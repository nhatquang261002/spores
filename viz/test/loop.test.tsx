// S13: the whole loop against a real run (test/fixtures/loop, a copy of a run's logs
// on router4). The story only uses what the logs confirm, a run still going only
// adds lines at the end, and a fall is said as a fall.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLoop, closeForPayment, frameOf, heroOf, LOOP_ACTS, loopArtInputs, loopDelay, loopLines, loopRows, loopWaiting, narrateLoop, quotesLine, type LoopEvent, type LoopRun, type LoopSnapshot, type LoopState } from '../src/model/loop';
import { buildSale, narrateSale } from '../src/model/sale';
import { tubesText } from '../src/ui/format';
import { durationMs, parseSceneLog, type SceneLine } from '../src/model/scene';
import type { Source } from '../src/model/types';
import { LoopStage } from '../src/components/LoopStage';
import { saleCastOf, saleSheetRows } from '../src/components/SaleStage';
import { SpecimenSheet } from '../src/components/StageAids';
import { LoopScene } from '../src/pages/LoopScene';
import { loadLoopRun } from '../src/sources/loop';
import { isRunFile } from '../src/sources/runFiles';
import { AppContext, type AppState } from '../src/state/source';
import { usePlayback } from '../src/state/scene';
import { RenderQueueContext } from '../src/wasm/art';

const DIR = path.join(__dirname, 'fixtures/loop');
const read = (f: string) => readFileSync(path.join(DIR, f), 'utf8');
const jsonl = (f: string) => read(f).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const SNAP_NAMES = readdirSync(path.join(DIR, 'snapshots')).sort();
const RUN: LoopRun = {
  run: JSON.parse(read('run.json')),
  events: jsonl('events.jsonl'),
  decisions: jsonl('decisions.jsonl'),
  snapshots: SNAP_NAMES.map((f) => JSON.parse(read(`snapshots/${f}`))),
  scene: parseSceneLog(read('scene.jsonl')),
  report: JSON.parse(read('report.json')),
};
const LINES = loopLines(RUN);
const HERO = RUN.run.sale_spore!;
const FIRST = RUN.decisions.find((d: any) => d.consumer === HERO && d.outcome === 'settled') as any;
const upTo = (type: string) => LINES.slice(0, LINES.findIndex((l) => l.type === type) + 1);
const stateAt = (type: string) => buildLoop(upTo(type));
const say = (s: LoopState) => narrateLoop(s, narrateSale);

