// Small figures from Design §7: `ReputationIndicator` (R), `ConductivityIndicator`
// (D with a 1 px bar, width ∝ √D against the collection max) and `SporeRef`
// (palette swatch + `#7`, the inline `SporeIdentity`). Units per §1.6.
import type { ReactNode } from 'react';
import { formatD, formatR } from '../ui/format';
import { hex, palettes } from '../ui/tokens';
import { Tooltip } from '../ui/Tooltip';

export { formatD };

export function ReputationIndicator({ r, variant = 'inline', note }: { r: number | null; variant?: 'figure' | 'inline'; note?: ReactNode }) {
  const tip = (
    <>
      R = Σ √D over the spore's tubes; one tube at D 1.00 gives R 1.00. Raw: <span className="mono">{r ?? '—'}</span>. {note}
    </>
  );
  return (
    <Tooltip content={tip}>
      <span className={variant === 'figure' ? 'figure' : 'mono'}>
        R {r === null ? <span className="unavailable">—</span> : formatR(r)}
      </span>
    </Tooltip>
  );
}

/** `D 0.84` + a 1 px bar; below `d_min` the contract drops the tube, so it says so. */
export function ConductivityIndicator({ d, dMax, dMin }: { d: number; dMax: number; dMin: number }) {
  const w = dMax > 0 ? Math.sqrt(Math.min(d, dMax) / dMax) : 0;
  return (
    <span className="conductivity">
      <span className="mono">D {formatD(d)}</span>
      <span className="conductivity-bar" aria-hidden="true">
        <span style={{ width: `${Math.round(w * 100)}%` }} />
      </span>
      {d < dMin && <span className="mono-s unavailable">below threshold</span>}
    </span>
  );
}

export function SporeRef({ id, palette, onClick }: { id: number; palette: number | null; onClick?: () => void }) {
  const body = (
    <>
      {palette !== null && <span className="swatch" style={{ background: hex(palettes[palette].stops[3]) }} aria-hidden="true" />}
      <span className="mono">#{id}</span>
    </>
  );
  if (!onClick) return <span className="spore-ref">{body}</span>;
  return (
    <button type="button" className="spore-ref is-button" onClick={onClick} aria-label={`Select Spore #${id}`}>
      {body}
    </button>
  );
}
