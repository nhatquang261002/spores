// Demo Lab scene logs (S11): `scene.jsonl`, one line per real event from
// agents/src/scenes/rogue.ts, the same lines live over SSE and from a
// recording. Everything on the scene page is built from these by `buildScene`,
// a pure function of the lines seen so far: the stage, the lanes, the strip and
// the verdict can't disagree, and a seek is just fewer lines.
import { formatNear } from '../ui/format';
import type { RenderInput } from '../wasm/renderer';

export type ActKey = 'limits' | 'cap' | 'budget' | 'drain' | 'quiet' | 'cleanup';
export type AttemptKey = 'cap' | 'budget' | 'drain';

export const ACTS: { key: ActKey; word: string }[] = [
  { key: 'limits', word: 'Owner sets limits' },
  { key: 'cap', word: 'Over the cap' },
  { key: 'budget', word: 'Over budget' },
  { key: 'drain', word: 'To an attacker' },
  { key: 'quiet', word: 'Agent goes quiet' },
  { key: 'cleanup', word: 'Verdict' },
];

export const ATTEMPTS: { key: AttemptKey; title: string; plan: string }[] = [
  { key: 'cap', title: 'Pay above the per-payment cap', plan: 'The agent accepts a quote bigger than one payment may be.' },
  { key: 'budget', title: 'Spend past the epoch budget', plan: 'Each payment is small enough. Together they are not.' },
  { key: 'drain', title: 'Pay an account the owner never approved', plan: 'Small enough, but to the wrong place.' },
];

export type SceneLine = Record<string, any> & { type: string };

export interface PeerArt extends RenderInput {
  id: number;
}

export interface SceneStart {
  scene: string;
  run: string;
  router: string;
  spore: number;
  provider: number;
  attacker: string;
  owner: string;
  operator: string;
  limits: { max_payment: string; budget_per_epoch: string };
  d_min: string;
  decay_bps: number;
  peers: PeerArt[];
}

export interface SceneStep {
  id: string;
  act: ActKey;
  attempt?: AttemptKey;
  actor: string;
  method: string;
  action: string;
  amount?: string;
  /** `ok`, or the exact contract error this step must fail with. */
  expected: string;
  at: string;
  state: 'pending' | 'ok' | 'failed';
  tx?: string;
  err?: string;
  args?: Record<string, any>;
}

/** Who did a step, in a visitor's words: anyone may send what the keeper sends. */
export const actorWord = (actor: string) => (actor === 'keeper' ? 'anyone' : actor);

/** A step's action in a visitor's words: no method names, no repeating who did it. */
export function stepWords(s: Pick<SceneStep, 'actor' | 'action'>): string {
  const a = s.action
    .replace(/^operator key called accept again$/, 'tries to pay again')
    .replace(/^operator key called accept$/, 'tries to pay')
    .replace(/^operator key called pay_service$/, 'tries to pay an outside account');
  const who = actorWord(s.actor);
  const said = a.toLowerCase().startsWith(`${who} `) ? a.slice(who.length + 1) : a;
  return said.charAt(0).toUpperCase() + said.slice(1);
}

export interface SceneTry extends SceneStep {
  /** What the contract did, whether or not the script expected it. */
  decision: 'pending' | 'refused' | 'allowed';
  /** The chain did not do what this step expected. */
  unexpected: boolean;
}

export interface SceneAttempt {
  key: AttemptKey;
  title: string;
  plan: string;
  tries: SceneTry[];
}

export interface SceneSnapshot {
  label: string;
  epoch: number;
  balance: string;
  reputation: string;
  connections: [number, string][];
  spent: string;
  policy: Record<string, any>;
  art: PeerArt;
}

export interface DecayPlate {
  mark: string;
  epoch: number;
  reputation: string;
  tubes: [number, string][];
  /** Tubes the earlier plate had and this one doesn't: below d_min, removed at the close. */
  removed: number[];
  art: PeerArt;
  /** The close that made this plate; null for N. */
  close: { epoch: number; tx: string | null; fingerprint: string | null } | null;
}

export interface SceneCheck {
  n: number;
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
  tx?: string;
}

export type SceneStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface SceneVerdict {
  status: SceneStatus;
  /** The one verdict line (Design §6.H); null until it's known. */
  line: string | null;
  failed: SceneCheck | null;
}

