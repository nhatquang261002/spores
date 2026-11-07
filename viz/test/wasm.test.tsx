// S5: the renderer and core wasm the app serves (viz/public/wasm/, built by
// scripts/build-wasm.sh) against the shared vectors, the render queue, the
// image cache and SporeArtwork's states.
import 'fake-indexeddb/auto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { artworkLabel, SporeArtwork } from '../src/components/SporeArtwork';
import { RenderQueueContext } from '../src/wasm/art';
import { CoreWasm } from '../src/wasm/core';
import { IdbImageCache } from '../src/wasm/imageCache';
import { encodeRenderInput, RendererWasm, RGB_LEN, toHex } from '../src/wasm/renderer';
import { cacheKey, RenderQueue, type ImageCacheLike, type WorkerLike, type WorkerReply, type WorkerRequest } from '../src/wasm/renderQueue';

const repo = path.join(process.cwd(), '..');
const wasmDir = path.join(process.cwd(), 'public', 'wasm');
const rendererVectors = JSON.parse(readFileSync(path.join(repo, 'vectors/renderer.json'), 'utf8'));
const coreVectors = JSON.parse(readFileSync(path.join(repo, 'vectors/core.json'), 'utf8'));

function needWasm(file: string): Buffer {
  const p = path.join(wasmDir, file);
  if (!existsSync(p)) throw new Error(`${p} is missing: run scripts/build-wasm.sh first`);
  return readFileSync(p);
}

let renderer: RendererWasm;
beforeAll(async () => {
  renderer = await RendererWasm.load(needWasm('spores_renderer.wasm'));
});
afterEach(cleanup);

type RenderFn = (input: Uint8Array) => { rgb: Uint8Array; imageHash: string };

/** Runs requests in-process with `render`; holds them until `gate` resolves. */
class InProcessWorker implements WorkerLike {
  onmessage: ((e: { data: WorkerReply }) => void) | null = null;
  onerror: ((e: { message?: string }) => void) | null = null;
  private readonly render: RenderFn;
  private readonly gate: Promise<void>;
  constructor(render: RenderFn, gate: Promise<void> = Promise.resolve()) {
    this.render = render;
    this.gate = gate;
  }
  postMessage(msg: WorkerRequest) {
    void this.gate.then(() => {
      try {
        const { rgb, imageHash } = this.render(msg.input);
        this.onmessage?.({ data: { id: msg.id, ok: true, rgb, imageHash, ms: 0 } });
      } catch (e) {
        this.onmessage?.({ data: { id: msg.id, ok: false, error: String((e as Error).message) } });
      }
    });
  }
  terminate() {}
}

function memoryCache(): ImageCacheLike {
  const map = new Map<string, any>();
  return { get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v) };
}

describe('renderer wasm (vectors/renderer.json)', () => {
  it('is the renderer version the vectors were made with', () => {
    const manifest = JSON.parse(needWasm('manifest.json').toString());
    expect(manifest.renderer_version).toBe(rendererVectors.renderer_version);
  });

  it('matches every vector image hash', { timeout: 120_000 }, () => {
    for (const c of rendererVectors.cases) {
      const { rgb, imageHash } = renderer.render(encodeRenderInput({ seed: c.seed, age: c.age, edges: c.edges }));
      expect(rgb.length).toBe(RGB_LEN);
      expect(imageHash, c.name).toBe(c.image_hash);
    }
  });

  it('encodes the input as Spore::from_bytes expects (edges sorted by id, little-endian)', () => {
    const b = encodeRenderInput({ seed: 'ab'.repeat(32), age: 3, edges: [[19, '990000'], [3, 880000]] });
    expect(b.length).toBe(40 + 24);
    const dv = new DataView(b.buffer);
    expect([b[0], b[31], dv.getUint32(32, true), dv.getUint32(36, true)]).toEqual([0xab, 0xab, 3, 2]);
    expect([dv.getUint32(40, true), dv.getBigUint64(44, true), dv.getUint32(52, true), dv.getBigUint64(56, true)]).toEqual([3, 880000n, 19, 990000n]);
    expect(() => encodeRenderInput({ seed: 'xyz', age: 0, edges: [] })).toThrow(/seed/);
    expect(() => renderer.render(new Uint8Array(39))).toThrow(/did not parse/);
  });
});

