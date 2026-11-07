// The Network explorer's data for the current source. LIVE shows the epoch in
// progress as soon as the bulk views are in, then fills in the past epochs as
// each close tx arrives, then replays them (core-wasm). It follows the app's
// `epoch_info` poll: new flows in the same epoch are settlements confirmed
// since the last poll; a higher epoch is a close, and the views are read again.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EpochClosed } from '../chain/events';
import type { EpochInfo, Router } from '../chain/router';
import { emptyFrame, type Frame, type NetworkHistory } from '../model/network';
import type { Source } from '../model/types';
import {
  applyReplay,
  fetchClose,
  frameFromClose,
  historyFromLiveBase,
  loadCloseList,
  loadLiveBase,
  loadRunNetwork,
  newSettlements,
  sameTubes,
  sporesFromTokens,
  withLiveFlows,
  type NetworkData,
} from '../sources/network';
import { loadCore } from '../wasm/core';

/** Settlements and rejects the app's poll saw since the previous poll (LIVE, same epoch). */
export interface LiveBatch {
  n: number;
  epoch: number;
  settled: [number, number, string][];
  rejected: [number, number][];
}

export interface NetworkState {
  data: NetworkData | null;
  error: Error | null;
  retry: () => void;
  live: LiveBatch | null;
}

const CLOSE_CONCURRENCY = 2;

export async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>, alive: () => boolean) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length && alive()) await fn(items[i++]);
    }),
  );
}

/**
 * Frames for the closes fetched so far over `h`. A close event without tubes
 * keeps the tubes the frame already had (`edges()` for the last close, or an
 * earlier replay).
 */
export function mergeCloses(h: NetworkHistory, closes: Map<number, { ev: EpochClosed; tx: string }>): NetworkHistory {
  const frames = new Map(h.frames);
  for (const [e, { ev, tx }] of closes) {
    if (e >= h.current) continue;
    const old = frames.get(e);
    if (old?.close?.tx === tx && old.close.fetched) continue;
    const f = frameFromClose(ev, tx);
    if (!f.tubes && old?.tubes) Object.assign(f, { tubes: old.tubes, tubesFrom: old.tubesFrom, reputation: old.reputation, replay: old.replay });
    frames.set(e, f);
  }
  return { ...h, frames };
}

/** The tubes after the close before the live epoch, from history, against `edges()` (↻). */
export function edgesCheckOf(h: NetworkHistory): 'match' | 'mismatch' | null {
  const last = h.frames.get(h.current - 1);
  if (!last?.tubes || !h.live.tubes || (last.tubesFrom !== 'replay' && last.tubesFrom !== 'event')) return null;
  return sameTubes(last.tubes, h.live.tubes) ? 'match' : 'mismatch';
}

