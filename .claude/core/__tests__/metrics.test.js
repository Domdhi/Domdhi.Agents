import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);

const { createGitRepo, gitAvailable } = require('./_helpers/git-fixture');
const METRICS_CLI = require.resolve('../metrics');

// Regression (M1): `main()` was synchronous but invoked as `main().catch(...)`,
// so every real CLI run threw an uncaught TypeError and exited 1 AFTER printing
// the report. The existing suite only exercises the pure exports, so it never
// caught this — a child_process smoke test on the actual CLI does.
describe('metrics CLI (child process) — M1 exit code', () => {
    it('`metrics.js report` prints JSON and exits 0', () => {
        // execFileSync throws if the process exits non-zero; a clean return proves exit 0.
        const out = execFileSync('node', [METRICS_CLI, 'report'], { encoding: 'utf8' });
        const parsed = JSON.parse(out);
        expect(parsed).toHaveProperty('generated');
    });

    it('`metrics.js report --pretty` exits 0', () => {
        const out = execFileSync('node', [METRICS_CLI, 'report', '--pretty'], { encoding: 'utf8' });
        expect(out).toContain('Workflow Metrics');
    });
});

// metrics.js captures PROJECT_ROOT (from CLAUDE_PROJECT_DIR) at module-load
// time. Every test that needs metrics to read from a temp dir must:
//   1. set CLAUDE_PROJECT_DIR to the temp dir
//   2. bust the CJS require cache for ../metrics (createRequire's cache is NOT
//      reset by vi.resetModules) so the re-require recomputes PROJECT_ROOT.
// telemetry-paths is a pure helper (no env at load) but we bust it too to match
// the established pattern and avoid any stale closure surprises.
function bustCache() {
    delete require.cache[require.resolve('../metrics')];
    delete require.cache[require.resolve('../_lib/telemetry-paths')];
}

function loadMetrics(projectDir) {
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    bustCache();
    return require('../metrics');
}

describe('metrics', () => {
    it('loads without side effects and exports helpers', () => {
        const exports = require('../metrics');
        expect(exports).toBeDefined();
        expect(typeof exports.buildReport).toBe('function');
        expect(typeof exports.prettyReport).toBe('function');
        expect(typeof exports.findTodoFiles).toBe('function');
        expect(typeof exports.parseTodoFileStories).toBe('function');
        expect(typeof exports.computeTelemetry).toBe('function');
        expect(typeof exports.computeGit).toBe('function');
        expect(typeof exports.computeTodos).toBe('function');
    });
});

// Regression (2026-06-03): gate-outcome vocabulary normalization.
// command-usage-logger emits 'success'/'failure'/'unknown', but pre-A4 JSONL
// still carries legacy 'pass'/'fail'. computeTelemetry must count BOTH vocabs
// and IGNORE 'unknown' — the old `else fail++` branch miscounted both legacy
// passes and unknowns as failures, inflating the fail rate.
describe('computeTelemetry — gate outcome normalization', () => {
    let dir, prevEnv;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-tel-'));
        const telDir = path.join(dir, 'docs', '.output', '.state', 'telemetry');
        fs.mkdirSync(telDir, { recursive: true });
        const rows = [
            { type: 'gate_run', command: 'gate:test', outcome: 'success' },
            { type: 'gate_run', command: 'gate:test', outcome: 'pass' },     // legacy pass
            { type: 'gate_run', command: 'gate:test', outcome: 'failure' },
            { type: 'gate_run', command: 'gate:test', outcome: 'fail' },     // legacy fail
            { type: 'gate_run', command: 'gate:test', outcome: 'unknown' },  // no signal — ignore
        ];
        fs.writeFileSync(path.join(telDir, 'command-usage.jsonl'),
            rows.map(r => JSON.stringify(r)).join('\n') + '\n');
        prevEnv = process.env.CLAUDE_PROJECT_DIR;
        process.env.CLAUDE_PROJECT_DIR = dir;
        // PROJECT_ROOT is captured at module load; clear the CJS require cache
        // (vi.resetModules does not touch createRequire's cache) so the re-require
        // recomputes PROJECT_ROOT from the temp CLAUDE_PROJECT_DIR.
        delete require.cache[require.resolve('../metrics')];
        delete require.cache[require.resolve('../_lib/telemetry-paths')];
    });
    afterEach(() => {
        if (prevEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = prevEnv;
        fs.rmSync(dir, { recursive: true, force: true });
        delete require.cache[require.resolve('../metrics')];
        delete require.cache[require.resolve('../_lib/telemetry-paths')];
    });

    it('counts both vocabularies and ignores unknown', () => {
        const { computeTelemetry } = require('../metrics');
        const t = computeTelemetry();
        const g = t.gate_results['gate:test'];
        expect(g.pass).toBe(2);   // success + legacy pass
        expect(g.fail).toBe(2);   // failure + legacy fail; unknown NOT counted
        expect(g.pass_rate).toBe(50.0);
    });
});

