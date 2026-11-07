// Activity (`/activity`, Design §6.E): what happened and why. LOCAL RUN and
// RECORDED read the run's decision and event logs; LIVE reads the only history
// the chain gives without an indexer, the close txs in the close list, and says
// so. A run opens on its decisions, drawn as bars; `?view=log` is every line.
// Filters live in the URL.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { Rpc } from '../chain/rpc';
import { EventFeed } from '../components/EventFeed';
import { QuoteTube, type QuoteTubeSpec } from '../components/QuoteTube';
import '../components/gallery.css';
import {
  activeFilters,
  filterRows,
  groupRows,
  kindCounts,
  KINDS,
  OUTCOMES,
  outcomeMark,
  parseFilter,
  parseView,
  writeFilter,
  writeView,
  type ActivityFilter,
  type ActivityKind,
} from '../model/activity';
import { liveRouter } from '../sources/live';
import { listRecorded, type RecordedBundle } from '../sources/recorded';
import { listRuns } from '../sources/run';
import { linkTo, sourceQuery } from '../sources/source';
import { ReceiptContext, useActivity, useReceiptStore } from '../state/activity';
import { useApp } from '../state/source';
import { formatClock } from '../ui/format';
import { EmptyState, ErrorState, LoadingBar } from '../ui/states';
import { SourceBadge } from '../ui/status';
import { Tooltip } from '../ui/Tooltip';

const NOT_ON_CHAIN = 'Not on chain: written by the agents’ log';
const NO_INDEXER = 'The chain keeps this in transaction logs, which this app doesn’t search. The agents’ log lists it.';

function KindChip({ word, n, pressed, disabled, onClick }: { word: string; n: number; pressed: boolean; disabled: string | null; onClick: () => void }) {
  const chip = (
    <button type="button" className="chip" aria-pressed={pressed} disabled={disabled !== null} onClick={onClick}>
      {word} <span className="mono-s">{disabled ? '—' : n}</span>
    </button>
  );
  return disabled ? <Tooltip content={disabled}>{chip}</Tooltip> : chip;
}

/** The epoch inputs write on change; an empty value clears that end. */
function EpochInput({ word, label, value, onChange }: { word: string; label: string; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <label className="ev-field label">
      {word}
      <input className="mono" aria-label={label} type="number" min={0} inputMode="numeric" value={value ?? ''} onChange={(e) => onChange(/^\d{1,9}$/.test(e.target.value) ? Number(e.target.value) : null)} />
    </label>
  );
}

function Filters({ f, set, spores, counts, outcomes, chain, log }: { f: ActivityFilter; set: (f: ActivityFilter) => void; spores: number[]; counts: Map<string, number>; outcomes: string[]; chain: boolean; log: boolean }) {
  const toggle = (k: ActivityKind) => set({ ...f, kinds: f.kinds.includes(k) ? f.kinds.filter((x) => x !== k) : [...f.kinds, k] });
  const disabledFor = (k: ActivityKind): string | null => {
    if (!chain || k === 'close') return null;
    return k === 'market' || k === 'image' ? NO_INDEXER : NOT_ON_CHAIN;
  };
  const shown = f.spore !== null && !spores.includes(f.spore) ? [...spores, f.spore].sort((a, b) => a - b) : spores;
  return (
    <>
      <label className="ev-field label">
        Spore
        <select className="mono" disabled={chain} value={f.spore ?? ''} onChange={(e) => set({ ...f, spore: e.target.value === '' ? null : Number(e.target.value) })}>
          <option value="">All</option>
          {shown.map((s) => (
            <option key={s} value={s}>#{s}</option>
          ))}
        </select>
      </label>
      <EpochInput word="Epochs" label="From epoch" value={f.from} onChange={(from) => set({ ...f, from })} />
      <EpochInput word="to" label="To epoch" value={f.to} onChange={(to) => set({ ...f, to })} />
      <label className="ev-field label">
        Outcome
        <select value={f.outcome ?? ''} onChange={(e) => set({ ...f, outcome: e.target.value || null })} disabled={chain}>
          <option value="">All</option>
          {[...new Set([...outcomes, ...(f.outcome ? [f.outcome] : [])])].map((o) => (
            <option key={o} value={o}>{outcomeMark(o).word}</option>
          ))}
        </select>
      </label>
      <div className="chips" role="group" aria-label="Kind">
        {log ? (
          KINDS.map(({ kind, word }) => <KindChip key={kind} word={word} n={counts.get(kind) ?? 0} pressed={f.kinds.includes(kind)} disabled={disabledFor(kind)} onClick={() => toggle(kind)} />)
        ) : (
          <button type="button" className="chip" aria-pressed={!!f.tube} onClick={() => set({ ...f, tube: !f.tube })}>
            Tube beat a cheaper quote
          </button>
        )}
      </div>
    </>
  );
}

const SCENE_NAMES: Record<string, string> = { loop: 'the whole loop', rogue: 'the rogue agent', sale: 'the sale' };
const bundleName = (b: RecordedBundle) => `${(b.scene && SCENE_NAMES[b.scene]) ?? 'a recording'}, ${b.date}`;

