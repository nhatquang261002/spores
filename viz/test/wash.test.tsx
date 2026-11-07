// S12 done-when: every number on the wash panel matches the simulator's own
// reports, read from the committed copies in public/recorded/sim/. Failures are
// stated as failures, the figure names its configuration, and every configuration
// S1 measured stays on screen.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spreadLabels } from '../src/components/WashChart';
import { cappedBy, configOf, failures, FIRST_PICK, FIXED_SENTENCE, LOOPS, loopOf, nearOfMilli, pathsOf, trafficName, washLine, yMax, type WashData } from '../src/model/wash';
import { WashScene } from '../src/pages/WashScene';
import { washData } from '../src/sources/recorded';
import { AppContext, type AppState } from '../src/state/source';

const dir = path.join(__dirname, '../public/recorded/sim');
const file = (f: string) => readFileSync(path.join(dir, f), 'utf8');
const DATA: WashData = JSON.parse(file('wash.json'));
const REPORT = file('phase1-report.md');
/** The section of the report on the shipped params. */
const SHIPPED = REPORT.slice(REPORT.indexOf('**shipped**'));

/** The shipped row of an `allowance*.md`: gate and worst net, as the simulator printed them. */
function shippedRow(name: string) {
  const row = file(name).split('\n').find((l) => l.includes('(shipped)'))!;
  const cells = row.split('|').map((c) => c.trim());
  const [pass, cases] = cells[8].split('/').map(Number);
  return { pass, cases, net: cells[9] };
}

describe('the panel’s numbers against the simulator’s reports', () => {
  const FILES: [string, number, number][] = [['allowance.md', 16, 3], ['allowance-j1.md', 16, 1], ['allowance-64.md', 64, 3], ['allowance-64-j1.md', 64, 1]];

  it.each(FILES)('%s: the gate and the worst net at %i active, %i jobs', (name, active, jobs) => {
    const c = configOf(DATA, { active, jobs })!;
    const row = shippedRow(name);
    expect(c.gate_pass).toBe(row.pass);
    expect(c.cases).toBe(row.cases);
    expect(c.worst_net_near.toFixed(4)).toBe(row.net);
    // The 16 × 3 file predates --max-active and --jobs, and doesn't name its scale.
    if (name !== 'allowance.md') expect(file(name)).toContain(`${active} active spores, ${jobs} honest jobs`);
  });

  it('the S1 results, by value: 270, 270, 255 and 168 of 270, and the attacker always loses money', () => {
    const at = (active: number, jobs: number) => configOf(DATA, { active, jobs })!;
    expect([at(16, 3).gate_pass, at(64, 3).gate_pass, at(16, 1).gate_pass, at(64, 1).gate_pass]).toEqual([270, 270, 255, 168]);
    expect(DATA.configs.every((c) => c.cases === 270 && c.loses_money === 270)).toBe(true);
    expect(DATA.configs.map((c) => c.worst_net_near.toFixed(4))).toEqual(['-0.0010', '-0.0010', '-0.0010', '-0.0010']);
  });

  it('Phase 1: the gate and the §9 literal test, as the report says', () => {
    const p = DATA.phase1;
    expect(SHIPPED).toContain(`gate ${p.gate_in_range.pass}/${p.gate_in_range.cases} in range, ${p.gate_all.pass}/${p.gate_all.cases} over the whole grid`);
    expect(SHIPPED).toContain(`§9 literal ${p.literal_in_range.pass}/${p.literal_in_range.cases} in range`);
    expect([p.gate_in_range.pass, p.gate_in_range.cases, p.gate_all.pass, p.gate_all.cases]).toEqual([270, 270, 355, 361]);
    expect(p.literal_in_range).toEqual({ pass: 177, cases: 270 });
  });

  it('the 93 literal failures, row by row against the report’s table, are all tiny loops', () => {
    const p = DATA.phase1;
    for (const l of p.literal) {
      const loop = String(l.loop_milli_near / 1000);
      const row = SHIPPED.split('\n').find((x) => x.startsWith(`| ${l.spores} | ${loop} |`))!;
      const cells = row.split('|').map((c) => c.trim());
      expect(cells[4]).toBe(`${l.literal_pass}/${l.cases}`);
      expect(cells[7]).toBe(l.worst_rep_ratio.toFixed(2));
    }
    const failed = p.literal.filter((l) => l.literal_pass < l.cases);
    expect(failed.reduce((n, l) => n + l.cases - l.literal_pass, 0)).toBe(93);
    expect(Math.max(...failed.map((l) => l.loop_milli_near))).toBe(50);
    expect(Math.max(...failed.map((l) => l.worst_rep_ratio)).toFixed(2)).toBe('12.12');
  });

  it('the 6 out-of-range failures are the report’s: K = 0.5, loop 5, 3 spores', () => {
    const list = DATA.phase1.out_of_range_failures;
    expect(list).toHaveLength(6);
    expect(SHIPPED).toContain('Gate failures outside the range (6)');
    for (const f of list) {
      expect(f).toMatchObject({ spores: 3, k_milli_near: '500', loop_milli_near: '5000' });
      expect(f.net_near_worst).toBeLessThan(0);
      expect(f.attacker_max_rep).toBeGreaterThan(f.honest_median_rep);
      const gain = Number(f.gain);
      expect(SHIPPED).toContain(`K=0.5 fee=${f.fee_bps} gain=${gain} loop=5`);
    }
  });
});

