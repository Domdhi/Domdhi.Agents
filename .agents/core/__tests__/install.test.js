// install.js — brownfield installer tests.
//
// All tests are fully headless: no TTY interaction, no real .claude/ copy.
// Each test builds a synthetic source .claude/ in a tmp dir so we exercise
// the logic without copying the real (multi-MB) template tree.
//
// Style mirrors memory-backend-detect.test.js and adopter-ship.test.js:
//   - ESM import for vitest, createRequire for CJS module under test.
//   - createTmpDir helper for isolated tmp trees.
//   - beforeEach / afterEach for setup + cleanup.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { runInstall, resolveConflict, writeMergeNotes, DO_NOT_SHIP, parseArgs, preflightInstall, installScope } = require('../../../.agents/core/install');
const { createTmpDir } = require('./_helpers/tmp-dir');
const { ignoredFilter } = require('../_lib/git-ignored');

// Symlink-capability probe — Windows checkouts without Developer Mode cannot
// create symlinks; skip rather than fail there (mirrors fs-safe.test.js).
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal synthetic source tree in a tmp dir.
 * Returns the source root (which contains a .claude/ subdirectory).
 *
 * @param {ReturnType<typeof createTmpDir>} tmp
 * @param {string[]} [files] — relative paths inside .claude/ to create
 * @returns {string} absolute path to the synthetic source root
 */
function buildSource(tmp, files) {
  files = files || [
    'commands/do.md',
    'core/install.js',
    'agents/general-purpose.md',
    'skills/full-output-enforcement/SKILL.md',
  ];
  for (const f of files) {
    tmp.write(path.join('source', '.claude', f), `# ${f}\ncontent`);
  }
  return path.join(tmp.root, 'source');
}

/**
 * Build a minimal synthetic target dir (an empty project).
 *
 * @param {ReturnType<typeof createTmpDir>} tmp
 * @param {string} [name] — subdirectory name inside tmp (default 'target')
 * @returns {string} absolute path to the synthetic target root
 */
function buildTarget(tmp, name) {
  name = name || 'target';
  const t = path.join(tmp.root, name);
  fs.mkdirSync(t, { recursive: true });
  return t;
}

let tmp;

beforeEach(() => {
  tmp = createTmpDir({ prefix: 'install-test-' });
});

afterEach(() => {
  tmp.cleanup();
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('defaults to target "." with all flags false', () => {
    const opts = parseArgs([]);
    expect(opts.target).toBe('.');
    expect(opts.dryRun).toBe(false);
    expect(opts.overwriteAll).toBe(false);
    expect(opts.keepAll).toBe(false);
    expect(opts.force).toBe(false);
    expect(opts.noDeps).toBe(false);
  });

  it('picks up positional as target', () => {
    const opts = parseArgs(['/some/path']);
    expect(opts.target).toBe('/some/path');
  });

  it('sets dryRun on --dry-run', () => {
    const opts = parseArgs(['--dry-run']);
    expect(opts.dryRun).toBe(true);
  });

  it('sets overwriteAll on --overwrite-all', () => {
    const opts = parseArgs(['--overwrite-all']);
    expect(opts.overwriteAll).toBe(true);
    expect(opts.force).toBe(false);
  });

  it('sets force AND overwriteAll on --force', () => {
    const opts = parseArgs(['--force']);
    expect(opts.force).toBe(true);
    expect(opts.overwriteAll).toBe(true);
  });

  it('sets keepAll on --keep', () => {
    const opts = parseArgs(['--keep']);
    expect(opts.keepAll).toBe(true);
  });

  it('sets noDeps on --no-deps', () => {
    const opts = parseArgs(['--no-deps']);
    expect(opts.noDeps).toBe(true);
  });

  it('handles mixed positional + flags', () => {
    const opts = parseArgs(['/target', '--dry-run', '--force']);
    expect(opts.target).toBe('/target');
    expect(opts.dryRun).toBe(true);
    expect(opts.force).toBe(true);
    expect(opts.overwriteAll).toBe(true);
  });


});

// ── resolveConflict ───────────────────────────────────────────────────────────

describe('resolveConflict', () => {
  it('returns "overwrite" when overwriteAll is true', () => {
    expect(resolveConflict('core/test.js', { overwriteAll: true })).toBe('overwrite');
  });

  it('returns "overwrite" when force is true', () => {
    expect(resolveConflict('core/test.js', { force: true })).toBe('overwrite');
  });

  it('returns "keep" when keepAll is true', () => {
    expect(resolveConflict('core/test.js', { keepAll: true })).toBe('keep');
  });

  it('force takes precedence over keepAll', () => {
    expect(resolveConflict('core/test.js', { force: true, keepAll: true })).toBe('overwrite');
  });

  it('returns "keep" in headless mode (no TTY, no flags)', () => {
    expect(resolveConflict('core/test.js', { interactive: false })).toBe('keep');
  });

  it('calls choiceFn when interactive, returns keep when fn returns keep', () => {
    const choiceFn = () => 'keep';
    expect(resolveConflict('core/test.js', { interactive: true, choiceFn })).toBe('keep');
  });

  it('calls choiceFn when interactive, returns overwrite when fn returns overwrite', () => {
    const choiceFn = () => 'overwrite';
    expect(resolveConflict('core/test.js', { interactive: true, choiceFn })).toBe('overwrite');
  });

  it('re-calls choiceFn once when it returns "diff", uses second result', () => {
    let calls = 0;
    const choiceFn = () => {
      calls++;
      return calls === 1 ? 'diff' : 'overwrite';
    };
    expect(resolveConflict('core/test.js', { interactive: true, choiceFn })).toBe('overwrite');
    expect(calls).toBe(2);
  });
});

// ── DO_NOT_SHIP ───────────────────────────────────────────────────────────────

describe('DO_NOT_SHIP', () => {
  it('is an array of strings', () => {
    expect(Array.isArray(DO_NOT_SHIP)).toBe(true);
    expect(DO_NOT_SHIP.every(s => typeof s === 'string')).toBe(true);
  });

  it('includes agent-memory/**', () => {
    expect(DO_NOT_SHIP).toContain('agent-memory/**');
  });

  it('includes settings.local.json', () => {
    expect(DO_NOT_SHIP).toContain('settings.local.json');
  });

  it('includes push-guardrail.json', () => {
    expect(DO_NOT_SHIP).toContain('push-guardrail.json');
  });
});

// ── runInstall: basic copy ─────────────────────────────────────────────────────

