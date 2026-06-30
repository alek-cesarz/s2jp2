/**
 * Coalesced tile-part fetching.
 *
 * S3 (and S3-proxy nginx) is dramatically more efficient with one
 * 500 KB request than with ten 50 KB requests — the per-request
 * handshake / SigV4 / lookup overhead dominates over byte transfer time
 * at all sizes below ~1 MB. CDSE specifically: ~500 ms minimum per
 * request regardless of size, with bytes adding only ~50 MB/s on top.
 *
 * JP2 tile-parts in S2 are stored in raster order: row-adjacent tile-parts
 * are byte-adjacent in the file (separated only by SOT-marker padding).
 * So the tile-parts intersecting an OL tile typically form a single
 * contiguous (or near-contiguous) byte range.
 *
 * This module groups `plan.tileRanges` by contiguity and issues one
 * probe + (optionally) one corrective fetch per group instead of per
 * tile-part. Each tile-part inside the slab is then parsed (PLT extracted)
 * and trimmed via the existing `truncateToPackets` helper.
 *
 * All edge cases — slab too short, PLT not visible, malformed bytes —
 * fall back to the per-tile-part `fetchTilePartTrimmed` path so
 * coalescing is a strict performance optimization, never a correctness
 * risk.
 */
import { fetchTilePartTrimmed } from "./fetch-trimmed.js";
import {
  extractPacketLengths,
  sodOffset,
  truncateToPackets,
} from "./markers/plt.js";
import type { ByteRange } from "./markers/tlm.js";
import type { RangeFetcher } from "./pipeline.js";

/**
 * Default coalesce gap. Tile-parts whose start-of-next minus end-of-prev
 * is ≤ this many bytes are grouped together. 64 KB comfortably covers any
 * inter-tile-part padding while keeping wasted bytes bounded.
 */
export const DEFAULT_MAX_COALESCE_GAP = 64 * 1024;

/**
 * Default per-group probe size. Sized to comfortably contain (header +
 * leading packet bytes) for several typical tile-parts. Bigger than the
 * per-tile-part probe (4 KB) because the slab covers multiple tile-parts'
 * headers AND their initial packet data in one shot.
 */
export const DEFAULT_GROUP_PROBE_BYTES = 64 * 1024;

export interface TilePartGroup {
  /** Byte range covering all tile-parts in the group (start of first, end of last). */
  start: number;
  end: number;
  /** Member tile-parts in file order. */
  tileParts: ByteRange[];
}

/**
 * Group adjacent / near-adjacent tile-parts into contiguity groups.
 *
 * Walks `ranges` left-to-right (after sorting by `start`) and merges each
 * range into the previous group when the gap `current.start - prev.end`
 * is ≤ `maxGap`. Returns groups in start-order.
 *
 * An empty input returns `[]`; a singleton returns one group containing
 * that range.
 */
export function groupContiguousTileParts(
  ranges: readonly ByteRange[],
  maxGap: number = DEFAULT_MAX_COALESCE_GAP,
): TilePartGroup[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const groups: TilePartGroup[] = [];
  let current: TilePartGroup = {
    start: sorted[0]!.start,
    end: sorted[0]!.end,
    tileParts: [sorted[0]!],
  };
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i]!;
    const gap = r.start - current.end;
    if (gap <= maxGap) {
      current.tileParts.push(r);
      if (r.end > current.end) current.end = r.end;
    } else {
      groups.push(current);
      current = { start: r.start, end: r.end, tileParts: [r] };
    }
  }
  groups.push(current);
  return groups;
}

/**
 * Compute, for each tile-part in the group, the byte length needed to
 * cover the first `keepPackets` packets. Returns absolute byte offsets
 * relative to `group.start` so the caller can decide if the slab is large
 * enough or a corrective fetch is needed.
 *
 * Throws when a tile-part's PLT is not visible in the slab, or when SOD
 * isn't reachable, or when PLT count < keepPackets. The caller is
 * expected to fall back to per-tile-part fetching in that case.
 */
function computeNeededBytesPerTilePart(
  slab: Uint8Array,
  group: TilePartGroup,
  keepPackets: readonly number[],
): number[] {
  const out: number[] = [];
  group.tileParts.forEach((tp, ti) => {
    const keep = keepPackets[ti]!;
    const startInSlab = tp.start - group.start;
    const tpLength = tp.end - tp.start;
    // Tile-part view extends to the slab's end OR to the tile-part's own end,
    // whichever is smaller. The parser only needs SOD + the first `keep`
    // packet lengths to fit; we don't yet know how many bytes those occupy.
    const visibleEnd = Math.min(slab.length, startInSlab + tpLength);
    if (visibleEnd <= startInSlab) {
      // Tile-part start past the slab — definitely under-fetched.
      throw new Error("coalesced: tile-part start beyond slab");
    }
    const view = slab.subarray(startInSlab, visibleEnd);
    const sod = sodOffset(view); // throws if SOD not in view
    const lengths = extractPacketLengths(view); // throws on PLT parse failure
    if (lengths.length < keep) {
      throw new Error(
        `coalesced: PLT count ${lengths.length} < keepPackets ${keep}`,
      );
    }
    let payloadBytes = 0;
    for (let i = 0; i < keep; i++) payloadBytes += lengths[i]!;
    const neededFromTilePartStart = sod + 2 + payloadBytes;
    out.push(startInSlab + neededFromTilePartStart);
  });
  return out;
}

export interface FetchTilePartGroupCoalescedOptions {
  group: TilePartGroup;
  /** Packets to keep, per tile-part (aligned with `group.tileParts`). */
  keepPackets: readonly number[];
  /** Total packets, per tile-part (aligned with `group.tileParts`). */
  totalPackets: readonly number[];
  /** Probe size for the per-group fetch. Default `DEFAULT_GROUP_PROBE_BYTES`. */
  probeBytes?: number;
}

