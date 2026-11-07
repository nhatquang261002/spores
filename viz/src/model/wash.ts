// The wash panel's data (S12): `public/recorded/sim/wash.json`, written by
// `spores-sim wash`. Everything here is a labelled simulation (Design §4.1): no
// chain figure is mixed in, and it isn't fetched from a run or a router. Failures
// stay failures: `failures` lists every one the panel must state.

export interface WashSeries {
  seed: number;
  attacker_r: number[];
  honest_r: number[];
  attacker_money: number[];
}

export interface WashLoopCase {
  spores: number;
  loop_milli_near: number;
  cases: number;
  gate_pass: number;
  loses_money: number;
  worst_net_near: number;
  /** Attacker best R over honest median R, worst over the grid; null when the honest median is 0. */
  worst_r_ratio: number | null;
  default: { gate_pass: boolean; net_near_worst: number; attacker_max_rep: number; honest_median_rep: number; series: WashSeries[] };
}

export interface WashConfig {
  active: number;
  jobs: number;
  cases: number;
  gate_pass: number;
  loses_money: number;
  worst_net_near: number;
  worst_r_ratio: number | null;
  loops: WashLoopCase[];
}

export interface WashData {
  epochs: number;
  seeds: number[];
  note: string;
  configs: WashConfig[];
  phase1: {
    gate_in_range: { pass: number; cases: number };
    gate_all: { pass: number; cases: number };
    literal_in_range: { pass: number; cases: number };
    literal: { spores: number; loop_milli_near: number; cases: number; literal_pass: number; worst_rep_ratio: number; worst_tube_ratio: number }[];
    out_of_range_failures: { spores: number; fee_bps: number; k_milli_near: string; gain: string; loop_milli_near: string; net_near_worst: number; attacker_max_rep: number; honest_median_rep: number }[];
  };
}

export interface WashPick {
  active: number;
  jobs: number;
  spores: number;
  loop: number;
}

/** What opens first: the traffic testnet actually has, and a loop that beats the gate there. The unfavourable case leads. */
export const FIRST_PICK: WashPick = { active: 64, jobs: 1, spores: 3, loop: 200 };

export const LOOPS = [10, 50, 200, 1000, 5000] as const;

export const configOf = (d: WashData, p: Pick<WashPick, 'active' | 'jobs'>) => d.configs.find((c) => c.active === p.active && c.jobs === p.jobs) ?? null;
export const loopOf = (c: WashConfig, p: Pick<WashPick, 'spores' | 'loop'>) => c.loops.find((l) => l.spores === p.spores && l.loop_milli_near === p.loop) ?? null;