describe('runInstall — basic copy into empty target', () => {
  it('copies .claude/ files into an empty target; returns created count', () => {
    const source = buildSource(tmp, [
      'commands/do.md',
      'core/install.js',
    ]);
    const target = buildTarget(tmp);

    const stats = runInstall({ source, target, dryRun: false, interactive: false });

    expect(stats.created).toBeGreaterThan(0);
    expect(stats.skipped).toBe(0);
    expect(stats.merged).toBe(0);
    expect(stats.conflicts).toHaveLength(0);
    expect(stats.dryRun).toBe(false);

    // Files should exist in target
    expect(fs.existsSync(path.join(target, '.claude', 'commands', 'do.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.claude', 'core', 'install.js'))).toBe(true);
  });

  it('leaves a sentinel file OUTSIDE .claude/ in the target untouched', () => {
    const source = buildSource(tmp, ['core/install.js']);
    const target = buildTarget(tmp);

    // Place a sentinel file in target root
    fs.writeFileSync(path.join(target, 'sentinel.txt'), 'do not touch', 'utf8');

    runInstall({ source, target, dryRun: false, interactive: false });

    expect(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8')).toBe('do not touch');
  });

  it('creates CLAUDE.md stub when target has no CLAUDE.md', () => {
    const source = buildSource(tmp, ['core/install.js']);
    const target = buildTarget(tmp);

    runInstall({ source, target, dryRun: false, interactive: false });

    const claudeMd = path.join(target, 'CLAUDE.md');
    expect(fs.existsSync(claudeMd)).toBe(true);
    expect(fs.readFileSync(claudeMd, 'utf8')).toContain('/onboard');
  });
});

// ── runInstall: existing CLAUDE.md preserved ─────────────────────────────────

describe('runInstall — existing CLAUDE.md preserved', () => {
  it('does NOT overwrite an existing CLAUDE.md in the target', () => {
    const source = buildSource(tmp, ['core/install.js']);
    const target = buildTarget(tmp);

    const originalContent = '# My Custom CLAUDE.md\nproject-specific content\n';
    fs.writeFileSync(path.join(target, 'CLAUDE.md'), originalContent, 'utf8');

    runInstall({ source, target, dryRun: false, interactive: false });

    expect(fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8')).toBe(originalContent);
  });

  // Unconditional (not behind the symlink capability gate), so it runs on every CI agent.
  it('runInstall_brownfieldWithoutClaudeMd_writesDomdhiStubWithOnboardMarker', () => {
    const source = buildSource(tmp, ['core/foo.js']);
    const target = buildTarget(tmp);

    runInstall({ source, target, dryRun: false, interactive: false, keepAll: true });

    const stub = fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8');
    expect(stub).toContain('This project uses the Domdhi.Agents toolkit.');
    // The onboard and create-new-project workflows detect the stub by this marker.
    expect(stub).toContain('Run `/onboard` in Claude Code to complete project setup.');
    expect((stub.match(/[A-Za-z0-9_-]+\.Agents/g) || []).every(name => name === 'Domdhi.Agents')).toBe(true);
  });
});

// ── runInstall: conflict handling ─────────────────────────────────────────────

describe('runInstall — conflict + headless keep-existing', () => {
  it('keeps existing content and writes MERGE-NOTES.md when conflict occurs headlessly', () => {
    const source = buildSource(tmp, ['core/install.js']);
    const target = buildTarget(tmp);

    // Pre-populate the target with a conflicting file
    const existingContent = 'existing content — do not overwrite';
    fs.mkdirSync(path.join(target, '.claude', 'core'), { recursive: true });
    fs.writeFileSync(path.join(target, '.claude', 'core', 'install.js'), existingContent, 'utf8');

    const stats = runInstall({ source, target, dryRun: false, interactive: false });

    // Conflict was kept
    expect(stats.skipped).toBeGreaterThan(0);
    expect(stats.conflicts).toContain('core/install.js');

    // Original content preserved
    expect(fs.readFileSync(path.join(target, '.claude', 'core', 'install.js'), 'utf8'))
      .toBe(existingContent);

    // MERGE-NOTES.md written
    const notesPath = path.join(target, '.claude', 'MERGE-NOTES.md');
    expect(fs.existsSync(notesPath)).toBe(true);
    const notes = fs.readFileSync(notesPath, 'utf8');
    expect(notes).toContain('core/install.js');
  });
});

describe('runInstall — conflict + overwriteAll', () => {
  it('overwrites conflicting files when overwriteAll is true', () => {
    const newContent = '# new install.js content';
    const source = buildSource(tmp, ['core/install.js']);
    // Overwrite the source file content for a distinct assertion
    fs.writeFileSync(
      path.join(tmp.root, 'source', '.claude', 'core', 'install.js'),
      newContent, 'utf8'
    );

    const target = buildTarget(tmp);
    fs.mkdirSync(path.join(target, '.claude', 'core'), { recursive: true });
    fs.writeFileSync(path.join(target, '.claude', 'core', 'install.js'), 'OLD', 'utf8');

    const stats = runInstall({ source, target, dryRun: false, overwriteAll: true, interactive: false });

    expect(stats.merged).toBeGreaterThan(0);
    expect(stats.conflicts).toHaveLength(0);
    expect(fs.readFileSync(path.join(target, '.claude', 'core', 'install.js'), 'utf8'))
      .toBe(newContent);
  });
});

describe('runInstall — conflict + force', () => {
  it('overwrites conflicting files when force is true', () => {
    const source = buildSource(tmp, ['core/install.js']);
    const target = buildTarget(tmp);

    fs.mkdirSync(path.join(target, '.claude', 'core'), { recursive: true });
    fs.writeFileSync(path.join(target, '.claude', 'core', 'install.js'), 'OLD', 'utf8');

    const stats = runInstall({ source, target, dryRun: false, force: true, interactive: false });

    expect(stats.merged).toBeGreaterThan(0);
  });
});

describe('runInstall — conflict + keepAll', () => {
  it('keeps all conflicting files when keepAll is true', () => {
    const source = buildSource(tmp, ['core/install.js']);
    const target = buildTarget(tmp);

    fs.mkdirSync(path.join(target, '.claude', 'core'), { recursive: true });
    fs.writeFileSync(path.join(target, '.claude', 'core', 'install.js'), 'KEEP THIS', 'utf8');

    const stats = runInstall({ source, target, dryRun: false, keepAll: true, interactive: false });

    expect(stats.skipped).toBeGreaterThan(0);
    expect(stats.conflicts).toContain('core/install.js');
    expect(fs.readFileSync(path.join(target, '.claude', 'core', 'install.js'), 'utf8'))
      .toBe('KEEP THIS');
  });
});

// ── runInstall: resolveConflict with injected choiceFn ───────────────────────

describe('runInstall — interactive choiceFn', () => {
  it('calls choiceFn for conflict and honors keep result', () => {
    const source = buildSource(tmp, ['core/install.js']);
    const target = buildTarget(tmp);

    fs.mkdirSync(path.join(target, '.claude', 'core'), { recursive: true });
    fs.writeFileSync(path.join(target, '.claude', 'core', 'install.js'), 'MY VERSION', 'utf8');

    const calls = [];
    const choiceFn = (relPath) => { calls.push(relPath); return 'keep'; };

    const stats = runInstall({
      source, target, dryRun: false,
      interactive: true, choiceFn,
    });

    expect(calls).toContain('core/install.js');
    expect(stats.skipped).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(target, '.claude', 'core', 'install.js'), 'utf8'))
      .toBe('MY VERSION');
  });

  it('calls choiceFn for conflict and honors overwrite result', () => {
    const newContent = '# install.js from source';
    const source = buildSource(tmp, ['core/install.js']);
    fs.writeFileSync(
      path.join(tmp.root, 'source', '.claude', 'core', 'install.js'),
      newContent, 'utf8'
    );

    const target = buildTarget(tmp);
    fs.mkdirSync(path.join(target, '.claude', 'core'), { recursive: true });
    fs.writeFileSync(path.join(target, '.claude', 'core', 'install.js'), 'OLD', 'utf8');

    const choiceFn = () => 'overwrite';
    const stats = runInstall({
      source, target, dryRun: false,
      interactive: true, choiceFn,
    });

    expect(stats.merged).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(target, '.claude', 'core', 'install.js'), 'utf8'))
      .toBe(newContent);
  });
});

