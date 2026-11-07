// Rogue agent scene on router4 (SPEC §7.3): the owner
// sets narrow limits in the contract, a scripted agent with the spore's real
// operator key breaks each one, and the contract refuses. Then the agent stays
// quiet for two closes and the spore's tubes decay.
//
// Every line it prints is a real event: a tx it sent, the chain's outcome, a
// view it read. Money decisions are fixed by the script; nothing here is a
// model, and the UI says "scripted". Exit 0 only if every check passed.
//
//   node agents/src/scenes/rogue.ts [--run NAME] [--spore N] [--provider N]
//   node agents/src/scenes/rogue.ts --reset     restores the policy of a run that died before it could
//
// Output: JSON lines on stdout and in out/agents/<run>/scene.jsonl, plus
// run.json and events.jsonl in the run-log format (Reference C), so Activity
// can read the same run. Keys come from .env and are never printed.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendJsonl, ensureDir, envKey, sleep } from '../common.ts';
import { Caller, chainTimeNs, view, type TxResult } from '../near.ts';

const NEAR = 10n ** 24n;
const milli = (n: bigint) => (n * NEAR) / 1000n;

export const LIMITS = { max_payment: milli(20n), budget_per_epoch: milli(30n) };
/** Above the cap. */
export const OVER_CAP = milli(50n);
/** Inside the cap; two of them pass the budget. */
export const EACH = milli(20n);
/** Inside the cap and the budget left, so only the payee can be the reason. */
export const DRAIN = milli(10n);
/** Never on any allowlist. It doesn't have to exist: the contract refuses before any transfer. */
export const ATTACKER = 'attacker.spores-hack.testnet';
/** Closes the agent stays quiet for (the decay strip's N, N+1, N+2). */
export const QUIET_CLOSES = 2;
const CLOSE_GAS_TGAS = 300;
const MIN_BALANCE = milli(100n);

export const ERR_CAP = 'policy: payment exceeds the per-payment cap';
export const ERR_BUDGET = 'policy: epoch budget exceeded';
export const ERR_PAYEE = 'policy: payee is not on the external allowlist';

export type Role = 'owner' | 'agent' | 'provider' | 'keeper';

/** All the chain this scene touches, so tests can drive it without a network. */
export interface SceneChain {
  view(method: string, args?: object): Promise<any>;
  call(role: Role, method: string, args: object, deposit?: bigint, gasTgas?: number): Promise<TxResult>;
  timeNs(): Promise<bigint>;
  sleep(ms: number): Promise<void>;
}

export type Emit = (e: Record<string, unknown> & { type: string }) => void;

/** NEAR's prefix goes; the contract's own words stay exact. */
export const panicText = (err: string) => err.replace(/^Smart contract panicked: /, '');

export function tubesOf(summary: any): [number, string][] {
  return (summary.connections ?? []).map(([n, d]: [number, string]) => [n, String(d)]);
}

/** D after `closes` closes with no flow (integer, as `spores_core`: D − D·decay/10000). */
export function decayed(d: bigint, decayBps: bigint, closes: number): bigint {
  let v = d;
  for (let i = 0; i < closes; i++) v -= (v * decayBps) / 10_000n;
  return v;
}

export interface PickOpts {
  /** Accounts whose keys this process holds. */
  owners: string[];
  /** May this spore's operator key sign? */
  hasOperatorKey: (id: number) => boolean;
  /** The account those keys belong to; a spore run by anyone else can't take part. */
  operator?: string;
  spore?: number;
  provider?: number;
}

export interface ScenePick {
  spore: number;
  provider: number;
  summary: any;
  reason: string;
}

/** Slots between `id` and the nearest of `others` on the 64-slot ring. */
export function ringGap(id: number, others: Iterable<number>): number {
  let best = 64;
  for (const o of others) {
    const d = Math.abs(id - o) % 64;
    best = Math.min(best, d, 64 - d);
  }
  return best;
}

const inPairs = (pairs: number[][], id: number) => pairs.some(([a, b]) => a === id || b === id);

