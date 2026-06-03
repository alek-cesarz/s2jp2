# s2jp2

TypeScript library for **client-side streaming visualization of Sentinel-2 JPEG 2000 products**. Built to power browser-based viewers (e.g. STEX) without a server-side WMS, by exploiting the TLM (Tile-part Length) markers that ESA added to S2 MSI JP2s starting in processing baseline `N0500`.

## Purpose

Sentinel-2 L1C and L2A products are distributed as JP2 files. A 10 m TCI is 125 MB; a full reflectance band is similar. Naive HTTP streaming would require downloading the whole asset just to look at a thumbnail-sized region. This library does what `s2surgeon` does for native Rust, but in TypeScript + WASM:

1. **Read only the bytes needed** for a requested window at a requested zoom level. The TLM marker tells us which tile-parts the window intersects; PLT markers inside each tile-part tell us how many packets to keep for a given resolution-reduction. We compute the byte ranges, ask a consumer-supplied `RangeFetcher` to retrieve them, stitch a partial JPEG 2000 codestream, and decode.
2. **Decode at native precision in the browser.** A vendored OpenJPEG 2.5.3 WASM (247 KB) exposes `cp_reduce` (resolution reduction) and `opj_set_decode_area` (windowed decode) — the two APIs the popular `@cornerstonejs/codec-openjpeg` package doesn't expose. Output is `Uint8Array` for 8-bit assets (TCI / SCL / CLD / SNW) and `Uint16Array` for 16-bit assets (reflectance bands / AOT / WVP).
3. **Stay out of the way.** No I/O is bundled; the consumer provides a `RangeFetcher` interface. That keeps STEX's existing S3 SigV4 + nginx proxy plumbing in charge of network and auth.

## Status

- **Asset coverage:** every JP2 asset family in S2 L1C and L2A — TCI (3-band uint8), reflectance bands B01–B12/B8A (1-band uint16), SCL (1-band uint8 categorical), CLD/SNW (1-band uint8 probability), AOT/WVP (1-band uint16) — at all three resolutions (10 m / 20 m / 60 m).
- **Baseline gate:** requires `s2:processing_baseline >= N0500`. Pre-N0500 products lack TLM markers and cannot be range-streamed; the library will throw `ParseError` on `inspectAsset` if TLM is missing.
- **Decode performance** (measured on the development host, Node 20, single thread; browser numbers are typically equal-or-faster):
  | Window (source px) | Reduce | Output | Time |
  |--------------------|--------|--------|------|
  | 256 × 256 | L=2 | 64×64 | ~70 ms |
  | 2048 × 2048 | L=3 | 256×256 | 113 ms |
  | 2048 × 2048 | L=2 | 512×512 | 298 ms |
- **Bundle size:** 247 KB WASM + 46 KB JS glue + ~30 KB of TS (compiled). No runtime dependencies.
- **Tests:** 79 tests across 10 files; real CDSE fixtures (TCI 10 m + B04 60 m) exercise every layer end-to-end.

## Architecture

```
                  ┌────────────────────────────────────────┐
  Consumer (STEX) │ RangeFetcher (S3 SigV4 + proxy)        │
                  └─────┬──────────────────────────────────┘
                        │ fetchRange(start, end) → Uint8Array
                        ▼
         ┌──────────────────────────────────────────┐
         │  pipeline.ts: fetchAndDecodeWindow       │
         │  ───────────────────────────────────────  │
         │  1. fetch header (default 100 KB)        │
         │  2. inspectAsset → AssetDescriptor       │
         │  3. planWindowFetches → byte ranges      │
         │  4. fetch tile-parts → truncateToPackets │
         │  5. stitchPartialCodestream              │
         │  6. Decoder.decode (WASM)                │
         └─────┬──────────────────────────────────┬─┘
               │                                  │
               ▼                                  ▼
       ┌───────────────┐                  ┌─────────────────┐
       │ Marker parsers│                  │ OpenJPEG 2.5.3  │
       │ (siz/cod/tlm/ │                  │ WASM            │
       │  plt/codestream)│                │ (cp_reduce +    │
       │ + window math │                  │  decode_area)   │
       └───────────────┘                  └─────────────────┘
```

### Source layout

