import type { ProgressionOrder } from "./markers/cod.js";

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
  progression: "LRCP",
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
  const { tileWidth, tileHeight, numDecompLevels, numComponents, precincts } =
    args;
  if (!Number.isInteger(tileWidth) || tileWidth <= 0) {
    throw new RangeError(`tileWidth=${tileWidth} must be a positive integer`);
  }
  if (!Number.isInteger(tileHeight) || tileHeight <= 0) {
    throw new RangeError(`tileHeight=${tileHeight} must be a positive integer`);
  }
  if (!Number.isInteger(numDecompLevels) || numDecompLevels < 0) {
    throw new RangeError(
      `numDecompLevels=${numDecompLevels} must be a non-negative integer`,
    );
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
 *
 * NOTE: this uses a SINGLE global packet table, which is only correct for the
 * tile at the canvas origin. Precinct partitions are anchored to the image
 * origin, so other tiles straddle the precinct grid and have DIFFERENT
 * per-resolution packet counts — truncating them with this global count cuts
 * mid-resolution and corrupts the decode. Use {@link keepPacketsForTile} per
 * tile-part instead; this is kept only for callers that still need a
 * representative figure (e.g. `totalPackets`).
 */
export function keepPacketsForOverview(
  level: number,
  table: PacketTable,
): number | null {
  const r = table.packetsPerResolution.length - 1;
  if (!Number.isInteger(level) || level < 0 || level > r) return null;
  return table.cumulativePackets[r - level] ?? null;
}

/**
 * Canvas-anchored per-tile packet geometry. Unlike {@link computePacketTable}
 * (which counts precincts tile-relative and is only right for the origin tile),
 * this models the JPEG 2000 precinct partition anchored to the image origin
 * (Annex B.6), so each tile's true per-resolution packet count is computed from
 * its position. Assumes uniform component sub-sampling (S2 assets are 1,1).
 */
export interface TilePacketGeometry {
  imageWidth: number;
  imageHeight: number;
  tileWidth: number;
  tileHeight: number;
  imageXOffset: number;
  imageYOffset: number;
  tileXOffset: number;
  tileYOffset: number;
  subsamplingX: number;
  subsamplingY: number;
  numComponents: number;
  numDecompLevels: number;
  tilesPerRow: number;
  /** COD precinct sizes, coarsest-first, length numDecompLevels + 1. */
  precincts: ReadonlyArray<readonly [number, number]>;
}

/**
 * Packets per resolution for ONE tile (index 0 = coarsest resolution), computed
 * position-aware. For resolution level r the tile occupies resolution-grid
 * coords [trx0,trx1)×[try0,try1); the number of precincts is
 * `ceil(tr1/2^PP) − floor(tr0/2^PP)` per axis — i.e. counted on the
 * image-anchored precinct grid, NOT tile-relative.
 */
export function packetsPerResolutionForTile(
  geom: TilePacketGeometry,
  tileIndex: number,
): number[] {
  const p = tileIndex % geom.tilesPerRow;
  const q = Math.floor(tileIndex / geom.tilesPerRow);
  const sx = geom.subsamplingX || 1;
  const sy = geom.subsamplingY || 1;
  const tcx0 = Math.ceil(
    Math.max(geom.tileXOffset + p * geom.tileWidth, geom.imageXOffset) / sx,
  );
  const tcx1 = Math.ceil(
    Math.min(geom.tileXOffset + (p + 1) * geom.tileWidth, geom.imageWidth) / sx,
  );
  const tcy0 = Math.ceil(
    Math.max(geom.tileYOffset + q * geom.tileHeight, geom.imageYOffset) / sy,
  );
  const tcy1 = Math.ceil(
    Math.min(geom.tileYOffset + (q + 1) * geom.tileHeight, geom.imageHeight) /
      sy,
  );
  const NL = geom.numDecompLevels;
  const out: number[] = new Array(NL + 1);
  for (let r = 0; r <= NL; r++) {
    const div = 2 ** (NL - r);
    const trx0 = Math.ceil(tcx0 / div);
    const trx1 = Math.ceil(tcx1 / div);
    const try0 = Math.ceil(tcy0 / div);
    const try1 = Math.ceil(tcy1 / div);
    const [ppx, ppy] = geom.precincts[r] ?? [15, 15];
    const nx =
      trx1 > trx0
        ? Math.ceil(trx1 / 2 ** ppx) - Math.floor(trx0 / 2 ** ppx)
        : 0;
    const ny =
      try1 > try0
        ? Math.ceil(try1 / 2 ** ppy) - Math.floor(try0 / 2 ** ppy)
        : 0;
    out[r] = nx * ny * geom.numComponents;
  }
  return out;
}

/**
 * Packets to keep for a tile-part at overview `level`: the packets for
 * resolutions `0 … numDecompLevels − level` of THAT tile. Returns null when
 * `level` exceeds the available resolutions.
 */
export function keepPacketsForTile(
  geom: TilePacketGeometry,
  tileIndex: number,
  level: number,
): number | null {
  const NL = geom.numDecompLevels;
  if (!Number.isInteger(level) || level < 0 || level > NL) return null;
  const per = packetsPerResolutionForTile(geom, tileIndex);
  let sum = 0;
  for (let r = 0; r <= NL - level; r++) sum += per[r]!;
  return sum;
}

/** Total packets (all resolutions) for a tile-part. */
export function totalPacketsForTile(
  geom: TilePacketGeometry,
  tileIndex: number,
): number {
  const per = packetsPerResolutionForTile(geom, tileIndex);
  let sum = 0;
  for (const v of per) sum += v;
  return sum;
}
