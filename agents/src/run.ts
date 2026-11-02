// One command for a live run: starts the outside service, the keeper and one
// agent process per spore against the router on testnet, fires the scripted
// shocks, and when the keeper has closed the requested epochs stops
// everything, renders every spore after every close and checks the Phase 4
// exit criteria. Writes everything to out/agents/<run>/ and exits non-zero if
// a check fails.
//
//   node src/run.ts --spores 0-8 --epochs 8 --seed 1 [--run NAME] [--shocks raise@4,cut@5,kill@6]
//
// Shock epochs count from the epoch the run starts in. Targets follow sim:
// kill the best-value provider (quality per cost), raise the runner-up's cost
// threefold, cut the strongest tube among the run's spores.
// Reads keys from the repo's .env; never prints them.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendJsonl, ensureDir, sleep, writeControl } from './common.ts';
import { EXPLORER, view } from './near.ts';
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
const router = process.env.ROUTER ?? dotenv.PHASE4_ROUTER_ACCOUNT_ID ?? dotenv.ROUTER_ACCOUNT_ID;
const runDir = join(ROOT, 'out/agents', runName);
ensureDir(runDir);
writeControl(runDir, { killed: [], raise: {}, cut: [] });
const EVENTS = join(runDir, 'events.jsonl');

const childEnv = {
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

async function main() {
  console.log(`run ${runName}: router ${router}, spores ${spores.join(',')}, ${epochs} epochs, seed ${seed}, shocks ${shockSpec || 'none'}`);
  sh('cargo', ['build', '--release', '-q', '-p', 'spores-renderer', '-p', 'spores-sim']);
  const config = await view(router, 'config');
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
      console.log(`epoch ${info.epoch}: shock ${s.kind}`);
    }
  }
  for (const p of children.values()) p.kill('SIGTERM');
  await sleep(1_000);
  const ok = report();
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

function report(): boolean {
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
    checks,
  };
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(out, null, 2));

  const lines = [
    `# Phase 4 live run ${runName}`,
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
    ...(Object.keys(errors).length ? ['Failed calls:', '', ...Object.entries(errors).map(([k, v]) => `- ${v} x ${k}`)] : []),
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
