// Wipes the live router's state in place, so setup can deploy it fresh on the same account.
//
//   node agents/src/reset-router.ts <state_cleanup.wasm>          # dry run: key count, balance
//   node agents/src/reset-router.ts <state_cleanup.wasm> --yes    # wipe
//
// There is no migrate path and an epoch length is fixed at `new`, so a new config needs empty
// state. This follows NEAR's "State Cleaner" (docs.near.org/tools/clear-state): deploy NEAR's
// state_cleanup.wasm (near/core-contracts state-manipulation/res, git blob 034593df...) over the
// router, call `clean` with every key (base64), check the state is empty. Then it moves the
// balance above KEEP_NEAR (default 8: wasm storage plus 64 spores) to the deployer, because the
// old ledger's money is nobody's once the state is gone. The router's access keys, and the
// spores' keys on the operator accounts, are untouched. Afterwards (see CLAUDE.md):
//   EPOCH_LEN_S=150 SETUP_KEY_PREFIX=P7_ SPORE_DEPOSIT=0.2 bash scripts/phase5-setup.sh
//   SETUP_KEY_PREFIX=P7_ TOPUP=1 bash scripts/phase6-setup.sh
//
// The router is PHASE5_ROUTER_ACCOUNT_ID; testnet only, and never the evidence router (router4).
// Stop `scripts/auto.sh` first.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { actions, nearToYocto, teraToGas } from 'near-api-js';
import { Caller, balanceOf } from './near.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const env: Record<string, string> = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const ROUTER = env.PHASE5_ROUTER_ACCOUNT_ID;
const DEPLOYER = env.DEPLOYER_ACCOUNT_ID;
const wasmPath = process.argv[2];
const YES = process.argv.includes('--yes');
const KEEP = nearToYocto(process.env.KEEP_NEAR ?? '8');
// view_state over ~50 KB is refused by most public RPCs; Intea's serves it (per the State Cleaner page).
const STATE_RPC = process.env.STATE_RPC ?? 'https://testnet-rpc.intea.rs';
const fmt = (y: bigint) => (Number(y / 10n ** 20n) / 1e4).toFixed(4);

if (!wasmPath) throw new Error('usage: node agents/src/reset-router.ts <state_cleanup.wasm> [--yes]');
if (!ROUTER?.endsWith('.testnet')) throw new Error(`refusing router ${ROUTER}: testnet only`);
if (ROUTER === 'spores-hack-router4.testnet' || ROUTER === env.ROUTER4_ACCOUNT_ID) throw new Error('refusing the evidence router');
if (!env.PHASE5_ROUTER_PRIVATE_KEY || !DEPLOYER) throw new Error('.env needs PHASE5_ROUTER_PRIVATE_KEY and DEPLOYER_ACCOUNT_ID');
const wasm = readFileSync(wasmPath);
if (wasm.subarray(0, 4).toString('hex') !== '0061736d') throw new Error(`${wasmPath} is not a wasm module`);

async function stateKeys(): Promise<string[]> {
  const res = await fetch(STATE_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_state', finality: 'final', account_id: ROUTER, prefix_base64: '' } }),
  });
  const r = await res.json();
  if (!r.result) throw new Error(`view_state on ${STATE_RPC}: ${JSON.stringify(r.error ?? r).slice(0, 300)}`);
  return r.result.values.map((v: { key: string }) => v.key);
}

const keys = await stateKeys();
const balance = (await balanceOf(ROUTER)) ?? 0n;
console.log(`info | ${ROUTER}: ${keys.length} state keys, balance ${fmt(balance)} NEAR; will keep ${fmt(KEEP)} and move the rest to ${DEPLOYER}`);
if (!YES) {
  console.log('dry run; --yes wipes it');
  process.exit(0);
}

const router = new Caller(ROUTER, env.PHASE5_ROUTER_PRIVATE_KEY, ROUTER);
const step = (what: string, r: { ok: boolean; hash: string; err: string }) => {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} | ${what} | ${r.hash}${r.ok ? '' : ` | ${r.err}`}`);
  if (!r.ok) process.exit(1);
};
step(`deploy state_cleanup.wasm (${wasm.length} bytes) over the router`, await router.send(ROUTER, [actions.deployContract(wasm)]));
for (let i = 0; i < keys.length; i += 300) {
  const batch = keys.slice(i, i + 300);
  step(`clean keys ${i}..${i + batch.length - 1}`, await router.send(ROUTER, [actions.functionCall('clean', { keys: batch }, teraToGas('300'), 0n)]));
}
const left = await stateKeys();
if (left.length) {
  console.log(`FAIL | ${left.length} keys still there; run it again`);
  process.exit(1);
}
console.log('ok   | state is empty');
const now = (await balanceOf(ROUTER)) ?? 0n;
if (now > KEEP + nearToYocto('0.1')) {
  const move = now - KEEP;
  step(`move ${fmt(move)} NEAR to ${DEPLOYER}`, await new Caller(ROUTER, env.PHASE5_ROUTER_PRIVATE_KEY, DEPLOYER).send(DEPLOYER, [actions.transfer(move)]));
}
console.log(`done | ${ROUTER} runs state_cleanup with empty state; next: setup (see the header)`);