export type Beat =
  | { kind: 'none' }
  | { kind: 'setup' }
  | { kind: 'limits' }
  | { kind: 'reach'; attempt: AttemptKey; index: number; step: SceneTry }
  | { kind: 'decided'; attempt: AttemptKey; index: number; step: SceneTry }
  | { kind: 'quiet' }
  | { kind: 'wait'; what: string; seconds: number }
  | { kind: 'closed'; epoch: number; from: string; to: string }
  | { kind: 'cleanup' }
  | { kind: 'end' };

export interface SceneState {
  start: SceneStart | null;
  act: ActKey | null;
  steps: SceneStep[];
  attempts: SceneAttempt[];
  snapshots: SceneSnapshot[];
  plates: DecayPlate[];
  checks: SceneCheck[];
  /** The snapshot taken before anything moved. */
  before: SceneSnapshot | null;
  now: SceneSnapshot | null;
  /** The owner's limits are set on chain. */
  limitsSet: boolean;
  /** The allowed payment, while the price sits in escrow. */
  escrow: { amount: string; job: number } | null;
  /** Closes seen so far; a rise is a confirmed close. */
  closes: number;
  beat: Beat;
  verdict: SceneVerdict;
  /** Lines that were not JSON, shown as they are. */
  bad: string[];
  /** A line that means the script died (`fatal`, or a note). */
  notes: string[];
  lines: number;
}

/** Each line of a log; a line that doesn't parse stays as `{type:'bad'}`. */
export function parseSceneLog(text: string): SceneLine[] {
  const out: SceneLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    out.push(parseSceneLine(raw));
  }
  return out;
}

export function parseSceneLine(raw: string): SceneLine {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && typeof v.type === 'string') return v;
  } catch {
    // Falls through: a line we can't read stays visible.
  }
  return { type: 'bad', raw };
}

const isTry = (s: SceneStep) => !!s.attempt && (s.method === 'accept' || s.method === 'pay_service');

function toTry(s: SceneStep): SceneTry {
  const decision = s.state === 'pending' ? 'pending' : s.state === 'ok' ? 'allowed' : 'refused';
  const unexpected = s.state !== 'pending' && (s.expected === 'ok' ? s.state !== 'ok' : s.state === 'ok' || s.err !== s.expected);
  return { ...s, decision, unexpected };
}

export function verdictOf(lines: SceneLine[], checks: SceneCheck[], fatal: string | null): SceneVerdict {
  const done = lines.find((l) => l.type === 'done');
  const exit = lines.find((l) => l.type === 'exit');
  if (!lines.length) return { status: 'idle', line: null, failed: null };
  const failed = checks.find((c) => !c.ok) ?? null;
  const reason = () => {
    if (failed) return `Failed at check ${failed.n}: expected ${failed.expected}, got ${failed.actual}`;
    if (fatal) return `Failed: ${fatal}`;
    if (exit && exit.code !== 0) return `Failed: the script exited with code ${exit.code}${exit.signal ? ` (${exit.signal})` : ''}`;
    if (done && !done.ok) return 'Failed: the script reports a failure and no check says which';
    if (exit && !done) return 'Failed: the script exited before it finished';
    return null;
  };
  const why = reason();
  // A failed check or a dead script is final at once; "completed" waits for the real exit code.
  if (why) return { status: 'failed', line: why, failed };
  if (!exit) return { status: 'running', line: null, failed: null };
  return { status: 'completed', line: `Completed: ${checks.length} of ${checks.length} checks passed`, failed: null };
}

