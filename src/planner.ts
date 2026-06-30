import { WindowError } from "./errors.js";
import type { AssetDescriptor } from "./inspect.js";
import type { ByteRange } from "./markers/tlm.js";
import {
  keepPacketsForOverview,
  keepPacketsForTile,
  totalPacketsForTile,
} from "./profile.js";
import {
  groupedTilePartRanges,
  validateWindow,
  windowTileIndices,
} from "./window.js";

export interface Window {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Reliability floor (px) for the decoded tile dimension. Below this, a
 * PLT-trimmed reduced decode of a small-tile product produces OpenJPEG
 * boundary-clamp artifacts (the "white cross"), so the planner reads full
 * tile-parts instead.
 */
const MIN_RELIABLE_REDUCED_TILE = 64;
/**
 * Only small-tile products are affected. The artifact was observed on S2 60 m
 * bands (192 px tiles); standard 10/20 m tiles are 1024 px and decode cleanly
 * at every reduce level. Gating on the SOURCE tile size (not just the decoded
 * dimension) keeps large-tile products on the bandwidth-saving trim path even
 * at deep reduce levels — e.g. a 1024 px tile with 6 resolution levels at
 * reduce 5 (1024 >> 5 = 32) must NOT be forced to a full read.
 */
const SMALL_TILE_PX = 512;

export interface FetchPlan {
  tileIndices: number[];
  tileRanges: ByteRange[]; // intersecting tile-parts in TLM order
  ranges: ByteRange[]; // coalesced ranges for fetching
  /** Representative (origin-tile) figures — kept for back-compat. Per-tile-part
   *  trimming MUST use the per-index maps below, which are position-aware. */
  keepPackets: number;
  totalPackets: number;
  /** Packets to keep, per tile index (canvas-anchored, position-aware). */
  keepPacketsByIndex: Map<number, number>;
  /** Total packets, per tile index. */
  totalPacketsByIndex: Map<number, number>;
}

export function planWindowFetches(
  descriptor: AssetDescriptor,
  window: Window,
  overviewLevel: number,
): FetchPlan {
  validateWindow(
    descriptor.tileGrid,
    window.x,
    window.y,
    window.width,
    window.height,
  );
  let keepPackets = keepPacketsForOverview(
    overviewLevel,
    descriptor.packetTable,
  );
  if (keepPackets === null) {
    throw new WindowError(
      `overview level ${overviewLevel} exceeds asset max ${descriptor.numDecompLevels}`,
    );
  }
  const totalPackets = descriptor.packetTable.cumulativePackets.at(-1) ?? 0;

  // Small-tile trim guard. Tiny tiles (e.g. Sentinel-2 60 m bands use 192 px
  // tiles, vs 1024 px at 10/20 m) decode unreliably at high reduce levels when
  // the codestream is PLT-trimmed: OpenJPEG's reduced inverse wavelet at the
  // tile boundary saturates the under-decoded coefficients to a clamp value,
  // producing a white cross along the tile seams. Such tiles are tiny, so
  // reading the whole tile-part costs almost nothing — disable trimming when a
  // SMALL-TILE product's decoded tile dimension falls below a reliability floor.
  // Gating on the source tile size (`<= SMALL_TILE_PX`) keeps large-tile
  // products (1024 px) on the trim path at every reduce level — including the
  // deep levels of a ≥6-resolution asset where the post-reduce dimension alone
  // would otherwise dip below the floor (1024 >> 5 = 32).
  const tileMin = Math.min(descriptor.siz.tileWidth, descriptor.siz.tileHeight);
  const forceFullRead =
    tileMin > 0 &&
    tileMin <= SMALL_TILE_PX &&
    tileMin >> overviewLevel < MIN_RELIABLE_REDUCED_TILE;
  if (forceFullRead) keepPackets = totalPackets;
  const tileIndices = windowTileIndices(
    descriptor.tileGrid,
    window.x,
    window.y,
    window.width,
    window.height,
  );
  const tileRanges = tileIndices.map((idx) => {
    const r = descriptor.tileRanges[idx];
    if (!r)
      throw new WindowError(
        `tile index ${idx} out of TLM range (${descriptor.tileRanges.length})`,
      );
    return r;
  });
  const grouped = groupedTilePartRanges(descriptor.tileRanges, tileIndices);

  // Per-tile keepPackets/totalPackets. Precinct partitions are anchored to the
  // image origin, so tiles straddle the grid differently and have different
  // per-resolution packet counts; a global keepPackets cuts the non-origin tiles
  // mid-resolution. When the small-tile guard forces a full read, keep == total
  // per tile (no trim) — preserving the boundary-clamp safeguard.
  const geom = descriptor.tilePacketGeometry;
  const keepPacketsByIndex = new Map<number, number>();
  const totalPacketsByIndex = new Map<number, number>();
  for (const idx of tileIndices) {
    const tileTotal = totalPacketsForTile(geom, idx);
    totalPacketsByIndex.set(idx, tileTotal);
    const tileKeep = forceFullRead
      ? tileTotal
      : (keepPacketsForTile(geom, idx, overviewLevel) ?? tileTotal);
    keepPacketsByIndex.set(idx, tileKeep);
  }
  return {
    tileIndices,
    tileRanges,
    ranges: grouped,
    keepPackets,
    totalPackets,
    keepPacketsByIndex,
    totalPacketsByIndex,
  };
}
