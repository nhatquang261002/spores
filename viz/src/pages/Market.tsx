// Marketplace = the collection gallery (Design §5.1, §6.B): all 64 spores,
// or the ones for sale as `MarketplaceListing` cards with Buy (§6.F), with
// sort and filter in the URL. Owners list from a Spore's page.
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { artKey } from '../components/SporeArtwork';
import { BuyAction } from '../components/ownerActions';
import { SporeCard } from '../components/SporeCard';
import '../components/gallery.css';
import { canAct } from '../model/actions';
import {
  activeWord,
  describeFilters,
  filterSpores,
  matchesState,
  NO_FILTERS,
  parseFilters,
  parseSort,
  SORTS,
  sortSpores,
  writeFilters,
  type Filters,
  type GallerySpore,
} from '../model/gallery';
import { shortRouter, sourceQuery } from '../sources/source';
import { useGallery } from '../state/gallery';
import { useApp } from '../state/source';
import { useWallet } from '../state/wallet';
import { formatClock } from '../ui/format';
import { EmptyState, ErrorState, LoadingBar } from '../ui/states';
import { SourceBadge } from '../ui/status';
import { hex, palettes } from '../ui/tokens';
import { Tooltip } from '../ui/Tooltip';

type View = 'all' | 'listed';

/** Columns of the laid-out grid: the items on the first row. */
function columnsOf(items: HTMLElement[]): number {
  const top = items[0]?.offsetTop;
  return Math.max(1, items.filter((el) => el.offsetTop === top).length);
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="chip" aria-pressed={pressed} onClick={onClick}>
      {children}
    </button>
  );
}

/** Design §6.B chips with their counts over the whole collection. OR within states and palettes, AND across. */
function FilterChips({
  all,
  filters,
  coarse,
  account,
  set,
}: {
  all: GallerySpore[];
  filters: Filters;
  coarse: boolean;
  /** The connected wallet: the "Owned by me" chip shows only with one. */
  account: string | null;
  set: (f: Filters) => void;
}) {
  const toggleState = (w: 'active' | 'dormant') =>
    set({ ...filters, state: filters.state.includes(w) ? filters.state.filter((x) => x !== w) : [...filters.state, w] });
  const togglePal = (i: number) =>
    set({ ...filters, palettes: filters.palettes.includes(i) ? filters.palettes.filter((x) => x !== i) : [...filters.palettes, i] });
  const count = (f: (s: GallerySpore) => boolean) => all.filter(f).length;
  return (
    <div className="chips" role="group" aria-label="Filters">
      <Chip pressed={filters.state.includes('active')} onClick={() => toggleState('active')}>
        {activeWord(coarse)} <span className="mono-s">{count((s) => matchesState(s, 'active'))}</span>
      </Chip>
      <Chip pressed={filters.state.includes('dormant')} onClick={() => toggleState('dormant')}>
        Dormant <span className="mono-s">{count((s) => matchesState(s, 'dormant'))}</span>
      </Chip>
      <Chip pressed={filters.listed} onClick={() => set({ ...filters, listed: !filters.listed })}>
        Listed <span className="mono-s">{count((s) => s.holding.listedPrice !== null)}</span>
      </Chip>
      <Chip pressed={filters.tubes} onClick={() => set({ ...filters, tubes: !filters.tubes })}>
        Has tubes <span className="mono-s">{count((s) => s.organism.tubes.length > 0)}</span>
      </Chip>
      {palettes.map((p) => (
        <Chip key={p.idx} pressed={filters.palettes.includes(p.idx)} onClick={() => togglePal(p.idx)}>
          <span className="swatch" style={{ background: hex(p.stops[3]) }} aria-hidden="true" />
          {p.name} <span className="mono-s">{count((s) => s.organism.palette === p.idx)}</span>
        </Chip>
      ))}
      {account && (
        <Chip pressed={!!filters.mine} onClick={() => set({ ...filters, mine: !filters.mine })}>
          Owned by me <span className="mono-s">{count((s) => s.holding.owner === account)}</span>
        </Chip>
      )}
    </div>
  );
}

