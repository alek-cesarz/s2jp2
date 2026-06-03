import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectAsset } from '../src/inspect.js';
import { planWindowFetches } from '../src/planner.js';

const TCI = 'tests/fixtures/sample_TCI_10m.jp2';
const B04 = 'tests/fixtures/sample_B04_60m.jp2';

describe.runIf(existsSync(TCI))('inspectAsset (TCI 10m)', () => {
  it('summarises the asset', () => {
    const data = readFileSync(TCI);
    const a = inspectAsset(new Uint8Array(data.buffer, data.byteOffset, 100_000));
    expect(a.tileGrid.imageWidth).toBe(10980);
    expect(a.tileGrid.totalTiles).toBe(121);
    expect(a.numComponents).toBe(3);
    expect(a.numDecompLevels).toBe(4);
    expect(a.numResolutions).toBe(5);
    expect(a.packetTable.cumulativePackets).toEqual([3, 6, 9, 21, 69]);
  });
});

describe.runIf(existsSync(B04))('inspectAsset (B04 60m)', () => {
  it('summarises the single-band 60m asset', () => {
    const data = readFileSync(B04);
    const a = inspectAsset(new Uint8Array(data.buffer, data.byteOffset, 100_000));
    expect(a.tileGrid.imageWidth).toBe(1830);
    expect(a.numComponents).toBe(1);
    expect(a.numResolutions).toBeGreaterThanOrEqual(3);
    expect(a.packetTable.cumulativePackets.at(-1)).toBeLessThan(69);
  });
});

describe.runIf(existsSync(TCI))('planWindowFetches (TCI 10m)', () => {
  it('plans a 100×100 window at overview 4 → one tile, 3 packets', () => {
    const data = readFileSync(TCI);
    const header = new Uint8Array(data.buffer, data.byteOffset, 100_000);
    const descriptor = inspectAsset(header);
    const plan = planWindowFetches(descriptor, { x: 0, y: 0, width: 100, height: 100 }, 4);
    expect(plan.tileIndices).toEqual([0]);
    expect(plan.keepPackets).toBe(3);
    expect(plan.ranges.length).toBe(1);
  });
  it('plans a 2×2 spread at overview 0 → 4 tiles, 69 packets, 2 coalesced ranges', () => {
    const data = readFileSync(TCI);
    const header = new Uint8Array(data.buffer, data.byteOffset, 100_000);
    const descriptor = inspectAsset(header);
    const plan = planWindowFetches(descriptor, { x: 900, y: 900, width: 200, height: 200 }, 0);
    expect(plan.tileIndices).toEqual([0, 1, 11, 12]);
    expect(plan.keepPackets).toBe(69);
    expect(plan.ranges.length).toBe(2);
  });
});