/** Why this spore can't star, or null. */
export function unfit(s: any, info: any, config: any, opts: PickOpts): string | null {
  if (!s.active) return 'not active';
  if (s.policy?.paused) return 'paused';
  if (s.listed_price) return 'listed';
  if (!opts.owners.includes(s.owner_id)) return `no key for its owner ${s.owner_id}`;
  if (!opts.hasOperatorKey(s.spore_id)) return 'no operator key';
  if (opts.operator && s.operator_id !== opts.operator) return `run by ${s.operator_id}`;
  if (BigInt(s.balance) < MIN_BALANCE) return 'balance under 0.1 NEAR';
  if (BigInt(s.spent_this_epoch) !== 0n) return 'already spent this epoch';
  // A flow or reject on it this epoch would move its tubes or pay it a rebate at the close.
  if (inPairs(info.flows, s.spore_id) || inPairs(info.rejects, s.spore_id)) return 'it traded this epoch';
  const survivors = tubesOf(s).filter(([, d]) => decayed(BigInt(d), BigInt(config.decay_bps), QUIET_CLOSES) >= BigInt(config.d_min));
  if (survivors.length < 2) return 'fewer than 2 tubes would outlast the quiet closes';
  return null;
}

/**
 * The spore with the most tubes that fits (ties: most D), and a provider with
 * no tube to it, so nothing here touches the tubes being watched.
 */
export async function pickSpores(chain: ViewChain, opts: PickOpts): Promise<ScenePick> {
  const [edges, info, config] = await Promise.all([chain.view('edges'), chain.view('epoch_info'), chain.view('config')]);
  const stats = new Map<number, { degree: number; total: bigint }>();
  for (const [a, b, d] of edges as [number, number, string][]) {
    for (const id of [a, b]) {
      const s = stats.get(id) ?? { degree: 0, total: 0n };
      stats.set(id, { degree: s.degree + 1, total: s.total + BigInt(d) });
    }
  }
  const order = opts.spore !== undefined ? [opts.spore] : [...stats.entries()].sort((x, y) => y[1].degree - x[1].degree || (y[1].total > x[1].total ? 1 : y[1].total < x[1].total ? -1 : x[0] - y[0])).map(([id]) => id);
  let summary: any = null;
  const refused: string[] = [];
  for (const id of order.slice(0, 8)) {
    const s = await chain.view('spore_summary', { spore_id: id });
    const why = unfit(s, info, config, opts);
    if (!why) {
      summary = s;
      break;
    }
    refused.push(`#${id}: ${why}`);
  }
  if (!summary) throw new Error(`no spore fits the scene (${refused.join('; ') || 'no tubes on the router'}); scripts/phase6-testnet.sh grows tubes`);
  const partners = new Set(tubesOf(summary).map(([n]) => n));
  // Far round the ring from its tubes, so on the stage the attempts have room and never cross a tube.
  const providers = opts.provider !== undefined ? [opts.provider] : (info.active as number[]).filter((id) => id !== summary.spore_id && !partners.has(id) && opts.hasOperatorKey(id)).sort((a, b) => ringGap(b, partners) - ringGap(a, partners) || a - b);
  for (const id of providers.slice(0, 8)) {
    const p = await chain.view('spore_summary', { spore_id: id });
    if (p.active && !p.policy.paused && p.operator_id && (!opts.operator || p.operator_id === opts.operator) && !p.listed_price && !partners.has(id) && id !== summary.spore_id && opts.hasOperatorKey(id)) {
      return { spore: summary.spore_id, provider: id, summary, reason: `most tubes (${partners.size}) among the spores with keys` };
    }
  }
  throw new Error(`no provider for spore ${summary.spore_id}: every candidate is paused, listed or has a tube to it`);
}
type ViewChain = Pick<SceneChain, 'view'>;

const artOf = (r: any) => ({ id: r.spore_id, seed: r.seed, age: r.age, edges: r.edges });

export interface SceneResult {
  ok: boolean;
  passed: number;
  total: number;
}

/**
 * The scene. `onPolicySet` runs right after the owner narrows the policy, so
 * a crash afterwards can still be undone (`--reset`); `onPolicyRestored` when
 * the policy is back.
 */
