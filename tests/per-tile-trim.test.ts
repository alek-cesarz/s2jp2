import { readFileSync, existsSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { loadDecoder } from "../src/decoder/decoder.js";
import { inspectAsset } from "../src/inspect.js";
import { fetchAndDecodeWindow } from "../src/pipeline.js";
import { tilePartRangesFromHeader } from "../src/markers/tlm.js";
import { extractPacketLengths } from "../src/markers/plt.js";
import { packetsPerResolutionForTile } from "../src/profile.js";

const B04 = "tests/fixtures/sample_B04_60m.jp2";

/**
 * Regression for the per-tile PLT-trim bug: JPEG 2000 precinct partitions are
 * anchored to the image origin, so tiles straddle the precinct grid differently
 * and have different per-resolution packet counts. The old code trimmed every
 * tile-part with a SINGLE global keepPackets derived from the origin tile, which
 * cut the non-origin (and partial-edge) tiles mid-resolution — decoding correct
 * VALUES into the WRONG positions (≈34 % of pixels at reduce 1 on this fixture).
 */
describe.runIf(existsSync(B04))(
  "per-tile PLT trim (canvas-anchored precincts)",
  () => {
    it("packetsPerResolutionForTile reproduces every tile-part’s real packet count", () => {
      const buf = new Uint8Array(readFileSync(B04));
      const header = buf.subarray(0, 200 * 1024);
      const desc = inspectAsset(header);
      const ranges = tilePartRangesFromHeader(header);
      const empirical = ranges.map(
        (r) => extractPacketLengths(buf.subarray(r.start, r.end)).length,
      );
      const model = ranges.map((_r, idx) =>
        packetsPerResolutionForTile(desc.tilePacketGeometry, idx).reduce(
          (a, b) => a + b,
          0,
        ),
      );
      expect(model).toEqual(empirical);
      // Sanity: the counts genuinely vary per tile (otherwise this wouldn't bite).
      expect(new Set(empirical).size).toBeGreaterThan(1);
    });

    it("window decode equals the full WASM decode at every reduce level", async () => {
      const buf = new Uint8Array(readFileSync(B04));
      const desc = inspectAsset(buf.subarray(0, 200 * 1024));
      const decoder = await loadDecoder();
      const W = desc.siz.imageWidth;
      const H = desc.siz.imageHeight;
      const fetcher = {
        fetchRange: async (s: number, e: number) => buf.subarray(s, e),
      };
      for (const reduce of [0, 1, 2, 3, 4]) {
        const full = decoder.decode(buf, { reduceLevel: reduce });
        const win = await fetchAndDecodeWindow(fetcher, {
          window: { x: 0, y: 0, width: W, height: H },
          overviewLevel: reduce,
          descriptor: desc,
          decoder,
        });
        let differing = 0;
        for (let i = 0; i < full.pixels.length; i++) {
          if (full.pixels[i] !== win.pixels[i]) differing += 1;
        }
        // Byte-exact: the trimmed window codestream must decode identically to the
        // untrimmed full-file decode (was ~34 % differing at reduce 1 pre-fix).
        expect(differing).toBe(0);
      }
    }, 60000);
  },
);