```
src/
├── errors.ts                ParseError, ProfileMismatchError, WindowError
├── profile.ts               S2_N0512_CAPABILITY, computePacketTable, keepPacketsForOverview
├── markers/
│   ├── scan.ts              findMarker (shared by every parser)
│   ├── siz.ts               extractSizInfo (image dims + tile dims + components)
│   ├── cod.ts               parseCod + validateS2N0512Capability
│   ├── tlm.ts               extractTileLengths + tilePartRangesFromHeader
│   ├── plt.ts               extractPacketLengths + truncateToPackets
│   └── codestream.ts        SOC/SOT navigation + stitchPartialCodestream
├── window.ts                TileGrid + windowTileIndices + groupedTilePartRanges
├── inspect.ts               inspectAsset → AssetDescriptor (top-level "what is this asset?")
├── planner.ts               planWindowFetches → FetchPlan (byte ranges + keep-packets)
├── decoder/
│   ├── decoder.ts           Decoder class (typed TS facade)
│   ├── stex-jp2.wasm        Vendored OpenJPEG 2.5.3 build
│   ├── stex-jp2.mjs         Emscripten glue
│   └── stex-jp2.d.mts       Type stub for the glue
├── pipeline.ts              fetchAndDecodeWindow (end-to-end orchestration)
└── index.ts                 Public API
```

## Public API

```ts
import {
  inspectAsset,                    // header bytes → AssetDescriptor
  planWindowFetches,               // descriptor + window + level → FetchPlan
  fetchAndDecodeWindow,            // one-shot end-to-end
  loadDecoder,                     // load the WASM (once per session)
  Decoder,
  type AssetDescriptor,
  type DecodeResult,
  type FetchPlan,
  type RangeFetcher,
  type Window,
  type TileGrid,
  type SizInfo,
  type CodInfo,
} from 's2jp2';
```

### `RangeFetcher` — consumer-supplied

```ts
interface RangeFetcher {
  fetchRange(start: number, end: number): Promise<Uint8Array>;
  // start inclusive, end exclusive — matches HTTP Range "bytes=start-(end-1)"
}
```

### `inspectAsset(header) → AssetDescriptor`

Validates the header against the S2 N0512 capability predicate (LRCP / single layer / 5/3 wavelet / 64-px code blocks / user-defined precincts) and returns everything downstream code needs:

```ts
interface AssetDescriptor {
  siz: SizInfo;                                // image + tile dims + numComponents
  cod: CodInfo;                                // full parsed COD
  tileGrid: TileGrid;                          // tilesPerRow/Col, totalTiles
  numComponents: number;                       // 1 for B-bands, 3 for TCI
  numDecompLevels: number;                     // typically 4 for S2
  numResolutions: number;                      // numDecompLevels + 1
  packetTable: PacketTable;                    // packets per resolution
  tileRanges: ByteRange[];                     // absolute byte ranges of every tile-part
  header: Uint8Array;                          // the bytes used to derive everything above
}
```

