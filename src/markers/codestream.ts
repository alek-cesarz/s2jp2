import { ParseError } from '../errors.js';
import { findMarker } from './scan.js';

const SOC = [0xff, 0x4f] as const; // start of codestream
const SOT = [0xff, 0x90] as const; // start of tile-part
const SOD = [0xff, 0x93] as const; // start of data (in tile-part)
const EOC = [0xff, 0xd9] as const; // end of codestream
const TLM = [0xff, 0x55] as const; // tile-part lengths (main header)

export function socOffset(data: Uint8Array): number {
  return findMarker(data, SOC[0], SOC[1]);
}

/**
 * Offset of the first SOT (FF 90) — the start of the first tile-part.
 *
 * Walks the main-header marker segments from SOC by their declared lengths
 * rather than scanning raw bytes, because FF 90 can occur INSIDE a marker
 * segment's payload (e.g. a SIZ/COM/QCD body) and a naive scan would match
 * that spurious occurrence, anchoring every tile-part offset too early.
 * Observed in the wild on Sentinel-2 L1C T34SEG, whose SIZ payload contains
 * FF 90 00 70 fifty-six bytes before the real SOT — which silently shifted
 * every TLM-derived tile-part range and broke the decode.
 *
 * Falls back to the linear scan when SOC is absent or the marker walk can't
 * complete (truncated/non-conformant header), preserving the old behaviour
 * for inputs that never had a clean main header to walk.
 */
export function firstSotOffset(data: Uint8Array): number {
  const soc = socOffset(data);
  if (soc < 0) return findMarker(data, SOT[0], SOT[1]);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = soc + 2; // SOC itself carries no length field
  while (pos + 2 <= data.byteLength) {
    if (data[pos] !== 0xff) break; // not at a marker boundary — bail to scan
    const m1 = data[pos + 1]!;
    if (m1 === SOT[1]) return pos; // first tile-part
    // SOD/EOC (no length) must not precede SOT in a well-formed main header.
    if (m1 === SOD[1] || m1 === EOC[1]) break;
    if (pos + 4 > data.byteLength) break;
    const segLen = view.getUint16(pos + 2, false);
    if (segLen < 2) break; // invalid Lmar
    pos += 2 + segLen;
  }
  // Marker walk could not locate SOT — fall back to the linear scan so a
  // non-conformant header still has a chance rather than a hard failure.
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
