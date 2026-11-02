// The keeper closes epochs (SPEC §8.5: anyone may, after the duration) and
// times out jobs past their deadline. It signs with a function-call key on the
// deployer account limited to `close_epoch` and `timeout_job`. After every
// close it snapshots the chain state the renderer and the run report need.
// Exits after EPOCHS closes.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonl, ensureDir, loadConfig, nowNs, sleep } from './common.ts';
import { Caller, view } from './near.ts';

const cfg = loadConfig();
const target = Number(process.env.EPOCHS ?? 8);
const keeperId = process.env.KEEPER_ACCOUNT_ID;
const keeperKey = process.env.KEEPER_FC_PRIVATE_KEY;
if (!keeperId || !keeperKey) throw new Error('set KEEPER_ACCOUNT_ID and KEEPER_FC_PRIVATE_KEY');
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
    spores[id] = { render_input: render, balance: summary.balance, reputation: summary.reputation, degree: summary.degree };
  }
  const fingerprint = info.epoch > 0 ? await view(cfg.router, 'fingerprint', { epoch: info.epoch - 1 }) : null;
  writeFileSync(join(snapDir, `${label}.json`), JSON.stringify({ label, epoch: info.epoch, fingerprint, epoch_info: info, edges, ledger, spores }, null, 2));
  return info;
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
          for (let i = 0; ; i++) {
            try {
              await snapshot(`epoch-${String(info.epoch + 1).padStart(3, '0')}`);
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
