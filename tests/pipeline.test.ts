import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchAndDecodeWindow, fetchWindowCodestream } from '../src/pipeline.js';
import type { RangeFetcher } from '../src/pipeline.js';
import type { AssetDescriptor } from '../src/inspect.js';

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

// ── fetchWindowCodestream — synthetic fixture ─────────────────────────────────
//
// Build a minimal fake descriptor (same pattern as planner.test.ts mkDesc)
// and a fake fetcher that returns a synthetic tile-part payload (a minimal
// valid SOT+SOD block so stitchPartialCodestream produces a non-empty result).
//
// A minimal valid JP2 main header for the descriptor's `header` field needs
// SOC (FF 4F) followed by at least one marker segment with a valid Lseg, and
// then a SOT marker (FF 90 00 0A) — this is what stitchPartialCodestream
// uses to slice out the main-header prefix and strip TLM segments.
//
// The fake tile-part payload is a tiny SOT+SOD block (no PLT, Psot=0 meaning
// unknown length). fetchTilePartTrimmed will issue one fetch covering the full
// range (keepPackets equals totalPackets when they are equal, so no trimming).
//

// Minimal JP2 main-header bytes: JP2 signature + SOC + SIZ stub + SOT
// We only need the SOC…SOT prefix for stitchPartialCodestream.
// Structure: SOC(2) + SIZ marker with Lsiz=0x005e (94) min stub(96) + SOT(4)
// Simpler: SOC(2) + a short COM marker + SOT(4)
// COM: FF 64, Lcom=0x0005 (5), Rcom=0x0000, "x" = 3 bytes payload → total 7 bytes
const FAKE_HEADER = Uint8Array.from([
  // SOC
  0xff, 0x4f,
  // COM: FF 64, Lcom=0x0005, Rcom=0x00 0x00, data=0x78 ('x')
  0xff, 0x64, 0x00, 0x05, 0x00, 0x00, 0x78,
  // SOT: FF 90 00 0A (Lsot=10, Isot=0, Psot=0, TPsot=0, TNsot=0)
  0xff, 0x90, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

// Synthetic tile-part returned by the fake fetcher.
// Needs a PLT segment so fetchTilePartTrimmed's truncateToPackets path works.
// keepPackets=3 at overviewLevel=2 (cumulativePackets[2]=3 from packetTable).
// totalPackets=16 (cumulativePackets[4]), so keepPackets < totalPackets and
// the PLT-trimmed path is taken. We declare 16 packets all of length 1 in
// the PLT so the 3-packet trim succeeds.
//
// Structure (bytes):
//   0..11   SOT: FF 90, Lsot=000A, Isot=0000, Psot=TBD, TPsot=00, TNsot=01
//   12..31  PLT: FF 58, Lplt=0012 (18), Zplt=00, Iplt=[1]*16
//   32..33  SOD: FF 93
//   34..49  payload: 16 bytes (one per packet)
// Total = 50 bytes → Psot = 0x00000032 (50)
const FAKE_TILE_PART = Uint8Array.from([
  // SOT: FF 90, Lsot=000A, Isot=0000, Psot=0x00000033 (51), TPsot=00, TNsot=01
  0xff, 0x90, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x33, 0x00, 0x01,
  // PLT: FF 58, Lplt=0x0012 (18 = 2 header + 1 Zplt + 15 Iplt lengths... wait)
  // Lplt = 2 (fixed) + 1 (Zplt) + 16 (packet lengths) = 19, but Lplt itself
  // is 2 bytes so total segment = 2 (marker) + 19 (Lplt value) = 21 bytes.
  // Actually Lplt is the length of the rest of the PLT marker segment
  // (excluding the FF 58 marker itself but INCLUDING the Lplt field):
  // Lplt = 2 (Lplt itself) + 1 (Zplt) + 16 (Iplt values) = 19 = 0x0013
  0xff, 0x58, 0x00, 0x13, 0x00,  // marker, Lplt=0x0013, Zplt=0x00
  0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, // 8 packet lengths of 1
  0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, // 8 more → 16 total
  // SOD: FF 93
  0xff, 0x93,
  // payload: 16 bytes (one byte per packet)
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
]);

const TILE_START = 1000;
// TILE_END computed at runtime from FAKE_TILE_PART.byteLength so it stays
// correct if the fixture is ever resized.
const TILE_END = TILE_START + FAKE_TILE_PART.byteLength;

function makeFakeDescriptor(): AssetDescriptor {
  const tile = 1024;
  return {
    siz: { imageWidth: tile, imageHeight: tile, tileWidth: tile, tileHeight: tile, numComponents: 1 },
    cod: {} as never,
    numDecompLevels: 4,
    numResolutions: 5,
    packetTable: {
      packetsPerResolution: [1, 1, 1, 4, 9],
      cumulativePackets: [1, 2, 3, 7, 16],
    },
    tileGrid: {
      imageWidth: tile, imageHeight: tile, tileWidth: tile, tileHeight: tile,
      tilesPerRow: 1, tilesPerCol: 1, totalTiles: 1, numComponents: 1,
    },
    tileRanges: [{ start: TILE_START, end: TILE_END }],
    header: FAKE_HEADER,
  } as unknown as AssetDescriptor;
}

function makeFakeFetcher(): RangeFetcher {
  // A big virtual "file": header at 0, tile-part at TILE_START
  const file = new Uint8Array(TILE_END + 100);
  file.set(FAKE_HEADER, 0);
  file.set(FAKE_TILE_PART, TILE_START);
  return {
    async fetchRange(start: number, end: number): Promise<Uint8Array> {
      return file.slice(start, end);
    },
  };
}

describe('fetchWindowCodestream (synthetic fixture, no WASM decoder)', () => {
  it('assembles a codestream without decoding', async () => {
    const fakeFetcher = makeFakeFetcher();
    const testDescriptor = makeFakeDescriptor();

    const result = await fetchWindowCodestream(fakeFetcher, {
      window: { x: 0, y: 0, width: 16, height: 16 },
      overviewLevel: 2,
      descriptor: testDescriptor,
    });

    expect(result.codestream).toBeInstanceOf(Uint8Array);
    expect(result.codestream.byteLength).toBeGreaterThan(0);
    expect(result.reduceLevel).toBe(2);
    expect(result.decodeArea).toEqual({ x0: 0, y0: 0, x1: 16, y1: 16 });
  });
});
