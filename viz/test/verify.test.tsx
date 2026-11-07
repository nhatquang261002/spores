// S10: `/verify` against the 25 real router4 closes (test/fixtures, read from
// testnet) through a fake JSON-RPC node, with the real Rpc, Router, core-wasm
// and renderer wasm. The results must equal `spores-verify` (16 × match and
// `image: match` for spore 5 with docs/phase5-closes.txt).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { ARCHIVAL_RPCS, Rpc, RpcError } from '../src/chain/rpc';
import { Router } from '../src/chain/router';
import { TransactionReceipt } from '../src/components/TransactionReceipt';
import { EpochVerification, SporeVerification } from '../src/components/VerificationResult';
import { overallVerdict, planCloses, progressText, readFailureReason, summaryText, tubeDiff, txFailureReason, type VerifyResult } from '../src/model/verify';
import { parseSporeParam, parseTargetEpoch } from '../src/pages/Verify';
import { hashesFromLog, loadCloseHashes, runVerification, type VerifyDeps } from '../src/sources/verify';
import { useVerify, VerifyProvider } from '../src/state/verify';
import { RenderQueueContext } from '../src/wasm/art';
import { CoreWasm } from '../src/wasm/core';
import { RenderQueue, type WorkerLike } from '../src/wasm/renderQueue';
import { encodeRenderInput, RendererWasm, RGB_LEN } from '../src/wasm/renderer';

const ROUTER = 'spores-hack-router4.testnet';
const ADMIN = 'deployer.spores-hack.testnet';
const fixtures = path.join(__dirname, 'fixtures');
const CLOSES: { hash: string; signer: string; epoch_closed: any }[] = JSON.parse(readFileSync(path.join(fixtures, 'router4-closes.json'), 'utf8'));
const CONFIG = JSON.parse(readFileSync(path.join(fixtures, 'router4-config.json'), 'utf8'));
const PHASE5 = readFileSync(path.join(__dirname, '../../docs/phase5-closes.txt'), 'utf8').split('\n').filter(Boolean);
const CORE_WASM = path.join(process.cwd(), 'public/wasm/spores_core_wasm.wasm');
const RENDERER_WASM = path.join(process.cwd(), 'public/wasm/spores_renderer.wasm');

// As `spores-verify image --spore 5` prints them, and router4's commit.
const COMMIT = {
  epoch: 17,
  state_hash: 'd09c99572178f124ece346c79a5450ec1667e3cfa5a810e26c66ce7e39a83f0b',
  image_hash: 'ac15a3e9eaaac7cedb069c0c677bb534ebbee62e54986c86d5e5586410058cfe',
  renderer_version: 1,
};
const SEED = '1ad5d6a6938bbde23f85a3f43306716784f9f4f70c6ef1bd7f49dfc70ce215d4';

let core: CoreWasm;
let renderer: RendererWasm;
beforeAll(async () => {
  for (const p of [CORE_WASM, RENDERER_WASM]) if (!existsSync(p)) throw new Error(`${p} is missing: run scripts/build-wasm.sh first`);
  core = await CoreWasm.load(readFileSync(CORE_WASM));
  renderer = await RendererWasm.load(readFileSync(RENDERER_WASM));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

interface ChainOptions {
  /** Close events by hash, after any tampering. */
  events?: (ev: any, hash: string) => any;
  tx?: (hash: string, url: string) => { status?: number; body?: unknown } | undefined;
  view?: (method: string, args: any) => { value: unknown } | undefined;
  head?: number;
  headFingerprint?: string;
  commit?: unknown;
}

/** A JSON-RPC node over the real closes. */
function fakeChain(o: ChainOptions = {}) {
  const calls: { method: string; url: string; view?: string; hash?: string }[] = [];
  const head = o.head ?? 26;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body));
    if (method === 'tx') {
      calls.push({ method, url, hash: params.tx_hash });
      const forced = o.tx?.(params.tx_hash, url);
      if (forced) return json(forced.body ?? {}, forced.status ?? 200);
      const c = CLOSES.find((x) => x.hash === params.tx_hash);
      if (!c) return json({ error: { message: 'unknown', cause: { name: 'UNKNOWN_TRANSACTION' } } });
      const ev = (o.events ?? ((e) => e))(structuredClone(c.epoch_closed), c.hash);
      const log = `EVENT_JSON:${JSON.stringify({ standard: 'spores', version: '1.0.0', event: 'epoch_closed', data: [ev] })}`;
      return json({ result: { transaction: { receiver_id: ROUTER, hash: c.hash, signer_id: ADMIN }, status: { SuccessValue: '' }, receipts_outcome: [{ id: 'r', outcome: { logs: [log] } }] } });
    }
    const name = params.method_name;
    const args = JSON.parse(atob(params.args_base64));
    calls.push({ method, url, view: name });
    const forced = o.view?.(name, args);
    const answer = (v: unknown) => json({ result: { result: [...new TextEncoder().encode(JSON.stringify(v))], logs: [] } });
    if (forced) return answer(forced.value);
    switch (name) {
      case 'config':
        return answer(CONFIG);
      case 'admin':
        return answer(ADMIN);
      case 'fingerprint':
        return answer(CLOSES.find((c) => c.epoch_closed.epoch === args.epoch)?.epoch_closed.fingerprint ?? null);
      case 'epoch_info':
        return answer({ epoch: head, started_ns: '0', ends_ns: '9000000000000000000', prev_fingerprint: o.headFingerprint ?? CLOSES.find((c) => c.epoch_closed.epoch === head - 1)?.epoch_closed.fingerprint, active: [], pool: '0', flows: [], rejects: [] });
      case 'image_commit':
        return answer(o.commit === undefined ? COMMIT : o.commit);
      case 'spore_summary':
        return answer({ spore_id: args.spore_id, seed: SEED, age: head - 1 });
      case 'nft_token':
        return answer({ token_id: String(args.token_id), owner_id: 'x', metadata: { title: null, media: 'data:image/svg+xml;utf8,<svg/>', extra: '{}' } });
      case 'nft_total_supply':
        return answer('64');
      default:
        return json({ error: { message: `no view ${name}` } });
    }
  });
  const rpc = new Rpc({ urls: ['https://rpc-a'], archival: 'https://archive', fetch: fetchFn as unknown as typeof fetch, sleep: async () => {}, random: () => 0, attempts: 2 });
  return { router: new Router(rpc, ROUTER), calls, fetchFn };
}

