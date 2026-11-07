// The whole loop (S13, /lab/loop): one spore through Wake → Hire → Settle → Grow →
// Reputation → Art → Sell → Control, told from a run's own logs (Reference C).
//
// `loopLines` turns the logs into story lines and `buildLoop` folds the lines seen
// so far into what the page shows, the same pure shape as the scene logs: a seek
// is just fewer lines, and a run still going is a list that grows at its end.
// Lines appear only once the log has confirmed them, so waiting for the chain is
// waiting on the page. Nothing here invents a value: a step the log doesn't have
// is a missing line, and a tube that didn't grow says so.
import { formatNear, tubesText } from '../ui/format';
import { readDecision, tubeBeatCheaper, type Candidate, type Decision } from './decisions';
import { buildSale, type SaleState } from './sale';
import { repText, type PeerArt, type SceneLine, type SceneStep } from './scene';

export type LoopAct = 'wake' | 'hire' | 'settle' | 'grow' | 'reputation' | 'art' | 'sell' | 'control';

/** The eight stops. `promise` is what the stop means, shown before a run has reached it. */
export const LOOP_ACTS: { key: LoopAct; word: string; promise: string }[] = [
  { key: 'wake', word: 'Wake', promise: 'An NFT with its own money and an agent' },
  { key: 'hire', word: 'Hire', promise: 'Its agent picks who to pay' },
  { key: 'settle', word: 'Settle', promise: 'The money moves, on chain' },
  { key: 'grow', word: 'Grow', promise: 'Paying someone grows a tube' },
  { key: 'reputation', word: 'Reputation', promise: 'Tubes set how much it may spend' },
  { key: 'art', word: 'Art', promise: 'Its picture is drawn from its tubes' },
  { key: 'sell', word: 'Sell', promise: 'Anyone can buy it' },
  { key: 'control', word: 'Control', promise: 'The buyer’s agent takes over' },
];

export interface SnapshotSpore {
  render_input: { spore_id: number; epoch?: number; seed: string; age: number; edges: [number, number | string][] };
  balance: string;
  reputation: string | number;
  owner_id: string;
  operator_id: string | null;
  effective_budget: string;
  policy?: { paused?: boolean; budget_per_epoch?: string };
}

export interface LoopSnapshot {
  epoch: number;
  spores: Record<string, SnapshotSpore>;
}

export interface LoopRunJson {
  run?: string;
  router?: string;
  spores?: number[];
  start_epoch?: number;
  sale_spore?: number | null;
}

export interface LoopReport {
  checks?: { name: string; ok: boolean }[];
  sale?: { spore?: number; epoch?: number };
  /** e.g. "replayed 30 decisions: 30 match, 0 differ". */
  replay?: string;
}

export interface LoopEvent {
  at: string;
  spore: number | string;
  kind: string;
  method?: string;
  args?: Record<string, any>;
  hash?: string;
  ok?: boolean;
  closed?: number;
}

export interface LoopRun {
  run: LoopRunJson;
  events: LoopEvent[];
  decisions: unknown[];
  snapshots: LoopSnapshot[];
  scene: SceneLine[];
  report: LoopReport | null;
}

/** The spore as one snapshot read it. */
export interface HeroFrame {
  epoch: number;
  art: PeerArt;
  tubes: [number, string][];
  peers: PeerArt[];
  balance: string;
  reputation: string;
  /** `effective_budget`: what the contract lets it spend per epoch now. */
  allowance: string;
  /** The owner's budget, the most the allowance can reach. */
  cap: string | null;
  owner: string;
  operator: string | null;
}

export function frameOf(snap: LoopSnapshot, id: number): HeroFrame | null {
  const s = snap.spores[String(id)];
  if (!s) return null;
  const artOf = (x: SnapshotSpore): PeerArt => ({ id: x.render_input.spore_id, seed: x.render_input.seed, age: x.render_input.age, edges: x.render_input.edges.map(([n, d]) => [n, Number(d)]) as [number, number][] });
  const tubes = s.render_input.edges.map(([n, d]) => [n, String(d)] as [number, string]);
  const peers = Object.values(snap.spores).filter((x) => x.render_input.spore_id !== id).map(artOf);
  return { epoch: snap.epoch, art: artOf(s), tubes, peers, balance: s.balance, reputation: String(s.reputation), allowance: s.effective_budget, cap: s.policy?.budget_per_epoch ?? null, owner: s.owner_id, operator: s.operator_id };
}

