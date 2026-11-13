// The source a view reads from, picked by the `?source=` query param so it
// persists across navigation (Design §5.1), and its labels (Design §4.1).
import type { Source } from '../model/types';

export const DEFAULT_ROUTER: string = import.meta.env?.VITE_ROUTER || 'spores-hack-router5.testnet';

const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `?source=live` (default), `?source=run&run=<name>`,
 * `?source=recorded&run=<name>&date=<date>`. An unusable combination is an
 * error, never a silent fallback to another source.
 */
export function parseSource(search: string, router: string = DEFAULT_ROUTER): Source {
  const q = new URLSearchParams(search);
  const kind = q.get('source') ?? 'live';
  const run = q.get('run') ?? '';
  if (kind === 'live') return { kind: 'live', network: 'testnet', router };
  if (kind === 'run' || kind === 'recorded') {
    if (!RUN_NAME.test(run)) throw new Error(`?source=${kind} needs a run name (?run=<name>), got "${run}"`);
    if (kind === 'run') return { kind: 'run', run };
    return { kind: 'recorded', run, date: q.get('date') ?? '' };
  }
  if (kind === 'sim') return { kind: 'sim' };
  throw new Error(`unknown source "${kind}" (live, run, recorded or sim)`);
}

/** Query string that selects `s`, for links that keep the source. */
export function sourceQuery(s: Source): string {
  switch (s.kind) {
    case 'live':
      return '';
    case 'run':
      return `?source=run&run=${encodeURIComponent(s.run)}`;
    case 'recorded':
      return `?source=recorded&run=${encodeURIComponent(s.run)}${s.date ? `&date=${encodeURIComponent(s.date)}` : ''}`;
    case 'sim':
      return '?source=sim';
  }
}

/** Badge word and detail text (Design §4.1). */
export function sourceLabel(s: Source): { word: string; detail: string; full: string } {
  switch (s.kind) {
    case 'live':
      return { word: 'LIVE', detail: `${s.network} · ${s.router}`, full: `LIVE · ${s.network}` };
    case 'run':
      return { word: 'LOCAL RUN', detail: s.run, full: `LOCAL RUN · ${s.run}` };
    case 'recorded':
      return { word: 'RECORDED', detail: s.date ?? '', full: s.date ? `RECORDED · ${s.date}` : 'RECORDED' };
    case 'sim':
      return { word: 'SIMULATION', detail: 'simulator output', full: 'SIMULATION' };
  }
}

/** Short router name for the top bar (`spores-hack-router4.testnet` → `router4`). */
export function shortRouter(id: string): string {
  const m = /(router\d*)/.exec(id);
  return m ? m[1] : id;
}

/** A link to `path` that keeps the source query `q` and adds `params` (`network`, `3-7`-style values are passed as is). */
export function linkTo(path: string, q: string, params: Record<string, string | number> = {}): string {
  const extra = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  return extra ? `${path}${q ? `${q}&` : '?'}${extra}` : `${path}${q}`;
}
