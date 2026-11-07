// One command for a live run: starts the outside service, the keeper and one
// agent process per spore against the router on testnet, fires the scripted
// shocks, and when the keeper has closed the requested epochs stops
// everything, renders every spore after every close and checks the Phase 4
// exit criteria. Writes everything to out/agents/<run>/ and exits non-zero if
// a check fails.
//
//   node src/run.ts --spores 0-8 --epochs 8 --seed 1 [--run NAME] [--shocks raise@4,cut@5,kill@6,sale@3] [--sale-spore N] [--per-process N]
//
// --per-process N runs N spores in each agent process (Phase 6: one process
// for 64 spores shares its RPC reads); the default 1 is one process per spore.
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
// the router and checks the sold spore's committed image. The spore is picked
// when the run starts and named in run.json (`sale_spore`), so the app can
// follow it from the first line, and the sale's own lines go to scene.jsonl.
// Reads keys from the repo's .env; never prints them.
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { cpus } from 'node:os';
import { promisify } from 'node:util';
import { appendFileSync, createWriteStream, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nearToYocto } from 'near-api-js';
import { appendJsonl, ensureDir, envKey, parseIds, sleep, tubesGrew, writeControl } from './common.ts';
import { balanceOf, Caller, chainTimeNs, EXPLORER, rpc, txStatus, view } from './near.ts';
import { newOwnerPolicy, runSale, type SaleChain, type SaleRole } from './scenes/sale.ts';
import { profile } from './services.ts';
import { applyShock } from './shock.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
// Refuse anything unknown (`--help` once started a real run on the default router).
const KNOWN = ['spores', 'epochs', 'seed', 'run', 'shocks', 'sale-spore', 'per-process'];
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith('--') || !KNOWN.includes(args[i].slice(2)) || args[i + 1] === undefined) {
    console.error(`usage: node src/run.ts ${KNOWN.map((k) => `[--${k} V]`).join(' ')} (ROUTER from the environment)`);
    process.exit(2);
  }
}
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

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
const perProcess = Math.max(1, Number(opt('per-process', '1')));
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

async function saleSpore(targets: { star: number; runnerUp: number }): Promise<number> {
  if (saleSporeOpt) return Number(saleSporeOpt);
  let best = -1;
  let bestRep = -1n;
  for (const id of spores) {
    if (id === targets.star || id === targets.runnerUp) continue;
    const s = await view(router, 'spore_summary', { spore_id: id });
    // Only the seller's own spore can be sold (spore 5 on router4 went to the buyer in Phase 5).
    if (s.owner_id !== dotenv.OWNER_ACCOUNT_ID) continue;
    const r = BigInt(s.reputation);
    if (r > bestRep) [best, bestRep] = [id, r];
  }
  if (best < 0) throw new Error(`none of spores ${spores.join(',')} can be sold: ${dotenv.OWNER_ACCOUNT_ID} owns none outside the shock targets`);
  return best;
}

