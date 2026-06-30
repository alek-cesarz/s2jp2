import { parseCod, validateS2N0512Capability } from "./markers/cod.js";
import type { CodInfo } from "./markers/cod.js";
import { extractSizInfo } from "./markers/siz.js";
import type { SizInfo } from "./markers/siz.js";
import { tilePartRangesFromHeader } from "./markers/tlm.js";
import type { ByteRange } from "./markers/tlm.js";
import { computePacketTable } from "./profile.js";
import type { PacketTable, TilePacketGeometry } from "./profile.js";
import { tileGridFromSiz } from "./window.js";
import type { TileGrid } from "./window.js";

export interface AssetDescriptor {
  siz: SizInfo;
  cod: CodInfo;
  tileGrid: TileGrid;
  numComponents: number;
  numDecompLevels: number;
  numResolutions: number;
  packetTable: PacketTable;
  /** Canvas-anchored per-tile packet geometry (for correct per-tile-part PLT
   *  trimming — see {@link keepPacketsForTile}). */
  tilePacketGeometry: TilePacketGeometry;
  tileRanges: ByteRange[];
  /** The header bytes used to derive everything above (sub-array of the input). */
  header: Uint8Array;
}

/**
 * Validate + summarise a JP2 main header. Throws `ParseError`/`ProfileMismatchError`/`WindowError`
 * if anything fails, otherwise returns everything downstream code needs to plan
 * windowed fetches and decodes.
 */
export function inspectAsset(header: Uint8Array): AssetDescriptor {
  const siz = extractSizInfo(header);
  const cod = parseCod(header);
  validateS2N0512Capability(cod);
  const tileGrid = tileGridFromSiz(siz);
  const packetTable = computePacketTable({
    tileWidth: siz.tileWidth,
    tileHeight: siz.tileHeight,
    numDecompLevels: cod.numDecompLevels,
    numComponents: siz.numComponents,
    precincts: cod.precincts,
  });
  const tileRanges = tilePartRangesFromHeader(header);
  const tilePacketGeometry: TilePacketGeometry = {
    imageWidth: siz.imageWidth,
    imageHeight: siz.imageHeight,
    tileWidth: siz.tileWidth,
    tileHeight: siz.tileHeight,
    imageXOffset: siz.imageXOffset,
    imageYOffset: siz.imageYOffset,
    tileXOffset: siz.tileXOffset,
    tileYOffset: siz.tileYOffset,
    subsamplingX: siz.subsamplingX,
    subsamplingY: siz.subsamplingY,
    numComponents: siz.numComponents,
    numDecompLevels: cod.numDecompLevels,
    tilesPerRow: tileGrid.tilesPerRow,
    precincts: cod.precincts,
  };
  return {
    siz,
    cod,
    tileGrid,
    numComponents: siz.numComponents,
    numDecompLevels: cod.numDecompLevels,
    numResolutions: cod.numDecompLevels + 1,
    packetTable,
    tilePacketGeometry,
    tileRanges,
    header,
  };
}
