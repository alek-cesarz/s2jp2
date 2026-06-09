import { loadDecoder } from './decoder/decoder.js';
import type { DecodeResult, Decoder } from './decoder/decoder.js';
import { fetchTilePartTrimmed } from './fetch-trimmed.js';
import { inspectAsset } from './inspect.js';
import type { AssetDescriptor } from './inspect.js';
import { stitchPartialCodestream } from './markers/codestream.js';
import { planWindowFetches } from './planner.js';
import type { Window } from './planner.js';

export interface RangeFetcher {
  fetchRange(start: number, end: number): Promise<Uint8Array>;
}

export interface FetchAndDecodeOptions {
  window: Window;
  overviewLevel: number;
  /** Reuse a previously-built descriptor (avoid re-fetching/parsing the header). */
  descriptor?: AssetDescriptor;
  /** Header probe size used when descriptor is absent. Default 100 KB. */
  headerProbeBytes?: number;
  /** Reusable decoder (the WASM module loads ~200 ms; cache when possible). */
  decoder?: Decoder;
  /**
   * Per-tile-part probe size for PLT-trimmed fetching. Default 4 KB — enough
   * to hold SOT + PLT(s) + SOD for any S2 tile-part. Increase only for
   * codestreams with unusually many packets per tile-part.
   */
  tilePartProbeBytes?: number;
}

const DEFAULT_HEADER_PROBE = 100 * 1024;

/**
 * Fetch + decode a window of a JP2 asset. Returns a `DecodeResult` whose
 * `pixels` is `Uint8Array` for 8-bit assets (TCI / SCL / CLD / SNW) and
 * `Uint16Array` for 16-bit assets (reflectance bands / AOT / WVP).
 *
 * Per-tile-part bytes are PLT-trimmed: at low overview levels we read a
 * small probe of each tile-part to learn the per-packet byte lengths, then
 * fetch only the prefix of bytes corresponding to the packets that decode
 * at the requested `overviewLevel`. At reduce-level 4 with `keepPackets`
 * = 1, this cuts per-tile-part bandwidth from ~MB to ~KB.
 */
export async function fetchAndDecodeWindow(
  fetcher: RangeFetcher,
  options: FetchAndDecodeOptions,
): Promise<DecodeResult> {
  const decoder = options.decoder ?? await loadDecoder();

  const descriptor = options.descriptor ?? await (async () => {
    const header = await fetcher.fetchRange(0, options.headerProbeBytes ?? DEFAULT_HEADER_PROBE);
    return inspectAsset(header);
  })();

  const plan = planWindowFetches(descriptor, options.window, options.overviewLevel);

  // PLT-trimmed per-tile-part fetches. Each call probes + (optionally)
  // fetches the remainder, returning bytes equivalent to truncating a
  // full fetch but sized to what's actually consumed. Falls back to
  // full-tile-part fetching on PLT-parsing edge cases.
  const payloads: Uint8Array[] = await Promise.all(
    plan.tileRanges.map((range) => {
      const opts: Parameters<typeof fetchTilePartTrimmed>[1] = {
        range,
        keepPackets: plan.keepPackets,
        totalPackets: plan.totalPackets,
      };
      if (options.tilePartProbeBytes !== undefined) {
        opts.probeBytes = options.tilePartProbeBytes;
      }
      return fetchTilePartTrimmed(fetcher, opts);
    }),
  );

  const codestream = stitchPartialCodestream(descriptor.header, payloads);
  return decoder.decode(codestream, {
    reduceLevel: options.overviewLevel,
    decodeArea: {
      x0: options.window.x,
      y0: options.window.y,
      x1: options.window.x + options.window.width,
      y1: options.window.y + options.window.height,
    },
  });
}