Throws `ParseError` (malformed bytes), `ProfileMismatchError` (doesn't satisfy N0512 capability), or `WindowError` (degenerate sizes). Catching these is how STEX decides whether to offer the JP2 visualization.

### `fetchAndDecodeWindow(fetcher, options) → DecodeResult`

```ts
interface FetchAndDecodeOptions {
  window: { x: number; y: number; width: number; height: number };
  overviewLevel: number;                       // 0 = full res, R = lowest
  descriptor?: AssetDescriptor;                // reuse across calls — avoids re-parsing header
  decoder?: Decoder;                           // reuse across calls — WASM load is ~200 ms
  headerProbeBytes?: number;                   // default 100 KB
}

interface DecodeResult {
  pixels: Uint8Array | Uint16Array;            // interleaved, c-major
  width: number;                               // output width (after cp_reduce)
  height: number;
  numComponents: number;
  bitsPerSample: number;                       // 8 or typically 12/16
}
```

The window is specified in **full-resolution source pixels** (i.e. the UTM grid the SIZ marker declares). At `overviewLevel = 3` the decoder shrinks to 1/8 — so a 2048×2048 window decodes to 256×256.

## Integrating into STEX as the JP2 visualizer

The integration target is parallel to STEX's existing COG renderer. The pieces below name STEX modules where context exists.

### 1. Detection — which items support JP2 viz?

```ts
// In stac-client.ts or wherever the visualization-method picker lives:
function jp2VizAvailable(item: StacItem, asset: StacAsset): boolean {
  if (item.collection !== 'sentinel-2-l1c' && item.collection !== 'sentinel-2-l2a') {
    return false;
  }
  const baseline = item.properties['s2:processing_baseline'] as string | undefined;
  // String compare works because the format is NNNNN: 'N0500' < 'N0512'
  if (!baseline || baseline < 'N0500') return false;
  if (!asset.href.endsWith('.jp2')) return false;
  return true;
}
```

Add `'jp2'` to `VizMethod` in `src/lib/types.ts` and wire the method picker to offer it when the predicate above is true. If both COG (unlikely for S2 originals) and JP2 are available, prefer JP2 — it's the native format with no quality loss.

### 2. RangeFetcher — wrap STEX's S3 SigV4 + proxy

S2 assets on CDSE live at `s3://eodata/...`. STEX already routes S3 byte-range requests through `/s3-proxy/<host>/...` with SigV4 signed headers (see `src/lib/s3-download.ts`, `src/lib/s3-credentials.ts`). The RangeFetcher is a one-screen wrapper:

```ts
// New file: src/lib/jp2-fetcher.ts
import { signedHeadersForGet } from './s3-download.js';
import { proxyUrl } from './s3-credentials.js';
import type { RangeFetcher } from 's2jp2';

export function makeS3Jp2Fetcher(s3Url: string): RangeFetcher {
  // Resolve s3://eodata/path → /s3-proxy/eodata.cloudferro.com/path
  const url = proxyUrl(s3Url);
  return {
    async fetchRange(start, end) {
      const headers = await signedHeadersForGet(s3Url, { range: `bytes=${start}-${end - 1}` });
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error(`fetchRange failed ${resp.status}`);
      return new Uint8Array(await resp.arrayBuffer());
    },
  };
}
```

Note: CDSE's S3 endpoint does not honour pre-signed URLs but does honour header-signed Range requests (this is why STEX uses the proxy pattern). The fetcher signs every range request individually — this is fine; the SigV4 cost is negligible compared to the network round-trip.

### 3. Decoder lifecycle — load once, share across items

`loadDecoder()` instantiates a fresh WASM module (~200 ms). Cache it in `viz-state.ts` and reuse across asset switches:

```ts
let cachedDecoder: Decoder | null = null;
async function getJp2Decoder(): Promise<Decoder> {
  if (!cachedDecoder) cachedDecoder = await loadDecoder();
  return cachedDecoder;
}
```

When the user fully exits JP2 viz, you can drop the reference — the WASM module is reclaimable.

### 4. AssetDescriptor caching — per item

The header probe (100 KB by default) parses to the AssetDescriptor in <10 ms. Cache it keyed by `(itemId, assetKey)` so panning/zooming the same asset doesn't re-fetch the header. The descriptor includes the raw header bytes; size is ~100 KB plus a few small derived structures.

### 5. Tile source — the per-tile render path

S2 JP2 assets are in UTM (varies per zone). OL's `DataTileSource` invokes a loader with each tile's extent in EPSG:3857; the loader has to:

1. Reproject the tile's web-mercator extent → asset's UTM coords.
2. Snap to source pixels using the asset's affine transform (from `proj:transform`).
3. Decode that window at an appropriate `overviewLevel` (pick the coarsest level whose decoded pixel size matches or beats the requested tile resolution — analogous to `cog-renderer.ts` overview selection).
4. Convert pixels to the right `DataTile` representation for the asset type (see §6).

```ts
// New file: src/lib/jp2-tile-source.ts (sketch)
import { fetchAndDecodeWindow, type AssetDescriptor, type Decoder } from 's2jp2';
import { DataTileSource } from 'ol/source';
import type { RangeFetcher } from 's2jp2';

interface Args {
  fetcher: RangeFetcher;
  descriptor: AssetDescriptor;
  decoder: Decoder;
  utmEpsg: string;                                  // e.g. 'EPSG:32633'
  utmTransform: [number, number, number, number, number, number];  // proj:transform
}

export function makeJp2TileSource(a: Args): DataTileSource {
  return new DataTileSource({
    projection: 'EPSG:3857',
    loader: async ([z, x, y], { extent }) => {
      const window = pixelWindowFromMercatorExtent(extent, a.utmEpsg, a.utmTransform);
      const level  = chooseOverviewLevel(window, /* tile output size */ 256);
      const result = await fetchAndDecodeWindow(a.fetcher, {
        window,
        overviewLevel: level,
        descriptor: a.descriptor,
        decoder: a.decoder,
      });
      return packForOlDataTile(result);             // see §6
    },
  });
}
```

For per-tile concurrency control and request cancellation, mirror what `cog-tile-source.ts` does — OL's loader hands you an `AbortSignal`.

### 6. Asset → render mapping

`fetchAndDecodeWindow` returns native-precision pixels. STEX has to translate per asset:

| Asset family | `pixels` type | Components | Suggested render |
|---|---|---|---|
| `TCI_{10,20,60}m` | `Uint8Array` | 3 | Direct RGB into the tile — no stretching, no colormap |
| `B{01..12,8A}_*` | `Uint16Array` | 1 | Grayscale or single-band colormap with a stretch (2–98 percentile typical for reflectance, or fixed `[0, 4000]`); reuse `cog-renderer.ts`'s `WebGLTileLayer` style pipeline |
| `AOT_*`, `WVP_*` | `Uint16Array` | 1 | Continuous colormap; AOT is unitless×1000, WVP is g/cm²×1000 |
| `SCL_{20,60}m` | `Uint8Array` | 1 | Categorical — apply ESA's official SCL palette (12 classes: 0=NoData, 1=Saturated, 2=DarkArea, 3=CloudShadow, 4=Vegetation, 5=NotVegetated, 6=Water, 7=Unclassified, 8=CloudMedium, 9=CloudHigh, 10=ThinCirrus, 11=Snow) |
| `CLD_{20,60}m`, `SNW_{20,60}m` | `Uint8Array` | 1 | Probability 0–100 → semi-transparent overlay or continuous colormap |

For 16-bit reflectance, the simplest path is to upload the `Uint16Array` to a WebGL R16UI texture and apply the stretch in the fragment shader — same approach `cog-renderer.ts` uses for single-band COGs.

### 7. Cleanup

When the user switches assets or methods:

```ts
// viz-state.ts cleanup for the JP2 case:
cleanup() {
  this.olLayer.dispose();
  // Decoder is shared across the session — don't dispose
  // AssetDescriptor: drop the reference; the descriptor holds the 100 KB header
  this.cachedDescriptor = null;
}
```

### Integration checklist

- [ ] Extend `VizMethod` to include `'jp2'`
- [ ] Add `jp2VizAvailable` predicate (collection + baseline + `.jp2` href)
- [ ] Add `makeS3Jp2Fetcher` wrapping STEX's existing S3 SigV4 signing
- [ ] Add `getJp2Decoder` (one WASM load per session)
- [ ] Add `jp2-renderer.ts` + `jp2-tile-source.ts` parallel to the COG pair
- [ ] Wire per-asset render mapping (RGB direct / single-band stretch / SCL palette / probability colormap)
- [ ] Add a Web Worker wrapper if decode latency on the main thread becomes a problem (decode is fast but blocking; the COG path already uses workers and the patterns transfer)

## Supported Sentinel-2 assets

Verified against real CDSE fixtures (TCI 10 m + B04 60 m). Other rows are inferred from the consistent N0512 framework; if any specific asset fails inspection, file an issue with the CDSE STAC item id.

| Asset family | Resolution | Components | Precision | Image dims | Status |
|---|---|---|---|---|---|
| TCI_10m | 10 m | 3 (RGB) | 8-bit | 10980 × 10980 | ✓ tested |
| TCI_20m | 20 m | 3 (RGB) | 8-bit | 5490 × 5490 | inferred ✓ |
| TCI_60m | 60 m | 3 (RGB) | 8-bit | 1830 × 1830 | inferred ✓ |
| B02–B04, B08 (10 m) | 10 m | 1 | 16-bit | 10980 × 10980 | inferred ✓ |
| B01, B05–B07, B8A, B11–B12 (20 m) | 20 m | 1 | 16-bit | 5490 × 5490 | inferred ✓ |
| B01–B12, B8A (60 m) | 60 m | 1 | 16-bit | 1830 × 1830 | B04_60m tested ✓ |
| AOT, WVP | per resolution | 1 | 16-bit | per resolution | inferred ✓ |
| SCL | 20 m / 60 m | 1 | 8-bit | per resolution | inferred ✓ |
| CLD, SNW | 20 m / 60 m | 1 | 8-bit | per resolution | inferred ✓ |

## Limitations and deferred features

### Hard limits (won't fix without scope change)

- **S2 MSI only.** The capability predicate explicitly checks for LRCP progression, single layer, 5/3 reversible wavelet, 64 × 64 code blocks, and user-defined precincts — non-S2 JPEG 2000 files (Sentinel-1 SLCs, third-party imagery, DICOM) won't pass inspection. This is by design; loosening it would compromise correctness of the packet-truncation logic.
- **Baseline `>= N0500`.** Pre-N0500 products have no TLM marker and cannot be range-streamed. `inspectAsset` will throw `ParseError`. STEX must gate on `s2:processing_baseline` before offering the JP2 viz.
- **Cooperatively cancellable, not pre-emptively.** The `RangeFetcher` interface doesn't take an `AbortSignal`. Consumers can wrap their fetcher to abort in-flight HTTP requests externally; aborted requests will surface as fetcher errors which propagate as decoder errors.

### Deferred (worth doing later, scoped)

- **Probe-and-remainder fetch optimization.** The current pipeline fetches each intersecting tile-part in full, then truncates locally. At coarse zoom (overview ≥ 3) this wastes 5–20× the bytes. `s2surgeon` probes the first ~4 KB of each tile-part, parses the PLT to compute exact bytes needed, then fetches just the remainder. Adds ~80 LOC to `pipeline.ts` and one helper to `plt.ts`. Defer until interactive UX shows it's needed.
- **Multi-segment TLM support.** A single TLM segment caps at ~16 380 tile-parts. No S2 MSI asset reaches that limit (densest is 121 tile-parts), so this is dormant. If a future product family uses denser tiling, `extractTileLengths` would silently parse only the first TLM and the planner would throw `tile index out of TLM range` on out-of-bounds tile requests — failure is loud, not silent. Fix would extend `findMarker` to a sweep, sort segments by `Ztlm`, concatenate.
- **Web Worker wrapper.** Decode is fast (50–300 ms per typical tile) but blocking. For a smoother UX with many concurrent tiles, run decoding off the main thread. The WASM module is structured-cloneable; STEX's COG path already has a worker harness to mirror.
- **AbortSignal in `RangeFetcher`.** Tile cancellation on quick pan would benefit from passing OL's `AbortSignal` through to the fetcher. Easy addition; gated on demand.

### Out of scope (not planned)

- HTTP-level concerns: retries, backoff, parallelism caps, request coalescing. STEX's existing infrastructure handles these.
- Map-projection math, OL integration. The library is OL-agnostic.
- Encoder. Decode only.

## Build / develop

```bash
# Install
npm install

# Run the test suite. Real-fixture tests skip cleanly if the JP2s aren't downloaded.
npm test

# Download the canonical test fixtures from CDSE (requires ~/tools/cdse.json
# and the get-token script — see scripts/fetch-fixture.sh for details).
npm run fetch:fixture

# Compile to dist/ (CommonJS-free; ESM with .d.ts).
npm run build
```

### Rebuilding the WASM

```bash
# Prerequisites (one-time):
#   1. emsdk at ~/emsdk (https://emscripten.org/docs/getting_started/downloads.html)
#   2. OpenJPEG 2.5.3 cloned + built as a static .a library, accessible at
#      ../openjpeg/build-wasm/bin/libopenjp2.a relative to this repo
#      (a symlink works fine)

npm run build:wasm
# → regenerates src/decoder/stex-jp2.{wasm,mjs}
```

The wrapper source is `wrapper/jp2.cpp` (≈300 LOC of embind glue). Modify it if you need to expose additional OpenJPEG APIs (e.g. progression-order metadata, per-component precision queries) and re-run `npm run build:wasm`.

## Reference

- **JPEG 2000 spec:** ITU-T Rec. T.800 / ISO/IEC 15444-1.
- **S2 PSD:** [Sentinel-2 Products Specification Document](https://sentinels.copernicus.eu/documents/d/sentinel/sentinel-2-products-specification-document-15_1) — TLM marker was added in baseline `N0500`.
- **Reference implementation (Rust):** `s2surgeon` — the inline byte-level logic was ported from there; the `validateS2N0512Capability` predicate is intentionally looser than s2surgeon's hardcoded TCI 10 m profile.
- **OpenJPEG:** [uclouvain/openjpeg](https://github.com/uclouvain/openjpeg) 2.5.3.
