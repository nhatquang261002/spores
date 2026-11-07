// The Activity feed (Design §6.E): every line of a run log (Reference C) as a
// row, grouped by epoch, or the chain's close events on LIVE. Nothing is
// dropped: a line that can't be read becomes an `unreadable` row that no filter
// hides, a job step that isn't a row of its own sits in its job's timeline, and
// routine notes merge into one row per epoch that still lists every line.
import type { EpochClosed } from '../chain/events';
import { formatNear, shortHash } from '../ui/format';
import { hireVerb, readDecision, recompute, tubeBeatCheaper, type Decision } from './decisions';
import { pairKey, type PairKey } from './network';
import { closeReceipt, type Receipt } from './receipts';
import type { RawEvent } from './steps';

export type ActivityKind = 'decision' | 'settlement' | 'refund' | 'refusal' | 'close' | 'market' | 'image' | 'lifecycle';
export type RowKind = ActivityKind | 'unreadable';
export type Tone = 'agent' | 'growth' | 'value' | 'warn' | 'caution' | 'muted' | 'slime';

/** Filter order and words (Design §6.E; "Refused / failed" also holds failures that aren't refusals, §13 item 16). */
export const KINDS: { kind: ActivityKind; word: string }[] = [
  { kind: 'decision', word: 'Decisions' },
  { kind: 'settlement', word: 'Settlements' },
  { kind: 'refund', word: 'Refunds' },
  { kind: 'refusal', word: 'Refused / failed' },
  { kind: 'close', word: 'Closes' },
  { kind: 'market', word: 'Market' },
  { kind: 'image', word: 'Images' },
  { kind: 'lifecycle', word: 'Agent lifecycle' },
];

export interface Mark {
  glyph: string;
  tone: Tone;
  word: string | null;
}

/** Status words of the decision outcomes (S9 Do list); an outcome this build doesn't know keeps its raw word. */
export const OUTCOMES: Record<string, Mark> = {
  settled: { glyph: '✓', tone: 'growth', word: 'Settled' },
  rejected: { glyph: '✕', tone: 'warn', word: 'Rejected' },
  accept_failed: { glyph: '✕', tone: 'warn', word: 'Accept failed' },
  over_budget: { glyph: '!', tone: 'caution', word: 'Over budget' },
  low_balance: { glyph: '!', tone: 'caution', word: 'Low balance' },
  timeout: { glyph: '○', tone: 'muted', word: 'Timed out' },
  settle_failed: { glyph: '✕', tone: 'warn', word: 'Settle failed' },
  reject_failed: { glyph: '✕', tone: 'warn', word: 'Reject failed' },
};
export const outcomeMark = (o: string): Mark => OUTCOMES[o] ?? { glyph: '○', tone: 'muted', word: o };

export interface ActivityRow {
  key: string;
  kind: RowKind;
  /** ms; null when the source has no time for it (a close event has none). */
  at: number | null;
  /** The epoch in progress when logged; a close and a decision carry their own. */
  epoch: number | null;
  spores: number[];
  outcome: string | null;
  tx: string | null;
  summary: string;
  glyph: string;
  tone: Tone;
  word: string | null;
  /** The pair, when the row has a tube. */
  pair: [number, number] | null;
  decision?: Decision;
  receipt?: Receipt;
  /** The hash's account hint for the `tx` lookup. */
  sender?: string | null;
  /** The log's own verdict on the tx. */
  loggedOk?: boolean;
  /** The file and line(s) behind the row: nothing is hidden. */
  raw: { where: string; text: string }[];
  /** Routine lines merge into one row per epoch; `note` is the phrase for its count. */
  note?: [string, string];
  /** Unreadable rows say why. */
  reason?: string;
}

export interface JobStep {
  key: string;
  label: string;
  /** ok and failed come from the log (or the chain); `skipped` was not sent, with `note` saying why; `pending` was sent and has no outcome yet (scenes). */
  state: 'ok' | 'failed' | 'skipped' | 'pending';
  note?: string;
  err?: string;
  at?: number;
  tx?: string;
  amount?: string;
}

export interface Activity {
  mode: 'log' | 'chain';
  rows: ActivityRow[];
  /** Tubes after the close of each epoch, as far as this source has them. */
  tubesAt: Map<number, Map<PairKey, number>>;
  /** Job-step txs by job id, for `jobSteps`. */
  jobLines: Map<number, RawEvent[]>;
  postLines: Map<string, RawEvent>;
  palettes: Map<number, number>;
  router: string | null;
  stats: {
    decisionLines: number;
    eventLines: number;
    /** Job-step txs shown in a decision's timeline. */
    inTimelines: number;
    /** Job-step txs for jobs with no decision line. */
    withoutDecision: number;
    matches: number;
    decisions: number;
    /** Decisions where the winner's tube beat a cheaper quote. */
    tubeWins: number;
    /** The largest quote in the log, yocto: the shared scale of the decision bars. */
    maxQuote: string;
    /** The largest candidate D in the log: the shared scale of the tubes' width. */
    maxD: number;
  };
  /** Log files this source doesn't have. */
  missing: string[];
}

