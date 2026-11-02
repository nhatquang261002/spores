// Port of the spores-core rules the agents need: RNG (core/src/rng.rs), hiring
// (core/src/hiring.rs) and pricing/demand (core/src/market.rs). Checked
// against vectors/agents.json by test/vectors.test.ts, and every logged hire
// is re-checked in Rust by `spores-sim replay-decisions`. All integers are
// BigInt; no floats.

const MASK = (1n << 64n) - 1n;
export const BPS = 10_000n;
export const ONE = 1_000_000n;

export const MARGIN_START = 2_000;
export const MARGIN_MIN = 500;
export const MARGIN_MAX = 6_000;
export const MARGIN_STEP = 250;

/** The shipped hiring rule (SPEC §6.3): w = 4, D_norm relative to the strongest candidate tube. */
export const SHIPPED_W_BPS = 40_000;
export type Norm = 'relative' | { absolute: bigint };
export const SHIPPED_NORM: Norm = 'relative';

/** SplitMix64, as `spores_core::rng::Rng`. */
export class Rng {
  state: bigint;
  constructor(seed: bigint) {
    this.state = seed & MASK;
  }
  nextU64(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return z ^ (z >> 31n);
  }
  below(n: bigint): bigint {
    return this.nextU64() % n;
  }
}

function rotl(x: bigint, r: bigint): bigint {
  return ((x << r) | (x >> (64n - r))) & MASK;
}

/** An independent stream derived from a tuple of keys, as `spores_core::rng::stream`. */
export function stream(keys: bigint[]): Rng {
  let r = new Rng(0x05eed0f57095n);
  let acc = 0n;
  for (const k of keys) {
    acc = r.nextU64() ^ ((k * 0xd6e8feb86659fd93n) & MASK) ^ rotl(acc, 17n);
    r = new Rng(acc);
  }
  return r;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** `min(d, reference) / reference` in 0..=ONE; zero when reference is 0. */
export function dNorm(d: bigint, reference: bigint): bigint {
  if (reference === 0n) return 0n;
  return (min(d, reference) * ONE) / reference;
}

/** Effective price `floor(quote / (1 + w * D_norm))`, w = w_bps / 10000. */
export function score(quote: bigint, d: bigint, reference: bigint, wBps: number): bigint {
  const denom = BPS * ONE + BigInt(wBps) * dNorm(d, reference);
  return (quote * BPS * ONE) / denom;
}

export interface Quote {
  provider: number;
  price: bigint;
  /** Conductivity of the tube between consumer and provider. */
  d: bigint;
}

export function reference(quotes: Quote[], norm: Norm): bigint {
  if (norm === 'relative') return quotes.reduce((m, q) => (q.d > m ? q.d : m), 0n);
  return norm.absolute;
}

/** Index of the winning quote: lowest score, then lowest price, then lowest provider id. */
export function pick(quotes: Quote[], wBps: number, norm: Norm): number | null {
  const ref = reference(quotes, norm);
  let best: number | null = null;
  let key: [bigint, bigint, number] | null = null;
  quotes.forEach((q, i) => {
    const k: [bigint, bigint, number] = [score(q.price, q.d, ref, wBps), q.price, q.provider];
    if (key === null || k[0] < key[0] || (k[0] === key[0] && (k[1] < key[1] || (k[1] === key[1] && k[2] < key[2])))) {
      best = i;
      key = k;
    }
  });
  return best;
}

/** `quote = cost * (1 + margin)`, rounded down. */
export function quotePrice(cost: bigint, marginBps: number): bigint {
  return (cost * (BPS + BigInt(marginBps))) / BPS;
}

/** Up one step after two or more wins, down one after none, within bounds. */
export function nextMargin(marginBps: number, wins: number): number {
  if (wins >= 2) return Math.min(marginBps + MARGIN_STEP, MARGIN_MAX);
  if (wins === 0) return Math.max(Math.max(marginBps - MARGIN_STEP, 0), MARGIN_MIN);
  return marginBps;
}

/** The service a consumer's j-th job of epoch t asks for: any but its own. */
export function jobService(seed: bigint, t: bigint, consumer: bigint, j: bigint, services: number, own: number): number {
  const draw = Number(stream([seed, t, consumer, j, 0n]).below(BigInt(services - 1)));
  return draw >= own ? draw + 1 : draw;
}
