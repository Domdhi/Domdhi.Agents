// AC→source: memory-health-check.js — validates the memory system's index
// freshness (derived FTS5 db vs tracked JSON source, mirroring the
// session-start-prime self-heal criterion), inbox backlog, search backend,
// write/search perf, quality metrics (confidence / usage), and update recency,
// aggregating into results.{passed,warnings,errors} and a boolean
// runHealthCheck() verdict (healthy iff no errors).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const MemoryHealthChecker = require('../../../.agents/core/memory-health-check');
const MemoryManager = require('../../../.agents/core/memory-manager');
const CONSTANTS = require('../../../.agents/core/constants');
const { createTmpDir } = require('./_helpers/tmp-dir');

const CATEGORIES = Object.values(CONSTANTS.MEMORY_CATEGORIES);

// Inline hand-created-memory writer (mirrors the shape createMemory() writes:
// top-level usage_count/updated, metadata.confidence) — no shared fixture
// exists for this shape (see memory-promoter.test.js's own copy of the idea).
function writeHandCreatedMemory(tmp, category, slug, opts = {}) {
  const now = new Date().toISOString();
  const memory = {
    id: slug,
    type: opts.type || 'pattern',
    category,
    created: opts.created || now,
    updated: opts.updated || now,
    usage_count: opts.usage_count ?? 0,
    content: { description: opts.description || `${slug} description` },
    metadata: { sessions: [], agents: [], confidence: opts.confidence ?? 1.0 },
  };
  return tmp.write(
    path.join('docs', '.output', '.memory', category, `${slug}.json`),
    JSON.stringify(memory, null, 2)
  );
}

let tmp;
let originalEnv;
let checker;

function silenceConsole() {
  return vi.spyOn(console, 'log').mockImplementation(() => {});
}

beforeEach(() => {
  tmp = createTmpDir({ prefix: 'memory-health-check-test-' });
  originalEnv = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = tmp.root;
});