describe('the story, from a real run', () => {
  it('follows the spore the run sells, through every stop in order', () => {
    expect(buildLoop(LINES).hero).toBe(HERO);
    const acts = LINES.filter((l) => l.type === 'act').map((l) => l.act);
    expect(acts).toEqual(LOOP_ACTS.map((a) => a.key));
  });

  it('uses the first settled hire and its real quotes', () => {
    const s = stateAt('hired');
    expect(s.job!.id).toBe(FIRST.job_id);
    expect(s.job!.winner).toBe(FIRST.winner);
    expect(s.job!.candidates).toEqual(FIRST.candidates);
    expect(s.txs.accept).toBe(FIRST.tx.accept);
    expect(stateAt('paid').txs.settle).toBe(FIRST.tx.settle);
  });

  it('each hire line carries its own real tx, and quotes and delivery come from the event log', () => {
    const post = LINES.find((l) => l.type === 'post')!;
    const logged = RUN.events.find((e) => e.hash === FIRST.tx.post)!;
    expect(post.at).toBe(logged.at);
    const del = LINES.find((l) => l.type === 'delivered')!;
    expect(RUN.events.find((e) => e.hash === del.tx)?.method).toBe('deliver');
  });

  it('moves no tube before the close, and no art before the Art stop', () => {
    const start = buildLoop(upTo('wake'));
    for (const type of ['post', 'quotes', 'hired', 'delivered', 'paid']) {
      const s = stateAt(type);
      expect(s.frame, type).toBe(start.frame);
      expect(s.artFrame, type).toBe(start.artFrame);
    }
    const closed = stateAt('closed');
    expect(closed.frame).not.toBe(start.frame);
    expect(closed.artFrame, 'the tube moves first').toBe(start.artFrame);
    expect(stateAt('art').artFrame).toBe(closed.frame);
  });

  it('reports the tube from the snapshots either side of the close', () => {
    const l = LINES.find((x) => x.type === 'closed')!;
    const snap = (e: number) => RUN.snapshots.find((s) => s.epoch === e)!;
    const dIn = (s: LoopSnapshot) => Number(frameOf(s, HERO)!.tubes.find(([n]) => n === FIRST.winner)?.[1] ?? 0);
    expect(l.dAfter).toBe(dIn(snap(l.epoch + 1)));
    expect(l.dBefore).toBe(dIn(snap(l.epoch)));
    expect(l.dAfter).toBeGreaterThan(l.dBefore);
    expect(RUN.events.find((e) => e.hash === l.tx)?.closed).toBe(l.epoch);
  });

  it('reputation and allowance come from the same two snapshots', () => {
    const c = LINES.find((x) => x.type === 'closed')!;
    const r = stateAt('rep').rep!;
    expect(r.from).toBe(c.prior.reputation);
    expect(r.to).toBe(c.frame.reputation);
    expect(r.allowanceFrom).toBe(c.prior.allowance);
    expect(r.allowanceTo).toBe(c.frame.allowance);
  });

  it('the time-lapse is the closes before the sale, in order, and each is a real close', () => {
    const closed = LINES.find((x) => x.type === 'closed')!;
    const saleAt = Date.parse(RUN.scene[0].at);
    const lapses = LINES.filter((l) => l.type === 'lapse');
    for (const l of lapses) {
      expect(l.epoch).toBeGreaterThan(closed.epoch);
      expect(Date.parse(l.at)).toBeLessThan(saleAt);
      expect(RUN.events.find((e) => e.hash === l.tx)?.closed).toBe(l.epoch);
      expect(l.frame.epoch).toBe(l.epoch + 1);
    }
    expect(lapses.map((l) => l.epoch)).toEqual([...lapses.map((l) => l.epoch)].sort((a, b) => a - b));
  });

  it('the sale is the sale’s own log, line for line, on its own stage', () => {
    const inner = LINES.filter((l) => l.type === 'sale').map((l) => l.line);
    expect(inner).toEqual(RUN.scene);
    const s = buildLoop(LINES);
    expect(s.saleStarted).toBe(true);
    expect(s.sale.sold).toBe(true);
    expect(s.sale.owner).toBe(s.sale.start!.buyer);
    expect(s.sale.oldKey!.state).toBe('failed');
  });

  it('the plate stays at the buy: what ✓ kept proved, even though later closes decay the tubes', () => {
    const s = buildLoop(LINES);
    const after = RUN.scene.find((l) => l.type === 'block_diff')!.after;
    expect(s.sale.intact).toBe(true);
    expect(s.sale.now!.connections.length, 'the narrator said this many').toBe(after.connections.length);
    expect(String(s.sale.now!.reputation)).toBe(String(after.reputation));
    const last = RUN.scene.filter((l) => l.type === 'snapshot').at(-1)!;
    expect(last.connections.length, 'the fixture really decayed after the buy, or this test proves nothing').toBeLessThan(after.connections.length);
    expect(buildSale(RUN.scene).now!.connections.length, 'the scene’s own state moves on').toBe(last.connections.length);
  });

  it('flips the owner only at the buy’s final outcome', () => {
    const saleLines = LINES.map((l, i) => ({ l, i })).filter(({ l }) => l.type === 'sale');
    const buyAt = saleLines.find(({ l }) => l.line.type === 'result' && l.line.method === 'buy')!.i;
    expect(buildLoop(LINES.slice(0, buyAt)).sale.sold).toBe(false);
    expect(buildLoop(LINES.slice(0, buyAt + 1)).sale.sold).toBe(true);
  });

  it('marks the new agent’s first real tx as what closes the loop', () => {
    const r = LINES.find((l) => l.type === 'resumed')!;
    const ev = RUN.events.find((e) => e.hash === r.tx)!;
    expect(ev.spore).toBe(HERO);
    expect(ev.ok).toBe(true);
    const took = RUN.scene.find((l) => l.type === 'result' && l.method === 'set_policy')!;
    expect(Date.parse(ev.at)).toBeGreaterThan(Date.parse(took.at));
    expect(buildLoop(LINES).sale.probe?.tx, 'the stage’s last ripple is that tx').toBe(r.tx);
    expect(buildLoop(LINES.slice(0, LINES.indexOf(r))).resumed).toBeNull();
  });

  it('ends with the run’s own checks', () => {
    expect(buildLoop(LINES).checks).toEqual(RUN.report!.checks);
    expect(LINES.at(-1)!.type).toBe('report');
  });
});

describe('the first 30 seconds', () => {
  it('reaches the Art stop inside 30 s and the end inside 90 s in story pace', () => {
    const toArt = durationMs(upTo('art'), 'story', loopDelay);
    expect(toArt).toBeLessThanOrEqual(30_000);
    expect(durationMs(LINES, 'story', loopDelay)).toBeLessThanOrEqual(90_000);
  });

  it('has the real durations at real-time pace', () => {
    const a = Date.parse(LINES[0].at);
    const b = Date.parse(LINES.at(-1)!.at);
    expect(durationMs(LINES, 'real', loopDelay)).toBeGreaterThanOrEqual(b - a);
  });

  it('says what each stop means before anything has happened', () => {
    const rows = loopRows(buildLoop([]), false);
    expect(rows.map((r) => r.word)).toEqual(['Wake', 'Hire', 'Settle', 'Grow', 'Reputation', 'Art', 'Sell', 'Control']);
    for (const r of rows) {
      expect(r.state).toBe('future');
      expect(r.fact).toBeNull();
      expect(r.promise.length).toBeGreaterThan(10);
    }
    expect(say(buildLoop([]))).toMatch(/NFT with its own money and an agent/);
  });
});

