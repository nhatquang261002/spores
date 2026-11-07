// What `/verify` found (Design §6.G), as plain data: the comparisons
// `verify/src/main.rs` makes, one row per epoch, with no chain or wasm here.
// `sources/verify.ts` does the reading and the replay.
import type { EpochClosed } from '../chain/events';
import { RpcError } from '../chain/rpc';

export type Verdict = 'match' | 'mismatch' | 'unable';

/** The three result words (Design §6.G), each with its glyph. */
export const VERDICT_WORD: Record<Verdict, { glyph: string; word: string; tone: string }> = {
  match: { glyph: '✓', word: 'Match', tone: 'tone-growth' },
  mismatch: { glyph: '✕', word: 'Mismatch', tone: 'tone-warn' },
  unable: { glyph: '!', word: 'Unable', tone: 'tone-caution' },
};

export type CheckName = 'event fingerprint' | 'stored fingerprint' | 'prev fingerprint' | 'tubes' | 'tube count';

export interface Check {
  what: CheckName;
  verdict: Verdict;
  /** What the replay computed. */
  replayed: string;
  /** What the chain says; null when it could not be read. */
  chain: string | null;
  /** Why it could not be checked. */
  reason?: string;
}

export interface EpochRow {
  epoch: number;
  /** The close tx this row used; null when no close for the epoch was read. */
  tx: string | null;
  verdict: Verdict;
  /** Set when the verdict is `unable`. */
  reason: string | null;
  replayed: string | null;
  eventFingerprint: string | null;
  viewFingerprint: string | null;
  tubeCount: number | null;
  /** The event lists its tubes (router4 epochs 1–16), so they were compared one by one, not just counted. */
  tubesListed: boolean;
  /** Empty when the row was not replayed. */
  checks: Check[];
}

/** A row as `core-wasm` returns it (`ReplayedEpoch`), reduced to what is compared. */
export interface Replayed {
  epoch: number;
  prev_fingerprint: string;
  fingerprint: string;
  tubes: [number, number, string][];
}

export type ViewRead = { ok: true; fingerprint: string | null } | { ok: false; reason: string };

function tubeMap(tubes: [number, number, string | number][]): Map<string, string> {
  return new Map(tubes.map(([a, b, d]) => [`${a}-${b}`, String(d)]));
}

/** Pairs that differ, as `3-7: 100 on chain, 90 replayed`. Empty when the two sets are equal. */
export function tubeDiff(chain: [number, number, string | number][], replayed: [number, number, string | number][]): string[] {
  const c = tubeMap(chain);
  const r = tubeMap(replayed);
  const out: string[] = [];
  for (const k of [...new Set([...c.keys(), ...r.keys()])].sort()) {
    if (c.get(k) !== r.get(k)) out.push(`${k}: ${c.get(k) ?? 'none'} on chain, ${r.get(k) ?? 'none'} replayed`);
  }
  return out;
}

const same = (what: CheckName, replayed: string, chain: string | null | undefined): Check => ({
  what,
  verdict: chain === replayed ? 'match' : 'mismatch',
  replayed,
  chain: chain ?? null,
});

/** One replayed epoch against its event and the `fingerprint(epoch)` view, as `verify/src/main.rs` compares them. */
export function compareEpoch(ev: EpochClosed, tx: string, r: Replayed, view: ViewRead): EpochRow {
  const checks: Check[] = [same('event fingerprint', r.fingerprint, ev.fingerprint)];
  checks.push(
    view.ok
      ? same('stored fingerprint', r.fingerprint, view.fingerprint)
      : { what: 'stored fingerprint', verdict: 'unable', replayed: r.fingerprint, chain: null, reason: view.reason },
  );
  checks.push(same('prev fingerprint', r.prev_fingerprint, ev.prev_fingerprint));
  // Router4 logged the tubes up to epoch 16; later closes log only their count.
  if (ev.tubes) {
    const diff = tubeDiff(ev.tubes, r.tubes);
    checks.push({ what: 'tubes', verdict: diff.length ? 'mismatch' : 'match', replayed: `${r.tubes.length} tubes`, chain: diff.length ? diff.join('; ') : `${ev.tubes.length} tubes` });
  }
  checks.push(same('tube count', String(r.tubes.length), ev.edges === undefined ? null : String(ev.edges)));
  const bad = checks.some((c) => c.verdict === 'mismatch');
  const unread = checks.find((c) => c.verdict === 'unable');
  return {
    epoch: r.epoch,
    tx,
    verdict: bad ? 'mismatch' : unread ? 'unable' : 'match',
    reason: !bad && unread ? (unread.reason ?? null) : null,
    replayed: r.fingerprint,
    eventFingerprint: ev.fingerprint ?? null,
    viewFingerprint: view.ok ? view.fingerprint : null,
    tubeCount: r.tubes.length,
    tubesListed: !!ev.tubes,
    checks,
  };
}