export function Market() {
  const { source, epoch, router, reducedMotion } = useApp();
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'listed' ? 'listed' : 'all';
  const sort = parseSort(params.get('sort'));
  const filterKey = `${params.get('f') ?? ''}|${params.get('pal') ?? ''}`;
  const filters = useMemo(() => parseFilters(params), [filterKey]); // by value: `params` is a new object on every render
  const g = useGallery(source, router, epoch.info?.epoch);
  const wallet = useWallet();
  const account = wallet.phase === 'connected' ? wallet.accountId : null;
  const [done, setDone] = useState<ReadonlyMap<number, string>>(new Map());
  const [focusId, setFocusId] = useState<number | null>(null);
  const grid = useRef<HTMLUListElement>(null);

  const all = useMemo(() => g.data?.spores ?? [], [g.data]);
  const listedCount = all.filter((s) => s.holding.listedPrice !== null).length;
  const shown = useMemo(
    () => sortSpores(filterSpores(view === 'listed' ? all.filter((s) => s.holding.listedPrice !== null) : all, filters, account), sort),
    [all, view, filters, sort, account],
  );

  const onArt = useCallback((id: number, key: string) => setDone((m) => (m.get(id) === key ? m : new Map(m).set(id, key))), []);
  const renderedCount = shown.filter((s) => done.get(s.organism.id) === artKey(s.organism)).length;

  const setQuery = (next: URLSearchParams) => setParams(next, { replace: true });
  const setFilters = (f: Filters) => setQuery(writeFilters(params, f));
  const withParam = (k: string, v: string | null) => {
    const q = new URLSearchParams(params);
    if (v === null) q.delete(k);
    else q.set(k, v);
    return q;
  };

  if (!source) return null;
  const q = sourceQuery(source);
  const coarse = g.data?.coarseStatus ?? source.kind === 'live';
  const staleAt = g.data && source.kind === 'live' && (epoch.staleSince != null || g.error) ? g.data.readAt : null;
  const current = shown.some((s) => s.organism.id === focusId) ? focusId : (shown[0]?.organism.id ?? null);
  const where = source.kind === 'live' ? shortRouter(source.router) : source.kind === 'sim' ? 'the simulation' : source.run;

  // Roving focus (Design §9): one tab stop; arrows, Home and End move inside the grid.
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const links = [...(grid.current?.querySelectorAll<HTMLAnchorElement>('a.spore-card') ?? [])];
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (i < 0) return;
    const cols = columnsOf(links.map((a) => a.parentElement as HTMLElement));
    const moves: Record<string, number> = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: links.length - 1 };
    if (!(e.key in moves)) return;
    e.preventDefault();
    const j = Math.max(0, Math.min(links.length - 1, moves[e.key]));
    links[j].focus();
    setFocusId(Number(links[j].dataset.id));
  };

  let body: ReactNode;
  if (!g.data && g.error) {
    body = (
      <ErrorState error={g.error} what={source.kind === 'live' ? 'the collection' : `the collection from ${where}`} onRetry={g.retry}>
        {source.kind !== 'live' && <p className="body">A Demo Lab recording holds one scene, not the whole collection. <Link to="/market">Open the marketplace on LIVE</Link>.</p>}
      </ErrorState>
    );
  } else if (!g.data) {
    body = (
      <p className="body gallery-status" aria-busy="true">
        Reading the collection from <span className="mono">{where}</span> <LoadingBar ch={8} label="Reading the collection" />
      </p>
    );
  } else if (view === 'listed' && listedCount === 0) {
    body = <EmptyState title="Nothing is listed right now">Owners list from a Spore's page.</EmptyState>;
  } else if (shown.length === 0) {
    body = (
      <EmptyState title={`No spores match ${describeFilters(filters, coarse)}.`}>
        <button type="button" className="btn btn-secondary" onClick={() => setFilters(NO_FILTERS)}>
          Clear filters
        </button>
      </EmptyState>
    );
  } else {
    body = (
      <ul className="gallery-grid" ref={grid} onKeyDown={onKeyDown} onFocus={(e) => e.target.dataset.id && setFocusId(Number(e.target.dataset.id))} aria-label={`${shown.length} spores`}>
        {shown.map((s, i) => (
          <SporeCard
            key={s.organism.id}
            spore={s}
            to={`/spore/${s.organism.id}${q}`}
            tabIndex={s.organism.id === current ? 0 : -1}
            priority={1 + i}
            stale={staleAt !== null}
            viewTransition={!reducedMotion}
            onArt={onArt}
            from={{ label: 'Marketplace', to: `/market${view === 'listed' ? `?${withParam('view', 'listed')}` : q}` }}
            variant={view === 'listed' ? 'listing' : 'default'}
            action={
              view === 'listed' && router && s.holding.listedPrice ? (
                <BuyAction
                  router={router}
                  sporeId={s.organism.id}
                  owner={s.holding.owner}
                  price={s.holding.listedPrice}
                  balance={null}
                  gate={canAct('buy', s.holding, { phase: wallet.phase, accountId: wallet.accountId }, { active: s.organism.active, paused: false })}
                  setupHref={`/spore/${s.organism.id}${q}`}
                  onFinal={g.retry}
                />
              ) : undefined
            }
          />
        ))}
      </ul>
    );
  }

  return (
    <>
      <div className="gallery-header">
        <div className="gallery-header-row">
          <h1 className="title">Marketplace</h1>
          <SourceBadge source={source} staleSince={epoch.staleSince} />
          <nav className="segmented" aria-label="Gallery view">
            <Link to={`?${withParam('view', 'all')}`} aria-current={view === 'all' ? 'page' : undefined} replace>
              All <span className="mono-s">{g.data ? all.length : '—'}</span>
            </Link>
            <Link to={`?${withParam('view', 'listed')}`} aria-current={view === 'listed' ? 'page' : undefined} replace>
              For sale <span className="mono-s">({g.data ? listedCount : '—'})</span>
            </Link>
          </nav>
          <label className="label sort">
            Sort{' '}
            <select value={sort} onChange={(e) => setQuery(withParam('sort', e.target.value === 'id' ? null : e.target.value))}>
              {SORTS.filter((o) => o.key !== 'price' || listedCount > 0 || sort === 'price').map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <span className="gallery-progress mono-s" role="status">
            {staleAt !== null && (
              <Tooltip align="end" content={`The collection was read at ${formatClock(staleAt)}; ${g.error ? 'reading it again failed' : 'polling has failed since'}.`}>
                <span className="stale-mark">
                  <span className="glyph-caution" aria-hidden="true">!</span> as of {formatClock(staleAt)}
                </span>
              </Tooltip>
            )}
            {g.data && shown.length > 0 && renderedCount < shown.length && `Rendering ${renderedCount} / ${shown.length}`}
          </span>
        </div>
        {g.data && <FilterChips all={all} filters={filters} coarse={coarse} account={account} set={setFilters} />}
      </div>
      {g.data && g.error && <ErrorState error={g.error} what={`the collection after epoch ${g.data.epoch}`} onRetry={g.retry} />}
      {body}
    </>
  );
}