describe('a run still going', () => {
  /** The logs as they stood at time `t`. */
  const asOf = (t: number): LoopRun => {
    const before = <T extends { at?: string }>(xs: T[]) => xs.filter((x) => Date.parse(x.at!) <= t);
    const closes = RUN.events.filter((e) => e.method === 'close_epoch' && e.ok);
    // A snapshot is written soon after its close: the keeper's `snapshot` note says when.
    const notes = RUN.events.filter((e) => e.kind === 'snapshot') as (LoopEvent & { epoch?: number })[];
    const snaps = RUN.snapshots.filter((s) => s.epoch === RUN.run.start_epoch || notes.some((n) => n.epoch === s.epoch && Date.parse(n.at) <= t) || (!notes.some((n) => n.epoch === s.epoch) && closes.some((c) => c.closed === s.epoch - 1 && Date.parse(c.at) + 5000 <= t)));
    // A decision's `at` is when it was made; its line is written when the job ends, after that tx's own line.
    const written = (d: any) => {
      const last = RUN.events.find((e) => e.hash && e.hash === (d.tx?.settle ?? d.tx?.reject ?? d.tx?.accept ?? d.tx?.post));
      return Math.max(Date.parse(d.at), last ? Date.parse(last.at) : 0) <= t;
    };
    return { ...RUN, events: before(RUN.events), decisions: RUN.decisions.filter(written), snapshots: snaps, scene: before(RUN.scene as { at: string; type: string }[]) as SceneLine[], report: null };
  };

  it('only ever adds lines at the end: what has played stays true', () => {
    const times = [...RUN.events.map((e) => Date.parse(e.at))].sort((a, b) => a - b);
    let before: SceneLine[] = [];
    for (let i = 0; i < times.length; i += 5) {
      const now = loopLines(asOf(times[i]));
      expect(now.slice(0, before.length), `at line ${i}`).toEqual(before);
      before = now;
    }
    const finished = loopLines({ ...RUN, report: null });
    expect(finished.slice(0, before.length)).toEqual(before);
  });

  it('holds the sale until the closes before it have their snapshots', () => {
    // A close between the story's first close and the sale, whose snapshot hasn't been written.
    const closed = LINES.find((l) => l.type === 'closed')!;
    const saleAt = Date.parse(RUN.scene[0].at);
    const at = new Date((Date.parse(closed.at) + saleAt) / 2).toISOString();
    const epoch = 900;
    const run: LoopRun = { ...RUN, report: null, events: [...RUN.events, { at, spore: 'keeper', kind: 'tx', method: 'close_epoch', ok: true, closed: epoch, hash: 'LATE' }] };
    const waiting = loopLines(run);
    expect(waiting.some((l) => l.type === 'sale'), 'it would push a line in ahead of what has played').toBe(false);
    expect(loopLines({ ...run, report: RUN.report }).some((l) => l.type === 'sale'), 'a finished run plays what it has').toBe(true);
    const arrived = loopLines({ ...run, snapshots: [...RUN.snapshots, { ...RUN.snapshots.at(-1)!, epoch: epoch + 1 }] });
    expect(arrived.some((l) => l.type === 'lapse' && l.epoch === epoch), 'then it plays, before the sale').toBe(true);
    expect(arrived.findIndex((l) => l.type === 'lapse' && l.epoch === epoch)).toBeLessThan(arrived.findIndex((l) => l.type === 'sale'));
  });

  it('a quote that lands after the hire doesn’t move the story’s quote line', () => {
    const hired = LINES.find((l) => l.type === 'hired')!;
    const quoted = LINES.find((l) => l.type === 'quotes')!;
    const late = new Date(Date.parse(hired.at) + 5_000).toISOString();
    const lines = loopLines({ ...RUN, events: [...RUN.events, { at: late, spore: 9, kind: 'tx', method: 'quote', ok: true, args: { job_id: FIRST.job_id, spore_id: 9, price: '1' }, hash: 'LATEQ' }] });
    expect(lines.find((l) => l.type === 'quotes')!.at).toBe(quoted.at);
  });

  it('has nothing to tell before the first snapshot, and says what it waits for', () => {
    const r: LoopRun = { ...RUN, events: [], decisions: [], snapshots: [], scene: [], report: null };
    expect(loopLines(r)).toEqual([]);
    expect(loopWaiting(r, buildLoop([]))).toMatch(/first reading/);
    const woke = stateAt('wake');
    expect(loopWaiting({ ...RUN, report: null }, woke)).toMatch(new RegExp(`Spore #${HERO}’s first settled hire`));
    expect(loopWaiting({ ...RUN, report: null }, stateAt('paid'))).toMatch(/the epoch to close/);
    expect(loopWaiting({ ...RUN, report: null }, stateAt('art'))).toMatch(/next close/);
    expect(loopWaiting({ ...RUN, report: null }, buildLoop(LINES.slice(0, -1)))).toMatch(/checks itself/);
    expect(loopWaiting(RUN, buildLoop(LINES)), 'a finished run waits for nothing').toBeNull();
  });
});

