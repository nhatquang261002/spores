// Shock commands (SPEC §6.6), applied through the run's control.json, which
// every agent reads each loop:
//   kill <spore>        the agent stops (no quotes, no jobs)
//   raise <spore> <x>   the provider's cost is multiplied by x (e.g. 3)
//   cut <a> <b>         a and b stop trading with each other, and a delivery in
//                       flight between them is rejected. The router has no
//                       method to delete a tube, so unlike sim (which zeroes it)
//                       the tube is cut 50% per rejection at the next close and
//                       then decays to the prune threshold.
// Usage: node src/shock.ts <run dir> kill 4 | raise 2 3 | cut 1 5
import { appendJsonl, readControl, writeControl } from './common.ts';
import { join } from 'node:path';

export type Shock = { kind: 'kill'; spore: number } | { kind: 'raise'; spore: number; factorBps: number } | { kind: 'cut'; a: number; b: number };

export function applyShock(runDir: string, s: Shock, epoch?: number) {
  const c = readControl(runDir);
  if (s.kind === 'kill' && !c.killed.includes(s.spore)) c.killed.push(s.spore);
  if (s.kind === 'raise') c.raise[String(s.spore)] = s.factorBps;
  if (s.kind === 'cut' && !c.cut.some(([x, y]) => (x === s.a && y === s.b) || (x === s.b && y === s.a))) c.cut.push([s.a, s.b]);
  writeControl(runDir, c);
  appendJsonl(join(runDir, 'events.jsonl'), { at: new Date().toISOString(), spore: 'shock', kind: 'shock', shock: s, epoch });
}

if (import.meta.main) {
  const [runDir, kind, x, y] = process.argv.slice(2);
  const n = (v: string | undefined) => {
    const k = Number(v);
    if (!Number.isInteger(k) || k < 0) throw new Error('usage: shock.ts <run dir> kill <id> | raise <id> <x> | cut <a> <b>');
    return k;
  };
  if (kind === 'kill') applyShock(runDir, { kind, spore: n(x) });
  else if (kind === 'raise') applyShock(runDir, { kind, spore: n(x), factorBps: Math.round(Number(y) * 10_000) });
  else if (kind === 'cut') applyShock(runDir, { kind, a: n(x), b: n(y) });
  else n(undefined);
  console.log(JSON.stringify(readControl(runDir)));
}
