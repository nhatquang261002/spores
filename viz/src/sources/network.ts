// Loads the Network explorer's history for the current source (Design §6.C).
//
// LIVE: the bulk views (`config`, `epoch_info`, `nft_tokens`, `edges`) give
// the epoch in progress at once. Past tube sets are only in `epoch_closed`
// logs (Design §1.7), so the close txs listed in `/closes/<router>.txt` (a
// copy of `docs/<router>-closes.txt`, the same list `spores-verify` takes) are
// fetched one by one, and every close since epoch 1 is replayed with
// core-wasm, as `verify` does. Closes the list doesn't have stay unknown.
//
// LOCAL RUN / RECORDED: the run's epoch snapshots (tubes, R and policy as the
// keeper read them) and its event log (every step, Reference C).
import type { Router, RouterConfig, SporeToken } from '../chain/router';
import { epochClosed, type EpochClosed } from '../chain/events';
import { emptyFrame, pairKey, tubesFromTuples, type Frame, type NetworkHistory, type PairKey } from '../model/network';
import { runFlows, runRejects, stepsFromRunLog, type RawDecision, type RawEvent, type Step } from '../model/steps';
import type { Source } from '../model/types';
import { paletteOf } from '../ui/tokens';
import type { CoreWasm, ReplayEpoch } from '../wasm/core';
import { listRunDir, RunFiles, runFiles, SourceFileError } from './run';
import { recordedFiles, recordedManifest } from './recorded';

/** What the map knows about each spore now (not per epoch): identity and market state. */
export interface NetworkSpore {
  id: number;
  seed: string;
  palette: number;
  owner: string | null;
  listedPrice: string | null;
  /** null when the source has no policy (LIVE bulk views). */
  paused: boolean | null;
  active: boolean;
  glyph: string | null;
  age: number | null;
}

/** Per-epoch figures a run snapshot carries, by frame epoch then spore. */
export type SnapshotFigures = Map<number, Map<number, { balance: string; allowance: string; paused: boolean; operator: string | null }>>;

export interface CloseProgress {
  /** Closes in the close list. */
  listed: number;
  /** Fetched so far. */
  loaded: number;
  error: Error | null;
  listUrl: string | null;
}

export interface NetworkData {
  history: NetworkHistory;
  spores: Map<number, NetworkSpore>;
  /** Every step of the run (LOCAL RUN / RECORDED); null for LIVE. */
  steps: Step[] | null;
  figures: SnapshotFigures | null;
  /** When the base views were read (ms). */
  readAt: number;
  closes: CloseProgress;
  /** ↻ The replayed tubes after the last close against `edges()` (LIVE); null when not compared. */
  edgesCheck: 'match' | 'mismatch' | null;
}

// --- LIVE -------------------------------------------------------------------

export interface LiveBase {
  config: RouterConfig;
  info: Awaited<ReturnType<Router['epochInfo']>>;
  tokens: SporeToken[];
  edges: [number, number, string][];
  readAt: number;
}

/** The bulk views, bracketed by `epoch_info` so the tubes and the epoch belong together. */
export async function loadLiveBase(router: Router, attempts = 3): Promise<LiveBase> {
  const config = await router.config();
  for (let i = 0; i < attempts; i++) {
    const before = await router.epochInfo();
    const [tokens, edges] = await Promise.all([router.allTokens(16), router.edges()]);
    const info = await router.epochInfo();
    if (before.epoch === info.epoch) return { config, info, tokens, edges, readAt: Date.now() };
  }
  throw new Error(`an epoch closed during each of ${attempts} reads of the network; retry`);
}

export function sporesFromTokens(tokens: SporeToken[]): Map<number, NetworkSpore> {
  const m = new Map<number, NetworkSpore>();
  for (const t of tokens) {
    m.set(t.id, {
      id: t.id,
      seed: t.extra.seed,
      palette: paletteOf(t.extra.seed).idx,
      owner: t.owner_id,
      listedPrice: t.extra.listed_price,
      paused: null,
      active: t.extra.active,
      glyph: t.glyph,
      age: t.extra.age,
    });
  }
  return m;
}

