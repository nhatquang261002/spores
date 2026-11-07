// Every step of the network, from a run log (Reference C `events.jsonl`, with
// `decisions.jsonl` to link posts to job ids): an agent wakes, a consumer
// posts a job, providers quote, the consumer hires one, the provider
// delivers, the consumer settles (pays) or rejects, the keeper closes the
// epoch. Each step is a logged transaction with its final outcome; nothing is
// inferred except the links between a job's steps (by job id) and the epoch a
// step fell in (by log time between the keeper's close lines).
import { pairKey, type PairKey } from './network';

export type StepKind =
  | 'wake'
  | 'post'
  | 'quote'
  | 'hire'
  | 'deliver'
  | 'settle'
  | 'reject'
  | 'timeout'
  | 'outside'
  | 'close'
  | 'commit'
  | 'failed';

export interface Step {
  /** ms since the first logged line. */
  t: number;
  /** Wall-clock ms of the log line. */
  at: number;
  /** The epoch in progress when it was logged. */
  epoch: number;
  kind: StepKind;
  /** Where the step starts (the spore that sent the tx, or the job's payer). */
  from: number | null;
  /** Where it goes: a spore, or null (self, the outside service, the whole ring). */
  to: number | null;
  job?: number;
  /** yocto */
  amount?: string;
  service?: string;
  /** The epoch a close closed. */
  closed?: number;
  /** Failed tx: the method and the contract's error, verbatim. */
  method?: string;
  err?: string;
  tx: string | null;
}

export interface RawEvent {
  at: string;
  spore: number | string;
  kind: string;
  method?: string;
  args?: Record<string, any>;
  hash?: string;
  ok?: boolean;
  err?: string;
  closed?: number;
  service?: string;
}

export interface RawDecision {
  job_id: number;
  consumer: number;
  tx?: { post?: string };
}

const sporeOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

