// Keeps the router's epochs closing and the agents trading, with no one watching.
// `run.ts` is one finite run with exit checks; this is the open-ended version of
// the same processes (outside service, keeper, agents) under a supervisor:
//
//   node agents/src/auto.ts [--spores 12] [--cycle-hours 6] [--min-keeper-near 1] [--min-free-gb 1]
//
// Every cycle it re-runs `demo-prep.ts` (picks the spores, tops up any below the
// floor), starts the processes in a fresh `out/agents/auto-<time>/`, restarts one
// that dies, and after --cycle-hours stops them and starts the next cycle.
// It stops everything and exits 1 (so no more gas is burned) when:
//   - the keeper account is below --min-keeper-near,
//   - the disk has less than --min-free-gb free,
//   - a process keeps dying (more than 5 restarts in 10 minutes).
// State for `scripts/auto.sh status`: out/auto/status.json. Log: out/auto/auto.log.
// Keys come from .env and are never printed. Testnet only: ROUTER is PHASE5_ROUTER_ACCOUNT_ID (router5 since 2026-11-13).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, readdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { appendJsonl, ensureDir, parseIds, writeControl } from './common.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const KNOWN = ['spores', 'cycle-hours', 'min-keeper-near', 'min-free-gb'];
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith('--') || !KNOWN.includes(args[i].slice(2)) || args[i + 1] === undefined) {
    console.error(`usage: node src/auto.ts ${KNOWN.map((k) => `[--${k} V]`).join(' ')}`);
    process.exit(2);
  }
}
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const sporeCount = Number(opt('spores', '12'));
const cycleMs = Number(opt('cycle-hours', '6')) * 3_600_000;
const minKeeperYocto = BigInt(Math.round(Number(opt('min-keeper-near', '1')) * 1000)) * 10n ** 21n;
const minFreeBytes = Number(opt('min-free-gb', '1')) * 2 ** 30;
if (![sporeCount, cycleMs, Number(opt('min-keeper-near', '1')), minFreeBytes].every((n) => Number.isFinite(n) && n > 0)) {
  console.error('every option must be a positive number');
  process.exit(2);
}

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  // No .env (a container keeps its keys as environment variables): the environment is the source.
  if (!existsSync(join(ROOT, '.env'))) return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const dotenv = loadEnv();
const router = dotenv.PHASE5_ROUTER_ACCOUNT_ID;
const keeperId = dotenv.KEEPER_ACCOUNT_ID ?? dotenv.DEPLOYER_ACCOUNT_ID;
if (!router || !keeperId) throw new Error('.env needs PHASE5_ROUTER_ACCOUNT_ID and a keeper (or deployer) account: run scripts/phase6-setup.sh');
if (!router.endsWith('.testnet')) throw new Error(`refusing ${router}: testnet only`);

// The same settings `scripts/demo.sh` runs with. Set before near.ts is imported: it reads NEAR_RPCS once.
const runEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  ...dotenv,
  ROUTER: router,
  KEY_PREFIX: 'P7_', // router5's keys (P6_/P5_ target router4)
  NEAR_RPCS: process.env.NEAR_RPCS ?? 'https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://testnet-rpc.intea.rs',
  QUOTE_FANOUT: process.env.QUOTE_FANOUT ?? '3',
  RPC_CONCURRENCY: process.env.RPC_CONCURRENCY ?? '8',
  CONTROL_EVERY: process.env.CONTROL_EVERY ?? '1000',
  POST_EVERY: process.env.POST_EVERY ?? '1',
  BUY_EVERY: process.env.BUY_EVERY ?? '4',
  JOBS_PER_EPOCH: process.env.JOBS_PER_EPOCH ?? '1',
  POLL_MS: process.env.POLL_MS ?? '3000',
  SEED: '1',
  EPOCHS: '1000000000', // the keeper exits after EPOCHS closes: effectively never
  KEEPER_ACCOUNT_ID: keeperId,
  AUTO_PARENT_PID: String(process.pid), // children exit when this process is gone (common.ts)
};
process.env.NEAR_RPCS = runEnv.NEAR_RPCS;
const { balanceOf, view } = await import('./near.ts');