const dOf = (f: HeroFrame, partner: number) => Number(f.tubes.find(([n]) => n === partner)?.[1] ?? 0);

/** Which spore the story follows: the one this run sells, or else its busiest buyer. */
export function heroOf(r: LoopRun, decisions: Decision[]): number | null {
  if (typeof r.run.sale_spore === 'number') return r.run.sale_spore;
  if (typeof r.report?.sale?.spore === 'number') return r.report.sale.spore;
  const n = new Map<number, number>();
  for (const d of decisions) if (d.outcome === 'settled') n.set(d.consumer, (n.get(d.consumer) ?? 0) + 1);
  let best: number | null = null;
  for (const [id, c] of n) if (best === null || c > n.get(best)! || (c === n.get(best) && id < best)) best = id;
  return best;
}

/** A close tx from the keeper's log with the epoch it closed. */
const closesOf = (events: LoopEvent[]) => events.filter((e) => e.kind === 'tx' && e.method === 'close_epoch' && e.ok && typeof e.closed === 'number').sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

/** Log order and block order can disagree by a few seconds at a close (found in S9). */
const CLOSE_SLACK_MS = 15_000;

/**
 * The close that counted this payment. Normally the first close after the settle
 * line; but a settle logged just after a close may have landed before it, which
 * the tube itself shows. Null while the snapshots to tell aren't in.
 */
export function closeForPayment(closes: LoopEvent[], snaps: Map<number, LoopSnapshot>, hero: number, partner: number, settledAt: string): LoopEvent | null {
  const t = Date.parse(settledAt);
  const grewAt = (c: LoopEvent) => {
    const after = snaps.get(c.closed! + 1);
    const before = snaps.get(c.closed!);
    const a = after && frameOf(after, hero);
    const b = before && frameOf(before, hero);
    return a && b ? dOf(a, partner) > dOf(b, partner) : null;
  };
  const prev = [...closes].reverse().find((c) => Date.parse(c.at) <= t);
  if (prev && t - Date.parse(prev.at) <= CLOSE_SLACK_MS) {
    const g = grewAt(prev);
    if (g === null) return null;
    if (g) return prev;
  }
  return closes.find((c) => Date.parse(c.at) > t && snaps.has(c.closed! + 1)) ?? null;
}

const tx = (e: LoopEvent | undefined) => e?.hash ?? null;

/**
 * The story so far, from the logs so far. Later logs only add lines at the end:
 * the sale waits until every close before it has its snapshot, so a late snapshot
 * can't push a line in ahead of what has already played.
 */
