// One agent = one active spore (SPEC §4, §6). Usage: SPORE_ID=N node src/agent.ts
// (normally started by run.ts). Signs with SPORE_<N>_FC_PRIVATE_KEY, a
// function-call key on the operator account limited to the router's job and
// pay methods. Every money decision follows the shared rules (rules.ts =
// spores-core): providers quote cost * (1 + margin); consumers hire by
// quote / (1 + w * D_norm) and log each decision.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonl, ensureDir, isCut, loadConfig, nowNs, readControl, sleep } from './common.ts';
import { Caller, view, type TxResult } from './near.ts';
import { MARGIN_START, SHIPPED_NORM, SHIPPED_W_BPS, dNorm, jobService, nextMargin, pick, quotePrice, reference, score, type Quote } from './rules.ts';
import { SERVICES, decodeTask, deliver, encodeTask, makeTask, profile, resultHash, serviceOf, solve, type Task } from './services.ts';

const cfg = loadConfig();
const me = Number(process.env.SPORE_ID);
const key = process.env[`SPORE_${me}_FC_PRIVATE_KEY`];
if (!Number.isInteger(me) || !key) throw new Error('set SPORE_ID and SPORE_<id>_FC_PRIVATE_KEY');
const chain = new Caller(cfg.operatorId, key, cfg.router, 'EXECUTED_OPTIMISTIC');
const myService = serviceOf(me);
const { cost, qualityBps } = profile(cfg.seed, me);
const resultsDir = join(cfg.runDir, 'results');
ensureDir(resultsDir);
const DECISIONS = join(cfg.runDir, 'decisions.jsonl');
const EVENTS = join(cfg.runDir, 'events.jsonl');

function note(kind: string, extra: object = {}) {
  appendJsonl(EVENTS, { at: new Date().toISOString(), spore: me, kind, ...extra });
}

async function send(method: string, args: object, gasTgas?: number): Promise<TxResult> {
  const r = await chain.call(method, args, 0n, gasTgas);
  note('tx', { method, args, hash: r.hash, ok: r.ok, err: r.err || undefined, gas_tgas: r.gasTgas });
  return r;
}

// ---- consumer state -----------------------------------------------------------

interface Pending {
  j: number;
  attempt: number;
  tried: number[];
}
interface Current extends Pending {
  jobId: number;
  task: Task;
  taskText: string;
  postedAt: number;
  postTx: string;
  phase: 'quotes' | 'delivery';
  decision?: any;
}

let queue: Pending[] = [];
let current: Current | null = null;
let epoch = -1;
let edges = new Map<string, bigint>();
const edgeKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

// ---- provider state -----------------------------------------------------------

let margin = MARGIN_START;
let wins = 0;
const quoted = new Set<number>();
const delivered = new Set<number>();

// ---- control ------------------------------------------------------------------

let idleReason = '';
let loops = 0;
let epochEnds = 0n;

async function inControl(): Promise<boolean> {
  const s = await view(cfg.router, 'spore_summary', { spore_id: me });
  const why = !s ? 'unknown spore' : !s.active ? 'spore is not active' : s.operator_id !== cfg.operatorId ? 'not the registered operator' : s.policy.paused ? 'policy is paused' : '';
  if (why !== idleReason) note(why ? 'idle' : 'resumed', { reason: why || undefined, operator_gen: s?.operator_gen });
  idleReason = why;
  return !why;
}

async function onNewEpoch(e: number) {
  if (epoch >= 0) {
    const next = nextMargin(margin, wins);
    note('margin', { epoch: epoch, wins, from: margin, to: next });
    margin = next;
    wins = 0;
  }
  epoch = e;
  edges = new Map((await view(cfg.router, 'edges')).map(([a, b, d]: [number, number, string]) => [edgeKey(a, b), BigInt(d)]));
  // Keep retries still waiting from the last epoch; add this epoch's jobs.
  queue = [...queue.filter((p) => p.attempt > 0), ...Array.from({ length: cfg.jobsPerEpoch }, (_, j) => ({ j, attempt: 0, tried: [] as number[] }))];
  if (cfg.buyEvery > 0 && e % cfg.buyEvery === me % cfg.buyEvery) await buyOutside();
}

