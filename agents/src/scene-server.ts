// Scene server (docs/phase6-plan.md S11): runs Demo Lab scenes for the app.
// Local only: it binds 127.0.0.1 and refuses any request whose peer, Host or
// Origin isn't loopback, because a run signs with the keys in .env and any web
// page could otherwise POST to it. Each scene runs as a child process, and its
// JSONL stdout streams over SSE. Keys stay in the child: no response carries one.
//
//   node agents/src/scene-server.ts            (SCENE_PORT, default 8790)
//
//   GET  /scenes               scenes with live preconditions
//   POST /scenes/:id/run       202 {run}; 409 while running or not ready
//   GET  /scenes/:id/stream    SSE of the current run's lines (Last-Event-ID resumes)
//   POST /scenes/:id/reset     undoes what a dead run left behind, where the scene can
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { balanceOf } from './near.ts';
import { chainViews, keeperKey, loadDotEnv, ownerKeys, pendingReset, pickOpts, pickSpores, ROOT, routerOf } from './scenes/rogue.ts';
import { BUYER_MARGIN, DEFAULT_PRICE, newAgentKey, pendingSaleReset, pickForSale, salePickOpts } from './scenes/sale.ts';

export const DEFAULT_PORT = 8790;

export interface Precondition {
  key: string;
  label: string;
  ok: boolean;
  /** What's wrong and what to do; never a key. */
  detail?: string;
  /** The spores a run would use, when this check picked them. */
  pick?: { spore: number; provider: number };
}

export interface SceneDef {
  id: string;
  title: string;
  /** Command for a run; `run` is the run's directory name. */
  command(run: string): { cmd: string; args: string[] };
  /** Command for a reset, when the scene has one. */
  resetCommand?(): { cmd: string; args: string[] };
  preconditions(): Promise<Precondition[]>;
  /** null when there is something to reset; otherwise why not. */
  resetBlocked?(): string | null;
  /** The log file a run appends to, so the exit line lands in the recording too. */
  logFile?(run: string): string;
}

const LOOPBACK_PEER = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/** Why this request is refused, or null. A browser on another site always sends its Origin, so it can't reach the keys. */
export function refusal(peer: string | undefined, host: string | undefined, origin: string | undefined): string | null {
  if (!peer || !LOOPBACK_PEER.has(peer)) return 'only this machine may call the scene server';
  if (!host || !LOOPBACK_HOST.test(host)) return 'the Host header must be 127.0.0.1 or localhost';
  if (origin !== undefined && !LOOPBACK_ORIGIN.test(origin)) return 'only a page served from this machine may call the scene server';
  return null;
}

/** One SSE message. A newline in the payload starts another `data:` line, so a message can never be split or forged by its content. */
export function sseFrame(id: number | null, event: string, data: string): string {
  const head = `${id !== null ? `id: ${id}\n` : ''}event: ${event}\n`;
  return `${head}${data.split(/\r\n|\r|\n/).map((l) => `data: ${l}`).join('\n')}\n\n`;
}

interface RunState {
  run: string;
  lines: string[];
  child: ChildProcess | null;
  finished: boolean;
  subscribers: Set<ServerResponse>;
}

export interface SceneServerOpts {
  scenes: SceneDef[];
  /** Tests make run names predictable. */
  runName?: (id: string) => string;
  heartbeatMs?: number;
}

