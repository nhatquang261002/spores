// The keeper closes epochs (SPEC §8.5: anyone may, after the duration) and
// times out jobs past their deadline. It signs with a function-call key on the
// deployer (admin) account limited to `close_epoch`, `timeout_job` and, from
// Phase 5, `commit_image`. After every close it snapshots the chain state the
// renderer and the run report need; with COMMIT_IMAGES=1 it then renders each
// active spore from that state and commits the image hash (SPEC §5.5), in the
// background (`commits.ts`): the next close never waits for it, and commits
// the next close would make stale are skipped and logged as `skip`.
// At 64 active (Phase 6) a snapshot is about 130 views, so it runs in the
// background too, every view pinned to the first final block after the close:
// it records the post-close state however long it takes, and the next close
// does not wait for it. Timeouts are capped per loop, escrowed jobs first, so
// a backlog of expired open jobs cannot hold up a close.
// Exits after EPOCHS closes, once the last epoch's snapshot is written and its
// commits are done or one epoch length has passed (the rest are skipped).
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CommitQueue } from './commits.ts';
import { appendJsonl, ensureDir, envKey, loadConfig, nowNs, sleep } from './common.ts';
import { Caller, allJobs, rpc, rpcSince, view } from './near.ts';

const cfg = loadConfig();
const target = Number(process.env.EPOCHS ?? 8);
const keeperId = process.env.KEEPER_ACCOUNT_ID;
const keeperKey = envKey('KEEPER_FC_PRIVATE_KEY');
if (!keeperId || !keeperKey) throw new Error('set KEEPER_ACCOUNT_ID and <KEY_PREFIX>KEEPER_FC_PRIVATE_KEY');
const commitImages = process.env.COMMIT_IMAGES === '1';
const renderer = process.env.RENDERER_BIN ?? resolve(import.meta.dirname, '../../target/release/spores-render');
const chain = new Caller(keeperId, keeperKey, cfg.router);
const EVENTS = join(cfg.runDir, 'events.jsonl');
const snapDir = join(cfg.runDir, 'snapshots');
ensureDir(snapDir);
const renderDir = join(cfg.runDir, 'renders');
ensureDir(renderDir);
const execFileAsync = promisify(execFile);
/**
 * Gas attached to `close_epoch`. At 64 active the close stores 64 state
 * hashes and burns more than a job call's 10 Tgas (a 10 Tgas close ran out on
 * 2026-11-03); 300 Tgas is the most one call may use.
 */
const CLOSE_GAS_TGAS = Number(process.env.CLOSE_GAS_TGAS ?? 300);
/** Timeout transactions per loop; each waits for finality (a few seconds). */
const TIMEOUTS_PER_LOOP = Number(process.env.TIMEOUTS_PER_LOOP ?? 4);
/** No timeout starts this close to the epoch's end, ns. */
const CLOSE_MARGIN_NS = 8_000_000_000n;
/** Only the close waits for finality: the views the keeper reads next are after a close. Timeouts and commits need only have executed. */
const QUICK = 'EXECUTED_OPTIMISTIC' as const;

const note = (kind: string, extra: object = {}) => appendJsonl(EVENTS, { at: new Date().toISOString(), spore: 'keeper', kind, ...extra });

