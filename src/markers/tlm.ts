import { ParseError } from '../errors.js';
import { firstSotOffset } from './codestream.js';

const TLM_MARKER_0 = 0xff;
const TLM_MARKER_1 = 0x55;

/** Decode Stlm into entry sizes. Returns [tileIndexBytes, lengthBytes]. */
function entrySizes(stlm: number): [number, number] {
  const st = (stlm >> 4) & 0x3;
  const sp = (stlm >> 6) & 0x3;
  const tBytes = st === 0 ? 0 : st === 1 ? 1 : st === 2 ? 2 : -1;
  const pBytes = sp === 0 ? 2 : sp === 1 ? 4 : -1;
  return [tBytes, pBytes];
}

/** Locate `FF 55` and return the declared tile-part byte lengths. */
export function extractTileLengths(data: Uint8Array): number[] {
  const pos = findMarker(data, TLM_MARKER_0, TLM_MARKER_1);
  if (pos < 0) throw new ParseError('TLM marker (FF 55) not found');

  const after = pos + 2;
  if (after + 4 > data.byteLength) {
    throw new ParseError('TLM segment truncated before Ltlm/Ztlm/Stlm');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ltlm = view.getUint16(after, false);
  if (ltlm < 4) throw new ParseError(`TLM Ltlm=${ltlm} below minimum 4`);
  if (after + ltlm > data.byteLength) {
    throw new ParseError(`TLM segment claims ${ltlm} bytes; only ${data.byteLength - after} available`);
  }

  const stlm = data[after + 3]!;
  const [tBytes, pBytes] = entrySizes(stlm);
  if (tBytes < 0 || pBytes < 0) {
    throw new ParseError(`TLM Stlm=0x${stlm.toString(16)} declares invalid ST/SP`);
  }
  const entrySize = tBytes + pBytes;
  if (entrySize === 0) {
    throw new ParseError('TLM entry size 0 (ST=0 + SP=0 invalid)');
  }
  const bodyBytes = ltlm - 4;
  if (bodyBytes % entrySize !== 0) {
    throw new ParseError(`TLM body ${bodyBytes} not a multiple of entry size ${entrySize}`);
  }
  const numEntries = bodyBytes / entrySize;
  const lengths: number[] = new Array(numEntries);
  let cursor = after + 4;
  for (let i = 0; i < numEntries; i++) {
    cursor += tBytes; // skip optional tile index
    if (pBytes === 2) {
      lengths[i] = view.getUint16(cursor, false);
    } else {
      lengths[i] = view.getUint32(cursor, false);
    }
    cursor += pBytes;
  }
  return lengths;
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Compute absolute byte ranges (start inclusive, end exclusive) for every
 * tile-part in the file, anchored at the first SOT offset.
 */
export function tilePartRangesFromHeader(header: Uint8Array): ByteRange[] {
  const sot = firstSotOffset(header);
  if (sot < 0) throw new ParseError('first SOT (FF 90) not found in header');
  const lengths = extractTileLengths(header);
  if (lengths.length === 0) throw new ParseError('TLM declares no tile-parts');

  const ranges: ByteRange[] = new Array(lengths.length);
  let start = sot;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    if (len === 0) {
      throw new ParseError(`TLM contains zero-length tile-part at index ${i} (offset ${start})`);
    }
    const end = start + len;
    ranges[i] = { start, end };
    start = end;
  }
  return ranges;
}

function findMarker(data: Uint8Array, a: number, b: number): number {
  for (let i = 0; i + 1 < data.byteLength; i++) {
    if (data[i] === a && data[i + 1] === b) return i;
  }
  return -1;
}
