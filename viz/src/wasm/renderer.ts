// spores_renderer.wasm (renderer/src/wasm.rs): the same integer-only renderer
// `verify` and the vectors use. No second implementation in JS: this file only
// encodes the input and moves bytes.

/** Image side and RGB byte length (renderer/src/lib.rs `N`). */
export const N = 512;
export const RGB_LEN = N * N * 3;
const U64_MAX = (1n << 64n) - 1n;

/** What an image depends on: seed (64 hex), age in epochs, and `[neighbour, D]` with D on the 1e6 scale. */
export interface RenderInput {
  seed: string;
  age: number;
  edges: [number, number | string | bigint][];
}

/**
 * The byte layout of `Spore::from_bytes` (renderer/src/lib.rs):
 * `seed[32] | age u32 | n u32 | n × (id u32, D u64)`, little-endian, edges by id.
 * D above u64 is clamped, as `verify` does.
 */
export function encodeRenderInput(r: RenderInput): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(r.seed)) throw new Error(`seed is not 32 bytes of hex: ${r.seed}`);
  if (!Number.isInteger(r.age) || r.age < 0 || r.age > 0xffffffff) throw new Error(`bad age: ${r.age}`);
  const edges = r.edges
    .map(([id, d]) => {
      const big = BigInt(d);
      if (!Number.isInteger(id) || id < 0 || id > 0xffffffff || big < 0n) throw new Error(`bad edge: [${id}, ${d}]`);
      return [id, big > U64_MAX ? U64_MAX : big] as const;
    })
    .sort((a, b) => a[0] - b[0]);
  const out = new Uint8Array(40 + 12 * edges.length);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 32; i++) out[i] = parseInt(r.seed.slice(2 * i, 2 * i + 2), 16);
  dv.setUint32(32, r.age, true);
  dv.setUint32(36, edges.length, true);
  edges.forEach(([id, d], i) => {
    dv.setUint32(40 + 12 * i, id, true);
    dv.setBigUint64(44 + 12 * i, d, true);
  });
  return out;
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** 512×512 RGB → RGBA for ImageData. */
export function rgbToRgba(rgb: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(N * N * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    out[j] = rgb[i];
    out[j + 1] = rgb[i + 1];
    out[j + 2] = rgb[i + 2];
    out[j + 3] = 255;
  }
  return out;
}

interface RendererExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  image_len(): number;
  render_into(input: number, len: number, out: number): number;
  hash_image(rgb: number, out: number): void;
}

export class RendererWasm {
  private readonly x: RendererExports;
  private constructor(x: RendererExports) {
    if (x.image_len() !== RGB_LEN) throw new Error(`renderer wasm image_len ${x.image_len()}, expected ${RGB_LEN}`);
    this.x = x;
  }

  static async load(source: BufferSource | WebAssembly.Module): Promise<RendererWasm> {
    const instance =
      source instanceof WebAssembly.Module ? await WebAssembly.instantiate(source, {}) : (await WebAssembly.instantiate(source, {})).instance;
    return new RendererWasm(instance.exports as unknown as RendererExports);
  }

  /** Renders one image; returns its RGB bytes and image hash (hex). */
  render(input: Uint8Array): { rgb: Uint8Array; imageHash: string } {
    const x = this.x;
    const pin = x.alloc(input.length);
    const pout = x.alloc(RGB_LEN);
    const phash = x.alloc(32);
    try {
      new Uint8Array(x.memory.buffer).set(input, pin);
      if (x.render_into(pin, input.length, pout) !== 0) throw new Error('renderer: input did not parse');
      x.hash_image(pout, phash);
      // A fresh view: rendering can grow (and so detach) the memory buffer.
      const mem = new Uint8Array(x.memory.buffer);
      return { rgb: mem.slice(pout, pout + RGB_LEN), imageHash: toHex(mem.slice(phash, phash + 32)) };
    } finally {
      x.dealloc(pin, input.length);
      x.dealloc(pout, RGB_LEN);
      x.dealloc(phash, 32);
    }
  }
}