describe('the chart’s lines', () => {
  const all = DATA.configs.flatMap((c) => c.loops.map((l) => ({ c, l })));

  it('have 40 epochs from 3 seeds, for every traffic level and every loop', () => {
    expect(DATA.configs).toHaveLength(4);
    expect(all).toHaveLength(40);
    for (const { l } of all) {
      expect(l.default.series.map((s) => s.seed)).toEqual([1, 2, 3]);
      const p = pathsOf(l);
      expect([p.attacker.length, p.honest.length, p.money.length]).toEqual([40, 40, 40]);
    }
  });

  it('are read as the gate reads them: highest attacker, lowest honest, smallest loss', () => {
    const l = loopOf(configOf(DATA, FIRST_PICK)!, FIRST_PICK)!;
    const p = pathsOf(l);
    for (let i = 0; i < 40; i++) {
      expect(p.attacker[i]).toBe(Math.max(...l.default.series.map((s) => s.attacker_r[i])));
      expect(p.honest[i]).toBe(Math.min(...l.default.series.map((s) => s.honest_r[i])));
      expect(p.money[i]).toBe(Math.max(...l.default.series.map((s) => s.attacker_money[i])));
    }
  });

  it('take the same side on seeds that differ, whatever this data happens to hold', () => {
    const series = [
      { seed: 1, attacker_r: [1, 5], honest_r: [2, 9], attacker_money: [-1, -3] },
      { seed: 2, attacker_r: [4, 2], honest_r: [8, 3], attacker_money: [-2, -1] },
    ];
    const l = { spores: 2, loop_milli_near: 10, cases: 1, gate_pass: 1, loses_money: 1, worst_net_near: -1, worst_r_ratio: 0, default: { gate_pass: true, net_near_worst: -1, attacker_max_rep: 5, honest_median_rep: 3, series } };
    expect(pathsOf(l)).toEqual({ attacker: [4, 5], honest: [2, 3], money: [-1, -1] });
  });

  it('end where the case’s own totals say', () => {
    for (const { l } of all) {
      const p = pathsOf(l);
      expect(p.money.at(-1)).toBeCloseTo(l.default.net_near_worst, 5);
      expect(Math.max(...p.attacker)).toBeCloseTo(l.default.attacker_max_rep, 2);
    }
  });

  it('agree with the verdict: a failed gate is an attacker at or past the honest line, a held one isn’t', () => {
    for (const { l } of all) {
      const p = pathsOf(l);
      const windowed = p.attacker.slice(20);
      const peak = Math.max(...windowed);
      const honest = l.default.honest_median_rep;
      expect(l.default.gate_pass).toBe(l.default.net_near_worst < 0 && l.default.attacker_max_rep < honest);
      if (!l.default.gate_pass) expect(peak).toBeGreaterThanOrEqual(honest - 0.01);
    }
  });

  it('share one y scale that holds every value', () => {
    const top = yMax(DATA);
    for (const { l } of all) for (const s of l.default.series) expect(Math.max(...s.attacker_r, ...s.honest_r)).toBeLessThanOrEqual(top);
  });
});

