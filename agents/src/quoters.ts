// Who quotes on a job (Phase 6). With every spore active, a service has about
// 21 providers but the router keeps at most MAX_QUOTES quotes per job, so the
// rest would only burn failed transactions and RPC requests. With a fan-out
// k > 0, the consumer's tube neighbours quote (strongest tube first, up to
// MAX_QUOTES - k) plus k seeded picks among the other providers, so new
// tubes can still form. Every agent computes the same list from the job id,
// the run seed and the tubes of the last close, so the consumer knows whose
// quotes to wait for. This picks who may bid; who is hired stays rules.ts.
import { createHash } from 'node:crypto';

/** The router's `MAX_QUOTES` (router/src/types.rs). */
export const MAX_QUOTES = 8;

/**
 * The providers that quote on `jobId`. `providers` are the candidates (same
 * service, live, not the consumer); `d(p)` is the consumer's tube to `p` (0n
 * if none). Fan-out 0 means everyone, as in Phase 4 and 5.
 */
export function quoters(providers: number[], jobId: number, seed: bigint, d: (p: number) => bigint, fanout: number): number[] {
  if (fanout <= 0) return [...providers];
  const k = Math.min(fanout, MAX_QUOTES);
  const byTube = providers
    .filter((p) => d(p) > 0n)
    .sort((a, b) => (d(a) > d(b) ? -1 : d(a) < d(b) ? 1 : a - b))
    .slice(0, MAX_QUOTES - k);
  const draw = (p: number) => createHash('sha256').update(`spores/quoters/v1|${seed}|${jobId}|${p}`).digest('hex');
  const others = providers
    .filter((p) => !byTube.includes(p))
    .map((p) => ({ p, h: draw(p) }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0))
    .slice(0, k)
    .map((x) => x.p);
  return [...byTube, ...others].sort((a, b) => a - b);
}
