// A logged hire (`decisions.jsonl`, Reference C) and the three checks a reader
// can run on it in the browser (Design §6.E): the rule re-run with the same
// `@rules` the agents use, the D values against the previous close, and the
// derived sentence that says why the winner won. Mirrors `spores-sim
// replay-decisions` (sim/src/replay.rs), so both give the same verdict.
import { dNorm, pick, reference, score, type Norm, type Quote } from '@rules';
import { formatD, formatNear } from '../ui/format';
import { pairKey, tubeAlpha, tubeWidth, type PairKey } from './network';

export interface Candidate {
  provider: number;
  price: string;
  d: string;
  d_norm: string;
  score: string;
}

export interface Decision {
  run?: string;
  at: string;
  epoch: number;
  job_id: number;
  consumer: number;
  service?: string;
  task_hash?: string;
  attempt?: number;
  rule: { w_bps: number; norm: unknown };
  candidates: Candidate[];
  winner: number | null;
  tx: { post?: string; accept?: string; settle?: string; reject?: string };
  outcome: string;
  correct?: boolean;
  cut?: boolean;
  err?: string;
  budget_left?: string;
  balance?: string;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** The parsed line as a `Decision`, or why it can't be one. */
export function readDecision(v: unknown): Decision | string {
  const d = v as Decision | null;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'not an object';
  if (!Number.isFinite(Date.parse(d.at))) return 'no valid `at`';
  if (!isInt(d.epoch)) return 'no valid `epoch`';
  if (!isInt(d.job_id)) return 'no valid `job_id`';
  if (!isInt(d.consumer)) return 'no valid `consumer`';
  if (!Array.isArray(d.candidates)) return 'no `candidates` list';
  if (d.candidates.some((c) => !isInt(c?.provider) || [c.price, c.d, c.d_norm, c.score].some((n) => !/^\d+$/.test(String(n))))) return 'a candidate has an unreadable number';
  if (!d.rule || typeof d.rule !== 'object') return 'no `rule`';
  if (typeof d.outcome !== 'string') return 'no `outcome`';
  return { ...d, tx: d.tx ?? {}, winner: d.winner ?? null };
}

function normOf(v: unknown): Norm | null {
  if (v === 'relative') return 'relative';
  const abs = (v as { absolute?: unknown } | null)?.absolute;
  if (typeof abs === 'string' || typeof abs === 'number') return { absolute: BigInt(abs) };
  return null;
}

export interface RecomputeDiff {
  /** `winner`, or the candidate and field that differs. */
  what: string;
  logged: string;
  recomputed: string;
}

export type Recompute = { status: 'matches' } | { status: 'differs'; diffs: RecomputeDiff[] } | { status: 'unverifiable'; reason: string };

/** Re-runs the hiring rule over the logged quotes, with the log's own `rule` (Design §6.E part 3). */
export function recompute(d: Decision): Recompute {
  let quotes: Quote[];
  let norm: Norm | null;
  try {
    norm = normOf(d.rule.norm);
    quotes = d.candidates.map((c) => ({ provider: c.provider, price: BigInt(c.price), d: BigInt(c.d) }));
  } catch (e) {
    return { status: 'unverifiable', reason: `a logged number does not parse: ${(e as Error).message}` };
  }
  if (!norm) return { status: 'unverifiable', reason: `unknown norm ${JSON.stringify(d.rule.norm)}` };
  const w = d.rule.w_bps;
  if (!isInt(w) || w < 0) return { status: 'unverifiable', reason: `unusable w_bps ${JSON.stringify(w)}` };

  const ref = reference(quotes, norm);
  const diffs: RecomputeDiff[] = [];
  d.candidates.forEach((c, i) => {
    const wantN = dNorm(quotes[i].d, ref).toString();
    const wantS = score(quotes[i].price, quotes[i].d, ref, w).toString();
    if (String(c.d_norm) !== wantN) diffs.push({ what: `#${c.provider} D_norm`, logged: String(c.d_norm), recomputed: wantN });
    if (String(c.score) !== wantS) diffs.push({ what: `#${c.provider} score`, logged: String(c.score), recomputed: wantS });
  });
  const i = pick(quotes, w, norm);
  const want = i === null ? null : quotes[i].provider;
  if (want !== d.winner) diffs.push({ what: 'winner', logged: d.winner === null ? 'none' : `#${d.winner}`, recomputed: want === null ? 'none' : `#${want}` });
  return diffs.length ? { status: 'differs', diffs } : { status: 'matches' };
}

/** Candidates as the rule orders them: score, then price, then id. */
export function byScore(cands: Candidate[]): Candidate[] {
  const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
  return [...cands].sort((a, b) => cmp(BigInt(a.score), BigInt(b.score)) || cmp(BigInt(a.price), BigInt(b.price)) || a.provider - b.provider);
}

const hasTube = (c: Candidate) => BigInt(c.d) > 0n && BigInt(c.score) < BigInt(c.price);

/** The row's verb: only an accept that went through is a hire. */
export function hireVerb(d: Decision): string {
  if (d.winner === null) return `#${d.consumer} hired no one`;
  return `#${d.consumer} ${d.tx.accept && d.outcome !== 'accept_failed' ? 'hired' : 'picked'} #${d.winner}`;
}

/** The winner quoted more than another candidate and still scored lowest: only its tube can do that. */
export function tubeBeatCheaper(d: Decision): boolean {
  const w = d.candidates.find((c) => c.provider === d.winner);
  if (!w || !hasTube(w)) return false;
  return d.candidates.some((c) => BigInt(c.price) < BigInt(w.price));
}

export interface HireBar {
  candidate: Candidate;
  won: boolean;
  tube: boolean;
  /** Of the log's largest quote, 0..1, so bars compare across rows. */
  quote: number;
  effective: number;
  /** The tube as the map draws it: width √D and brightness D, against the log's largest D. */
  width: number;
  alpha: number;
}

/** One bar per candidate, in the rule's order, on a shared zero-based scale. */
export function hireBars(d: Decision, maxQuote: bigint, maxD: number): HireBar[] {
  const share = (v: string) => (maxQuote > 0n ? Math.min(1, Number((BigInt(v) * 10_000n) / maxQuote) / 10_000) : 0);
  return byScore(d.candidates).map((c) => ({ candidate: c, won: c.provider === d.winner, tube: hasTube(c), quote: share(c.price), effective: share(c.score), width: tubeWidth(Number(c.d), maxD), alpha: tubeAlpha(Number(c.d), maxD) }));
}

/** The derived sentence (Design §6.E part 1), without its `≈` mark. */
export function decisionSummary(d: Decision): string {
  if (d.candidates.length === 0) return 'No provider quoted.';
  // Not "only one provider quoted": other quotes can land after the agent chose (the timeline shows them).
  if (d.candidates.length === 1) return 'Only one quote was in when the agent chose.';
  const w = d.candidates.find((c) => c.provider === d.winner);
  if (!w) return `The log names no winner among the ${d.candidates.length} quotes.`;
  const won = hasTube(w)
    ? `#${w.provider} won on effective price: its tube with #${d.consumer} (D ${formatD(w.d)}) cut its ${formatNear(w.price)} quote to an effective ${formatNear(w.score)}.`
    : `#${w.provider} won on its ${formatNear(w.price)} quote, with no tube.`;
  const next = byScore(d.candidates).find((c) => c.provider !== w.provider)!;
  const other = hasTube(next)
    ? `#${next.provider} quoted ${formatNear(next.price)}, an effective ${formatNear(next.score)} with its tube (D ${formatD(next.d)}).`
    : `#${next.provider} quoted ${formatNear(next.price)} with no tube.`;
  return `${won} ${other}`;
}

/** The rule caption, from the log's `rule` field, never constants (Design §6.E part 2). */
export function ruleCaption(rule: Decision['rule']): string {
  const w = (rule.w_bps / 10_000).toFixed(2);
  const abs = (rule.norm as { absolute?: unknown } | null)?.absolute;
  const norm = rule.norm === 'relative' ? 'relative to the largest candidate D' : abs !== undefined ? `relative to D ${formatD(String(abs))}` : `by ${JSON.stringify(rule.norm)}`;
  return `score = quote / (1 + w·D_norm), w = ${w} (w_bps ${rule.w_bps}), D_norm ${norm}; lowest score wins, ties → lower price → lower id`;
}

export type TubeCheck =
  | { status: 'match'; epoch: number }
  | { status: 'differ'; epoch: number; diffs: { provider: number; logged: string; close: string }[] }
  | { status: 'needs'; epoch: number };

/**
 * Each candidate's `d` against the tubes after the previous close (Design §6.E
 * part 4). `tubesAt(e)` is the tube set after the close of epoch `e`, or null
 * when this source doesn't have it.
 */
export function tubeCheck(d: Decision, tubesAt: (epoch: number) => Map<PairKey, number> | null | undefined): TubeCheck {
  const epoch = d.epoch - 1;
  const tubes = tubesAt(epoch);
  if (!tubes) return { status: 'needs', epoch };
  const diffs: { provider: number; logged: string; close: string }[] = [];
  for (const c of d.candidates) {
    const close = String(tubes.get(pairKey(d.consumer, c.provider)) ?? 0);
    if (String(c.d) !== close) diffs.push({ provider: c.provider, logged: String(c.d), close });
  }
  return diffs.length ? { status: 'differ', epoch, diffs } : { status: 'match', epoch };
}
