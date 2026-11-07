// The Overview's plate (Design §13 items 22, 23): how fast it tells its story, what its pen
// points at, what the sheet beside it says, and where each stop can be seen for real.
// Loaded with the plate, not the page.
import { formatNear } from '../ui/format';
import { LOOP_ACTS, loopDelay, type LoopAct, type LoopRow, type LoopState } from './loop';
import type { SceneLine } from './scene';

/**
 * The plate's pace: the whole story inside 30 seconds, each line still long enough
 * to read. `/lab/loop` keeps the slower telling, and every close is there, faster.
 */
export function overviewDelay(l: SceneLine): number {
  switch (l.type) {
    case 'wake':
      return 2800;
    case 'post':
      return 1800;
    case 'quotes':
      return 1800;
    case 'hired':
      return 2100;
    case 'delivered':
      return 600;
    case 'paid':
      return 2200;
    case 'closed':
      return 2700;
    case 'rep':
      return 2600;
    case 'art':
      return 2400;
    case 'lapse':
      return 1100;
    case 'sale':
      return Math.round(loopDelay(l) * 0.62);
    case 'resumed':
      return 2000;
    default:
      return loopDelay(l);
  }
}

/**
 * Whether this line gets the note to itself. The sale happens fast: told line by line
 * here, its fourteen lines change faster than anyone reads. The stage still shows every
 * one, and `/lab/sale` has them all; the note says the ones that carry the story, and
 * stays on each long enough to be read.
 */
export function noteWorthy(s: LoopState): boolean {
  if (s.beat === 'delivered') return false;
  if (s.beat !== 'sale') return true;
  switch (s.sale.beat.kind) {
    case 'listed':
    case 'sold':
    case 'triedKey':
    case 'intact':
    case 'triedNew':
      return true;
    default:
      return false;
  }
}

/** What the plate's arrow points at while a line is on screen. */
export type PlateTarget =
  | { at: 'hero' }
  | { at: 'peer'; id: number }
  | { at: 'tube'; id: number }
  | { at: 'rim' }
  | { at: 'label' }
  | { at: 'seller' }
  | { at: 'royalty' }
  | { at: 'buyer' };

export function plateTarget(s: LoopState): PlateTarget | null {
  switch (s.beat) {
    case 'none':
    case 'report':
      return null;
    case 'wake':
    case 'post':
    case 'art':
    case 'lapse':
    case 'resumed':
      return { at: 'hero' };
    case 'quotes':
    case 'hired':
    case 'delivered':
    case 'paid':
      return s.job?.winner != null ? { at: 'peer', id: s.job.winner } : { at: 'hero' };
    case 'closed':
      return s.growth ? { at: 'tube', id: s.growth.partner } : { at: 'hero' };
    case 'rep':
      return { at: 'rim' };
    case 'sale':
      switch (s.sale.beat.kind) {
        case 'setup':
        case 'listed':
        case 'buying':
        case 'sold':
          return { at: 'label' };
        case 'paid':
          return s.sale.beat.role === 'seller' ? { at: 'seller' } : { at: 'royalty' };
        case 'tryKey':
        case 'triedKey':
        case 'tryOwner':
        case 'triedOwner':
          return { at: 'seller' };
        case 'appointed':
        case 'budget':
        case 'tryNew':
        case 'triedNew':
          return { at: 'buyer' };
        default:
          return { at: 'hero' };
      }
  }
}

/** Where each stop of the loop can be seen for real (Design §6.A). */
export function deepLink(a: LoopAct, hero: number | null): { path: string; word: string; params?: Record<string, string> } {
  const spore = hero === null ? '/market' : `/spore/${hero}`;
  switch (a) {
    case 'wake':
      return { path: '/market', word: 'All 64', params: { view: 'all' } };
    case 'hire':
      return { path: '/activity', word: 'Every hire' };
    case 'settle':
      return { path: '/activity', word: 'Every payment', params: { view: 'log', kind: 'settlement' } };
    case 'grow':
      return { path: '/network', word: 'The map' };
    case 'reputation':
      return { path: spore, word: 'Its page' };
    case 'art':
      return { path: spore, word: 'Its art' };
    case 'sell':
      return { path: '/market', word: 'The market' };
    case 'control':
      return { path: '/lab/sale', word: 'The sale' };
  }
}

