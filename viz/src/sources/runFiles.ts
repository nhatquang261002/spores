// The run-log files a view may read (docs/phase6-plan.md Reference C), shared
// by the dev-server middleware (server/runs.ts), the LOCAL RUN source and the
// RECORDED bundle. Anything else in a run directory (agent logs, control.json,
// outside.jsonl) and anything outside out/agents/ is never served.

export const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const FILES = [
  /^run\.json$/,
  /^report\.json$/,
  /^decisions\.jsonl$/,
  /^events\.jsonl$/,
  /^scene\.jsonl$/,
  /^snapshots\/(start|epoch-\d{3,6})\.json$/,
  /^renders\/[A-Za-z0-9_-]{1,64}-spore-\d{1,3}\.(png|json)$/,
];

/** True for a file path (relative to the run directory) that may be read. */
export function isRunFile(rel: string): boolean {
  return FILES.some((re) => re.test(rel));
}

export type RunRequest =
  | { kind: 'runs' }
  | { kind: 'dir'; run: string; dir: 'snapshots' | 'renders' }
  | { kind: 'file'; run: string; file: string };

/**
 * Parses a path under `/runs/` (already stripped of the prefix and query):
 * `` → list of runs, `<run>/snapshots/` or `<run>/renders/` → list of files,
 * `<run>/<file>` → one allowed file. Anything else is null (404).
 */
export function parseRunPath(path: string): RunRequest | null {
  let p: string;
  try {
    p = decodeURIComponent(path);
  } catch {
    return null;
  }
  p = p.replace(/^\/+/, '');
  if (p === '') return { kind: 'runs' };
  if (p.includes('\\') || p.includes('\0')) return null;
  const slash = p.indexOf('/');
  if (slash < 0) return null;
  const run = p.slice(0, slash);
  const rest = p.slice(slash + 1);
  if (!RUN_NAME.test(run) || run.includes('..')) return null;
  if (rest === 'snapshots/' || rest === 'renders/') return { kind: 'dir', run, dir: rest.slice(0, -1) as 'snapshots' | 'renders' };
  return isRunFile(rest) ? { kind: 'file', run, file: rest } : null;
}
