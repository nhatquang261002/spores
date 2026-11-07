// The app's render queue: real Web Workers, the IndexedDB cache, and the
// renderer version from /wasm/manifest.json (written by scripts/build-wasm.sh
// from renderer/src/lib.rs). Components get it through RenderQueueContext so
// tests can pass their own.
import { createContext } from 'react';
import { IdbImageCache } from './imageCache';
import { RenderQueue, type WorkerLike } from './renderQueue';

export interface WasmManifest {
  renderer_version: number;
  files: Record<string, { bytes: number; sha256: string }>;
}

export async function loadManifest(fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<WasmManifest> {
  const url = `${import.meta.env.BASE_URL}wasm/manifest.json`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`${url}: http ${res.status} (build the wasm with scripts/build-wasm.sh)`);
  const m = (await res.json()) as WasmManifest;
  if (!Number.isInteger(m.renderer_version)) throw new Error(`${url}: no renderer_version`);
  return m;
}

let shared: Promise<RenderQueue> | null = null;

export function appRenderQueue(): Promise<RenderQueue> {
  shared ??= (async () => {
    const [manifest, cache] = await Promise.all([loadManifest(), IdbImageCache.open()]);
    return new RenderQueue({
      createWorker: () => new Worker(new URL('./renderer.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
      rendererVersion: manifest.renderer_version,
      cache,
      maxWorkers: 2,
    });
  })().catch((e) => {
    shared = null;
    throw e;
  });
  return shared;
}

export const RenderQueueContext = createContext<() => Promise<RenderQueue>>(appRenderQueue);
