import { ParseError } from '../errors.js';

const SOT = [0xff, 0x90] as const;
const PLT = [0xff, 0x58] as const;
const SOD = [0xff, 0x93] as const;
const SOT_LENGTH = 12; // SOT is always 12 bytes (Lsot=0x000A + 2-byte marker)

export function decodePacketLengths(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let current = 0;
  let inProgress = false;
  for (let i = 0; i < bytes.byteLength; i++) {
    const b = bytes[i]!;
    current = ((current << 7) | (b & 0x7f)) >>> 0;
    inProgress = true;
    if ((b & 0x80) === 0) {
      out.push(current);
      current = 0;
      inProgress = false;
    }
  }
  if (inProgress) {
    throw new ParseError('PLT packet length table ends mid-continuation');
  }
  return out;
}

export function sodOffset(tilePart: Uint8Array): number {
  for (let i = 0; i + 1 < tilePart.byteLength; i++) {
    if (tilePart[i] === SOD[0] && tilePart[i + 1] === SOD[1]) return i;
  }
  throw new ParseError('SOD marker (FF 93) not found in tile-part');
}

export function payloadSize(tilePart: Uint8Array): number {
  const sod = sodOffset(tilePart);
  return tilePart.byteLength - (sod + 2);
}

export function extractPacketLengths(tilePart: Uint8Array): number[] {
  const sod = sodOffset(tilePart);
  const view = new DataView(tilePart.buffer, tilePart.byteOffset, tilePart.byteLength);
  let pos = 0;
  const lengths: number[] = [];
  let foundPlt = false;

  while (pos + 2 <= sod) {
    const m0 = tilePart[pos]!;
    const m1 = tilePart[pos + 1]!;

    // SOT inside the tile-part (rare — appears only when concatenating tile-parts)
    if (m0 === SOT[0] && m1 === SOT[1]) {
      if (pos + SOT_LENGTH > tilePart.byteLength) {
        throw new ParseError('truncated SOT inside tile-part');
      }
      pos += SOT_LENGTH;
      continue;
    }

    if (m0 === PLT[0] && m1 === PLT[1]) {
      if (pos + 5 > tilePart.byteLength) throw new ParseError('truncated PLT segment');
      const lplt = view.getUint16(pos + 2, false);
      if (lplt < 3) throw new ParseError(`invalid Lplt=${lplt}`);
      const end = pos + 2 + lplt;
      if (end > tilePart.byteLength) {
        throw new ParseError(`PLT extends past tile-part: end=${end}, len=${tilePart.byteLength}`);
      }
      const ipltBytes = tilePart.subarray(pos + 5, end);
      for (const v of decodePacketLengths(ipltBytes)) lengths.push(v);
      foundPlt = true;
      pos = end;
      continue;
    }

    if (m0 === SOD[0] && m1 === SOD[1]) break;

    // Generic length-prefixed marker (QCD, COD, etc.) — skip
    if (pos + 4 > tilePart.byteLength) {
      throw new ParseError(`cannot read marker length at offset ${pos}`);
    }
    const segLen = view.getUint16(pos + 2, false);
    if (segLen < 2) {
      throw new ParseError(`invalid segment length ${segLen} at offset ${pos}`);
    }
    const end = pos + 2 + segLen;
    if (end > tilePart.byteLength) {
      throw new ParseError(`segment at offset ${pos} extends past tile-part`);
    }
    pos = end;
  }

  if (!foundPlt) throw new ParseError('no PLT segment found in tile-part');
  return lengths;
}

export function truncateToPackets(tilePart: Uint8Array, keepPackets: number): Uint8Array {
  if (tilePart.byteLength < SOT_LENGTH) {
    throw new ParseError(`tile-part too short for SOT: len=${tilePart.byteLength}`);
  }
  if (tilePart[0] !== SOT[0] || tilePart[1] !== SOT[1]) {
    throw new ParseError('tile-part does not start with SOT (FF 90)');
  }
  if (tilePart[2] !== 0x00 || tilePart[3] !== 0x0a) {
    throw new ParseError(
      `unexpected Lsot 0x${tilePart[2]!.toString(16)}${tilePart[3]!.toString(16)} (expected 0x000A)`,
    );
  }

  const sod = sodOffset(tilePart);
  const payloadStart = sod + 2;
  const lengths = extractPacketLengths(tilePart);
  if (keepPackets > lengths.length) {
    throw new ParseError(`keep=${keepPackets} > packet count ${lengths.length}`);
  }
  let keepBytes = 0;
  for (let i = 0; i < keepPackets; i++) keepBytes += lengths[i]!;
  if (payloadStart + keepBytes > tilePart.byteLength) {
    throw new ParseError(
      `keepBytes=${keepBytes} overruns tile-part (payloadStart=${payloadStart}, len=${tilePart.byteLength})`,
    );
  }

  const out = new Uint8Array(payloadStart + keepBytes);
  out.set(tilePart.subarray(0, payloadStart), 0);
  out.set(tilePart.subarray(payloadStart, payloadStart + keepBytes), payloadStart);
  // Patch Psot (4 BE bytes at offset 6 in the SOT)
  const view = new DataView(out.buffer);
  view.setUint32(6, out.byteLength, false);
  return out;
}
