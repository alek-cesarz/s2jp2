/**
 * PLT-trimmed tile-part fetching.
 *
 * The naive strategy ("fetch the whole tile-part, truncate client-side")
 * over-reads dramatically at low overview levels. At reduce-level 4 on a
 * typical S2 tile-part with ~20 packets distributed across 5 resolution
 * tiers, only the first 1-2 packets carry the bytes the decoder will
 * actually use — yet a naive fetch downloads all ~20 packets' bytes from
 * S3 just to throw most away on arrival.
 *
 * `fetchTilePartTrimmed` instead:
 *   1. Probes the first N bytes of the tile-part (default 4 KB) — enough
 *      to contain SOT + PLT(s) + SOD for any S2 tile-part.
 *   2. Parses the PLT to compute the exact byte count needed for
 *      `keepPackets`.
 *   3. If the probe already covers those bytes, returns a slice.
 *   4. Otherwise, fetches just the remainder and concatenates.
 *
 * All edge cases (no SOD in probe, PLT segment count < keepPackets, tile-part
 * smaller than probe, keepPackets >= totalPackets) degrade gracefully to a
 * single full-tile-part fetch — never crash.
 */
import { extractPacketLengths, sodOffset, truncateToPackets } from './markers/plt.js';
import type { RangeFetcher } from './pipeline.js';

/**
 * 4 KB is comfortably larger than any S2 tile-part header. SOT (12 bytes)
 * + PLT (4-byte header + 1-2 bytes per packet × ~20 packets) + SOD (2 bytes)
 * stays well under 200 bytes for typical S2 codestreams. A larger probe
 * costs nothing on a cold S3 read (HTTP overhead dominates below ~64 KB)
 * and provides margin for products with many packets per tile-part.
 */
export const DEFAULT_TILE_PART_PROBE = 4 * 1024;

export interface FetchTilePartTrimmedOptions {
  /** Byte range of the tile-part from TLM. `end` is exclusive. */
  range: { start: number; end: number };
  /** Packets to keep (from `planWindowFetches`'s `keepPackets`). */
  keepPackets: number;
  /** Total packets per tile-part (from `planWindowFetches`'s `totalPackets`). */
  totalPackets: number;
  /** Probe size override. Defaults to `DEFAULT_TILE_PART_PROBE` (4 KB). */
  probeBytes?: number;
}

/**
 * Fetch a tile-part trimmed to its first `keepPackets` packets.
 *
 * Returns bytes byte-equivalent to `truncateToPackets(fullFetch, keepPackets)`
 * — same SOT (with patched Psot), same packet payload prefix — but with the
 * underlying range fetches sized to what's actually consumed.
 */
export async function fetchTilePartTrimmed(
  fetcher: RangeFetcher,
  options: FetchTilePartTrimmedOptions,
): Promise<Uint8Array> {
  const { range, keepPackets, totalPackets } = options;
  const probeBytes = options.probeBytes ?? DEFAULT_TILE_PART_PROBE;
  const fullLength = range.end - range.start;

  // Fast path 1: caller wants everything — no point in PLT-trimming.
  if (keepPackets >= totalPackets) {
    return fetcher.fetchRange(range.start, range.end);
  }

  // Fast path 2: tile-part is already small enough that a single full read
  // is cheaper than two HTTP round trips. The threshold of `probeBytes`
  // means a single round trip of equivalent size.
  if (fullLength <= probeBytes) {
    const full = await fetcher.fetchRange(range.start, range.end);
    return truncateToPackets(full, keepPackets);
  }

  // Phase 1: probe.
  const probeEnd = range.start + probeBytes;
  const probe = await fetcher.fetchRange(range.start, probeEnd);

  // Compute how many bytes from the start of the tile-part we actually need.
  // SOD + 2 marker bytes + sum of the first keepPackets packet lengths.
  let bytesFromTilePartStart: number;
  try {
    const sod = sodOffset(probe);
    const lengths = extractPacketLengths(probe);
    if (lengths.length < keepPackets) {
      // PLT in the probe doesn't account for all the packets we want to
      // keep — usually means the tile-part has multiple PLT segments and
      // some are past the probe boundary. Fall back to a full fetch.
      const full = await fetcher.fetchRange(range.start, range.end);
      return truncateToPackets(full, keepPackets);
    }
    let payloadBytes = 0;
    for (let i = 0; i < keepPackets; i++) payloadBytes += lengths[i]!;
    bytesFromTilePartStart = sod + 2 + payloadBytes;
  } catch {
    // SOD not in probe, or PLT parsing failed. Probe size was too small
    // for this tile-part — fall back to the full fetch.
    const full = await fetcher.fetchRange(range.start, range.end);
    return truncateToPackets(full, keepPackets);
  }

  // Phase 2 (or zero-phase): did the probe already cover everything?
  if (probe.byteLength >= bytesFromTilePartStart) {
    // Yes — slice the probe and patch Psot via the existing helper.
    return truncateToPackets(probe.slice(0, bytesFromTilePartStart), keepPackets);
  }

  // No — fetch the remainder and concatenate.
  const remainderEnd = range.start + bytesFromTilePartStart;
  const remainder = await fetcher.fetchRange(probeEnd, remainderEnd);
  const assembled = new Uint8Array(probe.byteLength + remainder.byteLength);
  assembled.set(probe, 0);
  assembled.set(remainder, probe.byteLength);
  return truncateToPackets(assembled, keepPackets);
}
