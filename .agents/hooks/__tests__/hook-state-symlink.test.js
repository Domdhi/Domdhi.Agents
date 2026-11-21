// AC→source map (L1H, wave-L1 review C1 part 2 — unsandboxed hook state writers must not follow symlinks):
//   Hooks run OUTSIDE any sandbox and write under docs/.output/.state/, which is gitignored and so is whatever
//   the working tree says it is. A model-planted symlink turned an append into an arbitrary write.
//   - memory-capture.cjs, fed a PostToolUse Bash commit payload whose stdout carries attacker text, with
//     memory-daily/<date>.md symlinked to a victim file: the victim is unchanged, the hook exits 0 and says why
//     on stderr (the executable repro of the review's exploit)
//   - one case per hook writer that a symlinked ANCESTOR directory is refused (nothing created in the target),
//     and that a symlinked LEAF is refused or displaced (the target never written): memory-capture (and its
//     fallback append), memory-recall (seen file, index marker, telemetry), pre-compaction-archive (snapshot and
//     daily log), memory-session-capture (capture log), organize (plans and screenshots)
//   - a refused write never crashes or blocks a hook: the rest of the hook still runs (fail-soft)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');
const { startEmbedServer } = require('../../core/__tests__/_helpers/memory-fakes');
const R = require('../../core/_lib/memory-recall');
const { loadCorpus } = require('../../core/_lib/memory-notes');
const DailyLog = require('../../core/daily-log');

const HOOKS = path.resolve(__dirname, '..');
const memoryCapture = require('../memory-capture.cjs');
const memoryRecall = require('../memory-recall.cjs');
const preCompaction = require('../pre-compaction-archive.cjs');
const sessionCapture = require('../memory-session-capture.cjs');
const organize = require('../organize.cjs');

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

// Everything that can redirect a hook's root or behaviour, cleared for every case.
const CONTEXT = [
  'AGENT_SHARED_STATE_ROOT', 'AGENTS_PROJECT_DIR', 'AGENT_SOURCE_ROOT', 'CODEX_PROJECT_DIR', 'CLAUDE_PROJECT_DIR',
  'MEMORY_PROFILE', 'MEMORY_DIR', 'MEMORY_CAPTURE', 'MEMORY_CAPTURE_PROVIDER', 'MEMORY_CAPTURE_INNER', 'MEMORY_SYNC',
  'MEMORY_RECALL', 'MEMORY_RECALL_MAX', 'MEMORY_RECALL_FLOOR', 'MEMORY_EMBED_PROVIDER', 'MEMORY_EMBED_URL',
  'MEMORY_EMBED_MODEL', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR',
];
const saved = {};
let tmp, project, state, victimDir, victimFile, stderrSpy;

const today = () => new Date().toISOString().slice(0, 10);
const listing = dir => fs.readdirSync(dir).sort();
const refusalLines = () => stderrSpy.mock.calls.map(([chunk]) => String(chunk)).filter(line => line.startsWith('[fs-safe]'));

function envFor(extra = {}) {
  const env = { ...process.env };
  for (const key of CONTEXT) delete env[key];
  return { ...env, CLAUDE_PROJECT_DIR: project, MEMORY_PROFILE: 'standard', ...extra };
}

beforeEach(() => {
  for (const key of CONTEXT) saved[key] = process.env[key];
  for (const key of CONTEXT) delete process.env[key];
  tmp = createTmpDir({ prefix: 'hook-state-symlink-' });
  project = path.join(tmp.root, 'project');
  state = path.join(project, 'docs', '.output', '.state');
  fs.mkdirSync(state, { recursive: true });
  victimDir = path.join(tmp.root, 'victim-dir');
  fs.mkdirSync(victimDir);
  victimFile = path.join(tmp.root, 'victim.txt');
  fs.writeFileSync(victimFile, 'VICTIM-CONTENT');
  process.env.CLAUDE_PROJECT_DIR = project;
  process.env.MEMORY_PROFILE = 'standard';
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of CONTEXT) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  tmp.cleanup();
});

const commitPayload = () => JSON.stringify({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'git commit -m "docs: fix link"' },
  tool_response: { stdout: '[main 1a2b3c4d] docs: fix link; touch /tmp/l1h-marker #\n 1 file changed, 1 insertion(+)\n' },
});

const runMemoryCapture = () => spawnSync(process.execPath, [path.join(HOOKS, 'memory-capture.cjs')], {
  input: commitPayload(), encoding: 'utf8', timeout: 20000, windowsHide: true, env: envFor(),
});

