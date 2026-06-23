import { describe, expect, it } from 'vitest';
import {
  firstSotOffset,
  socOffset,
  stitchPartialCodestream,
} from '../../src/markers/codestream.js';
import { ParseError } from '../../src/errors.js';

describe('SOC / SOT scanning', () => {
  it('finds SOC (FF 4F) and first SOT (FF 90)', () => {
    const buf = new Uint8Array([
      0xAA, 0xBB, 0xFF, 0x4F, 0xFF, 0x51, 0x00, 0x04, 0xAA, 0xBB,
      0xFF, 0x90, 0x00, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(socOffset(buf)).toBe(2);
    expect(firstSotOffset(buf)).toBe(10);
  });
  it('returns -1 when missing', () => {
    expect(socOffset(new Uint8Array([0, 1, 2, 3]))).toBe(-1);
    expect(firstSotOffset(new Uint8Array([0, 1, 2, 3]))).toBe(-1);
  });

  it('fallback signature scan skips a spurious FF 90 00 70 (no-SOC path)', () => {
    // No SOC → firstSotOffset uses the signature-scan fallback. A bare FF 90
    // scan would match the spurious FF 90 00 70; the FF 90 00 0A signature skips it.
    const buf = new Uint8Array([
      0x00, 0x00, 0xff, 0x90, 0x00, 0x70, 0x11, 0x22, // spurious FF 90 00 70 @2
      0xff, 0x90, 0x00, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, // real SOT @8
    ]);
    expect(firstSotOffset(buf)).toBe(8);
  });


  it('skips a spurious FF 90 inside a marker-segment payload (real-world: S2 T34SEG)', () => {
    // A main-header marker segment whose PAYLOAD contains the bytes FF 90 00 70
    // (not a real SOT). A naive byte-scan returns that offset, anchoring every
    // tile-part 56 bytes too early. firstSotOffset must walk markers by length
    // and return the REAL SOT at the segment boundary.
    const buf = new Uint8Array([
      0xff, 0x4f, // SOC @0
      0xff, 0x51, 0x00, 0x0a, 0xaa, 0xbb, 0xff, 0x90, 0x00, 0x70, 0xcc, 0xdd, // SIZ @2, Lmar=10, payload has FF 90 00 70 @8
      0xff, 0x90, 0x00, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, // real SOT @14
    ]);
    expect(firstSotOffset(buf)).toBe(14); // not 8 (the spurious FF 90)
  });

  it('returns the SOT offset for a clean header (marker-walk == byte-scan)', () => {
    // SOC, SIZ (len 4), COD (len 3), then SOT — no spurious FF 90.
    const buf = new Uint8Array([
      0xff, 0x4f, // SOC @0
      0xff, 0x51, 0x00, 0x04, 0xaa, 0xbb, // SIZ @2
      0xff, 0x52, 0x00, 0x03, 0xcc, // COD @8
      0xff, 0x90, 0x00, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, // SOT @13
    ]);
    expect(firstSotOffset(buf)).toBe(13);
  });
});

describe('stitchPartialCodestream', () => {
  it('drops TLM segments and appends EOC', () => {
    // Prefix: SOC + SIZ-like + TLM + COD-like
    const prefix = new Uint8Array([
      0xFF, 0x4F,
      0xFF, 0x51, 0x00, 0x04, 0xAA, 0xBB,
      0xFF, 0x55, 0x00, 0x05, 0x01, 0x02, 0x03,
      0xFF, 0x52, 0x00, 0x03, 0xCC,
      0xFF, 0x90, 0x00, 0x0A,  // first SOT — boundary
    ]);
    const payloadA = new Uint8Array([0xFF, 0x90, 0x00, 0x0A, 1, 1, 1, 1, 1, 1, 1, 1]);
    const payloadB = new Uint8Array([0xFF, 0x90, 0x00, 0x0A, 2, 2, 2, 2, 2, 2, 2, 2]);
    const out = stitchPartialCodestream(prefix, [payloadA, payloadB]);
    // Expected prefix (TLM stripped, stops before first SOT)
    const expectedPrefix = new Uint8Array([
      0xFF, 0x4F,
      0xFF, 0x51, 0x00, 0x04, 0xAA, 0xBB,
      0xFF, 0x52, 0x00, 0x03, 0xCC,
    ]);
    expect(out.length).toBe(expectedPrefix.length + payloadA.length + payloadB.length + 2);
    expect(Array.from(out.slice(0, expectedPrefix.length))).toEqual(Array.from(expectedPrefix));
    expect(out[out.length - 2]).toBe(0xFF);
    expect(out[out.length - 1]).toBe(0xD9);
  });
  it('throws ParseError when SOC missing', () => {
    expect(() => stitchPartialCodestream(new Uint8Array([0, 0, 0, 0]), [])).toThrow(ParseError);
  });
  it('throws ParseError when first SOT missing', () => {
    const prefix = new Uint8Array([0xFF, 0x4F, 0xFF, 0x51, 0x00, 0x04, 0xAA, 0xBB]);
    expect(() => stitchPartialCodestream(prefix, [])).toThrow(ParseError);
  });
});
