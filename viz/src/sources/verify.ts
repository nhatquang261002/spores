// The Verify run in the browser: what `verify/src/main.rs` does, step for step,
// through the same core and renderer code compiled to wasm. Each run reads the
// chain again: nothing here touches the close cache in localStorage or the
// image cache, so a click always recomputes (plan S10).
import { epochClosed, type EpochClosed } from '../chain/events';
import type { Router } from '../chain/router';
import type { Rpc } from '../chain/rpc';
import {
  compareEpoch,
  planCloses,
  readFailureReason,
  txFailureReason,
  unableImage,
  unableRow,
  type EpochRow,
  type FailedClose,
  type HeadCheck,
  type ImageCheck,
  type VerifyProgress,
  type VerifyResult,
  type ViewRead,
} from '../model/verify';
import type { Source } from '../model/types';
import { pool } from '../state/network';
import type { CoreWasm, ReplayedEpoch } from '../wasm/core';
import type { RenderInput } from '../wasm/renderer';
import { loadCloseList } from './network';
import { recordedFiles } from './recorded';
import { runFiles, type RunFiles } from './run';

const CLOSE_CONCURRENCY = 2;
const VIEW_CONCURRENCY = 3;

export interface CloseHashes {
  router: string;
  hashes: string[];
  /** Where they came from, in order: the app's close list, the run log. */
  from: { label: string; count: number; url?: string }[];
  /** Log lines that didn't parse (they are skipped, and said so). */
  unreadableLines: number;
}

/** Close hashes in a keeper log: `close_epoch` tx lines that succeeded, as `close_hashes` in the CLI. */
export function hashesFromLog(text: string): { hashes: string[]; unreadable: number } {
  const hashes: string[] = [];
  let unreadable = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let v: any;
    try {
      v = JSON.parse(line);
    } catch {
      unreadable++;
      continue;
    }
    if (v?.method === 'close_epoch' && v?.ok === true && typeof v.hash === 'string') hashes.push(v.hash);
  }
  return { hashes, unreadable };
}

/**
 * The hashes this source verifies. LIVE: the app's list for the router. A run
 * or recorded bundle: its own log, plus the router's list when there is one,
 * because the replay has to start at epoch 1 and most runs start later (the
 * CLI is given both files for the same reason).
 */
export async function loadCloseHashes(source: Extract<Source, { kind: 'live' | 'run' | 'recorded' }>, liveRouter: string | null, fetchFn?: typeof fetch): Promise<CloseHashes> {
  if (source.kind === 'live') {
    const list = await loadCloseList(liveRouter!, fetchFn);
    return {
      router: liveRouter!,
      hashes: [...new Set(list?.hashes ?? [])],
      from: list ? [{ label: 'the close list', count: list.hashes.length, url: list.url }] : [],
      unreadableLines: 0,
    };
  }
  const files: RunFiles = source.kind === 'run' ? runFiles(source.run, fetchFn) : recordedFiles(source.run, fetchFn);
  const run = await files.json<{ router?: string }>('run.json');
  if (!run.router) throw new Error(`${source.run}: run.json names no router`);
  const log = hashesFromLog(await files.text('events.jsonl'));
  const list = await loadCloseList(run.router, fetchFn);
  const from: CloseHashes['from'] = [];
  if (list) from.push({ label: 'the close list', count: list.hashes.length, url: list.url });
  from.push({ label: source.kind === 'run' ? `the agents’ log` : `the recording`, count: log.hashes.length });
  return { router: run.router, hashes: [...new Set([...(list?.hashes ?? []), ...log.hashes])], from, unreadableLines: log.unreadable };
}

/**
 * A close tx, fresh from the chain. Archival first: the regular nodes have
 * dropped old txs and answer with an error after 2–30 s, against 1–5 s for an
 * archival node (measured in S10). Both errors are kept, so a rate limit isn't
 * reported as "missing".
 */
