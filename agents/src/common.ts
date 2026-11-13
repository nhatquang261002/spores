// Shared run configuration, control file and logs for the agent processes.
// Everything comes from environment variables set by run.ts (keys are read
// from the git-ignored .env by the caller and never logged).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export interface RunConfig {
  runDir: string;
  router: string;
  seed: bigint;
  /** Active spores taking part, ascending. */
  spores: number[];
  operatorId: string;
  jobsPerEpoch: number;
  attempts: number;
  quoteWaitMs: number;
  pollMs: number;
  outsideUrl: string;
  /** Each spore buys from the outside service every `buyEvery` epochs (0 = never). */
  buyEvery: number;
  /**
   * 0: every provider of the service quotes on every job (Phase 4 and 5).
   * k > 0 (Phase 6, 64 active): only the consumer's tube neighbours and k
   * seeded picks among the other providers quote, at most MAX_QUOTES in all.
   */
  quoteFanout: number;
  /** Agents re-read their spore's summary (control, policy) every this many polls, and at each new epoch. */
  controlEvery: number;
  /** Each spore posts its jobs every this many epochs, staggered by id (1 = every epoch). */
  postEvery: number;
}

/**
 * Under `auto.ts`: when the supervisor is gone (killed, not stopped), exit too.
 * A keeper left running with no agents closes idle epochs, and every close
 * decays every edge by 25%: 28 of them emptied router4's graph on 2026-11-12.
 */
function exitWithSupervisor() {
  const parent = Number(process.env.AUTO_PARENT_PID);
  if (!parent) return;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      process.exit(0);
    }
  }, 3_000).unref();
}

export function loadConfig(): RunConfig {
  exitWithSupervisor();
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  return {
    runDir: need('RUN_DIR'),
    router: need('ROUTER'),
    seed: BigInt(process.env.SEED ?? '1'),
    spores: need('SPORES').split(',').map(Number).sort((a, b) => a - b),
    operatorId: need('OPERATOR_ACCOUNT_ID'),
    jobsPerEpoch: Number(process.env.JOBS_PER_EPOCH ?? 1),
    attempts: Number(process.env.ATTEMPTS ?? 2),
    quoteWaitMs: Number(process.env.QUOTE_WAIT_MS ?? 8_000),
    pollMs: Number(process.env.POLL_MS ?? 2_500),
    outsideUrl: process.env.OUTSIDE_URL ?? 'http://127.0.0.1:8787',
    buyEvery: Number(process.env.BUY_EVERY ?? 3),
    quoteFanout: Number(process.env.QUOTE_FANOUT ?? 0),
    controlEvery: Number(process.env.CONTROL_EVERY ?? 5),
    postEvery: Math.max(1, Number(process.env.POST_EVERY ?? 1)),
  };
}

/** `0-8,12` -> [0..8, 12]. */
export function parseIds(s: string): number[] {
  return s.split(',').filter(Boolean).flatMap((part) => {
    const [a, b] = part.split('-').map(Number);
    return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, k) => a + k);
  });
}

/**
 * A key from the environment under the first of KEY_PREFIX's comma-separated
 * prefixes that has it (`P6_,P5_`: Phase 6 keys first, then Phase 5 ones).
 */
export function envKey(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  for (const p of (env.KEY_PREFIX ?? '').split(',')) {
    const v = env[`${p.trim()}${name}`];
    if (v) return v;
  }
  return undefined;
}

/** Scripted shocks (SPEC §6.6), written by shock.ts and read by every agent each loop. */
export interface Control {
  killed: number[];
  /** Spore id -> cost multiplier in bps (30000 = triple). */
  raise: Record<string, number>;
  /** Pairs that stop trading with each other. */
  cut: [number, number][];
}

export const controlPath = (runDir: string) => join(runDir, 'control.json');

export function readControl(runDir: string): Control {
  const p = controlPath(runDir);
  if (!existsSync(p)) return { killed: [], raise: {}, cut: [] };
  try {
    return { killed: [], raise: {}, cut: [], ...JSON.parse(readFileSync(p, 'utf8')) };
  } catch {
    return { killed: [], raise: {}, cut: [] };
  }
}

export function writeControl(runDir: string, c: Control) {
  const p = controlPath(runDir);
  writeFileSync(p + '.tmp', JSON.stringify(c, null, 2));
  renameSync(p + '.tmp', p);
}

export const isCut = (c: Control, a: number, b: number) => c.cut.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

/** Appends one JSON line; lines are small, so concurrent O_APPEND writers do not interleave. */
export function appendJsonl(file: string, entry: object) {
  appendFileSync(file, JSON.stringify(entry, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');
}

export function ensureDir(p: string) {
  mkdirSync(p, { recursive: true });
}

export const nowNs = () => BigInt(Date.now()) * 1_000_000n;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True if some tube between `ids` is thicker in a snapshot than in the one before it. D only moves at a close. */
export function tubesGrew(snaps: { edges: [number, number, string | number][] }[], ids: number[]): boolean {
  const mine = (s: { edges: [number, number, string | number][] }) => new Map(s.edges.filter(([a, b]) => ids.includes(a) && ids.includes(b)).map(([a, b, d]) => [`${a}-${b}`, BigInt(d)]));
  return snaps.slice(1).some((s, i) => {
    const before = mine(snaps[i]);
    return [...mine(s)].some(([k, d]) => d > (before.get(k) ?? 0n));
  });
}
