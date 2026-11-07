// S11: the Demo Lab against the real rogue run (test/fixtures/rogue, a copy of
// the run's scene.jsonl on router4). Nothing reads as done before the log says
// so; a wrong error string, a non-zero exit or a missing exit line is never
// "Completed".
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { angleGap, fanOut, gateLayout, membraneAt, metrics, subCurve } from '../src/graph/stage';
import { actStarts, buildScene, durationMs, gapMs, narrate, parseSceneLog, refusalCount, storyDelay, type SceneLine } from '../src/model/scene';
import { DemoLab } from '../src/pages/DemoLab';
import { RogueScene } from '../src/pages/RogueScene';
import { isRunFile } from '../src/sources/runFiles';
import { SceneClient, type ServerScene } from '../src/sources/scene';
import { usePlayback } from '../src/state/scene';
import { AppContext, type AppState } from '../src/state/source';
import type { Source } from '../src/model/types';
import { RenderQueueContext } from '../src/wasm/art';

const isOff = (el: HTMLElement) => (el as HTMLButtonElement).disabled;
const TEXT = readFileSync(path.join(__dirname, 'fixtures/rogue/scene.jsonl'), 'utf8');
const LINES = parseSceneLog(TEXT);
const CAP = 'policy: payment exceeds the per-payment cap';
const BUDGET = 'policy: epoch budget exceeded';
const PAYEE = 'policy: payee is not on the external allowlist';
const upTo = (pred: (l: SceneLine) => boolean) => LINES.slice(0, LINES.findIndex(pred) + 1);
const without = (type: string) => LINES.filter((l) => l.type !== type);

describe('buildScene on the real run', () => {
  const s = buildScene(LINES);

  it('has the three exact refusals, with their txs, and the one allowed payment', () => {
    const tries = s.attempts.flatMap((a) => a.tries);
    expect(tries.map((t) => t.decision)).toEqual(['refused', 'allowed', 'refused', 'refused']);
    expect(tries.filter((t) => t.decision === 'refused').map((t) => t.err)).toEqual([CAP, BUDGET, PAYEE]);
    expect(tries.every((t) => !t.unexpected && /^[1-9A-HJ-NP-Za-km-z]{40,}$/.test(t.tx!))).toBe(true);
    expect(refusalCount(s)).toEqual({ refused: 3, total: 3 });
  });

  it('completes only on all checks and the real exit line', () => {
    expect(s.checks).toHaveLength(8);
    expect(s.checks.every((c) => c.ok)).toBe(true);
    expect(s.verdict).toEqual({ status: 'completed', line: 'Completed: 8 of 8 checks passed', failed: null });
  });

  it('builds the decay strip from the chain’s values: N, N+1, N+2, with #55 removed at N+2', () => {
    expect(s.plates.map((p) => [p.mark, p.epoch, p.reputation])).toEqual([['N', 26, '1303'], ['N+1', 27, '1128'], ['N+2', 28, '782']]);
    expect(s.plates[1].tubes).toContainEqual([55, '50683']);
    expect(s.plates[2].removed).toEqual([55]);
    expect(s.plates[0].close).toBeNull();
    expect(s.plates[2].close?.epoch).toBe(27);
    expect(s.plates[2].close?.tx).toMatch(/^C8D3/);
  });

  it('tracks the money: escrow while held, back at the refund, balance as it started', () => {
    expect(buildScene(upTo((l) => l.type === 'snapshot' && l.label === 'escrow')).escrow?.amount).toBe('20000000000000000000000');
    expect(s.escrow).toBeNull();
    expect(s.now?.balance).toBe(s.before?.balance);
    expect(s.limitsSet).toBe(false);
  });
});

