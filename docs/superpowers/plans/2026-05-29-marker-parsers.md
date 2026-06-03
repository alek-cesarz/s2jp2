# s2jp2 — TypeScript port of s2surgeon marker parsers + WASM decoder facade

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone TypeScript library that exposes (1) byte-level parsers for the JPEG 2000 markers used by every Sentinel-2 MSI JP2 asset (TCI / reflectance bands / SCL / CLD / SNW / AOT / WVP at 10 m, 20 m, or 60 m), (2) a high-level "header + window + reduce level → byte ranges → stitched codestream" pipeline that plans range fetches from TLM/PLT, (3) a typed facade over the OpenJPEG 2.5.3 WASM decoder built in the spike that returns native-precision pixels (Uint8 or Uint16, 1–3 components).

**Architecture:** Pure parsers operate on `Uint8Array` via `DataView`. No I/O — consumers plug in their own `RangeFetcher` (HTTPS, S3 SigV4, file, etc.). The WASM module (`stex-jp2.wasm` + `.mjs`) is vendored under `src/decoder/` and wrapped in a thin TS class. **No hardcoded asset constants:** image dimensions, tile dimensions, decomposition levels, component count, and per-resolution packet counts are all derived at runtime from the SIZ + COD markers. The fixed parts of the S2 N0512 framework (LRCP progression, single quality layer, 5/3 reversible wavelet, 64×64 code blocks, PLT in every tile-part, TLM in the main header) form a *capability predicate* validated up front. The Rust source at `~/code/s2surgeon/src/*.rs` is the byte-level spec; the TS port generalises over (numComponents, numDecompLevels, precincts) instead of hardcoding the TCI 10 m values.

**GitHub remote:** `git@github.com:alek-cesarz/s2jp2.git` (configured in Task 1).

**Tech Stack:** TypeScript (strict, ESM-only), Vitest, Node ≥ 20. No runtime dependencies for the parser modules. The WASM artifact (247 KB) is a vendored binary asset.

**Reference sources (read these before each task):**
- `~/code/s2surgeon/src/siz.rs` — SIZ marker
- `~/code/s2surgeon/src/tlm.rs` — TLM marker
- `~/code/s2surgeon/src/cod.rs` — COD marker + N0512 profile
- `~/code/s2surgeon/src/plt.rs` — PLT marker + truncation
- `~/code/s2surgeon/src/codestream.rs` — SOC/SOT navigation, stitching
- `~/code/s2surgeon/src/window.rs` — window/tile math
- `/tmp/jp2-spike/wrapper/jp2.cpp` — embind decoder wrapper
- `/tmp/jp2-spike/wrapper/stex-jp2.{wasm,mjs}` — built decoder artifacts
- `/tmp/jp2-spike/sample_TCI_10m.jp2` — verified-decodable CDSE test fixture

**Spec invariants (apply to every parser):**
- All multi-byte integers are **big-endian** (JPEG 2000 spec, §A.2).
- Markers are 2 bytes starting with `0xFF`. Marker segments are followed by 2 BE bytes of segment length `L` (which includes the length field itself but not the 2-byte marker).
- Use `DataView` for reads (`getUint16(offset, false)` etc.), not bit-shifting on raw `Uint8Array` indices — keeps signed/unsigned semantics explicit.
- Throw `Error` subclasses with descriptive messages on every malformed input. Never silently truncate.

**S2 N0512 framework capability check (the only fixed assumptions):**
- COD progression order = `LRCP` (so the packet stream is Layer→Resolution→Component→Position; truncating to the first K packets correctly drops higher resolutions).
- COD numLayers = 1 (truncation logic assumes a single quality layer).
- COD waveletTransform = 1 (5/3 reversible).
- COD codeBlockWidthExp = codeBlockHeightExp = 4 (64×64 code blocks).
- COD userDefinedPrecincts = true and every precinct = [8, 8] (256×256 precincts at every resolution).
- Main header contains a TLM (`FF 55`) listing every tile-part length.
- Every tile-part contains at least one PLT (`FF 58`).

**What varies per asset (discovered at runtime, never hardcoded):**
- `Xsiz × Ysiz` (image dimensions) — 10980 / 5490 / 1830 per axis for 10 m / 20 m / 60 m.
- `XTsiz × YTsiz` (tile dimensions) — usually 1024×1024 but may differ for 60 m assets that fit in one tile.
- `numDecompLevels` — 4 for 10 m, possibly fewer for coarser assets that need fewer resolutions.
- `numComponents` — 3 for TCI, 1 for everything else.
- Component precision (`prec`) — 8 for TCI / SCL / CLD / SNW, 16 for reflectance bands and AOT / WVP.

**Confirmed asset matrix from CDSE S2 L2A:**

| Asset family            | Resolution | Components | Precision | Image dims     |
|-------------------------|------------|------------|-----------|----------------|
| `TCI_{10,20,60}m`        | 10/20/60 m | 3 (RGB)    | 8-bit     | 10980/5490/1830 px |
| `B{01..12,8A}_{10,20,60}m` | 10/20/60 m | 1          | 16-bit    | per resolution |
| `AOT_*`, `WVP_*`         | 10/20/60 m | 1          | 16-bit    | per resolution |
| `SCL_{20,60}m`           | 20/60 m    | 1          | 8-bit     | 5490/1830 px   |
| `CLD_{20,60}m`, `SNW_{20,60}m` | 20/60 m | 1     | 8-bit     | 5490/1830 px   |

---

## File structure

```
~/code/s2jp2/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── .gitignore
├── docs/superpowers/plans/2026-05-29-marker-parsers.md  ← this file
├── wrapper/                            # WASM build source (kept for rebuild reproducibility)
│   ├── jp2.cpp                         # copied from /tmp/jp2-spike/wrapper/jp2.cpp
│   └── build.sh                        # repeatable build script
├── scripts/
│   └── fetch-fixture.sh                # downloads sample_TCI_10m.jp2 via CDSE token
├── src/
│   ├── errors.ts                       # ParseError, ProfileMismatchError, WindowError
│   ├── profile.ts                      # capability predicate + runtime keepPacketsForOverview
│   ├── markers/
│   │   ├── siz.ts                      # extractSizInfo (dims + tile dims + components)
│   │   ├── tlm.ts                      # extractTileLengths, tilePartRangesFromHeader
│   │   ├── cod.ts                      # parseCod, validateS2N0512Capability
│   │   ├── plt.ts                      # sodOffset, extractPacketLengths, payloadSize, truncateToPackets
│   │   └── codestream.ts               # firstSotOffset, extractCodestreamOffset, stitchPartialCodestream
│   ├── window.ts                       # windowTileIndices (parameterised), groupedTilePartRanges
│   ├── inspect.ts                      # inspectAsset(header) → AssetDescriptor
│   ├── planner.ts                      # planWindowFetches (high level)
│   ├── decoder/
│   │   ├── stex-jp2.wasm               # vendored (binary)
│   │   ├── stex-jp2.mjs                # vendored (emscripten glue)
│   │   └── decoder.ts                  # loadDecoder() + typed Decoder class
│   ├── pipeline.ts                     # fetchAndDecodeWindow (end-to-end)
│   └── index.ts                        # public API
└── tests/
    ├── fixtures/
    │   └── README.md                   # how to run scripts/fetch-fixture.sh
    ├── markers/
    │   ├── siz.test.ts
    │   ├── tlm.test.ts
    │   ├── cod.test.ts
    │   ├── plt.test.ts
    │   └── codestream.test.ts
    ├── window.test.ts
    ├── profile.test.ts
    ├── planner.test.ts
    ├── decoder.test.ts
    └── pipeline.test.ts
```

---

### Task 1: Scaffold project + vendor WASM artifacts + fixture script

**Files:**
- Create: `~/code/s2jp2/package.json`
- Create: `~/code/s2jp2/tsconfig.json`
- Create: `~/code/s2jp2/vitest.config.ts`
- Create: `~/code/s2jp2/.gitignore`
- Create: `~/code/s2jp2/README.md`
- Create: `~/code/s2jp2/src/errors.ts`
- Create: `~/code/s2jp2/scripts/fetch-fixture.sh`
- Create: `~/code/s2jp2/tests/fixtures/README.md`
- Create: `~/code/s2jp2/wrapper/jp2.cpp` (copy from `/tmp/jp2-spike/wrapper/jp2.cpp`)
- Create: `~/code/s2jp2/wrapper/build.sh`
- Create: `~/code/s2jp2/src/decoder/stex-jp2.wasm` (copy from `/tmp/jp2-spike/wrapper/stex-jp2.wasm`)
- Create: `~/code/s2jp2/src/decoder/stex-jp2.mjs` (copy from `/tmp/jp2-spike/wrapper/stex-jp2.mjs`)

- [ ] **Step 1: `package.json`**

```json
{
  "name": "s2jp2",
  "version": "0.1.0",
  "description": "Sentinel-2 JPEG 2000 marker parsing + windowed WASM decode",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./decoder/stex-jp2.wasm": "./src/decoder/stex-jp2.wasm",
    "./decoder/stex-jp2.mjs": "./src/decoder/stex-jp2.mjs"
  },
  "files": ["dist", "src/decoder/stex-jp2.wasm", "src/decoder/stex-jp2.mjs"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "fetch:fixture": "bash scripts/fetch-fixture.sh",
    "build:wasm": "bash wrapper/build.sh"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.0.0"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*"],
  "exclude": ["src/decoder/stex-jp2.mjs"]
}
```