describe('what the logs don’t have stays unsaid', () => {
  it('a run with no settled hire before its sale goes from Wake to the sale', () => {
    const r: LoopRun = { ...RUN, decisions: RUN.decisions.filter((d: any) => !(d.consumer === HERO && d.outcome === 'settled')) };
    const lines = loopLines(r);
    expect(lines.some((l) => l.type === 'post' || l.type === 'closed' || l.type === 'art')).toBe(false);
    expect(lines.some((l) => l.type === 'sale')).toBe(true);
    const rows = loopRows(buildLoop(lines), true);
    for (const k of ['hire', 'settle', 'grow', 'reputation']) expect(rows.find((x) => x.key === k)!.fact, k).toBeNull();
  });

  it('a hire after the sale isn’t told as if it came before', () => {
    const saleAt = Date.parse(RUN.scene[0].at);
    const r: LoopRun = { ...RUN, decisions: RUN.decisions.filter((d: any) => d.consumer !== HERO || Date.parse(d.at) > saleAt) };
    expect(loopLines(r).some((l) => l.type === 'post')).toBe(false);
  });

  it('with no sale in the run the story stops at the Art stop', () => {
    const r: LoopRun = { ...RUN, scene: [] };
    const s = buildLoop(loopLines(r));
    expect(s.saleStarted).toBe(false);
    const rows = loopRows(s, true);
    expect(rows.find((x) => x.key === 'sell')!.fact).toBeNull();
    expect(rows.find((x) => x.key === 'control')!.fact).toBeNull();
  });

  it('picks the busiest buyer when the run sold nothing, and nothing when no one bought', () => {
    const none = { ...RUN, run: { ...RUN.run, sale_spore: null }, report: null };
    const d = (consumer: number, outcome = 'settled') => ({ consumer, outcome }) as any;
    expect(heroOf(none, [d(3), d(5), d(5), d(1, 'rejected')])).toBe(5);
    expect(heroOf(none, [])).toBeNull();
    expect(loopLines({ ...none, decisions: [] })).toEqual([]);
    expect(heroOf({ ...none, report: { sale: { spore: 9 } } }, [])).toBe(9);
  });
});

describe('✓ kept on the Sale stage', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  const plate = (scene: ReturnType<typeof buildSale>) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 800 } as DOMRect);
    const { container } = render(<SpecimenSheet spore={scene.start!.spore} rows={saleSheetRows(scene, saleCastOf(scene, null)!)} label="sheet" />);
    return [...container.querySelectorAll('.sheet-row')].map((r) => (r.textContent ?? '').toLowerCase());
  };

  it('marks a value only if it is the one the blocks either side of the buy agree on', () => {
    const scene = buildSale(RUN.scene);
    const rows = plate(scene);
    const after = RUN.scene.find((l) => l.type === 'block_diff')!.after;
    expect(scene.now!.connections.length).not.toBe(after.connections.length);
    const tubes = rows.find((r) => /tube/.test(r))!;
    expect(tubes, 'a later snapshot has fewer tubes: not what was proved').not.toContain('kept');
    expect(rows.find((r) => r.startsWith('reputation')), 'nor its later reputation').not.toContain('kept');
  });

  it('marks them all at the buy, the state the check compared', () => {
    const rows = plate(buildLoop(LINES).sale);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r, r).toContain('kept');
  });
});

describe('words', () => {
  it('count one tube as one tube', () => {
    expect(tubesText(1)).toBe('1 tube');
    expect(tubesText(0)).toBe('0 tubes');
    expect(tubesText(5)).toBe('5 tubes');
  });
});

