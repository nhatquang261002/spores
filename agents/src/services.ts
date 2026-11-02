// The three simulated services live agents sell each other (SPEC §6.1: price
// data, summarizer, classifier). Tasks are generated from the run seed, so a
// consumer can recompute the right answer and check what it was sold; hidden
// provider quality decides how often a provider gets it wrong (SPEC §6.5).
// No LLM here: task content is rule-generated in Phase 4.
import { createHash } from 'node:crypto';
import { stream } from './rules.ts';

export const SERVICES = ['price', 'summary', 'classify'] as const;
export type Service = (typeof SERVICES)[number];

/** Spore `id` provides service `id % 3`. */
export const serviceOf = (spore: number): number => spore % SERVICES.length;

const WORDS = ['spore', 'tube', 'slime', 'agent', 'near', 'price', 'path', 'food', 'mold', 'graph', 'trust', 'fee'];

// Stream tags so each use of the seed is independent.
const TAG_COST = 0xc057n;
const TAG_QUALITY = 0x9a11n;
const TAG_TASK = 0x7a5cn;
const TAG_ROLL = 0xd1ce5n;

export interface Task {
  /** Service name. */
  s: Service;
  /** Epoch, consumer, job index and attempt: the task's identity. */
  t: number;
  c: number;
  j: number;
  a: number;
  /** Input. */
  x: number[] | string | number;
}

/** A provider's private profile: cost (0.030 to 0.150 NEAR, as in sim) and quality in bps (5000 to 9800). */
export function profile(seed: bigint, spore: number): { cost: bigint; qualityBps: number } {
  const costMilli = 30n + stream([seed, BigInt(spore), TAG_COST]).below(121n);
  const qualityBps = 5_000 + Number(stream([seed, BigInt(spore), TAG_QUALITY]).below(4_801n));
  return { cost: (costMilli * 10n ** 24n) / 1_000n, qualityBps };
}

export function makeTask(seed: bigint, service: number, t: number, c: number, j: number, a: number): Task {
  const g = stream([seed, BigInt(t), BigInt(c), BigInt(j), TAG_TASK]);
  const s = SERVICES[service];
  let x: Task['x'];
  if (s === 'price') x = Array.from({ length: 7 }, () => 100 + Number(g.below(900n)));
  else if (s === 'summary') x = Array.from({ length: 12 }, () => WORDS[Number(g.below(BigInt(WORDS.length)))]).join(' ');
  else x = 2 + Number(g.below(9_998n));
  return { s, t, c, j, a, x };
}

/** Fits the router's 256-byte task limit. */
export const encodeTask = (task: Task): string => JSON.stringify(task);

export function decodeTask(text: string): Task | null {
  try {
    const t = JSON.parse(text);
    return SERVICES.includes(t.s) ? t : null;
  } catch {
    return null;
  }
}

const isPrime = (n: number) => {
  if (n < 2) return false;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
  return true;
};

/** The right answer. */
export function solve(task: Task): string {
  switch (task.s) {
    case 'price': {
      const v = [...(task.x as number[])].sort((a, b) => a - b);
      return String(v[v.length >> 1]);
    }
    case 'summary': {
      const counts = new Map<string, number>();
      for (const w of (task.x as string).split(' ')) counts.set(w, (counts.get(w) ?? 0) + 1);
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 3)
        .map(([w]) => w)
        .join(',');
    }
    case 'classify': {
      const n = task.x as number;
      return isPrime(n) ? 'prime' : n % 2 === 0 ? 'even' : 'odd';
    }
  }
}

/** What a provider of the given quality delivers for a job: right with probability quality. */
export function deliver(seed: bigint, jobId: number, task: Task, qualityBps: number): { answer: string; correct: boolean } {
  const right = solve(task);
  const correct = Number(stream([seed, BigInt(jobId), TAG_ROLL]).below(10_000n)) < qualityBps;
  return { answer: correct ? right : `wrong:${right.length}`, correct };
}

export const resultHash = (body: string): string => `sha256:${createHash('sha256').update(body).digest('hex')}`;
