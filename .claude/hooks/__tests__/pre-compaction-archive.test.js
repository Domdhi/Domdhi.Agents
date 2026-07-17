// AC→source map (pre-compaction-archive, post-2026-04-20 refactor):
//   - buildSnapshot: reads git branch/status/log, inProgress, decisions → structured markdown string
//   - buildSnapshot: includes trigger and branch name in output
//   - processEvent: writes snapshot to docs/.output/.state/sessions/{date}/{time}-pre-compaction.md
//   - processEvent: calls log.capture('Pre-Compaction')
//   - processEvent: NEVER spawns memory-extractor (extraction moved to session-handoff skill)
//   - Source no longer imports child_process.spawn; the mock is retained in case the
//     regression test "no spawn ever fires" needs to fail loudly if someone adds it back.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');
const { installExecSyncMock } = require('../../core/__tests__/_helpers/claude-mock');

// ---------------------------------------------------------------------------
// Env save/restore (must happen BEFORE installExecSyncMock loads the source)
// ---------------------------------------------------------------------------
const origProjectDir = process.env.CLAUDE_PROJECT_DIR;
const origMemoryProfile = process.env.MEMORY_PROFILE;

// ---------------------------------------------------------------------------
// DailyLog mock injection — MUST happen BEFORE installExecSyncMock.
//
// pre-compaction-archive.cjs does `const DailyLog = require('../core/daily-log')`
// at top-level (line 22). The hook captures that class reference at module load.
// If we inject into require.cache AFTER load, the hook's reference still points
// at the real class — same problem as the child_process destructure issue.
//
// Fix: install a proxy DailyLog class into require.cache FIRST. The hook's
// top-level require picks it up. Individual tests set `currentMockLog` to
// control the per-test instance the proxy constructor returns.
// ---------------------------------------------------------------------------
const dailyLogCachePath = require.resolve('../../core/daily-log');
let currentMockLog = null;

require.cache[dailyLogCachePath] = {
    id: dailyLogCachePath,
    filename: dailyLogCachePath,
    exports: class DailyLog {
        constructor() {
            if (currentMockLog) Object.assign(this, currentMockLog);
        }
    },
    loaded: true,
    children: [],
    paths: []
};

// ---------------------------------------------------------------------------
// Load source + inject spawn mock.
// pre-compaction-archive.cjs destructures spawn at line 20:
//   const { spawn } = require('child_process');
// installExecSyncMock pre-populates require.cache before the source loads.
// The spawn fake returns an object with unref() — the hook calls child.unref().
// ---------------------------------------------------------------------------
const { mocks, source } = installExecSyncMock(
    vi,
    () => require('../pre-compaction-archive.cjs'),
    ['spawn']
);
const spawnMock = mocks.spawn;
spawnMock.mockImplementation(() => ({ unref: vi.fn() }));
const { processEvent, buildSnapshot } = source;

// ---------------------------------------------------------------------------
// Per-test sandbox
// ---------------------------------------------------------------------------
let tmp;

// Shared DailyLog mock factory — creates a log instance mock that exercises all
// the DailyLog API points pre-compaction-archive uses.
function makeMockLog(overrides = {}) {
    return {
        run: vi.fn(cmd => {
            if (cmd && cmd.includes('git status')) return '';
            if (cmd && cmd.includes('git log')) return 'abc1234 feat: add thing';
            if (cmd && cmd.includes('git branch')) return 'main';
            return '';
        }),
        findInProgressTodos: vi.fn(() => '(none)'),
        findKeyDecisions: vi.fn(() => '(none)'),
        capture: vi.fn(() => ({ logPath: path.join(tmp ? tmp.root : '/tmp', 'daily.md') })),
        ...overrides
    };
}

