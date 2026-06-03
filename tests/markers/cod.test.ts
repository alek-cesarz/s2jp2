import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCod, validateS2N0512Capability } from '../../src/markers/cod.js';
import { ParseError, ProfileMismatchError } from '../../src/errors.js';

/** A COD shaped like S2 N0512, parameterised by decomposition level count. */
function buildSyntheticCod(numDecompLevels: number): Uint8Array {
  const Lcod = 12 + (numDecompLevels + 1);
  const head = [
    (Lcod >> 8) & 0xff, Lcod & 0xff,
    0x01,                         // Scod
    0,                            // progression LRCP
    0x00, 0x01,                   // num layers = 1
    0x01,                         // MCT
    numDecompLevels & 0xff,
    0x04,                         // cb width exp
    0x04,                         // cb height exp
    0x00,                         // cb style
    0x01,                         // wavelet 5/3
  ];
  const precincts = Array(numDecompLevels + 1).fill(0x88);
  return Uint8Array.from([0xff, 0x52, ...head, ...precincts]);
}

describe('parseCod', () => {
  it('parses a TCI-10m-shaped COD (4 decomp levels)', () => {
    const info = parseCod(buildSyntheticCod(4));
    expect(info.progression).toBe('LRCP');
    expect(info.numLayers).toBe(1);
    expect(info.mct).toBe(1);
    expect(info.numDecompLevels).toBe(4);
    expect(info.codeBlockWidthExp).toBe(4);
    expect(info.codeBlockHeightExp).toBe(4);
    expect(info.codeBlockStyle).toBe(0);
    expect(info.waveletTransform).toBe(1);
    expect(info.userDefinedPrecincts).toBe(true);
    expect(info.precincts).toEqual([[8, 8], [8, 8], [8, 8], [8, 8], [8, 8]]);
  });

  it('parses a B04-60m-shaped COD (3 decomp levels)', () => {
    const info = parseCod(buildSyntheticCod(3));
    expect(info.numDecompLevels).toBe(3);
    expect(info.precincts.length).toBe(4);
  });

  it('rejects unknown progression order', () => {
    const buf = buildSyntheticCod(4);
    buf[5] = 99;
    expect(() => parseCod(buf)).toThrow(ParseError);
  });

  it('rejects missing COD marker', () => {
    expect(() => parseCod(new Uint8Array([0, 1, 2, 3]))).toThrow(ParseError);
  });
});

describe('validateS2N0512Capability', () => {
  it('accepts a TCI-shaped CodInfo', () => {
    expect(() => validateS2N0512Capability(parseCod(buildSyntheticCod(4)))).not.toThrow();
  });
  it('accepts a CodInfo with 3 decomp levels', () => {
    expect(() => validateS2N0512Capability(parseCod(buildSyntheticCod(3)))).not.toThrow();
  });
  it('rejects RPCL progression', () => {
    const info = { ...parseCod(buildSyntheticCod(4)), progression: 'RPCL' as const };
    expect(() => validateS2N0512Capability(info)).toThrow(ProfileMismatchError);
  });
  it('rejects multi-layer COD', () => {
    const info = { ...parseCod(buildSyntheticCod(4)), numLayers: 2 };
    expect(() => validateS2N0512Capability(info)).toThrow(ProfileMismatchError);
  });
  it('rejects non-reversible wavelet (irreversible 9/7)', () => {
    const info = { ...parseCod(buildSyntheticCod(4)), waveletTransform: 0 };
    expect(() => validateS2N0512Capability(info)).toThrow(ProfileMismatchError);
  });
});

const TCI = 'tests/fixtures/sample_TCI_10m.jp2';
const B04 = 'tests/fixtures/sample_B04_60m.jp2';
describe.runIf(existsSync(TCI))('COD (real TCI 10m)', () => {
  it('passes S2 N0512 capability validation', () => {
    const data = readFileSync(TCI);
    const header = new Uint8Array(data.buffer, data.byteOffset, 100_000);
    expect(() => validateS2N0512Capability(parseCod(header))).not.toThrow();
  });
});
describe.runIf(existsSync(B04))('COD (real B04 60m)', () => {
  it('passes S2 N0512 capability validation', () => {
    const data = readFileSync(B04);
    const header = new Uint8Array(data.buffer, data.byteOffset, 100_000);
    expect(() => validateS2N0512Capability(parseCod(header))).not.toThrow();
  });
});