export function loopLines(r: LoopRun): SceneLine[] {
  const decisions = r.decisions.map(readDecision).filter((d): d is Decision => typeof d !== 'string');
  const hero = heroOf(r, decisions);
  if (hero === null) return [];
  const snaps = new Map(r.snapshots.map((s) => [s.epoch, s]));
  const startEpoch = r.run.start_epoch ?? Math.min(...r.snapshots.map((s) => s.epoch));
  const first = snaps.get(startEpoch) ?? [...r.snapshots].sort((a, b) => a.epoch - b.epoch)[0];
  const wake = first && frameOf(first, hero);
  if (!wake) return [];

  const lines: SceneLine[] = [];
  const woke = r.events.find((e) => e.kind === 'start' && e.spore === hero);
  // The agent's own first line: the story can't start before it, and a finished run without one (an older log) still plays.
  if (!woke && !r.report) return [];
  const at0 = woke?.at ?? r.events[0]?.at ?? '';
  lines.push({ type: 'act', act: 'wake', at: at0 }, { type: 'wake', at: at0, hero, frame: wake });

  const closes = closesOf(r.events);
  const saleAt = r.scene.find((l) => l.type === 'start')?.at as string | undefined;
  const beforeSale = (at: string) => !saleAt || Date.parse(at) < Date.parse(saleAt);
  const d = decisions.find((x) => x.consumer === hero && x.outcome === 'settled' && x.winner !== null && beforeSale(x.at));
  const byHash = new Map(r.events.filter((e) => e.hash).map((e) => [e.hash!, e]));
  let storyDone = !!r.report;
  let grewAt: LoopEvent | null = null;

  if (d) {
    const winner = d.candidates.find((c) => c.provider === d.winner)!;
    const postAt = byHash.get(d.tx.post ?? '')?.at ?? d.at;
    const acceptAt = byHash.get(d.tx.accept ?? '')?.at ?? d.at;
    const settleAt = byHash.get(d.tx.settle ?? '')?.at ?? d.at;
    // Quotes can land after the agent chose; those weren't candidates.
    const quotes = r.events.filter((e) => e.kind === 'tx' && e.method === 'quote' && e.ok && e.args?.job_id === d.job_id && Date.parse(e.at) <= Date.parse(acceptAt));
    const delivered = r.events.find((e) => e.kind === 'tx' && e.method === 'deliver' && e.ok && e.args?.job_id === d.job_id);
    const job = { id: d.job_id, service: d.service ?? null, candidates: d.candidates, winner: d.winner!, price: winner.price, decision: d };
    lines.push(
      { type: 'act', act: 'hire', at: postAt },
      { type: 'post', at: postAt, job, tx: d.tx.post ?? null },
      { type: 'quotes', at: quotes.at(-1)?.at ?? acceptAt },
      { type: 'hired', at: acceptAt, tx: d.tx.accept ?? null },
      { type: 'act', act: 'settle', at: delivered?.at ?? settleAt },
      { type: 'delivered', at: delivered?.at ?? settleAt, tx: tx(delivered) },
      { type: 'paid', at: settleAt, tx: d.tx.settle ?? null },
    );
    const close = closeForPayment(closes, snaps, hero, d.winner!, settleAt);
    const after = close && snaps.get(close.closed! + 1);
    const frame = after && frameOf(after, hero);
    const before = close && (snaps.get(close.closed!) ?? first);
    const prior = before && frameOf(before, hero);
    if (close && frame && prior) {
      grewAt = close;
      lines.push(
        { type: 'act', act: 'grow', at: close.at },
        { type: 'closed', at: close.at, tx: tx(close), epoch: close.closed, frame, prior, partner: d.winner, dBefore: dOf(prior, d.winner!), dAfter: dOf(frame, d.winner!) },
        { type: 'act', act: 'reputation', at: close.at },
        { type: 'rep', at: close.at },
        { type: 'act', act: 'art', at: close.at },
        { type: 'art', at: close.at },
      );
      storyDone = true;
    }
  } else {
    // No settled hire yet. Only a sale that has begun, or a finished run, says there won't be one to tell.
    storyDone = !!r.report || !!saleAt;
  }

  // Every close after that one and before the sale redraws it.
  let closesReady = true;
  if (storyDone) {
    for (const c of closes) {
      if (grewAt && Date.parse(c.at) <= Date.parse(grewAt.at)) continue;
      if (!beforeSale(c.at)) break;
      const f = snaps.get(c.closed! + 1);
      const frame = f && frameOf(f, hero);
      if (!frame) {
        closesReady = !!r.report;
        break;
      }
      lines.push({ type: 'lapse', at: c.at, tx: tx(c), epoch: c.closed, frame });
    }
  }

  // The sale's own lines, unchanged: acts 7 and 8 are its log.
  if (storyDone && closesReady && r.scene.length) {
    let control = false;
    lines.push({ type: 'act', act: 'sell', at: saleAt ?? r.scene[0].at });
    for (const line of r.scene) {
      if (!control && line.type === 'act' && line.act === 'lockout') {
        control = true;
        lines.push({ type: 'act', act: 'control', at: line.at });
      }
      lines.push({ type: 'sale', at: line.at, line });
    }
    const took = r.scene.find((l) => l.type === 'result' && l.method === 'set_policy' && l.ok);
    const resumed = took && r.events.find((e) => e.spore === hero && e.kind === 'tx' && e.ok && Date.parse(e.at) > Date.parse(took.at));
    if (resumed) lines.push({ type: 'resumed', at: resumed.at, tx: resumed.hash ?? null, method: resumed.method });
  }

  if (r.report) lines.push({ type: 'report', at: lines.at(-1)!.at, checks: r.report.checks ?? [] });
  return lines;
}

