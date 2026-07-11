// Tests for gen-timeline.js
//
// Coverage strategy:
//   - Pure helpers (getMonday, formatDate, formatWeekHeader): known-date assertions
//   - groupByTheme: feed every branch in the typeMap + scope + unrecognised type + no-prefix
//   - main(): drive against a real tmp git repo (CLAUDE_PROJECT_DIR env var),
//     manipulate process.argv[2] for mode, mock process.exit to prevent test-process death.
//
// CJS module note: gen-timeline.js is CommonJS loaded via createRequire.
// Cache-bust before each main() call so env/argv changes take effect.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { createGitRepo, gitAvailable } = require('./_helpers/git-fixture');

// Absolute path used for cache busting before each main() invocation
const GEN_TIMELINE_PATH = require.resolve('../gen-timeline');

// Top-level require for pure functions — no env/argv dependency
const { getMonday, formatDate, formatWeekHeader, groupByTheme, mergeTimeline } = require('../gen-timeline');

// ─── mergeTimeline (M2) ──────────────────────────────────────────────────────
// Update mode fetches only NEW commits then splices them onto the existing
// timeline. When the new commits land in a week the timeline already covers, a
// naive prepend duplicated the `## Week of …` header. mergeTimeline merges by
// header instead.

describe('mergeTimeline (M2 — within-week update)', () => {
    const countOccurrences = (s, needle) => s.split(needle).length - 1;

    it('does NOT duplicate a week header when new commits fall in an existing week', () => {
        const existing = [
            '## Week of Jun 8, 2026',
            '',
            '### Mon Jun 8 (2 commits, 3 files)',
            '- feat: existing one',
            '- feat: existing two',
            '',
            '---',
            '',
        ].join('\n');
        const fresh = [
            '## Week of Jun 8, 2026',
            '',
            '### Wed Jun 10 (1 commit, 1 files)',
            '- fix: brand new',
            '',
            '---',
            '',
        ].join('\n');

        const merged = mergeTimeline(fresh, existing);
        expect(countOccurrences(merged, '## Week of Jun 8, 2026')).toBe(1);
        // Both the old and new commits survive the merge.
        expect(merged).toContain('feat: existing one');
        expect(merged).toContain('fix: brand new');
    });

    it('merges a shared day: sums counts and concatenates bullets (existing then new)', () => {
        const existing = [
            '## Week of Jun 8, 2026',
            '',
            '### Mon Jun 8 (1 commit, 2 files)',
            '- feat: older commit',
            '',
            '---',
            '',
        ].join('\n');
        const fresh = [
            '## Week of Jun 8, 2026',
            '',
            '### Mon Jun 8 (1 commit, 1 files)',
            '- fix: newer commit',
            '',
            '---',
            '',
        ].join('\n');

        const merged = mergeTimeline(fresh, existing);
        expect(countOccurrences(merged, '### Mon Jun 8')).toBe(1);
        // 1 + 1 commits, 2 + 1 files.
        expect(merged).toContain('### Mon Jun 8 (2 commits, 3 files)');
        const olderIdx = merged.indexOf('feat: older commit');
        const newerIdx = merged.indexOf('fix: newer commit');
        expect(olderIdx).toBeGreaterThan(-1);
        expect(newerIdx).toBeGreaterThan(olderIdx); // existing-then-new order
    });

    it('keeps non-overlapping weeks distinct (new week first, old week after)', () => {
        const existing = [
            '## Week of Jun 1, 2026',
            '',
            '### Mon Jun 1 (1 commit, 1 files)',
            '- feat: last week',
            '',
            '---',
            '',
        ].join('\n');
        const fresh = [
            '## Week of Jun 8, 2026',
            '',
            '### Mon Jun 8 (1 commit, 1 files)',
            '- feat: this week',
            '',
            '---',
            '',
        ].join('\n');

        const merged = mergeTimeline(fresh, existing);
        expect(merged.indexOf('## Week of Jun 8, 2026')).toBeLessThan(merged.indexOf('## Week of Jun 1, 2026'));
    });
});

// ─── getMonday ────────────────────────────────────────────────────────────────

