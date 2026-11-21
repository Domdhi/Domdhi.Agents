// AC→source map (L1H, wave-L1 review C1 part 2 — the library writers the unsandboxed hooks call):
//   - jsonl-writer.appendJsonl: a symlinked ancestor or leaf is refused with ONE stderr line, never thrown into the
//     caller, never written through (the target stays unchanged / empty), onError still hears of it
//   - DailyLog capture / captureNote / captureCommit: a symlinked ancestor or leaf throws an error that is a
//     refusal fs-safe recognizes (so a hook can warn and skip) and writes nothing through the link
//   - MemoryManager: the constructor creates no directory inside a symlinked state folder, initDb refuses a
//     symlinked database file / sidecar / ancestor (falls back to JSON-only), the rebuild status is not written through
//   - memory-sync saveBase and memory-recall syncIndex / withFallback: no write through a symlinked state folder
//   NOT COVERED: memory-capture.js's ledger/candidate writeAtomic delegate (the same safeWriteAtomic call, proved in
//   fs-safe-state.test.js; the CLI run needs a model provider fixture).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

const { appendJsonl } = require('../../../.agents/core/_lib/jsonl-writer');
const DailyLog = require('../../../.agents/core/daily-log');
const MemoryManager = require('../../../.agents/core/memory-manager');
const sync = require('../../../.agents/core/_lib/memory-sync');
const R = require('../../../.agents/core/_lib/memory-recall');
const { isRefusal } = require('../../../.agents/core/_lib/fs-safe');
const { createTmpDir } = require('./_helpers/tmp-dir');
const { startEmbedServer } = require('./_helpers/memory-fakes');

const canSymlink = (() => {
  const probeDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'symlink-probe-'));
  try {
    fs.writeFileSync(path.join(probeDir, 't.txt'), 'x');
    fs.symlinkSync(path.join(probeDir, 't.txt'), path.join(probeDir, 'l.txt'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

const hasSqlite = (() => {
  try {
    const { resolveSqliteBackend } = require('../../../.agents/core/_lib/sqlite-backend');
    return resolveSqliteBackend().DatabaseSync !== null;
  } catch {
    return false;
  }
})();

const CONTEXT = ['AGENT_SHARED_STATE_ROOT', 'AGENTS_PROJECT_DIR', 'AGENT_SOURCE_ROOT', 'CODEX_PROJECT_DIR', 'CLAUDE_PROJECT_DIR'];
const saved = {};
let tmp, project, state, victimDir, victimFile, stderrSpy;

const listing = dir => fs.readdirSync(dir).sort();
const refusalLines = () => stderrSpy.mock.calls.map(([chunk]) => String(chunk)).filter(line => line.startsWith('[fs-safe]'));
const today = () => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  for (const key of CONTEXT) { saved[key] = process.env[key]; delete process.env[key]; }
  tmp = createTmpDir({ prefix: 'state-writers-symlink-' });
  project = path.join(tmp.root, 'project');
  state = path.join(project, 'docs', '.output', '.state');
  fs.mkdirSync(state, { recursive: true });
  victimDir = path.join(tmp.root, 'victim-dir');
  fs.mkdirSync(victimDir);
  victimFile = path.join(tmp.root, 'victim.txt');
  fs.writeFileSync(victimFile, 'VICTIM-CONTENT');
  process.env.CLAUDE_PROJECT_DIR = project;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of CONTEXT) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  tmp.cleanup();
});

