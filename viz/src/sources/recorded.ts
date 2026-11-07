// RECORDED source: a committed bundle in viz/public/recorded/<run>/ with the
// same file names as a run directory. Static hosting can't list directories,
// so each bundle has files.json (relative paths) and the bundles are listed in
// recorded/index.json. `node agents/src/record-scene.ts <run>` makes a scene's bundle (S11), `bash scripts/record-bundle.sh <run>` a whole run's (S13).
import { isHtml, RunFiles, SourceFileError } from './run';
import type { WashData } from '../model/wash';
import { RUN_NAME } from './runFiles';

export interface RecordedBundle {
  run: string;
  /** Date of the run, as shown in the RECORDED badge. */
  date: string;
  /** The Demo Lab page it plays on: `rogue` or `sale` (a scene log), `loop` (a whole run). */
  scene?: string;
}

/** Bundles in this build. No index (no bundle committed yet) is an empty list, not an error. */
export async function listRecorded(fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<RecordedBundle[]> {
  const res = await fetchFn('/recorded/index.json');
  if (res.status === 404 || isHtml(res)) return [];
  if (!res.ok) throw new SourceFileError('/recorded/index.json', res.status, `/recorded/index.json: http ${res.status}`);
  const list = (await res.json()) as RecordedBundle[];
  return list.filter((b) => RUN_NAME.test(b.run));
}

export function recordedFiles(run: string, fetchFn?: typeof fetch): RunFiles {
  if (!RUN_NAME.test(run)) throw new Error(`bad recorded run name: ${run}`);
  return new RunFiles(`/recorded/${run}/`, fetchFn);
}

/** The bundle's files.json. */
export async function recordedManifest(run: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<string[]> {
  const url = `/recorded/${run}/files.json`;
  const res = await fetchFn(url);
  if (!res.ok) throw new SourceFileError(url, res.status, `${url}: http ${res.status}`);
  if (isHtml(res)) throw new SourceFileError(url, 404, `${url}: http 404 (the host sent its HTML page instead)`);
  return res.json();
}

/** The wash panel's data: a committed copy of `spores-sim wash`. A missing file is an error naming it, never an empty panel. */
export async function washData(fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<WashData> {
  const url = '/recorded/sim/wash.json';
  const res = await fetchFn(url);
  if (!res.ok) throw new SourceFileError(url, res.status, `${url}: http ${res.status}`);
  if (isHtml(res)) throw new SourceFileError(url, 404, `${url}: http 404 (the host sent its HTML page instead)`);
  return res.json();
}