/** A row that could not be replayed. `close` is its close, when that one was read but an earlier one wasn't. */
export function unableRow(epoch: number, reason: string, close?: { tx: string; ev: EpochClosed }): EpochRow {
  return {
    epoch,
    tx: close?.tx ?? null,
    verdict: 'unable',
    reason,
    replayed: null,
    eventFingerprint: close?.ev.fingerprint ?? null,
    viewFingerprint: null,
    tubeCount: null,
    tubesListed: false,
    checks: [],
  };
}

export interface ClosePlan {
  /** Consecutive closes from epoch 1, the most that can be replayed. */
  replayable: { tx: string; ev: EpochClosed }[];
  /** First epoch that stops the replay, and why; null when nothing does. */
  gap: { epoch: number; reason: string } | null;
  /** Rows to show, epoch 1 to this. */
  last: number;
}

/**
 * The epochs must start at 1 with no gaps (`verify/src/main.rs`). `listed` is
 * how many hashes were asked for: a close that failed to load still has a row,
 * so a failure at the end of the list shows as a missing epoch.
 */
export function planCloses(reads: { tx: string; ev: EpochClosed }[], listed: number, failed: number): ClosePlan {
  const byEpoch = new Map<number, { tx: string; ev: EpochClosed }[]>();
  for (const c of reads) byEpoch.set(c.ev.epoch, [...(byEpoch.get(c.ev.epoch) ?? []), c]);
  const highest = reads.length ? Math.max(...reads.map((c) => c.ev.epoch)) : 0;
  const last = Math.max(highest, failed ? listed : 0);
  const replayable: { tx: string; ev: EpochClosed }[] = [];
  for (let e = 1; e <= last; e++) {
    const here = byEpoch.get(e);
    if (!here) return { replayable, gap: { epoch: e, reason: `missing epoch ${e}` }, last };
    if (here.length > 1) return { replayable, gap: { epoch: e, reason: `two closes for epoch ${e}` }, last };
    replayable.push(here[0]);
  }
  return { replayable, gap: null, last };
}

/** The router's current `epoch_info.prev_fingerprint` against the last replayed fingerprint. */
export type HeadCheck =
  | { kind: 'checked'; verdict: 'match' | 'mismatch'; epoch: number; replayed: string; chain: string }
  /** Only comparable when the router is on the epoch right after the last replayed close. */
  | { kind: 'skipped'; routerEpoch: number; lastEpoch: number }
  | { kind: 'unable'; reason: string };

export interface ImageHashes {
  /** Recomputed in the browser. */
  mine: string;
  committed: string;
}

export interface ImageCheck {
  spore: number;
  verdict: Verdict;
  /** Why it could not be checked, or what the mismatch means. */
  reason: string | null;
  /** The commit's epoch; null when there is no commit. */
  epoch: number | null;
  age: number | null;
  tubes: number | null;
  state: ImageHashes | null;
  image: ImageHashes | null;
  renderer: { mine: number; committed: number } | null;
  /** Pixels of this run's render: never from the image cache. */
  rgb: Uint8Array | null;
  /** On-chain SVG glyph (`nft_token` media), as of now, not the commit's epoch. */
  glyph: string | null;
  seed: string | null;
}

export function unableImage(spore: number, reason: string, epoch: number | null = null): ImageCheck {
  return { spore, verdict: 'unable', reason, epoch, age: null, tubes: null, state: null, image: null, renderer: null, rgb: null, glyph: null, seed: null };
}