describe.skipIf(!canSymlink)('jsonl-writer.appendJsonl', () => {
  it('writes into a symlinked telemetry folder NOTHING, reports once, and does not throw', () => {
    fs.symlinkSync(victimDir, path.join(state, 'telemetry'), 'dir');
    const errors = [];

    expect(() => appendJsonl(path.join(state, 'telemetry', 'x.jsonl'), { n: 1 }, { onError: m => errors.push(m) })).not.toThrow();

    expect(listing(victimDir)).toEqual([]);
    expect(refusalLines()).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/symlinked ancestor/);
  });

  it('writes into a symlinked state folder nothing (the whole .state link)', () => {
    fs.rmSync(state, { recursive: true });
    fs.symlinkSync(victimDir, state, 'dir');

    appendJsonl(path.join(state, 'telemetry', 'x.jsonl'), { n: 1 });

    expect(listing(victimDir)).toEqual([]);
  });

  it('never appends through a symlinked leaf', () => {
    fs.mkdirSync(path.join(state, 'telemetry'));
    fs.symlinkSync(victimFile, path.join(state, 'telemetry', 'x.jsonl'));

    appendJsonl(path.join(state, 'telemetry', 'x.jsonl'), { n: 1 });

    expect(fs.readFileSync(victimFile, 'utf8')).toBe('VICTIM-CONTENT');
    expect(refusalLines()).toHaveLength(1);
  });

  it('honours an explicit containRoot for a path with no docs/.output segment', () => {
    const root = path.join(tmp.root, 'plain');
    fs.mkdirSync(root);
    fs.symlinkSync(victimDir, path.join(root, 'logs'), 'dir');

    appendJsonl(path.join(root, 'logs', 'x.jsonl'), { n: 1 }, { containRoot: root });

    expect(listing(victimDir)).toEqual([]);
  });

  it('control: a real tree appends and rotates exactly as before', () => {
    const file = path.join(state, 'telemetry', 'x.jsonl');
    for (let i = 0; i < 11; i++) appendJsonl(file, { n: i }, { maxLines: 10, tailKeep: 5 });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(5);
    expect(JSON.parse(lines[4])).toEqual({ n: 10 });
    expect(refusalLines()).toEqual([]);
  });
});

describe.skipIf(!canSymlink)('DailyLog', () => {
  const writers = [
    ['capture', log => log.capture('manual')],
    ['captureNote', log => log.captureNote('a note')],
    ['captureCommit', log => log.captureCommit('1a2b3c4d', 'subject', 1)],
  ];

  for (const [name, write] of writers) {
    it(`${name}: a symlinked state folder throws a refusal and creates nothing in the target`, () => {
      fs.rmSync(state, { recursive: true });
      fs.symlinkSync(victimDir, state, 'dir');
      let caught;
      try { write(new DailyLog(project)); } catch (error) { caught = error; }
      expect(isRefusal(caught)).toBe(true);
      expect(listing(victimDir)).toEqual([]);
    });

    it(`${name}: a symlinked daily-log file throws a refusal and the target is unchanged`, () => {
      fs.mkdirSync(path.join(state, 'memory-daily'));
      fs.symlinkSync(victimFile, path.join(state, 'memory-daily', `${today()}.md`));
      let caught;
      try { write(new DailyLog(project)); } catch (error) { caught = error; }
      expect(isRefusal(caught)).toBe(true);
      expect(fs.readFileSync(victimFile, 'utf8')).toBe('VICTIM-CONTENT');
    });

    it(`${name}: control, a real tree appends one entry`, () => {
      const { logPath } = write(new DailyLog(project));
      expect(logPath).toBe(path.join(state, 'memory-daily', `${today()}.md`));
      expect(fs.readFileSync(logPath, 'utf8').split('\n## ').length).toBeGreaterThanOrEqual(1);
      expect(fs.readFileSync(logPath, 'utf8')).toMatch(/^## \d\d:\d\d/);
    });
  }
});

describe.skipIf(!canSymlink)('MemoryManager', () => {
  it('creates no directory inside a symlinked state folder', () => {
    fs.rmSync(state, { recursive: true });
    fs.symlinkSync(victimDir, state, 'dir');

    expect(() => new MemoryManager()).not.toThrow();

    expect(listing(victimDir)).toEqual([]);
    expect(refusalLines().some(line => /symlinked ancestor/.test(line))).toBe(true);
  });

  it.skipIf(!hasSqlite)('initDb refuses a symlinked database file, a symlinked sidecar and a symlinked index folder', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.mkdirSync(path.join(state, 'memory-index'), { recursive: true });
    const db = path.join(state, 'memory-index', 'memories.db');

    fs.symlinkSync(victimFile, db);
    expect(new MemoryManager().initDb()).toBe(false);
    expect(fs.readFileSync(victimFile, 'utf8')).toBe('VICTIM-CONTENT');
    expect(errors.mock.calls.some(([message, detail]) => /SQLite init failed/.test(message) && /symlink/.test(detail))).toBe(true);
    fs.unlinkSync(db);

    fs.symlinkSync(victimFile, `${db}-journal`);
    expect(new MemoryManager().initDb()).toBe(false);
    expect(fs.readFileSync(victimFile, 'utf8')).toBe('VICTIM-CONTENT');
    fs.unlinkSync(`${db}-journal`);

    fs.rmSync(path.join(state, 'memory-index'), { recursive: true });
    fs.symlinkSync(victimDir, path.join(state, 'memory-index'), 'dir');
    expect(new MemoryManager().initDb()).toBe(false);
    expect(listing(victimDir)).toEqual([]);
  });

  it.skipIf(!hasSqlite)('control: a real tree opens the database', () => {
    const manager = new MemoryManager();
    try {
      expect(manager.initDb()).toBe(true);
      expect(fs.existsSync(path.join(state, 'memory-index', 'memories.db'))).toBe(true);
    } finally {
      if (manager.db) manager.db.close();
    }
  });

  it('does not write the rebuild status through a symlinked index folder', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.symlinkSync(victimDir, path.join(state, 'memory-index'), 'dir');
    const manager = new MemoryManager();

    await manager._writeRebuildStatus(0, []);

    expect(listing(victimDir)).toEqual([]);
    expect(errors.mock.calls.some(([message]) => /could not write rebuild status/.test(message))).toBe(true);
  });
});

