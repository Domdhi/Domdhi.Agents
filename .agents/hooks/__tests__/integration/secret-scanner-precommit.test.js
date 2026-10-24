import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Helpers are three hops up from integration/ to .claude/, then down to core/__tests__/_helpers/
const { createTmpDir } = require('../../../core/__tests__/_helpers/tmp-dir');
const { createGitRepo, gitAvailable } = require('../../../core/__tests__/_helpers/git-fixture');

// Resolve scanner path: up two levels from integration/ → __tests__/ → hooks/
const __filename = fileURLToPath(import.meta.url);
const SCANNER_PATH = path.resolve(path.dirname(__filename), '..', '..', 'secret-scanner.cjs');

// ─── Subprocess helper ────────────────────────────────────────────────────────

/**
 * Invokes secret-scanner.cjs --git-precommit as a subprocess rooted at repoPath.
 * Returns { exitCode, stdout, stderr }.
 *
 * Both cwd and CLAUDE_PROJECT_DIR are set to repoPath:
 *   - cwd gives git its working directory if anything in the scanner still relied
 *     on inheriting CWD.
 *   - CLAUDE_PROJECT_DIR is what the scanner's getProjectRoot() helper reads;
 *     without it the scanner would resolve to the real repo root (__dirname
 *     fallback) and `git diff --cached` would run against the wrong tree.
 *
 * @param {string} repoPath  Absolute path to an initialized git repo.
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
function runScanner(repoPath) {
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    try {
        stdout = execFileSync('node', [SCANNER_PATH, '--git-precommit'], {
            cwd: repoPath,
            env: { ...process.env, CLAUDE_PROJECT_DIR: repoPath },
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (err) {
        exitCode = err.status ?? 1;
        stdout = err.stdout?.toString() ?? '';
        stderr = err.stderr?.toString() ?? '';
    }
    return { exitCode, stdout, stderr };
}

// ─── Integration tests ────────────────────────────────────────────────────────

describe('secret-scanner --git-precommit integration', () => {
    // Each test owns its own tmp dir so repos are fully isolated.
    // Cleanup is in afterEach rather than inside each test so a failing assertion
    // doesn't skip cleanup (the tmp dir is still cleaned even on failure).
    let tmp;
    beforeEach(() => {
        tmp = createTmpDir({ prefix: 'scanner-precommit-' });
    });
    afterEach(() => {
        tmp.cleanup();
    });

    // ── AC 1: staged file with fake AWS key → exit != 0, stderr contains pattern name ──

    it.skipIf(!gitAvailable())(
        'stagedFileWithAwsKey_blocksCommit_exitsNonZeroWithPatternInStderr',
        () => {
            const repo = createGitRepo({ root: tmp.root });

            // Concatenate the key to avoid triggering the scanner on THIS file
            // AKIA + 16 uppercase alnum chars = valid AWS Access Key pattern
            const awsKey = 'AKIA' + 'IOSFODNN7EXAMPLE1234';
            fs.writeFileSync(
                path.join(repo.repoPath, 'secrets.js'),
                `const key = "${awsKey}";\n`
            );
            execFileSync('git', ['add', 'secrets.js'], { cwd: repo.repoPath, stdio: 'pipe' });

            const { exitCode, stderr } = runScanner(repo.repoPath);

            expect(exitCode).not.toBe(0);
            expect(stderr).toMatch(/AWS Access Key/);
        }
    );

    // ── AC 2: staged file with only clean content → exit 0 ──────────────────

    it.skipIf(!gitAvailable())(
        'stagedCleanFile_allowsCommit_exitsZero',
        () => {
            const repo = createGitRepo({ root: tmp.root });

            fs.writeFileSync(
                path.join(repo.repoPath, 'clean.js'),
                'const x = 1;\nconsole.log(x);\n'
            );
            execFileSync('git', ['add', 'clean.js'], { cwd: repo.repoPath, stdio: 'pipe' });

            const { exitCode } = runScanner(repo.repoPath);

            expect(exitCode).toBe(0);
        }
    );

    // ── AC 3: staged file in node_modules/ → skipped via shouldSkipPath → exit 0 ──

    it.skipIf(!gitAvailable())(
        'stagedNodeModulesFile_skipsViaShouldSkipPath_exitsZero',
        () => {
            const repo = createGitRepo({ root: tmp.root });

            // node_modules/ is usually .gitignored; force-stage with -f
            fs.mkdirSync(path.join(repo.repoPath, 'node_modules', 'pkg'), { recursive: true });
            const awsKey = 'AKIA' + 'IOSFODNN7EXAMPLE1234';
            fs.writeFileSync(
                path.join(repo.repoPath, 'node_modules', 'pkg', 'index.js'),
                `const k = "${awsKey}";\n`
            );
            execFileSync(
                'git', ['add', '-f', 'node_modules/pkg/index.js'],
                { cwd: repo.repoPath, stdio: 'pipe' }
            );

            // shouldSkipPath checks /node_modules\// — the file is skipped before
            // git show is called, so the secret is never examined. Exit must be 0.
            const { exitCode } = runScanner(repo.repoPath);

            expect(exitCode).toBe(0);
        }
    );

    // ── AC 4: binary file staged → handled gracefully → exit 0 ───────────────

    it.skipIf(!gitAvailable())(
        'stagedBinaryFile_handlesGracefully_exitsZero',
        () => {
            const repo = createGitRepo({ root: tmp.root });

            // Write a file containing PNG magic bytes.
            // The binary content does not contain any secret pattern, so whether the
            // scanner reads it as garbled UTF-8 or catches a decoding exception and
            // skips the file, the result is exit 0 with no findings.
            const pngBytes = Buffer.from([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                0x00, 0x00, 0x00, 0x0d,
            ]);
            fs.writeFileSync(path.join(repo.repoPath, 'image.png'), pngBytes);
            execFileSync('git', ['add', 'image.png'], { cwd: repo.repoPath, stdio: 'pipe' });

            const { exitCode } = runScanner(repo.repoPath);

            expect(exitCode).toBe(0);
        }
    );
});
