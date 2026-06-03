import { ParseError, ProfileMismatchError } from '../errors.js';
import { S2_N0512_CAPABILITY } from '../profile.js';
import { findMarker } from './scan.js';

const COD_MARKER_0 = 0xff;
const COD_MARKER_1 = 0x52;

export type ProgressionOrder = 'LRCP' | 'RLCP' | 'RPCL' | 'PCRL' | 'CPRL';
const PROGRESSION_BY_BYTE: Record<number, ProgressionOrder> = {
  0: 'LRCP',
  1: 'RLCP',
  2: 'RPCL',
  3: 'PCRL',
  4: 'CPRL',
};

export interface CodInfo {
  lcod: number;
  scod: number;
  progression: ProgressionOrder;
  numLayers: number;
  mct: number;
  numDecompLevels: number;
  codeBlockWidthExp: number;
  codeBlockHeightExp: number;
  codeBlockStyle: number;
  waveletTransform: number;
  userDefinedPrecincts: boolean;
  precincts: ReadonlyArray<readonly [number, number]>;
}

export function parseCod(data: Uint8Array): CodInfo {
  const pos = findMarker(data, COD_MARKER_0, COD_MARKER_1);
  if (pos < 0) throw new ParseError('COD marker (FF 52) not found');

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const after = pos + 2;
  if (after + 2 > data.byteLength) throw new ParseError('COD truncated before Lcod');
  const lcod = view.getUint16(after, false);
  if (lcod < 12) throw new ParseError(`COD Lcod=${lcod} below minimum 12`);
  if (after + lcod > data.byteLength) {
    throw new ParseError(`COD claims ${lcod} bytes; only ${data.byteLength - after} available`);
  }
  // Payload begins after Lcod (which is the first 2 bytes after the marker)
  const p = after + 2;
  if (p + 10 > data.byteLength) throw new ParseError('COD payload truncated');

  const scod = data[p]!;
  const progByte = data[p + 1]!;
  const progression = PROGRESSION_BY_BYTE[progByte];
  if (!progression) {
    throw new ParseError(`COD: unknown progression order 0x${progByte.toString(16)}`);
  }
  const numLayers = view.getUint16(p + 2, false);
  const mct = data[p + 4]!;
  const numDecompLevels = data[p + 5]!;
  const codeBlockWidthExp = data[p + 6]!;
  const codeBlockHeightExp = data[p + 7]!;
  const codeBlockStyle = data[p + 8]!;
  const waveletTransform = data[p + 9]!;

  const userDefined = (scod & 0x01) !== 0;
  let precincts: ReadonlyArray<readonly [number, number]> = [];
  if (userDefined) {
    const count = numDecompLevels + 1;
    const start = p + 10;
    if (start + count > data.byteLength) {
      throw new ParseError(`COD precincts truncated: need ${count}, have ${data.byteLength - start}`);
    }
    const out: Array<readonly [number, number]> = new Array(count);
    for (let i = 0; i < count; i++) {
      const b = data[start + i]!;
      out[i] = [b & 0x0f, (b >> 4) & 0x0f];
    }
    precincts = out;
  }

  return {
    lcod, scod, progression, numLayers, mct, numDecompLevels,
    codeBlockWidthExp, codeBlockHeightExp, codeBlockStyle, waveletTransform,
    userDefinedPrecincts: userDefined, precincts,
  };
}

/**
 * Validate a parsed CodInfo against the fixed parts of the S2 N0512 framework.
 * Does NOT pin numDecompLevels (varies per asset, captured by the caller for
 * runtime packet-table computation).
 */
export function validateS2N0512Capability(info: CodInfo): void {
  const cap = S2_N0512_CAPABILITY;
  const checks: Array<[string, unknown, unknown]> = [
    ['progression', cap.progression, info.progression],
    ['numLayers', cap.numLayers, info.numLayers],
    ['codeBlockStyle', cap.codeBlockStyle, info.codeBlockStyle],
    ['waveletTransform', cap.waveletTransform, info.waveletTransform],
    ['userDefinedPrecincts', cap.userDefinedPrecincts, info.userDefinedPrecincts],
  ];
  for (const [field, expected, actual] of checks) {
    if (expected !== actual) {
      throw new ProfileMismatchError(
        `COD field ${field} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
}
