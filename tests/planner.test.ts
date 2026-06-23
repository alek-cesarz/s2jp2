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

describe('planWindowFetches — small-tile trim guard', () => {
  const mkDesc = (tile: number) =>
    ({
      siz: { imageWidth: tile, imageHeight: tile, tileWidth: tile, tileHeight: tile, numComponents: 1 },
      numDecompLevels: 4,
      numResolutions: 5,
      packetTable: { packetsPerResolution: [1, 1, 1, 4, 9], cumulativePackets: [1, 2, 3, 7, 16] },
      tileGrid: { imageWidth: tile, imageHeight: tile, tileWidth: tile, tileHeight: tile, tilesPerRow: 1, tilesPerCol: 1, totalTiles: 1, numComponents: 1 },
      tileRanges: [{ start: 0, end: 1000 }],
      header: new Uint8Array(0),
    }) as unknown as Parameters<typeof planWindowFetches>[0];

  it('disables trimming for small tiles at high reduce (192px tile, reduce 4)', () => {
    // 192 >> 4 = 12 < 64 reliability floor → read full (keepPackets == total),
    // avoiding the OpenJPEG boundary-clamp "white cross".
    const plan = planWindowFetches(mkDesc(192), { x: 0, y: 0, width: 192, height: 192 }, 4);
    expect(plan.keepPackets).toBe(plan.totalPackets); // 16
  });

  it('still trims standard 1024px tiles at reduce 4', () => {
    // 1024 >> 4 = 64, not below the floor → normal PLT trim.
    const plan = planWindowFetches(mkDesc(1024), { x: 0, y: 0, width: 1024, height: 1024 }, 4);
    expect(plan.keepPackets).toBe(1); // cumulative[0]
    expect(plan.keepPackets).toBeLessThan(plan.totalPackets);
  });

  it('does not over-trim small tiles at low reduce (192px tile, reduce 1 stays trimmed)', () => {
    // 192 >> 1 = 96 >= 64 → normal trim (already clean at this level).
    const plan = planWindowFetches(mkDesc(192), { x: 0, y: 0, width: 192, height: 192 }, 1);
    expect(plan.keepPackets).toBe(7); // cumulative[3]
  });
  it('does NOT force a full read for large tiles at deep reduce (1024px, 6 resolutions, reduce 5)', () => {
    // 1024 >> 5 = 32 < 64, but the SOURCE tile (1024) exceeds SMALL_TILE_PX,
    // so a large-tile product keeps its PLT trim even at a deep reduce level.
    const desc = {
      siz: { imageWidth: 1024, imageHeight: 1024, tileWidth: 1024, tileHeight: 1024, numComponents: 1 },
      numDecompLevels: 5,
      numResolutions: 6,
      packetTable: { packetsPerResolution: [1, 1, 1, 1, 4, 9], cumulativePackets: [1, 2, 3, 4, 8, 17] },
      tileGrid: { imageWidth: 1024, imageHeight: 1024, tileWidth: 1024, tileHeight: 1024, tilesPerRow: 1, tilesPerCol: 1, totalTiles: 1, numComponents: 1 },
      tileRanges: [{ start: 0, end: 1000 }],
      header: new Uint8Array(0),
    } as unknown as Parameters<typeof planWindowFetches>[0];
    const plan = planWindowFetches(desc, { x: 0, y: 0, width: 1024, height: 1024 }, 5);
    expect(plan.keepPackets).toBe(1); // cumulative[0]
    expect(plan.keepPackets).toBeLessThan(plan.totalPackets);
  });
});
