// S7: the Network explorer. History from router4's real close events
// (test/fixtures/router4-closes.json, fetched from testnet for the 25 closes in
// docs/router4-closes.txt) replayed with core-wasm; hit testing; the run-log
// steps; the tween and zoom; reduced motion; and the page's states.
import 'fake-indexeddb/auto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { EpochClosed } from '../src/chain/events';
import type { EpochInfo, Router, RouterConfig, SporeToken } from '../src/chain/router';
import { NetworkGraph, sample, type NetworkGraphHandle } from '../src/components/NetworkGraph';
import {
  closeSummary,
  curvePoint,
  diffTubes,
  emptyFrame,
  flowCounts,
  frameAt,
  hitNode,
  IDENTITY,
  pairKey,
  previousTubes,
  ringPos,
  toWorld,
  TubeIndex,
  tubeCurve,
  tubesFromTuples,
  tweenTubes,
  zoomAt,
  type NetworkHistory,
} from '../src/model/network';
import { runFlows, stepsFromRunLog, type RawEvent } from '../src/model/steps';
import { railCounts } from '../src/pages/Network';
import { applyReplay, frameFromClose, historyFromRun, newSettlements, type SnapshotFile } from '../src/sources/network';
import { edgesCheckOf, mergeCloses } from '../src/state/network';
import { RenderQueueContext } from '../src/wasm/art';
import { CoreWasm } from '../src/wasm/core';
import type { RenderQueue } from '../src/wasm/renderQueue';

const fixtures = path.join(process.cwd(), 'test', 'fixtures');
const closes: { hash: string; epoch_closed: EpochClosed }[] = JSON.parse(readFileSync(path.join(fixtures, 'router4-closes.json'), 'utf8'));
const config: RouterConfig = JSON.parse(readFileSync(path.join(fixtures, 'router4-config.json'), 'utf8'));