describe('truth over time', () => {
  it('shows no decision before the tx’s outcome line', () => {
    const sent = LINES.findIndex((l) => l.type === 'step' && l.method === 'accept');
    const pending = buildScene(LINES.slice(0, sent + 1));
    expect(pending.attempts[0].tries[0].decision).toBe('pending');
    expect(narrate(pending)).toContain('tries to pay');
    expect(narrate(pending)).not.toContain('Refused');
    expect(refusalCount(pending).refused).toBe(0);
    const decided = buildScene(LINES.slice(0, sent + 2));
    expect(decided.attempts[0].tries[0].decision).toBe('refused');
    expect(narrate(decided)).toBe('Refused by the contract.');
  });

  it('every prefix of the log stays running until the exit line, even after done:true', () => {
    const exit = LINES.findIndex((l) => l.type === 'exit');
    for (let i = 1; i < exit; i++) expect(buildScene(LINES.slice(0, i)).verdict.status).toBe('running');
    expect(buildScene(LINES.slice(0, exit + 1)).verdict.status).toBe('completed');
  });

  it('tubes move only with a close line', () => {
    const before = buildScene(upTo((l) => l.type === 'close'));
    expect(before.now?.reputation).toBe('1303');
    expect(before.closes).toBe(1);
    const after = buildScene(LINES.slice(0, LINES.findIndex((l) => l.type === 'close') + 2));
    expect(after.now?.reputation).toBe('1128');
    expect(narrate(after)).toBe('Epoch 26 closed. Reputation 1.30 → 1.13.');
  });
});

describe('failed runs say so', () => {
  it('a non-zero exit is never completed, whatever the script said', () => {
    const lines = LINES.map((l) => (l.type === 'exit' ? { ...l, code: 3 } : l));
    expect(buildScene(lines).verdict).toMatchObject({ status: 'failed', line: 'Failed: the script exited with code 3' });
  });

  it('names the failed check with both strings', () => {
    const lines = LINES.map((l) => (l.type === 'check' && l.n === 3 ? { ...l, ok: false, actual: 'policy: spore is paused' } : l.type === 'done' ? { ...l, ok: false } : l));
    expect(buildScene(lines).verdict.line).toBe(`Failed at check 3: expected ${BUDGET}, got policy: spore is paused`);
  });

  it('a failed check shows at once, before the script has exited', () => {
    const i = LINES.findIndex((l) => l.type === 'check');
    const lines = LINES.slice(0, i + 1).map((l) => (l.type === 'check' ? { ...l, ok: false } : l));
    expect(buildScene(lines).verdict.status).toBe('failed');
  });

  it('a script that dies, one with no done line, and a done:false without a check', () => {
    expect(buildScene([{ type: 'fatal', error: 'no spore fits' }, { type: 'exit', code: 2 }]).verdict.line).toBe('Failed: no spore fits');
    expect(buildScene([...without('done').filter((l) => l.type !== 'exit'), { type: 'exit', code: 0 }]).verdict.line).toBe('Failed: the script exited before it finished');
    expect(buildScene([{ type: 'done', ok: false }, { type: 'exit', code: 0 }]).verdict.status).toBe('failed');
  });

  it('marks a refusal for the wrong reason and a tx that should have been refused', () => {
    const wrong = LINES.map((l) => (l.type === 'result' && l.err === CAP ? { ...l, err: 'insufficient balance' } : l));
    const t = buildScene(wrong).attempts[0].tries[0];
    expect(t).toMatchObject({ decision: 'refused', unexpected: true });
    expect(refusalCount(buildScene(wrong)).refused).toBe(2);
    const through = LINES.map((l) => (l.type === 'result' && l.err === PAYEE ? { ...l, ok: true, err: '' } : l));
    expect(buildScene(through).attempts[2].tries[0]).toMatchObject({ decision: 'allowed', unexpected: true });
  });

  it('keeps a line it cannot read', () => {
    const lines = parseSceneLog('{"type":"act","act":"cap"}\nnot json\n[1]\n');
    expect(buildScene(lines).bad).toEqual(['not json', '[1]']);
  });
});

describe('pacing', () => {
  it('tells the whole story in under 45 s, the first refusal in under 12 s', () => {
    expect(durationMs(LINES, 'story')).toBeLessThan(45_000);
    const first = LINES.findIndex((l) => l.type === 'result' && l.err === CAP);
    expect(durationMs(LINES.slice(0, first + 1), 'story')).toBeLessThan(12_000);
  });

  it('real time is the log’s own gaps', () => {
    const span = Date.parse(LINES.at(-1)!.at) - Date.parse(LINES[0].at);
    expect(durationMs(LINES, 'real')).toBe(span);
    expect(span).toBeGreaterThan(120_000);
    expect(gapMs(undefined, LINES[0], 'real')).toBe(0);
  });

  it('holds on a refusal longer than on setup', () => {
    expect(storyDelay({ type: 'result', method: 'accept', ok: false })).toBeGreaterThan(storyDelay({ type: 'result', method: 'quote', ok: true }));
  });

  it('finds each act', () => {
    const at = actStarts(LINES);
    expect(Object.keys(at)).toEqual(['limits', 'cap', 'budget', 'drain', 'quiet', 'cleanup']);
    expect(LINES[at.quiet!]).toMatchObject({ type: 'act', act: 'quiet' });
  });
});

