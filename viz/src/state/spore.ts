// One spore's detail for the current source. LIVE reads `spore_summary`,
// `nft_token` and `epoch_info` on load, again at each observed close, and
// after a confirmed transaction (`retry`); it never polls. LOCAL RUN and
// RECORDED read the run's last snapshot. A failed refresh keeps the last
// data next to the error.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Router, RouterConfig } from '../chain/router';
import { sporeFromLive, sporeFromSnapshot, type SporeView } from '../model/spore';
import type { Source } from '../model/types';
import { loadLastSnapshot } from '../sources/gallery';

export interface SporeState {
  data: SporeView | null;
  error: Error | null;
  loading: boolean;
  retry: () => void;
}

export async function loadLiveSpore(router: Router, id: number): Promise<SporeView> {
  const [summary, token, info] = await Promise.all([router.sporeSummary(id), router.nftToken(id), router.epochInfo()]);
  if (!summary) throw new Error(`spore_summary has no Spore #${id} on ${router.id}`);
  return sporeFromLive(summary, token, info, Date.now());
}

export function useSpore(source: Source | null, router: Router | null, id: number, liveEpoch: number | undefined): SporeState {
  const [data, setData] = useState<SporeView | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const key = source ? `${JSON.stringify(source)}#${id}` : '';

  useEffect(() => {
    setData(null);
    setError(null);
  }, [key]);

  useEffect(() => {
    if (source?.kind === 'live' && data && liveEpoch !== undefined && liveEpoch > data.epoch && !loading) setAttempt((a) => a + 1);
  }, [liveEpoch, data]); // a close only

  useEffect(() => {
    if (!source) return;
    if (source.kind === 'sim') {
      setError(new Error('the simulation has no spores: it is aggregate economy output'));
      return;
    }
    if (source.kind === 'live' && !router) return;
    const my = ++seq.current;
    setLoading(true);
    const load = source.kind === 'live' ? loadLiveSpore(router!, id) : loadLastSnapshot(source).then((s) => sporeFromSnapshot(s, id, Date.now()));
    load.then(
      (v) => {
        if (my !== seq.current) return;
        setData(v);
        setError(null);
        setLoading(false);
      },
      (e) => {
        if (my !== seq.current) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      },
    );
    return () => {
      seq.current++;
    };
  }, [key, router, attempt]); // `source` and `id` are covered by `key`

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { data, error, loading, retry };
}

const configs = new WeakMap<Router, Promise<RouterConfig>>();

/** The router's config, read once per router (it changes only by admin call). */
export function routerConfig(router: Router): Promise<RouterConfig> {
  let p = configs.get(router);
  if (!p) {
    p = router.config();
    p.catch(() => configs.delete(router));
    configs.set(router, p);
  }
  return p;
}

export function useConfig(router: Router | null): { config: RouterConfig | null; error: Error | null } {
  const [state, setState] = useState<{ config: RouterConfig | null; error: Error | null }>({ config: null, error: null });
  useEffect(() => {
    if (!router) return;
    let live = true;
    routerConfig(router).then(
      (config) => live && setState({ config, error: null }),
      (e) => live && setState({ config: null, error: e instanceof Error ? e : new Error(String(e)) }),
    );
    return () => {
      live = false;
    };
  }, [router]);
  return state;
}