// --- reading lines ----------------------------------------------------------

export interface LogLine {
  file: string;
  line: number;
  text: string;
  value: unknown;
}

/** JSON lines; a line that doesn't parse comes back as `value: undefined`. Not `parseJsonl`, which throws at the first bad line. */
export function readLines(text: string, file: string): LogLine[] {
  const out: LogLine[] = [];
  text.split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    out.push({ file, line: i + 1, text: raw, value });
  });
  return out;
}

function unreadable(l: LogLine, reason: string): ActivityRow {
  return {
    key: `bad:${l.file}:${l.line}`,
    kind: 'unreadable',
    at: null,
    epoch: null,
    spores: [],
    outcome: null,
    tx: null,
    summary: `${l.file} line ${l.line}: ${reason}`,
    glyph: '✕',
    tone: 'warn',
    word: 'Unreadable',
    pair: null,
    raw: [{ where: `${l.file}:${l.line}`, text: l.text }],
    reason,
  };
}

// --- building rows ----------------------------------------------------------

const PANIC = 'Smart contract panicked: ';
const JOB_METHODS = new Set(['post_job', 'quote', 'accept', 'deliver', 'settle', 'reject', 'timeout_job']);
/** Routine lines: one merged row per epoch, phrased "9 margin changes". */
const NOTES: Record<string, [string, string]> = {
  margin: ['margin change', 'margin changes'],
  skip: ['skipped step', 'skipped steps'],
  rpc: ['RPC report', 'RPC reports'],
  snapshot: ['snapshot', 'snapshots'],
  outside: ['outside-service call', 'outside-service calls'],
  start: ['agent started', 'agents started'],
  stop: ['agent stopped', 'agents stopped'],
  exit: ['process exited', 'processes exited'],
  done: ['`done` line', '`done` lines'],
};

const asSpore = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const actor = (v: unknown): string => (asSpore(v) !== null ? `#${v}` : String(v));
const ordered = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);

export function errorText(err: unknown): string {
  const s = String(err ?? 'failed');
  return s.startsWith(PANIC) ? s.slice(PANIC.length) : s;
}

export interface SaleInfo {
  spore?: number;
  price?: string;
  seller?: string;
  buyer?: string;
  list?: string;
  buy?: string;
}

function shockText(s: any): string {
  if (s?.kind === 'raise') return `Shock: #${s.spore} raises its cost ×${(s.factorBps / 10_000).toFixed(2)}`;
  if (s?.kind === 'cut') return `Shock: #${s.a} and #${s.b} stop working together`;
  if (s?.kind === 'kill') return `Shock: #${s.spore}'s agent is killed`;
  return `Shock: ${JSON.stringify(s)}`;
}

export interface BuildInput {
  decisions: string | null;
  events: string | null;
  startEpoch: number | null;
  router: string | null;
  sale?: SaleInfo | null;
  tubesAt?: Map<number, Map<PairKey, number>>;
  palettes?: Map<number, number>;
}

