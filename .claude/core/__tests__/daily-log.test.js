// AC→source map (TDD-3.1 / daily-log):
//   - Constructor reads CLAUDE_PROJECT_DIR env or falls back to __dirname/../..
//   - capture(trigger='manual') → appends ## HH:MM — {trigger}, branch, commits, in-progress, decisions
//   - captureNote(note, trigger='remember') → appends ## HH:MM — {trigger} + note body
//   - captureCommit(hash, subject, filesChanged, insertions?, deletions?) → appends post-commit entry
//     diffstat line only when BOTH insertions and deletions are finite numbers
//   - findInProgressTodos() → scans docs/work/todo/ AND docs/ for TODO*.md; [>] and [!] markers
//   - findKeyDecisions() → scans docs/ ONLY for TODO*.md; ## Key Decisions table (header+separator required)
//   - All writes go to docs/.output/.state/memory-daily/{YYYY-MM-DD}.md via appendFileSync (same-date = same file)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

const DailyLog = require('../daily-log');
const { createTmpDir } = require('./_helpers/tmp-dir');
const { createGitRepo } = require('./_helpers/git-fixture');

let tmp;
let originalEnv;

beforeEach(() => {
  tmp = createTmpDir();
  originalEnv = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = tmp.root;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = originalEnv;
  tmp.cleanup();
});

