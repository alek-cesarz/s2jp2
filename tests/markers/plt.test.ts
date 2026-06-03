import { describe, expect, it } from 'vitest';
import {
  decodePacketLengths, extractPacketLengths, payloadSize, sodOffset, truncateToPackets,
} from '../../src/markers/plt.js';
import { ParseError } from '../../src/errors.js';

function syntheticTilePart(): Uint8Array {
  return Uint8Array.from([
    // SOT: FF 90, Lsot=000A, Isot=0000, Psot=0000001F (31), TPsot=00, TNsot=01
    0xFF, 0x90, 0x00, 0x0A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F, 0x00, 0x01,
    // PLT: FF 58, Lplt=0006, Zplt=00, Iplt=[2,3,4]
    0xFF, 0x58, 0x00, 0x06, 0x00, 0x02, 0x03, 0x04,
    // SOD
    0xFF, 0x93,
    // Payload: 2 + 3 + 4 = 9 bytes
    0x10, 0x11, 0x20, 0x21, 0x22, 0x30, 0x31, 0x32, 0x33,
  ]);
}

describe('decodePacketLengths', () => {
  it('reads single-byte lengths', () => {
    expect(decodePacketLengths(new Uint8Array([0x01, 0x7F, 0x00]))).toEqual([1, 127, 0]);
  });
  it('reads multi-byte continuations', () => {
    expect(decodePacketLengths(new Uint8Array([0x81, 0x00, 0x82, 0x2C]))).toEqual([128, 300]);
  });
  it('throws on truncated continuation', () => {
    expect(() => decodePacketLengths(new Uint8Array([0x81]))).toThrow(ParseError);
  });
});

describe('sodOffset / extractPacketLengths / payloadSize', () => {
  const tp = syntheticTilePart();
  it('finds SOD', () => { expect(sodOffset(tp)).toBe(20); });
  it('extracts packet lengths', () => {
    expect(extractPacketLengths(tp)).toEqual([2, 3, 4]);
  });
  it('reports payload size', () => {
    expect(payloadSize(tp)).toBe(9);
  });
  it('throws when PLT missing', () => {
    const noPlt = Uint8Array.from([
      0xFF, 0x90, 0x00, 0x0A, 0, 0, 0, 0, 0, 0x16, 0, 1,
      0xFF, 0x93, 1, 2, 3, 4,
    ]);
    expect(() => extractPacketLengths(noPlt)).toThrow(ParseError);
  });
});

describe('truncateToPackets', () => {
  it('keeps first 2 packets, patches Psot', () => {
    const tp = syntheticTilePart();
    const out = truncateToPackets(tp, 2);
    expect(out.byteLength).toBe(27);
    // Psot at bytes [6..10] BE should equal 27
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(view.getUint32(6, false)).toBe(27);
  });
  it('keeps zero packets', () => {
    const out = truncateToPackets(syntheticTilePart(), 0);
    expect(out.byteLength).toBe(22);
  });
  it('all packets → byte-identical to input', () => {
    const tp = syntheticTilePart();
    const out = truncateToPackets(tp, 3);
    expect(Array.from(out)).toEqual(Array.from(tp));
  });
  it('rejects keep > packetCount', () => {
    expect(() => truncateToPackets(syntheticTilePart(), 4)).toThrow(ParseError);
  });
  it('rejects missing SOT', () => {
    const broken = syntheticTilePart();
    broken[0] = 0x00;
    expect(() => truncateToPackets(broken, 1)).toThrow(ParseError);
  });
});
