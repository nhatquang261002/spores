// The Sale scene's model (S12): `scene.jsonl` from agents/src/scenes/sale.ts, the
// same lines live over SSE and from a recording. Like `buildScene`, a pure
// function of the lines seen so far, so the stage, the label on the dish, the
// checklist and the verdict can't disagree. The owner changes here only when the
// `buy` tx's final outcome is in the log (Design §6.H).
import { formatNear, shortAccount, tubesText } from '../ui/format';
import { verdictOf, type PeerArt, type SceneCheck, type SceneLine, type SceneStep, type SceneVerdict } from './scene';

export type SaleActKey = 'listed' | 'sold' | 'lockout' | 'intact' | 'takeover';

export const SALE_ACTS: { key: SaleActKey; word: string }[] = [
  { key: 'listed', word: 'Listed' },
  { key: 'sold', word: 'Sold' },
  { key: 'lockout', word: 'Old hands out' },
  { key: 'intact', word: 'What it kept' },
  { key: 'takeover', word: 'New hands' },
];

/** The 11 checks, as numbered steps, each under the act it belongs to. A run's own words win once it has reported them. */
export const SALE_CHECKS: { n: number; act: SaleActKey; name: string }[] = [
  { n: 1, act: 'listed', name: 'The owner lists it at its price' },
  { n: 2, act: 'sold', name: 'The buy is final and the spore is the buyer’s' },
  { n: 3, act: 'sold', name: 'The seller was paid 95% (from the receipt)' },
  { n: 4, act: 'sold', name: 'The royalty account was paid 5% (from the receipt)' },
  { n: 5, act: 'sold', name: 'The chain logged spore_sold with those amounts' },
  { n: 6, act: 'lockout', name: 'The old agent’s key is refused' },
  { n: 7, act: 'lockout', name: 'The old owner is refused' },
  { n: 8, act: 'intact', name: 'It arrives locked: no operator, paused, zero budget' },
  { n: 9, act: 'intact', name: 'Balance, tubes and age came with it' },
  { n: 10, act: 'takeover', name: 'The buyer appoints its agent and sets a policy' },
  { n: 11, act: 'takeover', name: 'The new agent’s key works' },
];

export interface SaleStart {
  scene: string;
  run: string;
  router: string;
  spore: number;
  seller: string;
  buyer: string;
  royalty_account: string;
  royalty_bps: number;
  price: string;
  old_operator: string;
  new_operator: string;
  peers: PeerArt[];
}

export interface SaleSnapshot {
  label: string;
  epoch: number;
  owner: string;
  operator: string | null;
  balance: string;
  reputation: string | number;
  age: number;
  connections: [number, string][];
  policy: Record<string, any>;
  listed_price: string | null;
  sales: number;
  art: PeerArt;
}

export interface SalePayout {
  to: string;
  amount: string | null;
  ok: boolean;
  receipt: string | null;
}

/** What the chain held in the blocks either side of the buy. */
export interface BlockDiff {
  block: string;
  before: Record<string, any>;
  after: Record<string, any>;
  refunds: string;
}

export type SaleBeat =
  | { kind: 'none' }
  | { kind: 'setup' }
  | { kind: 'listed' }
  | { kind: 'buying' }
  | { kind: 'sold' }
  | { kind: 'paid'; role: 'seller' | 'royalty' }
  | { kind: 'tryKey'; step: SceneStep }
  | { kind: 'triedKey'; step: SceneStep }
  | { kind: 'tryOwner'; step: SceneStep }
  | { kind: 'triedOwner'; step: SceneStep }
  | { kind: 'locked' }
  | { kind: 'intact' }
  | { kind: 'appointed' }
  | { kind: 'budget' }
  | { kind: 'tryNew'; step: SceneStep }
  | { kind: 'triedNew'; step: SceneStep }
  | { kind: 'end' };

export interface SaleState {
  start: SaleStart | null;
  act: SaleActKey | null;
  steps: SceneStep[];
  checks: SceneCheck[];
  before: SaleSnapshot | null;
  now: SaleSnapshot | null;
  /** The list tx is final. */
  listed: boolean;
  /** The buy tx was sent and hasn't an outcome yet. */
  buying: boolean;
  /** The buy tx's final outcome is ok: the only thing that flips the owner. */
  sold: boolean;
  /** The current owner, as far as the log has confirmed. */
  owner: string | null;
  buyTx: string | null;
  payouts: { seller: SalePayout | null; royalty: SalePayout | null };
  oldKey: SceneStep | null;
  oldOwner: SceneStep | null;
  /** The buyer's register_operator is final. */
  appointed: boolean;
  /** The buyer's set_policy is final. */
  unlocked: boolean;
  probe: SceneStep | null;
  /** Check 9 passed: the chain's own before and after say it kept everything. */
  intact: boolean;
  diff: BlockDiff | null;
  beat: SaleBeat;
  verdict: SceneVerdict;
  bad: string[];
  notes: string[];
  lines: number;
}

