// The whole loop's logs: a finished run's bundle, or a run still going in
// out/agents/ (read again as it grows). A file that doesn't exist yet is empty
// only where a run can really not have it yet; anything else is an error.
import type { LoopEvent, LoopReport, LoopRun, LoopRunJson, LoopSnapshot } from '../model/loop';
import type { SceneLine } from '../model/scene';
import { parseSceneLog } from '../model/scene';
import type { Source } from '../model/types';
import { recordedFiles, recordedManifest } from './recorded';
import { listRunDir, parseJsonl, runFiles, SourceFileError, type RunFiles } from './run';

export type LogSource = Extract<Source, { kind: 'run' | 'recorded' }>;

const missing = (e: unknown) => e instanceof SourceFileError && e.status === 404;

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

/** Half-written last line of a growing log: it arrives whole on the next read. */
function growing<T>(text: string | null, where: string): T[] {
  if (!text) return [];
  const end = text.lastIndexOf('\n');
  return parseJsonl<T>(end < 0 ? '' : text.slice(0, end), where);
}

/**
 * Reads the run. `cache` keeps snapshots across reads of a run still going: they
 * are written once. Null when a LOCAL RUN hasn't written its run.json yet.
 */
export async function loadLoopRun(source: LogSource, cache: Map<string, LoopSnapshot> = new Map(), fetchFn?: typeof fetch): Promise<LoopRun | null> {
  const files: RunFiles = source.kind === 'run' ? runFiles(source.run, fetchFn) : recordedFiles(source.run, fetchFn);
  const run = source.kind === 'run' ? await orNull(files.json<LoopRunJson>('run.json')) : await files.json<LoopRunJson>('run.json');
  if (!run) return null;
  const names = source.kind === 'run' ? await listRunDir(source.run, 'snapshots', fetchFn) : await recordedManifest(source.run, fetchFn);
  const snapNames = names.map((n) => n.replace(/^snapshots\//, '')).filter((n) => /^(start|epoch-\d{3,6})\.json$/.test(n));
  await Promise.all(
    snapNames.filter((n) => !cache.has(n)).map(async (n) => {
      const s = await orNull(files.json<LoopSnapshot>(`snapshots/${n}`));
      if (s) cache.set(n, s);
    }),
  );
  // A bundle lists its files, so it never asks for one it doesn't have; a run still going can't.
  const may = (f: string) => source.kind === 'run' || names.includes(f);
  const [events, decisions, scene, report] = await Promise.all([
    may('events.jsonl') ? orNull(files.text('events.jsonl')) : null,
    may('decisions.jsonl') ? orNull(files.text('decisions.jsonl')) : null,
    may('scene.jsonl') ? orNull(files.text('scene.jsonl')) : null,
    may('report.json') ? orNull(files.json<LoopReport>('report.json')) : null,
  ]);
  const sceneLines: SceneLine[] = scene ? parseSceneLog(scene.slice(0, scene.lastIndexOf('\n') + 1)) : [];
  return {
    run,
    events: growing<LoopEvent>(events, files.url('events.jsonl')),
    decisions: growing<unknown>(decisions, files.url('decisions.jsonl')),
    snapshots: [...cache.values()],
    scene: sceneLines,
    report,
  };
}
