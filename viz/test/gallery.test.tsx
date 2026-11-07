// S6: the collection gallery. State reading (Design §1.5), the image-hash
// badge (a real check, run here on spore 5's committed epoch-17 image with the
// renderer wasm), the live and snapshot loaders, sort and filter, and the
// page's states (loading, error + retry, empty filter, no listings, stale,
// reload on close, roving focus).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { EdgeTuple, EpochInfo, Router, SporeToken, TokenExtra } from '../src/chain/router';
import { RpcError } from '../src/chain/rpc';
import { cardLabel, partnersText } from '../src/components/SporeCard';
import {
  describeFilters,
  filterSpores,
  galleryFromLive,
  galleryFromSnapshot,
  imageBadge,
  parseFilters,
  readStatus,
  sortSpores,
  writeFilters,
  type RunSnapshot,
} from '../src/model/gallery';
import type { ImageEvidence } from '../src/model/types';
import { lastSnapshot, loadLiveGallery, loadSnapshotGallery } from '../src/sources/gallery';
import { RenderQueueContext } from '../src/wasm/art';
import { encodeRenderInput, RendererWasm } from '../src/wasm/renderer';
import type { RenderQueue } from '../src/wasm/renderQueue';

afterEach(cleanup);

const seed = (last: number, fill = '1a') => fill.repeat(31) + last.toString(16).padStart(2, '0');
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const info = (epoch: number, extra: Partial<EpochInfo> = {}): EpochInfo => ({
  epoch,
  started_ns: ns(Date.now() - 5_000),
  ends_ns: ns(Date.now() + 25_000),
  prev_fingerprint: '0'.repeat(64),
  active: [],
  pool: '0',
  flows: [],
  rejects: [],
  ...extra,
});
const commit = (epoch: number, state: string, image: string) => ({ epoch, state_hash: state, image_hash: image, renderer_version: 1 });
function token(id: number, x: Partial<TokenExtra>, owner = 'deployer.spores-hack.testnet'): SporeToken {
  return {
    id,
    owner_id: owner,
    title: `Spore #${id}`,
    glyph: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>",
    extra: { seed: seed(id), active: true, age: 5, degree: 0, reputation: 0, transfers: 0, sales: 0, listed_price: null, state_hash: `s${id}`, image: null, ...x },
  };
}

describe('state reading (Design §1.5)', () => {
  it('reads the full set when the policy is known, and only "activated" from the bulk views', () => {
    const paused = { paused: true }, running = { paused: false };
    expect(readStatus({ active: false })).toEqual({ status: 'dormant', derived: false });
    expect(readStatus({ active: true })).toEqual({ status: 'activated', derived: false });
    expect(readStatus({ active: true, policy: running, operator: 'op' })).toEqual({ status: 'active', derived: false });
    expect(readStatus({ active: true, policy: paused, operator: null, transfers: 1 })).toEqual({ status: 'control-reset', derived: true });
    expect(readStatus({ active: true, policy: paused, operator: 'op', transfers: 0 })).toEqual({ status: 'awaiting-policy', derived: false });
    expect(readStatus({ active: true, policy: paused, operator: 'op', transfers: 2 })).toEqual({ status: 'paused', derived: false });
    // a snapshot has no transfer count: paused is true either way
    expect(readStatus({ active: true, policy: paused, operator: 'op', transfers: null }).status).toBe('paused');
  });
});

