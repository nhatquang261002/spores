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
import { appendFileSync, chmodSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KeyPair, actions, nearToYocto, teraToGas } from 'near-api-js';
import { Caller, balanceOf, rpc, view } from './near.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const ENV_FILE = join(ROOT, '.env');
const env: Record<string, string> = {};
for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const PARENT = env.SPORES_PARENT_ACCOUNT_ID;
const ROUTER = env.PHASE4_ROUTER_ACCOUNT_ID ?? `router3.${PARENT}`;
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

async function createAccount(id: string, funding: bigint, keyVar: string) {
  if ((await balanceOf(id)) !== null) return console.log(`skip | ${id} exists`);
  await need(PARENT, funding, `creating ${id}`);
  const kp = KeyPair.fromRandom('ed25519');
  // Save the key before the account exists, so a crash cannot lose it.
  saveEnv(keyVar, kp.toString());
  const r = await parent.send(id, [actions.createAccount(), actions.transfer(funding), actions.addFullAccessKey(kp.getPublicKey())]);
  check(`create ${id} with ${fmt(funding)} NEAR`, r);
}

async function main() {
  console.log(`router ${ROUTER}, outside ${OUTSIDE}, spores ${SPORES.join(',')}`);
  if (!env.PHASE4_ROUTER_ACCOUNT_ID) saveEnv('PHASE4_ROUTER_ACCOUNT_ID', ROUTER);
  if (!env.OUTSIDE_ACCOUNT_ID) saveEnv('OUTSIDE_ACCOUNT_ID', OUTSIDE);
  // Check every balance this run will spend up front, so a shortfall stops
  // the setup before anything is created.
  const routerExists = (await balanceOf(ROUTER)) !== null;
  const outsideExists = (await balanceOf(OUTSIDE)) !== null;
  await need(PARENT, (routerExists ? 0n : ROUTER_FUNDING) + (outsideExists ? 0n : nearToYocto('0.05')), 'creating the router and outside accounts');
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

  await createAccount(ROUTER, ROUTER_FUNDING, 'PHASE4_ROUTER_PRIVATE_KEY');
  await createAccount(OUTSIDE, nearToYocto('0.05'), 'OUTSIDE_PRIVATE_KEY');

  let deployed = false;
  try {
    await view(ROUTER, 'config');
    deployed = true;
  } catch {}
  if (deployed) console.log('skip | router already deployed');
  else {
    const wasm = readFileSync(join(ROOT, 'target/near/spores_router/spores_router.wasm'));
    const config = {
      supply_cap: 64, max_active: 16,
      epoch_len_ns: '30000000000', job_timeout_ns: '60000000000',
      min_activation_deposit: '100000000000000000000000',
      decay_bps: 2500, gain: '1000000', k: '100000000000000000000000', d_min: '50000',
      fee_bps: 100, rebate_bps: 5000, breadth_full: 4, reject_bps: 5000,
    };
    const r = await as(ROUTER, env.PHASE4_ROUTER_PRIVATE_KEY).send(ROUTER, [
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
    const v = `SPORE_${id}_FC_PRIVATE_KEY`;
    if (env[v] && keys.has(KeyPair.fromString(env[v] as any).getPublicKey().toString())) {
      console.log(`skip | ${v} on chain`);
      continue;
    }
    const kp = KeyPair.fromRandom('ed25519');
    saveEnv(v, kp.toString());
    check(`FC key for spore ${id} on ${OPERATOR}`, await operator.send(OPERATOR, [actions.addFunctionCallAccessKey(kp.getPublicKey(), ROUTER, OP_METHODS, KEY_ALLOWANCE)]));
  }
  const deployerKeys = await operatorKeys(DEPLOYER);
  if (env.KEEPER_FC_PRIVATE_KEY && deployerKeys.has(KeyPair.fromString(env.KEEPER_FC_PRIVATE_KEY as any).getPublicKey().toString())) console.log('skip | keeper key on chain');
  else {
    const kp = KeyPair.fromRandom('ed25519');
    saveEnv('KEEPER_FC_PRIVATE_KEY', kp.toString());
    if (!env.KEEPER_ACCOUNT_ID) saveEnv('KEEPER_ACCOUNT_ID', DEPLOYER);
    check(`keeper FC key on ${DEPLOYER}`, await deployer.send(DEPLOYER, [actions.addFunctionCallAccessKey(kp.getPublicKey(), ROUTER, ['close_epoch', 'timeout_job'], KEY_ALLOWANCE)]));
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
