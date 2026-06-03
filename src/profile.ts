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
