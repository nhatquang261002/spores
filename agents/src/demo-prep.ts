// What `scripts/demo.sh` needs before a run: which spores trade, which one the
// story follows, and enough money for them to trade with. Only reads the chain,
// unless a spore is below the floor: then the owner deposits (S13 "Top-up").
//
//   node agents/src/demo-prep.ts [--spores N]
//
// stdout: one JSON line {spores, hero, topped}. Stderr: what it did, for people.
// Exits 1 with the reason and what to run when the run can't work. Keys come from
// .env and are never printed.
import { actions, nearToYocto, teraToGas } from 'near-api-js';
import { allJobs, balanceOf, Caller, chainTimeNs, view } from './near.ts';
import { loadDotEnv, routerOf, sporeKey, tubesOf } from './scenes/rogue.ts';
import { BUYER_MARGIN, DEFAULT_PRICE, newAgentKey } from './scenes/sale.ts';

export interface SporeFacts {
  id: number;
  owner: string;
  operator: string | null;
  active: boolean;
  paused: boolean;
  listed: boolean;
  balance: bigint;
  tubes: number[];
}

/** Why this spore can't trade in the demo, or null. Anyone's spore can trade; only the seller's can be sold. */
export function unfit(s: SporeFacts, operator: string, hasKey: (id: number) => boolean): string | null {
  if (!s.active) return 'not active';
  if (s.paused) return 'paused';
  if (s.listed) return 'listed';
  if (s.operator !== operator) return `run by ${s.operator}`;
  if (!hasKey(s.id)) return 'no operator key';
  return null;
}

/** Each spore can hold 4 unfinished jobs, and a job nobody hired stays until someone times it out. */
export function expiredOf(jobs: { id: number; consumer: number; deadline_ns: string }[], spores: number[], nowNs: bigint): number[] {
  return jobs.filter((j) => spores.includes(j.consumer) && BigInt(j.deadline_ns) + 2_000_000_000n < nowNs).map((j) => j.id);
}

export interface DemoPlan {
  hero: number;
  spores: number[];
  low: { id: number; amount: bigint }[];
}

/**
 * The hero is the seller's fitting spore with the most tubes: its reputation gives
 * it an allowance that can afford real quotes. Real runs tried the other way: two
 * heroes with the fewest tubes had no settled hire before their sale, and two with
 * the most had one, whose tube and reputation grew. The others are its partners
 * first, then the lowest ids. All must be fit to trade.
 */
export function planDemo(all: SporeFacts[], count: number, fit: (s: SporeFacts) => boolean, seller: string, floor: bigint, target: bigint): DemoPlan | null {
  const good = all.filter(fit);
  const sellable = good.filter((s) => s.owner === seller);
  if (good.length < 2 || !sellable.length) return null;
  const hero = [...sellable].sort((a, b) => b.tubes.length - a.tubes.length || a.id - b.id)[0];
  const byId = new Map(good.map((s) => [s.id, s]));
  const partners = hero.tubes.filter((n) => byId.has(n));
  const rest = good.map((s) => s.id).filter((id) => id !== hero.id && !partners.includes(id));
  const chosen = [hero.id, ...partners, ...rest].slice(0, Math.max(2, count)).sort((a, b) => a - b);
  const low = chosen.map((id) => byId.get(id)!).filter((s) => s.balance < floor).map((s) => ({ id: s.id, amount: target - s.balance }));
  return { hero: hero.id, spores: chosen, low };
}

const say = (s: string) => process.stderr.write(`${s}\n`);
const near = (y: bigint) => (Number(y / 10n ** 21n) / 1000).toFixed(3);

async function mapLimited<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await f(items[i]);
      }
    }),
  );
  return out;
}

function fail(reason: string, fix: string): never {
  say(`  ✕ ${reason}`);
  say(`    ${fix}`);
  process.exit(1);
}

