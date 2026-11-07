// The step monitor and the living tubes (user 2026-11-04).
import { render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { FeedRow } from '../src/components/LoopRail';
import { lanesFor, StepMonitor, tracePath } from '../src/components/StepMonitor';
import { phaseOf, profile, STILL, sway } from '../src/graph/flex';
import { inputKey, useNodeArt, type NodeArtInput } from '../src/graph/nodeArt';
import { RenderQueueContext } from '../src/wasm/art';
import type { RenderQueue } from '../src/wasm/renderQueue';
import { artEnds, artReach, curvePoint, pairKey, ringPos, slotDir, tubeCurve, tweenTubes } from '../src/model/network';
import { epochFeed } from '../src/pages/Network';
import type { Step } from '../src/model/steps';

const row = (key: string, kind: FeedRow['kind'], t: number | null): FeedRow => ({ key, kind, text: key, epoch: 3, t, tx: null, evidence: t === null ? 'chain' : 'logged' });
const step = (t: number, kind: Step['kind']): Step => ({ t, at: t, epoch: 3, kind, from: 1, to: 2, tx: null });

describe('step monitor', () => {
  it('epochFeed: rows newest first, t from the first step, the log span and the kinds', () => {
    const f = epochFeed([step(1000, 'post'), step(1500, 'quote'), step(4000, 'hire')]);
    expect(f.rows.map((r) => [r.kind, r.t])).toEqual([
      ['hire', 3000],
      ['quote', 500],
      ['post', 0],
    ]);
    expect(f.span).toBe(3000);
    expect(f.kinds).toEqual(['post', 'quote', 'hire']);
  });

  it('a run log keeps the loop lanes even before any step played; chain rows only their own', () => {
    expect(lanesFor([], ['failed'], true)).toEqual(['post', 'quote', 'hire', 'deliver', 'settle', 'failed']);
    expect(lanesFor([row('a', 'reject', null), row('b', 'settle', null)], [], false)).toEqual(['settle', 'reject']);
  });

  it('the trace is a closed area normalised to the busiest bucket', () => {
    expect(tracePath([], 10)).toBeNull();
    expect(tracePath([0, 0, 9], 10, 2)).toBe('M0 1 L0 0.000 L1 0.000 L1 0.500 L2 0.500 L2 1 Z');
  });

  it('places ticks by log time with a playhead on the newest while playing', () => {
    const rows = [row('q', 'quote', 2000), row('p', 'post', 0)];
    const { container } = render(<StepMonitor rows={rows} span={4000} kinds={['post', 'quote']} epoch={3} mode="play" empty="none" />);
    const ticks = [...container.querySelectorAll('.monitor-tick')];
    expect(ticks.map((t) => t.getAttribute('x'))).toEqual(['0%', '50%']);
    expect(container.querySelector('.monitor-tick.is-new')!.getAttribute('x')).toBe('50%');
    expect((container.querySelector('.monitor-playhead') as HTMLElement).style.left).toBe('50%');
    expect(container.querySelector('.monitor-body')!.getAttribute('aria-label')).toBe('2 steps in epoch 3: 1 post, 1 quote, 0 hire, 0 deliver, 0 settle');
    // The text log stays in the DOM for screen readers.
    expect(container.querySelectorAll('.feed-row')).toHaveLength(2);
  });

  it('chain rows have no time: a tally with the reason, no trace or playhead', () => {
    const rows = [row('s1', 'settle', null), row('s2', 'settle', null)];
    const { container } = render(<StepMonitor rows={rows} span={0} kinds={['settle']} epoch={3} mode="live" empty="none" />);
    expect([...container.querySelectorAll('.monitor-tick')].map((t) => t.getAttribute('x'))).toEqual(['0', '6']);
    expect(container.querySelector('.monitor-trace')).toBeNull();
    expect(container.querySelector('.monitor-playhead')).toBeNull();
    expect(container.textContent).toContain('unordered: the chain keeps per-pair totals');
  });
});

describe('living tubes', () => {
  const q = tubeCurve(3, 40, 300, 300, 200);
  const k = pairKey(3, 40);

  it('reduced motion: the curve is the layout curve and the width only flares at the ends', () => {
    expect(sway(q, k, STILL)).toBe(q);
    expect(profile(0.5, 300, { k, angle: 0, swell: 0, clock: STILL })).toBeCloseTo(1, 6);
    expect(profile(0, 300, { k, angle: 0, swell: 0, clock: STILL })).toBeGreaterThan(1.8);
  });

  it('sway is the same whichever way the tube is drawn, and stays within 3.5 px', () => {
    const clock = { now: 1234, ambient: true };
    const ab = sway(q, k, clock);
    const ba = sway(tubeCurve(40, 3, 300, 300, 200), k, clock);
    for (const t of [0.25, 0.5, 0.75]) {
      expect(curvePoint(ab, t).x).toBeCloseTo(curvePoint(ba, 1 - t).x, 9);
      expect(curvePoint(ab, t).y).toBeCloseTo(curvePoint(ba, 1 - t).y, 9);
    }
    const m = curvePoint(ab, 0.5);
    const m0 = curvePoint(q, 0.5);
    expect(Math.hypot(m.x - m0.x, m.y - m0.y)).toBeLessThanOrEqual(3.5 + 1e-9);
  });

  it('where a tube leaves a spore\'s art it starts at the vein width and thickens to √D', () => {
    const o = { k, angle: 0, swell: 0, clock: STILL, taper: [0.2, null] as [number, null] };
    expect(profile(0, 300, o)).toBeCloseTo(0.2, 6);
    expect(profile(0.5, 300, o)).toBeCloseTo(1, 6);
    expect(profile(1, 300, o)).toBeGreaterThan(1.8);
  });

  it('the ambient wave averages out along a tube, so the mean width stays √D', () => {
    const o = { k, angle: 0, swell: 0, clock: { now: 0, ambient: true } };
    let sum = 0;
    const n = 2000;
    // Mid-tube only (away from the flares); breathing at now = 0 is sin(0) = 0.
    for (let i = 0; i < n; i++) sum += profile(0.3 + (0.4 * i) / n, 900, o);
    expect(sum / n).toBeCloseTo(1, 1);
    expect(phaseOf(k)).toBeGreaterThanOrEqual(0);
  });

  it('only a tube that grew or was born swells at a close, and the swell ends with the close', () => {
    const from = new Map([
      [1, 100],
      [2, 100],
    ]);
    const to = new Map([
      [1, 200],
      [2, 50],
      [3, 10],
    ]);
    const mid = Object.fromEntries(tweenTubes(from, to, 0.5).map((t) => [t.k, t.swell]));
    expect(mid).toEqual({ 1: 0.5, 2: 0, 3: 0.5 });
    expect(tweenTubes(from, to, 1).every((t) => t.swell === 0)).toBe(true);
  });
});

describe('spore nodes', () => {
  const seed = 'ab'.repeat(32);
  const items: NodeArtInput[] = [
    { id: 3, input: { seed, age: 5, edges: [[7, '120000']] }, glyph: null },
    { id: 9, input: null, glyph: null },
  ];

  it('asks the renderer for each spore with art, behind anything on screen, once per input', async () => {
    const asked: { key: string; priority: number | undefined }[] = [];
    const queue = {
      request: (input: NodeArtInput['input'] & object, o: { priority?: number }) => {
        asked.push({ key: inputKey(input), priority: o.priority });
        return new Promise(() => {});
      },
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RenderQueueContext.Provider value={async () => queue as unknown as RenderQueue}>{children}</RenderQueueContext.Provider>
    );
    const { rerender } = renderHook(({ list }) => useNodeArt(list), { wrapper, initialProps: { list: items } });
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toEqual({ key: `${seed}|5|7:120000`, priority: 3 });
    rerender({ list: items.map((i) => ({ ...i })) });
    await new Promise((r) => setTimeout(r, 10));
    expect(asked).toHaveLength(1);
  });
});

describe('tubes leave from the spore\'s art', () => {
  it('artReach is the renderer\'s partner-disc radius (renderer/src/sim.rs nodes())', () => {
    // min(168 − 84·dn/1000, bound_r(deg) − 12), bound_r = min(140 + 10·deg, 215)
    expect(artReach(0, 1)).toBe(138);
    expect(artReach(0, 8)).toBe(168);
    expect(artReach(1_000_000, 8)).toBe(84);
    expect(artReach(5_000_000, 3)).toBe(84);
    expect(artReach(500_000, 8)).toBe(126);
    expect(artReach(120_999, 10)).toBe(158);
  });

  it('a tube starts at the partner\'s disc in each art and leaves along the art\'s vein', () => {
    const reach = new Map([
      [3, new Map([[40, 126]])],
      [40, new Map([[3, 84]])],
    ]);
    const ends = artEnds((id) => reach.get(id), () => 64);
    const q = tubeCurve(3, 40, 300, 300, 200, ends);
    const a = ringPos(3, 300, 300, 200);
    const u = slotDir(40);
    expect(q.p0.x).toBeCloseTo(a.x + u.x * 126 * (64 / 512), 9);
    expect(q.p0.y).toBeCloseTo(a.y + u.y * 126 * (64 / 512), 9);
    // It leaves along the art's vein: the plain handle (2/3 of the way to the bowed control), pushed 1.5× the reach along the vein.
    const b = ringPos(40, 300, 300, 200);
    const c = { x: 300 + 0.35 * ((a.x + b.x) / 2 - 300), y: 300 + 0.35 * ((a.y + b.y) / 2 - 300) };
    const off = { x: q.p0.x - a.x, y: q.p0.y - a.y };
    expect(q.c0.x).toBeCloseTo(q.p0.x + (2 / 3) * (c.x - q.p0.x) + 1.5 * off.x, 9);
    expect(q.c0.y).toBeCloseTo(q.p0.y + (2 / 3) * (c.y - q.p0.y) + 1.5 * off.y, 9);
    // A spore without art keeps the plain end at its slot.
    const plain = tubeCurve(3, 40, 300, 300, 200, artEnds((id) => (id === 3 ? reach.get(3) : null), () => 64));
    expect(plain.p1).toEqual(ringPos(40, 300, 300, 200));
  });
});
