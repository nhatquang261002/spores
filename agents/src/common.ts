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
}

export function loadConfig(): RunConfig {
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
  };
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
