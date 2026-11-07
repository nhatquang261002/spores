// Testnet client for the agents and the keeper. near-api-js 7.4.0 builds and
// signs transactions; the nonce is tracked here, and everything on the wire is
// plain JSON-RPC so failures are handled the same way as scripts/near-lib.sh:
// every call gets a hash computed locally, `send_tx` times out after 60 s, and
// the status is then polled by hash (an RPC once hung for 48 min on a
// transaction that had already executed).
import { createHash } from 'node:crypto';
import { KeyPair, KeyPairSigner, PublicKey, actions, baseDecode, baseEncode, createTransaction, encodeTransaction, teraToGas, type Action, type KeyPairString } from 'near-api-js';

/**
 * Public testnet RPC endpoints (docs.near.org/api/rpc/providers), tried in
 * rotation: each one rate-limits, FastNEAR after a burst of about 17
 * requests, so a rate-limited request moves on to the next endpoint.
 */
export const RPCS = (process.env.NEAR_RPCS ?? process.env.NEAR_RPC ?? 'https://test.rpc.fastnear.com,https://near-testnet.drpc.org').split(',');
let next = Math.floor(Math.random() * RPCS.length);
export const EXPLORER = 'https://testnet.nearblocks.io/txns';
/** Router calls burn about 3 Tgas (docs/results.md); 10 keeps the allowance hold small. */
export const CALL_GAS_TGAS = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * HTTP requests this process sent, by RPC method (`query` split by view
 * method or request type), and how many came back rate-limited. The agents
 * and the keeper log the per-epoch difference as `kind: "rpc"`.
 */
export const rpcStats = { requests: 0, limited: 0, byMethod: {} as Record<string, number> };

let lastStats = { requests: 0, limited: 0, byMethod: {} as Record<string, number> };
/** Requests since the previous call (the first call counts from process start). */
export function rpcSince(): { requests: number; limited: number; by_method: Record<string, number> } {
  const by: Record<string, number> = {};
  for (const [k, v] of Object.entries(rpcStats.byMethod)) if (v - (lastStats.byMethod[k] ?? 0) > 0) by[k] = v - (lastStats.byMethod[k] ?? 0);
  const out = { requests: rpcStats.requests - lastStats.requests, limited: rpcStats.limited - lastStats.limited, by_method: by };
  lastStats = { requests: rpcStats.requests, limited: rpcStats.limited, byMethod: { ...rpcStats.byMethod } };
  return out;
}

/** At most RPC_CONCURRENCY requests in flight (unset: no limit), so one process running many spores sends no bursts. */
const MAX_IN_FLIGHT = Number(process.env.RPC_CONCURRENCY ?? 0);
let inFlight = 0;
const waiting: (() => void)[] = [];
async function slot(): Promise<() => void> {
  if (MAX_IN_FLIGHT > 0) {
    while (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
  }
  inFlight++;
  return () => {
    inFlight--;
    waiting.shift()?.();
  };
}

function label(method: string, params: any): string {
  if (method !== 'query') return method;
  return params?.request_type === 'call_function' ? `view:${params.method_name}` : `query:${params?.request_type}`;
}

export async function rpc(method: string, params: unknown, timeoutMs = 20_000): Promise<any> {
  const name = label(method, params);
  for (let attempt = 0; ; attempt++) {
    const release = await slot();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const url = RPCS[next++ % RPCS.length];
    rpcStats.requests++;
    rpcStats.byMethod[name] = (rpcStats.byMethod[name] ?? 0) + 1;
    let failed: unknown = null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      });
      if (res.status === 429) rpcStats.limited++;
      if (res.status === 429 || res.status >= 500) throw new Error(`rpc http ${res.status}`);
      const body = await res.json();
      if (body?.error?.code === -429 || /rate limit/i.test(body?.error?.message ?? '')) {
        rpcStats.limited++;
        throw new Error('rpc rate limited');
      }
      return body;
    } catch (e) {
      failed = e;
    } finally {
      clearTimeout(timer);
      release();
    }
    if (attempt >= 8) throw failed;
    await sleep(Math.min(250 * 2 ** attempt, 8_000) + Math.random() * 300);
  }
}

/**
 * Read-only call at final finality, or at `blockId` (height or hash) when
 * given; returns the parsed JSON result.
 */
