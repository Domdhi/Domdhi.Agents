// AC→source map (memory-capture, post-2026-04-20 refactor):
//   - processEvent routes on parsedJson: null/empty → handleStop; Bash + command → handleBashPostToolUse; else → handleStop
//   - handleStop: shouldCapture() → spawnCapture (daily-log). spawnCurate only under MEMORY_PROFILE=strict.
//   - handleStop does NOT spawn compiler or extractor (compiler retired; extractor fires from session-handoff skill)
//   - handleBashPostToolUse: detects git commit output, runs execSync for diffstat, calls DailyLog.captureCommit
//   - Dedup: if hash already in daily log file → no capture
//   - Non-commit Bash (e.g., ls) → ignored
//   - MEMORY_PROFILE gate on processEvent: minimal → returns null, no spawns
//   - Spawn mock MUST return { unref: vi.fn() } — hook calls child.unref()
//   - installExecSyncMock(['execSync','spawn']) used because source destructures both at load

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');
const { installExecSyncMock } = require('../../core/__tests__/_helpers/claude-mock');

// ---------------------------------------------------------------------------
// Save originals — memory-capture reads CLAUDE_PROJECT_DIR at MODULE LOAD time.
// Module is loaded exactly once via installExecSyncMock's loadSourceFn.
// We must set CLAUDE_PROJECT_DIR before that call.
// ---------------------------------------------------------------------------
const originalClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
const originalMemoryProfile = process.env.MEMORY_PROFILE;

// ---------------------------------------------------------------------------
// Set up a real tmp directory BEFORE calling installExecSyncMock so that
// the CLAUDE_PROJECT_DIR at module-load time is a real (writable) path.
// ---------------------------------------------------------------------------
const setupTmp = createTmpDir({ prefix: 'memory-capture-setup-' });
process.env.CLAUDE_PROJECT_DIR = setupTmp.root;

// Stub the spawned scripts so `fs.existsSync(curatorPath)` etc. short-circuit
// to true inside spawnCurate. Without these, the spawn mock is never invoked
// because the hook returns early.
setupTmp.write('.claude/core/daily-log.js', '// test stub\n');
setupTmp.write('.claude/core/memory-curator.js', '// test stub\n');

// ---------------------------------------------------------------------------
// Load source + inject mocks for both 'execSync' and 'spawn'.
// The source destructures both from child_process at line 20:
//   const { spawn, execSync } = require('child_process');
// installExecSyncMock injects vi.fn() backed fakes into require.cache BEFORE
// the source loads, so destructuring captures our mocks.
// ---------------------------------------------------------------------------
const { mocks, source } = installExecSyncMock(
    vi,
    () => require('../memory-capture.cjs'),
    ['execSync', 'spawn']
);

const { execSync: execSyncMock, spawn: spawnMock } = mocks;
const { processEvent, handleStop, handleBashPostToolUse, shouldCapture, isCommitCommand } = source;

// ---------------------------------------------------------------------------
// Per-test sandbox
// ---------------------------------------------------------------------------
let tmp;
const today = new Date().toISOString().slice(0, 10);

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'memory-capture-' });
    // Reset mocks
    execSyncMock.mockReset();
    spawnMock.mockReset();
    // spawn must return an object with unref() — the hook calls .unref() on the returned child
    spawnMock.mockReturnValue({ unref: vi.fn() });
    // Default profile: standard (the default for getProfile())
    process.env.MEMORY_PROFILE = 'standard';
});

afterEach(() => {
    tmp.cleanup();
    // Restore env vars
    process.env.MEMORY_PROFILE = 'standard';
});

