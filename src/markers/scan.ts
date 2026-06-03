/**
 * Linear scan for a two-byte marker (`0xFF XX`) in a `Uint8Array`.
 * Returns the byte offset of the first occurrence, or -1 if absent.
 * Used by every marker parser.
 */
export function findMarker(data: Uint8Array, a: number, b: number): number {
  for (let i = 0; i + 1 < data.byteLength; i++) {
    if (data[i] === a && data[i + 1] === b) return i;
  }
  return -1;
}