/** A run log → rows. `events` and `decisions` are the two files' text; null when the run doesn't have the file. */
export function buildActivity(input: BuildInput): Activity {
  const tubesAt = input.tubesAt ?? new Map<number, Map<PairKey, number>>();
  const rows: ActivityRow[] = [];
  const missing: string[] = [];
  if (input.decisions === null) missing.push('decisions.jsonl');
  if (input.events === null) missing.push('events.jsonl');
  const decisionLines = readLines(input.decisions ?? '', 'decisions.jsonl');
  const eventLines = readLines(input.events ?? '', 'events.jsonl');

  // Decisions first: settle and refund rows take their pair and price from them.
  const decisions = new Map<number, Decision>();
  let matches = 0;
  let tubeWins = 0;
  let maxQuote = 0n;
  let maxD = 0;
  for (const l of decisionLines) {
    if (l.value === undefined) {
      rows.push(unreadable(l, 'not JSON'));
      continue;
    }
    const d = readDecision(l.value);
    if (typeof d === 'string') {
      rows.push(unreadable(l, d));
      continue;
    }
    decisions.set(d.job_id, d);
    if (recompute(d).status === 'matches') matches++;
    if (tubeBeatCheaper(d)) tubeWins++;
    for (const c of d.candidates) {
      if (BigInt(c.price) > maxQuote) maxQuote = BigInt(c.price);
      maxD = Math.max(maxD, Number(c.d));
    }
    const win = d.candidates.find((c) => c.provider === d.winner);
    const verb = hireVerb(d);
    const mark = outcomeMark(d.outcome);
    rows.push({
      key: `d:${d.job_id}:${l.line}`,
      kind: 'decision',
      at: Date.parse(d.at),
      epoch: d.epoch,
      spores: [d.consumer, ...d.candidates.map((c) => c.provider)],
      outcome: d.outcome,
      tx: d.tx.settle ?? d.tx.reject ?? d.tx.accept ?? d.tx.post ?? null,
      summary: [verb, d.service, win && formatNear(win.price), d.attempt ? `retry ${d.attempt}` : null].filter(Boolean).join(' · '),
      glyph: '◆',
      tone: 'agent',
      word: mark.word,
      pair: win ? ordered(d.consumer, win.provider) : null,
      decision: d,
      raw: [{ where: `decisions.jsonl:${l.line}`, text: l.text }],
    });
  }

  // Events, oldest first, so each knows its epoch and the operator at the time.
  const events: { e: RawEvent & Record<string, any>; l: LogLine; at: number }[] = [];
  for (const l of eventLines) {
    if (l.value === undefined) {
      rows.push(unreadable(l, 'not JSON'));
      continue;
    }
    const e = l.value as RawEvent;
    const at = Date.parse(e?.at);
    if (!e || typeof e !== 'object' || !Number.isFinite(at) || typeof e.kind !== 'string') {
      rows.push(unreadable(l, 'no valid `at` or `kind`'));
      continue;
    }
    events.push({ e, l, at });
  }
  events.sort((a, b) => a.at - b.at || a.l.line - b.l.line);

  // Pairs and prices for job txs from the whole log (a quote is logged before the hire that names its consumer).
  const hire = new Map<number, { consumer: number; provider: number }>();
  const quoted = new Map<string, string>();
  const jobLines = new Map<number, RawEvent[]>();
  const postLines = new Map<string, RawEvent>();
  for (const { e } of events) {
    if (e.kind !== 'tx' || !e.method || !JOB_METHODS.has(e.method)) continue;
    if (e.method === 'post_job' && e.hash) postLines.set(e.hash, e);
    const job = e.args?.job_id;
    if (typeof job !== 'number') continue;
    (jobLines.get(job) ?? jobLines.set(job, []).get(job)!).push(e);
    if (e.ok && e.method === 'accept' && asSpore(e.spore) !== null) hire.set(job, { consumer: e.spore as number, provider: e.args!.provider_id });
    if (e.ok && e.method === 'quote') quoted.set(`${job}:${e.args!.spore_id}`, String(e.args!.price));
  }
  const pairOfJob = (job: number) => {
    const d = decisions.get(job);
    if (d && d.winner !== null) return { consumer: d.consumer, provider: d.winner };
    return hire.get(job) ?? null;
  };
  const priceOfJob = (job: number) => {
    const p = pairOfJob(job);
    if (!p) return undefined;
    return decisions.get(job)?.candidates.find((c) => c.provider === p.provider)?.price ?? quoted.get(`${job}:${p.provider}`);
  };
  const posts = new Set([...decisions.values()].map((d) => d.tx.post));

  // The sale's lines don't say which spore (spore:"sale"); the run report does, or the final `done` line (Reference C's known bug).
  const saleSpore = input.sale?.spore ?? events.map(({ e }) => (e.kind === 'done' ? asSpore(e.spore) : null)).find((s) => s !== null) ?? null;

  let epoch = input.startEpoch;
  const operator = new Map<number, string>();
  let inTimelines = 0;
  let withoutDecision = 0;
  const closeRows: { row: ActivityRow; closed: number }[] = [];
  /** Pairs paid by an explicit settle, per log-timed epoch: what `flows` should list for that close. */
  const settledPairs = new Map<number, Set<PairKey>>();

  for (const { e, l, at } of events) {
    const me = asSpore(e.spore);
    const a = (e.args ?? {}) as Record<string, any>;
    const key = `e:${l.line}`;
    const raw = [{ where: `events.jsonl:${l.line}`, text: l.text }];
    const base = { key, at, epoch, raw, outcome: null as string | null, pair: null as [number, number] | null, spores: me !== null ? [me] : ([] as number[]) };
    if (e.kind === 'start' && me !== null && typeof e.operator === 'string') operator.set(me, e.operator);

    if (e.kind !== 'tx') {
      // An abnormal exit is not routine: it keeps a row of its own.
      const note = e.kind === 'exit' && e.code ? undefined : NOTES[e.kind];
      if (note) {
        const spores = me !== null ? [me] : asSpore(a.spore_id) !== null ? [a.spore_id] : [];
        rows.push({ ...base, spores, kind: 'lifecycle', tx: null, summary: `${actor(e.spore)} ${e.kind}`, glyph: '◌', tone: 'muted', word: null, note });
        continue;
      }
      const who = actor(e.spore);
      const known: Record<string, Pick<ActivityRow, 'summary' | 'glyph' | 'tone' | 'word'>> = {
        killed: { summary: `${who} agent killed`, glyph: '✕', tone: 'warn', word: 'Killed' },
        idle: { summary: `${who} idle: ${e.reason ?? 'no reason logged'}`, glyph: '!', tone: 'caution', word: 'Idle' },
        resumed: { summary: `${who} resumed`, glyph: '◆', tone: 'agent', word: 'Resumed' },
        priced_out: { summary: `${who} priced out of job ${e.job_id ?? '?'}`, glyph: '◌', tone: 'muted', word: null },
        shock: { summary: shockText(e.shock), glyph: '!', tone: 'caution', word: 'Shock' },
        error: { summary: `${who}: ${e.err ?? 'error'}`, glyph: '✕', tone: 'warn', word: 'Error' },
        exit: { summary: `${e.name ?? who} exited with code ${e.code}`, glyph: '✕', tone: 'warn', word: 'Exited' },
      };
      const k = known[e.kind] ?? { summary: `${who} ${e.kind}`, glyph: '◌', tone: 'muted' as Tone, word: null };
      const spores = e.kind === 'shock' ? [e.shock?.spore, e.shock?.a, e.shock?.b].filter((s) => asSpore(s) !== null) : base.spores;
      rows.push({ ...base, spores, kind: 'lifecycle', tx: null, ...k });
      continue;
    }

    const method = e.method ?? 'tx';
    const hash = e.hash ?? null;
    const job: number | undefined = typeof a.job_id === 'number' ? a.job_id : undefined;
    const sender = me !== null ? (operator.get(me) ?? null) : e.spore === 'sale' ? (method === 'list' ? (input.sale?.seller ?? null) : (input.sale?.buyer ?? null)) : null;
    const subject = me ?? asSpore(a.spore_id) ?? (e.spore === 'sale' ? saleSpore : null);
    const logged = { evidence: 'logged' as const, tx: hash ?? '', epoch: null, from: null, to: null };
    const common = { ...base, tx: hash, sender, loggedOk: !!e.ok };

    if (!e.ok) {
      const panic = String(e.err ?? '').startsWith(PANIC);
      const text = errorText(e.err);
      const pair = job !== undefined ? pairOfJob(job) : null;
      rows.push({
        ...common,
        spores: [subject, ...(pair ? [pair.consumer, pair.provider] : [])].filter((s): s is number => s !== null),
        kind: 'refusal',
        summary: `${panic ? 'Refused by the contract' : 'Tx failed'}: ${subject !== null ? `#${subject} ` : ''}${method}${typeof e.step === 'string' ? ` (${e.step})` : ''}`,
        glyph: '✕',
        tone: 'warn',
        word: panic ? 'Refused' : 'Failed',
        receipt: hash ? { ...logged, kind: panic ? 'refusal' : 'failed', event: method, error: text } : undefined,
      });
      if (job !== undefined && JOB_METHODS.has(method)) decisions.has(job) ? inTimelines++ : withoutDecision++;
      continue;
    }

    if (method === 'settle' || method === 'reject' || method === 'timeout_job') {
      const pair = job !== undefined ? pairOfJob(job) : null;
      const price = job !== undefined ? priceOfJob(job) : undefined;
      const spores = pair ? [pair.consumer, pair.provider] : base.spores;
      const tube = pair ? ordered(pair.consumer, pair.provider) : null;
      const who = pair ? `#${pair.consumer} paid #${pair.provider}` : `Job ${job}`;
      if (job !== undefined) decisions.has(job) ? inTimelines++ : withoutDecision++;
      if (method === 'settle' || (method === 'timeout_job' && a.status === 'Delivered')) {
        const auto = method === 'timeout_job';
        if (!auto && tube && epoch !== null) (settledPairs.get(epoch) ?? settledPairs.set(epoch, new Set()).get(epoch)!).add(pairKey(tube[0], tube[1]));
        rows.push({
          ...common,
          spores,
          pair: tube,
          kind: 'settlement',
          outcome: 'settled',
          summary: [who, price && formatNear(price), auto ? 'at the deadline' : null].filter(Boolean).join(' · '),
          glyph: '✓',
          tone: 'growth',
          word: auto ? 'Auto-settled' : 'Settled',
          receipt: { ...logged, kind: 'settlement', event: method, from: pair?.consumer ?? null, to: pair?.provider ?? null, amount: price, auto },
        });
      } else if (method === 'reject') {
        rows.push({
          ...common,
          spores,
          pair: tube,
          kind: 'refund',
          outcome: 'rejected',
          summary: pair ? `#${pair.consumer} rejected #${pair.provider}'s delivery · refunded` : `Job ${job} rejected · refunded`,
          glyph: '✕',
          tone: 'warn',
          word: 'Rejected',
          receipt: { ...logged, kind: 'refund', event: method, from: pair?.consumer ?? null, to: pair?.provider ?? null, amount: price, reason: 'rejected' },
        });
      } else {
        const consumer = job !== undefined ? decisions.get(job)?.consumer : undefined;
        rows.push({
          ...common,
          spores: consumer !== undefined ? [consumer, ...spores] : spores,
          pair: tube,
          kind: 'refund',
          outcome: 'timeout',
          summary: `Job ${job} timed out${a.status ? ` while ${String(a.status).toLowerCase()}` : ''}`,
          glyph: '○',
          tone: 'muted',
          word: 'Timed out',
          receipt: { ...logged, kind: 'refund', event: method, from: pair?.consumer ?? null, to: pair?.provider ?? null, reason: 'timeout' },
        });
      }
      continue;
    }

    if (JOB_METHODS.has(method)) {
      // post, quote, accept and deliver: steps of a job, shown in its decision's timeline.
      const has = method === 'post_job' ? posts.has(hash ?? undefined) : job !== undefined && decisions.has(job);
      has ? inTimelines++ : withoutDecision++;
      continue;
    }

    if (method === 'close_epoch') {
      if (typeof e.closed === 'number') {
        const closed: number = e.closed;
        const fingerprint = typeof e.fingerprint === 'string' ? e.fingerprint : undefined;
        const row: ActivityRow = {
          ...common,
          epoch: closed,
          kind: 'close',
          summary: '',
          glyph: '◷',
          tone: 'slime',
          word: 'Closed',
          receipt: { ...logged, kind: 'close', event: 'close_epoch', epoch: closed, fingerprint, tubes: tubesAt.get(closed)?.size ?? null },
        };
        rows.push(row);
        closeRows.push({ row, closed });
        epoch = closed + 1;
      } else {
        rows.push({ ...common, kind: 'close', summary: 'close_epoch sent', glyph: '◷', tone: 'slime', word: null, receipt: hash ? { ...logged, kind: 'other', event: method } : undefined });
      }
      continue;
    }

    if (method === 'commit_image') {
      const hashOf = typeof a.image_hash === 'string' ? a.image_hash : undefined;
      rows.push({
        ...common,
        spores: asSpore(a.spore_id) !== null ? [a.spore_id] : [],
        kind: 'image',
        summary: `#${a.spore_id} image committed · epoch ${a.epoch}${hashOf ? ` · ${shortHash(hashOf)}` : ''}`,
        glyph: '◎',
        tone: 'growth',
        word: 'Committed',
        receipt: { ...logged, kind: 'image', event: method, epoch: typeof a.epoch === 'number' ? a.epoch : null, spore: a.spore_id, imageHash: hashOf },
      });
      continue;
    }

    if (method === 'pay_service') {
      rows.push({
        ...common,
        spores: subject !== null ? [subject] : [],
        kind: 'settlement',
        summary: `#${subject} paid ${a.payee} · ${a.amount ? formatNear(String(a.amount)) : '—'}`,
        glyph: '✓',
        tone: 'value',
        word: 'Paid',
        receipt: { ...logged, kind: 'service', event: method, from: subject, payee: a.payee, amount: a.amount ? String(a.amount) : undefined, memo: a.memo },
      });
      continue;
    }

    if (method === 'list' || method === 'delist' || method === 'buy' || e.spore === 'sale') {
      const sold = method === 'buy';
      const price = sold || method === 'list' ? input.sale?.price : undefined;
      const words: Record<string, string> = { list: 'listed', delist: 'delisted', buy: 'sold' };
      const name = subject !== null ? `#${subject}` : 'Spore';
      const text = words[method] ? `${name} ${words[method]}` : `${name}: ${typeof e.step === 'string' ? e.step : method}`;
      rows.push({
        ...common,
        spores: subject !== null ? [subject] : [],
        kind: 'market',
        summary: [text, price && formatNear(price), sold && input.sale?.buyer ? `to ${input.sale.buyer}` : null].filter(Boolean).join(' · '),
        glyph: '⇄',
        tone: 'value',
        word: sold ? 'Sold' : method === 'list' ? 'Listed' : null,
        receipt: { ...logged, kind: sold ? 'sale' : 'market', event: method, spore: subject ?? undefined, amount: price, seller: input.sale?.seller, buyer: sold ? input.sale?.buyer : undefined },
      });
      continue;
    }

    rows.push({ ...common, kind: 'lifecycle', summary: `${actor(e.spore)} ${method}`, glyph: '◌', tone: 'muted', word: null, receipt: hash ? { ...logged, kind: 'other', event: method } : undefined });
  }

  // Close rows now that the epoch's settles are counted. The flow count is derived from log timing until the receipt is fetched.
  for (const { row, closed } of closeRows) {
    const flows = settledPairs.get(closed)?.size ?? 0;
    const r = row.receipt!;
    row.receipt = { ...r, flows, flowsDerived: true };
    row.summary = closeSummary(closed, `≈ ${flows}`, r.tubes ?? null, r.fingerprint);
  }

  return {
    mode: 'log',
    rows,
    tubesAt,
    jobLines,
    postLines,
    palettes: input.palettes ?? new Map(),
    router: input.router,
    stats: { decisionLines: decisionLines.length, eventLines: eventLines.length, inTimelines, withoutDecision, matches, decisions: decisions.size, tubeWins, maxQuote: maxQuote.toString(), maxD },
    missing,
  };
}

