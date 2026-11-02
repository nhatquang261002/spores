// The outside service (SPEC §6.4 option 2; we run it, the README says so).
// Sells a deterministic price feed to active spores' operators.
//   GET  /offer?spore_id=N   -> { nonce, price, payee, router }
//   POST /redeem { spore_id, signer_id, tx_hash } -> { data } or 402 { error }
// Env: ROUTER (router account), OUTSIDE_ACCOUNT_ID (payee), PORT (default
// 8787), OUTSIDE_PRICE (yocto, default 0.01 NEAR), OUTSIDE_LOG (jsonl path),
// NEAR_RPC. Needs no key: it only reads the chain.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { checkReceipt, type Offer } from './receipt.ts';

const RPCS = (process.env.NEAR_RPCS ?? process.env.NEAR_RPC ?? 'https://test.rpc.fastnear.com,https://near-testnet.drpc.org').split(',');
const ROUTER = process.env.ROUTER ?? '';
const PAYEE = process.env.OUTSIDE_ACCOUNT_ID ?? '';
const PORT = Number(process.env.PORT ?? 8787);
const PRICE = BigInt(process.env.OUTSIDE_PRICE ?? '10000000000000000000000');
const LOG = process.env.OUTSIDE_LOG;
if (!ROUTER || !PAYEE) throw new Error('set ROUTER and OUTSIDE_ACCOUNT_ID');

const offers = new Map<string, Offer>();
let sold = 0;

function log(entry: object) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  console.log(line);
  if (LOG) appendFileSync(LOG, line + '\n');
}

/** JSON-RPC with rotation across endpoints and retry on rate limits and errors. */
async function rpc(method: string, params: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(RPCS[attempt % RPCS.length], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.json();
      if (res.status === 429 || body?.error?.code === -429) throw new Error('rate limited');
      if (body?.error && attempt < 3) throw new Error(JSON.stringify(body.error));
      return body;
    } catch (e) {
      if (attempt >= 6) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** Math.min(attempt, 4)));
    }
  }
}

async function isOperator(sporeId: number, accountId: string): Promise<boolean> {
  const r = await rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: ROUTER,
    method_name: 'is_operator',
    args_base64: Buffer.from(JSON.stringify({ spore_id: sporeId, account_id: accountId })).toString('base64'),
  });
  return r.result ? JSON.parse(Buffer.from(r.result.result).toString()) === true : false;
}

/** The product: a deterministic feed of 8 prices for the redeemed nonce. */
function feed(nonce: string): number[] {
  const h = createHash('sha256').update(`feed:${nonce}`).digest();
  return Array.from({ length: 8 }, (_, i) => 100 + h.readUInt16BE(i * 2) % 900);
}

async function body(req: any): Promise<any> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 4096) throw new Error('body too large');
  }
  return JSON.parse(text);
}

const server = createServer(async (req, res) => {
  const send = (code: number, obj: object) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/offer') {
      const sporeId = Number(url.searchParams.get('spore_id'));
      if (!Number.isInteger(sporeId) || sporeId < 0) return send(400, { error: 'spore_id' });
      const nonce = randomBytes(12).toString('hex');
      offers.set(nonce, { nonce, sporeId, price: PRICE, open: true });
      log({ kind: 'offer', spore_id: sporeId, nonce, price: PRICE.toString() });
      return send(200, { nonce, price: PRICE.toString(), payee: PAYEE, router: ROUTER });
    }
    if (req.method === 'POST' && url.pathname === '/redeem') {
      const b = await body(req);
      const sporeId = Number(b.spore_id);
      const signerId = String(b.signer_id ?? '');
      const txHash = String(b.tx_hash ?? '');
      const tx = await rpc('tx', { tx_hash: txHash, sender_account_id: signerId, wait_until: 'FINAL' });
      const nonce = tx?.result?.receipts_outcome
        ?.flatMap((o: any) => o.outcome.logs ?? [])
        .filter((l: string) => l.startsWith('EVENT_JSON:'))
        .map((l: string) => JSON.parse(l.slice(11)))
        .find((ev: any) => ev.event === 'service_paid')?.data?.[0]?.memo;
      const offer = nonce ? offers.get(nonce) : undefined;
      const why = checkReceipt(tx, {
        router: ROUTER,
        payee: PAYEE,
        signerId,
        sporeId,
        offer,
        isOperator: await isOperator(sporeId, signerId),
      });
      if (why) {
        log({ kind: 'refused', spore_id: sporeId, signer_id: signerId, tx_hash: txHash, reason: why });
        return send(402, { error: why });
      }
      offer!.open = false;
      sold++;
      log({ kind: 'sold', spore_id: sporeId, signer_id: signerId, tx_hash: txHash, nonce, price: offer!.price.toString(), sold });
      return send(200, { data: feed(nonce!), nonce });
    }
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, sold, router: ROUTER, payee: PAYEE });
    send(404, { error: 'not found' });
  } catch (e) {
    send(400, { error: (e as Error).message });
  }
});

server.listen(PORT, () => log({ kind: 'listening', port: PORT, router: ROUTER, payee: PAYEE, price: PRICE.toString() }));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
