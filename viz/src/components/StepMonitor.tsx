// The step monitor (S7, user 2026-11-04: "easy to watch visually, not a bunch
// of text"): one lane per kind of step, each logged step a tick placed by its
// log time within the epoch, an activity trace over all lanes, and a playhead
// that sits on the last step played. One readout line names the newest step,
// or the one under the pointer. The full text log is one click away (and is
// the screen-reader view, Design §9).
//
// Time is the run log's own: x = (t − first step) / (last − first step), the
// same mapping ▶︎ plays with. Chain rows (flows, rejects) have no time and no
// order on chain, so they are a tally, not a timeline (Design §4.2).
import { useMemo, useState, type PointerEvent, type ReactNode } from 'react';
import { STEP_MARKS, type StepKind } from '../model/steps';
import { StepFeed, type FeedRow } from './LoopRail';

/** Lanes top to bottom: the loop's order, then the side steps. */
export const LANE_ORDER: StepKind[] = ['wake', 'post', 'quote', 'hire', 'deliver', 'settle', 'reject', 'timeout', 'failed', 'outside', 'commit'];
/** A run log always shows the loop's lanes, so the layout holds still while an epoch plays. */
const LOOP_LANES: StepKind[] = ['post', 'quote', 'hire', 'deliver', 'settle'];
const TRACE_BUCKETS = 48;
/** Tally spacing for unordered (chain) rows, in px. */
const TALLY_PX = 6;
/** How close (as a fraction of the plot) the pointer must be to a tick to pick it. */
const PICK = 0.02;

export interface MonitorProps {
  /** Newest first, as the feed. `t` is ms since the epoch's first step; null when the source has no time. */
  rows: FeedRow[];
  /** ms from the epoch's first step to its last (all of them, not only those played). */
  span: number;
  /** Every kind of step in this epoch (all, not only those played), to fix the lanes. */
  kinds: StepKind[];
  /** The epoch on screen. */
  epoch: number;
  /** `play`: ▶︎ is playing this epoch; `live`: LIVE at Live; `still`: anything else. */
  mode: 'play' | 'live' | 'still';
  empty: ReactNode;
}

export function lanesFor(rows: FeedRow[], kinds: StepKind[], timed: boolean): StepKind[] {
  const seen = new Set<StepKind>([...kinds, ...rows.map((r) => r.kind)]);
  if (timed) LOOP_LANES.forEach((k) => seen.add(k));
  return LANE_ORDER.filter((k) => seen.has(k));
}

/** Steps per time bucket, as an area path in a 0..B × 0..1 box (1 = the busiest bucket). */
export function tracePath(ts: number[], span: number, buckets = TRACE_BUCKETS): string | null {
  if (!ts.length) return null;
  const n = new Array<number>(buckets).fill(0);
  for (const t of ts) n[Math.min(buckets - 1, Math.max(0, Math.floor((span > 0 ? t / span : 0) * buckets)))]++;
  const max = Math.max(...n);
  let d = 'M0 1';
  n.forEach((c, i) => {
    const y = (1 - c / max).toFixed(3);
    d += ` L${i} ${y} L${i + 1} ${y}`;
  });
  return `${d} L${buckets} 1 Z`;
}

const fmtS = (ms: number) => `${ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)} s`;

