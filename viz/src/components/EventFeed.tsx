// `EventFeed` (Design §7, §6.E): rows grouped by epoch with a sticky header.
// `EventFeed` (`full`) windows its rows against the page scroll: group headers
// always render, so `position: sticky` works natively, and only rows are
// swapped for spacers. Rows expand inline. `CompactFeed` is the short list for
// other screens. With `decisions`, a decision row is drawn as bars (`HireRow`).
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { EXPLORER } from '../chain/rpc';
import { windowRows, type Activity, type ActivityRow, type EpochGroup, type GroupWindow } from '../model/activity';
import { linkTo } from '../sources/source';
import { formatClock, shortHash } from '../ui/format';
import { DecisionEntry } from './DecisionEntry';
import { HIRE_BAR_H, HIRE_PAD, HireRow } from './HireRow';
import { RowWord as Word } from './JobTimeline';
import { TransactionReceipt } from './TransactionReceipt';
import { EpochVerification } from './VerificationResult';
import './activity.css';

/** Design sizes: a 52 px row and the epoch header. `activity.css` draws the same. */
export const ROW_H = 52;
export const HEADER_H = 40;
const OVERSCAN = 800;

function Expanded({ row, data, q }: { row: ActivityRow; data: Activity; q: string }) {
  if (row.decision) return <DecisionEntry row={row} data={data} q={q} />;
  return (
    <div className="ev-expanded">
      {row.reason && (
        <p className="body">
          This line can’t be read: <span className="mono tone-warn">{row.reason}</span>. It stays here as written.
        </p>
      )}
      {row.receipt && <TransactionReceipt logged={row.receipt} fallbackEpoch={row.epoch} q={q} sender={row.sender} loggedOk={row.loggedOk} />}
      {row.raw.length > 0 && (
        <details className="technical" open={row.kind === 'unreadable' || row.kind === 'lifecycle'}>
          <summary className="label">Log lines ({row.raw.length})</summary>
          {row.raw.map((l) => (
            <pre key={l.where} className="mono-s raw-line" aria-label={l.where}>{l.text}</pre>
          ))}
        </details>
      )}
    </div>
  );
}

function Row({ row, data, q, open, onToggle, fresh, observe, bars }: { row: ActivityRow; data: Activity; q: string; open: boolean; onToggle: () => void; fresh: boolean; observe: (el: HTMLElement | null, key: string) => void; bars: boolean }) {
  const id = useId();
  const verify = row.kind === 'close' && row.epoch !== null;
  const hire = bars && !!row.decision;
  const slides = row.kind === 'settlement' || (hire && row.outcome === 'settled');
  return (
    <div className={`ev-row kind-${row.kind}${open ? ' is-open' : ''}${fresh && slides ? ' is-fresh' : ''}`} ref={(el) => observe(el, row.key)}>
      <div className="ev-line">
        <button type="button" id={id} className={`ev-toggle${hire ? ' is-hire' : ''}`} aria-expanded={open} aria-label={hire ? [row.summary, row.word].filter(Boolean).join(' · ') : undefined} onClick={onToggle}>
          {hire ? (
            <HireRow row={row} data={data} />
          ) : (
            <>
              <span className="mono-s ev-time">
                {row.at !== null ? formatClock(row.at) : <span aria-hidden="true">—</span>}
                {row.at === null && <span className="sr-only">{row.kind === 'unreadable' ? 'no time' : 'the close event has no time'}</span>}
              </span>
              <span className={`ev-glyph tone-${row.tone}`} aria-hidden="true">{row.glyph}</span>
              <span className="body ev-summary">{row.summary}</span>
              <Word row={row} />
            </>
          )}
        </button>
        {verify && (
          <EpochVerification className="mono-s ev-verify" epoch={row.epoch!} q={q} />
        )}
        {row.tx ? (
          <a className="mono-s ev-tx" href={`${EXPLORER}/${row.tx}`} target="_blank" rel="noreferrer" aria-label={`tx ${row.tx}, opens the explorer`}>
            ↗
          </a>
        ) : (
          <span className="ev-tx" />
        )}
      </div>
      {open && (
        <div role="region" aria-labelledby={id} className="ev-detail">
          <Expanded row={row} data={data} q={q} />
        </div>
      )}
    </div>
  );
}

function GroupHeader({ g, q }: { g: EpochGroup; q: string }) {
  if (g.unreadable) {
    return (
      <h2 className="ev-header label tone-warn">
        <span aria-hidden="true">✕ </span>
        {g.rows.length} {g.rows.length === 1 ? 'line' : 'lines'} that can’t be read
      </h2>
    );
  }
  if (g.epoch === null) return <h2 className="ev-header label">Epoch unknown: this run doesn’t say where it started</h2>;
  const fp = g.close?.receipt?.fingerprint;
  return (
    <h2 className="ev-header label">
      <Link to={linkTo('/network', q, { epoch: g.epoch })}>Epoch {g.epoch}</Link>
      <span className="mono-s ev-header-rest">
        {g.close ? `${g.close.at !== null ? `closed ${formatClock(g.close.at)}` : 'closed'}${fp ? ` · fingerprint ${shortHash(fp)}` : ''}` : 'no close in this source'}
      </span>
    </h2>
  );
}