export async function runRogue(chain: SceneChain, emit: Emit, opts: PickOpts & { run: string; router: string; onPolicySet?: (spore: number, policy: unknown) => void; onPolicyRestored?: () => void }): Promise<SceneResult> {
  let n = 0;
  const checks: { n: number; ok: boolean }[] = [];
  const check = (name: string, ok: boolean, expected: string, actual: string, tx?: string) => {
    checks.push({ n: checks.length + 1, ok });
    emit({ type: 'check', n: checks.length, name, ok, expected, actual, tx });
  };
  const tx = async (role: Role, act: string, method: string, args: object, meta: { action: string; attempt?: string; amount?: bigint; expected?: string; closed?: number }, deposit = 0n, gas?: number) => {
    const id = `s${++n}`;
    const expected = meta.expected ?? 'ok';
    emit({ type: 'step', id, act, attempt: meta.attempt, actor: role, method, action: meta.action, amount: meta.amount?.toString(), expected });
    const r = await chain.call(role, method, args, deposit, gas);
    emit({ type: 'result', id, ok: r.ok, tx: r.hash, err: r.ok ? '' : panicText(r.err), gas_tgas: r.gasTgas, ret: r.ret ?? undefined, args, role, method, closed: meta.closed });
    return r;
  };
  const snapshot = async (label: string, id: number) => {
    const [s, art, info] = await Promise.all([chain.view('spore_summary', { spore_id: id }), chain.view('render_input', { spore_id: id }), chain.view('epoch_info')]);
    emit({ type: 'snapshot', label, spore: id, epoch: info.epoch, balance: s.balance, reputation: s.reputation, degree: s.degree, connections: tubesOf(s), spent: s.spent_this_epoch, effective_budget: s.effective_budget, policy: s.policy, posted_jobs: s.posted_jobs, art: artOf(art) });
    return { s, art, info };
  };

  const pick = await pickSpores(chain, opts);
  const X = pick.spore;
  const P = pick.provider;
  const config = await chain.view('config');
  const peerIds = [P, ...tubesOf(pick.summary).map(([id]) => id)];
  const peers = await Promise.all(peerIds.map((id) => chain.view('render_input', { spore_id: id }).then(artOf)));
  emit({
    type: 'start',
    scene: 'rogue',
    run: opts.run,
    router: opts.router,
    spore: X,
    provider: P,
    attacker: ATTACKER,
    owner: pick.summary.owner_id,
    operator: pick.summary.operator_id,
    limits: { max_payment: LIMITS.max_payment.toString(), budget_per_epoch: LIMITS.budget_per_epoch.toString() },
    d_min: config.d_min,
    decay_bps: config.decay_bps,
    epoch_len_ns: config.epoch_len_ns,
    job_timeout_ns: config.job_timeout_ns,
    reason: pick.reason,
    peers,
  });

  const original = pick.summary.policy;
  let restored = false;
  const jobs: number[] = [];
  const restore = async () => {
    if (restored) return true;
    const r = await tx('owner', 'cleanup', 'set_policy', { spore_id: X, policy: original }, { action: 'owner puts the original policy back' }, 1n, 30);
    restored = r.ok;
    if (r.ok) opts.onPolicyRestored?.();
    return r.ok;
  };

  try {
    // --- limits ---------------------------------------------------------------
    emit({ type: 'act', act: 'limits' });
    // Jobs left over from earlier runs would hold posting slots; past their deadline anyone may clear them.
    for (const job of pick.summary.posted_jobs ?? []) {
      const j = await chain.view('get_job', { job_id: job }).catch(() => null);
      if (j && BigInt(j.deadline_ns) <= (await chain.timeNs())) await tx('keeper', 'limits', 'timeout_job', { job_id: job }, { action: `clear job ${job}, left over from an earlier run and past its deadline` }, 0n, 30);
    }
    const { s: before } = await snapshot('before', X);
    const policy = { paused: false, budget_per_epoch: LIMITS.budget_per_epoch.toString(), max_payment: LIMITS.max_payment.toString(), allow_all_spores: false, allowlist: [P], external_allowlist: [] };
    opts.onPolicySet?.(X, original);
    const set = await tx('owner', 'limits', 'set_policy', { spore_id: X, policy }, { action: 'owner sets the limits in the contract' }, 1n, 30);
    if (!set.ok) throw new Error(`set_policy failed: ${panicText(set.err)}`);
    await snapshot('limits', X);

    const post = async (act: string, attempt: string, maxPrice: bigint) => {
      const r = await tx('agent', act, 'post_job', { spore_id: X, task: `rogue scene ${opts.run}`, max_price: maxPrice.toString() }, { action: 'agent posts a job', attempt });
      if (!r.ok) throw new Error(`post_job failed: ${panicText(r.err)}`);
      const job = Number(r.ret);
      jobs.push(job);
      const q = await tx('provider', act, 'quote', { job_id: job, spore_id: P, price: maxPrice.toString() }, { action: `Spore #${P} quotes`, attempt, amount: maxPrice });
      if (!q.ok) throw new Error(`quote failed: ${panicText(q.err)}`);
      return job;
    };
    const refused = (name: string, r: TxResult, expected: string) => check(name, !r.ok && panicText(r.err) === expected, expected, r.ok ? 'the tx succeeded' : panicText(r.err), r.hash);

    // --- attempt 1: above the per-payment cap ---------------------------------
    emit({ type: 'act', act: 'cap' });
    const j1 = await post('cap', 'cap', OVER_CAP);
    const a1 = await tx('agent', 'cap', 'accept', { job_id: j1, provider_id: P }, { action: 'operator key called accept', attempt: 'cap', amount: OVER_CAP, expected: ERR_CAP });
    refused('A payment above the cap is refused', a1, ERR_CAP);

    // --- attempt 2: inside the cap, past the budget ---------------------------
    emit({ type: 'act', act: 'budget' });
    const j2 = await post('budget', 'budget', EACH);
    const a2 = await tx('agent', 'budget', 'accept', { job_id: j2, provider_id: P }, { action: 'operator key called accept', attempt: 'budget', amount: EACH });
    check('A payment inside the limits goes through', a2.ok, 'ok', a2.ok ? 'ok' : panicText(a2.err), a2.hash);
    await snapshot('escrow', X);
    const j3 = await post('budget', 'budget', EACH);
    const a3 = await tx('agent', 'budget', 'accept', { job_id: j3, provider_id: P }, { action: 'operator key called accept again', attempt: 'budget', amount: EACH, expected: ERR_BUDGET });
    refused('A payment past the epoch budget is refused', a3, ERR_BUDGET);

    // --- attempt 3: straight to an account the owner never approved ----------
    emit({ type: 'act', act: 'drain' });
    const a4 = await tx('agent', 'drain', 'pay_service', { spore_id: X, payee: ATTACKER, amount: DRAIN.toString(), memo: 'rogue scene' }, { action: 'operator key called pay_service', attempt: 'drain', amount: DRAIN, expected: ERR_PAYEE }, 0n, 60);
    refused('A payment to an unapproved account is refused', a4, ERR_PAYEE);
    const { s: afterRefusals } = await snapshot('after_refusals', X);
    const expectedBalance = BigInt(before.balance) - (a2.ok ? EACH : 0n);
    check('The refused attempts moved nothing', BigInt(afterRefusals.balance) === expectedBalance, `balance ${expectedBalance} (only the allowed payment left, into escrow)`, `balance ${afterRefusals.balance}`);

    // --- the agent stays quiet: decay ----------------------------------------
    emit({ type: 'act', act: 'quiet' });
    const series: { epoch: number; tubes: Map<number, bigint>; rep: bigint }[] = [];
    const tubesNow = (s: any) => new Map(tubesOf(s).map(([id, d]) => [id, BigInt(d)]));
    series.push({ epoch: (await chain.view('epoch_info')).epoch, tubes: tubesNow(afterRefusals), rep: BigInt(afterRefusals.reputation) });
    for (let i = 0; i < QUIET_CLOSES; i++) {
      const closedEpoch = await closeOnce(chain, tx, emit);
      const { s } = await snapshot('close', X);
      series.push({ epoch: closedEpoch + 1, tubes: tubesNow(s), rep: BigInt(s.reputation) });
    }
    const shrank = series.slice(1).every((now, i) => {
      const was = series[i];
      return [...was.tubes].every(([id, d]) => (now.tubes.get(id) ?? 0n) < d) && [...now.tubes.keys()].every((id) => was.tubes.has(id)) && now.rep < was.rep;
    });
    check('Every tube shrank at every close while the agent was quiet', shrank, 'each D and R lower at each close, no new tube', series.map((s) => `E${s.epoch} R ${s.rep}`).join(' → '));

    // --- cleanup ---------------------------------------------------------------
    emit({ type: 'act', act: 'cleanup' });
    const deadlines = await Promise.all(jobs.map((job) => chain.view('get_job', { job_id: job })));
    const last = deadlines.reduce((m, j) => (BigInt(j.deadline_ns) > m ? BigInt(j.deadline_ns) : m), 0n);
    await waitUntil(chain, emit, last, 'the jobs to reach their deadline');
    for (const job of jobs) await tx('keeper', 'cleanup', 'timeout_job', { job_id: job }, { action: `refund job ${job} at its deadline (nobody delivered)` }, 0n, 30);
    const back = await restore();
    const { s: after } = await snapshot('after', X);
    check('The escrowed payment came back', BigInt(after.balance) === BigInt(before.balance), `balance ${before.balance}`, `balance ${after.balance}`);
    check('The owner’s policy is back as it was', back && JSON.stringify(after.policy) === JSON.stringify(original), JSON.stringify(original), JSON.stringify(after.policy));
  } catch (e) {
    check('The scene ran to the end', false, 'no error', (e as Error).message);
  } finally {
    if (!restored) await restore().catch((e) => emit({ type: 'note', note: `could not restore the policy: ${(e as Error).message}` }));
  }

  const passed = checks.filter((c) => c.ok).length;
  const ok = passed === checks.length;
  emit({ type: 'done', ok, passed, total: checks.length });
  return { ok, passed, total: checks.length };
}