// ── runInstall: do-not-ship excludes ─────────────────────────────────────────

describe('runInstall — do-not-ship excludes', () => {
  it('does NOT copy agent-memory/** files', () => {
    const source = buildSource(tmp, [
      'core/install.js',
      'agent-memory/general-purpose/foo.json',
    ]);
    const target = buildTarget(tmp);

    runInstall({ source, target, dryRun: false, interactive: false });

    expect(fs.existsSync(path.join(target, '.claude', 'agent-memory'))).toBe(false);
  });

  it('does NOT copy settings.local.json', () => {
    const source = buildSource(tmp, [
      'core/install.js',
      'settings.local.json',
    ]);
    const target = buildTarget(tmp);

    runInstall({ source, target, dryRun: false, interactive: false });

    expect(fs.existsSync(path.join(target, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('does NOT copy push-guardrail.json', () => {
    const source = buildSource(tmp, [
      'core/install.js',
      'push-guardrail.json',
    ]);
    const target = buildTarget(tmp);

    runInstall({ source, target, dryRun: false, interactive: false });

    expect(fs.existsSync(path.join(target, '.claude', 'push-guardrail.json'))).toBe(false);
  });

  it('does NOT copy skills-optional/** files', () => {
    const source = buildSource(tmp, [
      'core/install.js',
      'skills-optional/react-patterns/SKILL.md',
    ]);
    const target = buildTarget(tmp);

    runInstall({ source, target, dryRun: false, interactive: false });

    expect(fs.existsSync(path.join(target, '.claude', 'skills-optional'))).toBe(false);
  });

  it('does NOT copy agents-optional/** files', () => {
    const source = buildSource(tmp, [
      'core/install.js',
      'agents-optional/custom-agent.md',
    ]);
    const target = buildTarget(tmp);

    runInstall({ source, target, dryRun: false, interactive: false });

    expect(fs.existsSync(path.join(target, '.claude', 'agents-optional'))).toBe(false);
  });

  it('DOES copy regular files that are not excluded (sanity check)', () => {
    const source = buildSource(tmp, [
      'core/install.js',
      'agents/general-purpose.md',
    ]);
    const target = buildTarget(tmp);

    runInstall({ source, target, dryRun: false, interactive: false });

    expect(fs.existsSync(path.join(target, '.claude', 'core', 'install.js'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.claude', 'agents', 'general-purpose.md'))).toBe(true);
  });
});

// ── runInstall: dry-run ───────────────────────────────────────────────────────

describe('runInstall — dry-run', () => {
  it('writes NOTHING to the target .claude/ when dryRun is true', () => {
    const source = buildSource(tmp, [
      'core/install.js',
      'agents/general-purpose.md',
    ]);
    const target = buildTarget(tmp);

    const stats = runInstall({ source, target, dryRun: true, interactive: false });

    expect(stats.dryRun).toBe(true);
    // Target .claude/ must not exist at all
    expect(fs.existsSync(path.join(target, '.claude'))).toBe(false);
    // Stats should still report what WOULD have been created
    expect(stats.created).toBeGreaterThan(0);
  });

  it('dry-run does NOT write MERGE-NOTES.md when conflicts occur', () => {
    const source = buildSource(tmp, ['core/install.js']);
    const target = buildTarget(tmp);

    // Pre-populate a conflict
    fs.mkdirSync(path.join(target, '.claude', 'core'), { recursive: true });
    fs.writeFileSync(path.join(target, '.claude', 'core', 'install.js'), 'OLD', 'utf8');

    const stats = runInstall({ source, target, dryRun: true, interactive: false });

    expect(stats.dryRun).toBe(true);
    expect(fs.existsSync(path.join(target, '.claude', 'MERGE-NOTES.md'))).toBe(false);
  });
});

// ── runInstall: existing .claude/ → recommendedReSync ────────────────────────

describe('runInstall — existing .claude/ merge-mode recommendation', () => {
  it('sets recommendedReSync on stats when target already has .claude/', () => {
    const source = buildSource(tmp, ['core/install.js']);
    const target = buildTarget(tmp);

    // Simulate an existing .claude/ install
    fs.mkdirSync(path.join(target, '.claude'), { recursive: true });

    const stats = runInstall({ source, target, dryRun: false, interactive: false });

    expect(stats.recommendedReSync).toBe(true);
  });

  it('does NOT set recommendedReSync when target has no .claude/', () => {
    const source = buildSource(tmp, ['core/install.js']);
    const target = buildTarget(tmp);

    const stats = runInstall({ source, target, dryRun: false, interactive: false });

    expect(stats.recommendedReSync).toBeFalsy();
  });
});

// ── runInstall: error cases ───────────────────────────────────────────────────

describe('runInstall — preflight errors', () => {
  it('returns early with ok=false + error when target does not exist (no process.exitCode side effect)', () => {
    const source = buildSource(tmp, ['core/install.js']);
    const before = process.exitCode;

    const stats = runInstall({
      source,
      target: path.join(tmp.root, 'does-not-exist'),
      dryRun: false,
      interactive: false,
    });

    expect(stats.created).toBe(0);
    expect(stats.ok).toBe(false);
    expect(typeof stats.error).toBe('string');
    // runInstall must NOT mutate global process.exitCode — that's main()'s job.
    expect(process.exitCode).toBe(before);
  });
});

// ── runInstall: --force must NOT clobber the adopter's docs/root via scaffold ────
//
// Regression guard for the CRITICAL found in review: install's --force means
// "overwrite conflicting .claude/ files", NOT "overwrite the adopter's docs/ and
// repo-root files". scaffold.js's own `force` means the latter. runInstall must
// always call scaffold with force:false regardless of install --force, else
// `install --force` silently replaces the adopter's root .gitignore.
describe('runInstall — --force does not propagate into scaffold', () => {
  it('invokes the target scaffold with force:false even when install --force is set', () => {
    // Synthetic source whose .claude/core/scaffold.js is a STUB that records the
    // `force` value it receives. install copies it into the target, then requires
    // and runs it — so the recorded value is exactly what runInstall passed.
    const source = buildSource(tmp, ['core/install.js']);
    const stub =
      "module.exports = { runScaffold: (target, opts) => {\n" +
      "  require('fs').writeFileSync(require('path').join(target, 'scaffold-force.txt'), String(opts && opts.force));\n" +
      "} };\n";
    tmp.write(path.join('source', '.claude', 'core', 'scaffold.js'), stub);

    const target = buildTarget(tmp);
    const stats = runInstall({ source, target, dryRun: false, interactive: false, force: true });

    const recorded = fs.readFileSync(path.join(target, 'scaffold-force.txt'), 'utf8');
    expect(recorded).toBe('false');     // NOT 'true' — the fix
    expect(stats.ok).toBe(true);
  });
});

// ── runInstall: symlinked-ancestor guard (MED — install.js:302,318 containRoot) ──
//
// copyFile() forwards `target` as containRoot at both call sites so
// assertNoSymlinkedAncestor (fs-safe.js) actually fires when a brownfield
// target has replaced a directory under .claude/ with a symlink pointing
// outside the tree — e.g. `.claude/core -> /external-dir`. Without
// containRoot the guard is a silent no-op and the write follows the link
// out of the project, clobbering an arbitrary external path.
describe.skipIf(!canSymlink)('runInstall — symlinked-ancestor guard', () => {
  it('refuses a NEW-file copy through a symlinked .claude/core, leaving the external dir untouched', () => {
    const source = buildSource(tmp, ['core/foo.js']);
    const target = buildTarget(tmp);

    // External directory OUTSIDE the target tree — the attack's intended victim.
    const externalDir = tmp.mkdir('external-dir');

    // Replace .claude/core with a symlink to the external directory before install
    // ever creates it — simulating a brownfield/compromised target.
    fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
    fs.symlinkSync(externalDir, path.join(target, '.claude', 'core'), 'dir');

    // The new-file branch (install.js ~302) must throw rather than silently
    // writing through the symlinked ancestor.
    expect(() => runInstall({ source, target, dryRun: false, interactive: false }))
      .toThrow(/symlinked ancestor/);

    // The external directory must remain exactly as it was — empty.
    expect(fs.readdirSync(externalDir)).toHaveLength(0);
  });

  it('refuses an OVERWRITE-conflict copy through a symlinked .claude/core, leaving the external file untouched', () => {
    const newContent = '# new content from source';
    const source = buildSource(tmp, ['core/foo.js']);
    fs.writeFileSync(
      path.join(tmp.root, 'source', '.claude', 'core', 'foo.js'),
      newContent, 'utf8'
    );
    const target = buildTarget(tmp);

    // External directory holds a pre-existing "foo.js" so destAbs (reached via
    // the .claude/core symlink) already exists — this drives install into the
    // conflict/overwrite branch (install.js ~318), not the new-file branch.
    const externalDir = tmp.mkdir('external-dir');
    const externalContent = 'ORIGINAL EXTERNAL CONTENT — must not be clobbered';
    fs.writeFileSync(path.join(externalDir, 'foo.js'), externalContent, 'utf8');

    fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
    fs.symlinkSync(externalDir, path.join(target, '.claude', 'core'), 'dir');

    expect(() => runInstall({ source, target, dryRun: false, force: true, interactive: false }))
      .toThrow(/symlinked ancestor/);

    // The external file's content must be exactly what it was before install ran.
    expect(fs.readFileSync(path.join(externalDir, 'foo.js'), 'utf8')).toBe(externalContent);
  });

  it('still copies normally into a target with no symlinked ancestors (regression: containRoot does not break the ordinary case)', () => {
    const source = buildSource(tmp, ['core/foo.js']);
    const target = buildTarget(tmp);

    const stats = runInstall({ source, target, dryRun: false, interactive: false });

    expect(stats.ok).toBe(true);
    expect(stats.created).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(target, '.claude', 'core', 'foo.js'))).toBe(true);
  });
});

// ── Wave-2 review class-closure: raw writes in install.js that skipped fs-safe ──
// M1 (CLAUDE.md stub) + M2 (MERGE-NOTES append) were the two raw-write survivors
// of this wave's symlink-containment class, in the very module 2C hardened.
describe.skipIf(!canSymlink)('runInstall — CLAUDE.md stub is symlink-safe (M1)', () => {
  it('does NOT create the external target when CLAUDE.md is a DANGLING symlink', () => {
    const source = buildSource(tmp, ['core/foo.js']);
    const target = buildTarget(tmp);
    // dangling: link target does not exist — existsSync(CLAUDE.md) follows it → false,
    // so the "absent" branch runs and a raw write would create the external file.
    const external = path.join(tmp.root, 'EXTERNAL_claudemd.txt');
    fs.symlinkSync(external, path.join(target, 'CLAUDE.md'));

    runInstall({ source, target, dryRun: false, interactive: false, keepAll: true });

    expect(fs.existsSync(external)).toBe(false);           // stub never written through the link
    // the dangling link is replaced by a real stub file in the project root
    const st = fs.lstatSync(path.join(target, 'CLAUDE.md'));
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
  });

  it('still writes a real CLAUDE.md stub in the ordinary (no-symlink) case', () => {
    const source = buildSource(tmp, ['core/foo.js']);
    const target = buildTarget(tmp);

    runInstall({ source, target, dryRun: false, interactive: false, keepAll: true });

    const md = path.join(target, 'CLAUDE.md');
    expect(fs.existsSync(md)).toBe(true);
    expect(fs.lstatSync(md).isSymbolicLink()).toBe(false);
  });
});

describe.skipIf(!canSymlink)('writeMergeNotes — symlink-safe append (M2)', () => {
  it('does NOT append through a symlinked MERGE-NOTES.md leaf; replaces it with a real file', () => {
    const target = buildTarget(tmp);
    const claude = path.join(target, '.claude');
    fs.mkdirSync(claude, { recursive: true });
    const external = path.join(tmp.root, 'NOTES_victim.md');
    fs.writeFileSync(external, 'ORIGINAL_VICTIM\n', 'utf8');
    fs.symlinkSync(external, path.join(claude, 'MERGE-NOTES.md'));

    writeMergeNotes(claude, ['some/conflict.md'], target);

    expect(fs.readFileSync(external, 'utf8')).toBe('ORIGINAL_VICTIM\n'); // victim untouched
    const st = fs.lstatSync(path.join(claude, 'MERGE-NOTES.md'));
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    expect(fs.readFileSync(path.join(claude, 'MERGE-NOTES.md'), 'utf8')).toContain('some/conflict.md');
  });

  it('refuses to write MERGE-NOTES through a symlinked .claude ANCESTOR', () => {
    const target = buildTarget(tmp);
    const externalDir = path.join(tmp.root, 'external-claude');
    fs.mkdirSync(externalDir, { recursive: true });
    fs.symlinkSync(externalDir, path.join(target, '.claude'), 'dir');

    expect(() => writeMergeNotes(path.join(target, '.claude'), ['c.md'], target))
      .toThrow(/symlinked ancestor/);
    expect(fs.readdirSync(externalDir)).toEqual([]); // nothing written into the victim dir
  });

  it('preserves prior history from a genuine regular MERGE-NOTES.md (append semantics intact)', () => {
    const target = buildTarget(tmp);
    const claude = path.join(target, '.claude');
    fs.mkdirSync(claude, { recursive: true });
    const notes = path.join(claude, 'MERGE-NOTES.md');
    fs.writeFileSync(notes, '# .claude/ Merge Notes\n\nPRIOR_RUN_MARKER\n\n', 'utf8');

    writeMergeNotes(claude, ['later/conflict.md'], target);

    const out = fs.readFileSync(notes, 'utf8');
    expect(out).toContain('PRIOR_RUN_MARKER');       // history preserved
    expect(out).toContain('later/conflict.md');      // new section appended
  });
});

// Direct installer front doors exercise real canonical and native entry points.

const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INSTALL_ENTRIES = ['.agents/core/install.js', '.claude/core/install.js', '.codex/core/install.js'];
const EXPECTED_INSTALL_SCOPE = ['.agents', '.claude', '.codex', '.gitignore', '.playwright', 'AGENTS.md', 'CLAUDE.md', 'docs'];

function productionEngineCallers(sourceRoot) {
  const callers = [];
  const isIgnored = ignoredFilter(sourceRoot);
  const skip = new Set(['node_modules', '__tests__', '_helpers', '.git', 'docs']);
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(sourceRoot, abs).replace(/\\/g, '/');
      if (isIgnored(entry.isDirectory() ? `${rel}/` : rel)) continue;
      // A nested clone or linked worktree belongs to its own source tree.
      if (entry.isDirectory()) {
        if (!fs.existsSync(path.join(abs, '.git'))) walk(abs);
      } else if (/\.(?:c|m)?js$/.test(entry.name) && /\brun(?:Install|Update)\s*\(/.test(fs.readFileSync(abs, 'utf8'))) {
        callers.push(rel);
      }
    }
  })(sourceRoot);
  return callers.sort();
}

describe('production engine caller scan', () => {
  const gitAt = (args) => execFileSync('git', ['-C', tmp.root, ...args], { encoding: 'utf8', windowsHide: true });

  it('publicPathGuard_ignoredFilesAndTrees_excludesDecoysWithoutExcludingTheirSibling', () => {
    gitAt(['init', '--quiet']);
    tmp.write('.gitignore', 'local-copies/\n*.local.js\n');
    tmp.write('.git/info/exclude', 'private-copy/\n');
    tmp.write('local-copies/core/install.js', 'runInstall({});\n');
    tmp.write('private-copy/core/update.cjs', 'runUpdate({});\n');
    tmp.write('tools/decoy.local.js', 'runInstall({});\n');
    tmp.write('local-copies-sibling/caller.mjs', 'runUpdate({});\n');

    expect(productionEngineCallers(tmp.root)).toEqual(['local-copies-sibling/caller.mjs']);
  });

  it.each(['directory', 'file'])('publicPathGuard_nestedGit_%s_excludesForeignCallers', kind => {
    gitAt(['init', '--quiet']);
    if (kind === 'directory') tmp.mkdir('nested-checkout/.git');
    else tmp.write('nested-checkout/.git', 'gitdir: ../external-git-dir\n');
    tmp.write('nested-checkout/.agents/core/install.js', 'runInstall({});\n');
    tmp.write('tools/caller.js', 'runUpdate({});\n');

    expect(productionEngineCallers(tmp.root)).toEqual(['tools/caller.js']);
  });

  it.each(['tracked', 'untracked', 'trackedIgnoredPattern'])('publicPathGuard_unexpectedProductionCaller_%s_remainsDetected', kind => {
    gitAt(['init', '--quiet']);
    tmp.write('.gitignore', '*.local.js\n');
    const caller = kind === 'trackedIgnoredPattern' ? 'tools/unexpected.local.js' : 'tools/unexpected.js';
    tmp.write(caller, 'runInstall({});\nrunUpdate({});\n');
    if (kind !== 'untracked') gitAt(['add', '-f', '--', caller]);

    expect(productionEngineCallers(tmp.root)).toEqual([caller]);
  });
});

function cliEnv(extra = {}) {
  const env = { ...process.env };
  // No inherited runtime/source/Git override may reach the entry point under
  // test; each case states exactly which environment it supplies.
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key) || key === 'CLAUDE_PROJECT_DIR' || key === 'AGENTS_RUNTIME' || key === 'AGENT_RUNTIME') delete env[key];
  }
  return { ...env, ...extra };
}

function runEntry(entry, args, env = {}) {
  const result = spawnSync(process.execPath, [path.join(TOOLKIT, entry), ...args], {
    cwd: TOOLKIT, env: cliEnv(env), encoding: 'utf8', timeout: 90000,
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function gitAt(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    env: cliEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' }),
    encoding: 'utf8',
  }).trim();
}

function snapshotTree(root) {
  const files = {};
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) files[rel] = `symlink:${fs.readlinkSync(abs)}`;
      else if (entry.isDirectory()) { files[`${rel}/`] = 'directory'; walk(abs); }
      else files[rel] = fs.readFileSync(abs).toString('base64');
    }
  })(root);
  return files;
}

