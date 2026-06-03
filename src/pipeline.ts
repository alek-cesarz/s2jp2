import { loadDecoder } from './decoder/decoder.js';
import type { DecodeResult, Decoder } from './decoder/decoder.js';
import { inspectAsset } from './inspect.js';
import type { AssetDescriptor } from './inspect.js';
import { stitchPartialCodestream } from './markers/codestream.js';
import { truncateToPackets } from './markers/plt.js';
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
}

const DEFAULT_HEADER_PROBE = 100 * 1024;

/**
 * Fetch + decode a window of a JP2 asset. Returns a `DecodeResult` whose
 * `pixels` is `Uint8Array` for 8-bit assets (TCI / SCL / CLD / SNW) and
 * `Uint16Array` for 16-bit assets (reflectance bands / AOT / WVP).
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

  // Fetch each intersecting tile-part in full, then truncate to keepPackets.
  // (Smarter: probe + remainder like s2surgeon — a later optimisation.)
  const payloads: Uint8Array[] = await Promise.all(
    plan.tileRanges.map(async (range) => {
      const full = await fetcher.fetchRange(range.start, range.end);
      return plan.keepPackets >= plan.totalPackets
        ? full
        : truncateToPackets(full, plan.keepPackets);
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
