// The Overview's reading of the collection (Design §6.A, §13 item 22): the one line of
// health, the map's frame, the featured rule. Everything is read from a source; nothing
// is estimated. It stays out of the loop model, which only the lazy plate loads.
import type { EpochInfo } from '../chain/router';
import { formatD, formatNear, tubesText } from '../ui/format';
import type { Gallery, GallerySpore } from './gallery';
import { emptyFrame, pairKey, type Frame, type PairKey } from './network';

export interface Health {
  /** Activated spores; `of` is how many were read. */
  active: number;
  of: number;
  tubes: number;
  /** Σ D over the tubes, 1e6 scale. Added up in the browser, so shown as derived. */
  totalD: bigint;
  /** Pairs that settled this epoch; null when the source doesn't say. The chain keeps per-pair totals, not payments. */
  pairs: number | null;
  settled: bigint | null;
  rejected: number | null;
}

/** Each tube once, by its lower id's side. */
function tubeList(g: Gallery): [number, number, string][] {
  const out: [number, number, string][] = [];
  for (const s of g.spores) for (const [n, d] of s.organism.tubes) if (s.organism.id < n) out.push([s.organism.id, n, d]);
  return out;
}

export function healthOf(g: Gallery, info: EpochInfo | null): Health {
  const tubes = tubeList(g);
  const now = info && info.epoch === g.epoch ? info : null;
  return {
    active: g.spores.filter((s) => s.organism.active).length,
    of: g.spores.length,
    tubes: tubes.length,
    totalD: tubes.reduce((sum, [, , d]) => sum + BigInt(d), 0n),
    pairs: now ? now.flows.length : null,
    settled: now ? now.flows.reduce((sum, [, , y]) => sum + BigInt(y), 0n) : null,
    rejected: now ? now.rejects.reduce((sum, [, , n]) => sum + n, 0) : null,
  };
}

/** `64 of 64 active · 4 tubes · 1 pair paid 0.1008 NEAR this epoch`. Four figures at most, inline (Design §2). */
export function healthLine(h: Health): string[] {
  const parts = [`${h.active} of ${h.of} active`, tubesText(h.tubes)];
  if (h.pairs !== null && h.settled !== null) {
    parts.push(h.pairs === 0 ? 'no payment settled this epoch yet' : `${h.pairs} pair${h.pairs === 1 ? '' : 's'} paid ${formatNear(h.settled)} this epoch`);
  }
  return parts;
}

/** The map's frame from the same read as the rest of the page: nothing extra is fetched (Design §10). */
export function frameOfGallery(g: Gallery, info: EpochInfo | null, from: 'edges' | 'snapshot'): Frame {
  const tubes = new Map<PairKey, number>();
  for (const [a, b, d] of tubeList(g)) tubes.set(pairKey(a, b), Number(d));
  const now = info && info.epoch === g.epoch ? info : null;
  return {
    ...emptyFrame(g.epoch, 'live'),
    tubes,
    tubesFrom: from,
    active: g.spores.filter((s) => s.organism.active).map((s) => s.organism.id),
    reputation: new Map(g.spores.map((s) => [s.organism.id, s.organism.reputation])),
    flows: now ? now.flows : null,
    rejects: now ? now.rejects : null,
    flowsFrom: now ? 'chain' : null,
  };
}

/** `Network at epoch 17: 9 active spores, 14 tubes; strongest tube #3–#7 D 0.84` (Design §6.A). */
export function mapSummary(g: Gallery): string {
  const tubes = tubeList(g);
  const active = g.spores.filter((s) => s.organism.active).length;
  const head = `Network at epoch ${g.epoch}: ${active} active spore${active === 1 ? '' : 's'}, ${tubesText(tubes.length)}`;
  if (!tubes.length) return `${head}.`;
  const [a, b, d] = tubes.reduce((best, t) => (BigInt(t[2]) > BigInt(best[2]) ? t : best));
  return `${head}; strongest tube #${a}–#${b} D ${formatD(d)}`;
}

export interface Featured {
  eyebrow: string;
  spores: GallerySpore[];
}

const FEATURED = 4;

/**
 * Highest reputation now. Past those with any, the most recently activated, which is
 * the youngest: the bulk views give age, not an activation time. The eyebrow says so.
 */
export function featuredOf(g: Gallery): Featured {
  const ranked = g.spores.filter((s) => s.organism.reputation > 0).sort((a, b) => b.organism.reputation - a.organism.reputation || a.organism.id - b.organism.id);
  const top = ranked.slice(0, FEATURED);
  if (top.length === FEATURED) return { eyebrow: 'Highest reputation now', spores: top };
  const chosen = new Set(top.map((s) => s.organism.id));
  const young = g.spores.filter((s) => s.organism.active && !chosen.has(s.organism.id)).sort((a, b) => a.organism.age - b.organism.age || a.organism.id - b.organism.id);
  const spores = [...top, ...young].slice(0, FEATURED);
  if (!top.length) return { eyebrow: 'Most recently activated', spores };
  return { eyebrow: spores.length > top.length ? 'Highest reputation now, then most recently activated' : 'Highest reputation now', spores };
}

/** A minute is kept for a keeper that is merely late: past that, nobody is closing. */
export const IDLE_AFTER_MS = 90_000;

/** How long the epoch has been waiting for its close; null while it is running or only just over. */
export function idleFor(info: EpochInfo | null, nowMs: number): number | null {
  if (!info) return null;
  const late = nowMs - Number(BigInt(info.ends_ns) / 1_000_000n);
  return late > IDLE_AFTER_MS ? late : null;
}