export interface LoopJob {
  id: number;
  service: string | null;
  candidates: Candidate[];
  winner: number;
  price: string;
  decision: Decision;
}

export type LoopBeat = 'none' | 'wake' | 'post' | 'quotes' | 'hired' | 'delivered' | 'paid' | 'closed' | 'rep' | 'art' | 'lapse' | 'sale' | 'resumed' | 'report';

export interface LoopState {
  hero: number | null;
  act: LoopAct | null;
  beat: LoopBeat;
  /** What the first snapshot read. */
  start: HeroFrame | null;
  /** Tubes, money and reputation as of the latest close shown. */
  frame: HeroFrame | null;
  /** The frame before the latest close, while it tweens. */
  prior: HeroFrame | null;
  /** The render shown: it moves on at the Art stop, after the tubes. */
  artFrame: HeroFrame | null;
  job: LoopJob | null;
  /** Txs of the hire, as far as the story has reached. */
  txs: { post?: string | null; accept?: string | null; deliver?: string | null; settle?: string | null; close?: string | null };
  quoted: boolean;
  hired: boolean;
  delivered: boolean;
  paid: boolean;
  growth: { partner: number; before: number; after: number; epoch: number } | null;
  /** Reputation and allowance, before and after the close the story follows. */
  rep: { from: string; to: string; allowanceFrom: string; allowanceTo: string } | null;
  /** Closes the time-lapse has shown after the first one. */
  lapses: number;
  /** The sale's own state, from its lines so far. */
  sale: SaleState;
  saleStarted: boolean;
  resumed: { tx: string | null; method: string | null } | null;
  checks: { name: string; ok: boolean }[] | null;
  /** Lines seen, so a stage can tell a step from a seek. */
  lines: number;
  /** Bumps once per moment that moves the stage. */
  moments: string[];
}

const EMPTY_SALE = buildSale([]);

export function buildLoop(lines: SceneLine[]): LoopState {
  const s: LoopState = { hero: null, act: null, beat: 'none', start: null, frame: null, prior: null, artFrame: null, job: null, txs: {}, quoted: false, hired: false, delivered: false, paid: false, growth: null, rep: null, lapses: 0, sale: EMPTY_SALE, saleStarted: false, resumed: null, checks: null, lines: lines.length, moments: [] };
  const sale: SceneLine[] = [];
  for (const l of lines) {
    switch (l.type) {
      case 'act':
        s.act = l.act;
        break;
      case 'wake':
        s.hero = l.hero;
        s.start = s.frame = s.artFrame = l.frame;
        s.beat = 'wake';
        s.moments.push('wake');
        break;
      case 'post':
        s.job = l.job;
        s.txs.post = l.tx;
        s.beat = 'post';
        s.moments.push('post');
        break;
      case 'quotes':
        s.quoted = true;
        s.beat = 'quotes';
        s.moments.push('quotes');
        break;
      case 'hired':
        s.hired = true;
        s.txs.accept = l.tx;
        s.beat = 'hired';
        s.moments.push('hired');
        break;
      case 'delivered':
        s.delivered = true;
        s.txs.deliver = l.tx;
        s.beat = 'delivered';
        s.moments.push('delivered');
        break;
      case 'paid':
        s.paid = true;
        s.txs.settle = l.tx;
        s.beat = 'paid';
        s.moments.push('paid');
        break;
      case 'closed':
        s.prior = l.prior;
        s.frame = l.frame;
        s.txs.close = l.tx;
        s.growth = { partner: l.partner, before: l.dBefore, after: l.dAfter, epoch: l.epoch };
        s.beat = 'closed';
        s.moments.push('closed');
        break;
      case 'rep':
        if (s.prior && s.frame) s.rep = { from: s.prior.reputation, to: s.frame.reputation, allowanceFrom: s.prior.allowance, allowanceTo: s.frame.allowance };
        s.beat = 'rep';
        s.moments.push('rep');
        break;
      case 'art':
        s.artFrame = s.frame;
        s.beat = 'art';
        s.moments.push('art');
        break;
      case 'lapse':
        s.prior = s.frame;
        s.frame = s.artFrame = l.frame;
        s.lapses++;
        s.beat = 'lapse';
        s.moments.push(`lapse:${l.epoch}`);
        break;
      case 'sale':
        sale.push(l.line);
        s.saleStarted = true;
        s.beat = 'sale';
        break;
      case 'resumed':
        s.resumed = { tx: l.tx, method: l.method ?? null };
        s.beat = 'resumed';
        s.moments.push('resumed');
        break;
      case 'report':
        s.checks = l.checks;
        s.beat = 'report';
        break;
      default:
        break;
    }
  }
  if (sale.length) s.sale = atTheBuy(withResumed(buildSale(sale), s.resumed), sale);
  return s;
}