export function createSceneServer({ scenes, runName, heartbeatMs = 15_000 }: SceneServerOpts): Server {
  const runs = new Map<string, RunState>();
  const busy = new Set<string>();
  const byId = new Map(scenes.map((s) => [s.id, s]));

  const publish = (st: RunState, line: string) => {
    st.lines.push(line);
    for (const res of st.subscribers) res.write(sseFrame(st.lines.length, 'scene', line));
  };
  const finish = (st: RunState) => {
    st.finished = true;
    for (const res of st.subscribers) {
      res.write(sseFrame(null, 'end', JSON.stringify({ run: st.run })));
      res.end();
    }
    st.subscribers.clear();
  };

  const start = (def: SceneDef): RunState => {
    const run = runName?.(def.id) ?? `${def.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const { cmd, args } = def.command(run);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
    const st: RunState = { run, lines: [], child, finished: false, subscribers: new Set() };
    runs.set(def.id, st);
    const out = createInterface({ input: child.stdout! });
    out.on('line', (line) => {
      try {
        JSON.parse(line);
        publish(st, line);
      } catch {
        // Only JSON lines are events; anything else stays on the server's side.
      }
    });
    let spawnError: string | null = null;
    child.on('error', (e) => {
      spawnError = e.message;
    });
    child.on('close', (code, signal) => {
      out.close();
      // The UI says "completed" only on this line: the process's real exit code.
      const line = JSON.stringify({ seq: st.lines.length + 1, at: new Date().toISOString(), type: 'exit', code: code ?? -1, signal: signal ?? undefined, error: spawnError ?? undefined });
      publish(st, line);
      const log = def.logFile?.(run);
      if (log) {
        try {
          appendFileSync(log, line + '\n');
        } catch {
          // The child never got as far as its directory; the stream still has the line.
        }
      }
      st.child = null;
      finish(st);
    });
    return st;
  };

  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  const describe = async (def: SceneDef) => {
    const st = runs.get(def.id);
    return {
      id: def.id,
      title: def.title,
      running: !!st && !st.finished,
      run: st?.run ?? null,
      preconditions: await def.preconditions(),
      reset: def.resetCommand ? { blocked: st && !st.finished ? 'a run is in progress' : def.resetBlocked?.() ?? null } : { blocked: 'This scene has nothing to reset.' },
    };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const why = refusal(req.socket.remoteAddress, req.headers.host, req.headers.origin);
    if (why) return reply(res, 403, { error: why });
    // Past the check, so this only ever names a loopback page.
    if (req.headers.origin) {
      res.setHeader('access-control-allow-origin', req.headers.origin);
      res.setHeader('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, POST');
      res.setHeader('access-control-allow-headers', 'last-event-id');
      res.writeHead(204);
      return res.end();
    }
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/scenes') {
      if (req.method !== 'GET') return reply(res, 405, { error: 'GET only' });
      return reply(res, 200, { scenes: await Promise.all(scenes.map(describe)) });
    }
    const m = /^\/scenes\/([a-z0-9-]+)\/(run|stream|reset)$/.exec(path);
    const def = m && byId.get(m[1]);
    if (!m || !def) return reply(res, 404, { error: 'not found' });
    const st = runs.get(def.id);

    if (m[2] === 'stream') {
      if (req.method !== 'GET') return reply(res, 405, { error: 'GET only' });
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.flushHeaders();
      const from = Number(req.headers['last-event-id'] ?? 0) || 0;
      if (st) st.lines.slice(from).forEach((line, i) => res.write(sseFrame(from + i + 1, 'scene', line)));
      // No run to follow: the client starts one with POST, then connects.
      if (!st || st.finished) {
        res.write(st ? sseFrame(null, 'end', JSON.stringify({ run: st.run })) : sseFrame(null, 'idle', '{}'));
        return res.end();
      }
      st.subscribers.add(res);
      const beat = setInterval(() => res.write(': keep-alive\n\n'), heartbeatMs);
      res.on('close', () => {
        clearInterval(beat);
        st.subscribers.delete(res);
      });
      return;
    }

    if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' });
    if (st && !st.finished) return reply(res, 409, { error: 'a run is in progress', run: st.run });
    if (busy.has(def.id)) return reply(res, 409, { error: 'another request for this scene is in progress' });
    // Scenes share accounts, so two at once would race on nonces and pick the same spore.
    const other = [...runs.entries()].find(([id, r]) => id !== def.id && !r.finished);
    if (other) return reply(res, 409, { error: `the ${other[0]} scene is running`, run: other[1].run });

    if (m[2] === 'run') {
      // Held across the await: two quick clicks must not sign twice.
      busy.add(def.id);
      try {
        const pre = await def.preconditions();
        const failed = pre.filter((p) => !p.ok);
        if (failed.length) return reply(res, 409, { error: 'preconditions not met', failed });
        return reply(res, 202, { run: start(def).run });
      } finally {
        busy.delete(def.id);
      }
    }

    const blocked = def.resetCommand ? def.resetBlocked?.() ?? null : 'This scene has nothing to reset.';
    if (blocked) return reply(res, 409, { error: blocked });
    const { cmd, args } = def.resetCommand!();
    busy.add(def.id);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
    let out = '';
    child.stdout!.on('data', (d) => (out += d));
    child.on('error', (e) => reply(res, 500, { error: e.message }));
    child.on('close', (code) => {
      busy.delete(def.id);
      if (res.headersSent) return;
      let detail: unknown = null;
      try {
        detail = JSON.parse(out.trim().split('\n').pop() ?? 'null');
      } catch {}
      reply(res, code === 0 ? 200 : 500, { ok: code === 0, detail });
    });
  };

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) reply(res, 500, { error: (e as Error).message });
      else res.end();
    });
  });
}

/** Rogue on the real router: each precondition read live, cached briefly because the page polls. */
export function rogueScene(): SceneDef {
  const script = join(ROOT, 'agents/src/scenes/rogue.ts');
  let cache: { at: number; value: Promise<Precondition[]> } | null = null;
  const read = async (): Promise<Precondition[]> => {
    const env = loadDotEnv();
    const router = routerOf(env);
    const out: Precondition[] = [];
    const needKeys: string[] = [];
    if (!router) needKeys.push('PHASE5_ROUTER_ACCOUNT_ID');
    if (ownerKeys(env).size === 0) needKeys.push('an owner key');
    if (!keeperKey(env)) needKeys.push('the keeper key');
    if (!env.OPERATOR_ACCOUNT_ID) needKeys.push('OPERATOR_ACCOUNT_ID');
    out.push({ key: 'keys', label: 'Testnet keys in .env', ok: needKeys.length === 0, detail: needKeys.length ? `Missing ${needKeys.join(', ')}. Run scripts/phase6-setup.sh.` : undefined });
    const pending = pendingReset();
    out.push({ key: 'clean', label: 'No narrowed policy left by an earlier run', ok: !pending, detail: pending ? `Run ${pending.run} left spore ${pending.spore}'s policy narrowed. Use Reset.` : undefined });
    if (router) {
      try {
        const pick = await pickSpores(chainViews(router), pickOpts(env));
        out.push({ key: 'spore', label: `Test spore #${pick.spore} ready, hiring #${pick.provider}`, ok: true, detail: pick.reason, pick: { spore: pick.spore, provider: pick.provider } });
      } catch (e) {
        out.push({ key: 'spore', label: 'A spore with tubes to watch', ok: false, detail: (e as Error).message });
      }
    }
    return out;
  };
  return {
    id: 'rogue',
    title: 'Rogue agent',
    command: (run) => ({ cmd: process.execPath, args: [script, '--run', run] }),
    resetCommand: () => ({ cmd: process.execPath, args: [script, '--reset'] }),
    resetBlocked: () => (pendingReset() ? null : 'Nothing to reset: each run puts the policy back itself, and tube decay can’t be undone.'),
    logFile: (run) => join(ROOT, 'out/agents', run, 'scene.jsonl'),
    preconditions: () => {
      if (!cache || Date.now() - cache.at > 8_000) cache = { at: Date.now(), value: read() };
      return cache.value;
    },
  };
}