/** Which logs the reader could load instead: dev-server runs and committed bundles. */
function LogLinks() {
  const [runs, setRuns] = useState<string[]>([]);
  const [recorded, setRecorded] = useState<RecordedBundle[]>([]);
  useEffect(() => {
    let alive = true;
    listRuns().then((r) => alive && setRuns(r), () => {});
    listRecorded().then((r) => alive && setRecorded(r), () => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!runs.length && !recorded.length) return <> No agents’ log is available.</>;
  const links = [
    ...recorded.map((b) => ({ key: b.run, name: bundleName(b), to: linkTo('/activity', sourceQuery({ kind: 'recorded', run: b.run, date: b.date })) })),
    // A recorded run is also in the dev server's list: once is enough, and the recording works without it.
    ...runs.filter((r) => !recorded.some((b) => b.run === r)).map((r) => ({ key: r, name: r, to: linkTo('/activity', sourceQuery({ kind: 'run', run: r })) })),
  ];
  return (
    <>
      {' '}
      Load one:{' '}
      {links.map((l, i) => (
        <span key={l.key}>
          {i > 0 && ', '}
          <Link to={l.to}>{l.name}</Link>
        </span>
      ))}
      .
    </>
  );
}

function Heading({ children }: { children?: ReactNode }) {
  return (
    <div className="activity-head">
      <h1 className="title">Activity</h1>
      {children}
    </div>
  );
}

/** The legend's sample. Illustration, not data: no values are read from it. */
const TUBE_KEY: QuoteTubeSpec = { quote: 1, effective: 0.4, tube: true, width: 5, alpha: 1, won: true, from: 0, to: 0 };

const NO_FILTER: ActivityFilter = { spore: null, from: null, to: null, kinds: [], outcome: null };

export function Activity({ rpc }: { rpc?: Rpc }) {
  const { source, router, epoch } = useApp();
  const [params, setParams] = useSearchParams();
  const state = useActivity(source, router, { poll: true });
  const { data } = state;
  const store = useReceiptStore(rpc ?? router?.rpc ?? liveRouter().rpc, data?.router ?? router?.id ?? null);
  const q = source ? sourceQuery(source) : '';

  const filter = useMemo(() => parseFilter(params), [params]);

  const rows = data?.rows ?? [];
  const counts = useMemo(() => kindCounts(rows), [rows]);
  // Only a run with decisions has that view: LIVE and an events-only run are their log.
  const log = parseView(params) === 'log' || !counts.get('decision');
  const setFilter = (f: ActivityFilter) => {
    const next = writeFilter(params, f);
    // Clearing the last kind must not drop the reader out of the log.
    if (log && data?.mode === 'log') next.set('view', 'log');
    setParams(next, { replace: true });
  };
  const sporesSeen = useMemo(() => (data?.mode === 'log' ? [...new Set(rows.flatMap((r) => r.spores))].sort((a, b) => a - b) : []), [rows, data]);
  const outcomesSeen = useMemo(() => {
    const seen = new Set(rows.filter((r) => log || r.kind === 'decision').map((r) => r.outcome).filter((o): o is string => !!o));
    return [...Object.keys(OUTCOMES).filter((o) => seen.has(o)), ...[...seen].filter((o) => !OUTCOMES[o])];
  }, [rows, log]);
  const filtered = useMemo(() => filterRows(rows, log ? { ...filter, tube: false } : { ...filter, kinds: ['decision'] }), [rows, filter, log]);
  const groups = useMemo(() => groupRows(filtered, rows), [filtered, rows]);

  const [sheet, setSheet] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const [barH, setBarH] = useState(0);
  const hasData = data !== null;
  useEffect(() => {
    if (!bar.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setBarH(bar.current?.offsetHeight ?? 0));
    ro.observe(bar.current);
    return () => ro.disconnect();
  }, [hasData]);
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheet(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sheet]);

  if (source?.kind === 'sim') {
    return (
      <>
        <Heading />
        <EmptyState title="The simulation has no activity feed">It writes aggregate economy output, with no jobs or transactions per spore. Choose a recording or the live contract.</EmptyState>
      </>
    );
  }
  if (!source) return <Heading />;
  if (!data) {
    return (
      <>
        <Heading>
          <SourceBadge source={source} staleSince={epoch.staleSince} />
        </Heading>
        {state.error ? (
          <ErrorState error={state.error} what={source.kind === 'live' ? 'the close list' : `the logs of ${source.run}`} onRetry={state.retry} />
        ) : (
          <p className="body activity-note">
            <LoadingBar ch={12} label="Reading the source" /> {source.kind === 'live' ? 'Reading the close list' : `Reading the logs of ${source.run}`}
          </p>
        )}
      </>
    );
  }

  const chain = data.mode === 'chain';
  const nActive = activeFilters(filter);
  const { stats, missing } = data;
  const settledNew = rows.filter((r) => r.kind === 'settlement' && state.fresh.has(r.key)).length;
  const listed = state.closes?.listed ?? 0;
  return (
    <ReceiptContext.Provider value={store}>
      <div className="activity" style={{ '--activity-bar-h': `${barH}px` } as CSSProperties}>
        <Heading>
          <span className="activity-head-right">
            {!log && (
              <Tooltip content="From the logged quotes: the winner quoted more than another candidate and still had the lowest score, which only its tube can do.">
                <span className="mono activity-primary">
                  <span aria-hidden="true">≈</span> a tube beat a cheaper quote in {stats.tubeWins} of {stats.decisions} decisions
                </span>
              </Tooltip>
            )}
            {!chain && stats.decisions > 0 && (
              <Tooltip content="Re-ran the hiring rule in your browser over each logged decision, with the agents’ own rules.ts.">
                <span className="mono activity-figure">
                  <span aria-hidden="true">↻</span> {stats.matches} / {stats.decisions} decisions match the log
                </span>
              </Tooltip>
            )}
            <SourceBadge source={source} staleSince={epoch.staleSince} />
          </span>
        </Heading>

        <div className={`activity-bar${sheet ? ' is-sheet-open' : ''}`} ref={bar}>
          {!chain && !!counts.get('decision') && (
            <div className="segmented" role="group" aria-label="View">
              <Link to={`?${writeView(params, 'decisions')}`} aria-current={log ? undefined : 'page'}>Decisions</Link>
              <Link to={`?${writeView(params, 'log')}`} aria-current={log ? 'page' : undefined}>Full log</Link>
            </div>
          )}
          <div className="activity-bar-mobile">
            <button type="button" className="btn btn-secondary" aria-expanded={sheet} onClick={() => setSheet((s) => !s)}>
              Filters{nActive ? ` (${nActive})` : ''}
            </button>
          </div>
          <div className="activity-filters" role="group" aria-label="Filters">
            <Filters f={filter} set={setFilter} spores={sporesSeen} counts={counts} outcomes={outcomesSeen} chain={chain} log={log} />
            {sheet && (
              <button type="button" className="btn btn-secondary" onClick={() => setSheet(false)}>
                Show {filtered.length} rows
              </button>
            )}
          </div>
        </div>

        {chain && (
          <p className="body activity-note">
            Decisions and job history are not on chain: the agents’ log has them. LIVE shows the closes in the close list.
            <LogLinks />
          </p>
        )}
        {chain && listed > 0 && state.closes!.loaded < listed && !state.error && (
          <p className="mono-s activity-note" role="status">
            Fetching close {state.closes!.loaded + 1} / {listed}
          </p>
        )}
        {chain && state.closes !== null && listed === 0 && (
          <EmptyState title="No close hashes for this router">
            The chain has no index of past closes. Add the close tx hashes to <span className="mono">/closes/{data.router}.txt</span>, one per line.
          </EmptyState>
        )}
        {chain && epoch.info && listed > 0 && epoch.info.epoch - 1 > listed && (
          <p className="body activity-note">
            The close list has {listed} closes; the contract is at epoch {epoch.info.epoch}. Later closes have no hash here.
          </p>
        )}
        {state.error && <ErrorState error={state.error} what={chain ? 'a close tx' : 'the logs'} onRetry={state.retry} />}
        {state.staleSince !== null && (
          <p className="body activity-note tone-caution">
            <span aria-hidden="true">! </span>Reading the log failed; rows as of {formatClock(state.staleSince)}.
          </p>
        )}
        {missing.length > 0 && (
          <p className="body activity-note">
            This run has no <span className="mono">{missing.join(' or ')}</span>, so those rows are missing here.
          </p>
        )}

        {!log && groups.length > 0 && (
          <p className="mono-s hire-key">
            <span className="hire-key-sample"><QuoteTube spec={TUBE_KEY} /></span>
            <span>wider: a stronger tube</span>
            <span><span aria-hidden="true">●</span> the price the rule compares</span>
            <span>faded: what the tube took off the quote</span>
            <span>thread: no tube</span>
            <span><span className="tone-agent" aria-hidden="true">◆</span> lowest wins</span>
          </p>
        )}
        {groups.length > 0 ? (
          <EventFeed groups={groups} data={data} q={q} fresh={state.fresh} bars={!log} />
        ) : rows.length > 0 ? (
          <EmptyState title="No rows match these filters">
            <button type="button" className="btn btn-secondary" onClick={() => setFilter(NO_FILTER)}>
              Clear filters
            </button>
          </EmptyState>
        ) : !chain ? (
          <EmptyState title="These logs are empty">Rows appear here as the agents write to them.</EmptyState>
        ) : null}

        {!chain && log && (
          <p className="mono-s activity-note activity-count">
            {stats.decisionLines} decision lines, {stats.eventLines} event lines · {rows.length} rows · {stats.inTimelines} job steps inside decisions’ timelines
            {stats.withoutDecision > 0 && ` · ${stats.withoutDecision} job steps of jobs with no decision line (raw log only)`}
          </p>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {settledNew > 0 ? `${settledNew} new ${settledNew === 1 ? 'settlement' : 'settlements'} in the log` : ''}
        </p>
      </div>
    </ReceiptContext.Provider>
  );
}