describe('closeForPayment', () => {
  const snapWith = (epoch: number, d: number): LoopSnapshot => ({ epoch, spores: { 1: { render_input: { spore_id: 1, seed: 's', age: 1, edges: d ? [[2, d]] : [] }, balance: '0', reputation: 0, owner_id: 'o', operator_id: null, effective_budget: '0' } } });
  const close = (closed: number, at: string): LoopEvent => ({ at, spore: 'keeper', kind: 'tx', method: 'close_epoch', ok: true, closed, hash: `c${closed}` });
  const closes = [close(10, '2026-01-01T00:01:00Z'), close(11, '2026-01-01T00:02:00Z')];

  it('is the first close after the settle', () => {
    const snaps = new Map([snapWith(10, 0), snapWith(11, 0), snapWith(12, 500)].map((s) => [s.epoch, s]));
    expect(closeForPayment(closes, snaps, 1, 2, '2026-01-01T00:01:30Z')?.closed).toBe(11);
  });

  it('is the close just before when the tube says the tx landed ahead of its log line', () => {
    const snaps = new Map([snapWith(10, 0), snapWith(11, 700), snapWith(12, 500)].map((s) => [s.epoch, s]));
    expect(closeForPayment(closes, snaps, 1, 2, '2026-01-01T00:01:05Z')?.closed).toBe(10);
  });

  it('doesn’t reach back further than the slack', () => {
    const snaps = new Map([snapWith(10, 0), snapWith(11, 700), snapWith(12, 500)].map((s) => [s.epoch, s]));
    expect(closeForPayment(closes, snaps, 1, 2, '2026-01-01T00:01:30Z')?.closed).toBe(11);
  });

  it('waits rather than guesses when a snapshot it needs isn’t in', () => {
    expect(closeForPayment(closes, new Map([snapWith(10, 0)].map((s) => [s.epoch, s])), 1, 2, '2026-01-01T00:01:05Z')).toBeNull();
    expect(closeForPayment(closes, new Map([snapWith(11, 0)].map((s) => [s.epoch, s])), 1, 2, '2026-01-01T00:01:30Z')).toBeNull();
    // The later close's snapshot is in, the one that would say whether the earlier close counted it isn't.
    expect(closeForPayment(closes, new Map([snapWith(10, 0), snapWith(12, 500)].map((s) => [s.epoch, s])), 1, 2, '2026-01-01T00:01:05Z')).toBeNull();
  });
});