const deps = (router: Router, realRender = false): VerifyDeps => ({
  router,
  core: async () => core,
  render: async (input) => {
    if (!realRender) return { rgb: new Uint8Array(RGB_LEN), imageHash: COMMIT.image_hash, rendererVersion: 1 };
    const { rgb, imageHash } = renderer.render(encodeRenderInput(input));
    return { rgb, imageHash, rendererVersion: 1 };
  },
});

const ALL = CLOSES.map((c) => c.hash);
const row = (r: VerifyResult, e: number) => r.rows.find((x) => x.epoch === e)!;
const hashOf = (e: number) => CLOSES.find((c) => c.epoch_closed.epoch === e)!.hash;
const failing = (r: VerifyResult, e: number) => row(r, e).checks.filter((c) => c.verdict === 'mismatch').map((c) => c.what);

describe('a run against the real closes', () => {
  it('docs/phase5-closes.txt: 16 × Match and the image matches, the same as the CLI', { timeout: 30_000 }, async () => {
    const { router } = fakeChain();
    const r = await runVerification(deps(router, true), { hashes: PHASE5, spore: 5 });
    expect(r.rows).toHaveLength(16);
    expect(r.rows.every((x) => x.verdict === 'match')).toBe(true);
    // The last line of `spores-verify epochs`.
    expect(row(r, 16).replayed).toBe('8b6b2614f402c9bfd88701b0e3bde05b48fc1765ac2d47dcdf2f121bbedec27e');
    expect(r.rows.every((x) => x.tubesListed)).toBe(true);
    expect(r.image).toMatchObject({ verdict: 'match', epoch: 17, age: 16, tubes: 4, reason: null });
    expect(r.image!.state).toEqual({ mine: COMMIT.state_hash, committed: COMMIT.state_hash });
    expect(r.image!.image).toEqual({ mine: COMMIT.image_hash, committed: COMMIT.image_hash });
    // The router is at 26, so the head can't be compared with epoch 16: the CLI skips it too.
    expect(r.head).toEqual({ kind: 'skipped', routerEpoch: 26, lastEpoch: 16 });
    expect(overallVerdict(r)).toBe('match');
    expect(summaryText(r)).toBe('Match · 16/16 epochs · image matches commit');
  });

  it('all 25: later closes are checked by tube count, and the head is compared', async () => {
    const { router } = fakeChain();
    const r = await runVerification(deps(router), { hashes: ALL, spore: null });
    expect(r.rows.map((x) => x.verdict)).toEqual(Array(25).fill('match'));
    expect(row(r, 16).checks.map((c) => c.what)).toContain('tubes');
    expect(row(r, 17).tubesListed).toBe(false);
    expect(row(r, 17).checks.map((c) => c.what)).not.toContain('tubes');
    expect(r.head).toMatchObject({ kind: 'checked', verdict: 'match', epoch: 26 });
    expect(summaryText(r)).toBe('Match · 25/25 epochs');
  });

  it('reports the steps in order', async () => {
    const { router } = fakeChain();
    const seen: string[] = [];
    await runVerification(deps(router), { hashes: PHASE5.slice(0, 2), spore: null }, (p) => seen.push(progressText(p)));
    expect(seen).toEqual(['Fetching close 1 / 2', 'Fetching close 2 / 2', 'Fetching close 2 / 2', 'Replaying', 'Comparing 0 / 2', 'Comparing 1 / 2', 'Comparing 2 / 2']);
  });
});