// ── computeTelemetry — additional branches ───────────────────────────
describe('computeTelemetry — missing/empty/malformed data', () => {
    let dir, prevEnv;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-tel2-'));
        prevEnv = process.env.CLAUDE_PROJECT_DIR;
    });
    afterEach(() => {
        if (prevEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = prevEnv;
        fs.rmSync(dir, { recursive: true, force: true });
        bustCache();
    });

    it('returns null when the telemetry file does not exist', () => {
        const { computeTelemetry } = loadMetrics(dir);
        expect(computeTelemetry()).toBeNull();
    });

    it('returns null when the telemetry file is empty (whitespace only)', () => {
        const telDir = path.join(dir, 'docs', '.output', '.state', 'telemetry');
        fs.mkdirSync(telDir, { recursive: true });
        fs.writeFileSync(path.join(telDir, 'command-usage.jsonl'), '   \n\n  \n');
        const { computeTelemetry } = loadMetrics(dir);
        expect(computeTelemetry()).toBeNull();
    });

    it('returns null when every line is malformed JSON', () => {
        const telDir = path.join(dir, 'docs', '.output', '.state', 'telemetry');
        fs.mkdirSync(telDir, { recursive: true });
        fs.writeFileSync(path.join(telDir, 'command-usage.jsonl'), 'not json\n{broken\n');
        const { computeTelemetry } = loadMetrics(dir);
        expect(computeTelemetry()).toBeNull();
    });

    it('aggregates command_frequency and skips malformed lines among valid ones', () => {
        const telDir = path.join(dir, 'docs', '.output', '.state', 'telemetry');
        fs.mkdirSync(telDir, { recursive: true });
        const rows = [
            JSON.stringify({ type: 'command_invocation', command: '/do' }),
            JSON.stringify({ type: 'command_invocation', command: '/do' }),
            JSON.stringify({ type: 'command_invocation', command: '/prime' }),
            JSON.stringify({ type: 'command_invocation' }), // no command → 'unknown'
            'GARBAGE LINE',                                  // malformed → skipped
            JSON.stringify({ type: 'gate_run', outcome: 'success' }), // no command → 'unknown'
        ];
        fs.writeFileSync(path.join(telDir, 'command-usage.jsonl'), rows.join('\n') + '\n');
        const { computeTelemetry } = loadMetrics(dir);
        const t = computeTelemetry();
        expect(t.command_frequency['/do']).toBe(2);
        expect(t.command_frequency['/prime']).toBe(1);
        expect(t.command_frequency['unknown']).toBe(1);
        expect(t.gate_results['unknown'].pass).toBe(1);
        expect(t.gate_results['unknown'].pass_rate).toBe(100.0);
        // 6 lines, 1 malformed → 5 parsed events
        expect(t.total_events).toBe(5);
    });
});

// ── computeGit ───────────────────────────────────────────────────────
describe('computeGit', () => {
    let dir, prevEnv;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-git-'));
        prevEnv = process.env.CLAUDE_PROJECT_DIR;
    });
    afterEach(() => {
        if (prevEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = prevEnv;
        fs.rmSync(dir, { recursive: true, force: true });
        bustCache();
    });

    it('returns null when PROJECT_ROOT is not a git repo', () => {
        // dir is a plain temp dir — git log fails → caught → null
        const { computeGit } = loadMetrics(dir);
        expect(computeGit()).toBeNull();
    });

    it('parses conventional-commit types and counts commits in the last 30 days', () => {
        if (!gitAvailable()) {
            // NOT COVERED: computeGit happy path requires git on PATH.
            return;
        }
        const repoDir = path.join(dir, 'repo');
        const today = new Date().toISOString().slice(0, 10) + 'T12:00:00';
        const repo = createGitRepo({ root: repoDir });
        repo.addCommitOnDate('feat: add widget', today);
        repo.addCommitOnDate('fix: patch bug', today);
        repo.addCommitOnDate('docs: update readme', today);
        repo.addCommitOnDate('refactor: tidy module', today);
        repo.addCommitOnDate('chore: bump deps', today);
        repo.addCommitOnDate('non-conventional subject', today);
        // An old commit outside the 30d window — counted for types, not for last_30d.
        repo.addCommitOnDate('feat: ancient feature', '2020-01-01T12:00:00');

        const { computeGit } = loadMetrics(repoDir);
        const g = computeGit();
        expect(g).not.toBeNull();
        expect(g.type_breakdown.feat).toBe(2);   // today + ancient
        expect(g.type_breakdown.fix).toBe(1);
        expect(g.type_breakdown.docs).toBe(1);
        expect(g.type_breakdown.refactor).toBe(1);
        expect(g.type_breakdown.chore).toBe(1);
        // 6 commits today + 1 "initial" empty commit (dated now by fixture) are
        // within 30d; the 2020 commit is not.
        expect(g.commits_last_30d).toBeGreaterThanOrEqual(6);
        const todayKey = new Date().toISOString().slice(0, 10);
        expect(g.commits_by_day[todayKey]).toBeGreaterThanOrEqual(6);
    });
});

