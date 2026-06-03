import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractTileLengths, tilePartRangesFromHeader } from '../../src/markers/tlm.js';
import { ParseError } from '../../src/errors.js';

function buildSyntheticTlm(lengths: readonly number[]): Uint8Array {
  // Stlm = 0b01_00_0000 → ST=0 (no tile index), SP=1 (4-byte length)
  const entryBytes = 4;
  const Ltlm = 4 + lengths.length * entryBytes; // Stlm payload length incl. itself
  const segment = new Uint8Array(2 + Ltlm);
  const view = new DataView(segment.buffer);
  segment[0] = 0xFF; segment[1] = 0x55;
  view.setUint16(2, Ltlm, false);
  segment[4] = 0;       // Ztlm
  segment[5] = 0b0100_0000; // Stlm: ST=0, SP=1
  let cursor = 6;
  for (const len of lengths) {
    view.setUint32(cursor, len, false);
    cursor += entryBytes;
  }
  return segment;
}

function withSocSotPrefix(tlm: Uint8Array): Uint8Array {
  // Synthetic main header: SOC, SIZ-like, TLM, then first SOT marker so
  // tilePartRangesFromHeader can anchor the ranges.
  const prefix = new Uint8Array([
    0xFF, 0x4F,              // SOC
    0xFF, 0x51, 0x00, 0x04, 0xAA, 0xBB, // SIZ-like
  ]);
  const sotMarker = new Uint8Array([0xFF, 0x90]);
  const out = new Uint8Array(prefix.length + tlm.length + sotMarker.length);
  out.set(prefix, 0);
  out.set(tlm, prefix.length);
  out.set(sotMarker, prefix.length + tlm.length);
  return out;
}

describe('extractTileLengths (synthetic)', () => {
  it('reads 4-byte lengths with ST=0/SP=1', () => {
    const tlm = buildSyntheticTlm([100, 200, 300, 400]);
    expect(extractTileLengths(tlm)).toEqual([100, 200, 300, 400]);
  });
  it('throws when TLM marker absent', () => {
    expect(() => extractTileLengths(new Uint8Array([0, 0, 0]))).toThrow(ParseError);
  });
  it('throws when Stlm declares a reserved SP encoding', () => {
    // Stlm bits: SP at bits 6-7. SP=3 (0b11_xx_xxxx) is reserved.
    // Build minimal segment: FF 55 | Ltlm=4 | Ztlm=0 | Stlm=0xC0 → no entries; pBytes=-1
    const segment = new Uint8Array([0xFF, 0x55, 0x00, 0x04, 0x00, 0xC0]);
    expect(() => extractTileLengths(segment)).toThrow(/invalid ST\/SP/);
  });
  it('reads lengths with ST=1 (1-byte tile index field, SP=1)', () => {
    // Stlm=0b01_01_0000=0x50 → ST=1 (1-byte index), SP=1 (4-byte length)
    // 2 entries × (1 + 4) = 10 bytes body. Ltlm = 4 + 10 = 14.
    const seg = new Uint8Array([
      0xFF, 0x55, 0x00, 0x0E, 0x00, 0x50,
      0x00, 0x00, 0x00, 0x00, 0x64,  // tileIdx=0, length=100
      0x01, 0x00, 0x00, 0x00, 0xC8,  // tileIdx=1, length=200
    ]);
    expect(extractTileLengths(seg)).toEqual([100, 200]);
  });
  it('reads lengths with ST=2 (2-byte tile index field, SP=1)', () => {
    // Stlm=0b01_10_0000=0x60 → ST=2 (2-byte index), SP=1 (4-byte length)
    // 2 entries × (2 + 4) = 12 bytes body. Ltlm = 4 + 12 = 16.
    const seg = new Uint8Array([
      0xFF, 0x55, 0x00, 0x10, 0x00, 0x60,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x64,  // tileIdx=0, length=100
      0x00, 0x01, 0x00, 0x00, 0x00, 0xC8,  // tileIdx=1, length=200
    ]);
    expect(extractTileLengths(seg)).toEqual([100, 200]);
  });
});

describe('tilePartRangesFromHeader (synthetic)', () => {
  it('anchors ranges at the first SOT offset', () => {
    const tlm = buildSyntheticTlm([100, 200, 300]);
    const header = withSocSotPrefix(tlm);
    const sotOffset = header.length - 2;
    const ranges = tilePartRangesFromHeader(header);
    expect(ranges).toEqual([
      { start: sotOffset, end: sotOffset + 100 },
      { start: sotOffset + 100, end: sotOffset + 300 },
      { start: sotOffset + 300, end: sotOffset + 600 },
    ]);
  });
  it('throws when TLM contains a zero-length entry', () => {
    const tlm = buildSyntheticTlm([100, 0, 300]);
    expect(() => tilePartRangesFromHeader(withSocSotPrefix(tlm))).toThrow(ParseError);
  });
});

const FIXTURE = 'tests/fixtures/sample_TCI_10m.jp2';
describe.runIf(existsSync(FIXTURE))('TLM (real S2 TCI)', () => {
  it('returns 121 tile-parts (S2 TCI 10m: 11x11 tiles)', () => {
    const data = readFileSync(FIXTURE);
    const header = new Uint8Array(data.buffer, data.byteOffset, 100_000);
    const ranges = tilePartRangesFromHeader(header);
    expect(ranges.length).toBe(121);
    expect(ranges[0]!.start).toBeLessThan(ranges[0]!.end);
    // Ranges must be contiguous (each end == next start)
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!.start).toBe(ranges[i - 1]!.end);
    }
  });
});
