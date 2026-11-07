// Loads the gallery from the current source. LIVE reads the bulk views only
// (Design §10: `nft_tokens` paged by 16, `edges`, `epoch_info`), with no
// per-spore calls. LOCAL RUN and RECORDED read the run's last epoch snapshot.
// Failures are errors; nothing falls back to another source.
import type { Router } from '../chain/router';
import { galleryFromLive, galleryFromSnapshot, type Gallery, type RunSnapshot } from '../model/gallery';
import type { Source } from '../model/types';
import { listRunDir, runFiles } from './run';
import { recordedFiles, recordedManifest } from './recorded';

/**
 * Tubes, age and state hashes change only at a close, so the reads are
 * bracketed by `epoch_info`: if an epoch closed in between, read again.
 */
export async function loadLiveGallery(router: Router, attempts = 3): Promise<Gallery> {
  for (let i = 0; i < attempts; i++) {
    const before = await router.epochInfo();
    const [tokens, edges] = await Promise.all([router.allTokens(16), router.edges()]);
    const after = await router.epochInfo();
    if (before.epoch === after.epoch) return galleryFromLive(after, tokens, edges, Date.now());
  }
  throw new Error(`an epoch closed during each of ${attempts} reads of the collection; retry`);
}

/** The highest `snapshots/epoch-NNN.json` among `names` (relative to the run or to snapshots/). */
export function lastSnapshot(names: string[]): string | null {
  const snaps = names.map((n) => n.replace(/^snapshots\//, '')).filter((n) => /^epoch-\d{3,6}\.json$/.test(n));
  if (!snaps.length) return null;
  return snaps.reduce((a, b) => (Number(b.slice(6, -5)) > Number(a.slice(6, -5)) ? b : a));
}

/** The run's last epoch snapshot (Reference C). */
export async function loadLastSnapshot(source: Extract<Source, { kind: 'run' | 'recorded' }>, fetchFn?: typeof fetch): Promise<RunSnapshot> {
  const names = source.kind === 'run' ? await listRunDir(source.run, 'snapshots', fetchFn) : await recordedManifest(source.run, fetchFn);
  const last = lastSnapshot(names);
  if (!last) throw new Error(`${source.run} has no epoch snapshots (snapshots/epoch-NNN.json)`);
  const files = source.kind === 'run' ? runFiles(source.run, fetchFn) : recordedFiles(source.run, fetchFn);
  return files.json<RunSnapshot>(`snapshots/${last}`);
}

export async function loadSnapshotGallery(source: Extract<Source, { kind: 'run' | 'recorded' }>, fetchFn?: typeof fetch): Promise<Gallery> {
  return galleryFromSnapshot(await loadLastSnapshot(source, fetchFn), Date.now());
}
