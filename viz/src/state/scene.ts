// A scene's lines over time: a recording played back, or a live run followed
// over SSE. Both end in the same `SceneLine[]`, so the page has one path.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SaleCast } from '../components/SaleStage';
import { actStarts, buildScene, durationMs, gapMs, storyDelay, type Pace, type PeerArt, type SceneLine, type SceneState, type StoryDelay } from '../model/scene';
import { SceneClient, type ServerScene } from '../sources/scene';
import { useApp } from './source';

export interface Playback<S = SceneState> {
  lines: SceneLine[];
  scene: S;
  playing: boolean;
  finished: boolean;
  pace: Pace;
  setPace: (p: Pace) => void;
  play: () => void;
  pause: () => void;
  restart: () => void;
  seekAct: (a: string) => void;
  /** Lands on the last line: the finished story, as a still. */
  seekEnd: () => void;
  /** Lands just before `next` opens, or on the last line if there's none: the stop before it, with everything it said. */
  seekUntil: (next: string | null) => void;
  /** Whole recording at each pace, ms. */
  length: Record<Pace, number>;
}

/** Plays `all` at recorded times or in story pace. Nothing but the cursor changes. */
export function usePlayback<S = SceneState>(
  all: SceneLine[] | null,
  {
    autoplay,
    build = buildScene as unknown as (lines: SceneLine[]) => S,
    delay = storyDelay,
    lastAct = 'cleanup',
    follow = false,
    landOnLine = false,
  }: {
    autoplay: boolean;
    build?: (lines: SceneLine[]) => S;
    delay?: StoryDelay;
    lastAct?: string | null;
    /** The log is a run still going: lines only ever arrive at its end, so more of them isn't a new story. */
    follow?: boolean;
    /** A stop opens on its first real line, not on its title, so a paused story shows what the stop says. */
    landOnLine?: boolean;
  },
): Playback<S> {
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pace, setPace] = useState<Pace>('story');
  const had = useRef<SceneLine[] | null>(null);
  const held = useRef(false);

  useEffect(() => {
    const before = had.current;
    had.current = all;
    if (follow && before?.length && all && all.length >= before.length) {
      if (autoplay && !held.current) setPlaying(true);
      return;
    }
    setCursor(0);
    setPlaying(!!all && autoplay);
  }, [all, autoplay, follow]);

  useEffect(() => {
    if (!playing || !all) return;
    if (cursor >= all.length) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setCursor((c) => c + 1), gapMs(all[cursor - 1], all[cursor], pace, delay));
    return () => clearTimeout(t);
  }, [playing, cursor, all, pace, delay]);

  const lines = useMemo(() => (all ? all.slice(0, cursor) : []), [all, cursor]);
  const scene = useMemo(() => build(lines), [lines, build]);
  const length = useMemo(() => ({ story: all ? durationMs(all, 'story', delay) : 0, real: all ? durationMs(all, 'real', delay) : 0 }), [all, delay]);

  return {
    lines,
    scene,
    playing,
    finished: !!all && cursor >= all.length,
    pace,
    setPace,
    play: () => {
      held.current = false;
      setPlaying(true);
    },
    pause: () => {
      held.current = true;
      setPlaying(false);
    },
    restart: () => {
      held.current = false;
      setCursor(0);
      setPlaying(true);
    },
    seekAct: (a) => {
      if (!all) return;
      // The last stop is the outcome, so it jumps to the end of the log.
      if (a === lastAct) {
        setCursor(all.length);
        return;
      }
      const i = actStarts(all)[a];
      if (i !== undefined) setCursor(Math.min(all.length, i + (landOnLine ? 2 : 1)));
    },
    seekEnd: () => {
      if (all) setCursor(all.length);
    },
    seekUntil: (next) => {
      if (!all) return;
      const i = next === null ? undefined : actStarts(all)[next];
      setCursor(i ?? all.length);
    },
    length,
  };
}

export interface ServerState {
  /** null until the first answer. */
  reachable: boolean | null;
  scene: ServerScene | null;
  error: string | null;
  refresh: () => void;
}