export function useNetwork(source: Source | null, router: Router | null, info: EpochInfo | null): NetworkState {
  const [data, setData] = useState<NetworkData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [live, setLive] = useState<LiveBatch | null>(null);
  const seq = useRef(0);
  const closes = useRef(new Map<number, { ev: EpochClosed; tx: string }>());
  const dataRef = useRef<NetworkData | null>(null);
  const key = source ? JSON.stringify(source) : '';

  const commit = (d: NetworkData) => {
    dataRef.current = d;
    setData(d);
  };

  useEffect(() => {
    dataRef.current = null;
    setData(null);
    setError(null);
    setLive(null);
    closes.current = new Map();
  }, [key]);

  // A close seen by the app's poll: read the views again (the past frames stay).
  const liveEpoch = info?.epoch;
  useEffect(() => {
    const d = dataRef.current;
    if (source?.kind === 'live' && d && liveEpoch !== undefined && liveEpoch > d.history.current) setAttempt((a) => a + 1);
  }, [liveEpoch]); // a close only

  // Same epoch, newer poll: the flows settled so far.
  useEffect(() => {
    const d = dataRef.current;
    if (source?.kind !== 'live' || !d || !info || info.epoch !== d.history.current) return;
    const next = withLiveFlows(d.history, info);
    const batch = newSettlements(d.history.live, next.live);
    if (!batch.settled.length && !batch.rejected.length) return;
    commit({ ...d, history: next });
    setLive((l) => ({ n: (l?.n ?? 0) + 1, epoch: info.epoch, ...batch }));
  }, [info]);

  useEffect(() => {
    if (!source) return;
    if (source.kind === 'sim') {
      setError(new Error('the simulation has no tubes per spore: it is aggregate economy output'));
      return;
    }
    if (source.kind === 'live' && !router) return;
    const my = ++seq.current;
    const alive = () => my === seq.current;
    const fail = (e: unknown) => alive() && setError(e instanceof Error ? e : new Error(String(e)));

    if (source.kind !== 'live') {
      loadRunNetwork(source).then((d) => {
        if (!alive()) return;
        commit(d);
        setError(null);
      }, fail);
      return () => {
        seq.current++;
      };
    }

    (async () => {
      const r = router!;
      const base = await loadLiveBase(r);
      if (!alive()) return;
      const prev = dataRef.current;
      let history = historyFromLiveBase(base);
      // Frames already loaded stay; the close before the live epoch has the new edges() as its tubes.
      for (const [e, f] of prev?.history.frames ?? []) if (e < history.current) history.frames.set(e, f);
      const after = history.current - 1;
      if (after >= 1 && !history.frames.get(after)?.tubes) {
        const f: Frame = history.frames.get(after) ?? emptyFrame(after);
        history.frames.set(after, { ...f, tubes: history.live.tubes, tubesFrom: 'edges', active: f.active ?? base.info.active });
      }
      history = mergeCloses(history, closes.current);
      commit({
        history,
        spores: sporesFromTokens(base.tokens),
        steps: null,
        figures: null,
        readAt: base.readAt,
        closes: prev?.closes ?? { listed: 0, loaded: 0, error: null, listUrl: null },
        edgesCheck: edgesCheckOf(history),
      });
      setError(null);

      // Past epochs: the close list, then each close tx (cached), then the replay.
      // The map already stands on edges(); a missing or unreadable close list only leaves the past hollow.
      let list: Awaited<ReturnType<typeof loadCloseList>>;
      try {
        list = await loadCloseList(r.id);
      } catch (e) {
        if (alive()) commit({ ...dataRef.current!, closes: { listed: 0, loaded: 0, error: e instanceof Error ? e : new Error(String(e)), listUrl: null } });
        return;
      }
      if (!alive()) return;
      if (!list) return commit({ ...dataRef.current!, closes: { listed: 0, loaded: 0, error: null, listUrl: null } });
      const have = new Set([...closes.current.values()].map((c) => c.tx));
      const todo = list.hashes.filter((h) => !have.has(h));
      let closeErr: Error | null = null;
      let signer = '';
      try {
        if (todo.length) signer = await r.admin();
      } catch (e) {
        if (alive()) commit({ ...dataRef.current!, closes: { listed: list.hashes.length, loaded: closes.current.size, error: e instanceof Error ? e : new Error(String(e)), listUrl: list.url } });
        return;
      }
      const progress = () => {
        if (!alive()) return;
        const d = dataRef.current!;
        commit({ ...d, history: mergeCloses(d.history, closes.current), closes: { listed: list.hashes.length, loaded: closes.current.size, error: closeErr, listUrl: list.url } });
      };
      progress();
      await pool(
        todo,
        CLOSE_CONCURRENCY,
        async (tx) => {
          try {
            const ev = await fetchClose(r, tx, signer);
            closes.current.set(ev.epoch, { ev, tx });
          } catch (e) {
            closeErr ??= e instanceof Error ? e : new Error(String(e));
          }
          progress();
        },
        alive,
      );
      if (!alive() || !closes.current.has(1)) return;
      let core: Awaited<ReturnType<typeof loadCore>>;
      try {
        core = await loadCore();
      } catch (e) {
        if (alive()) commit({ ...dataRef.current!, closes: { ...dataRef.current!.closes, error: e instanceof Error ? e : new Error(String(e)) } });
        return;
      }
      if (!alive()) return;
      const d = dataRef.current!;
      const next: NetworkHistory = { ...d.history, frames: new Map([...d.history.frames].map(([e, f]) => [e, { ...f }])) };
      applyReplay(next, new Map([...closes.current].map(([e, c]) => [e, c.ev])), core, base.config);
      commit({ ...d, history: next, edgesCheck: edgesCheckOf(next) });
    })().catch(fail);
    return () => {
      seq.current++;
    };
  }, [key, router, attempt]); // `source` is covered by `key`

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { data, error, retry, live };
}
