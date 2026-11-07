// Bottom-right stack of this session's transactions (Design §7). Wallet calls
// arrive in S8 and push here; a tx shows success only after its final outcome.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { EXPLORER } from '../chain/rpc';
import { shortHash } from './format';

export type TxState = 'signing' | 'pending' | 'ok' | 'failed' | 'cancelled';

export interface TrayTx {
  id: string;
  /** e.g. `List Spore #7`. */
  label: string;
  state: TxState;
  hash?: string;
  /** Contract error, verbatim. */
  error?: string;
}

interface TrayApi {
  txs: TrayTx[];
  upsert: (tx: TrayTx) => void;
}

const TrayContext = createContext<TrayApi>({ txs: [], upsert: () => {} });

export function TxTrayProvider({ children }: { children: ReactNode }) {
  const [txs, setTxs] = useState<TrayTx[]>([]);
  const upsert = useCallback((tx: TrayTx) => {
    setTxs((list) => {
      const i = list.findIndex((t) => t.id === tx.id);
      if (i < 0) return [tx, ...list];
      const next = list.slice();
      next[i] = tx;
      return next;
    });
  }, []);
  const api = useMemo(() => ({ txs, upsert }), [txs, upsert]);
  return <TrayContext.Provider value={api}>{children}</TrayContext.Provider>;
}

export const useTxTray = () => useContext(TrayContext);

/** Fixed copy per state (Design §8.3). */
export function txStateText(tx: TrayTx): string {
  switch (tx.state) {
    case 'signing':
      return 'Waiting for your wallet…';
    case 'pending':
      return 'Sent · waiting for final outcome';
    case 'ok':
      return '✓ Confirmed';
    case 'failed':
      return `✕ Failed: ${tx.error ?? 'unknown error'}`;
    case 'cancelled':
      return 'Cancelled in wallet. Nothing was sent.';
  }
}

export function TxTray() {
  const { txs } = useTxTray();
  if (txs.length === 0) return null;
  return (
    <aside className="tx-tray" aria-label="Transactions this session">
      <ul>
        {txs.slice(0, 4).map((tx) => (
          <li key={tx.id} className={`tx-row tx-${tx.state}`} aria-live={tx.state === 'failed' ? 'assertive' : 'polite'}>
            <span className="body">{tx.label}</span>
            <span className="mono-s">{txStateText(tx)}</span>
            {tx.hash && (
              <a className="mono-s" href={`${EXPLORER}/${tx.hash}`} target="_blank" rel="noreferrer">
                {shortHash(tx.hash)} ↗
              </a>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