describe('tampering gives Mismatch', () => {
  const run = (o: ChainOptions, hashes = PHASE5, spore: number | null = null) => runVerification(deps(fakeChain(o).router), { hashes, spore });

  it('a changed flow: that epoch and every later one, because the fingerprints chain', async () => {
    const r = await run({
      events: (ev) => {
        if (ev.epoch === 7) ev.flows[0][2] = String(BigInt(ev.flows[0][2]) * 3n);
        return ev;
      },
    });
    expect(row(r, 6).verdict).toBe('match');
    expect(row(r, 7).verdict).toBe('mismatch');
    expect(failing(r, 7)).toEqual(expect.arrayContaining(['event fingerprint', 'stored fingerprint']));
    expect(r.rows.filter((x) => x.epoch > 7).every((x) => x.verdict === 'mismatch')).toBe(true);
    expect(overallVerdict(r)).toBe('mismatch');
    expect(summaryText(r)).toBe('Mismatch · 6/16 epochs');
  });

  it('a changed event fingerprint: only that row, naming only that check', async () => {
    const r = await run({ events: (ev) => (ev.epoch === 7 ? { ...ev, fingerprint: 'f'.repeat(64) } : ev) });
    expect(failing(r, 7)).toEqual(['event fingerprint']);
    expect(row(r, 7).checks[0]).toMatchObject({ chain: 'f'.repeat(64), replayed: row(r, 7).replayed });
    expect(r.rows.filter((x) => x.verdict === 'mismatch').map((x) => x.epoch)).toEqual([7]);
  });

  it('a changed prev link', async () => {
    const r = await run({ events: (ev) => (ev.epoch === 3 ? { ...ev, prev_fingerprint: '0'.repeat(64) } : ev) });
    expect(failing(r, 3)).toEqual(['prev fingerprint']);
  });

  it('changed tubes, naming the pair', async () => {
    const r = await run({
      events: (ev) => {
        if (ev.epoch === 5) ev.tubes[0][2] = '1';
        return ev;
      },
    });
    expect(failing(r, 5)).toEqual(['tubes']);
    const [a, b] = CLOSES[4].epoch_closed.tubes[0];
    expect(row(r, 5).checks.find((c) => c.what === 'tubes')!.chain).toContain(`${a}-${b}: 1 on chain`);
  });

  it('a changed tube count, including one missing from the event', async () => {
    const more = await run({ events: (ev) => (ev.epoch === 20 ? { ...ev, edges: ev.edges + 1 } : ev) }, ALL);
    expect(failing(more, 20)).toEqual(['tube count']);
    const none = await run({ events: (ev) => (ev.epoch === 20 ? { ...ev, edges: undefined } : ev) }, ALL);
    expect(failing(none, 20)).toEqual(['tube count']);
  });

  it('the stored fingerprint differing or absent', async () => {
    const other = await run({ view: (m, a) => (m === 'fingerprint' && a.epoch === 9 ? { value: 'a'.repeat(64) } : undefined) });
    expect(failing(other, 9)).toEqual(['stored fingerprint']);
    const none = await run({ view: (m, a) => (m === 'fingerprint' && a.epoch === 9 ? { value: null } : undefined) });
    expect(failing(none, 9)).toEqual(['stored fingerprint']);
  });

  it('the router head differing from the replay', async () => {
    const r = await run({ headFingerprint: 'b'.repeat(64) }, ALL);
    expect(r.head).toMatchObject({ kind: 'checked', verdict: 'mismatch', chain: 'b'.repeat(64) });
    expect(overallVerdict(r)).toBe('mismatch');
  });

  it('a tube count that matches but a wrong image or state commit', async () => {
    const image = await run({ commit: { ...COMMIT, image_hash: 'c'.repeat(64) } }, PHASE5, 5);
    expect(image.image).toMatchObject({ verdict: 'mismatch' });
    expect(summaryText(image)).toBe('Mismatch · 16/16 epochs · image differs from commit');
    const state = await run({ commit: { ...COMMIT, state_hash: 'd'.repeat(64) } }, PHASE5, 5);
    expect(state.image!.verdict).toBe('mismatch');
  });

  it('another renderer version is a mismatch that says so', async () => {
    const r = await run({ commit: { ...COMMIT, renderer_version: 2 } }, PHASE5, 5);
    expect(r.image).toMatchObject({ verdict: 'mismatch', reason: 'Committed with renderer v2; this app renders v1.' });
  });
});

