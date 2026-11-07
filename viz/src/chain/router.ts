// Typed views of the Spores router (docs/how-it-works.md §3). Names
// and shapes follow the router ABI; U128/U64 stay decimal strings (money is
// formatted with BigInt, never Number).
import { Rpc } from './rpc';

export type Yocto = string;
export type Hex32 = string;
/** `[a, b, D]` with a < b, D on the 1e6 scale. */
export type EdgeTuple = [number, number, string];

export interface RouterConfig {
  supply_cap: number;
  max_active: number;
  epoch_len_ns: string;
  job_timeout_ns: string;
  min_activation_deposit: Yocto;
  decay_bps: number;
  gain: string;
  k: Yocto;
  d_min: string;
  fee_bps: number;
  rebate_bps: number;
  breadth_full: number;
  reject_bps: number;
  base_budget: Yocto;
  trust_gain: Yocto;
  royalty_bps: number;
  royalty_account: string | null;
}

/** The epoch in progress, with what it has collected so far. */
export interface EpochInfo {
  epoch: number;
  started_ns: string;
  ends_ns: string;
  prev_fingerprint: Hex32;
  active: number[];
  pool: Yocto;
  flows: [number, number, Yocto][];
  rejects: [number, number, number][];
}

export interface ImageCommit {
  epoch: number;
  state_hash: Hex32;
  image_hash: Hex32;
  renderer_version: number;
}

/** `metadata.extra`, a JSON string in the token. */
export interface TokenExtra {
  seed: Hex32;
  active: boolean;
  age: number;
  degree: number;
  reputation: number;
  transfers: number;
  sales: number;
  listed_price: Yocto | null;
  state_hash: Hex32 | null;
  image: ImageCommit | null;
}

export interface Token {
  token_id: string;
  owner_id: string;
  metadata: {
    title: string | null;
    description: string | null;
    /** The on-chain SVG glyph as a data URI. */
    media: string | null;
    media_hash: string | null;
    extra: string | null;
    [k: string]: unknown;
  };
  approved_account_ids?: Record<string, number> | null;
}

/** A token with `extra` parsed. */
export interface SporeToken {
  id: number;
  owner_id: string;
  title: string;
  glyph: string | null;
  extra: TokenExtra;
}

export interface Policy {
  paused: boolean;
  budget_per_epoch: Yocto;
  max_payment: Yocto;
  allow_all_spores: boolean;
  allowlist: number[];
  external_allowlist: string[];
}

export interface SporeSummary {
  spore_id: number;
  owner_id: string;
  active: boolean;
  operator_id: string | null;
  operator_gen: number;
  balance: Yocto;
  reputation: string;
  age: number;
  degree: number;
  connections: [number, string][];
  policy: Policy;
  spent_this_epoch: Yocto;
  effective_budget: Yocto;
  budget_left: Yocto;
  seed: Hex32;
  posted_jobs: number[];
  serving_jobs: number[];
  transfers: number;
  sales: number;
  listed_price: Yocto | null;
  state?: [number, Hex32] | null;
  image?: ImageCommit | null;
}

/** Exactly what the renderer needs; D is a JSON number here (it fits u64). */
export interface RenderInput {
  spore_id: number;
  epoch: number;
  seed: Hex32;
  age: number;
  edges: [number, number][];
}

export function parseToken(t: Token): SporeToken {
  const id = Number(t.token_id);
  if (!Number.isInteger(id)) throw new Error(`token id is not a spore id: ${t.token_id}`);
  if (!t.metadata?.extra) throw new Error(`token ${id} has no metadata.extra`);
  return {
    id,
    owner_id: t.owner_id,
    title: t.metadata.title ?? `Spore #${id}`,
    glyph: t.metadata.media ?? null,
    extra: JSON.parse(t.metadata.extra) as TokenExtra,
  };
}

export class Router {
  readonly rpc: Rpc;
  readonly id: string;
  constructor(rpc: Rpc, id: string) {
    this.rpc = rpc;
    this.id = id;
  }

  private view<T>(method: string, args: object = {}): Promise<T> {
    return this.rpc.view<T>(this.id, method, args);
  }

  config() {
    return this.view<RouterConfig>('config');
  }
  epochInfo() {
    return this.view<EpochInfo>('epoch_info');
  }
  /** Tubes as of the last close. */
  edges() {
    return this.view<EdgeTuple[]>('edges');
  }
  listings() {
    return this.view<[number, Yocto][]>('listings');
  }
  /** The admin account; the keeper signs closes with a key on it (the `tx` lookup needs the sender). */
  admin() {
    return this.view<string>('admin');
  }
  fingerprint(epoch: number) {
    return this.view<Hex32 | null>('fingerprint', { epoch });
  }
  nftTotalSupply() {
    return this.view<string>('nft_total_supply').then(Number);
  }
  nftTokens(fromIndex: number, limit: number) {
    return this.view<Token[]>('nft_tokens', { from_index: String(fromIndex), limit });
  }
  nftToken(id: number) {
    return this.view<Token | null>('nft_token', { token_id: String(id) });
  }
  nftTokensForOwner(accountId: string, fromIndex = 0, limit = 64) {
    return this.view<Token[]>('nft_tokens_for_owner', { account_id: accountId, from_index: String(fromIndex), limit });
  }
  sporeSummary(id: number) {
    return this.view<SporeSummary | null>('spore_summary', { spore_id: id });
  }
  renderInput(id: number) {
    return this.view<RenderInput | null>('render_input', { spore_id: id });
  }
  imageCommit(id: number) {
    return this.view<ImageCommit | null>('image_commit', { spore_id: id });
  }
  /** NEP-199: how a sale at `price` would be split between the owner and the royalty account. */
  nftPayout(id: number, price: Yocto) {
    return this.view<{ payout: Record<string, Yocto> }>('nft_payout', { token_id: String(id), balance: price });
  }

  /** The ids `account` owns, `pageSize` tokens per call (as `allTokens`). */
  async idsOwnedBy(account: string, pageSize = 16): Promise<number[]> {
    const out: number[] = [];
    for (;;) {
      const page = await this.nftTokensForOwner(account, out.length, pageSize);
      out.push(...page.map((t) => Number(t.token_id)));
      if (page.length < pageSize) return out.sort((a, b) => a - b);
    }
  }

  /**
   * Every token, `pageSize` per call (Design §10: 16). `nft_tokens` for all 64
   * at once was 26 Tgas at 9 active and is unmeasured at 64 active.
   */
  async allTokens(pageSize = 16): Promise<SporeToken[]> {
    const out: SporeToken[] = [];
    for (;;) {
      const page = await this.nftTokens(out.length, pageSize);
      out.push(...page.map(parseToken));
      if (page.length < pageSize) return out;
    }
  }
}
