// The Verify run, held above the routes so it keeps going while the reader
// looks at another page (a run takes about a minute) and the Spore page and
// close rows can show its result. It lives in memory only: nothing is stored as
// "verified", a reload forgets it, and each click reads the chain again.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Router } from '../chain/router';
import type { VerifyProgress, VerifyResult } from '../model/verify';
import { liveRouter } from '../sources/live';
import { loadCloseHashes, runVerification, type CloseHashes, type VerifyDeps } from '../sources/verify';
import type { Source } from '../model/types';
import { RenderQueueContext } from '../wasm/art';
import { loadCore } from '../wasm/core';

export type VerifyRun =
  | { status: 'running'; spore: number | null; progress: VerifyProgress }
  | { status: 'done'; spore: number | null; result: VerifyResult }
  /** Nothing could be checked: no list, no `config`, no core-wasm. */
  | { status: 'failed'; spore: number | null; error: Error };

export interface VerifyStore {
  /** Verification reads a chain; the simulation has none. */
  available: boolean;
  run: VerifyRun | null;
  start: (spore: number | null) => void;
}

const VerifyContext = createContext<VerifyStore>({ available: false, run: null, start: () => {} });
export const useVerify = () => useContext(VerifyContext);

const toError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

export function VerifyProvider({ source, router, rpcRouter, children }: { source: Source | null; router: Router | null; rpcRouter?: Router; children: ReactNode }) {
  const getQueue = useContext(RenderQueueContext);
  const [run, setRun] = useState<VerifyRun | null>(null);
  const seq = useRef(0);
  const key = source ? JSON.stringify(source) : '';

  // A result belongs to one source: never show it under another's badge.
  useEffect(() => {
    seq.current++;
    setRun(null);
  }, [key]);

  const start = useCallback(
    (spore: number | null) => {
      if (!source || source.kind === 'sim' || (source.kind === 'live' && !router)) return;
      const my = ++seq.current;
      const alive = () => my === seq.current;
      setRun({ status: 'running', spore, progress: { step: 'list' } });
      (async () => {
        const list = await loadCloseHashes(source, router?.id ?? null);
        const chain = router ?? new Router((rpcRouter ?? liveRouter()).rpc, list.router);
        const deps: VerifyDeps = {
          router: chain,
          core: loadCore,
          render: async (input) => {
            const r = await (await getQueue()).request(input, { priority: 0, fresh: true });
            return { rgb: r.rgb, imageHash: r.imageHash, rendererVersion: r.rendererVersion };
          },
        };
        const result = await runVerification(deps, { hashes: list.hashes, spore }, (progress) => alive() && setRun({ status: 'running', spore, progress }), alive);
        if (alive()) setRun({ status: 'done', spore, result });
      })().catch((e) => alive() && setRun({ status: 'failed', spore, error: toError(e) }));
    },
    [key, router, rpcRouter, getQueue],
  );

  const store = useMemo(() => ({ available: !!source && source.kind !== 'sim', run, start }), [source, run, start]);
  return <VerifyContext.Provider value={store}>{children}</VerifyContext.Provider>;
}

export interface HashesState {
  list: CloseHashes | null;
  error: Error | null;
  retry: () => void;
}

/** The close hashes the header names before anything has run. */
export function useCloseHashes(source: Source | null, router: Router | null): HashesState {
  const [list, setList] = useState<CloseHashes | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = source ? JSON.stringify(source) : '';
  useEffect(() => {
    setList(null);
    setError(null);
    if (!source || source.kind === 'sim' || (source.kind === 'live' && !router)) return;
    let live = true;
    loadCloseHashes(source, router?.id ?? null).then(
      (l) => live && setList(l),
      (e) => live && setError(toError(e)),
    );
    return () => {
      live = false;
    };
  }, [key, router, attempt]);
  return { list, error, retry: useCallback(() => setAttempt((a) => a + 1), []) };
}
