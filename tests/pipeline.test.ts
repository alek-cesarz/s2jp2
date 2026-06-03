import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchAndDecodeWindow } from '../src/pipeline.js';

const TCI = 'tests/fixtures/sample_TCI_10m.jp2';
const B04 = 'tests/fixtures/sample_B04_60m.jp2';

/** A toy file-backed RangeFetcher for the test. */
function fileFetcher(path: string) {
  const fd = openSync(path, 'r');
  return {
    async fetchRange(start: number, end: number): Promise<Uint8Array> {
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    close() { closeSync(fd); },
  };
}

describe.runIf(existsSync(TCI))('fetchAndDecodeWindow (TCI 10m, uint8 RGB)', () => {
  it('decodes a 1024×1024 window at overview 3 → 128×128 uint8 RGB', async () => {
    const fetcher = fileFetcher(TCI);
    try {
      const result = await fetchAndDecodeWindow(fetcher, {
        window: { x: 4096, y: 4096, width: 1024, height: 1024 },
        overviewLevel: 3,
      });
      expect(result.width).toBe(128);
      expect(result.height).toBe(128);
      expect(result.numComponents).toBe(3);
      expect(result.bitsPerSample).toBe(8);
      expect(result.pixels).toBeInstanceOf(Uint8Array);
      let nz = 0;
      for (let i = 0; i < result.pixels.length; i += 100) if (result.pixels[i] !== 0) nz++;
      expect(nz).toBeGreaterThan(0);
    } finally {
      fetcher.close();
    }
  });
});

describe.runIf(existsSync(B04))('fetchAndDecodeWindow (B04 60m, uint16 single-band)', () => {
  it('decodes a 512×512 window at overview 1 → 256×256 uint16 single-band', async () => {
    const fetcher = fileFetcher(B04);
    try {
      const result = await fetchAndDecodeWindow(fetcher, {
        window: { x: 256, y: 256, width: 512, height: 512 },
        overviewLevel: 1,
      });
      expect(result.width).toBe(256);
      expect(result.height).toBe(256);
      expect(result.numComponents).toBe(1);
      expect(result.bitsPerSample).toBeGreaterThan(8);
      expect(result.pixels).toBeInstanceOf(Uint16Array);
    } finally {
      fetcher.close();
    }
  });
});
