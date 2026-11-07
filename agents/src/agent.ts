// Agents for active spores (SPEC §4, §6). Usage: SPORE_ID=N node src/agent.ts,
// or SPORE_IDS=9-63 for one process running many spores (Phase 6: 64 one-spore
// processes would each poll the RPC; here they share one `list_jobs`,
// `epoch_info` and `edges` read). Normally started by run.ts. Each spore signs
// with its own function-call key, <KEY_PREFIX>SPORE_<N>_FC_PRIVATE_KEY on the
// operator account (KEY_PREFIX may list several prefixes, first match wins),
// limited to the router's job and pay methods; a spore whose registered
// operator is OPERATOR2_ACCOUNT_ID signs with <KEY_PREFIX>OPERATOR2_FC_PRIVATE_KEY.
// After a sale the new owner's operator takes over: run.ts starts the agent
// again with AGENT_OPERATOR_ACCOUNT_ID and AGENT_FC_PRIVATE_KEY. Every money
// decision follows the shared rules (rules.ts = spores-core): providers quote
// cost * (1 + margin); consumers hire by quote / (1 + w * D_norm) and log each
// decision.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonl, ensureDir, envKey, isCut, loadConfig, nowNs, parseIds, readControl, sleep, type Control } from './common.ts';
import { Caller, allJobs, rpcSince, view, type TxResult } from './near.ts';
import { MAX_QUOTES, quoters } from './quoters.ts';
import { MARGIN_START, SHIPPED_NORM, SHIPPED_W_BPS, dNorm, jobService, nextMargin, pick, quotePrice, reference, score, type Quote } from './rules.ts';
import { SERVICES, decodeTask, deliver, encodeTask, makeTask, profile, resultHash, serviceOf, solve, type Task } from './services.ts';

const cfg = loadConfig();
const mine = parseIds(process.env.SPORE_IDS ?? process.env.SPORE_ID ?? '');
if (mine.length === 0 || mine.some((id) => !Number.isInteger(id))) throw new Error('set SPORE_ID or SPORE_IDS');
const resultsDir = join(cfg.runDir, 'results');
ensureDir(resultsDir);
const DECISIONS = join(cfg.runDir, 'decisions.jsonl');
const EVENTS = join(cfg.runDir, 'events.jsonl');
const edgeKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
const processLabel = mine.length === 1 ? mine[0] : 'agents';

// ---- chain state shared by every spore in this process -----------------------

let epoch = -1;
let epochEnds = 0n;
let edges = new Map<string, bigint>();
let lastEpochRead = 0;
let epochRead: Promise<number> | null = null;
let jobsCache: { at: number; jobs: Promise<any[]> } | null = null;

const rpcNote = (extra: object = {}) =>
  appendJsonl(EVENTS, { at: new Date().toISOString(), spore: processLabel, kind: 'rpc', epoch, spores: mine.length, ...extra, ...rpcSince() });

/**
 * The current epoch. Re-reads `epoch_info` once the cached epoch has ended
 * (or every 10 polls) and `edges` when the epoch changes, once for all spores.
 * Logs this process's RPC requests for the epoch that just ended.
 */
function currentEpoch(): Promise<number> {
  if (nowNs() < epochEnds && Date.now() - lastEpochRead < 10 * cfg.pollMs) return Promise.resolve(epoch);
  epochRead ??= (async () => {
    try {
      const info = await view(cfg.router, 'epoch_info');
      if (info.epoch !== epoch) {
        edges = new Map((await view(cfg.router, 'edges')).map(([a, b, d]: [number, number, string]) => [edgeKey(a, b), BigInt(d)]));
        if (epoch >= 0) rpcNote();
        else rpcSince();
        epoch = info.epoch;
      }
      epochEnds = BigInt(info.ends_ns);
      lastEpochRead = Date.now();
      return epoch;
    } finally {
      epochRead = null;
    }
  })();
  return epochRead;
}

/** Every open job, read at most once per half poll interval for all spores. */
function currentJobs(): Promise<any[]> {
  if (!jobsCache || Date.now() - jobsCache.at > cfg.pollMs / 2) {
    const jobs = allJobs(cfg.router);
    jobsCache = { at: Date.now(), jobs };
    jobs.catch(() => (jobsCache = null));
  }
  return jobsCache.jobs;
}

