import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadDecoder } from '../src/decoder/decoder.js';

const TCI = 'tests/fixtures/sample_TCI_10m.jp2';
const B04 = 'tests/fixtures/sample_B04_60m.jp2';

describe.runIf(existsSync(TCI))('Decoder (TCI 10m uint8 RGB)', () => {
  it('decodes the full image at cp_reduce=4 as Uint8Array', async () => {
    const decoder = await loadDecoder();
    const data = readFileSync(TCI);
    const r = decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
      reduceLevel: 4,
    });
    expect(r.width).toBe(687);
    expect(r.height).toBe(687);
    expect(r.numComponents).toBe(3);
    expect(r.bitsPerSample).toBe(8);
    expect(r.pixels).toBeInstanceOf(Uint8Array);
    expect(r.pixels.byteLength).toBe(687 * 687 * 3);
    expect(r.reduceLevel).toBe(4);
  });

  it('decodes a 2048×2048 window at cp_reduce=3 → 256×256 uint8 RGB', async () => {
    const decoder = await loadDecoder();
    const data = readFileSync(TCI);
    const r = decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
      reduceLevel: 3,
      decodeArea: { x0: 4466, y0: 4466, x1: 6514, y1: 6514 },
    });
    expect(r.width).toBe(256);
    expect(r.height).toBe(256);
    expect(r.numComponents).toBe(3);
    expect(r.bitsPerSample).toBe(8);
    expect(r.pixels).toBeInstanceOf(Uint8Array);
    expect(r.reduceLevel).toBe(3);
  });
});

describe.runIf(existsSync(B04))('Decoder (B04 60m single-band uint16)', () => {
  it('decodes the full image as a single-component Uint16Array', async () => {
    const decoder = await loadDecoder();
    const data = readFileSync(B04);
    const r = decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
      reduceLevel: 0,
    });
    expect(r.width).toBe(1830);
    expect(r.height).toBe(1830);
    expect(r.numComponents).toBe(1);
    expect(r.bitsPerSample).toBeGreaterThan(8);
    expect(r.pixels).toBeInstanceOf(Uint16Array);
    expect(r.pixels.length).toBe(1830 * 1830);
    expect(r.reduceLevel).toBe(0);
  });
});

describe('Decoder error surfacing', () => {
  it('throws rather than returning a degenerate result', async () => {
    const decoder = await loadDecoder();
    expect(() =>
      decoder.decode(new Uint8Array([0, 0, 0, 0]), { reduceLevel: 0 }),
    ).toThrow(/decode/i);
  });
});

describe.runIf(existsSync(B04))('Decoder reduce clamping', () => {
  it('clamps an over-large reduce factor instead of failing', async () => {
    const decoder = await loadDecoder();
    const data = readFileSync(B04);
    const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    // 99 is far beyond any S2 asset's resolution-level count. Without clamping
    // OpenJPEG hard-errors; with clamping it falls back to the coarsest overview.
    const r = decoder.decode(u8, { reduceLevel: 99 });
    expect(r.reduceLevel).toBeLessThan(99);
    expect(r.reduceLevel).toBeGreaterThanOrEqual(0);
    expect(r.width).toBeGreaterThan(0);
    expect(r.width).toBeLessThan(1830); // coarser than full 60 m resolution
    expect(r.pixels.length).toBe(r.width * r.height * r.numComponents);
  });
});

describe.runIf(existsSync(TCI))('Decoder tolerant mode (truncated codestream)', () => {
  it('decodes a truncated stream that strict mode rejects', async () => {
    const decoder = await loadDecoder();
    const data = readFileSync(TCI);
    const full = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    // Find a truncation point that strict mode rejects (header stays intact at
    // these fractions of a ~131 MB file, so the failure is missing tail packets).
    let truncated: Uint8Array | null = null;
    for (const frac of [0.3, 0.5, 0.7, 0.9]) {
      const cut = full.subarray(0, Math.floor(full.length * frac));
      let strictThrew = false;
      try {
        decoder.decode(cut, { reduceLevel: 4, tolerant: false });
      } catch {
        strictThrew = true;
      }
      if (strictThrew) {
        truncated = cut;
        break;
      }
    }
    expect(truncated, 'expected a truncation strict mode rejects').not.toBeNull();

    // Tolerant mode decodes the same bytes without throwing; dimensions come
    // from the (intact) header, so they are unchanged by the missing tail.
    const r = decoder.decode(truncated!, { reduceLevel: 4, tolerant: true });
    expect(r.width).toBe(687);
    expect(r.height).toBe(687);
    expect(r.numComponents).toBe(3);
    expect(r.bitsPerSample).toBe(8);
    expect(r.pixels.byteLength).toBe(687 * 687 * 3);
  });
});
