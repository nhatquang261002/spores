// The landing page at `/` (Design §6.A, §13 items 22, 23). The first screen answers "what
// is this?" with one line, one sentence, and a real spore's life told on a plate. Below it
// the lazy story says what a spore is, what we do, how it works and how to check it, and
// what the collection is doing right now is read from the same bulk views as the gallery.
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { NetworkGraph, type NodeInfo } from '../components/NetworkGraph';
import { SporeCard } from '../components/SporeCard';
import '../components/gallery.css';
import '../components/network.css';
import { featuredOf, frameOfGallery, healthLine, healthOf, idleFor, mapSummary } from '../model/overview';
import type { Source } from '../model/types';
import { latestRecording } from '../sources/scene';
import { linkTo, sourceQuery } from '../sources/source';
import { useGallery } from '../state/gallery';
import { useApp } from '../state/source';
import { formatD } from '../ui/format';
import { EmptyState, ErrorState, LoadingBar } from '../ui/states';
import { SourceBadge } from '../ui/status';
import { Tooltip } from '../ui/Tooltip';
import './overview.css';

const OverviewPlate = lazy(() => import('../components/OverviewPlate'));
const LandingStory = lazy(() => import('../components/LandingStory'));

/** True once `el` has come near the screen: what's below the fold starts no work until then. */
function useNear(el: HTMLElement | null): boolean {
  const [near, setNear] = useState(typeof IntersectionObserver !== 'function');
  useEffect(() => {
    if (!el || near) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setNear(true), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [el, near]);
  return near;
}

function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function RightNow({ source }: { source: Source }) {
  const { epoch, router, reducedMotion } = useApp();
  const live = source.kind === 'live';
  const info = live ? epoch.info : null;
  const g = useGallery(source, router, info?.epoch);
  const data = g.data;
  const now = useMinute();
  const q = sourceQuery(source);
  const [mapEl, setMapEl] = useState<HTMLElement | null>(null);
  const mapNear = useNear(mapEl);

  const health = useMemo(() => (data ? healthOf(data, info) : null), [data, info]);
  const frame = useMemo(() => (data ? frameOfGallery(data, info, live ? 'edges' : 'snapshot') : null), [data, info, live]);
  const dMax = useMemo(() => Math.max(1, ...(frame?.tubes?.values() ?? [])), [frame]);
  const rMax = useMemo(() => Math.max(1, ...(data?.spores.map((s) => s.organism.reputation) ?? [])), [data]);
  // Only spores with tubes get their art here: a render per dormant-looking node isn't worth a first visit (Design §10).
  const nodeInfo = useMemo(() => {
    const m = new Map<number, NodeInfo>();
    for (const s of data?.spores ?? []) {
      const o = s.organism;
      m.set(o.id, { palette: o.palette, price: s.holding.listedPrice, paused: s.status.status === 'paused', art: o.tubes.length ? { seed: o.seed, age: o.age, edges: o.tubes } : null, glyph: o.tubes.length ? s.glyph : null });
    }
    return m;
  }, [data]);
  const featured = useMemo(() => (data ? featuredOf(data) : null), [data]);
  const idle = live ? idleFor(info, now) : null;
  const shownEpoch = info?.epoch ?? data?.epoch ?? null;
  const zero = health !== null && health.active === 0;
  const stale = live && epoch.staleSince != null;

  return (
    <div className="landing-section" id="now">
      <p className="ov-section-line">The same collection, read from the chain as you look.</p>
      <section className="ov-now" aria-labelledby="ov-now-title">
        <div className="ov-map" ref={setMapEl}>
          {g.error && !data ? (
            <ErrorState error={g.error} what={live ? 'the network' : 'the network from this source'} onRetry={g.retry}>
              {!live && <p className="body"><Link to="/">Open the overview on LIVE</Link>.</p>}
            </ErrorState>
          ) : !data || !frame || !mapNear ? (
            <div className="ov-map-wait"><LoadingBar ch={12} label="Reading the network" /></div>
          ) : (
            <Link className="ov-map-link" to={linkTo('/network', q)} aria-label="Explore the network">
              <NetworkGraph
                frame={frame}
                nodeInfo={nodeInfo}
                dMax={dMax}
                rMax={rMax}
                diff={null}
                selection={null}
                onSelect={() => {}}
                labels="selected"
                reducedMotion={reducedMotion}
                compactLabel={mapSummary(data)}
              />
            </Link>
          )}
          {data && <Link className="body ov-map-table" to={linkTo('/network', q, { view: 'table' })}>View as table</Link>}
        </div>

        <div className="ov-now-copy">
          <div className="ov-now-source">
            <h2 id="ov-now-title" className="eyebrow">{live ? 'Right now' : 'At the end of this recording'}</h2>
            <SourceBadge source={source} staleSince={epoch.staleSince} compact />
          </div>
          <p className={`figure-l ov-epoch${stale ? ' is-stale' : ''}`}>
            {shownEpoch !== null ? `Epoch ${shownEpoch}` : <LoadingBar ch={8} label="Reading the epoch" />}
          </p>
          {health ? (
            <p className="body ov-health">
              {healthLine(health).join(' · ')}{' '}
              <Tooltip content={<>Total tube strength (D) ≈ {formatD(health.totalD.toString())}, added up in your browser from the tubes.</>}>
                <span className="ov-more mono-s">more</span>
              </Tooltip>
            </p>
          ) : (
            !g.error && <p className="body ov-health"><LoadingBar ch={24} label="Reading the collection" /></p>
          )}
          {zero ? (
            <p className="body-l ov-why">No spore is active yet. Every tube on this map will come from a settled payment.</p>
          ) : idle !== null ? (
            <p className="body-l ov-why">
              The network is quiet right now. The tubes on this map stay as the last close left them.
            </p>
          ) : live && info ? (
            <p className="body-l ov-why">The tubes on this map change when this epoch closes, and at no other moment.</p>
          ) : null}
          <p className="ov-now-actions">
            <Link className="btn btn-secondary" to={linkTo('/network', q)}>Explore the network</Link>
          </p>
        </div>
      </section>

      <section className="ov-featured" aria-labelledby="ov-featured-title">
        <div className="ov-section-head">
          <h2 id="ov-featured-title" className="eyebrow">{featured?.eyebrow ?? 'Highest reputation now'}</h2>
          <Link className="body" to={linkTo('/market', q, { view: 'all' })}>Browse all 64 →</Link>
        </div>
        {g.error && !data ? (
          <p className="body ov-why">The cards need the same read as the map above.</p>
        ) : !featured ? (
          <LoadingBar ch={12} label="Reading the collection" />
        ) : featured.spores.length === 0 ? (
          <EmptyState title="No spore is active yet">Spores appear here once they are activated.</EmptyState>
        ) : (
          <ul className="ov-cards" role="list">
            {featured.spores.map((s) => (
              <SporeCard key={s.organism.id} spore={s} to={linkTo(`/spore/${s.organism.id}`, q)} tabIndex={0} priority={2} stale={stale} from={{ label: 'Home', to: linkTo('/', q) }} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** The newest recording of the whole loop as a query; null until it's known, or if there's none. */
function useRecordingQuery(): string | null {
  const [q, setQ] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    latestRecording('loop').then(
      (b) => alive && b && setQ(sourceQuery({ kind: 'recorded', run: b.run, date: b.date })),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);
  return q;
}

export function Overview() {
  const { source } = useApp();
  const [hero, setHero] = useState<HTMLElement | null>(null);
  const q = source ? sourceQuery(source) : '';
  // On LIVE nothing is playing, so the whole loop opens on its recording; on a recording it stays there.
  const recording = useRecordingQuery();
  const loopTo = linkTo('/lab/loop', source?.kind === 'live' ? (recording ?? '') : q);
  return (
    <div className="overview">
      <section className="ov-hero" ref={setHero} aria-labelledby="ov-line">
        <div className="ov-copy">
          <h1 id="ov-line" className="ov-line">Sixty-four slime molds that earn, hire and grow by trading with each other.</h1>
          <p className="body-l ov-sentence">Each Spore is an NFT with its own agent. When one pays another for work and the job settles, a tube grows between them. Tubes are reputation, reputation is spending power, and the art is drawn from the tubes.</p>
        </div>
        <div className="ov-actions">
          <Link className="btn btn-primary" to={linkTo('/network', q)}>Explore the network</Link>
          <Link className="btn btn-secondary" to={loopTo}>Watch the whole loop</Link>
        </div>
        <Suspense fallback={<div className="ov-stage"><div className="loop-stages" /></div>}>
          <OverviewPlate hero={hero} />
        </Suspense>
      </section>

      <Suspense fallback={<LoadingBar ch={12} label="Loading the rest of the page" />}>
        <LandingStory now={source && <RightNow source={source} />} />
      </Suspense>
    </div>
  );
}