/** A close tx from the list that gave no event. Which epoch it was is unknown. */
export interface FailedClose {
  tx: string;
  reason: string;
}

export interface VerifyResult {
  router: string;
  /** Hashes asked for. */
  listed: number;
  rows: EpochRow[];
  failed: FailedClose[];
  /** The replay itself refused the input. */
  replayError: string | null;
  head: HeadCheck;
  image: ImageCheck | null;
  ranAt: number;
  ms: number;
}

export function overallVerdict(r: Pick<VerifyResult, 'rows' | 'head' | 'image' | 'failed' | 'replayError'>): Verdict {
  const all: Verdict[] = r.rows.map((x) => x.verdict);
  if (r.image) all.push(r.image.verdict);
  if (r.head.kind === 'checked') all.push(r.head.verdict);
  if (r.head.kind === 'unable' || r.failed.length || r.replayError || !r.rows.length) all.push('unable');
  if (all.includes('mismatch')) return 'mismatch';
  return all.includes('unable') ? 'unable' : 'match';
}

export const matchedEpochs = (rows: EpochRow[]) => rows.filter((x) => x.verdict === 'match').length;

const IMAGE_TEXT: Record<Verdict, string> = { match: 'image matches commit', mismatch: 'image differs from commit', unable: 'image not checked' };

/** `Match · 16/16 epochs · image matches commit`, without the glyph (Design §6.G). */
export function summaryText(r: VerifyResult): string {
  const v = VERDICT_WORD[overallVerdict(r)].word;
  const parts = [v, `${matchedEpochs(r.rows)}/${r.rows.length} epochs`];
  if (r.image) parts.push(IMAGE_TEXT[r.image.verdict]);
  return parts.join(' · ');
}

export type VerifyProgress =
  | { step: 'list' }
  | { step: 'fetching'; done: number; total: number }
  | { step: 'replaying' }
  | { step: 'comparing'; done: number; total: number }
  | { step: 'image'; spore: number };

/** `Fetching close 7 / 16`, then `Replaying`, then `Comparing` (Design §6.G). */
export function progressText(p: VerifyProgress): string {
  switch (p.step) {
    case 'list':
      return 'Reading the close list';
    case 'fetching':
      return `Fetching close ${Math.min(p.done + 1, p.total)} / ${p.total}`;
    case 'replaying':
      return 'Replaying';
    case 'comparing':
      return `Comparing ${p.done} / ${p.total}`;
    case 'image':
      return `Rendering Spore #${p.spore}`;
  }
}

const isRateLimit = (e: RpcError) => e.kind === 'retryable' && /rate limited|http 429/.test(e.message);
/**
 * No answer the page may read. Both archival nodes send their 429 without a CORS
 * header (seen in Chrome, S10), so to the browser a rate limit and a dead node
 * are the same `Failed to fetch`: say that, don't pick one.
 */
const isBlocked = (e: RpcError) => e.kind === 'retryable' && /failed to fetch|networkerror|load failed/i.test(e.message);

/**
 * Why an old tx could not be read, in the words the Design names (archival rate
 * limit, missing tx, RPC down). The archival node is the one that decides:
 * the others have dropped old txs, so their "unknown" or timeout says nothing.
 */
export function txFailureReason(archival: unknown, other: unknown): string {
  const a = archival instanceof RpcError ? archival : null;
  if (a && isRateLimit(a)) return 'archival rate limit';
  if (a && isBlocked(a)) return 'archival node unreachable or rate-limited: the browser cannot tell which';
  if (a?.causeName === 'UNKNOWN_TRANSACTION' || (!a && other instanceof RpcError && other.causeName === 'UNKNOWN_TRANSACTION')) return 'missing tx: the node does not have it';
  return readFailureReason(archival ?? other);
}

/** Why a read failed: `RPC down` for a node that never answered, otherwise what the node said. */
export function readFailureReason(e: unknown): string {
  if (e instanceof RpcError) {
    if (isRateLimit(e)) return `rate limit at ${e.endpoint}`;
    if (isBlocked(e)) return `${e.endpoint} unreachable or rate-limited: the browser cannot tell which`;
    return e.kind === 'retryable' ? `RPC down: ${e.endpoint}: ${e.message}` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