function closeSummary(epoch: number, flows: string | number, tubes: number | null, fingerprint?: string): string {
  return [`Epoch ${epoch} closed`, `${flows} ${flows === 1 ? 'flow' : 'flows'}`, `${tubes ?? '—'} ${tubes === 1 ? 'tube' : 'tubes'}`, fingerprint && shortHash(fingerprint)].filter(Boolean).join(' · ');
}

/** LIVE: a close event the app read itself is the whole row (Design §6.E live-only mode). */
export function closeRow(ev: EpochClosed, tx: string): ActivityRow {
  return {
    key: `c:${ev.epoch}`,
    kind: 'close',
    at: null,
    epoch: ev.epoch,
    spores: ev.active,
    outcome: null,
    tx,
    summary: closeSummary(ev.epoch, ev.flows.length, ev.edges, ev.fingerprint),
    glyph: '◷',
    tone: 'slime',
    word: 'Closed',
    pair: null,
    receipt: closeReceipt(ev, tx),
    raw: [{ where: 'epoch_closed event', text: JSON.stringify(ev) }],
  };
}

export function emptyActivity(mode: Activity['mode'], router: string | null, rows: ActivityRow[] = []): Activity {
  return {
    mode,
    rows,
    tubesAt: new Map(),
    jobLines: new Map(),
    postLines: new Map(),
    palettes: new Map(),
    router,
    stats: { decisionLines: 0, eventLines: 0, inTimelines: 0, withoutDecision: 0, matches: 0, decisions: 0, tubeWins: 0, maxQuote: '0', maxD: 0 },
    missing: [],
  };
}