/**
 * The plate tells the sale as the chain's blocks either side of the buy do. Closes
 * go on during the minute a run's sale takes, so later snapshots have decayed
 * further; what `✓ kept` claims is the state at the buy, and the narrator says the same.
 */
function atTheBuy(sale: SaleState, lines: SceneLine[]): SaleState {
  const sold = lines.find((l) => l.type === 'snapshot' && l.label === 'sold');
  return sold ? { ...sale, now: sold as unknown as SaleState['now'] } : sale;
}

/** A real agent, not a probe, proves the new key in a run: its first tx is what the stage's last ripple marks. */
function withResumed(sale: SaleState, resumed: LoopState['resumed']): SaleState {
  if (!resumed || !sale.start) return sale;
  const probe: SceneStep = { id: 'resumed', act: 'takeover' as SceneStep['act'], actor: 'new agent', method: resumed.method ?? 'tx', action: 'the new agent’s first tx', expected: 'ok', at: '', state: 'ok', tx: resumed.tx ?? undefined };
  return { ...sale, probe };
}

/** How the winner won, in the narrator's words (the numbers are in the row). */
function hireLine(j: LoopJob): string {
  const n = j.candidates.length;
  if (n === 1) return `It hires #${j.winner}: the only quote in when it chose.`;
  if (tubeBeatCheaper(j.decision)) return `It hires #${j.winner}. Dearer, but they already share a tube.`;
  const low = j.candidates.every((c) => BigInt(c.price) >= BigInt(j.price));
  return low ? `It hires #${j.winner}, the cheapest quote.` : `It hires #${j.winner}, the best score under the rule.`;
}

export function quotesLine(j: LoopJob): string {
  const prices = j.candidates.map((c) => BigInt(c.price));
  if (j.candidates.length === 1) return `#${j.candidates[0].provider} quotes ${formatNear(j.candidates[0].price)}.`;
  if (j.candidates.length === 2) return `Two quotes: #${j.candidates[0].provider} wants ${formatNear(j.candidates[0].price)}, #${j.candidates[1].provider} ${formatNear(j.candidates[1].price)}.`;
  const lo = prices.reduce((a, b) => (b < a ? b : a));
  const hi = prices.reduce((a, b) => (b > a ? b : a));
  return `${j.candidates.length} spores quote, from ${formatNear(lo)} to ${formatNear(hi)}.`;
}