- [ ] **Step 3: `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 4: `.gitignore`**

```
node_modules/
dist/
*.log
tests/fixtures/*.jp2
wrapper/build-wasm/
```

- [ ] **Step 5: `src/errors.ts`**

```ts
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export class ProfileMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileMismatchError';
  }
}

export class WindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowError';
  }
}
```

- [ ] **Step 6: `scripts/fetch-fixture.sh`**

```bash
#!/usr/bin/env bash
# Downloads two reference Sentinel-2 JP2 assets used by the test suite:
#   1. TCI_10m  — 3-band uint8, 10980×10980, exercises the multi-component RGB path
#   2. B04_60m  — 1-band uint16, 1830×1830, exercises the single-band 16-bit path
# Requires ~/tools/cdse.json (the get-token skill profile) to exist.
set -euo pipefail

ITEM='S2B_MSIL2A_20260502T101019_N0512_R022_T33UWS_20260502T140118'
PROD_ID='6da938c1-db72-4b9a-8f6b-ea8bb7490253'
BASE="https://download.dataspace.copernicus.eu/odata/v1/Products($PROD_ID)/Nodes($ITEM.SAFE)/Nodes(GRANULE)/Nodes(L2A_T33UWS_A047810_20260502T101020)/Nodes(IMG_DATA)"

declare -A ASSETS=(
  ["sample_TCI_10m.jp2"]="$BASE/Nodes(R10m)/Nodes(T33UWS_20260502T101019_TCI_10m.jp2)/\$value"
  ["sample_B04_60m.jp2"]="$BASE/Nodes(R60m)/Nodes(T33UWS_20260502T101019_B04_60m.jp2)/\$value"
)

mkdir -p tests/fixtures
TOKEN=$("$HOME/tools/get_token.sh" "$HOME/tools/cdse.json" | tail -1)
for NAME in "${!ASSETS[@]}"; do
  OUT="tests/fixtures/$NAME"
  if [ -f "$OUT" ]; then
    echo "fixture already present: $OUT"
    continue
  fi
  echo "fetching $NAME ..."
  curl -sL -H "Authorization: Bearer $TOKEN" -o "$OUT" -w "  http=%{http_code} size=%{size_download}\n" "${ASSETS[$NAME]}"
done
```

- [ ] **Step 7: Copy the wrapper source + WASM artifacts**

Run:
```bash
mkdir -p ~/code/s2jp2/wrapper ~/code/s2jp2/src/decoder
cp /tmp/jp2-spike/wrapper/jp2.cpp ~/code/s2jp2/wrapper/jp2.cpp
cp /tmp/jp2-spike/wrapper/stex-jp2.wasm ~/code/s2jp2/src/decoder/stex-jp2.wasm
cp /tmp/jp2-spike/wrapper/stex-jp2.mjs ~/code/s2jp2/src/decoder/stex-jp2.mjs
```

Expected: 3 files copied. Check sizes — `.wasm` ≈ 247 KB, `.mjs` ≈ 46 KB, `.cpp` ≈ 7 KB.

- [ ] **Step 8: `wrapper/build.sh`** (reproducible rebuild)

```bash
#!/usr/bin/env bash
# Rebuilds stex-jp2.wasm + stex-jp2.mjs from wrapper/jp2.cpp.
# Assumes emsdk is at ~/emsdk and OpenJPEG 2.5.3 is cloned next to this repo
# at ../openjpeg with build-wasm/bin/libopenjp2.a already produced.
set -euo pipefail
source "$HOME/emsdk/emsdk_env.sh"

cd "$(dirname "$0")"
em++ -O3 -std=c++17 \
  -I ../openjpeg/src/lib/openjp2 \
  -I ../openjpeg/build-wasm/src/lib/openjp2 \
  -lembind \
  -s MODULARIZE=1 -s EXPORT_NAME=createStexJp2 \
  -s ENVIRONMENT=node,web -s EXPORT_ES6=1 \
  -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=64MB -s MAXIMUM_MEMORY=2GB \
  jp2.cpp ../openjpeg/build-wasm/bin/libopenjp2.a \
  -o ../src/decoder/stex-jp2.mjs
```

Then `chmod +x scripts/fetch-fixture.sh wrapper/build.sh`.

- [ ] **Step 9: `README.md`** — minimal contract

```markdown
# s2jp2

TypeScript library for streaming Sentinel-2 JPEG 2000 tiles: marker parsers
(SIZ/TLM/COD/PLT), window-to-tile-range planning, and a WASM decoder
(OpenJPEG 2.5.3) supporting `cp_reduce` + windowed decode.

## Status
Pre-release. Scope: TCI 10m N0512 profile only.

## Install
```bash
npm install s2jp2
```

## Use
See `tests/pipeline.test.ts` for a full end-to-end example.

## Develop
```bash
npm install
npm run fetch:fixture   # downloads the test JP2 via CDSE token
npm test
```
```

- [ ] **Step 10: Install + verify**

Run:
```bash
cd ~/code/s2jp2 && npm install
```

Expected: succeeds, `node_modules/` populated.

- [ ] **Step 11: Initialize git + first commit + add GitHub remote**

Run:
```bash
cd ~/code/s2jp2
git init -b main
git add -A
git commit -m "scaffold: project layout + vendored WASM decoder"
git remote add origin git@github.com:alek-cesarz/s2jp2.git
```

Pushing is deferred until the public API stabilises (after Task 11). At that point:
```bash
git push -u origin main
```

---

### Task 2: S2 N0512 capability predicate + runtime `keepPacketsForOverview`

We do NOT hardcode an asset profile. Instead we expose:
(a) **`S2_N0512_CAPABILITY`** — the fixed coding parameters every S2 MSI JP2
    must satisfy for our truncation logic to be sound (LRCP, single layer,
    5/3 wavelet, 64×64 code blocks, [256,256] precincts, PLT in tile-parts,
    TLM in main header). This is the *predicate* the COD validator
    enforces (Task 6) — not a profile we paste into the codestream.
(b) **`computePacketTable(numDecompLevels, numComponents)`** — derives
    `packetsPerResolution` and `cumulativePackets` at runtime from the
    parsed COD. For TCI 10m it returns the s2surgeon values; for B04_60m
    (1-component, 3 decomp levels) it returns a different, smaller table.
(c) **`keepPacketsForOverview(level, packetTable)`** — pure function over
    a runtime packet table. Returns null when `level` overshoots.

**Reference:** `~/code/s2surgeon/src/cod.rs` lines 75–125 (the *shape* of the table — but the values are computed instead of hardcoded).

**Files:**
- Create: `~/code/s2jp2/src/profile.ts`
- Create: `~/code/s2jp2/tests/profile.test.ts`

- [ ] **Step 1: Failing test (`tests/profile.test.ts`)**

```ts
import { describe, expect, it } from 'vitest';
import {
  computePacketTable,
  keepPacketsForOverview,
  S2_N0512_CAPABILITY,
} from '../src/profile.js';

describe('S2_N0512_CAPABILITY', () => {
  it('locks in the invariants every S2 MSI JP2 must satisfy', () => {
    expect(S2_N0512_CAPABILITY.progression).toBe('LRCP');
    expect(S2_N0512_CAPABILITY.numLayers).toBe(1);
    expect(S2_N0512_CAPABILITY.codeBlockWidthExp).toBe(4);
    expect(S2_N0512_CAPABILITY.codeBlockHeightExp).toBe(4);
    expect(S2_N0512_CAPABILITY.waveletTransform).toBe(1);
    expect(S2_N0512_CAPABILITY.requirePltInTileParts).toBe(true);
    expect(S2_N0512_CAPABILITY.requireTlmInMainHeader).toBe(true);
    // numComponents and numDecompLevels intentionally NOT pinned —
    // those are per-asset and discovered from SIZ + COD.
  });
});

describe('computePacketTable', () => {
  it('TCI 10m (3 components, 4 decomp levels) reproduces the s2surgeon table', () => {
    const t = computePacketTable({ numDecompLevels: 4, numComponents: 3 });
    expect(t.packetsPerResolution).toEqual([3, 3, 3, 12, 48]);
    expect(t.cumulativePackets).toEqual([3, 6, 9, 21, 69]);
  });
  it('B04_60m-shaped (1 component, 3 decomp levels) → smaller table', () => {
    const t = computePacketTable({ numDecompLevels: 3, numComponents: 1 });
    // Precincts per resolution for N0512 are [1,1,1,4,16][..R+1] entries.
    // With R=3 → 4 resolutions: precincts [1,1,1,4]
    // packets = precincts * numLayers(1) * numComponents(1) = [1,1,1,4]
    expect(t.packetsPerResolution).toEqual([1, 1, 1, 4]);
    expect(t.cumulativePackets).toEqual([1, 2, 3, 7]);
  });
});

describe('keepPacketsForOverview', () => {
  const tciTable = computePacketTable({ numDecompLevels: 4, numComponents: 3 });
  it('returns the full packet count at overview level 0', () => {
    expect(keepPacketsForOverview(0, tciTable)).toBe(69);
  });
  it('returns 3 packets at the deepest overview', () => {
    expect(keepPacketsForOverview(4, tciTable)).toBe(3);
  });
  it('walks the cumulative table in reverse', () => {
    expect(keepPacketsForOverview(1, tciTable)).toBe(21);
    expect(keepPacketsForOverview(2, tciTable)).toBe(9);
    expect(keepPacketsForOverview(3, tciTable)).toBe(6);
  });
  it('returns null when overview level exceeds available resolutions', () => {
    expect(keepPacketsForOverview(5, tciTable)).toBeNull();
    expect(keepPacketsForOverview(255, tciTable)).toBeNull();
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `npm test -- profile`
Expected: FAIL — `Cannot find module '../src/profile.js'`

- [ ] **Step 3: Implement `src/profile.ts`**

```ts
import type { ProgressionOrder } from './markers/cod.js';

/**
 * The fixed parts of the S2 N0512 framework. These are properties of every
 * Sentinel-2 MSI JP2 (TCI / reflectance bands / SCL / CLD / SNW / AOT / WVP),
 * regardless of resolution or component count. The COD validator (Task 6)
 * checks each parsed COD against this predicate.
 */
export interface S2N0512Capability {
  readonly progression: ProgressionOrder;
  readonly numLayers: 1;
  readonly waveletTransform: 1; // 5/3 reversible
  readonly codeBlockWidthExp: 4; // 64 px
  readonly codeBlockHeightExp: 4; // 64 px
  readonly codeBlockStyle: 0x00;
  readonly userDefinedPrecincts: true;
  readonly precinctSize: readonly [number, number]; // [PPx, PPy] = [8, 8] → 256 px
  readonly requirePltInTileParts: boolean;
  readonly requireTlmInMainHeader: boolean;
}

export const S2_N0512_CAPABILITY: S2N0512Capability = {
  progression: 'LRCP',
  numLayers: 1,
  waveletTransform: 1,
  codeBlockWidthExp: 4,
  codeBlockHeightExp: 4,
  codeBlockStyle: 0x00,
  userDefinedPrecincts: true,
  precinctSize: [8, 8],
  requirePltInTileParts: true,
  requireTlmInMainHeader: true,
};

/**
 * Runtime packet table for one asset, derived from its parsed COD.
 *
 * The N0512 framework uses a fixed precinct count per resolution
 * (1, 1, 1, 4, 16, 64, … — one per quadrant-split of the LL subband).
 * Packets per resolution = precincts × numLayers × numComponents.
 */
export interface PacketTable {
  readonly packetsPerResolution: readonly number[];
  readonly cumulativePackets: readonly number[];
}

/** Precincts per resolution under the N0512 framework, from coarsest to finest. */
const PRECINCTS_PER_RESOLUTION = [1, 1, 1, 4, 16, 64, 256] as const;

export function computePacketTable(args: {
  numDecompLevels: number;
  numComponents: number;
}): PacketTable {
  const { numDecompLevels, numComponents } = args;
  if (!Number.isInteger(numDecompLevels) || numDecompLevels < 0) {
    throw new RangeError(`numDecompLevels=${numDecompLevels} must be a non-negative integer`);
  }
  if (!Number.isInteger(numComponents) || numComponents < 1) {
    throw new RangeError(`numComponents=${numComponents} must be ≥ 1`);
  }
  const numResolutions = numDecompLevels + 1;
  if (numResolutions > PRECINCTS_PER_RESOLUTION.length) {
    throw new RangeError(
      `numDecompLevels=${numDecompLevels} exceeds the supported maximum ${PRECINCTS_PER_RESOLUTION.length - 1}`,
    );
  }
  const packetsPerResolution: number[] = new Array(numResolutions);
  const cumulativePackets: number[] = new Array(numResolutions);
  let acc = 0;
  for (let i = 0; i < numResolutions; i++) {
    const precincts = PRECINCTS_PER_RESOLUTION[i]!;
    const packets = precincts * 1 /* numLayers */ * numComponents;
    packetsPerResolution[i] = packets;
    acc += packets;
    cumulativePackets[i] = acc;
  }
  return { packetsPerResolution, cumulativePackets };
}

/**
 * Map an overview level to the number of packets per tile-part to keep.
 *   level 0  = full resolution → all packets
 *   level R  = lowest resolution → just the packets for resolution 0
 * Returns null when level exceeds available resolutions.
 */
export function keepPacketsForOverview(level: number, table: PacketTable): number | null {
  const r = table.packetsPerResolution.length - 1;
  if (!Number.isInteger(level) || level < 0 || level > r) return null;
  return table.cumulativePackets[r - level] ?? null;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `npm test -- profile`
Expected: PASS — all 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/profile.ts tests/profile.test.ts
git commit -m "feat: S2 N0512 capability + runtime packet-table computation"
```

---

### Task 3: SIZ marker parser — `extractSizInfo`

The SIZ marker (`FF 51`) declares the image grid, tile grid, AND component
count. All three vary across S2 assets and must be discovered, not assumed.
The parser scans for `FF 51` anywhere in the header (the marker appears
inside the JP2 codestream wrapped by JP2 boxes).

**Reference:** `~/code/s2surgeon/src/siz.rs`.

JPEG 2000 SIZ layout (after the 2-byte marker `FF 51`):
| Offset | Size | Field |
|--------|------|-------|
| 0      | 2 BE | Lsiz (segment length, includes itself) |
| 2      | 2 BE | Rsiz (capability) |
| 4      | 4 BE | Xsiz (reference grid width) |
| 8      | 4 BE | Ysiz (reference grid height) |
| 12     | 4 BE | XOsiz (image origin X) |
| 16     | 4 BE | YOsiz (image origin Y) |
| 20     | 4 BE | XTsiz (tile width) |
| 24     | 4 BE | YTsiz (tile height) |
| 28     | 4 BE | XTOsiz (tile grid origin X) |
| 32     | 4 BE | YTOsiz (tile grid origin Y) |
| 36     | 2 BE | Csiz (component count) |
| 38..   | 3·N  | per-component Ssiz/XRsiz/YRsiz |

**Files:**
- Create: `~/code/s2jp2/src/markers/siz.ts`
- Create: `~/code/s2jp2/tests/markers/siz.test.ts`

- [ ] **Step 1: Failing test (`tests/markers/siz.test.ts`)**

```ts
import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractSizInfo } from '../../src/markers/siz.js';
import { ParseError } from '../../src/errors.js';

function buildSyntheticSiz(opts: {
  Xsiz: number; Ysiz: number; XTsiz: number; YTsiz: number; Csiz: number;
}): Uint8Array {
  // 16 bytes of leading junk → confirms scanner finds FF 51 anywhere.
  // SIZ body length = 36 (fixed prefix) + 3·Csiz. Lsiz = body + 2.
  const componentBytes = 3 * opts.Csiz;
  const Lsiz = 38 + componentBytes; // includes its own 2 bytes
  const buf = new Uint8Array(16 + 2 + Lsiz);
  const v = new DataView(buf.buffer);
  for (let i = 0; i < 16; i++) buf[i] = 0xAA;
  buf[16] = 0xFF; buf[17] = 0x51;
  v.setUint16(18, Lsiz, false);
  v.setUint16(20, 0, false);                  // Rsiz
  v.setUint32(22, opts.Xsiz, false);
  v.setUint32(26, opts.Ysiz, false);
  v.setUint32(30, 0, false); v.setUint32(34, 0, false);   // XOsiz/YOsiz
  v.setUint32(38, opts.XTsiz, false);
  v.setUint32(42, opts.YTsiz, false);
  v.setUint32(46, 0, false); v.setUint32(50, 0, false);   // XTOsiz/YTOsiz
  v.setUint16(54, opts.Csiz, false);
  // Component info — Ssiz precision encoded as (prec-1) in low 7 bits.
  for (let c = 0; c < opts.Csiz; c++) {
    const base = 56 + c * 3;
    buf[base] = 7;     // Ssiz: unsigned, prec=8
    buf[base + 1] = 1; // XRsiz
    buf[base + 2] = 1; // YRsiz
  }
  return buf;
}

