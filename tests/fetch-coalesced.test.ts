import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROUP_PROBE_BYTES,
  DEFAULT_MAX_COALESCE_GAP,
  fetchTilePartGroupCoalesced,
  groupContiguousTileParts,
} from "../src/fetch-coalesced.js";
import { truncateToPackets } from "../src/markers/plt.js";
import type { ByteRange } from "../src/markers/tlm.js";
import type { RangeFetcher } from "../src/pipeline.js";

// ── Synthetic tile-part fixture (reuse the shape from fetch-trimmed tests) ──
//
// Each tile-part is 31 bytes with 3 packets of length {2, 3, 4}.
function synthTilePart(): Uint8Array {
  return Uint8Array.from([
    // SOT: FF 90, Lsot=000A, Isot=0000, Psot=0000001F (31), TPsot=00, TNsot=01
    0xff, 0x90, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f, 0x00, 0x01,
    // PLT: FF 58, Lplt=0006, Zplt=00, Iplt=[2,3,4]
    0xff, 0x58, 0x00, 0x06, 0x00, 0x02, 0x03, 0x04,
    // SOD
    0xff, 0x93,
    // Payload: 2 + 3 + 4 = 9 bytes
    0x10, 0x11, 0x20, 0x21, 0x22, 0x30, 0x31, 0x32, 0x33,
  ]);
}

const TP_BYTES = 31;

interface FetchCall {
  start: number;
  end: number;
}

function makeRecordingFetcher(fileBytes: Uint8Array): {
  fetcher: RangeFetcher;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetcher: RangeFetcher = {
    async fetchRange(start, end) {
      calls.push({ start, end });
      return fileBytes.slice(start, end);
    },
  };
  return { fetcher, calls };
}

/**
 * Build a synthetic "file" containing N tile-parts at the given offsets.
 * `offsets[i]` is the byte position of tile-part i's start. The file is
 * padded with 0x00 between tile-parts; total file size includes a trailing
 * 100 bytes of pad.
 */
function makeFile(offsets: number[]): {
  file: Uint8Array;
  ranges: ByteRange[];
} {
  const tp = synthTilePart();
  const last = offsets[offsets.length - 1]!;
  const totalSize = last + tp.length + 100;
  const file = new Uint8Array(totalSize);
  const ranges: ByteRange[] = [];
  for (const off of offsets) {
    file.set(tp, off);
    ranges.push({ start: off, end: off + tp.length });
  }
  return { file, ranges };
}

// ── groupContiguousTileParts ─────────────────────────────────────

