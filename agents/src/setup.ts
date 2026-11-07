// Phase 4 testnet setup (run by scripts/phase4-setup.sh). Idempotent: every
// step checks chain state first and skips what is already done.
//  1. create router3.<parent> (funded by the parent) and outside.<parent>
//  2. deploy the router wasm and init it (30 s epochs, 60 s job timeout)
//  3. mint 64 spores: 0-8 to the owner, the rest to the deployer
//  4. activate spores 0-8 with the operator, an open policy whose external
//     allowlist is the outside service, and the activation deposit
//  5. one function-call key per spore on the operator account (router job and
//     pay methods, 1 NEAR allowance) and a keeper key on the deployer
//     (close_epoch, timeout_job)
// New keys are appended to the git-ignored .env and never printed. If an
// account lacks the balance for a step, prints the shortfall and exits 2
// before sending anything for that step.
//
// SETUP_PHASE=5 (scripts/phase5-setup.sh) sets up the Phase 5 router instead:
//  - spores-hack-router4.testnet, a top-level account from the testnet faucet
//    (10 NEAR; the wasm needs about 5 NEAR of storage), with the living
//    allowance and royalty config
//  - the owner and buyer topped up from the surplus above storage of the
//    abandoned v0 router (its key is in .env; the account is kept)
//  - operator2.<parent>, the operator the buyer registers after the sale, with
//    its own function-call key
//  - keys under the P5_ prefix (a function-call key is bound to one contract),
//    and the keeper key may also call `commit_image`
//
// SETUP_PHASE=6 (scripts/phase6-setup.sh) grows router4 to every spore active
// with no init and no mint (all 64 exist):
//  - REDEPLOY=1: code-only redeploy of the local wasm (same state layout),
//    then the state is read back through `config` and `epoch_info`
//  - `set_max_active(MAX_ACTIVE)` (64) from the admin
//  - the deployer (owner of spores 9-63) and the operator funded from faucet
//    accounts spores-hack-fund6-<n>.testnet (10 NEAR each, created on demand,
//    keys P6_FUND_<n>_PRIVATE_KEY); prints the arithmetic first
//  - spores 9-63 activated with SPORE_DEPOSIT and the Phase 5 policy, several
//    per transaction; their P6_ function-call keys added in one transaction.
//    Spores 0-8 keep their P5_ keys and spore 5 stays with buyer / operator2;
//    the keeper keeps P5_KEEPER_FC_PRIVATE_KEY
//  - TOPUP=1: deposits to every active spore below SPORE_MIN, back up to
//    SPORE_DEPOSIT, and refills the operator's gas float
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { KeyPair, actions, baseEncode, nearToYocto, teraToGas } from 'near-api-js';
import { Caller, balanceOf, rpc, view } from './near.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const ENV_FILE = join(ROOT, '.env');
const env: Record<string, string> = {};
for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const PHASE6 = process.env.SETUP_PHASE === '6';
const PHASE5 = process.env.SETUP_PHASE === '5' || PHASE6;
const KP = PHASE5 ? 'P5_' : '';
const PARENT = env.SPORES_PARENT_ACCOUNT_ID;
const ROUTER_VAR = PHASE5 ? 'PHASE5_ROUTER_ACCOUNT_ID' : 'PHASE4_ROUTER_ACCOUNT_ID';
const ROUTER_KEY_VAR = PHASE5 ? 'PHASE5_ROUTER_PRIVATE_KEY' : 'PHASE4_ROUTER_PRIVATE_KEY';
const ROUTER = env[ROUTER_VAR] ?? (PHASE5 ? 'spores-hack-router4.testnet' : `router3.${PARENT}`);
const OPERATOR2 = env.OPERATOR2_ACCOUNT_ID ?? `operator2.${PARENT}`;
const BUYER = env.BUYER_ACCOUNT_ID;
const SALE_PRICE = nearToYocto(process.env.SALE_PRICE ?? '0.5');
const KEEPER_METHODS = PHASE5 ? ['close_epoch', 'timeout_job', 'commit_image'] : ['close_epoch', 'timeout_job'];
const OUTSIDE = env.OUTSIDE_ACCOUNT_ID ?? `outside.${PARENT}`;
const DEPLOYER = env.DEPLOYER_ACCOUNT_ID;
const OWNER = env.OWNER_ACCOUNT_ID;
const OPERATOR = env.OPERATOR_ACCOUNT_ID;
const SPORES = Array.from({ length: Number(process.env.ACTIVE ?? 9) }, (_, i) => i);
const ROUTER_FUNDING = nearToYocto(process.env.ROUTER_FUNDING ?? '5.8');
const SPORE_DEPOSIT = nearToYocto(process.env.SPORE_DEPOSIT ?? '0.5');
const OP_METHODS = ['post_job', 'quote', 'accept', 'deliver', 'settle', 'reject', 'timeout_job', 'pay_service'];
const KEY_ALLOWANCE = nearToYocto('1');
const GAS_RESERVE = nearToYocto('0.05');
const fmt = (y: bigint) => (Number(y / 10n ** 18n) / 1e6).toFixed(3);