/** Tops an account up to `need` from the faucet accounts phase6-setup.sh made. Returns what it has now. */
async function refill(env: Record<string, string>, account: string, need: bigint): Promise<bigint> {
  let has = (await balanceOf(account)) ?? 0n;
  for (let n = 1; has < need && env[`P6_FUND_${n}_PRIVATE_KEY`]; n++) {
    const id = `spores-hack-fund6-${n}.testnet`;
    const spare = ((await balanceOf(id)) ?? 0n) - nearToYocto('0.1');
    if (spare <= 0n) continue;
    const move = spare < need - has ? spare : need - has;
    const r = await new Caller(id, env[`P6_FUND_${n}_PRIVATE_KEY`], account).send(account, [actions.transfer(move)]);
    if (!r.ok) fail(`moving NEAR from ${id} to ${account} failed: ${r.err}`, 'TOPUP=1 bash scripts/phase6-setup.sh');
    say(`  ✓ moved ${near(move)} NEAR from ${id} to ${account}`);
    has = (await balanceOf(account)) ?? 0n;
  }
  return has;
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--spores');
  const count = i >= 0 ? Number(argv[i + 1]) : 12;
  const env = loadDotEnv();
  const router = routerOf(env);
  if (!router) fail('no router in .env (PHASE5_ROUTER_ACCOUNT_ID)', 'bash scripts/phase6-setup.sh');
  if (!env.OWNER_ACCOUNT_ID || !env.OWNER_PRIVATE_KEY || !env.OPERATOR_ACCOUNT_ID || !env.BUYER_ACCOUNT_ID || !env.BUYER_PRIVATE_KEY) fail('.env is missing the owner, operator or buyer', 'bash scripts/phase6-setup.sh');
  if (!env.OPERATOR2_ACCOUNT_ID || !newAgentKey(env)) fail('.env is missing the new owner’s agent (operator2)', 'bash scripts/phase5-setup.sh');
  const config = await view(router, 'config');
  const ids = Array.from({ length: Number(config.supply_cap) }, (_, n) => n);
  const raw = await mapLimited(ids, 6, (id) => view(router, 'spore_summary', { spore_id: id }));
  const facts: SporeFacts[] = raw.flatMap((s, n) =>
    s ? [{ id: n, owner: s.owner_id, operator: s.operator_id, active: s.active, paused: !!s.policy?.paused, listed: !!s.listed_price, balance: BigInt(s.balance), tubes: tubesOf(s).map(([p]) => p) }] : [],
  );
  const floor = nearToYocto(process.env.DEMO_SPORE_FLOOR ?? '0.2');
  const target = nearToYocto(process.env.DEMO_SPORE_TARGET ?? '0.4');
  const plan = planDemo(facts, count, (s) => unfit(s, env.OPERATOR_ACCOUNT_ID, (id) => !!sporeKey(env, id)) === null, env.OWNER_ACCOUNT_ID, floor, target);
  if (!plan) fail(`${router} has no spore of ${env.OWNER_ACCOUNT_ID} that can trade, or fewer than 2 that can`, 'bash scripts/phase6-setup.sh');

  // Each sale spends the buyer's money and pays the owner: both are refilled, so the demo can run again.
  const needBuyer = DEFAULT_PRICE + BUYER_MARGIN;
  const buyer = await refill(env, env.BUYER_ACCOUNT_ID, needBuyer);
  if (buyer < needBuyer) fail(`the buyer has ${near(buyer)} NEAR and the sale needs ${near(needBuyer)}`, `send NEAR to ${env.BUYER_ACCOUNT_ID}`);
  const float = (await balanceOf(env.OPERATOR_ACCOUNT_ID)) ?? 0n;
  const needFloat = nearToYocto('0.5');
  if (float < needFloat) fail(`the operator has ${near(float)} NEAR for gas, under ${near(needFloat)}`, 'TOPUP=1 bash scripts/phase6-setup.sh');

  const total = plan.low.reduce((t, l) => t + l.amount, 0n);
  if (total > 0n) {
    const need = total + nearToYocto('0.05');
    const has = await refill(env, env.OWNER_ACCOUNT_ID, need);
    if (has < need) fail(`the owner has ${near(has)} NEAR and the top-up needs ${near(total)}`, 'TOPUP=1 bash scripts/phase6-setup.sh');
    const owner = new Caller(env.OWNER_ACCOUNT_ID, env.OWNER_PRIVATE_KEY, router);
    for (const { id, amount } of plan.low) {
      const r = await owner.call('deposit', { spore_id: id }, amount, 10);
      if (!r.ok) fail(`deposit to spore ${id} failed: ${r.err}`, 'TOPUP=1 bash scripts/phase6-setup.sh');
      say(`  ✓ topped up spore ${id} with ${near(amount)} NEAR (${r.hash})`);
    }
  }
  // Old jobs of these spores would stop them posting. Anyone may time a job out; a batch keeps it to a few txs.
  const stale = expiredOf(await allJobs(router), plan.spores, await chainTimeNs());
  if (stale.length) {
    const clearer = new Caller(env.OWNER_ACCOUNT_ID, env.OWNER_PRIVATE_KEY, router);
    let cleared = 0;
    for (let n = 0; n < stale.length; n += 20) {
      const batch = stale.slice(n, n + 20);
      const r = await clearer.send(router, batch.map((job_id) => actions.functionCall('timeout_job', { job_id }, teraToGas('10'), 0n)));
      if (r.ok) cleared += batch.length;
      else say(`  ! could not clear jobs ${batch.join(',')}: ${r.err}`);
    }
    say(`  ✓ cleared ${cleared} of ${stale.length} expired jobs of these spores`);
  }
  console.log(JSON.stringify({ spores: plan.spores.join(','), hero: plan.hero, topped: plan.low.map((l) => l.id) }));
}

if (import.meta.main) {
  main().catch((e) => fail((e as Error).message, 'check the RPC endpoints (NEAR_RPCS), then run it again'));
}