export interface PlateSheet {
  spore: number;
  status: { glyph: string; word: string; why: string; tone: 'growth' | 'money' | 'warn' };
  owner: string;
  /** Set once a sale has gone through. */
  previousOwner: string | null;
  /** What the sale did to each of them, once a receipt or the final buy says so. */
  ownerDelta: string | null;
  previousDelta: string | null;
  royalty: { account: string; bps: number; got: string | null } | null;
  /** Null while nobody runs it: the sale took its old agent's key away. */
  agent: string | null;
  balance: string;
  reputation: string;
  /** What the contract lets its agent spend an epoch; null once a sale has reset it and no later read says. */
  allowance: string | null;
  tubes: number;
  age: number;
  seed: string;
}

/** The spore on the plate as far as the story has reached. Every value comes from the log's last read of it. */
export function plateSheet(s: LoopState): PlateSheet | null {
  const f = s.frame;
  if (s.hero === null || !f) return null;
  const sale = s.sale;
  const start = sale.start;
  const now = sale.now;
  const status: PlateSheet['status'] = sale.sold
    ? sale.unlocked
      ? { glyph: '◉', word: 'Active', why: 'Under its new owner, with a new agent.', tone: 'growth' }
      : { glyph: '✕', word: 'Locked', why: 'Sold. Paused with a budget of 0 until the new owner sets a policy.', tone: 'warn' }
    : sale.listed && start
      ? { glyph: '◇', word: 'For sale', why: `Listed at ${formatNear(start.price)}. Its agent keeps working until it sells.`, tone: 'money' }
      : f.operator
        ? { glyph: '◉', word: 'Active', why: 'Its agent is trading with other spores.', tone: 'growth' }
        : { glyph: '○', word: 'Dormant', why: 'No agent runs it.', tone: 'money' };
  return {
    spore: s.hero,
    status,
    owner: (s.saleStarted && sale.owner) || f.owner,
    previousOwner: sale.sold && start ? start.seller : null,
    ownerDelta: sale.sold && start ? `−${formatNear(start.price)}` : null,
    previousDelta: sale.payouts.seller?.amount ? `+${formatNear(sale.payouts.seller.amount)}` : null,
    royalty: sale.sold && start ? { account: start.royalty_account, bps: start.royalty_bps, got: sale.payouts.royalty?.amount ? `+${formatNear(sale.payouts.royalty.amount)}` : null } : null,
    agent: sale.sold ? (sale.appointed && start ? start.new_operator : null) : (start?.old_operator ?? f.operator),
    balance: now?.balance ?? f.balance,
    reputation: String(now?.reputation ?? f.reputation),
    allowance: sale.sold ? null : f.allowance,
    tubes: now?.connections?.length ?? f.tubes.length,
    age: now?.age ?? f.art.age,
    seed: f.art.seed,
  };
}

/** What each stop's figures mean, in words. D, R and E are the chain's own terms. */
export const STOP_GLOSS: Record<LoopAct, string> = {
  wake: 'Its money is testnet NEAR, held by the contract under the spore’s id. An epoch is one round of trading.',
  hire: 'The agent scores each quote as price ÷ (1 + 4 × tube strength to that provider) and takes the lowest, so history can beat a lower price.',
  settle: 'The money waits in escrow until the job settles. Settling takes a 1% fee and pays the provider. The tube doesn’t move yet.',
  grow: 'D is a tube’s strength. It changes only when an epoch closes: settled payments add to it, and every tube decays by 25%.',
  reputation: 'R is reputation, added up from its tubes (the sum of √D). It lifts what the contract lets its agent spend each epoch.',
  art: 'E is the epoch. The picture is redrawn from the spore’s seed, age and tubes, and its hash is committed on chain.',
  sell: 'One call moves the NFT, pays the seller and pays a 5% royalty.',
  control: 'The old agent’s key and the old owner are refused. Balance, tubes and age stay with the spore.',
};

/** The stop to show: the one the story is on, or the last it reached. */
export function shownStop(rows: LoopRow[]): LoopRow {
  return rows.find((r) => r.state === 'now') ?? [...rows].reverse().find((r) => r.state === 'past') ?? rows[0];
}

/** The stop after this one: a seek lands just before it, where this one has said everything. */
export function nextStop(a: LoopAct): LoopAct | null {
  return LOOP_ACTS[LOOP_ACTS.findIndex((x) => x.key === a) + 1]?.key ?? null;
}
