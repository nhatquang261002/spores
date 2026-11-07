#!/usr/bin/env node
// Chain stats for the README, from public data only: no keys, no local logs.
//
//   node scripts/chain-stats.mjs [closes-file] [--finality N]
//
// Reads every close transaction in the list (default docs/router4-closes.txt)
// from archival RPC, sums what each `epoch_closed` event says, and, for the last
// N closes (default 9), measures inclusion to finality from block timestamps:
// from the block that included the tx to the first block whose `last_final_block`
// covers the tx's last receipt. It does not count the trip to the RPC node.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const fIdx = args.indexOf('--finality');
const finalityN = fIdx >= 0 ? Number(args.splice(fIdx, 2)[1]) : 9;
const file = args[0] ?? 'docs/router4-closes.txt';
const SIGNER = process.env.CLOSE_SIGNER ?? 'deployer.spores-hack.testnet';
const RPCS = (process.env.NEAR_ARCHIVAL_RPCS ?? 'https://archival-rpc.testnet.fastnear.com,https://archival-rpc.testnet.near.org').split(',');
const hashes = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params) {
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = RPCS[attempt % RPCS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(JSON.stringify(body.error).slice(0, 200));
      return body.result;
    } catch (e) {
      last = e;
      await sleep(500 * 2 ** Math.min(attempt, 4));
    }
  }
  throw new Error(`${method}: ${last}`);
}

const near = (y) => (Number(y / 10n ** 15n) / 1e9).toFixed(4);
const tgas = (g) => g / 1e12;
const event = (tx) => {
  for (const r of tx.receipts_outcome) for (const l of r.outcome.logs) {
    if (!l.startsWith('EVENT_JSON:')) continue;
    const e = JSON.parse(l.slice(11));
    if (e.event === 'epoch_closed') return e.data[0];
  }
  throw new Error(`no epoch_closed in ${tx.transaction.hash}`);
};

const rows = [];
for (const h of hashes) {
  const tx = await rpc('tx', { tx_hash: h, sender_account_id: SIGNER, wait_until: 'FINAL' });
  rows.push({ h, tx, e: event(tx) });
}

let fees = 0n, volume = 0n, pairEpochs = 0, rejects = 0, busiest = 0;
for (const { e } of rows) {
  fees += BigInt(e.pool);
  for (const [, , q] of e.flows) volume += BigInt(q);
  pairEpochs += e.flows.length;
  for (const [, , n] of e.rejects) rejects += Number(n);
  busiest = Math.max(busiest, e.flows.length);
}
const gasOf = (tx) => tx.transaction_outcome.outcome.gas_burnt + tx.receipts_outcome.reduce((s, r) => s + r.outcome.gas_burnt, 0);
const byActive = new Map();
for (const { e, tx } of rows) {
  const a = e.active.length;
  const g = byActive.get(a) ?? [];
  g.push(tgas(gasOf(tx)));
  byActive.set(a, g);
}

const epochs = rows.map((r) => r.e.epoch);
console.log(`closes read: ${rows.length}, epochs ${Math.min(...epochs)} to ${Math.max(...epochs)}`);
console.log(`settled volume in closes (sum of per-pair flows): ${near(volume)} NEAR`);
console.log(`fees in closes (sum of pools): ${near(fees)} NEAR`);
console.log(`pair-epochs with flow: ${pairEpochs}, busiest close: ${busiest} pairs`);
console.log(`rejected deliveries in closes: ${rejects}`);
for (const [a, g] of [...byActive].sort((x, y) => x[0] - y[0])) {
  const avg = g.reduce((s, v) => s + v, 0) / g.length;
  console.log(`close_epoch gas at ${a} active: ${g.length} closes, avg ${avg.toFixed(2)}, max ${Math.max(...g).toFixed(2)} Tgas`);
}

const blockAt = (height) => rpc('block', { block_id: height });
const ms = [];
for (const { tx } of rows.slice(-finalityN)) {
  const inc = await rpc('block', { block_id: tx.transaction_outcome.block_hash });
  let lastH = 0;
  for (const r of tx.receipts_outcome) lastH = Math.max(lastH, (await rpc('block', { block_id: r.block_hash })).header.height);
  let h = lastH + 1, end;
  for (; h < lastH + 30; h++) {
    let b;
    try { b = await blockAt(h); } catch { continue; } // a skipped height
    const final = await rpc('block', { block_id: b.header.last_final_block });
    if (final.header.height >= lastH) { end = b; break; }
  }
  if (!end) throw new Error('no final block found');
  ms.push((end.header.timestamp - inc.header.timestamp) / 1e6);
}
if (ms.length) {
  ms.sort((a, b) => a - b);
  const avg = ms.reduce((s, v) => s + v, 0) / ms.length;
  console.log(`inclusion to final, last ${ms.length} closes: avg ${(avg / 1000).toFixed(2)} s, min ${(ms[0] / 1000).toFixed(2)} s, max ${(ms[ms.length - 1] / 1000).toFixed(2)} s`);
}
