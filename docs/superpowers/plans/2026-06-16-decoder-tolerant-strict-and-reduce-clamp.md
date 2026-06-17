# Decoder: Tolerant (non-strict) Mode + Reduce-Factor Clamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the WASM JP2 decoder robust to the partial codestreams s2jp2 exists to feed it — (1) tolerate truncated / PLT-trimmed streams instead of hard-failing, and (2) clamp an over-large reduce factor to the deepest overview the codestream actually carries instead of erroring.

**Architecture:** Two untapped OpenJPEG 2.5.4 APIs are wired into the embind wrapper (`wrapper/jp2.cpp`) and surfaced through the TS facade (`src/decoder/decoder.ts`). (1) `opj_decoder_set_strict_mode(codec, OPJ_FALSE)` is called after `opj_setup_decoder` when a new `tolerant` flag is set. (2) Reduce-factor application moves from `params.cp_reduce` (pre-header) to `opj_set_decoded_resolution_factor` (post-header) wrapped in a decrement-until-accepted clamp loop; the applied level is returned to the caller. The WASM is rebuilt and exercised against the real S2 fixtures.

**Tech Stack:** C++17 + Emscripten embind (`em++`), OpenJPEG 2.5.4 static lib (`../openjpeg/build-wasm/bin/libopenjp2.a`, already built at tag v2.5.4), TypeScript facade, Vitest.

---

## Context for the engineer (zero-context assumptions)

- **Repo:** `/home/eouser/code/s2jp2`. **Branch:** `chore/openjpeg-2.5.4` (already checked out; it already carries the OpenJPEG 2.5.3→2.5.4 upgrade commit — these two features land on the same branch as the user requested).
- **Build prerequisite (already satisfied):** emsdk at `~/emsdk`; OpenJPEG checked out at tag `v2.5.4` and built to `../openjpeg/build-wasm/bin/libopenjp2.a`. You do **not** need to rebuild OpenJPEG — only relink the wrapper.
- **Rebuild the wrapper WASM:** `npm run build:wasm` (runs `wrapper/build.sh`, which sources emsdk and emits `src/decoder/stex-jp2.{wasm,mjs}`). The unit tests import the decoder from `src/decoder/`, so a `build:wasm` is enough to test — you do **not** need `npm run build` (that only refreshes the gitignored `dist/`).
- **Run tests:** `npm test` (Vitest, whole suite) or a single file: `npx vitest run tests/decoder.test.ts`.
- **Why two APIs:** today the wrapper sets `params.cp_reduce` before `opj_read_header` and decodes in OpenJPEG's default **strict** mode (`j2k.c:10707` sets `m_cp.strict = OPJ_TRUE`). Strict mode can reject truncated streams; an over-large `cp_reduce` hard-errors at decode time (`j2k.c:10977`). Both are wrong defaults for a library whose whole job is feeding trimmed codestreams.
- **Sole caller** of the WASM `decode()` is the `Decoder.decode()` facade in `src/decoder/decoder.ts`. The embind binding `emscripten::function("decode", &decode)` infers arity automatically, so adding a trailing C++ parameter only requires updating the TS `StexJp2Module` interface and the one call site.

## File Structure

- **Modify** `wrapper/jp2.cpp` — add `tolerant` param + `opj_decoder_set_strict_mode`; move reduce application post-header into a clamp loop; add `appliedReduce_` field + `reduceLevel()` getter + its binding.
- **Modify** `src/decoder/decoder.ts` — add `tolerant?: boolean` to `DecodeOptions` (default `true`), add `reduceLevel: number` to `DecodeResult`, extend the `StexJp2Module`/`StexJp2DecodeResult` interfaces, pass/return the new fields.
- **Modify** `tests/decoder.test.ts` — one test per feature, both against existing real fixtures.
- **Modify** `README.md` + `package.json` — document the new behavior; bump `0.3.2 → 0.3.3`.
- **Rebuilt artifacts** (committed): `src/decoder/stex-jp2.wasm`, `src/decoder/stex-jp2.mjs`.

---

## Task 1: Tolerant (non-strict) decode of truncated codestreams

**Files:**
- Modify: `wrapper/jp2.cpp` (signature + strict-mode call)
- Modify: `src/decoder/decoder.ts` (interface + option, default `true`)
- Test: `tests/decoder.test.ts`
- Rebuild: `src/decoder/stex-jp2.{wasm,mjs}`

- [ ] **Step 1: Write the failing test**

Append to `tests/decoder.test.ts`:

```ts
describe.runIf(existsSync(TCI))('Decoder tolerant mode (truncated codestream)', () => {
  it('decodes a truncated stream that strict mode rejects', async () => {
    const decoder = await loadDecoder();
    const data = readFileSync(TCI);
    const full = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    // Find a truncation point that strict mode rejects (header stays intact at
    // these fractions of a ~131 MB file, so the failure is missing tail packets).
    let truncated: Uint8Array | null = null;
    for (const frac of [0.3, 0.5, 0.7, 0.9]) {
      const cut = full.subarray(0, Math.floor(full.length * frac));
      let strictThrew = false;
      try {
        decoder.decode(cut, { reduceLevel: 4, tolerant: false });
      } catch {
        strictThrew = true;
      }
      if (strictThrew) {
        truncated = cut;
        break;
      }
    }
    expect(truncated, 'expected a truncation strict mode rejects').not.toBeNull();

    // Tolerant mode decodes the same bytes without throwing; dimensions come
    // from the (intact) header, so they are unchanged by the missing tail.
    const r = decoder.decode(truncated!, { reduceLevel: 4, tolerant: true });
    expect(r.width).toBe(687);
    expect(r.height).toBe(687);
    expect(r.numComponents).toBe(3);
    expect(r.pixels.byteLength).toBe(687 * 687 * 3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/decoder.test.ts -t 'truncated codestream'`
Expected: FAIL — with the current (strict-only) build the `tolerant: true` decode throws `JP2 decode failed: ...`, so the assertion block never reached / test errors.

- [ ] **Step 3: Add the `tolerant` parameter and strict-mode call in `wrapper/jp2.cpp`**

Change the `decode` signature (around line 95) to add a trailing `bool tolerant`:

```cpp
DecodeResult decode(const emscripten::val& encoded,
                    std::uint32_t reduceLevel,
                    bool useArea,
                    std::int32_t areaX0,
                    std::int32_t areaY0,
                    std::int32_t areaX1,
                    std::int32_t areaY1,
                    bool tolerant) {
```

Then, immediately after the `opj_setup_decoder` success check (after the closing `}` of the `if (!opj_setup_decoder(...))` block, before `opj_image_t* image = nullptr;`), insert:

```cpp
    // Tolerant mode: decode truncated / PLT-trimmed codestreams instead of
    // hard-failing when trailing packets or tile-parts are missing. OpenJPEG
    // defaults to strict mode (j2k.c: m_cp.strict = OPJ_TRUE).
    if (tolerant) {
        opj_decoder_set_strict_mode(codec, OPJ_FALSE);
    }
```

- [ ] **Step 4: Thread the option through `src/decoder/decoder.ts` (default `true`)**

Update the `StexJp2Module` interface (lines 1-8) to add the trailing `tolerant` arg:

```ts
interface StexJp2Module {
  decode(
    encoded: Uint8Array,
    reduceLevel: number,
    useArea: boolean,
    x0: number, y0: number, x1: number, y1: number,
    tolerant: boolean,
  ): StexJp2DecodeResult;
}
```

Add `tolerant` to `DecodeOptions` (after `decodeArea?`):

```ts
export interface DecodeOptions {
  reduceLevel?: number;
  decodeArea?: DecodeArea;
  /** Decode truncated / PLT-trimmed codestreams instead of failing when
   *  trailing packets are missing. Defaults to true (the streaming use case). */
  tolerant?: boolean;
}
```

Update the body of `Decoder.decode` to read and pass it:

```ts
  decode(encoded: Uint8Array, options: DecodeOptions = {}): DecodeResult {
    const reduce = options.reduceLevel ?? 0;
    const tolerant = options.tolerant ?? true;
    const area = options.decodeArea;
    const result = this.module.decode(
      encoded,
      reduce,
      area !== undefined,
      area?.x0 ?? 0, area?.y0 ?? 0, area?.x1 ?? 0, area?.y1 ?? 0,
      tolerant,
    );
```

(Leave the rest of the method unchanged for now — `reduceLevel` on the result is added in Task 2.)

- [ ] **Step 5: Rebuild the WASM**

Run: `npm run build:wasm`
Expected: completes with `em++` linking `../openjpeg/build-wasm/bin/libopenjp2.a`; `src/decoder/stex-jp2.{wasm,mjs}` mtimes update, no errors.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/decoder.test.ts -t 'truncated codestream'`
Expected: PASS.

- [ ] **Step 7: Run the full decoder suite to confirm no regression**

Run: `npx vitest run tests/decoder.test.ts`
Expected: PASS — the three pre-existing decoder tests (full TCI reduce=4, TCI window reduce=3, B04 reduce=0) still pass because complete streams behave identically under non-strict mode, and the `error surfacing` test still throws (the `< 12 bytes` guard and header-read failure are independent of strict mode).

- [ ] **Step 8: Commit**

```bash
git add wrapper/jp2.cpp src/decoder/decoder.ts src/decoder/stex-jp2.wasm src/decoder/stex-jp2.mjs tests/decoder.test.ts
git commit -m "feat(decoder): tolerant mode for truncated/PLT-trimmed codestreams