describe('what the panel says', () => {
  it('opens on the unfavourable case, by name', () => {
    const c = configOf(DATA, FIRST_PICK)!;
    const l = loopOf(c, FIRST_PICK)!;
    expect([c.active, c.jobs, c.gate_pass]).toEqual([64, 1, 168]);
    expect(l.default.gate_pass).toBe(false);
    expect(washLine(l)).toBe('It pays 0.20 NEAR and gets past the honest median.');
  });

  it('the same loop on a busy network holds', () => {
    const l = loopOf(configOf(DATA, { active: 64, jobs: 3 })!, FIRST_PICK)!;
    expect(l.default.gate_pass).toBe(true);
    expect(washLine(l)).toBe('It pays 0.20 NEAR and still trails the honest median.');
  });

  it('states every failure as a failure, none dropped, with its count', () => {
    const list = failures(DATA);
    expect(list.map((f) => f.count)).toEqual(['102 of 270 failed', '15 of 270 failed', '6 of 91 failed', '93 of 270 failed']);
    expect(list[0].where).toContain('64 active × 1 job');
    expect(list[0].what).toContain('It lost money in 270 of 270');
    expect(list[2].what).toContain('K = 0.5, a 5 NEAR loop, 3 spores');
    expect(list[3].what).toContain('12.12 times');
    expect(list[3].what).toContain('0.05 NEAR or less');
  });

  it('never claims a loss the data doesn’t have', () => {
    const edited = structuredClone(DATA);
    edited.configs[3].loses_money = 200;
    expect(failures(edited)[0].what).toContain('It lost money in 200 of 270');
    edited.phase1.gate_in_range.pass = 269;
    expect(failures(edited).at(-1)!.what).not.toContain('still lose money');
  });

  it('names a capped loop only when the numbers are exactly the smaller loop’s', () => {
    const c = configOf(DATA, FIRST_PICK)!;
    expect(cappedBy(c, loopOf(c, { spores: 3, loop: 5000 })!)!.loop_milli_near).toBe(1000);
    expect(cappedBy(c, loopOf(c, { spores: 3, loop: 200 })!)).toBeNull();
    expect(cappedBy(c, loopOf(c, { spores: 3, loop: 10 })!)).toBeNull();
  });

  it('formats and names plainly', () => {
    expect(LOOPS.map(nearOfMilli)).toEqual(['0.01 NEAR', '0.05 NEAR', '0.2 NEAR', '1 NEAR', '5 NEAR']);
    expect(trafficName({ active: 64, jobs: 1 })).toContain('like the live one');
    expect(trafficName({ active: 16, jobs: 1 })).toBe('Quiet network');
    expect(trafficName({ active: 64, jobs: 3 })).toBe('Busy network');
  });

  it('the end labels stay readable when the lines meet, with the higher value on top', () => {
    expect(spreadLabels(100, 200, 34)).toEqual([100, 200]);
    expect(spreadLabels(100, 110, 34)).toEqual([88, 122]);
    expect(spreadLabels(110, 100, 34)).toEqual([122, 88]);
  });
});

