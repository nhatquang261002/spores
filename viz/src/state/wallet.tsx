// The connected wallet, app-wide (Design §7 `WalletStatus`, §11: wallet
// identity is separate from ownership; owner gating goes through `canAct`).
// The connector loads on the first wallet interaction; a browser that
// connected before (flag in localStorage) restores the session at load.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isWrongNetwork, nearConnectWallet, type WalletClient } from '../chain/wallet';
import { isWalletCancel } from '../model/tx';

export type WalletPhase = 'disconnected' | 'connecting' | 'connected' | 'wrong-network';

export interface WalletState {
  phase: WalletPhase;
  /** Set when connected (also on the wrong network, to say which account). */
  accountId: string | null;
  /** The last connect error, verbatim. */
  error: string | null;
  connect: () => void;
  disconnect: () => void;
  client: WalletClient;
}

const FLAG = 'spores.wallet';

const WalletContext = createContext<WalletState | null>(null);

let shared: WalletClient | null = null;
const defaultClient = () => (shared ??= nearConnectWallet());

const remembered = () => {
  try {
    return localStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
};
const remember = (on: boolean) => {
  try {
    if (on) localStorage.setItem(FLAG, '1');
    else localStorage.removeItem(FLAG);
  } catch {
    /* storage off: the session just isn't restored */
  }
};

export function WalletProvider({ client, children }: { client?: WalletClient; children: ReactNode }) {
  const wallet = useMemo(() => client ?? defaultClient(), [client]);
  const [accountId, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!remembered()) return;
    let live = true;
    setBusy(true);
    wallet.restore().then(
      (id) => {
        if (!live) return;
        setAccount(id);
        if (!id) remember(false);
        setBusy(false);
      },
      () => live && (remember(false), setBusy(false)),
    );
    return () => {
      live = false;
    };
  }, [wallet]);

  const connect = useCallback(() => {
    setBusy(true);
    setError(null);
    wallet.connect().then(
      (id) => {
        setAccount(id);
        remember(true);
        setBusy(false);
      },
      (e) => {
        // Closing the picker is not an error (near-connect rejects with "User rejected").
        setError(isWalletCancel(e) ? null : String((e as Error)?.message ?? e));
        setBusy(false);
      },
    );
  }, [wallet]);

  const disconnect = useCallback(() => {
    setAccount(null);
    remember(false);
    wallet.disconnect().catch(() => {});
  }, [wallet]);

  const phase: WalletPhase = busy ? 'connecting' : !accountId ? 'disconnected' : isWrongNetwork(accountId) ? 'wrong-network' : 'connected';
  const state = useMemo(() => ({ phase, accountId, error, connect, disconnect, client: wallet }), [phase, accountId, error, connect, disconnect, wallet]);
  return <WalletContext.Provider value={state}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const s = useContext(WalletContext);
  if (!s) throw new Error('useWallet outside WalletProvider');
  return s;
}

/** The account that may sign: connected on testnet, else null. */
export const signerOf = (w: Pick<WalletState, 'phase' | 'accountId'>) => (w.phase === 'connected' ? w.accountId : null);