export async function view(contract: string, method: string, args: object = {}, blockId?: number | string): Promise<any> {
  const r = await rpc('query', {
    request_type: 'call_function',
    ...(blockId === undefined ? { finality: 'final' } : { block_id: blockId }),
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  if (r.error || r.result?.error) throw new Error(`view ${method}: ${JSON.stringify(r.error ?? r.result.error)}`);
  return JSON.parse(Buffer.from(r.result.result).toString('utf8'));
}

/** Every job in flight, read page by page (`list_jobs` returns 100 at most per call here). */
export async function allJobs(contract: string): Promise<any[]> {
  const out: any[] = [];
  for (;;) {
    const page = await view(contract, 'list_jobs', { from_index: out.length, limit: 100 });
    out.push(...page);
    if (page.length < 100) return out;
  }
}

export interface TxResult {
  hash: string;
  ok: boolean;
  /** Contract panic message, action error or RPC rejection. */
  err: string;
  /** Parsed return value, if any. */
  ret: unknown;
  gasTgas: number;
  /** NEP-297 events logged by the transaction's receipts. */
  events: { event: string; data: any[] }[];
  /** Bytes of every log line, per receipt that logged (NEAR caps each receipt at 16 KiB). */
  logBytes: number[];
}

export function parseOutcome(hash: string, res: any): TxResult {
  const r = res?.result;
  if (!r?.status) {
    const err = res?.error ? JSON.stringify(res.error.data ?? res.error) : 'no result';
    return { hash: `${hash}(not included)`, ok: false, err, ret: null, gasTgas: 0, events: [], logBytes: [] };
  }
  const outcomes = [r.transaction_outcome, ...(r.receipts_outcome ?? [])];
  const gas = outcomes.reduce((s: number, o: any) => s + (o?.outcome?.gas_burnt ?? 0), 0);
  const events = [];
  const logBytes: number[] = [];
  for (const o of r.receipts_outcome ?? []) {
    const logs: string[] = o.outcome.logs ?? [];
    if (logs.length) logBytes.push(logs.reduce((t, l) => t + Buffer.byteLength(l), 0));
    for (const log of logs) {
      if (log.startsWith('EVENT_JSON:')) {
        try {
          events.push(JSON.parse(log.slice('EVENT_JSON:'.length)));
        } catch {}
      }
    }
  }
  // A receipt can fail (e.g. a contract panic) even if the transaction status is the
  // top-level Failure; look for the first ExecutionError anywhere.
  const failure = JSON.stringify(r.status.Failure ?? '');
  const m = failure.match(/"ExecutionError":"((?:[^"\\]|\\.)*)"/);
  const ok = r.status.SuccessValue !== undefined;
  let ret: unknown = null;
  if (ok && r.status.SuccessValue) {
    const text = Buffer.from(r.status.SuccessValue, 'base64').toString('utf8');
    try {
      ret = JSON.parse(text);
    } catch {
      ret = text;
    }
  }
  return {
    hash: r.transaction.hash,
    ok,
    err: ok ? '' : m ? JSON.parse(`"${m[1]}"`) : failure,
    ret,
    gasTgas: Math.round(gas / 1e10) / 100,
    events,
    logBytes,
  };
}

/**
 * Signs as `accountId` with one key and calls `contract`. The nonce is read
 * once from chain and then kept locally (one process per key), and a recent
 * final block hash is cached for a minute, so a call costs no extra RPC
 * requests before `send_tx` (the public RPC rate-limits).
 */
let sharedBlock: Promise<{ hash: Uint8Array; at: number }> | null = null;
let sharedBlockAt = 0;

export class Caller {
  readonly accountId: string;
  readonly contract: string;
  private signer: KeyPairSigner;
  private publicKey: PublicKey;
  private nonce: bigint | null = null;
  private block: { hash: Uint8Array; at: number } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * How long `send_tx` waits. Agents use EXECUTED_OPTIMISTIC (about 1-2 s:
   * their next step only needs the call to have executed); the keeper and
   * setup use FINAL so the views they read next see the result.
   */
  readonly waitUntil: 'FINAL' | 'EXECUTED_OPTIMISTIC';

  constructor(accountId: string, privateKey: string, contract: string, waitUntil: 'FINAL' | 'EXECUTED_OPTIMISTIC' = 'FINAL') {
    this.accountId = accountId;
    this.contract = contract;
    this.waitUntil = waitUntil;
    const kp = KeyPair.fromString(privateKey as KeyPairString);
    this.signer = new KeyPairSigner(kp);
    this.publicKey = kp.getPublicKey();
  }