export function StepMonitor({ rows, span, kinds, epoch, mode, empty }: MonitorProps) {
  const timed = rows.some((r) => r.t !== null) || (mode === 'play' && span > 0);
  const lanes = useMemo(() => lanesFor(rows, kinds, timed), [rows, kinds, timed]);
  const [hover, setHover] = useState<FeedRow | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  const x = (r: FeedRow) => (r.t === null ? 0 : span > 0 ? r.t / span : 0.5);
  const byLane = useMemo(() => {
    const m = new Map<StepKind, FeedRow[]>();
    for (const k of lanes) m.set(k, []);
    // Oldest first, so the newest tick paints on top.
    for (let i = rows.length - 1; i >= 0; i--) m.get(rows[i].kind)?.push(rows[i]);
    return m;
  }, [rows, lanes]);
  const trace = useMemo(() => (timed ? tracePath(rows.flatMap((r) => (r.t === null ? [] : [r.t])), span) : null), [rows, span, timed]);

  const newest = rows[0] ?? null;
  const shown = hover && rows.includes(hover) ? hover : newest;
  const playhead = mode === 'play' && newest && newest.t !== null ? x(newest) : null;

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!timed || !lanes.length) return;
    const b = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - b.left) / Math.max(1, b.width);
    const lane = lanes[Math.min(lanes.length - 1, Math.floor(((e.clientY - b.top) / Math.max(1, b.height)) * lanes.length))];
    let best: FeedRow | null = null;
    let bd = PICK;
    for (const r of byLane.get(lane) ?? []) {
      const d = Math.abs(x(r) - fx);
      if (d <= bd) [best, bd] = [r, d];
    }
    setHover(best);
  };

  const label = `${rows.length} step${rows.length === 1 ? '' : 's'} in epoch ${epoch}: ${lanes
    .map((k) => `${byLane.get(k)!.length} ${STEP_MARKS[k].word.toLowerCase()}`)
    .join(', ')}`;

  return (
    <section className={`monitor is-${mode}`} aria-label="Step monitor">
      <header className="monitor-head mono-s">
        <span>
          <span className="monitor-state" aria-hidden="true">
            {mode === 'play' ? '▶︎' : mode === 'live' ? '●' : '■'}
          </span>{' '}
          epoch {epoch}
        </span>
        <span>
          {rows.length} step{rows.length === 1 ? '' : 's'}
          {timed && span > 0 ? ` · ${fmtS(span)} of log` : ''}
        </span>
      </header>
      {rows.length === 0 && mode !== 'play' ? (
        <p className="body feed-empty">{empty}</p>
      ) : (
        <div className="monitor-body" role="img" aria-label={label}>
          <div className="monitor-labels mono-s" aria-hidden="true">
            {timed && <span className="monitor-trace-label">all</span>}
            {lanes.map((k) => (
              <span key={k} className={`monitor-lane-label tone-${STEP_MARKS[k].tone}`}>
                <span className="monitor-glyph">{STEP_MARKS[k].glyph}</span>
                <span className="monitor-word">{STEP_MARKS[k].word}</span>
                <span className="monitor-n">{byLane.get(k)!.length}</span>
              </span>
            ))}
          </div>
          <div className="monitor-plot" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            {timed && (
              <svg className="monitor-trace" viewBox={`0 0 ${TRACE_BUCKETS} 1`} preserveAspectRatio="none" aria-hidden="true">
                {trace && <path d={trace} />}
              </svg>
            )}
            <svg className="monitor-lanes" style={{ height: `calc(${lanes.length} * var(--monitor-lane))` }} aria-hidden="true">
              {lanes.map((k, li) => {
                const mid = `${((li + 0.5) / lanes.length) * 100}%`;
                return (
                  <g key={k} className={`tone-${STEP_MARKS[k].tone}`}>
                    <line className="monitor-rule" x1="0" x2="100%" y1={mid} y2={mid} />
                    {byLane.get(k)!.map((r, i) => (
                      <rect
                        key={r.key}
                        className={`monitor-tick${r === newest ? ' is-new' : ''}${r === hover ? ' is-hover' : ''}`}
                        x={timed ? `${x(r) * 100}%` : i * TALLY_PX}
                        y={`${((li + 0.18) / lanes.length) * 100}%`}
                        width="2"
                        height={`${(0.64 / lanes.length) * 100}%`}
                      />
                    ))}
                  </g>
                );
              })}
            </svg>
            {playhead !== null && <span className="monitor-playhead" style={{ left: `${playhead * 100}%` }} aria-hidden="true" />}
            {hover && <span className="monitor-cursor" style={{ left: `${x(hover) * 100}%` }} aria-hidden="true" />}
          </div>
          <div className="monitor-axis mono-s" aria-hidden="true">
            {timed ? (
              <>
                <span>0 s</span>
                <span>{span > 0 ? fmtS(span) : ''}</span>
              </>
            ) : (
              <span>unordered: the chain keeps per-pair totals, not their order</span>
            )}
          </div>
        </div>
      )}
      {shown && (
        <p className={`monitor-readout tone-${STEP_MARKS[shown.kind].tone}`}>
          <span className="monitor-glyph" aria-hidden="true">
            {STEP_MARKS[shown.kind].glyph}
          </span>
          <span className="feed-text body">
            {shown.t !== null && <span className="mono-s monitor-at">+{fmtS(shown.t)} </span>}
            {shown.text}
          </span>
        </p>
      )}
      <button type="button" className="link-button label monitor-log-toggle" aria-expanded={logOpen} onClick={() => setLogOpen((o) => !o)}>
        {logOpen ? 'Hide' : 'Show'} the log as text
      </button>
      <div className={logOpen ? 'monitor-log' : 'sr-only'}>
        <StepFeed rows={rows} empty={empty} />
      </div>
    </section>
  );
}