Add a tolerant flag (default true) that calls opj_decoder_set_strict_mode(
codec, OPJ_FALSE) so deliberately-trimmed streams decode instead of hard-
failing on missing trailing packets.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Clamp over-large reduce factor + report the applied level

**Files:**
- Modify: `wrapper/jp2.cpp` (move reduce post-header into clamp loop; add `appliedReduce_` + `reduceLevel()` + binding)
- Modify: `src/decoder/decoder.ts` (`StexJp2DecodeResult.reduceLevel()`, `DecodeResult.reduceLevel`, return it)
- Test: `tests/decoder.test.ts`
- Rebuild: `src/decoder/stex-jp2.{wasm,mjs}`

- [ ] **Step 1: Write the failing test**

Append to `tests/decoder.test.ts`:

```ts
describe.runIf(existsSync(B04))('Decoder reduce clamping', () => {
  it('clamps an over-large reduce factor instead of failing', async () => {
    const decoder = await loadDecoder();
    const data = readFileSync(B04);
    const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    // 99 is far beyond any S2 asset's resolution-level count. Without clamping
    // OpenJPEG hard-errors; with clamping it falls back to the coarsest overview.
    const r = decoder.decode(u8, { reduceLevel: 99 });
    expect(r.reduceLevel).toBeLessThan(99);
    expect(r.reduceLevel).toBeGreaterThanOrEqual(0);
    expect(r.width).toBeGreaterThan(0);
    expect(r.width).toBeLessThan(1830); // coarser than full 60 m resolution
    expect(r.pixels.length).toBe(r.width * r.height * r.numComponents);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/decoder.test.ts -t 'reduce clamping'`
Expected: FAIL — the current build sets `cp_reduce = 99` and hard-errors at decode (so `decode` throws), and `r.reduceLevel` does not exist on the result.

- [ ] **Step 3: Add the clamp loop + applied-reduce field in `wrapper/jp2.cpp`**

**(3a)** In the `DecodeResult` class, add the getter (next to the other getters, e.g. after `bitsPerSample()`):

```cpp
    std::uint32_t reduceLevel() const { return appliedReduce_; }
```

and add the field (next to the other members, e.g. after `std::uint32_t bitsPerSample_{0};`):

```cpp
    std::uint32_t appliedReduce_{0};
```

**(3b)** Remove the pre-header reduce assignment. Delete this line (currently right after `opj_set_default_decoder_parameters(&params);`):

```cpp
    params.cp_reduce = reduceLevel;
```

and replace it with a clarifying comment:

```cpp
    // Reduce factor is applied AFTER opj_read_header via
    // opj_set_decoded_resolution_factor so it can be clamped to the number of
    // resolution levels the codestream actually carries (see below).
```

**(3c)** Immediately after the `opj_read_header` success block (after its closing `}`, before the `if (useArea)` block), insert the clamp loop:

```cpp
    // Clamp the requested reduce factor down to the deepest overview present.
    // opj_set_decoded_resolution_factor() emits an EVT_ERROR and returns false
    // when res_factor >= numresolutions, so suppress the error handler during
    // the probe (these failures are expected) and decrement until it sticks.
    opj_set_error_handler(codec, msg_quiet, nullptr);
    std::uint32_t applied = reduceLevel;
    bool factorOk = false;
    for (;;) {
        if (opj_set_decoded_resolution_factor(codec, applied)) {
            factorOk = true;
            break;
        }
        if (applied == 0) {
            break;
        }
        --applied;
    }
    opj_set_error_handler(codec, msg_error, &out.error_);
    if (!factorOk) {
        opj_image_destroy(image);
        opj_destroy_codec(codec);
        opj_stream_destroy(opj_stream);
        out.error_ = "opj_set_decoded_resolution_factor failed";
        return out;
    }
    out.appliedReduce_ = applied;
```

**(3d)** Register the getter in the embind block (inside `EMSCRIPTEN_BINDINGS`, alongside the other `.function(...)` lines):

```cpp
        .function("reduceLevel", &DecodeResult::reduceLevel)
```

- [ ] **Step 4: Surface `reduceLevel` through `src/decoder/decoder.ts`**

Add the getter to the `StexJp2DecodeResult` interface (after `bitsPerSample(): number;`):

```ts
  reduceLevel(): number;
```

Add the field to the exported `DecodeResult` interface (after `bitsPerSample: number;`):

```ts
  /** The reduce factor actually applied, after clamping to the number of
   *  resolution levels present (<= options.reduceLevel). */
  reduceLevel: number;
```

Add it to the returned object in `Decoder.decode` (after `bitsPerSample: result.bitsPerSample(),`):

```ts
      reduceLevel: result.reduceLevel(),
```