describe('image-hash badge', () => {
  const ev = (o: Partial<ImageEvidence> = {}): ImageEvidence => ({
    stateEpoch: 26,
    stateHash: 'cur',
    commit: { epoch: 26, stateHash: 'cur', imageHash: 'img', rendererVersion: 1 },
    ...o,
  });
  it('compares only a commit for the state shown, and only renders of the same renderer version', () => {
    expect(imageBadge(ev({ commit: null }), null)).toBe('none');
    expect(imageBadge(ev({ commit: { epoch: 17, stateHash: 'old', imageHash: 'img', rendererVersion: 1 } }), { imageHash: 'img', rendererVersion: 1 })).toBe('older');
    expect(imageBadge(ev({ stateHash: 'other' }), { imageHash: 'img', rendererVersion: 1 })).toBe('older');
    expect(imageBadge(ev({ stateHash: null }), null)).toBe('older');
    expect(imageBadge(ev(), null)).toBe('checking');
    expect(imageBadge(ev(), { imageHash: 'img', rendererVersion: 1 })).toBe('match');
    expect(imageBadge(ev(), { imageHash: 'nope', rendererVersion: 1 })).toBe('mismatch');
    expect(imageBadge(ev(), { imageHash: 'img', rendererVersion: 2 })).toBe('other-renderer');
  });

  describe('spore 5 on router4 (spores-verify image: match for its epoch-17 commit)', () => {
    // render_input and state of spore 5 at epoch 17 (out/agents/phase5-exit2/snapshots/epoch-017.json);
    // the commit as router4 returns it (`nft_token` 5, metadata.extra.image).
    const epoch17 = { seed: '1ad5d6a6938bbde23f85a3f43306716784f9f4f70c6ef1bd7f49dfc70ce215d4', age: 16, edges: [[0, 480004], [1, 969818], [3, 52699], [6, 97650]] as [number, number][] };
    const committed = {
      epoch: 17,
      stateHash: 'd09c99572178f124ece346c79a5450ec1667e3cfa5a810e26c66ce7e39a83f0b',
      imageHash: 'ac15a3e9eaaac7cedb069c0c677bb534ebbee62e54986c86d5e5586410058cfe',
      rendererVersion: 1,
    };
    let renderer: RendererWasm;
    beforeAll(async () => {
      const p = path.join(process.cwd(), 'public/wasm/spores_renderer.wasm');
      if (!existsSync(p)) throw new Error(`${p} is missing: run scripts/build-wasm.sh first`);
      renderer = await RendererWasm.load(readFileSync(p));
    });

    it('is ✓ when the epochs line up', { timeout: 30_000 }, () => {
      const { imageHash } = renderer.render(encodeRenderInput(epoch17));
      expect(imageBadge({ stateEpoch: 17, stateHash: committed.stateHash, commit: committed }, { imageHash, rendererVersion: 1 })).toBe('match');
    });

    it('is "older commit" at a later state (router4 epoch 26)', () => {
      const now = { stateEpoch: 26, stateHash: '9cb669f40d318429f4310d2fa424b30060dca39df680e51c0c3003015dfcf605', commit: committed };
      expect(imageBadge(now, null)).toBe('older');
    });
  });
});

