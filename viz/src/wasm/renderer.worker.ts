/// <reference lib="webworker" />
// Render worker: runs spores_renderer.wasm off the main thread. One request at
// a time; replies with the RGB bytes (transferred) and the image hash.
import { RendererWasm } from './renderer';
import type { WorkerReply, WorkerRequest } from './renderQueue';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const url = `${import.meta.env.BASE_URL}wasm/spores_renderer.wasm`;
let wasm: Promise<RendererWasm> | null = null;

function load(): Promise<RendererWasm> {
  wasm ??= fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`${url}: http ${r.status} (build it with scripts/build-wasm.sh)`);
      return r.arrayBuffer();
    })
    .then((b) => RendererWasm.load(b))
    .catch((e) => {
      wasm = null;
      throw e;
    });
  return wasm;
}

scope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, input } = e.data;
  let reply: WorkerReply;
  const transfer: Transferable[] = [];
  try {
    const r = await load();
    const t0 = performance.now();
    const { rgb, imageHash } = r.render(input);
    reply = { id, ok: true, rgb, imageHash, ms: Math.round(performance.now() - t0) };
    transfer.push(rgb.buffer);
  } catch (err) {
    reply = { id, ok: false, error: String((err as Error)?.message ?? err) };
  }
  scope.postMessage(reply, transfer);
};