/** Sale on the real router. A finished run leaves the spore with the buyer, so a second run waits for Reset. */
export function saleScene(): SceneDef {
  const script = join(ROOT, 'agents/src/scenes/sale.ts');
  let cache: { at: number; pending: boolean; value: Promise<Precondition[]> } | null = null;
  const read = async (): Promise<Precondition[]> => {
    const env = loadDotEnv();
    const router = routerOf(env);
    const out: Precondition[] = [];
    const needKeys: string[] = [];
    if (!router) needKeys.push('PHASE5_ROUTER_ACCOUNT_ID');
    if (!env.OWNER_ACCOUNT_ID || !env.OWNER_PRIVATE_KEY) needKeys.push('the owner key');
    if (!env.BUYER_ACCOUNT_ID || !env.BUYER_PRIVATE_KEY) needKeys.push('the buyer key');
    if (!env.OPERATOR2_ACCOUNT_ID || !newAgentKey(env)) needKeys.push('the second operator key');
    out.push({ key: 'keys', label: 'Testnet keys in .env', ok: needKeys.length === 0, detail: needKeys.length ? `Missing ${needKeys.join(', ')}. Run scripts/phase5-setup.sh.` : undefined });
    const pending = pendingSaleReset();
    out.push({ key: 'clean', label: 'No spore left with the buyer by an earlier run', ok: !pending, detail: pending ? `Run ${pending.run} sold spore ${pending.spore}. Use Reset to sell it back.` : undefined });
    if (router && env.OWNER_ACCOUNT_ID) {
      if (!pending) {
        try {
          const pick = await pickForSale(chainViews(router), salePickOpts(env));
          out.push({ key: 'spore', label: `Spore #${pick.spore} ready to sell`, ok: true, detail: pick.reason, pick: { spore: pick.spore, provider: -1 } });
        } catch (e) {
          out.push({ key: 'spore', label: 'A spore with tubes to keep', ok: false, detail: (e as Error).message });
        }
      }
      if (env.BUYER_ACCOUNT_ID) {
        const need = DEFAULT_PRICE + BUYER_MARGIN;
        const funds = await balanceOf(env.BUYER_ACCOUNT_ID).catch(() => null);
        out.push({ key: 'funds', label: 'The buyer can pay', ok: funds !== null && funds >= need, detail: funds === null ? 'Could not read the buyer’s balance.' : `Needs ${Number(need) / 1e24} NEAR, has ${(Number(funds) / 1e24).toFixed(3)} NEAR.` });
      }
    }
    return out;
  };
  return {
    id: 'sale',
    title: 'Sale and control transfer',
    command: (run) => ({ cmd: process.execPath, args: [script, '--run', run] }),
    resetCommand: () => ({ cmd: process.execPath, args: [script, '--reset'] }),
    resetBlocked: () => (pendingSaleReset() ? null : 'Nothing to reset: no spore is with the buyer because of this scene.'),
    logFile: (run) => join(ROOT, 'out/agents', run, 'scene.jsonl'),
    preconditions: () => {
      // A finished run or a Reset changes the answer at once, so it can't wait out the cache.
      const pending = !!pendingSaleReset();
      if (!cache || Date.now() - cache.at > 8_000 || cache.pending !== pending) cache = { at: Date.now(), pending, value: read() };
      return cache.value;
    },
  };
}

if (import.meta.main) {
  const port = Number(process.env.SCENE_PORT ?? DEFAULT_PORT);
  createSceneServer({ scenes: [rogueScene(), saleScene()] }).listen(port, '127.0.0.1', () => {
    console.log(`scene server on http://127.0.0.1:${port} (this machine only)`);
  });
}
