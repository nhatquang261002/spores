// The collection gallery's model (Design §6.B): one item per spore from the
// bulk views (LIVE) or a run snapshot (LOCAL RUN / RECORDED), the state
// reading of Design §1.5, the image-hash check, and sort and filter.
import type { EdgeTuple, EpochInfo, ImageCommit, Policy, SporeToken } from '../chain/router';
import { paletteOf, palettes } from '../ui/tokens';
import type { Holding, ImageEvidence, Organism, SporeStatus, StatusReading } from './types';

export interface GallerySpore {
  organism: Organism;
  holding: Holding;
  status: StatusReading;
  image: ImageEvidence;
  /** NEP-177 `media`, the on-chain glyph; run snapshots don't carry it. */
  glyph: string | null;
  /** Trade pairs (flows and rejects) with this spore in the epoch in progress. */
  pairsThisEpoch: number;
}

export interface Gallery {
  /** The epoch in progress; the art shows the state written at its start (the last close). */
  epoch: number;
  spores: GallerySpore[];
  /** When the data was read (ms). */
  readAt: number;
  /** True when the status is the bulk-view reading (`activated`), not the full §1.5 set. */
  coarseStatus: boolean;
}

/**
 * Design §1.5. Without the policy (bulk views) an activated spore is only
 * `activated`. A paused spore with no operator was reset by a transfer: no
 * event is read here, so that is derived. With the operator set, transfers 0
 * means awaiting policy; unknown transfers leave it `paused`, which is true
 * either way.
 */
export function readStatus(s: { active: boolean; policy?: Pick<Policy, 'paused'> | null; operator?: string | null; transfers?: number | null }): StatusReading {
  const at = (status: SporeStatus, derived = false): StatusReading => ({ status, derived });
  if (!s.active) return at('dormant');
  if (!s.policy) return at('activated');
  if (!s.policy.paused) return at('active');
  if (!s.operator) return at('control-reset', true);
  if (s.transfers === 0) return at('awaiting-policy');
  return at('paused');
}

const commitOf = (c: ImageCommit | null | undefined): ImageEvidence['commit'] =>
  c ? { epoch: c.epoch, stateHash: c.state_hash, imageHash: c.image_hash, rendererVersion: c.renderer_version } : null;

