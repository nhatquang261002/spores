// The run a loop page tells. A recording loads once; a LOCAL RUN is read again
// every few seconds until its report exists, and each read can only add lines.
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildLoop, loopDelay, loopLines, type LoopRun, type LoopSnapshot } from '../model/loop';
import { durationMs, type SceneLine } from '../model/scene';
import type { Source } from '../model/types';
import { loadLoopRun, type LogSource } from '../sources/loop';
import type { RecordedBundle } from '../sources/recorded';
import { latestRecording } from '../sources/scene';

const POLL_MS = 3_000;

export interface LoopData {
  run: LoopRun | null;
  lines: SceneLine[] | null;
  error: Error | null;
  /** A read of a run still going failed; what's on screen is older than the log. */
  lostSince: number | null;
  retry: () => void;
}

export function useLoopRun(source: LogSource | null, fetchFn?: typeof fetch): LoopData {
  const [run, setRun] = useState<LoopRun | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [lostSince, setLostSince] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const cache = useRef(new Map<string, LoopSnapshot>());
  const key = source ? `${source.kind}:${source.run}` : '';

  useEffect(() => {
    setRun(null);
    setError(null);
    setLostSince(null);
    cache.current = new Map();
    if (!source) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let seen = false;
    const read = () => {
      loadLoopRun(source, cache.current, fetchFn).then(
        (r) => {
          if (!alive) return;
          if (r) {
            seen = true;
            setRun(r);
            setLostSince(null);
          }
          if (source.kind === 'run' && !r?.report) timer = setTimeout(read, POLL_MS);
        },
        (e) => {
          if (!alive) return;
          if (seen && source.kind === 'run') {
            // The story so far is still true; the page says it has stopped hearing.
            setLostSince((t) => t ?? Date.now());
            timer = setTimeout(read, POLL_MS);
          } else setError(e);
        },
      );
    };
    read();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [key, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only a new line is a new story: a read that added nothing keeps the same array.
  const last = useRef<SceneLine[] | null>(null);
  const lines = useMemo(() => {
    if (!run) return (last.current = null);
    const next = loopLines(run);
    if (last.current && last.current.length === next.length) return last.current;
    return (last.current = next);
  }, [run]);

  return { run, lines, error, lostSince, retry: () => setAttempt((n) => n + 1) };
}

/** The recording to tell on the landing page: the one this page is already showing, or the newest of the whole loop. */
export function useStorySource(source: Source | null) {
  const [found, setFound] = useState<{ bundle: LogSource | null; error: Error | null; done: boolean }>({ bundle: null, error: null, done: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setFound({ bundle: null, error: null, done: false });
    latestRecording('loop').then(
      (b) => alive && setFound({ bundle: b ? { kind: 'recorded', run: b.run, date: b.date } : null, error: null, done: true }),
      (e) => alive && setFound({ bundle: null, error: e instanceof Error ? e : new Error(String(e)), done: true }),
    );
    return () => {
      alive = false;
    };
  }, [attempt]);
  const own = source?.kind === 'recorded' && source.run.startsWith('demo-') ? source : null;
  return { story: own ?? found.bundle, ...found, retry: () => setAttempt((n) => n + 1) };
}

export interface LoopRecording {
  bundle: RecordedBundle | null;
  /** The spore it follows. */
  hero: number | null;
  /** How long it plays in story pace, ms. */
  length: number | null;
}

/** The newest recording of the whole loop: what the page and the Demo Lab offer on LIVE. Nothing to offer is a state, not an error. */
export function useLoopRecording(): LoopRecording {
  const [rec, setRec] = useState<LoopRecording>({ bundle: null, hero: null, length: null });
  useEffect(() => {
    let alive = true;
    latestRecording('loop')
      .then(async (bundle) => {
        if (!bundle || !alive) return;
        setRec({ bundle, hero: null, length: null });
        const run = await loadLoopRun({ kind: 'recorded', run: bundle.run, date: bundle.date });
        if (!alive || !run) return;
        const lines = loopLines(run);
        setRec({ bundle, hero: buildLoop(lines).hero, length: durationMs(lines, 'story', loopDelay) });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return rec;
}
