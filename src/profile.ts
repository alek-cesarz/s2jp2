import type { ProgressionOrder } from './markers/cod.js';

/**
 * Fixed parts of the S2 N0512 framework that hold across every MSI JP2 asset
 * (TCI / reflectance bands / SCL / CLD / SNW / AOT / WVP at 10 m, 20 m, 60 m).
 * Code-block size and precinct size are NOT included — those vary across
 * resolution tiers; capture them per-asset from the parsed COD.
 */
export interface S2N0512Capability {
  readonly progression: ProgressionOrder;
  readonly numLayers: 1;
  readonly waveletTransform: 1; // 5/3 reversible
  readonly codeBlockStyle: 0x00;
  readonly userDefinedPrecincts: true;
  readonly requirePltInTileParts: boolean;
  readonly requireTlmInMainHeader: boolean;
}

export const S2_N0512_CAPABILITY: S2N0512Capability = {
  progression: 'LRCP',
  numLayers: 1,
  waveletTransform: 1,
  codeBlockStyle: 0x00,
  userDefinedPrecincts: true,
  requirePltInTileParts: true,
  requireTlmInMainHeader: true,
};

/** Runtime packet table derived from the parsed COD + SIZ. */
export interface PacketTable {
  readonly packetsPerResolution: readonly number[];
  readonly cumulativePackets: readonly number[];
}

/**
 * Compute the per-tile-part packet table at runtime.
 *
 * Precincts per resolution depend on the tile size at that resolution and
 * the precinct size declared in the COD. For each resolution r (0=coarsest,
 * R=finest):
 *
 *   W_r = ceil(tileWidth  / 2^(R - r))
 *   H_r = ceil(tileHeight / 2^(R - r))
 *   precincts_x_r = ceil(W_r / 2^PPx_r)
 *   precincts_y_r = ceil(H_r / 2^PPy_r)
 *   precincts_r   = precincts_x_r * precincts_y_r
 *   packets_r     = precincts_r * numLayers(=1) * numComponents
 *
 * `precincts` is the COD per-resolution precinct array (length = R+1, with
 * index 0 = coarsest resolution). Each entry is [PPx, PPy] in COD encoding
 * (range 0..15 each). The function caps PPx/PPy at 15 to match the spec.
 *
 * Throws RangeError on invalid inputs.
 */
export function computePacketTable(args: {
  tileWidth: number;
  tileHeight: number;
  numDecompLevels: number;
  numComponents: number;
  /** From COD, length must equal numDecompLevels + 1, coarsest-first. */
  precincts: ReadonlyArray<readonly [number, number]>;
}): PacketTable {
  const { tileWidth, tileHeight, numDecompLevels, numComponents, precincts } = args;
  if (!Number.isInteger(tileWidth) || tileWidth <= 0) {
    throw new RangeError(`tileWidth=${tileWidth} must be a positive integer`);
  }
  if (!Number.isInteger(tileHeight) || tileHeight <= 0) {
    throw new RangeError(`tileHeight=${tileHeight} must be a positive integer`);
  }
  if (!Number.isInteger(numDecompLevels) || numDecompLevels < 0) {
    throw new RangeError(`numDecompLevels=${numDecompLevels} must be a non-negative integer`);
  }
  if (!Number.isInteger(numComponents) || numComponents < 1) {
    throw new RangeError(`numComponents=${numComponents} must be ≥ 1`);
  }
  const numResolutions = numDecompLevels + 1;
  if (precincts.length !== numResolutions) {
    throw new RangeError(
      `precincts length ${precincts.length} != numResolutions ${numResolutions}`,
    );
  }

  const packetsPerResolution: number[] = new Array(numResolutions);
  const cumulativePackets: number[] = new Array(numResolutions);
  let acc = 0;
  for (let r = 0; r < numResolutions; r++) {
    const scale = 2 ** (numDecompLevels - r);
    const widthAtR = Math.ceil(tileWidth / scale);
    const heightAtR = Math.ceil(tileHeight / scale);
    const [ppx, ppy] = precincts[r]!;
    const precinctW = 2 ** Math.min(ppx, 15);
    const precinctH = 2 ** Math.min(ppy, 15);
    const px = Math.max(1, Math.ceil(widthAtR / precinctW));
    const py = Math.max(1, Math.ceil(heightAtR / precinctH));
    const packets = px * py * 1 /* numLayers */ * numComponents;
    packetsPerResolution[r] = packets;
    acc += packets;
    cumulativePackets[r] = acc;
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
