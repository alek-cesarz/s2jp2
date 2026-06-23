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

/**
 * Reliability floor (px) for the decoded tile dimension. Below this, a
 * PLT-trimmed reduced decode produces OpenJPEG boundary-clamp artifacts
 * (the "white cross"), so the planner reads full tile-parts instead. Chosen
 * so standard 1024 px tiles are never affected at any valid reduce level
 * (1024 >> 4 = 64) while small (≤512 px) tiles are read whole at the reduce
 * levels where the artifact appears.
 */
const MIN_RELIABLE_REDUCED_TILE = 64;

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
  let keepPackets = keepPacketsForOverview(overviewLevel, descriptor.packetTable);
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
  // reading the whole tile-part costs almost nothing — disable trimming when
  // the decoded tile dimension falls below a reliability floor. Standard
  // 1024 px tiles never trip this within their valid reduce range
  // (1024 >> 4 = 64), so their PLT bandwidth savings are unaffected.
  const tw = descriptor.siz.tileWidth;
  const th = descriptor.siz.tileHeight;
  if (tw > 0 && th > 0) {
    const reducedTileMin = Math.min(tw, th) >> overviewLevel;
    if (reducedTileMin < MIN_RELIABLE_REDUCED_TILE) keepPackets = totalPackets;
  }
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
