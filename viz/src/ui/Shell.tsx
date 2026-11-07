// App frame (Design §5): skip link, sticky top bar (nav + status cluster), the
// RECORDED banner, mobile bottom bar, footer (its vein; motion follows the OS),
// and the tx tray. Links keep the current `?source=`. The landing page at `/` is
// outside the app's nav and has its own frame (§13 item 23).
import { useRef, type ReactNode } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { sourceQuery } from '../sources/source';
import { useApp } from '../state/source';
import { EpochClock, SourceBadge, WalletStatus } from './status';
import { TxTray } from './TxTray';
import { VeinPulse } from './VeinPulse';
import { VeinTube } from './VeinTube';

export const NAV = [
  { to: '/network', label: 'Network', short: 'Network', icon: 'network' },
  { to: '/mine', label: 'My Spores', short: 'Mine', icon: 'mine' },
  { to: '/market', label: 'Marketplace', short: 'Market', icon: 'market' },
  { to: '/activity', label: 'Activity', short: 'Activity', icon: 'activity' },
] as const;

function Icon({ name }: { name: (typeof NAV)[number]['icon'] }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const };
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      {name === 'network' && <><circle cx="10" cy="10" r="7" {...p} /><path d="M10 3 L15 15 M10 3 L5 15 M5 15 L15 15" {...p} /></>}
      {name === 'mine' && <><circle cx="10" cy="7" r="3" {...p} /><path d="M4 17c1-3.5 3.5-5 6-5s5 1.5 6 5" {...p} /></>}
      {name === 'market' && <><rect x="3" y="3" width="6" height="6" {...p} /><rect x="11" y="3" width="6" height="6" {...p} /><rect x="3" y="11" width="6" height="6" {...p} /><rect x="11" y="11" width="6" height="6" {...p} /></>}
      {name === 'activity' && <path d="M3 10h3l2-5 4 10 2-5h3" {...p} />}
    </svg>
  );
}

/** The small-size brand mark (brand/favicon.svg) beside the name. Its tile is `--bg`, so on the bar only the mark shows. */
function BrandLink({ to }: { to: string }) {
  return (
    <Link to={to} className="wordmark" aria-label="Spores, home">
      <img className="brand-mark" src={`${import.meta.env?.BASE_URL ?? '/'}favicon.svg`} alt="" width={44} height={44} />
      Spores
    </Link>
  );
}

function TopBar() {
  const { source, epoch, reducedMotion } = useApp();
  const bar = useRef<HTMLElement>(null);
  const q = source ? sourceQuery(source) : '';
  const notLive =
    source && source.kind !== 'live' ? `No live epoch: this view reads ${source.kind === 'sim' ? 'simulation output' : `run ${source.run}`}` : undefined;
  return (
    <header className="topbar" ref={bar}>
      <BrandLink to={`/${q}`} />
      <nav className="topnav" aria-label="Primary">
        {NAV.map((n) => (
          <NavLink key={n.to} to={`${n.to}${q}`} className="navlink">
            {n.label}
          </NavLink>
        ))}
      </nav>
      <div className="status-cluster">
        <NavLink to={`/lab${q}`} className="navlink lab-link">
          Demo Lab
        </NavLink>
        {source && (
          <>
            <span className="only-desktop">
              <SourceBadge source={source} staleSince={epoch.staleSince} />
            </span>
            <span className="only-mobile">
              <SourceBadge source={source} staleSince={epoch.staleSince} compact />
            </span>
          </>
        )}
        <EpochClock info={epoch.info} staleSince={epoch.staleSince} reducedMotion={reducedMotion} unavailable={notLive} />
        <WalletStatus />
      </div>
      <VeinTube edge="bottom" reducedMotion={reducedMotion} />
      <VeinPulse epoch={notLive ? null : epoch.info?.epoch} reducedMotion={reducedMotion} container={bar} />
    </header>
  );
}

function BottomBar() {
  const { source, reducedMotion } = useApp();
  const q = source ? sourceQuery(source) : '';
  return (
    <nav className="bottombar" aria-label="Primary (mobile)">
      <VeinTube edge="top" lag={4000} reducedMotion={reducedMotion} />
      {NAV.map((n) => (
        <NavLink key={n.to} to={`${n.to}${q}`} className="bottomlink">
          <Icon name={n.icon} />
          <span>{n.short}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function RecordedBanner() {
  const { source } = useApp();
  if (source?.kind !== 'recorded') return null;
  return (
    <div className="recorded-banner body" role="note">
      Recorded playback{source.date ? ` from ${source.date}` : ''}. Nothing here is happening now.
    </div>
  );
}

/** The landing page's own sections. */
export const LANDING_SECTIONS = [
  { id: 'what', label: 'What it is' },
  { id: 'how', label: 'How it works' },
  { id: 'proof', label: 'Proof' },
] as const;

function LandingBar() {
  const { source, reducedMotion } = useApp();
  const q = source ? sourceQuery(source) : '';
  return (
    <header className="topbar landing-bar">
      <BrandLink to={`/${q}`} />
      <nav className="topnav landing-nav" aria-label="On this page">
        {LANDING_SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="navlink">
            {s.label}
          </a>
        ))}
      </nav>
      <Link className="btn btn-secondary landing-enter" to={`/network${q}`}>
        Open the app
      </Link>
      <VeinTube edge="bottom" reducedMotion={reducedMotion} />
    </header>
  );
}

/** The page before the app: its own bar, no app nav, no wallet, no bottom bar. */
export function LandingFrame() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <LandingBar />
      <RecordedBanner />
      <main id="main" className="page landing-page" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}

export function Shell({ children }: { children?: ReactNode }) {
  const { reducedMotion } = useApp();
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <TopBar />
      <RecordedBanner />
      <main id="main" className="page" tabIndex={-1}>
        {children ?? <Outlet />}
      </main>
      <footer className="footer">
        <VeinTube edge="top" lag={2000} reducedMotion={reducedMotion} />
      </footer>
      <BottomBar />
      <TxTray />
    </>
  );
}
