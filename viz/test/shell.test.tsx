import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { EpochInfo, Router } from '../src/chain/router';
import { RpcError } from '../src/chain/rpc';
import { nextPollMs, staleSince } from '../src/state/epoch';
import { formatCountdown, formatNear, shortAccount, shortHash } from '../src/ui/format';
import { Unavailable } from '../src/ui/states';
import { clockPhase, EpochClock, SourceBadge } from '../src/ui/status';
import { Tooltip, TOOLTIP_DELAY_MS } from '../src/ui/Tooltip';
import { color, hex, paletteOf, palettes } from '../src/ui/tokens';
import { VeinPulse } from '../src/ui/VeinPulse';
import { useCloseSwell } from '../src/ui/motion';
import { useRef } from 'react';

afterEach(cleanup);

const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const info = (epoch: number, startMs: number, endMs: number): EpochInfo => ({
  epoch,
  started_ns: ns(startMs),
  ends_ns: ns(endMs),
  prev_fingerprint: '0'.repeat(64),
  active: [],
  pool: '0',
  flows: [],
  rejects: [],
});

function fakeRouter(epochInfo: () => Promise<EpochInfo>): Router {
  return { epochInfo } as unknown as Router;
}

async function renderApp(url: string, router: Router) {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[url]}>
        <App router={router} />
      </MemoryRouter>,
    );
  });
}

