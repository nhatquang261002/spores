// One command for a live run: starts the outside service, the keeper and one
// agent process per spore against the router on testnet, fires the scripted
// shocks, and when the keeper has closed the requested epochs stops
// everything, renders every spore after every close and checks the Phase 4
// exit criteria. Writes everything to out/agents/<run>/ and exits non-zero if
// a check fails.
//
//   node src/run.ts --spores 0-8 --epochs 8 --seed 1 [--run NAME] [--shocks raise@4,cut@5,kill@6,sale@3] [--sale-spore N]
//
// Shock epochs count from the epoch the run starts in. Targets follow sim:
// kill the best-value provider (quality per cost), raise the runner-up's cost
// threefold, cut the strongest tube among the run's spores.
//
// Phase 5 (a router with the market, i.e. `royalty_bps` in its config): the
// keeper commits an image for every active spore after each close, and
// `sale@N` runs the sale scene (SPEC §7.3): the owner lists the spore with the
// highest reputation that is not a shock target (or --sale-spore), the buyer
// buys it, the old operator key and the old owner are refused, the buyer
// registers operator2 and a policy, and the spore's agent restarts under
// operator2. The report then also runs `spores-verify` over every close of
// the router and checks the sold spore's committed image.
// Reads keys from the repo's .env; never prints them.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nearToYocto } from 'near-api-js';
import { appendJsonl, ensureDir, sleep, writeControl } from './common.ts';
import { Caller, EXPLORER, rpc, txStatus, view, type TxResult } from './near.ts';
import { profile } from './services.ts';
import { applyShock } from './shock.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

function parseIds(s: string): number[] {
  return s.split(',').flatMap((part) => {
    const [a, b] = part.split('-').map(Number);
    return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, k) => a + k);
  });
}

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const dotenv = loadEnv();
const spores = parseIds(opt('spores', '0-8'));
const epochs = Number(opt('epochs', '8'));
const seed = opt('seed', '1');
const runName = opt('run', new Date().toISOString().replace(/[:.]/g, '-'));
const shockSpec = opt('shocks', 'raise@4,cut@5,kill@6');
const saleSporeOpt = opt('sale-spore', '');
const SALE_PRICE = nearToYocto(process.env.SALE_PRICE ?? '0.5');
const router = process.env.ROUTER ?? dotenv.PHASE4_ROUTER_ACCOUNT_ID ?? dotenv.ROUTER_ACCOUNT_ID;
const runDir = join(ROOT, 'out/agents', runName);
ensureDir(runDir);
writeControl(runDir, { killed: [], raise: {}, cut: [] });
const EVENTS = join(runDir, 'events.jsonl');

const childEnv: Record<string, string | undefined> = {
  ...process.env,
  ...dotenv,
  RUN_DIR: runDir,
  ROUTER: router,
  SEED: seed,
  SPORES: spores.join(','),
  EPOCHS: String(epochs),
  OUTSIDE_ACCOUNT_ID: dotenv.OUTSIDE_ACCOUNT_ID,
  OUTSIDE_LOG: join(runDir, 'outside.jsonl'),
  KEEPER_ACCOUNT_ID: dotenv.KEEPER_ACCOUNT_ID ?? dotenv.DEPLOYER_ACCOUNT_ID,
};

