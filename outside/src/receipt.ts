// Receipt check for the outside service. A buyer pays through the router's
// `pay_service` (budget, cap and external allowlist enforced on chain) with
// the service's nonce as memo, then redeems with the transaction hash. The
// service delivers only if that transaction succeeded, called our router,
// paid us at least the price for that nonce, and was signed by the spore's
// current operator. Pure function so it can be tested without a network.

export interface Offer {
  nonce: string;
  sporeId: number;
  price: bigint;
  /** Issued and not yet redeemed. */
  open: boolean;
}

export interface Expect {
  router: string;
  payee: string;
  signerId: string;
  sporeId: number;
  offer: Offer | undefined;
  /** `is_operator(spore_id, signer_id)` on the router, read at redeem time. */
  isOperator: boolean;
}

/** Returns null if the receipt is good, otherwise why it is refused. */
export function checkReceipt(tx: any, e: Expect): string | null {
  if (!e.offer) return 'unknown nonce';
  if (!e.offer.open) return 'nonce already redeemed';
  if (e.offer.sporeId !== e.sporeId) return 'nonce was issued to another spore';
  const r = tx?.result;
  if (!r?.status || r.status.SuccessValue === undefined) return 'transaction did not succeed';
  if (r.transaction?.receiver_id !== e.router) return 'transaction did not call the router';
  if (r.transaction?.signer_id !== e.signerId) return 'transaction was signed by someone else';
  const events: any[] = [];
  for (const o of r.receipts_outcome ?? []) {
    if (o.outcome?.executor_id !== e.router) continue;
    for (const log of o.outcome.logs ?? []) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      try {
        const ev = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (ev.standard === 'spores') events.push(ev);
      } catch {}
    }
  }
  if (events.some((ev) => ev.event === 'service_payment_failed')) return 'the transfer to us failed';
  const paid = events
    .filter((ev) => ev.event === 'service_paid')
    .flatMap((ev) => ev.data)
    .find((d) => d.memo === e.offer!.nonce);
  if (!paid) return 'no service_paid event for this nonce';
  if (paid.payee !== e.payee) return 'paid to another account';
  if (paid.spore_id !== e.sporeId) return 'paid by another spore';
  if (BigInt(paid.amount) < e.offer.price) return 'underpaid';
  if (!e.isOperator) return "signer is not the spore's current operator";
  return null;
}