function injectDailyLogMock(mockInstance) {
    // Swap the per-test mock; the hook's DailyLog class reference is stable
    // (installed above), but each new DailyLog() picks up this mock's methods.
    currentMockLog = mockInstance;
}

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'pre-compaction-' });
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => ({ unref: vi.fn() }));
    currentMockLog = null;
    process.env.MEMORY_PROFILE = 'standard';
    // Isolate the hook's write paths. pre-compaction-archive.cjs resolves its
    // output root from CLAUDE_PROJECT_DIR (lazily, per call); setting it to
    // tmp.root guarantees snapshot + daily-log writes land in the sandbox
    // and never pollute the real repo's docs/.output/.state/sessions/ or memories/.
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
});

afterEach(() => {
    tmp.cleanup();
    currentMockLog = null;
    if (origMemoryProfile === undefined) delete process.env.MEMORY_PROFILE;
    else process.env.MEMORY_PROFILE = origMemoryProfile;
    if (origProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origProjectDir;
});

afterAll(() => {
    delete require.cache[dailyLogCachePath];
    // CLAUDE_PROJECT_DIR restore also happens per-test in afterEach; this
    // afterAll is belt-and-suspenders in case a test bails before afterEach.
    if (origProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origProjectDir;
});

// ---------------------------------------------------------------------------
// buildSnapshot
// ---------------------------------------------------------------------------

describe('buildSnapshot', () => {
    it('buildSnapshot_containsSnapshotHeader', () => {
        const mockLog = makeMockLog();
        const snap = buildSnapshot(tmp.root, mockLog, 'test-trigger');
        expect(snap).toContain('# Pre-Compaction Snapshot');
    });

    it('buildSnapshot_containsTriggerInOutput', () => {
        const mockLog = makeMockLog();
        const snap = buildSnapshot(tmp.root, mockLog, 'manual');
        expect(snap).toContain('manual');
    });

    it('buildSnapshot_containsGitBranch', () => {
        // F74: the branch now rides the `git status --short --branch` header
        // (one spawn) instead of a separate `git branch --show-current`.
        const mockLog = makeMockLog({
            run: vi.fn(cmd => {
                if (cmd && cmd.includes('git status')) return '## feature-x...origin/feature-x [ahead 1]\n M some/file.js';
                return '';
            })
        });
        const snap = buildSnapshot(tmp.root, mockLog, 'test');
        expect(snap).toContain('**Branch:** feature-x');
        // the header line is stripped back out of the status block
        expect(snap).toContain('M some/file.js');
        expect(snap).not.toContain('## feature-x...');
    });

    it('buildSnapshot_branchEdgeCases_detachedAndUnborn (F74)', () => {
        const detached = buildSnapshot(tmp.root, makeMockLog({
            run: vi.fn(cmd => (cmd && cmd.includes('git status')) ? '## HEAD (no branch)' : ''),
        }), 'test');
        expect(detached).toContain('**Branch:** \n');

        const unborn = buildSnapshot(tmp.root, makeMockLog({
            run: vi.fn(cmd => (cmd && cmd.includes('git status')) ? '## No commits yet on main' : ''),
        }), 'test');
        expect(unborn).toContain('**Branch:** main');
    });

    it('buildSnapshot_containsTimestampField', () => {
        const mockLog = makeMockLog();
        const snap = buildSnapshot(tmp.root, mockLog, 'test');
        expect(snap).toContain('**Timestamp:**');
    });

    it('buildSnapshot_containsInProgressSection', () => {
        const mockLog = makeMockLog({
            findInProgressTodos: vi.fn(() => '- [>] some task in progress')
        });
        const snap = buildSnapshot(tmp.root, mockLog, 'test');
        expect(snap).toContain('some task in progress');
    });

    it('buildSnapshot_readsHandoffWhenPresent', () => {
        const mockLog = makeMockLog();
        // Create a handoff file at the new per-session/branch path (resolved by
        // handoff-path.js — newest-overall fallback picks it regardless of branch).
        tmp.write('docs/.output/handoffs/260607-1200-end-main.md', `# Handoff

## Decisions & Context
Decision A was made for reason B.

## Next Actions
- Do thing X
`);
        const snap = buildSnapshot(tmp.root, mockLog, 'test');
        expect(snap).toContain('Decision A');
    });

    it('buildSnapshot_readsAgentUpdatesBucketedUnderMonthDir', () => {
        const mockLog = makeMockLog();
        // The ADR-0006 migration month-buckets day-files under {YYYY-MM}/. The reader
        // must descend into the month dir or it silently captures no agent updates.
        tmp.write('docs/.output/evolution/agents/2026-06/2026-06-14.md',
            '## Wave 1 misalignment\nA bucketed agent-update signal.\n');
        const snap = buildSnapshot(tmp.root, mockLog, 'test');
        expect(snap).toContain('Recent Agent Updates');
        expect(snap).toContain('A bucketed agent-update signal.');
    });
});

// ---------------------------------------------------------------------------
// processEvent — snapshot file written
// ---------------------------------------------------------------------------

describe('processEvent_snapshotFile', () => {
    it('processEvent_writesSnapshotToSessionsDir', () => {
        const mockLog = makeMockLog();
        injectDailyLogMock(mockLog);

        processEvent({ trigger: 'test' });

        const sessionsDir = path.join(tmp.root, 'docs', '.output', '.state', 'sessions');
        expect(fs.existsSync(sessionsDir)).toBe(true);
        const dateDirs = fs.readdirSync(sessionsDir);
        expect(dateDirs.length).toBeGreaterThan(0);
    });

    it('processEvent_snapshotFilenameContainsPreCompaction', () => {
        const mockLog = makeMockLog();
        injectDailyLogMock(mockLog);

        processEvent({ trigger: 'test' });

        const sessionsDir = path.join(tmp.root, 'docs', '.output', '.state', 'sessions');
        const dateDirs = fs.readdirSync(sessionsDir);
        const snapshotFiles = dateDirs.flatMap(d =>
            fs.readdirSync(path.join(sessionsDir, d))
        );
        expect(snapshotFiles.some(f => f.includes('pre-compaction'))).toBe(true);
    });

    it('processEvent_snapshotContentContainsTrigger', () => {
        const mockLog = makeMockLog();
        injectDailyLogMock(mockLog);

        processEvent({ trigger: 'auto-compact' });

        const sessionsDir = path.join(tmp.root, 'docs', '.output', '.state', 'sessions');
        const dateDirs = fs.readdirSync(sessionsDir);
        const dateDir = path.join(sessionsDir, dateDirs[0]);
        const files = fs.readdirSync(dateDir);
        const content = fs.readFileSync(path.join(dateDir, files[0]), 'utf8');
        expect(content).toContain('auto-compact');
    });

    it('processEvent_ignoresCwdFieldOnPayload_usesProjectRootOnly', () => {
        // REGRESSION: earlier versions of the hook used `parsedJson.cwd` or
        // `process.cwd()` to resolve the output root, which meant a prior
        // `cd src && ...` in the same shell would dump the snapshot into
        // `src/docs/.output/.state/sessions/` and the daily log into
        // `src/docs/.output/.state/memory-daily/`. The hook must now ignore cwd
        // entirely and resolve exclusively from CLAUDE_PROJECT_DIR / __dirname.
        const mockLog = makeMockLog();
        injectDailyLogMock(mockLog);

        const bogusCwd = path.join(tmp.root, 'subdir-that-should-not-be-used');
        fs.mkdirSync(bogusCwd, { recursive: true });

        processEvent({ trigger: 'test', cwd: bogusCwd });

        // Snapshot lands under CLAUDE_PROJECT_DIR (tmp.root), not bogusCwd
        const sessionsDir = path.join(tmp.root, 'docs', '.output', '.state', 'sessions');
        expect(fs.existsSync(sessionsDir)).toBe(true);

        const bogusSessionsDir = path.join(bogusCwd, 'docs', '.output', '.state', 'sessions');
        expect(fs.existsSync(bogusSessionsDir)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// processEvent — DailyLog.capture called
// ---------------------------------------------------------------------------

describe('processEvent_dailyLogCapture', () => {
    it('processEvent_callsDailyLogCapture', () => {
        const mockLog = makeMockLog();
        injectDailyLogMock(mockLog);

        processEvent({ trigger: 'test' });

        expect(mockLog.capture).toHaveBeenCalled();
        const [captureArg] = mockLog.capture.mock.calls[0];
        expect(captureArg).toBe('Pre-Compaction');
    });
});

// ---------------------------------------------------------------------------
// processEvent — extraction regression guard
//
// Extraction moved to the session-handoff skill 2026-04-20. This hook must
// never spawn the extractor again, regardless of env vars or profile.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// getProjectRoot — worktree-safe resolution (F72, council-260715-2244)
// ---------------------------------------------------------------------------
// getProjectRoot() must route through the worktree-safe _lib/project-root.js
// resolveProjectRoot() instead of the naive
// `CLAUDE_PROJECT_DIR || path.resolve(__dirname,...)` fallback — the latter
// anchors the shared GITIGNORED daily-log/session-snapshot writes to whichever
// worktree happens to be current instead of the shared main worktree (the
// same bug class already fixed in memory-capture.cjs/session-start-prime.cjs;
// see project memory `worktree-root-retrofit-must-sweep-all-callsites`).

describe('processEvent_worktreeSafeProjectRoot', () => {
    it('getProjectRoot() invokes resolveProjectRoot() and writes under ITS resolved root, not a naive __dirname fallback', () => {
        const projectRootCachePath = require.resolve('../../core/_lib/project-root');
        const hookCachePath = require.resolve('../pre-compaction-archive.cjs');
        const savedProjectRoot = require.cache[projectRootCachePath];
        const savedHook = require.cache[hookCachePath];

        // A fake resolved root, distinct from both CLAUDE_PROJECT_DIR (unset in
        // this test) and the real repo path a naive __dirname fallback would
        // produce. fs writes are spied/no-op'd so this never touches disk
        // regardless of which path the implementation actually resolves.
        // path.resolve makes the fake root platform-absolute ('C:\fake\…' on win32) so
        // the implementation's path.join output still startsWith it — a bare '/fake/…'
        // gets its separators flipped by win32 path.join and the prefix check fails.
        const fakeRoot = path.resolve('/fake/f72-main-worktree-root');
        let calledWithFallback = null;

        require.cache[projectRootCachePath] = {
            id: projectRootCachePath, filename: projectRootCachePath, loaded: true, children: [], paths: [],
            exports: {
                resolveProjectRoot: (fallbackDir) => { calledWithFallback = fallbackDir; return fakeRoot; },
                resolveWorktreeRoot: (fallbackDir) => fallbackDir,
            },
        };
        delete require.cache[hookCachePath];

        const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
        const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        delete process.env.CLAUDE_PROJECT_DIR;

        try {
            const fresh = require('../pre-compaction-archive.cjs');
            const mockLog = makeMockLog();
            injectDailyLogMock(mockLog);

            fresh.processEvent({ trigger: 'test' });

            expect(calledWithFallback).toBeTruthy(); // resolveProjectRoot() was actually called
            const sessionsMkdirCall = mkdirSpy.mock.calls.find(
                ([p]) => typeof p === 'string' && p.includes('sessions')
            );
            expect(sessionsMkdirCall).toBeTruthy();
            expect(sessionsMkdirCall[0].startsWith(fakeRoot)).toBe(true);
        } finally {
            mkdirSpy.mockRestore();
            writeSpy.mockRestore();
            require.cache[projectRootCachePath] = savedProjectRoot;
            if (savedHook) require.cache[hookCachePath] = savedHook;
            else delete require.cache[hookCachePath];
        }
    });
});

describe('processEvent_noExtractorSpawn', () => {
    it('processEvent_profileStandard_neverSpawns', () => {
        process.env.MEMORY_PROFILE = 'standard';
        const mockLog = makeMockLog();
        injectDailyLogMock(mockLog);
        processEvent({ trigger: 'test' });
        expect(spawnMock).not.toHaveBeenCalled();
    });

    it('processEvent_profileStrict_neverSpawns', () => {
        process.env.MEMORY_PROFILE = 'strict';
        tmp.write('.claude/core/memory-extractor.js', '// stub\n');
        const mockLog = makeMockLog();
        injectDailyLogMock(mockLog);
        processEvent({ trigger: 'test' });
        // Even under strict profile, the compaction hook does not spawn the extractor.
        expect(spawnMock).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Fail-open hardening (R6) — hook mode, end-to-end (spawned process)
//
// The MAJOR gap this wave fixes: `main()` called `processEvent(data)` with no
// try/catch and installed no uncaughtException/unhandledRejection handler, so
// a write error (permission, disk full, ENOTDIR) crashed the process with a
// stack trace and a non-zero exit instead of honoring the hook's documented
// contract: "Exit codes: 0 = always (PreCompact hooks cannot block
// compaction)". These tests run the REAL file (not the in-process mocked
// module above) as a subprocess and force a genuine fs error — the exit code
// IS the contract, not whether a JS function happened not to throw in-process.
// Mirrors secret-scanner.test.js's "runClaudeHook (spawned process)" pattern.
// ---------------------------------------------------------------------------

describe('runClaudeHook (spawned process, fail-open)', () => {
    const hookPath = path.resolve(
        fileURLToPath(import.meta.url),
        '..', '..', 'pre-compaction-archive.cjs'
    );

    function runHook(event, envRoot) {
        try {
            const stdout = execFileSync('node', [hookPath], {
                input: JSON.stringify(event),
                env: { ...process.env, CLAUDE_PROJECT_DIR: envRoot },
                stdio: 'pipe',
            });
            return { exitCode: 0, stdout: stdout.toString(), stderr: '' };
        } catch (err) {
            return {
                exitCode: err.status,
                stdout: err.stdout?.toString() || '',
                stderr: err.stderr?.toString() || '',
            };
        }
    }

    it('hookMode_sessionsPathBlockedByAFile_stillExits0', () => {
        // Force a REAL fs.mkdirSync throw: pre-create docs/.output/.state/sessions
        // as a regular FILE (not a directory). processEvent's
        // `fs.mkdirSync(sessionsDir, { recursive: true })` then fails with
        // ENOTDIR (a path component that must be a directory is a file) — an
        // authentic, unmocked failure in the exact unguarded call site the
        // finding named, not a simulated one.
        const sandbox = createTmpDir({ prefix: 'pre-compaction-hookmode-' });
        try {
            sandbox.write('docs/.output/.state/sessions', '');

            const result = runHook({ trigger: 'auto-compact' }, sandbox.root);

            expect(result.exitCode).toBe(0);
        } finally {
            sandbox.cleanup();
        }
    });

    it('hookMode_healthyRun_stillWritesSnapshotAndExits0', () => {
        // Companion happy-path check at the same subprocess layer: the fix must
        // not have changed successful-run behavior — snapshot still lands on
        // disk and the process still exits 0.
        const sandbox = createTmpDir({ prefix: 'pre-compaction-hookmode-' });
        try {
            const result = runHook({ trigger: 'manual' }, sandbox.root);

            expect(result.exitCode).toBe(0);
            const sessionsDir = path.join(sandbox.root, 'docs', '.output', '.state', 'sessions');
            expect(fs.existsSync(sessionsDir)).toBe(true);
            const dateDirs = fs.readdirSync(sessionsDir);
            expect(dateDirs.length).toBeGreaterThan(0);
        } finally {
            sandbox.cleanup();
        }
    });

    it('hookMode_malformedStdinJson_stillExits0', () => {
        // Belt-and-suspenders: garbage stdin must not escape as an uncaught
        // exception either (JSON.parse is already caught in main(), but this
        // confirms the whole pipeline honors exit-0 end to end).
        const sandbox = createTmpDir({ prefix: 'pre-compaction-hookmode-' });
        try {
            let exitCode = 0;
            try {
                execFileSync('node', [hookPath], {
                    input: '{not valid json',
                    env: { ...process.env, CLAUDE_PROJECT_DIR: sandbox.root },
                    stdio: 'pipe',
                });
            } catch (err) {
                exitCode = err.status;
            }
            expect(exitCode).toBe(0);
        } finally {
            sandbox.cleanup();
        }
    });
});