const children = new Map<string, ChildProcess>();
function start(name: string, script: string, extra: Record<string, string> = {}) {
  const out = createWriteStream(join(runDir, `${name}.log`));
  const p = spawn(process.execPath, [script], { env: { ...childEnv, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  p.on('exit', (code) => appendJsonl(EVENTS, { at: new Date().toISOString(), spore: 'run', kind: 'exit', name, code }));
  children.set(name, p);
  return p;
}

function shockTargets() {
  const value = spores
    .map((id) => ({ id, ...profile(BigInt(seed), id) }))
    // Highest quality per unit of cost first: q_a / c_a > q_b / c_b  <=>  q_a * c_b > q_b * c_a.
    .sort((a, b) => {
      const l = BigInt(a.qualityBps) * b.cost;
      const r = BigInt(b.qualityBps) * a.cost;
      return l > r ? -1 : l < r ? 1 : a.id - b.id;
    });
  return { star: value[0].id, runnerUp: value[1].id };
}

async function strongestTube(): Promise<[number, number] | null> {
  const edges: [number, number, string][] = await view(router, 'edges');
  const mine = edges.filter(([a, b]) => spores.includes(a) && spores.includes(b));
  mine.sort((x, y) => (BigInt(y[2]) > BigInt(x[2]) ? 1 : BigInt(y[2]) < BigInt(x[2]) ? -1 : x[0] - y[0] || x[1] - y[1]));
  return mine.length ? [mine[0][0], mine[0][1]] : null;
}

function sh(cmd: string, argv: string[], cwd = ROOT): string {
  return execFileSync(cmd, argv, { cwd, encoding: 'utf8', env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` } });
}

// ---- sale scene (Phase 5) ----------------------------------------------------

const sale: Record<string, any> = { scheduled: false };
const saleNote = (kind: string, extra: object = {}) => appendJsonl(EVENTS, { at: new Date().toISOString(), spore: 'sale', kind, ...extra });
function saleTx(step: string, method: string, r: TxResult) {
  saleNote('tx', { step, method, hash: r.hash, ok: r.ok, err: r.err || undefined, gas_tgas: r.gasTgas });
  console.log(`sale: ${step} ${r.ok ? 'ok' : 'FAILED'} ${r.hash}${r.ok ? '' : ` ${r.err}`}`);
  return r;
}
const LOCKED = { paused: true, budget_per_epoch: '0', max_payment: '0', allow_all_spores: false, allowlist: [], external_allowlist: [] };

async function saleSpore(targets: { star: number; runnerUp: number }): Promise<number> {
  if (saleSporeOpt) return Number(saleSporeOpt);
  let best = -1;
  let bestRep = -1n;
  for (const id of spores) {
    if (id === targets.star || id === targets.runnerUp) continue;
    const r = BigInt((await view(router, 'spore_summary', { spore_id: id })).reputation);
    if (r > bestRep) [best, bestRep] = [id, r];
  }
  return best;
}

async function runSale(targets: { star: number; runnerUp: number }, config: any) {
  const X = await saleSpore(targets);
  const owner = new Caller(dotenv.OWNER_ACCOUNT_ID, dotenv.OWNER_PRIVATE_KEY, router);
  const buyer = new Caller(dotenv.BUYER_ACCOUNT_ID, dotenv.BUYER_PRIVATE_KEY, router);
  const royaltyAccount = config.royalty_account ?? (await view(router, 'admin'));
  const seller: string = (await view(router, 'spore_summary', { spore_id: X })).owner_id;
  Object.assign(sale, { spore: X, seller, buyer: buyer.accountId, royalty_account: royaltyAccount, price: SALE_PRICE.toString(), royalty_bps: config.royalty_bps });
  console.log(`sale: spore ${X} from ${seller} to ${buyer.accountId} for ${SALE_PRICE} yocto`);
  sale.list = saleTx('list', 'list', await owner.call('list', { spore_id: X, price: SALE_PRICE.toString() }, 1n, 30)).hash;
  const buy = saleTx('buy', 'buy', await buyer.call('buy', { spore_id: X }, SALE_PRICE, 100));
  sale.buy = buy.hash;
  sale.buy_ok = buy.ok;
  sale.at = new Date().toISOString();
  if (!buy.ok) return;

  // State just before and just after the block that ran the buy receipt.
  const st = await txStatus(buy.hash, buyer.accountId);
  const first = st.transaction_outcome.outcome.receipt_ids[0];
  const ro = st.receipts_outcome.find((o: any) => o.id === first);
  const prevHash = (await rpc('block', { block_id: ro.block_hash })).result.header.prev_hash;
  const before = await view(router, 'spore_summary', { spore_id: X }, prevHash);
  const after = await view(router, 'spore_summary', { spore_id: X }, ro.block_hash);
  const ev = (name: string) => buy.events.filter((e) => e.event === name).flatMap((e) => e.data);
  const sold = ev('spore_sold')[0];
  const refundsToX = ev('job_refunded').filter((d) => d.consumer === X).reduce((t, d) => t + BigInt(d.amount), 0n);
  // The two payout transfers and whether each one succeeded.
  const paid = (to: string) =>
    (st.receipts ?? [])
      .filter((r: any) => r.receiver_id === to && r.predecessor_id === router)
      .flatMap((r: any) => (r.receipt?.Action?.actions ?? []).filter((a: any) => a.Transfer).map((a: any) => ({ id: r.receipt_id, deposit: BigInt(a.Transfer.deposit) })))
      .map((t: any) => ({ ...t, ok: st.receipts_outcome.find((o: any) => o.id === t.id)?.outcome?.status?.SuccessValue !== undefined }));
  const royalty = (SALE_PRICE * BigInt(config.royalty_bps)) / 10_000n;
  const toSeller = paid(seller);
  const toRoyalty = paid(royaltyAccount);
  Object.assign(sale, {
    block: ro.block_hash,
    before: { owner: before.owner_id, operator: before.operator_id, operator_gen: before.operator_gen, balance: before.balance, age: before.age, reputation: before.reputation, connections: before.connections, policy: before.policy },
    after: { owner: after.owner_id, operator: after.operator_id, operator_gen: after.operator_gen, balance: after.balance, age: after.age, reputation: after.reputation, connections: after.connections, policy: after.policy, listed_price: after.listed_price, sales: after.sales },
    sold_event: sold,
    refunds_to_spore: refundsToX.toString(),
    payouts: { seller: toSeller.map((t: any) => ({ ...t, deposit: t.deposit.toString() })), royalty: toRoyalty.map((t: any) => ({ ...t, deposit: t.deposit.toString() })) },
    payment_failed: ev('sale_payment_failed').length > 0,
  });
  sale.paid_ok =
    after.owner_id === buyer.accountId && !!sold && BigInt(sold.price) === SALE_PRICE && BigInt(sold.royalty) === royalty &&
    BigInt(sold.seller_amount) + BigInt(sold.royalty) === SALE_PRICE &&
    toSeller.some((t: any) => t.ok && t.deposit === SALE_PRICE - royalty) && (royalty === 0n || toRoyalty.some((t: any) => t.ok && t.deposit === royalty)) && !sale.payment_failed;
  sale.reset_ok = JSON.stringify(after.policy) === JSON.stringify(LOCKED) && after.operator_id === null && after.operator_gen === before.operator_gen + 1 && after.listed_price === null;
  sale.intact_ok =
    BigInt(after.balance) === BigInt(before.balance) + refundsToX && JSON.stringify(after.connections) === JSON.stringify(before.connections) && after.age === before.age && after.reputation === before.reputation;

  // The old agent notices it lost control; then its key and the old owner are refused.
  for (let i = 0; i < 10 && !readJsonl(EVENTS).some((e) => e.spore === X && e.kind === 'idle' && e.at > sale.at); i++) await sleep(2_000);
  sale.old_agent_idle = readJsonl(EVENTS).some((e) => e.spore === X && e.kind === 'idle' && e.at > sale.at);
  children.get(`agent-${X}`)?.kill('SIGTERM');
  await sleep(1_500);
  const oldKey = new Caller(dotenv.OPERATOR_ACCOUNT_ID, dotenv[`${process.env.KEY_PREFIX ?? ''}SPORE_${X}_FC_PRIVATE_KEY`], router);
  const lock = saleTx('old operator key posts a job (must fail)', 'post_job', await oldKey.call('post_job', { spore_id: X, task: 'lockout check', max_price: '1' }));
  sale.old_key_refused = !lock.ok && /not this spore's operator/.test(lock.err);
  sale.old_key_tx = lock.hash;
  const wd = saleTx('old owner withdraws (must fail)', 'withdraw', await owner.call('withdraw', { spore_id: X, amount: '1' }, 1n, 30));
  sale.old_owner_refused = !wd.ok && /only the spore owner/.test(wd.err);
  sale.old_owner_tx = wd.hash;

  // The new owner takes over with its own operator; the agent resumes under it.
  const op2 = dotenv.OPERATOR2_ACCOUNT_ID;
  sale.register = saleTx('buyer registers operator2', 'register_operator', await buyer.call('register_operator', { spore_id: X, operator_id: op2 }, 1n, 30)).hash;
  const policy = { paused: false, budget_per_epoch: nearToYocto('1.5').toString(), max_payment: nearToYocto('0.5').toString(), allow_all_spores: true, allowlist: [], external_allowlist: [dotenv.OUTSIDE_ACCOUNT_ID] };
  sale.policy = saleTx('buyer sets a policy', 'set_policy', await buyer.call('set_policy', { spore_id: X, policy }, 1n, 30)).hash;
  sale.resumed_at = new Date().toISOString();
  start(`agent-${X}-operator2`, join(ROOT, 'agents/src/agent.ts'), { SPORE_ID: String(X), AGENT_OPERATOR_ACCOUNT_ID: op2, AGENT_FC_PRIVATE_KEY: dotenv.P5_OPERATOR2_FC_PRIVATE_KEY });
  saleNote('done', { spore: X });
}

async function main() {
  console.log(`run ${runName}: router ${router}, spores ${spores.join(',')}, ${epochs} epochs, seed ${seed}, shocks ${shockSpec || 'none'}`);
  sh('cargo', ['build', '--release', '-q', '-p', 'spores-renderer', '-p', 'spores-sim']);
  const config = await view(router, 'config');
  const phase5 = config.royalty_bps !== undefined;
  if (phase5) {
    sh('cargo', ['build', '--release', '-q', '-p', 'spores-verify']);
    childEnv.COMMIT_IMAGES = '1';
  }
  const startInfo = await view(router, 'epoch_info');
  const targets = shockTargets();
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({ run: runName, router, spores, epochs, seed, shocks: shockSpec, start_epoch: startInfo.epoch, shock_targets: targets, config, profiles: Object.fromEntries(spores.map((id) => [id, profile(BigInt(seed), id)])) }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );

  start('outside', join(ROOT, 'outside/src/server.ts'));
  await sleep(1_000);
  start('keeper', join(ROOT, 'agents/src/keeper.ts'));
  for (const id of spores) start(`agent-${id}`, join(ROOT, 'agents/src/agent.ts'), { SPORE_ID: String(id) });

  const pending = shockSpec
    ? shockSpec.split(',').map((s) => {
        const [kind, at] = s.split('@');
        return { kind, at: startInfo.epoch + Number(at), done: false };
      })
    : [];
  while (!existsSync(join(runDir, 'keeper-done.json'))) {
    await sleep(3_000);
    if (children.get('keeper')?.exitCode != null) break;
    let info;
    try {
      info = await view(router, 'epoch_info');
    } catch {
      continue;
    }
    for (const s of pending) {
      if (s.done || info.epoch < s.at) continue;
      s.done = true;
      if (s.kind === 'kill') applyShock(runDir, { kind: 'kill', spore: targets.star }, info.epoch);
      if (s.kind === 'raise') applyShock(runDir, { kind: 'raise', spore: targets.runnerUp, factorBps: 30_000 }, info.epoch);
      if (s.kind === 'cut') {
        const t = await strongestTube();
        if (t) applyShock(runDir, { kind: 'cut', a: t[0], b: t[1] }, info.epoch);
      }
      if (s.kind === 'sale') {
        sale.scheduled = true;
        sale.epoch = info.epoch;
        try {
          await runSale(targets, config);
        } catch (e) {
          sale.error = (e as Error).message;
          console.log(`sale: error ${sale.error}`);
        }
      }
      console.log(`epoch ${info.epoch}: shock ${s.kind}`);
    }
  }
  for (const p of children.values()) p.kill('SIGTERM');
  await sleep(1_000);
  const ok = report(phase5);
  process.exit(ok ? 0 : 1);
}

// ---- report -------------------------------------------------------------------

function readJsonl(file: string): any[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Every run directory's events.jsonl for this router, oldest run first: verify needs every close since epoch 1. */
function routerEventFiles(): string[] {
  const base = join(ROOT, 'out/agents');
  return readdirSync(base)
    .filter((d) => existsSync(join(base, d, 'run.json')) && existsSync(join(base, d, 'events.jsonl')))
    .filter((d) => JSON.parse(readFileSync(join(base, d, 'run.json'), 'utf8')).router === router)
    .sort()
    .map((d) => join(base, d, 'events.jsonl'));
}

function runVerify(argv: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: sh(join(ROOT, 'target/release/spores-verify'), argv).trim() };
  } catch (e: any) {
    return { ok: false, out: `${String(e.stdout ?? '').trim()}\n${String(e.stderr ?? e.message).trim()}`.trim() };
  }
}

function report(phase5: boolean): boolean {
  const snapDir = join(runDir, 'snapshots');
  const snaps = readdirSync(snapDir)
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => (a === 'start.json' ? -1 : b === 'start.json' ? 1 : a.localeCompare(b)))
    .map((f) => JSON.parse(readFileSync(join(snapDir, f), 'utf8')));
  const renderDir = join(runDir, 'renders');
  ensureDir(renderDir);
  const renderer = join(ROOT, 'target/release/spores-render');
  const hashes: Record<string, Record<string, string>> = {};
  for (const s of snaps) {
    hashes[s.label] = {};
    for (const id of spores) {
      const input = join(renderDir, `${s.label}-spore-${id}.json`);
      writeFileSync(input, JSON.stringify(s.spores[id].render_input));
      const out = sh(renderer, ['state', input, join(renderDir, `${s.label}-spore-${id}.png`)]);
      hashes[s.label][id] = out.match(/image_hash ([0-9a-f]+)/)![1];
    }
  }
  if (snaps.length === 0) {
    console.log('no snapshots: the keeper never recorded chain state');
    return false;
  }
  const first = snaps[0];
  const last = snaps[snaps.length - 1];
  const changed = spores.filter((id) => new Set(snaps.map((s) => hashes[s.label][id])).size > 1);
  const edgeCounts = snaps.map((s) => s.edges.length);
  const totalD = snaps.map((s) => s.edges.reduce((t: bigint, e: any) => t + BigInt(e[2]), 0n).toString());

  const decisions = readJsonl(join(runDir, 'decisions.jsonl'));
  const outcomes: Record<string, number> = {};
  for (const d of decisions) outcomes[d.outcome] = (outcomes[d.outcome] ?? 0) + 1;
  let replay = '';
  let replayOk = false;
  try {
    if (!existsSync(join(runDir, 'decisions.jsonl'))) throw new Error('no decisions logged');
    replay = sh(join(ROOT, 'target/release/spores-sim'), ['replay-decisions', join(runDir, 'decisions.jsonl')]).trim();
    replayOk = true;
  } catch (e: any) {
    replay = String(e.stdout ?? e.message).trim();
  }
  const sold = readJsonl(join(runDir, 'outside.jsonl')).filter((e) => e.kind === 'sold');
  const refused = readJsonl(join(runDir, 'outside.jsonl')).filter((e) => e.kind === 'refused');
  const events = readJsonl(EVENTS);
  const txs = events.filter((e) => e.kind === 'tx');
  const gas: Record<string, { n: number; ok: number; total: number; max: number }> = {};
  for (const t of txs) {
    const g = (gas[t.method] ??= { n: 0, ok: 0, total: 0, max: 0 });
    g.n++;
    if (t.ok) {
      g.ok++;
      g.total += t.gas_tgas;
      g.max = Math.max(g.max, t.gas_tgas);
    }
  }
  const failedTx = txs.filter((t) => !t.ok);
  const errors: Record<string, number> = {};
  for (const t of failedTx) {
    const k = `${t.method}: ${String(t.err).replace(/^Smart contract panicked: /, '').slice(0, 80)}`;
    errors[k] = (errors[k] ?? 0) + 1;
  }

  const checks = [
    { name: `agents traded unattended for ${snaps.length - 1} epochs`, ok: snaps.length - 1 >= epochs && (outcomes.settled ?? 0) > 0 },
    { name: 'tubes formed (edges after the run > at the start, and non-empty)', ok: last.edges.length > 0 && Math.max(...edgeCounts) > first.edges.length },
    { name: 'the rendered art changed between epochs', ok: changed.length > 0 },
    { name: 'every logged hire matches spores_core::hiring::pick', ok: replayOk && decisions.length > 0 },
    { name: 'ledger conserved at the end', ok: last.ledger.conserved === true },
    { name: 'outside service sold at least one item against an on-chain receipt', ok: sold.length > 0 },
  ];
  let verifyEpochs: { ok: boolean; out: string } | null = null;
  let verifyImage: { ok: boolean; out: string } | null = null;
  const commits = txs.filter((t) => t.method === 'commit_image');
  if (phase5) {
    const files = routerEventFiles();
    verifyEpochs = runVerify(['epochs', '--router', router, '--closes', ...files]);
    checks.push({ name: 'the keeper committed an image for every active spore after each close', ok: commits.length > 0 && commits.every((t) => t.ok) && commits.length >= (snaps.length - 1) * spores.length });
    checks.push({ name: 'spores-verify reproduces every epoch fingerprint of the router from its close receipts', ok: verifyEpochs.ok && /: match$/m.test(verifyEpochs.out) });
    const imageSpore = sale.spore ?? spores[0];
    verifyImage = runVerify(['image', '--router', router, '--closes', ...files, '--spore', String(imageSpore)]);
    checks.push({ name: `spores-verify regenerates spore ${imageSpore}'s committed image from chain state`, ok: verifyImage.ok && /^image: match$/m.test(verifyImage.out) });
  }
  if (sale.scheduled) {
    const X = sale.spore;
    const resumed = events.filter((e) => e.spore === X && e.kind === 'tx' && e.ok && sale.resumed_at && e.at > sale.resumed_at);
    sale.resumed_txs = resumed.length;
    checks.push(
      { name: `sale: spore ${X} bought atomically, seller paid price - royalty and the royalty account paid ${sale.royalty_bps} bps`, ok: !!sale.buy_ok && !!sale.paid_ok },
      { name: 'sale: operator cleared, policy reset to paused with zero budget, listing gone', ok: !!sale.reset_ok },
      { name: 'sale: balance (plus refunded escrow), tubes, age and reputation unchanged', ok: !!sale.intact_ok },
      { name: 'sale: the old operator key and the old owner are refused', ok: !!sale.old_key_refused && !!sale.old_owner_refused },
      { name: 'sale: the new owner registered operator2 and the agent resumed trading', ok: resumed.length > 0 },
    );
  }
  const out = {
    run: runName,
    router,
    epochs: snaps.map((s) => s.epoch),
    fingerprints: snaps.map((s) => s.fingerprint),
    edge_counts: edgeCounts,
    total_d: totalD,
    final_edges: last.edges,
    image_hashes: hashes,
    art_changed: changed,
    decisions: decisions.length,
    outcomes,
    replay,
    outside: { sold: sold.length, refused: refused.length, sales: sold.map((s) => ({ spore: s.spore_id, tx: s.tx_hash })) },
    tx: { total: txs.length, failed: failedTx.length, errors, gas_tgas: Object.fromEntries(Object.entries(gas).map(([m, g]) => [m, { calls: g.n, ok: g.ok, avg: g.ok ? +(g.total / g.ok).toFixed(2) : 0, max: g.max }])) },
    ledger: last.ledger,
    image_commits: { total: commits.length, ok: commits.filter((t) => t.ok).length },
    sale: sale.scheduled ? sale : undefined,
    verify: phase5 ? { epochs: verifyEpochs, image: verifyImage } : undefined,
    checks,
  };
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(out, null, 2));

  const lines = [
    `# Live run ${runName}`,
    '',
    `Router \`${router}\`, spores ${spores.join(', ')}, seed ${seed}, shocks \`${shockSpec}\`. Epochs ${first.epoch} to ${last.epoch}.`,
    '',
    '| Check | Result |',
    '| --- | --- |',
    ...checks.map((c) => `| ${c.name} | ${c.ok ? 'PASS' : 'FAIL'} |`),
    '',
    `Edges per snapshot: ${edgeCounts.join(', ')}. Total D: ${totalD.join(', ')}.`,
    `Hires: ${decisions.length} (${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(', ')}). Replay: ${replay}`,
    `Outside service: ${sold.length} sold, ${refused.length} refused.${sold[0] ? ` First sale: ${EXPLORER}/${sold[0].tx_hash}` : ''}`,
    `Transactions: ${txs.length}, failed ${failedTx.length}.`,
    `Art changed for spores: ${changed.join(', ') || 'none'}.`,
    `Ledger: ${JSON.stringify(last.ledger)}`,
    '',
    '| Method | Calls | OK | Avg Tgas | Max Tgas |',
    '| --- | --- | --- | --- | --- |',
    ...Object.entries(out.tx.gas_tgas).map(([m, g]: any) => `| ${m} | ${g.calls} | ${g.ok} | ${g.avg} | ${g.max} |`),
    '',
    ...(Object.keys(errors).length ? ['Failed calls:', '', ...Object.entries(errors).map(([k, v]) => `- ${v} x ${k}`), ''] : []),
    ...(sale.scheduled
      ? [
          `Sale at epoch ${sale.epoch}: spore ${sale.spore} from ${sale.seller} to ${sale.buyer} for ${sale.price} yocto. List ${EXPLORER}/${sale.list}, buy ${EXPLORER}/${sale.buy}.`,
          `Payouts: seller ${JSON.stringify(sale.payouts?.seller)}, royalty to ${sale.royalty_account} ${JSON.stringify(sale.payouts?.royalty)}.`,
          `Before/after (block-precise): ${JSON.stringify(sale.before)} / ${JSON.stringify(sale.after)}; escrow refunded to the spore ${sale.refunds_to_spore}.`,
          `Old operator key: ${EXPLORER}/${sale.old_key_tx}; old owner withdraw: ${EXPLORER}/${sale.old_owner_tx}; register operator2 ${EXPLORER}/${sale.register}; new policy ${EXPLORER}/${sale.policy}. Transactions by the resumed agent: ${sale.resumed_txs}.`,
          ...(sale.error ? [`Sale error: ${sale.error}`] : []),
          '',
        ]
      : []),
    ...(phase5 ? [`Image commits: ${commits.length} (${commits.filter((t) => t.ok).length} ok).`, '', '```', verifyEpochs?.out ?? '', verifyImage?.out ?? '', '```'] : []),
  ];
  writeFileSync(join(runDir, 'report.md'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  return checks.every((c) => c.ok);
}

main().catch((e) => {
  console.error(e);
  for (const p of children.values()) p.kill('SIGTERM');
  process.exit(1);
});
