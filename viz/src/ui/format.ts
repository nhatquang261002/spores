// Display formatting (Design §8.1). Money is formatted from yocto strings with
// BigInt, never Number.

const YOCTO = 10n ** 24n;

/** `0.012 NEAR`, `2.31 NEAR`, `0.00 NEAR`, `<0.0001 NEAR`: up to 4 decimals, at least 2, trailing zeros trimmed. */
export function formatNear(yocto: string | bigint): string {
  const v = typeof yocto === 'bigint' ? yocto : BigInt(yocto);
  const neg = v < 0n;
  const a = neg ? -v : v;
  if (a > 0n && a < YOCTO / 10_000n) return `${neg ? '>-' : '<'}0.0001 NEAR`;
  const whole = a / YOCTO;
  let frac = ((a % YOCTO) / (YOCTO / 10_000n)).toString().padStart(4, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac} NEAR`;
}

/** Local wall-clock `14:02:11`. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Countdown `0:21`, `12:05`; negative is clamped to `0:00`. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Hashes: first 6 and last 4 for hex, first 4 and last 4 for base58. */
export function shortHash(h: string): string {
  const head = /^[0-9a-f]+$/i.test(h) ? 6 : 4;
  return h.length <= head + 5 ? h : `${h.slice(0, head)}…${h.slice(-4)}`;
}

/** Accounts: full if ≤ 28 characters, else middle-truncated keeping the suffix. */
export function shortAccount(a: string): string {
  if (a.length <= 28) return a;
  const dot = a.lastIndexOf('.');
  const suffix = dot > 0 ? a.slice(dot + 1) : a.slice(-7);
  return `${a.slice(0, 27 - suffix.length - 1)}…${suffix}`;
}

/** D on the 1e6 scale, 2 decimals (Design §1.6): `0.84`. */
export const formatD = (d: number | string) => (Number(d) / 1e6).toFixed(2);

/** R (Σ isqrt(D), one tube at D = 1.0 is 1000) as `R/1000` with 2 decimals (Design §1.6): `1.43`. */
export function formatR(r: number): string {
  return (r / 1000).toFixed(2);
}

/** `1 tube`, `3 tubes`. */
export const tubesText = (n: number) => `${n} tube${n === 1 ? '' : 's'}`;