/**
 * Fetch all tile-parts in a contiguity group with at most two HTTP
 * requests (probe + optional corrective). Returns an array of trimmed
 * tile-part bytes in `group.tileParts` order, byte-equivalent to running
 * `fetchTilePartTrimmed` per tile-part.
 *
 * Falls back to per-tile-part `fetchTilePartTrimmed` if PLT parsing in
 * the slab fails for any tile-part — caller gets correctness without
 * having to handle the failure mode.
 */
export async function fetchTilePartGroupCoalesced(
  fetcher: RangeFetcher,
  options: FetchTilePartGroupCoalescedOptions,
): Promise<Uint8Array[]> {
  const { group, keepPackets, totalPackets } = options;
  const probeBytes = options.probeBytes ?? DEFAULT_GROUP_PROBE_BYTES;
  const groupLength = group.end - group.start;

  // Fast path A: every tile-part wants everything. One fetch covers the whole
  // group — no PLT trim possible / needed.
  if (group.tileParts.every((_, i) => keepPackets[i]! >= totalPackets[i]!)) {
    const slab = await fetcher.fetchRange(group.start, group.end);
    return sliceTilePartsFromSlab(slab, group);
  }

  // Fast path B: group fits within probe budget. One fetch + per-tile-part
  // truncate.
  if (groupLength <= probeBytes) {
    const slab = await fetcher.fetchRange(group.start, group.end);
    return trimSlabPerTilePart(
      slab,
      group,
      keepPackets,
      /* fetcher */ fetcher,
      totalPackets,
    );
  }

  // Probe-then-(maybe-)remainder.
  const probeEnd = Math.min(group.start + probeBytes, group.end);
  const probe = await fetcher.fetchRange(group.start, probeEnd);

  let neededEndsInSlab: number[];
  try {
    neededEndsInSlab = computeNeededBytesPerTilePart(probe, group, keepPackets);
  } catch {
    // PLT parsing failed inside the probe — fall back to per-tile-part path.
    return fallbackPerTilePart(fetcher, group, keepPackets, totalPackets);
  }

  const lastNeededOffset = Math.max(...neededEndsInSlab);
  if (lastNeededOffset <= probe.length) {
    // Probe covers everything — slice each tile-part.
    return trimSlabPerTilePart(
      probe,
      group,
      keepPackets,
      fetcher,
      totalPackets,
    );
  }

  // Need a corrective fetch for the bytes past the probe.
  const remainderEnd = group.start + lastNeededOffset;
  const remainder = await fetcher.fetchRange(probeEnd, remainderEnd);
  const assembled = new Uint8Array(probe.length + remainder.length);
  assembled.set(probe, 0);
  assembled.set(remainder, probe.length);
  return trimSlabPerTilePart(
    assembled,
    group,
    keepPackets,
    fetcher,
    totalPackets,
  );
}

/** Slice each tile-part's full bytes from the slab (no packet truncation). */
function sliceTilePartsFromSlab(
  slab: Uint8Array,
  group: TilePartGroup,
): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const tp of group.tileParts) {
    const startInSlab = tp.start - group.start;
    const endInSlab = tp.end - group.start;
    // Subarray (view) is fine here — the slab is held by `out`'s entries.
    out.push(slab.subarray(startInSlab, endInSlab));
  }
  return out;
}

/**
 * Per-tile-part truncation inside an assembled slab.
 *
 * `truncateToPackets` only needs SOT + PLT + SOD + first-keepPackets payload
 * bytes — it does NOT need the rest of the tile-part. So when the slab
 * covers a tile-part only up to its trimmed-needed-end (the common case for
 * the probe-then-corrective path), we hand the visible prefix and the helper
 * does the right thing.
 *
 * If parsing fails (SOD not visible, PLT short, malformed), fall back to a
 * per-tile-part fetch for that one tile-part — coalescing should never lose
 * correctness vs the per-tile-part path.
 */
async function trimSlabPerTilePart(
  slab: Uint8Array,
  group: TilePartGroup,
  keepPackets: readonly number[],
  fetcher: RangeFetcher,
  totalPackets: readonly number[],
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (let ti = 0; ti < group.tileParts.length; ti++) {
    const tp = group.tileParts[ti]!;
    const keep = keepPackets[ti]!;
    const total = totalPackets[ti]!;
    const startInSlab = tp.start - group.start;
    const tpLength = tp.end - tp.start;
    const visibleEnd = Math.min(slab.length, startInSlab + tpLength);
    if (visibleEnd <= startInSlab) {
      // Tile-part start is past the slab — definitely under-fetched.
      out.push(
        await fetchTilePartTrimmed(fetcher, {
          range: tp,
          keepPackets: keep,
          totalPackets: total,
        }),
      );
      continue;
    }
    const view = slab.subarray(startInSlab, visibleEnd);
    try {
      out.push(truncateToPackets(view, keep));
    } catch {
      out.push(
        await fetchTilePartTrimmed(fetcher, {
          range: tp,
          keepPackets: keep,
          totalPackets: total,
        }),
      );
    }
  }
  return out;
}

/** Full per-tile-part fallback. Used when the slab can't be trusted. */
async function fallbackPerTilePart(
  fetcher: RangeFetcher,
  group: TilePartGroup,
  keepPackets: readonly number[],
  totalPackets: readonly number[],
): Promise<Uint8Array[]> {
  return Promise.all(
    group.tileParts.map((tp, ti) =>
      fetchTilePartTrimmed(fetcher, {
        range: tp,
        keepPackets: keepPackets[ti]!,
        totalPackets: totalPackets[ti]!,
      }),
    ),
  );
}
