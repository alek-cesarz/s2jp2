import { ParseError } from '../errors.js';

const SIZ_MARKER_0 = 0xff;
const SIZ_MARKER_1 = 0x51;
const SIZ_MIN_BODY_BYTES = 38; // Lsiz minimum (36 fixed + 2 length bytes)

export interface SizInfo {
  imageWidth: number;
  imageHeight: number;
  tileWidth: number;
  tileHeight: number;
  numComponents: number;
}

/**
 * Locate the SIZ marker (FF 51) inside main-header bytes and return image
 * dimensions, tile dimensions, and component count. Throws if absent or
 * truncated.
 */
export function extractSizInfo(data: Uint8Array): SizInfo {
  const pos = findMarker(data, SIZ_MARKER_0, SIZ_MARKER_1);
  if (pos < 0) throw new ParseError('SIZ marker (FF 51) not found');

  const after = pos + 2;
  if (after + SIZ_MIN_BODY_BYTES > data.byteLength) {
    throw new ParseError('SIZ segment truncated: cannot read fixed prefix');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lsiz = view.getUint16(after, false);
  if (lsiz < SIZ_MIN_BODY_BYTES) {
    throw new ParseError(`SIZ Lsiz=${lsiz} below minimum ${SIZ_MIN_BODY_BYTES}`);
  }
  if (after + lsiz > data.byteLength) {
    throw new ParseError(`SIZ segment claims ${lsiz} bytes but only ${data.byteLength - after} available`);
  }
  const imageWidth = view.getUint32(after + 4, false);
  const imageHeight = view.getUint32(after + 8, false);
  const tileWidth = view.getUint32(after + 20, false);
  const tileHeight = view.getUint32(after + 24, false);
  const numComponents = view.getUint16(after + 36, false);

  if (imageWidth === 0 || imageHeight === 0) {
    throw new ParseError(`SIZ declares degenerate image dimensions ${imageWidth}x${imageHeight}`);
  }
  if (tileWidth === 0 || tileHeight === 0) {
    throw new ParseError(`SIZ declares degenerate tile dimensions ${tileWidth}x${tileHeight}`);
  }
  if (numComponents < 1 || numComponents > 4) {
    throw new ParseError(`SIZ declares unsupported Csiz=${numComponents} (expected 1..4)`);
  }
  return { imageWidth, imageHeight, tileWidth, tileHeight, numComponents };
}

function findMarker(data: Uint8Array, a: number, b: number): number {
  for (let i = 0; i + 1 < data.byteLength; i++) {
    if (data[i] === a && data[i + 1] === b) return i;
  }
  return -1;
}
