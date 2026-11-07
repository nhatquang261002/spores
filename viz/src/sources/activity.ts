// Loads the Activity feed for a source and fetches receipts one tx at a time.
//
// LOCAL RUN / RECORDED: the run's two logs, read line by line so a bad line
// becomes a row rather than an error; snapshots give the tubes the decisions'
// D values are checked against. LIVE has no job history (Design §1.7): only
// the close txs in the close list.
import { buildActivity, type Activity, type SaleInfo } from '../model/activity';
import { tubesFromTuples, type PairKey } from '../model/network';
import { receiptFromTx, type Receipt } from '../model/receipts';
import type { Rpc } from '../chain/rpc';
import type { Source } from '../model/types';
import { paletteOf } from '../ui/tokens';
import { fetchOldTx, type SnapshotFile } from './network';
import { recordedFiles, recordedManifest } from './recorded';
import { listRunDir, RunFiles, runFiles, SourceFileError } from './run';

async function optional<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof SourceFileError && e.status === 404) return null;
    throw e;
  }
}

interface RunJson {
  router?: string;
  start_epoch?: number;
  config?: { d_min?: string };
}

export type LogSource = Extract<Source, { kind: 'run' | 'recorded' }>;

export interface RunActivity {
  activity: Activity;
  /** The run wrote its report, so the log won't grow. */
  finished: boolean;
}

/** `cache` keeps snapshots across polls; snapshot files don't change once written. */
export async function loadRunActivity(source: LogSource, fetchFn?: typeof fetch, cache: Map<string, SnapshotFile> = new Map()): Promise<RunActivity> {
  const files: RunFiles = source.kind === 'run' ? runFiles(source.run, fetchFn) : recordedFiles(source.run, fetchFn);
  const [run, decisions, events, report] = await Promise.all([
    files.json<RunJson>('run.json'),
    optional(() => files.text('decisions.jsonl')),
    optional(() => files.text('events.jsonl')),
    optional(() => files.json<{ sale?: SaleInfo | null }>('report.json')),
  ]);
  if (decisions === null && events === null) throw new SourceFileError(files.base, 404, `${source.run} has neither decisions.jsonl nor events.jsonl`);

  const names = source.kind === 'run' ? await listRunDir(source.run, 'snapshots', fetchFn) : await recordedManifest(source.run, fetchFn);
  const snapNames = names.map((n) => n.replace(/^snapshots\//, '')).filter((n) => /^epoch-\d{3,6}\.json$/.test(n));
  await Promise.all(
    snapNames.filter((n) => !cache.has(n)).map(async (n) => {
      cache.set(n, await files.json<SnapshotFile>(`snapshots/${n}`));
    }),
  );

  // Snapshot `epoch-K` was read after the close of K − 1 (S7), so it gives that close's tubes.
  const tubesAt = new Map<number, Map<PairKey, number>>();
  const palettes = new Map<number, number>();
  const dMin = Number(run.config?.d_min ?? 0);
  const snaps = snapNames.map((n) => cache.get(n)!).sort((a, b) => a.epoch_info.epoch - b.epoch_info.epoch);
  for (const s of snaps) {
    tubesAt.set(s.epoch_info.epoch - 1, tubesFromTuples(s.edges, dMin));
    for (const x of Object.values(s.spores)) palettes.set(x.render_input.spore_id, paletteOf(x.render_input.seed).idx);
  }

  const activity = buildActivity({ decisions, events, startEpoch: run.start_epoch ?? null, router: run.router ?? null, sale: report?.sale ?? null, tubesAt, palettes });
  return { activity, finished: report !== null };
}

const CACHE = 'spores.receipt.v1.';

export function cachedReceipt(hash: string): Receipt | null {
  try {
    const hit = localStorage.getItem(CACHE + hash);
    return hit ? (JSON.parse(hit) as Receipt) : null;
  } catch {
    return null;
  }
}

/**
 * A tx's final outcome → receipt. `sender` is the log's best guess at the
 * signer; `router` must be the tx's receiver, so a hash from another contract
 * can't pass for this router's receipt. Final txs never change, so the receipt
 * is kept in localStorage.
 */
export async function fetchReceipt(rpc: Rpc, hash: string, sender: string | null, router: string | null): Promise<Receipt> {
  const tx = await fetchOldTx(rpc, hash, sender ?? router ?? 'unknown');
  const receiver = tx?.transaction?.receiver_id;
  if (router && receiver !== router) throw new Error(`tx ${hash} was sent to ${receiver}, not ${router}`);
  let height: number | null = null;
  const block = tx?.transaction_outcome?.block_hash;
  if (block) {
    try {
      const b = await rpc.call('block', { block_id: block }, rpc.archivalUrls?.length ? rpc.archivalUrls : undefined);
      height = typeof b?.header?.height === 'number' ? b.header.height : null;
    } catch {
      // The height is a nicety: the outcome above is what the receipt confirms.
    }
  }
  const receipt = receiptFromTx(tx, height);
  try {
    localStorage.setItem(CACHE + hash, JSON.stringify(receipt));
  } catch {
    // full or blocked: it is fetched again next time
  }
  return receipt;
}