/** Everything the page shows, from the lines so far. */
export function buildScene(lines: SceneLine[]): SceneState {
  const steps = new Map<string, SceneStep>();
  const attempts: SceneAttempt[] = ATTEMPTS.map((a) => ({ ...a, tries: [] }));
  const snapshots: SceneSnapshot[] = [];
  const plates: DecayPlate[] = [];
  const checks: SceneCheck[] = [];
  const bad: string[] = [];
  const notes: string[] = [];
  let start: SceneStart | null = null;
  let act: ActKey | null = null;
  let limitsSet = false;
  let escrow: SceneState['escrow'] = null;
  let closes = 0;
  let fatal: string | null = null;
  let beat: Beat = { kind: 'none' };
  let pendingClose: DecayPlate['close'] = null;

  const refreshTry = (s: SceneStep) => {
    if (!s.attempt || !isTry(s)) return null;
    const a = attempts.find((x) => x.key === s.attempt)!;
    const t = toTry(s);
    const i = a.tries.findIndex((x) => x.id === s.id);
    if (i >= 0) a.tries[i] = t;
    else a.tries.push(t);
    return { t, index: i >= 0 ? i : a.tries.length - 1 };
  };

  for (const l of lines) {
    switch (l.type) {
      case 'start':
        start = l as unknown as SceneStart;
        beat = { kind: 'setup' };
        break;
      case 'act':
        act = l.act;
        if (act === 'quiet') beat = { kind: 'quiet' };
        if (act === 'cleanup') beat = { kind: 'cleanup' };
        break;
      case 'step': {
        const s: SceneStep = { id: l.id, act: l.act, attempt: l.attempt, actor: l.actor, method: l.method, action: l.action, amount: l.amount, expected: l.expected, at: l.at, state: 'pending' };
        steps.set(s.id, s);
        const r = refreshTry(s);
        if (r) beat = { kind: 'reach', attempt: r.t.attempt!, index: r.index, step: r.t };
        break;
      }
      case 'result': {
        const s = steps.get(l.id);
        if (!s) break;
        Object.assign(s, { state: l.ok ? 'ok' : 'failed', tx: l.tx, err: l.err || undefined, args: l.args });
        const r = refreshTry(s);
        if (r) {
          beat = { kind: 'decided', attempt: r.t.attempt!, index: r.index, step: r.t };
          if (r.t.decision === 'allowed' && r.t.amount) escrow = { amount: r.t.amount, job: Number(l.args?.job_id) };
        }
        if (s.method === 'set_policy' && l.ok && s.act === 'limits') {
          limitsSet = true;
          beat = { kind: 'limits' };
        }
        if (s.method === 'set_policy' && l.ok && s.act === 'cleanup') limitsSet = false;
        if (s.method === 'timeout_job' && l.ok && escrow && Number(l.args?.job_id) === escrow.job) escrow = null;
        break;
      }
      case 'snapshot': {
        const snap: SceneSnapshot = { label: l.label, epoch: l.epoch, balance: l.balance, reputation: l.reputation, connections: l.connections ?? [], spent: l.spent, policy: l.policy, art: l.art };
        snapshots.push(snap);
        if (l.label === 'after_refusals' || l.label === 'close') {
          const prev = plates.at(-1);
          const ids = new Set(snap.connections.map(([n]) => n));
          plates.push({
            mark: plates.length === 0 ? 'N' : `N+${plates.length}`,
            epoch: snap.epoch,
            reputation: snap.reputation,
            tubes: snap.connections,
            removed: prev ? prev.tubes.map(([n]) => n).filter((n) => !ids.has(n)) : [],
            art: snap.art,
            close: l.label === 'close' ? pendingClose : null,
          });
          if (l.label === 'close' && prev) beat = { kind: 'closed', epoch: pendingClose?.epoch ?? snap.epoch - 1, from: prev.reputation, to: snap.reputation };
        }
        break;
      }
      case 'close':
        closes++;
        pendingClose = { epoch: l.epoch, tx: l.tx ?? null, fingerprint: l.fingerprint ?? null };
        break;
      case 'wait':
        beat = { kind: 'wait', what: l.what, seconds: l.seconds };
        break;
      case 'check':
        checks.push({ n: l.n, name: l.name, ok: l.ok, expected: l.expected, actual: l.actual, tx: l.tx });
        break;
      case 'fatal':
        fatal = l.error;
        break;
      case 'note':
        notes.push(l.note);
        break;
      case 'bad':
        bad.push(l.raw);
        break;
      default:
        break;
    }
  }

  const verdict = verdictOf(lines, checks, fatal);
  if (verdict.status === 'completed' || (verdict.status === 'failed' && lines.some((l) => l.type === 'exit' || l.type === 'done'))) beat = { kind: 'end' };
  return {
    start,
    act,
    steps: [...steps.values()],
    attempts,
    snapshots,
    plates,
    checks,
    before: snapshots.find((s) => s.label === 'before') ?? null,
    now: snapshots.at(-1) ?? null,
    limitsSet,
    escrow,
    closes,
    beat,
    verdict,
    bad,
    notes,
    lines: lines.length,
  };
}

