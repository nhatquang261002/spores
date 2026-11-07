// App model (Design §11). Four model types with no cross-imports, so a later
// non-NFT product can reuse Organism and Economy without the NFT parts:
// SporeArtwork and NetworkGraph take Organism only; marketplace code takes
// Holding only.

/** Where a view's data comes from (Design §4.1). Every view shows it. */
export type Source =
  | { kind: 'live'; network: 'testnet'; router: string }
  | { kind: 'run'; run: string }
  | { kind: 'recorded'; run: string; date: string }
  | { kind: 'sim' };

/** Pure biology: what the art and the map are drawn from. */
export interface Organism {
  id: number;
  /** 64 hex chars. */
  seed: string;
  /** `seed[31] % 5` (renderer palette). */
  palette: number;
  /** Epochs since activation. */
  age: number;
  /** `[neighbour, D]`, D on the 1e6 scale as a decimal string. */
  tubes: [number, string][];
  /** Σ isqrt(D), REP_ONE = 1000 (computed by the router at read time). */
  reputation: number;
  active: boolean;
  /** Epoch this state belongs to. */
  epoch: number;
}

/** NFT-specific: ownership and the market. */
export interface Holding {
  id: number;
  owner: string;
  listedPrice: string | null;
  /** null when the source does not carry it (run snapshots). */
  sales: number | null;
  transfers: number | null;
}

/**
 * The states of Design §1.5 that a source can prove. `activated` is the
 * coarse reading of the bulk views (`active:true` without the policy, which
 * only `spore_summary` has): it covers awaiting policy, active, paused and
 * control reset (team decision, S6).
 */
export type SporeStatus = 'dormant' | 'activated' | 'awaiting-policy' | 'active' | 'paused' | 'control-reset';

export interface StatusReading {
  status: SporeStatus;
  /** Inferred from other fields, not read (Design §4.2 "derived"). */
  derived: boolean;
}

/** The art's evidence: the stored state hash and the committed image (`commit_image`). */
export interface ImageEvidence {
  /** Epoch of the state the art is drawn from. */
  stateEpoch: number;
  /** The router's stored state hash for that state; null before the first close after activation. */
  stateHash: string | null;
  commit: { epoch: number; stateHash: string; imageHash: string; rendererVersion: number } | null;
}

/** Who may act for the spore, and under which policy. */
export interface AgentAuthorization {
  id: number;
  operator: string | null;
  operatorGen: number;
  paused: boolean;
  budgetPerEpoch: string;
  maxPayment: string;
  allowAllSpores: boolean;
  allowlist: number[];
  externalAllowlist: string[];
}

/** Money: ledger balance and the allowance. Yocto strings. */
export interface Economy {
  id: number;
  balance: string;
  effectiveBudget: string;
  spentThisEpoch: string;
  budgetLeft: string;
}