describe('getMonday', () => {
    it('returns Monday itself when date is a Monday', () => {
        // 2026-06-08 is a Monday
        expect(getMonday('2026-06-08')).toBe('2026-06-08');
    });

    it('returns the Monday for a Sunday (preceding Monday)', () => {
        // 2026-04-19 is a Sunday → Monday 2026-04-13
        expect(getMonday('2026-04-19')).toBe('2026-04-13');
    });

    it('returns the Monday for a Tuesday', () => {
        // 2026-04-14 is a Tuesday → Monday 2026-04-13
        expect(getMonday('2026-04-14')).toBe('2026-04-13');
    });

    it('returns the Monday for a Wednesday', () => {
        // 2026-06-10 is a Wednesday → Monday 2026-06-08
        expect(getMonday('2026-06-10')).toBe('2026-06-08');
    });

    it('returns the Monday for a Friday', () => {
        // 2026-06-12 is a Friday → Monday 2026-06-08
        expect(getMonday('2026-06-12')).toBe('2026-06-08');
    });

    it('returns the Monday for a Saturday', () => {
        // 2026-06-13 is a Saturday → Monday 2026-06-08
        expect(getMonday('2026-06-13')).toBe('2026-06-08');
    });

    it('handles month boundary correctly', () => {
        // 2026-03-01 is a Sunday → Monday 2026-02-23
        expect(getMonday('2026-03-01')).toBe('2026-02-23');
    });
});

// ─── formatDate ──────────────────────────────────────────────────────────────

describe('formatDate', () => {
    it('formats a Monday correctly', () => {
        // 2026-06-08 is Monday, June
        expect(formatDate('2026-06-08')).toBe('Mon Jun 8');
    });

    it('formats a Sunday correctly', () => {
        // 2026-04-19 is Sunday, April
        expect(formatDate('2026-04-19')).toBe('Sun Apr 19');
    });

    it('formats a Wednesday in January', () => {
        // 2026-01-07 is a Wednesday
        expect(formatDate('2026-01-07')).toBe('Wed Jan 7');
    });

    it('formats a day in December', () => {
        // 2025-12-25 is Thursday
        expect(formatDate('2025-12-25')).toBe('Thu Dec 25');
    });

    it('formats a Saturday in August', () => {
        // 2026-08-01 is a Saturday
        expect(formatDate('2026-08-01')).toBe('Sat Aug 1');
    });

    it('includes day name, month abbr, and day number without leading zero', () => {
        // 2026-05-05 is a Tuesday in May
        const result = formatDate('2026-05-05');
        expect(result).toMatch(/^Tue May 5$/);
    });
});

// ─── formatWeekHeader ─────────────────────────────────────────────────────────

describe('formatWeekHeader', () => {
    it('formats a week header for a Monday in June', () => {
        expect(formatWeekHeader('2026-06-08')).toBe('Week of Jun 8, 2026');
    });

    it('formats a week header for a Monday in January', () => {
        expect(formatWeekHeader('2026-01-05')).toBe('Week of Jan 5, 2026');
    });

    it('formats a week header for a Monday in December', () => {
        expect(formatWeekHeader('2025-12-29')).toBe('Week of Dec 29, 2025');
    });

    it('includes the full year', () => {
        const result = formatWeekHeader('2026-04-13');
        expect(result).toContain('2026');
    });
});

// ─── groupByTheme ─────────────────────────────────────────────────────────────

