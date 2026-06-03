import { parseCod, validateS2N0512Capability } from './markers/cod.js';
import type { CodInfo } from './markers/cod.js';
import { extractSizInfo } from './markers/siz.js';
import type { SizInfo } from './markers/siz.js';
import { tilePartRangesFromHeader } from './markers/tlm.js';
import type { ByteRange } from './markers/tlm.js';
import { computePacketTable } from './profile.js';
import type { PacketTable } from './profile.js';
import { tileGridFromSiz } from './window.js';
import type { TileGrid } from './window.js';

export interface AssetDescriptor {
  siz: SizInfo;
  cod: CodInfo;
  tileGrid: TileGrid;
  numComponents: number;
  numDecompLevels: number;
  numResolutions: number;
  packetTable: PacketTable;
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
  return {
    siz,
    cod,
    tileGrid,
    numComponents: siz.numComponents,
    numDecompLevels: cod.numDecompLevels,
    numResolutions: cod.numDecompLevels + 1,
    packetTable,
    tileRanges,
    header,
  };
}
