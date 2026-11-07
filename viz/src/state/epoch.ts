// Live epoch polling (Design §10): `epoch_info` every ~10 s plus a refresh just
// after `ends_ns`. When polling has failed for more than 30 s the data is
// stale (Design §6.0); values stay on screen with the time they are from.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EpochInfo, Router } from '../chain/router';

export const POLL_MS = 10_000;
export const STALE_AFTER_MS = 30_000;
/** Chain time runs on block timestamps; look a little after the end. */
const END_MARGIN_MS = 1_500;

export const nsToMs = (ns: string): number => Number(BigInt(ns) / 1_000_000n);

/** Delay to the next poll: the interval, or just after the epoch's end if that comes first. */
export function nextPollMs(nowMs: number, info: EpochInfo | null, intervalMs = POLL_MS): number {
  if (!info) return intervalMs;
  const toEnd = nsToMs(info.ends_ns) - nowMs + END_MARGIN_MS;
  return toEnd > 0 ? Math.min(intervalMs, toEnd) : intervalMs;
}

/** Time the data has been stale since (the last success), or null while fresh. */
export function staleSince(lastOkAt: number | null, failing: boolean, nowMs: number): number | null {
  if (!failing || lastOkAt === null) return null;
  return nowMs - lastOkAt > STALE_AFTER_MS ? lastOkAt : null;
}

export interface EpochState {
  info: EpochInfo | null;
  /** ms epoch of the last successful poll. */
  lastOkAt: number | null;
  /** The last poll's error, cleared by a success. */
  error: Error | null;
  /** Set when polling has failed for more than 30 s. */
  staleSince: number | null;
  retry: () => void;
}

/** Polls `router.epochInfo()` while mounted; `router` null disables polling (non-live sources). */
export function useEpochInfo(router: Router | null): EpochState {
  const [info, setInfo] = useState<EpochInfo | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    if (!router) return;
    let alive = true;
    let current: EpochInfo | null = null;
    const poll = async () => {
      if (timer.current) clearTimeout(timer.current);
      try {
        current = await router.epochInfo();
        if (!alive) return;
        setInfo(current);
        setLastOkAt(Date.now());
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      }
      setNow(Date.now());
      if (alive) timer.current = setTimeout(poll, nextPollMs(Date.now(), current));
    };
    kick.current = () => void poll();
    void poll();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [router]);

  const retry = useCallback(() => kick.current(), []);
  return { info, lastOkAt, error, staleSince: staleSince(lastOkAt, error !== null, now), retry };
}