/** Disposable adopter checkout with committed, staged and unstaged project work. */
function seedAdopter(root, name = 'Internal.App') {
  const target = path.join(root, `${name} with spaces`);
  fs.mkdirSync(target, { recursive: true });
  gitAt(target, ['init', '--initial-branch=main']);
  gitAt(target, ['config', 'user.name', 'Fixture Maintainer']);
  gitAt(target, ['config', 'user.email', 'fixture@example.invalid']);
  fs.writeFileSync(path.join(target, 'README.md'), '# Project baseline\n');
  fs.writeFileSync(path.join(target, 'CLAUDE.md'), '# PROJECT_OWNED_INSTRUCTIONS\n\nKeep this project rule.\n');
  gitAt(target, ['add', '--', 'README.md', 'CLAUDE.md']);
  gitAt(target, ['commit', '-m', 'adopter baseline']);
  fs.writeFileSync(path.join(target, 'README.md'), '# Existing staged project work\n');
  gitAt(target, ['add', '--', 'README.md']);
  fs.writeFileSync(path.join(target, 'unstaged-notes.txt'), 'existing unstaged project work\n');
  return target;
}

describe('direct install front door', () => {
  let root;
  beforeEach(() => { root = fs.realpathSync.native(tmp.mkdir('direct-install')); });

  it.each(INSTALL_ENTRIES)('installCli_%s_helpDocumentsOrdinaryDomdhiInstallation', entry => {
    const result = runEntry(entry, ['--help']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Domdhi.Agents toolkit');
    expect(result.output).not.toMatch(/--policy|--target-id/);
    expect((result.output.match(/[A-Za-z0-9_-]+\.Agents/g) || []).every(name => name === 'Domdhi.Agents')).toBe(true);
  });

  it('installScope_realToolkit_coversEveryInstallerAndScaffoldOutput', () => {
    expect(installScope(TOOLKIT)).toEqual(EXPECTED_INSTALL_SCOPE);
  });

  it('installCli_freshDisposableAdopterWithSpaces_preflightsThenInstallsAndPreservesProjectWork', () => {
    const target = seedAdopter(root);
    const index = fs.readFileSync(path.join(target, '.git/index'));
    const head = gitAt(target, ['rev-parse', 'HEAD']);

    const result = runEntry('.codex/core/install.js', [target, '--keep']);

    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(target, '.claude/version.json'), 'utf8')))
      .toEqual(JSON.parse(fs.readFileSync(path.join(TOOLKIT, '.agents/config/version.json'), 'utf8')));
    for (const rel of ['.agents/startup.md', '.codex/agents/qa-engineer.toml', 'AGENTS.md', 'docs', '.playwright/cli.config.json']) {
      expect(fs.existsSync(path.join(target, rel)), rel).toBe(true);
    }
    expect(fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8')).toContain('# PROJECT_OWNED_INSTRUCTIONS\n\nKeep this project rule.');
    expect(fs.readFileSync(path.join(target, '.git/index'))).toEqual(index);
    expect(gitAt(target, ['rev-parse', 'HEAD'])).toBe(head);
    expect(gitAt(target, ['diff', '--cached', '--name-only'])).toBe('README.md');
    expect(fs.readFileSync(path.join(target, 'unstaged-notes.txt'), 'utf8')).toBe('existing unstaged project work\n');
  }, 120000);

  it.each([
    ['invalid JSON', '{ not json'],
    ['non-array skillExclude', JSON.stringify({ skillExclude: 'tailwind-css-patterns' })],
    ['non-string exclusion', JSON.stringify({ skillExclude: [42] })],
  ])('installCli_malformedProjectUpdateConfig_%s_refusesBeforeAnyWrite', (_label, bytes) => {
    const target = seedAdopter(root);
    fs.mkdirSync(path.join(target, '.claude'));
    fs.writeFileSync(path.join(target, '.claude/update-config.json'), bytes);
    const before = snapshotTree(target);

    const result = runEntry('.agents/core/install.js', [target]);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toMatch(/CONFIG/);
    expect(snapshotTree(target)).toEqual(before);
  }, 60000);

  it('preflightInstall_missingSourceAssets_refusesWhileTheCompleteToolkitPasses', () => {
    const target = seedAdopter(root);
    const incomplete = path.join(root, 'incomplete-toolkit');
    fs.mkdirSync(path.join(incomplete, '.claude/core'), { recursive: true });
    fs.writeFileSync(path.join(incomplete, '.claude/core/install.js'), '// no scaffold or templates\n');
    const before = snapshotTree(target);

    const missing = preflightInstall({ source: incomplete, target });
    expect(missing.ok).toBe(false);
    expect(missing.exitCode).toBe(1);
    expect(missing.errors.map(error => error.code)).toEqual(['ASSETS']);

    const complete = preflightInstall({ source: TOOLKIT, target, dryRun: true });
    expect(complete).toMatchObject({ ok: true, exitCode: 0, operation: 'install', dryRun: true });
    expect(complete.scope).toEqual(EXPECTED_INSTALL_SCOPE);
    expect(snapshotTree(target)).toEqual(before);
  }, 60000);

  it('installCli_generatedProjectionConflict_refusesWithoutMarkerInstructionSettingsOrIndexChanges', () => {
    const target = seedAdopter(root);
    const args = [target, '--keep'];
    expect(runEntry('.agents/core/install.js', args).code).toBe(0);
    fs.writeFileSync(path.join(target, '.claude/version.json'), '{ "version": "0.0" }\n');
    fs.appendFileSync(path.join(target, '.codex/agents/qa-engineer.toml'), '\n# LOCAL GENERATED EDIT\n');
    fs.writeFileSync(path.join(target, '.claude/settings.local.json'), '{ "local": "KEEP" }\n');
    const before = snapshotTree(target);

    const result = runEntry('.claude/core/install.js', args);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toMatch(/conflict/i);
    expect(result.output).toContain('.codex/agents/qa-engineer.toml');
    expect(snapshotTree(target)).toEqual(before);
  }, 120000);

  it('runInstall_scaffoldFailure_reportsFailureAndWithholdsTheVersionMarker', () => {
    const source = path.join(root, 'source');
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true }); fs.writeFileSync(path.join(source, rel), text); };
    write('.agents/config/version.json', '{ "version": "9.9" }\n');
    write('.claude/core/scaffold.js', "module.exports = { runScaffold() { throw new Error('missing scaffold asset'); } };\n");
    write('.claude/templates/README.md', 'template\n');
    const quiet = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    let failed;
    let succeeded;
    try {
      failed = runInstall({ source, target: buildTarget(tmp, 'failed-target') });
      write('.claude/core/scaffold.js', 'module.exports = { runScaffold() {} };\n');
      succeeded = runInstall({ source, target: buildTarget(tmp, 'passing-target') });
    } finally { Object.assign(console, quiet); }

    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/scaffold/i);
    expect(fs.existsSync(path.join(tmp.root, 'failed-target/.claude/version.json'))).toBe(false);
    // Positive control: the same marker is rendered when every phase succeeds.
    expect(succeeded.ok, JSON.stringify(succeeded)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(tmp.root, 'passing-target/.claude/version.json'), 'utf8'))).toEqual({ version: '9.9' });
  });

  it('installScope_keptTargetRootTemplates_areIncludedWithoutADeclaration', () => {
    const target = seedAdopter(root);
    fs.mkdirSync(path.join(target, '.claude/templates/root'), { recursive: true });
    fs.writeFileSync(path.join(target, '.claude/templates/root/extra-root-config.json'), '{}\n');
    expect(installScope(TOOLKIT, target)).toContain('extra-root-config.json');
    const before = snapshotTree(target);
    const result = runEntry('.codex/core/install.js', [target, '--keep', '--dry-run']);
    expect(result.code, result.output).toBe(0);
    expect(snapshotTree(target)).toEqual(before);
  }, 60000);

  it('runInstall_toolkitClaudeMd_isDeliveredAsTheTemplateDocsTheUpdaterWouldWrite', () => {
    // NA7.14: install and update must agree about one release; the first update after an install used to
    // write .claude/README.md because only the updater applied the doc redirect.
    const source = path.join(root, 'redirect-source');
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true }); fs.writeFileSync(path.join(source, rel), text); };
    write('.agents/config/version.json', '{ "version": "9.9" }\n');
    write('.claude/core/scaffold.js', 'module.exports = { runScaffold() {} };\n');
    write('.claude/templates/README.md', 'template\n');
    write('CLAUDE.md', '# Toolkit working instructions\n');
    const quiet = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    let fresh;
    let kept;
    try {
      fresh = runInstall({ source, target: buildTarget(tmp, 'redirect-fresh') });
      const existing = buildTarget(tmp, 'redirect-existing');
      fs.mkdirSync(path.join(existing, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(existing, '.claude/README.md'), '# Project-owned notes\n');
      kept = runInstall({ source, target: existing, keepAll: true });
    } finally { Object.assign(console, quiet); }

    expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
    expect(fs.readFileSync(path.join(tmp.root, 'redirect-fresh/.claude/README.md'), 'utf8')).toBe('# Toolkit working instructions\n');
    // A different existing file is a conflict like any other .claude/ file, kept without --force.
    expect(kept.ok, JSON.stringify(kept)).toBe(true);
    expect(kept.conflicts).toContain('README.md');
    expect(fs.readFileSync(path.join(tmp.root, 'redirect-existing/.claude/README.md'), 'utf8')).toBe('# Project-owned notes\n');
  });

  it('runInstall_excludedSkill_isAlreadyStrippedFromAFreshRoleLikeTheUpdaterMerge', () => {
    const source = path.join(root, 'exclude-source');
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true }); fs.writeFileSync(path.join(source, rel), text); };
    write('.agents/config/version.json', '{ "version": "9.9" }\n');
    write('.claude/core/scaffold.js', 'module.exports = { runScaffold() {} };\n');
    write('.claude/templates/README.md', 'template\n');
    write('.agents/roles/ux-designer.md', [
      '---', 'name: ux-designer', 'description: UX design specifications', 'skills:', '  - ux-design', '  - tailwind-css-patterns', '---', '',
      '## Skills', '',
      '- `.agents/skills/ux-design/SKILL.md` - design', '- `.agents/skills/tailwind-css-patterns/SKILL.md` - utility CSS', '',
    ].join('\n'));
    const target = buildTarget(tmp, 'exclude-target');
    fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(target, '.claude/update-config.json'), '{ "skillExclude": ["tailwind-css-patterns"] }\n');
    const quiet = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    let stats;
    try { stats = runInstall({ source, target }); } finally { Object.assign(console, quiet); }

    expect(stats.ok, JSON.stringify(stats)).toBe(true);
    const role = fs.readFileSync(path.join(target, '.agents/roles/ux-designer.md'), 'utf8');
    expect(role).toContain('ux-design/SKILL.md');
    expect(role).not.toContain('tailwind-css-patterns');
  });

  it('runInstall_legacySourceMarker_isCopiedLastOnlyWhenEveryPhaseSucceeds', () => {
    // A legacy (pre-canonical) source ships .claude/version.json as an ordinary
    // file rather than a projection; it is still the install-complete marker.
    const source = path.join(root, 'legacy-source');
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true }); fs.writeFileSync(path.join(source, rel), text); };
    write('.claude/version.json', '{ "version": "5.2" }\n');
    write('.claude/core/scaffold.js', "module.exports = { runScaffold() { throw new Error('missing scaffold asset'); } };\n");
    write('.claude/templates/README.md', 'template\n');
    const quiet = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    let failed;
    let succeeded;
    try {
      failed = runInstall({ source, target: buildTarget(tmp, 'legacy-failed') });
      write('.claude/core/scaffold.js', 'module.exports = { runScaffold() {} };\n');
      succeeded = runInstall({ source, target: buildTarget(tmp, 'legacy-passing') });
    } finally { Object.assign(console, quiet); }

    expect(failed.ok).toBe(false);
    expect(fs.existsSync(path.join(tmp.root, 'legacy-failed/.claude/version.json'))).toBe(false);
    expect(succeeded.ok, JSON.stringify(succeeded)).toBe(true);
    expect(fs.readFileSync(path.join(tmp.root, 'legacy-passing/.claude/version.json'), 'utf8')).toBe('{ "version": "5.2" }\n');
  });

  it.each(INSTALL_ENTRIES)('installCli_%s_acceptsANeutralNonGitProjectWithoutPolicyFlags', entry => {
    const target = path.join(root, 'neutral project with spaces');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'project.txt'), 'KEEP_PROJECT\n');
    const result = runEntry(entry, [target, '--keep']);
    expect(result.code, result.output).toBe(0);
    expect(fs.readFileSync(path.join(target, 'project.txt'), 'utf8')).toBe('KEEP_PROJECT\n');
    expect(fs.existsSync(path.join(target, '.claude/version.json'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.codex/agents/qa-engineer.toml'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.git'))).toBe(false);
  }, 120000);

  it.each(INSTALL_ENTRIES)('installCli_%s_dryRunWritesNothing', entry => {
    const target = seedAdopter(root);
    const before = snapshotTree(target);
    const result = runEntry(entry, [target, '--dry-run']);
    expect(result.code, result.output).toBe(0);
    expect(snapshotTree(target)).toEqual(before);
  }, 60000);

  it.each(INSTALL_ENTRIES)('publicEntry_%s_refusesMissingTargets', entry => {
    const target = path.join(root, 'missing target');
    const result = runEntry(entry, [target]);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toMatch(/TARGET/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it.skipIf(!canSymlink).each(['.claude/core', '.agents/roles', '.codex/agents', 'AGENTS.md', '.gitignore'])('publicEntry_symlinkAt_%s_refusesBeforeAnyReadOrWrite', rel => {
    const target = seedAdopter(root);
    const external = path.join(root, 'external');
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, 'sentinel.txt'), 'EXTERNAL_KEEP\n');
    fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
    fs.symlinkSync(external, path.join(target, rel), 'dir');
    const before = snapshotTree(target);
    const outside = snapshotTree(external);
    for (const entry of INSTALL_ENTRIES) {
      for (const dryRun of [false, true]) {
        const result = runEntry(entry, [target, ...(dryRun ? ['--dry-run'] : [])]);
        expect(result.code, result.output).toBe(1);
        expect(result.output).toMatch(/PATH/);
        expect(snapshotTree(target)).toEqual(before);
        expect(snapshotTree(external)).toEqual(outside);
      }
    }
  });

  it('publicPathGuard_noProductionModuleCallsTheInstallOrUpdateEngineAroundItsPreflight', () => {
    // Only the two canonical modules define and front-door their engines;
    // generated wrappers delegate to those canonical entry points.
    expect(productionEngineCallers(TOOLKIT)).toEqual(['.agents/core/install.js', '.agents/core/template-updater.js']);
    for (const runtime of ['.claude', '.codex']) {
      for (const name of ['install.js', 'template-updater.js']) {
        const wrapper = fs.readFileSync(path.join(TOOLKIT, runtime, 'core', name), 'utf8');
        expect(wrapper).toContain(`require('path').resolve(__dirname, "../../.agents/core/${name}")`);
        expect(wrapper).toContain('spawnSync(process.execPath, [entry, ...process.argv.slice(2)]');
      }
    }
  });
});