/** Chain state for the renderer and the report, every view at `block` (a height; latest final if absent). */
async function snapshot(label: string, block?: number) {
  const at = (method: string, args: object = {}) => view(cfg.router, method, args, block);
  const [info, edges, ledger] = await Promise.all([at('epoch_info'), at('edges'), at('ledger_totals')]);
  const spores: Record<string, unknown> = {};
  await Promise.all(
    cfg.spores.map(async (id) => {
      const summary = await at('spore_summary', { spore_id: id });
      // The router's `render_input`, built from the same block's summary (one view per spore instead of two).
      const render = { spore_id: id, epoch: info.epoch, seed: summary.seed, age: summary.age, edges: summary.connections.map(([n, d]: [number, string]) => [n, Number(d)]) };
      spores[id] = {
      render_input: render, balance: summary.balance, reputation: summary.reputation, degree: summary.degree,
      owner_id: summary.owner_id, operator_id: summary.operator_id, operator_gen: summary.operator_gen, policy: summary.policy,
      effective_budget: summary.effective_budget, listed_price: summary.listed_price, sales: summary.sales, state: summary.state, image: summary.image,
      };
    }),
  );
  const ordered = Object.fromEntries(cfg.spores.map((id) => [id, spores[id]]));
  const fingerprint = info.epoch > 0 ? await at('fingerprint', { epoch: info.epoch - 1 }) : null;
  writeFileSync(join(snapDir, `${label}.json`), JSON.stringify({ label, epoch: info.epoch, block: block ?? null, fingerprint, epoch_info: info, edges, ledger, spores: ordered }, null, 2));
  return info;
}

type ImageJob = { label: string; epoch: number; id: number; renderInput: unknown };

/**
 * The spores of a snapshot whose stored state hash is from that epoch. The
 * order rotates each epoch: with many spores only the first few commit before
 * the next close makes the rest stale, so each spore gets its turn.
 */
function imageJobs(label: string, snap: any): ImageJob[] {
  const n = cfg.spores.length;
  const from = (snap.epoch * 8) % n;
  return [...cfg.spores.slice(from), ...cfg.spores.slice(0, from)]
    .filter((id) => {
      const sp = snap.spores[id];
      return sp?.state && sp.state[0] === snap.epoch && sp.render_input.epoch === snap.epoch;
    })
    .map((id) => ({ label, epoch: snap.epoch, id, renderInput: snap.spores[id].render_input }));
}

const skipNote = (job: ImageJob, when: string) =>
  note('skip', { method: 'commit_image', args: { spore_id: job.id, epoch: job.epoch }, reason: `the next close came first (${when})` });

/** Renders one spore's snapshot state and commits the image hash against its stored state hash. */
async function commitImage(job: ImageJob, live: () => boolean) {
  try {
    const input = join(renderDir, `${job.label}-spore-${job.id}.json`);
    writeFileSync(input, JSON.stringify(job.renderInput));
    const { stdout } = await execFileAsync(renderer, ['state', input, join(renderDir, `${job.label}-spore-${job.id}.png`)], { encoding: 'utf8' });
    const m = stdout.match(/renderer v(\d+) .*image_hash ([0-9a-f]{64})/);
    if (!m) throw new Error(`unexpected renderer output: ${stdout.trim()}`);
    if (!live()) return skipNote(job, 'after render');
    const r = await chain.call('commit_image', { spore_id: job.id, epoch: job.epoch, image_hash: m[2], renderer_version: Number(m[1]) }, undefined, undefined, QUICK);
    note('tx', { method: 'commit_image', args: { spore_id: job.id, epoch: job.epoch, image_hash: m[2] }, hash: r.hash, ok: r.ok, err: r.err || undefined, gas_tgas: r.gasTgas });
  } catch (e) {
    note('error', { err: `commit_image ${job.id}: ${(e as Error).message}` });
  }
}

// Commit txs and the close share the keeper key, so `chain` sends them in call
// order: a close waits for at most the one commit tx already sent.
const commits = new CommitQueue<ImageJob>(commitImage, (job) => skipNote(job, 'queued'));

/** Snapshots run one after another in the background; commits follow each one. */
let snapshots: Promise<void> = Promise.resolve();
/** The epoch after the keeper's latest close: only its state hashes accept a commit. */
let headEpoch = 0;
function snapshotAfterClose(label: string, block: number) {
  snapshots = snapshots.then(async () => {
    // The snapshot is the run's evidence: retry until it lands.
    for (let i = 0; ; i++) {
      try {
        const snap = await snapshot(label, block);
        const jobs = commitImages ? imageJobs(label, JSON.parse(readFileSync(join(snapDir, `${label}.json`), 'utf8'))) : [];
        // A snapshot that finished after the next close would commit stale state.
        if (snap.epoch === headEpoch) commits.run(jobs);
        else for (const job of jobs) skipNote(job, 'before the snapshot finished');
        note('snapshot', { label, epoch: snap.epoch, block });
        return;
      } catch (e) {
        note('error', { err: `snapshot ${label}: ${(e as Error).message}` });
        if (i >= 5) return;
        await sleep(3_000);
      }
    }
  });
}