// --- a job's steps ----------------------------------------------------------

/** Post → quotes → accept → deliver → settle or reject (Design §6.E part 5), from the job's own log lines. */
export function jobSteps(d: Decision, a: Pick<Activity, 'jobLines' | 'postLines'>): JobStep[] {
  const lines = a.jobLines.get(d.job_id) ?? [];
  const steps: JobStep[] = [];
  const fromLine = (key: string, label: string, e: RawEvent & Record<string, any>, amount?: string): JobStep => ({
    key,
    label,
    state: e.ok ? 'ok' : 'failed',
    err: e.ok ? undefined : errorText(e.err),
    at: Date.parse(e.at),
    tx: e.hash,
    amount,
  });
  const by = (m: string) => lines.filter((e) => e.method === m);
  const win = d.candidates.find((c) => c.provider === d.winner);

  const post = d.tx.post ? a.postLines.get(d.tx.post) : undefined;
  steps.push(post ? fromLine('post', `#${d.consumer} posts job ${d.job_id}`, post) : { key: 'post', label: `#${d.consumer} posts job ${d.job_id}`, state: 'ok', tx: d.tx.post });

  for (const q of by('quote')) {
    const p = q.args?.spore_id ?? q.spore;
    const step = fromLine(`quote:${q.hash}`, `#${p} quotes`, q, q.args?.price !== undefined ? String(q.args.price) : undefined);
    steps.push(q.ok && !d.candidates.some((c) => c.provider === p) ? { ...step, note: 'Not a candidate: this quote isn’t among those the agent chose from.' } : step);
  }

  const acceptLines = by('accept');
  const pickLabel = `#${d.consumer} accepts${d.winner !== null ? ` #${d.winner}` : ''}`;
  if (acceptLines.length) {
    for (const e of acceptLines) steps.push(fromLine(`accept:${e.hash}`, pickLabel, e, win?.price));
  } else if (d.tx.accept) {
    steps.push({ key: 'accept', label: pickLabel, state: d.outcome === 'accept_failed' ? 'failed' : 'ok', err: d.outcome === 'accept_failed' ? errorText(d.err) : undefined, tx: d.tx.accept, amount: win?.price });
  } else {
    const price = win ? formatNear(win.price) : 'the quote';
    const note =
      d.outcome === 'over_budget' && d.budget_left !== undefined
        ? `Not sent: the agent read budget left ${formatNear(d.budget_left)}, under ${price}. The router enforces the same limit.`
        : d.outcome === 'low_balance' && d.balance !== undefined
          ? `Not sent: the agent read a balance of ${formatNear(d.balance)}, under ${price}. The router enforces the same limit.`
          : 'Not sent, per the log.';
    steps.push({ key: 'accept', label: pickLabel, state: 'skipped', note });
  }

  for (const e of by('deliver')) steps.push(fromLine(`deliver:${e.hash}`, `#${e.spore} delivers`, e));

  for (const e of by('settle')) steps.push(fromLine(`settle:${e.hash}`, `#${d.consumer} settles`, e, win?.price));
  for (const e of by('reject')) {
    const why = d.cut ? 'Rejected: this pair was cut by a shock.' : d.correct === false ? 'Rejected: the delivered answer failed the check.' : undefined;
    steps.push({ ...fromLine(`reject:${e.hash}`, `#${d.consumer} rejects`, e), note: why });
  }
  for (const e of by('timeout_job')) {
    const note = e.args?.status === 'Delivered' ? 'Delivered and not settled by the deadline: paid minus the fee, with no flow.' : 'Refunded at the deadline.';
    steps.push({ ...fromLine(`timeout:${e.hash}`, 'Keeper times the job out', e), note });
  }
  // A terminal tx the decision names but the event log doesn't have.
  for (const [m, tx] of [['settle', d.tx.settle], ['reject', d.tx.reject]] as const) {
    if (tx && !by(m).some((e) => e.hash === tx)) {
      const failed = d.outcome === `${m}_failed`;
      steps.push({ key: `${m}:log`, label: `#${d.consumer} ${m === 'settle' ? 'settles' : 'rejects'}`, state: failed ? 'failed' : 'ok', err: failed ? errorText(d.err) : undefined, tx, amount: m === 'settle' ? win?.price : undefined });
    }
  }
  return steps;
}