/** The narrator's line (Design §8.2): what just happened, from the log. */
export function narrateLoop(s: LoopState, narrateSale: (x: SaleState) => string): string {
  const id = s.hero === null ? 'This spore' : `Spore #${s.hero}`;
  switch (s.beat) {
    case 'none':
      return 'A Spore is an NFT with its own money and an agent that spends it.';
    case 'wake':
      return `${id} is an NFT with its own money. An agent runs it.`;
    case 'post':
      return `It needs ${s.job?.service ? `a ${s.job.service} job` : 'a job'} done, so it asks the network.`;
    case 'quotes':
      return quotesLine(s.job!);
    case 'hired':
      return hireLine(s.job!);
    case 'delivered':
      return `#${s.job!.winner} delivers the work.`;
    case 'paid':
      return `It pays. ${formatNear(s.job!.price)} leaves escrow for #${s.job!.winner}.`;
    case 'closed': {
      const g = s.growth!;
      if (g.after > g.before) return g.before === 0 ? 'The epoch closes. That payment grew a new tube.' : 'The epoch closes. That payment made their tube thicker.';
      return g.after === 0 ? 'The epoch closes. That payment wasn’t enough to keep a tube.' : 'The epoch closes. Their tube still shrank: it decays faster than this fed it.';
    }
    case 'rep': {
      const r = s.rep;
      if (!r) return 'Its tubes set its reputation.';
      const up = Number(r.to) > Number(r.from);
      const more = BigInt(r.allowanceTo) > BigInt(r.allowanceFrom);
      if (up && more) return 'Stronger tubes, more reputation. The contract lets it spend more.';
      if (up) return 'Stronger tubes, more reputation. Its owner’s budget still caps its spending.';
      if (Number(r.to) === Number(r.from)) return 'Its reputation holds, and so does what it may spend.';
      return 'Its other tubes shrank more, so its reputation fell, and what it may spend.';
    }
    case 'art':
      return 'Its picture is drawn from its tubes, so the picture changed.';
    case 'lapse':
      return 'It keeps trading. Every close redraws it.';
    case 'sale':
      return narrateSale(s.sale);
    case 'resumed':
      return 'The new agent is working.';
    case 'report': {
      const failed = (s.checks ?? []).filter((c) => !c.ok);
      if (failed.length) return 'This run failed a check. The reason is below.';
      if (s.resumed) return 'Same spore, new hands. And the loop goes round again.';
      return s.saleStarted ? narrateSale(s.sale) : 'That’s the loop, as far as this run went.';
    }
  }
}

export interface LoopRow {
  key: LoopAct;
  word: string;
  promise: string;
  state: 'future' | 'now' | 'past';
  /** The real figures of this stop, once it has happened. */
  fact: string | null;
  /** The tx behind the fact. */
  tx: string | null;
  /** The contract said no, or the log says it went wrong. */
  warn?: boolean;
}

const dText = (d: number) => d.toLocaleString('en-US');

function hireFact(j: LoopJob): string {
  const others = j.candidates.filter((c) => c.provider !== j.winner);
  if (!others.length) return `#${j.winner} at ${formatNear(j.price)}, the only quote`;
  const cheaper = others.filter((c) => BigInt(c.price) < BigInt(j.price));
  if (cheaper.length) {
    const c = cheaper.reduce((a, b) => (BigInt(b.price) < BigInt(a.price) ? b : a));
    return `#${j.winner} at ${formatNear(j.price)} over #${c.provider} at ${formatNear(c.price)}`;
  }
  return `#${j.winner} at ${formatNear(j.price)}, lowest of ${j.candidates.length}`;
}