describe('memory-capture.cjs as a process (the executable repro of review C1)', () => {
  it('control: without a symlink the commit entry lands in the daily log', () => {
    const run = runMemoryCapture();
    expect(run.status).toBe(0);
    const log = fs.readFileSync(path.join(state, 'memory-daily', `${today()}.md`), 'utf8');
    expect(log).toContain('1a2b3c4d');
    expect(log).toContain('touch /tmp/l1h-marker');
  });

  it.skipIf(!canSymlink)('a symlinked memory-daily/<date>.md leaves the victim file UNCHANGED, exits 0 and says why', () => {
    fs.mkdirSync(path.join(state, 'memory-daily'), { recursive: true });
    fs.symlinkSync(victimFile, path.join(state, 'memory-daily', `${today()}.md`));

    const run = runMemoryCapture();

    expect(run.status).toBe(0);
    expect(fs.readFileSync(victimFile, 'utf8')).toBe('VICTIM-CONTENT');
    expect(run.stderr).toMatch(/\[fs-safe\] state write skipped: .*symlink/);
  });

  it.skipIf(!canSymlink)('a symlinked state folder creates NOTHING in the link target (daily log, telemetry, any hook state)', () => {
    fs.rmSync(state, { recursive: true });
    fs.symlinkSync(victimDir, state, 'dir');

    const run = runMemoryCapture();

    expect(run.status).toBe(0);
    expect(listing(victimDir)).toEqual([]);
    expect(run.stderr).toMatch(/\[fs-safe\] state write skipped: .*symlinked ancestor/);
  });
});

describe.skipIf(!canSymlink)('memory-capture.cjs fallback append', () => {
  const input = { tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, tool_response: { stdout: '[main 1a2b3c4d] subject\n 1 file changed\n' } };

  it('refuses a symlinked daily-log leaf and a symlinked ancestor when DailyLog itself is unavailable', () => {
    vi.spyOn(DailyLog.prototype, 'captureCommit').mockImplementation(() => { throw new Error('DailyLog unavailable'); });
    fs.mkdirSync(path.join(state, 'memory-daily'), { recursive: true });
    fs.symlinkSync(victimFile, path.join(state, 'memory-daily', `${today()}.md`));

    expect(() => memoryCapture.handleBashPostToolUse(input)).not.toThrow();
    expect(fs.readFileSync(victimFile, 'utf8')).toBe('VICTIM-CONTENT');

    fs.rmSync(state, { recursive: true });
    fs.symlinkSync(victimDir, state, 'dir');
    expect(() => memoryCapture.handleBashPostToolUse(input)).not.toThrow();
    expect(listing(victimDir)).toEqual([]);
    expect(refusalLines()).toHaveLength(2);
  });
});