export type RailState = 'ok' | 'failed' | 'skipped' | 'none';
export interface RailStage {
  key: string;
  word: string;
  state: RailState;
}

/** The job's steps as the four stages before its outcome (the Network's loop rail, for one job). */
export function jobRail(d: Decision, steps: JobStep[]): RailStage[] {
  const stage = (key: string, word: string, prefix: string): RailStage => {
    const of = steps.filter((s) => s.key.startsWith(prefix));
    const state: RailState = !of.length ? 'none' : of.some((s) => s.state === 'ok') ? 'ok' : of.some((s) => s.state === 'failed') ? 'failed' : 'skipped';
    return { key, word, state };
  };
  const quote = stage('quote', 'Quote', 'quote');
  // The decision's candidates are quotes, even when the event log has no line for them.
  if (quote.state === 'none' && d.candidates.length) quote.state = 'ok';
  return [stage('post', 'Post', 'post'), quote, stage('hire', 'Hire', 'accept'), stage('deliver', 'Deliver', 'deliver')];
}

// --- filters ----------------------------------------------------------------

export interface ActivityFilter {
  spore: number | null;
  from: number | null;
  to: number | null;
  kinds: ActivityKind[];
  outcome: string | null;
  /** Only decisions where a tube beat a cheaper quote. */
  tube?: boolean;
}

