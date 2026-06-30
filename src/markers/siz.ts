import { ParseError } from "../errors.js";
import { findMarker } from "./scan.js";

const SIZ_MARKER_0 = 0xff;
const SIZ_MARKER_1 = 0x51;
const SIZ_MIN_BODY_BYTES = 38; // Lsiz minimum (36 fixed + 2 length bytes)

export interface SizInfo {
  imageWidth: number;
  imageHeight: number;
  tileWidth: number;
  tileHeight: number;
  numComponents: number;
  /** Image area offset on the reference grid (XOsiz / YOsiz). */
  imageXOffset: number;
  imageYOffset: number;
  /** Tile grid offset on the reference grid (XTOsiz / YTOsiz). */
  tileXOffset: number;
  tileYOffset: number;
  /** Component-0 sub-sampling (XRsiz / YRsiz). S2 assets are uniform (1,1). */
  subsamplingX: number;
  subsamplingY: number;
}

/**
 * Locate the SIZ marker (FF 51) inside main-header bytes and return image
 * dimensions, tile dimensions, and component count. Throws if absent or
 * truncated.
 *
 * **Precondition:** `data` should be the codestream main header (starting
 * at or near SOC, `FF 4F`), not the raw file with JP2 box wrapping. The
 * scanner walks bytes until it finds `FF 51`; in practice S2 JP2 box
 * payloads do not contain coincidental `FF 51` bytes before the codestream,
 * but adversarial JP2 wrappers could mislead this scanner. Use
 * `firstSotOffset` / `socOffset` from `./codestream.js` to anchor the
 * search if you need stricter robustness.
 */
export function extractSizInfo(data: Uint8Array): SizInfo {
  const pos = findMarker(data, SIZ_MARKER_0, SIZ_MARKER_1);
  if (pos < 0) throw new ParseError("SIZ marker (FF 51) not found");

  const after = pos + 2;
  if (after + SIZ_MIN_BODY_BYTES > data.byteLength) {
    throw new ParseError("SIZ segment truncated: cannot read fixed prefix");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lsiz = view.getUint16(after, false);
  if (lsiz < SIZ_MIN_BODY_BYTES) {
    throw new ParseError(
      `SIZ Lsiz=${lsiz} below minimum ${SIZ_MIN_BODY_BYTES}`,
    );
  }
  if (after + lsiz > data.byteLength) {
    throw new ParseError(
      `SIZ segment claims ${lsiz} bytes but only ${data.byteLength - after} available`,
    );
  }
  const imageWidth = view.getUint32(after + 4, false);
  const imageHeight = view.getUint32(after + 8, false);
  const imageXOffset = view.getUint32(after + 12, false);
  const imageYOffset = view.getUint32(after + 16, false);
  const tileWidth = view.getUint32(after + 20, false);
  const tileHeight = view.getUint32(after + 24, false);
  const tileXOffset = view.getUint32(after + 28, false);
  const tileYOffset = view.getUint32(after + 32, false);
  const numComponents = view.getUint16(after + 36, false);
  // Component-0 sub-sampling: components begin at +38 as (Ssiz, XRsiz, YRsiz).
  const subsamplingX = data[after + 36 + 2 + 1] ?? 1;
  const subsamplingY = data[after + 36 + 2 + 2] ?? 1;

  if (imageWidth === 0 || imageHeight === 0) {
    throw new ParseError(
      `SIZ declares degenerate image dimensions ${imageWidth}x${imageHeight}`,
    );
  }
  if (tileWidth === 0 || tileHeight === 0) {
    throw new ParseError(
      `SIZ declares degenerate tile dimensions ${tileWidth}x${tileHeight}`,
    );
  }
  if (numComponents < 1 || numComponents > 4) {
    throw new ParseError(
      `SIZ declares unsupported Csiz=${numComponents} (expected 1..4)`,
    );
  }
  return {
    imageWidth,
    imageHeight,
    tileWidth,
    tileHeight,
    numComponents,
    imageXOffset,
    imageYOffset,
    tileXOffset,
    tileYOffset,
    subsamplingX: subsamplingX || 1,
    subsamplingY: subsamplingY || 1,
  };
}
