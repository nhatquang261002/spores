// The Activity feed's data, and the receipts the reader has fetched.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { EpochClosed } from '../chain/events';
import type { Rpc } from '../chain/rpc';
import type { Router } from '../chain/router';
import { closeRow, emptyActivity, type Activity } from '../model/activity';
import type { Receipt } from '../model/receipts';
import type { Source } from '../model/types';
import { cachedReceipt, fetchReceipt, loadRunActivity } from '../sources/activity';
import { fetchClose, loadCloseList, type SnapshotFile } from '../sources/network';
import { pool } from './network';

export interface CloseProgress {
  listed: number;
  loaded: number;
  listUrl: string | null;
}

export interface ActivityState {
  data: Activity | null;
  error: Error | null;
  retry: () => void;
  /** LIVE: how far the close list has been read; null when no list has been read yet. */
  closes: CloseProgress | null;
  /** Rows that arrived on a later read of the log, for the feed's arrival motion. */
  fresh: Set<string>;
  /** A later read of a growing log failed: rows stay, as of this time. */
  staleSince: number | null;
}

const POLL_MS = 5_000;
const CLOSE_CONCURRENCY = 2;
const toError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

/** `poll`: follow a LOCAL RUN that has no report yet (it may still be running). */
export function useActivity(source: Source | null, router: Router | null, { poll = false }: { poll?: boolean } = {}): ActivityState {
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [closes, setCloses] = useState<CloseProgress | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [staleSince, setStaleSince] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = source ? JSON.stringify(source) : '';

  useEffect(() => {
    setData(null);
    setError(null);
    setCloses(null);
    setFresh(new Set());
    setStaleSince(null);
  }, [key]);

  useEffect(() => {
    if (!source || source.kind === 'sim') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (source.kind === 'live') {
      if (!router) return;
      setError(null);
      (async () => {
        const list = await loadCloseList(router.id);
        if (!alive) return;
        if (!list) {
          setCloses({ listed: 0, loaded: 0, listUrl: null });
          setData(emptyActivity('chain', router.id));
          return;
        }
        const events = new Map<string, EpochClosed>();
        const publish = () => {
          if (!alive) return;
          setCloses({ listed: list.hashes.length, loaded: events.size, listUrl: list.url });
          setData(emptyActivity('chain', router.id, [...events].map(([tx, ev]) => closeRow(ev, tx))));
        };
        publish();
        const signer = list.hashes.length ? await router.admin() : '';
        let first: Error | null = null;
        await pool(
          list.hashes,
          CLOSE_CONCURRENCY,
          async (tx) => {
            try {
              events.set(tx, await fetchClose(router, tx, signer));
            } catch (e) {
              first ??= toError(e);
            }
            publish();
          },
          () => alive,
        );
        if (alive && first) setError(first);
      })().catch((e) => alive && setError(toError(e)));
      return () => {
        alive = false;
      };
    }

    const cache = new Map<string, SnapshotFile>();
    let seen: Set<string> | null = null;
    const read = async () => {
      try {
        const { activity, finished } = await loadRunActivity(source, undefined, cache);
        if (!alive) return;
        const keys = new Set(activity.rows.map((r) => r.key));
        if (seen) setFresh(new Set([...keys].filter((k) => !seen!.has(k))));
        seen = keys;
        setData(activity);
        setError(null);
        setStaleSince(null);
        if (poll && source.kind === 'run' && !finished) timer = setTimeout(read, POLL_MS);
      } catch (e) {
        if (!alive) return;
        // A first read that failed is an error; a later one keeps the rows, marked stale.
        if (seen) {
          setStaleSince((s) => s ?? Date.now());
          timer = setTimeout(read, POLL_MS);
        } else {
          setError(toError(e));
        }
      }
    };
    read();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, router, attempt, poll]); // `source` is covered by `key`

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { data, error, retry, closes, fresh, staleSince };
}

// --- receipts ---------------------------------------------------------------

export type ReceiptState = { status: 'idle' } | { status: 'loading' } | { status: 'ok'; receipt: Receipt } | { status: 'error'; error: Error };

export interface ReceiptStore {
  stateOf: (hash: string) => ReceiptState;
  fetch: (hash: string, sender: string | null) => void;
}

/** Fetched lazily, per tx, on the reader's click (S9); a receipt stays Logged until then. */
export function useReceiptStore(rpc: Rpc, router: string | null): ReceiptStore {
  const states = useRef(new Map<string, ReceiptState>());
  const [, bump] = useState(0);
  const set = (hash: string, s: ReceiptState) => {
    states.current.set(hash, s);
    bump((n) => n + 1);
  };
  return {
    stateOf: (hash) => {
      const s = states.current.get(hash);
      if (s) return s;
      const hit = cachedReceipt(hash);
      return hit ? { status: 'ok', receipt: hit } : { status: 'idle' };
    },
    fetch: (hash, sender) => {
      if (states.current.get(hash)?.status === 'loading') return;
      set(hash, { status: 'loading' });
      fetchReceipt(rpc, hash, sender, router).then(
        (receipt) => set(hash, { status: 'ok', receipt }),
        (e) => set(hash, { status: 'error', error: toError(e) }),
      );
    },
  };
}

export const ReceiptContext = createContext<ReceiptStore | null>(null);
export const useReceipts = () => useContext(ReceiptContext);