describe('the narrator', () => {
  const base = stateAt('closed');
  const withGrowth = (before: number, after: number): LoopState => ({ ...base, growth: { ...base.growth!, before, after } });
  const withRep = (from: string, to: string, a: string, b: string): LoopState => ({ ...stateAt('rep'), rep: { from, to, allowanceFrom: a, allowanceTo: b } });

  it('says a new tube, a thicker one, and one that shrank, as they are', () => {
    expect(say(withGrowth(0, 300))).toMatch(/grew a new tube/);
    expect(say(withGrowth(200, 300))).toMatch(/thicker/);
    expect(say(withGrowth(300, 200))).toMatch(/still shrank/);
    expect(say(withGrowth(100, 0))).toMatch(/wasn’t enough/);
  });

  it('says a fall in reputation as a fall, and a cap as a cap', () => {
    expect(say(withRep('1000', '1200', '1', '2'))).toMatch(/spend more/);
    expect(say(withRep('1000', '1200', '2', '2'))).toMatch(/budget still caps/);
    expect(say(withRep('1000', '1000', '2', '2'))).toMatch(/holds/);
    expect(say(withRep('1200', '1000', '2', '1'))).toMatch(/reputation fell/);
  });

  it('gives the hiring reason the quotes support', () => {
    const j = stateAt('hired').job!;
    const cand = (provider: number, price: string, d = '0', score = price) => ({ provider, price, d, d_norm: '0', score });
    const job = (candidates: any[], winner: number, price: string) => ({ ...j, candidates, winner, price, decision: { ...j.decision, candidates, winner, consumer: HERO } });
    expect(say({ ...stateAt('hired'), job: job([cand(7, '5')], 7, '5') })).toMatch(/the only quote/);
    expect(say({ ...stateAt('hired'), job: job([cand(7, '5'), cand(8, '6')], 7, '5') })).toMatch(/the cheapest/);
    expect(say({ ...stateAt('hired'), job: job([cand(7, '9', '100', '4'), cand(8, '6')], 7, '9') })).toMatch(/already share a tube/);
    expect(quotesLine(job([cand(7, '5')], 7, '5'))).toMatch(/#7 quotes/);
    expect(quotesLine(job([cand(7, '5'), cand(8, '6')], 7, '5'))).toMatch(/Two quotes/);
    expect(quotesLine(job([cand(7, '5'), cand(8, '6'), cand(9, '7')], 7, '5'))).toMatch(/3 spores quote/);
  });

  it('never calls a failed run finished', () => {
    const s = { ...buildLoop(LINES), checks: [{ name: 'x', ok: false }] };
    expect(say(s)).toMatch(/failed a check/);
  });
});

describe('the stops', () => {
  it('turn a promise into a fact only when the story reaches it', () => {
    const at = (type: string, key: string) => loopRows(stateAt(type), false).find((r) => r.key === key)!;
    expect(at('wake', 'hire').fact).toBeNull();
    expect(at('wake', 'hire').state).toBe('future');
    expect(at('post', 'hire').state).toBe('now');
    expect(at('quotes', 'hire').fact, 'quotes are in, nobody is hired yet').toBeNull();
    expect(at('hired', 'hire').fact).toContain(`#${FIRST.winner}`);
    expect(at('hired', 'hire').tx).toBe(FIRST.tx.accept);
    expect(at('hired', 'settle').fact).toBeNull();
    expect(at('paid', 'settle').tx).toBe(FIRST.tx.settle);
    expect(at('paid', 'grow').fact).toBeNull();
    expect(at('closed', 'grow').fact).toMatch(/D .* → /);
    expect(at('closed', 'reputation').fact).toBeNull();
    expect(at('rep', 'reputation').fact).toMatch(/^R /);
    expect(at('rep', 'art').fact).toBeNull();
    expect(at('art', 'art').fact).toMatch(/tubes, age/);
  });

  it('name a dearer winner beside the cheaper quote it beat', () => {
    const j = stateAt('hired').job!;
    const candidates = [{ provider: 7, price: '200000000000000000000000', d: '100', d_norm: '1', score: '1' }, { provider: 8, price: '100000000000000000000000', d: '0', d_norm: '0', score: '100000000000000000000000' }];
    const s = { ...stateAt('hired'), job: { ...j, candidates, winner: 7, price: candidates[0].price } };
    expect(loopRows(s, false).find((r) => r.key === 'hire')!.fact).toMatch(/#7 at 0\.20.* over #8 at 0\.10/);
  });

  it('warn when the old key was not refused or the buy failed', () => {
    const bad = LINES.map((l) => (l.type === 'sale' && l.line.type === 'result' && l.line.method === 'post_job' && l.line.role === 'agent' ? { ...l, line: { ...l.line, ok: true, err: '' } } : l));
    const row = loopRows(buildLoop(bad), true).find((r) => r.key === 'control')!;
    expect(row.warn).toBe(true);
    expect(row.fact).toMatch(/not refused/);
    const noBuy = LINES.map((l) => (l.type === 'sale' && l.line.type === 'result' && l.line.method === 'buy' ? { ...l, line: { ...l.line, ok: false, err: 'no' } } : l));
    const sell = loopRows(buildLoop(noBuy), true).find((r) => r.key === 'sell')!;
    expect(sell.warn).toBe(true);
    expect(sell.fact).toMatch(/failed/);
  });

  it('are all past at the end', () => {
    expect(loopRows(buildLoop(LINES), true).every((r) => r.state === 'past')).toBe(true);
  });

  it('prewarms every state the hero will show, each once', () => {
    const inputs = loopArtInputs(LINES);
    const shown = new Set(LINES.filter((l) => l.frame).map((l) => `${l.frame.art.age}|${l.frame.art.edges.join()}`));
    expect(inputs).toHaveLength(shown.size);
    expect(inputs.every((i) => i.id === HERO)).toBe(true);
  });
});

const ALL_FILES = ['run.json', 'report.json', 'events.jsonl', 'decisions.jsonl', 'scene.jsonl', ...SNAP_NAMES.map((n) => `snapshots/${n}`)];

function stubBundle(run = 'demo-real', files: Record<string, string> = {}, manifest = ALL_FILES) {
  const asked: string[] = [];
  const f = vi.fn(async (url: string) => {
    const u = String(url);
    asked.push(u);
    if (u in files) return new Response(files[u]);
    if (u === `/recorded/${run}/files.json`) return new Response(JSON.stringify(manifest));
    const m = new RegExp(`^/recorded/${run}/(.+)$`).exec(u);
    if (m && manifest.includes(m[1])) return new Response(read(m[1]));
    return new Response('', { status: 404 });
  });
  vi.stubGlobal('fetch', f);
  return { asked, f };
}

function page(source: Source, router?: unknown) {
  const state = { source, sourceError: null, reducedMotion: true, router: router ?? null, epoch: { info: null, error: null, staleSince: null, retry: () => {} } } as unknown as AppState;
  return render(
    <RenderQueueContext.Provider value={() => Promise.reject(new Error('no renderer in this test'))}>
      <AppContext.Provider value={state}>
        <MemoryRouter initialEntries={['/lab/loop']}>
          <Routes>
            <Route path="/lab/loop" element={<LoopScene />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    </RenderQueueContext.Provider>,
  );
}

const RECORDED: Source = { kind: 'recorded', run: 'demo-real', date: '2026-11-06' };
const narrator = () => document.querySelector('.scene-narrator')!.textContent!;

describe('the page, on a recording', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, 'error');
  });
  afterEach(() => {
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('asks the question and shows every stop’s meaning at once, then plays by itself', async () => {
    stubBundle();
    page(RECORDED);
    expect(screen.getByRole('heading', { name: 'What does a Spore actually do?' })).toBeTruthy();
    for (const a of LOOP_ACTS) expect(screen.getByText(a.promise)).toBeTruthy();
    await waitFor(() => expect(narrator()).toMatch(new RegExp(`Spore #${HERO} is an NFT with its own money`)));
  });

  it('never asks a bundle for a file it doesn’t list', async () => {
    const { asked } = stubBundle('demo-real', {}, ALL_FILES.filter((f) => f !== 'report.json' && f !== 'scene.jsonl'));
    const r = await loadLoopRun(RECORDED);
    expect(r!.report).toBeNull();
    expect(r!.scene).toEqual([]);
    expect(asked.some((u) => u.endsWith('report.json') || u.endsWith('scene.jsonl'))).toBe(false);
  });

  it('jumps by stop, keeps the source on every way onward, and links real txs', async () => {
    stubBundle();
    page(RECORDED);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Control/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Art/ }));
    await waitFor(() => expect(narrator()).toMatch(/picture/));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    // The links carry the source.
    const crumb = screen.getByRole('link', { name: 'Demo Lab' }).getAttribute('href')!;
    expect(crumb).toContain('source=recorded');
    expect(crumb).toContain('run=demo-real');
    const hire = screen.getByRole('link', { name: /Hire tx/ });
    expect(hire.getAttribute('href')).toContain(FIRST.tx.accept);
  });

  /** Jump to the last stop, then play out what's left without waiting for it. */
  async function playToTheEnd() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await screen.findByRole('button', { name: /^Control/ });
    fireEvent.click(screen.getByRole('button', { name: /^Control/ }));
    // In steps: each line's timer is set by the render after the line before it.
    for (let i = 0; i < 200 && !document.querySelector('.scene-verdict'); i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
  }

  it('says the run’s own verdict at the end, and where to go next, with the source kept', async () => {
    stubBundle();
    page(RECORDED);
    await playToTheEnd();
    const passed = RUN.report!.checks!.filter((c) => c.ok).length;
    expect(screen.getByText(`${passed} / ${RUN.report!.checks!.length}`)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Check it against the chain' }).getAttribute('href')).toContain('source=recorded');
  });

  it('strikes through only the spores that quoted and lost, not tube partners who never quoted', async () => {
    const lines = upTo('hired');
    const s = buildLoop(lines);
    const quoters = new Set(s.job!.candidates.map((c) => c.provider));
    const partner = s.frame!.tubes.map(([n]) => n).find((n) => !quoters.has(n));
    expect(partner, 'the fixture’s hero has a tube partner who didn’t quote').toBeDefined();
    // jsdom lays nothing out: the stage needs a size for its notes to have places.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 800 } as DOMRect);
    const { container } = render(<RenderQueueContext.Provider value={() => Promise.reject(new Error('no renderer'))}><LoopStage state={s} reducedMotion /></RenderQueueContext.Provider>);
    const notes = [...container.querySelectorAll('.stage-note')];
    expect(notes.length).toBeGreaterThan(s.job!.candidates.length - 1);
    expect(notes.some((n) => n.firstElementChild?.textContent === `#${partner}`), 'the partner is on stage').toBe(true);
    for (const n of notes) {
      // The first span alone: the id runs straight into the price in textContent.
      const id = Number(/^#(\d+)$/.exec(n.firstElementChild?.textContent ?? '')?.[1]);
      if (!Number.isFinite(id) || id === s.job!.winner) expect(n.className).not.toContain('is-gone');
      else expect(n.className.includes('is-gone'), `#${id}`).toBe(quoters.has(id));
    }
    vi.restoreAllMocks();
  });

  it('states a failed check by name', async () => {
    const report = { ...RUN.report, checks: [{ name: 'the ledger balanced', ok: true }, { name: 'the art changed', ok: false }] };
    stubBundle('demo-real', { '/recorded/demo-real/report.json': JSON.stringify(report) });
    page(RECORDED);
    await playToTheEnd();
    expect(screen.getByText(/Failed: the art changed/)).toBeTruthy();
    expect(screen.getByText('1 / 2')).toBeTruthy();
    expect(narrator()).toMatch(/failed a check/);
  });

  it('shows an error naming the file for a missing bundle, not an empty story', async () => {
    stubBundle('other');
    page(RECORDED);
    await waitFor(() => expect(screen.getAllByText(/run\.json/).length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
  });
});

describe('the page, on LIVE', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  const LIVE: Source = { kind: 'live', network: 'testnet', router: 'spores-hack-router4.testnet' };
  const router = () => ({
    id: 'spores-hack-router4.testnet',
    rpc: {},
    sporeSummary: vi.fn(async () => ({ owner_id: 'owner.t', operator_id: 'op.t', connections: [[7, '5000']], balance: '1', reputation: 100, age: 3 })),
    renderInput: vi.fn(async (id: number) => ({ spore_id: id, seed: 'a'.repeat(64), age: 1, edges: [] })),
  });

  it('plays nothing: it offers the recording by a click that changes the source, and reads a real spore', async () => {
    stubBundle('demo-real', { '/recorded/index.json': JSON.stringify([{ run: 'demo-real', date: '2026-11-06', scene: 'loop' }]) });
    const r = router();
    page(LIVE, r);
    const link = await screen.findByRole('link', { name: /Watch the recording/ });
    expect(link.getAttribute('href')).toBe('/lab/loop?source=recorded&run=demo-real&date=2026-11-06');
    await waitFor(() => expect(r.sporeSummary).toHaveBeenCalledWith(HERO));
    await waitFor(() => expect(narrator()).toMatch(new RegExp(`Spore #${HERO} is an NFT`)));
    for (const a of LOOP_ACTS) expect(screen.getByText(a.promise)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('says so when this build has no recording, and still never falls back to one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    page(LIVE, router());
    await waitFor(() => expect(screen.getByText('No recording available.')).toBeTruthy());
    expect(screen.queryByText(/bash scripts/)).toBeNull();
    expect(screen.queryByRole('link', { name: /Watch the recording/ })).toBeNull();
  });
});

describe('the page, following a run', () => {
  const RUNNING: Source = { kind: 'run', run: 'demo-going' };
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits for the run’s first line, then follows it, and says when it loses the log', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let phase: 'none' | 'going' | 'down' = 'none';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (phase === 'down') return new Response('', { status: 500 });
        if (u.endsWith('/run.json')) return phase === 'none' ? new Response('', { status: 404 }) : new Response(read('run.json'));
        if (u.endsWith('/snapshots/')) return new Response(JSON.stringify(['start.json']));
        if (u.endsWith('/snapshots/start.json')) return new Response(read('snapshots/start.json'));
        if (u.endsWith('/events.jsonl')) return new Response(jsonl('events.jsonl').filter((e) => e.kind === 'start').map((e) => JSON.stringify(e)).join('\n') + '\n{"half":');
        return new Response('', { status: 404 });
      }),
    );
    page(RUNNING);
    await waitFor(() => expect(screen.getByText(/Waiting for the run to write its first line/)).toBeTruthy());
    phase = 'going';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() => expect(narrator()).toMatch(/is an NFT/));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/first settled hire/));
    expect(screen.queryByRole('button', { name: /Jump to/ }), 'a run going has no future to jump to').toBeNull();
    phase = 'down';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Lost the connection/));
    expect(narrator(), 'what it said stays').toMatch(/is an NFT/);
  });
});