const as = (id: string, key: string, receiver = ROUTER) => new Caller(id, key, receiver);
const parent = as(PARENT, env.SPORES_PARENT_PRIVATE_KEY);
const deployer = as(DEPLOYER, env.DEPLOYER_PRIVATE_KEY);
const owner = as(OWNER, env.OWNER_PRIVATE_KEY);
const operator = as(OPERATOR, env.OPERATOR_PRIVATE_KEY);

function saveEnv(k: string, v: string) {
  appendFileSync(ENV_FILE, `${k}=${v}\n`);
  chmodSync(ENV_FILE, 0o600);
  env[k] = v;
}

async function need(account: string, amount: bigint, what: string) {
  const have = (await balanceOf(account)) ?? 0n;
  if (have < amount + GAS_RESERVE) {
    console.log(`SHORTFALL ${account}: has ${fmt(have)} NEAR, needs ${fmt(amount + GAS_RESERVE)} for ${what} (short ${fmt(amount + GAS_RESERVE - have)})`);
    process.exit(2);
  }
}

function check(step: string, r: { ok: boolean; hash: string; err: string; gasTgas: number }) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} | ${step} | ${r.hash} | ${r.gasTgas} Tgas${r.ok ? '' : ` | ${r.err}`}`);
  if (!r.ok) process.exit(1);
}

/** A top-level testnet account from the faucet, with a key generated and saved here first. */
async function createFaucetAccount(id: string, keyVar: string) {
  if ((await balanceOf(id)) !== null) return console.log(`skip | ${id} exists`);
  const kp = KeyPair.fromRandom('ed25519');
  saveEnv(keyVar, kp.toString());
  const out = execFileSync('near', ['account', 'create-account', 'sponsor-by-faucet-service', id, 'use-manually-provided-public-key', kp.getPublicKey().toString(), 'network-config', 'testnet', 'create'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 10 && (await balanceOf(id)) === null; i++) await new Promise((r) => setTimeout(r, 3_000));
  const have = await balanceOf(id);
  if (have === null) {
    console.log(`FAIL | faucet did not create ${id}: ${out.trim().split('\n').slice(-3).join(' / ')}`);
    process.exit(1);
  }
  console.log(`ok   | faucet created ${id} with ${fmt(have)} NEAR`);
}

/**
 * Moves what `who` lacks (for `amount` plus the gas reserve) from the v0
 * router's balance above its storage cost. Never touches the storage stake.
 */
async function topUpFromV0(who: string, amount: bigint) {
  const have = (await balanceOf(who)) ?? 0n;
  const want = amount + nearToYocto('0.3');
  if (have >= want) return console.log(`skip | ${who} has ${fmt(have)} NEAR`);
  const V0 = env.ROUTER_V0_ACCOUNT_ID;
  const acct = (await rpc('query', { request_type: 'view_account', finality: 'final', account_id: V0 })).result;
  const surplus = BigInt(acct.amount) - BigInt(acct.storage_usage) * 10n ** 19n - GAS_RESERVE;
  const move = want - have;
  if (move > surplus) {
    console.log(`SHORTFALL ${who}: needs ${fmt(move)} more NEAR, the v0 router ${V0} has ${fmt(surplus > 0n ? surplus : 0n)} above storage`);
    process.exit(2);
  }
  check(`move ${fmt(move)} NEAR from ${V0} (surplus above storage) to ${who}`, await as(V0, env.ROUTER_V0_PRIVATE_KEY, who).send(who, [actions.transfer(move)]));
}

async function createAccount(id: string, funding: bigint, keyVar: string) {
  if ((await balanceOf(id)) !== null) return console.log(`skip | ${id} exists`);
  await need(PARENT, funding, `creating ${id}`);
  const kp = KeyPair.fromRandom('ed25519');
  // Save the key before the account exists, so a crash cannot lose it.
  saveEnv(keyVar, kp.toString());
  const r = await parent.send(id, [actions.createAccount(), actions.transfer(funding), actions.addFullAccessKey(kp.getPublicKey())]);
  check(`create ${id} with ${fmt(funding)} NEAR`, r);
}

// ---- Phase 6 -----------------------------------------------------------------------

const MAX_ACTIVE = Number(process.env.MAX_ACTIVE ?? 64);
const P6_DEPOSIT = nearToYocto(process.env.SPORE_DEPOSIT ?? '0.15');
const P6_MIN = nearToYocto(process.env.SPORE_MIN ?? '0.05');
/** Gas for the agents' transactions (about 0.0003 NEAR each, several hundred per epoch at 64 active). */
const OPERATOR_FLOAT = nearToYocto(process.env.OPERATOR_FLOAT ?? '2');
/** The keeper signs as the deployer: closes (300 Tgas attached), timeouts and image commits. */
const DEPLOYER_FLOAT = nearToYocto(process.env.DEPLOYER_FLOAT ?? '1');
const PER_TX = 8;
const P6_POLICY = {
  paused: false,
  budget_per_epoch: nearToYocto('1.5').toString(),
  max_payment: nearToYocto('0.5').toString(),
  allow_all_spores: true,
  allowlist: [],
  external_allowlist: [OUTSIDE],
};

/** Faucet accounts used as the funding source, created when the existing ones run dry. */
async function fundFrom(to: string, amount: bigint, what: string) {
  if (amount < nearToYocto('0.05')) return;
  let left = amount;
  for (let n = 1; left > 0n && n <= Number(process.env.MAX_FUND_ACCOUNTS ?? 3); n++) {
    const id = `spores-hack-fund6-${n}.testnet`;
    const keyVar = `P6_FUND_${n}_PRIVATE_KEY`;
    if ((await balanceOf(id)) === null) await createFaucetAccount(id, keyVar);
    const have = (await balanceOf(id)) ?? 0n;
    const spare = have - nearToYocto('0.1');
    if (spare <= 0n) continue;
    const move = spare < left ? spare : left;
    check(`move ${fmt(move)} NEAR from ${id} to ${to} (${what})`, await as(id, env[keyVar], to).send(to, [actions.transfer(move)]));
    left -= move;
  }
  if (left > 0n) {
    console.log(`SHORTFALL ${to}: still needs ${fmt(left)} NEAR for ${what}; raise MAX_FUND_ACCOUNTS or fund it by hand`);
    process.exit(2);
  }
}

async function phase6() {
  const supply = Number(await view(ROUTER, 'nft_total_supply'));
  if (supply !== 64) throw new Error(`${ROUTER} has ${supply} spores, expected 64`);
  const summaries = new Map<number, any>();
  for (let id = 0; id < 64; id++) summaries.set(id, await view(ROUTER, 'spore_summary', { spore_id: id }));
  const todo = [...summaries.values()].filter((s) => !s.active && s.spore_id < MAX_ACTIVE);
  const notMine = todo.filter((s) => s.owner_id !== DEPLOYER);
  if (notMine.length) throw new Error(`spores ${notMine.map((s) => s.spore_id).join(',')} are not the deployer's`);

  // 1. Code-only redeploy (same state layout), then read the state back.
  const wasm = readFileSync(join(ROOT, 'target/near/spores_router/spores_router.wasm'));
  const local = baseEncode(createHash('sha256').update(wasm).digest());
  const onChain = (await rpc('query', { request_type: 'view_account', finality: 'final', account_id: ROUTER })).result.code_hash;
  if (onChain === local) console.log(`skip | router already runs this wasm (${local})`);
  else if (process.env.REDEPLOY !== '1') {
    console.log(`STOP | on-chain code ${onChain} differs from local ${local}; REDEPLOY=1 deploys it (code only, no init)`);
    process.exit(2);
  } else {
    check(`redeploy ${wasm.length} bytes (code only, state kept)`, await as(ROUTER, env[ROUTER_KEY_VAR]).send(ROUTER, [actions.deployContract(wasm)]));
    const info = await view(ROUTER, 'epoch_info');
    console.log(`ok   | state reads back after the redeploy: epoch ${info.epoch}, ${info.active.length} active, ledger conserved ${(await view(ROUTER, 'ledger_totals')).conserved}`);
  }

  // 2. Raise the active cap.
  const config = await view(ROUTER, 'config');
  if (config.max_active >= MAX_ACTIVE) console.log(`skip | max_active is ${config.max_active}`);
  else {
    const storage = await view(ROUTER, 'storage_report');
    console.log(`info | before the raise: storage ${storage.storage_bytes} bytes (${fmt(BigInt(storage.storage_cost))} NEAR), balance ${fmt(BigInt(storage.account_balance))}, ledger ${fmt(BigInt(storage.ledger))}, solvent ${storage.solvent}`);
    check(`set_max_active ${config.max_active} -> ${MAX_ACTIVE}`, await deployer.call('set_max_active', { max_active: MAX_ACTIVE }, 1n, 30));
  }

  // 3. Funding: activations (deployer) and the agents' gas float (operator).
  // Prepaid gas is reserved at a pessimistic price (two 15 Tgas calls held about
  // 0.03 NEAR per spore on 2026-11-03) and mostly refunded afterwards.
  const gas = nearToYocto('0.04') * BigInt(todo.length) + GAS_RESERVE;
  const deployerNeeds = BigInt(todo.length) * P6_DEPOSIT + gas;
  const deployerHas = (await balanceOf(DEPLOYER)) ?? 0n;
  const operatorHas = (await balanceOf(OPERATOR)) ?? 0n;
  console.log(`info | funding: ${todo.length} activations x ${fmt(P6_DEPOSIT)} + gas ${fmt(gas)} = ${fmt(deployerNeeds)} NEAR (deployer has ${fmt(deployerHas)}); operator float ${fmt(OPERATOR_FLOAT)} (has ${fmt(operatorHas)})`);
  await fundFrom(DEPLOYER, deployerNeeds + DEPLOYER_FLOAT - deployerHas, `${todo.length} activations and the keeper's gas`);
  await fundFrom(OPERATOR, OPERATOR_FLOAT - operatorHas, 'agent gas');

  // 4. Activate and set the policy, PER_TX spores per transaction.
  for (let i = 0; i < todo.length; i += PER_TX) {
    const batch = todo.slice(i, i + PER_TX).map((s) => s.spore_id);
    const acts = batch.flatMap((id) => [
      actions.functionCall('activate', { spore_id: id, operator_id: OPERATOR }, teraToGas('15'), P6_DEPOSIT),
      actions.functionCall('set_policy', { spore_id: id, policy: P6_POLICY }, teraToGas('15'), 1n),
    ]);
    check(`activate + set_policy spores ${batch.join(',')} (${fmt(P6_DEPOSIT)} NEAR each)`, await deployer.send(ROUTER, acts));
  }
  if (!todo.length) console.log('skip | every spore below MAX_ACTIVE is active');

  // 5. Function-call keys for the spores that have none on the operator account.
  const keys = await operatorKeys(OPERATOR);
  const hasKey = (id: number) => ['P6_', 'P5_'].some((p) => env[`${p}SPORE_${id}_FC_PRIVATE_KEY`] && keys.has(KeyPair.fromString(env[`${p}SPORE_${id}_FC_PRIVATE_KEY`] as any).getPublicKey().toString()));
  const needKeys = Array.from({ length: MAX_ACTIVE }, (_, id) => id).filter((id) => id !== 5 && !hasKey(id));
  if (needKeys.length) {
    const fresh = needKeys.map((id) => {
      const kp = KeyPair.fromRandom('ed25519');
      saveEnv(`P6_SPORE_${id}_FC_PRIVATE_KEY`, kp.toString());
      return kp.getPublicKey();
    });
    for (let i = 0; i < fresh.length; i += 50) {
      const acts = fresh.slice(i, i + 50).map((pk) => actions.addFunctionCallAccessKey(pk, ROUTER, OP_METHODS, KEY_ALLOWANCE));
      check(`P6_ FC keys for spores ${needKeys.slice(i, i + 50).join(',')} on ${OPERATOR}`, await operator.send(OPERATOR, acts));
    }
  } else console.log('skip | every spore has a function-call key on chain');
  // The keeper's key: a 300 Tgas close holds about 0.03 NEAR of allowance.
  const deployerKeys = await operatorKeys(DEPLOYER);
  if (env.P6_KEEPER_FC_PRIVATE_KEY && deployerKeys.has(KeyPair.fromString(env.P6_KEEPER_FC_PRIVATE_KEY as any).getPublicKey().toString())) console.log('skip | P6_ keeper key on chain');
  else {
    const kp = KeyPair.fromRandom('ed25519');
    saveEnv('P6_KEEPER_FC_PRIVATE_KEY', kp.toString());
    check(`P6_ keeper FC key on ${DEPLOYER} (${KEEPER_METHODS.join(', ')}, 5 NEAR allowance)`, await deployer.send(DEPLOYER, [actions.addFunctionCallAccessKey(kp.getPublicKey(), ROUTER, KEEPER_METHODS, nearToYocto('5'))]));
  }

  // 6. Top-up: spores below SPORE_MIN back to SPORE_DEPOSIT, the operator back to its float.
  if (process.env.TOPUP === '1') {
    const low: [number, bigint][] = [];
    for (let id = 0; id < MAX_ACTIVE; id++) {
      const s = await view(ROUTER, 'spore_summary', { spore_id: id });
      if (s.active && BigInt(s.balance) < P6_MIN && s.listed_price === null) low.push([id, P6_DEPOSIT - BigInt(s.balance)]);
    }
    const total = low.reduce((t, [, a]) => t + a, 0n);
    console.log(`info | top-up: ${low.length} spores below ${fmt(P6_MIN)} NEAR need ${fmt(total)} NEAR`);
    if (total > 0n) {
      const has = (await balanceOf(DEPLOYER)) ?? 0n;
      await fundFrom(DEPLOYER, total + GAS_RESERVE - has, 'spore top-ups');
      for (let i = 0; i < low.length; i += 20) {
        const batch = low.slice(i, i + 20);
        check(`deposit to spores ${batch.map(([id]) => id).join(',')}`, await deployer.send(ROUTER, batch.map(([id, a]) => actions.functionCall('deposit', { spore_id: id }, teraToGas('10'), a))));
      }
    }
    await fundFrom(OPERATOR, OPERATOR_FLOAT - ((await balanceOf(OPERATOR)) ?? 0n), 'agent gas');
  }

  const after = await view(ROUTER, 'config');
  const info = await view(ROUTER, 'epoch_info');
  console.log(JSON.stringify({ max_active: after.max_active, active: info.active.length, storage: await view(ROUTER, 'storage_report'), ledger: await view(ROUTER, 'ledger_totals') }));
}