describe('gallery model', () => {
  const edges: EdgeTuple[] = [[0, 3, '900000'], [0, 1, '300000'], [1, 3, '80000']];
  const tokens = [
    token(3, { degree: 2, reputation: 1231, age: 9, listed_price: '800000000000000000000000' }),
    token(0, { degree: 2, reputation: 1496, image: commit(26, 's0', 'h0') }),
    token(1, { degree: 2, reputation: 830, age: 7 }),
    token(2, { active: false, age: 0, state_hash: null, seed: seed(2) }),
  ];

  it('builds tubes from edges() as render_input does, and keeps the bulk reading coarse', () => {
    const g = galleryFromLive(info(26, { flows: [[1, 3, '5']], rejects: [[3, 0, 1]] }), tokens, edges, 1);
    expect(g.epoch).toBe(26);
    expect(g.coarseStatus).toBe(true);
    expect(g.spores.map((s) => s.organism.id)).toEqual([0, 1, 2, 3]);
    expect(g.spores[0].organism.tubes).toEqual([[1, '300000'], [3, '900000']]);
    expect(g.spores[2].organism.tubes).toEqual([]);
    expect(g.spores.map((s) => s.status.status)).toEqual(['activated', 'activated', 'dormant', 'activated']);
    expect(g.spores[0].image).toEqual({ stateEpoch: 26, stateHash: 's0', commit: { epoch: 26, stateHash: 's0', imageHash: 'h0', rendererVersion: 1 } });
    expect(g.spores.map((s) => s.pairsThisEpoch)).toEqual([1, 1, 0, 2]);
  });

  it('sorts with ties to the lower id, and filters with OR inside a group and AND across', () => {
    const g = galleryFromLive(info(26, { flows: [[1, 3, '5']], rejects: [[3, 0, 1]] }), tokens, edges, 1).spores;
    const ids = (l: typeof g) => l.map((s) => s.organism.id);
    expect(ids(sortSpores(g, 'reputation'))).toEqual([0, 3, 1, 2]);
    expect(ids(sortSpores(g, 'degree'))).toEqual([0, 1, 3, 2]);
    expect(ids(sortSpores(g, 'age'))).toEqual([3, 1, 0, 2]);
    expect(ids(sortSpores(g, 'price'))).toEqual([3, 0, 1, 2]);
    expect(ids(sortSpores(g, 'recent'))).toEqual([3, 0, 1, 2]);
    const f = parseFilters(new URLSearchParams('f=active,dormant,tubes&pal=bogus'));
    expect(f).toEqual({ state: ['active', 'dormant'], listed: false, tubes: true, palettes: [], mine: false });
    expect(ids(filterSpores(g, f))).toEqual([0, 1, 3]);
    expect(ids(filterSpores(g, { ...f, listed: true }))).toEqual([3]);
    const pal = g[0].organism.palette;
    expect(ids(filterSpores(g, { state: [], listed: false, tubes: false, palettes: [pal] }))).toContain(0);
    const q = writeFilters(new URLSearchParams('source=run&run=x&f=old'), { state: ['dormant'], listed: true, tubes: false, palettes: [1] });
    expect(q.toString()).toBe('source=run&run=x&f=dormant%2Clisted&pal=ember');
    expect(describeFilters({ state: ['active'], listed: false, tubes: false, palettes: [1] }, false)).toBe('Active + ember');
    expect(describeFilters({ state: ['active'], listed: false, tubes: false, palettes: [] }, true)).toBe('Activated');
  });

  it('names each card for screen readers (Design §6.B)', () => {
    const g = galleryFromLive(info(17), [token(7, { reputation: 1430, listed_price: '800000000000000000000000' })], [[3, 7, '1'], [7, 12, '1'], [7, 40, '1'], [7, 41, '1']], 1);
    expect(cardLabel(g.spores[0], 'match')).toBe('Spore #7, activated, epoch 17, degree 4, reputation 1.43, listed 0.80 NEAR, image verified');
    expect(partnersText([[40, '1'], [3, '1'], [12, '1']])).toBe('partners #3 #12 #40');
    expect(partnersText(Array.from({ length: 10 }, (_, i) => [i, '1'] as [number, string]))).toBe('partners #0 #1 #2 #3 #4 #5 #6 #7 +2');
    expect(partnersText([])).toBe('no tubes');
  });

  const snapshot: RunSnapshot = {
    label: 'epoch-026',
    epoch: 26,
    epoch_info: info(26, { active: [5, 6, 7] }),
    spores: {
      '5': {
        render_input: { spore_id: 5, epoch: 26, seed: seed(5), age: 25, edges: [[1, 409143], [0, 202503]] },
        reputation: '1089',
        degree: 2,
        owner_id: 'buyer.spores-hack.testnet',
        operator_id: 'operator2.spores-hack.testnet',
        policy: { paused: false, budget_per_epoch: '1', max_payment: '1', allow_all_spores: true, allowlist: [], external_allowlist: [] },
        listed_price: null,
        sales: 1,
        state: [26, 'abc'],
        image: commit(17, 'old', 'img'),
      },
      '6': {
        render_input: { spore_id: 6, epoch: 26, seed: seed(6), age: 3, edges: [] },
        reputation: 0,
        degree: 0,
        owner_id: 'owner.spores-hack.testnet',
        operator_id: null,
        policy: { paused: true, budget_per_epoch: '0', max_payment: '0', allow_all_spores: false, allowlist: [], external_allowlist: [] },
        listed_price: null,
        state: [25, 'stale'],
        image: null,
      },
      '9': {
        render_input: { spore_id: 9, epoch: 26, seed: seed(9), age: 0, edges: [] },
        reputation: 0,
        degree: 0,
        owner_id: 'deployer.spores-hack.testnet',
        operator_id: null,
        policy: { paused: true, budget_per_epoch: '0', max_payment: '0', allow_all_spores: false, allowlist: [], external_allowlist: [] },
        listed_price: null,
        state: null,
        image: null,
      },
    },
  };

  it('reads a run snapshot with the full state set', () => {
    const g = galleryFromSnapshot(snapshot, 1);
    expect(g.coarseStatus).toBe(false);
    expect(g.spores.map((s) => [s.organism.id, s.status.status, s.status.derived])).toEqual([
      [5, 'active', false],
      [6, 'control-reset', true],
      [9, 'dormant', false],
    ]);
    expect(g.spores[0].organism.tubes).toEqual([[0, '202503'], [1, '409143']]);
    expect(g.spores[0].organism.reputation).toBe(1089);
    // a state hash from another epoch is not the state shown
    expect(g.spores[1].image.stateHash).toBeNull();
    expect(imageBadge(g.spores[0].image, null)).toBe('older');
  });

  it('picks the last epoch snapshot and loads run and recorded sources by file', async () => {
    expect(lastSnapshot(['start.json', 'epoch-021.json', 'epoch-102.json', 'epoch-099.json'])).toBe('epoch-102.json');
    expect(lastSnapshot(['snapshots/epoch-003.json', 'run.json'])).toBe('epoch-003.json');
    expect(lastSnapshot(['start.json'])).toBeNull();
    const served: string[] = [];
    const fetchFn = (async (url: string) => {
      served.push(url);
      if (url === '/runs/r1/snapshots/') return Response.json(['epoch-025.json', 'epoch-026.json', 'start.json']);
      if (url === '/recorded/b1/files.json') return Response.json(['run.json', 'snapshots/epoch-026.json']);
      if (url.endsWith('snapshots/epoch-026.json')) return Response.json(snapshot);
      return new Response('', { status: 404 });
    }) as typeof fetch;
    expect((await loadSnapshotGallery({ kind: 'run', run: 'r1' }, fetchFn)).spores).toHaveLength(3);
    expect((await loadSnapshotGallery({ kind: 'recorded', run: 'b1', date: '' }, fetchFn)).epoch).toBe(26);
    expect(served).toEqual(['/runs/r1/snapshots/', '/runs/r1/snapshots/epoch-026.json', '/recorded/b1/files.json', '/recorded/b1/snapshots/epoch-026.json']);
    await expect(loadSnapshotGallery({ kind: 'run', run: 'none' }, fetchFn)).rejects.toThrow(/http 404/);
  });

  it('reads the live views within one epoch, again if a close came in between', async () => {
    let n = 0;
    const epochs = [26, 27, 27, 27];
    const router = { epochInfo: async () => info(epochs[n++]), allTokens: async () => [token(0, {})], edges: async () => [] } as unknown as Router;
    expect((await loadLiveGallery(router)).epoch).toBe(27);
    const moving = { epochInfo: async () => info(n++), allTokens: async () => [], edges: async () => [] } as unknown as Router;
    await expect(loadLiveGallery(moving, 2)).rejects.toThrow(/an epoch closed during each of 2 reads/);
  });
});