function pairCounts(info: Pick<EpochInfo, 'flows' | 'rejects'>): Map<number, number> {
  const m = new Map<number, number>();
  for (const [a, b] of [...info.flows, ...info.rejects]) {
    m.set(a, (m.get(a) ?? 0) + 1);
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  return m;
}

/** `[neighbour, D]` per spore from `edges()`, by neighbour id (what `render_input` returns). */
export function tubesBySpore(edges: EdgeTuple[]): Map<number, [number, string][]> {
  const m = new Map<number, [number, string][]>();
  const add = (id: number, t: [number, string]) => (m.get(id) ?? m.set(id, []).get(id)!).push(t);
  for (const [a, b, d] of edges) {
    add(a, [b, d]);
    add(b, [a, d]);
  }
  for (const v of m.values()) v.sort((x, y) => x[0] - y[0]);
  return m;
}

/** LIVE: `epoch_info`, every token (`nft_tokens`) and `edges()`, read within one epoch. */
export function galleryFromLive(info: EpochInfo, tokens: SporeToken[], edges: EdgeTuple[], readAt: number): Gallery {
  const tubes = tubesBySpore(edges);
  const pairs = pairCounts(info);
  const spores = tokens
    .map((t): GallerySpore => {
      const x = t.extra;
      return {
        organism: {
          id: t.id,
          seed: x.seed,
          palette: paletteOf(x.seed).idx,
          age: x.age,
          tubes: tubes.get(t.id) ?? [],
          reputation: x.reputation,
          active: x.active,
          epoch: info.epoch,
        },
        holding: { id: t.id, owner: t.owner_id, listedPrice: x.listed_price, sales: x.sales, transfers: x.transfers },
        status: readStatus({ active: x.active }),
        image: { stateEpoch: info.epoch, stateHash: x.state_hash, commit: commitOf(x.image) },
        glyph: t.glyph,
        pairsThisEpoch: pairs.get(t.id) ?? 0,
      };
    })
    .sort((a, b) => a.organism.id - b.organism.id);
  return { epoch: info.epoch, spores, readAt, coarseStatus: true };
}

/** `snapshots/epoch-NNN.json` of a run (Reference C), the fields the gallery reads. */
export interface RunSnapshot {
  label: string;
  epoch: number;
  epoch_info: EpochInfo;
  spores: Record<
    string,
    {
      render_input: { spore_id: number; epoch: number; seed: string; age: number; edges: [number, number | string][] };
      reputation: string | number;
      degree: number;
      owner_id: string;
      operator_id: string | null;
      policy: Policy;
      listed_price: string | null;
      sales?: number;
      state: [number, string] | null;
      image: ImageCommit | null;
    }
  >;
}

/** LOCAL RUN / RECORDED: one snapshot. It has the policy and operator, so the full §1.5 set (no transfer count). */
export function galleryFromSnapshot(snap: RunSnapshot, readAt: number): Gallery {
  const pairs = pairCounts(snap.epoch_info);
  const active = new Set(snap.epoch_info.active);
  const spores = Object.values(snap.spores)
    .map((s): GallerySpore => {
      const r = s.render_input;
      const id = r.spore_id;
      return {
        organism: {
          id,
          seed: r.seed,
          palette: paletteOf(r.seed).idx,
          age: r.age,
          tubes: r.edges.map(([n, d]) => [n, String(d)] as [number, string]).sort((x, y) => x[0] - y[0]),
          reputation: Number(s.reputation),
          active: active.has(id),
          epoch: r.epoch,
        },
        holding: { id, owner: s.owner_id, listedPrice: s.listed_price, sales: s.sales ?? null, transfers: null },
        status: readStatus({ active: active.has(id), policy: s.policy, operator: s.operator_id, transfers: null }),
        image: { stateEpoch: r.epoch, stateHash: s.state && s.state[0] === r.epoch ? s.state[1] : null, commit: commitOf(s.image) },
        glyph: null,
        pairsThisEpoch: pairs.get(id) ?? 0,
      };
    })
    .sort((a, b) => a.organism.id - b.organism.id);
  return { epoch: snap.epoch, spores, readAt, coarseStatus: false };
}

// --- image-hash badge (Design §6.B, plan S6) ---------------------------------

export type ImageBadge = 'match' | 'mismatch' | 'none' | 'older' | 'other-renderer' | 'checking';

/** What this browser's renderer produced for the item's current render input. */
export interface RenderedImage {
  imageHash: string;
  rendererVersion: number;
}

/**
 * A real check: when the commit is for the state the card shows (same epoch
 * and stored state hash), the hash the browser just rendered must equal the
 * committed one. An older commit can't be checked here (the detail page
 * replays it). A commit made with another renderer version can't be compared.
 */
export function imageBadge(ev: ImageEvidence, rendered: RenderedImage | null): ImageBadge {
  const c = ev.commit;
  if (!c) return 'none';
  if (c.epoch !== ev.stateEpoch || ev.stateHash === null || c.stateHash !== ev.stateHash) return 'older';
  if (!rendered) return 'checking';
  if (rendered.rendererVersion !== c.rendererVersion) return 'other-renderer';
  return rendered.imageHash === c.imageHash ? 'match' : 'mismatch';
}

// --- sort and filter (URL-backed, Design §5.1) -------------------------------

export const SORTS = [
  { key: 'id', label: 'Id' },
  { key: 'reputation', label: 'Reputation' },
  { key: 'degree', label: 'Degree' },
  { key: 'age', label: 'Age' },
  { key: 'price', label: 'Price' },
  { key: 'recent', label: 'Recently active' },
] as const;
export type SortKey = (typeof SORTS)[number]['key'];

export function parseSort(v: string | null): SortKey {
  return SORTS.some((s) => s.key === v) ? (v as SortKey) : 'id';
}

/** Ties go to the lower id. Price puts listed spores first, cheapest first. Recently active = most trade pairs this epoch so far. */
export function sortSpores(list: GallerySpore[], key: SortKey): GallerySpore[] {
  const by = (f: (s: GallerySpore) => number) => (a: GallerySpore, b: GallerySpore) => f(b) - f(a) || a.organism.id - b.organism.id;
  const out = [...list];
  switch (key) {
    case 'id':
      return out.sort((a, b) => a.organism.id - b.organism.id);
    case 'reputation':
      return out.sort(by((s) => s.organism.reputation));
    case 'degree':
      return out.sort(by((s) => s.organism.tubes.length));
    case 'age':
      return out.sort(by((s) => s.organism.age));
    case 'recent':
      return out.sort(by((s) => s.pairsThisEpoch));
    case 'price':
      return out.sort((a, b) => {
        const pa = a.holding.listedPrice, pb = b.holding.listedPrice;
        if (pa && pb) return BigInt(pa) < BigInt(pb) ? -1 : BigInt(pa) > BigInt(pb) ? 1 : a.organism.id - b.organism.id;
        if (pa || pb) return pa ? -1 : 1;
        return a.organism.id - b.organism.id;
      });
  }
}

export type StateFilter = 'active' | 'dormant';
export interface Filters {
  /** Either state; empty = any. */
  state: StateFilter[];
  listed: boolean;
  tubes: boolean;
  /** Palette indices; empty = any. */
  palettes: number[];
  /** Owned by the connected wallet (Design §6.B; the chip shows only with a wallet). */
  mine?: boolean;
}

export const NO_FILTERS: Filters = { state: [], listed: false, tubes: false, palettes: [], mine: false };

/** `?f=active,listed,tubes,mine&pal=ember,violet`. Unknown words are ignored. */
export function parseFilters(q: URLSearchParams): Filters {
  const words = (q.get('f') ?? '').split(',').filter(Boolean);
  const pal = (q.get('pal') ?? '').split(',').filter(Boolean);
  return {
    state: (['active', 'dormant'] as const).filter((w) => words.includes(w)),
    listed: words.includes('listed'),
    tubes: words.includes('tubes'),
    palettes: palettes.filter((p) => pal.includes(p.name)).map((p) => p.idx),
    mine: words.includes('mine'),
  };
}

/** Writes `f` and `pal` into `q` (other params, like the source, stay). */
export function writeFilters(q: URLSearchParams, f: Filters): URLSearchParams {
  const out = new URLSearchParams(q);
  const words = [...f.state, ...(f.listed ? ['listed'] : []), ...(f.tubes ? ['tubes'] : []), ...(f.mine ? ['mine'] : [])];
  if (words.length) out.set('f', words.join(','));
  else out.delete('f');
  if (f.palettes.length) out.set('pal', f.palettes.map((i) => palettes[i].name).join(','));
  else out.delete('pal');
  return out;
}

export const hasFilters = (f: Filters) => f.state.length > 0 || f.listed || f.tubes || f.palettes.length > 0 || !!f.mine;

/** `active` is the proven state: `active` with the full set, `activated` with the bulk views. */
export function matchesState(s: GallerySpore, w: StateFilter): boolean {
  if (w === 'dormant') return s.status.status === 'dormant';
  return s.status.status === 'active' || s.status.status === 'activated';
}

/** OR within a group (states, palettes), AND across groups. "Owned by me" with no wallet matches nothing. */
export function filterSpores(list: GallerySpore[], f: Filters, account: string | null = null): GallerySpore[] {
  return list.filter(
    (s) =>
      (!f.mine || (account !== null && s.holding.owner === account)) &&
      (f.state.length === 0 || f.state.some((w) => matchesState(s, w))) &&
      (!f.listed || s.holding.listedPrice !== null) &&
      (!f.tubes || s.organism.tubes.length > 0) &&
      (f.palettes.length === 0 || f.palettes.includes(s.organism.palette)),
  );
}

/** Chip word for the `active` state filter: what the source can prove. */
export const activeWord = (coarse: boolean) => (coarse ? 'Activated' : 'Active');

/** "Active + ember", for the empty-filter sentence. */
export function describeFilters(f: Filters, coarse: boolean): string {
  return [
    ...f.state.map((w) => (w === 'active' ? activeWord(coarse) : 'Dormant')),
    ...(f.listed ? ['Listed'] : []),
    ...(f.tubes ? ['Has tubes'] : []),
    ...f.palettes.map((i) => palettes[i].name),
    ...(f.mine ? ['Owned by me'] : []),
  ].join(' + ');
}