/** The providers that quote on `job` (every live provider of the service unless QUOTE_FANOUT limits it). */
function quotersOf(job: { id: number; consumer: number }, service: number, ctl: Control): number[] {
  const live = cfg.spores.filter((id) => id !== job.consumer && serviceOf(id) === service && !ctl.killed.includes(id) && !isCut(ctl, job.consumer, id));
  return quoters(live, job.id, cfg.seed, (p) => edges.get(edgeKey(job.consumer, p)) ?? 0n, cfg.quoteFanout);
}

// ---- one spore ------------------------------------------------------------------

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

class Agent {
  readonly me: number;
  readonly operatorId: string;
  private readonly chain: Caller;
  private readonly myService: number;
  private readonly cost: bigint;
  private readonly qualityBps: number;
  // consumer
  private queue: Pending[] = [];
  private current: Current | null = null;
  private epoch = -1;
  // provider
  private margin = MARGIN_START;
  private wins = 0;
  private readonly quoted = new Set<number>();
  private readonly delivered = new Set<number>();
  // control
  private idleReason = '';
  private loops = 0;
  private summary: any = null;
  /** Escrowed since `summary` was read: budget and balance checks before an accept start from it. */
  private spentSinceSummary = 0n;
  private recheck = true;

  constructor(me: number, operatorId: string, key: string) {
    this.me = me;
    this.operatorId = operatorId;
    this.chain = new Caller(operatorId, key, cfg.router, 'EXECUTED_OPTIMISTIC');
    this.myService = serviceOf(me);
    const p = profile(cfg.seed, me);
    this.cost = p.cost;
    this.qualityBps = p.qualityBps;
  }

  note(kind: string, extra: object = {}) {
    appendJsonl(EVENTS, { at: new Date().toISOString(), spore: this.me, kind, ...extra });
  }

