import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a log folder name in the expected YYYY-MM-DD_HHMMSS_* format */
function logFolderName(date, suffix = 'run') {
    const d = date instanceof Date ? date : new Date(date);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${dy}_120000_${suffix}`;
}

/**
 * Create a log subfolder inside `logsDir`, write a small file inside it,
 * then backdate both the file and the folder's mtime to `date`.
 * Returns the full path to the folder.
 */
function createLogFolder(logsDir, date, suffix = 'run') {
    const name = logFolderName(date, suffix);
    const folderPath = path.join(logsDir, name);
    fs.mkdirSync(folderPath, { recursive: true });

    // Write a tiny file so getFolderSize returns > 0
    const filePath = path.join(folderPath, 'output.log');
    fs.writeFileSync(filePath, 'some log content\n');

    // Back-date the mtime of file and folder
    const t = date instanceof Date ? date : new Date(date);
    const tsec = t.getTime() / 1000;
    fs.utimesSync(filePath, tsec, tsec);
    fs.utimesSync(folderPath, tsec, tsec);

    return folderPath;
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let tmp;
let originalEnv;

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'cleanup-logs-test-' });
    originalEnv = process.env.CLAUDE_PROJECT_DIR;
    // Point all path resolution at our tmp root
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
});

afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalEnv;
    tmp.cleanup();
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------

describe('formatBytes', () => {
    const { formatBytes } = require('../../../.agents/core/cleanup-logs');

    it('returns 0 B for zero', () => {
        expect(formatBytes(0)).toBe('0 B');
    });

    it('returns bytes for values under 1 KB', () => {
        expect(formatBytes(500)).toBe('500 B');
    });

    it('returns KB for values in the kilobyte range', () => {
        expect(formatBytes(1024)).toBe('1 KB');
        expect(formatBytes(2048)).toBe('2 KB');
    });

    it('returns MB for values in the megabyte range', () => {
        expect(formatBytes(1024 * 1024)).toBe('1 MB');
    });

    it('returns GB for values in the gigabyte range', () => {
        expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    });

    it('formats fractional values to 2 decimal places', () => {
        // 1536 bytes = 1.5 KB
        expect(formatBytes(1536)).toBe('1.5 KB');
    });
});

// ---------------------------------------------------------------------------
// getFolderSize
// ---------------------------------------------------------------------------

describe('getFolderSize', () => {
    const { getFolderSize } = require('../../../.agents/core/cleanup-logs');

    it('returns 0 for an empty directory', async () => {
        const dir = tmp.mkdir('empty-dir');
        const size = await getFolderSize(dir);
        expect(size).toBe(0);
    });

    it('returns 0 for a non-existent directory', async () => {
        const size = await getFolderSize(path.join(tmp.root, 'does-not-exist'));
        expect(size).toBe(0);
    });

    it('sums file sizes in a flat directory', async () => {
        tmp.write('flat/a.txt', 'hello');    // 5 bytes
        tmp.write('flat/b.txt', 'world!');   // 6 bytes
        const size = await getFolderSize(path.join(tmp.root, 'flat'));
        expect(size).toBe(11);
    });

    it('recursively sums nested files', async () => {
        tmp.write('nested/sub/a.txt', '12345');  // 5 bytes
        tmp.write('nested/b.txt', '123');         // 3 bytes
        const size = await getFolderSize(path.join(tmp.root, 'nested'));
        expect(size).toBe(8);
    });
});

// ---------------------------------------------------------------------------
// cleanupLogs — main path
// ---------------------------------------------------------------------------

describe('cleanupLogs', () => {
    // Each test loads cleanupLogs fresh so CLAUDE_PROJECT_DIR is picked up
    // at call time (the module reads the env each invocation via getProjectRoot).
    const { cleanupLogs } = require('../../../.agents/core/cleanup-logs');

    /** Return the telemetry/logs dir for the current tmp root */
    function logsDir() {
        return path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'logs');
    }

    it('does nothing when the logs dir does not exist', async () => {
        // No logs dir created — should not throw
        await expect(cleanupLogs(30)).resolves.toBeUndefined();
    });

    it('does nothing when the logs dir is empty', async () => {
        fs.mkdirSync(logsDir(), { recursive: true });
        await expect(cleanupLogs(30)).resolves.toBeUndefined();
    });

    it('deletes a folder older than maxAgeDays', async () => {
        const dir = logsDir();
        // 60 days ago — older than the 30-day cutoff
        const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        const oldFolder = createLogFolder(dir, oldDate, 'old');

        await cleanupLogs(30);

        expect(fs.existsSync(oldFolder)).toBe(false);
    });

    it('keeps a folder newer than maxAgeDays', async () => {
        const dir = logsDir();
        // 5 days ago — within the 30-day window
        const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
        const recentFolder = createLogFolder(dir, recentDate, 'recent');

        await cleanupLogs(30);

        expect(fs.existsSync(recentFolder)).toBe(true);
    });

    it('deletes old folders and keeps recent ones simultaneously', async () => {
        const dir = logsDir();

        const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

        const oldFolder = createLogFolder(dir, oldDate, 'old');
        const recentFolder = createLogFolder(dir, recentDate, 'recent');

        await cleanupLogs(30);

        expect(fs.existsSync(oldFolder)).toBe(false);
        expect(fs.existsSync(recentFolder)).toBe(true);
    });

    it('skips entries whose names do not match the expected date format', async () => {
        const dir = logsDir();
        // A directory without the YYYY-MM-DD_ prefix — should be left alone
        const unnamedDir = path.join(dir, 'not-a-dated-folder');
        fs.mkdirSync(unnamedDir, { recursive: true });

        await cleanupLogs(30);

        expect(fs.existsSync(unnamedDir)).toBe(true);
    });

    it('skips _latest-* prefixed entries', async () => {
        const dir = logsDir();
        // A _latest- directory — should never be deleted regardless of date
        const latestDir = path.join(dir, '_latest-summary');
        fs.mkdirSync(latestDir, { recursive: true });

        await cleanupLogs(30);

        expect(fs.existsSync(latestDir)).toBe(true);
    });

    it('skips plain files (non-directories) in the logs dir', async () => {
        const dir = logsDir();
        fs.mkdirSync(dir, { recursive: true });
        // A file at the top level of logs dir — should be ignored
        const filePath = path.join(dir, '2020-01-01_120000_something');
        fs.writeFileSync(filePath, 'stray file');

        await cleanupLogs(30);

        // It's a file, not a directory — skipped because !entry.isDirectory()
        expect(fs.existsSync(filePath)).toBe(true);
    });

    it('uses maxAgeDays=1 to delete a folder from yesterday', async () => {
        const dir = logsDir();
        // 2 days ago — older than 1-day cutoff
        const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        const oldFolder = createLogFolder(dir, oldDate, 'yesterday');

        await cleanupLogs(1);

        expect(fs.existsSync(oldFolder)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// cleanupLogs — flat gate-*.log files (F26)
//
// The ONLY producer under telemetry/logs/ is gate.js, which writes FLAT files
// named gate-{ISO}.log (e.g. gate-2026-06-10T02-42-10-940Z.log) — never dated
// subdirs. cleanupLogs must age these out using the timestamp in the filename.
// ---------------------------------------------------------------------------

describe('cleanupLogs — flat gate-*.log files', () => {
    const { cleanupLogs } = require('../../../.agents/core/cleanup-logs');

    function logsDir() {
        return path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'logs');
    }

    /** Build a gate log filename exactly as gate.js does: gate-{ISO}.log with `:`/`.` → `-` */
    function gateLogName(date) {
        const iso = (date instanceof Date ? date : new Date(date)).toISOString().replace(/[:.]/g, '-');
        return `gate-${iso}.log`;
    }

    it('deletes a flat gate-*.log older than maxAgeDays', async () => {
        const dir = logsDir();
        fs.mkdirSync(dir, { recursive: true });
        const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        const oldLog = path.join(dir, gateLogName(oldDate));
        fs.writeFileSync(oldLog, 'gate output\n');

        await cleanupLogs(30);

        expect(fs.existsSync(oldLog)).toBe(false);
    });

    it('keeps a flat gate-*.log newer than maxAgeDays', async () => {
        const dir = logsDir();
        fs.mkdirSync(dir, { recursive: true });
        const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
        const recentLog = path.join(dir, gateLogName(recentDate));
        fs.writeFileSync(recentLog, 'gate output\n');

        await cleanupLogs(30);

        expect(fs.existsSync(recentLog)).toBe(true);
    });

    it('deletes old gate logs and keeps recent ones simultaneously', async () => {
        const dir = logsDir();
        fs.mkdirSync(dir, { recursive: true });
        const oldLog = path.join(dir, gateLogName(new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)));
        const recentLog = path.join(dir, gateLogName(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)));
        fs.writeFileSync(oldLog, 'old\n');
        fs.writeFileSync(recentLog, 'recent\n');

        await cleanupLogs(30);

        expect(fs.existsSync(oldLog)).toBe(false);
        expect(fs.existsSync(recentLog)).toBe(true);
    });

    it('leaves non-gate flat files alone (only gate-*.log is targeted)', async () => {
        const dir = logsDir();
        fs.mkdirSync(dir, { recursive: true });
        // A stray flat file that is NOT a gate log — must be preserved regardless of age
        const stray = path.join(dir, '2020-01-01_120000_something');
        fs.writeFileSync(stray, 'stray\n');

        await cleanupLogs(30);

        expect(fs.existsSync(stray)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// cleanupLogs — exports surface (smoke)
// ---------------------------------------------------------------------------

describe('cleanup-logs exports', () => {
    it('loads without side effects and exports the three helpers', () => {
        const exports = require('../../../.agents/core/cleanup-logs');
        expect(typeof exports.cleanupLogs).toBe('function');
        expect(typeof exports.getFolderSize).toBe('function');
        expect(typeof exports.formatBytes).toBe('function');
    });
});

// ---------------------------------------------------------------------------
// CLI main guard — in-process coverage via Module._compile injection
//
// Same technique as telemetry-log: prepend `require.main = module;` before
// _compile runs so the main guard body (lines 95-107) is executed in-process
// and captured by v8 coverage.
// ---------------------------------------------------------------------------

describe('cleanup-logs CLI main guard (in-process via _compile injection)', () => {
    const Module = require('node:module');
    const CLEANUP_LOGS_JS = path.resolve(__dirname, '../../../.agents/core/cleanup-logs.js');

    function runMainInProcess(argv) {
        const origCompile = Module.prototype._compile;
        const origArgv = process.argv;
        const origEnv = process.env.CLAUDE_PROJECT_DIR;

        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        process.argv = ['node', CLEANUP_LOGS_JS, ...argv];

        // Must be inserted AFTER the shebang line (if present) — `#!` is only valid on line 1.
        Module.prototype._compile = function (code, filename) {
            if (filename === CLEANUP_LOGS_JS) {
                if (code.startsWith('#!')) {
                    const nlIdx = code.indexOf('\n');
                    code = code.slice(0, nlIdx + 1) + 'require.main = module;\n' + code.slice(nlIdx + 1);
                } else {
                    code = 'require.main = module;\n' + code;
                }
            }
            return origCompile.call(this, code, filename);
        };

        delete require.cache[CLEANUP_LOGS_JS];

        let exitCode;
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
            exitCode = code;
            throw new Error(`process.exit(${code})`);
        });

        try {
            require(CLEANUP_LOGS_JS);
        } catch (e) {
            // Expected: process.exit() throws via our spy (sync) or the async cleanupLogs runs
        } finally {
            Module.prototype._compile = origCompile;
            process.argv = origArgv;
            if (origEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
            else process.env.CLAUDE_PROJECT_DIR = origEnv;
            delete require.cache[CLEANUP_LOGS_JS];
            exitSpy.mockRestore();
        }

        return { exitCode };
    }

    it('exits with code 1 when --days is not a positive integer', () => {
        const { exitCode } = runMainInProcess(['--days', 'abc']);
        expect(exitCode).toBe(1);
    });

    it('exits with code 1 when --days is 0', () => {
        const { exitCode } = runMainInProcess(['--days', '0']);
        expect(exitCode).toBe(1);
    });

    it('runs cleanupLogs without error when --days is valid', async () => {
        // The main guard fires and calls cleanupLogs(days) which is async.
        // The sync part (argv parsing + validation) runs; cleanupLogs promise
        // runs in the background. We just verify no error exit.
        const { exitCode } = runMainInProcess(['--days', '7']);
        // exitCode is undefined (async branch doesn't call process.exit synchronously)
        // or 0 if it resolved immediately — either is acceptable (no exit(1))
        expect(exitCode).not.toBe(1);
    });

    it('runs with default days when --days is omitted', async () => {
        const { exitCode } = runMainInProcess([]);
        expect(exitCode).not.toBe(1);
    });
});