  private async nextNonce(): Promise<bigint> {
    if (this.nonce === null) {
      const r = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: this.accountId, public_key: this.publicKey.toString() });
      if (!r.result) throw new Error(`access key: ${JSON.stringify(r.error ?? r)}`);
      this.nonce = BigInt(r.result.nonce);
    }
    this.nonce += 1n;
    return this.nonce;
  }

  /** A recent final block hash, shared by every Caller in the process (one agent process may sign for 64 spores). */
  private async blockHash(): Promise<Uint8Array> {
    if (!this.block || Date.now() - this.block.at > 60_000) {
      if (!sharedBlock || Date.now() - sharedBlockAt > 60_000) {
        sharedBlock = (async () => {
          const r = await rpc('block', { finality: 'final' });
          return { hash: baseDecode(r.result.header.hash), at: Date.now() };
        })();
        const mine = sharedBlock;
        mine.catch(() => {
          if (sharedBlock === mine) sharedBlock = null;
        });
        sharedBlockAt = Date.now();
      }
      this.block = await sharedBlock;
    }
    return this.block.hash;
  }

  /** `waitUntil` overrides the Caller's own for this call: the keeper closes with FINAL and does everything else faster. */
  async call(method: string, args: object, deposit = 0n, gasTgas = CALL_GAS_TGAS, waitUntil = this.waitUntil): Promise<TxResult> {
    return this.send(this.contract, [actions.functionCall(method, args, teraToGas(String(gasTgas)), deposit)], waitUntil);
  }

  /** Signs and sends any actions to any receiver (setup uses this with full-access keys). */
  /** Signs and sends any actions to any receiver. Calls on one Caller run one at a time. */
  send(receiverId: string, acts: Action[], waitUntil = this.waitUntil): Promise<TxResult> {
    const run = this.queue.then(() => this.sendNow(receiverId, acts, waitUntil));
    this.queue = run.catch(() => {});
    return run;
  }

  private async sendNow(receiverId: string, acts: Action[], waitUntil: Caller['waitUntil']): Promise<TxResult> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.once(receiverId, acts, waitUntil);
      // Never executed (nonce clash, expired block hash, signing hiccup): drop
      // the cached nonce and block, back off and try again.
      if (!r.ok && attempt < 3 && r.hash.endsWith(')') && /InvalidNonce|Expired|nonce|signing failed|rate limit/i.test(r.err)) {
        this.nonce = null;
        this.block = null;
        sharedBlock = null;
        await sleep(1_000 * (attempt + 1));
        continue;
      }
      return r;
    }
  }

  private async once(receiverId: string, acts: Action[], waitUntil: Caller['waitUntil']): Promise<TxResult> {
    let signed;
    try {
      const [nonce, hash] = [await this.nextNonce(), await this.blockHash()];
      const tx = createTransaction(this.accountId, this.publicKey, receiverId, nonce, acts, hash);
      signed = (await this.signer.signTransaction(tx)).signedTransaction;
    } catch (e) {
      return { hash: '(not signed)', ok: false, err: `signing failed: ${(e as Error).message}`, ret: null, gasTgas: 0, events: [], logBytes: [] };
    }
    const hash = baseEncode(createHash('sha256').update(signed.transaction.encode()).digest());
    const b64 = Buffer.from(encodeTransaction(signed)).toString('base64');
    let res: any = null;
    try {
      res = await rpc('send_tx', { signed_tx_base64: b64, wait_until: waitUntil }, 60_000);
    } catch {}
    for (let i = 0; i < 6; i++) {
      if (res?.result?.status || res?.error?.cause?.name === 'INVALID_TRANSACTION') break;
      await sleep(5_000);
      try {
        res = await rpc('tx', { tx_hash: hash, sender_account_id: this.accountId, wait_until: waitUntil }, 30_000);
      } catch {}
    }
    return parseOutcome(hash, res);
  }
}

/**
 * A finished transaction with its receipts (`EXPERIMENTAL_tx_status`): the
 * receipts carry each action (e.g. a Transfer's deposit) and the outcomes
 * carry each receipt's status and block.
 */
export async function txStatus(hash: string, sender: string): Promise<any> {
  const r = await rpc('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: sender, wait_until: 'FINAL' }, 30_000);
  if (r.error) throw new Error(`tx status ${hash}: ${JSON.stringify(r.error)}`);
  return r.result;
}

/** Account balance in yocto, or null if the account does not exist. */
export async function balanceOf(accountId: string): Promise<bigint | null> {
  const r = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
  return r.result ? BigInt(r.result.amount) : null;
}

/** Current chain time in ns, from the latest final block. */
export async function chainTimeNs(): Promise<bigint> {
  const r = await rpc('block', { finality: 'final' });
  return BigInt(r.result.header.timestamp_nanosec);
}
