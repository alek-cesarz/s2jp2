# PLT-trimmed fetch optimization

## Problem

Today `fetchAndDecodeWindow` (`src/pipeline.ts`) fetches each intersecting tile-part **in full** and trims packets client-side via `truncateToPackets`:

```ts
const full = await fetcher.fetchRange(range.start, range.end);
return plan.keepPackets >= plan.totalPackets ? full : truncateToPackets(full, plan.keepPackets);
```

At low overview levels (where `keepPackets` is 1-2 out of ~20+), we still pay full per-tile-part bytes from S3 and discard ~99% on arrival. The library comment acknowledges this:

> // Fetch each intersecting tile-part in full, then truncate to keepPackets.
> // (Smarter: probe + remainder like s2surgeon — a later optimisation.)

For a typical S2 B04_10m tile-part (~0.95 MB), at overview level 4 we want ~4-20 KB of bytes. Multiply by 16 OL-tile-intersecting tile-parts × 3 RGB channels and the wasted bandwidth is significant.

## Solution

Two-phase fetch per tile-part:

1. **Probe** the first ~32 KB of the tile-part. This is large enough to contain the SOT + PLT(s) + SOD markers for any S2 tile-part end-to-end for the 60m and 20m variants (so the probe doubles as the data read), and for the 10m variant it discovers the PLT in one round trip.
2. Parse the probe to:
   - Locate `SOD` (`sodOffset`)
   - Extract the per-packet byte lengths from the PLT marker(s) (`extractPacketLengths`)
3. Sum the first `keepPackets` packet lengths → compute `bytesNeeded = sodOffset + 2 + sum(lengths[0..keepPackets-1])`.
4. **If the probe already covers `bytesNeeded`**, return `probe.slice(0, bytesNeeded)` truncated via the existing helper.
5. **Otherwise**, issue a second range fetch for the remainder (`[probe_end, range.start + bytesNeeded)`) and concatenate.
6. Pass the assembled bytes through `truncateToPackets` to patch the SOT's `Psot` field uniformly.

### Edge cases

- `keepPackets >= totalPackets` → just fetch in full (no PLT trim needed).
- Tile-part smaller than probe size → just fetch in full.
- PLT not present in probe (SOD or PLT segment beyond probe boundary, header too big) → fall back to full fetch.
- Fewer packet lengths than `keepPackets` → fall back to full fetch.

All edge cases degrade gracefully to the current behavior — never crash.

## API

`fetchAndDecodeWindow` keeps the same signature. New `tilePartProbeBytes` option on `FetchAndDecodeOptions` (default 32768) for testing / unusual products.

Internal helper `fetchTilePartTrimmed(fetcher, range, keepPackets, totalPackets, probeBytes)` does the work; `pipeline.ts` calls it per tile-part.

## Expected savings

For S2 L2A B04_10m at overview level 4:
- Before: ~0.95 MB per tile-part × 16 tile-parts × 3 channels = ~46 MB per OL tile
- After: probe-only (32 KB covers PLT + needed payload at low overview for 10 m) ≈ ~5-32 KB per tile-part × 16 × 3 = ~250 KB-1.5 MB per OL tile

~150-200× reduction on per-tile bandwidth at low zoom.

## Tests

- Probe path: small `keepPackets`, tile-part > probe size, probe doesn't cover all needed bytes → asserts two `fetchRange` calls, total bytes < full tile-part.
- Probe-only path: probe covers all needed bytes → single `fetchRange` call.
- Full-fetch fallback: SOD not found in probe.
- Full-fetch fallback: PLT length count < `keepPackets`.
- All-packets path: `keepPackets === totalPackets` → single full fetch, no truncation.
- Tiny tile-part: `range.end - range.start <= probeBytes` → single full fetch.
- Output byte-equivalence: trimmed result decodes identically to `truncateToPackets(fullFetch, keepPackets)`.