describe('shell', () => {
  it('shows the live epoch and the LIVE badge', async () => {
    const now = Date.now();
    await renderApp('/network', fakeRouter(async () => info(26, now - 10_000, now + 20_000)));
    expect(screen.getByText('E 26')).toBeTruthy();
    expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/testnet · router4/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Network' })[0].getAttribute('href')).toBe('/network');
  });

  it('says closing… once the epoch has ended and nobody closed it', async () => {
    const now = Date.now();
    await renderApp('/network', fakeRouter(async () => info(26, now - 60_000, now - 30_000)));
    expect(screen.getByText('closing…')).toBeTruthy();
  });

  it('says the epoch ended once nothing is on its way, rather than promising a close', async () => {
    const now = Date.now();
    await renderApp('/network', fakeRouter(async () => info(26, now - 3_600_000, now - 3_000_000)));
    expect(screen.getByText('ended')).toBeTruthy();
    expect(screen.queryByText('closing…')).toBeNull();
  });

  it('the landing page has left the app: its own bar, no app nav, and the app has no Overview', async () => {
    const now = Date.now();
    await renderApp('/', fakeRouter(async () => info(26, now - 10_000, now + 20_000)));
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Primary (mobile)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect wallet' })).toBeNull();
    expect(screen.getByRole('navigation', { name: 'On this page' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'How it works' }).getAttribute('href')).toBe('#how');
    expect(screen.queryByRole('link', { name: 'About' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Spores, home' }).querySelector('img')?.getAttribute('src')).toBe('/favicon.svg');
    expect(screen.getByRole('link', { name: 'Open the app' }).getAttribute('href')).toBe('/network');
    cleanup();
    await renderApp('/network', fakeRouter(async () => info(26, now - 10_000, now + 20_000)));
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).queryByRole('link', { name: 'Overview' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Spores, home' }).getAttribute('href')).toBe('/');
  });

  it('keeps the source on the way into the app', async () => {
    await renderApp('/?source=recorded&run=demo1&date=2026-11-10', fakeRouter(async () => info(1, 0, 1)));
    expect(screen.getByRole('note').textContent).toContain('Recorded playback');
    expect(screen.getByRole('link', { name: 'Open the app' }).getAttribute('href')).toBe('/network?source=recorded&run=demo1&date=2026-11-10');
  });

  it('shows an inline error naming the endpoint when epoch_info fails', async () => {
    await renderApp('/', fakeRouter(async () => Promise.reject(new RpcError('https://test.rpc.fastnear.com', 'http 503', 'retryable'))));
    // Each region the failure reaches says so itself (Design §6.0); the words on the page stay.
    expect((await screen.findAllByRole('alert')).some((a) => a.textContent?.includes('https://test.rpc.fastnear.com'))).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Sixty-four slime molds');
  });

  it('recorded source: banner, badge, no live epoch, links keep the source', async () => {
    let polled = 0;
    await renderApp('/network?source=recorded&run=demo1&date=2026-11-10', fakeRouter(async () => (polled++, info(1, 0, 1))));
    expect(screen.getByRole('note').textContent).toBe('Recorded playback from 2026-11-10. Nothing here is happening now.');
    expect(screen.getAllByText('RECORDED').length).toBeGreaterThan(0);
    expect(polled).toBe(0);
    expect(screen.getAllByRole('link', { name: 'Activity' })[0].getAttribute('href')).toBe('/activity?source=recorded&run=demo1&date=2026-11-10');
  });

  it('an unusable source is an error, not a fallback', async () => {
    await renderApp('/?source=run', fakeRouter(async () => info(1, 0, 1)));
    expect(screen.getByRole('alert').textContent).toContain('needs a run name');
  });

  it('the scenes of S12 and S13 have their pages', async () => {
    await renderApp('/lab/sale', fakeRouter(async () => info(1, 0, 1)));
    // Lazy chunks: the first import under a loaded test run can take a while (8 s wasn't always enough).
    expect(await screen.findByRole('heading', { name: 'What does a buyer actually get?' }, { timeout: 25_000 })).toBeTruthy();
    cleanup();
    await renderApp('/lab/wash', fakeRouter(async () => info(1, 0, 1)));
    expect(await screen.findByRole('heading', { name: /Can one owner pump reputation/ }, { timeout: 25_000 })).toBeTruthy();
    cleanup();
    await renderApp('/lab/loop', fakeRouter(async () => info(1, 0, 1)));
    expect(await screen.findByRole('heading', { name: 'What does a Spore actually do?' }, { timeout: 25_000 })).toBeTruthy();
  }, 80_000);

  it('a scene address that does not exist says so', async () => {
    await renderApp('/lab/nope', fakeRouter(async () => info(1, 0, 1)));
    expect(screen.getByText('There is no scene at this address')).toBeTruthy();
  });

  it('badges: run, simulation and stale', () => {
    render(<SourceBadge source={{ kind: 'run', run: 'phase5-exit2' }} />);
    expect(screen.getByText('LOCAL RUN')).toBeTruthy();
    cleanup();
    render(<SourceBadge source={{ kind: 'sim' }} />);
    expect(screen.getByText('SIMULATION')).toBeTruthy();
    cleanup();
    render(<SourceBadge source={{ kind: 'live', network: 'testnet', router: 'r' }} staleSince={new Date(2026, 10, 3, 14, 2, 11).getTime()} />);
    expect(screen.getByRole('status').textContent).toBe('!STALEsince 14:02:11');
  });
});

describe('tooltip and value marks (Design §4.2, §7, §9)', () => {
  it('opens after 400 ms on hover and on focus, at once on tap, and Escape closes it', () => {
    vi.useFakeTimers();
    try {
      render(<Tooltip content="computed by the router at read time">R 1.43</Tooltip>);
      const anchor = screen.getByText('R 1.43');
      fireEvent.mouseEnter(anchor);
      act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1));
      expect(screen.queryByRole('tooltip')).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByRole('tooltip').textContent).toBe('computed by the router at read time');
      expect(anchor.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).toBeNull();
      fireEvent.mouseLeave(anchor);
      fireEvent.focus(anchor);
      act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
      expect(screen.getByRole('tooltip')).toBeTruthy();
      fireEvent.blur(anchor);
      expect(screen.queryByRole('tooltip')).toBeNull();
      fireEvent.click(anchor);
      expect(screen.getByRole('tooltip')).toBeTruthy();
      expect(anchor.tabIndex).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows unknown values as an em dash with the reason', () => {
    render(<Unavailable reason="needs the close tx for epoch 4" />);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText('unavailable: needs the close tx for epoch 4')).toBeTruthy();
    fireEvent.click(screen.getByText('—'));
    expect(screen.getByRole('tooltip').textContent).toBe('needs the close tx for epoch 4');
  });

  it('keeps a stale epoch, in the stale style, with "as of"', () => {
    const now = Date.now();
    const since = new Date(2026, 10, 3, 14, 2, 11).getTime();
    const { container } = render(<EpochClock info={info(26, now - 10_000, now + 20_000)} staleSince={since} reducedMotion />);
    expect(screen.getByText('E 26')).toBeTruthy();
    expect(container.querySelector('.epoch-clock.is-stale .glyph-caution')?.textContent).toBe('!');
    fireEvent.click(screen.getByText('E 26'));
    expect(screen.getByRole('tooltip').textContent).toContain('Stale: as of 14:02:11.');
  });

});

describe('polling and clock', () => {
  it('polls every 10 s, or just after the epoch ends if sooner', () => {
    expect(nextPollMs(0, null)).toBe(10_000);
    expect(nextPollMs(0, info(1, 0, 4_000))).toBe(5_500);
    expect(nextPollMs(0, info(1, 0, 30_000))).toBe(10_000);
    expect(nextPollMs(50_000, info(1, 0, 30_000))).toBe(10_000);
  });
  it('is stale only after 30 s of failures', () => {
    expect(staleSince(1_000, false, 100_000)).toBeNull();
    expect(staleSince(1_000, true, 30_000)).toBeNull();
    expect(staleSince(1_000, true, 31_001)).toBe(1_000);
    expect(staleSince(null, true, 100_000)).toBeNull();
  });
  it('drains the arc linearly and then says closing', () => {
    expect(clockPhase(info(1, 0, 30_000), 15_000)).toEqual({ phase: 'counting', remainingMs: 15_000, fraction: 0.5 });
    expect(clockPhase(info(1, 0, 30_000), 30_000).phase).toBe('closing');
    expect(clockPhase(null, 0).phase).toBe('none');
    expect(formatCountdown(21_000)).toBe('0:21');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

describe('epoch pulse (Design §3.5)', () => {
  function Bar({ epoch, reduced = false }: { epoch: number | null; reduced?: boolean }) {
    const ref = useRef<HTMLElement>(null);
    return (
      <header ref={ref}>
        <span className="epoch-clock">E {epoch}</span>
        <VeinPulse epoch={epoch} reducedMotion={reduced} container={ref} />
      </header>
    );
  }
  it('pulses only when a poll shows the epoch went up', () => {
    const { rerender } = render(<Bar epoch={26} />);
    expect(screen.queryByTestId('vein-pulse')).toBeNull(); // first value seen: no guess
    rerender(<Bar epoch={26} />);
    expect(screen.queryByTestId('vein-pulse')).toBeNull();
    rerender(<Bar epoch={27} />);
    const first = screen.getByTestId('vein-pulse');
    rerender(<Bar epoch={null} />); // source switch / poll gap
    rerender(<Bar epoch={25} />); // a fall is not a close
    expect(screen.getByTestId('vein-pulse')).toBe(first);
    rerender(<Bar epoch={26} />);
    expect(screen.getByTestId('vein-pulse')).not.toBe(first); // a new close restarts it
  });
  it('never pulses under reduced motion', () => {
    const { rerender } = render(<Bar epoch={26} reduced />);
    rerender(<Bar epoch={27} reduced />);
    expect(screen.queryByTestId('vein-pulse')).toBeNull();
  });
});

describe('epoch-close swell (Design §3.5)', () => {
  function Name({ epoch, r }: { epoch: number; r: number }) {
    const s = useCloseSwell(epoch, r);
    return (
      <span data-testid="name" key={s.n} data-swell={s.dir ?? undefined}>
        Spore #7
      </span>
    );
  }
  const swell = () => screen.getByTestId('name').dataset.swell;
  it('swells only when a close moved R, and thins when R fell', () => {
    const { rerender } = render(<Name epoch={26} r={10} />);
    expect(swell()).toBeUndefined(); // first values seen: no guess
    rerender(<Name epoch={26} r={12} />);
    expect(swell()).toBeUndefined(); // R moved without a close
    rerender(<Name epoch={27} r={12} />);
    expect(swell()).toBeUndefined(); // a close that left R alone
    rerender(<Name epoch={28} r={15} />);
    const grew = screen.getByTestId('name');
    expect(grew.dataset.swell).toBe('grew');
    rerender(<Name epoch={29} r={11} />);
    expect(swell()).toBe('decayed');
    expect(screen.getByTestId('name')).not.toBe(grew); // each close restarts the animation
  });
});

describe('format (Design §8.1)', () => {
  it('formats NEAR from yocto with BigInt', () => {
    expect(formatNear('12000000000000000000000')).toBe('0.012 NEAR');
    expect(formatNear('2310000000000000000000000')).toBe('2.31 NEAR');
    expect(formatNear('0')).toBe('0.00 NEAR');
    expect(formatNear('1')).toBe('<0.0001 NEAR');
    expect(formatNear('123456789000000000000000000')).toBe('123.4567 NEAR');
  });
  it('shortens hashes and accounts', () => {
    expect(shortHash('3d38ff8998acec301bc9dae950ff7e7c1bacd605c259426002b8f597f92cc76a')).toBe('3d38ff…c76a');
    expect(shortHash('95UsZnqpAbCdEfGh')).toBe('95Us…EfGh');
    expect(shortAccount('buyer.spores-hack.testnet')).toBe('buyer.spores-hack.testnet');
    expect(shortAccount('operator-number-two.spores-hack.testnet')).toBe('operator-number-two…testnet');
  });
});

describe('tokens', () => {
  it('palettes are the renderer palettes, and the CSS matches tokens.ts', () => {
    const paint = readFileSync(path.join(process.cwd(), '../renderer/src/paint.rs'), 'utf8');
    const start = paint.indexOf('const PALETTES');
    const block = paint.slice(start, paint.indexOf('\n];', start));
    const nums = [...block.matchAll(/\[(\d+),\s*(\d+),\s*(\d+),?\s*\]/g)].map((m) => [+m[1], +m[2], +m[3]]);
    expect(nums).toEqual(palettes.flatMap((p) => p.stops.map((s) => [...s])));
    const css = readFileSync(path.join(process.cwd(), 'src/ui/tokens.css'), 'utf8');
    for (const p of palettes) {
      expect(css).toContain(`--pal-${p.name}-accent: ${hex(p.stops[3])};`);
      expect(css).toContain(`--pal-${p.name}-mid: ${hex(p.stops[2])};`);
    }
    for (const [k, v] of Object.entries(color)) {
      const name = k.replace(/[A-Z0-9]/g, (c) => '-' + c.toLowerCase());
      expect(css, k).toContain(`--${name}: ${v};`);
    }
  });
  it('text and control colours meet WCAG AA on every surface they sit on (§3.1)', () => {
    const lum = (h: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const surfaces = [color.bg, color.surface, color.surface2];
    for (const fg of [color.text, color.text2, color.text3, color.slime, color.growth, color.agent, color.value, color.warn]) {
      for (const bg of surfaces) expect(ratio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const bg of surfaces) expect(ratio(color.lineStrong, bg), `line-strong on ${bg}`).toBeGreaterThanOrEqual(3);
    // solid buttons put --bg text on the accent or a status colour
    for (const fill of [color.slime, color.growth, color.agent, color.value, color.warn]) expect(ratio(color.bg, fill)).toBeGreaterThanOrEqual(4.5);
  });
  it('picks the palette from seed[31] % 5', () => {
    expect(paletteOf('00'.repeat(31) + '07').name).toBe('violet');
    expect(paletteOf('ff'.repeat(32)).name).toBe('yolk');
    expect(() => paletteOf('abc')).toThrow();
  });
});
