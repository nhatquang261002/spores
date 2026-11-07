// Global states (Design §6.0): static loading placeholders (no shimmer, no
// page spinners), empty states that say why, and inline errors that name the
// endpoint and offer Retry. Failures never fall back to other data.
import type { ReactNode } from 'react';
import { RpcError } from '../chain/rpc';
import { Tooltip } from './Tooltip';

/** A 1 px line the width of the expected value. */
export function LoadingBar({ ch = 6, label = 'Loading' }: { ch?: number; label?: string }) {
  return <span className="loading-bar" style={{ width: `${ch}ch` }} role="status" aria-label={label} />;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="empty-state">
      <h2 className="heading">{title}</h2>
      {children && <div className="body-l">{children}</div>}
    </section>
  );
}

export function ErrorState({ error, what, onRetry, children }: { error: unknown; what: string; onRetry?: () => void; children?: ReactNode }) {
  const endpoint = error instanceof RpcError ? error.endpoint : (error as { url?: string })?.url;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <section className="error-state" role="alert">
      <p className="heading">
        <span className="glyph-warn" aria-hidden="true">✕</span> Could not load {what}
      </p>
      {endpoint && (
        <p className="body">
          Endpoint tried: <span className="mono">{endpoint}</span>
        </p>
      )}
      <p className="mono error-text">{message}</p>
      {onRetry && (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          Retry
        </button>
      )}
      {children}
    </section>
  );
}

/** Unknown value: an em dash with the reason in its tooltip (Design §4.2). Never 0, n/a or blank. */
export function Unavailable({ reason }: { reason: string }) {
  return (
    <Tooltip content={reason}>
      <span className="unavailable">
        <span aria-hidden="true">—</span>
        <span className="sr-only">unavailable: {reason}</span>
      </span>
    </Tooltip>
  );
}