describe('extractSizInfo (synthetic)', () => {
  it('reads Xsiz/Ysiz, XTsiz/YTsiz, Csiz from a SIZ marker', () => {
    const info = extractSizInfo(buildSyntheticSiz({
      Xsiz: 10980, Ysiz: 10980, XTsiz: 1024, YTsiz: 1024, Csiz: 3,
    }));
    expect(info).toEqual({
      imageWidth: 10980, imageHeight: 10980,
      tileWidth: 1024, tileHeight: 1024,
      numComponents: 3,
    });
  });
  it('handles a single-component 60m asset shape', () => {
    const info = extractSizInfo(buildSyntheticSiz({
      Xsiz: 1830, Ysiz: 1830, XTsiz: 1024, YTsiz: 1024, Csiz: 1,
    }));
    expect(info.imageWidth).toBe(1830);
    expect(info.numComponents).toBe(1);
  });
  it('throws ParseError when SIZ is absent', () => {
    expect(() => extractSizInfo(new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]))).toThrow(ParseError);
  });
  it('throws ParseError when SIZ is truncated', () => {
    expect(() => extractSizInfo(new Uint8Array([0xFF, 0x51, 0x00, 0x05]))).toThrow(ParseError);
  });
});

const TCI = 'tests/fixtures/sample_TCI_10m.jp2';
const B04 = 'tests/fixtures/sample_B04_60m.jp2';

describe.runIf(existsSync(TCI))('extractSizInfo (real TCI 10m)', () => {
  it('returns 10980x10980, 1024x1024 tiles, 3 components', () => {
    const data = readFileSync(TCI);
    const header = new Uint8Array(data.buffer, data.byteOffset, Math.min(data.byteLength, 100_000));
    expect(extractSizInfo(header)).toMatchObject({
      imageWidth: 10980, imageHeight: 10980, numComponents: 3,
    });
  });
});