const AUTO = join(ROOT, 'out/auto');
ensureDir(AUTO);
const LOG = join(AUTO, 'auto.log');
const say = (msg: string) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const near = (y: bigint | null) => (y == null ? 'unknown' : (Number(y / 10n ** 20n) / 10_000).toFixed(4));

let stopping = false;
let children = new Map<string, { p: ChildProcess; script: string; extra: Record<string, string>; log: string }>();
let restarts: number[] = [];

function start(runDir: string, name: string, script: string, extra: Record<string, string> = {}) {
  const log = join(runDir, `${name}.log`);
  const out = createWriteStream(log, { flags: 'a' });
  const p = spawn(process.execPath, [script], { env: { ...runEnv, ...extra, RUN_DIR: runDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  children.set(name, { p, script, extra, log });
  return p;
}

async function stopAll() {
  for (const { p } of children.values()) if (p.exitCode == null) p.kill('SIGTERM');
  for (let i = 0; i < 20 && [...children.values()].some(({ p }) => p.exitCode == null); i++) await sleep(500);
  for (const { p } of children.values()) if (p.exitCode == null) p.kill('SIGKILL');
  children = new Map();
}

function pruneOldRuns(keep = 3) {
  const dirs = readdirSync(join(ROOT, 'out/agents')).filter((d) => d.startsWith('auto-')).sort();
  for (const d of dirs.slice(0, Math.max(0, dirs.length - keep))) rmSync(join(ROOT, 'out/agents', d), { recursive: true, force: true });
}

async function guard(): Promise<string | null> {
  const keeper = await balanceOf(keeperId!).catch(() => null);
  if (keeper != null && keeper < minKeeperYocto) return `keeper ${keeperId} is down to ${near(keeper)} NEAR (floor ${near(minKeeperYocto)})`;
  const fs = statfsSync(ROOT);
  if (fs.bavail * fs.bsize < minFreeBytes) return `disk has ${(fs.bavail * fs.bsize / 2 ** 30).toFixed(2)} GiB free (floor ${(minFreeBytes / 2 ** 30).toFixed(2)})`;
  return null;
}

/** The first port from `from` that nothing listens on, tested the way `outside` listens (all interfaces). */
function freePort(from: number): Promise<number> {
  return new Promise((resolvePort) => {
    const probe = (port: number) => {
      const s = createServer();
      s.once('error', () => probe(port + 1));
      s.once('listening', () => s.close(() => resolvePort(port)));
      s.listen(port);
    };
    probe(from);
  });
}

async function cycle(): Promise<string | null> {
  const { stdout } = await execFileAsync(process.execPath, [join(ROOT, 'agents/src/demo-prep.ts'), '--spores', String(sporeCount)], { env: runEnv, cwd: ROOT, timeout: 600_000 }).catch((e) => {
    throw new Error(`demo-prep failed: ${String(e.stderr ?? e.message).trim().split('\n').slice(-3).join(' | ')}`);
  });
  const plan = JSON.parse(stdout.trim().split('\n').pop()!);
  const spores = parseIds(String(plan.spores));
  const runName = `auto-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = join(ROOT, 'out/agents', runName);
  ensureDir(runDir);
  writeControl(runDir, { killed: [], raise: {}, cut: [] });
  runEnv.SPORES = spores.join(',');
  runEnv.OUTSIDE_LOG = join(runDir, 'outside.jsonl');
  // 8787 is often taken (another project held it on 2026-11-12 and `outside` died 5 times): take the first free port.
  const port = await freePort(8787);
  runEnv.PORT = String(port);
  runEnv.OUTSIDE_URL = `http://127.0.0.1:${port}`;
  const events = join(runDir, 'events.jsonl');
  const startInfo = await view(router!, 'epoch_info');
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ run: runName, router, spores, epochs: null, seed: '1', shocks: '', start_epoch: startInfo.epoch, auto: true }, null, 2));
  say(`cycle ${runName}: spores ${spores.join(',')}, router ${router}, starting at epoch ${startInfo.epoch}`);

  start(runDir, 'outside', join(ROOT, 'outside/src/server.ts'));
  await sleep(1_000);
  start(runDir, 'keeper', join(ROOT, 'agents/src/keeper.ts'));
  start(runDir, `agents-${spores[0]}-${spores[spores.length - 1]}`, join(ROOT, 'agents/src/agent.ts'), { SPORE_IDS: spores.join(',') });

  const until = Date.now() + cycleMs;
  while (Date.now() < until && !stopping) {
    await sleep(30_000);
    const why = await guard();
    if (why) return why;
    for (const [name, c] of children) {
      if (c.p.exitCode == null) continue;
      const now = Date.now();
      restarts = restarts.filter((t) => now - t < 600_000);
      if (restarts.length >= 5) return `${name} keeps dying (exit ${c.p.exitCode}); last log lines in ${c.log}`;
      restarts.push(now);
      say(`${name} exited with ${c.p.exitCode}; restarting (${restarts.length} in the last 10 min)`);
      appendJsonl(events, { at: new Date().toISOString(), spore: 'auto', kind: 'restart', name, code: c.p.exitCode });
      start(runDir, name, c.script, c.extra);
      await sleep(2_000);
    }
    let epoch: number | null = null;
    let lateS: number | null = null;
    try {
      const info = await view(router!, 'epoch_info');
      epoch = info.epoch;
      lateS = Math.max(0, Math.round((Date.now() * 1e6 - Number(info.ends_ns)) / 1e9));
      if (lateS > 180) say(`epoch ${epoch} ended ${lateS} s ago and no close has landed`);
    } catch {
      /* RPC blip: the next tick looks again */
    }
    writeFileSync(
      join(AUTO, 'status.json'),
      JSON.stringify({ pid: process.pid, run: runName, router, spores, epoch, seconds_past_end: lateS, keeper_near: near(await balanceOf(keeperId!).catch(() => null)), restarts_10min: restarts.length, cycle_ends: new Date(until).toISOString(), at: new Date().toISOString() }, null, 2),
    );
  }
  await stopAll();
  return null;
}

