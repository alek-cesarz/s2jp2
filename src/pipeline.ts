import { loadDecoder } from './decoder/decoder.js';
import type { DecodeResult, Decoder } from './decoder/decoder.js';
import {
  fetchTilePartGroupCoalesced,
  groupContiguousTileParts,
  DEFAULT_GROUP_PROBE_BYTES,
  DEFAULT_MAX_COALESCE_GAP,
} from './fetch-coalesced.js';
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
   *
   * Only used when coalescing is disabled (`groupProbeBytes: 0`) or when
   * the coalesced path falls back to the per-tile-part path.
   */
  tilePartProbeBytes?: number;
  /**
   * Per-group probe size for coalesced fetching. Default 64 KB. Pass `0`
   * to disable coalescing entirely (one fetch per tile-part). Bigger
   * values capture more tile-parts in one slab at the cost of a larger
   * over-fetch when overview level is high.
   */
  groupProbeBytes?: number;
  /**
   * Tile-parts whose byte gap is ≤ this value are grouped into one
   * coalesced fetch. Default 64 KB.
   */
  maxCoalesceGap?: number;
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

  const groupProbe = options.groupProbeBytes ?? DEFAULT_GROUP_PROBE_BYTES;
  const maxGap = options.maxCoalesceGap ?? DEFAULT_MAX_COALESCE_GAP;

  let payloads: Uint8Array[];
  if (groupProbe === 0) {
    // Coalescing disabled — fall back to per-tile-part PLT-trimmed fetches.
    payloads = await Promise.all(
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
  } else {
    // Coalesce contiguous tile-parts and issue one probe (+ optional
    // corrective) per group. S2 tile-parts are stored in raster order so the
    // tile-parts intersecting an OL viewport tile usually form one or two
    // groups — much fewer HTTP requests than per-tile-part fetching.
    const groups = groupContiguousTileParts(plan.tileRanges, maxGap);
    const groupedPayloads = await Promise.all(
      groups.map((group) =>
        fetchTilePartGroupCoalesced(fetcher, {
          group,
          keepPackets: plan.keepPackets,
          totalPackets: plan.totalPackets,
          probeBytes: groupProbe,
        }),
      ),
    );
    // Reorder back to plan.tileRanges order (groupContiguousTileParts sorts
    // by start which is also the file order, but the planner may have its
    // own order tied to the window — index by tile-part identity).
    const byRange = new Map<string, Uint8Array>();
    let g = 0;
    for (const group of groups) {
      const payloads = groupedPayloads[g++]!;
      for (let i = 0; i < group.tileParts.length; i++) {
        const tp = group.tileParts[i]!;
        byRange.set(`${tp.start}:${tp.end}`, payloads[i]!);
      }
    }
    payloads = plan.tileRanges.map((r) => {
      const v = byRange.get(`${r.start}:${r.end}`);
      if (!v) throw new Error('coalesced: tile-part missing from grouped payloads');
      return v;
    });
  }

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