export const repText = (r: string | number) => (Number(r) / 1000).toFixed(2);

/** The attempts' refusals so far, for the primary figure. */
export function refusalCount(s: SceneState): { refused: number; total: number } {
  const all = s.attempts.map((a) => a.tries.at(-1)).filter(Boolean) as SceneTry[];
  return { refused: all.filter((t) => t.decision === 'refused' && !t.unexpected).length, total: ATTEMPTS.length };
}

/** The narrator's line: what just happened, in one short sentence (Design §8.2). Every number is from the log. */
export function narrate(s: SceneState): string {
  const id = s.start ? `Spore #${s.start.spore}` : 'The spore';
  const b = s.beat;
  const lim = s.start?.limits;
  switch (b.kind) {
    case 'none':
    case 'setup':
      return `${id}’s owner is about to narrow its limits.`;
    case 'limits':
      return `The owner writes limits into the contract: ${formatNear(lim!.max_payment)} a payment, ${formatNear(lim!.budget_per_epoch)} an epoch.`;
    case 'reach': {
      const amount = b.step.amount ? formatNear(b.step.amount) : '';
      if (b.attempt === 'cap') return `Its agent tries to pay ${amount}. The cap is ${formatNear(lim!.max_payment)}.`;
      if (b.attempt === 'drain') return `Now ${amount} straight to an account the owner never approved.`;
      return b.index === 0 ? `Now ${amount}. That’s inside every limit.` : `Another ${amount}. That passes the ${formatNear(lim!.budget_per_epoch)} budget.`;
    }
    case 'decided':
      if (b.step.decision === 'allowed') return b.step.unexpected ? 'The contract let it through. It should have refused.' : 'Allowed. The limits stop overspending, not spending.';
      return b.step.unexpected ? 'Refused, but not for the expected reason.' : 'Refused by the contract.';
    case 'quiet':
      return 'Now the agent goes quiet. No settled work, so nothing feeds its tubes.';
    case 'wait':
      return `Waiting for ${b.what}.`;
    case 'closed':
      return `Epoch ${b.epoch} closed. Reputation ${repText(b.from)} → ${repText(b.to)}.`;
    case 'cleanup':
      return 'The escrowed payment comes back and the owner’s policy is restored.';
    case 'end':
      return s.verdict.status === 'completed' ? 'The agent had the key. The contract had the last word.' : 'This run failed. The reason is below.';
  }
}

// --- pacing -------------------------------------------------------------------

export type Pace = 'story' | 'real';

/**
 * How long a line stays before the next one, in story pace: long enough to read
 * what the line changed, with waits and setup squeezed. Real pace uses the
 * logged gaps. Every row still shows its real time either way.
 */
export function storyDelay(l: SceneLine): number {
  switch (l.type) {
    case 'start':
      return 1500;
    case 'act':
      return 500;
    case 'step':
      return l.attempt && (l.method === 'accept' || l.method === 'pay_service') ? 1200 : 200;
    case 'result':
      if (l.method === 'set_policy' && l.ok) return 2400;
      if (l.method === 'accept' || l.method === 'pay_service') return l.ok ? 2200 : 3200;
      return 180;
    case 'wait':
      return 1000;
    case 'snapshot':
      return l.label === 'close' ? 2800 : 80;
    case 'check':
      return 90;
    default:
      return 120;
  }
}

export type StoryDelay = (l: SceneLine) => number;

export function gapMs(prev: SceneLine | undefined, next: SceneLine, pace: Pace, delay: StoryDelay = storyDelay): number {
  if (!prev) return 0;
  if (pace === 'story') return delay(prev);
  const a = Date.parse(prev.at);
  const b = Date.parse(next.at);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : delay(prev);
}

/** Total playback time of a log at a pace, ms. */
export function durationMs(lines: SceneLine[], pace: Pace, delay: StoryDelay = storyDelay): number {
  return lines.reduce((sum, l, i) => sum + (i ? gapMs(lines[i - 1], l, pace, delay) : 0), 0);
}

/** First line of each act, for seeking. */
export function actStarts(lines: SceneLine[]): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = {};
  lines.forEach((l, i) => {
    if (l.type === 'act' && out[l.act] === undefined) out[l.act] = i;
  });
  return out;
}