function taskService(task: unknown): string | undefined {
  if (typeof task !== 'string') return undefined;
  try {
    const s = JSON.parse(task)?.s;
    return typeof s === 'string' ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Steps in log order. `startEpoch` is `run.json`'s `start_epoch`: the epoch in
 * progress when the run began; each keeper `close_epoch` line moves it to
 * `closed + 1`.
 */
export function stepsFromRunLog(events: RawEvent[], decisions: RawDecision[], startEpoch: number): Step[] {
  const sorted = events
    .map((e, i) => ({ e, i, at: Date.parse(e.at) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at || a.i - b.i);
  if (!sorted.length) return [];

  // Links between a job's steps, from the whole log (a quote is logged before the hire that names its consumer).
  const consumer = new Map<number, number>();
  const provider = new Map<number, number>();
  const quoted = new Map<string, string>();
  const jobOfPost = new Map<string, number>();
  for (const d of decisions) {
    if (Number.isInteger(d.job_id) && Number.isInteger(d.consumer)) consumer.set(d.job_id, d.consumer);
    if (d.tx?.post) jobOfPost.set(d.tx.post, d.job_id);
  }
  for (const { e } of sorted) {
    if (e.kind !== 'tx' || !e.ok || !e.args) continue;
    const job = e.args.job_id;
    if (e.method === 'accept' && sporeOf(e.spore) !== null) {
      consumer.set(job, e.spore as number);
      provider.set(job, e.args.provider_id);
    }
    if (e.method === 'quote') quoted.set(`${job}:${e.args.spore_id}`, String(e.args.price));
  }
  const priceOf = (job: number | undefined) => {
    const p = job === undefined ? undefined : provider.get(job);
    return p === undefined ? undefined : quoted.get(`${job}:${p}`);
  };
  const consumerOf = (job: number | undefined) => (job === undefined ? null : (consumer.get(job) ?? null));
  const providerOf = (job: number | undefined) => (job === undefined ? null : (provider.get(job) ?? null));

  const t0 = sorted[0].at;
  let epoch = startEpoch;
  const out: Step[] = [];
  for (const { e, at } of sorted) {
    const base = { t: at - t0, at, epoch, tx: e.hash ?? null };
    const me = sporeOf(e.spore);
    if (e.kind === 'start' && me !== null) {
      out.push({ ...base, kind: 'wake', from: me, to: null, service: e.service });
      continue;
    }
    if (e.kind !== 'tx' || !e.method) continue;
    const a = e.args ?? {};
    const job: number | undefined = typeof a.job_id === 'number' ? a.job_id : undefined;
    if (!e.ok) {
      out.push({ ...base, kind: 'failed', from: me ?? sporeOf(a.spore_id), to: null, job, method: e.method, err: e.err ?? 'failed' });
      continue;
    }
    switch (e.method) {
      case 'post_job':
        out.push({ ...base, kind: 'post', from: me, to: null, job: e.hash ? jobOfPost.get(e.hash) : undefined, amount: a.max_price, service: taskService(a.task) });
        break;
      case 'quote':
        out.push({ ...base, kind: 'quote', from: sporeOf(a.spore_id) ?? me, to: consumerOf(job), job, amount: String(a.price) });
        break;
      case 'accept':
        out.push({ ...base, kind: 'hire', from: me, to: sporeOf(a.provider_id), job, amount: priceOf(job) });
        break;
      case 'deliver':
        out.push({ ...base, kind: 'deliver', from: me, to: consumerOf(job), job });
        break;
      case 'settle':
        out.push({ ...base, kind: 'settle', from: consumerOf(job) ?? me, to: providerOf(job), job, amount: priceOf(job) });
        break;
      case 'reject':
        out.push({ ...base, kind: 'reject', from: me, to: providerOf(job), job });
        break;
      case 'timeout_job':
        out.push({ ...base, kind: 'timeout', from: consumerOf(job), to: providerOf(job), job });
        break;
      case 'pay_service':
        out.push({ ...base, kind: 'outside', from: me ?? sporeOf(a.spore_id), to: null, amount: String(a.amount) });
        break;
      case 'commit_image':
        out.push({ ...base, kind: 'commit', from: sporeOf(a.spore_id), to: null });
        break;
      case 'close_epoch':
        if (typeof e.closed === 'number') {
          out.push({ ...base, kind: 'close', from: null, to: null, closed: e.closed });
          epoch = e.closed + 1;
        }
        break;
    }
  }
  return out;
}

/**
 * Flows per epoch from the run log's settled jobs: the router adds the
 * accepted price to the pair's flow at `settle` (router/src/jobs.rs), so this
 * is what the close event lists, as far as the log's timing puts each settle
 * in the right epoch.
 */
export function runFlows(steps: Step[]): Map<number, [number, number, string][]> {
  const byEpoch = new Map<number, Map<PairKey, { a: number; b: number; amt: bigint }>>();
  for (const s of steps) {
    if (s.kind !== 'settle' || s.from === null || s.to === null || s.amount === undefined) continue;
    const m = byEpoch.get(s.epoch) ?? byEpoch.set(s.epoch, new Map()).get(s.epoch)!;
    const k = pairKey(s.from, s.to);
    const cur = m.get(k) ?? { a: Math.min(s.from, s.to), b: Math.max(s.from, s.to), amt: 0n };
    cur.amt += BigInt(s.amount);
    m.set(k, cur);
  }
  const out = new Map<number, [number, number, string][]>();
  for (const [e, m] of byEpoch) out.set(e, [...m.values()].sort((x, y) => x.a - y.a || x.b - y.b).map((v) => [v.a, v.b, v.amt.toString()]));
  return out;
}

/** Rejected deliveries per epoch from the run log, `[a, b, count]`. */
export function runRejects(steps: Step[]): Map<number, [number, number, number][]> {
  const byEpoch = new Map<number, Map<PairKey, [number, number, number]>>();
  for (const s of steps) {
    if (s.kind !== 'reject' || s.from === null || s.to === null) continue;
    const m = byEpoch.get(s.epoch) ?? byEpoch.set(s.epoch, new Map()).get(s.epoch)!;
    const k = pairKey(s.from, s.to);
    const cur = m.get(k) ?? [Math.min(s.from, s.to), Math.max(s.from, s.to), 0];
    cur[2]++;
    m.set(k, cur);
  }
  const out = new Map<number, [number, number, number][]>();
  for (const [e, m] of byEpoch) out.set(e, [...m.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1]));
  return out;
}

// --- the loop rail and the step feed ----------------------------------------

/** The steps the loop rail names, in the loop's order. */
export const LOOP = ['wake', 'post', 'quote', 'hire', 'deliver', 'settle', 'close'] as const;
export type LoopStep = (typeof LOOP)[number];

export type StepTone = 'agent' | 'value' | 'growth' | 'warn' | 'muted' | 'slime';

/** Glyph, word and semantic colour of each step (Design §3.1.2: never colour alone). */
export const STEP_MARKS: Record<StepKind, { glyph: string; word: string; tone: StepTone }> = {
  wake: { glyph: '◌', word: 'Wake', tone: 'agent' },
  post: { glyph: '◆', word: 'Post', tone: 'agent' },
  quote: { glyph: '◆', word: 'Quote', tone: 'agent' },
  hire: { glyph: '◆', word: 'Hire', tone: 'agent' },
  deliver: { glyph: '◆', word: 'Deliver', tone: 'agent' },
  settle: { glyph: '✓', word: 'Settle', tone: 'growth' },
  reject: { glyph: '✕', word: 'Reject', tone: 'warn' },
  timeout: { glyph: '○', word: 'Timeout', tone: 'muted' },
  outside: { glyph: '→', word: 'Outside', tone: 'value' },
  close: { glyph: '◎', word: 'Close', tone: 'slime' },
  commit: { glyph: '✓', word: 'Image', tone: 'growth' },
  failed: { glyph: '✕', word: 'Failed', tone: 'warn' },
};