describe('what cannot be checked is Unable, with the reason', () => {
  const run = (o: ChainOptions, hashes = PHASE5, spore: number | null = null) => runVerification(deps(fakeChain(o).router), { hashes, spore });

  it('a gap: the epochs before it match, the rest are "missing epoch N"', async () => {
    const r = await run({}, PHASE5.filter((h) => h !== hashOf(7)));
    expect(r.rows.map((x) => x.verdict)).toEqual([...Array(6).fill('match'), ...Array(10).fill('unable')]);
    expect(row(r, 7)).toMatchObject({ reason: 'missing epoch 7', tx: null });
    expect(row(r, 8)).toMatchObject({ reason: 'missing epoch 7', tx: hashOf(8), replayed: null });
    expect(overallVerdict(r)).toBe('unable');
    expect(summaryText(r)).toBe('Unable · 6/16 epochs');
  });

  it('a list that does not start at 1 replays nothing', async () => {
    const r = await run({}, ALL.slice(17));
    expect(r.rows).toHaveLength(25);
    expect(r.rows.every((x) => x.verdict === 'unable' && x.reason === 'missing epoch 1')).toBe(true);
    expect(r.head).toEqual({ kind: 'skipped', routerEpoch: 26, lastEpoch: 0 });
  });

  it('the image needs closes the replay did not reach', async () => {
    const r = await run({}, PHASE5.slice(0, 10), 5);
    expect(r.image).toMatchObject({ verdict: 'unable', epoch: 17 });
    expect(r.image!.reason).toContain('needs closes up to epoch 16, and the replay reached epoch 10');
    expect(overallVerdict(r)).toBe('unable');
  });

  it('no commit', async () => {
    const r = await run({ commit: null }, PHASE5.slice(0, 2), 28);
    expect(r.image).toMatchObject({ verdict: 'unable', reason: 'Spore #28 has no committed image' });
  });

  it('a failing tx: its row is missing, and the block names the tx and why', async () => {
    const bad = hashOf(16);
    const r = await run({ tx: (h) => (h === bad ? { status: 429 } : undefined) });
    expect(r.failed).toEqual([{ tx: bad, reason: 'archival rate limit' }]);
    expect(r.rows).toHaveLength(16);
    expect(row(r, 16)).toMatchObject({ verdict: 'unable', reason: 'missing epoch 16' });
    expect(row(r, 15).verdict).toBe('match');
  });

  it('reasons: archival rate limit, missing tx, RPC down', () => {
    const limited = new RpcError('https://archive', 'http 429', 'retryable');
    const unknown = new RpcError('https://archive', 'unknown', 'rpc', 'UNKNOWN_TRANSACTION');
    const down = new RpcError('https://archive', 'timeout after 20000 ms', 'retryable');
    const gone = new RpcError('https://rpc-a', 'unknown', 'rpc', 'UNKNOWN_TRANSACTION');
    // A rate limit stays a rate limit though the regular node says "unknown": it has dropped old txs.
    expect(txFailureReason(limited, gone)).toBe('archival rate limit');
    expect(txFailureReason(unknown, gone)).toBe('missing tx: the node does not have it');
    expect(txFailureReason(null, gone)).toBe('missing tx: the node does not have it');
    expect(txFailureReason(down, gone)).toBe('RPC down: https://archive: timeout after 20000 ms');
    // A 429 without a CORS header reaches the page as this, so it must not be called either one.
    const blocked = new RpcError('https://archive', 'Failed to fetch', 'retryable');
    expect(txFailureReason(blocked, gone)).toBe('archival node unreachable or rate-limited: the browser cannot tell which');
    expect(readFailureReason(new RpcError('https://rpc-a', 'Failed to fetch', 'retryable'))).toBe('https://rpc-a unreachable or rate-limited: the browser cannot tell which');
  });

  it('a tx sent elsewhere, a failed tx, a tx with no event', async () => {
    const [a, b, c] = PHASE5;
    const r = await run({
      tx: (h) => {
        if (h === a) return { body: { result: { transaction: { receiver_id: 'other.testnet' }, receipts_outcome: [] } } };
        if (h === b) return { body: { result: { transaction: { receiver_id: ROUTER }, status: { Failure: { x: 1 } }, receipts_outcome: [] } } };
        if (h === c) return { body: { result: { transaction: { receiver_id: ROUTER }, status: {}, receipts_outcome: [] } } };
        return undefined;
      },
    }, [a, b, c]);
    expect(r.failed.map((f) => f.reason).sort()).toEqual(['no epoch_closed event', `the tx failed: {"x":1}`, `was sent to other.testnet, not ${ROUTER}`].sort());
  });

  it('two closes for one epoch', async () => {
    const r = await run({ events: (ev, h) => (h === hashOf(4) ? { ...ev, epoch: 3 } : ev) });
    expect(row(r, 3)).toMatchObject({ verdict: 'unable', reason: 'two closes for epoch 3' });
    expect(row(r, 2).verdict).toBe('match');
  });

  it('a fingerprint view that cannot be read leaves that row Unable, not Match', async () => {
    const { router, fetchFn } = fakeChain();
    const real = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.params.method_name === 'fingerprint' && JSON.parse(atob(body.params.args_base64)).epoch === 4) return new Response('', { status: 503 });
      return real(url, init);
    });
    const r = await runVerification(deps(router), { hashes: PHASE5, spore: null });
    expect(row(r, 4).verdict).toBe('unable');
    expect(row(r, 4).reason).toContain('RPC down: https://rpc-a: http 503');
    expect(row(r, 5).verdict).toBe('match');
  });

  it('input the replay refuses: every row says so', async () => {
    const r = await run({ events: (ev) => (ev.epoch === 2 ? { ...ev, active: undefined } : ev) });
    expect(r.replayError).toContain('active');
    expect(r.rows.every((x) => x.verdict === 'unable' && x.reason === r.replayError)).toBe(true);
  });

  it('no config stops the run, and no list is refused', async () => {
    await expect(run({ view: (m) => { if (m === 'config') throw new Error('x'); return undefined; } })).rejects.toThrow();
    await expect(run({}, [])).rejects.toThrow('no close_epoch transactions');
  });
});

