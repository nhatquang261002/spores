// The loop, step by step (S7): a rail that names each step of the network in
// order (Wake → Post → Quote → Hire → Deliver → Settle → Close → Grow) with
// how many happened in the epoch on screen, lighting the step that just
// fired; and a feed that narrates each step as it plays. Every count and row
// is a logged tx (run log) or a chain value; a step the source can't see is
// `—` with the reason (Design §4.2).
import type { ReactNode } from 'react';
import { EXPLORER } from '../chain/rpc';
import { STEP_MARKS, type Step, type StepKind } from '../model/steps';
import { formatNear, shortHash } from '../ui/format';
import { Tooltip } from '../ui/Tooltip';

export type RailKey = 'wake' | 'post' | 'quote' | 'hire' | 'deliver' | 'settle' | 'close' | 'grow';
export const RAIL: RailKey[] = ['wake', 'post', 'quote', 'hire', 'deliver', 'settle', 'close', 'grow'];

const RAIL_MARKS: Record<RailKey, { glyph: string; word: string; tone: string; what: string }> = {
  wake: { glyph: '◌', word: 'Wake', tone: 'agent', what: 'agent processes started and began quoting' },
  post: { glyph: '◆', word: 'Post', tone: 'agent', what: 'jobs posted: a spore asks the network for work, with a price cap' },
  quote: { glyph: '◆', word: 'Quote', tone: 'agent', what: 'quotes: providers offer a price for a posted job' },
  hire: { glyph: '◆', word: 'Hire', tone: 'agent', what: 'hires: the consumer accepts one quote by the hiring rule (price ÷ (1 + w·D_norm)); the price goes to escrow' },
  deliver: { glyph: '◆', word: 'Deliver', tone: 'agent', what: 'deliveries: the provider posts its result hash' },
  settle: { glyph: '✓', word: 'Settle', tone: 'growth', what: 'settlements: escrow paid to the provider, added to the pair’s flow' },
  close: { glyph: '◎', word: 'Close', tone: 'slime', what: 'close: the epoch closes, and the contract updates every tube from the epoch’s flows' },
  grow: { glyph: '✓', word: 'Grow', tone: 'growth', what: 'tubes that grew or were born at this close (D moves only at a close)' },
};

export type RailCount = { n: number | null; reason?: string };

export interface RailProps {
  counts: Record<RailKey, RailCount>;
  side: { kind: StepKind; n: number }[];
  /** The step that just fired; `n` changes on each firing so the flash restarts. */
  firing: { key: RailKey; n: number } | null;
}

