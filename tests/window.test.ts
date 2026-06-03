import { describe, expect, it } from 'vitest';
import {
  groupedTilePartRanges, tileGridFromSiz, validateWindow, windowTileIndices,
} from '../src/window.js';
import { WindowError } from '../src/errors.js';

const TCI_10M = tileGridFromSiz({
  imageWidth: 10980, imageHeight: 10980, tileWidth: 1024, tileHeight: 1024,
  numComponents: 3,
});
const B04_60M = tileGridFromSiz({
  imageWidth: 1830, imageHeight: 1830, tileWidth: 1024, tileHeight: 1024,
  numComponents: 1,
});

describe('tileGridFromSiz', () => {
  it('computes 11×11 tile grid for TCI 10m', () => {
    expect(TCI_10M.tilesPerRow).toBe(11);
    expect(TCI_10M.tilesPerCol).toBe(11);
    expect(TCI_10M.totalTiles).toBe(121);
  });
  it('computes 2×2 tile grid for B04 60m', () => {
    expect(B04_60M.tilesPerRow).toBe(2);
    expect(B04_60M.tilesPerCol).toBe(2);
    expect(B04_60M.totalTiles).toBe(4);
  });
});

describe('windowTileIndices', () => {
  it('single tile when window lies inside tile (0,0) of TCI 10m', () => {
    expect(windowTileIndices(TCI_10M, 0, 0, 100, 100)).toEqual([0]);
  });
  it('returns 4 corner tiles for 2×2 spread on TCI 10m', () => {
    expect(windowTileIndices(TCI_10M, 900, 900, 200, 200)).toEqual([0, 1, 11, 12]);
  });
  it('full image → all 121 tiles on TCI 10m', () => {
    const all = windowTileIndices(TCI_10M, 0, 0, 10980, 10980);
    expect(all.length).toBe(121);
    expect(all[120]).toBe(120);
  });
  it('full image → all 4 tiles on B04 60m', () => {
    expect(windowTileIndices(B04_60M, 0, 0, 1830, 1830)).toEqual([0, 1, 2, 3]);
  });
});

describe('validateWindow', () => {
  it('accepts a valid window on TCI 10m', () => {
    expect(() => validateWindow(TCI_10M, 0, 0, 1024, 1024)).not.toThrow();
  });
  it('rejects window past the image extent', () => {
    expect(() => validateWindow(TCI_10M, 10000, 0, 2000, 100)).toThrow(WindowError);
  });
  it('rejects zero-sized window', () => {
    expect(() => validateWindow(TCI_10M, 0, 0, 0, 100)).toThrow(WindowError);
  });
  it('accepts a full-image window on B04 60m', () => {
    expect(() => validateWindow(B04_60M, 0, 0, 1830, 1830)).not.toThrow();
  });
});

describe('groupedTilePartRanges', () => {
  const ranges = Array.from({ length: 5 }, (_, i) => ({ start: i * 100, end: i * 100 + 100 }));
  it('collapses contiguous indices into one range', () => {
    expect(groupedTilePartRanges(ranges, [0, 1, 2])).toEqual([{ start: 0, end: 300 }]);
  });
  it('keeps gaps as separate ranges', () => {
    expect(groupedTilePartRanges(ranges, [0, 1, 3, 4])).toEqual([
      { start: 0, end: 200 },
      { start: 300, end: 500 },
    ]);
  });
  it('throws on empty tile index list', () => {
    expect(() => groupedTilePartRanges(ranges, [])).toThrow(WindowError);
  });
});
