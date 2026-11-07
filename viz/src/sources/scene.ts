// The scene server (agents/src/scene-server.ts, this machine only) and scene
// recordings. A server that doesn't answer is a state the page shows, never a
// reason to play something else.
import type { SceneLine } from '../model/scene';
import { parseSceneLine, parseSceneLog } from '../model/scene';
import type { Source } from '../model/types';
import { listRecorded, recordedFiles, type RecordedBundle } from './recorded';
import { runFiles } from './run';

export const SCENE_SERVER: string = import.meta.env?.VITE_SCENE_SERVER || 'http://127.0.0.1:8790';

export interface Precondition {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
  pick?: { spore: number; provider: number };
}

export interface ServerScene {
  id: string;
  title: string;
  running: boolean;
  run: string | null;
  preconditions: Precondition[];
  reset: { blocked: string | null };
}

export class SceneServerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'SceneServerError';
    this.status = status;
  }
}

export type StreamHandlers = { onLine: (l: SceneLine) => void; onEnd: () => void; onConnection: (ok: boolean) => void };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** A loopback server can only be asked from a loopback page. With no page at all (a test, a worker) nothing rules it out. */
export function canReachFrom(base: string, pageHost: string | undefined): boolean {
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return true; // A relative base is this page's own server.
  }
  return !LOOPBACK.has(host) || pageHost === undefined || LOOPBACK.has(pageHost);
}

export class SceneClient {
  readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly makeSource: (url: string) => EventSource;
  constructor(base = SCENE_SERVER, fetchFn: typeof fetch = (...a) => fetch(...a), makeSource: (url: string) => EventSource = (u) => new EventSource(u)) {
    this.base = base;
    this.fetchFn = fetchFn;
    this.makeSource = makeSource;
  }

  private async send(path: string, method: 'GET' | 'POST'): Promise<any> {
    const res = await this.fetchFn(this.base + path, { method });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new SceneServerError(res.status, body?.failed?.map((f: Precondition) => f.label).join(', ') || body?.error || `http ${res.status}`);
    return body;
  }

  async list(): Promise<ServerScene[]> {
    // It answers only pages on this machine (agents/src/scene-server.ts), so a hosted page never knocks: it would only ever be refused.
    if (!canReachFrom(this.base, globalThis.location?.hostname)) throw new SceneServerError(0, 'the scene server only answers pages opened on its own machine');
    return (await this.send('/scenes', 'GET')).scenes;
  }
  run(id: string): Promise<{ run: string }> {
    return this.send(`/scenes/${id}/run`, 'POST');
  }
  reset(id: string): Promise<{ ok: boolean }> {
    return this.send(`/scenes/${id}/reset`, 'POST');
  }

  /** Follows a run. EventSource reconnects with Last-Event-ID by itself; the handlers hear about the gap. */
  stream(id: string, h: StreamHandlers): () => void {
    const es = this.makeSource(`${this.base}/scenes/${id}/stream`);
    let ended = false;
    const stop = () => {
      ended = true;
      es.close();
    };
    es.addEventListener('open', () => h.onConnection(true));
    es.addEventListener('scene', (e) => h.onLine(parseSceneLine((e as MessageEvent<string>).data)));
    es.addEventListener('end', () => {
      stop();
      h.onEnd();
    });
    es.addEventListener('idle', () => {
      stop();
      h.onEnd();
    });
    es.addEventListener('error', () => {
      if (!ended) h.onConnection(false);
    });
    return stop;
  }
}

/** Newest recording of a scene in this build, or null. */
export async function latestRecording(scene: string, fetchFn?: typeof fetch): Promise<RecordedBundle | null> {
  const all = await listRecorded(fetchFn);
  const mine = all.filter((b) => b.scene === scene).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return mine[0] ?? null;
}

/** A log from a RECORDED bundle or a LOCAL RUN. Missing is an error naming the file, never empty. */
export async function loadSceneLog(source: Extract<Source, { kind: 'run' | 'recorded' }>, fetchFn?: typeof fetch): Promise<SceneLine[]> {
  const files = source.kind === 'run' ? runFiles(source.run, fetchFn) : recordedFiles(source.run, fetchFn);
  return parseSceneLog(await files.text('scene.jsonl'));
}