- [ ] **Step 5: Rebuild the WASM**

Run: `npm run build:wasm`
Expected: completes without errors; `src/decoder/stex-jp2.{wasm,mjs}` updated.

- [ ] **Step 6: Run the full decoder suite**

Run: `npx vitest run tests/decoder.test.ts`
Expected: PASS — the new clamp test passes; the three original decoder tests still pass (their valid reduce levels 4/3/0 are accepted by the clamp loop on the first iteration, so behavior is unchanged) and now also carry a `reduceLevel` field equal to their requested level.

- [ ] **Step 7: Run the whole project test suite**

Run: `npm test`
Expected: PASS — full suite green (the pipeline/marker suites are unaffected; the decoder facade change is additive and the WASM signature change is internal).

- [ ] **Step 8: Commit**

```bash
git add wrapper/jp2.cpp src/decoder/decoder.ts src/decoder/stex-jp2.wasm src/decoder/stex-jp2.mjs tests/decoder.test.ts
git commit -m "feat(decoder): clamp over-large reduce factor + report applied level

Apply the reduce factor post-header via opj_set_decoded_resolution_factor in
a decrement-until-accepted loop so requesting a reduce deeper than the asset's
overview pyramid degrades to the coarsest level instead of hard-failing.
Expose the applied (clamped) level on DecodeResult.reduceLevel.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Documentation + version bump

**Files:**
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Update the README capability description**

In `README.md`, replace the feature-2 sentence about the WASM (the line starting `2. **Decode at native precision in the browser.**`) so it ends with an added sentence:

```markdown
2. **Decode at native precision in the browser.** A vendored OpenJPEG 2.5.4 WASM (245 KB) exposes `cp_reduce` (resolution reduction) and `opj_set_decode_area` (windowed decode) — the two APIs the popular `@cornerstonejs/codec-openjpeg` package doesn't expose. The decoder runs in **non-strict mode** so it decodes the truncated / PLT-trimmed codestreams this library produces, and it **clamps** a requested reduce factor to the deepest overview the codestream carries (reporting the applied level on `DecodeResult.reduceLevel`). Output is `Uint8Array` for 8-bit assets (TCI / SCL / CLD / SNW) and `Uint16Array` for 16-bit assets (reflectance bands / AOT / WVP).
```

- [ ] **Step 2: Bump the package version**

In `package.json`, change:

```json
  "version": "0.3.2",
```

to:

```json
  "version": "0.3.3",
```

- [ ] **Step 3: Commit**

```bash
git add README.md package.json
git commit -m "docs: document non-strict decode + reduce clamp; bump 0.3.2 -> 0.3.3

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Risks & Verification Notes

- **Truncation test determinism:** the Task 1 loop searches fixed fractions of the real TCI fixture and self-asserts that *some* truncation trips strict mode. If none do (`truncated` stays null), the test fails loudly rather than silently passing — surfacing a wrong premise instead of a false green. For a baseline-N0500 S2 TCI (resolution-major progression) truncating to 30–90 % reliably drops trailing packets.
- **No error-handler pollution:** `opj_set_decoded_resolution_factor` calls during the clamp loop emit `EVT_ERROR` on each rejected level. The loop swaps the error handler to `msg_quiet` around the probe and restores `msg_error` afterward, so a successful clamp leaves `out.error_` empty and `result.ok()` stays true. Only a genuine post-clamp decode error surfaces.
- **Post-header reduce is the sanctioned pattern:** `opj_decompress.c:1374-1548` uses `opj_set_decoded_resolution_factor` (post-`opj_read_header`) as the documented alternative to `parameters.cp_reduce`, including for the full-image path — so moving reduce application after the header does not change valid-reduce behavior (verified by the three unchanged decoder tests).
- **Backward compatibility:** `tolerant` defaults to `true` and `reduceLevel` is additive on the result, so the sole caller (the facade) and any downstream STEX consumer keep working; complete-stream decodes are byte-identical.

## Self-Review

1. **Spec coverage:** #1 (strict mode) → Task 1. #2 (reduce clamp, callable post-header) → Task 2. Docs/version consistency (global doc discipline) → Task 3. No gaps.
2. **Placeholder scan:** every code/edit step shows the literal code; every run step gives an exact command + expected outcome. No TODO/TBD/"handle edge cases".
3. **Type consistency:** `tolerant` (bool) appears identically in the C++ signature, `StexJp2Module.decode`, and `DecodeOptions`. `reduceLevel()` getter (C++ `reduceLevel()` / embind `"reduceLevel"`) matches `StexJp2DecodeResult.reduceLevel()` and `DecodeResult.reduceLevel`. `appliedReduce_` is the C++ field only. Arg order of `decode(...)` matches between C++ and TS (trailing `tolerant`).
