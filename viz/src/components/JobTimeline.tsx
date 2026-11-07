// `JobTimeline` (Design §7): ordered steps with tx links. Every step here comes
// from a run log, so a tx hash carries the Logged mark `○` (§4.3); the `job`
// variant is the decision card's, `scene` is the Demo Lab's (S11). `JobRail` is
// the same job at a glance: one glyph per stage, then the outcome word.
import type { ReactNode } from 'react';
import { EXPLORER } from '../chain/rpc';
import { outcomeMark, type ActivityRow, type JobStep, type RailStage, type RailState } from '../model/activity';
import { formatClock, formatNear, shortHash } from '../ui/format';
import { Tooltip } from '../ui/Tooltip';

function Glyph({ state }: { state: JobStep['state'] }) {
  if (state === 'failed') return <span className="tone-warn" aria-hidden="true">✕</span>;
  if (state === 'skipped') return <span className="tone-muted" aria-hidden="true">—</span>;
  if (state === 'pending') return <span className="tone-muted" aria-hidden="true">○</span>;
  return <span className="tone-agent" aria-hidden="true">◆</span>;
}

const RAIL: Record<RailState, { glyph: string; tone: string; said: string }> = {
  ok: { glyph: '◆', tone: 'agent', said: 'done' },
  failed: { glyph: '✕', tone: 'warn', said: 'failed' },
  // Not `—`: it would read as one of the rail's connectors.
  skipped: { glyph: '◇', tone: 'muted', said: 'not sent' },
  none: { glyph: '·', tone: 'muted', said: 'no line in the log' },
};

/** Spans, so it can sit inside a row's button. `labelled` writes each stage's word. */
export function JobRail({ stages, labelled, children }: { stages: RailStage[]; labelled?: boolean; children?: ReactNode }) {
  return (
    <span className={`job-rail${labelled ? ' is-labelled' : ''}`}>
      {stages.map((s) => (
        <span key={s.key} className="job-rail-stage">
          <span className={`tone-${RAIL[s.state].tone}`} aria-hidden="true">{RAIL[s.state].glyph}</span>
          <span className={labelled ? 'label' : 'sr-only'}>{s.word}</span>
          <span className="sr-only">{RAIL[s.state].said}</span>
        </span>
      ))}
      {children}
    </span>
  );
}

/** A row's status: a decision's says its outcome, with the glyph. */
export function RowWord({ row }: { row: ActivityRow }) {
  if (!row.word) return <span />;
  const mark = row.kind === 'decision' && row.outcome ? outcomeMark(row.outcome) : null;
  return (
    <span className={`ev-word label tone-${mark ? mark.tone : row.tone}`}>
      {mark && <span aria-hidden="true">{mark.glyph} </span>}
      {row.word}
    </span>
  );
}

export function JobTimeline({ steps, variant = 'job' }: { steps: JobStep[]; variant?: 'job' | 'scene' }) {
  return (
    <ol className={`job-timeline is-${variant}`}>
      {steps.map((s) => (
        <li key={s.key} className={`job-step is-${s.state}`}>
          <Glyph state={s.state} />
          <div className="job-step-body">
            <span className="body">{s.label}</span>
            {s.amount && (
              <Tooltip content={<span className="mono">{s.amount} yocto</span>}>
                <span className="mono money">{formatNear(s.amount)}</span>
              </Tooltip>
            )}
            {s.state === 'failed' && <span className="sr-only">failed</span>}
            {s.state === 'pending' && <span className="sr-only">waiting for the final outcome</span>}
            {s.err && <span className="mono tone-warn job-step-err">{s.err}</span>}
            {s.note && <span className="body job-step-note">{s.note}</span>}
          </div>
          <span className="mono-s job-step-time">{s.at ? formatClock(s.at) : ''}</span>
          {s.tx ? (
            <a className="mono-s job-step-tx" href={`${EXPLORER}/${s.tx}`} target="_blank" rel="noreferrer" aria-label={`${s.label}: logged tx ${s.tx}, opens the explorer`}>
              ○ {shortHash(s.tx)} ↗
            </a>
          ) : (
            <span />
          )}
        </li>
      ))}
    </ol>
  );
}