// --- the page --------------------------------------------------------------

/** Renders in-process: the image hash is `h<id>` for each spore's seed, so commits can be set to match or not. */
function fakeQueue(): () => Promise<RenderQueue> {
  const q = {
    request: async (input: { seed: string }) => ({ rgb: new Uint8Array(3), imageHash: `h${parseInt(input.seed.slice(62), 16)}`, source: 'worker', rendererVersion: 1 }),
  };
  return async () => q as unknown as RenderQueue;
}

function liveRouter(o: { epoch?: () => number; tokens?: () => Promise<SporeToken[]>; edges?: EdgeTuple[] } = {}) {
  const calls = { tokens: 0 };
  const router = {
    epochInfo: async () => info(o.epoch?.() ?? 26),
    allTokens: async () => {
      calls.tokens++;
      return o.tokens
        ? o.tokens()
        : [
            token(0, { image: commit(26, 's0', 'h0'), reputation: 1496 }),
            token(1, { image: commit(26, 's1', 'not-what-renders') }),
            token(2, { active: false, state_hash: null }),
            token(3, { image: commit(20, 'old', 'x'), listed_price: '800000000000000000000000' }, 'buyer.spores-hack.testnet'),
          ];
    },
    edges: async () => o.edges ?? [[0, 1, '900000'], [0, 3, '300000']],
  } as unknown as Router;
  return { router, calls };
}

async function renderPage(url: string, router: Router) {
  await act(async () => {
    render(
      <RenderQueueContext.Provider value={fakeQueue()}>
        <MemoryRouter initialEntries={[url]}>
          <App router={router} />
        </MemoryRouter>
      </RenderQueueContext.Provider>,
    );
  });
  await settle();
}
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const cards = () => [...document.querySelectorAll<HTMLAnchorElement>('a.spore-card')];