export async function fetchCloseTx(rpc: Rpc, hash: string, signer: string): Promise<any> {
  const params = { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' };
  let archivalError: unknown = null;
  if (rpc.archivalUrls?.length) {
    try {
      return await rpc.call('tx', params, rpc.archivalUrls);
    } catch (e) {
      archivalError = e;
    }
  }
  try {
    return await rpc.call('tx', params);
  } catch (e) {
    throw new Error(txFailureReason(archivalError, e));
  }
}

/** The `epoch_closed` of a close tx, or why it can't be used. */
export function closeFromTx(tx: any, router: string): EpochClosed {
  const receiver = tx?.transaction?.receiver_id;
  if (receiver !== router) throw new Error(`was sent to ${receiver}, not ${router}`);
  if (tx?.status?.Failure) throw new Error(`the tx failed: ${JSON.stringify(tx.status.Failure)}`);
  const ev = epochClosed(tx);
  if (!ev) throw new Error('no epoch_closed event');
  if (!Number.isInteger(ev.epoch)) throw new Error('the event has no epoch');
  return ev;
}

export interface FreshImage {
  rgb: Uint8Array;
  imageHash: string;
  rendererVersion: number;
}

export interface VerifyDeps {
  router: Router;
  core: () => Promise<CoreWasm>;
  /** A render made now, not read from the image cache. */
  render: (input: RenderInput) => Promise<FreshImage>;
}

/** `verify_image` in `verify/src/main.rs`: rebuild the spore's state at its commit's epoch from the replayed tubes. */
export async function verifyImage(deps: VerifyDeps, core: CoreWasm, spore: number, replayed: ReplayedEpoch[]): Promise<ImageCheck> {
  const { router } = deps;
  try {
    const commit = await router.imageCommit(spore);
    if (!commit) return unableImage(spore, `Spore #${spore} has no committed image`);
    const epoch = commit.epoch;
    const after = replayed.find((r) => r.epoch === epoch - 1);
    if (epoch > 1 && !after) {
      const reach = replayed.length ? replayed[replayed.length - 1].epoch : 0;
      return unableImage(spore, `the image is for epoch ${epoch}; it needs closes up to epoch ${epoch - 1}, and the replay reached ${reach ? `epoch ${reach}` : 'no epoch'}`, epoch);
    }
    // `age` counts from the router's current epoch, so both reads must be of the same one.
    let summary = null;
    let current = -1;
    for (let i = 0; i < 3; i++) {
      const before = (await router.epochInfo()).epoch;
      summary = await router.sporeSummary(spore);
      current = (await router.epochInfo()).epoch;
      if (before === current) break;
    }
    if (!summary) return unableImage(spore, `The contract has nothing for Spore #${spore}`, epoch);
    const age = epoch - (current - summary.age);
    if (age < 0) return unableImage(spore, `the commit is for epoch ${epoch}, before Spore #${spore} was activated`, epoch);
    const conns: [number, string][] = (after?.tubes ?? []).flatMap(([a, b, d]) => (a === spore ? [[b, d] as [number, string]] : b === spore ? [[a, d] as [number, string]] : []));

    const state = core.stateHash({ spore_id: spore, epoch, seed: summary.seed, age, edges: conns }).state_hash;
    const { rgb, imageHash, rendererVersion } = await deps.render({ seed: summary.seed, age, edges: conns });
    let glyph: string | null = null;
    try {
      glyph = (await router.nftToken(spore))?.metadata.media ?? null;
    } catch {
      // The glyph is shown beside the render; it isn't part of the check.
    }
    const versionOk = rendererVersion === commit.renderer_version;
    const ok = state === commit.state_hash && imageHash === commit.image_hash && versionOk;
    return {
      spore,
      verdict: ok ? 'match' : 'mismatch',
      reason: versionOk ? null : `Committed with renderer v${commit.renderer_version}; this app renders v${rendererVersion}.`,
      epoch,
      age,
      tubes: conns.length,
      state: { mine: state, committed: commit.state_hash },
      image: { mine: imageHash, committed: commit.image_hash },
      renderer: { mine: rendererVersion, committed: commit.renderer_version },
      rgb,
      glyph,
      seed: summary.seed,
    };
  } catch (e) {
    return unableImage(spore, readFailureReason(e));
  }
}

export interface VerifyRequest {
  hashes: string[];
  /** The spore whose committed image is checked; null for epochs only. */
  spore: number | null;
}

/**
 * One whole run. Reads that fail become `! Unable` rows with the reason; only
 * what stops everything (no `config`, no core-wasm) throws. `alive` stops the
 * remaining work when the reader has moved to another source.
 */
export async function runVerification(deps: VerifyDeps, req: VerifyRequest, onProgress: (p: VerifyProgress) => void = () => {}, alive: () => boolean = () => true): Promise<VerifyResult> {
  const { router } = deps;
  const started = Date.now();
  if (!req.hashes.length) throw new Error('no close_epoch transactions to verify');
  const [config, signer, core] = await Promise.all([router.config(), router.admin(), deps.core()]);

  // 1–2. Every close tx: sent to this router, with its `epoch_closed`.
  const reads: { tx: string; ev: EpochClosed }[] = [];
  const failed: FailedClose[] = [];
  const total = req.hashes.length;
  let done = 0;
  onProgress({ step: 'fetching', done, total });
  await pool(
    req.hashes,
    CLOSE_CONCURRENCY,
    async (hash) => {
      try {
        reads.push({ tx: hash, ev: closeFromTx(await fetchCloseTx(router.rpc, hash, signer), router.id) });
      } catch (e) {
        failed.push({ tx: hash, reason: readFailureReason(e) });
      }
      done++;
      onProgress({ step: 'fetching', done, total });
    },
    alive,
  );

  // 3. From epoch 1, no gaps.
  const plan = planCloses(reads, total, failed.length);

  // 4. The replay.
  onProgress({ step: 'replaying' });
  let replayed: ReplayedEpoch[] = [];
  let replayError: string | null = null;
  if (plan.replayable.length) {
    try {
      replayed = core.replay(
        config,
        plan.replayable.map(({ ev }) => ({ epoch: ev.epoch, active: ev.active, flows: ev.flows, rejects: ev.rejects, pool: ev.pool })),
      );
    } catch (e) {
      replayError = readFailureReason(e);
    }
  }

  // 5. Against the event and the stored fingerprint.
  const views = new Map<number, ViewRead>();
  let compared = 0;
  onProgress({ step: 'comparing', done: compared, total: replayed.length });
  await pool(
    replayed,
    VIEW_CONCURRENCY,
    async (r) => {
      try {
        views.set(r.epoch, { ok: true, fingerprint: await router.fingerprint(r.epoch) });
      } catch (e) {
        views.set(r.epoch, { ok: false, reason: readFailureReason(e) });
      }
      compared++;
      onProgress({ step: 'comparing', done: compared, total: replayed.length });
    },
    alive,
  );

  const usable = new Map(plan.replayable.map((c) => [c.ev.epoch, c]));
  const anyRead = new Map(reads.map((c) => [c.ev.epoch, c]));
  const rows: EpochRow[] = [];
  for (let e = 1; e <= plan.last; e++) {
    const r = replayed.find((x) => x.epoch === e);
    const close = usable.get(e);
    if (r && close) {
      rows.push(compareEpoch(close.ev, close.tx, r, views.get(e) ?? { ok: false, reason: 'stopped before this read' }));
    } else {
      rows.push(unableRow(e, replayError ?? plan.gap?.reason ?? `missing epoch ${e}`, anyRead.get(e)));
    }
  }

  // Finally the router's head, when it is on the very next epoch.
  let head: HeadCheck;
  const last = replayed[replayed.length - 1];
  try {
    const info = await router.epochInfo();
    if (last && info.epoch === last.epoch + 1 && !plan.gap) {
      head = { kind: 'checked', verdict: info.prev_fingerprint === last.fingerprint ? 'match' : 'mismatch', epoch: info.epoch, replayed: last.fingerprint, chain: info.prev_fingerprint };
    } else {
      head = { kind: 'skipped', routerEpoch: info.epoch, lastEpoch: last?.epoch ?? 0 };
    }
  } catch (e) {
    head = { kind: 'unable', reason: readFailureReason(e) };
  }

  // Then the committed image.
  let image: ImageCheck | null = null;
  if (req.spore !== null) {
    onProgress({ step: 'image', spore: req.spore });
    image = await verifyImage(deps, core, req.spore, replayed);
  }

  return { router: router.id, listed: total, rows, failed, replayError, head, image, ranAt: Date.now(), ms: Date.now() - started };
}
