// Top-bar status cluster (Design §5.2, §7): SourceBadge, EpochClock and
// WalletStatus. Status always has a glyph and a word, never colour alone;
// explanations are Tooltips (hover, focus and tap), never a native `title`.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { EpochInfo } from '../chain/router';
import { IDLE_AFTER_MS } from '../model/overview';
import type { Source } from '../model/types';
import { shortRouter, sourceLabel, sourceQuery } from '../sources/source';
import { useApp } from '../state/source';
import { useWallet } from '../state/wallet';
import { nsToMs } from '../state/epoch';
import { formatClock, formatCountdown, shortAccount } from './format';
import { Tooltip } from './Tooltip';

export function SourceBadge({ source, staleSince, compact = false }: { source: Source; staleSince?: number | null; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const label = sourceLabel(source);
  if (staleSince != null) {
    return (
      <Tooltip align="end" content={`Polling has failed since ${formatClock(staleSince)}; values are as of then.`}>
        <span className="source-badge is-stale" role="status">
          <span className="glyph-caution" aria-hidden="true">!</span>
          <span className="label">STALE</span>
          <span className="mono-s">since {formatClock(staleSince)}</span>
        </span>
      </Tooltip>
    );
  }
  const detail = source.kind === 'live' ? `${source.network} · ${shortRouter(source.router)}` : label.detail;
  const glyph =
    source.kind === 'live' ? <span className="dot-live" aria-hidden="true" /> :
    source.kind === 'run' ? <span className="dot-run" aria-hidden="true" /> :
    source.kind === 'recorded' ? <span aria-hidden="true">▶︎</span> : null;
  const body = (
    <>
      {glyph}
      <span className="label">{label.word}</span>
      {(!compact || open) && <span className="mono-s source-detail">{detail}</span>}
    </>
  );
  const cls = `source-badge source-${source.kind}`;
  const full = source.kind === 'live' ? `${label.full} · ${source.router}` : label.full;
  if (compact) {
    // Mobile (§5.3): the glyph and word only; a tap expands the detail.
    return (
      <button type="button" className={`${cls} is-compact`} aria-expanded={open} aria-label={full} onClick={() => setOpen((o) => !o)}>
        {body}
      </button>
    );
  }
  return (
    <Tooltip align="end" content={full}>
      <span className={cls}>{body}</span>
    </Tooltip>
  );
}

/** Ticks every `ms` while mounted. */
export function useNow(ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export type ClockPhase = 'none' | 'counting' | 'closing';

/** Countdown state from chain time; past `ends_ns` it is "closing…" until a close is observed (someone has to call close_epoch). */
export function clockPhase(info: EpochInfo | null, nowMs: number): { phase: ClockPhase; remainingMs: number; fraction: number } {
  if (!info) return { phase: 'none', remainingMs: 0, fraction: 0 };
  const start = nsToMs(info.started_ns);
  const end = nsToMs(info.ends_ns);
  const remainingMs = end - nowMs;
  if (remainingMs <= 0) return { phase: 'closing', remainingMs: 0, fraction: 0 };
  return { phase: 'counting', remainingMs, fraction: Math.min(1, remainingMs / Math.max(1, end - start)) };
}

const ARC_R = 8;
const ARC_LEN = 2 * Math.PI * ARC_R;

export function EpochClock({
  info,
  staleSince,
  reducedMotion,
  unavailable,
}: {
  info: EpochInfo | null;
  /** Set when polling has failed for 30 s: the value stays, marked stale (§4.2). */
  staleSince: number | null;
  reducedMotion: boolean;
  unavailable?: string;
}) {
  const now = useNow(reducedMotion ? 1000 : 250);
  if (unavailable) {
    return (
      <Tooltip align="end" content={unavailable}>
        <span className="epoch-clock">
          <span className="mono">E</span> <span className="mono unavailable">—</span>
        </span>
      </Tooltip>
    );
  }
  const { phase, remainingMs, fraction } = clockPhase(info, now);
  if (phase === 'none' || !info) {
    return (
      <span className="epoch-clock" aria-busy="true" aria-label="Reading the epoch">
        <span className="mono">E</span> <span className="loading-bar" style={{ width: '2ch' }} />
      </span>
    );
  }
  // Past the first moments nothing is on its way: say so, rather than a word that keeps promising.
  const waiting = phase === 'closing' && now - nsToMs(info.ends_ns) > IDLE_AFTER_MS;
  const text = waiting ? 'ended' : phase === 'closing' ? 'closing…' : formatCountdown(remainingMs);
  const stale = staleSince != null;
  const tip = [
    phase === 'closing'
      ? `Epoch ${info.epoch} ended at ${formatClock(nsToMs(info.ends_ns))}. Tubes change when it closes, and at no other moment.`
      : `Epoch ${info.epoch} ends at ${formatClock(nsToMs(info.ends_ns))}.`,
    stale ? `Stale: as of ${formatClock(staleSince)}.` : null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Tooltip align="end" content={tip}>
      <span className={`epoch-clock${stale ? ' is-stale' : ''}`}>
        {stale && (
          <span className="glyph-caution" aria-hidden="true">
            !
          </span>
        )}
        <span className="mono epoch-figure">E {info.epoch}</span>
        {!reducedMotion && (
          <svg className={`epoch-arc phase-${phase}`} width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <circle className="track" cx="10" cy="10" r={ARC_R} />
            <circle
              className="fill"
              cx="10"
              cy="10"
              r={ARC_R}
              strokeDasharray={phase === 'closing' ? '2 3' : `${ARC_LEN * fraction} ${ARC_LEN}`}
              transform="rotate(-90 10 10)"
            />
          </svg>
        )}
        <span className="mono countdown">{text}</span>
      </span>
    </Tooltip>
  );
}

function AvatarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="7" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 17c1-3.5 3.5-5 6-5s5 1.5 6 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Connect / account menu (Design §5.2, §7; on mobile an avatar button, §5.3).
 * States: disconnected, connecting, connected, wrong-network ("Switch to
 * testnet"). The menu holds My Spores, Demo Lab (mobile reaches it here) and
 * Disconnect. Identity only: ownership is decided by `canAct` (§11).
 */
export function WalletStatus() {
  const w = useWallet();
  const { source } = useApp();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const q = source ? sourceQuery(source) : '';

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  if (w.phase === 'disconnected' || w.phase === 'connecting') {
    const busy = w.phase === 'connecting';
    const err = w.error && !busy && (
      <Tooltip align="end" content={<>Could not connect: <span className="mono">{w.error}</span></>}>
        <span className="glyph-warn wallet-error">
          <span aria-hidden="true">✕</span>
          <span className="sr-only">Could not connect: {w.error}</span>
        </span>
      </Tooltip>
    );
    return (
      <span className="wallet">
        {err}
        <span className="only-desktop">
          <button type="button" className="btn btn-secondary" onClick={w.connect} disabled={busy}>
            {busy ? 'Connecting…' : 'Connect wallet'}
          </button>
        </span>
        <span className="only-mobile">
          <button type="button" className="btn-avatar" onClick={w.connect} disabled={busy} aria-label={busy ? 'Connecting…' : 'Connect wallet'}>
            <AvatarIcon />
          </button>
        </span>
      </span>
    );
  }

  const wrong = w.phase === 'wrong-network';
  const account = w.accountId ?? '';
  return (
    <span className="wallet" ref={box} onKeyDown={(e) => e.key === 'Escape' && open && (e.stopPropagation(), setOpen(false))}>
      <span className="only-desktop">
        <button type="button" className={`btn btn-secondary${wrong ? ' is-wrong' : ''}`} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
          {wrong ? (
            <>
              <span className="glyph-caution" aria-hidden="true">!</span> Switch to testnet
            </>
          ) : (
            <span className="mono">{shortAccount(account)}</span>
          )}
        </button>
      </span>
      <span className="only-mobile">
        <button type="button" className="btn-avatar is-connected" aria-expanded={open} aria-haspopup="true" aria-label={wrong ? 'Switch to testnet' : `Wallet ${account}`} onClick={() => setOpen((o) => !o)}>
          <AvatarIcon />
        </button>
      </span>
      {open && (
        <div className="wallet-menu" role="menu" aria-label="Wallet">
          <p className="mono-s wallet-account">{account}</p>
          {wrong && <p className="body">This app acts on testnet only. Disconnect, then connect a testnet account.</p>}
          {!wrong && (
            <Link role="menuitem" className="body" to={`/mine${q}`} onClick={() => setOpen(false)}>
              My Spores
            </Link>
          )}
          <Link role="menuitem" className="body" to={`/lab${q}`} onClick={() => setOpen(false)}>
            Demo Lab
          </Link>
          <button type="button" role="menuitem" className="body wallet-disconnect" onClick={() => (setOpen(false), w.disconnect())}>
            Disconnect
          </button>
        </div>
      )}
    </span>
  );
}
