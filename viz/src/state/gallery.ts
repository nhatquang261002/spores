// The gallery's data for the current source. LIVE reloads when the app's
// epoch poll sees a close (the tubes and art change only then). A failed
// refresh keeps the last data, marked with the time it was read, next to the
// error; a failed first load is just the error.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Router } from '../chain/router';
import type { Gallery } from '../model/gallery';
import type { Source } from '../model/types';
import { loadLiveGallery, loadSnapshotGallery } from '../sources/gallery';

export interface GalleryState {
  data: Gallery | null;
  error: Error | null;
  loading: boolean;
  retry: () => void;
}

/**
 * The last LIVE read per router, so moving between the gallery, a Spore page
 * and My Spores doesn't read the collection again within an epoch (Design
 * §10). A close still triggers a reread (below).
 */
const liveCache = new WeakMap<Router, Gallery>();

export function useGallery(source: Source | null, router: Router | null, liveEpoch: number | undefined): GalleryState {
  const cached = () => (source?.kind === 'live' && router ? (liveCache.get(router) ?? null) : null);
  const [data, setDataState] = useState<Gallery | null>(cached);
  const setData = (g: Gallery | null) => {
    if (g && source?.kind === 'live' && router) liveCache.set(router, g);
    setDataState(g);
  };
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const key = source ? JSON.stringify(source) : '';

  // A new source starts from nothing: never show one source's spores under another's badge.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setDataState(cached());
    setError(null);
  }, [key]);

  const busy = useRef(false);

  // LIVE: a close moves `liveEpoch` past the loaded epoch; read again once (a failure waits for Retry or the next close).
  useEffect(() => {
    if (source?.kind === 'live' && data && liveEpoch !== undefined && liveEpoch > data.epoch && !busy.current) setAttempt((a) => a + 1);
  }, [liveEpoch, data]); // reacts to a close only

  useEffect(() => {
    if (!source) return;
    if (source.kind === 'sim') {
      setError(new Error('the simulation has no spores: it is aggregate economy output'));
      return;
    }
    if (source.kind === 'live' && !router) return;
    // A cached LIVE read is used as is; the close effect above rereads when the epoch moved on.
    if (attempt === 0 && source.kind === 'live' && liveCache.has(router!)) return;
    const my = ++seq.current;
    busy.current = true;
    setLoading(true);
    const load = source.kind === 'live' ? loadLiveGallery(router!) : loadSnapshotGallery(source);
    load.then(
      (g) => {
        if (my !== seq.current) return;
        busy.current = false;
        setData(g);
        setError(null);
        setLoading(false);
      },
      (e) => {
        if (my !== seq.current) return;
        busy.current = false;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      },
    );
    return () => {
      seq.current++;
      busy.current = false;
    };
  }, [key, router, attempt]); // `source` is covered by `key`

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { data, error, loading, retry };
}
