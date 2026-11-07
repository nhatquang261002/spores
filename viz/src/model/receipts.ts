// `TransactionReceipt`'s data (Design §6.G): one shape for every kind, with its
// evidence level (§4.3). A `confirmed` receipt comes only from a final tx
// outcome the app read itself; anything from a run log stays `logged`.
import type { EpochClosed } from '../chain/events';
import { outcomeOf } from './tx';

export type ReceiptKind = 'settlement' | 'refund' | 'service' | 'sale' | 'market' | 'refusal' | 'failed' | 'close' | 'image' | 'other';

export interface Receipt {
  evidence: 'confirmed' | 'logged';
  kind: ReceiptKind;
  /** Router event name, or the method when no event is known. */
  event: string;
  tx: string;
  /** The router's epoch for this tx, when the event carries one. */
  epoch: number | null;
  from: number | null;
  to: number | null;
  spore?: number;
  amount?: string;
  fee?: string;
  auto?: boolean;
  reason?: string;
  payee?: string;
  memo?: string;
  seller?: string;
  buyer?: string;
  sellerAmount?: string;
  royalty?: string;
  royaltyAccount?: string | null;
  fingerprint?: string;
  flows?: number;
  flowsDerived?: boolean;
  rejects?: number;
  tubes?: number | null;
  pool?: string;
  treasury?: string;
  stateHash?: string;
  imageHash?: string;
  rendererVersion?: number;
  /** A contract error verbatim, without NEAR's prefix; for `refusal` and `failed`. */
  error?: string;
  /** The router logged that part of the call failed afterwards (a bounced transfer). */
  warnings?: string[];
  signer?: string;
  block?: { hash: string; height: number | null };
}

/** Which event names what a tx did; `job_refunded` comes last because a sale also refunds in-flight jobs. */
const PRIMARY = ['spore_sold', 'epoch_closed', 'job_settled', 'service_paid', 'image_committed', 'spore_listed', 'spore_delisted', 'job_refunded'];
const FAILED_AFTER = ['sale_payment_failed', 'service_payment_failed', 'withdraw_failed'];

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export function closeReceipt(ev: EpochClosed, tx: string, extra: Partial<Receipt> = {}): Receipt {
  return {
    evidence: 'confirmed',
    kind: 'close',
    event: 'epoch_closed',
    tx,
    epoch: ev.epoch,
    from: null,
    to: null,
    fingerprint: ev.fingerprint,
    flows: ev.flows.length,
    rejects: ev.rejects.reduce((n, r) => n + r[2], 0),
    tubes: ev.edges,
    pool: ev.pool,
    treasury: ev.treasury,
    ...extra,
  };
}

/** A `tx` RPC result (final) → receipt. Refused calls moved nothing and log no event. */
export function receiptFromTx(tx: any, blockHeight: number | null = null): Receipt {
  const out = outcomeOf(tx);
  const hash = out.hash;
  const base = {
    evidence: 'confirmed' as const,
    tx: hash,
    epoch: null,
    from: null,
    to: null,
    signer: tx?.transaction?.signer_id as string | undefined,
    block: tx?.transaction_outcome?.block_hash ? { hash: tx.transaction_outcome.block_hash as string, height: blockHeight } : undefined,
  };
  const method: string = tx?.transaction?.actions?.[0]?.FunctionCall?.method_name ?? 'tx';
  if (!out.ok) {
    const refused = /Smart contract panicked/.test(JSON.stringify(tx?.status?.Failure ?? ''));
    return { ...base, kind: refused ? 'refusal' : 'failed', event: method, error: out.error };
  }
  const own = out.events.filter((e) => e.standard === 'spores');
  const warnings = own.filter((e) => FAILED_AFTER.includes(e.event)).map((e) => `${e.event}: ${JSON.stringify(e.data[0] ?? {})}`);
  const primary = PRIMARY.map((name) => own.find((e) => e.event === name)).find(Boolean);
  if (!primary) return { ...base, kind: 'other', event: method, warnings };
  const d = primary.data[0] ?? {};
  const shared = { ...base, event: primary.event, warnings };
  switch (primary.event) {
    case 'job_settled':
      return { ...shared, kind: 'settlement', epoch: num(d.epoch), from: d.consumer, to: d.provider, amount: d.price, fee: d.fee, auto: !!d.auto };
    case 'job_refunded':
      return { ...shared, kind: 'refund', from: d.consumer, to: d.provider ?? null, amount: d.amount, reason: d.reason };
    case 'service_paid':
      return { ...shared, kind: 'service', epoch: num(d.epoch), from: d.spore_id, payee: d.payee, amount: d.amount, memo: d.memo };
    case 'spore_sold':
      return { ...shared, kind: 'sale', spore: d.spore_id, seller: d.seller, buyer: d.buyer, amount: d.price, sellerAmount: d.seller_amount, royalty: d.royalty, royaltyAccount: d.royalty_account };
    case 'spore_listed':
    case 'spore_delisted':
      return { ...shared, kind: 'market', spore: d.spore_id, seller: d.owner_id, amount: d.price };
    case 'epoch_closed':
      return { ...closeReceipt(d as EpochClosed, hash), signer: base.signer, block: base.block, warnings };
    case 'image_committed':
      return { ...shared, kind: 'image', epoch: num(d.epoch), spore: d.spore_id, stateHash: d.state_hash, imageHash: d.image_hash, rendererVersion: d.renderer_version };
    default:
      return { ...shared, kind: 'other' };
  }
}