describe.runIf(existsSync(B04))('extractSizInfo (real B04 60m)', () => {
  it('returns 1830x1830 and a single component', () => {
    const data = readFileSync(B04);
    const header = new Uint8Array(data.buffer, data.byteOffset, Math.min(data.byteLength, 100_000));
    const info = extractSizInfo(header);
    expect(info.imageWidth).toBe(1830);
    expect(info.imageHeight).toBe(1830);
    expect(info.numComponents).toBe(1);
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `npm test -- markers/siz`
Expected: FAIL — `Cannot find module '../../src/markers/siz.js'`

- [ ] **Step 3: Implement `src/markers/siz.ts`**

```ts
import { ParseError } from '../errors.js';

const SIZ_MARKER_0 = 0xff;
const SIZ_MARKER_1 = 0x51;
const SIZ_MIN_BODY_BYTES = 38; // Lsiz minimum (36 fixed + 2 length bytes)

export interface SizInfo {
  imageWidth: number;
  imageHeight: number;
  tileWidth: number;
  tileHeight: number;
  numComponents: number;
}

/**
 * Locate the SIZ marker (FF 51) inside main-header bytes and return image
 * dimensions, tile dimensions, and component count. Throws if absent or
 * truncated.
 */
export function extractSizInfo(data: Uint8Array): SizInfo {
  const pos = findMarker(data, SIZ_MARKER_0, SIZ_MARKER_1);
  if (pos < 0) throw new ParseError('SIZ marker (FF 51) not found');

  const after = pos + 2;
  if (after + SIZ_MIN_BODY_BYTES > data.byteLength) {
    throw new ParseError('SIZ segment truncated: cannot read fixed prefix');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lsiz = view.getUint16(after, false);
  if (lsiz < SIZ_MIN_BODY_BYTES) {
    throw new ParseError(`SIZ Lsiz=${lsiz} below minimum ${SIZ_MIN_BODY_BYTES}`);
  }
  if (after + lsiz > data.byteLength) {
    throw new ParseError(`SIZ segment claims ${lsiz} bytes but only ${data.byteLength - after} available`);
  }
  const imageWidth = view.getUint32(after + 4, false);
  const imageHeight = view.getUint32(after + 8, false);
  const tileWidth = view.getUint32(after + 20, false);
  const tileHeight = view.getUint32(after + 24, false);
  const numComponents = view.getUint16(after + 36, false);

  if (imageWidth === 0 || imageHeight === 0) {
    throw new ParseError(`SIZ declares degenerate image dimensions ${imageWidth}x${imageHeight}`);
  }
  if (tileWidth === 0 || tileHeight === 0) {
    throw new ParseError(`SIZ declares degenerate tile dimensions ${tileWidth}x${tileHeight}`);
  }
  if (numComponents < 1 || numComponents > 4) {
    throw new ParseError(`SIZ declares unsupported Csiz=${numComponents} (expected 1..4)`);
  }
  return { imageWidth, imageHeight, tileWidth, tileHeight, numComponents };
}

function findMarker(data: Uint8Array, a: number, b: number): number {
  for (let i = 0; i + 1 < data.byteLength; i++) {
    if (data[i] === a && data[i + 1] === b) return i;
  }
  return -1;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `npm test -- markers/siz`
Expected: PASS — 4 synthetic + up to 2 real-fixture (or just 4 if no fixture).

- [ ] **Step 5: (optional) download fixtures + re-run**

```bash
npm run fetch:fixture
npm test -- markers/siz
```

- [ ] **Step 6: Commit**

```bash
git add src/markers/siz.ts tests/markers/siz.test.ts
git commit -m "feat(markers): extractSizInfo (dims + tile dims + components)"
```

---

### Task 4: Codestream navigation — SOC, first SOT, partial stitching

The JP2 box wrapping is non-codestream metadata; the actual JPEG 2000 codestream
starts at SOC = `FF 4F`. The first tile-part starts at SOT = `FF 90`. Everything
between SOC and the first SOT is the **main header prefix** — the list of
length-prefixed marker segments (SIZ, COD, COC, QCD, QCC, TLM, PLM, COM, …).

`stitchPartialCodestream` rebuilds a fresh valid codestream from a subset of
tile-part payloads: prefix (with TLM dropped) + payloads + EOC `FF D9`. The
TLM must be dropped because its original-file offsets become meaningless once
you keep only some tile-parts — OpenJPEG's `m_is_invalid` flag triggers
sequential SOT scanning instead, which is what we want.

**Reference:** `~/code/s2surgeon/src/codestream.rs` (full file).

**Files:**
- Create: `~/code/s2jp2/src/markers/codestream.ts`
- Create: `~/code/s2jp2/tests/markers/codestream.test.ts`

- [ ] **Step 1: Failing test (`tests/markers/codestream.test.ts`)**

```ts
import { describe, expect, it } from 'vitest';
import {
  firstSotOffset,
  socOffset,
  stitchPartialCodestream,
} from '../../src/markers/codestream.js';
import { ParseError } from '../../src/errors.js';

describe('SOC / SOT scanning', () => {
  it('finds SOC (FF 4F) and first SOT (FF 90)', () => {
    const buf = new Uint8Array([
      0xAA, 0xBB, 0xFF, 0x4F, 0xFF, 0x51, 0x00, 0x04, 0xAA, 0xBB,
      0xFF, 0x90, 0x00, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(socOffset(buf)).toBe(2);
    expect(firstSotOffset(buf)).toBe(10);
  });
  it('returns -1 when missing', () => {
    expect(socOffset(new Uint8Array([0, 1, 2, 3]))).toBe(-1);
    expect(firstSotOffset(new Uint8Array([0, 1, 2, 3]))).toBe(-1);
  });
});

describe('stitchPartialCodestream', () => {
  it('drops TLM segments and appends EOC', () => {
    // Prefix: SOC + SIZ-like + TLM + COD-like
    const prefix = new Uint8Array([
      0xFF, 0x4F,
      0xFF, 0x51, 0x00, 0x04, 0xAA, 0xBB,
      0xFF, 0x55, 0x00, 0x05, 0x01, 0x02, 0x03,
      0xFF, 0x52, 0x00, 0x03, 0xCC,
      0xFF, 0x90, 0x00, 0x0A,  // first SOT — boundary
    ]);
    const payloadA = new Uint8Array([0xFF, 0x90, 0x00, 0x0A, 1, 1, 1, 1, 1, 1, 1, 1]);
    const payloadB = new Uint8Array([0xFF, 0x90, 0x00, 0x0A, 2, 2, 2, 2, 2, 2, 2, 2]);
    const out = stitchPartialCodestream(prefix, [payloadA, payloadB]);
    // Expected prefix (TLM stripped, stops before first SOT)
    const expectedPrefix = new Uint8Array([
      0xFF, 0x4F,
      0xFF, 0x51, 0x00, 0x04, 0xAA, 0xBB,
      0xFF, 0x52, 0x00, 0x03, 0xCC,
    ]);
    expect(out.length).toBe(expectedPrefix.length + payloadA.length + payloadB.length + 2);
    expect(Array.from(out.slice(0, expectedPrefix.length))).toEqual(Array.from(expectedPrefix));
    expect(out[out.length - 2]).toBe(0xFF);
    expect(out[out.length - 1]).toBe(0xD9);
  });
  it('throws ParseError when SOC missing', () => {
    expect(() => stitchPartialCodestream(new Uint8Array([0, 0, 0, 0]), [])).toThrow(ParseError);
  });
  it('throws ParseError when first SOT missing', () => {
    const prefix = new Uint8Array([0xFF, 0x4F, 0xFF, 0x51, 0x00, 0x04, 0xAA, 0xBB]);
    expect(() => stitchPartialCodestream(prefix, [])).toThrow(ParseError);
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `npm test -- markers/codestream`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/markers/codestream.ts`**

```ts
import { ParseError } from '../errors.js';

const SOC = [0xff, 0x4f] as const; // start of codestream
const SOT = [0xff, 0x90] as const; // start of tile-part
const SOD = [0xff, 0x93] as const; // start of data (in tile-part)
const EOC = [0xff, 0xd9] as const; // end of codestream
const TLM = [0xff, 0x55] as const; // tile-part lengths (main header)

export function socOffset(data: Uint8Array): number {
  return findMarker(data, SOC[0], SOC[1]);
}

export function firstSotOffset(data: Uint8Array): number {
  return findMarker(data, SOT[0], SOT[1]);
}

/** Slice between SOC and the first SOT. Throws if either is missing. */
function mainHeaderPrefix(header: Uint8Array): Uint8Array {
  const soc = socOffset(header);
  if (soc < 0) throw new ParseError('SOC (FF 4F) not found in header');
  const sot = firstSotOffset(header);
  if (sot < 0) throw new ParseError('first SOT (FF 90) not found in header');
  return header.subarray(soc, sot);
}

/** Re-emit the main header prefix with TLM segments removed. */
function prefixWithoutTlm(prefix: Uint8Array): Uint8Array {
  if (prefix.byteLength < 2 || prefix[0] !== SOC[0] || prefix[1] !== SOC[1]) {
    throw new ParseError('prefix does not start with SOC (FF 4F)');
  }
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const out: number[] = [SOC[0], SOC[1]];
  let pos = 2;
  while (pos + 4 <= prefix.byteLength) {
    const m0 = prefix[pos];
    const m1 = prefix[pos + 1];
    // SOT / SOD / EOC carry no length — bail (shouldn't occur in a clean prefix)
    if (
      (m0 === SOT[0] && m1 === SOT[1]) ||
      (m0 === SOD[0] && m1 === SOD[1]) ||
      (m0 === EOC[0] && m1 === EOC[1])
    ) {
      break;
    }
    const segLen = view.getUint16(pos + 2, false);
    if (segLen < 2) {
      throw new ParseError(
        `invalid segment length ${segLen} at offset ${pos} (marker 0x${m0!.toString(16)}${m1!.toString(16)})`,
      );
    }
    const segEnd = pos + 2 + segLen;
    if (segEnd > prefix.byteLength) {
      throw new ParseError(
        `segment 0x${m0!.toString(16)}${m1!.toString(16)} extends past prefix (end=${segEnd}, len=${prefix.byteLength})`,
      );
    }
    if (!(m0 === TLM[0] && m1 === TLM[1])) {
      for (let i = pos; i < segEnd; i++) out.push(prefix[i]!);
    }
    pos = segEnd;
  }
  // Trailing bytes (defensive — should not happen given the loop boundary)
  for (let i = pos; i < prefix.byteLength; i++) out.push(prefix[i]!);
  return Uint8Array.from(out);
}

/**
 * Build a fresh valid codestream from the main header (TLM-stripped) plus
 * a sequence of tile-part payloads, terminated with EOC.
 */
export function stitchPartialCodestream(
  header: Uint8Array,
  tilePartPayloads: readonly Uint8Array[],
): Uint8Array {
  const prefix = prefixWithoutTlm(mainHeaderPrefix(header));
  const payloadBytes = tilePartPayloads.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(prefix.byteLength + payloadBytes + 2);
  out.set(prefix, 0);
  let cursor = prefix.byteLength;
  for (const p of tilePartPayloads) {
    out.set(p, cursor);
    cursor += p.byteLength;
  }
  out[cursor] = EOC[0];
  out[cursor + 1] = EOC[1];
  return out;
}

function findMarker(data: Uint8Array, a: number, b: number): number {
  for (let i = 0; i + 1 < data.byteLength; i++) {
    if (data[i] === a && data[i + 1] === b) return i;
  }
  return -1;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `npm test -- markers/codestream`
Expected: PASS — 5/5.

- [ ] **Step 5: Commit**

```bash
git add src/markers/codestream.ts tests/markers/codestream.test.ts
git commit -m "feat(markers): SOC/SOT navigation + stitchPartialCodestream"
```

---

### Task 5: TLM marker parser — tile-part lengths + absolute byte ranges

The TLM (Tile-part Length, Main header) marker (`FF 55`) lists every
tile-part's byte length, in declaration order. We use these lengths,
anchored at the first SOT, to compute the absolute byte ranges every
tile-part occupies in the file — the input to range-fetching.

TLM layout (after `FF 55`):
| Offset | Size | Field |
|--------|------|-------|
| 0      | 2 BE | Ltlm (segment length, includes itself) |
| 2      | 1    | Ztlm (instance index) |
| 3      | 1    | Stlm (entry size flags) |
| 4..    | N    | entries |

`Stlm` bits:
- ST = `(Stlm >> 4) & 0x3` — tile index field size in bytes (0, 1, or 2)
- SP = `(Stlm >> 6) & 0x3` — tile-part length field size (0 → 2 bytes; 1 → 4)

For S2 TCI, ST = 0 (no tile index field) and SP = 1 (4-byte lengths) —
each entry is 4 bytes. Number of entries = `(Ltlm - 4) / (ST + SP)`.

**Reference:** `~/code/s2surgeon/src/tlm.rs` (full file).

**Files:**
- Create: `~/code/s2jp2/src/markers/tlm.ts`
- Create: `~/code/s2jp2/tests/markers/tlm.test.ts`

- [ ] **Step 1: Failing test (`tests/markers/tlm.test.ts`)**

```ts
import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractTileLengths, tilePartRangesFromHeader } from '../../src/markers/tlm.js';
import { ParseError } from '../../src/errors.js';

function buildSyntheticTlm(lengths: readonly number[]): Uint8Array {
  // Stlm = 0b01_00_0000 → ST=0 (no tile index), SP=1 (4-byte length)
  const entryBytes = 4;
  const Ltlm = 4 + lengths.length * entryBytes; // Stlm payload length incl. itself
  const segment = new Uint8Array(2 + Ltlm);
  const view = new DataView(segment.buffer);
  segment[0] = 0xFF; segment[1] = 0x55;
  view.setUint16(2, Ltlm, false);
  segment[4] = 0;       // Ztlm
  segment[5] = 0b0100_0000; // Stlm: ST=0, SP=1
  let cursor = 6;
  for (const len of lengths) {
    view.setUint32(cursor, len, false);
    cursor += entryBytes;
  }
  return segment;
}

function withSocSotPrefix(tlm: Uint8Array): Uint8Array {
  // Synthetic main header: SOC, SIZ-like, TLM, then first SOT marker so
  // tilePartRangesFromHeader can anchor the ranges.
  const prefix = new Uint8Array([
    0xFF, 0x4F,              // SOC
    0xFF, 0x51, 0x00, 0x04, 0xAA, 0xBB, // SIZ-like
  ]);
  const sotMarker = new Uint8Array([0xFF, 0x90]);
  const out = new Uint8Array(prefix.length + tlm.length + sotMarker.length);
  out.set(prefix, 0);
  out.set(tlm, prefix.length);
  out.set(sotMarker, prefix.length + tlm.length);
  return out;
}

describe('extractTileLengths (synthetic)', () => {
  it('reads 4-byte lengths with ST=0/SP=1', () => {
    const tlm = buildSyntheticTlm([100, 200, 300, 400]);
    expect(extractTileLengths(tlm)).toEqual([100, 200, 300, 400]);
  });
  it('throws when TLM marker absent', () => {
    expect(() => extractTileLengths(new Uint8Array([0, 0, 0]))).toThrow(ParseError);
  });
  it('throws when entry size is zero (invalid Stlm)', () => {
    // Stlm=0 → ST=0, SP=0 → entry size = 0 (invalid)
    const segment = new Uint8Array([0xFF, 0x55, 0x00, 0x04, 0x00, 0x00]);
    expect(() => extractTileLengths(segment)).toThrow(ParseError);
  });
});

describe('tilePartRangesFromHeader (synthetic)', () => {
  it('anchors ranges at the first SOT offset', () => {
    const tlm = buildSyntheticTlm([100, 200, 300]);
    const header = withSocSotPrefix(tlm);
    const sotOffset = header.length - 2;
    const ranges = tilePartRangesFromHeader(header);
    expect(ranges).toEqual([
      { start: sotOffset, end: sotOffset + 100 },
      { start: sotOffset + 100, end: sotOffset + 300 },
      { start: sotOffset + 300, end: sotOffset + 600 },
    ]);
  });
  it('throws when TLM contains a zero-length entry', () => {
    const tlm = buildSyntheticTlm([100, 0, 300]);
    expect(() => tilePartRangesFromHeader(withSocSotPrefix(tlm))).toThrow(ParseError);
  });
});

const FIXTURE = 'tests/fixtures/sample_TCI_10m.jp2';
describe.runIf(existsSync(FIXTURE))('TLM (real S2 TCI)', () => {
  it('returns 121 tile-parts (S2 TCI 10m: 11x11 tiles)', () => {
    const data = readFileSync(FIXTURE);
    const header = new Uint8Array(data.buffer, data.byteOffset, 100_000);
    const ranges = tilePartRangesFromHeader(header);
    expect(ranges.length).toBe(121);
    expect(ranges[0]!.start).toBeLessThan(ranges[0]!.end);
    // Ranges must be contiguous (each end == next start)
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!.start).toBe(ranges[i - 1]!.end);
    }
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `npm test -- markers/tlm`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/markers/tlm.ts`**

```ts
import { ParseError } from '../errors.js';
import { firstSotOffset } from './codestream.js';

const TLM_MARKER_0 = 0xff;
const TLM_MARKER_1 = 0x55;

/** Decode Stlm into entry sizes. Returns [tileIndexBytes, lengthBytes]. */
function entrySizes(stlm: number): [number, number] {
  const st = (stlm >> 4) & 0x3;
  const sp = (stlm >> 6) & 0x3;
  const tBytes = st === 0 ? 0 : st === 1 ? 1 : st === 2 ? 2 : -1;
  const pBytes = sp === 0 ? 2 : sp === 1 ? 4 : -1;
  return [tBytes, pBytes];
}

/** Locate `FF 55` and return the declared tile-part byte lengths. */
export function extractTileLengths(data: Uint8Array): number[] {
  const pos = findMarker(data, TLM_MARKER_0, TLM_MARKER_1);
  if (pos < 0) throw new ParseError('TLM marker (FF 55) not found');

  const after = pos + 2;
  if (after + 4 > data.byteLength) {
    throw new ParseError('TLM segment truncated before Ltlm/Ztlm/Stlm');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ltlm = view.getUint16(after, false);
  if (ltlm < 4) throw new ParseError(`TLM Ltlm=${ltlm} below minimum 4`);
  if (after + ltlm > data.byteLength) {
    throw new ParseError(`TLM segment claims ${ltlm} bytes; only ${data.byteLength - after} available`);
  }

  const stlm = data[after + 3]!;
  const [tBytes, pBytes] = entrySizes(stlm);
  if (tBytes < 0 || pBytes < 0) {
    throw new ParseError(`TLM Stlm=0x${stlm.toString(16)} declares invalid ST/SP`);
  }
  const entrySize = tBytes + pBytes;
  if (entrySize === 0) {
    throw new ParseError('TLM entry size 0 (ST=0 + SP=0 invalid)');
  }
  const bodyBytes = ltlm - 4;
  if (bodyBytes % entrySize !== 0) {
    throw new ParseError(`TLM body ${bodyBytes} not a multiple of entry size ${entrySize}`);
  }
  const numEntries = bodyBytes / entrySize;
  const lengths: number[] = new Array(numEntries);
  let cursor = after + 4;
  for (let i = 0; i < numEntries; i++) {
    cursor += tBytes; // skip optional tile index
    if (pBytes === 2) {
      lengths[i] = view.getUint16(cursor, false);
    } else {
      lengths[i] = view.getUint32(cursor, false);
    }
    cursor += pBytes;
  }
  return lengths;
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Compute absolute byte ranges (start inclusive, end exclusive) for every
 * tile-part in the file, anchored at the first SOT offset.
 */
export function tilePartRangesFromHeader(header: Uint8Array): ByteRange[] {
  const sot = firstSotOffset(header);
  if (sot < 0) throw new ParseError('first SOT (FF 90) not found in header');
  const lengths = extractTileLengths(header);
  if (lengths.length === 0) throw new ParseError('TLM declares no tile-parts');

  const ranges: ByteRange[] = new Array(lengths.length);
  let start = sot;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    if (len === 0) {
      throw new ParseError(`TLM contains zero-length tile-part at index ${i} (offset ${start})`);
    }
    const end = start + len;
    ranges[i] = { start, end };
    start = end;
  }
  return ranges;
}

function findMarker(data: Uint8Array, a: number, b: number): number {
  for (let i = 0; i + 1 < data.byteLength; i++) {
    if (data[i] === a && data[i + 1] === b) return i;
  }
  return -1;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `npm test -- markers/tlm`
Expected: PASS — 5 synthetic + 1 real-fixture (or 5 + skip).

- [ ] **Step 5: Commit**

```bash
git add src/markers/tlm.ts tests/markers/tlm.test.ts
git commit -m "feat(markers): TLM parser + tilePartRangesFromHeader"
```

---

### Task 6: COD marker parser + S2 N0512 capability validator

The COD (Coding style, Default) marker (`FF 52`) declares the coding
parameters that apply to every component: progression order, layer count,
multi-component transform, decomposition levels, code-block dimensions,
wavelet kernel, precinct sizes. We parse it to (a) verify the asset
satisfies the `S2_N0512_CAPABILITY` predicate and (b) extract
`numDecompLevels` (varies per asset) so the runtime packet-table
computation has the input it needs.

COD payload (after `FF 52` and 2-byte Lcod):
| Offset | Size | Field |
|--------|------|-------|
| 0      | 1    | Scod (style flags; bit 0 = user-defined precincts) |
| 1      | 1    | Progression order (0=LRCP, 1=RLCP, 2=RPCL, 3=PCRL, 4=CPRL) |
| 2      | 2 BE | Number of quality layers |
| 4      | 1    | MCT (multi-component transform) |
| 5      | 1    | Number of decomposition levels |
| 6      | 1    | Code-block width exponent |
| 7      | 1    | Code-block height exponent |
| 8      | 1    | Code-block style |
| 9      | 1    | Wavelet transform (1=5/3 reversible, 0=9/7 irreversible) |
| 10..   | N    | Precinct sizes (only when Scod bit 0 set) — one byte per resolution |

**Reference:** `~/code/s2surgeon/src/cod.rs` lines 130–215.

**Files:**
- Create: `~/code/s2jp2/src/markers/cod.ts`
- Create: `~/code/s2jp2/tests/markers/cod.test.ts`

- [ ] **Step 1: Failing test (`tests/markers/cod.test.ts`)**

```ts
import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCod, validateS2N0512Capability } from '../../src/markers/cod.js';
import { ParseError, ProfileMismatchError } from '../../src/errors.js';

/** A COD shaped like S2 N0512, parameterised by decomposition level count. */
function buildSyntheticCod(numDecompLevels: number): Uint8Array {
  // Scod=01 (user precincts), prog=0 (LRCP), layers=1, MCT=1,
  // decomp=R, cbw=4, cbh=4, cbstyle=0, wavelet=1, precincts=[0x88]*(R+1)
  const Lcod = 12 + (numDecompLevels + 1);
  const head = [
    (Lcod >> 8) & 0xff, Lcod & 0xff,
    0x01,                         // Scod
    0,                            // progression LRCP
    0x00, 0x01,                   // num layers = 1
    0x01,                         // MCT
    numDecompLevels & 0xff,
    0x04,                         // cb width exp
    0x04,                         // cb height exp
    0x00,                         // cb style
    0x01,                         // wavelet 5/3
  ];
  const precincts = Array(numDecompLevels + 1).fill(0x88);
  return Uint8Array.from([0xff, 0x52, ...head, ...precincts]);
}

describe('parseCod', () => {
  it('parses a TCI-10m-shaped COD (4 decomp levels)', () => {
    const info = parseCod(buildSyntheticCod(4));
    expect(info.progression).toBe('LRCP');
    expect(info.numLayers).toBe(1);
    expect(info.mct).toBe(1);
    expect(info.numDecompLevels).toBe(4);
    expect(info.codeBlockWidthExp).toBe(4);
    expect(info.codeBlockHeightExp).toBe(4);
    expect(info.codeBlockStyle).toBe(0);
    expect(info.waveletTransform).toBe(1);
    expect(info.userDefinedPrecincts).toBe(true);
    expect(info.precincts).toEqual([[8, 8], [8, 8], [8, 8], [8, 8], [8, 8]]);
  });

  it('parses a B04-60m-shaped COD (3 decomp levels)', () => {
    const info = parseCod(buildSyntheticCod(3));
    expect(info.numDecompLevels).toBe(3);
    expect(info.precincts.length).toBe(4);
  });

  it('rejects unknown progression order', () => {
    const buf = buildSyntheticCod(4);
    // Progression byte sits at byte 5 inside the segment (FF 52 | Lcod | Scod | prog)
    buf[5] = 99;
    expect(() => parseCod(buf)).toThrow(ParseError);
  });

  it('rejects missing COD marker', () => {
    expect(() => parseCod(new Uint8Array([0, 1, 2, 3]))).toThrow(ParseError);
  });
});

describe('validateS2N0512Capability', () => {
  it('accepts a TCI 10m-shaped CodInfo', () => {
    expect(() => validateS2N0512Capability(parseCod(buildSyntheticCod(4)))).not.toThrow();
  });
  it('accepts a B04 60m-shaped CodInfo (3 decomp levels)', () => {
    expect(() => validateS2N0512Capability(parseCod(buildSyntheticCod(3)))).not.toThrow();
  });
  it('rejects RPCL progression', () => {
    const info = { ...parseCod(buildSyntheticCod(4)), progression: 'RPCL' as const };
    expect(() => validateS2N0512Capability(info)).toThrow(ProfileMismatchError);
  });
  it('rejects multi-layer COD', () => {
    const info = { ...parseCod(buildSyntheticCod(4)), numLayers: 2 };
    expect(() => validateS2N0512Capability(info)).toThrow(ProfileMismatchError);
  });
  it('rejects wrong code-block size', () => {
    const info = { ...parseCod(buildSyntheticCod(4)), codeBlockWidthExp: 5 };
    expect(() => validateS2N0512Capability(info)).toThrow(ProfileMismatchError);
  });
  it('rejects non-uniform precinct sizes', () => {
    const info = parseCod(buildSyntheticCod(4));
    const tampered = { ...info, precincts: [...info.precincts.slice(0, -1), [4, 4] as const] };
    expect(() => validateS2N0512Capability(tampered)).toThrow(ProfileMismatchError);
  });
});

const TCI = 'tests/fixtures/sample_TCI_10m.jp2';
const B04 = 'tests/fixtures/sample_B04_60m.jp2';
describe.runIf(existsSync(TCI))('COD (real TCI 10m)', () => {
  it('passes S2 N0512 capability validation', () => {
    const data = readFileSync(TCI);
    const header = new Uint8Array(data.buffer, data.byteOffset, 100_000);
    expect(() => validateS2N0512Capability(parseCod(header))).not.toThrow();
  });
});
describe.runIf(existsSync(B04))('COD (real B04 60m)', () => {
  it('passes S2 N0512 capability validation', () => {
    const data = readFileSync(B04);
    const header = new Uint8Array(data.buffer, data.byteOffset, 100_000);
    expect(() => validateS2N0512Capability(parseCod(header))).not.toThrow();
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `npm test -- markers/cod`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/markers/cod.ts`**

```ts
import { ParseError, ProfileMismatchError } from '../errors.js';
import { S2_N0512_CAPABILITY } from '../profile.js';

const COD_MARKER_0 = 0xff;
const COD_MARKER_1 = 0x52;

export type ProgressionOrder = 'LRCP' | 'RLCP' | 'RPCL' | 'PCRL' | 'CPRL';
const PROGRESSION_BY_BYTE: Record<number, ProgressionOrder> = {
  0: 'LRCP',
  1: 'RLCP',
  2: 'RPCL',
  3: 'PCRL',
  4: 'CPRL',
};

export interface CodInfo {
  lcod: number;
  scod: number;
  progression: ProgressionOrder;
  numLayers: number;
  mct: number;
  numDecompLevels: number;
  codeBlockWidthExp: number;
  codeBlockHeightExp: number;
  codeBlockStyle: number;
  waveletTransform: number;
  userDefinedPrecincts: boolean;
  precincts: ReadonlyArray<readonly [number, number]>;
}

export function parseCod(data: Uint8Array): CodInfo {
  const pos = findMarker(data, COD_MARKER_0, COD_MARKER_1);
  if (pos < 0) throw new ParseError('COD marker (FF 52) not found');

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const after = pos + 2;
  if (after + 2 > data.byteLength) throw new ParseError('COD truncated before Lcod');
  const lcod = view.getUint16(after, false);
  if (lcod < 12) throw new ParseError(`COD Lcod=${lcod} below minimum 12`);
  if (after + lcod > data.byteLength) {
    throw new ParseError(`COD claims ${lcod} bytes; only ${data.byteLength - after} available`);
  }
  // Payload begins after Lcod (which is the first 2 bytes after the marker)
  const p = after + 2;
  if (p + 10 > data.byteLength) throw new ParseError('COD payload truncated');

  const scod = data[p]!;
  const progByte = data[p + 1]!;
  const progression = PROGRESSION_BY_BYTE[progByte];
  if (!progression) {
    throw new ParseError(`COD: unknown progression order 0x${progByte.toString(16)}`);
  }
  const numLayers = view.getUint16(p + 2, false);
  const mct = data[p + 4]!;
  const numDecompLevels = data[p + 5]!;
  const codeBlockWidthExp = data[p + 6]!;
  const codeBlockHeightExp = data[p + 7]!;
  const codeBlockStyle = data[p + 8]!;
  const waveletTransform = data[p + 9]!;

  const userDefined = (scod & 0x01) !== 0;
  let precincts: ReadonlyArray<readonly [number, number]> = [];
  if (userDefined) {
    const count = numDecompLevels + 1;
    const start = p + 10;
    if (start + count > data.byteLength) {
      throw new ParseError(`COD precincts truncated: need ${count}, have ${data.byteLength - start}`);
    }
    const out: Array<readonly [number, number]> = new Array(count);
    for (let i = 0; i < count; i++) {
      const b = data[start + i]!;
      out[i] = [b & 0x0f, (b >> 4) & 0x0f];
    }
    precincts = out;
  }

  return {
    lcod,
    scod,
    progression,
    numLayers,
    mct,
    numDecompLevels,
    codeBlockWidthExp,
    codeBlockHeightExp,
    codeBlockStyle,
    waveletTransform,
    userDefinedPrecincts: userDefined,
    precincts,
  };
}

/**
 * Validate a parsed CodInfo against the fixed parts of the S2 N0512 framework.
 * Does NOT pin numDecompLevels (varies per asset, captured by the caller for
 * runtime packet-table computation).
 */
export function validateS2N0512Capability(info: CodInfo): void {
  const cap = S2_N0512_CAPABILITY;
  const checks: Array<[string, unknown, unknown]> = [
    ['progression', cap.progression, info.progression],
    ['numLayers', cap.numLayers, info.numLayers],
    ['codeBlockWidthExp', cap.codeBlockWidthExp, info.codeBlockWidthExp],
    ['codeBlockHeightExp', cap.codeBlockHeightExp, info.codeBlockHeightExp],
    ['codeBlockStyle', cap.codeBlockStyle, info.codeBlockStyle],
    ['waveletTransform', cap.waveletTransform, info.waveletTransform],
    ['userDefinedPrecincts', cap.userDefinedPrecincts, info.userDefinedPrecincts],
  ];
  for (const [field, expected, actual] of checks) {
    if (expected !== actual) {
      throw new ProfileMismatchError(
        `COD field ${field} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
  const [ppx, ppy] = cap.precinctSize;
  for (let i = 0; i < info.precincts.length; i++) {
    const [aw, ah] = info.precincts[i]!;
    if (aw !== ppx || ah !== ppy) {
      throw new ProfileMismatchError(
        `COD precinct[${i}] mismatch: expected [${ppx},${ppy}], got [${aw},${ah}]`,
      );
    }
  }
}

function findMarker(data: Uint8Array, a: number, b: number): number {
  for (let i = 0; i + 1 < data.byteLength; i++) {
    if (data[i] === a && data[i + 1] === b) return i;
  }
  return -1;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `npm test -- markers/cod`
Expected: PASS — 5 synthetic + 1 real-fixture (or 5 + skip).

- [ ] **Step 5: Commit**

```bash
git add src/markers/cod.ts tests/markers/cod.test.ts
git commit -m "feat(markers): COD parser + S2 N0512 capability validator"
```

---

### Task 7: Window / tile-grid math (parameterised by runtime SIZ)

The tile grid varies per asset: 10980 / 1024 = 11×11 tiles for 10 m,
5490 / 1024 = 6×6 tiles for 20 m, 1830 / 1024 = 2×2 tiles for 60 m
(rounded up). All math takes a `TileGrid` derived from SIZ at runtime;
no asset-specific constants.

**Reference:** `~/code/s2surgeon/src/window.rs` (shape only — constants
are replaced by parameters).

**Files:**
- Create: `~/code/s2jp2/src/window.ts`
- Create: `~/code/s2jp2/tests/window.test.ts`

- [ ] **Step 1: Failing test (`tests/window.test.ts`)**

```ts
import { describe, expect, it } from 'vitest';
import {
  groupedTilePartRanges, tileGridFromSiz, validateWindow, windowTileIndices,
} from '../src/window.js';
import { WindowError } from '../src/errors.js';

const TCI_10M = tileGridFromSiz({
  imageWidth: 10980, imageHeight: 10980, tileWidth: 1024, tileHeight: 1024,
  numComponents: 3,
});
const B04_60M = tileGridFromSiz({
  imageWidth: 1830, imageHeight: 1830, tileWidth: 1024, tileHeight: 1024,
  numComponents: 1,
});

describe('tileGridFromSiz', () => {
  it('computes 11×11 tile grid for TCI 10m', () => {
    expect(TCI_10M.tilesPerRow).toBe(11);
    expect(TCI_10M.tilesPerCol).toBe(11);
    expect(TCI_10M.totalTiles).toBe(121);
  });
  it('computes 2×2 tile grid for B04 60m', () => {
    expect(B04_60M.tilesPerRow).toBe(2);
    expect(B04_60M.tilesPerCol).toBe(2);
    expect(B04_60M.totalTiles).toBe(4);
  });
});

describe('windowTileIndices', () => {
  it('single tile when window lies inside tile (0,0) of TCI 10m', () => {
    expect(windowTileIndices(TCI_10M, 0, 0, 100, 100)).toEqual([0]);
  });
  it('returns 4 corner tiles for 2×2 spread on TCI 10m', () => {
    expect(windowTileIndices(TCI_10M, 900, 900, 200, 200)).toEqual([0, 1, 11, 12]);
  });
  it('full image → all 121 tiles on TCI 10m', () => {
    const all = windowTileIndices(TCI_10M, 0, 0, 10980, 10980);
    expect(all.length).toBe(121);
    expect(all[120]).toBe(120);
  });
  it('full image → all 4 tiles on B04 60m', () => {
    expect(windowTileIndices(B04_60M, 0, 0, 1830, 1830)).toEqual([0, 1, 2, 3]);
  });
});

describe('validateWindow', () => {
  it('accepts a valid window on TCI 10m', () => {
    expect(() => validateWindow(TCI_10M, 0, 0, 1024, 1024)).not.toThrow();
  });
  it('rejects window past the image extent', () => {
    expect(() => validateWindow(TCI_10M, 10000, 0, 2000, 100)).toThrow(WindowError);
  });
  it('rejects zero-sized window', () => {
    expect(() => validateWindow(TCI_10M, 0, 0, 0, 100)).toThrow(WindowError);
  });
  it('accepts a full-image window on B04 60m', () => {
    expect(() => validateWindow(B04_60M, 0, 0, 1830, 1830)).not.toThrow();
  });
});

describe('groupedTilePartRanges', () => {
  const ranges = Array.from({ length: 5 }, (_, i) => ({ start: i * 100, end: i * 100 + 100 }));
  it('collapses contiguous indices into one range', () => {
    expect(groupedTilePartRanges(ranges, [0, 1, 2])).toEqual([{ start: 0, end: 300 }]);
  });
  it('keeps gaps as separate ranges', () => {
    expect(groupedTilePartRanges(ranges, [0, 1, 3, 4])).toEqual([
      { start: 0, end: 200 },
      { start: 300, end: 500 },
    ]);
  });
  it('throws on empty tile index list', () => {
    expect(() => groupedTilePartRanges(ranges, [])).toThrow(WindowError);
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `npm test -- window`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/window.ts`**

```ts
import { WindowError } from './errors.js';
import type { ByteRange } from './markers/tlm.js';
import type { SizInfo } from './markers/siz.js';

export interface TileGrid {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly tilesPerRow: number;
  readonly tilesPerCol: number;
  readonly totalTiles: number;
  readonly numComponents: number;
}

export function tileGridFromSiz(siz: SizInfo): TileGrid {
  const tilesPerRow = Math.ceil(siz.imageWidth / siz.tileWidth);
  const tilesPerCol = Math.ceil(siz.imageHeight / siz.tileHeight);
  return {
    imageWidth: siz.imageWidth,
    imageHeight: siz.imageHeight,
    tileWidth: siz.tileWidth,
    tileHeight: siz.tileHeight,
    tilesPerRow,
    tilesPerCol,
    totalTiles: tilesPerRow * tilesPerCol,
    numComponents: siz.numComponents,
  };
}

export function validateWindow(
  grid: TileGrid, x: number, y: number, width: number, height: number,
): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) ||
      !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new WindowError('window coordinates must be integers');
  }
  if (width <= 0 || height <= 0) {
    throw new WindowError(`window must be positive: width=${width}, height=${height}`);
  }
  if (x < 0 || y < 0) {
    throw new WindowError(`window origin must be non-negative: x=${x}, y=${y}`);
  }
  if (x + width > grid.imageWidth || y + height > grid.imageHeight) {
    throw new WindowError(
      `window exceeds image ${grid.imageWidth}×${grid.imageHeight}: ` +
      `x=${x}, y=${y}, width=${width}, height=${height}`,
    );
  }
}

/**
 * Tile indices the window intersects, row-major (top-to-bottom, left-to-right).
 * Returned indices are non-decreasing.
 */
export function windowTileIndices(
  grid: TileGrid, x: number, y: number, width: number, height: number,
): number[] {
  const endX = x + width;
  const endY = y + height;
  const tileMinX = Math.floor(x / grid.tileWidth);
  const tileMaxX = Math.floor((endX - 1) / grid.tileWidth);
  const tileMinY = Math.floor(y / grid.tileHeight);
  const tileMaxY = Math.floor((endY - 1) / grid.tileHeight);
  const out: number[] = [];
  for (let ty = tileMinY; ty <= tileMaxY; ty++) {
    for (let tx = tileMinX; tx <= tileMaxX; tx++) {
      out.push(ty * grid.tilesPerRow + tx);
    }
  }
  return out;
}

/**
 * Merge contiguous tile indices into the minimal set of byte ranges —
 * fewer HTTP Range requests. Assumes `tileIndices` ascending (which
 * windowTileIndices guarantees).
 */
export function groupedTilePartRanges(
  ranges: readonly ByteRange[],
  tileIndices: readonly number[],
): ByteRange[] {
  if (tileIndices.length === 0) {
    throw new WindowError('no tile indices supplied');
  }
  const out: ByteRange[] = [];
  let groupStart = tileIndices[0]!;
  let prev = groupStart;
  for (let i = 1; i < tileIndices.length; i++) {
    const idx = tileIndices[i]!;
    if (idx === prev + 1) {
      prev = idx;
      continue;
    }
    out.push({ start: ranges[groupStart]!.start, end: ranges[prev]!.end });
    groupStart = idx;
    prev = idx;
  }
  out.push({ start: ranges[groupStart]!.start, end: ranges[prev]!.end });
  return out;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `npm test -- window`
Expected: PASS — 12/12.

- [ ] **Step 5: Commit**

```bash
git add src/window.ts tests/window.test.ts
git commit -m "feat: parameterised tile-grid + window math"
```

---

### Task 8: PLT parser + tile-part packet truncation

PLT (Packet Length, Tile-part header) marker `FF 58` lists every packet's
length in the tile-part body using a 7-bit variable-length encoding: each
byte contributes its low 7 bits, the high bit signals "more bytes follow".

`extractPacketLengths` walks a tile-part: skip the SOT (always 12 bytes),
collect every PLT segment's `Iplt` bytes, stop at SOD (`FF 93`). It
defends against any tile-part lacking PLT entirely (which would be invalid
for N0512).

`truncateToPackets` rewrites a tile-part keeping only the first N packets:
SOT (with patched Psot) + PLT(s) + SOD + first N packets' raw bytes.

**Reference:** `~/code/s2surgeon/src/plt.rs` (full file).

**Files:**
- Create: `~/code/s2jp2/src/markers/plt.ts`
- Create: `~/code/s2jp2/tests/markers/plt.test.ts`

- [ ] **Step 1: Failing test (`tests/markers/plt.test.ts`)**

```ts
import { describe, expect, it } from 'vitest';
import {
  decodePacketLengths, extractPacketLengths, payloadSize, sodOffset, truncateToPackets,
} from '../../src/markers/plt.js';
import { ParseError } from '../../src/errors.js';

function syntheticTilePart(): Uint8Array {
  return Uint8Array.from([
    // SOT: FF 90, Lsot=000A, Isot=0000, Psot=0000001F (31), TPsot=00, TNsot=01
    0xFF, 0x90, 0x00, 0x0A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F, 0x00, 0x01,
    // PLT: FF 58, Lplt=0006, Zplt=00, Iplt=[2,3,4]
    0xFF, 0x58, 0x00, 0x06, 0x00, 0x02, 0x03, 0x04,
    // SOD
    0xFF, 0x93,
    // Payload: 2 + 3 + 4 = 9 bytes
    0x10, 0x11, 0x20, 0x21, 0x22, 0x30, 0x31, 0x32, 0x33,
  ]);
}

describe('decodePacketLengths', () => {
  it('reads single-byte lengths', () => {
    expect(decodePacketLengths(new Uint8Array([0x01, 0x7F, 0x00]))).toEqual([1, 127, 0]);
  });
  it('reads multi-byte continuations', () => {
    expect(decodePacketLengths(new Uint8Array([0x81, 0x00, 0x82, 0x2C]))).toEqual([128, 300]);
  });
  it('throws on truncated continuation', () => {
    expect(() => decodePacketLengths(new Uint8Array([0x81]))).toThrow(ParseError);
  });
});

describe('sodOffset / extractPacketLengths / payloadSize', () => {
  const tp = syntheticTilePart();
  it('finds SOD', () => { expect(sodOffset(tp)).toBe(20); });
  it('extracts packet lengths', () => {
    expect(extractPacketLengths(tp)).toEqual([2, 3, 4]);
  });
  it('reports payload size', () => {
    expect(payloadSize(tp)).toBe(9);
  });
  it('throws when PLT missing', () => {
    const noPlt = Uint8Array.from([
      0xFF, 0x90, 0x00, 0x0A, 0, 0, 0, 0, 0, 0x16, 0, 1,
      0xFF, 0x93, 1, 2, 3, 4,
    ]);
    expect(() => extractPacketLengths(noPlt)).toThrow(ParseError);
  });
});

describe('truncateToPackets', () => {
  it('keeps first 2 packets, patches Psot', () => {
    const tp = syntheticTilePart();
    const out = truncateToPackets(tp, 2);
    expect(out.byteLength).toBe(27);
    // Psot at bytes [6..10] BE should equal 27
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(view.getUint32(6, false)).toBe(27);
  });
  it('keeps zero packets', () => {
    const out = truncateToPackets(syntheticTilePart(), 0);
    expect(out.byteLength).toBe(22);
  });
  it('all packets → byte-identical to input', () => {
    const tp = syntheticTilePart();
    const out = truncateToPackets(tp, 3);
    expect(Array.from(out)).toEqual(Array.from(tp));
  });
  it('rejects keep > packetCount', () => {
    expect(() => truncateToPackets(syntheticTilePart(), 4)).toThrow(ParseError);
  });
  it('rejects missing SOT', () => {
    const broken = syntheticTilePart();
    broken[0] = 0x00;
    expect(() => truncateToPackets(broken, 1)).toThrow(ParseError);
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `npm test -- markers/plt`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/markers/plt.ts`**

```ts
import { ParseError } from '../errors.js';

const SOT = [0xff, 0x90] as const;
const PLT = [0xff, 0x58] as const;
const SOD = [0xff, 0x93] as const;
const SOT_LENGTH = 12; // SOT is always 12 bytes (Lsot=0x000A + 2-byte marker)

export function decodePacketLengths(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let current = 0;
  let inProgress = false;
  for (let i = 0; i < bytes.byteLength; i++) {
    const b = bytes[i]!;
    current = ((current << 7) | (b & 0x7f)) >>> 0;
    inProgress = true;
    if ((b & 0x80) === 0) {
      out.push(current);
      current = 0;
      inProgress = false;
    }
  }
  if (inProgress) {
    throw new ParseError('PLT packet length table ends mid-continuation');
  }
  return out;
}

export function sodOffset(tilePart: Uint8Array): number {
  for (let i = 0; i + 1 < tilePart.byteLength; i++) {
    if (tilePart[i] === SOD[0] && tilePart[i + 1] === SOD[1]) return i;
  }
  throw new ParseError('SOD marker (FF 93) not found in tile-part');
}

export function payloadSize(tilePart: Uint8Array): number {
  const sod = sodOffset(tilePart);
  return tilePart.byteLength - (sod + 2);
}

export function extractPacketLengths(tilePart: Uint8Array): number[] {
  const sod = sodOffset(tilePart);
  const view = new DataView(tilePart.buffer, tilePart.byteOffset, tilePart.byteLength);
  let pos = 0;
  const lengths: number[] = [];
  let foundPlt = false;

  while (pos + 2 <= sod) {
    const m0 = tilePart[pos]!;
    const m1 = tilePart[pos + 1]!;

    // SOT inside the tile-part (rare — appears only when concatenating tile-parts)
    if (m0 === SOT[0] && m1 === SOT[1]) {
      if (pos + SOT_LENGTH > tilePart.byteLength) {
        throw new ParseError('truncated SOT inside tile-part');
      }
      pos += SOT_LENGTH;
      continue;
    }

    if (m0 === PLT[0] && m1 === PLT[1]) {
      if (pos + 5 > tilePart.byteLength) throw new ParseError('truncated PLT segment');
      const lplt = view.getUint16(pos + 2, false);
      if (lplt < 3) throw new ParseError(`invalid Lplt=${lplt}`);
      const end = pos + 2 + lplt;
      if (end > tilePart.byteLength) {
        throw new ParseError(`PLT extends past tile-part: end=${end}, len=${tilePart.byteLength}`);
      }
      const ipltBytes = tilePart.subarray(pos + 5, end);
      for (const v of decodePacketLengths(ipltBytes)) lengths.push(v);
      foundPlt = true;
      pos = end;
      continue;
    }

    if (m0 === SOD[0] && m1 === SOD[1]) break;

    // Generic length-prefixed marker (QCD, COD, etc.) — skip
    if (pos + 4 > tilePart.byteLength) {
      throw new ParseError(`cannot read marker length at offset ${pos}`);
    }
    const segLen = view.getUint16(pos + 2, false);
    if (segLen < 2) {
      throw new ParseError(`invalid segment length ${segLen} at offset ${pos}`);
    }
    const end = pos + 2 + segLen;
    if (end > tilePart.byteLength) {
      throw new ParseError(`segment at offset ${pos} extends past tile-part`);
    }
    pos = end;
  }

  if (!foundPlt) throw new ParseError('no PLT segment found in tile-part');
  return lengths;
}

export function truncateToPackets(tilePart: Uint8Array, keepPackets: number): Uint8Array {
  if (tilePart.byteLength < SOT_LENGTH) {
    throw new ParseError(`tile-part too short for SOT: len=${tilePart.byteLength}`);
  }
  if (tilePart[0] !== SOT[0] || tilePart[1] !== SOT[1]) {
    throw new ParseError('tile-part does not start with SOT (FF 90)');
  }
  if (tilePart[2] !== 0x00 || tilePart[3] !== 0x0a) {
    throw new ParseError(
      `unexpected Lsot 0x${tilePart[2]!.toString(16)}${tilePart[3]!.toString(16)} (expected 0x000A)`,
    );
  }

  const sod = sodOffset(tilePart);
  const payloadStart = sod + 2;
  const lengths = extractPacketLengths(tilePart);
  if (keepPackets > lengths.length) {
    throw new ParseError(`keep=${keepPackets} > packet count ${lengths.length}`);
  }
  let keepBytes = 0;
  for (let i = 0; i < keepPackets; i++) keepBytes += lengths[i]!;
  if (payloadStart + keepBytes > tilePart.byteLength) {
    throw new ParseError(
      `keepBytes=${keepBytes} overruns tile-part (payloadStart=${payloadStart}, len=${tilePart.byteLength})`,
    );
  }

  const out = new Uint8Array(payloadStart + keepBytes);
  out.set(tilePart.subarray(0, payloadStart), 0);
  out.set(tilePart.subarray(payloadStart, payloadStart + keepBytes), payloadStart);
  // Patch Psot (4 BE bytes at offset 6 in the SOT)
  const view = new DataView(out.buffer);
  view.setUint32(6, out.byteLength, false);
  return out;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `npm test -- markers/plt`
Expected: PASS — 11/11.

- [ ] **Step 5: Commit**

```bash
git add src/markers/plt.ts tests/markers/plt.test.ts
git commit -m "feat(markers): PLT parser + truncateToPackets"
```

---

### Task 9: Decoder facade — typed TS wrapper + 16-bit support

The spike's wrapper hard-clamped pixels to uint8 — fine for TCI / SCL /
CLD / SNW, but it would corrupt every reflectance band (uint16). Step 1
of this task updates `wrapper/jp2.cpp` to return native precision, then
rebuilds the WASM. Steps 2 onward add the typed TS facade.

**Files:**
- Modify: `~/code/s2jp2/wrapper/jp2.cpp` (16-bit output path, `bitsPerSample` accessor)
- Modify: `~/code/s2jp2/src/decoder/stex-jp2.{wasm,mjs}` (regenerated)
- Create: `~/code/s2jp2/src/decoder/decoder.ts`
- Create: `~/code/s2jp2/tests/decoder.test.ts`

- [ ] **Step 0: Update `wrapper/jp2.cpp` to return native-precision pixels**

Replace the `DecodeResult` class and the planar→interleaved copy block at
the end of `decode()` with:

```cpp
class DecodeResult {
public:
    emscripten::val pixels() const {
        if (bitsPerSample_ <= 8) {
            return emscripten::val(emscripten::typed_memory_view(buf8_.size(), buf8_.data()));
        }
        return emscripten::val(emscripten::typed_memory_view(buf16_.size(), buf16_.data()));
    }
    std::uint32_t width() const { return width_; }
    std::uint32_t height() const { return height_; }
    std::uint32_t numComponents() const { return numComps_; }
    std::uint32_t bitsPerSample() const { return bitsPerSample_; }
    std::string error() const { return error_; }
    bool ok() const { return error_.empty(); }

    std::vector<std::uint8_t>  buf8_;
    std::vector<std::uint16_t> buf16_;
    std::uint32_t width_{0};
    std::uint32_t height_{0};
    std::uint32_t numComps_{0};
    std::uint32_t bitsPerSample_{0};
    std::string error_;
};
```

And the conversion block at the end of `decode()`:

```cpp
const OPJ_UINT32 prec = image->comps[0].prec;
for (OPJ_UINT32 c = 1; c < numComps; ++c) {
    if (image->comps[c].prec != prec) {
        // Cleanup omitted for brevity — same as spike
        out.error_ = "mixed component precisions not supported";
        return out;
    }
}
out.bitsPerSample_ = prec;

const std::size_t pixels = static_cast<std::size_t>(w) * h;
if (prec <= 8) {
    out.buf8_.resize(pixels * numComps);
    for (OPJ_UINT32 c = 0; c < numComps; ++c) {
        const OPJ_INT32* src = image->comps[c].data;
        std::uint8_t* dst = out.buf8_.data() + c;
        for (std::size_t i = 0; i < pixels; ++i) {
            OPJ_INT32 v = src[i];
            if (v < 0) v = 0;
            if (v > 255) v = 255;
            *dst = static_cast<std::uint8_t>(v);
            dst += numComps;
        }
    }
} else {
    const OPJ_INT32 maxv = (1 << prec) - 1;
    out.buf16_.resize(pixels * numComps);
    for (OPJ_UINT32 c = 0; c < numComps; ++c) {
        const OPJ_INT32* src = image->comps[c].data;
        std::uint16_t* dst = out.buf16_.data() + c;
        for (std::size_t i = 0; i < pixels; ++i) {
            OPJ_INT32 v = src[i];
            if (v < 0) v = 0;
            if (v > maxv) v = maxv;
            *dst = static_cast<std::uint16_t>(v);
            dst += numComps;
        }
    }
}
```

And extend the embind class definition:

```cpp
EMSCRIPTEN_BINDINGS(stex_jp2) {
    emscripten::class_<DecodeResult>("DecodeResult")
        .function("pixels", &DecodeResult::pixels)
        .function("width", &DecodeResult::width)
        .function("height", &DecodeResult::height)
        .function("numComponents", &DecodeResult::numComponents)
        .function("bitsPerSample", &DecodeResult::bitsPerSample)
        .function("error", &DecodeResult::error)
        .function("ok", &DecodeResult::ok);
    emscripten::function("decode", &decode);
}
```

- [ ] **Step 0a: Rebuild the WASM**

Run:
```bash
npm run build:wasm
ls -la src/decoder/stex-jp2.{wasm,mjs}
```

Expected: both regenerated, `.wasm` size still ~250 KB.

- [ ] **Step 1: Failing test (`tests/decoder.test.ts`)**

```ts
import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadDecoder } from '../src/decoder/decoder.js';

const TCI = 'tests/fixtures/sample_TCI_10m.jp2';
const B04 = 'tests/fixtures/sample_B04_60m.jp2';

describe.runIf(existsSync(TCI))('Decoder (TCI 10m uint8 RGB)', () => {
  it('decodes the full image at cp_reduce=4 as Uint8Array', async () => {
    const decoder = await loadDecoder();
    const data = readFileSync(TCI);
    const r = decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
      reduceLevel: 4,
    });
    expect(r.width).toBe(687);
    expect(r.height).toBe(687);
    expect(r.numComponents).toBe(3);
    expect(r.bitsPerSample).toBe(8);
    expect(r.pixels).toBeInstanceOf(Uint8Array);
    expect(r.pixels.byteLength).toBe(687 * 687 * 3);
  });

  it('decodes a 2048×2048 window at cp_reduce=3 → 256×256 uint8 RGB', async () => {
    const decoder = await loadDecoder();
    const data = readFileSync(TCI);
    const r = decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
      reduceLevel: 3,
      decodeArea: { x0: 4466, y0: 4466, x1: 6514, y1: 6514 },
    });
    expect(r.width).toBe(256);
    expect(r.height).toBe(256);
    expect(r.numComponents).toBe(3);
    expect(r.bitsPerSample).toBe(8);
    expect(r.pixels).toBeInstanceOf(Uint8Array);
  });
});

describe.runIf(existsSync(B04))('Decoder (B04 60m single-band uint16)', () => {
  it('decodes the full image as a single-component Uint16Array', async () => {
    const decoder = await loadDecoder();
    const data = readFileSync(B04);
    const r = decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
      reduceLevel: 0,
    });
    expect(r.width).toBe(1830);
    expect(r.height).toBe(1830);
    expect(r.numComponents).toBe(1);
    expect(r.bitsPerSample).toBeGreaterThan(8);
    expect(r.pixels).toBeInstanceOf(Uint16Array);
    expect(r.pixels.length).toBe(1830 * 1830);
  });
});

describe('Decoder error surfacing', () => {
  it('throws rather than returning a degenerate result', async () => {
    const decoder = await loadDecoder();
    expect(() =>
      decoder.decode(new Uint8Array([0, 0, 0, 0]), { reduceLevel: 0 }),
    ).toThrow(/decode/i);
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `npm test -- decoder`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/decoder/decoder.ts`**

```ts
interface StexJp2Module {
  decode(
    encoded: Uint8Array,
    reduceLevel: number,
    useArea: boolean,
    x0: number, y0: number, x1: number, y1: number,
  ): StexJp2DecodeResult;
}
interface StexJp2DecodeResult {
  ok(): boolean;
  error(): string;
  width(): number;
  height(): number;
  numComponents(): number;
  bitsPerSample(): number;
  pixels(): Uint8Array | Uint16Array;
}

export interface DecodeArea {
  x0: number; y0: number; x1: number; y1: number;
}
export interface DecodeOptions {
  reduceLevel?: number;
  decodeArea?: DecodeArea;
}
export interface DecodeResult {
  pixels: Uint8Array | Uint16Array;
  width: number;
  height: number;
  numComponents: number;
  bitsPerSample: number;
}

export class Decoder {
  private constructor(private readonly module: StexJp2Module) {}

  static async load(): Promise<Decoder> {
    const factory = (await import('./stex-jp2.mjs')) as unknown as {
      default: () => Promise<StexJp2Module>;
    };
    const module = await factory.default();
    return new Decoder(module);
  }

  decode(encoded: Uint8Array, options: DecodeOptions = {}): DecodeResult {
    const reduce = options.reduceLevel ?? 0;
    const area = options.decodeArea;
    const result = this.module.decode(
      encoded,
      reduce,
      area !== undefined,
      area?.x0 ?? 0, area?.y0 ?? 0, area?.x1 ?? 0, area?.y1 ?? 0,
    );
    if (!result.ok()) {
      throw new Error(`JP2 decode failed: ${result.error() || 'unknown error'}`);
    }
    // The WASM returns a typed view into module memory; copy out so the
    // caller owns the bytes and they survive subsequent decode() calls.
    const view = result.pixels();
    const pixels = view instanceof Uint16Array
      ? new Uint16Array(view)
      : new Uint8Array(view);
    return {
      pixels,
      width: result.width(),
      height: result.height(),
      numComponents: result.numComponents(),
      bitsPerSample: result.bitsPerSample(),
    };
  }
}

export async function loadDecoder(): Promise<Decoder> {
  return Decoder.load();
}
```

- [ ] **Step 4: Verify tests pass**

Run: `npm run fetch:fixture && npm test -- decoder`
Expected: PASS — 3/3 if fixture present.

- [ ] **Step 5: Commit**

```bash
git add src/decoder/decoder.ts tests/decoder.test.ts
git commit -m "feat(decoder): typed TS facade over the WASM module"
```

---

### Task 10: `inspectAsset` + high-level planner

Two related modules in one task:

(a) **`inspectAsset(header)`** — the entry point STEX will call to decide
whether to offer the JP2 visualization for a given asset. Parses SIZ +
COD + TLM, validates the S2 N0512 capability predicate, derives the
runtime tile grid and packet table, returns an `AssetDescriptor` bundle.

(b) **`planWindowFetches(descriptor, window, overviewLevel)`** — given an
`AssetDescriptor` and a window in source pixels, returns byte ranges to
fetch and per-tile-part packet-keep instructions.

The split lets STEX cache one `AssetDescriptor` per item and plan multiple
tile fetches against it without re-parsing the header.

**Files:**
- Create: `~/code/s2jp2/src/inspect.ts`
- Create: `~/code/s2jp2/src/planner.ts`
- Create: `~/code/s2jp2/tests/planner.test.ts`

- [ ] **Step 1: Failing test (`tests/planner.test.ts`)**

```ts
import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectAsset } from '../src/inspect.js';
import { planWindowFetches } from '../src/planner.js';

const TCI = 'tests/fixtures/sample_TCI_10m.jp2';
const B04 = 'tests/fixtures/sample_B04_60m.jp2';

describe.runIf(existsSync(TCI))('inspectAsset (TCI 10m)', () => {
  it('summarises the asset', () => {
    const data = readFileSync(TCI);
    const a = inspectAsset(new Uint8Array(data.buffer, data.byteOffset, 100_000));
    expect(a.tileGrid.imageWidth).toBe(10980);
    expect(a.tileGrid.totalTiles).toBe(121);
    expect(a.numComponents).toBe(3);
    expect(a.numDecompLevels).toBe(4);
    expect(a.numResolutions).toBe(5);
    expect(a.packetTable.cumulativePackets).toEqual([3, 6, 9, 21, 69]);
  });
});

describe.runIf(existsSync(B04))('inspectAsset (B04 60m)', () => {
  it('summarises the single-band 60m asset', () => {
    const data = readFileSync(B04);
    const a = inspectAsset(new Uint8Array(data.buffer, data.byteOffset, 100_000));
    expect(a.tileGrid.imageWidth).toBe(1830);
    expect(a.numComponents).toBe(1);
    expect(a.numResolutions).toBeGreaterThanOrEqual(3);
    expect(a.packetTable.cumulativePackets.at(-1)).toBeLessThan(69);
  });
});

describe.runIf(existsSync(TCI))('planWindowFetches (TCI 10m)', () => {
  it('plans a 100×100 window at overview 4 → one tile, 3 packets', () => {
    const data = readFileSync(TCI);
    const header = new Uint8Array(data.buffer, data.byteOffset, 100_000);
    const descriptor = inspectAsset(header);
    const plan = planWindowFetches(descriptor, { x: 0, y: 0, width: 100, height: 100 }, 4);
    expect(plan.tileIndices).toEqual([0]);
    expect(plan.keepPackets).toBe(3);
    expect(plan.ranges.length).toBe(1);
  });
  it('plans a 2×2 spread at overview 0 → 4 tiles, 69 packets, 2 coalesced ranges', () => {
    const data = readFileSync(TCI);
    const header = new Uint8Array(data.buffer, data.byteOffset, 100_000);
    const descriptor = inspectAsset(header);
    const plan = planWindowFetches(descriptor, { x: 900, y: 900, width: 200, height: 200 }, 0);
    expect(plan.tileIndices).toEqual([0, 1, 11, 12]);
    expect(plan.keepPackets).toBe(69);
    expect(plan.ranges.length).toBe(2);
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `npm test -- planner`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement `src/inspect.ts`**

```ts
import { parseCod, validateS2N0512Capability } from './markers/cod.js';
import type { CodInfo } from './markers/cod.js';
import { extractSizInfo } from './markers/siz.js';
import type { SizInfo } from './markers/siz.js';
import { tilePartRangesFromHeader } from './markers/tlm.js';
import type { ByteRange } from './markers/tlm.js';
import { computePacketTable } from './profile.js';
import type { PacketTable } from './profile.js';
import { tileGridFromSiz } from './window.js';
import type { TileGrid } from './window.js';

export interface AssetDescriptor {
  siz: SizInfo;
  cod: CodInfo;
  tileGrid: TileGrid;
  numComponents: number;
  numDecompLevels: number;
  numResolutions: number;
  packetTable: PacketTable;
  tileRanges: ByteRange[];
  /** The header bytes used to derive everything above (sub-array of the input). */
  header: Uint8Array;
}

/**
 * Validate + summarise a JP2 main header. Throws `ParseError`/`ProfileMismatchError`/`WindowError`
 * if anything fails, otherwise returns everything downstream code needs to plan
 * windowed fetches and decodes.
 */
export function inspectAsset(header: Uint8Array): AssetDescriptor {
  const siz = extractSizInfo(header);
  const cod = parseCod(header);
  validateS2N0512Capability(cod);
  const tileGrid = tileGridFromSiz(siz);
  const packetTable = computePacketTable({
    numDecompLevels: cod.numDecompLevels,
    numComponents: siz.numComponents,
  });
  const tileRanges = tilePartRangesFromHeader(header);
  return {
    siz,
    cod,
    tileGrid,
    numComponents: siz.numComponents,
    numDecompLevels: cod.numDecompLevels,
    numResolutions: cod.numDecompLevels + 1,
    packetTable,
    tileRanges,
    header,
  };
}
```

- [ ] **Step 4: Implement `src/planner.ts`**

```ts
import { WindowError } from './errors.js';
import type { AssetDescriptor } from './inspect.js';
import type { ByteRange } from './markers/tlm.js';
import { keepPacketsForOverview } from './profile.js';
import {
  groupedTilePartRanges, validateWindow, windowTileIndices,
} from './window.js';

export interface Window {
  x: number; y: number; width: number; height: number;
}

export interface FetchPlan {
  tileIndices: number[];
  tileRanges: ByteRange[];   // intersecting tile-parts in TLM order
  ranges: ByteRange[];       // coalesced ranges for fetching
  keepPackets: number;
  totalPackets: number;
}

export function planWindowFetches(
  descriptor: AssetDescriptor,
  window: Window,
  overviewLevel: number,
): FetchPlan {
  validateWindow(descriptor.tileGrid, window.x, window.y, window.width, window.height);
  const keepPackets = keepPacketsForOverview(overviewLevel, descriptor.packetTable);
  if (keepPackets === null) {
    throw new WindowError(
      `overview level ${overviewLevel} exceeds asset max ${descriptor.numDecompLevels}`,
    );
  }
  const totalPackets = descriptor.packetTable.cumulativePackets.at(-1) ?? 0;
  const tileIndices = windowTileIndices(
    descriptor.tileGrid, window.x, window.y, window.width, window.height,
  );
  const tileRanges = tileIndices.map((idx) => {
    const r = descriptor.tileRanges[idx];
    if (!r) throw new WindowError(`tile index ${idx} out of TLM range (${descriptor.tileRanges.length})`);
    return r;
  });
  const grouped = groupedTilePartRanges(descriptor.tileRanges, tileIndices);
  return { tileIndices, tileRanges, ranges: grouped, keepPackets, totalPackets };
}
```

- [ ] **Step 5: Verify tests pass**

Run: `npm test -- planner`
Expected: PASS — up to 5 (TCI + B04 fixtures) or skip if absent.

- [ ] **Step 6: Commit**

```bash
git add src/inspect.ts src/planner.ts tests/planner.test.ts
git commit -m "feat(planner): inspectAsset + planWindowFetches"
```

---

### Task 11: End-to-end pipeline + public API

The pipeline accepts a `RangeFetcher` (consumer-supplied: HTTPS, SigV4 S3,
file system, whatever) and orchestrates: fetch header → plan → fetch
tile-parts → per-tile-part truncate → stitch → decode. The test uses a
file-backed fetcher to validate end-to-end against the real fixture.

`index.ts` re-exports the small public surface consumers need.

**Files:**
- Create: `~/code/s2jp2/src/pipeline.ts`
- Create: `~/code/s2jp2/src/index.ts`
- Create: `~/code/s2jp2/tests/pipeline.test.ts`

- [ ] **Step 1: Failing test (`tests/pipeline.test.ts`)**

```ts
import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchAndDecodeWindow } from '../src/pipeline.js';

const TCI = 'tests/fixtures/sample_TCI_10m.jp2';
const B04 = 'tests/fixtures/sample_B04_60m.jp2';

/** A toy file-backed RangeFetcher for the test. */
function fileFetcher(path: string) {
  const fd = openSync(path, 'r');
  return {
    async fetchRange(start: number, end: number): Promise<Uint8Array> {
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    close() { closeSync(fd); },
  };
}

describe.runIf(existsSync(TCI))('fetchAndDecodeWindow (TCI 10m, uint8 RGB)', () => {
  it('decodes a 1024×1024 window at overview 3 → 128×128 uint8 RGB', async () => {
    const fetcher = fileFetcher(TCI);
    try {
      const result = await fetchAndDecodeWindow(fetcher, {
        window: { x: 4096, y: 4096, width: 1024, height: 1024 },
        overviewLevel: 3,
      });
      expect(result.width).toBe(128);
      expect(result.height).toBe(128);
      expect(result.numComponents).toBe(3);
      expect(result.bitsPerSample).toBe(8);
      expect(result.pixels).toBeInstanceOf(Uint8Array);
      let nz = 0;
      for (let i = 0; i < result.pixels.length; i += 100) if (result.pixels[i] !== 0) nz++;
      expect(nz).toBeGreaterThan(0);
    } finally {
      fetcher.close();
    }
  });
});

describe.runIf(existsSync(B04))('fetchAndDecodeWindow (B04 60m, uint16 single-band)', () => {
  it('decodes a 512×512 window at overview 1 → 256×256 uint16 single-band', async () => {
    const fetcher = fileFetcher(B04);
    try {
      const result = await fetchAndDecodeWindow(fetcher, {
        window: { x: 256, y: 256, width: 512, height: 512 },
        overviewLevel: 1,
      });
      expect(result.width).toBe(256);
      expect(result.height).toBe(256);
      expect(result.numComponents).toBe(1);
      expect(result.bitsPerSample).toBeGreaterThan(8);
      expect(result.pixels).toBeInstanceOf(Uint16Array);
    } finally {
      fetcher.close();
    }
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `npm test -- pipeline`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/pipeline.ts`**

```ts
import { loadDecoder } from './decoder/decoder.js';
import type { DecodeResult, Decoder } from './decoder/decoder.js';
import { inspectAsset } from './inspect.js';
import type { AssetDescriptor } from './inspect.js';
import { stitchPartialCodestream } from './markers/codestream.js';
import { truncateToPackets } from './markers/plt.js';
import { planWindowFetches } from './planner.js';
import type { Window } from './planner.js';

export interface RangeFetcher {
  fetchRange(start: number, end: number): Promise<Uint8Array>;
}

export interface FetchAndDecodeOptions {
  window: Window;
  overviewLevel: number;
  /** Reuse a previously-built descriptor (avoid re-fetching/parsing the header). */
  descriptor?: AssetDescriptor;
  /** Header probe size used when descriptor is absent. Default 100 KB. */
  headerProbeBytes?: number;
  /** Reusable decoder (the WASM module loads ~200 ms; cache when possible). */
  decoder?: Decoder;
}

const DEFAULT_HEADER_PROBE = 100 * 1024;

/**
 * Fetch + decode a window of a JP2 asset. Returns a `DecodeResult` whose
 * `pixels` is `Uint8Array` for 8-bit assets (TCI / SCL / CLD / SNW) and
 * `Uint16Array` for 16-bit assets (reflectance bands / AOT / WVP).
 */
export async function fetchAndDecodeWindow(
  fetcher: RangeFetcher,
  options: FetchAndDecodeOptions,
): Promise<DecodeResult> {
  const decoder = options.decoder ?? await loadDecoder();

  const descriptor = options.descriptor ?? await (async () => {
    const header = await fetcher.fetchRange(0, options.headerProbeBytes ?? DEFAULT_HEADER_PROBE);
    return inspectAsset(header);
  })();

  const plan = planWindowFetches(descriptor, options.window, options.overviewLevel);

  // Fetch each intersecting tile-part in full, then truncate to keepPackets.
  // (Smarter: probe + remainder like s2surgeon — a later optimisation.)
  const payloads: Uint8Array[] = await Promise.all(
    plan.tileRanges.map(async (range) => {
      const full = await fetcher.fetchRange(range.start, range.end);
      return plan.keepPackets >= plan.totalPackets
        ? full
        : truncateToPackets(full, plan.keepPackets);
    }),
  );

  const codestream = stitchPartialCodestream(descriptor.header, payloads);
  return decoder.decode(codestream, {
    reduceLevel: options.overviewLevel,
    decodeArea: {
      x0: options.window.x,
      y0: options.window.y,
      x1: options.window.x + options.window.width,
      y1: options.window.y + options.window.height,
    },
  });
}
```

- [ ] **Step 4: Implement `src/index.ts`** (public API)

```ts
export { ParseError, ProfileMismatchError, WindowError } from './errors.js';

export {
  S2_N0512_CAPABILITY, computePacketTable, keepPacketsForOverview,
} from './profile.js';
export type { PacketTable, S2N0512Capability } from './profile.js';

export { extractSizInfo } from './markers/siz.js';
export type { SizInfo } from './markers/siz.js';

export {
  extractTileLengths, tilePartRangesFromHeader,
} from './markers/tlm.js';
export type { ByteRange } from './markers/tlm.js';

export { parseCod, validateS2N0512Capability } from './markers/cod.js';
export type { CodInfo, ProgressionOrder } from './markers/cod.js';

export {
  decodePacketLengths, extractPacketLengths, payloadSize, sodOffset, truncateToPackets,
} from './markers/plt.js';

export {
  firstSotOffset, socOffset, stitchPartialCodestream,
} from './markers/codestream.js';

export {
  groupedTilePartRanges, tileGridFromSiz, validateWindow, windowTileIndices,
} from './window.js';
export type { TileGrid } from './window.js';

export { inspectAsset } from './inspect.js';
export type { AssetDescriptor } from './inspect.js';

export { planWindowFetches } from './planner.js';
export type { FetchPlan, Window } from './planner.js';

export { Decoder, loadDecoder } from './decoder/decoder.js';
export type { DecodeArea, DecodeOptions, DecodeResult } from './decoder/decoder.js';

export { fetchAndDecodeWindow } from './pipeline.js';
export type { FetchAndDecodeOptions, RangeFetcher } from './pipeline.js';
```

- [ ] **Step 5: Verify everything still builds + tests pass**

Run:
```bash
npm run build
npm test
```

Expected: `tsc` succeeds, all tests pass (real-fixture tests skip if `tests/fixtures/sample_TCI_10m.jp2` absent).

- [ ] **Step 6: Commit**

```bash
git add src/pipeline.ts src/index.ts tests/pipeline.test.ts
git commit -m "feat: end-to-end pipeline + public API"
```

---

## Done criteria

- `npm run build` succeeds with `tsc --strict --noUncheckedIndexedAccess`.
- `npm test` passes on a machine with both fixtures (CDSE-authenticated) AND on one without (real-fixture tests skip cleanly).
- `dist/` contains compiled `.js` + `.d.ts` for every public symbol listed in `src/index.ts`.
- The package decodes **both** the TCI 10m sample (3-band uint8) and the B04 60m sample (1-band uint16) via `fetchAndDecodeWindow`, with `pixels` typed as `Uint8Array` or `Uint16Array` respectively.
- `inspectAsset(header)` returns a populated `AssetDescriptor` for any S2 MSI JP2 asset (TCI / reflectance / SCL / CLD / SNW / AOT / WVP at any of the three resolutions); STEX uses this to decide whether to offer the JP2 visualization for a chosen asset.
- The wrapper source `wrapper/jp2.cpp` and `wrapper/build.sh` are committed so the WASM is reproducibly rebuildable.
- Git remote `origin = git@github.com:alek-cesarz/s2jp2.git` is configured; push deferred until manual review of the final commit graph.
- Out of scope for this plan (future work): S3 SigV4 fetcher, HTTPS fetcher with retries/backoff, Web Worker wrapper, OpenLayers tile-source adapter, in-flight tile-part probe-and-remainder (s2surgeon's smarter fetch heuristic), STEX-side asset-picker UI.