describe('nothing is cached as verified', () => {
  it('a poisoned close cache is not read; each run fetches every tx again', async () => {
    for (const c of CLOSES) localStorage.setItem(`spores.close.v1.${c.hash}`, JSON.stringify({ ...c.epoch_closed, fingerprint: 'e'.repeat(64) }));
    const { router, calls } = fakeChain();
    const first = await runVerification(deps(router), { hashes: PHASE5, spore: null });
    expect(first.rows.every((x) => x.verdict === 'match')).toBe(true);
    expect(calls.filter((c) => c.method === 'tx')).toHaveLength(16);
    await runVerification(deps(router), { hashes: PHASE5, spore: null });
    expect(calls.filter((c) => c.method === 'tx')).toHaveLength(32);
    expect(calls.filter((c) => c.view === 'fingerprint')).toHaveLength(32);
  });

  it('close txs go to the archival node and views to the regular ones', async () => {
    const { router, calls } = fakeChain();
    await runVerification(deps(router), { hashes: PHASE5.slice(0, 3), spore: null });
    expect(new Set(calls.filter((c) => c.method === 'tx').map((c) => c.url))).toEqual(new Set(['https://archive']));
    expect(new Set(calls.filter((c) => c.view).map((c) => c.url))).toEqual(new Set(['https://rpc-a']));
  });

  it('a limit on one archival node moves to the next', async () => {
    expect(ARCHIVAL_RPCS.length).toBeGreaterThan(1);
    const seen: string[] = [];
    const rpc = new Rpc({
      urls: ['https://rpc-a'],
      sleep: async () => {},
      random: () => 0,
      fetch: (async (url: string) => {
        seen.push(url);
        return url === ARCHIVAL_RPCS[0] ? new Response('', { status: 429 }) : new Response(JSON.stringify({ result: { ok: true } }));
      }) as unknown as typeof fetch,
    });
    await expect(rpc.call('tx', {}, rpc.archivalUrls)).resolves.toEqual({ ok: true });
    expect(seen).toEqual([ARCHIVAL_RPCS[0], ARCHIVAL_RPCS[1]]);
  });

  it('`fresh` renders in a worker though the cache has the image, and refreshes the cache', async () => {
    const stored = new Map<string, { rgb: Uint8Array; imageHash: string }>();
    const posted: number[] = [];
    const worker = (): WorkerLike => {
      const w: WorkerLike = {
        onmessage: null,
        onerror: null,
        terminate() {},
        postMessage(m) {
          posted.push(m.id);
          queueMicrotask(() => w.onmessage?.({ data: { id: m.id, ok: true, rgb: new Uint8Array(3), imageHash: 'real', ms: 1 } }));
        },
      };
      return w;
    };
    const q = new RenderQueue({ createWorker: worker, rendererVersion: 1, cache: { get: async (k) => stored.get(k), put: async (k, v) => void stored.set(k, v) } });
    const input = { seed: SEED, age: 1, edges: [] };
    await q.request(input);
    expect(posted).toHaveLength(1);
    const key = [...stored.keys()][0];
    stored.set(key, { rgb: new Uint8Array(3), imageHash: 'poisoned' });
    expect((await q.request(input)).imageHash).toBe('poisoned');
    expect(posted).toHaveLength(1);
    const fresh = await q.request(input, { fresh: true });
    expect(fresh).toMatchObject({ imageHash: 'real', source: 'worker' });
    expect(posted).toHaveLength(2);
    expect(stored.get(key)!.imageHash).toBe('real');
  });
});

describe('close hashes', () => {
  const log = [
    '{"kind":"tx","method":"close_epoch","hash":"A","ok":true}',
    '{"kind":"tx","method":"close_epoch","hash":"B","ok":false}',
    '{"kind":"tx","method":"settle","hash":"C","ok":true}',
    'not json',
    '',
    '{"kind":"tx","method":"close_epoch","hash":"D","ok":true}',
  ].join('\n');

  it('reads only successful close_epoch lines and counts what it could not read', () => {
    expect(hashesFromLog(log)).toEqual({ hashes: ['A', 'D'], unreadable: 1 });
  });

  const serve = (files: Record<string, string>) => (async (u: string) => (files[u] !== undefined ? new Response(files[u]) : new Response('', { status: 404 }))) as unknown as typeof fetch;

  it('LIVE: the app’s list, comments skipped', async () => {
    const r = await loadCloseHashes({ kind: 'live', network: 'testnet', router: ROUTER }, ROUTER, serve({ [`/closes/${ROUTER}.txt`]: '# note\nA\nB\nA\n' }));
    expect(r).toMatchObject({ router: ROUTER, hashes: ['A', 'B'], from: [{ label: 'the close list', url: `/closes/${ROUTER}.txt`, count: 3 }] });
  });

  it('a run: its router’s list then its own log, deduplicated, because the replay starts at epoch 1', async () => {
    const r = await loadCloseHashes({ kind: 'run', run: 'x' }, null, serve({ '/runs/x/run.json': JSON.stringify({ router: ROUTER }), '/runs/x/events.jsonl': log, [`/closes/${ROUTER}.txt`]: 'Z\nA\n' }));
    expect(r.hashes).toEqual(['Z', 'A', 'D']);
    expect(r.from.map((f) => f.label)).toEqual(['the close list', 'the agents’ log']);
    expect(r.unreadableLines).toBe(1);
  });

  it('a run with no list for its router uses its log alone; one naming no router is an error', async () => {
    const r = await loadCloseHashes({ kind: 'recorded', run: 'x', date: '' }, null, serve({ '/recorded/x/run.json': JSON.stringify({ router: 'other.testnet' }), '/recorded/x/events.jsonl': log }));
    expect(r).toMatchObject({ router: 'other.testnet', hashes: ['A', 'D'], from: [{ label: 'the recording', count: 2 }] });
    await expect(loadCloseHashes({ kind: 'run', run: 'x' }, null, serve({ '/runs/x/run.json': '{}', '/runs/x/events.jsonl': '' }))).rejects.toThrow('names no router');
  });
});

