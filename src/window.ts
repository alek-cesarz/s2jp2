import { WindowError } from './errors.js';
import type { ByteRange } from './markers/tlm.js';
import type { SizInfo } from './markers/siz.js';

export interface TileGrid {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly tilesPerRow: number;
  readonly tilesPerCol: number;
  readonly totalTiles: number;
  readonly numComponents: number;
}

export function tileGridFromSiz(siz: SizInfo): TileGrid {
  const tilesPerRow = Math.ceil(siz.imageWidth / siz.tileWidth);
  const tilesPerCol = Math.ceil(siz.imageHeight / siz.tileHeight);
  return {
    imageWidth: siz.imageWidth,
    imageHeight: siz.imageHeight,
    tileWidth: siz.tileWidth,
    tileHeight: siz.tileHeight,
    tilesPerRow,
    tilesPerCol,
    totalTiles: tilesPerRow * tilesPerCol,
    numComponents: siz.numComponents,
  };
}

export function validateWindow(
  grid: TileGrid, x: number, y: number, width: number, height: number,
): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) ||
      !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new WindowError('window coordinates must be integers');
  }
  if (width <= 0 || height <= 0) {
    throw new WindowError(`window must be positive: width=${width}, height=${height}`);
  }
  if (x < 0 || y < 0) {
    throw new WindowError(`window origin must be non-negative: x=${x}, y=${y}`);
  }
  if (x + width > grid.imageWidth || y + height > grid.imageHeight) {
    throw new WindowError(
      `window exceeds image ${grid.imageWidth}×${grid.imageHeight}: ` +
      `x=${x}, y=${y}, width=${width}, height=${height}`,
    );
  }
}

/**
 * Tile indices the window intersects, row-major (top-to-bottom, left-to-right).
 * Returned indices are non-decreasing.
 */
export function windowTileIndices(
  grid: TileGrid, x: number, y: number, width: number, height: number,
): number[] {
  const endX = x + width;
  const endY = y + height;
  const tileMinX = Math.floor(x / grid.tileWidth);
  const tileMaxX = Math.floor((endX - 1) / grid.tileWidth);
  const tileMinY = Math.floor(y / grid.tileHeight);
  const tileMaxY = Math.floor((endY - 1) / grid.tileHeight);
  const out: number[] = [];
  for (let ty = tileMinY; ty <= tileMaxY; ty++) {
    for (let tx = tileMinX; tx <= tileMaxX; tx++) {
      out.push(ty * grid.tilesPerRow + tx);
    }
  }
  return out;
}

/**
 * Merge contiguous tile indices into the minimal set of byte ranges —
 * fewer HTTP Range requests. Assumes `tileIndices` ascending (which
 * windowTileIndices guarantees).
 */
export function groupedTilePartRanges(
  ranges: readonly ByteRange[],
  tileIndices: readonly number[],
): ByteRange[] {
  if (tileIndices.length === 0) {
    throw new WindowError('no tile indices supplied');
  }
  const out: ByteRange[] = [];
  let groupStart = tileIndices[0]!;
  let prev = groupStart;
  for (let i = 1; i < tileIndices.length; i++) {
    const idx = tileIndices[i]!;
    if (idx === prev + 1) {
      prev = idx;
      continue;
    }
    out.push({ start: ranges[groupStart]!.start, end: ranges[prev]!.end });
    groupStart = idx;
    prev = idx;
  }
  out.push({ start: ranges[groupStart]!.start, end: ranges[prev]!.end });
  return out;
}