describe.skipIf(!canSymlink)('memory-sync and memory-recall state writes', () => {
  const servers = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map(s => s.close())); });

  it('saveBase refuses a symlinked state folder and displaces (never follows) a symlinked sync.json', () => {
    const stateDir = path.join(state, 'memory-notes');
    fs.rmSync(state, { recursive: true });
    fs.symlinkSync(victimDir, state, 'dir');
    let caught;
    try { sync.saveBase(stateDir, { a: 'x' }); } catch (error) { caught = error; }
    expect(isRefusal(caught)).toBe(true);
    expect(listing(victimDir)).toEqual([]);

    fs.unlinkSync(state);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.symlinkSync(victimFile, path.join(stateDir, 'sync.json'));
    sync.saveBase(stateDir, { a: 'x' });
    expect(fs.readFileSync(victimFile, 'utf8')).toBe('VICTIM-CONTENT');
    expect(sync.loadBase(stateDir)).toEqual({ a: 'x' });
  });

  it('syncIndex refuses to write the vector index into a symlinked state folder', async () => {
    const s = await startEmbedServer();
    servers.push(s);
    const cfg = R.embedConfig({ MEMORY_EMBED_PROVIDER: 'openai', MEMORY_EMBED_URL: `${s.url}/v1`, MEMORY_EMBED_MODEL: 'test-embed' });
    const corpus = { doc: { text: 'Mint Mobile plan', sha: 'abc', body: 'x', name: 'doc' } };
    const stateDir = path.join(state, 'memory-notes');
    fs.rmSync(state, { recursive: true });
    fs.symlinkSync(victimDir, state, 'dir');

    await expect(R.syncIndex(corpus, stateDir, cfg)).rejects.toMatchObject({ fsSafeRefusal: true });

    expect(listing(victimDir)).toEqual([]);
  });

  it('withFallback marks a failed server in a symlinked state folder nowhere, and still answers', async () => {
    const hostsFile = path.join(state, 'memory-notes', 'embed-hosts.json');
    fs.rmSync(state, { recursive: true });
    fs.symlinkSync(victimDir, state, 'dir');
    const call = async url => { if (url === 'http://a.invalid') throw new Error('down'); return 'ok'; };

    const out = await R.withFallback(['http://a.invalid', 'http://b.invalid'], call, { timeoutMs: 1000, hostsFile });

    expect(out).toBe('ok');
    expect(listing(victimDir)).toEqual([]);
  });
});