async function buyOutside() {
  try {
    const offer = await (await fetch(`${cfg.outsideUrl}/offer?spore_id=${me}`, { signal: AbortSignal.timeout(5_000) })).json();
    // The transfer and its callback need more than a job call's 10 Tgas.
    const r = await send('pay_service', { spore_id: me, payee: offer.payee, amount: offer.price, memo: offer.nonce }, 30);
    if (!r.ok) return note('outside', { ok: false, step: 'pay', err: r.err });
    const res = await fetch(`${cfg.outsideUrl}/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spore_id: me, signer_id: cfg.operatorId, tx_hash: r.hash }),
      signal: AbortSignal.timeout(30_000),
    });
    const got = await res.json();
    note('outside', { ok: res.ok, step: 'redeem', tx: r.hash, price: offer.price, data: got.data, err: got.error });
  } catch (e) {
    note('outside', { ok: false, step: 'http', err: (e as Error).message });
  }
}

// ---- provider -----------------------------------------------------------------

async function provide(jobs: any[], ctl: ReturnType<typeof readControl>) {
  const now = nowNs();
  const myCost = (cost * BigInt(ctl.raise[String(me)] ?? 10_000)) / 10_000n;
  for (const job of jobs) {
    if (job.status !== 'Open' || quoted.has(job.id) || job.consumer === me) continue;
    const task = decodeTask(job.task);
    if (!task || task.s !== SERVICES[myService]) continue;
    if (isCut(ctl, job.consumer, me) || BigInt(job.deadline_ns) <= now) continue;
    quoted.add(job.id);
    const price = quotePrice(myCost, margin);
    if (price > BigInt(job.max_price)) {
      note('priced_out', { job_id: job.id, price, max_price: job.max_price });
      continue;
    }
    await send('quote', { job_id: job.id, spore_id: me, price: price.toString() });
  }
  for (const job of jobs) {
    if (job.status !== 'Accepted' || job.provider !== me || delivered.has(job.id)) continue;
    delivered.add(job.id);
    wins++;
    const task = decodeTask(job.task);
    if (!task) continue;
    const out = deliver(cfg.seed, job.id, task, qualityBps);
    const body = JSON.stringify({ job_id: job.id, provider: me, answer: out.answer });
    const hash = resultHash(body);
    writeFileSync(join(resultsDir, hash.slice('sha256:'.length) + '.json'), body);
    await send('deliver', { job_id: job.id, result_hash: hash });
  }
}

// ---- consumer -----------------------------------------------------------------

/** The live providers of a service, from the run's spore list and the kill list. */
function providersOf(service: number, ctl: ReturnType<typeof readControl>, tried: number[]) {
  return cfg.spores.filter((id) => id !== me && serviceOf(id) === service && !ctl.killed.includes(id) && !tried.includes(id) && !isCut(ctl, me, id));
}

function finish(outcome: string, extra: object = {}) {
  if (!current) return;
  const c = current;
  if (c.decision) appendJsonl(DECISIONS, { ...c.decision, outcome, ...extra });
  if (outcome === 'rejected' && c.attempt + 1 < cfg.attempts) queue.unshift({ j: c.j, attempt: c.attempt + 1, tried: c.tried });
  current = null;
}

async function consume(jobs: any[], ctl: ReturnType<typeof readControl>, policyMax: string) {
  if (!current) {
    const next = queue.shift();
    if (!next) return;
    // Demand follows the shared rule (core market::job_service): any service but our own.
    const svc = jobService(cfg.seed, BigInt(epoch), BigInt(me), BigInt(next.j), SERVICES.length, myService);
    const task = makeTask(cfg.seed, svc, epoch, me, next.j, next.attempt);
    const taskText = encodeTask(task);
    const r = await send('post_job', { spore_id: me, task: taskText, max_price: policyMax });
    if (!r.ok) return;
    current = { ...next, jobId: Number(r.ret), task, taskText, postedAt: Date.now(), postTx: r.hash, phase: 'quotes' };
    return;
  }
  const job = jobs.find((j) => j.id === current!.jobId);
  if (current.phase === 'quotes') {
    if (!job) return finish('expired');
    const service = SERVICES.indexOf(current.task.s);
    const expected = providersOf(service, ctl, current.tried);
    const quotes: Quote[] = job.quotes
      .filter((q: any) => expected.includes(q.provider))
      .map((q: any) => ({ provider: q.provider, price: BigInt(q.price), d: edges.get(edgeKey(me, q.provider)) ?? 0n }));
    const waited = Date.now() - current.postedAt;
    if (quotes.length < expected.length && waited < cfg.quoteWaitMs) return;
    if (quotes.length === 0) {
      if (waited < 3 * cfg.quoteWaitMs) return;
      current.decision = null;
      return finish('no_quotes');
    }
    const i = pick(quotes, SHIPPED_W_BPS, SHIPPED_NORM)!;
    const ref = reference(quotes, SHIPPED_NORM);
    const winner = quotes[i].provider;
    current.tried.push(winner);
    current.decision = {
      run: cfg.runDir.split('/').pop(),
      at: new Date().toISOString(),
      epoch,
      job_id: current.jobId,
      consumer: me,
      service: current.task.s,
      task_hash: createHash('sha256').update(current.taskText).digest('hex'),
      attempt: current.attempt,
      rule: { w_bps: SHIPPED_W_BPS, norm: SHIPPED_NORM },
      candidates: quotes.map((q) => ({ provider: q.provider, price: q.price.toString(), d: q.d.toString(), d_norm: dNorm(q.d, ref).toString(), score: score(q.price, q.d, ref, SHIPPED_W_BPS).toString() })),
      winner,
      tx: { post: current.postTx } as Record<string, string>,
    };
    const r = await send('accept', { job_id: current.jobId, provider_id: winner });
    current.decision.tx.accept = r.hash;
    if (!r.ok) return finish('accept_failed', { err: r.err });
    current.phase = 'delivery';
    return;
  }
  // Waiting for delivery.
  if (!job) return finish('timeout');
  if (job.status !== 'Delivered') return;
  const hash: string = job.result_hash ?? '';
  const file = join(resultsDir, hash.replace(/^sha256:/, '') + '.json');
  let correct = false;
  if (existsSync(file)) {
    const body = readFileSync(file, 'utf8');
    correct = resultHash(body) === hash && JSON.parse(body).answer === solve(current.task);
  }
  const cut = isCut(ctl, me, job.provider);
  const method = correct && !cut ? 'settle' : 'reject';
  const r = await send(method, { job_id: current.jobId });
  current.decision.tx[method] = r.hash;
  finish(r.ok ? (method === 'settle' ? 'settled' : 'rejected') : `${method}_failed`, { correct, cut: cut || undefined, err: r.err || undefined });
}

// ---- main loop ----------------------------------------------------------------

async function main() {
  // Stagger the agents' polling so their RPC requests do not arrive together.
  await sleep((me * 997) % cfg.pollMs);
  note('start', { service: SERVICES[myService], cost, quality_bps: qualityBps, pid: process.pid });
  let summary: any = null;
  for (;;) {
    loops++;
    const ctl = readControl(cfg.runDir);
    if (ctl.killed.includes(me)) {
      note('killed');
      process.exit(0);
    }
    try {
      if (loops % 5 === 1 || idleReason) {
        if (!(await inControl())) {
          await sleep(cfg.pollMs * 2);
          continue;
        }
        summary = await view(cfg.router, 'spore_summary', { spore_id: me });
      }
      // epoch_info only changes at a close, so re-read it once the cached
      // epoch has ended (or every 10 loops as a fallback).
      if (nowNs() >= epochEnds || loops % 10 === 0) {
        const info = await view(cfg.router, 'epoch_info');
        epochEnds = BigInt(info.ends_ns);
        if (info.epoch !== epoch) await onNewEpoch(info.epoch);
      }
      const jobs = await view(cfg.router, 'list_jobs', { from_index: 0, limit: 100 });
      await provide(jobs, ctl);
      await consume(jobs, ctl, summary.policy.max_payment);
    } catch (e) {
      note('error', { err: (e as Error).message });
    }
    await sleep(cfg.pollMs);
  }
}

process.on('SIGTERM', () => {
  note('stop');
  process.exit(0);
});
main();