// ---------------------------------------------------------------------------
// CLI main guard — subprocess via execFileSync (correctness verification)
// These don't contribute to v8 coverage but verify real CLI behavior.
// ---------------------------------------------------------------------------

describe('cleanup-logs CLI main guard (subprocess)', () => {
    const { execFileSync } = require('node:child_process');
    const CLEANUP_LOGS_JS = path.resolve(__dirname, '../../../.agents/core/cleanup-logs.js');

    function runCli(argv, envOverrides = {}) {
        try {
            const stdout = execFileSync(
                'node',
                [CLEANUP_LOGS_JS, ...argv],
                {
                    encoding: 'utf8',
                    env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root, ...envOverrides },
                }
            );
            return { status: 0, stdout };
        } catch (e) {
            return { status: e.status ?? 1, stdout: (e.stdout || '') + (e.stderr || '') };
        }
    }

    it('exits with code 1 when --days is not a positive integer', () => {
        const { status } = runCli(['--days', 'abc']);
        expect(status).toBe(1);
    });

    it('exits with code 1 when --days is 0', () => {
        const { status } = runCli(['--days', '0']);
        expect(status).toBe(1);
    });

    it('exits with code 0 when no --days flag is provided (default 30)', () => {
        const { status, stdout } = runCli([]);
        expect(status).toBe(0);
        expect(stdout).toContain('Deleted 0 entries');
    });

    it('exits with code 0 when a valid --days value is provided', () => {
        const { status } = runCli(['--days', '7']);
        expect(status).toBe(0);
    });

    it('deletes old folders when invoked via CLI', () => {
        const dir = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'logs');
        const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        const oldFolder = createLogFolder(dir, oldDate, 'cli-test');

        const { status, stdout } = runCli(['--days', '30']);

        expect(status).toBe(0);
        expect(stdout).toContain('Deleted 1 entries');
        expect(fs.existsSync(oldFolder)).toBe(false);
    });
});
