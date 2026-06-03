import { describe, expect, it } from 'vitest';
import {
  computePacketTable,
  keepPacketsForOverview,
  S2_N0512_CAPABILITY,
} from '../src/profile.js';

describe('S2_N0512_CAPABILITY', () => {
  it('locks in the truly invariant fields', () => {
    expect(S2_N0512_CAPABILITY.progression).toBe('LRCP');
    expect(S2_N0512_CAPABILITY.numLayers).toBe(1);
    expect(S2_N0512_CAPABILITY.waveletTransform).toBe(1);
    expect(S2_N0512_CAPABILITY.codeBlockStyle).toBe(0x00);
    expect(S2_N0512_CAPABILITY.userDefinedPrecincts).toBe(true);
    expect(S2_N0512_CAPABILITY.requirePltInTileParts).toBe(true);
    expect(S2_N0512_CAPABILITY.requireTlmInMainHeader).toBe(true);
  });
  it('does not pin code-block size, precinct size, MCT, or numDecompLevels', () => {
    // These vary per asset; capture them from the parsed COD, do not assume.
    expect('codeBlockWidthExp' in S2_N0512_CAPABILITY).toBe(false);
    expect('codeBlockHeightExp' in S2_N0512_CAPABILITY).toBe(false);
    expect('precinctSize' in S2_N0512_CAPABILITY).toBe(false);
    expect('mct' in S2_N0512_CAPABILITY).toBe(false);
    expect('numDecompLevels' in S2_N0512_CAPABILITY).toBe(false);
  });
});

describe('computePacketTable', () => {
  it('TCI 10m: 1024px tiles, 4 decomp levels, 256-px precincts, 3 components', () => {
    const t = computePacketTable({
      tileWidth: 1024, tileHeight: 1024,
      numDecompLevels: 4,
      numComponents: 3,
      // PPx=PPy=8 → 2^8 = 256 px precincts at every resolution
      precincts: [[8, 8], [8, 8], [8, 8], [8, 8], [8, 8]],
    });
    // tile size per res: 64, 128, 256, 512, 1024
    // precincts per axis: 1, 1, 1, 2, 4 → square 1, 1, 1, 4, 16
    // × 1 layer × 3 components: [3, 3, 3, 12, 48]
    expect(t.packetsPerResolution).toEqual([3, 3, 3, 12, 48]);
    expect(t.cumulativePackets).toEqual([3, 6, 9, 21, 69]);
  });
  it('B04 60m-shape: 1024px tiles, 4 decomp levels, 64-px precincts, 1 component', () => {
    const t = computePacketTable({
      tileWidth: 1024, tileHeight: 1024,
      numDecompLevels: 4,
      numComponents: 1,
      // PPx=PPy=6 → 2^6 = 64 px precincts
      precincts: [[6, 6], [6, 6], [6, 6], [6, 6], [6, 6]],
    });
    // tile size per res: 64, 128, 256, 512, 1024
    // precincts per axis: 1, 2, 4, 8, 16 → square 1, 4, 16, 64, 256
    expect(t.packetsPerResolution).toEqual([1, 4, 16, 64, 256]);
    expect(t.cumulativePackets).toEqual([1, 5, 21, 85, 341]);
  });
  it('throws RangeError on precincts length mismatch', () => {
    expect(() => computePacketTable({
      tileWidth: 1024, tileHeight: 1024,
      numDecompLevels: 4,
      numComponents: 3,
      precincts: [[8, 8], [8, 8]], // wrong length
    })).toThrow(RangeError);
  });
  it('throws RangeError on invalid numComponents', () => {
    expect(() => computePacketTable({
      tileWidth: 1024, tileHeight: 1024,
      numDecompLevels: 4,
      numComponents: 0,
      precincts: [[8, 8], [8, 8], [8, 8], [8, 8], [8, 8]],
    })).toThrow(RangeError);
  });
});

describe('keepPacketsForOverview', () => {
  const tciTable = computePacketTable({
    tileWidth: 1024, tileHeight: 1024, numDecompLevels: 4, numComponents: 3,
    precincts: [[8, 8], [8, 8], [8, 8], [8, 8], [8, 8]],
  });
  it('returns the full packet count at overview level 0', () => {
    expect(keepPacketsForOverview(0, tciTable)).toBe(69);
  });
  it('returns 3 packets at the deepest overview', () => {
    expect(keepPacketsForOverview(4, tciTable)).toBe(3);
  });
  it('walks the cumulative table in reverse', () => {
    expect(keepPacketsForOverview(1, tciTable)).toBe(21);
    expect(keepPacketsForOverview(2, tciTable)).toBe(9);
    expect(keepPacketsForOverview(3, tciTable)).toBe(6);
  });
  it('returns null when overview level exceeds available resolutions', () => {
    expect(keepPacketsForOverview(5, tciTable)).toBeNull();
    expect(keepPacketsForOverview(255, tciTable)).toBeNull();
  });
});
