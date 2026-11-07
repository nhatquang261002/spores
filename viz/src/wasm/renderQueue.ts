// Render scheduling (Design §10): at most 2 workers, lowest priority number
// first (visible cards ask with 0), one render per distinct input, and an
// image cache so returning visitors render nothing.
//
// The cache key is the renderer version plus sha256 of the encoded render
// input (seed | age | edges): exactly what the image depends on. The plan
// says "state hash + RENDERER_VERSION"; the state hash also covers the spore
// id and epoch, which the image does not depend on, and is not on hand for
// historical states without core-wasm. Logged as a deviation in the plan.
import { encodeRenderInput, toHex, type RenderInput } from './renderer';

export type WorkerRequest = { id: number; input: Uint8Array };
export type WorkerReply = { id: number; ok: true; rgb: Uint8Array; imageHash: string; ms: number } | { id: number; ok: false; error: string };

/** The part of `Worker` the queue uses (tests pass an in-process fake). */
export interface WorkerLike {
  postMessage(msg: WorkerRequest, transfer: Transferable[]): void;
  onmessage: ((e: { data: WorkerReply }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
  terminate(): void;
}

export interface CachedImage {
  rgb: Uint8Array;
  imageHash: string;
}

export interface ImageCacheLike {
  get(key: string): Promise<CachedImage | undefined>;
  put(key: string, value: CachedImage): Promise<void>;
}

export interface Rendered extends CachedImage {
  source: 'cache' | 'worker';
  /** RENDERER_VERSION of the wasm that made it (part of the cache key). */
  rendererVersion: number;
  /** Render time in the worker. */
  ms?: number;
}

export async function cacheKey(input: Uint8Array, rendererVersion: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', input as Uint8Array<ArrayBuffer>);
  return `r${rendererVersion}:${toHex(new Uint8Array(digest))}`;
}

const abortError = () => new DOMException('render request released', 'AbortError');

interface Task {
  key: string;
  /** Where the image is stored; equal to `key` unless the request is `fresh`. */
  cacheKey: string;
  /** Skip the cache read: the image must be made now. */
  fresh: boolean;
  input: Uint8Array;
  priority: number;
  seq: number;
  waiters: number;
  started: boolean;
  promise: Promise<Rendered>;
  resolve: (r: Rendered) => void;
  reject: (e: unknown) => void;
}

interface Slot {
  worker: WorkerLike;
  task: Task | null;
}

export interface RenderQueueOptions {
  createWorker: () => WorkerLike;
  rendererVersion: number;
  cache?: ImageCacheLike | null;
  maxWorkers?: number;
}

export class RenderQueue {
  private readonly opts: Required<Omit<RenderQueueOptions, 'cache'>> & { cache: ImageCacheLike | null };
  private readonly tasks = new Map<string, Task>();
  private readonly waiting: Task[] = [];
  private readonly slots: Slot[] = [];
  private seq = 0;
  private nextId = 1;
  private readonly byId = new Map<number, Task>();

  constructor(o: RenderQueueOptions) {
    this.opts = { maxWorkers: 2, cache: null, ...o };
  }

  /** Renders waiting and running, and workers started. */
  get stats() {
    return { queued: this.waiting.length, running: this.slots.filter((s) => s.task).length, workers: this.slots.length };
  }

  /**
   * The image for `input`. Lower `priority` goes first. Aborting `signal`
   * releases this request; a render nobody waits for any more is dropped if it
   * has not started. `fresh` renders now instead of reading the cache and
   * shares nothing with other requests (Verify recomputes on each click); the
   * result still goes into the cache.
   */
  async request(input: RenderInput | Uint8Array, { priority = 1, signal, fresh = false }: { priority?: number; signal?: AbortSignal; fresh?: boolean } = {}): Promise<Rendered> {
    const bytes = input instanceof Uint8Array ? input : encodeRenderInput(input);
    const stored = await cacheKey(bytes, this.opts.rendererVersion);
    if (signal?.aborted) throw abortError();
    const key = fresh ? `fresh:${this.seq}:${stored}` : stored;
    let task = this.tasks.get(key);
    if (task) {
      task.priority = Math.min(task.priority, priority);
    } else {
      task = this.newTask(key, stored, fresh, bytes, priority);
      void this.start(task);
    }
    const t = task;
    t.waiters++;
    return new Promise<Rendered>((resolve, reject) => {
      const onAbort = () => {
        t.waiters--;
        if (t.waiters === 0 && !t.started) this.drop(t);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      t.promise.then(
        (r) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(r);
        },
        (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  /** Stops every worker; pending requests fail. */
  dispose(): void {
    for (const t of [...this.tasks.values()]) t.reject(new Error('render queue disposed'));
    this.tasks.clear();
    this.waiting.length = 0;
    for (const s of this.slots) s.worker.terminate();
    this.slots.length = 0;
  }

  private newTask(key: string, stored: string, fresh: boolean, input: Uint8Array, priority: number): Task {
    let resolve!: (r: Rendered) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<Rendered>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => {});
    const task: Task = { key, cacheKey: stored, fresh, input, priority, seq: this.seq++, waiters: 0, started: false, promise, resolve, reject };
    this.tasks.set(key, task);
    return task;
  }

  private async start(task: Task) {
    const hit = this.opts.cache && !task.fresh ? await this.opts.cache.get(task.cacheKey).catch(() => undefined) : undefined;
    if (this.tasks.get(task.key) !== task) return; // dropped while reading the cache
    if (hit) {
      this.tasks.delete(task.key);
      task.resolve({ ...hit, source: 'cache', rendererVersion: this.opts.rendererVersion });
      return;
    }
    this.waiting.push(task);
    this.pump();
  }

  private drop(task: Task) {
    const i = this.waiting.indexOf(task);
    if (i >= 0) this.waiting.splice(i, 1);
    this.tasks.delete(task.key);
    task.reject(abortError());
  }

  private slot(): Slot | null {
    const idle = this.slots.find((s) => !s.task);
    if (idle) return idle;
    if (this.slots.length >= this.opts.maxWorkers) return null;
    const slot: Slot = { worker: this.opts.createWorker(), task: null };
    slot.worker.onmessage = (e) => this.onReply(slot, e.data);
    slot.worker.onerror = (e) => this.onWorkerError(slot, e?.message || 'render worker failed');
    this.slots.push(slot);
    return slot;
  }

  private pump() {
    while (this.waiting.length) {
      const slot = this.slot();
      if (!slot) return;
      this.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const task = this.waiting.shift()!;
      task.started = true;
      slot.task = task;
      const id = this.nextId++;
      this.byId.set(id, task);
      const copy = task.input.slice();
      slot.worker.postMessage({ id, input: copy }, [copy.buffer]);
    }
  }

  private onReply(slot: Slot, reply: WorkerReply) {
    const task = this.byId.get(reply.id);
    this.byId.delete(reply.id);
    slot.task = null;
    if (task) {
      this.tasks.delete(task.key);
      if (reply.ok) {
        const image = { rgb: reply.rgb, imageHash: reply.imageHash };
        void this.opts.cache?.put(task.cacheKey, image).catch(() => {});
        task.resolve({ ...image, source: 'worker', rendererVersion: this.opts.rendererVersion, ms: reply.ms });
      } else {
        task.reject(new Error(reply.error));
      }
    }
    this.pump();
  }

  private onWorkerError(slot: Slot, message: string) {
    const task = slot.task;
    slot.worker.terminate();
    this.slots.splice(this.slots.indexOf(slot), 1);
    if (task) {
      this.tasks.delete(task.key);
      task.reject(new Error(message));
    }
    this.pump();
  }
}