async function waitUntil(chain: SceneChain, emit: Emit, untilNs: bigint, what: string) {
  const now = await chain.timeNs();
  if (now >= untilNs) return;
  emit({ type: 'wait', what, seconds: Number((untilNs - now) / 1_000_000_000n) + 1 });
  for (;;) {
    const t = await chain.timeNs();
    if (t >= untilNs) return;
    await chain.sleep(Math.min(5_000, Number((untilNs - t) / 1_000_000n) + 200));
  }
}

/** Waits for the open epoch to end and closes it. Someone else closing first is fine: the view says so. Returns the epoch that closed. */
async function closeOnce(chain: SceneChain, tx: (role: Role, act: string, method: string, args: object, meta: { action: string; closed?: number }, deposit?: bigint, gas?: number) => Promise<TxResult>, emit: Emit): Promise<number> {
  const info = await chain.view('epoch_info');
  await waitUntil(chain, emit, BigInt(info.ends_ns), `epoch ${info.epoch} to end`);
  const r = await tx('keeper', 'quiet', 'close_epoch', {}, { action: `anyone closes epoch ${info.epoch}`, closed: info.epoch }, 0n, CLOSE_GAS_TGAS);
  const now = await chain.view('epoch_info');
  if (now.epoch <= info.epoch) throw new Error(`epoch ${info.epoch} did not close: ${panicText(r.err)}`);
  const fingerprint = await chain.view('fingerprint', { epoch: info.epoch }).catch(() => null);
  emit({ type: 'close', epoch: info.epoch, tx: r.ok ? r.hash : null, closed_by_us: r.ok, fingerprint });
  return info.epoch;
}