// ── NA5.1 AC2: a malformed release source refuses before any install write ────
//
// Missing source assets are refused by preflightInstall (NA2.6 above). A source
// that is present but malformed — a truncated role frontmatter or a skill whose
// declared name is not its directory — must also leave the adopter untouched,
// with no version marker, while the corrected source installs normally.

describe('NA5.1 malformed release source', () => {
  const VALID_ROLE = '---\nname: qa-engineer\nnickname: Murphy\ndescription: QA role.\nskills:\n  - review-specialize\n---\n\n# Murphy\n\nSoul.\n\n## Skills\n\nRELEASE_ROLE\n';
  const VALID_SKILL = '---\nname: review-specialize\ndescription: Use when specializing a project.\n---\n\n# Specialize\n\nRELEASE_SKILL\n';

  function releaseSource(root, overrides) {
    const files = {
      '.agents/config/version.json': '{ "version": "9.9" }\n',
      '.agents/roles/qa-engineer.md': VALID_ROLE,
      '.agents/skills/review-specialize/SKILL.md': VALID_SKILL,
      '.claude/core/scaffold.js': 'module.exports = { runScaffold() {} };\n',
      '.claude/templates/README.md': 'template\n',
      ...overrides,
    };
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    return root;
  }

  it.each([
    ['truncated role frontmatter', { '.agents/roles/qa-engineer.md': '---\nname: qa-engineer\nnickname: Murphy\ndescription: truncated release file\n' }, /missing name in canonical frontmatter/],
    ['skill name that is not its directory', { '.agents/skills/review-specialize/SKILL.md': VALID_SKILL.replace('name: review-specialize', 'name: specialize-renamed') }, /skill name must match review-specialize/],
  ])('runInstall_malformedSource_%s_refusesBeforeAnyWriteWithoutTheVersionMarker', (_label, overrides, message) => {
    const target = path.join(tmp.root, 'Internal.App with spaces');
    fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(target, 'CLAUDE.md'), '# PROJECT_OWNED_INSTRUCTIONS\n\nKeep this project rule.\n');
    fs.writeFileSync(path.join(target, '.claude/settings.local.json'), '{ "local": "KEEP" }\n');
    const before = snapshotTree(target);
    const quiet = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    let installed;
    try {
      expect(() => runInstall({ source: releaseSource(path.join(tmp.root, 'malformed release'), overrides), target })).toThrow(message);
      expect(snapshotTree(target)).toEqual(before);
      expect(fs.existsSync(path.join(target, '.claude/version.json'))).toBe(false);
      // Positive control: the corrected release installs the same target and writes the marker last.
      installed = runInstall({ source: releaseSource(path.join(tmp.root, 'corrected release'), {}), target });
    } finally { Object.assign(console, quiet); }
    expect(installed.ok, JSON.stringify(installed)).toBe(true);
    expect(installed.conflicts).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(target, '.claude/version.json'), 'utf8'))).toEqual({ version: '9.9' });
    expect(fs.readFileSync(path.join(target, '.codex/agents/qa-engineer.toml'), 'utf8')).toContain('RELEASE_ROLE');
    expect(fs.readFileSync(path.join(target, '.claude/skills/review-specialize/SKILL.md'), 'utf8')).toContain('RELEASE_SKILL');
    expect(fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8')).toContain('# PROJECT_OWNED_INSTRUCTIONS\n\nKeep this project rule.');
    expect(fs.readFileSync(path.join(target, '.claude/settings.local.json'), 'utf8')).toBe('{ "local": "KEEP" }\n');
  });
});

