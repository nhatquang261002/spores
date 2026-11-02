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
/** Router calls burn about 3 Tgas (docs/phase3-results.md); 10 keeps the allowance hold small. */
export const CALL_GAS_TGAS = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function rpc(method: string, params: unknown, timeoutMs = 20_000): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const url = RPCS[next++ % RPCS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`rpc http ${res.status}`);
      const body = await res.json();
      if (body?.error?.code === -429 || /rate limit/i.test(body?.error?.message ?? '')) throw new Error('rpc rate limited');
      return body;
    } catch (e) {
      if (attempt >= 8) throw e;
      await sleep(Math.min(250 * 2 ** attempt, 8_000) + Math.random() * 300);
    } finally {
      clearTimeout(timer);
    }
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
}

export function parseOutcome(hash: string, res: any): TxResult {
  const r = res?.result;
  if (!r?.status) {
    const err = res?.error ? JSON.stringify(res.error.data ?? res.error) : 'no result';
    return { hash: `${hash}(not included)`, ok: false, err, ret: null, gasTgas: 0, events: [] };
  }
  const outcomes = [r.transaction_outcome, ...(r.receipts_outcome ?? [])];
  const gas = outcomes.reduce((s: number, o: any) => s + (o?.outcome?.gas_burnt ?? 0), 0);
  const events = [];
  for (const o of r.receipts_outcome ?? []) {
    for (const log of o.outcome.logs ?? []) {
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
  };
}

/**
 * Signs as `accountId` with one key and calls `contract`. The nonce is read
 * once from chain and then kept locally (one process per key), and a recent
 * final block hash is cached for a minute, so a call costs no extra RPC
 * requests before `send_tx` (the public RPC rate-limits).
 */
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

  private async blockHash(): Promise<Uint8Array> {
    if (!this.block || Date.now() - this.block.at > 60_000) {
      const r = await rpc('block', { finality: 'final' });
      this.block = { hash: baseDecode(r.result.header.hash), at: Date.now() };
    }
    return this.block.hash;
  }

  async call(method: string, args: object, deposit = 0n, gasTgas = CALL_GAS_TGAS): Promise<TxResult> {
    return this.send(this.contract, [actions.functionCall(method, args, teraToGas(String(gasTgas)), deposit)]);
  }

  /** Signs and sends any actions to any receiver (setup uses this with full-access keys). */
  /** Signs and sends any actions to any receiver. Calls on one Caller run one at a time. */
  send(receiverId: string, acts: Action[]): Promise<TxResult> {
    const run = this.queue.then(() => this.sendNow(receiverId, acts));
    this.queue = run.catch(() => {});
    return run;
  }

  private async sendNow(receiverId: string, acts: Action[]): Promise<TxResult> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.once(receiverId, acts);
      // Never executed (nonce clash, expired block hash, signing hiccup): drop
      // the cached nonce and block, back off and try again.
      if (!r.ok && attempt < 3 && r.hash.endsWith(')') && /InvalidNonce|Expired|nonce|signing failed|rate limit/i.test(r.err)) {
        this.nonce = null;
        this.block = null;
        await sleep(1_000 * (attempt + 1));
        continue;
      }
      return r;
    }
  }

  private async once(receiverId: string, acts: Action[]): Promise<TxResult> {
    let signed;
    try {
      const [nonce, hash] = [await this.nextNonce(), await this.blockHash()];
      const tx = createTransaction(this.accountId, this.publicKey, receiverId, nonce, acts, hash);
      signed = (await this.signer.signTransaction(tx)).signedTransaction;
    } catch (e) {
      return { hash: '(not signed)', ok: false, err: `signing failed: ${(e as Error).message}`, ret: null, gasTgas: 0, events: [] };
    }
    const hash = baseEncode(createHash('sha256').update(signed.transaction.encode()).digest());
    const b64 = Buffer.from(encodeTransaction(signed)).toString('base64');
    let res: any = null;
    try {
      res = await rpc('send_tx', { signed_tx_base64: b64, wait_until: this.waitUntil }, 60_000);
    } catch {}
    for (let i = 0; i < 6; i++) {
      if (res?.result?.status || res?.error?.cause?.name === 'INVALID_TRANSACTION') break;
      await sleep(5_000);
      try {
        res = await rpc('tx', { tx_hash: hash, sender_account_id: this.accountId, wait_until: this.waitUntil }, 30_000);
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