/** The sale itself is `scenes/sale.ts`; here it runs among live agents, so the old one is stopped and a new one started. */
async function runSaleShock(X: number) {
  sale.spore = X;
  console.log(`sale: spore ${X} to ${dotenv.BUYER_ACCOUNT_ID} for ${SALE_PRICE} yocto`);
  const callers: Record<SaleRole, Caller | null> = {
    seller: new Caller(dotenv.OWNER_ACCOUNT_ID, dotenv.OWNER_PRIVATE_KEY, router),
    buyer: new Caller(dotenv.BUYER_ACCOUNT_ID, dotenv.BUYER_PRIVATE_KEY, router),
    agent: new Caller(dotenv.OPERATOR_ACCOUNT_ID, envKey(`SPORE_${X}_FC_PRIVATE_KEY`, { ...dotenv, KEY_PREFIX: process.env.KEY_PREFIX })!, router),
    'new agent': null,
    keeper: null,
  };
  const chain: SaleChain = {
    view: (method, a = {}, block) => view(router, method, a, block),
    call: (role, method, a, deposit = 0n, gas) => callers[role]!.call(method, a, deposit, gas),
    timeNs: chainTimeNs,
    status: txStatus,
    prevBlock: async (hash) => (await rpc('block', { block_id: hash })).result.header.prev_hash,
    balanceOf,
  };
  const steps = new Map<string, string>();
  const SCENE = join(runDir, 'scene.jsonl');
  const started = Date.now();
  let seq = 0;
  const sceneLine = (e: object) => appendFileSync(SCENE, JSON.stringify({ seq: ++seq, at: new Date().toISOString(), t: Date.now() - started, ...e }) + '\n');
  let exitCode = 1;
  try {
    const rec = await runSale(
    chain,
    (e: any) => {
      sceneLine(e);
      if (e.type === 'step') steps.set(e.id, e.action);
      if (e.type === 'result') {
        saleNote('tx', { step: steps.get(e.id), method: e.method, hash: e.tx, ok: e.ok, err: e.err || undefined, gas_tgas: e.gas_tgas });
        console.log(`sale: ${steps.get(e.id)} ${e.ok ? 'ok' : 'FAILED'} ${e.tx}${e.ok ? '' : ` ${e.err}`}`);
      }
      if (e.type === 'check' && !e.ok) console.log(`sale: check ${e.name} failed: expected ${e.expected}, got ${e.actual}`);
    },
    {
      run: runName,
      router,
      spore: X,
      price: SALE_PRICE,
      buyer: dotenv.BUYER_ACCOUNT_ID,
      newOperator: dotenv.OPERATOR2_ACCOUNT_ID,
      newPolicy: newOwnerPolicy(dotenv.OUTSIDE_ACCOUNT_ID),
      probeAgent: false,
      clearStale: false,
      // The old agent notices it lost control; only then are its key and the old owner tried.
      afterSold: async (r) => {
        for (let i = 0; i < 10 && !readJsonl(EVENTS).some((e) => e.spore === X && e.kind === 'idle' && e.at > r.at!); i++) await sleep(2_000);
        sale.old_agent_idle = readJsonl(EVENTS).some((e) => e.spore === X && e.kind === 'idle' && e.at > r.at!);
        children.get(`agent-${X}`)?.kill('SIGTERM');
        await sleep(1_500);
      },
      onResume: () => {
        start(`agent-${X}-operator2`, join(ROOT, 'agents/src/agent.ts'), { SPORE_ID: String(X), AGENT_OPERATOR_ACCOUNT_ID: dotenv.OPERATOR2_ACCOUNT_ID, AGENT_FC_PRIVATE_KEY: dotenv.P5_OPERATOR2_FC_PRIVATE_KEY });
      },
    },
    );
    Object.assign(sale, rec);
    exitCode = rec.ok ? 0 : 1;
  } finally {
    // Like the scene server's: "completed" needs a real exit line.
    sceneLine({ type: 'exit', code: exitCode });
  }
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
  const saleX = /(^|,)sale@/.test(shockSpec) ? await saleSpore(targets) : null;
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({ run: runName, router, spores, epochs, seed, shocks: shockSpec, start_epoch: startInfo.epoch, shock_targets: targets, sale_spore: saleX, config, profiles: Object.fromEntries(spores.map((id) => [id, profile(BigInt(seed), id)])) }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );

  start('outside', join(ROOT, 'outside/src/server.ts'));
  await sleep(1_000);
  start('keeper', join(ROOT, 'agents/src/keeper.ts'));
  if (perProcess === 1) for (const id of spores) start(`agent-${id}`, join(ROOT, 'agents/src/agent.ts'), { SPORE_ID: String(id) });
  else
    for (let i = 0; i < spores.length; i += perProcess) {
      const group = spores.slice(i, i + perProcess);
      start(`agents-${group[0]}-${group[group.length - 1]}`, join(ROOT, 'agents/src/agent.ts'), { SPORE_IDS: group.join(',') });
    }

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
          await runSaleShock(saleX!);
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
  const ok = await report(phase5);
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

/**
 * The router's committed close list, then every run directory's events.jsonl for
 * this router, oldest run first: verify needs every close since epoch 1, and a
 * clean checkout has no earlier runs in out/. `spores-verify` drops duplicates.
 */
function routerEventFiles(): string[] {
  const base = join(ROOT, 'out/agents');
  const name = /router\d*/.exec(router)?.[0];
  const list = name ? join(ROOT, 'docs', `${name}-closes.txt`) : '';
  return [
    ...(list && existsSync(list) ? [list] : []),
    ...readdirSync(base)
      .filter((d) => existsSync(join(base, d, 'run.json')) && existsSync(join(base, d, 'events.jsonl')))
      .filter((d) => JSON.parse(readFileSync(join(base, d, 'run.json'), 'utf8')).router === router)
      .sort()
      .map((d) => join(base, d, 'events.jsonl')),
  ];
}

function runVerify(argv: string[]): { ok: boolean; out: string } {
  // Old close transactions may only be on the archival node.
  const rpcs = process.env.NEAR_RPCS;
  if (rpcs && !rpcs.includes('archival')) process.env.NEAR_RPCS = `${rpcs},https://archival-rpc.testnet.near.org`;
  try {
    return { ok: true, out: sh(join(ROOT, 'target/release/spores-verify'), argv).trim() };
  } catch (e: any) {
    return { ok: false, out: `${String(e.stdout ?? '').trim()}\n${String(e.stderr ?? e.message).trim()}`.trim() };
  }
}

async function report(phase5: boolean): Promise<boolean> {
  const snapDir = join(runDir, 'snapshots');
  const snaps = readdirSync(snapDir)
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => (a === 'start.json' ? -1 : b === 'start.json' ? 1 : a.localeCompare(b)))
    .map((f) => JSON.parse(readFileSync(join(snapDir, f), 'utf8')));
  const renderDir = join(runDir, 'renders');
  ensureDir(renderDir);
  const renderer = join(ROOT, 'target/release/spores-render');
  const hashes: Record<string, Record<string, string>> = {};
  // One renderer process per core: at 64 spores a report renders hundreds of images.
  const todo = snaps.flatMap((s) => spores.map((id) => ({ label: s.label, id, input: s.spores[id].render_input })));
  for (const s of snaps) hashes[s.label] = {};
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(cpus().length, todo.length) }, async () => {
      while (next < todo.length) {
        const t = todo[next++];
        const input = join(renderDir, `${t.label}-spore-${t.id}.json`);
        writeFileSync(input, JSON.stringify(t.input));
        const { stdout } = await execFileAsync(renderer, ['state', input, join(renderDir, `${t.label}-spore-${t.id}.png`)], { encoding: 'utf8' });
        hashes[t.label][t.id] = stdout.match(/image_hash ([0-9a-f]+)/)![1];
      }
    }),
  );
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
  // Each close: when it landed, seconds since the previous one, gas, log bytes, pairs named.
  const closes = events.filter((e) => e.spore === 'keeper' && e.kind === 'tx' && e.method === 'close_epoch' && e.ok);
  const closeStats = closes.map((c, i) => ({
    epoch: c.closed, at: c.at, secs: i ? Math.round((Date.parse(c.at) - Date.parse(closes[i - 1].at)) / 100) / 10 : null,
    gas_tgas: c.gas_tgas, log_bytes: c.log_bytes, active: c.active, pairs: c.pairs, hash: c.hash,
  }));
  // RPC requests per epoch, summed over the agent processes and the keeper.
  const rpcByEpoch: Record<string, { requests: number; limited: number }> = {};
  for (const e of events.filter((e) => e.kind === 'rpc' && !e.final)) {
    const r = (rpcByEpoch[e.epoch] ??= { requests: 0, limited: 0 });
    r.requests += e.requests;
    r.limited += e.limited;
  }
  const errors: Record<string, number> = {};
  for (const t of failedTx) {
    const k = `${t.method}: ${String(t.err).replace(/^Smart contract panicked: /, '').slice(0, 80)}`;
    errors[k] = (errors[k] ?? 0) + 1;
  }

  const checks = [
    { name: `agents traded unattended for ${snaps.length - 1} epochs`, ok: snaps.length - 1 >= epochs && (outcomes.settled ?? 0) > 0 },
    // Between the run's own spores: on a router with older tubes elsewhere, the total can fall while this run forms new ones (S13).
    { name: 'tubes formed: a tube between the run\'s spores was born or grew at a close', ok: tubesGrew(snaps, spores) },
    { name: 'the rendered art changed between epochs', ok: changed.length > 0 },
    { name: 'every logged hire matches spores_core::hiring::pick', ok: replayOk && decisions.length > 0 },
    { name: 'ledger conserved at the end', ok: last.ledger.conserved === true },
    { name: 'outside service sold at least one item against an on-chain receipt', ok: sold.length > 0 },
  ];
  let verifyEpochs: { ok: boolean; out: string } | null = null;
  let verifyImage: { ok: boolean; out: string } | null = null;
  const commits = txs.filter((t) => t.method === 'commit_image');
  // Commits the next close made stale (the keeper does not hold a close for them).
  const skippedCommits = events.filter((e) => e.kind === 'skip' && e.method === 'commit_image');
  if (phase5) {
    const files = routerEventFiles();
    verifyEpochs = runVerify(['epochs', '--router', router, '--closes', ...files]);
    checks.push({ name: 'the keeper committed an image for every active spore after each close, or logged it as skipped', ok: commits.length > 0 && commits.every((t) => t.ok) && commits.length + skippedCommits.length >= (snaps.length - 1) * spores.length });
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
    image_commits: { total: commits.length, ok: commits.filter((t) => t.ok).length, skipped: skippedCommits.length },
    closes: closeStats,
    rpc_per_epoch: rpcByEpoch,
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
    '| Closed epoch | Seconds since previous close | Active | Pairs | Gas (Tgas) | Log bytes | RPC requests in epoch (rate-limited) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...closeStats.map((c) => `| ${c.epoch} | ${c.secs ?? '-'} | ${c.active ?? '-'} | ${c.pairs ?? '-'} | ${c.gas_tgas} | ${c.log_bytes ?? '-'} | ${rpcByEpoch[c.epoch] ? `${rpcByEpoch[c.epoch].requests} (${rpcByEpoch[c.epoch].limited})` : '-'} |`),
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
    ...(phase5 ? [`Image commits: ${commits.length} (${commits.filter((t) => t.ok).length} ok, ${skippedCommits.length} skipped because the next close came first).`, '', '```', verifyEpochs?.out ?? '', verifyImage?.out ?? '', '```'] : []),
  ];
  writeFileSync(join(runDir, 'report.md'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  return checks.every((c) => c.ok);
}

// A stop from outside (Ctrl-C in scripts/demo.sh) takes the agents and the keeper with it.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const p of children.values()) p.kill('SIGTERM');
    process.exit(130);
  });
}

main().catch((e) => {
  console.error(e);
  for (const p of children.values()) p.kill('SIGTERM');
  process.exit(1);
});