function useRowWindow(groups: EpochGroup[], estimate: (key: string) => number) {
  const list = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const estimateRef = useRef(estimate);
  estimateRef.current = estimate;
  const [win, setWin] = useState<Map<string, GroupWindow> | null>(null);
  const frame = useRef(0);

  const compute = useCallback(() => {
    const top = list.current?.getBoundingClientRect().top ?? 0;
    const next = windowRows(groupsRef.current, (k) => heights.current.get(k) ?? estimateRef.current(k), HEADER_H, -top - OVERSCAN, -top + window.innerHeight + OVERSCAN);
    setWin((prev) => {
      const same =
        prev &&
        prev.size === next.size &&
        [...next].every(([k, v]) => {
          const p = prev.get(k);
          return p && p.from === v.from && p.to === v.to && p.top === v.top && p.bottom === v.bottom;
        });
      return same ? prev : next;
    });
  }, []);
  const schedule = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(compute);
  }, [compute]);

  useLayoutEffect(compute, [groups, compute]);

  useEffect(() => {
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(frame.current);
    };
  }, [schedule]);

  // Rows report their real height: expanded, or wrapped on mobile.
  const observer = useMemo(() => {
    if (typeof ResizeObserver === 'undefined') return null;
    return new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const el = e.target as HTMLElement;
        const k = el.dataset.rowKey;
        if (k && el.offsetHeight && heights.current.get(k) !== el.offsetHeight) {
          heights.current.set(k, el.offsetHeight);
          changed = true;
        }
      }
      if (changed) schedule();
    });
  }, [schedule]);
  useEffect(() => () => observer?.disconnect(), [observer]);
  const observe = useCallback(
    (el: HTMLElement | null, key: string) => {
      if (el && observer) {
        el.dataset.rowKey = key;
        observer.observe(el);
      }
    },
    [observer],
  );

  return { list, win, observe };
}

export function EventFeed({ groups, data, q, fresh, bars = false }: { groups: EpochGroup[]; data: Activity; q: string; fresh: Set<string>; bars?: boolean }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // Until a row reports its height: bars take one line per candidate.
  const lines = useMemo(() => new Map(bars ? groups.flatMap((g) => g.rows.flatMap((r) => (r.decision ? [[r.key, r.decision.candidates.length] as const] : []))) : []), [groups, bars]);
  const estimate = (k: string) => Math.max(ROW_H, (lines.get(k) ?? 0) * HIRE_BAR_H + HIRE_PAD);
  const { list, win, observe } = useRowWindow(groups, estimate);
  const toggle = (key: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (!n.delete(key)) n.add(key);
      return n;
    });
  return (
    <div className="event-feed" ref={list}>
      {groups.map((g) => {
        const w = win?.get(g.key) ?? { from: 0, to: Math.min(g.rows.length, 40), top: 0, bottom: 0 };
        return (
          <section key={g.key} className="ev-group" aria-label={g.unreadable ? 'Lines that can’t be read' : g.epoch === null ? 'Epoch unknown' : `Epoch ${g.epoch}`}>
            <GroupHeader g={g} q={q} />
            {w.top > 0 && <div style={{ height: w.top }} aria-hidden="true" />}
            {g.rows.slice(w.from, w.to).map((r) => (
              <Row key={r.key} row={r} data={data} q={q} open={open.has(r.key)} onToggle={() => toggle(r.key)} fresh={fresh.has(r.key)} observe={observe} bars={bars} />
            ))}
            {w.bottom > 0 && <div style={{ height: w.bottom }} aria-hidden="true" />}
          </section>
        );
      })}
    </div>
  );
}

/** The `compact` variant: newest first, each row opening in Activity. */
export function CompactFeed({ rows, more }: { rows: ActivityRow[]; more: string }) {
  return (
    <ul className="event-feed-compact">
      {rows.map((r) => (
        <li key={r.key} className="ev-compact-row">
          <span className="mono-s ev-time">{r.at !== null ? formatClock(r.at) : '—'}</span>
          <span className={`ev-glyph tone-${r.tone}`} aria-hidden="true">{r.glyph}</span>
          <Link className="body ev-summary" to={more}>{r.summary}</Link>
          <Word row={r} />
          {r.tx ? (
            <a className="mono-s ev-tx" href={`${EXPLORER}/${r.tx}`} target="_blank" rel="noreferrer" aria-label={`tx ${r.tx}, opens the explorer`}>
              ↗
            </a>
          ) : (
            <span />
          )}
        </li>
      ))}
    </ul>
  );
}
