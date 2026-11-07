import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { serveRuns } from '../server/runs';
import { listRecorded, recordedFiles } from '../src/sources/recorded';
import { parseJsonl, runFiles } from '../src/sources/run';
import { isRunFile, parseRunPath } from '../src/sources/runFiles';
import { parseSource, shortRouter, sourceLabel, sourceQuery } from '../src/sources/source';

describe('source selection and labels', () => {
  it('defaults to live on the configured router', () => {
    expect(parseSource('', 'r.testnet')).toEqual({ kind: 'live', network: 'testnet', router: 'r.testnet' });
  });
  it('parses run and recorded sources and round-trips the query', () => {
    const run = parseSource('?source=run&run=phase5-exit2');
    expect(run).toEqual({ kind: 'run', run: 'phase5-exit2' });
    expect(parseSource(sourceQuery(run))).toEqual(run);
    const rec = parseSource('?source=recorded&run=demo1&date=2026-11-10');
    expect(rec).toEqual({ kind: 'recorded', run: 'demo1', date: '2026-11-10' });
    expect(parseSource(sourceQuery(rec))).toEqual(rec);
    expect(parseSource('?source=sim')).toEqual({ kind: 'sim' });
  });
  it('refuses unusable sources instead of falling back', () => {
    expect(() => parseSource('?source=run')).toThrow(/needs a run name/);
    expect(() => parseSource('?source=run&run=../x')).toThrow(/needs a run name/);
    expect(() => parseSource('?source=cache')).toThrow(/unknown source/);
  });
  it('labels every source as Design §4.1 says', () => {
    expect(sourceLabel({ kind: 'live', network: 'testnet', router: 'spores-hack-router4.testnet' }).full).toBe('LIVE · testnet');
    expect(sourceLabel({ kind: 'run', run: 'phase5-exit2' }).full).toBe('LOCAL RUN · phase5-exit2');
    expect(sourceLabel({ kind: 'recorded', run: 'demo1', date: '2026-11-10' }).full).toBe('RECORDED · 2026-11-10');
    expect(sourceLabel({ kind: 'sim' }).full).toBe('SIMULATION');
    expect(shortRouter('spores-hack-router4.testnet')).toBe('router4');
  });
});

describe('run files', () => {
  it('allows only the run-log files of Reference C', () => {
    for (const f of ['run.json', 'report.json', 'decisions.jsonl', 'events.jsonl', 'snapshots/epoch-017.json', 'renders/epoch-021-spore-5.png', 'renders/final-spore-63.json'])
      expect(isRunFile(f), f).toBe(true);
    for (const f of ['.env', 'keeper.log', 'control.json', 'outside.jsonl', 'snapshots/../run.json', 'renders/x.png', 'report.md', '../run.json'])
      expect(isRunFile(f), f).toBe(false);
  });
  it('parses /runs/ paths and rejects traversal', () => {
    expect(parseRunPath('')).toEqual({ kind: 'runs' });
    expect(parseRunPath('phase5-exit2/events.jsonl')).toEqual({ kind: 'file', run: 'phase5-exit2', file: 'events.jsonl' });
    expect(parseRunPath('phase5-exit2/snapshots/')).toEqual({ kind: 'dir', run: 'phase5-exit2', dir: 'snapshots' });
    for (const p of ['..%2F..%2F.env', '../.env', 'a/../../.env', 'a/.env', 'a%5Crun.json', '%E0%A4%A', '.hidden/run.json', 'a/snapshots/../../x'])
      expect(parseRunPath(p), p).toBeNull();
  });

  it('serves allowed files only, from inside out/agents (symlinks included)', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'viz-runs-'));
    const out = path.join(tmp, 'out', 'agents');
    mkdirSync(path.join(out, 'r1', 'snapshots'), { recursive: true });
    writeFileSync(path.join(out, 'r1', 'run.json'), '{"run":"r1"}');
    writeFileSync(path.join(out, 'r1', 'snapshots', 'epoch-001.json'), '{}');
    writeFileSync(path.join(out, 'r1', 'snapshots', 'notes.txt'), 'x');
    writeFileSync(path.join(out, 'r1', 'keeper.log'), 'log');
    mkdirSync(path.join(out, 'no-run-json'));
    writeFileSync(path.join(tmp, 'outside.json'), '{"leak":true}');
    mkdirSync(path.join(out, 'r2'));
    writeFileSync(path.join(out, 'r2', 'run.json'), '{}');
    symlinkSync(path.join(tmp, 'outside.json'), path.join(out, 'r2', 'report.json'));

    expect(JSON.parse(String((await serveRuns(out, '')).body))).toEqual(['r1', 'r2']);
    const run = await serveRuns(out, 'r1/run.json');
    expect([run.status, String(run.body), run.type]).toEqual([200, '{"run":"r1"}', 'application/json; charset=utf-8']);
    expect(JSON.parse(String((await serveRuns(out, 'r1/snapshots/')).body))).toEqual(['epoch-001.json']);
    expect((await serveRuns(out, 'r1/keeper.log')).status).toBe(404);
    expect((await serveRuns(out, 'r1/report.json')).status).toBe(404);
    expect((await serveRuns(out, 'r2/report.json')).status).toBe(404);
    expect((await serveRuns(out, 'r1/../../outside.json')).status).toBe(404);
    expect(JSON.parse(String((await serveRuns(path.join(tmp, 'missing'), '')).body))).toEqual([]);
  });

  it('reads JSON lines and names the bad line', async () => {
    expect(parseJsonl('{"a":1}\n\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(() => parseJsonl('{"a":1}\nnope', 'events.jsonl')).toThrow('events.jsonl: line 2 is not JSON');
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(url);
      return new Response('{"x":1}\n');
    }) as unknown as typeof fetch;
    expect(await runFiles('phase5-exit2', f).jsonl('events.jsonl')).toEqual([{ x: 1 }]);
    expect(seen).toEqual(['/runs/phase5-exit2/events.jsonl']);
    expect(() => runFiles('r', f).url('.env')).toThrow(/not a run file/);
  });

  it('a missing file is an error, and no recorded index is an empty list', async () => {
    const f404 = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(runFiles('r', f404).json('run.json')).rejects.toThrow('/runs/r/run.json: http 404');
    expect(await listRecorded(f404)).toEqual([]);
    await expect(recordedFiles('demo', f404).json('report.json')).rejects.toThrow('/recorded/demo/report.json: http 404');
  });
});