afterEach(() => {
  if (checker?.manager?.db) {
    try { checker.manager.db.close(); } catch { /* non-fatal */ }
    checker.manager.db = null;
  }
  checker = undefined;
  if (originalEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = originalEnv;
  tmp.cleanup();
});

describe('MemoryHealthChecker construction', () => {
  it('loads without side effects and exports MemoryHealthChecker', () => {
    expect(MemoryHealthChecker).toBeDefined();
    expect(typeof MemoryHealthChecker).toBe('function');
  });

  it('can be instantiated without throwing, with empty results buckets', () => {
    checker = new MemoryHealthChecker();
    expect(checker).toBeDefined();
    expect(checker.results).toEqual({ passed: [], warnings: [], errors: [] });
  });

  it('self-heals the category directories on construction (via MemoryManager.ensureDirs)', () => {
    checker = new MemoryHealthChecker();
    const fs = require('node:fs');
    for (const category of CATEGORIES) {
      expect(fs.existsSync(path.join(tmp.root, 'docs', '.output', '.memory', category))).toBe(true);
    }
  });
});

describe('checkIndexFreshness', () => {
  const dbRelPath = path.join('docs', '.output', '.state', 'memory-index', 'memories.db');

  it('passes as "store empty" when there is no curated JSON at all', async () => {
    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    await checker.checkIndexFreshness();
    logSpy.mockRestore();
    expect(checker.results.warnings).toEqual([]);
    expect(checker.results.passed.some((p) => /store empty/.test(p))).toBe(true);
  });

  it('warns "index absent" when JSON exists but the db was never built (fresh clone)', async () => {
    writeHandCreatedMemory(tmp, CATEGORIES[0], 'some-memory');
    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    await checker.checkIndexFreshness();
    logSpy.mockRestore();
    expect(checker.results.errors).toEqual([]); // self-healing → WARN, never ERROR
    expect(checker.results.warnings.some((w) => /index absent/.test(w))).toBe(true);
  });

  it('warns "STALE" when curated JSON is newer than the db (post-git-pull state)', async () => {
    const fs = require('node:fs');
    const dbPath = tmp.write(dbRelPath, 'not-a-real-db');
    const past = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(dbPath, past, past);
    writeHandCreatedMemory(tmp, CATEGORIES[0], 'newer-memory');

    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    await checker.checkIndexFreshness();
    logSpy.mockRestore();
    expect(checker.results.warnings.some((w) => /STALE/.test(w))).toBe(true);
  });

  // NA5.13 — newer-than-JSON is necessary but not sufficient: the index must also
  // describe the store (shared _lib/memory-index-divergence.js, read-only open).
  const fsNode = require('node:fs');
  const future = () => new Date(Date.now() + 60 * 1000);
  async function buildIndex(ids) {
    const manager = new MemoryManager();
    for (const id of ids) await manager.createMemory(CATEGORIES[0], id, { description: `${id} lesson` });
    manager.db.close();
    manager.db = null;
  }
  const memoryFile = (id) => path.join(tmp.root, 'docs', '.output', '.memory', CATEGORIES[0], `${id}.json`);
  async function runFreshness() {
    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    await checker.checkIndexFreshness();
    logSpy.mockRestore();
  }

  it.each(['last-file', 'store'])('R2_health_emptyStore_%s_warnsAboutOrphanedLiveRows', async mode => {
    await buildIndex(['last-live']);
    if (mode === 'last-file') fsNode.unlinkSync(memoryFile('last-live'));
    else fsNode.rmSync(path.join(tmp.root, 'docs', '.output', '.memory'), { recursive: true, force: true });
    await runFreshness();
    expect(checker.results.warnings).toEqual([expect.stringMatching(/1 orphaned row\(s\)/)]);
    expect(checker.results.passed.some(p => /store empty|index fresh/.test(p))).toBe(false);
  });

  it.each(['{broken', 'null'])('R1_health_badSource_%s_reportsTheFileInsteadOfCertifyingFreshness', async raw => {
    await buildIndex(['damaged']);
    fsNode.writeFileSync(memoryFile('damaged'), raw);
    fsNode.utimesSync(path.join(tmp.root, dbRelPath), future(), future());
    await runFreshness();
    expect(checker.results.errors.some(e => e.includes(`${CATEGORIES[0]}/damaged.json`))).toBe(true);
    expect(checker.results.passed.some(p => /index fresh/.test(p))).toBe(false);
  });

  it('R1_health_categoryEnumerationFailure_reportsIncompleteSourceSnapshot', async () => {
    await buildIndex(['kept']);
    const original = fsNode.promises.readdir;
    const spy = vi.spyOn(fsNode.promises, 'readdir').mockImplementation((dir, ...args) => {
      if (String(dir) === path.dirname(memoryFile('kept'))) return Promise.reject(Object.assign(new Error('category denied'), { code: 'EACCES' }));
      return original(dir, ...args);
    });
    try { await runFreshness(); } finally { spy.mockRestore(); }
    expect(checker.results.errors.some(e => e.includes(`${CATEGORIES[0]}/`) && /category denied|EACCES/.test(e))).toBe(true);
    expect(checker.results.passed.some(p => /store empty|index fresh/.test(p))).toBe(false);
  });

  it('passes when the db is newer than every JSON file and holds every record', async () => {
    await buildIndex(['older-memory', 'second-memory']);
    fsNode.utimesSync(path.join(tmp.root, dbRelPath), future(), future());

    await runFreshness();

    expect(checker.results.warnings).toEqual([]);
    expect(checker.results.errors).toEqual([]);
    expect(checker.results.passed.some((p) => /index fresh/.test(p))).toBe(true);
  });

  it('warns DIVERGED when a newer db is missing a live record (partial index)', async () => {
    await buildIndex(['indexed-memory']);
    writeHandCreatedMemory(tmp, CATEGORIES[0], 'unindexed-memory');
    fsNode.utimesSync(path.join(tmp.root, dbRelPath), future(), future());

    await runFreshness();

    expect(checker.results.errors).toEqual([]);
    expect(checker.results.passed.some((p) => /index fresh/.test(p))).toBe(false);
    expect(checker.results.warnings).toHaveLength(1);
    expect(checker.results.warnings[0]).toMatch(/DIVERGED/);
    expect(checker.results.warnings[0]).toContain('1 live record(s) missing');
  });

  it('warns DIVERGED when a newer db still lists a retired record as live (stale eligibility)', async () => {
    await buildIndex(['kept-memory', 'retired-memory']);
    const retired = JSON.parse(fsNode.readFileSync(memoryFile('retired-memory'), 'utf8'));
    retired.invalid_at = '2026-10-09T00:00:00.000Z';
    fsNode.writeFileSync(memoryFile('retired-memory'), JSON.stringify(retired, null, 2));
    fsNode.utimesSync(path.join(tmp.root, dbRelPath), future(), future());

    await runFreshness();

    expect(checker.results.warnings).toHaveLength(1);
    expect(checker.results.warnings[0]).toContain('1 with stale eligibility');
  });

  it('reports a record the last rebuild could not index as an ERROR', async () => {
    await buildIndex(['good-memory']);
    fsNode.writeFileSync(memoryFile('no-created'), JSON.stringify({ id: 'no-created', type: 'pattern', category: CATEGORIES[0], content: { description: 'missing created' }, metadata: { confidence: 1 } }, null, 2));
    const past = new Date(Date.now() - 60 * 60 * 1000);
    fsNode.utimesSync(memoryFile('no-created'), past, past);
    fsNode.utimesSync(memoryFile('good-memory'), past, past);
    const manager = new MemoryManager();
    await manager.rebuildIndex();
    manager.db.close();
    manager.db = null;

    await runFreshness();

    expect(checker.results.errors).toHaveLength(1);
    expect(checker.results.errors[0]).toContain(`${CATEGORIES[0]}/no-created.json`);
    expect(checker.results.warnings).toEqual([]);
  });

  it('waits out a concurrent writer lock instead of reporting the index unreadable', async () => {
    await buildIndex(['locked-memory']);
    const dbFile = path.join(tmp.root, dbRelPath);
    fsNode.utimesSync(dbFile, future(), future());
    const marker = path.join(tmp.root, 'locked.txt');
    // Another process holds an EXCLUSIVE lock for ~1.5 s (a rebuild commit's window).
    const holder = require('node:child_process').spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(dbFile)});
      db.exec('BEGIN EXCLUSIVE');
      require('fs').writeFileSync(${JSON.stringify(marker)}, 'locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      db.exec('COMMIT'); db.close();
    `], { stdio: 'ignore', windowsHide: true });
    const exited = new Promise(resolve => holder.on('exit', resolve));
    for (let i = 0; i < 100 && !fsNode.existsSync(marker); i++) await new Promise(r => setTimeout(r, 50));
    expect(fsNode.existsSync(marker)).toBe(true);

    await runFreshness();
    await exited;

    expect(checker.results.warnings).toEqual([]);
    expect(checker.results.passed.some((p) => /index fresh/.test(p))).toBe(true);
  }, 20000);

  it('warns when a newer db cannot be read, instead of certifying it fresh', async () => {
    writeHandCreatedMemory(tmp, CATEGORIES[0], 'older-memory');
    const dbPath = tmp.write(dbRelPath, 'not-a-real-db');
    fsNode.utimesSync(dbPath, future(), future());

    await runFreshness();

    expect(checker.results.passed.some((p) => /index fresh/.test(p))).toBe(false);
    expect(checker.results.warnings).toHaveLength(1);
    expect(checker.results.warnings[0]).toMatch(/unreadable/);
  });
});

describe('checkInboxBacklog', () => {
  const inboxRel = (name) => path.join('docs', '.output', '.state', 'memory-inbox', name);

  it('passes on an empty (or absent) inbox', async () => {
    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    await checker.checkInboxBacklog();
    logSpy.mockRestore();
    expect(checker.results.passed.some((p) => /inbox empty/.test(p))).toBe(true);
  });

  it('passes with a count for a small pending set (normal between /end runs)', async () => {
    tmp.write(inboxRel('draft-1.json'), '{}');
    tmp.write(inboxRel('draft-2.json'), '{}');
    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    await checker.checkInboxBacklog();
    logSpy.mockRestore();
    expect(checker.results.warnings).toEqual([]);
    expect(checker.results.passed.some((p) => /2 draft/.test(p))).toBe(true);
  });

  it('warns when the backlog signals a stalled promotion loop', async () => {
    for (let i = 0; i < 12; i++) tmp.write(inboxRel(`draft-${i}.json`), '{}');
    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    await checker.checkInboxBacklog();
    logSpy.mockRestore();
    expect(checker.results.warnings.some((w) => /backlog: 12 drafts/.test(w))).toBe(true);
  });

  it('counts only .json drafts, not stray files', async () => {
    for (let i = 0; i < 12; i++) tmp.write(inboxRel(`note-${i}.txt`), 'x');
    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    await checker.checkInboxBacklog();
    logSpy.mockRestore();
    expect(checker.results.warnings).toEqual([]);
  });
});

describe('checkBackend', () => {
  it('records exactly one backend verdict, consistently worded either way', async () => {
    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    await checker.checkBackend();
    logSpy.mockRestore();

    const total = checker.results.passed.length + checker.results.warnings.length + checker.results.errors.length;
    expect(total).toBe(1);
    const message = [...checker.results.passed, ...checker.results.warnings].join('');
    expect(message).toMatch(/FTS5/);
    expect(checker.results.errors).toEqual([]); // backend degradation is a warning, never an error
  });
});

describe('checkMemoryPerformance', () => {
  it('reports both a creation and a search timing, and leaves the probe deleted afterward', async () => {
    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    await checker.checkMemoryPerformance();
    logSpy.mockRestore();

    const all = [...checker.results.passed, ...checker.results.warnings, ...checker.results.errors].join('\n');
    expect(all).toMatch(/Memory creation:/);
    expect(all).toMatch(/Memory search:/);

    // The probe memory (fixed key `_health_check_probe`) must be cleaned up —
    // otherwise every health-check run leaves a growing pile of junk memories.
    const remaining = await checker.manager.listMemories(CONSTANTS.MEMORY_CATEGORIES.PATTERNS);
    expect(remaining.some((m) => m.id === '_health_check_probe')).toBe(false);
  });
});

describe('checkMemoryQuality', () => {
  it('classifies confidence into high/medium/low buckets and flags empty categories', async () => {
    const [patterns, constraints, decisions] = CATEGORIES;
    writeHandCreatedMemory(tmp, patterns, 'high-conf', { confidence: 0.95, usage_count: 10 });
    writeHandCreatedMemory(tmp, constraints, 'mid-conf', { confidence: 0.6, usage_count: 1 });
    writeHandCreatedMemory(tmp, decisions, 'low-conf', { confidence: 0.2, usage_count: 0 });
    // workflows / rejected-approaches (the remaining categories) stay empty.

    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    await checker.checkMemoryQuality();
    logSpy.mockRestore();

    const passed = checker.results.passed.join('\n');
    const warnings = checker.results.warnings.join('\n');
    const errors = checker.results.errors.join('\n');

    expect(passed).toMatch(new RegExp(`${patterns}: High confidence`));
    expect(passed).toMatch(new RegExp(`${patterns}: Well-used \\(10 total uses\\)`));
    expect(warnings).toMatch(new RegExp(`${constraints}: Medium confidence`));
    expect(errors).toMatch(new RegExp(`${decisions}: Low confidence`));

    const emptyCategories = CATEGORIES.filter((c) => ![patterns, constraints, decisions].includes(c));
    for (const category of emptyCategories) {
      expect(warnings).toMatch(new RegExp(`${category}' is empty`));
    }
  });

  it('does not double-count an empty category as low confidence', async () => {
    // Regression guard: an empty category must warn "is empty" and `continue`,
    // never fall through to the confidence/usage checks (avg_confidence is 0
    // for an empty category via `sum/length || 0`, which would otherwise
    // misreport every untouched category as a confidence ERROR).
    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    await checker.checkMemoryQuality();
    logSpy.mockRestore();

    expect(checker.results.errors).toEqual([]);
    expect(checker.results.warnings.length).toBe(CATEGORIES.length);
    expect(checker.results.warnings.every((w) => w.includes('is empty'))).toBe(true);
  });
});