  private async send(method: string, args: object, gasTgas?: number): Promise<TxResult> {
    const r = await this.chain.call(method, args, 0n, gasTgas);
    this.note('tx', { method, args, hash: r.hash, ok: r.ok, err: r.err || undefined, gas_tgas: r.gasTgas });
    // Lost control (a sale, a new operator, a pause): look again before the next step.
    if (!r.ok && /not this spore's operator|spore is paused|spore is not active/.test(r.err)) this.recheck = true;
    return r;
  }

  private async inControl(): Promise<boolean> {
    const s = await view(cfg.router, 'spore_summary', { spore_id: this.me });
    const why = !s ? 'unknown spore' : !s.active ? 'spore is not active' : s.operator_id !== this.operatorId ? 'not the registered operator' : s.policy.paused ? 'policy is paused' : '';
    if (why !== this.idleReason) this.note(why ? 'idle' : 'resumed', { reason: why || undefined, operator_gen: s?.operator_gen });
    this.idleReason = why;
    if (!why) {
      this.summary = s;
      this.spentSinceSummary = 0n;
    }
    return !why;
  }

  private async onNewEpoch(e: number) {
    if (this.epoch >= 0) {
      const next = nextMargin(this.margin, this.wins);
      this.note('margin', { epoch: this.epoch, wins: this.wins, from: this.margin, to: next });
      this.margin = next;
      this.wins = 0;
    }
    this.epoch = e;
    // Keep retries still waiting from the last epoch; add this epoch's jobs
    // (every POST_EVERY epochs, staggered by spore id).
    const posting = e % cfg.postEvery === this.me % cfg.postEvery;
    this.queue = [...this.queue.filter((p) => p.attempt > 0), ...Array.from({ length: posting ? cfg.jobsPerEpoch : 0 }, (_, j) => ({ j, attempt: 0, tried: [] as number[] }))];
    if (cfg.buyEvery > 0 && e % cfg.buyEvery === this.me % cfg.buyEvery) await this.buyOutside();
  }

  private async buyOutside() {
    try {
      const offer = await (await fetch(`${cfg.outsideUrl}/offer?spore_id=${this.me}`, { signal: AbortSignal.timeout(5_000) })).json();
      // The transfer and its callback need more than a job call's 10 Tgas.
      const r = await this.send('pay_service', { spore_id: this.me, payee: offer.payee, amount: offer.price, memo: offer.nonce }, 30);
      if (!r.ok) return this.note('outside', { ok: false, step: 'pay', err: r.err });
      const res = await fetch(`${cfg.outsideUrl}/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spore_id: this.me, signer_id: this.operatorId, tx_hash: r.hash }),
        signal: AbortSignal.timeout(30_000),
      });
      const got = await res.json();
      this.note('outside', { ok: res.ok, step: 'redeem', tx: r.hash, price: offer.price, data: got.data, err: got.error });
    } catch (e) {
      this.note('outside', { ok: false, step: 'http', err: (e as Error).message });
    }
  }

  // ---- provider ---------------------------------------------------------------

  private async provide(jobs: any[], ctl: Control) {
    const me = this.me;
    const now = nowNs();
    const myCost = (this.cost * BigInt(ctl.raise[String(me)] ?? 10_000)) / 10_000n;
    for (const job of jobs) {
      if (job.status !== 'Open' || this.quoted.has(job.id) || job.consumer === me) continue;
      const task = decodeTask(job.task);
      if (!task || task.s !== SERVICES[this.myService]) continue;
      if (isCut(ctl, job.consumer, me) || BigInt(job.deadline_ns) <= now) continue;
      // Not asked to bid on this one, or the router already holds MAX_QUOTES quotes.
      if (cfg.quoteFanout > 0 && !quotersOf(job, this.myService, ctl).includes(me)) continue;
      if (job.quotes.length >= MAX_QUOTES) continue;
      this.quoted.add(job.id);
      const price = quotePrice(myCost, this.margin);
      if (price > BigInt(job.max_price)) {
        this.note('priced_out', { job_id: job.id, price, max_price: job.max_price });
        continue;
      }
      await this.send('quote', { job_id: job.id, spore_id: me, price: price.toString() });
    }
    for (const job of jobs) {
      if (job.status !== 'Accepted' || job.provider !== me || this.delivered.has(job.id)) continue;
      this.delivered.add(job.id);
      this.wins++;
      const task = decodeTask(job.task);
      if (!task) continue;
      const out = deliver(cfg.seed, job.id, task, this.qualityBps);
      const body = JSON.stringify({ job_id: job.id, provider: me, answer: out.answer });
      const hash = resultHash(body);
      writeFileSync(join(resultsDir, hash.slice('sha256:'.length) + '.json'), body);
      await this.send('deliver', { job_id: job.id, result_hash: hash });
    }
  }

  // ---- consumer ---------------------------------------------------------------

  private finish(outcome: string, extra: object = {}) {
    const c = this.current;
    if (!c) return;
    if (c.decision) appendJsonl(DECISIONS, { ...c.decision, outcome, ...extra });
    if (outcome === 'rejected' && c.attempt + 1 < cfg.attempts) this.queue.unshift({ j: c.j, attempt: c.attempt + 1, tried: c.tried });
    this.current = null;
  }

  private async consume(jobs: any[], ctl: Control) {
    const me = this.me;
    if (!this.current) {
      const next = this.queue.shift();
      if (!next) return;
      // Demand follows the shared rule (core market::job_service): any service but our own.
      const svc = jobService(cfg.seed, BigInt(this.epoch), BigInt(me), BigInt(next.j), SERVICES.length, this.myService);
      const task = makeTask(cfg.seed, svc, this.epoch, me, next.j, next.attempt);
      const taskText = encodeTask(task);
      const r = await this.send('post_job', { spore_id: me, task: taskText, max_price: this.summary.policy.max_payment });
      if (!r.ok) return;
      this.current = { ...next, jobId: Number(r.ret), task, taskText, postedAt: Date.now(), postTx: r.hash, phase: 'quotes' };
      return;
    }
    const current = this.current;
    const job = jobs.find((j) => j.id === current.jobId);
    if (current.phase === 'quotes') {
      if (!job) return this.finish('expired');
      const service = SERVICES.indexOf(current.task.s);
      const expected = quotersOf({ id: current.jobId, consumer: me }, service, ctl).filter((p) => !current.tried.includes(p));
      const quotes: Quote[] = job.quotes
        .filter((q: any) => expected.includes(q.provider))
        .map((q: any) => ({ provider: q.provider, price: BigInt(q.price), d: edges.get(edgeKey(me, q.provider)) ?? 0n }));
      const waited = Date.now() - current.postedAt;
      if (quotes.length < Math.min(expected.length, MAX_QUOTES) && waited < cfg.quoteWaitMs) return;
      if (quotes.length === 0) {
        if (waited < 3 * cfg.quoteWaitMs) return;
        current.decision = null;
        return this.finish('no_quotes');
      }
      const i = pick(quotes, SHIPPED_W_BPS, SHIPPED_NORM)!;
      const ref = reference(quotes, SHIPPED_NORM);
      const winner = quotes[i].provider;
      current.tried.push(winner);
      current.decision = {
        run: cfg.runDir.split('/').pop(),
        at: new Date().toISOString(),
        epoch: this.epoch,
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
      // The router enforces the living allowance (SPEC §7.2) and the balance;
      // skip a hire it would refuse instead of spending a failed transaction on it.
      // The summary read this epoch, less what was escrowed since, is a lower
      // bound (income is ignored): read the chain only when it says no.
      const price = quotes[i].price;
      const fits = (s: any, spent: bigint) => BigInt(s.budget_left) - spent >= price && BigInt(s.balance) - spent >= price;
      if (!this.summary || !fits(this.summary, this.spentSinceSummary)) {
        const s = await view(cfg.router, 'spore_summary', { spore_id: me });
        if (s && BigInt(s.budget_left) < price) return this.finish('over_budget', { budget_left: s.budget_left });
        if (s && BigInt(s.balance) < price) return this.finish('low_balance', { balance: s.balance });
        if (s) {
          this.summary = s;
          this.spentSinceSummary = 0n;
        }
      }
      // A refusal (including the router's epoch pair cap) is logged with the
      // decision like any failed accept; the next epoch brings new jobs.
      const r = await this.send('accept', { job_id: current.jobId, provider_id: winner });
      current.decision.tx.accept = r.hash;
      if (!r.ok) return this.finish('accept_failed', { err: r.err });
      this.spentSinceSummary += price;
      current.phase = 'delivery';
      return;
    }
    // Waiting for delivery.
    if (!job) return this.finish('timeout');
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
    const r = await this.send(method, { job_id: current.jobId });
    current.decision.tx[method] = r.hash;
    this.finish(r.ok ? (method === 'settle' ? 'settled' : 'rejected') : `${method}_failed`, { correct, cut: cut || undefined, err: r.err || undefined });
  }

  // ---- loop -------------------------------------------------------------------

  async run() {
    // Stagger the spores' polling so their requests do not arrive together.
    await sleep((this.me * 997) % cfg.pollMs);
    this.note('start', { service: SERVICES[this.myService], cost: this.cost, quality_bps: this.qualityBps, operator: this.operatorId, pid: process.pid });
    for (;;) {
      this.loops++;
      const ctl = readControl(cfg.runDir);
      if (ctl.killed.includes(this.me)) return this.note('killed');
      try {
        const e = await currentEpoch();
        // Control and policy: every CONTROL_EVERY polls, at a new epoch, while
        // idle, and right after a call failed for lack of control.
        if (this.recheck || this.idleReason || e !== this.epoch || this.loops % cfg.controlEvery === 1) {
          this.recheck = false;
          if (!(await this.inControl())) {
            await sleep(cfg.pollMs * 2);
            continue;
          }
        }
        if (e !== this.epoch) await this.onNewEpoch(e);
        const jobs = await currentJobs();
        await this.provide(jobs, ctl);
        await this.consume(jobs, ctl);
      } catch (e) {
        this.note('error', { err: (e as Error).message });
      }
      await sleep(cfg.pollMs);
    }
  }
}

// ---- main ---------------------------------------------------------------------

async function operatorAndKey(id: number): Promise<[string, string]> {
  const forced = process.env.AGENT_OPERATOR_ACCOUNT_ID;
  if (forced) {
    const key = process.env.AGENT_FC_PRIVATE_KEY;
    if (!key || mine.length !== 1) throw new Error('AGENT_OPERATOR_ACCOUNT_ID needs AGENT_FC_PRIVATE_KEY and a single SPORE_ID');
    return [forced, key];
  }
  // A spore the buyer runs through operator2 (spore 5 on router4 since Phase 5).
  const op2 = process.env.OPERATOR2_ACCOUNT_ID;
  const op2Key = envKey('OPERATOR2_FC_PRIVATE_KEY');
  if (op2 && op2Key && (await view(cfg.router, 'spore_summary', { spore_id: id }))?.operator_id === op2) return [op2, op2Key];
  const key = envKey(`SPORE_${id}_FC_PRIVATE_KEY`);
  if (!key) throw new Error(`no <KEY_PREFIX>SPORE_${id}_FC_PRIVATE_KEY (KEY_PREFIX=${process.env.KEY_PREFIX ?? ''})`);
  return [cfg.operatorId, key];
}

async function main() {
  const agents = await Promise.all(mine.map(async (id) => new Agent(id, ...(await operatorAndKey(id)))));
  await Promise.all(agents.map((a) => a.run()));
  rpcNote({ final: true });
}

process.on('SIGTERM', () => {
  rpcNote({ final: true });
  for (const id of mine) appendJsonl(EVENTS, { at: new Date().toISOString(), spore: id, kind: 'stop' });
  process.exit(0);
});
main();