describe('render queue', () => {
  const cases = rendererVectors.cases.slice(0, 4);

  it('renders through two workers and returns the vector hashes', { timeout: 60_000 }, async () => {
    // The fake renders on this thread, so hold the first renders until every request is queued.
    const gate = new Promise<void>((r) => setTimeout(r, 50));
    let workers = 0;
    const q = new RenderQueue({ createWorker: () => (workers++, new InProcessWorker((i) => renderer.render(i), gate)), rendererVersion: 1 });
    const out = await Promise.all(cases.map((c: any) => q.request({ seed: c.seed, age: c.age, edges: c.edges })));
    expect(out.map((r) => r.imageHash)).toEqual(cases.map((c: any) => c.image_hash));
    expect(out.every((r) => r.source === 'worker')).toBe(true);
    expect(workers).toBe(2);
  });

  it('renders one input once, lowest priority number first, and drops released requests', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const order: number[] = [];
    const fake: RenderFn = (input) => {
      order.push(new DataView(input.buffer).getUint32(32, true));
      return { rgb: new Uint8Array(RGB_LEN), imageHash: 'h' };
    };
    const q = new RenderQueue({ createWorker: () => new InProcessWorker(fake, gate), rendererVersion: 1, maxWorkers: 1 });
    const seed = '00'.repeat(32);
    const at = (age: number, priority: number, signal?: AbortSignal) => q.request({ seed, age, edges: [] }, { priority, signal });
    const first = at(1, 5); // takes the only worker
    await new Promise((r) => setTimeout(r, 10));
    const ctrl = new AbortController();
    const reqs = [at(2, 3), at(3, 0), at(2, 1), at(4, 2, ctrl.signal)];
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    await expect(reqs[3]).rejects.toThrow(/released/);
    open();
    await Promise.all([first, reqs[0], reqs[1], reqs[2]]);
    expect(order).toEqual([1, 3, 2]);
  });

  it('serves a cached image without rendering, keyed by renderer version and input', async () => {
    const cache = memoryCache();
    let renders = 0;
    const fake: RenderFn = () => (renders++, { rgb: new Uint8Array(RGB_LEN).fill(7), imageHash: 'cafe' });
    const mk = (v: number) => new RenderQueue({ createWorker: () => new InProcessWorker(fake), rendererVersion: v, cache });
    const input = { seed: '11'.repeat(32), age: 2, edges: [[5, 60000]] as [number, number][] };
    expect((await mk(1).request(input)).source).toBe('worker');
    await new Promise((r) => setTimeout(r, 0));
    const again = await mk(1).request(input);
    expect([again.source, again.imageHash, again.rgb[0]]).toEqual(['cache', 'cafe', 7]);
    expect((await mk(2).request(input)).source).toBe('worker');
    expect(renders).toBe(2);
    expect(await cacheKey(encodeRenderInput(input), 1)).toMatch(/^r1:[0-9a-f]{64}$/);
  });

  it('reports a worker error to the waiting request', async () => {
    const boom: RenderFn = () => {
      throw new Error('boom');
    };
    const q = new RenderQueue({ createWorker: () => new InProcessWorker(boom), rendererVersion: 1 });
    await expect(q.request({ seed: '22'.repeat(32), age: 0, edges: [] })).rejects.toThrow('boom');
  });
});

describe('image cache (IndexedDB)', () => {
  it('stores RGB and the hash, and trims the oldest entries', async () => {
    const cache = (await IdbImageCache.open(indexedDB, `test-${Math.random()}`))!;
    expect(cache).not.toBeNull();
    const rgb = new Uint8Array(RGB_LEN).fill(3);
    await cache.put('a', { rgb, imageHash: 'x' });
    const got = await cache.get('a');
    expect([got?.imageHash, got?.rgb.length, got?.rgb[100]]).toEqual(['x', RGB_LEN, 3]);
    expect(await cache.get('missing')).toBeUndefined();
    await cache.put('b', { rgb, imageHash: 'y' });
    await cache.put('c', { rgb, imageHash: 'z' });
    await cache.trim(2);
    expect(await cache.count()).toBe(2);
    cache.close();
  });
  it('is absent, not an error, without IndexedDB', async () => {
    expect(await IdbImageCache.open(null)).toBeNull();
  });
});

