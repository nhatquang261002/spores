// A wallet call's life (Design §7 `TxAction`, §8.3): idle → confirm →
// signing → pending → ok | failed, plus cancelled. A transaction shows success
// only after the app fetched its final outcome (Rules: "a tx shows success
// only after its final outcome"); nothing here is optimistic. Pure, so the
// rule is tested without a wallet.
import { eventsFromTx, type ChainEvent } from '../chain/events';

export type TxPhase = 'idle' | 'confirm' | 'signing' | 'pending' | 'ok' | 'failed' | 'cancelled';

export interface TxMachine {
  phase: TxPhase;
  /** Known once the wallet returns it. */
  hash?: string;
  /** Contract error verbatim, or the wallet's error text. */
  error?: string;
  /** Pending only: reading the final outcome failed, so the result is not known yet. */
  checkError?: string;
  /** Events the router logged (final outcomes only). */
  events?: ChainEvent[];
}

export type TxEvent =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'sign' }
  | { type: 'sent'; hash: string }
  | { type: 'final'; outcome: TxOutcome }
  | { type: 'checkFailed'; error: string }
  | { type: 'walletError'; error: string; cancelled: boolean };

export const IDLE: TxMachine = { phase: 'idle' };

/** Signing and pending: the action can't be started again (Design §7: disabled while busy). */
export const isBusy = (m: TxMachine) => m.phase === 'signing' || m.phase === 'pending';

/**
 * Transitions. An event that does not fit the phase is ignored, so a late
 * outcome can't turn a closed dialog green and nothing reaches `ok` except a
 * final outcome read while pending.
 */
export function txReduce(m: TxMachine, e: TxEvent): TxMachine {
  switch (e.type) {
    case 'open':
      return isBusy(m) ? m : { phase: 'confirm' };
    case 'close':
      return isBusy(m) ? m : IDLE;
    case 'sign':
      return m.phase === 'confirm' || m.phase === 'cancelled' || m.phase === 'failed' ? { phase: 'signing' } : m;
    case 'sent':
      return m.phase === 'signing' ? { phase: 'pending', hash: e.hash } : m;
    case 'checkFailed':
      return m.phase === 'pending' ? { ...m, checkError: e.error } : m;
    case 'final':
      if (m.phase !== 'pending') return m;
      return e.outcome.ok
        ? { phase: 'ok', hash: e.outcome.hash, events: e.outcome.events }
        : { phase: 'failed', hash: e.outcome.hash, error: e.outcome.error, events: e.outcome.events };
    case 'walletError':
      if (m.phase !== 'signing') return m;
      return e.cancelled ? { phase: 'cancelled' } : { phase: 'failed', error: e.error };
  }
}

export interface TxOutcome {
  hash: string;
  ok: boolean;
  /** The contract's panic message verbatim (without NEAR's "Smart contract panicked: " prefix), or the action error. */
  error?: string;
  events: ChainEvent[];
}

const PANIC = 'Smart contract panicked: ';

/**
 * A `tx` RPC result (wait_until FINAL) → outcome. `failEvents` are router
 * events that mean the call did not do what it says even though the receipt
 * succeeded (`withdraw_failed`: the transfer bounced and the balance was
 * restored).
 */
export function outcomeOf(tx: any, failEvents: string[] = []): TxOutcome {
  const hash: string = tx?.transaction?.hash ?? tx?.transaction_outcome?.id ?? '';
  const status = tx?.status;
  if (!status || typeof status !== 'object') throw new Error('the transaction result has no final status');
  const events = eventsFromTx(tx);
  if (status.Failure !== undefined) {
    const text = JSON.stringify(status.Failure);
    const m = text.match(/"ExecutionError":"((?:[^"\\]|\\.)*)"/);
    const raw: string = m ? JSON.parse(`"${m[1]}"`) : text;
    return { hash, ok: false, error: raw.startsWith(PANIC) ? raw.slice(PANIC.length) : raw, events };
  }
  if (status.SuccessValue === undefined) throw new Error(`the transaction is not final: ${Object.keys(status).join(', ')}`);
  const bad = events.find((e) => e.standard === 'spores' && failEvents.includes(e.event));
  if (bad) return { hash, ok: false, error: `${bad.event} (logged by the router)`, events };
  return { hash, ok: true, events };
}

/**
 * Wallet errors carry no standard code. Only an error that reads like the
 * user declining is "cancelled", which promises nothing was sent; anything
 * else is a failure with the wallet's own words.
 */
export function isWalletCancel(err: unknown): boolean {
  const text = String((err as Error)?.message ?? err ?? '');
  return /\b(user )?(reject(ed)?|cancel(l?ed)?|denied|declined|closed)\b/i.test(text);
}

/** Copy per phase (Design §8.3). `confirm` is the action title. */
export function txCopy(m: TxMachine, action: string, sporeId: number): string {
  switch (m.phase) {
    case 'idle':
    case 'confirm':
      return `${action} Spore #${sporeId}`;
    case 'signing':
      return 'Waiting for your wallet…';
    case 'pending':
      return 'Sent · waiting for final outcome';
    case 'ok':
      return '✓ Confirmed';
    case 'failed':
      return `✕ Failed: ${m.error ?? 'unknown error'}`;
    case 'cancelled':
      return 'Cancelled in wallet. Nothing was sent.';
  }
}