describe("groupContiguousTileParts", () => {
  it("returns [] on empty input", () => {
    expect(groupContiguousTileParts([])).toEqual([]);
  });

  it("returns a single group for one range", () => {
    const out = groupContiguousTileParts([{ start: 100, end: 200 }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.start).toBe(100);
    expect(out[0]!.end).toBe(200);
    expect(out[0]!.tileParts).toHaveLength(1);
  });

  it("coalesces byte-adjacent ranges into one group", () => {
    const out = groupContiguousTileParts([
      { start: 100, end: 200 },
      { start: 200, end: 300 },
      { start: 300, end: 400 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.start).toBe(100);
    expect(out[0]!.end).toBe(400);
    expect(out[0]!.tileParts).toHaveLength(3);
  });

  it("coalesces ranges with a small gap (≤ maxGap)", () => {
    const out = groupContiguousTileParts(
      [
        { start: 100, end: 200 },
        { start: 250, end: 350 }, // gap of 50
      ],
      100, // maxGap = 100
    );
    expect(out).toHaveLength(1);
  });

  it("splits ranges with a large gap (> maxGap)", () => {
    const out = groupContiguousTileParts(
      [
        { start: 100, end: 200 },
        { start: 400, end: 500 }, // gap of 200
      ],
      100, // maxGap = 100
    );
    expect(out).toHaveLength(2);
  });

  it("sorts unsorted input by start offset", () => {
    const out = groupContiguousTileParts([
      { start: 400, end: 500 },
      { start: 100, end: 200 },
      { start: 200, end: 300 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.tileParts.map((tp) => tp.start)).toEqual([100, 200, 400]);
  });

  it("uses default maxGap when not provided", () => {
    const out = groupContiguousTileParts([
      { start: 100, end: 200 },
      {
        start: 200 + DEFAULT_MAX_COALESCE_GAP,
        end: 300 + DEFAULT_MAX_COALESCE_GAP,
      },
    ]);
    expect(out).toHaveLength(1); // exactly at the boundary still coalesces
  });
});

// ── fetchTilePartGroupCoalesced ──────────────────────────────────

describe("fetchTilePartGroupCoalesced", () => {
  it("Fast path A: keepPackets >= totalPackets uses one full fetch", async () => {
    // Three byte-adjacent tile-parts at offsets 0, 31, 62.
    const { file, ranges } = makeFile([0, 31, 62]);
    const group = { start: 0, end: 31 * 3, tileParts: ranges };
    const { fetcher, calls } = makeRecordingFetcher(file);
    const out = await fetchTilePartGroupCoalesced(fetcher, {
      group,
      keepPackets: group.tileParts.map(() => 3),
      totalPackets: group.tileParts.map(() => 3),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ start: 0, end: 31 * 3 });
    expect(out).toHaveLength(3);
    // Each tile-part returned is the full 31 bytes.
    for (const tp of out) expect(tp.byteLength).toBe(TP_BYTES);
  });

  it("Fast path B: group fits within probe → one fetch + per-tile-part truncate", async () => {
    const { file, ranges } = makeFile([0, 31, 62]);
    const group = { start: 0, end: 31 * 3, tileParts: ranges };
    const { fetcher, calls } = makeRecordingFetcher(file);
    const out = await fetchTilePartGroupCoalesced(fetcher, {
      group,
      keepPackets: group.tileParts.map(() => 2),
      totalPackets: group.tileParts.map(() => 3),
      probeBytes: 200, // larger than the 93-byte group
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ start: 0, end: 31 * 3 });
    // Per-tile-part output is byte-equivalent to truncateToPackets(full, 2).
    const expected = truncateToPackets(synthTilePart(), 2);
    expect(out).toHaveLength(3);
    for (const tp of out) expect(Array.from(tp)).toEqual(Array.from(expected));
  });

  it("Probe + corrective: under-sized probe triggers one additional fetch", async () => {
    // Three byte-adjacent tile-parts at offsets 0, 31, 62. With keepPackets=2
    // we need bytes through offset 27 within each tile-part (SOD at 20 + 2 +
    // 5 payload bytes). So the last needed offset is 62 + 27 = 89. A probe of
    // 50 bytes covers only the first ~1.6 tile-parts → forces a corrective
    // fetch to bytes 89.
    const { file, ranges } = makeFile([0, 31, 62]);
    const group = { start: 0, end: 31 * 3, tileParts: ranges };
    const { fetcher, calls } = makeRecordingFetcher(file);
    // PLT lengths for tile-part 2 won't be visible in a 50-byte probe (its
    // PLT is at offsets 75-82 in the slab). So this case actually falls back
    // to per-tile-part — the fallback test below covers that. Use a larger
    // probe that DOES see all three tile-parts' headers (header runs
    // 0-21, 31-52, 62-83) but doesn't cover bytes through 89.
    const out = await fetchTilePartGroupCoalesced(fetcher, {
      group,
      keepPackets: group.tileParts.map(() => 2),
      totalPackets: group.tileParts.map(() => 3),
      probeBytes: 84, // covers all three PLTs but not all needed payload
    });
    // 1 probe + 1 corrective.
    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual({ start: 0, end: 84 });
    expect(calls[1]!.start).toBe(84);
    expect(calls[1]!.end).toBe(89); // 62 + 27 = last needed byte
    const expected = truncateToPackets(synthTilePart(), 2);
    expect(out).toHaveLength(3);
    for (const tp of out) expect(Array.from(tp)).toEqual(Array.from(expected));
  });

  it("Fallback: under-sized probe (no PLT visible) → per-tile-part fetches", async () => {
    const { file, ranges } = makeFile([0, 31, 62]);
    const group = { start: 0, end: 31 * 3, tileParts: ranges };
    const { fetcher, calls } = makeRecordingFetcher(file);
    // Probe of 22 bytes: covers tile-part 0's PLT + SOD but tile-parts 1
    // and 2's headers are past the probe → falls back to per-tile-part.
    const out = await fetchTilePartGroupCoalesced(fetcher, {
      group,
      keepPackets: group.tileParts.map(() => 2),
      totalPackets: group.tileParts.map(() => 3),
      probeBytes: 22,
    });
    // Probe + 3 per-tile-part fetches (each does its own full-tile-part
    // fetch since each tile-part is smaller than the per-tile-part default
    // probe size).
    expect(calls.length).toBeGreaterThanOrEqual(4);
    // Output is still byte-equivalent.
    const expected = truncateToPackets(synthTilePart(), 2);
    expect(out).toHaveLength(3);
    for (const tp of out) expect(Array.from(tp)).toEqual(Array.from(expected));
  });

  it("Single-tile-part group degrades to one fetch (Fast path A / B)", async () => {
    const { file, ranges } = makeFile([0]);
    const group = { start: 0, end: 31, tileParts: ranges };
    const { fetcher, calls } = makeRecordingFetcher(file);
    const out = await fetchTilePartGroupCoalesced(fetcher, {
      group,
      keepPackets: group.tileParts.map(() => 1),
      totalPackets: group.tileParts.map(() => 3),
      probeBytes: 200,
    });
    expect(calls).toHaveLength(1);
    expect(out).toHaveLength(1);
    expect(Array.from(out[0]!)).toEqual(
      Array.from(truncateToPackets(synthTilePart(), 1)),
    );
  });

  it("uses DEFAULT_GROUP_PROBE_BYTES when probeBytes is not provided", async () => {
    // Sanity: the constant is exported and used by the pipeline.
    expect(DEFAULT_GROUP_PROBE_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_GROUP_PROBE_BYTES).toBeGreaterThan(31 * 3);
    // With the default probe size, the entire group fits → fast path B.
    const { file, ranges } = makeFile([0, 31, 62]);
    const group = { start: 0, end: 31 * 3, tileParts: ranges };
    const { fetcher, calls } = makeRecordingFetcher(file);
    const out = await fetchTilePartGroupCoalesced(fetcher, {
      group,
      keepPackets: group.tileParts.map(() => 1),
      totalPackets: group.tileParts.map(() => 3),
    });
    expect(calls).toHaveLength(1);
    expect(out).toHaveLength(3);
  });
});