describe('usePlayback', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('plays, pauses, seeks, ends and restarts', () => {
    const { result } = renderHook(() => usePlayback(LINES, { autoplay: true }));
    expect(result.current.playing).toBe(true);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current.lines).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(storyDelay(LINES[0]) + 1));
    expect(result.current.lines).toHaveLength(2);
    act(() => result.current.pause());
    const n = result.current.lines.length;
    act(() => void vi.advanceTimersByTime(60_000));
    expect(result.current.lines).toHaveLength(n);
    act(() => result.current.seekAct('quiet'));
    expect(result.current.scene.act).toBe('quiet');
    expect(result.current.scene.attempts[2].tries).toHaveLength(1);
    act(() => result.current.seekAct('cleanup'));
    expect(result.current.finished).toBe(true);
    expect(result.current.scene.verdict.status).toBe('completed');
    act(() => result.current.restart());
    expect(result.current.lines).toHaveLength(0);
    expect(result.current.playing).toBe(true);
  });

  it('runs off the end and stops', () => {
    const { result } = renderHook(() => usePlayback(LINES, { autoplay: true }));
    for (let i = 0; i < LINES.length + 2; i++) act(() => void vi.advanceTimersByTime(4_000));
    expect(result.current.finished).toBe(true);
    expect(result.current.playing).toBe(false);
  });

  it('does not start on its own without autoplay', () => {
    const { result } = renderHook(() => usePlayback(LINES, { autoplay: false }));
    act(() => void vi.advanceTimersByTime(5_000));
    expect(result.current.lines).toHaveLength(0);
  });
});

describe('stage geometry', () => {
  const deg = (d: number) => (d * Math.PI) / 180;

  it('keeps gates and the attacker clear of every tube, on the real run and a crowded ring', () => {
    for (const [partners, provider] of [[[1, 2, 7, 55], 31], [[0, 1, 6, 16], 40], [[10, 12, 14], 44]] as [number[], number][]) {
      const g = gateLayout(partners, provider);
      for (const a of g.partners.values()) {
        for (const gate of [g.cap, g.budget, g.attacker]) expect(angleGap(a, gate)).toBeGreaterThan(deg(20));
      }
      expect(angleGap(g.attacker, g.cap)).toBeGreaterThan(deg(20));
      expect(angleGap(g.attacker, g.budget)).toBeGreaterThan(deg(20));
      expect(angleGap(g.wall, g.attacker)).toBeGreaterThan(deg(20));
    }
  });

  it('fans neighbours apart, in order', () => {
    const f = fanOut([{ id: 1, a: deg(5) }, { id: 2, a: deg(11) }, { id: 7, a: deg(39) }], deg(20));
    expect(angleGap(f.get(1)!, f.get(2)!)).toBeGreaterThanOrEqual(deg(19.9));
    expect(angleGap(f.get(2)!, f.get(7)!)).toBeGreaterThanOrEqual(deg(19.9));
  });

  it('a push moves the wall out only near the gate; a passage thins it there', () => {
    const m = metrics(800, 600);
    const still = { now: 0, ambient: false };
    const rest = membraneAt(m, 1, [], still);
    expect(rest.r).toBe(m.membraneR);
    const pushed = membraneAt(m, 1, [{ angle: 1, push: 30, part: 0, flash: 0 }], still);
    expect(pushed.r).toBeCloseTo(m.membraneR + 30);
    expect(membraneAt(m, 1 + Math.PI, [{ angle: 1, push: 30, part: 0, flash: 0 }], still).r).toBeCloseTo(m.membraneR);
    expect(membraneAt(m, 1, [{ angle: 1, push: 0, part: 1, flash: 0 }], still).w).toBeCloseTo(0);
  });

  it('subCurve ends where the curve is at that share', () => {
    const q = { p0: { x: 0, y: 0 }, c0: { x: 0, y: 10 }, c1: { x: 10, y: 10 }, p1: { x: 10, y: 0 } };
    expect(subCurve(q, 1).p1).toEqual(q.p1);
    expect(subCurve(q, 0.5).p1).toEqual({ x: 5, y: 7.5 });
  });
});