async function main() {
  let start;
  for (let i = 0; !start; i++) {
    try {
      start = await snapshot('start');
    } catch (e) {
      if (i >= 5) throw e;
      await sleep(3_000);
    }
  }
  note('start', { epoch: start.epoch, target, pid: process.pid });
  rpcSince();
  let closes = 0;
  while (closes < target) {
    try {
      const info = await view(cfg.router, 'epoch_info');
      const now = nowNs();
      if (now >= BigInt(info.ends_ns) + 1_000_000_000n) {
        commits.stop();
        const r = await chain.call('close_epoch', {}, 0n, CLOSE_GAS_TGAS);
        note('tx', { method: 'close_epoch', hash: r.hash, ok: r.ok, err: r.err || undefined, gas_tgas: r.gasTgas, closed: info.epoch, fingerprint: r.ret, log_bytes: Math.max(0, ...r.logBytes), active: info.active.length, pairs: new Set([...info.flows, ...info.rejects].map(([a, b]: number[]) => `${a}-${b}`)).size });
        if (r.ok) {
          closes++;
          headEpoch = info.epoch + 1;
          note('rpc', { epoch: info.epoch, ...rpcSince() });
          // The close is final (the keeper waits for FINAL), so the latest final block is after it.
          const block = (await rpc('block', { finality: 'final' })).result.header.height;
          snapshotAfterClose(`epoch-${String(info.epoch + 1).padStart(3, '0')}`, block);
        }
      }
      // Escrowed jobs first: they hold money and a slot under the epoch pair cap.
      // None while a close is near (S13 measured it: four per loop, each waiting
      // for finality behind a commit on the same key, pushed closes out to 66-92 s
      // on a 30 s epoch; holding them back with no quicker tx left jobs unfinished,
      // and agents then couldn't post).
      const closeNear = () => BigInt(info.ends_ns) - nowNs() < CLOSE_MARGIN_NS;
      const expired = (closeNear() ? [] : await allJobs(cfg.router))
        .filter((job) => BigInt(job.deadline_ns) + 2_000_000_000n < now)
        // Then this run's own: a spore with 4 unfinished jobs can't post, and other spores' old jobs can wait.
        .sort((a, b) => Number(a.status === 'Open') - Number(b.status === 'Open') || Number(!cfg.spores.includes(a.consumer)) - Number(!cfg.spores.includes(b.consumer)) || a.id - b.id)
        .slice(0, TIMEOUTS_PER_LOOP);
      for (const job of expired) {
        if (closeNear()) break;
        const r = await chain.call('timeout_job', { job_id: job.id }, undefined, undefined, QUICK);
        note('tx', { method: 'timeout_job', args: { job_id: job.id, status: job.status }, hash: r.hash, ok: r.ok, err: r.err || undefined, gas_tgas: r.gasTgas });
      }
    } catch (e) {
      note('error', { err: (e as Error).message });
    }
    await sleep(2_000);
  }
  await snapshots;
  // The last batch has no next close to make it stale: give it one epoch
  // length (64 renders and commits take minutes), then skip the rest.
  const epochMs = Number(BigInt((await view(cfg.router, 'config')).epoch_len_ns) / 1_000_000n);
  await Promise.race([commits.idle(), sleep(epochMs)]);
  commits.stop();
  await commits.idle();
  note('done', { closes });
  writeFileSync(join(cfg.runDir, 'keeper-done.json'), JSON.stringify({ closes, at: new Date().toISOString() }));
}

main();
