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