/** History with only the epoch in progress: tubes from `edges()`, R from the tokens, flows so far. */
export function historyFromLiveBase(b: LiveBase): NetworkHistory {
  const live: Frame = {
    ...emptyFrame(b.info.epoch, 'live'),
    tubes: tubesFromTuples(b.edges),
    tubesFrom: 'edges',
    flows: b.info.flows.map(([a, x, amt]) => [a, x, String(amt)]),
    rejects: b.info.rejects,
    active: b.info.active,
    reputation: new Map(b.tokens.filter((t) => t.extra.active).map((t) => [t.id, t.extra.reputation])),
    fingerprint: b.info.prev_fingerprint,
    flowsFrom: 'chain',
  };
  return { frames: new Map(), current: b.info.epoch, live, dMin: Number(b.config.d_min) };
}

/** One close event → its frame (flows, rejects, active, fingerprint; tubes when the event carries them, router4 epochs 1–16). */
export function frameFromClose(ev: EpochClosed, tx: string): Frame {
  return {
    ...emptyFrame(ev.epoch),
    tubes: ev.tubes ? tubesFromTuples(ev.tubes) : null,
    tubesFrom: ev.tubes ? 'event' : null,
    flows: ev.flows.map(([a, b, amt]) => [a, b, String(amt)]),
    rejects: ev.rejects,
    active: ev.active,
    close: { tx, fetched: true },
    fingerprint: ev.fingerprint,
    flowsFrom: 'chain',
  };
}

export const sameTubes = (a: Map<PairKey, number>, b: Map<PairKey, number>) => a.size === b.size && [...a].every(([k, d]) => b.get(k) === d);

/**
 * Replays the consecutive closes from epoch 1 (core-wasm, `spores_core::close_epoch`)
 * and fills in each frame's tubes and R. The replay must reproduce each
 * event's fingerprints and, where the event carries them, its tubes (↻).
 * Stops at the first gap. Returns the number of epochs replayed.
 */
export function applyReplay(h: NetworkHistory, events: Map<number, EpochClosed>, core: CoreWasm, config: RouterConfig): number {
  const run: ReplayEpoch[] = [];
  for (let e = 1; events.has(e); e++) {
    const ev = events.get(e)!;
    run.push({ epoch: e, prev_fingerprint: ev.prev_fingerprint, active: ev.active, flows: ev.flows, rejects: ev.rejects, pool: ev.pool });
  }
  if (!run.length) return 0;
  for (const r of core.replay(config, run)) {
    const f = h.frames.get(r.epoch);
    if (!f) continue;
    const tubes = tubesFromTuples(r.tubes);
    const ev = events.get(r.epoch)!;
    // Event tubes (router4 epochs 1–16) are kept and must match; anything else (edges(), nothing) gives way to the replay.
    const eventTubes = f.tubesFrom === 'event' ? f.tubes : null;
    const ok = r.fingerprint === ev.fingerprint && r.prev_fingerprint === ev.prev_fingerprint && (!eventTubes || sameTubes(eventTubes, tubes));
    f.replay = ok ? 'match' : 'mismatch';
    if (!eventTubes) {
      f.tubes = tubes;
      f.tubesFrom = 'replay';
    }
    f.reputation = new Map(r.reputation.map(([id, rep]) => [id, Number(rep)]));
  }
  return run.length;
}