describe('Marketplace gallery page', () => {
  it('shows every spore with state, the real image check, owner and price', async () => {
    await renderPage('/market', liveRouter().router);
    expect(cards().map((a) => a.getAttribute('aria-label'))).toEqual([
      'Spore #0, activated, epoch 26, degree 2, reputation 1.50, image verified',
      'Spore #1, activated, epoch 26, degree 1, reputation 0.00, image hash mismatch',
      'Spore #2, dormant, epoch 26, degree 0, reputation 0.00, no image commit',
      'Spore #3, activated, epoch 26, degree 1, reputation 0.00, listed 0.80 NEAR, older image commit',
    ]);
    expect(cards()[0].getAttribute('href')).toBe('/spore/0');
    expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);
    expect(screen.getByText('0.80 NEAR')).toBeTruthy();
    expect(screen.getByText('partners #1 #3')).toBeTruthy();
    // every render is done, so the progress line is gone
    expect(screen.queryByText(/Rendering \d+ \/ \d+/)).toBeNull();
    expect(screen.getByRole('button', { name: /Activated 3/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Dormant 1/ })).toBeTruthy();
  });

  it('says what it is reading before the data arrives, with no sample cards', async () => {
    let release!: (t: SporeToken[]) => void;
    await renderPage('/market', liveRouter({ tokens: () => new Promise((r) => (release = r)) }).router);
    expect(screen.getByText(/Reading the collection from/)).toBeTruthy();
    expect(cards()).toHaveLength(0);
    await act(async () => release([token(0, {})]));
    await settle();
    expect(cards()).toHaveLength(1);
  });

  it('shows the RPC error with the endpoint and retries', async () => {
    let fail = true;
    const { router } = liveRouter({
      tokens: async () => {
        if (fail) throw new RpcError('https://test.rpc.fastnear.com', 'http 429', 'retryable');
        return [token(0, {})];
      },
    });
    await renderPage('/market', router);
    expect(screen.getByText(/Could not load the collection/)).toBeTruthy();
    expect(screen.getByText('https://test.rpc.fastnear.com')).toBeTruthy();
    fail = false;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    await settle();
    expect(cards()).toHaveLength(1);
  });

  it('says which filters matched nothing, and clears them', async () => {
    await renderPage('/market?f=dormant&pal=ember', liveRouter({ tokens: async () => [token(0, {}), token(1, {})] }).router);
    expect(screen.getByText('No spores match Dormant + ember.')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clear filters' })));
    expect(cards()).toHaveLength(2);
  });

  it('has no fake listings when nothing is for sale', async () => {
    await renderPage('/market?view=listed', liveRouter({ tokens: async () => [token(0, {})] }).router);
    expect(screen.getByText('Nothing is listed right now')).toBeTruthy();
    expect(screen.getByRole('link', { name: /For sale/ }).textContent).toContain('(0)');
  });

  it('reads again after a close, and keeps the old data, marked, when that fails', async () => {
    let epoch = 26;
    let fail = false;
    const { router, calls } = liveRouter({
      epoch: () => epoch,
      tokens: async () => {
        if (fail) throw new Error('http 503');
        return [token(0, { reputation: epoch })];
      },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderPage('/market', router);
      expect(calls.tokens).toBe(1);
      epoch = 27;
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_500)));
      await settle();
      expect(calls.tokens).toBe(2);
      expect(cards()[0].getAttribute('aria-label')).toContain('epoch 27');
      fail = true;
      epoch = 28;
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_500)));
      await settle();
      expect(calls.tokens).toBe(3);
      // the epoch-27 cards stay, marked stale, next to the error
      expect(cards()[0].getAttribute('aria-label')).toContain('epoch 27');
      expect(cards()[0].dataset.stale).toBe('true');
      expect(screen.getByText(/as of/)).toBeTruthy();
      expect(screen.getByText(/Could not load the collection after epoch 27/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is one tab stop with arrow keys inside (roving focus)', async () => {
    await renderPage('/market', liveRouter().router);
    expect(cards().map((a) => a.tabIndex)).toEqual([0, -1, -1, -1]);
    cards()[0].focus();
    fireEvent.keyDown(cards()[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cards()[1]);
    expect(cards().map((a) => a.tabIndex)).toEqual([-1, 0, -1, -1]);
    fireEvent.keyDown(cards()[1], { key: 'End' });
    expect(document.activeElement).toBe(cards()[3]);
    fireEvent.keyDown(cards()[3], { key: 'Home' });
    expect(document.activeElement).toBe(cards()[0]);
  });

  it('says the simulation has no spores instead of showing any', async () => {
    await renderPage('/market?source=sim', liveRouter().router);
    expect(screen.getByText(/the simulation has no spores/)).toBeTruthy();
    expect(cards()).toHaveLength(0);
  });
});