function Follow({ all, follow }: { all: SceneLine[]; follow: boolean }) {
  const p = usePlayback<SceneLine[]>(all, { autoplay: true, build: (l) => l, delay: () => 10, lastAct: null, follow });
  return (
    <>
      <span data-testid="n">{p.lines.length}</span>
      <button onClick={p.pause}>pause</button>
    </>
  );
}

describe('usePlayback following a log', () => {
  afterEach(cleanup);
  const lines = (n: number): SceneLine[] => Array.from({ length: n }, (_, i) => ({ type: 'x', at: '', i }));

  it('keeps its place when lines arrive, and goes on from there', async () => {
    const { rerender } = render(<Follow all={lines(3)} follow />);
    await waitFor(() => expect(screen.getByTestId('n').textContent).toBe('3'));
    rerender(<Follow all={lines(5)} follow />);
    expect(Number(screen.getByTestId('n').textContent)).toBeGreaterThanOrEqual(3);
    await waitFor(() => expect(screen.getByTestId('n').textContent).toBe('5'));
  });

  it('starts over on a new log when not following', async () => {
    const { rerender } = render(<Follow all={lines(3)} follow={false} />);
    await waitFor(() => expect(screen.getByTestId('n').textContent).toBe('3'));
    rerender(<Follow all={lines(2)} follow={false} />);
    await waitFor(() => expect(screen.getByTestId('n').textContent).toBe('2'));
  });

  it('stays paused when lines arrive', async () => {
    const { rerender } = render(<Follow all={lines(2)} follow />);
    await waitFor(() => expect(screen.getByTestId('n').textContent).toBe('2'));
    fireEvent.click(screen.getByText('pause'));
    rerender(<Follow all={lines(4)} follow />);
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByTestId('n').textContent).toBe('2');
  });
});

describe('what a run may serve', () => {
  it('serves the first snapshot now, and still nothing else', () => {
    expect(isRunFile('snapshots/start.json')).toBe(true);
    for (const f of ['snapshots/start.json.bak', 'snapshots/other.json', 'start.json']) expect(isRunFile(f), f).toBe(false);
  });
});