const NAME_OF = new Map(SALE_CHECKS.map((c) => [c.n, c.name]));

export function buildSale(lines: SceneLine[]): SaleState {
  const steps = new Map<string, SceneStep>();
  const checks: SceneCheck[] = [];
  const snapshots: SaleSnapshot[] = [];
  const bad: string[] = [];
  const notes: string[] = [];
  const payouts: SaleState['payouts'] = { seller: null, royalty: null };
  let start: SaleStart | null = null;
  let act: SaleActKey | null = null;
  let fatal: string | null = null;
  let listed = false;
  let buying = false;
  let sold = false;
  let buyTx: string | null = null;
  let oldKey: SceneStep | null = null;
  let oldOwner: SceneStep | null = null;
  let probe: SceneStep | null = null;
  let appointed = false;
  let unlocked = false;
  let intact = false;
  let diff: BlockDiff | null = null;
  let beat: SaleBeat = { kind: 'none' };

  for (const l of lines) {
    switch (l.type) {
      case 'start':
        start = l as unknown as SaleStart;
        beat = { kind: 'setup' };
        break;
      case 'act':
        act = l.act;
        break;
      case 'step': {
        const s: SceneStep = { id: l.id, act: l.act, actor: l.actor, method: l.method, action: l.action, amount: l.amount, expected: l.expected, at: l.at, state: 'pending' };
        steps.set(s.id, s);
        if (l.method === 'buy') {
          buying = true;
          beat = { kind: 'buying' };
        }
        if (l.actor === 'agent' && l.method === 'post_job') {
          oldKey = s;
          beat = { kind: 'tryKey', step: s };
        }
        if (l.method === 'withdraw') {
          oldOwner = s;
          beat = { kind: 'tryOwner', step: s };
        }
        if (l.actor === 'new agent') {
          probe = s;
          beat = { kind: 'tryNew', step: s };
        }
        break;
      }
      case 'result': {
        const s = steps.get(l.id);
        if (!s) break;
        Object.assign(s, { state: l.ok ? 'ok' : 'failed', tx: l.tx, err: l.err || undefined, args: l.args });
        if (s.method === 'list' && l.ok) {
          listed = true;
          beat = { kind: 'listed' };
        }
        if (s.method === 'delist' && l.ok) listed = false;
        if (s.method === 'buy') {
          buying = false;
          buyTx = l.tx ?? null;
          if (l.ok) {
            sold = true;
            listed = false;
            beat = { kind: 'sold' };
          }
        }
        if (s === oldKey) beat = { kind: 'triedKey', step: s };
        if (s === oldOwner) beat = { kind: 'triedOwner', step: s };
        if (s.method === 'register_operator' && l.ok) {
          appointed = true;
          beat = { kind: 'appointed' };
        }
        if (s.method === 'set_policy' && l.ok) {
          unlocked = true;
          beat = { kind: 'budget' };
        }
        if (s === probe) beat = { kind: 'triedNew', step: s };
        break;
      }
      case 'snapshot':
        snapshots.push(l as unknown as SaleSnapshot);
        break;
      case 'payout':
        payouts[l.role as 'seller' | 'royalty'] = { to: l.to, amount: l.amount, ok: l.ok, receipt: l.receipt };
        beat = { kind: 'paid', role: l.role };
        break;
      case 'block_diff':
        diff = { block: l.block, before: l.before, after: l.after, refunds: l.refunds };
        break;
      case 'check':
        checks.push({ n: l.n, name: l.name, ok: l.ok, expected: l.expected, actual: l.actual, tx: l.tx });
        // By number and by word: a check that failed early can't pass for a later one.
        if (l.n === 8 && l.name === NAME_OF.get(8)) beat = { kind: 'locked' };
        if (l.n === 9 && l.name === NAME_OF.get(9)) {
          intact = l.ok;
          beat = { kind: 'intact' };
        }
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
  const before = snapshots.find((s) => s.label === 'before') ?? null;
  return {
    start,
    act,
    steps: [...steps.values()],
    checks,
    before,
    now: snapshots.at(-1) ?? null,
    listed,
    buying,
    sold,
    owner: start ? (sold ? start.buyer : start.seller) : null,
    buyTx,
    payouts,
    oldKey,
    oldOwner,
    appointed,
    unlocked,
    probe,
    intact,
    diff,
    beat,
    verdict,
    bad,
    notes,
    lines: lines.length,
  };
}

/** Only the account's first part: the whole name is in the proof below. */
export const accountWord = (a: string) => {
  const dot = a.indexOf('.');
  return dot > 0 ? a.slice(0, dot) : shortAccount(a);
};

/** The narrator's line (Design §8.2): what just happened, from the log. */
export function narrateSale(s: SaleState): string {
  const st = s.start;
  const id = st ? `Spore #${st.spore}` : 'The spore';
  const price = st ? formatNear(st.price) : '';
  const b = s.beat;
  switch (b.kind) {
    case 'none':
    case 'setup':
      return `${id} has tubes, money and an agent. It’s about to change hands.`;
    case 'listed':
      return `Its owner puts it up for ${price}.`;
    case 'buying':
      return `A buyer attaches ${price}. Nothing moves until the chain says so.`;
    case 'sold':
      return 'Sold. One transaction, and the old agent’s key stops working.';
    case 'paid':
      return b.role === 'seller'
        ? `${s.payouts.seller?.amount ? formatNear(s.payouts.seller.amount) : 'The price'} goes to the seller.`
        : `${s.payouts.royalty?.amount ? formatNear(s.payouts.royalty.amount) : 'The rest'} goes to the royalty account. The receipts say so.`;
    case 'tryKey':
      return 'The old agent still has its key. It tries to post a job.';
    case 'triedKey':
      return b.step.state === 'failed' && b.step.err === b.step.expected ? 'Refused. That key opens nothing now.' : 'The contract did not refuse as it should have.';
    case 'tryOwner':
      return 'The old owner tries to take money out.';
    case 'triedOwner':
      return b.step.state === 'failed' && b.step.err === b.step.expected ? 'Refused. That money went with the spore.' : 'The contract did not refuse as it should have.';
    case 'locked':
      return 'It arrives asleep: no agent, paused, zero budget.';
    case 'intact':
      return s.intact && s.now ? `But it kept all it grew: ${tubesText(s.now.connections.length)}, ${formatNear(s.now.balance)}, age ${s.now.age}.` : 'The chain’s before and after do not match. The reason is below.';
    case 'appointed':
      return 'The buyer appoints its own agent.';
    case 'budget':
      return 'The buyer writes its own limits. The spore wakes.';
    case 'tryNew':
      return 'The new agent posts its first job.';
    case 'triedNew':
      return b.step.state === 'ok' ? 'It works.' : 'The new agent was refused.';
    case 'end':
      return s.verdict.status === 'completed' ? 'Same spore. New hands.' : 'This run failed. The reason is below.';
  }
}

export interface SaleRow {
  n: number;
  act: SaleActKey;
  name: string;
  state: 'future' | 'ok' | 'failed';
  check: SceneCheck | null;
}

/** The numbered steps of the docket: what's reported so far, then what's still to come. */
export function saleRows(s: SaleState): SaleRow[] {
  return SALE_CHECKS.map((c) => {
    const got = s.checks.find((x) => x.n === c.n) ?? null;
    return { n: c.n, act: c.act, name: got?.name ?? c.name, state: got ? (got.ok ? 'ok' : 'failed') : 'future', check: got };
  });
}

/**
 * How long each line stays in story pace: long enough to read what it changed.
 * Most of a run's real time is waiting for finality, so the whole run fits the
 * first half minute without dropping a line. Every row keeps its real time.
 */
export function saleDelay(l: SceneLine): number {
  switch (l.type) {
    case 'start':
      return 150;
    case 'act':
      return 150;
    case 'step':
      if (l.method === 'buy') return 1500;
      if (l.actor === 'keeper') return 120;
      if (l.expected !== 'ok') return 1100;
      return 600;
    case 'result':
      if (l.method === 'list') return 1500;
      if (l.method === 'buy') return l.ok ? 2200 : 3200;
      if (l.method === 'timeout_job') return 120;
      return l.ok ? 1300 : 1900;
    case 'payout':
      return 1300;
    case 'block_diff':
      return 80;
    case 'check':
      if (l.n === 8) return 2000;
      if (l.n === 9) return 2600;
      return 60;
    case 'snapshot':
      // The first look: the whole spore on stage, before anything happens to it.
      return l.label === 'before' ? 2400 : 50;
    default:
      return 100;
  }
}
