// The keeper closes epochs (SPEC §8.5: anyone may, after the duration) and
// times out jobs past their deadline. It signs with a function-call key on the
// deployer (admin) account limited to `close_epoch`, `timeout_job` and, from
// Phase 5, `commit_image`. After every close it snapshots the chain state the
// renderer and the run report need; with COMMIT_IMAGES=1 it then renders each
// active spore from that state and commits the image hash (SPEC §5.5).
// Exits after EPOCHS closes.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendJsonl, ensureDir, loadConfig, nowNs, sleep } from './common.ts';
import { Caller, view } from './near.ts';

const cfg = loadConfig();
const target = Number(process.env.EPOCHS ?? 8);
const keeperId = process.env.KEEPER_ACCOUNT_ID;
const keeperKey = process.env[`${process.env.KEY_PREFIX ?? ''}KEEPER_FC_PRIVATE_KEY`];
if (!keeperId || !keeperKey) throw new Error('set KEEPER_ACCOUNT_ID and <KEY_PREFIX>KEEPER_FC_PRIVATE_KEY');
const commitImages = process.env.COMMIT_IMAGES === '1';
const renderer = process.env.RENDERER_BIN ?? resolve(import.meta.dirname, '../../target/release/spores-render');
const chain = new Caller(keeperId, keeperKey, cfg.router);
const EVENTS = join(cfg.runDir, 'events.jsonl');
const snapDir = join(cfg.runDir, 'snapshots');
ensureDir(snapDir);

const note = (kind: string, extra: object = {}) => appendJsonl(EVENTS, { at: new Date().toISOString(), spore: 'keeper', kind, ...extra });

async function snapshot(label: string) {
  const [info, edges, ledger] = await Promise.all([view(cfg.router, 'epoch_info'), view(cfg.router, 'edges'), view(cfg.router, 'ledger_totals')]);
  const spores: Record<string, unknown> = {};
  for (const id of cfg.spores) {
    const [render, summary] = await Promise.all([view(cfg.router, 'render_input', { spore_id: id }), view(cfg.router, 'spore_summary', { spore_id: id })]);
    spores[id] = {
      render_input: render, balance: summary.balance, reputation: summary.reputation, degree: summary.degree,
      owner_id: summary.owner_id, operator_id: summary.operator_id, operator_gen: summary.operator_gen, policy: summary.policy,
      effective_budget: summary.effective_budget, listed_price: summary.listed_price, sales: summary.sales, state: summary.state, image: summary.image,
    };
  }
  const fingerprint = info.epoch > 0 ? await view(cfg.router, 'fingerprint', { epoch: info.epoch - 1 }) : null;
  writeFileSync(join(snapDir, `${label}.json`), JSON.stringify({ label, epoch: info.epoch, fingerprint, epoch_info: info, edges, ledger, spores }, null, 2));
  return info;
}

/** Renders each spore's snapshot state and commits the image hash against its stored state hash. */
async function commitImages_(label: string, snap: any) {
  const dir = join(cfg.runDir, 'renders');
  ensureDir(dir);
  for (const id of cfg.spores) {
    const sp = snap.spores[id];
    if (!sp?.state || sp.state[0] !== snap.epoch || sp.render_input.epoch !== snap.epoch) continue;
    try {
      const input = join(dir, `${label}-spore-${id}.json`);
      writeFileSync(input, JSON.stringify(sp.render_input));
      const out = execFileSync(renderer, ['state', input, join(dir, `${label}-spore-${id}.png`)], { encoding: 'utf8' });
      const m = out.match(/renderer v(\d+) .*image_hash ([0-9a-f]{64})/);
      if (!m) throw new Error(`unexpected renderer output: ${out.trim()}`);
      const r = await chain.call('commit_image', { spore_id: id, epoch: snap.epoch, image_hash: m[2], renderer_version: Number(m[1]) });
      note('tx', { method: 'commit_image', args: { spore_id: id, epoch: snap.epoch, image_hash: m[2] }, hash: r.hash, ok: r.ok, err: r.err || undefined, gas_tgas: r.gasTgas });
    } catch (e) {
      note('error', { err: `commit_image ${id}: ${(e as Error).message}` });
    }
  }
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
  let closes = 0;
  while (closes < target) {
    try {
      const info = await view(cfg.router, 'epoch_info');
      const now = nowNs();
      if (now >= BigInt(info.ends_ns) + 1_000_000_000n) {
        const r = await chain.call('close_epoch', {});
        note('tx', { method: 'close_epoch', hash: r.hash, ok: r.ok, err: r.err || undefined, gas_tgas: r.gasTgas, closed: info.epoch, fingerprint: r.ret });
        if (r.ok) {
          closes++;
          // The snapshot is the run's evidence: retry until it lands.
          const label = `epoch-${String(info.epoch + 1).padStart(3, '0')}`;
          for (let i = 0; ; i++) {
            try {
              await snapshot(label);
              if (commitImages) await commitImages_(label, JSON.parse(readFileSync(join(snapDir, `${label}.json`), 'utf8')));
              break;
            } catch (e) {
              note('error', { err: `snapshot: ${(e as Error).message}` });
              if (i >= 5) break;
              await sleep(3_000);
            }
          }
        }
      }
      const jobs = await view(cfg.router, 'list_jobs', { from_index: 0, limit: 100 });
      for (const job of jobs) {
        if (BigInt(job.deadline_ns) + 2_000_000_000n < now) {
          const r = await chain.call('timeout_job', { job_id: job.id });
          note('tx', { method: 'timeout_job', args: { job_id: job.id, status: job.status }, hash: r.hash, ok: r.ok, err: r.err || undefined, gas_tgas: r.gasTgas });
        }
      }
    } catch (e) {
      note('error', { err: (e as Error).message });
    }
    await sleep(2_000);
  }
  note('done', { closes });
  writeFileSync(join(cfg.runDir, 'keeper-done.json'), JSON.stringify({ closes, at: new Date().toISOString() }));
}

main();