// ── findTodoFiles / parseTodoFileStories / computeTodos ──────────────
describe('TODO scanning and parsing', () => {
    let dir, prevEnv;
    const writeDoc = (rel, content) => {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        return full;
    };
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-todo-'));
        prevEnv = process.env.CLAUDE_PROJECT_DIR;
    });
    afterEach(() => {
        if (prevEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = prevEnv;
        fs.rmSync(dir, { recursive: true, force: true });
        bustCache();
    });

    it('findTodoFiles finds TODO*.md recursively and skips ignored dirs', () => {
        writeDoc('docs/TODO_Project.md', '# master');
        writeDoc('docs/work/todo/TODO_epic01.md', '# epic');
        writeDoc('docs/notes.md', '# not a todo');                 // wrong name
        writeDoc('docs/.output/TODO_should_skip.md', '# skipped'); // .output skipped
        writeDoc('docs/.archive/TODO_old.md', '# skipped');        // .archive skipped
        const { findTodoFiles } = loadMetrics(dir);
        const files = findTodoFiles();
        const rels = files.map(f => path.relative(dir, f).split(path.sep).join('/'));
        expect(rels).toContain('docs/TODO_Project.md');
        expect(rels).toContain('docs/work/todo/TODO_epic01.md');
        expect(rels).not.toContain('docs/notes.md');
        expect(rels.some(r => r.includes('.output'))).toBe(false);
        expect(rels.some(r => r.includes('.archive'))).toBe(false);
    });

    it('findTodoFiles returns [] when docs/ does not exist', () => {
        const { findTodoFiles } = loadMetrics(dir); // no docs/ created
        expect(findTodoFiles()).toEqual([]);
    });

    it('parseTodoFileStories — checklist with all marker states', () => {
        const file = writeDoc('docs/work/todo/TODO_epic02.md', [
            '# Epic 02 Checklist',
            '',
            '- [ ] **2.1 Pending story** — todo',
            '- [x] **2.2 Done story** — finished',
            '- [>] **2.3 Active story** — in progress',
            '- [!] **2.4 Blocked story** — blocked',
            '- [~] **2.5 Deferred story** — deferred',
            '- [ ] non-bold subtask should NOT count',
            'plain text line',
        ].join('\n'));
        const { parseTodoFileStories } = loadMetrics(dir);
        const s = parseTodoFileStories(file);
        expect(s.total).toBe(5);
        expect(s.pending).toBe(1);
        expect(s.done).toBe(1);
        expect(s.in_progress).toBe(1);
        expect(s.blocked).toBe(1);
        expect(s.deferred).toBe(1);
    });

    it('parseTodoFileStories — table-status marker rows count too', () => {
        const file = writeDoc('docs/work/todo/TODO_table.md', [
            '# Table-style checklist',
            '',
            '| Story | Status |',
            '| ----- | ------ |',
            '| Widget | [x] |',
            '| Gadget | [ ] |',
            '| Sprocket | [>] |',
        ].join('\n'));
        const { parseTodoFileStories } = loadMetrics(dir);
        const s = parseTodoFileStories(file);
        // Table-status matches `| [m] |` — done/pending/in_progress
        expect(s.total).toBe(3);
        expect(s.done).toBe(1);
        expect(s.pending).toBe(1);
        expect(s.in_progress).toBe(1);
    });

    it('parseTodoFileStories — master index via Phase Map table', () => {
        const file = writeDoc('docs/TODO_Master.md', [
            '# Master Index',
            '',
            '## Phase Map',
            '',
            '| Phase | Name | Epics | Desc | Stories | Done | Status |',
            '| ----- | ---- | ----- | ---- | ------- | ---- | ------ |',
            '| 1 | Foundation | 2 | core | 10 | 6 | active |',
            '| 2 | Build | 3 | feat | 8 | 2 | pending |',
            '',
            '## Notes',
            'irrelevant',
        ].join('\n'));
        const { parseTodoFileStories } = loadMetrics(dir);
        const s = parseTodoFileStories(file);
        expect(s.total).toBe(18);  // 10 + 8
        expect(s.done).toBe(8);    // 6 + 2
        expect(s.pending).toBe(10); // remainder: 18 - 8
    });

    it('parseTodoFileStories — master index via Epic Index when no Phase Map', () => {
        const file = writeDoc('docs/TODO_Epics.md', [
            '# Master Index',
            '',
            '## Epic Index',
            '',
            '| Epic | Name | Desc | Stories | Owner | Status |',
            '| ---- | ---- | ---- | ------- | ----- | ------ |',
            '| 01 | Auth | login | 5 | dom | [x] |',
            '| 02 | Billing | pay | 3 | dom | [>] |',
            '| 03 | Reports | charts | 4 | dom | [ ] |',
        ].join('\n'));
        const { parseTodoFileStories } = loadMetrics(dir);
        const s = parseTodoFileStories(file);
        // Real-module quirk: the Epic Index branch is guarded by
        // `if (stories.total === 0)`, so it accumulates ONLY the first epic row
        // (after which total != 0). Epics 02/03 are skipped. We assert the
        // module's ACTUAL behavior, not the intuitive sum — see metrics.js:213.
        expect(s.total).toBe(5);   // only epic 01 counted
        expect(s.done).toBe(5);    // epic 01 [x] → its 5 stories marked done
        expect(s.in_progress).toBe(0);
        expect(s.pending).toBe(0);
    });

    it('parseTodoFileStories returns null for an unreadable path', () => {
        const { parseTodoFileStories } = loadMetrics(dir);
        const missing = path.join(dir, 'docs', 'does-not-exist.md');
        expect(parseTodoFileStories(missing)).toBeNull();
    });

    it('computeTodos aggregates across files and computes completion_rate', () => {
        writeDoc('docs/work/todo/TODO_a.md', [
            '- [x] **1.1 Done** — x',
            '- [ ] **1.2 Pending** — p',
        ].join('\n'));
        writeDoc('docs/work/todo/TODO_b.md', [
            '- [x] **2.1 Done** — x',
            '- [x] **2.2 Done** — x',
        ].join('\n'));
        const { computeTodos } = loadMetrics(dir);
        const td = computeTodos();
        expect(td.files).toBe(2);
        expect(td.total).toBe(4);
        expect(td.done).toBe(3);
        expect(td.pending).toBe(1);
        expect(td.completion_rate).toBe(75.0);
    });

    it('computeTodos returns null when no TODO files exist', () => {
        const { computeTodos } = loadMetrics(dir); // no docs/
        expect(computeTodos()).toBeNull();
    });

    it('computeTodos returns null when TODO files contain zero stories', () => {
        writeDoc('docs/TODO_empty.md', '# heading only, no checkboxes');
        const { computeTodos } = loadMetrics(dir);
        expect(computeTodos()).toBeNull();
    });
});