afterAll(() => {
    setupTmp.cleanup();
    // Restore original env vars
    if (originalClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalClaudeProjectDir;
    if (originalMemoryProfile === undefined) delete process.env.MEMORY_PROFILE;
    else process.env.MEMORY_PROFILE = originalMemoryProfile;
});

// ---------------------------------------------------------------------------
// shouldCapture
// ---------------------------------------------------------------------------

describe('shouldCapture', () => {
    it('shouldCapture_fileDoesNotExist_returnsTrue', () => {
        // No daily log file in setupTmp → shouldCapture should return true
        // (file at CLAUDE_PROJECT_DIR/.../today.md does not exist)
        const result = shouldCapture();
        expect(result).toBe(true);
    });

    it('shouldCapture_recentlyModifiedFile_returnsFalse', () => {
        // Create the daily log file in setupTmp with a fresh mtime (modified now)
        const dailyDir = path.join(setupTmp.root, 'docs', '.output', '.state', 'memory-daily');
        fs.mkdirSync(dailyDir, { recursive: true });
        const logPath = path.join(dailyDir, `${today}.md`);
        fs.writeFileSync(logPath, '# Day\n\n', 'utf8');
        // File was just written → minutesSinceUpdate < 30 → shouldCapture returns false
        const result = shouldCapture();
        expect(result).toBe(false);
        // Clean up so other tests aren't affected
        fs.rmSync(logPath);
    });
});

// ---------------------------------------------------------------------------
// handleStop — spawn verification
// ---------------------------------------------------------------------------

describe('handleStop', () => {
    it('handleStop_profileStandard_doesNotSpawnCompiler', () => {
        // Compiler pipeline retired 2026-04-20 — handleStop must NOT spawn it.
        process.env.MEMORY_PROFILE = 'standard';
        handleStop();
        const compileCalls = spawnMock.mock.calls.filter(
            c => c[1] && c[1][0] && c[1][0].includes('memory-compiler.js')
        );
        expect(compileCalls).toHaveLength(0);
    });

    it('handleStop_profileStandard_doesNotSpawnExtractor', () => {
        // Extraction moved to session-handoff skill — handleStop must NOT spawn extractor.
        process.env.MEMORY_PROFILE = 'standard';
        handleStop();
        const extractorCalls = spawnMock.mock.calls.filter(
            c => c[1] && c[1][0] && c[1][0].includes('memory-extractor.js')
        );
        expect(extractorCalls).toHaveLength(0);
    });

    it('handleStop_spawnsCapture_whenShouldCaptureTrue', () => {
        // shouldCapture reads dailyLogPath at module scope (setupTmp.root, no daily log file there)
        // so shouldCapture() returns true → spawnCapture fires
        process.env.MEMORY_PROFILE = 'standard';
        handleStop();
        const spawnedScripts = spawnMock.mock.calls.map(c => c[1][0]);
        expect(spawnedScripts.some(p => p.includes('daily-log.js'))).toBe(true);
    });

    it('handleStop_spawnReturnValueUsed_unrefCalled', () => {
        process.env.MEMORY_PROFILE = 'standard';
        const unrefFn = vi.fn();
        spawnMock.mockReturnValue({ unref: unrefFn });
        handleStop();
        expect(unrefFn).toHaveBeenCalled();
    });

    it('handleStop_spawnCapture_calledWithAutoStopTrigger', () => {
        process.env.MEMORY_PROFILE = 'standard';
        handleStop();
        const captureCall = spawnMock.mock.calls.find(c => c[1][0] && c[1][0].includes('daily-log.js'));
        // Should be called with 'capture' and '--trigger', 'auto-stop'
        if (captureCall) {
            expect(captureCall[1]).toContain('capture');
            expect(captureCall[1]).toContain('auto-stop');
        }
    });

    it('handleStop_profileStrict_spawnsCurate', () => {
        process.env.MEMORY_PROFILE = 'strict';
        handleStop();
        const curateCalls = spawnMock.mock.calls.filter(
            c => c[1] && c[1][0] && c[1][0].includes('memory-curator.js')
        );
        expect(curateCalls).toHaveLength(1);
    });

    it('handleStop_profileStandard_doesNotSpawnCurate', () => {
        process.env.MEMORY_PROFILE = 'standard';
        handleStop();
        const curateCalls = spawnMock.mock.calls.filter(
            c => c[1] && c[1][0] && c[1][0].includes('memory-curator.js')
        );
        expect(curateCalls).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// processEvent — routing
// ---------------------------------------------------------------------------

describe('processEvent', () => {
    it('processEvent_nullInput_callsHandleStop_profileStandard', () => {
        process.env.MEMORY_PROFILE = 'standard';
        const result = processEvent(null);
        expect(result).toBeNull();
        // handleStop should have fired → spawn called for daily-log capture
        const captureCalls = spawnMock.mock.calls.filter(
            c => c[1] && c[1][0] && c[1][0].includes('daily-log.js')
        );
        expect(captureCalls.length).toBeGreaterThan(0);
    });

    it('processEvent_emptyObject_callsHandleStop', () => {
        process.env.MEMORY_PROFILE = 'standard';
        const result = processEvent({});
        expect(result).toBeNull();
        const captureCalls = spawnMock.mock.calls.filter(
            c => c[1] && c[1][0] && c[1][0].includes('daily-log.js')
        );
        expect(captureCalls.length).toBeGreaterThan(0);
    });

    it('processEvent_bashEvent_withCommand_callsHandleBashPostToolUse', () => {
        process.env.MEMORY_PROFILE = 'standard';
        const event = {
            tool_name: 'Bash',
            tool_input: { command: 'ls -la' },
            tool_output: { stdout: 'file1\nfile2' }
        };
        const result = processEvent(event);
        expect(result).toBeNull();
        // ls command is not a git commit → execSync should NOT be called
        expect(execSyncMock).not.toHaveBeenCalled();
        // handleStop should NOT fire (no daily-log capture spawn)
        const captureCalls = spawnMock.mock.calls.filter(
            c => c[1] && c[1][0] && c[1][0].includes('daily-log.js')
        );
        expect(captureCalls).toHaveLength(0);
    });

    it('processEvent_profileMinimal_returnsNull_noSpawns', () => {
        process.env.MEMORY_PROFILE = 'minimal';
        const result = processEvent({});
        expect(result).toBeNull();
        expect(spawnMock).not.toHaveBeenCalled();
        expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('processEvent_nonBashEvent_callsHandleStop', () => {
        process.env.MEMORY_PROFILE = 'standard';
        const event = { tool_name: 'Read', tool_input: { file_path: '/foo.js' } };
        const result = processEvent(event);
        expect(result).toBeNull();
        // handleStop fires → daily-log capture spawn
        const captureCalls = spawnMock.mock.calls.filter(
            c => c[1] && c[1][0] && c[1][0].includes('daily-log.js')
        );
        expect(captureCalls.length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// handleBashPostToolUse — commit detection
// ---------------------------------------------------------------------------

describe('handleBashPostToolUse_commitDetection', () => {
    it('handleBashPostToolUse_gitCommit_callsExecSyncForDiffstat', () => {
        execSyncMock.mockReturnValue('5\t3\tfile.js\n');
        const event = {
            tool_name: 'Bash',
            tool_input: { command: 'git commit -m "feat: add thing"' },
            tool_output: { stdout: '[main abc1234] feat: add thing\n 1 file changed, 1 insertion(+)' }
        };
        handleBashPostToolUse(event);
        // execSync should be called for `git show --numstat`
        expect(execSyncMock).toHaveBeenCalled();
        const [cmd] = execSyncMock.mock.calls[0];
        expect(cmd).toContain('git show');
        expect(cmd).toContain('abc1234');
    });

    it('handleBashPostToolUse_nonCommitCommand_noExecSync', () => {
        const event = {
            tool_name: 'Bash',
            tool_input: { command: 'ls -la' },
            tool_output: { stdout: 'file1\nfile2' }
        };
        handleBashPostToolUse(event);
        expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('handleBashPostToolUse_gitStatus_notCaptured', () => {
        const event = {
            tool_name: 'Bash',
            tool_input: { command: 'git status' },
            tool_output: { stdout: 'On branch main\nnothing to commit' }
        };
        handleBashPostToolUse(event);
        expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('handleBashPostToolUse_gitCommitAmend_ignored', () => {
        const event = {
            tool_name: 'Bash',
            tool_input: { command: 'git commit --amend -m "fix typo"' },
            tool_output: { stdout: '[main def5678] fix typo\n 1 file changed' }
        };
        handleBashPostToolUse(event);
        expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('handleBashPostToolUse_noCommitHashInOutput_ignored', () => {
        // git commit command but output doesn't match expected pattern
        execSyncMock.mockReturnValue('');
        const event = {
            tool_name: 'Bash',
            tool_input: { command: 'git commit -m "thing"' },
            tool_output: { stdout: 'nothing happened' }
        };
        handleBashPostToolUse(event);
        // No commit hash match → should not call execSync
        expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('handleBashPostToolUse_toolResponseShape_captures', () => {
        // Claude Code's current payload shape uses tool_response.stdout, not tool_output.stdout.
        // Regression guard: the hook must read either.
        execSyncMock.mockReturnValue('5\t3\tfile.js\n');
        const event = {
            tool_name: 'Bash',
            tool_input: { command: 'git commit -m "feat: real"' },
            tool_response: { stdout: '[main fed1234] feat: real\n 1 file changed, 5 insertions(+)' }
        };
        handleBashPostToolUse(event);
        // tool_response.stdout supplies the commit output → execSync fires for diffstat
        expect(execSyncMock).toHaveBeenCalled();
        const [cmd] = execSyncMock.mock.calls[0];
        expect(cmd).toContain('git show');
        expect(cmd).toContain('fed1234');
    });
});

// ---------------------------------------------------------------------------
// F64 — commit.js invocation recognition
//
// This repo MANDATES `node .claude/core/commit.js` (commit-guard blocks inline
// `git commit -m`). commit.js runs `git commit -F` in a CHILD process, so the
// PostToolUse hook sees `node .claude/core/commit.js …`, never `git commit`.
// The gate must recognize BOTH forms or commit-context enrichment never fires.
// ---------------------------------------------------------------------------

describe('isCommitCommand (F64 — recognizes commit.js invocation)', () => {
    it('recognizes node .claude/core/commit.js with flags', () => {
        expect(isCommitCommand('node .claude/core/commit.js --all')).toBe(true);
    });

    it('recognizes bare node .claude/core/commit.js', () => {
        expect(isCommitCommand('node .claude/core/commit.js')).toBe(true);
    });

    it('still recognizes a plain git commit', () => {
        expect(isCommitCommand('git commit -m "feat: x"')).toBe(true);
    });

    it('does not recognize a non-commit command', () => {
        expect(isCommitCommand('ls -la')).toBe(false);
    });
});

describe('handleBashPostToolUse — commit.js invocation (F64)', () => {
    it('captures commit context from a commit.js invocation', () => {
        // commit.js prints git's "[branch hash] subject" line (stdio: 'inherit'),
        // which the Bash tool surfaces in tool_response.stdout.
        execSyncMock.mockReturnValue('5\t3\tfile.js\n');
        const event = {
            tool_name: 'Bash',
            tool_input: { command: 'node .claude/core/commit.js --all' },
            tool_response: { stdout: '[main abc9f12] feat: real change\n 2 files changed, 5 insertions(+)' }
        };
        handleBashPostToolUse(event);
        // Recognized as a commit → execSync fires for the diffstat enrichment
        expect(execSyncMock).toHaveBeenCalled();
        const [cmd] = execSyncMock.mock.calls[0];
        expect(cmd).toContain('git show');
        expect(cmd).toContain('abc9f12');
    });

    it('ignores a commit.js invocation with --amend', () => {
        const event = {
            tool_name: 'Bash',
            tool_input: { command: 'node .claude/core/commit.js --amend' },
            tool_response: { stdout: '[main abc9f12] amended\n 1 file changed' }
        };
        handleBashPostToolUse(event);
        expect(execSyncMock).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// handleBashPostToolUse — dedup
// ---------------------------------------------------------------------------

describe('handleBashPostToolUse_dedup', () => {
    it('handleBashPostToolUse_hashAlreadyInLog_noExecSyncCall', () => {
        // Seed the daily log in CLAUDE_PROJECT_DIR (setupTmp.root) with the hash
        const dailyDir = path.join(setupTmp.root, 'docs', '.output', '.state', 'memory-daily');
        fs.mkdirSync(dailyDir, { recursive: true });
        const logPath = path.join(dailyDir, `${today}.md`);
        fs.writeFileSync(logPath, `# Day\n\nhash abc1234 already captured\n`, 'utf8');

        try {
            const event = {
                tool_name: 'Bash',
                tool_input: { command: 'git commit -m "test"' },
                tool_output: { stdout: '[main abc1234] test\n 1 file changed, 1 insertion(+)' }
            };
            handleBashPostToolUse(event);
            // Hash already in file → dedup fires → execSync never called
            expect(execSyncMock).not.toHaveBeenCalled();
        } finally {
            fs.rmSync(logPath, { force: true });
        }
    });

    it('handleBashPostToolUse_newHash_callsExecSync', () => {
        // Daily log exists but does NOT contain the new hash.
        // Hash must be hex-only — the source regex is /([a-f0-9]{7,})/.
        const dailyDir = path.join(setupTmp.root, 'docs', '.output', '.state', 'memory-daily');
        fs.mkdirSync(dailyDir, { recursive: true });
        const logPath = path.join(dailyDir, `${today}.md`);
        fs.writeFileSync(logPath, `# Day\n\nhash abc1234 captured earlier\n`, 'utf8');
        execSyncMock.mockReturnValue('3\t1\tfile.js\n');

        try {
            const event = {
                tool_name: 'Bash',
                tool_input: { command: 'git commit -m "new thing"' },
                tool_output: { stdout: '[main def5678] new thing\n 1 file changed, 1 insertion(+)' }
            };
            handleBashPostToolUse(event);
            // New hash (def5678, hex-only, 7 chars) → execSync should be called for diffstat
            expect(execSyncMock).toHaveBeenCalled();
        } finally {
            fs.rmSync(logPath, { force: true });
        }
    });

    it('handleBashPostToolUse_duplicateHash_contentCountUnchanged', () => {
        const dailyDir = path.join(setupTmp.root, 'docs', '.output', '.state', 'memory-daily');
        fs.mkdirSync(dailyDir, { recursive: true });
        const logPath = path.join(dailyDir, `${today}.md`);
        const seed = '# Day\n\nhash abc1234 already captured\n';
        fs.writeFileSync(logPath, seed, 'utf8');

        try {
            const event = {
                tool_name: 'Bash',
                tool_input: { command: 'git commit -m "test"' },
                tool_output: { stdout: '[main abc1234] test\n 1 file changed, 1 insertion(+)' }
            };
            // First call: hash already in file → no-op
            handleBashPostToolUse(event);
            const content = fs.readFileSync(logPath, 'utf8');
            const hashOccurrences = (content.match(/abc1234/g) || []).length;
            // Still just the one seeded occurrence
            expect(hashOccurrences).toBe(1);
        } finally {
            fs.rmSync(logPath, { force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// handleBashPostToolUse — fallback branch uses the shared formatCommitEntry
// (Wave 5G de-dup: memory-capture's fallback must never hand-reproduce
// DailyLog.captureCommit's string format)
// ---------------------------------------------------------------------------

describe('handleBashPostToolUse_fallbackFormatting', () => {
    it('handleBashPostToolUse_captureCommitThrows_fallbackWritesFormatCommitEntryOutput', () => {
        // Arrange — force the primary DailyLog.captureCommit path to throw so
        // handleBashPostToolUse falls into the catch-branch direct-append path.
        const DailyLog = require('../../core/daily-log');
        const captureCommitSpy = vi
            .spyOn(DailyLog.prototype, 'captureCommit')
            .mockImplementation(() => {
                throw new Error('simulated captureCommit failure');
            });

        const fixedNow = new Date('2026-07-16T09:15:00.000Z');
        const fixedDateStr = fixedNow.toISOString().slice(0, 10);
        vi.useFakeTimers();
        vi.setSystemTime(fixedNow);

        execSyncMock.mockReturnValue('5\t3\tfile.js\n');
        const dailyDir = path.join(setupTmp.root, 'docs', '.output', '.state', 'memory-daily');
        // Use the FIXED (faked) date, not the file-level `today` constant — the
        // hook computes its write path from `new Date()` too, which is faked.
        const logPath = path.join(dailyDir, `${fixedDateStr}.md`);

        try {
            const event = {
                tool_name: 'Bash',
                tool_input: { command: 'git commit -m "feat: fallback path"' },
                tool_output: { stdout: '[main fedcba1] feat: fallback path\n 1 file changed, 5 insertions(+), 3 deletions(-)' }
            };

            // Act
            handleBashPostToolUse(event);

            // Assert — the fallback's written entry is byte-identical to what
            // DailyLog.formatCommitEntry produces for the same inputs, proving
            // the two paths cannot drift (same function, not a visual copy).
            const timeLabel = fixedNow.toISOString().slice(11, 16);
            const expected = DailyLog.formatCommitEntry('fedcba1', 'feat: fallback path', 1, 5, 3, timeLabel);
            const writtenContent = fs.readFileSync(logPath, 'utf8');
            expect(writtenContent).toBe(expected);
        } finally {
            captureCommitSpy.mockRestore();
            vi.useRealTimers();
            fs.rmSync(logPath, { force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// handleBashPostToolUse — missing tool_output edge cases
// ---------------------------------------------------------------------------

describe('handleBashPostToolUse_edgeCases', () => {
    it('handleBashPostToolUse_noToolOutput_ignored', () => {
        const event = {
            tool_name: 'Bash',
            tool_input: { command: 'git commit -m "test"' },
            tool_output: null
        };
        // No stdout → commit output won't match → no execSync
        handleBashPostToolUse(event);
        expect(execSyncMock).not.toHaveBeenCalled();
    });

    it('handleBashPostToolUse_emptyCommand_ignored', () => {
        const event = {
            tool_name: 'Bash',
            tool_input: { command: '' },
            tool_output: { stdout: '' }
        };
        handleBashPostToolUse(event);
        expect(execSyncMock).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// module.exports — shape
// ---------------------------------------------------------------------------

describe('moduleExports', () => {
    it('exports_hasProcessEvent', () => {
        expect(typeof processEvent).toBe('function');
    });

    it('exports_hasHandleStop', () => {
        expect(typeof handleStop).toBe('function');
    });

    it('exports_hasHandleBashPostToolUse', () => {
        expect(typeof handleBashPostToolUse).toBe('function');
    });

    it('exports_hasShouldCapture', () => {
        expect(typeof shouldCapture).toBe('function');
    });
});