/** `/closes/<router>.txt`: one close tx hash per line (blank lines and `#` comments skipped). Missing = no list. */
export async function loadCloseList(router: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<{ url: string; hashes: string[] } | null> {
  const url = `${import.meta.env?.BASE_URL ?? '/'}closes/${encodeURIComponent(router)}.txt`;
  const res = await fetchFn(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new SourceFileError(url, res.status, `${url}: http ${res.status}`);
  const text = await res.text();
  // The dev server answers unknown paths with index.html.
  if (/^\s*</.test(text)) return null;
  return { url, hashes: text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) };
}

const CACHE = 'spores.close.v1.';

/** A final tx that may be old: archival first (other nodes drop old txs), then the regular endpoints. */
export async function fetchOldTx(rpc: Router['rpc'], hash: string, signer: string): Promise<any> {
  const params = { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' };
  try {
    return rpc.archivalUrls?.length ? await rpc.call('tx', params, rpc.archivalUrls) : await rpc.call('tx', params);
  } catch {
    return await rpc.call('tx', params);
  }
}

/** A close tx's `epoch_closed`, from localStorage (final txs never change) or RPC, archival first (other nodes drop old txs). */
export async function fetchClose(router: Router, hash: string, signer: string): Promise<EpochClosed> {
  try {
    const hit = localStorage.getItem(CACHE + hash);
    if (hit) return JSON.parse(hit) as EpochClosed;
  } catch {
    // storage blocked: fetch it
  }
  const tx = await fetchOldTx(router.rpc, hash, signer);
  if (tx?.transaction?.receiver_id !== router.id) throw new Error(`tx ${hash} was sent to ${tx?.transaction?.receiver_id}, not ${router.id}`);
  const ev = epochClosed(tx);
  if (!ev) throw new Error(`tx ${hash} has no epoch_closed event`);
  try {
    localStorage.setItem(CACHE + hash, JSON.stringify(ev));
  } catch {
    // full or blocked: it is fetched again next time
  }
  return ev;
}

/** Live-frame update from a newer `epoch_info` of the same epoch: the flows and rejects settled so far. */
export function withLiveFlows(h: NetworkHistory, info: { epoch: number; flows: [number, number, string][]; rejects: [number, number, number][] }): NetworkHistory {
  if (info.epoch !== h.current) return h;
  return { ...h, live: { ...h.live, flows: info.flows.map(([a, b, amt]) => [a, b, String(amt)]), rejects: info.rejects } };
}

/** New or larger flows and new rejects between two polls of the same epoch: settlements confirmed since the last poll. */
export function newSettlements(
  before: { flows: [number, number, string][] | null; rejects: [number, number, number][] | null },
  after: { flows: [number, number, string][] | null; rejects: [number, number, number][] | null },
): { settled: [number, number, string][]; rejected: [number, number][] } {
  const old = new Map((before.flows ?? []).map(([a, b, amt]) => [pairKey(a, b), BigInt(amt)]));
  const settled: [number, number, string][] = [];
  for (const [a, b, amt] of after.flows ?? []) {
    const d = BigInt(amt) - (old.get(pairKey(a, b)) ?? 0n);
    if (d > 0n) settled.push([a, b, d.toString()]);
  }
  const oldRej = new Map((before.rejects ?? []).map(([a, b, n]) => [pairKey(a, b), n]));
  const rejected: [number, number][] = [];
  for (const [a, b, n] of after.rejects ?? []) if (n > (oldRej.get(pairKey(a, b)) ?? 0)) rejected.push([a, b]);
  return { settled, rejected };
}

// --- LOCAL RUN / RECORDED ---------------------------------------------------

export interface SnapshotFile {
  epoch: number;
  fingerprint: string;
  epoch_info: { epoch: number; active: number[] };
  edges: [number, number, string | number][];
  spores: Record<
    string,
    {
      render_input: { spore_id: number; seed: string; age: number };
      reputation: string | number;
      balance: string;
      owner_id: string;
      operator_id: string | null;
      policy: { paused: boolean };
      effective_budget: string;
      listed_price: string | null;
    }
  >;
}

interface RunJson {
  start_epoch?: number;
  config?: { d_min?: string };
}

/**
 * A run's history. Snapshot `epoch-K.json` was read after the close of K − 1,
 * so it gives frame K − 1 (tubes, R); the last snapshot is also the run's end
 * frame. Flows and rejects come from the run log's settle and reject txs.
 */
export function historyFromRun(snaps: SnapshotFile[], steps: Step[], dMin: number) {
  const frames = new Map<number, Frame>();
  const figures: SnapshotFigures = new Map();
  const flows = runFlows(steps);
  const rejects = runRejects(steps);
  const logged = new Set(steps.map((s) => s.epoch));
  const closes = new Map(steps.filter((s) => s.kind === 'close' && s.tx).map((s) => [s.closed!, s.tx!]));
  const sorted = [...snaps].sort((a, b) => a.epoch_info.epoch - b.epoch_info.epoch);
  const last = sorted[sorted.length - 1];
  const current = Math.max(last?.epoch_info.epoch ?? 0, ...logged);
  const make = (e: number, kind: Frame['kind']): Frame => ({
    ...emptyFrame(e, kind),
    flows: flows.get(e) ?? (logged.has(e) ? [] : null),
    rejects: rejects.get(e) ?? (logged.has(e) ? [] : null),
    flowsFrom: logged.has(e) ? 'run-log' : null,
    close: closes.has(e) ? { tx: closes.get(e)!, fetched: false } : null,
  });
  for (const s of sorted) {
    const e = s.epoch_info.epoch - 1;
    if (e < 1 || e >= current) continue;
    const f = make(e, 'closed');
    f.tubes = tubesFromTuples(s.edges, dMin);
    f.tubesFrom = 'snapshot';
    f.active = s.epoch_info.active;
    f.reputation = new Map(Object.values(s.spores).map((x) => [x.render_input.spore_id, Number(x.reputation)]));
    f.fingerprint = s.fingerprint;
    frames.set(e, f);
    figures.set(
      e,
      new Map(
        Object.values(s.spores).map((x) => [x.render_input.spore_id, { balance: x.balance, allowance: x.effective_budget, paused: x.policy.paused, operator: x.operator_id }]),
      ),
    );
  }
  for (const e of logged) if (e >= 1 && e < current && !frames.has(e)) frames.set(e, make(e, 'closed'));
  const end = make(current, 'live');
  const before = frames.get(current - 1);
  if (before) {
    end.tubes = before.tubes;
    end.tubesFrom = before.tubesFrom;
    end.active = before.active;
    end.reputation = before.reputation;
    end.fingerprint = before.fingerprint;
  }
  if (figures.has(current - 1)) figures.set(current, figures.get(current - 1)!);
  const history: NetworkHistory = { frames, current, live: end, dMin };
  const spores = new Map<number, NetworkSpore>();
  if (last) {
    const active = new Set(last.epoch_info.active);
    for (const x of Object.values(last.spores)) {
      const id = x.render_input.spore_id;
      spores.set(id, {
        id,
        seed: x.render_input.seed,
        palette: paletteOf(x.render_input.seed).idx,
        owner: x.owner_id,
        listedPrice: x.listed_price,
        paused: x.policy.paused,
        active: active.has(id),
        glyph: null,
        age: x.render_input.age,
      });
    }
  }
  return { history, figures, spores };
}

async function optionalJsonl<T>(files: RunFiles, name: string): Promise<T[]> {
  try {
    return await files.jsonl<T>(name);
  } catch (e) {
    if (e instanceof SourceFileError && e.status === 404) return [];
    throw e;
  }
}

/** LOCAL RUN / RECORDED: snapshots, the event log and (if the run has one) the decision log. */
export async function loadRunNetwork(source: Extract<Source, { kind: 'run' | 'recorded' }>, fetchFn?: typeof fetch): Promise<NetworkData> {
  const names = source.kind === 'run' ? await listRunDir(source.run, 'snapshots', fetchFn) : await recordedManifest(source.run, fetchFn);
  const files = source.kind === 'run' ? runFiles(source.run, fetchFn) : recordedFiles(source.run, fetchFn);
  const snapNames = names.map((n) => n.replace(/^snapshots\//, '')).filter((n) => /^epoch-\d{3,6}\.json$/.test(n));
  if (!snapNames.length) throw new Error(`${source.run} has no epoch snapshots (snapshots/epoch-NNN.json)`);
  const [run, events, decisions, snaps] = await Promise.all([
    files.json<RunJson>('run.json'),
    files.jsonl<RawEvent>('events.jsonl'),
    optionalJsonl<RawDecision>(files, 'decisions.jsonl'),
    Promise.all(snapNames.map((n) => files.json<SnapshotFile>(`snapshots/${n}`))),
  ]);
  const startEpoch = run.start_epoch ?? Math.min(...snaps.map((s) => s.epoch_info.epoch));
  const steps = stepsFromRunLog(events, decisions, startEpoch);
  const { history, figures, spores } = historyFromRun(snaps, steps, Number(run.config?.d_min ?? 0));
  return { history, spores, steps, figures, readAt: Date.now(), closes: { listed: 0, loaded: 0, error: null, listUrl: null }, edgesCheck: null };
}