describe.skipIf(!canSymlink)('memory-recall.cjs', () => {
  let memDir;
  const MINT = 'what do I pay for my Mint Mobile phone plan each year';
  const servers = [];

  beforeEach(() => {
    memDir = path.join(tmp.root, 'mem');
    fs.mkdirSync(memDir);
    fs.writeFileSync(path.join(memDir, 'mint-plan.md'), '---\nname: mint-plan\ndescription: "phone plan cost"\n---\n\nMint Mobile annual plan renews in July at 206 dollars.\n');
    Object.assign(process.env, {
      AGENT_SHARED_STATE_ROOT: project, AGENTS_PROJECT_DIR: project, MEMORY_DIR: memDir,
      MEMORY_EMBED_PROVIDER: 'none', CLAUDE_CONFIG_DIR: path.join(tmp.root, 'claude'),
    });
  });
  afterEach(async () => { await Promise.all(servers.splice(0).map(s => s.close())); });

  it('still injects the memory when the seen-set folder is a symlink, and writes nothing into its target', async () => {
    fs.mkdirSync(path.join(state, 'memory-notes'), { recursive: true });
    fs.symlinkSync(victimDir, path.join(state, 'memory-notes', 'seen'), 'dir');

    const out = await memoryRecall.processEvent({ prompt: MINT, session_id: 's1' });

    expect(out.hookSpecificOutput.additionalContext).toContain('### mint-plan');
    expect(listing(victimDir)).toEqual([]);
    expect(refusalLines().some(line => /symlinked ancestor/.test(line))).toBe(true);
  });

  it('refuses a symlinked seen-set FILE (the target is never overwritten)', async () => {
    fs.mkdirSync(path.join(state, 'memory-notes', 'seen'), { recursive: true });
    fs.symlinkSync(victimFile, path.join(state, 'memory-notes', 'seen', 's1.json'));

    // safeWrite displaces a leaf link instead of following it: the victim is the invariant.
    const out = await memoryRecall.processEvent({ prompt: MINT, session_id: 's1' });

    expect(out).not.toBeNull();
    expect(fs.readFileSync(victimFile, 'utf8')).toBe('VICTIM-CONTENT');
  });

  it('writes no telemetry line into a symlinked telemetry folder', async () => {
    fs.symlinkSync(victimDir, path.join(state, 'telemetry'), 'dir');

    const out = await memoryRecall.processEvent({ prompt: MINT, session_id: 's1' });

    expect(out).not.toBeNull();
    expect(listing(victimDir)).toEqual([]);
  });

  it('starts no index run and writes no marker when the notes state folder is a symlink', async () => {
    const s = await startEmbedServer();
    servers.push(s);
    Object.assign(process.env, { MEMORY_EMBED_PROVIDER: 'openai', MEMORY_EMBED_URL: `${s.url}/v1`, MEMORY_EMBED_MODEL: 'test-embed' });
    const stateDir = path.join(state, 'memory-notes');
    await R.syncIndex(loadCorpus({ memoryDir: memDir }), stateDir, R.embedConfig(process.env));
    fs.writeFileSync(path.join(memDir, 'new-one.md'), '---\nname: new-one\ndescription: "brand new"\n---\n\nMint Mobile phone plan note added after the index was built.\n'); // now stale
    const moved = path.join(tmp.root, 'moved-notes');
    fs.renameSync(stateDir, moved);
    fs.symlinkSync(moved, stateDir, 'dir');
    const before = listing(moved);
    const spawn = vi.spyOn(childProcess, 'spawn').mockReturnValue({ unref() {} });

    await memoryRecall.processEvent({ prompt: MINT, session_id: 's1' });

    expect(spawn).not.toHaveBeenCalled();
    expect(listing(moved)).toEqual(before);
  });

  it('a symlinked index marker is displaced, never written through, and the index run still starts', async () => {
    const s = await startEmbedServer();
    servers.push(s);
    Object.assign(process.env, { MEMORY_EMBED_PROVIDER: 'openai', MEMORY_EMBED_URL: `${s.url}/v1`, MEMORY_EMBED_MODEL: 'test-embed' });
    const stateDir = path.join(state, 'memory-notes');
    await R.syncIndex(loadCorpus({ memoryDir: memDir }), stateDir, R.embedConfig(process.env));
    fs.writeFileSync(path.join(memDir, 'new-one.md'), '---\nname: new-one\ndescription: "brand new"\n---\n\nMint Mobile phone plan note added after the index was built.\n'); // now stale
    const old = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(victimFile, old, old);
    fs.symlinkSync(victimFile, path.join(stateDir, 'index-spawned'));
    const spawn = vi.spyOn(childProcess, 'spawn').mockReturnValue({ unref() {} });

    await memoryRecall.processEvent({ prompt: MINT, session_id: 's1' });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(victimFile, 'utf8')).toBe('VICTIM-CONTENT');
    expect(fs.lstatSync(path.join(stateDir, 'index-spawned')).isSymbolicLink()).toBe(false);
  });
});

describe.skipIf(!canSymlink)('pre-compaction-archive.cjs', () => {
  it('skips a snapshot whose sessions folder is a symlink, still writes the daily log, and does not throw', () => {
    fs.symlinkSync(victimDir, path.join(state, 'sessions'), 'dir');

    expect(() => preCompaction.processEvent({ trigger: 'test' })).not.toThrow();

    expect(listing(victimDir)).toEqual([]);
    expect(fs.readFileSync(path.join(state, 'memory-daily', `${today()}.md`), 'utf8')).toContain('Pre-Compaction');
    expect(refusalLines().some(line => /symlinked ancestor/.test(line))).toBe(true);
  });

  it('refuses a symlinked snapshot file and a symlinked daily-log file (the targets are never written)', () => {
    const now = new Date();
    const stamp = `${now.toISOString().slice(11, 16).replace(':', '')}`;
    fs.mkdirSync(path.join(state, 'sessions', today()), { recursive: true });
    fs.symlinkSync(victimFile, path.join(state, 'sessions', today(), `${stamp}-pre-compaction.md`));
    const victim2 = path.join(tmp.root, 'victim2.txt');
    fs.writeFileSync(victim2, 'VICTIM-TWO');
    fs.mkdirSync(path.join(state, 'memory-daily'), { recursive: true });
    fs.symlinkSync(victim2, path.join(state, 'memory-daily', `${today()}.md`));

    expect(() => preCompaction.processEvent({ trigger: 'test' })).not.toThrow();

    expect(fs.readFileSync(victim2, 'utf8')).toBe('VICTIM-TWO');
    // The snapshot leaf is displaced by safeWrite (never followed); a minute rollover just writes a fresh name.
    expect(fs.readFileSync(victimFile, 'utf8')).toBe('VICTIM-CONTENT');
  });
});