describe('Wash page', () => {
  beforeEach(() => {
    window.scrollTo = vi.fn() as never;
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (String(u) === '/recorded/sim/wash.json' ? new Response(JSON.stringify(DATA)) : new Response('', { status: 404 }))));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function page() {
    const state = { source: { kind: 'live', network: 'testnet', router: 'r' }, sourceError: null, reducedMotion: true, router: null, epoch: { info: null, error: null, staleSince: null, retry: () => {} } } as unknown as AppState;
    return render(
      <AppContext.Provider value={state}>
        <MemoryRouter>
          <WashScene />
        </MemoryRouter>
      </AppContext.Provider>,
    );
  }

  it('asks the question, labels itself a simulation, and shows the figure with its configuration', async () => {
    page();
    expect(await screen.findByRole('heading', { name: 'Can one owner pump reputation by trading between their own spores?' })).toBeTruthy();
    await screen.findByText('168 / 270', { selector: '.figure-l' });
    expect(screen.getAllByText('SIMULATION').length).toBe(2);
    expect(screen.getByText(/64 active, 1 honest job per spore per epoch \(the live network’s traffic\)/)).toBeTruthy();
    expect(screen.getByText(FIXED_SENTENCE)).toBeTruthy();
    expect(document.querySelector('.sim-panel')).toBeTruthy();
    // Under reduced motion the whole result is there at once.
    expect(await screen.findByText('epoch 40 / 40')).toBeTruthy();
  });

  it('keeps every configuration on screen, and each one changes the figure and the verdict', async () => {
    page();
    await screen.findByText('168 / 270', { selector: '.figure-l' });
    const traffic = screen.getByRole('group', { name: 'Honest traffic' });
    const rows = within(traffic).getAllByRole('button');
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.querySelector('.traffic-n')!.textContent)).toEqual(['270 / 270', '270 / 270', '168 / 270', '255 / 270']);
    expect(document.querySelector('.wash-case .stamp')!.textContent).toContain('Gate failed');
    fireEvent.click(rows[0]);
    expect(rows[0].getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('270 / 270', { selector: '.figure-l' })).toBeTruthy();
    expect(document.querySelector('.wash-case .stamp')!.textContent).toContain('Gate held');
    expect(screen.getByText('It pays 0.20 NEAR and still trails the honest median.')).toBeTruthy();
  });

  it('the loop and the spores drive the case; a capped loop says so', async () => {
    page();
    await screen.findByText('168 / 270', { selector: '.figure-l' });
    const slider = screen.getByRole('slider', { name: /How much money/ }) as HTMLInputElement;
    expect(slider.getAttribute('aria-valuetext')).toBe('0.2 NEAR');
    fireEvent.change(slider, { target: { value: '4' } });
    expect(slider.getAttribute('aria-valuetext')).toBe('5 NEAR');
    expect(screen.getByText(/Same result as 1 NEAR/)).toBeTruthy();
    fireEvent.change(slider, { target: { value: '0' } });
    expect(screen.queryByText(/Same result as/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '2 spores' }));
    expect(screen.getByRole('button', { name: '2 spores' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/2 spores, 0.01 NEAR a loop/)).toBeTruthy();
  });

  it('states the failures in a table, and has the chart as numbers', async () => {
    page();
    await screen.findByText('168 / 270', { selector: '.figure-l' });
    expect(screen.getByRole('heading', { name: 'Where it fails' })).toBeTruthy();
    for (const count of ['102 of 270 failed', '15 of 270 failed', '6 of 91 failed', '93 of 270 failed']) expect(screen.getByText(count)).toBeTruthy();
    expect(document.querySelectorAll('.wash-table-scroll tbody tr')).toHaveLength(40);
    expect(screen.queryByText(/cargo run/)).toBeNull();
  });

  it('a missing file is an error naming it, with Retry; never an empty panel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    page();
    expect((await screen.findByRole('alert')).textContent).toContain('/recorded/sim/wash.json');
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
  });

  it('a static host’s HTML answer is a missing file', async () => {
    const html = async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(washData(html as typeof fetch)).rejects.toMatchObject({ status: 404, url: '/recorded/sim/wash.json' });
  });
});