const intParam = (v: string | null) => (v !== null && /^\d{1,9}$/.test(v) ? Number(v) : null);

/** `?spore=&from=&to=&kind=a,b&outcome=`; `?epoch=N` is `from = to = N` (Design §5.1). */
export function parseFilter(q: URLSearchParams): ActivityFilter {
  const one = intParam(q.get('epoch'));
  const known = new Set<string>(KINDS.map((k) => k.kind));
  return {
    spore: intParam(q.get('spore')),
    from: intParam(q.get('from')) ?? one,
    to: intParam(q.get('to')) ?? one,
    kinds: (q.get('kind') ?? '').split(',').filter((k): k is ActivityKind => known.has(k)),
    outcome: q.get('outcome') || null,
    tube: q.get('tube') === '1' ? true : undefined,
  };
}

/** Writes the filter onto `q`, leaving other params (the source) alone. */
export function writeFilter(q: URLSearchParams, f: ActivityFilter): URLSearchParams {
  const out = new URLSearchParams(q);
  out.delete('epoch');
  const put = (k: string, v: string | number | null) => (v === null || v === '' ? out.delete(k) : out.set(k, String(v)));
  put('spore', f.spore);
  put('from', f.from);
  put('to', f.to);
  put('kind', f.kinds.join(','));
  put('outcome', f.outcome);
  put('tube', f.tube ? 1 : null);
  return out;
}

export type ActivityView = 'decisions' | 'log';

/** Decisions by default; `?view=log`, or a `kind` (which only the log can show), opens the full log. */
export const parseView = (q: URLSearchParams): ActivityView => (q.get('view') === 'log' || q.has('kind') ? 'log' : 'decisions');

/** The URL of a view: the other filters and the source stay. */
export function writeView(q: URLSearchParams, view: ActivityView): URLSearchParams {
  const out = new URLSearchParams(q);
  if (view === 'log') {
    out.set('view', 'log');
    out.delete('tube');
  } else {
    out.delete('view');
    out.delete('kind');
  }
  return out;
}