// ── buildReport → prettyReport (main()-equivalent orchestration) ─────
describe('buildReport → prettyReport (in-process orchestration)', () => {
    let dir, prevEnv;
    const writeDoc = (rel, content) => {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        return full;
    };
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-report-'));
        prevEnv = process.env.CLAUDE_PROJECT_DIR;
    });
    afterEach(() => {
        if (prevEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = prevEnv;
        fs.rmSync(dir, { recursive: true, force: true });
        bustCache();
    });

    it('buildReport returns a shaped object with all sections + generated stamp', () => {
        // Telemetry data
        const telDir = path.join(dir, 'docs', '.output', '.state', 'telemetry');
        fs.mkdirSync(telDir, { recursive: true });
        fs.writeFileSync(path.join(telDir, 'command-usage.jsonl'),
            [
                JSON.stringify({ type: 'command_invocation', command: '/do' }),
                JSON.stringify({ type: 'gate_run', command: 'gate:test', outcome: 'success' }),
            ].join('\n') + '\n');
        // TODO data
        writeDoc('docs/work/todo/TODO_x.md', '- [x] **1.1 Done** — x\n- [ ] **1.2 Pending** — p\n');

        const { buildReport } = loadMetrics(dir);
        const report = buildReport();
        expect(report).toHaveProperty('telemetry');
        expect(report).toHaveProperty('git');
        expect(report).toHaveProperty('todos');
        expect(report).toHaveProperty('sessions');
        expect(typeof report.generated).toBe('string');
        expect(report.generated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(report.telemetry.command_frequency['/do']).toBe(1);
        expect(report.todos.total).toBe(2);
        expect(report.todos.completion_rate).toBe(50.0);
    });

    it('prettyReport renders all sections when data is present', () => {
        const telDir = path.join(dir, 'docs', '.output', '.state', 'telemetry');
        fs.mkdirSync(telDir, { recursive: true });
        fs.writeFileSync(path.join(telDir, 'command-usage.jsonl'),
            [
                JSON.stringify({ type: 'command_invocation', command: '/do' }),
                JSON.stringify({ type: 'command_invocation', command: '/do' }),
                JSON.stringify({ type: 'gate_run', command: 'gate:test', outcome: 'success' }),
                JSON.stringify({ type: 'gate_run', command: 'gate:test', outcome: 'failure' }),
            ].join('\n') + '\n');
        writeDoc('docs/work/todo/TODO_y.md', '- [x] **1.1 Done** — x\n- [ ] **1.2 Pending** — p\n');
        // Session dirs to exercise the sessions section of prettyReport
        const sessDir = path.join(dir, 'docs', '.output', '.state', 'sessions');
        fs.mkdirSync(path.join(sessDir, '2026-06-12'), { recursive: true });
        fs.mkdirSync(path.join(sessDir, '2026-06-13'), { recursive: true });

        const { buildReport, prettyReport } = loadMetrics(dir);
        const out = prettyReport(buildReport());

        expect(out).toContain('Workflow Metrics');
        expect(out).toContain('  Telemetry');
        expect(out).toContain('Commands: /do (2)');
        expect(out).toContain('test 50% pass (1/2)');   // gate label strips 'gate:'
        expect(out).toContain('Total events: 4');
        expect(out).toContain('  TODOs');
        expect(out).toContain('1 file, 2 stories, 50% complete');
        expect(out).toContain('Sessions: 2');
    });

    it('prettyReport renders the "no data" fallbacks when sections are null', () => {
        // Empty project dir → telemetry/todos/sessions all null; git null (not a repo)
        const { buildReport, prettyReport } = loadMetrics(dir);
        const out = prettyReport(buildReport());
        expect(out).toContain('Telemetry: no data');
        expect(out).toContain('Git: no data');
        expect(out).toContain('TODOs: no data');
        expect(out).toContain('Sessions: no data');
    });

    it('prettyReport handles a synthetic report object directly (pluralization + git types)', () => {
        const { prettyReport } = loadMetrics(dir);
        const report = {
            generated: '2026-06-13T10:00:00.000Z',
            telemetry: {
                command_frequency: { '/do': 3, '/prime': 1 },
                gate_results: { 'gate:test': { pass: 2, fail: 0, pass_rate: 100 } },
                total_events: 6,
            },
            git: {
                commits_last_30d: 9,
                commits_by_day: { '2026-06-13': 9 },
                type_breakdown: { feat: 4, fix: 2, docs: 0, refactor: 0, chore: 1 },
            },
            todos: {
                files: 3, total: 20, done: 10, in_progress: 2, blocked: 1,
                deferred: 0, pending: 7, completion_rate: 50.0,
            },
            sessions: { total: 5, dates: [] },
        };
        const out = prettyReport(report);
        expect(out).toContain('Workflow Metrics (2026-06-13)');
        expect(out).toContain('Commands: /do (3), /prime (1)');
        expect(out).toContain('test 100% pass (2/2)');
        expect(out).toContain('Git (last 30 days)');
        expect(out).toContain('Commits: 9');
        expect(out).toContain('feat (4), fix (2), chore (1)'); // zero-count types filtered out
        expect(out).toContain('3 files, 20 stories, 50% complete'); // plural "files"
        expect(out).toContain('Done: 10, Active: 2, Blocked: 1, Pending: 7');
        expect(out).toContain('Sessions: 5');
    });
});
