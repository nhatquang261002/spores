// Sale and control transfer (SPEC §7.3): the owner lists
// a spore, a separate buyer buys it, payouts are read from the receipts, the old
// agent's key and the old owner are refused, the spore arrives locked with its
// balance, tubes and age intact, and the buyer's own agent takes over.
//
// `runSale` is the one implementation: the Demo Lab scene (`main` below, through
// agents/src/scene-server.ts) and `run.ts`'s `sale@N` shock both call it. Every
// line it emits is a real event: a tx it sent, the chain's outcome, a view it
// read. Exit 0 only if every check passed.
//
//   node agents/src/scenes/sale.ts [--run NAME] [--spore N] [--price NEAR]
//   node agents/src/scenes/sale.ts --reset     sells the spore back, so the scene can run again
//
// A sale is final, so the story ends with the spore in the buyer's hands. Reset
// is a second real sale, back to the first owner, with its own 5% royalty; until
// then the scene server won't start another run. Keys come from .env and are
// never printed.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nearToYocto } from 'near-api-js';
import { appendJsonl, ensureDir, envKey } from '../common.ts';
import { balanceOf, Caller, chainTimeNs, rpc, txStatus, view, type TxResult } from '../near.ts';
import { chainViews, keeperKey, loadDotEnv, ownerKeys, panicText, ROOT, routerOf, sporeKey, tubesOf, type Emit } from './rogue.ts';

export const DEFAULT_PRICE = nearToYocto('0.5');
/** What a sale leaves behind (SPEC §5.3). */
export const LOCKED = { paused: true, budget_per_epoch: '0', max_payment: '0', allow_all_spores: false, allowlist: [] as number[], external_allowlist: [] as string[] };
export const ERR_OLD_KEY = "caller is not this spore's operator";
export const ERR_OLD_OWNER = 'only the spore owner can do this';
/**
 * What the buyer needs on top of the price: NEAR charges the 100 Tgas `buy`
 * attaches up front, about 0.101 NEAR on testnet, and refunds what it doesn't
 * burn (a real run failed with NotEnoughBalance at a 0.02 margin).
 */
export const BUYER_MARGIN = nearToYocto('0.12');

export type SaleRole = 'seller' | 'buyer' | 'agent' | 'new agent' | 'keeper';

export interface SaleChain {
  view(method: string, args?: object, blockId?: string): Promise<any>;
  call(role: SaleRole, method: string, args: object, deposit?: bigint, gasTgas?: number): Promise<TxResult>;
  timeNs(): Promise<bigint>;
  /** The tx's receipts, from the chain (`EXPERIMENTAL_tx_status`). */
  status(hash: string, sender: string): Promise<any>;
  /** The block before this one. */
  prevBlock(hash: string): Promise<string>;
  /** Liquid balance of an account, yoctoNEAR; null if it doesn't exist. */
  balanceOf(account: string): Promise<bigint | null>;
}

export interface SaleOpts {
  run: string;
  router: string;
  spore: number;
  price: bigint;
  buyer: string;
  newOperator: string;
  newPolicy: Record<string, unknown>;
  /** Scene: the new agent's key posts a job as proof. `run.ts` restarts a real agent instead. */
  probeAgent: boolean;
  /** Scene: refund jobs past their deadline first, so nothing but the sale moves the balance. */
  clearStale: boolean;
  /** Called just before `list`: the moment the spore can start needing a Reset. */
  onListing?: (summary: any) => void;
  /** Called when nothing was sold after all, so there is nothing to Reset. */
  onUnsold?: () => void;
  /** After the buy's facts are read, before the old key is tried (`run.ts` stops the old agent here). */
  afterSold?: (rec: SaleRecord) => Promise<void>;
  /** After the buyer's policy is set (`run.ts` starts the agent under its new operator here). */
  onResume?: () => void;
}

export interface Payout {
  id: string;
  deposit: string;
  ok: boolean;
}