describe('core wasm (vectors/core.json)', () => {
  let core: CoreWasm;
  beforeAll(async () => {
    core = await CoreWasm.load(needWasm('spores_core_wasm.wasm'));
  });
  const epochs = (chain: any) => chain.epochs.map((e: any) => ({ epoch: e.epoch, active: chain.active, flows: e.payments, rejects: e.rejects, pool: e.pool }));

  it('replays both epoch chains: fingerprints, tubes and reputation', () => {
    for (const chain of coreVectors.epoch_chains) {
      const out = core.replay(chain.params, epochs(chain));
      chain.epochs.forEach((e: any, i: number) => {
        expect(out[i].fingerprint).toBe(e.expect.fingerprint);
        expect(out[i].prev_fingerprint).toBe(e.prev_fingerprint);
        expect(out[i].tubes).toEqual(e.expect.conductivity);
        expect(out[i].reputation).toEqual(e.expect.reputation);
      });
    }
  });

  it('maps the router config (rebate rule CappedRebate) and hashes spore states', () => {
    const chain = coreVectors.epoch_chains[1];
    const p = chain.params;
    const config = { decay_bps: p.decay_bps, gain: p.gain, k: p.k, d_min: p.d_min, fee_bps: p.fee_bps, rebate_bps: p.pool_rule.rebate_bps, breadth_full: p.breadth_full, reject_bps: p.reject_bps };
    expect(core.replay(config, epochs(chain)).map((e) => e.fingerprint)).toEqual(chain.epochs.map((e: any) => e.expect.fingerprint));
    for (const s of coreVectors.spore_state) {
      expect(core.stateHash({ spore_id: s.id, epoch: s.epoch, seed: s.seed, age: s.age, edges: s.edges })).toEqual({ state_hash: s.state_hash, canonical: s.canonical });
    }
  });

  it('returns errors as text', () => {
    expect(() => core.replay(coreVectors.params.shipped, [{ epoch: 1, active: [1], flows: [[1, 9, '5']], rejects: [], pool: '0' }])).toThrow(
      'core-wasm replay: epoch 1: spore 9 is not active',
    );
  });
});

describe('SporeArtwork', () => {
  const organism = { id: 7, seed: rendererVectors.cases[1].seed, age: 3, tubes: [[3, '900000'], [12, '300000']] as [number, string][] };
  const glyph = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>";

  function withQueue(q: Partial<RenderQueue>, el: ReactElement) {
    return render(<RenderQueueContext.Provider value={async () => q as RenderQueue}>{el}</RenderQueueContext.Provider>);
  }

  it('shows the on-chain glyph while rendering, then the image', async () => {
    let finish!: (r: any) => void;
    const seen: string[] = [];
    withQueue(
      { request: () => new Promise((r) => (finish = r)) },
      <SporeArtwork organism={organism} glyph={glyph} onRendered={(r) => seen.push(r.imageHash)} />,
    );
    expect(screen.getByText('on-chain glyph · rendering…')).toBeTruthy();
    expect(screen.getByRole('img').getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      finish({ rgb: new Uint8Array(RGB_LEN), imageHash: 'abc', source: 'worker' });
    });
    expect(screen.queryByText(/rendering/)).toBeNull();
    expect(seen).toEqual(['abc']);
    expect(document.querySelector('figure')?.dataset.state).toBe('ready');
  });

  it('keeps the glyph and says so when rendering fails', async () => {
    withQueue({ request: () => Promise.reject(new Error('wasm missing')) }, <SporeArtwork organism={organism} glyph={glyph} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // The reason is in a Tooltip (hover, focus or tap), not a native title.
    fireEvent.click(screen.getByText('Could not render · glyph shown'));
    expect(screen.getByRole('tooltip').textContent).toBe('wasm missing');
  });

  it('describes the art for screen readers', () => {
    expect(artworkLabel(organism)).toMatch(/^Spore #7 artwork: \w+ palette, 2 tubes, strongest to #3$/);
    expect(artworkLabel({ ...organism, tubes: [] })).toMatch(/no tubes$/);
    expect(toHex(Uint8Array.from([0, 15, 255]))).toBe('000fff');
  });
});