export const activeFilters = (f: ActivityFilter) => (f.spore !== null ? 1 : 0) + (f.from !== null || f.to !== null ? 1 : 0) + (f.kinds.length ? 1 : 0) + (f.outcome ? 1 : 0) + (f.tube ? 1 : 0);

/** Unreadable rows pass every filter: a broken line never hides behind one. */
export function filterRows(rows: ActivityRow[], f: ActivityFilter): ActivityRow[] {
  return rows.filter((r) => {
    if (r.kind === 'unreadable') return true;
    if (f.spore !== null && !r.spores.includes(f.spore)) return false;
    if (f.from !== null && (r.epoch === null || r.epoch < f.from)) return false;
    if (f.to !== null && (r.epoch === null || r.epoch > f.to)) return false;
    if (f.kinds.length && !f.kinds.includes(r.kind)) return false;
    if (f.outcome && r.outcome !== f.outcome) return false;
    if (f.tube && !(r.decision && tubeBeatCheaper(r.decision))) return false;
    return true;
  });
}

export function kindCounts(rows: ActivityRow[]): Map<RowKind, number> {
  const m = new Map<RowKind, number>();
  for (const r of rows) m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
  return m;
}

// --- grouping ---------------------------------------------------------------

export interface EpochGroup {
  key: string;
  /** null: the unreadable lines, or rows the source can't date. */
  epoch: number | null;
  unreadable: boolean;
  /** The epoch's close, even when filters hide its row: the header reads it. */
  close: ActivityRow | null;
  rows: ActivityRow[];
}

function mergeNotes(rows: ActivityRow[], epoch: number | null): ActivityRow[] {
  const notes = rows.filter((r) => r.note);
  if (notes.length < 2) return rows;
  const counts = new Map<[string, string], number>();
  for (const n of notes) counts.set(n.note!, (counts.get(n.note!) ?? 0) + 1);
  const merged: ActivityRow = {
    ...notes[notes.length - 1],
    key: `notes:${epoch}`,
    at: Math.max(...notes.map((n) => n.at ?? 0)),
    spores: [...new Set(notes.flatMap((n) => n.spores))],
    summary: [...counts].map(([[one, many], n]) => `${n} ${n === 1 ? one : many}`).join(' · '),
    raw: notes.flatMap((n) => n.raw),
  };
  const rest = rows.filter((r) => !r.note);
  return [...rest, merged];
}

/** Newest epoch first, newest row first; unreadable lines on top. */
export function groupRows(filtered: ActivityRow[], all: ActivityRow[]): EpochGroup[] {
  const closes = new Map(all.filter((r) => r.kind === 'close' && r.epoch !== null).map((r) => [r.epoch as number, r]));
  const bad = filtered.filter((r) => r.kind === 'unreadable');
  const byEpoch = new Map<number | null, ActivityRow[]>();
  for (const r of filtered) {
    if (r.kind === 'unreadable') continue;
    (byEpoch.get(r.epoch) ?? byEpoch.set(r.epoch, []).get(r.epoch)!).push(r);
  }
  const groups: EpochGroup[] = [];
  if (bad.length) groups.push({ key: 'unreadable', epoch: null, unreadable: true, close: null, rows: bad });
  const epochs = [...byEpoch.keys()].sort((a, b) => (b ?? -1) - (a ?? -1));
  for (const e of epochs) {
    const rows = mergeNotes(byEpoch.get(e)!, e).sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || b.key.localeCompare(a.key, undefined, { numeric: true }));
    groups.push({ key: `e${e}`, epoch: e, unreadable: false, close: e === null ? null : (closes.get(e) ?? null), rows });
  }
  return groups;
}

// --- the window of rows to render -------------------------------------------

export interface GroupWindow {
  from: number;
  to: number;
  /** Space standing in for the rows above and below the window. */
  top: number;
  bottom: number;
}

/**
 * Which rows of each group are near the viewport (`viewTop`..`viewBottom`, px
 * from the list's top). Group headers always render, so sticky headers work
 * natively; only rows are windowed. Pure, so it's tested without layout.
 */
export function windowRows(groups: { key: string; rows: { key: string }[] }[], heightOf: (key: string) => number, headerH: number, viewTop: number, viewBottom: number): Map<string, GroupWindow> {
  const out = new Map<string, GroupWindow>();
  let y = 0;
  for (const g of groups) {
    y += headerH;
    let from = -1;
    let to = -1;
    let top = 0;
    let bottom = 0;
    g.rows.forEach((r, i) => {
      const h = heightOf(r.key);
      const start = y;
      y += h;
      if (y <= viewTop) {
        top += h;
      } else if (start >= viewBottom) {
        bottom += h;
      } else {
        if (from < 0) from = i;
        to = i + 1;
      }
    });
    // Nothing visible: everything is one spacer, above or below this window.
    out.set(g.key, from < 0 ? { from: 0, to: 0, top: top + bottom, bottom: 0 } : { from, to, top, bottom });
  }
  return out;
}