/** Everything the run learned; `run.ts` turns it into its report. */
export interface SaleRecord {
  spore: number;
  seller: string;
  buyer: string;
  royalty_account: string;
  price: string;
  royalty_bps: number;
  list?: string;
  buy?: string;
  buy_ok?: boolean;
  at?: string;
  block?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  sold_event?: any;
  refunds_to_spore?: string;
  payouts?: { seller: Payout[]; royalty: Payout[] };
  payment_failed?: boolean;
  paid_ok?: boolean;
  reset_ok?: boolean;
  intact_ok?: boolean;
  old_key_refused?: boolean;
  old_key_tx?: string;
  old_owner_refused?: boolean;
  old_owner_tx?: string;
  register?: string;
  policy?: string;
  resumed_at?: string;
  agent_probe_tx?: string;
  ok: boolean;
  passed: number;
  total: number;
}

/** The transfers the router sent `to` in this tx, each with whether it succeeded, from the receipts. */
export function payoutsTo(status: any, router: string, to: string): Payout[] {
  return (status.receipts ?? [])
    .filter((r: any) => r.receiver_id === to && r.predecessor_id === router)
    .flatMap((r: any) => (r.receipt?.Action?.actions ?? []).filter((a: any) => a.Transfer).map((a: any) => ({ id: r.receipt_id as string, deposit: String(a.Transfer.deposit) })))
    .map((t: { id: string; deposit: string }) => ({ ...t, ok: status.receipts_outcome.find((o: any) => o.id === t.id)?.outcome?.status?.SuccessValue !== undefined }));
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const stateOf = (s: any) => ({ owner: s.owner_id, operator: s.operator_id, operator_gen: s.operator_gen, balance: s.balance, age: s.age, reputation: s.reputation, connections: s.connections, policy: s.policy, listed_price: s.listed_price, sales: s.sales });
const artOf = (r: any) => ({ id: r.spore_id, seed: r.seed, age: r.age, edges: r.edges });
const eventsOf = (r: TxResult, name: string) => r.events.filter((e) => e.event === name).flatMap((e) => e.data);

/** A failed check already says why; the rest of the story can't happen. */
class Abort extends Error {}

export async function runSale(chain: SaleChain, emit: Emit, opts: SaleOpts): Promise<SaleRecord> {
  const X = opts.spore;
  const config = await chain.view('config');
  const royaltyAccount: string = config.royalty_account ?? (await chain.view('admin'));
  const first = await chain.view('spore_summary', { spore_id: X });
  const seller: string = first.owner_id;
  const royaltyBps = Number(config.royalty_bps);
  const rec: SaleRecord = { spore: X, seller, buyer: opts.buyer, royalty_account: royaltyAccount, price: opts.price.toString(), royalty_bps: royaltyBps, ok: false, passed: 0, total: 0 };

  let n = 0;
  const checks: boolean[] = [];
  const check = (name: string, ok: boolean, expected: string, actual: string, tx?: string) => {
    checks.push(ok);
    emit({ type: 'check', n: checks.length, name, ok, expected, actual, tx });
    return ok;
  };
  const tx = async (role: SaleRole, act: string, method: string, args: object, meta: { action: string; amount?: bigint; expected?: string }, deposit = 0n, gas?: number) => {
    const id = `s${++n}`;
    emit({ type: 'step', id, act, actor: role, method, action: meta.action, amount: meta.amount?.toString(), expected: meta.expected ?? 'ok' });
    const r = await chain.call(role, method, args, deposit, gas);
    emit({ type: 'result', id, ok: r.ok, tx: r.hash, err: r.ok ? '' : panicText(r.err), gas_tgas: r.gasTgas, ret: r.ret ?? undefined, args, role, method });
    return r;
  };
  const snapshot = async (label: string) => {
    const [s, art, info] = await Promise.all([chain.view('spore_summary', { spore_id: X }), chain.view('render_input', { spore_id: X }), chain.view('epoch_info')]);
    emit({ type: 'snapshot', label, spore: X, epoch: info.epoch, owner: s.owner_id, operator: s.operator_id, balance: s.balance, reputation: s.reputation, age: s.age, degree: s.degree, connections: tubesOf(s), policy: s.policy, listed_price: s.listed_price, sales: s.sales, art: artOf(art) });
    return s;
  };

  const peers = await Promise.all(tubesOf(first).map(([id]) => chain.view('render_input', { spore_id: id }).then(artOf)));
  emit({
    type: 'start',
    scene: 'sale',
    run: opts.run,
    router: opts.router,
    spore: X,
    seller,
    buyer: opts.buyer,
    royalty_account: royaltyAccount,
    royalty_bps: royaltyBps,
    price: opts.price.toString(),
    old_operator: first.operator_id,
    new_operator: opts.newOperator,
    new_policy: opts.newPolicy,
    peers,
  });

  let listed = false;
  let sold = false;
  try {
    emit({ type: 'act', act: 'listed' });
    if (opts.clearStale) {
      for (const job of [...(first.posted_jobs ?? []), ...(first.serving_jobs ?? [])]) {
        const j = await chain.view('get_job', { job_id: job }).catch(() => null);
        if (j && BigInt(j.deadline_ns) <= (await chain.timeNs())) await tx('keeper', 'listed', 'timeout_job', { job_id: job }, { action: `clear job ${job}, left over from an earlier run and past its deadline` }, 0n, 30);
      }
    }
    const held = await snapshot('before');
    const funds = (await chain.balanceOf(opts.buyer)) ?? 0n;
    if (funds < opts.price + BUYER_MARGIN) {
      check('The buyer can pay', false, `at least ${opts.price + BUYER_MARGIN} yocto`, `${funds} yocto on ${opts.buyer}`);
      throw new Abort();
    }

    opts.onListing?.(held);
    const list = await tx('seller', 'listed', 'list', { spore_id: X, price: opts.price.toString() }, { action: 'owner lists the spore', amount: opts.price }, 1n, 30);
    rec.list = list.hash;
    listed = list.ok;
    const shown = await snapshot('listed');
    if (!check('The owner lists it at its price', list.ok && shown.listed_price === opts.price.toString(), `listed at ${opts.price}`, list.ok ? `listed at ${shown.listed_price}` : panicText(list.err), list.hash)) throw new Abort();

    emit({ type: 'act', act: 'sold' });
    const buy = await tx('buyer', 'sold', 'buy', { spore_id: X }, { action: 'buyer attaches the price', amount: opts.price }, opts.price, 100);
    rec.buy = buy.hash;
    rec.buy_ok = buy.ok;
    rec.at = new Date().toISOString();
    if (!buy.ok) {
      check('The buy is final and the spore is the buyer’s', false, `owner ${opts.buyer}`, panicText(buy.err), buy.hash);
      throw new Abort();
    }
    sold = true;

    // State just before and just after the block that ran the buy receipt.
    const st = await chain.status(buy.hash, opts.buyer);
    const firstReceipt = st.transaction_outcome.outcome.receipt_ids[0];
    const ro = st.receipts_outcome.find((o: any) => o.id === firstReceipt);
    const prevHash = await chain.prevBlock(ro.block_hash);
    const before = await chain.view('spore_summary', { spore_id: X }, prevHash);
    const after = await chain.view('spore_summary', { spore_id: X }, ro.block_hash);
    const soldEvent = eventsOf(buy, 'spore_sold')[0];
    const refunds = eventsOf(buy, 'job_refunded').filter((d) => d.consumer === X).reduce((t, d) => t + BigInt(d.amount), 0n);
    const royalty = (opts.price * BigInt(royaltyBps)) / 10_000n;
    const sellerAmount = opts.price - royalty;
    const toSeller = payoutsTo(st, opts.router, seller);
    const toRoyalty = payoutsTo(st, opts.router, royaltyAccount);
    const failedPayout = eventsOf(buy, 'sale_payment_failed').length > 0;
    Object.assign(rec, { block: ro.block_hash, before: stateOf(before), after: stateOf(after), sold_event: soldEvent, refunds_to_spore: refunds.toString(), payouts: { seller: toSeller, royalty: toRoyalty }, payment_failed: failedPayout });
    const sellerPaid = toSeller.some((t) => t.ok && t.deposit === sellerAmount.toString());
    const royaltyPaid = royalty === 0n || toRoyalty.some((t) => t.ok && t.deposit === royalty.toString());
    const eventRight = !!soldEvent && BigInt(soldEvent.price) === opts.price && BigInt(soldEvent.royalty) === royalty && BigInt(soldEvent.seller_amount) + BigInt(soldEvent.royalty) === opts.price;
    rec.paid_ok = after.owner_id === opts.buyer && eventRight && sellerPaid && royaltyPaid && !failedPayout;
    rec.reset_ok = sameJson(after.policy, LOCKED) && after.operator_id === null && after.operator_gen === before.operator_gen + 1 && after.listed_price === null;
    rec.intact_ok = BigInt(after.balance) === BigInt(before.balance) + refunds && sameJson(after.connections, before.connections) && after.age === before.age && after.reputation === before.reputation;

    await snapshot('sold');
    check('The buy is final and the spore is the buyer’s', after.owner_id === opts.buyer, `owner ${opts.buyer}`, `owner ${after.owner_id}`, buy.hash);
    emit({ type: 'payout', role: 'seller', to: seller, amount: toSeller.find((t) => t.ok)?.deposit ?? null, ok: sellerPaid, receipt: toSeller[0]?.id ?? null });
    check(`The seller was paid ${(10_000 - royaltyBps) / 100}% (from the receipt)`, sellerPaid, `${sellerAmount} to ${seller}`, JSON.stringify(toSeller), buy.hash);
    emit({ type: 'payout', role: 'royalty', to: royaltyAccount, amount: toRoyalty.find((t) => t.ok)?.deposit ?? null, ok: royaltyPaid, receipt: toRoyalty[0]?.id ?? null });
    check(`The royalty account was paid ${royaltyBps / 100}% (from the receipt)`, royaltyPaid, `${royalty} to ${royaltyAccount}`, JSON.stringify(toRoyalty), buy.hash);
    check('The chain logged spore_sold with those amounts', eventRight, `price ${opts.price}, royalty ${royalty}, seller ${sellerAmount}`, JSON.stringify(soldEvent ?? null), buy.hash);

    await opts.afterSold?.(rec);

    emit({ type: 'act', act: 'lockout' });
    const lock = await tx('agent', 'lockout', 'post_job', { spore_id: X, task: 'lockout check', max_price: '1' }, { action: 'the old agent’s key posts a job', expected: ERR_OLD_KEY });
    rec.old_key_refused = !lock.ok && panicText(lock.err) === ERR_OLD_KEY;
    rec.old_key_tx = lock.hash;
    check('The old agent’s key is refused', rec.old_key_refused, ERR_OLD_KEY, lock.ok ? 'the tx succeeded' : panicText(lock.err), lock.hash);
    const wd = await tx('seller', 'lockout', 'withdraw', { spore_id: X, amount: '1' }, { action: 'the old owner tries to withdraw', expected: ERR_OLD_OWNER }, 1n, 30);
    rec.old_owner_refused = !wd.ok && panicText(wd.err) === ERR_OLD_OWNER;
    rec.old_owner_tx = wd.hash;
    check('The old owner is refused', rec.old_owner_refused, ERR_OLD_OWNER, wd.ok ? 'the tx succeeded' : panicText(wd.err), wd.hash);

    emit({ type: 'act', act: 'intact' });
    emit({ type: 'block_diff', block: ro.block_hash, before: stateOf(before), after: stateOf(after), refunds: refunds.toString() });
    check('It arrives locked: no operator, paused, zero budget', rec.reset_ok, `operator null, generation ${before.operator_gen + 1}, policy ${JSON.stringify(LOCKED)}`, `operator ${after.operator_id}, generation ${after.operator_gen}, policy ${JSON.stringify(after.policy)}`);
    check('Balance, tubes and age came with it', rec.intact_ok, `balance ${BigInt(before.balance) + refunds}, ${before.connections.length} tubes unchanged, age ${before.age}, R ${before.reputation}`, `balance ${after.balance}, ${after.connections.length} tubes, age ${after.age}, R ${after.reputation}`, buy.hash);

    emit({ type: 'act', act: 'takeover' });
    const reg = await tx('buyer', 'takeover', 'register_operator', { spore_id: X, operator_id: opts.newOperator }, { action: 'buyer appoints its own agent' }, 1n, 30);
    rec.register = reg.hash;
    const pol = await tx('buyer', 'takeover', 'set_policy', { spore_id: X, policy: opts.newPolicy }, { action: 'buyer sets a budget' }, 1n, 30);
    rec.policy = pol.hash;
    rec.resumed_at = new Date().toISOString();
    opts.onResume?.();
    const taken = await snapshot('takeover');
    check('The buyer appoints its agent and sets a policy', reg.ok && pol.ok && taken.operator_id === opts.newOperator && sameJson(taken.policy, opts.newPolicy), `operator ${opts.newOperator}, policy set`, `operator ${taken.operator_id}${reg.ok ? '' : `, ${panicText(reg.err)}`}${pol.ok ? '' : `, ${panicText(pol.err)}`}`, pol.hash);
    if (opts.probeAgent) {
      const probe = await tx('new agent', 'takeover', 'post_job', { spore_id: X, task: `sale scene ${opts.run}`, max_price: nearToYocto('0.01').toString() }, { action: 'the new agent posts a job' });
      rec.agent_probe_tx = probe.hash;
      check('The new agent’s key works', probe.ok, 'ok', probe.ok ? 'ok' : panicText(probe.err), probe.hash);
      await snapshot('after');
    }
  } catch (e) {
    if (!(e instanceof Abort)) check('The scene ran to the end', false, 'no error', (e as Error).message);
  } finally {
    // A failed buy leaves a listing nobody wanted, and nothing to sell back.
    if (!sold) {
      if (listed) await tx('seller', 'listed', 'delist', { spore_id: X }, { action: 'owner takes the listing down, nothing was sold' }, 1n, 30).catch((e) => emit({ type: 'note', note: `could not delist: ${(e as Error).message}` }));
      opts.onUnsold?.();
    }
  }

  rec.passed = checks.filter(Boolean).length;
  rec.total = checks.length;
  rec.ok = rec.total > 0 && rec.passed === rec.total;
  emit({ type: 'done', ok: rec.ok, passed: rec.passed, total: rec.total });
  return rec;
}

export interface SalePickOpts {
  /** The one account that sells: its payout must not land on the royalty account. */
  seller: string;
  operator?: string;
  hasOperatorKey: (id: number) => boolean;
  spore?: number;
}

/** Why this spore can't star, or null. */
export function unfitForSale(s: any, opts: SalePickOpts): string | null {
  if (!s.active) return 'not active';
  if (s.policy?.paused) return 'paused';
  if (s.listed_price) return 'listed';
  if (s.owner_id !== opts.seller) return `owned by ${s.owner_id}`;
  if (!opts.hasOperatorKey(s.spore_id)) return 'no operator key';
  if (opts.operator && s.operator_id !== opts.operator) return `run by ${s.operator_id}`;
  if (tubesOf(s).length < 2) return 'fewer than 2 tubes to keep';
  return null;
}

/** The fitting spore with the most tubes (ties: most D): the scene is about what it keeps. */
export async function pickForSale(chain: Pick<SaleChain, 'view'>, opts: SalePickOpts): Promise<{ spore: number; summary: any; reason: string }> {
  const edges: [number, number, string][] = await chain.view('edges');
  const stats = new Map<number, { degree: number; total: bigint }>();
  for (const [a, b, d] of edges) {
    for (const id of [a, b]) {
      const s = stats.get(id) ?? { degree: 0, total: 0n };
      stats.set(id, { degree: s.degree + 1, total: s.total + BigInt(d) });
    }
  }
  const order = opts.spore !== undefined ? [opts.spore] : [...stats.entries()].sort((x, y) => y[1].degree - x[1].degree || (y[1].total > x[1].total ? 1 : y[1].total < x[1].total ? -1 : x[0] - y[0])).map(([id]) => id);
  const refused: string[] = [];
  for (const id of order.slice(0, 10)) {
    const s = await chain.view('spore_summary', { spore_id: id });
    const why = unfitForSale(s, opts);
    if (!why) return { spore: id, summary: s, reason: `most tubes (${tubesOf(s).length}) among ${opts.seller}'s spores` };
    refused.push(`#${id}: ${why}`);
  }
  throw new Error(`no spore fits the sale (${refused.join('; ') || 'no tubes on the router'})`);
}

export interface SaleResetState {
  spore: number;
  run: string;
  seller: string;
  buyer: string;
  operator: string;
  policy: unknown;
  price: string;
}

/**
 * Puts things back after a run. If the first owner still holds the spore, only a
 * stale listing can be left. Otherwise a real sale back, then the first operator
 * and policy. Returns the txs; throws at the first one that fails.
 */
export async function sellBack(chain: Pick<SaleChain, 'view' | 'call'>, st: SaleResetState): Promise<{ method: string; tx: string }[]> {
  const out: { method: string; tx: string }[] = [];
  const step = async (role: SaleRole, method: string, args: object, deposit = 1n, gas = 30) => {
    const r = await chain.call(role, method, args, deposit, gas);
    if (!r.ok) throw new Error(`${method} failed: ${panicText(r.err)}`);
    out.push({ method, tx: r.hash });
  };
  const s = await chain.view('spore_summary', { spore_id: st.spore });
  if (s.owner_id === st.seller) {
    if (s.listed_price) await step('seller', 'delist', { spore_id: st.spore });
    return out;
  }
  if (s.owner_id !== st.buyer) throw new Error(`spore ${st.spore} is owned by ${s.owner_id}, neither party of the run`);
  await step('buyer', 'list', { spore_id: st.spore, price: st.price });
  await step('seller', 'buy', { spore_id: st.spore }, BigInt(st.price), 100);
  await step('seller', 'register_operator', { spore_id: st.spore, operator_id: st.operator });
  await step('seller', 'set_policy', { spore_id: st.spore, policy: st.policy });
  const back = await chain.view('spore_summary', { spore_id: st.spore });
  if (back.owner_id !== st.seller || back.operator_id !== st.operator || !sameJson(back.policy, st.policy)) throw new Error(`spore ${st.spore} did not come back as it was: owner ${back.owner_id}, operator ${back.operator_id}`);
  return out;
}

// ---------------------------------------------------------------------------
// The real chain, keys from .env. Only below this line touches files or keys.

const PENDING = (root: string) => join(root, 'out/agents/.sale-pending-reset.json');
export const pendingSaleReset = (root = ROOT): SaleResetState | null => (existsSync(PENDING(root)) ? (JSON.parse(readFileSync(PENDING(root), 'utf8')) as SaleResetState) : null);

/** What the buyer sets, the same as Phase 5's exit run. */
export const newOwnerPolicy = (outside: string | undefined) => ({ paused: false, budget_per_epoch: nearToYocto('1.5').toString(), max_payment: nearToYocto('0.5').toString(), allow_all_spores: true, allowlist: [], external_allowlist: outside ? [outside] : [] });

export const newAgentKey = (env: Record<string, string>) => envKey('OPERATOR2_FC_PRIVATE_KEY', { ...env, KEY_PREFIX: 'P6_,P5_' });

export const salePickOpts = (env: Record<string, string>): SalePickOpts => ({ seller: env.OWNER_ACCOUNT_ID, operator: env.OPERATOR_ACCOUNT_ID, hasOperatorKey: (id) => !!sporeKey(env, id) });

function liveChain(env: Record<string, string>, router: string, spore: () => number): SaleChain {
  const callers = new Map<SaleRole, Caller>();
  const need = (v: string | undefined, what: string) => {
    if (!v) throw new Error(`no ${what} in .env`);
    return v;
  };
  const caller = (role: SaleRole): Caller => {
    let c = callers.get(role);
    if (c) return c;
    if (role === 'seller') c = new Caller(env.OWNER_ACCOUNT_ID, need(env.OWNER_PRIVATE_KEY, 'owner key'), router);
    else if (role === 'buyer') c = new Caller(env.BUYER_ACCOUNT_ID, need(env.BUYER_PRIVATE_KEY, 'buyer key'), router);
    else if (role === 'agent') c = new Caller(env.OPERATOR_ACCOUNT_ID, need(sporeKey(env, spore()), 'operator key'), router);
    else if (role === 'new agent') c = new Caller(env.OPERATOR2_ACCOUNT_ID, need(newAgentKey(env), 'new operator key'), router);
    else c = new Caller(env.DEPLOYER_ACCOUNT_ID, need(keeperKey(env), 'keeper key'), router);
    callers.set(role, c);
    return c;
  };
  return {
    view: (method, args = {}, blockId) => view(router, method, args, blockId),
    call: (role, method, args, deposit = 0n, gas) => caller(role).call(method, args, deposit, gas),
    timeNs: chainTimeNs,
    status: txStatus,
    prevBlock: async (hash) => (await rpc('block', { block_id: hash })).result.header.prev_hash,
    balanceOf,
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const env = loadDotEnv();
  const router = routerOf(env);
  if (!router) throw new Error('PHASE5_ROUTER_ACCOUNT_ID missing from .env');
  if (!ownerKeys(env).has(env.OWNER_ACCOUNT_ID)) throw new Error('OWNER_ACCOUNT_ID or its key is missing from .env');

  if (argv.includes('--reset')) {
    const st = pendingSaleReset();
    if (!st) return 0;
    const steps = await sellBack(liveChain(env, router, () => st.spore), st);
    console.log(JSON.stringify({ type: 'reset', spore: st.spore, ok: true, steps }));
    // The sale back is a real sale too: its txs stay on file beside the run they undid.
    appendJsonl(join(ROOT, 'out/agents', st.run, 'reset.jsonl'), { at: new Date().toISOString(), spore: st.spore, steps });
    rmSync(PENDING(ROOT));
    return 0;
  }
  if (pendingSaleReset()) throw new Error('an earlier run left a spore with the buyer: reset it first (--reset)');

  const run = opt('run') ?? `sale-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dir = join(ROOT, 'out/agents', run);
  ensureDir(dir);
  const pick = await pickForSale(chainViews(router), { ...salePickOpts(env), spore: opt('spore') ? Number(opt('spore')) : undefined });
  const started = Date.now();
  let seq = 0;
  const emit: Emit = (e) => {
    const line = { seq: ++seq, at: new Date().toISOString(), t: Date.now() - started, ...e };
    console.log(JSON.stringify(line));
    appendJsonl(join(dir, 'scene.jsonl'), line);
    // The same txs in the run-log format, so Activity can read this run.
    if (e.type === 'result') {
      const { role, method, args, ok, tx, err, gas_tgas } = e as any;
      appendJsonl(join(dir, 'events.jsonl'), { at: line.at, spore: role === 'keeper' ? 'keeper' : pick.spore, kind: 'tx', method, args, hash: tx, ok, err: err || undefined, gas_tgas });
    }
  };
  const price = opt('price') ? nearToYocto(opt('price')!) : DEFAULT_PRICE;
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ run, scene: 'sale', router, spores: [pick.spore], start_epoch: (await view(router, 'epoch_info')).epoch, config: await view(router, 'config') }, null, 2));
  const rec = await runSale(liveChain(env, router, () => pick.spore), emit, {
    run,
    router,
    spore: pick.spore,
    price,
    buyer: env.BUYER_ACCOUNT_ID,
    newOperator: env.OPERATOR2_ACCOUNT_ID,
    newPolicy: newOwnerPolicy(env.OUTSIDE_ACCOUNT_ID),
    probeAgent: true,
    clearStale: true,
    onListing: (held) => {
      const st: SaleResetState = { spore: pick.spore, run, seller: env.OWNER_ACCOUNT_ID, buyer: env.BUYER_ACCOUNT_ID, operator: held.operator_id, policy: held.policy, price: price.toString() };
      writeFileSync(PENDING(ROOT), JSON.stringify(st));
    },
    onUnsold: () => rmSync(PENDING(ROOT), { force: true }),
  });
  return rec.ok ? 0 : 1;
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
