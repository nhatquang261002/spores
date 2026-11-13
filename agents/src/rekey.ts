// Replaces router5's function-call keys that have a gas allowance with keys that have none.
//
//   node agents/src/rekey.ts            # dry run: lists each key and its allowance left
//   node agents/src/rekey.ts --apply    # one tx per account: add the new key, delete the old one
//
// Why: setup.ts gave every key a 1 NEAR allowance, and a 300 Tgas `close_epoch`
// reserves about 0.3 NEAR of it up front, so the keeper's key stopped working at
// 0.2997 NEAR left (epoch 253 on router5, 2026-11-13: 1,324 closes refused with
// NotEnoughAllowance, no tubes for hours). A key with no allowance is still limited
// to the same receiver and methods; the account's balance is then the only limit
// (auto.ts watches the keeper's and the operator's).
//
// The new key replaces the old one's line in .env before the tx is sent (a crash cannot lose
// it), and the old line comes back if the tx fails. Stop `scripts/auto.sh` first: running
// agents hold the old keys. Testnet only. Keys are never printed.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KeyPair, actions } from 'near-api-js';
import { Caller, rpc } from './near.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const ENV_FILE = join(ROOT, '.env');
const APPLY = process.argv.includes('--apply');
const PREFIX = process.env.KEY_PREFIX ?? 'P7_';

function readEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); // the last line wins, as everywhere else
  }
  return env;
}

/** Sets every line of `name` in .env to `value` (so no older line can win). */
function setEnv(name: string, value: string) {
  const lines = readFileSync(ENV_FILE, 'utf8').split('\n');
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}=`);
  if (!lines.some((l) => re.test(l))) throw new Error(`${name} is not in .env`);
  writeFileSync(ENV_FILE, lines.map((l) => (re.test(l) ? `${name}=${value}` : l)).join('\n'));
  chmodSync(ENV_FILE, 0o600);
}

const env = readEnv();
const ROUTER = env.PHASE5_ROUTER_ACCOUNT_ID;
if (!ROUTER?.endsWith('.testnet')) throw new Error(`refusing router ${ROUTER}: testnet only`);
const near = (y: bigint) => (Number(y / 10n ** 20n) / 1e4).toFixed(4);

// [env var, account holding the key, that account's full-access key var]
const holders: [string, string, string][] = [];
const keeperVar = `${PREFIX}KEEPER_FC_PRIVATE_KEY`;
const keeperAccount = env.KEEPER_ACCOUNT_ID ?? env.DEPLOYER_ACCOUNT_ID;
if (env[keeperVar]) holders.push([keeperVar, keeperAccount, keeperAccount === env.DEPLOYER_ACCOUNT_ID ? 'DEPLOYER_PRIVATE_KEY' : '']);
for (let id = 0; id < 64; id++) {
  const v = `${PREFIX}SPORE_${id}_FC_PRIVATE_KEY`;
  if (env[v]) holders.push([v, env.OPERATOR_ACCOUNT_ID, 'OPERATOR_PRIVATE_KEY']);
}
const op2 = `${PREFIX}OPERATOR2_FC_PRIVATE_KEY`;
if (env[op2]) holders.push([op2, env.OPERATOR2_ACCOUNT_ID, 'OPERATOR2_PRIVATE_KEY']);

type Plan = { v: string; account: string; fullKeyVar: string; old: KeyPair; methods: string[] };
const plans: Plan[] = [];
for (const [v, account, fullKeyVar] of holders) {
  const old = KeyPair.fromString(env[v] as any);
  const r = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: account, public_key: old.getPublicKey().toString() });
  const fc = r.result?.permission?.FunctionCall;
  if (!fc) {
    console.log(`skip | ${v}: not a function-call key on ${account} (${r.error?.cause?.name ?? 'no key'})`);
    continue;
  }
  if (fc.receiver_id !== ROUTER) {
    console.log(`skip | ${v}: for ${fc.receiver_id}, not ${ROUTER}`);
    continue;
  }
  if (fc.allowance == null) {
    console.log(`skip | ${v} on ${account}: already has no allowance`);
    continue;
  }
  if (!fullKeyVar || !env[fullKeyVar]) throw new Error(`no full-access key in .env for ${account}`);
  console.log(`todo | ${v} on ${account}: ${near(BigInt(fc.allowance))} NEAR allowance left, methods ${fc.method_names.join(',')}`);
  plans.push({ v, account, fullKeyVar, old, methods: fc.method_names });
}
if (!APPLY) {
  console.log(`${plans.length} key(s) to replace; --apply replaces them`);
  process.exit(0);
}

const byAccount = new Map<string, Plan[]>();
for (const p of plans) byAccount.set(p.account, [...(byAccount.get(p.account) ?? []), p]);
for (const [account, ps] of byAccount) {
  for (let i = 0; i < ps.length; i += 40) {
    const batch = ps.slice(i, i + 40);
    const fresh = batch.map(() => KeyPair.fromRandom('ed25519'));
    batch.forEach((p, j) => setEnv(p.v, fresh[j].toString()));
    const acts = batch.flatMap((p, j) => [
      actions.addFunctionCallAccessKey(fresh[j].getPublicKey(), ROUTER, p.methods), // no allowance
      actions.deleteKey(p.old.getPublicKey()),
    ]);
    const r = await new Caller(account, env[batch[0].fullKeyVar], account).send(account, acts);
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} | ${account}: ${batch.map((p) => p.v).join(', ')} replaced by keys with no allowance | ${r.hash}${r.ok ? '' : ` | ${r.err}`}`);
    if (!r.ok) {
      batch.forEach((p) => setEnv(p.v, p.old.toString()));
      console.log('     .env restored for that batch');
      process.exit(1);
    }
  }
}
