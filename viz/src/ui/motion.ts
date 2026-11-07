// Reduced motion (Design §3.5): the OS setting only (the footer toggle was
// dropped 2026-11-04: "just give it motion"). Mirrored on
// <html data-reduced-motion>, which zeroes the duration tokens in tokens.css.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function systemReduces(): boolean {
  return typeof matchMedia === 'function' && matchMedia(QUERY).matches;
}

/** True when the OS asks for reduced motion. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(systemReduces);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(QUERY);
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.reducedMotion = String(reduced);
  }, [reduced]);

  return reduced;
}

export type Swell = { dir: 'grew' | 'decayed' | null; n: number };

/**
 * Epoch-close swell (Design §3.5): which way `value` moved the last time
 * `epoch` went up. R and D change only at a close, so a rise in the loaded
 * epoch is the confirmed trigger. The first values seen, an epoch that didn't
 * rise and a value that didn't change don't count. `n` counts swells, so a
 * `key` on it restarts the animation.
 */
export function useCloseSwell(epoch: number, value: number): Swell {
  const last = useRef<{ epoch: number; value: number } | null>(null);
  const [swell, setSwell] = useState<Swell>({ dir: null, n: 0 });
  useLayoutEffect(() => {
    const prev = last.current;
    if (prev && epoch > prev.epoch && value !== prev.value) {
      setSwell((s) => ({ dir: value > prev.value ? 'grew' : 'decayed', n: s.n + 1 }));
    }
    last.current = { epoch, value };
  }, [epoch, value]);
  return swell;
}