// ---------------------------------------------------------------------------
// The real chain, keys from .env. Only below this line touches files or keys.

export const ROOT = resolve(import.meta.dirname, '../../..');

export function loadDotEnv(root = ROOT): Record<string, string> {
  const env: Record<string, string> = {};
  const file = join(root, '.env');
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const withPrefix = (env: Record<string, string>) => ({ ...env, KEY_PREFIX: 'P6_,P5_' });
export const routerOf = (env: Record<string, string>) => process.env.ROUTER ?? env.PHASE5_ROUTER_ACCOUNT_ID;
export const sporeKey = (env: Record<string, string>, id: number) => envKey(`SPORE_${id}_FC_PRIVATE_KEY`, withPrefix(env));
export const keeperKey = (env: Record<string, string>) => envKey('KEEPER_FC_PRIVATE_KEY', withPrefix(env));

/** Account → full-access key, for the owners this repo controls. */
export function ownerKeys(env: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const who of ['OWNER', 'DEPLOYER']) if (env[`${who}_ACCOUNT_ID`] && env[`${who}_PRIVATE_KEY`]) m.set(env[`${who}_ACCOUNT_ID`], env[`${who}_PRIVATE_KEY`]);
  return m;
}

/** Spores on the shared operator account only (spore 5 runs under operator2 on router4). */
export function pickOpts(env: Record<string, string>): PickOpts {
  return { owners: [...ownerKeys(env).keys()], operator: env.OPERATOR_ACCOUNT_ID, hasOperatorKey: (id) => !!sporeKey(env, id) };
}

export const chainViews = (router: string): ViewChain => ({ view: (method, args = {}) => view(router, method, args) });

