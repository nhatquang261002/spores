// core-wasm (core-wasm/src/lib.rs): spores_core compiled for the browser.
// Epoch replay (fingerprints and tubes from close events) and the per-spore
// state hash; no core math in JS.
import type { RouterConfig } from '../chain/router';

/** One epoch's input, as the `epoch_closed` event carries it. u128 values are decimal strings. */
export interface ReplayEpoch {
  epoch: number;
  prev_fingerprint?: string;
  active: number[];
  flows: [number, number, string | number][];
  rejects: [number, number, number][];
  pool: string;
}

export interface ReplayedEpoch {
  epoch: number;
  /** The replayed previous fingerprint (compare it with the event's). */
  prev_fingerprint: string;
  fingerprint: string;
  /** `[a, b, D]` after the close. */
  tubes: [number, number, string][];
  /** `[id, R]` for every active spore. */
  reputation: [number, string][];
}

export interface StateInput {
  spore_id: number;
  epoch: number;
  seed: string;
  age: number;
  edges: [number, string | number][];
}

/** Router `config` (mapped as `verify` maps it) or a vectors `params` object. */
export type ReplayParams = Pick<RouterConfig, 'decay_bps' | 'gain' | 'k' | 'd_min' | 'fee_bps' | 'breadth_full' | 'reject_bps'> &
  ({ rebate_bps: number } | { pool_rule: { rule: string; rebate_bps?: number } });

interface CoreExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  replay(ptr: number, len: number): number;
  state_hash(ptr: number, len: number): number;
  result_ptr(): number;
  result_len(): number;
}

export class CoreWasm {
  private readonly x: CoreExports;
  private constructor(x: CoreExports) {
    this.x = x;
  }

  static async load(source: BufferSource | WebAssembly.Module): Promise<CoreWasm> {
    const instance =
      source instanceof WebAssembly.Module ? await WebAssembly.instantiate(source, {}) : (await WebAssembly.instantiate(source, {})).instance;
    return new CoreWasm(instance.exports as unknown as CoreExports);
  }

  private call<T>(fn: 'replay' | 'state_hash', value: unknown): T {
    const x = this.x;
    const input = new TextEncoder().encode(JSON.stringify(value));
    const p = x.alloc(input.length);
    let code: number;
    try {
      new Uint8Array(x.memory.buffer).set(input, p);
      code = x[fn](p, input.length);
    } finally {
      x.dealloc(p, input.length);
    }
    const text = new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.result_ptr(), x.result_len()));
    if (code !== 0) throw new Error(`core-wasm ${fn}: ${text}`);
    return JSON.parse(text) as T;
  }

  /** Replays consecutive epochs from GENESIS (the first must be the router's first epoch to match it). */
  replay(params: ReplayParams, epochs: ReplayEpoch[]): ReplayedEpoch[] {
    return this.call('replay', { params, epochs });
  }

  stateHash(input: StateInput): { state_hash: string; canonical: string } {
    return this.call('state_hash', input);
  }
}

let shared: Promise<CoreWasm> | null = null;

/** The app's core-wasm, fetched once from /wasm/ (built by scripts/build-wasm.sh). */
export function loadCore(): Promise<CoreWasm> {
  const url = `${import.meta.env.BASE_URL}wasm/spores_core_wasm.wasm`;
  shared ??= fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`${url}: http ${r.status} (build it with scripts/build-wasm.sh)`);
      return r.arrayBuffer();
    })
    .then((b) => CoreWasm.load(b))
    .catch((e) => {
      shared = null;
      throw e;
    });
  return shared;
}