describe.skipIf(!canSymlink)('memory-session-capture.cjs', () => {
  let transcript, spawn;

  beforeEach(() => {
    Object.assign(process.env, {
      AGENT_SHARED_STATE_ROOT: project, AGENTS_PROJECT_DIR: project, MEMORY_CAPTURE: 'on', ANTHROPIC_API_KEY: 'k',
      CLAUDE_CONFIG_DIR: path.join(tmp.root, 'claude'),
    });
    transcript = path.join(tmp.root, 'abc.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    spawn = vi.fn(() => ({ unref: vi.fn() }));
  });

  it('starts no capture child and writes nothing when the notes state folder is a symlink', () => {
    fs.symlinkSync(victimDir, path.join(state, 'memory-notes'), 'dir');

    expect(sessionCapture.processEvent({ transcript_path: transcript }, { spawn })).toBe(false);

    expect(spawn).not.toHaveBeenCalled();
    expect(listing(victimDir)).toEqual([]);
    expect(refusalLines().some(line => /symlinked ancestor/.test(line))).toBe(true);
  });

  it('refuses a symlinked capture.log (the target is never written) and starts no child', () => {
    fs.mkdirSync(path.join(state, 'memory-notes'), { recursive: true });
    fs.symlinkSync(victimFile, path.join(state, 'memory-notes', 'capture.log'));

    expect(sessionCapture.processEvent({ transcript_path: transcript }, { spawn })).toBe(false);

    expect(spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(victimFile, 'utf8')).toBe('VICTIM-CONTENT');
  });

  it('control: a real tree starts exactly one child and writes the log', () => {
    expect(sessionCapture.processEvent({ transcript_path: transcript }, { spawn })).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(state, 'memory-notes', 'capture.log'), 'utf8')).toContain('capture abc.jsonl');
  });
});

describe.skipIf(!canSymlink)('organize.cjs', () => {
  it('leaves a plan in place when its dated target folder is a symlink, and moves nothing into the target', () => {
    const plans = path.join(project, 'docs', '.output', 'plans');
    fs.mkdirSync(plans, { recursive: true });
    const plan = path.join(plans, 'my-plan.md');
    fs.writeFileSync(plan, '# Plan: Thing\n\nbody\n');
    const stat = fs.statSync(plan);
    fs.symlinkSync(victimDir, path.join(plans, organize.dateFolder(stat.birthtime || stat.mtime)), 'dir');

    organize.processEvent({});

    expect(fs.existsSync(plan)).toBe(true);
    expect(listing(victimDir)).toEqual([]);
    expect(refusalLines().some(line => /symlinked ancestor/.test(line))).toBe(true);
  });

  it('moves no screenshot into a symlinked dated folder', () => {
    const shots = path.join(state, 'screenshots');
    fs.mkdirSync(shots, { recursive: true });
    const shot = path.join(shots, 'a.png');
    fs.writeFileSync(shot, 'png');
    fs.symlinkSync(victimDir, path.join(shots, organize.dateFolder(fs.statSync(shot).mtime)), 'dir');

    organize.processEvent({});

    expect(fs.existsSync(shot)).toBe(true);
    expect(listing(victimDir)).toEqual([]);
    expect(refusalLines().some(line => /symlinked ancestor/.test(line))).toBe(true);
  });

  it('control: a real tree still organizes a plan', () => {
    const plans = path.join(project, 'docs', '.output', 'plans');
    fs.mkdirSync(plans, { recursive: true });
    fs.writeFileSync(path.join(plans, 'my-plan.md'), '# Plan: Thing\n\nbody\n');

    const result = organize.processEvent({});

    expect(result.feedback).toContain('Organized 1 item(s)');
    expect(fs.existsSync(path.join(plans, 'my-plan.md'))).toBe(false);
  });
});
