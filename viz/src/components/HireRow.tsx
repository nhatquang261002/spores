// A decision at a glance (Design §6.E): who hired whom, one `QuoteTube` per
// quote, the job's stages and its outcome. Tubes share one zero-based scale, the
// largest quote in the log, so they compare across rows.
import { useMemo } from 'react';
import { jobRail, jobSteps, type Activity, type ActivityRow } from '../model/activity';
import { hireBars, hireVerb, tubeBeatCheaper, type HireBar } from '../model/decisions';
import { formatClock, formatD, formatNear } from '../ui/format';
import { SporeRef } from './indicators';
import { JobRail, RowWord } from './JobTimeline';
import { QuoteTube } from './QuoteTube';

/** One bar's line and the row's padding plus rule. `activity.css` draws the same. */
export const HIRE_BAR_H = 24;
export const HIRE_PAD = 17;

function Bar({ bar, palette, consumerPalette }: { bar: HireBar; palette: number | null; consumerPalette: number | null }) {
  const c = bar.candidate;
  return (
    <span className={`hire-bar${bar.won ? ' is-winner' : ''}`}>
      <span className="hire-id">
        <span className="tone-agent hire-win" aria-hidden="true">{bar.won ? '◆' : ''}</span>
        <SporeRef id={c.provider} palette={palette} />
      </span>
      <QuoteTube spec={{ quote: bar.quote, effective: bar.effective, tube: bar.tube, width: bar.width, alpha: bar.alpha, won: bar.won, from: consumerPalette ?? 0, to: palette ?? 0 }} />
      <span className="mono-s hire-num">
        <span className={bar.won ? 'money' : undefined}>{formatNear(c.score)}</span>
        {bar.tube && <span className="hire-was"> quote {formatNear(c.price).replace(' NEAR', '')} · D {formatD(c.d)}</span>}
      </span>
    </span>
  );
}

export function HireRow({ row, data }: { row: ActivityRow; data: Activity }) {
  const d = row.decision!;
  const bars = useMemo(() => hireBars(d, BigInt(data.stats.maxQuote), data.stats.maxD), [d, data.stats.maxQuote, data.stats.maxD]);
  const rail = useMemo(() => jobRail(d, jobSteps(d, data)), [d, data]);
  const meta = [d.service, d.attempt ? `retry ${d.attempt}` : null].filter(Boolean).join(' · ');
  return (
    <>
      <span className="hire-head">
        <span className="mono-s ev-time">{formatClock(row.at!)}</span>
        <span className="body hire-who">{hireVerb(d)}</span>
        {meta && <span className="mono-s hire-meta">{meta}</span>}
        {tubeBeatCheaper(d) && <span className="label hire-tag"><span aria-hidden="true">≈ </span>beat a cheaper quote</span>}
      </span>
      <span className="hire-bars">
        {bars.length ? bars.map((b) => <Bar key={b.candidate.provider} bar={b} palette={data.palettes.get(b.candidate.provider) ?? null} consumerPalette={data.palettes.get(d.consumer) ?? null} />) : <span className="mono-s hire-num">No provider quoted</span>}
      </span>
      <span className="hire-end">
        <JobRail stages={rail} />
        <RowWord row={row} />
      </span>
    </>
  );
}