export function LoopRail({ counts, side, firing }: RailProps) {
  return (
    <div className="loop-rail">
      <ol className="loop-steps" aria-label="The loop in this epoch">
        {RAIL.map((k, i) => {
          const m = RAIL_MARKS[k];
          const c = counts[k];
          const lit = firing?.key === k;
          return (
            <li key={k} className={`loop-step tone-${m.tone}`}>
              {i > 0 && (
                <span className="loop-arrow" aria-hidden="true">
                  →
                </span>
              )}
              <Tooltip content={c.n === null ? (c.reason ?? 'Not in this source.') : `${c.n} ${m.what}`}>
                <span className={`loop-chip${lit ? ' is-firing' : ''}`} key={lit ? `f${firing!.n}` : 'idle'}>
                  <span className="loop-glyph" aria-hidden="true">
                    {m.glyph}
                  </span>
                  <span className="label">{m.word}</span>
                  <span className="mono-s loop-count">{c.n === null ? '—' : c.n}</span>
                </span>
              </Tooltip>
            </li>
          );
        })}
      </ol>
      {side.length > 0 && (
        <p className="loop-side mono-s">
          {side.map((s) => (
            <span key={s.kind} className={`tone-${STEP_MARKS[s.kind].tone}`}>
              <span aria-hidden="true">{STEP_MARKS[s.kind].glyph}</span> {STEP_MARKS[s.kind].word.toLowerCase()} {s.n}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

// --- narration --------------------------------------------------------------

const sid = (n: number | null) => (n === null ? <span className="unavailable">#?</span> : <span className="mono">#{n}</span>);
const near = (y: string | undefined) => (y ? <span className="mono value">{formatNear(y)}</span> : null);

/** One plain sentence per step (Design §8.2: name the mechanism). */
export function narrate(s: Pick<Step, 'kind' | 'from' | 'to' | 'job' | 'amount' | 'service' | 'closed' | 'method' | 'err'>): ReactNode {
  const job = s.job === undefined ? null : <span className="mono-s"> · job {s.job}</span>;
  switch (s.kind) {
    case 'wake':
      return <>{sid(s.from)} woke{s.service ? <> · sells <span className="mono">{s.service}</span></> : null}</>;
    case 'post':
      return <>{sid(s.from)} posted {s.service ? <>a <span className="mono">{s.service}</span> job</> : 'a job'}{s.amount ? <> · max {near(s.amount)}</> : null}{job}</>;
    case 'quote':
      return <>{sid(s.from)} quoted {near(s.amount)}{s.to !== null ? <> to {sid(s.to)}</> : null}{job}</>;
    case 'hire':
      return <>{sid(s.from)} hired {sid(s.to)}{s.amount ? <> for {near(s.amount)}</> : null} · escrowed{job}</>;
    case 'deliver':
      return <>{sid(s.from)} delivered{s.to !== null ? <> to {sid(s.to)}</> : null}{job}</>;
    case 'settle':
      return s.job === undefined && s.amount ? <>{sid(s.from)} ↔ {sid(s.to)} settled {near(s.amount)}</> : <>{sid(s.from)} paid {sid(s.to)} {near(s.amount)}{job}</>;
    case 'reject':
      return <>{sid(s.from)} rejected {s.to !== null ? <>{sid(s.to)}’s delivery</> : 'a delivery'} · refunded{job}</>;
    case 'timeout':
      return <>job timed out{s.from !== null ? <> · {sid(s.from)}{s.to !== null ? <> ↔ {sid(s.to)}</> : null}</> : null}{job}</>;
    case 'outside':
      return <>{sid(s.from)} paid the outside data service {near(s.amount)}</>;
    case 'commit':
      return <>image hash of {sid(s.from)} committed</>;
    case 'failed':
      return <>{sid(s.from)} <span className="mono">{s.method}</span> failed: <span className="mono err">{s.err}</span></>;
    case 'close':
      return <>epoch {s.closed} closed</>;
  }
}

export interface FeedRow {
  key: string;
  kind: StepKind;
  text: ReactNode;
  epoch: number;
  /** ms since the epoch's first logged step (the monitor's x); null for chain rows, which have no time. */
  t: number | null;
  tx: string | null;
  /** `logged`: the run log has the hash and the app did not fetch it (§4.3); `chain`: from chain views. */
  evidence: 'logged' | 'chain';
}

export function StepFeed({ rows, empty }: { rows: FeedRow[]; empty: ReactNode }) {
  if (!rows.length) return <p className="body feed-empty">{empty}</p>;
  return (
    <ol className="step-feed">
      {rows.map((r) => {
        const m = STEP_MARKS[r.kind];
        return (
          <li key={r.key} className={`feed-row tone-${m.tone}`}>
            <span className="feed-glyph" aria-hidden="true">
              {m.glyph}
            </span>
            <span className="feed-text body">
              <span className="sr-only">{m.word}: </span>
              {r.text}
            </span>
            {r.tx ? (
              <Tooltip align="end" focusable={false} content={r.evidence === 'logged' ? 'Logged: the agents’ log has this transaction; the app has not fetched it. Opens the explorer.' : 'Opens the explorer.'}>
                <a className="feed-tx mono-s" href={`${EXPLORER}/${r.tx}`} target="_blank" rel="noreferrer">
                  {r.evidence === 'logged' ? '○ ' : ''}
                  {shortHash(r.tx)}
                </a>
              </Tooltip>
            ) : (
              <span className="feed-tx mono-s unavailable">{r.evidence === 'chain' ? 'on chain' : '—'}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
