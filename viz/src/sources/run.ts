// LOCAL RUN source: a run directory in out/agents/<run>/, served read-only by
// the dev server under /runs/ (server/runs.ts). Missing files are errors, not
// empty data.
import { isRunFile } from './runFiles';

export class SourceFileError extends Error {
  readonly url: string;
  readonly status: number;
  constructor(url: string, status: number, message: string) {
    super(message);
    this.name = 'SourceFileError';
    this.url = url;
    this.status = status;
  }
}

export const isHtml = (res: Response) => /text\/html/i.test(res.headers.get('content-type') ?? '');

/** Reads the allowed files of one run (or recorded bundle) under `base`. */
export class RunFiles {
  readonly base: string;
  private readonly fetchFn: typeof fetch;
  constructor(base: string, fetchFn: typeof fetch = (...a) => fetch(...a)) {
    this.base = base.endsWith('/') ? base : base + '/';
    this.fetchFn = fetchFn;
  }

  url(file: string): string {
    if (!isRunFile(file)) throw new Error(`not a run file: ${file}`);
    return this.base + file;
  }

  async text(file: string): Promise<string> {
    const url = this.url(file);
    const res = await this.fetchFn(url);
    if (!res.ok) throw new SourceFileError(url, res.status, `${url}: http ${res.status}`);
    // A static host answers a missing file with the app's index.html and a 200. No run file is HTML.
    if (isHtml(res)) throw new SourceFileError(url, 404, `${url}: http 404 (the host sent its HTML page instead)`);
    return res.text();
  }

  async json<T = unknown>(file: string): Promise<T> {
    return JSON.parse(await this.text(file)) as T;
  }

  /** JSON lines; a line that does not parse is an error naming its line number. */
  async jsonl<T = unknown>(file: string): Promise<T[]> {
    return parseJsonl<T>(await this.text(file), this.url(file));
  }
}

export function parseJsonl<T = unknown>(text: string, where = 'jsonl'): T[] {
  const out: T[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      throw new Error(`${where}: line ${i + 1} is not JSON`);
    }
  });
  return out;
}

/** Runs the dev server can serve (directories in out/agents/ with a run.json). */
export async function listRuns(fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<string[]> {
  const res = await fetchFn('/runs/');
  if (!res.ok) throw new SourceFileError('/runs/', res.status, `/runs/: http ${res.status} (local runs need the dev server)`);
  return res.json();
}

export function runFiles(run: string, fetchFn?: typeof fetch): RunFiles {
  return new RunFiles(`/runs/${encodeURIComponent(run)}/`, fetchFn);
}

/** `snapshots/` or `renders/` file names of a local run. */
export async function listRunDir(run: string, dir: 'snapshots' | 'renders', fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<string[]> {
  const url = `/runs/${encodeURIComponent(run)}/${dir}/`;
  const res = await fetchFn(url);
  if (!res.ok) throw new SourceFileError(url, res.status, `${url}: http ${res.status}`);
  return res.json();
}