/** The eight stops as the page lists them. Each fact is a value from the log. */
export function loopRows(s: LoopState, over: boolean): LoopRow[] {
  const at = s.act ? LOOP_ACTS.findIndex((a) => a.key === s.act) : -1;
  const sale = s.sale;
  const fact = (key: LoopAct): Pick<LoopRow, 'fact' | 'tx' | 'warn'> => {
    switch (key) {
      case 'wake':
        return s.start ? { fact: `${formatNear(s.start.balance)}, may spend ${formatNear(s.start.allowance)} an epoch`, tx: null } : { fact: null, tx: null };
      case 'hire':
        return s.hired && s.job ? { fact: hireFact(s.job), tx: s.txs.accept ?? null } : { fact: null, tx: null };
      case 'settle':
        return s.paid && s.job ? { fact: `paid #${s.job.winner} ${formatNear(s.job.price)}`, tx: s.txs.settle ?? null } : { fact: null, tx: null };
      case 'grow':
        return s.growth ? { fact: `tube to #${s.growth.partner}: D ${dText(s.growth.before)} → ${dText(s.growth.after)}`, tx: s.txs.close ?? null } : { fact: null, tx: null };
      case 'reputation':
        return s.rep ? { fact: `R ${repText(s.rep.from)} → ${repText(s.rep.to)}, may spend ${formatNear(s.rep.allowanceTo)}`, tx: null } : { fact: null, tx: null };
      case 'art':
        return s.artFrame && s.artFrame !== s.start ? { fact: `E ${s.artFrame.epoch}: ${tubesText(s.artFrame.tubes.length)}, age ${s.artFrame.art.age}`, tx: null } : { fact: null, tx: null };
      case 'sell':
        if (sale.sold && sale.start) return { fact: `to ${sale.start.buyer.split('.')[0]} for ${formatNear(sale.start.price)}`, tx: sale.buyTx };
        if (sale.buyTx) return { fact: 'the buy failed', tx: sale.buyTx, warn: true };
        if (sale.listed && sale.start) return { fact: `listed at ${formatNear(sale.start.price)}`, tx: null };
        return { fact: null, tx: null };
      case 'control': {
        const refused = sale.oldKey?.state === 'failed';
        if (!sale.oldKey || sale.oldKey.state === 'pending') return { fact: null, tx: null };
        if (!refused) return { fact: 'the old key was not refused', tx: sale.oldKey.tx ?? null, warn: true };
        return { fact: s.resumed ? 'old key refused, new agent working' : 'old key refused', tx: s.resumed?.tx ?? sale.oldKey.tx ?? null };
      }
    }
  };
  return LOOP_ACTS.map((a, i) => ({ ...a, ...fact(a.key), state: i < at || (over && i === at) ? 'past' : i === at ? 'now' : 'future' }));
}

/** What a run still going is waiting for, when the story has caught up with its log. Null when it isn't. */
export function loopWaiting(r: LoopRun, s: LoopState): string | null {
  if (r.report) return null;
  const txs = r.events.filter((e) => e.kind === 'tx').length;
  const so = txs ? ` ${txs} txs so far.` : '';
  if (s.hero === null || !s.start) return 'Waiting for the first reading.';
  if (!s.paid) return `Waiting for Spore #${s.hero}’s first settled hire.${so}`;
  if (!s.growth) return `Waiting for the epoch to close.${so}`;
  if (!s.saleStarted) return `Trading on. Waiting for the next close.${so}`;
  if (!s.resumed) return s.sale.verdict.status === 'running' ? `The sale is going through.${so}` : `Waiting for the new agent’s first tx.${so}`;
  return `Now it checks itself: rendering every spore and replaying every close.${so}`;
}

/**
 * How long each line stays in story pace: long enough to read what it changed,
 * and the Art stop lands inside the first 30 seconds. Real time is the logged gap.
 */
export function loopDelay(l: SceneLine): number {
  switch (l.type) {
    case 'act':
      return 0;
    case 'wake':
      return 3600;
    case 'post':
      return 2200;
    case 'quotes':
      return 3000;
    case 'hired':
      return 3200;
    case 'delivered':
      return 1500;
    case 'paid':
      return 3000;
    case 'closed':
      return 3400;
    case 'rep':
      return 3400;
    case 'art':
      return 3400;
    case 'lapse':
      return 1500;
    case 'sale':
      return saleLineDelay(l.line);
    case 'resumed':
      return 2600;
    default:
      return 400;
  }
}

/** The sale inside the loop is told faster than its own scene: `/lab/sale` has the long version. */
function saleLineDelay(l: SceneLine): number {
  switch (l.type) {
    case 'step':
      if (l.method === 'buy') return 1000;
      if (l.expected !== 'ok') return 700;
      return 300;
    case 'result':
      if (l.method === 'list') return 1100;
      if (l.method === 'buy') return l.ok ? 2000 : 3000;
      return l.ok ? 900 : 1500;
    case 'payout':
      return 700;
    case 'check':
      if (l.n === 8) return 1300;
      if (l.n === 9) return 2000;
      return 0;
    default:
      return 0;
  }
}

/** The render inputs the story will ask for, so the first play doesn't wait for the worker. */
export function loopArtInputs(lines: SceneLine[]): PeerArt[] {
  const seen = new Map<string, PeerArt>();
  const add = (f?: HeroFrame) => {
    if (f) seen.set(`${f.art.age}|${f.art.edges.join()}`, f.art);
  };
  for (const l of lines) add(l.frame);
  return [...seen.values()];
}