describe('small model pieces', () => {
  it('plans: a failure at the end of the list still gets a row', () => {
    const c = (epoch: number) => ({ tx: `t${epoch}`, ev: { epoch } as any });
    expect(planCloses([c(1), c(2)], 3, 1)).toMatchObject({ last: 3, gap: { epoch: 3, reason: 'missing epoch 3' } });
    expect(planCloses([c(1), c(2)], 2, 0)).toMatchObject({ last: 2, gap: null });
  });

  it('tube diff compares values as text, in any order', () => {
    expect(tubeDiff([[1, 2, 5], [3, 4, '9']], [[3, 4, 9], [1, 2, '5']])).toEqual([]);
    expect(tubeDiff([[1, 2, '5']], [[3, 4, '9']])).toEqual(['1-2: 5 on chain, none replayed', '3-4: none on chain, 9 replayed']);
  });

  it('url params', () => {
    expect(parseSporeParam(null)).toBe(5);
    expect(parseSporeParam('12')).toBe(12);
    expect(parseSporeParam('')).toBe(null);
    expect(parseTargetEpoch('16')).toBe(16);
    expect(parseTargetEpoch('0')).toBe(null);
    expect(parseTargetEpoch('x')).toBe(null);
  });
});

// --- the page ---------------------------------------------------------------

const LIST = `/closes/${ROUTER}.txt`;

function serveApp(list: string | null, extra: Record<string, string> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string) => {
      const url = String(u);
      if (url === '/wasm/spores_core_wasm.wasm') return new Response(readFileSync(CORE_WASM));
      if (url === LIST && list !== null) return new Response(list);
      if (extra[url] !== undefined) return new Response(extra[url]);
      return new Response('', { status: 404 });
    }),
  );
}

function fakeQueue(imageHash = COMMIT.image_hash) {
  const request = vi.fn(async () => ({ rgb: new Uint8Array(RGB_LEN), imageHash, source: 'worker', rendererVersion: 1 }));
  return { request } as unknown as RenderQueue & { request: typeof request };
}

async function mountApp(url: string, o: ChainOptions = {}, queue = fakeQueue()) {
  const { router, calls } = fakeChain(o);
  await act(async () => {
    render(
      <RenderQueueContext.Provider value={async () => queue}>
        <MemoryRouter initialEntries={[url]}>
          <App router={router} />
        </MemoryRouter>
      </RenderQueueContext.Provider>,
    );
  });
  return { router, calls, queue };
}

const runButton = () => screen.findByRole('button', { name: 'Run verification' });