const POLL_MS = 6_000;

export function useSceneServer(client: SceneClient, id: string, { enabled, paused }: { enabled: boolean; paused: boolean }): ServerState {
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [scene, setScene] = useState<ServerScene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const refresh = useCallback(() => setN((x) => x + 1), []);

  useEffect(() => {
    if (!enabled || paused) return;
    let alive = true;
    const read = () =>
      client.list().then(
        (all) => {
          if (!alive) return;
          setReachable(true);
          setError(null);
          setScene(all.find((s) => s.id === id) ?? null);
        },
        (e) => {
          if (!alive) return;
          setReachable(false);
          setScene(null);
          setError((e as Error).message);
        },
      );
    void read();
    const t = setInterval(read, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [client, id, enabled, paused, n]);

  return { reachable, scene, error, refresh };
}

export interface LiveRun<S = SceneState> {
  lines: SceneLine[];
  scene: S;
  /** A run has been followed in this page. */
  active: boolean;
  /** The stream ended (the exit line has arrived, or there was no run). */
  ended: boolean;
  /** The connection dropped; EventSource is retrying. */
  lost: boolean;
  starting: boolean;
  error: string | null;
  start: () => void;
  /** Follow a run the server is already doing (page opened mid-run). */
  follow: () => void;
  /** Forget the finished run: the chain has moved on, so the page reads it afresh. */
  clear: () => void;
}

export function useLiveRun<S = SceneState>(client: SceneClient, id: string, build: (lines: SceneLine[]) => S = buildScene as unknown as (lines: SceneLine[]) => S): LiveRun<S> {
  const [lines, setLines] = useState<SceneLine[]>([]);
  const [active, setActive] = useState(false);
  const [ended, setEnded] = useState(false);
  const [lost, setLost] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);

  const follow = useCallback(() => {
    stop.current?.();
    setLines([]);
    setActive(true);
    setEnded(false);
    setLost(false);
    stop.current = client.stream(id, {
      onLine: (l) => setLines((x) => [...x, l]),
      onEnd: () => setEnded(true),
      onConnection: (ok) => setLost(!ok),
    });
  }, [client, id]);

  const start = useCallback(() => {
    setStarting(true);
    setError(null);
    client.run(id).then(
      () => {
        setStarting(false);
        follow();
      },
      (e) => {
        setStarting(false);
        setError((e as Error).message);
      },
    );
  }, [client, id, follow]);

  const clear = useCallback(() => {
    stop.current?.();
    setLines([]);
    setActive(false);
    setEnded(false);
    setLost(false);
  }, []);

  const scene = useMemo(() => build(lines), [lines, build]);
  return { lines, scene, active, ended, lost, starting, error, start, follow, clear };
}

/** A spore as the chain has it now, for a stage before a run: tubes, money, owner and art. Null until read. */
export function useIdleCast(id: number | null, live: boolean, version: number): SaleCast | null {
  const { router } = useApp();
  const [cast, setCast] = useState<SaleCast | null>(null);
  useEffect(() => {
    if (!live || !router || id === null) return;
    let alive = true;
    (async () => {
      const [s, art] = await Promise.all([router.sporeSummary(id), router.renderInput(id)]);
      if (!s) return;
      const tubes = (s.connections ?? []).map(([n, d]: [number, string]) => [n, String(d)] as [number, string]);
      const partners = await Promise.all(tubes.map(([n]) => router.renderInput(n)));
      const asPeer = (r: any): PeerArt => ({ id: r.spore_id, seed: r.seed, age: r.age, edges: r.edges });
      if (alive) setCast({ spore: id, owner: s.owner_id, operator: s.operator_id ?? null, art: asPeer(art), peers: partners.map(asPeer), tubes, balance: s.balance, reputation: String(s.reputation), age: s.age });
    })().catch(() => {
      // The stage stays an empty dish; the epoch clock and preconditions already say the router isn't answering.
    });
    return () => {
      alive = false;
    };
  }, [id, live, router, version]);
  return cast;
}
