// Vite dev-server middleware: serves local run logs from out/agents/ read-only
// under /runs/ (LOCAL RUN source). Only the files in src/sources/runFiles.ts;
// never .env, agent logs or any path outside out/agents/ (symlinks included).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { RUN_NAME, isRunFile, parseRunPath } from '../src/sources/runFiles.ts';

const TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.png': 'image/png',
};

type Reply = { status: number; type: string; body: string | Buffer };
const json = (v: unknown): Reply => ({ status: 200, type: TYPES['.json'], body: JSON.stringify(v) });
const notFound: Reply = { status: 404, type: 'text/plain; charset=utf-8', body: 'not found' };

/** The real path of `p` if it exists and lies inside `root` (itself a real path). */
async function inside(root: string, p: string): Promise<string | null> {
  try {
    const real = await fs.realpath(p);
    return real === root || real.startsWith(root + path.sep) ? real : null;
  } catch {
    return null;
  }
}

/** Answers one GET under /runs/ (`urlPath` is what follows `/runs/`). Exported for tests. */
export async function serveRuns(outAgents: string, urlPath: string): Promise<Reply> {
  const req = parseRunPath(urlPath.split('?')[0]);
  if (!req) return notFound;
  let root: string;
  try {
    root = await fs.realpath(outAgents);
  } catch {
    return req.kind === 'runs' ? json([]) : notFound;
  }
  if (req.kind === 'runs') {
    const names: string[] = [];
    for (const d of await fs.readdir(root, { withFileTypes: true })) {
      if (!d.isDirectory() || !RUN_NAME.test(d.name)) continue;
      if (await inside(root, path.join(root, d.name, 'run.json'))) names.push(d.name);
    }
    return json(names.sort());
  }
  const runDir = await inside(root, path.join(root, req.run));
  if (!runDir) return notFound;
  if (req.kind === 'dir') {
    const dir = await inside(root, path.join(runDir, req.dir));
    if (!dir) return json([]);
    const files = (await fs.readdir(dir)).filter((f) => isRunFile(`${req.dir}/${f}`)).sort();
    return json(files);
  }
  const file = await inside(root, path.join(runDir, req.file));
  if (!file) return notFound;
  if (!(await fs.stat(file)).isFile()) return notFound;
  return { status: 200, type: TYPES[path.extname(file)] ?? 'application/octet-stream', body: await fs.readFile(file) };
}

/** Serves `outAgents` (normally <repo>/out/agents) under /runs/ in `vite` and `vite preview`. */
export function runsPlugin(outAgents: string): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/runs/')) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      return res.end();
    }
    try {
      const r = await serveRuns(outAgents, req.url.slice('/runs/'.length));
      res.statusCode = r.status;
      res.setHeader('content-type', r.type);
      res.setHeader('cache-control', 'no-store');
      res.end(req.method === 'HEAD' ? undefined : r.body);
    } catch (e) {
      res.statusCode = 500;
      res.end(String((e as Error)?.message ?? e));
    }
  };
  return {
    name: 'spores-runs',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