describe('/verify', () => {
  it('before a run: says what will be checked and from where, and has read no close', async () => {
    serveApp(PHASE5.join('\n'));
    const { calls } = await mountApp('/verify');
    await screen.findByText(/Every epoch fingerprint of/);
    const header = screen.getByText(/Every epoch fingerprint of/);
    expect(header.textContent).toBe(`Every epoch fingerprint of ${ROUTER} from epoch 1, and the committed image of Spore #5.`);
    expect(screen.getByRole('link', { name: 'the close list' }).getAttribute('href')).toBe(LIST);
    expect(screen.getByText('Not run yet')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'tx')).toEqual([]);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('with the chain out of reach it says Unable, never a failed check, and names the endpoint', async () => {
    serveApp(PHASE5.join('\n'));
    const { router } = await mountApp('/verify');
    (router as any).config = async () => {
      throw new Error('https://rpc.example: Failed to fetch');
    };
    fireEvent.click(await runButton());
    const line = await screen.findByText(/Nothing was checked/, {}, { timeout: 10_000 });
    expect(line.textContent).toContain('Unable');
    expect(line.textContent).toContain('says nothing about the run either way');
    expect(screen.getByText(/rpc\.example: Failed to fetch/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/Mismatch/)).toBeNull();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
  });

  it('Run: 16 × Match, the image section and the footer; a second click recomputes', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    serveApp(PHASE5.join('\n'));
    const { calls, queue } = await mountApp('/verify');
    fireEvent.click(await runButton());
    await screen.findByRole('table', {}, { timeout: 10_000 });
    const rows = within(screen.getByRole('table')).getAllByRole('button', { name: /^Epoch \d+: Match/ });
    expect(rows).toHaveLength(16);
    expect(screen.getAllByText(/Match · 16\/16 epochs · image matches commit/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Every epoch fingerprint of/).textContent).toContain('from epoch 1 to 16, and the committed image of Spore #5');
    expect(screen.getByRole('region', { name: 'Image check' }).textContent).toContain(COMMIT.state_hash);
    expect(screen.getByRole('region', { name: 'Image check' }).textContent).toContain('this app v1, committed v1');
    expect(screen.getByRole('img', { name: /Spore #5 at epoch 17, as this browser rendered it/ })).toBeTruthy();
    expect(screen.getByAltText(/On-chain glyph of Spore #5/)).toBeTruthy();
    expect(screen.getByText(/Verification ran in your browser using the same core code as the contract/)).toBeTruthy();
    expect(screen.getByText(/It did not check: anything not listed above, including epochs 17 to 25/)).toBeTruthy();
    expect(screen.getByText(/not compared\. The contract is at epoch 26; the replay reached epoch 16/)).toBeTruthy();
    expect(queue.request).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fresh: true }));
    const before = calls.filter((c) => c.method === 'tx').length;
    expect(before).toBe(16);
    fireEvent.click(await runButton());
    await waitFor(() => expect(calls.filter((c) => c.method === 'tx').length).toBe(32), { timeout: 10_000 });
    await waitFor(() => expect(queue.request).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    // React reports duplicate keys and the like here.
    expect(consoleError.mock.calls.map((c) => String(c[0]))).toEqual([]);
    consoleError.mockRestore();
  });

  it('a tampered event shows ✕ Mismatch, and its row expands to both values', async () => {
    serveApp(PHASE5.join('\n'));
    await mountApp('/verify?spore=', { events: (ev) => (ev.epoch === 7 ? { ...ev, fingerprint: 'f'.repeat(64) } : ev) });
    fireEvent.click(await runButton());
    const toggle = await screen.findByRole('button', { name: /^Epoch 7: Mismatch/ }, { timeout: 10_000 });
    expect(screen.getAllByText(/Mismatch · 15\/16 epochs/).length).toBeGreaterThan(0);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByText(`on chain ${'f'.repeat(64)}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Epoch 8: Match/ })).toBeTruthy();
  });

  it('a missing epoch shows ! Unable with the reason', async () => {
    serveApp(PHASE5.filter((h) => h !== hashOf(7)).join('\n'));
    await mountApp('/verify?spore=');
    fireEvent.click(await runButton());
    await screen.findByRole('button', { name: /^Epoch 7: Unable/ }, { timeout: 10_000 });
    expect(screen.getAllByText('missing epoch 7').length).toBe(10);
    expect(screen.getAllByText(/Unable · 6\/16 epochs/).length).toBeGreaterThan(0);
  });

  it('a close that fails is named, with its reason', async () => {
    serveApp(PHASE5.join('\n'));
    const bad = hashOf(16);
    await mountApp('/verify?spore=', { tx: (h) => (h === bad ? { status: 429 } : undefined) });
    fireEvent.click(await runButton());
    const block = await screen.findByRole('region', { name: 'Close txs that could not be used' }, { timeout: 10_000 });
    expect(block.textContent).toContain('1 close tx of 16 could not be used');
    expect(block.textContent).toContain('archival rate limit');
  });

  it('?epoch=N opens that row, and says why the whole chain runs', async () => {
    serveApp(PHASE5.join('\n'));
    await mountApp('/verify?epoch=5&spore=');
    expect(await screen.findByText(/Opened for epoch 5\. It is checked as part of the whole chain/)).toBeTruthy();
    fireEvent.click(await runButton());
    const toggle = await screen.findByRole('button', { name: /^Epoch 5: Match/ }, { timeout: 10_000 });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.closest('tr')!.className).toContain('is-target');
    expect(screen.getByRole('button', { name: /^Epoch 4: Match/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('link', { name: /opens the explorer/ }).getAttribute('href')).toContain(hashOf(5));
  });

  it('?epoch=N past the list says it was not checked', async () => {
    serveApp(PHASE5.join('\n'));
    await mountApp('/verify?epoch=20&spore=');
    fireEvent.click(await runButton());
    expect(await screen.findByText(/this run reached epoch 16, so it did not check it/, {}, { timeout: 10_000 })).toBeTruthy();
  });

  it('the spore field sets what the header promises and the run checks; empty means epochs only', async () => {
    serveApp(PHASE5.slice(0, 2).join('\n'));
    await mountApp('/verify', { commit: null });
    const input = await screen.findByRole('textbox', { name: 'Spore' });
    fireEvent.change(input, { target: { value: '28' } });
    expect(screen.getByText(/the committed image of Spore #28/)).toBeTruthy();
    fireEvent.click(await runButton());
    const image = await screen.findByRole('region', { name: 'Image check' }, { timeout: 10_000 });
    expect(image.textContent).toContain('Spore #28 has no committed image');
    expect(screen.getAllByText(/Unable · 2\/2 epochs · image not checked/).length).toBeGreaterThan(0);
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByText(/the committed image of/)).toBeNull();
    expect(screen.getByText('No spore: epochs only.')).toBeTruthy();
  });

  it('no list for the router: says what would fill it, and Run is disabled', async () => {
    serveApp(null);
    await mountApp('/verify');
    expect(await screen.findByText('No close hashes for this router')).toBeTruthy();
    expect(((await runButton()) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a list that cannot be read is an error with Retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await mountApp('/verify');
    expect((await screen.findByRole('alert')).textContent).toContain('the close hashes');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('config unreadable: nothing was checked, an error with Retry, no result words', async () => {
    serveApp(PHASE5.join('\n'));
    const { router, fetchFn } = fakeChain();
    const real = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return body.params.method_name === 'config' ? new Response('', { status: 503 }) : real(url, init);
    });
    await act(async () => {
      render(
        <RenderQueueContext.Provider value={async () => fakeQueue()}>
          <MemoryRouter initialEntries={['/verify']}>
            <App router={router} />
          </MemoryRouter>
        </RenderQueueContext.Provider>,
      );
    });
    fireEvent.click(await runButton());
    const alert = await screen.findByRole('alert', {}, { timeout: 10_000 });
    expect(alert.textContent).toContain('this verification');
    expect(screen.queryByText(/Match ·/)).toBeNull();
  });

  it('LOCAL RUN: hashes from the list and the log, both badges, chain reads on the run’s router', async () => {
    serveApp(PHASE5.slice(0, 2).join('\n'), {
      '/runs/x/run.json': JSON.stringify({ router: ROUTER }),
      '/runs/x/events.jsonl': `{"method":"close_epoch","hash":"${PHASE5[2]}","ok":true}\n`,
    });
    await mountApp('/verify?source=run&run=x&spore=');
    await screen.findByText(/Every epoch fingerprint/);
    expect(screen.getByText('the agents’ log')).toBeTruthy();
    expect(screen.getAllByText('LOCAL RUN').length).toBeGreaterThan(0);
    expect(screen.getByText(/Chain reads:/).textContent).toContain('LIVE');
    fireEvent.click(await runButton());
    await screen.findByRole('button', { name: /^Epoch 3: Match/ }, { timeout: 10_000 });
  });

  it('the simulation has nothing to verify', async () => {
    serveApp(null);
    await mountApp('/verify?source=sim');
    expect(screen.getByText('The simulation has no chain to verify')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run verification' })).toBeNull();
  });

  it('a result is forgotten on reload: a new mount starts at Not run yet', async () => {
    serveApp(PHASE5.slice(0, 2).join('\n'));
    await mountApp('/verify?spore=');
    fireEvent.click(await runButton());
    await screen.findByRole('table', {}, { timeout: 10_000 });
    cleanup();
    await mountApp('/verify?spore=');
    expect(await screen.findByText('Not run yet')).toBeTruthy();
  });
});

describe('receipts link to Verify (Design §5.1)', () => {
  const base = { tx: 'T', evidence: 'confirmed', event: 'x', signer: null, block: null };
  const show = (logged: any) =>
    render(
      <MemoryRouter>
        <TransactionReceipt logged={logged} fallbackEpoch={null} q="" />
      </MemoryRouter>,
    );

  it('an image commit opens that spore, a close opens that epoch', () => {
    show({ ...base, kind: 'image', epoch: 17, spore: 5, stateHash: 'a', imageHash: 'b', rendererVersion: 1 });
    expect(screen.getByRole('link', { name: 'Verify →' }).getAttribute('href')).toBe('/verify?spore=5');
    cleanup();
    show({ ...base, kind: 'close', epoch: 16, fingerprint: 'f', flows: 1, tubes: 1 });
    expect(screen.getByRole('link', { name: 'Verify →' }).getAttribute('href')).toBe('/verify?epoch=16');
  });
});

describe('VerificationResult compact', () => {
  function Runner({ spore }: { spore: number | null }) {
    const { start } = useVerify();
    return <button onClick={() => start(spore)}>go</button>;
  }

  async function mountCompact(o: ChainOptions = {}, list = PHASE5) {
    serveApp(list.join('\n'));
    const { router } = fakeChain(o);
    await act(async () => {
      render(
        <RenderQueueContext.Provider value={async () => fakeQueue()}>
          <MemoryRouter>
            <VerifyProvider source={{ kind: 'live', network: 'testnet', router: ROUTER }} router={router}>
              <Runner spore={null} />
              <EpochVerification epoch={5} q="" />
              <SporeVerification spore={5} hasCommit q="" />
              <SporeVerification spore={9} hasCommit={false} q="" />
            </VerifyProvider>
          </MemoryRouter>
        </RenderQueueContext.Provider>,
      );
    });
  }

  it('a close row says Verify → until a run reaches it, then that epoch’s word', async () => {
    await mountCompact();
    expect(screen.getByRole('link', { name: 'Verify →' }).getAttribute('href')).toBe('/verify?epoch=5');
    fireEvent.click(screen.getByText('go'));
    const link = await screen.findByRole('link', { name: 'Epoch 5: Match. Details' }, { timeout: 10_000 });
    expect(link.getAttribute('href')).toBe('/verify?epoch=5');
  });

  it('a close row shows a mismatch as a mismatch', async () => {
    await mountCompact({ events: (ev) => (ev.epoch === 5 ? { ...ev, fingerprint: 'f'.repeat(64) } : ev) });
    fireEvent.click(screen.getByText('go'));
    expect(await screen.findByRole('link', { name: 'Epoch 5: Mismatch. Details' }, { timeout: 10_000 })).toBeTruthy();
  });

  it('the Spore page: the button runs it, then the verdict with Details; no commit is — with the reason', async () => {
    await mountCompact();
    expect(screen.getByText(/unavailable: Spore #9 has no committed image/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Verify this image' }));
    expect(await screen.findByText(/Match · 16\/16 epochs · image matches commit/, {}, { timeout: 10_000 })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Details' }).getAttribute('href')).toBe('/verify?spore=5');
  });

  it('a run for another spore leaves this one’s button, so its verdict is never borrowed', async () => {
    await mountCompact();
    fireEvent.click(screen.getByText('go'));
    await screen.findByRole('link', { name: 'Epoch 5: Match. Details' }, { timeout: 10_000 });
    expect(screen.getByRole('button', { name: 'Verify this image' })).toBeTruthy();
    expect(screen.queryByText(/image matches commit/)).toBeNull();
  });
});