// --- pages -----------------------------------------------------------------------

const READY: ServerScene = {
  id: 'rogue',
  title: 'Rogue agent',
  running: false,
  run: null,
  preconditions: [
    { key: 'keys', label: 'Testnet keys in .env', ok: true },
    { key: 'spore', label: 'Test spore #0 ready, hiring #31', ok: true, pick: { spore: 0, provider: 31 } },
  ],
  reset: { blocked: 'Nothing to reset: each run puts the policy back itself, and tube decay can’t be undone.' },
};

class FakeEventSource {
  listeners = new Map<string, ((e: any) => void)[]>();
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(name: string, fn: (e: any) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  emit(name: string, data?: string) {
    for (const fn of this.listeners.get(name) ?? []) fn({ data });
  }
  close() {
    this.closed = true;
  }
}

function fakeClient(answer: ServerScene | Error | 'hang', run: () => Promise<Response> = async () => new Response('{"run":"r"}', { status: 202 })) {
  const sources: FakeEventSource[] = [];
  const posts: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(String(url));
      return run();
    }
    if (answer === 'hang') return new Promise(() => {});
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify({ scenes: [answer] }));
  }) as typeof fetch;
  const client = new SceneClient('http://server.test', fetchFn, (u) => {
    const es = new FakeEventSource(u);
    sources.push(es);
    return es as unknown as EventSource;
  });
  return { client, sources, posts };
}

/** Static files: the recording list and the bundle. */
function stubFiles({ bundle = true }: { bundle?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u === '/recorded/index.json') return bundle ? new Response(JSON.stringify([{ run: 'rogue-real', date: '2026-11-06', scene: 'rogue' }, { run: 'other', date: '2026-11-07' }])) : new Response('', { status: 404 });
      if (u === '/recorded/rogue-real/scene.jsonl') return new Response(TEXT);
      return new Response('', { status: 404 });
    }),
  );
}

const LIVE: Source = { kind: 'live', network: 'testnet', router: 'spores-hack-router4.testnet' };
const RECORDED: Source = { kind: 'recorded', run: 'rogue-real', date: '2026-11-06' };

function fakeRouter() {
  const start = LINES.find((l) => l.type === 'start')!;
  const render = (id: number) => start.peers.find((p: any) => p.id === id) ?? { id, seed: 'a'.repeat(64), age: 1, edges: [] };
  return {
    id: 'spores-hack-router4.testnet',
    rpc: {},
    sporeSummary: vi.fn(async () => ({ connections: [[1, '132814']], balance: '1278784672500000000000000', reputation: 1303 })),
    renderInput: vi.fn(async (id: number) => ({ spore_id: id, ...render(id) })),
    config: vi.fn(async () => ({ d_min: '50000' })),
  };
}

function page(ui: React.ReactNode, source: Source, route = '/lab/rogue') {
  const state = {
    source,
    sourceError: null,
    reducedMotion: true,
    router: source.kind === 'live' ? fakeRouter() : null,
    epoch: { info: { epoch: 28 }, error: null, staleSince: null, retry: () => {} },
  } as unknown as AppState;
  return render(
    <RenderQueueContext.Provider value={() => Promise.reject(new Error('no renderer in this test'))}>
      <AppContext.Provider value={state}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/lab" element={ui} />
            <Route path="/lab/rogue" element={ui} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    </RenderQueueContext.Provider>,
  );
}

