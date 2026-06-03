import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractSizInfo } from '../../src/markers/siz.js';
import { ParseError } from '../../src/errors.js';

function buildSyntheticSiz(opts: {
  Xsiz: number; Ysiz: number; XTsiz: number; YTsiz: number; Csiz: number;
}): Uint8Array {
  // 16 bytes of leading junk → confirms scanner finds FF 51 anywhere.
  // SIZ body length = 36 (fixed prefix) + 3·Csiz. Lsiz = body + 2.
  const componentBytes = 3 * opts.Csiz;
  const Lsiz = 38 + componentBytes; // includes its own 2 bytes
  const buf = new Uint8Array(16 + 2 + Lsiz);
  const v = new DataView(buf.buffer);
  for (let i = 0; i < 16; i++) buf[i] = 0xAA;
  buf[16] = 0xFF; buf[17] = 0x51;
  v.setUint16(18, Lsiz, false);
  v.setUint16(20, 0, false);                  // Rsiz
  v.setUint32(22, opts.Xsiz, false);
  v.setUint32(26, opts.Ysiz, false);
  v.setUint32(30, 0, false); v.setUint32(34, 0, false);   // XOsiz/YOsiz
  v.setUint32(38, opts.XTsiz, false);
  v.setUint32(42, opts.YTsiz, false);
  v.setUint32(46, 0, false); v.setUint32(50, 0, false);   // XTOsiz/YTOsiz
  v.setUint16(54, opts.Csiz, false);
  // Component info — Ssiz precision encoded as (prec-1) in low 7 bits.
  for (let c = 0; c < opts.Csiz; c++) {
    const base = 56 + c * 3;
    buf[base] = 7;     // Ssiz: unsigned, prec=8
    buf[base + 1] = 1; // XRsiz
    buf[base + 2] = 1; // YRsiz
  }
  return buf;
}

describe('extractSizInfo (synthetic)', () => {
  it('reads Xsiz/Ysiz, XTsiz/YTsiz, Csiz from a SIZ marker', () => {
    const info = extractSizInfo(buildSyntheticSiz({
      Xsiz: 10980, Ysiz: 10980, XTsiz: 1024, YTsiz: 1024, Csiz: 3,
    }));
    expect(info).toEqual({
      imageWidth: 10980, imageHeight: 10980,
      tileWidth: 1024, tileHeight: 1024,
      numComponents: 3,
    });
  });
  it('handles a single-component 60m asset shape', () => {
    const info = extractSizInfo(buildSyntheticSiz({
      Xsiz: 1830, Ysiz: 1830, XTsiz: 1024, YTsiz: 1024, Csiz: 1,
    }));
    expect(info.imageWidth).toBe(1830);
    expect(info.numComponents).toBe(1);
  });
  it('throws ParseError when SIZ is absent', () => {
    expect(() => extractSizInfo(new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]))).toThrow(ParseError);
  });
  it('throws ParseError when SIZ is truncated', () => {
    expect(() => extractSizInfo(new Uint8Array([0xFF, 0x51, 0x00, 0x05]))).toThrow(ParseError);
  });
  it('throws ParseError when Xsiz=0 (degenerate image dims)', () => {
    expect(() => extractSizInfo(buildSyntheticSiz({
      Xsiz: 0, Ysiz: 10980, XTsiz: 1024, YTsiz: 1024, Csiz: 3,
    }))).toThrow(/degenerate image dimensions/);
  });
  it('throws ParseError when XTsiz=0 (degenerate tile dims)', () => {
    expect(() => extractSizInfo(buildSyntheticSiz({
      Xsiz: 10980, Ysiz: 10980, XTsiz: 0, YTsiz: 1024, Csiz: 3,
    }))).toThrow(/degenerate tile dimensions/);
  });
  it('throws ParseError when Csiz=0 (unsupported component count)', () => {
    expect(() => extractSizInfo(buildSyntheticSiz({
      Xsiz: 10980, Ysiz: 10980, XTsiz: 1024, YTsiz: 1024, Csiz: 0,
    }))).toThrow(/unsupported Csiz=0/);
  });
  it('throws ParseError when Csiz=5 (exceeds supported max)', () => {
    expect(() => extractSizInfo(buildSyntheticSiz({
      Xsiz: 10980, Ysiz: 10980, XTsiz: 1024, YTsiz: 1024, Csiz: 5,
    }))).toThrow(/unsupported Csiz=5/);
  });
});

const TCI = 'tests/fixtures/sample_TCI_10m.jp2';
const B04 = 'tests/fixtures/sample_B04_60m.jp2';

describe.runIf(existsSync(TCI))('extractSizInfo (real TCI 10m)', () => {
  it('returns 10980x10980, 1024x1024 tiles, 3 components', () => {
    const data = readFileSync(TCI);
    const header = new Uint8Array(data.buffer, data.byteOffset, Math.min(data.byteLength, 100_000));
    expect(extractSizInfo(header)).toMatchObject({
      imageWidth: 10980, imageHeight: 10980, numComponents: 3,
    });
  });
});

describe.runIf(existsSync(B04))('extractSizInfo (real B04 60m)', () => {
  it('returns 1830x1830 and a single component', () => {
    const data = readFileSync(B04);
    const header = new Uint8Array(data.buffer, data.byteOffset, Math.min(data.byteLength, 100_000));
    const info = extractSizInfo(header);
    expect(info.imageWidth).toBe(1830);
    expect(info.imageHeight).toBe(1830);
    expect(info.numComponents).toBe(1);
  });
});
