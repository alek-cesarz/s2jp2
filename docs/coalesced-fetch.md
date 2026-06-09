# Coalesced tile-part fetching (Phase 1)

## Problem

`fetchAndDecodeWindow` today issues `Promise.all` of `fetchTilePartTrimmed` per intersecting tile-part. Each call:

1. Probes 4 KB to discover the PLT
2. Fetches the remainder

For an OL viewport tile that intersects 4 JP2 tile-parts × 3 RGB channels = 12 tile-parts, that's **24 HTTP requests** per OL tile, all paying the per-request handshake / SigV4 / S3 lookup overhead (≈500 ms on CDSE's s3-proxy regardless of size).

JP2 tile-parts are stored in raster order in the codestream — row-adjacent tile-parts are byte-adjacent in the file (separated only by SOT-marker padding). And S3 is dramatically more efficient with one 500 KB request than ten 50 KB requests.

## Phase 1 fix

**Group `plan.tileRanges` by contiguity. Issue one probe + one remainder per group, not per tile-part.**

### Algorithm

1. **Group**. Walk `plan.tileRanges` (sorted by `start`). Adjacent ranges with a gap ≤ `MAX_COALESCE_GAP` (default 64 KB) join the same group. The gap accommodates SOT padding and short inter-tile-part markers.
2. **Per group**:
   - **Fast path A** — `keepPackets >= totalPackets`: just fetch `[group.start, group.end)`. No PLT trimming needed.
   - **Fast path B** — group spans ≤ probe budget (default 64 KB): fetch the whole group in one shot. Parse each tile-part's PLT from inside, then `truncateToPackets` per tile-part.
   - **Probe-then-remainder**: fetch the first 64 KB of the group (the probe). Per tile-part inside the probe, parse the PLT and compute `bytesFromTilePartStart`. If the probe covers everything for all tile-parts, slice. Otherwise issue one corrective fetch for `[probeEnd, lastNeededByte)` and stitch.

### Per-group probe size

64 KB instead of the per-tile-part default of 4 KB. Reason: at group scope, the probe must cover the headers of every tile-part in the group, plus enough of each tile-part's data to cover packet bytes the caller wants. 64 KB is comfortably larger than the typical sum of (per-tile-part header ~200 B + low-overview packet bytes ~few KB) for a group of 4-8 tile-parts.

This costs at most ~64 KB per group at high overview (where we'd otherwise have fetched much less in total), but eliminates one RTT per tile-part in the group. At CDSE latencies the RTT savings dominate.

### Per-tile-part slicing inside the slab

Each tile-part's bytes inside the slab start at `tilePart.range.start - group.start`. Walk the slab tile-part by tile-part:

```ts
for (const tilePart of group.tileParts) {
  const tilePartStartInSlab = tilePart.range.start - group.start;
  const tilePartLength = tilePart.range.end - tilePart.range.start;
  const tilePartView = slab.subarray(tilePartStartInSlab, tilePartStartInSlab + tilePartLength);
  // tilePartView has the full tile-part bytes (or as much as the slab covers).
  // truncateToPackets handles Psot patching + payload trimming.
  const trimmed = truncateToPackets(tilePartView, keepPackets);
  out.push(trimmed);
}
```

### Corrective fetch when slab is short

If `slab.length < group.byteRange`, some tile-parts at the end are truncated. After parsing PLTs, find the maximum byte we actually need (`bytesFromGroupStart`); if larger than the slab, fetch the remainder.

### Fallback

Any failure inside the slab parsing (PLT not in probe, malformed bytes, etc.) falls back to per-tile-part fetching — `fetchTilePartTrimmed` per tile-part in the group. Same graceful degradation as today.

## API

`fetchAndDecodeWindow` keeps its signature. New option:

```ts
interface FetchAndDecodeOptions {
  // ... existing
  /**
   * Default 64 KB. Probe size for the coalesced per-group fetch. Larger
   * values capture more tile-parts in one slab at the cost of a bigger
   * wasted prefetch when overview level is high. Set to 0 to disable
   * coalescing entirely (per-tile-part path).
   */
  groupProbeBytes?: number;
  /**
   * Default 65536 (64 KB). Tile-parts with byte gap ≤ this value are
   * coalesced into one group. Larger values coalesce more aggressively
   * (fewer HTTP requests, more wasted bytes inside gaps).
   */
  maxCoalesceGap?: number;
}
```

Internal helper exported for direct use + tests:

```ts
export function groupContiguousTileParts(
  ranges: ByteRange[],
  maxGap: number,
): Array<{ start: number; end: number; tileParts: ByteRange[] }>;

export function fetchTilePartGroupCoalesced(
  fetcher: RangeFetcher,
  options: {
    group: { start: number; end: number; tileParts: ByteRange[] };
    keepPackets: number;
    totalPackets: number;
    probeBytes?: number;
  },
): Promise<Uint8Array[]>;
```

## Expected impact

For a typical viewport at high zoom: today 16 OL tiles × 3 channels × 4 tile-parts × 2 fetches ≈ 384 requests. Phase 1 brings that to ≈ 16 × 3 × 2 ≈ 96 requests (assuming most groups span 4 tile-parts and need one slab + zero corrective). **~4× reduction in request count**, and request-overhead-dominated wall-clock follows proportionally.

At low overview the savings are smaller in absolute terms (groups are smaller because slabs cover everything), but the percentage win is similar.

## Tests

- `groupContiguousTileParts` unit tests: contiguous block, gap > threshold splits, single-element ranges, empty.
- `fetchTilePartGroupCoalesced` unit tests with synthetic tile-parts:
  - Fast path A (`keepPackets >= totalPackets`): one full fetch, output matches concatenated full bytes.
  - Fast path B (group within probe size): one probe fetch, sliced output matches per-tile-part `truncateToPackets`.
  - Probe-then-remainder: probe + remainder = 2 fetches; output matches per-tile-part truncation.
  - Corrective: under-sized probe + corrective covers the right bytes.
  - Fallback: PLT parse fails inside slab → falls back to per-tile-part path.
- Pipeline integration: existing `pipeline.test.ts` continues to pass, both with the coalesced path (default) and with `groupProbeBytes: 0` (forces per-tile-part path).
