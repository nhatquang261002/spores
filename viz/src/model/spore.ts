// One spore for the detail page (Design §6.D): the four model types of §11
// plus the art's evidence, read from `spore_summary` + `nft_token` (LIVE) or
// the run's last snapshot (LOCAL RUN / RECORDED). A field the source does not
// carry is null, and the page shows it as unavailable with the reason.
import type { EpochInfo, SporeSummary, Token } from '../chain/router';
import { paletteOf } from '../ui/tokens';
import { readStatus, type RunSnapshot } from './gallery';
import type { AgentAuthorization, Holding, ImageEvidence, Organism, StatusReading } from './types';

export interface SporeEconomy {
  balance: string;
  /** min(owner budget, base + trust_gain × R/1000), computed by the router at read time. */
  effectiveBudget: string;
  /** null where the source has no per-epoch spend (run snapshots). */
  spentThisEpoch: string | null;
  budgetLeft: string | null;
}

export interface SporeView {
  /** The epoch whose state the art and figures show. */
  epoch: number;
  organism: Organism;
  holding: Holding;
  status: StatusReading;
  image: ImageEvidence;
  agent: AgentAuthorization;
  economy: SporeEconomy;
  glyph: string | null;
  /** Jobs it posted and serves now (LIVE only). */
  jobs: { posted: number; serving: number } | null;
  /** The raw `nft_token` view, for Technical (LIVE only). */
  token: Token | null;
  readAt: number;
}

const byId = (t: [number, string][]) => [...t].sort((a, b) => a[0] - b[0]);

function agentOf(id: number, operator: string | null, gen: number, p: SporeSummary['policy']): AgentAuthorization {
  return {
    id,
    operator,
    operatorGen: gen,
    paused: p.paused,
    budgetPerEpoch: p.budget_per_epoch,
    maxPayment: p.max_payment,
    allowAllSpores: p.allow_all_spores,
    allowlist: p.allowlist,
    externalAllowlist: p.external_allowlist ?? [],
  };
}

export function sporeFromLive(s: SporeSummary, token: Token | null, info: Pick<EpochInfo, 'epoch'>, readAt: number): SporeView {
  const id = s.spore_id;
  const state = s.state && s.state[0] === info.epoch ? s.state[1] : null;
  const img = s.image ?? null;
  return {
    epoch: info.epoch,
    organism: {
      id,
      seed: s.seed,
      palette: paletteOf(s.seed).idx,
      age: s.age,
      tubes: byId(s.connections),
      reputation: Number(s.reputation),
      active: s.active,
      epoch: info.epoch,
    },
    holding: { id, owner: s.owner_id, listedPrice: s.listed_price ?? null, sales: s.sales, transfers: s.transfers },
    status: readStatus({ active: s.active, policy: s.policy, operator: s.operator_id, transfers: s.transfers }),
    image: {
      stateEpoch: info.epoch,
      stateHash: state,
      commit: img ? { epoch: img.epoch, stateHash: img.state_hash, imageHash: img.image_hash, rendererVersion: img.renderer_version } : null,
    },
    agent: agentOf(id, s.operator_id, s.operator_gen, s.policy),
    economy: { balance: s.balance, effectiveBudget: s.effective_budget, spentThisEpoch: s.spent_this_epoch, budgetLeft: s.budget_left },
    glyph: token?.metadata?.media ?? null,
    jobs: { posted: s.posted_jobs.length, serving: s.serving_jobs.length },
    token,
    readAt,
  };
}

function need<T>(v: T | undefined, field: string): T {
  if (v === undefined || v === null) throw new Error(`the snapshot has no ${field} for this spore`);
  return v;
}

/** Snapshot spores carry balance, policy, operator and the effective budget, but not spend or transfers. */
export function sporeFromSnapshot(snap: RunSnapshot, id: number, readAt: number): SporeView {
  const s = snap.spores[String(id)] as RunSnapshot['spores'][string] & { balance?: string; operator_gen?: number; effective_budget?: string };
  if (!s) throw new Error(`the ${snap.label || `epoch ${snap.epoch}`} snapshot has no Spore #${id}`);
  const r = s.render_input;
  const active = snap.epoch_info.active.includes(id);
  return {
    epoch: r.epoch,
    organism: {
      id,
      seed: r.seed,
      palette: paletteOf(r.seed).idx,
      age: r.age,
      tubes: byId(r.edges.map(([n, d]) => [n, String(d)] as [number, string])),
      reputation: Number(s.reputation),
      active,
      epoch: r.epoch,
    },
    holding: { id, owner: s.owner_id, listedPrice: s.listed_price, sales: s.sales ?? null, transfers: null },
    status: readStatus({ active, policy: s.policy, operator: s.operator_id, transfers: null }),
    image: {
      stateEpoch: r.epoch,
      stateHash: s.state && s.state[0] === r.epoch ? s.state[1] : null,
      commit: s.image ? { epoch: s.image.epoch, stateHash: s.image.state_hash, imageHash: s.image.image_hash, rendererVersion: s.image.renderer_version } : null,
    },
    agent: agentOf(id, s.operator_id, s.operator_gen ?? 0, s.policy),
    economy: { balance: need(s.balance, 'balance'), effectiveBudget: need(s.effective_budget, 'effective_budget'), spentThisEpoch: null, budgetLeft: null },
    glyph: null,
    jobs: null,
    token: null,
    readAt,
  };
}

/** Each tube's share of R: isqrt(D) / R (R = Σ isqrt(D), Design §1.6). */
export function shareOfR(d: string, r: number): number {
  if (r <= 0) return 0;
  return Number(isqrt(BigInt(d))) / r;
}

export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}