export const nearOfMilli = (m: number) => {
  const s = (m / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return `${s} NEAR`;
};

/** The two lines of the chart, read the way the gate reads them: worst for the defence at every epoch. */
export function pathsOf(l: WashLoopCase): { attacker: number[]; honest: number[]; money: number[] } {
  const s = l.default.series;
  const n = s[0]?.attacker_r.length ?? 0;
  const at = (f: (x: WashSeries) => number[], pick: (...v: number[]) => number) => Array.from({ length: n }, (_, i) => pick(...s.map((x) => f(x)[i])));
  return { attacker: at((x) => x.attacker_r, Math.max), honest: at((x) => x.honest_r, Math.min), money: at((x) => x.attacker_money, Math.max) };
}

/** The highest R any line reaches in the file: one y scale, so traffic levels and loops can be compared by eye. */
export function yMax(d: WashData): number {
  let top = 0;
  for (const c of d.configs) for (const l of c.loops) for (const s of l.default.series) top = Math.max(top, ...s.attacker_r, ...s.honest_r);
  return Math.ceil(top);
}

export const trafficName = (c: Pick<WashConfig, 'active' | 'jobs'>) => (c.jobs >= 3 ? 'Busy network' : c.active === 64 ? 'Quiet network, like the live one' : 'Quiet network');
export const configWords = (c: Pick<WashConfig, 'active' | 'jobs'>) => `${c.active} active, ${c.jobs} honest job${c.jobs === 1 ? '' : 's'} per spore per epoch`;

/** The big line for the case on screen. It never says the loop is safe, only what this case did. */
export function washLine(l: WashLoopCase): string {
  const lost = Math.abs(l.default.net_near_worst).toFixed(l.default.net_near_worst > -0.01 ? 4 : 2);
  return l.default.gate_pass ? `It pays ${lost} NEAR and still trails the honest median.` : `It pays ${lost} NEAR and gets past the honest median.`;
}

/** A bigger loop that behaves exactly like a smaller one: the allowance has capped what the spore may spend. */
export function cappedBy(c: WashConfig, l: WashLoopCase): WashLoopCase | null {
  const i = LOOPS.indexOf(l.loop_milli_near as (typeof LOOPS)[number]);
  if (i <= 0) return null;
  const smaller = loopOf(c, { spores: l.spores, loop: LOOPS[i - 1] });
  return smaller && smaller.default.net_near_worst === l.default.net_near_worst ? smaller : null;
}

export interface WashFailure {
  where: string;
  count: string;
  what: string;
  worst: string;
}

/** Every failure the sim measured, in words, worst traffic first. Nothing here is softened or left out. */
export function failures(d: WashData): WashFailure[] {
  const out: WashFailure[] = [];
  const net = (x: number) => `${x.toFixed(4)} NEAR`;
  for (const c of [...d.configs].sort((a, b) => a.gate_pass - b.gate_pass)) {
    const failed = c.cases - c.gate_pass;
    if (!failed) continue;
    const by = c.loops.filter((l) => l.gate_pass < l.cases);
    const worstLoop = by.reduce((a, b) => (b.cases - b.gate_pass > a.cases - a.gate_pass ? b : a));
    out.push({
      where: `Gate, ${c.active} active × ${c.jobs} job${c.jobs === 1 ? '' : 's'}`,
      count: `${failed} of ${c.cases} failed`,
      what: `The attacker’s best spore reached the honest median R. Worst at ${worstLoop.spores} spores, ${nearOfMilli(worstLoop.loop_milli_near)} a loop: ${worstLoop.cases - worstLoop.gate_pass} of ${worstLoop.cases}. It lost money in ${c.loses_money} of ${c.cases}.`,
      worst: `smallest loss ${net(c.worst_net_near)}`,
    });
  }
  const oor = d.phase1.out_of_range_failures;
  if (oor.length) {
    const nets = oor.map((f) => f.net_near_worst);
    const r = oor.reduce((a, b) => (b.attacker_max_rep / b.honest_median_rep > a.attacker_max_rep / a.honest_median_rep ? b : a));
    out.push({
      where: 'Gate, outside the tested range (16 × 3, no allowance)',
      count: `${oor.length} of ${d.phase1.gate_all.cases - d.phase1.gate_in_range.cases} failed`,
      what: `K = 0.5, a 5 NEAR loop, 3 spores: the attacker’s best R ${r.attacker_max_rep.toFixed(2)} against an honest median of ${r.honest_median_rep.toFixed(2)}.`,
      worst: `smallest loss ${net(Math.max(...nets))}`,
    });
  }
  const lit = d.phase1.literal.filter((l) => l.literal_pass < l.cases);
  const total = d.phase1.literal_in_range.cases - d.phase1.literal_in_range.pass;
  if (lit.length) {
    const rep = Math.max(...lit.map((l) => l.worst_rep_ratio));
    const biggest = Math.max(...lit.map((l) => l.loop_milli_near));
    out.push({
      where: 'SPEC §9 per-NEAR test (16 × 3, no allowance)',
      count: `${total} of ${d.phase1.literal_in_range.cases} failed`,
      what: `Tiny loops, ${nearOfMilli(biggest)} or less: per NEAR spent they buy more tube and reputation than honest work does, up to ${rep.toFixed(2)} times.${d.phase1.gate_in_range.pass === d.phase1.gate_in_range.cases ? ' They still lose money and stay below the median.' : ''}`,
      worst: `reputation per NEAR ×${rep.toFixed(2)}`,
    });
  }
  return out;
}

export const FIXED_SENTENCE = 'Receipts and escrow do not stop an attacker controlling both sides; the defense is economic. No universal Sybil resistance is claimed.';