async function main() {
  if (PHASE6) return phase6();
  console.log(`router ${ROUTER}, outside ${OUTSIDE}, spores ${SPORES.join(',')}${PHASE5 ? `, operator2 ${OPERATOR2}` : ''}`);
  if (!env[ROUTER_VAR]) saveEnv(ROUTER_VAR, ROUTER);
  if (!env.OUTSIDE_ACCOUNT_ID) saveEnv('OUTSIDE_ACCOUNT_ID', OUTSIDE);
  if (PHASE5) {
    const routerUp = (await balanceOf(ROUTER)) !== null;
    let todo = BigInt(SPORES.length) * SPORE_DEPOSIT;
    if (routerUp) {
      try {
        for (const id of SPORES) if ((await view(ROUTER, 'spore_summary', { spore_id: id }))?.active) todo -= SPORE_DEPOSIT;
      } catch {}
    }
    await topUpFromV0(OWNER, todo);
    await topUpFromV0(BUYER, SALE_PRICE);
  }
  // Check every balance this run will spend up front, so a shortfall stops
  // the setup before anything is created.
  const routerExists = (await balanceOf(ROUTER)) !== null;
  const outsideExists = (await balanceOf(OUTSIDE)) !== null;
  const operator2Exists = !PHASE5 || (await balanceOf(OPERATOR2)) !== null;
  await need(
    PARENT,
    (routerExists || PHASE5 ? 0n : ROUTER_FUNDING) + (outsideExists ? 0n : nearToYocto('0.05')) + (operator2Exists ? 0n : nearToYocto('0.1')),
    'creating the router, outside and operator2 accounts',
  );
  const ownerHas = (await balanceOf(OWNER)) ?? 0n;
  const active = new Set<number>();
  if (routerExists) {
    try {
      for (const id of SPORES) if ((await view(ROUTER, 'spore_summary', { spore_id: id }))?.active) active.add(id);
    } catch {}
  }
  const ownerTodo = BigInt(SPORES.length - active.size) * SPORE_DEPOSIT;
  if (ownerHas < ownerTodo + GAS_RESERVE) {
    console.log(`SHORTFALL ${OWNER}: has ${fmt(ownerHas)} NEAR, needs ${fmt(ownerTodo + GAS_RESERVE)} to activate ${SPORES.length - active.size} spores (short ${fmt(ownerTodo + GAS_RESERVE - ownerHas)})`);
    process.exit(2);
  }

  if (PHASE5) await createFaucetAccount(ROUTER, ROUTER_KEY_VAR);
  else await createAccount(ROUTER, ROUTER_FUNDING, ROUTER_KEY_VAR);
  await createAccount(OUTSIDE, nearToYocto('0.05'), 'OUTSIDE_PRIVATE_KEY');
  if (PHASE5) {
    await createAccount(OPERATOR2, nearToYocto('0.1'), 'OPERATOR2_PRIVATE_KEY');
    if (!env.OPERATOR2_ACCOUNT_ID) saveEnv('OPERATOR2_ACCOUNT_ID', OPERATOR2);
  }

  let deployed = false;
  try {
    await view(ROUTER, 'config');
    deployed = true;
  } catch {}
  if (deployed) {
    // Same state layout, new code: REDEPLOY=1 deploys the local wasm without
    // re-running `new` when the on-chain code hash differs.
    const wasm = readFileSync(join(ROOT, 'target/near/spores_router/spores_router.wasm'));
    const local = baseEncode(createHash('sha256').update(wasm).digest());
    const onChain = (await rpc('query', { request_type: 'view_account', finality: 'final', account_id: ROUTER })).result.code_hash;
    if (onChain === local) console.log('skip | router already deployed with this wasm');
    else if (process.env.REDEPLOY !== '1') console.log(`WARN | on-chain code ${onChain} differs from local ${local}; REDEPLOY=1 deploys it (code only, no init)`);
    else check(`redeploy ${wasm.length} bytes (code only, state kept)`, await as(ROUTER, env[ROUTER_KEY_VAR]).send(ROUTER, [actions.deployContract(wasm)]));
  } else {
    const wasm = readFileSync(join(ROOT, 'target/near/spores_router/spores_router.wasm'));
    const config = {
      supply_cap: 64, max_active: 16,
      epoch_len_ns: '30000000000', job_timeout_ns: '60000000000',
      min_activation_deposit: '100000000000000000000000',
      decay_bps: 2500, gain: '1000000', k: '100000000000000000000000', d_min: '50000',
      fee_bps: 100, rebate_bps: 5000, breadth_full: 4, reject_bps: 5000,
      // Phase 5: living allowance (0.1 NEAR + 0.2 NEAR per 1000 reputation,
      // from `spores-sim allowance`) and a 5% royalty to the admin.
      ...(PHASE5 ? { base_budget: '100000000000000000000000', trust_gain: '200000000000000000000000', royalty_bps: 500, royalty_account: null } : {}),
    };
    const r = await as(ROUTER, env[ROUTER_KEY_VAR]).send(ROUTER, [
      actions.deployContract(wasm),
      actions.functionCall('new', { admin: DEPLOYER, config }, teraToGas('100'), 0n),
    ]);
    check(`deploy ${wasm.length} bytes and init`, r);
  }

  let supply = Number(await view(ROUTER, 'nft_total_supply'));
  while (supply < 64) {
    const owners = Array.from({ length: Math.min(16, 64 - supply) }, (_, i) => (SPORES.includes(supply + i) ? OWNER : DEPLOYER));
    check(`mint_genesis ${supply}..${supply + owners.length - 1}`, await deployer.call('mint_genesis', { owners }, 0n, 300));
    supply = Number(await view(ROUTER, 'nft_total_supply'));
  }

  const policy = {
    paused: false,
    budget_per_epoch: nearToYocto('1.5').toString(),
    max_payment: nearToYocto('0.5').toString(),
    allow_all_spores: true,
    allowlist: [],
    external_allowlist: [OUTSIDE],
  };
  for (const id of SPORES) {
    const s = await view(ROUTER, 'spore_summary', { spore_id: id });
    if (!s.active) check(`activate spore ${id} (${fmt(SPORE_DEPOSIT)} NEAR)`, await owner.call('activate', { spore_id: id, operator_id: OPERATOR }, SPORE_DEPOSIT, 30));
    else console.log(`skip | spore ${id} active`);
    const now = await view(ROUTER, 'spore_summary', { spore_id: id });
    if (JSON.stringify(now.policy) !== JSON.stringify(policy)) check(`set_policy spore ${id}`, await owner.call('set_policy', { spore_id: id, policy }, 1n, 30));
  }

  const keys = await operatorKeys(OPERATOR);
  for (const id of SPORES) {
    const v = `${KP}SPORE_${id}_FC_PRIVATE_KEY`;
    if (env[v] && keys.has(KeyPair.fromString(env[v] as any).getPublicKey().toString())) {
      console.log(`skip | ${v} on chain`);
      continue;
    }
    const kp = KeyPair.fromRandom('ed25519');
    saveEnv(v, kp.toString());
    check(`FC key for spore ${id} on ${OPERATOR}`, await operator.send(OPERATOR, [actions.addFunctionCallAccessKey(kp.getPublicKey(), ROUTER, OP_METHODS, KEY_ALLOWANCE)]));
  }
  const deployerKeys = await operatorKeys(DEPLOYER);
  const keeperVar = `${KP}KEEPER_FC_PRIVATE_KEY`;
  if (env[keeperVar] && deployerKeys.has(KeyPair.fromString(env[keeperVar] as any).getPublicKey().toString())) console.log('skip | keeper key on chain');
  else {
    const kp = KeyPair.fromRandom('ed25519');
    saveEnv(keeperVar, kp.toString());
    if (!env.KEEPER_ACCOUNT_ID) saveEnv('KEEPER_ACCOUNT_ID', DEPLOYER);
    check(`keeper FC key on ${DEPLOYER} (${KEEPER_METHODS.join(', ')})`, await deployer.send(DEPLOYER, [actions.addFunctionCallAccessKey(kp.getPublicKey(), ROUTER, KEEPER_METHODS, KEY_ALLOWANCE)]));
  }
  if (PHASE5) {
    const v = 'P5_OPERATOR2_FC_PRIVATE_KEY';
    const op2Keys = await operatorKeys(OPERATOR2);
    if (env[v] && op2Keys.has(KeyPair.fromString(env[v] as any).getPublicKey().toString())) console.log(`skip | ${v} on chain`);
    else {
      const kp = KeyPair.fromRandom('ed25519');
      saveEnv(v, kp.toString());
      const op2 = as(OPERATOR2, env.OPERATOR2_PRIVATE_KEY);
      check(`FC key on ${OPERATOR2}`, await op2.send(OPERATOR2, [actions.addFunctionCallAccessKey(kp.getPublicKey(), ROUTER, OP_METHODS, KEY_ALLOWANCE)]));
    }
  }

  console.log(JSON.stringify({ storage: await view(ROUTER, 'storage_report'), ledger: await view(ROUTER, 'ledger_totals') }));
}

async function operatorKeys(account: string): Promise<Set<string>> {
  const r = await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: account });
  return new Set((r.result?.keys ?? []).map((k: any) => k.public_key));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
