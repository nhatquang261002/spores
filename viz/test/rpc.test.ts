import { describe, expect, it } from 'vitest';
import { Rpc, RpcError, backoffMs, bytesToUtf8, utf8ToBase64 } from '../src/chain/rpc';

type Reply = { status?: number; body?: unknown; throws?: string };

/** fetch mock: answers from `replies` in order and records which URL each call went to. */
function mockFetch(replies: Reply[]) {
  const calls: { url: string; body: any }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const r = replies.shift();
    if (!r) throw new Error('no more replies');
    if (r.throws) throw new Error(r.throws);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = (result: unknown): Reply => ({ body: { jsonrpc: '2.0', id: 'viz', result } });

function rpc(replies: Reply[], extra: Partial<ConstructorParameters<typeof Rpc>[0]> = {}) {
  const f = mockFetch(replies);
  const sleeps: number[] = [];
  const r = new Rpc({
    urls: ['https://a', 'https://b'],
    archival: 'https://archive',
    fetch: f.fn,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0,
    ...extra,
  });
  return { r, calls: f.calls, sleeps };
}

describe('rpc', () => {
  it('rotates endpoints across calls', async () => {
    const { r, calls } = rpc([ok(1), ok(2), ok(3)]);
    expect([await r.call('m', {}), await r.call('m', {}), await r.call('m', {})]).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.url)).toEqual(['https://a', 'https://b', 'https://a']);
  });

  it('moves on and backs off after http 429, 5xx, rate-limit bodies, garbage and network errors', async () => {
    const { r, calls, sleeps } = rpc([
      { status: 429, body: '' },
      { status: 503, body: '' },
      { body: { error: { code: -429, message: 'Rate limit exceeded' } } },
      { body: 'not json' },
      { throws: 'socket hang up' },
      ok('done'),
    ]);
    expect(await r.call('m', {})).toBe('done');
    expect(calls.map((c) => c.url)).toEqual(['https://a', 'https://b', 'https://a', 'https://b', 'https://a', 'https://b']);
    expect(sleeps).toEqual([250, 500, 1000, 2000, 4000]);
    expect(r.stats).toEqual({ requests: 6, limited: 2 });
  });

  it('caps the backoff at 8 s plus jitter', () => {
    expect(backoffMs(10, () => 0)).toBe(8000);
    expect(backoffMs(10, () => 1)).toBe(8300);
  });

  it('throws an error the node returns at once, naming the endpoint', async () => {
    const { r, calls } = rpc([{ body: { error: { code: -32000, message: 'Server error', cause: { name: 'UNKNOWN_TRANSACTION' } } } }, ok('never')]);
    const e = await r.call('tx', {}).catch((x) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect(e.kind).toBe('rpc');
    expect(e.endpoint).toBe('https://a');
    expect(e.causeName).toBe('UNKNOWN_TRANSACTION');
    expect(calls).toHaveLength(1);
  });

  it('gives up after `attempts` tries with the last retryable error', async () => {
    const { r, sleeps } = rpc([{ status: 429 }, { status: 429 }, { status: 502 }], { attempts: 3 });
    const e = await r.call('m', {}).catch((x) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect(e.kind).toBe('retryable');
    expect(e.message).toBe('http 502');
    expect(sleeps).toHaveLength(2);
  });

  it('view sends base64 JSON args at final finality and decodes the result bytes', async () => {
    const bytes = Array.from(new TextEncoder().encode(JSON.stringify({ epoch: 26, note: 'é' })));
    const { r, calls } = rpc([ok({ result: bytes, logs: [] })]);
    expect(await r.view('router.testnet', 'epoch_info', { spore_id: 5 })).toEqual({ epoch: 26, note: 'é' });
    const p = calls[0].body.params;
    expect(p).toMatchObject({ request_type: 'call_function', finality: 'final', account_id: 'router.testnet', method_name: 'epoch_info' });
    expect(JSON.parse(atob(p.args_base64))).toEqual({ spore_id: 5 });
  });

  it('view throws on a contract error in the result', async () => {
    const { r } = rpc([ok({ error: 'wasm execution failed', logs: [] })]);
    await expect(r.view('router.testnet', 'nope')).rejects.toThrow(/wasm execution failed/);
  });

  it('tx falls back to the archival node', async () => {
    const { r, calls } = rpc([{ body: { error: { message: 'Server error', cause: { name: 'UNKNOWN_TRANSACTION' } } } }, ok({ status: {} })]);
    expect(await r.tx('Hash', 'keeper.testnet')).toEqual({ status: {} });
    expect(calls.map((c) => c.url)).toEqual(['https://a', 'https://archive']);
    expect(calls[1].body.params).toEqual({ tx_hash: 'Hash', sender_account_id: 'keeper.testnet', wait_until: 'FINAL' });
  });

  it('utf8 helpers round-trip', () => {
    const s = '{"a":"spore ✓"}';
    const b64 = utf8ToBase64(s);
    expect(bytesToUtf8(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).toBe(s);
  });
});