describe('checkRecentMemories', () => {
  it('counts recently-updated and stale memories into separate buckets', async () => {
    const [patterns] = CATEGORIES;
    const recentDate = new Date(Date.now() - 1 * CONSTANTS.TIME.MS_PER_DAY).toISOString(); // 1 day ago
    const oldDate = new Date(Date.now() - 40 * CONSTANTS.TIME.MS_PER_DAY).toISOString(); // 40 days ago
    writeHandCreatedMemory(tmp, patterns, 'recent-one', { updated: recentDate });
    writeHandCreatedMemory(tmp, patterns, 'old-one', { updated: oldDate });

    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    await checker.checkRecentMemories();
    logSpy.mockRestore();

    expect(checker.results.passed.some((p) => /1 memories updated in last 7 days/.test(p))).toBe(true);
    expect(checker.results.warnings.some((w) => /1 memories haven't been updated in over 28 days/.test(w))).toBe(true);
  });

  it('reports nothing when the store is empty (no recent, no stale)', async () => {
    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    await checker.checkRecentMemories();
    logSpy.mockRestore();

    expect(checker.results.passed).toEqual([]);
    expect(checker.results.warnings).toEqual([]);
  });
});

describe('runHealthCheck (full pipeline)', () => {
  it('returns true (healthy) when the store has no low-confidence, non-empty categories', async () => {
    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    const healthy = await checker.runHealthCheck();
    logSpy.mockRestore();

    expect(healthy).toBe(true);
    expect(checker.results.errors).toEqual([]);
    // Sanity: it actually ran all six checks, not a stub — freshness, inbox,
    // and backend each always contribute at least one passed/warning entry.
    expect(checker.results.passed.length + checker.results.warnings.length).toBeGreaterThan(0);
  });

  it('observes index freshness BEFORE later checks lazily create the db (ordering regression)', async () => {
    writeHandCreatedMemory(tmp, CATEGORIES[0], 'pre-existing', { confidence: 0.9 });
    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    await checker.runHealthCheck();
    logSpy.mockRestore();

    // checkMemoryPerformance (later in the pipeline) writes a probe, which
    // lazily creates the db file. If freshness ran after it, the just-created
    // db would read "fresh" and the absent-index warning would be lost.
    expect(checker.results.warnings.some((w) => /index absent/.test(w))).toBe(true);
  });

  it('returns false (unhealthy) when a category has an ERROR-level low-confidence memory', async () => {
    writeHandCreatedMemory(tmp, CATEGORIES[0], 'very-low-conf', { confidence: 0.1 });
    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    const healthy = await checker.runHealthCheck();
    logSpy.mockRestore();

    expect(healthy).toBe(false);
    expect(checker.results.errors.length).toBeGreaterThan(0);
  });

  it('return value is exactly `errors.length === 0`, not merely truthy/falsy of some other field', async () => {
    checker = new MemoryHealthChecker();
    const logSpy = silenceConsole();
    const healthy = await checker.runHealthCheck();
    logSpy.mockRestore();
    expect(healthy).toBe(checker.results.errors.length === 0);
  });

  // F39 (council-260715-2244): one run = ONE store scan. The old shape called
  // generateReport() twice (checkBackend + checkMemoryQuality) and swept the
  // store a third time in checkRecentMemories — ~6× full-store JSON parsing.
  it('generates the store report exactly ONCE per run and threads it through all checks (F39 single-pass)', async () => {
    writeHandCreatedMemory(tmp, CATEGORIES[0], 'single-pass-probe', { confidence: 0.9 });
    checker = new MemoryHealthChecker();
    const reportSpy = vi.spyOn(checker.manager, 'generateReport');
    const listSpy = vi.spyOn(checker.manager, 'listMemories');
    // Neutralize checkMemoryPerformance's searchMemories: on an FTS5-less
    // runtime its JSON fallback would add listMemories calls this count
    // doesn't budget for — the assertion targets the report path only.
    const searchSpy = vi.spyOn(checker.manager, 'searchMemories').mockResolvedValue([]);
    const logSpy = silenceConsole();
    await checker.runHealthCheck();
    logSpy.mockRestore();

    expect(reportSpy).toHaveBeenCalledTimes(1);
    // Every listMemories call must come from inside that single generateReport
    // (one per category) — no independent whole-store re-sweep remains.
    expect(listSpy.mock.calls.length).toBe(Object.values(CONSTANTS.MEMORY_CATEGORIES).length);
    reportSpy.mockRestore();
    listSpy.mockRestore();
    searchSpy.mockRestore();
  });
});

// ── CLI entry point — subprocess smoke test (exit-code/report shape only;
// does not contribute to in-process v8 coverage). ──────────────────────────
describe('memory-health-check.js CLI (subprocess smoke test)', () => {
  it('runs end-to-end and exits 0 on a fresh, self-healed store', () => {
    const { execFileSync } = require('node:child_process');
    const scriptPath = path.resolve(__dirname, '../../../.agents/core/memory-health-check.js');
    const stdout = execFileSync('node', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root },
    });
    expect(stdout).toContain('MEMORY SYSTEM HEALTH CHECK');
    expect(stdout).toContain('HEALTH CHECK RESULTS');
  });

  it('exits 1 when a low-confidence memory makes the store unhealthy', () => {
    writeHandCreatedMemory(tmp, CATEGORIES[0], 'very-low-conf', { confidence: 0.1 });
    const { execFileSync } = require('node:child_process');
    const scriptPath = path.resolve(__dirname, '../../../.agents/core/memory-health-check.js');
    let status = 0;
    let stdout = '';
    try {
      stdout = execFileSync('node', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root },
      });
    } catch (e) {
      status = e.status;
      stdout = e.stdout;
    }
    expect(status).toBe(1);
    expect(stdout).toContain('Memory system needs attention');
  });
});