describe('groupByTheme', () => {
    it('groups feat: commits into Features', () => {
        const result = groupByTheme([
            { msg: 'feat: add login' },
            { msg: 'feat: add signup' },
        ]);
        expect(result).toHaveProperty('Features');
        expect(result.Features).toHaveLength(2);
    });

    it('groups fix: commits into Fixes', () => {
        const result = groupByTheme([{ msg: 'fix: resolve null pointer' }]);
        expect(result).toHaveProperty('Fixes');
        expect(result.Fixes).toHaveLength(1);
    });

    it('groups docs: commits into Documentation', () => {
        const result = groupByTheme([{ msg: 'docs: update README' }]);
        expect(result).toHaveProperty('Documentation');
        expect(result.Documentation).toHaveLength(1);
    });

    it('groups refactor: commits into Refactoring', () => {
        const result = groupByTheme([{ msg: 'refactor: extract helper' }]);
        expect(result).toHaveProperty('Refactoring');
        expect(result.Refactoring).toHaveLength(1);
    });

    it('groups test: commits into Testing', () => {
        const result = groupByTheme([{ msg: 'test: add unit tests' }]);
        expect(result).toHaveProperty('Testing');
        expect(result.Testing).toHaveLength(1);
    });

    it('groups chore: commits into Chores', () => {
        const result = groupByTheme([{ msg: 'chore: bump dependencies' }]);
        expect(result).toHaveProperty('Chores');
        expect(result.Chores).toHaveLength(1);
    });

    it('groups style: commits into Styling', () => {
        const result = groupByTheme([{ msg: 'style: fix indentation' }]);
        expect(result).toHaveProperty('Styling');
        expect(result.Styling).toHaveLength(1);
    });

    it('groups perf: commits into Performance', () => {
        const result = groupByTheme([{ msg: 'perf: cache expensive query' }]);
        expect(result).toHaveProperty('Performance');
        expect(result.Performance).toHaveLength(1);
    });

    it('uses capitalized type name for unknown conventional commit types', () => {
        const result = groupByTheme([{ msg: 'ci: update pipeline' }]);
        expect(result).toHaveProperty('Ci');
        expect(result.Ci).toHaveLength(1);
    });

    it('uses scope as theme when scope is present in type(scope): format', () => {
        const result = groupByTheme([
            { msg: 'feat(auth): add JWT support' },
            { msg: 'fix(auth): handle token expiry' },
        ]);
        // Scope 'auth' → capitalised → 'Auth'
        expect(result).toHaveProperty('Auth');
        expect(result.Auth).toHaveLength(2);
    });

    it('capitalises the first letter of the scope', () => {
        const result = groupByTheme([{ msg: 'feat(database): add index' }]);
        expect(result).toHaveProperty('Database');
    });

    it('groups commits without conventional prefix into Other', () => {
        const result = groupByTheme([
            { msg: 'update stuff' },
            { msg: 'WIP' },
        ]);
        expect(result).toHaveProperty('Other');
        expect(result.Other).toHaveLength(2);
    });

    it('handles mixed themes in a single call', () => {
        const commits = [
            { msg: 'feat: new feature' },
            { msg: 'fix: critical bug' },
            { msg: 'docs: add guide' },
            { msg: 'chore: update lock' },
            { msg: 'some random message' },
            { msg: 'feat(api): versioning' },
        ];
        const result = groupByTheme(commits);
        expect(result).toHaveProperty('Features');
        expect(result).toHaveProperty('Fixes');
        expect(result).toHaveProperty('Documentation');
        expect(result).toHaveProperty('Chores');
        expect(result).toHaveProperty('Other');
        expect(result).toHaveProperty('Api');
        expect(result.Features).toHaveLength(1);
        expect(result.Api).toHaveLength(1);
    });

    it('accumulates multiple commits into same theme group', () => {
        const commits = [
            { msg: 'fix: bug one' },
            { msg: 'fix: bug two' },
            { msg: 'fix: bug three' },
        ];
        const result = groupByTheme(commits);
        expect(result.Fixes).toHaveLength(3);
    });

    it('returns an empty object for an empty array', () => {
        expect(groupByTheme([])).toEqual({});
    });
});

// ─── main() ──────────────────────────────────────────────────────────────────
// Drive main() in-process against a real tmp git repo.
// - CLAUDE_PROJECT_DIR env var points to the tmp repo root.
// - process.argv[2] controls mode ('full' / 'update').
// - process.exit is mocked to prevent killing the test process.