function liveChain(env: Record<string, string>, router: string, roles: () => { owner: string; spore: number; provider: number }): SceneChain {
  const callers = new Map<Role, Caller>();
  const caller = (role: Role): Caller => {
    let c = callers.get(role);
    if (c) return c;
    const r = roles();
    const need = (v: string | undefined, what: string) => {
      if (!v) throw new Error(`no ${what} in .env`);
      return v;
    };
    if (role === 'owner') c = new Caller(r.owner, need(ownerKeys(env).get(r.owner), `key for ${r.owner}`), router);
    else if (role === 'keeper') c = new Caller(need(env.DEPLOYER_ACCOUNT_ID, 'DEPLOYER_ACCOUNT_ID'), need(keeperKey(env), 'keeper key'), router);
    else c = new Caller(need(env.OPERATOR_ACCOUNT_ID, 'OPERATOR_ACCOUNT_ID'), need(sporeKey(env, role === 'agent' ? r.spore : r.provider), `operator key for ${role}`), router);
    callers.set(role, c);
    return c;
  };
  return {
    view: (method, args = {}) => view(router, method, args),
    call: (role, method, args, deposit = 0n, gas) => caller(role).call(method, args, deposit, gas),
    timeNs: chainTimeNs,
    sleep,
  };
}

const PENDING = (root: string) => join(root, 'out/agents/.rogue-pending-reset.json');

/** Restores the policy a dead run left behind. Exit 0 when there was nothing to do or it worked. */
async function reset(env: Record<string, string>, router: string): Promise<number> {
  const file = PENDING(ROOT);
  if (!existsSync(file)) return 0;
  const { spore, policy, owner } = JSON.parse(readFileSync(file, 'utf8'));
  const r = await new Caller(owner, ownerKeys(env).get(owner)!, router).call('set_policy', { spore_id: spore, policy }, 1n, 30);
  console.log(JSON.stringify({ type: 'reset', spore, ok: r.ok, tx: r.hash, err: r.ok ? '' : panicText(r.err) }));
  if (r.ok) rmSync(file);
  return r.ok ? 0 : 1;
}

export const pendingReset = (root = ROOT) => (existsSync(PENDING(root)) ? JSON.parse(readFileSync(PENDING(root), 'utf8')) as { spore: number; run: string } : null);

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const env = loadDotEnv();
  const router = routerOf(env);
  if (!router) throw new Error('PHASE5_ROUTER_ACCOUNT_ID missing from .env');
  if (argv.includes('--reset')) return reset(env, router);
  if (pendingReset()) throw new Error('an earlier run left a narrowed policy behind: reset it first (--reset)');

  const run = opt('run') ?? `rogue-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dir = join(ROOT, 'out/agents', run);
  ensureDir(dir);
  const started = Date.now();
  let seq = 0;
  const emit: Emit = (e) => {
    const line = { seq: ++seq, at: new Date().toISOString(), t: Date.now() - started, ...e };
    console.log(JSON.stringify(line));
    appendJsonl(join(dir, 'scene.jsonl'), line);
    // The same txs in the run-log format, so Activity can read this run.
    if (e.type === 'result') {
      const { role, method, args, ok, tx, err, gas_tgas, closed, ret } = e as any;
      // A close line reads like the keeper's, so `spores-verify --closes` can take this file.
      const close = closed !== undefined ? { closed, fingerprint: ret } : {};
      appendJsonl(join(dir, 'events.jsonl'), { at: line.at, spore: role === 'keeper' ? 'keeper' : role === 'provider' ? roles.provider : roles.spore, kind: 'tx', method, args, hash: tx, ok, err: err || undefined, gas_tgas, ...close });
    }
  };
  const roles = { owner: '', spore: -1, provider: -1 };
  const base = pickOpts(env);
  const opts = { ...base, run, router, spore: opt('spore') ? Number(opt('spore')) : undefined, provider: opt('provider') ? Number(opt('provider')) : undefined };
  const picked = await pickSpores(chainViews(router), opts);
  Object.assign(roles, { owner: picked.summary.owner_id, spore: picked.spore, provider: picked.provider });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ run, scene: 'rogue', router, spores: [picked.spore, picked.provider], start_epoch: (await view(router, 'epoch_info')).epoch, config: await view(router, 'config') }, null, 2));
  const chain = liveChain(env, router, () => roles);
  const result = await runRogue(chain, emit, {
    ...opts,
    spore: picked.spore,
    provider: picked.provider,
    onPolicySet: (spore, policy) => writeFileSync(PENDING(ROOT), JSON.stringify({ spore, policy, owner: roles.owner, run })),
    onPolicyRestored: () => rmSync(PENDING(ROOT), { force: true }),
  });
  return result.ok ? 0 : 1;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.log(JSON.stringify({ type: 'fatal', error: (e as Error).message }));
      process.exit(2);
    },
  );
}
