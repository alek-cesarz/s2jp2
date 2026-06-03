import { ParseError } from '../errors.js';

const SOC = [0xff, 0x4f] as const; // start of codestream
const SOT = [0xff, 0x90] as const; // start of tile-part
const SOD = [0xff, 0x93] as const; // start of data (in tile-part)
const EOC = [0xff, 0xd9] as const; // end of codestream
const TLM = [0xff, 0x55] as const; // tile-part lengths (main header)

export function socOffset(data: Uint8Array): number {
  return findMarker(data, SOC[0], SOC[1]);
}

export function firstSotOffset(data: Uint8Array): number {
  return findMarker(data, SOT[0], SOT[1]);
}

/** Slice between SOC and the first SOT. Throws if either is missing. */
function mainHeaderPrefix(header: Uint8Array): Uint8Array {
  const soc = socOffset(header);
  if (soc < 0) throw new ParseError('SOC (FF 4F) not found in header');
  const sot = firstSotOffset(header);
  if (sot < 0) throw new ParseError('first SOT (FF 90) not found in header');
  return header.subarray(soc, sot);
}

/** Re-emit the main header prefix with TLM segments removed. */
function prefixWithoutTlm(prefix: Uint8Array): Uint8Array {
  if (prefix.byteLength < 2 || prefix[0] !== SOC[0] || prefix[1] !== SOC[1]) {
    throw new ParseError('prefix does not start with SOC (FF 4F)');
  }
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  const out: number[] = [SOC[0], SOC[1]];
  let pos = 2;
  while (pos + 4 <= prefix.byteLength) {
    const m0 = prefix[pos];
    const m1 = prefix[pos + 1];
    // SOT / SOD / EOC carry no length — bail (shouldn't occur in a clean prefix)
    if (
      (m0 === SOT[0] && m1 === SOT[1]) ||
      (m0 === SOD[0] && m1 === SOD[1]) ||
      (m0 === EOC[0] && m1 === EOC[1])
    ) {
      break;
    }
    const segLen = view.getUint16(pos + 2, false);
    if (segLen < 2) {
      throw new ParseError(
        `invalid segment length ${segLen} at offset ${pos} (marker 0x${m0!.toString(16)}${m1!.toString(16)})`,
      );
    }
    const segEnd = pos + 2 + segLen;
    if (segEnd > prefix.byteLength) {
      throw new ParseError(
        `segment 0x${m0!.toString(16)}${m1!.toString(16)} extends past prefix (end=${segEnd}, len=${prefix.byteLength})`,
      );
    }
    if (!(m0 === TLM[0] && m1 === TLM[1])) {
      for (let i = pos; i < segEnd; i++) out.push(prefix[i]!);
    }
    pos = segEnd;
  }
  // Trailing bytes (defensive — should not happen given the loop boundary)
  for (let i = pos; i < prefix.byteLength; i++) out.push(prefix[i]!);
  return Uint8Array.from(out);
}

/**
 * Build a fresh valid codestream from the main header (TLM-stripped) plus
 * a sequence of tile-part payloads, terminated with EOC.
 */
export function stitchPartialCodestream(
  header: Uint8Array,
  tilePartPayloads: readonly Uint8Array[],
): Uint8Array {
  const prefix = prefixWithoutTlm(mainHeaderPrefix(header));
  const payloadBytes = tilePartPayloads.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(prefix.byteLength + payloadBytes + 2);
  out.set(prefix, 0);
  let cursor = prefix.byteLength;
  for (const p of tilePartPayloads) {
    out.set(p, cursor);
    cursor += p.byteLength;
  }
  out[cursor] = EOC[0];
  out[cursor + 1] = EOC[1];
  return out;
}

function findMarker(data: Uint8Array, a: number, b: number): number {
  for (let i = 0; i + 1 < data.byteLength; i++) {
    if (data[i] === a && data[i + 1] === b) return i;
  }
  return -1;
}
