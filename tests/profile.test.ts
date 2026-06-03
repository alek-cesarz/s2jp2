import { describe, expect, it } from 'vitest';
import {
  computePacketTable,
  keepPacketsForOverview,
  S2_N0512_CAPABILITY,
} from '../src/profile.js';

describe('S2_N0512_CAPABILITY', () => {
  it('locks in the invariants every S2 MSI JP2 must satisfy', () => {
    expect(S2_N0512_CAPABILITY.progression).toBe('LRCP');
    expect(S2_N0512_CAPABILITY.numLayers).toBe(1);
    expect(S2_N0512_CAPABILITY.codeBlockWidthExp).toBe(4);
    expect(S2_N0512_CAPABILITY.codeBlockHeightExp).toBe(4);
    expect(S2_N0512_CAPABILITY.waveletTransform).toBe(1);
    expect(S2_N0512_CAPABILITY.requirePltInTileParts).toBe(true);
    expect(S2_N0512_CAPABILITY.requireTlmInMainHeader).toBe(true);
    // numComponents and numDecompLevels intentionally NOT pinned —
    // those are per-asset and discovered from SIZ + COD.
  });
});

describe('computePacketTable', () => {
  it('TCI 10m (3 components, 4 decomp levels) reproduces the s2surgeon table', () => {
    const t = computePacketTable({ numDecompLevels: 4, numComponents: 3 });
    expect(t.packetsPerResolution).toEqual([3, 3, 3, 12, 48]);
    expect(t.cumulativePackets).toEqual([3, 6, 9, 21, 69]);
  });
  it('B04_60m-shaped (1 component, 3 decomp levels) → smaller table', () => {
    const t = computePacketTable({ numDecompLevels: 3, numComponents: 1 });
    // Precincts per resolution for N0512 are [1,1,1,4,16][..R+1] entries.
    // With R=3 → 4 resolutions: precincts [1,1,1,4]
    // packets = precincts * numLayers(1) * numComponents(1) = [1,1,1,4]
    expect(t.packetsPerResolution).toEqual([1, 1, 1, 4]);
    expect(t.cumulativePackets).toEqual([1, 2, 3, 7]);
  });
});

describe('keepPacketsForOverview', () => {
  const tciTable = computePacketTable({ numDecompLevels: 4, numComponents: 3 });
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