describe('main()', () => {
    let tmp;
    let repo;
    let originalArgv;
    let originalEnv;
    let exitSpy;

    beforeEach(() => {
        tmp = createTmpDir({ prefix: 'gen-timeline-test-' });
        // Create docs dir so timeline path is valid
        fs.mkdirSync(path.join(tmp.root, 'docs'), { recursive: true });

        if (gitAvailable()) {
            repo = createGitRepo({ root: tmp.root });
        }

        // Save originals
        originalArgv = process.argv.slice();
        originalEnv = process.env.CLAUDE_PROJECT_DIR;

        // Point module to our tmp repo
        process.env.CLAUDE_PROJECT_DIR = tmp.root;

        // Mock process.exit so main() early-exits don't kill vitest
        exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`process.exit(${code})`);
        });
    });

    afterEach(() => {
        // Restore argv, env, exit spy
        process.argv = originalArgv;
        if (originalEnv === undefined) {
            delete process.env.CLAUDE_PROJECT_DIR;
        } else {
            process.env.CLAUDE_PROJECT_DIR = originalEnv;
        }
        exitSpy.mockRestore();

        tmp.cleanup();
    });

    /**
     * Fresh-require main() after env/argv are set, so static module-level
     * values pick up the current process state.
     */
    function requireFreshMain() {
        delete require.cache[GEN_TIMELINE_PATH];
        return require('../gen-timeline').main;
    }

    it.skipIf(!gitAvailable())('full mode: generates timeline file from commits', () => {
        // Add commits with varied conventional types spread across dates
        repo.addCommitOnDate('feat: initial feature', '2026-05-01T10:00:00');
        repo.addCommitOnDate('fix: first bug', '2026-05-01T11:00:00');
        repo.addCommitOnDate('docs: write readme', '2026-05-08T09:00:00');
        repo.addCommitOnDate('chore: clean up', '2026-05-08T10:00:00');

        process.argv = ['node', 'gen-timeline.js', 'full'];
        const mainFn = requireFreshMain();
        mainFn();

        const timelinePath = path.join(tmp.root, 'docs', 'work/timeline.md');
        expect(fs.existsSync(timelinePath)).toBe(true);

        const content = fs.readFileSync(timelinePath, 'utf8');
        // Has project name header
        expect(content).toContain('# ');
        // Has at least one week header
        expect(content).toMatch(/## Week of/);
        // Contains commit messages
        expect(content).toContain('feat: initial feature');
        expect(content).toContain('fix: first bug');
        // Has the last-hash anchor for update mode
        expect(content).toMatch(/<!-- last:[a-f0-9]{40} -->/);
    });

    it.skipIf(!gitAvailable())('full mode: day header shows correct commit count', () => {
        repo.addCommitOnDate('feat: alpha', '2026-05-01T10:00:00');
        repo.addCommitOnDate('feat: beta', '2026-05-01T11:00:00');

        process.argv = ['node', 'gen-timeline.js', 'full'];
        const mainFn = requireFreshMain();
        mainFn();

        const content = fs.readFileSync(path.join(tmp.root, 'docs', 'work/timeline.md'), 'utf8');
        // 2 commits on 2026-05-01 (plus initial empty commit from createGitRepo, which is on today's date)
        // The day header for May 1 must report exactly "2 commits" — assert the count, not just the word.
        expect(content).toMatch(/\(2 commits, \d+ files\)/);
    });

    it.skipIf(!gitAvailable())('full mode: groups by theme when a day has more than 5 commits', () => {
        // Push 7 commits on the same day — triggers groupByTheme path in main()
        const day = '2026-05-01T10:00:00';
        repo.addCommitOnDate('feat: one', day);
        repo.addCommitOnDate('feat: two', day);
        repo.addCommitOnDate('fix: bug one', day);
        repo.addCommitOnDate('fix: bug two', day);
        repo.addCommitOnDate('docs: readme', day);
        repo.addCommitOnDate('chore: cleanup', day);
        repo.addCommitOnDate('refactor: extract helper', day);

        process.argv = ['node', 'gen-timeline.js', 'full'];
        const mainFn = requireFreshMain();
        mainFn();

        const content = fs.readFileSync(path.join(tmp.root, 'docs', 'work/timeline.md'), 'utf8');
        // When >5 commits/day, groupByTheme is used and bold theme headers appear
        expect(content).toMatch(/\*\*(Features|Fixes|Chores|Documentation|Refactoring)\*\*/);
    });

    it.skipIf(!gitAvailable())('update mode: prepends new weeks to existing timeline', () => {
        // Create an initial timeline with full mode
        repo.addCommitOnDate('feat: week one', '2026-05-01T10:00:00');

        process.argv = ['node', 'gen-timeline.js', 'full'];
        requireFreshMain()();

        const timelinePath = path.join(tmp.root, 'docs', 'work/timeline.md');
        const afterFull = fs.readFileSync(timelinePath, 'utf8');
        expect(afterFull).toContain('feat: week one');

        // Extract last hash from existing timeline so update mode uses it
        const hashMatch = afterFull.match(/<!-- last:([a-f0-9]{40}) -->/);
        expect(hashMatch).not.toBeNull();

        // Add a new commit after the last documented hash
        repo.addCommitOnDate('feat: week two', '2026-05-08T10:00:00');

        process.argv = ['node', 'gen-timeline.js', 'update'];
        requireFreshMain()();

        const afterUpdate = fs.readFileSync(timelinePath, 'utf8');
        // New commit should appear, header should be updated
        expect(afterUpdate).toContain('feat: week two');
        // Old content is preserved (prepend, not replace)
        expect(afterUpdate).toContain('feat: week one');
    });

    it.skipIf(!gitAvailable())('update mode: falls back to full when no last-hash in file', () => {
        // Create a timeline file WITHOUT the last-hash anchor
        const timelinePath = path.join(tmp.root, 'docs', 'work/timeline.md');
        fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
        fs.writeFileSync(timelinePath, '# My Project Timeline\n\n## Week of Jan 1, 2026\n\n- old entry\n');

        repo.addCommitOnDate('fix: fresh fix', '2026-05-01T10:00:00');

        process.argv = ['node', 'gen-timeline.js', 'update'];
        const mainFn = requireFreshMain();
        mainFn();

        const content = fs.readFileSync(timelinePath, 'utf8');
        // Should have regenerated from all commits (full fallback)
        expect(content).toContain('fix: fresh fix');
    });

    it.skipIf(!gitAvailable())('defaults to full mode when timeline file does not exist', () => {
        // No timeline file exists; no argv[2] — mode should auto-select 'full'
        repo.addCommitOnDate('chore: initial chore', '2026-05-01T10:00:00');

        process.argv = ['node', 'gen-timeline.js'];
        const mainFn = requireFreshMain();
        mainFn();

        const timelinePath = path.join(tmp.root, 'docs', 'work/timeline.md');
        expect(fs.existsSync(timelinePath)).toBe(true);
        const content = fs.readFileSync(timelinePath, 'utf8');
        expect(content).toContain('chore: initial chore');
    });

    it.skipIf(!gitAvailable())('defaults to update mode when timeline file already exists', () => {
        // Pre-create the timeline file; no argv[2] → mode should auto-select 'update'
        repo.addCommitOnDate('feat: existing', '2026-05-01T10:00:00');

        // Run full first to produce a valid timeline
        process.argv = ['node', 'gen-timeline.js', 'full'];
        requireFreshMain()();

        const timelinePath = path.join(tmp.root, 'docs', 'work/timeline.md');
        expect(fs.existsSync(timelinePath)).toBe(true);

        // Add another commit
        repo.addCommitOnDate('feat: new one', '2026-05-08T10:00:00');

        // Run without argv[2] — should pick update mode automatically
        process.argv = ['node', 'gen-timeline.js'];
        const mainFn = requireFreshMain();
        mainFn();

        const content = fs.readFileSync(timelinePath, 'utf8');
        expect(content).toContain('feat: new one');
    });

    it.skipIf(!gitAvailable())('writes last-hash anchor matching the last commit', () => {
        repo.addCommitOnDate('feat: versioned commit', '2026-05-01T10:00:00');

        process.argv = ['node', 'gen-timeline.js', 'full'];
        requireFreshMain()();

        const content = fs.readFileSync(path.join(tmp.root, 'docs', 'work/timeline.md'), 'utf8');
        const hashMatch = content.match(/<!-- last:([a-f0-9]{40}) -->/);
        expect(hashMatch).not.toBeNull();
        // Hash is 40 hex chars
        expect(hashMatch[1]).toMatch(/^[a-f0-9]{40}$/);
    });

    it.skipIf(!gitAvailable())('outputs valid JSON feedback on success', () => {
        repo.addCommitOnDate('style: formatting', '2026-05-01T10:00:00');

        const stdoutLines = [];
        const originalLog = console.log;
        console.log = (...args) => { stdoutLines.push(args.join(' ')); };

        process.argv = ['node', 'gen-timeline.js', 'full'];
        try {
            requireFreshMain()();
        } finally {
            console.log = originalLog;
        }

        // At least one line should be valid JSON with a feedback field
        const jsonLines = stdoutLines.filter(l => {
            try { JSON.parse(l); return true; } catch { return false; }
        });
        expect(jsonLines.length).toBeGreaterThan(0);
        const feedback = JSON.parse(jsonLines[jsonLines.length - 1]);
        expect(feedback).toHaveProperty('feedback');
        expect(typeof feedback.feedback).toBe('string');
    });
});