// Helper: read daily log for today's date (or a given date)
function readDailyLog(tmpRoot, dateStr) {
  const logPath = path.join(tmpRoot, 'docs', '.output', '.state', 'memory-daily', `${dateStr}.md`);
  return fs.readFileSync(logPath, 'utf8');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------
describe('DailyLog', () => {
  describe('constructor', () => {
    it('constructor_envVar_usesEnvAsProjectRoot', () => {
      // Arrange — CLAUDE_PROJECT_DIR is already set to tmp.root in beforeEach

      // Act
      const log = new DailyLog();

      // Assert
      expect(log.projectRoot).toBe(tmp.root);
    });

    it('constructor_explicitArg_overridesEnv', () => {
      // Arrange
      const explicitRoot = tmp.root + '-explicit';
      fs.mkdirSync(explicitRoot, { recursive: true });

      // Act
      const log = new DailyLog(explicitRoot);

      // Assert
      expect(log.projectRoot).toBe(explicitRoot);

      // Cleanup
      fs.rmSync(explicitRoot, { recursive: true, force: true });
    });

    it('constructor_dailyDir_pointsInsideProjectRoot', () => {
      // Arrange / Act
      const log = new DailyLog();

      // Assert
      const expectedDir = path.join(tmp.root, 'docs', '.output', '.state', 'memory-daily');
      expect(log.dailyDir).toBe(expectedDir);
    });

    // F12: with no explicit arg and no CLAUDE_PROJECT_DIR, the constructor's
    // fallback must route through resolveProjectRoot() (main-worktree-aware)
    // rather than the raw __dirname/../.. fallback — daily-log.js was the one
    // memory-domain module missed by the worktree-root retrofit (see project
    // memory worktree-root-retrofit-must-sweep-all-callsites). Stub
    // _lib/project-root's export the same way memory-backup.test.js's F37
    // does, so this asserts the WIRING (resolveProjectRoot is actually called
    // with daily-log.js's own __dirname/../.. as fallback) without needing a
    // real git worktree fixture.
    it('constructor_noEnvNoArg_routesFallbackThroughResolveProjectRoot', () => {
      delete process.env.CLAUDE_PROJECT_DIR;

      const projectRootCachePath = require.resolve('../_lib/project-root');
      const dailyLogCachePath = require.resolve('../daily-log');
      const savedProjectRoot = require.cache[projectRootCachePath];
      const savedDailyLog = require.cache[dailyLogCachePath];

      let calledWithFallback = null;
      const marker = path.join(tmp.root, 'resolved-via-project-root');

      require.cache[projectRootCachePath] = {
        id: projectRootCachePath, filename: projectRootCachePath, loaded: true, children: [], paths: [],
        exports: {
          resolveProjectRoot: (fallbackDir) => {
            calledWithFallback = fallbackDir;
            return marker;
          },
        },
      };
      delete require.cache[dailyLogCachePath];

      try {
        const FreshDailyLog = require('../daily-log');
        const log = new FreshDailyLog();

        // resolveProjectRoot was invoked with daily-log.js's own __dirname/../..
        expect(calledWithFallback).toBe(path.resolve(path.dirname(dailyLogCachePath), '..', '..'));
        // …and its return value is what the constructor adopted.
        expect(log.projectRoot).toBe(marker);
      } finally {
        if (savedProjectRoot) require.cache[projectRootCachePath] = savedProjectRoot;
        else delete require.cache[projectRootCachePath];
        if (savedDailyLog) require.cache[dailyLogCachePath] = savedDailyLog;
        else delete require.cache[dailyLogCachePath];
      }
    });
  });

  // ---------------------------------------------------------------------------
  // capture()
  // ---------------------------------------------------------------------------
  describe('capture', () => {
    it('capture_freshFile_writesHeadingWithTrigger', () => {
      // Arrange
      const log = new DailyLog();

      // Act
      const { logPath, dateStr } = log.capture('test-trigger');

      // Assert — return value
      expect(typeof logPath).toBe('string');
      expect(typeof dateStr).toBe('string');
      expect(dateStr).toBe(todayStr());

      // Assert — file exists
      expect(fs.existsSync(logPath)).toBe(true);

      // Assert — heading format: ## HH:MM — {trigger}
      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toMatch(/^## \d{2}:\d{2} — test-trigger/);
    });

    it('capture_defaultTrigger_usesManual', () => {
      // Arrange
      const log = new DailyLog();

      // Act
      log.capture();
      const content = readDailyLog(tmp.root, todayStr());

      // Assert
      expect(content).toContain('— manual');
    });

    it('capture_writesBranchSection', () => {
      // Arrange
      const log = new DailyLog();

      // Act
      log.capture('test');
      const content = readDailyLog(tmp.root, todayStr());

      // Assert — **Branch:** line exists (value may be empty string if not in a git repo)
      expect(content).toMatch(/\*\*Branch:\*\*/);
    });

    it('capture_writesRecentCommitsSection', () => {
      // Arrange
      const log = new DailyLog();

      // Act
      log.capture('test');
      const content = readDailyLog(tmp.root, todayStr());

      // Assert
      expect(content).toContain('### Recent Commits');
    });

    it('capture_writesInProgressSection', () => {
      // Arrange
      const log = new DailyLog();

      // Act
      log.capture('test');
      const content = readDailyLog(tmp.root, todayStr());

      // Assert
      expect(content).toContain('### In-Progress Work');
    });

    it('capture_writesKeyDecisionsSection', () => {
      // Arrange
      const log = new DailyLog();

      // Act
      log.capture('test');
      const content = readDailyLog(tmp.root, todayStr());

      // Assert
      expect(content).toContain('### Key Decisions');
    });

    it('capture_withInProgressTodos_includesTodoText', () => {
      // Arrange: write a TODO file with an in-progress marker
      tmp.write('docs/work/todo/TODO_epic01.md', '- [>] Build the widget\n- [ ] Done task\n');
      const log = new DailyLog();

      // Act
      log.capture('test');
      const content = readDailyLog(tmp.root, todayStr());

      // Assert
      expect(content).toContain('[>]');
      expect(content).toContain('Build the widget');
    });

    it('capture_sameDateTwice_appendsToBothEntriesInSameFile', () => {
      // Arrange
      const log = new DailyLog();

      // Act
      log.capture('first');
      log.capture('second');
      const content = readDailyLog(tmp.root, todayStr());

      // Assert — both headings appear in the same file
      expect(content).toContain('— first');
      expect(content).toContain('— second');
    });

    it('capture_logPathMatchesDateStr', () => {
      // Arrange
      const log = new DailyLog();

      // Act
      const { logPath, dateStr } = log.capture('test');

      // Assert
      expect(logPath).toBe(path.join(log.dailyDir, `${dateStr}.md`));
    });
  });

  // ---------------------------------------------------------------------------
  // captureNote()
  // ---------------------------------------------------------------------------
  describe('captureNote', () => {
    it('captureNote_writesNoteBody', () => {
      // Arrange
      const log = new DailyLog();
      const note = 'Use the adapter pattern for all external APIs.';

      // Act
      const { logPath, dateStr } = log.captureNote(note);

      // Assert — return value
      expect(typeof logPath).toBe('string');
      expect(dateStr).toBe(todayStr());

      // Assert — file content contains the note text
      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toContain(note);
    });

    it('captureNote_defaultTrigger_usesRemember', () => {
      // Arrange
      const log = new DailyLog();

      // Act
      log.captureNote('any note');
      const content = readDailyLog(tmp.root, todayStr());

      // Assert
      expect(content).toContain('— remember');
    });

    it('captureNote_customTrigger_usesCustomLabel', () => {
      // Arrange
      const log = new DailyLog();

      // Act
      log.captureNote('note body', 'custom-trigger');
      const content = readDailyLog(tmp.root, todayStr());

      // Assert
      expect(content).toContain('— custom-trigger');
    });

    it('captureNote_headingFormat_timestampedSection', () => {
      // Arrange
      const log = new DailyLog();

      // Act
      log.captureNote('note body');
      const content = readDailyLog(tmp.root, todayStr());

      // Assert — heading matches ## HH:MM — remember
      expect(content).toMatch(/## \d{2}:\d{2} — remember/);
    });

    it('captureNote_doesNotIncludeBranchOrCommits', () => {
      // Arrange
      const log = new DailyLog();

      // Act
      log.captureNote('note body');
      const content = readDailyLog(tmp.root, todayStr());

      // Assert — captureNote writes only heading + note, NOT the capture() sections
      expect(content).not.toContain('### Recent Commits');
      expect(content).not.toContain('### In-Progress Work');
      expect(content).not.toContain('**Branch:**');
    });

    it('captureNote_appendsToExistingCaptureFile', () => {
      // Arrange
      const log = new DailyLog();
      log.capture('first');

      // Act
      log.captureNote('important note');
      const content = readDailyLog(tmp.root, todayStr());

      // Assert — both entries present
      expect(content).toContain('— first');
      expect(content).toContain('important note');
    });
  });

  // ---------------------------------------------------------------------------
  // captureCommit()
  // ---------------------------------------------------------------------------
  describe('captureCommit', () => {
    it('captureCommit_withHash_writesPostCommitHeading', () => {
      // Arrange
      const log = new DailyLog();

      // Act
      const { logPath, dateStr } = log.captureCommit('abc1234', 'feat: add auth', 3);

      // Assert — return value
      expect(typeof logPath).toBe('string');
      expect(dateStr).toBe(todayStr());

      // Assert — heading
      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toMatch(/## \d{2}:\d{2} — post-commit/);
    });

    it('captureCommit_writesHashAndSubject', () => {
      // Arrange
      const log = new DailyLog();

      // Act
      log.captureCommit('abc1234', 'feat: add auth', 3);
      const content = readDailyLog(tmp.root, todayStr());

      // Assert
      expect(content).toContain('`abc1234`');
      expect(content).toContain('feat: add auth');
    });

    it('captureCommit_writesFilesChanged', () => {
      // Arrange
      const log = new DailyLog();

      // Act
      log.captureCommit('abc1234', 'feat: add auth', 5);
      const content = readDailyLog(tmp.root, todayStr());

      // Assert
      expect(content).toContain('**Files changed:** 5');
    });

    it('captureCommit_withDiffstat_writesDiffstatLine', () => {
      // Arrange
      const log = new DailyLog();

      // Act
      log.captureCommit('abc1234', 'feat: add auth', 3, 42, 7);
      const content = readDailyLog(tmp.root, todayStr());

      // Assert — diffstat line present when both insertions and deletions are finite
      expect(content).toContain('**Diffstat:** +42 -7');
    });

    it('captureCommit_withoutDiffstat_omitsDiffstatLine', () => {
      // Arrange
      const log = new DailyLog();

      // Act — no insertions/deletions passed
      log.captureCommit('abc1234', 'feat: add auth', 3);
      const content = readDailyLog(tmp.root, todayStr());

      // Assert — diffstat line NOT present
      expect(content).not.toContain('**Diffstat:**');
    });

    it('captureCommit_withNaNDiffstat_omitsDiffstatLine', () => {
      // Arrange
      const log = new DailyLog();

      // Act — non-finite values (NaN) should suppress diffstat
      log.captureCommit('abc1234', 'feat: add auth', 3, NaN, NaN);
      const content = readDailyLog(tmp.root, todayStr());

      // Assert
      expect(content).not.toContain('**Diffstat:**');
    });

    it('captureCommit_withOnlyInsertions_omitsDiffstatLine', () => {
      // Arrange
      const log = new DailyLog();

      // Act — only one of the two diffstat values provided
      log.captureCommit('abc1234', 'feat: add auth', 3, 10, undefined);
      const content = readDailyLog(tmp.root, todayStr());

      // Assert — BOTH must be finite; missing deletions → no diffstat
      expect(content).not.toContain('**Diffstat:**');
    });

    it('captureCommit_usesGitFixtureHash', () => {
      // Arrange: create a real git repo in tmp, add a commit, capture its hash
      const repo = createGitRepo({ root: tmp.root });
      if (!repo) return; // git not on PATH — skip gracefully

      repo.addCommit({
        message: 'feat: real commit for test',
        files: [{ path: 'src/index.js', content: 'console.log("hello");' }],
      });

      const { execSync } = require('node:child_process');
      const hash = execSync('git rev-parse --short HEAD', {
        cwd: tmp.root,
        encoding: 'utf8',
      }).trim();

      const log = new DailyLog();

      // Act
      log.captureCommit(hash, 'feat: real commit for test', 1, 1, 0);
      const content = readDailyLog(tmp.root, todayStr());

      // Assert — real hash and subject appear in log
      expect(content).toContain(`\`${hash}\``);
      expect(content).toContain('feat: real commit for test');
      expect(content).toContain('**Diffstat:** +1 -0');
    });
  });

  // ---------------------------------------------------------------------------
  // findInProgressTodos()
  // ---------------------------------------------------------------------------
  describe('findInProgressTodos', () => {
    it('findInProgressTodos_noTodoFiles_returnsNone', () => {
      // Arrange — tmp has no docs/ dir
      const log = new DailyLog();

      // Act
      const result = log.findInProgressTodos();

      // Assert
      expect(result).toBe('  None');
    });

    it('findInProgressTodos_todoFileWithInProgressMarker_returnsItem', () => {
      // Arrange
      tmp.write('docs/work/todo/TODO_epic01.md', '- [>] Build widget\n- [ ] Other task\n');
      const log = new DailyLog();

      // Act
      const result = log.findInProgressTodos();

      // Assert
      expect(result).toContain('[>]');
      expect(result).toContain('Build widget');
      expect(result).toContain('TODO_epic01.md');
    });

    it('findInProgressTodos_blockedMarker_returnsBlockedItem', () => {
      // Arrange
      tmp.write('docs/work/todo/TODO_epic02.md', '- [!] Blocked on auth\n');
      const log = new DailyLog();

      // Act
      const result = log.findInProgressTodos();

      // Assert
      expect(result).toContain('[!]');
      expect(result).toContain('Blocked on auth');
    });

    it('findInProgressTodos_scansDocsTodoAndDocs_returnsBothSources', () => {
      // Arrange: one file in docs/work/todo/, one in docs/
      tmp.write('docs/work/todo/TODO_epic01.md', '- [>] In todo subdir\n');
      tmp.write('docs/TODO_master.md', '- [>] In docs root\n');
      const log = new DailyLog();

      // Act
      const result = log.findInProgressTodos();

      // Assert — both sources reached AND no duplicates (exactly 2 in-progress markers)
      expect(result).toContain('In todo subdir');
      expect(result).toContain('In docs root');
      const inProgressMatches = result.match(/\[>\]/g) || [];
      expect(inProgressMatches).toHaveLength(2);
    });

    it('findInProgressTodos_onlyDocsRoot_picksUpViaSecondLoop', () => {
      // Guards against regression where only docs/work/todo/ is scanned.
      // No file in docs/work/todo/ — only in docs/ root.
      tmp.write('docs/TODO_master.md', '- [>] Only in docs root\n');
      const log = new DailyLog();

      const result = log.findInProgressTodos();

      expect(result).toContain('Only in docs root');
    });

    it('findInProgressTodos_multipleInProgress_returnsAllItems', () => {
      // Arrange
      tmp.write('docs/work/todo/TODO_epic01.md', '- [>] Task A\n- [>] Task B\n');
      const log = new DailyLog();

      // Act
      const result = log.findInProgressTodos();

      // Assert
      expect(result).toContain('Task A');
      expect(result).toContain('Task B');
    });

    it('findInProgressTodos_onlyDoneTasks_returnsNone', () => {
      // Arrange — no [>] or [!] markers
      tmp.write('docs/work/todo/TODO_epic01.md', '- [x] Completed task\n- [ ] Not started\n');
      const log = new DailyLog();

      // Act
      const result = log.findInProgressTodos();

      // Assert
      expect(result).toBe('  None');
    });

    it('findInProgressTodos_stripsLeadingBulletFromText', () => {
      // Arrange — line has leading whitespace and bullet
      tmp.write('docs/work/todo/TODO_epic01.md', '  - [>]   Task with whitespace  \n');
      const log = new DailyLog();

      // Act
      const result = log.findInProgressTodos();

      // Assert — the prefix stripped, clean text returned
      expect(result).toContain('Task with whitespace');
      // The raw prefix should NOT appear in the formatted output
      expect(result).not.toMatch(/^\s*- \[>\]\s*- \[>\]/);
    });

    it('findInProgressTodos_nonTodoMdFiles_ignored', () => {
      // Arrange — file not matching TODO*.md pattern
      tmp.write('docs/work/todo/notes.md', '- [>] Should not appear\n');
      const log = new DailyLog();

      // Act
      const result = log.findInProgressTodos();

      // Assert
      expect(result).toBe('  None');
    });

    // F28: per-module TODOs at docs/modules/{module}/TODO*.md were missed by the
    // old flat readdir. The scan must recurse (matching status.js/metrics.js).
    it('findInProgressTodos_moduleTodo_isFound', () => {
      // Arrange — an in-progress marker in a per-module TODO, nested under docs/modules/
      tmp.write('docs/modules/checkout/TODO_checkout.md', '- [>] Wire up the checkout module\n');
      const log = new DailyLog();

      // Act
      const result = log.findInProgressTodos();

      // Assert
      expect(result).toContain('[>]');
      expect(result).toContain('Wire up the checkout module');
      expect(result).toContain('TODO_checkout.md');
    });

    it('findInProgressTodos_skipsOutputDir', () => {
      // Arrange — a TODO-shaped file inside docs/.output must be skipped (skip-dir)
      tmp.write('docs/.output/TODO_generated.md', '- [>] Generated noise\n');
      const log = new DailyLog();

      // Act
      const result = log.findInProgressTodos();

      // Assert
      expect(result).not.toContain('Generated noise');
    });
  });

  // ---------------------------------------------------------------------------
  // findKeyDecisions()
  // ---------------------------------------------------------------------------
  describe('findKeyDecisions', () => {
    it('findKeyDecisions_noDocsDir_returnsNone', () => {
      // Arrange — tmp has no docs/ dir
      const log = new DailyLog();

      // Act
      const result = log.findKeyDecisions();

      // Assert
      expect(result).toBe('  None');
    });

    it('findKeyDecisions_todoWithKeyDecisionsTable_returnsRows', () => {
      // Arrange — fixture MUST have header row AND separator row for regex to match
      const fixture = [
        '# TODO Master',
        '',
        '## Key Decisions',
        '',
        '| Decision | Rationale | Outcome |',
        '| --- | --- | --- |',
        '| Use JWT | Security | Done |',
        '',
      ].join('\n');
      tmp.write('docs/TODO_master.md', fixture);
      const log = new DailyLog();

      // Act
      const result = log.findKeyDecisions();

      // Assert
      expect(result).toContain('Use JWT');
      expect(result).toContain('Security');
      expect(result).not.toBe('  None');
    });

    it('findKeyDecisions_scansDocsOnlyNotTodoSubdir', () => {
      // Arrange — file in docs/work/todo/ should NOT be scanned by findKeyDecisions
      const fixture = [
        '## Key Decisions',
        '',
        '| Decision | Rationale | Outcome |',
        '| --- | --- | --- |',
        '| Hidden decision | rationale | outcome |',
        '',
      ].join('\n');
      tmp.write('docs/work/todo/TODO_epic01.md', fixture);
      const log = new DailyLog();

      // Act
      const result = log.findKeyDecisions();

      // Assert — decisions in docs/work/todo/ are NOT found by findKeyDecisions
      expect(result).toBe('  None');
    });

    it('findKeyDecisions_missingTableSeparatorRow_returnsNone', () => {
      // Arrange — table without separator row → regex does not match
      const fixture = [
        '## Key Decisions',
        '',
        '| Decision | Rationale | Outcome |',
        '| Use JWT | Security | Done |',
        '',
      ].join('\n');
      tmp.write('docs/TODO_master.md', fixture);
      const log = new DailyLog();

      // Act
      const result = log.findKeyDecisions();

      // Assert — malformed table should yield no results
      expect(result).toBe('  None');
    });

    it('findKeyDecisions_moreThanFiveRows_returnsLastFive', () => {
      // Arrange — 7 decision rows; only last 5 should appear
      const rows = Array.from({ length: 7 }, (_, i) => `| Decision${i + 1} | r | o |`);
      const fixture = [
        '## Key Decisions',
        '',
        '| Decision | Rationale | Outcome |',
        '| --- | --- | --- |',
        ...rows,
        '',
      ].join('\n');
      tmp.write('docs/TODO_master.md', fixture);
      const log = new DailyLog();

      // Act
      const result = log.findKeyDecisions();

      // Assert — first two decisions NOT present, last five ARE
      expect(result).not.toContain('Decision1');
      expect(result).not.toContain('Decision2');
      expect(result).toContain('Decision3');
      expect(result).toContain('Decision7');
    });

    it('findKeyDecisions_noKeyDecisionsSection_returnsNone', () => {
      // Arrange
      tmp.write('docs/TODO_master.md', '# Master TODO\n\n- [ ] Task one\n');
      const log = new DailyLog();

      // Act
      const result = log.findKeyDecisions();

      // Assert
      expect(result).toBe('  None');
    });

    // F28: a Key Decisions table in a per-module TODO must be picked up. Module
    // TODOs (docs/modules/**) are scanned in addition to the docs root — but
    // docs/work/todo/ remains excluded (see findKeyDecisions_scansDocsOnlyNotTodoSubdir).
    it('findKeyDecisions_moduleTodo_isFound', () => {
      const fixture = [
        '## Key Decisions',
        '',
        '| Decision | Rationale | Outcome |',
        '| --- | --- | --- |',
        '| Module-scoped choice | reason | done |',
        '',
      ].join('\n');
      tmp.write('docs/modules/checkout/TODO_checkout.md', fixture);
      const log = new DailyLog();

      const result = log.findKeyDecisions();

      expect(result).toContain('Module-scoped choice');
    });
  });

  // ---------------------------------------------------------------------------
  // Day-boundary handling
  // ---------------------------------------------------------------------------
  describe('day boundary', () => {
    it('dayBoundary_sameDateTwice_appendsToSameFile', () => {
      // Arrange
      const log = new DailyLog();

      // Act — two captures in the same session (same date)
      const result1 = log.capture('capture-one');
      const result2 = log.capture('capture-two');

      // Assert — same file path, same date string
      expect(result1.logPath).toBe(result2.logPath);
      expect(result1.dateStr).toBe(result2.dateStr);

      // Assert — single file contains both entries
      const content = fs.readFileSync(result1.logPath, 'utf8');
      expect(content).toContain('— capture-one');
      expect(content).toContain('— capture-two');
    });

    it('dayBoundary_differentDate_writesDifferentFile', () => {
      // Arrange — write a log entry directly for a past date to simulate "yesterday"
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const yesterdayPath = path.join(
        tmp.root,
        'docs', '.output', '.state', 'memory-daily',
        `${yesterday}.md`
      );
      fs.mkdirSync(path.dirname(yesterdayPath), { recursive: true });
      fs.writeFileSync(yesterdayPath, '## 23:59 — old-entry\n\nOld content\n\n', 'utf8');

      const log = new DailyLog();

      // Act — capture for today
      const { logPath, dateStr } = log.capture('today-entry');

      // Assert — today's file is different from yesterday's
      expect(dateStr).toBe(todayStr());
      expect(logPath).not.toBe(yesterdayPath);
      expect(fs.existsSync(yesterdayPath)).toBe(true);
      expect(fs.existsSync(logPath)).toBe(true);

      // Assert — files are independent
      const todayContent = fs.readFileSync(logPath, 'utf8');
      const yesterdayContent = fs.readFileSync(yesterdayPath, 'utf8');
      expect(todayContent).toContain('today-entry');
      expect(yesterdayContent).toContain('old-entry');
      expect(todayContent).not.toContain('old-entry');
    });

    it('dayBoundary_captureNoteAndCapture_appendToSameFile', () => {
      // Arrange
      const log = new DailyLog();

      // Act — mix capture() and captureNote() on the same date
      log.capture('session-start');
      log.captureNote('Important insight discovered', 'remember');
      log.captureCommit('abc1234', 'feat: ship it', 2, 10, 0);

      const content = readDailyLog(tmp.root, todayStr());

      // Assert — all three entries in one file
      expect(content).toContain('— session-start');
      expect(content).toContain('Important insight discovered');
      expect(content).toContain('— post-commit');
    });
  });
});