let core: CoreWasm;
beforeAll(async () => {
  const p = path.join(process.cwd(), 'public', 'wasm', 'spores_core_wasm.wasm');
  if (!existsSync(p)) throw new Error(`${p} is missing: run scripts/build-wasm.sh first`);
  core = await CoreWasm.load(readFileSync(p));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Router4 from the fixture: every close as a frame, the live epoch 26 on top. */
function router4History(): { h: NetworkHistory; events: Map<number, EpochClosed> } {
  const events = new Map(closes.map((c) => [c.epoch_closed.epoch, c.epoch_closed]));
  const frames = new Map(closes.map((c) => [c.epoch_closed.epoch, frameFromClose(c.epoch_closed, c.hash)]));
  const h: NetworkHistory = { frames, current: 26, live: { ...emptyFrame(26, 'live'), tubes: null }, dMin: Number(config.d_min) };
  return { h, events };
}

describe('history: router4 closes replayed with core-wasm', () => {
  it('the close list in the app is docs/router4-closes.txt, and the fixture is its first 25 closes in epoch order', () => {
    const doc = readFileSync(path.join(process.cwd(), '..', 'docs', 'router4-closes.txt'), 'utf8');
    expect(readFileSync(path.join(process.cwd(), 'public', 'closes', 'spores-hack-router4.testnet.txt'), 'utf8')).toBe(doc);
    // Later closes (the S11 rogue run's 26 and 27, `spores-verify` matches all 27) extend the list, not this fixture.
    expect(closes.map((c) => c.hash)).toEqual(doc.trim().split('\n').slice(0, 25));
    expect(closes.map((c) => c.epoch_closed.epoch)).toEqual([...Array(25)].map((_, i) => i + 1));
  });

  it('epochs 1–16 carry their tubes; the scrubber shows exactly them, and the replay reproduces each', () => {
    const { h, events } = router4History();
    for (let e = 1; e <= 16; e++) {
      expect(events.get(e)!.tubes, `epoch ${e}`).toBeDefined();
      expect(frameAt(h, e).tubes).toEqual(tubesFromTuples(events.get(e)!.tubes!));
      expect(frameAt(h, e).tubesFrom).toBe('event');
    }
    expect(applyReplay(h, events, core, config)).toBe(25);
    for (let e = 1; e <= 25; e++) expect(frameAt(h, e).replay, `epoch ${e}`).toBe('match');
    // Epochs 17–25 log only their tube count (S3): the replay fills the tubes in, and the count matches.
    for (let e = 17; e <= 25; e++) {
      expect(frameAt(h, e).tubesFrom).toBe('replay');
      expect(frameAt(h, e).tubes!.size).toBe(events.get(e)!.edges);
    }
    expect(frameAt(h, 25).tubes!.size).toBe(29);
    expect(frameAt(h, 20).flows).toHaveLength(21);
  });

  it('a changed flow in the history is a mismatch from that epoch on', () => {
    const { h, events } = router4History();
    const e5 = structuredClone(events.get(5)!);
    // Ten times the payment: D grows more at this close, so its fingerprint and every later one change.
    e5.flows[0][2] = String(BigInt(e5.flows[0][2]) * 10n);
    events.set(5, e5);
    applyReplay(h, events, core, config);
    expect(frameAt(h, 4).replay).toBe('match');
    expect(frameAt(h, 5).replay).toBe('mismatch');
    expect(frameAt(h, 6).replay).toBe('mismatch');
  });

  it('↻ against edges(): the replayed tubes after the last close equal the live tubes, or it says they do not', () => {
    const { h, events } = router4History();
    applyReplay(h, events, core, config);
    const live: NetworkHistory = { ...h, live: { ...h.live, tubes: new Map(frameAt(h, 25).tubes!) } };
    expect(edgesCheckOf(live)).toBe('match');
    const off = new Map(live.live.tubes);
    off.set([...off.keys()][0], 1);
    expect(edgesCheckOf({ ...live, live: { ...live.live, tubes: off } })).toBe('mismatch');
  });

  it('a close event without tubes keeps the edges() tubes its frame already had', () => {
    const { h } = router4History();
    const base: NetworkHistory = { ...h, frames: new Map([[25, { ...emptyFrame(25), tubes: new Map([[pairKey(1, 2), 5]]), tubesFrom: 'edges' }]]) };
    const merged = mergeCloses(base, new Map([[25, { ev: closes[24].epoch_closed, tx: closes[24].hash }]]));
    expect(merged.frames.get(25)!.tubesFrom).toBe('edges');
    expect(merged.frames.get(25)!.close).toEqual({ tx: closes[24].hash, fetched: true });
  });

  it('scrubber bars are each epoch’s real flow count; epochs without history are null (hollow)', () => {
    const { h } = router4History();
    h.frames.delete(4);
    const ticks = flowCounts(h);
    expect(ticks).toHaveLength(26);
    expect(ticks[3]).toEqual({ epoch: 4, flows: null, tubes: false });
    expect(ticks[19].flows).toBe(21);
  });

  it('change at a close: new, grew, decayed, dropped, and the rejects that shaped it', () => {
    const prev = new Map([[pairKey(1, 2), 500_000], [pairKey(2, 3), 300_000], [pairKey(4, 5), 60_000]]);
    const next = new Map([[pairKey(1, 2), 700_000], [pairKey(2, 3), 225_000], [pairKey(6, 7), 90_000]]);
    const d = diffTubes(prev, next, [[3, 2, 1]]);
    expect(d.counts).toEqual({ new: 1, grew: 1, decayed: 1, same: 0, dropped: 1 });
    expect(d.change.get(pairKey(4, 5))).toBe('dropped');
    expect(d.rejected.has(pairKey(2, 3))).toBe(true);
    expect(closeSummary(18, d)).toBe('Epoch 18 closed · 1 new tube · 1 tube grew · 1 decayed · 1 dropped');
    expect(closeSummary(3, diffTubes(prev, prev))).toBe('Epoch 3 closed · no tube changed');
  });

  it('the tubes before a frame: E − 1 for a closed frame, C − 2 for the live one, none before epoch 1', () => {
    const { h } = router4History();
    expect(previousTubes(h, frameAt(h, 1))).toEqual(new Map());
    expect(previousTubes(h, frameAt(h, 10))).toBe(frameAt(h, 9).tubes);
    expect(previousTubes(h, h.live)).toBe(frameAt(h, 24).tubes);
  });
});

describe('geometry and hit testing', () => {
  const cx = 300;
  const cy = 300;
  const r = 200;

  it('slots follow the art: #0 at 12 o’clock, #16 at 3, #32 at 6, #48 at 9', () => {
    const near = (p: { x: number; y: number }, x: number, y: number) => expect(Math.hypot(p.x - x, p.y - y)).toBeLessThan(1e-9);
    near(ringPos(0, cx, cy, r), 300, 100);
    near(ringPos(16, cx, cy, r), 500, 300);
    near(ringPos(32, cx, cy, r), 300, 500);
    near(ringPos(48, cx, cy, r), 100, 300);
  });

  it('a click on a curve finds that tube, within 6 px only, the nearer of two winning', () => {
    const idx = new TubeIndex([pairKey(0, 16), pairKey(0, 32), pairKey(8, 40)], cx, cy, r);
    const on = curvePoint(tubeCurve(0, 16, cx, cy, r), 0.4);
    expect(idx.hit(on, 6)).toBe(pairKey(0, 16));
    expect(idx.hit({ x: on.x + 4, y: on.y }, 6)).toBe(pairKey(0, 16));
    expect(idx.hit({ x: cx + 150, y: cy + 150 }, 6)).toBeNull();
    // #0–#32 runs straight through the centre and #8–#40 crosses it there; off the crossing, the nearer one wins.
    const p = curvePoint(tubeCurve(0, 32, cx, cy, r), 0.25);
    expect(idx.hit({ x: p.x + 1, y: p.y }, 6)).toBe(pairKey(0, 32));
  });

  it('a click near a slot finds that spore', () => {
    const p = ringPos(7, cx, cy, r);
    expect(hitNode({ x: p.x + 3, y: p.y - 3 }, [6, 7, 8], cx, cy, r, 10)).toBe(7);
    expect(hitNode({ x: cx, y: cy }, [6, 7, 8], cx, cy, r, 10)).toBeNull();
  });

  it('zoom keeps the point under the cursor and stays within 0.5×–4×', () => {
    const anchor = { x: 100, y: 50 };
    const v = zoomAt({ scale: 1, tx: 20, ty: -10 }, 2, anchor);
    expect(v.scale).toBe(2);
    expect(toWorld(v, anchor)).toEqual(toWorld({ scale: 1, tx: 20, ty: -10 }, anchor));
    expect(zoomAt(IDENTITY, 100, anchor).scale).toBe(4);
    expect(zoomAt(IDENTITY, 0.01, anchor).scale).toBe(0.5);
  });
});

describe('tween at a close', () => {
  const from = new Map([[pairKey(1, 2), 400_000], [pairKey(3, 4), 300_000]]);
  const to = new Map([[pairKey(1, 2), 800_000], [pairKey(5, 6), 100_000]]);
  const find = (ts: ReturnType<typeof tweenTubes>, a: number, b: number) => ts.find((t) => t.k === pairKey(a, b))!;

  it('grows, draws new tubes in, fades dropped ones, and ends exactly on the new state', () => {
    const start = tweenTubes(from, to, 0);
    expect(find(start, 1, 2).d).toBe(400_000);
    expect(find(start, 5, 6).reveal).toBe(0);
    expect(find(start, 3, 4).fade).toBe(1);
    expect(find(tweenTubes(from, to, 0.5), 1, 2).glow).toBeGreaterThan(0.9);
    const end = tweenTubes(from, to, 1);
    expect(find(end, 1, 2).d).toBe(800_000);
    expect(find(end, 5, 6).reveal).toBe(1);
    expect(find(end, 3, 4).fade).toBe(0);
  });

  it('a zero-length tween (reduced motion) is at its end at once', () => {
    const s = sample({ from, to, repFrom: new Map([[1, 100]]), repTo: new Map([[1, 900]]), t0: 1000, dur: 0 }, 1000);
    expect(s.done).toBe(true);
    expect(s.rep.get(1)).toBe(900);
    expect(find(s.tubes, 1, 2).d).toBe(800_000);
  });

  it('with reduced motion on, no step particle is scheduled', () => {
    let pending: FrameRequestCallback[] = [];
    const raf = vi.fn((cb: FrameRequestCallback) => pending.push(cb));
    const flush = () => {
      const run = pending;
      pending = [];
      run.forEach((cb) => cb(0));
    };
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const frame = { ...emptyFrame(5), tubes: new Map([[pairKey(1, 2), 500_000]]), active: [1, 2] };
    const props = { frame, nodeInfo: new Map(), dMax: 1e6, rMax: 1000, diff: null, selection: null, onSelect: () => {}, labels: 'selected' as const };
    const ref = createRef<NetworkGraphHandle>();
    const { unmount } = render(<NetworkGraph ref={ref} {...props} reducedMotion />);
    act(flush);
    raf.mockClear();
    act(() => ref.current!.emit('settle', 1, 2));
    expect(raf).not.toHaveBeenCalled();
    unmount();
    render(<NetworkGraph ref={ref} {...props} reducedMotion={false} />);
    act(flush);
    raf.mockClear();
    act(() => ref.current!.emit('settle', 1, 2));
    expect(raf).toHaveBeenCalled();
  });
});

// --- run logs: every step ----------------------------------------------------

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const tx = (s: number, spore: number | string, method: string, args: object, ok = true, extra: object = {}): RawEvent => ({
  at: at(s),
  spore,
  kind: 'tx',
  method,
  args: args as Record<string, any>,
  hash: `H${s}`,
  ok,
  ...extra,
});
const LOG: RawEvent[] = [
  { at: at(0), spore: 3, kind: 'start', service: 'price' },
  tx(1, 3, 'post_job', { spore_id: 3, task: '{"s":"summary"}', max_price: '500' }),
  tx(2, 9, 'quote', { job_id: 7, spore_id: 9, price: '120' }),
  tx(3, 4, 'quote', { job_id: 7, spore_id: 4, price: '150' }),
  tx(4, 3, 'accept', { job_id: 7, provider_id: 9 }),
  tx(5, 9, 'deliver', { job_id: 7, result_hash: 'sha256:x' }),
  tx(6, 3, 'settle', { job_id: 7 }),
  tx(7, 4, 'deliver', { job_id: 8 }, false, { err: 'Smart contract panicked: job has timed out' }),
  tx(8, 'keeper', 'close_epoch', {}, true, { closed: 20 }),
  tx(9, 5, 'accept', { job_id: 11, provider_id: 3 }),
  tx(10, 5, 'reject', { job_id: 11 }),
  tx(11, 5, 'pay_service', { spore_id: 5, payee: 'outside.testnet', amount: '10' }),
];

describe('steps from a run log', () => {
  const steps = stepsFromRunLog(LOG, [{ job_id: 7, consumer: 3, tx: { post: 'H1' } }], 20);

  it('names every step with its spores, job, amount and epoch, in log order', () => {
    expect(steps.map((s) => `${s.epoch}:${s.kind}:${s.from}>${s.to}${s.job === undefined ? '' : `#${s.job}`}${s.amount ? `$${s.amount}` : ''}`)).toEqual([
      '20:wake:3>null',
      '20:post:3>null#7$500',
      '20:quote:9>3#7$120',
      '20:quote:4>3#7$150',
      '20:hire:3>9#7$120',
      '20:deliver:9>3#7',
      '20:settle:3>9#7$120',
      '20:failed:4>null#8',
      '20:close:null>null',
      '21:hire:5>3#11',
      '21:reject:5>3#11',
      '21:outside:5>null$10',
    ]);
    expect(steps.find((s) => s.kind === 'failed')!.err).toBe('Smart contract panicked: job has timed out');
    expect(steps.find((s) => s.kind === 'post')!.service).toBe('summary');
  });

  it('flows per epoch are the accepted prices of settled jobs, by pair', () => {
    expect(runFlows(steps).get(20)).toEqual([[3, 9, '120']]);
    expect(runFlows(steps).get(21)).toBeUndefined();
  });

  it('the rail counts what the log has; LIVE says which steps need a run log', () => {
    const snap = (epoch: number): SnapshotFile => ({ epoch, fingerprint: 'f'.repeat(64), epoch_info: { epoch, active: [3, 4, 5, 9] }, edges: [[3, 9, '600000']], spores: {} });
    const { history } = historyFromRun([snap(21), snap(22)], steps, 50_000);
    const data = { history, spores: new Map(), steps, figures: null, readAt: 0, closes: { listed: 0, loaded: 0, error: null, listUrl: null }, edgesCheck: null };
    const c20 = railCounts(data, frameAt(history, 20), 1, null);
    expect([c20.wake.n, c20.post.n, c20.quote.n, c20.hire.n, c20.deliver.n, c20.settle.n, c20.close.n, c20.grow.n]).toEqual([1, 1, 2, 1, 1, 1, 1, 1]);
    // While epoch 20 plays, its close hasn't happened yet.
    expect(railCounts(data, frameAt(history, 20), null, steps.slice(0, 3)).close.n).toBe(0);
    const live = railCounts({ ...data, steps: null }, { ...frameAt(history, 22), flows: [[1, 2, '5']] }, null, null);
    expect(live.post.n).toBeNull();
    expect(live.post.reason).toMatch(/Needs the agents’ log/);
    expect(live.settle.n).toBe(1);
    expect(live.close.reason).toMatch(/in progress/);
  });
});

describe('live polls', () => {
  it('new and larger flows and new rejects between two polls are the settlements to show', () => {
    const before = { flows: [[1, 2, '100']] as [number, number, string][], rejects: [[1, 2, 1]] as [number, number, number][] };
    const after = { flows: [[1, 2, '150'], [3, 4, '20']] as [number, number, string][], rejects: [[1, 2, 1], [3, 5, 1]] as [number, number, number][] };
    expect(newSettlements(before, after)).toEqual({ settled: [[1, 2, '50'], [3, 4, '20']], rejected: [[3, 5]] });
    expect(newSettlements(after, after)).toEqual({ settled: [], rejected: [] });
  });
});

// --- the page ------------------------------------------------------------------

const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const seed = (id: number) => id.toString(16).padStart(64, '0');
function token(id: number, active: boolean, reputation = 0): SporeToken {
  return {
    id,
    owner_id: 'owner.testnet',
    title: `Spore #${id}`,
    glyph: null,
    extra: { seed: seed(id), active, age: 3, degree: 0, reputation, transfers: 0, sales: 0, listed_price: null, state_hash: null, image: null },
  };
}

function fakeRouter(): Router {
  const info: EpochInfo = {
    epoch: 6,
    started_ns: ns(Date.now() - 1000),
    ends_ns: ns(Date.now() + 60_000),
    prev_fingerprint: '0'.repeat(64),
    active: [1, 2, 3],
    pool: '0',
    flows: [[1, 2, '70000000000000000000000']],
    rejects: [],
  };
  return {
    id: 'test-router.testnet',
    config: async () => config,
    epochInfo: async () => info,
    allTokens: async () => [token(1, true, 1200), token(2, true, 900), token(3, true, 0), token(4, false)],
    edges: async () => [[1, 2, '800000'], [2, 3, '60000']],
    admin: async () => 'admin.testnet',
    sporeSummary: async () => null,
  } as unknown as Router;
}

async function renderNetwork(url: string) {
  // This router has no close list: a 404 for /closes/<router>.txt.
  vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
  const queue = { request: async () => ({ rgb: new Uint8Array(3), imageHash: 'h', source: 'worker', rendererVersion: 1 }) };
  await act(async () => {
    render(
      <RenderQueueContext.Provider value={async () => queue as unknown as RenderQueue}>
        <MemoryRouter initialEntries={[url]}>
          <App router={fakeRouter()} />
        </MemoryRouter>
      </RenderQueueContext.Provider>,
    );
  });
  for (let i = 0; i < 5; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
}

describe('Network page (LIVE, no close list)', () => {
  it('shows the live epoch from the bulk views, with steps the chain can’t see marked —', async () => {
    await renderNetwork('/network');
    expect(screen.getByRole('application', { name: /Network map/ })).toBeTruthy();
    expect(screen.getByText('Live · epoch 6')).toBeTruthy();
    expect(screen.getByText('tubes now').previousElementSibling!.textContent).toBe('2');
    expect(screen.getByText('No close list for this contract, so past epochs are hollow.')).toBeTruthy();
    // The flow settled so far is a feed row read from epoch_info, not a tx.
    expect(document.querySelector('.feed-row')!.textContent).toContain('0.07 NEAR');
    const chips = [...document.querySelectorAll('.loop-chip')].map((c) => c.textContent);
    expect(chips).toContain('◆Post—');
    expect(chips).toContain('✓Settle1');
  });

  it('the scrubber has a tick per epoch; past ones are hollow with the reason; keys move it', async () => {
    await renderNetwork('/network');
    const slider = screen.getByRole('slider', { name: 'Epoch' });
    expect(document.querySelectorAll('.scrub-tick')).toHaveLength(6);
    expect(document.querySelectorAll('.scrub-tick.is-hollow')).toHaveLength(5);
    expect(slider.getAttribute('aria-valuenow')).toBe('6');
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider.getAttribute('aria-valuenow')).toBe('1');
    for (let i = 0; i < 3; i++) fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider.getAttribute('aria-valuetext')).toBe('Epoch 4 · No close tx for epoch 4 in this source');
    expect(screen.getByRole('note').textContent).toBe('No tube set for epoch 4 in this source.');
    // Epoch 5 is the close before the live epoch: its tubes are edges(), its flows unknown.
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider.getAttribute('aria-valuetext')).toBe('Epoch 5 · tubes known; flows need the close tx for epoch 5');
    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider.getAttribute('aria-valuenow')).toBe('6');
  });

  it('Table view lists every tube, and selecting there opens the same inspector', async () => {
    await renderNetwork('/network');
    fireEvent.click(screen.getByRole('button', { name: 'Table view' }));
    expect([...document.querySelectorAll('.net-table')[1].querySelectorAll('tbody tr')].map((r) => r.querySelector('td')!.textContent)).toEqual(['#1 ↔ #2', '#2 ↔ #3']);
    fireEvent.click(screen.getByRole('button', { name: 'Select Spore #1' }));
    expect(screen.getByRole('heading', { name: 'Spore #1' })).toBeTruthy();
    expect(document.querySelector('[aria-live]')!.textContent).toBe('Spore #1 selected, R 1.20, 1 tube');
    fireEvent.click(screen.getByRole('button', { name: '#1 ↔ #2' }));
    expect(screen.getByText('Per-job receipts are in the agents’ log. On chain: per-epoch flows only.')).toBeTruthy();
  });

  it('keyboard on the map: Tab walks active spores in id order, Escape clears', async () => {
    await renderNetwork('/network');
    const map = screen.getByRole('application', { name: /Network map/ });
    fireEvent.keyDown(map, { key: 'Tab' });
    expect(screen.getByRole('heading', { name: 'Spore #1' })).toBeTruthy();
    fireEvent.keyDown(map, { key: 'Tab' });
    expect(screen.getByRole('heading', { name: 'Spore #2' })).toBeTruthy();
    fireEvent.keyDown(map, { key: 'Escape' });
    expect(screen.getByText('Live · epoch 6')).toBeTruthy();
  });

  it('a link with ?epoch= and ?sel= opens scrubbed there with that tube selected', async () => {
    await renderNetwork('/network?epoch=4&sel=2-3');
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('4');
    expect(screen.getByRole('heading', { name: /#2.*#3/ })).toBeTruthy();
  });

  it('a link with ?sel= alone opens at the end with that spore selected', async () => {
    await renderNetwork('/network?sel=2');
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('6');
    expect(screen.getByRole('heading', { name: 'Spore #2' })).toBeTruthy();
  });

  it('the simulation source says it has no map', async () => {
    await renderNetwork('/network?source=sim');
    expect(screen.getByText('The simulation has no map')).toBeTruthy();
  });
});
