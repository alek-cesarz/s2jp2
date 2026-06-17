interface StexJp2Module {
  decode(
    encoded: Uint8Array,
    reduceLevel: number,
    useArea: boolean,
    x0: number, y0: number, x1: number, y1: number,
    tolerant: boolean,
  ): StexJp2DecodeResult;
}
interface StexJp2DecodeResult {
  ok(): boolean;
  error(): string;
  width(): number;
  height(): number;
  numComponents(): number;
  bitsPerSample(): number;
  pixels(): Uint8Array | Uint16Array;
}

export interface DecodeArea {
  x0: number; y0: number; x1: number; y1: number;
}
export interface DecodeOptions {
  reduceLevel?: number;
  decodeArea?: DecodeArea;
  /** Decode truncated / PLT-trimmed codestreams instead of failing when
   *  trailing packets are missing. Defaults to true (the streaming use case). */
  tolerant?: boolean;
}
export interface DecodeResult {
  pixels: Uint8Array | Uint16Array;
  width: number;
  height: number;
  numComponents: number;
  bitsPerSample: number;
}

export class Decoder {
  private constructor(private readonly module: StexJp2Module) {}

  static async load(): Promise<Decoder> {
    const factory = (await import('./stex-jp2.mjs')) as unknown as {
      default: () => Promise<StexJp2Module>;
    };
    const module = await factory.default();
    return new Decoder(module);
  }

  decode(encoded: Uint8Array, options: DecodeOptions = {}): DecodeResult {
    const reduce = options.reduceLevel ?? 0;
    const tolerant = options.tolerant ?? true;
    const area = options.decodeArea;
    const result = this.module.decode(
      encoded,
      reduce,
      area !== undefined,
      area?.x0 ?? 0, area?.y0 ?? 0, area?.x1 ?? 0, area?.y1 ?? 0,
      tolerant,
    );
    if (!result.ok()) {
      throw new Error(`JP2 decode failed: ${result.error() || 'unknown error'}`);
    }
    const view = result.pixels();
    const pixels = view instanceof Uint16Array
      ? new Uint16Array(view)
      : new Uint8Array(view);
    return {
      pixels,
      width: result.width(),
      height: result.height(),
      numComponents: result.numComponents(),
      bitsPerSample: result.bitsPerSample(),
    };
  }
}

export async function loadDecoder(): Promise<Decoder> {
  return Decoder.load();
}
