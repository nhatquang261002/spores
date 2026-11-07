// Browser port of the read path in agents/src/near.ts: plain JSON-RPC over
// fetch, endpoints tried in rotation, backoff on rate limits and 5xx, and
// NEAR's archival node for transactions the others have garbage-collected.
// No Node APIs (fetch, atob, btoa, TextEncoder/TextDecoder only).

/** Public testnet endpoints (docs.near.org/api/rpc/providers); FastNEAR rate-limits after a burst of about 17 requests. */
export const DEFAULT_RPCS = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org'];
/**
 * Old transactions only; both rate-limit, so a limit on one moves to the other.
 * FastNEAR first: near.org's answers 429 with a deprecation warning once it
 * limits, and FastNEAR's isn't in NEAR's provider table as free, so neither is
 * relied on alone (docs/verify-notes.md "Phase 6 S10").
 */
export const ARCHIVAL_RPCS = ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'];
export const EXPLORER = 'https://testnet.nearblocks.io/txns';

/** An RPC failure with the endpoint that gave it, so error states can name it (Design §6.0). */
export class RpcError extends Error {
  readonly endpoint: string;
  /** `retryable` errors were retried until attempts ran out; `rpc` errors came back from the node and were not retried. */
  readonly kind: 'retryable' | 'rpc';
  /** NEAR error `cause.name` when the node gave one (e.g. UNKNOWN_TRANSACTION). */
  readonly causeName?: string;
  constructor(endpoint: string, message: string, kind: 'retryable' | 'rpc', causeName?: string) {
    super(message);
    this.name = 'RpcError';
    this.endpoint = endpoint;
    this.kind = kind;
    this.causeName = causeName;
  }
}

export interface RpcOptions {
  urls?: string[];
  /** One archival endpoint instead of `ARCHIVAL_RPCS`; an empty string disables the archival fallback. */
  archival?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Per request. */
  timeoutMs?: number;
  /** Tries per call across all endpoints (agents/src/near.ts makes 9). */
  attempts?: number;
  random?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait before retry number `attempt + 1`, as in agents/src/near.ts. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  return Math.min(250 * 2 ** attempt, 8_000) + random() * 300;
}

function isRateLimit(err: any): boolean {
  return err?.code === -429 || /rate limit|too many/i.test(err?.message ?? '') || /TOO_MANY/i.test(err?.cause?.name ?? '');
}

function errText(err: any): string {
  const cause = err?.cause?.name ? `${err.cause.name}: ` : '';
  const data = typeof err?.data === 'string' ? err.data : err?.cause?.info ? JSON.stringify(err.cause.info) : '';
  return `${cause}${err?.message ?? 'rpc error'}${data ? ` (${data})` : ''}`;
}

export function utf8ToBase64(s: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function bytesToUtf8(bytes: number[] | Uint8Array): string {
  return new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
}

export class Rpc {
  readonly urls: string[];
  readonly archivalUrls: string[];
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly random: () => number;
  private next: number;
  /** Requests sent and how many came back rate-limited. */
  readonly stats = { requests: 0, limited: 0 };

  constructor(o: RpcOptions = {}) {
    this.urls = o.urls?.length ? o.urls : DEFAULT_RPCS;
    this.archivalUrls = o.archival === undefined ? ARCHIVAL_RPCS : o.archival ? [o.archival] : [];
    this.fetchFn = o.fetch ?? ((...a) => fetch(...a));
    this.sleep = o.sleep ?? realSleep;
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.attempts = o.attempts ?? 9;
    this.random = o.random ?? Math.random;
    this.next = Math.floor(this.random() * this.urls.length);
  }

  /**
   * One JSON-RPC call; returns its `result`. Rate limits, 5xx, timeouts and
   * unreadable bodies move to the next endpoint after a backoff; an error the
   * node returns (unknown tx, bad args, contract panic) is thrown at once.
   */
  async call(method: string, params: unknown, urls: string[] = this.urls): Promise<any> {
    let last: RpcError | null = null;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const url = urls === this.urls ? urls[this.next++ % urls.length] : urls[attempt % urls.length];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      this.stats.requests++;
      try {
        const res = await this.fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'viz', method, params }),
          signal: ctrl.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          if (res.status === 429) this.stats.limited++;
          last = new RpcError(url, `http ${res.status}`, 'retryable');
        } else {
          let body: any;
          try {
            body = await res.json();
          } catch {
            body = undefined;
          }
          if (!body || typeof body !== 'object') {
            last = new RpcError(url, `unreadable response (http ${res.status})`, 'retryable');
          } else if (body.error) {
            if (!isRateLimit(body.error)) throw new RpcError(url, errText(body.error), 'rpc', body.error?.cause?.name);
            this.stats.limited++;
            last = new RpcError(url, 'rate limited', 'retryable');
          } else if (body.result === undefined) {
            last = new RpcError(url, `no result (http ${res.status})`, 'retryable');
          } else {
            return body.result;
          }
        }
      } catch (e) {
        if (e instanceof RpcError) throw e;
        const msg = ctrl.signal.aborted ? `timeout after ${this.timeoutMs} ms` : String((e as Error)?.message ?? e);
        last = new RpcError(url, msg, 'retryable');
      } finally {
        clearTimeout(timer);
      }
      if (attempt + 1 < this.attempts) await this.sleep(backoffMs(attempt, this.random));
    }
    throw last ?? new RpcError(urls[0] ?? '', 'no attempts', 'retryable');
  }

  /** Read-only contract call at final finality (or at `blockId`); returns the parsed JSON result. */
  async view<T = unknown>(contract: string, method: string, args: object = {}, blockId?: number | string): Promise<T> {
    const r = await this.call('query', {
      request_type: 'call_function',
      ...(blockId === undefined ? { finality: 'final' } : { block_id: blockId }),
      account_id: contract,
      method_name: method,
      args_base64: utf8ToBase64(JSON.stringify(args)),
    });
    if (r?.error) throw new RpcError(`view ${method}`, String(r.error), 'rpc');
    if (!Array.isArray(r?.result)) throw new RpcError(`view ${method}`, 'no result bytes', 'rpc');
    return JSON.parse(bytesToUtf8(r.result)) as T;
  }

  /**
   * Final outcome of a transaction. Tries the regular endpoints, then the
   * archival node, which keeps transactions the others have garbage-collected.
   */
  async tx(hash: string, sender: string): Promise<any> {
    const params = { tx_hash: hash, sender_account_id: sender, wait_until: 'FINAL' };
    try {
      return await this.call('tx', params);
    } catch (e) {
      if (!this.archivalUrls.length) throw e;
      return await this.call('tx', params, this.archivalUrls);
    }
  }
}