async function main() {
  const quit = () => {
    stopping = true;
    say('stop requested');
  };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
  say(`auto started: router ${router}, ${sporeCount} spores, cycles of ${cycleMs / 3_600_000} h, floors ${near(minKeeperYocto)} NEAR / ${(minFreeBytes / 2 ** 30).toFixed(2)} GiB`);
  // On a platform that restarts crashed workers, exiting would just restart into the same stop:
  // AUTO_HOLD_ON_STOP=1 idles instead, spends nothing, and resumes once the floors are met again.
  const hold = process.env.AUTO_HOLD_ON_STOP === '1';
  const holdUntilFit = async (why: string) => {
    say(`HOLDING, no gas is being spent: ${why}. Looking again every 10 min`);
    while (!stopping) {
      await sleep(600_000);
      if (!(await guard().catch((e) => String(e)))) return say('floors met again, resuming');
    }
  };
  let code = 0;
  const early = await guard();
  if (early) {
    if (!hold) throw new Error(early);
    await holdUntilFit(early);
  }
  while (!stopping) {
    try {
      const why = await cycle();
      if (why) {
        await stopAll();
        if (hold) {
          await holdUntilFit(why);
          continue;
        }
        say(`STOPPING, no more gas will be spent: ${why}`);
        code = 1;
        break;
      }
      pruneOldRuns();
    } catch (e) {
      await stopAll();
      if (hold) {
        await holdUntilFit(`cycle failed (${(e as Error).message})`);
        continue;
      }
      say(`STOPPING: ${(e as Error).message}`);
      code = 1;
      break;
    }
  }
  await stopAll();
  say('auto stopped');
  process.exit(code);
}
main();