// NA5.18 AC1/AC2: install walks the source .claude/ tree from the filesystem, so
// a Git-ignored harness file in the workshop (the NA5.4 dry-run found a live
// .claude/scheduled_tasks.lock) would land in every fresh adopter. Ignored files
// never install; a tracked file matching an ignore pattern still does; a failed
// ignore query inside a real checkout refuses before any target write.
describe('runInstall — Git-ignored source files never install (NA5.18)', () => {
  function gitSource() {
    const source = buildSource(tmp, ['core/install.js', 'core/kept.log']);
    tmp.write('empty-gitconfig', '');
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp.root, 'empty-gitconfig') };
    for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|TRACE.*)$/.test(key)) delete env[key];
    execFileSync('git', ['-C', source, 'init', '--quiet', '--initial-branch=main'], { env, windowsHide: true });
    tmp.write('source/.git/info/exclude', '.claude/scheduled_tasks.lock\n.claude/worktrees/\n*.log\n');
    tmp.write('source/.claude/scheduled_tasks.lock', '{"sessionId":"LOCAL_SESSION_SENTINEL"}');
    tmp.write('source/.claude/worktrees/w1/file.txt', 'LOCAL_WORKTREE_SENTINEL');
    execFileSync('git', ['-C', source, 'add', '-f', '--', '.claude/core/kept.log'], { env, windowsHide: true });
    return source;
  }

  it('runInstall_gitIgnoredHarnessFiles_areNotCopied_trackedPatternMatchIs', () => {
    const source = gitSource();
    const target = buildTarget(tmp);

    runInstall({ source, target, dryRun: false, interactive: false });

    expect(fs.existsSync(path.join(target, '.claude', 'scheduled_tasks.lock'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.claude', 'worktrees'))).toBe(false);
    expect(fs.readFileSync(path.join(target, '.claude', 'core', 'kept.log'), 'utf8')).toBe('# core/kept.log\ncontent');
    expect(fs.existsSync(path.join(target, '.claude', 'core', 'install.js'))).toBe(true);
  });

  it('runInstall_failedIgnoreQueryInARealCheckout_refusesBeforeAnyTargetWrite', () => {
    const source = gitSource();
    tmp.write('source/.git/index', 'not a git index');
    const target = buildTarget(tmp);

    expect(() => runInstall({ source, target, dryRun: false, interactive: false })).toThrow(/^Install source ignored-file query failed/);
    expect(fs.readdirSync(target)).toEqual([]);
  });
});