describe('Rogue page', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stubFiles();
    window.scrollTo = vi.fn() as never;
    errors = vi.spyOn(console, 'error');
  });
  afterEach(() => {
    expect(errors.mock.calls).toEqual([]);
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('LIVE with no server: the recording is the way in, no live controls or server hints, nothing is played on its own', async () => {
    const { client } = fakeClient(new Error('Failed to fetch'));
    page(<RogueScene client={client} />, LIVE);
    expect((await screen.findByRole('link', { name: /Watch it happen · \d+ s/ })).getAttribute('href')).toEqual(expect.stringContaining('source=recorded&run=rogue-real'));
    expect(screen.queryByRole('button', { name: /Run it live/ })).toBeNull();
    expect(screen.queryByText(/scene-server|scene server/i)).toBeNull();
    expect(screen.queryByText(/Completed/)).toBeNull();
    expect(screen.queryByText('Refused', { exact: false, selector: '.stamp' })).toBeNull();
  });

  it('LIVE with no server and no recording says both, and invents nothing', async () => {
    stubFiles({ bundle: false });
    const { client } = fakeClient(new Error('Failed to fetch'));
    page(<RogueScene client={client} />, LIVE);
    expect(await screen.findByText('No recording available.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Watch it happen/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Run it live/ })).toBeNull();
  });

  it('LIVE idle shows the plan as plans, with the real spore read from the router', async () => {
    const { client } = fakeClient(READY);
    page(<RogueScene client={client} />, LIVE);
    expect(await screen.findByText(/Spore #0’s agent holds a key to 1\.2787 NEAR/)).toBeTruthy();
    expect(screen.getByText('Pay above the per-payment cap')).toBeTruthy();
    expect(screen.getByText('scripted')).toBeTruthy();
    expect(screen.queryByText('Refused', { exact: false, selector: '.stamp' })).toBeNull();
  });

  it('Run stays off until every precondition is met', async () => {
    const { client, posts } = fakeClient({ ...READY, preconditions: [{ key: 'spore', label: 'A spore with tubes to watch', ok: false, detail: 'no spore fits' }] });
    page(<RogueScene client={client} />, LIVE);
    const run = await screen.findByRole('button', { name: 'Run it live on testnet' });
    await screen.findByText(/A spore with tubes to watch: not ready/);
    expect(isOff(run)).toBe(true);
    fireEvent.click(run);
    expect(posts).toEqual([]);
  });

  it('a live run streams: pending, then the stamp and verbatim error, then the verdict only at the exit line', async () => {
    const { client, sources, posts } = fakeClient(READY);
    page(<RogueScene client={client} />, LIVE);
    const run = await screen.findByRole('button', { name: 'Run it live on testnet' });
    await waitFor(() => expect(isOff(run)).toBe(false));
    fireEvent.click(run);
    await waitFor(() => expect(sources).toHaveLength(1));
    expect(posts).toEqual(['http://server.test/scenes/rogue/run']);
    expect(sources[0].url).toBe('http://server.test/scenes/rogue/stream');
    expect((screen.getByRole('status')).textContent).toContain('Running on testnet');
    expect(screen.queryByRole('button', { name: /Run/ })).toBeNull();

    const feed = (lines: SceneLine[]) => act(() => lines.forEach((l) => sources[0].emit('scene', JSON.stringify(l))));
    const sent = LINES.findIndex((l) => l.type === 'step' && l.method === 'accept');
    feed(LINES.slice(0, sent + 1));
    expect(screen.getByText('Waiting for the final outcome…')).toBeTruthy();
    expect(screen.queryByText(CAP, { selector: '.lane-error' })).toBeNull();
    feed([LINES[sent + 1]]);
    expect(screen.getByText(CAP, { selector: '.lane-error' })).toBeTruthy();
    expect((screen.getAllByRole('link', { name: new RegExp(`tx ${LINES[sent + 1].tx}`) })[0]).getAttribute('href')).toEqual(`https://testnet.nearblocks.io/txns/${LINES[sent + 1].tx}`);

    const exit = LINES.findIndex((l) => l.type === 'exit');
    feed(LINES.slice(sent + 2, exit));
    expect(screen.queryByText(/Completed/)).toBeNull();
    feed([LINES[exit]]);
    act(() => sources[0].emit('end', '{}'));
    expect(await screen.findByText('Completed: 8 of 8 checks passed')).toBeTruthy();
    expect(sources[0].closed).toBe(true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run again on testnet' })).toBeTruthy());
  });

  it('a live run that fails says which check', async () => {
    const { client, sources } = fakeClient(READY);
    page(<RogueScene client={client} />, LIVE);
    const run = await screen.findByRole('button', { name: 'Run it live on testnet' });
    await waitFor(() => expect(isOff(run)).toBe(false));
    fireEvent.click(run);
    await waitFor(() => expect(sources).toHaveLength(1));
    const first = LINES.findIndex((l) => l.type === 'check');
    act(() => {
      for (const l of LINES.slice(0, first)) sources[0].emit('scene', JSON.stringify(l));
      sources[0].emit('scene', JSON.stringify({ ...LINES[first], ok: false, actual: 'policy: spore is paused' }));
      sources[0].emit('scene', JSON.stringify({ type: 'exit', code: 1 }));
      sources[0].emit('end', '{}');
    });
    expect(await screen.findByText(`Failed at check 1: expected ${CAP}, got policy: spore is paused`)).toBeTruthy();
    expect(screen.queryByText(/Completed/)).toBeNull();
  });

  it('a refused start and a dropped connection are shown', async () => {
    const { client, sources } = fakeClient(READY, async () => new Response('{"error":"a run is in progress"}', { status: 409 }));
    page(<RogueScene client={client} />, LIVE);
    const run = await screen.findByRole('button', { name: 'Run it live on testnet' });
    await waitFor(() => expect(isOff(run)).toBe(false));
    fireEvent.click(run);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not start: a run is in progress');
    expect(sources).toHaveLength(0);
    cleanup();
    const second = fakeClient({ ...READY, running: true, run: 'r2' });
    page(<RogueScene client={second.client} />, LIVE);
    await waitFor(() => expect(second.sources).toHaveLength(1));
    act(() => second.sources[0].emit('error'));
    expect(await screen.findByText(/connection lost, retrying/)).toBeTruthy();
    act(() => second.sources[0].emit('open'));
    await waitFor(() => expect(screen.queryByText(/connection lost/)).toBeNull());
  });

  it('RECORDED plays by itself, jumps and ends, with real tx links and no Run button', async () => {
    const { client, posts } = fakeClient(new Error('not used'));
    page(<RogueScene client={client} />, RECORDED);
    const verdictStop = await screen.findByRole('button', { name: 'Jump to: Verdict' });
    fireEvent.click(verdictStop);
    expect(await screen.findByText('Completed: 8 of 8 checks passed')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Watch again/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Run/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Run it live instead' })).toBeTruthy();
    expect(posts).toEqual([]);
    const strip = screen.getByRole('region', { name: 'Decay while the agent is quiet' });
    expect(within(strip).getByText('tube removed at this close')).toBeTruthy();
    expect(within(strip).getByText('R 0.78')).toBeTruthy();
    expect(within(strip).getByText(/25% of every D/)).toBeTruthy();
    expect(screen.getByText('A payment past the epoch budget is refused')).toBeTruthy();
  });

  it('a recording it can’t read is an error naming it, with Retry, never another source', async () => {
    const { client } = fakeClient(new Error('not used'));
    page(<RogueScene client={client} />, { kind: 'recorded', run: 'missing', date: '' });
    const alert = await screen.findByRole('alert');
    expect((alert).textContent).toContain('/recorded/missing/scene.jsonl');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText(/Completed/)).toBeNull();
  });

  it('Reset is off with the reason unless the server has something to undo', async () => {
    const { client, posts } = fakeClient(READY);
    page(<RogueScene client={client} />, LIVE);
    expect(await screen.findByText(READY.reset.blocked!)).toBeTruthy();
    expect(isOff(screen.getByRole('button', { name: 'Reset' }))).toBe(true);
    cleanup();
    const pending = fakeClient({ ...READY, reset: { blocked: null } }, async () => new Response('{"ok":true}'));
    page(<RogueScene client={pending.client} />, LIVE);
    const reset = await screen.findByRole('button', { name: 'Reset' });
    await waitFor(() => expect(isOff(reset)).toBe(false));
    fireEvent.click(reset);
    await waitFor(() => expect(pending.posts).toEqual(['http://server.test/scenes/rogue/reset']));
    expect(posts).toEqual([]);
  });
});

describe('Demo Lab index', () => {
  beforeEach(() => stubFiles());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('has four scenes; the injection card is unavailable, has no run button and links to Rogue', async () => {
    const { client } = fakeClient(new Error('down'));
    page(<DemoLab client={client} />, LIVE, '/lab');
    expect(await screen.findByRole('heading', { name: 'Rogue agent' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    const card = screen.getByRole('heading', { name: 'Prompt injection against a naive agent' }).closest('li')!;
    expect(within(card).getByText('Unavailable')).toBeTruthy();
    expect(within(card).getByText(/No LLM agent exists in this project/)).toBeTruthy();
    expect((within(card).getByRole('link', { name: 'Go to Rogue agent →' })).getAttribute('href')).toEqual('/lab/rogue');
    expect(within(card).queryByRole('button')).toBeNull();
    expect(screen.queryByText('Not built yet')).toBeNull();
    expect(screen.getByRole('link', { name: /Sale and control transfer/ }).getAttribute('href')).toContain('/lab/sale');
    expect(screen.getByRole('link', { name: /Wash trading/ }).getAttribute('href')).toContain('/lab/wash');
  });

  it('never calls a slow server down, and says the mode and lengths it really has', async () => {
    const hang = fakeClient('hang');
    page(<DemoLab client={hang.client} />, LIVE, '/lab');
    await screen.findByRole('heading', { name: 'Rogue agent' });
    expect(screen.queryByText(/scene server/)).toBeNull();
    cleanup();

    const down = fakeClient(new Error('down'));
    page(<DemoLab client={down.client} />, LIVE, '/lab');
    expect((await screen.findAllByText(/\d+ s to watch · 3 min in real time/))[0]).toBeTruthy();
    expect(screen.getByText('RECORDED')).toBeTruthy();
    cleanup();

    const up = fakeClient(READY);
    page(<DemoLab client={up.client} />, LIVE, '/lab');
    expect(await screen.findByText(/preconditions 2\/2/)).toBeTruthy();
    expect(screen.getByText('LIVE testnet')).toBeTruthy();
    cleanup();

    stubFiles({ bundle: false });
    const none = fakeClient(new Error('down'));
    page(<DemoLab client={none.client} />, LIVE, '/lab');
    await screen.findAllByText(/length —/);
    const rogue = screen.getByRole('heading', { name: 'Rogue agent' }).closest('li')!;
    expect(within(rogue).getByText('Unavailable')).toBeTruthy();
    expect(within(rogue).getByText(/length —/)).toBeTruthy();
  });
});

describe('a static host’s HTML answer', () => {
  const html = async () => new Response('<!doctype html><title>Spores</title>', { status: 200, headers: { 'content-type': 'text/html' } });

  it('is a missing file, not data: a run file, the bundle list, the manifest', async () => {
    const { loadSceneLog } = await import('../src/sources/scene');
    const { listRecorded, recordedManifest } = await import('../src/sources/recorded');
    await expect(loadSceneLog({ kind: 'recorded', run: 'gone', date: '' }, html as typeof fetch)).rejects.toMatchObject({ status: 404, url: '/recorded/gone/scene.jsonl' });
    expect(await listRecorded(html as typeof fetch)).toEqual([]);
    await expect(recordedManifest('gone', html as typeof fetch)).rejects.toMatchObject({ status: 404 });
  });
});

describe('scene files', () => {
  it('scene.jsonl is a readable run file; a recording stays one', () => {
    expect(isRunFile('scene.jsonl')).toBe(true);
    expect(isRunFile('../scene.jsonl')).toBe(false);
    expect(isRunFile('control.json')).toBe(false);
  });

  it('the committed bundle is the real run and holds no key', () => {
    const dir = path.join(__dirname, '../public/recorded');
    const index = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
    const entry = index.find((b: { scene?: string }) => b.scene === 'rogue');
    expect(entry).toBeTruthy();
    const log = readFileSync(path.join(dir, entry.run, 'scene.jsonl'), 'utf8');
    expect(log).toBe(TEXT);
    expect(JSON.parse(readFileSync(path.join(dir, entry.run, 'files.json'), 'utf8'))).toContain('scene.jsonl');
    for (const f of ['scene.jsonl', 'events.jsonl', 'run.json']) expect(readFileSync(path.join(dir, entry.run, f), 'utf8')).not.toMatch(/ed25519:|private_?key/i);
  });
});
