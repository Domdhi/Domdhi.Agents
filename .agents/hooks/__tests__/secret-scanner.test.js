import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const fs = require('node:fs');
const path = require('node:path');

// CJS bridge — loads the scanner after module.exports is added
const scanner = require('../../../.agents/hooks/secret-scanner.cjs');
const { processEvent, scanFile, isBinaryStagedFile, classifyUnreadableStagedFile } = scanner;

const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');
const { createGitRepo, gitAvailable } = require('../../core/__tests__/_helpers/git-fixture');

const syntheticPrivateKeyPath = ['', 'home', 'user', '.ssh', 'id_rsa'].join('/');

// ─── Fake secret builders (runtime concatenation avoids pre-commit hook) ──────

function fakeAwsKey() {
    return 'AKIA' + 'IOSFODNN7' + 'EXAMPLE123456';
}

// A syntactically valid AWS-shaped key that is NOT AWS's documented example
// (AKIAIOSFODNN7EXAMPLE, which fakeAwsKey() above happens to produce once the
// regex trims it to 16 chars) — used where a test needs a still-real-looking key.
function fakeAwsKeyNotPlaceholder() {
    return 'AKIA' + 'QW3ERTY7UIOP' + 'AS2D';
}

function fakeOpenAiKey() {
    return 'sk-' + 'abcdefghijklmnopqrstuvwxy' + 'z01234567890ABCDEFGHIJK';
}

function fakeGitHubPAT() {
    return 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789AB';
}

// ─── processEvent ─────────────────────────────────────────────────────────────

describe('processEvent', () => {
    it('processEvent_isExported', () => {
        expect(typeof processEvent).toBe('function');
    });

    describe('processEvent_writeEvent', () => {
        it('processEvent_writeWithSecret_returnsBlockResponse', () => {
            const event = {
                tool_name: 'Write',
                tool_input: {
                    file_path: '/project/config.js',
                    content: `const key = "${fakeAwsKey()}";`,
                },
            };
            const result = processEvent(event);
            expect(result).not.toBeNull();
            expect(result.block).toBe(true);
            expect(typeof result.feedback).toBe('string');
            expect(result.feedback).toContain('AWS Access Key');
            // Claude Code only BLOCKS a PreToolUse call on exit 2 — exit 1 is a
            // non-blocking error and the secret write would proceed. This once
            // shipped as exitCode 1 and the hook silently failed to block.
            expect(result.exitCode).toBe(2);
        });

        it('processEvent_writeWithCleanContent_returnsNull', () => {
            const event = {
                tool_name: 'Write',
                tool_input: {
                    file_path: '/project/hello.js',
                    content: 'console.log("hello world");\n',
                },
            };
            const result = processEvent(event);
            expect(result).toBeNull();
        });

        it('processEvent_writeWithNoContent_returnsNull', () => {
            const event = {
                tool_name: 'Write',
                tool_input: {
                    file_path: '/project/empty.js',
                    // no content or new_string
                },
            };
            const result = processEvent(event);
            expect(result).toBeNull();
        });
    });

    describe('processEvent_editEvent', () => {
        it('processEvent_editWithSecret_returnsBlockResponse', () => {
            const event = {
                tool_name: 'Edit',
                tool_input: {
                    file_path: '/project/settings.js',
                    new_string: `const token = "${fakeGitHubPAT()}";`,
                },
            };
            const result = processEvent(event);
            expect(result).not.toBeNull();
            expect(result.block).toBe(true);
            expect(result.feedback).toContain('GitHub Token');
        });

        it('processEvent_editWithCleanNewString_returnsNull', () => {
            const event = {
                tool_name: 'Edit',
                tool_input: {
                    file_path: '/project/settings.js',
                    new_string: 'const x = 42;',
                },
            };
            const result = processEvent(event);
            expect(result).toBeNull();
        });
    });

    // settings.json wires the scanner on MultiEdit and NotebookEdit too — those
    // payloads carry content in edits[].new_string / new_source, which the old
    // Write/Edit-only gate let through unscanned.
    describe('processEvent_multiEditAndNotebookEvents', () => {
        it('processEvent_multiEditWithSecretInEdits_returnsBlockResponse', () => {
            const event = {
                tool_name: 'MultiEdit',
                tool_input: {
                    file_path: '/project/config.js',
                    edits: [
                        { old_string: 'a', new_string: 'const x = 1;' },
                        { old_string: 'b', new_string: `const key = "${fakeAwsKey()}";` },
                    ],
                },
            };
            const result = processEvent(event);
            expect(result).not.toBeNull();
            expect(result.block).toBe(true);
            expect(result.exitCode).toBe(2);
        });

        it('processEvent_notebookEditWithSecretInNewSource_returnsBlockResponse', () => {
            const event = {
                tool_name: 'NotebookEdit',
                tool_input: {
                    notebook_path: '/project/analysis.ipynb',
                    new_source: `token = "${fakeGitHubPAT()}"`,
                },
            };
            const result = processEvent(event);
            expect(result).not.toBeNull();
            expect(result.block).toBe(true);
            expect(result.feedback).toContain('GitHub Token');
        });

        it('processEvent_multiEditCleanEdits_returnsNull', () => {
            const event = {
                tool_name: 'MultiEdit',
                tool_input: {
                    file_path: '/project/config.js',
                    edits: [{ old_string: 'a', new_string: 'const x = 1;' }],
                },
            };
            expect(processEvent(event)).toBeNull();
        });

        it('processEvent_multiEditSecretInSecondEdit_findingLabelsTheEdit', () => {
            // Line numbers must refer to the edit the secret was found in, not
            // a concatenated pseudo-document that misreports file positions.
            const event = {
                tool_name: 'MultiEdit',
                tool_input: {
                    file_path: '/project/config.js',
                    edits: [
                        { old_string: 'a', new_string: 'line one\nline two\nline three' },
                        { old_string: 'b', new_string: `const key = "${fakeAwsKey()}";` },
                    ],
                },
            };
            const result = processEvent(event);
            expect(result).not.toBeNull();
            expect(result.feedback).toContain('edit #2');
            // The secret sits on line 1 OF ITS EDIT — a concatenated scan
            // would have reported line 4+.
            expect(result.feedback).toContain(':1');
        });
    });

    describe('processEvent_highRiskFilename', () => {
        it('processEvent_whitespaceOnlyWriteToHighRiskFile_stillFlagsPath', () => {
            // The HIGH_RISK_FILE finding derives from the path alone. A
            // whitespace-only Write to id_rsa must still be flagged — an
            // `!content.trim()` early-return once skipped this check.
            const event = {
                tool_name: 'Write',
                tool_input: { file_path: syntheticPrivateKeyPath, content: ' \n' },
            };
            const result = processEvent(event);
            expect(result).not.toBeNull();
            expect(result.feedback).toContain('Sensitive file type');
        });

        it('processEvent_emptyContentWrite_returnsNull', () => {
            // Truly empty content has never been scanned — preserve that.
            const event = {
                tool_name: 'Write',
                tool_input: { file_path: syntheticPrivateKeyPath, content: '' },
            };
            expect(processEvent(event)).toBeNull();
        });
    });

    describe('processEvent_unrelatedEvent', () => {
        it('processEvent_bashEvent_returnsNull', () => {
            const event = {
                tool_name: 'Bash',
                tool_input: {
                    command: 'echo hello',
                },
            };
            const result = processEvent(event);
            expect(result).toBeNull();
        });

        it('processEvent_readEvent_returnsNull', () => {
            const event = {
                tool_name: 'Read',
                tool_input: {
                    file_path: '/project/config.js',
                },
            };
            const result = processEvent(event);
            expect(result).toBeNull();
        });
    });

    describe('processEvent_testFilePath_namedProvidersOnly', () => {
        it('processEvent_writeAwsKeyToTestFile_stillBlocks', () => {
            // Was previously wholesale-skipped via SKIP_PATHS/shouldSkipPath — a
            // real provider key pasted into a test file is still a leak.
            const event = {
                tool_name: 'Write',
                tool_input: {
                    file_path: '/project/src/auth.test.js',
                    content: `const key = "${fakeAwsKeyNotPlaceholder()}";`,
                },
            };
            const result = processEvent(event);
            expect(result).not.toBeNull();
            expect(result.block).toBe(true);
            expect(result.feedback).toContain('AWS Access Key');
        });

        it('processEvent_writeAwsDocumentedExampleKeyToTestFile_doesNotBlock', () => {
            // AWS's own published example access key (AKIAIOSFODNN7EXAMPLE) is
            // extremely common in SDK test fixtures/READMEs — it must not block
            // a commit when it shows up in a test file. fakeAwsKey() happens to
            // produce this exact literal once the regex trims it to 16 chars.
            const event = {
                tool_name: 'Write',
                tool_input: {
                    file_path: '/project/src/auth.test.js',
                    content: `const key = "${fakeAwsKey()}";`,
                },
            };
            const result = processEvent(event);
            expect(result).toBeNull();
        });

        it('processEvent_writeGitHubTokenToSpecFile_stillBlocks', () => {
            const event = {
                tool_name: 'Write',
                tool_input: {
                    file_path: '/project/src/auth.spec.ts',
                    content: `const token = "${fakeGitHubPAT()}";`,
                },
            };
            const result = processEvent(event);
            expect(result).not.toBeNull();
            expect(result.block).toBe(true);
            expect(result.feedback).toContain('GitHub Token');
        });

        it('processEvent_writeGenericPasswordFixtureToTestFile_doesNotBlock', () => {
            // A generic Password/Secret Assignment fixture in a test file must
            // still be suppressed (this is exactly the false-positive class
            // the wholesale skip existed to avoid).
            const event = {
                tool_name: 'Write',
                tool_input: {
                    file_path: '/project/src/__tests__/auth.js',
                    content: 'const password = "hunter2hunter2";',
                },
            };
            const result = processEvent(event);
            expect(result).toBeNull();
        });
    });

    describe('processEvent_skippedPath', () => {
        it('processEvent_writeToNodeModules_returnsNull', () => {
            const event = {
                tool_name: 'Write',
                tool_input: {
                    file_path: '/project/node_modules/lib/index.js',
                    content: `const key = "${fakeAwsKey()}";`,
                },
            };
            const result = processEvent(event);
            expect(result).toBeNull();
        });

        it('processEvent_writeToGitDirectory_returnsNull', () => {
            const event = {
                tool_name: 'Write',
                tool_input: {
                    file_path: '/project/.git/config',
                    content: `const key = "${fakeAwsKey()}";`,
                },
            };
            const result = processEvent(event);
            expect(result).toBeNull();
        });
    });
});

// ─── scanFile ─────────────────────────────────────────────────────────────────

describe('scanFile', () => {
    it('scanFile_isExported', () => {
        expect(typeof scanFile).toBe('function');
    });

    it('scanFile_missingFile_returnsErrorObject', () => {
        const result = scanFile('/nonexistent/path/that/does/not/exist.js');
        expect(result).toMatchObject({ error: 'File not found', findings: null, skipped: false });
    });

    it('scanFile_skippedPath_returnsSkippedTrue', () => {
        // node_modules path — shouldSkipPath returns true
        const result = scanFile('/any/node_modules/pkg/index.js');
        expect(result).toMatchObject({ findings: null, skipped: true });
    });

    it('scanFile_cleanFile_returnsFindingsEmpty', () => {
        const tmp = createTmpDir();
        const filePath = tmp.write('clean.js', 'const x = 1;\nconsole.log(x);\n');
        const result = scanFile(filePath);
        tmp.cleanup();
        expect(result.skipped).toBe(false);
        expect(result.findings).toEqual([]);
    });

    it('scanFile_fileWithSecret_returnsFindingsArray', () => {
        const tmp = createTmpDir();
        const content = `const key = "${fakeAwsKey()}";\n`;
        const filePath = tmp.write('secrets.js', content);
        const result = scanFile(filePath);
        tmp.cleanup();
        expect(result.skipped).toBe(false);
        expect(Array.isArray(result.findings)).toBe(true);
        expect(result.findings.length).toBeGreaterThan(0);
        const names = result.findings.map(f => f.name);
        expect(names).toContain('AWS Access Key');
    });

    it('scanFile_fileWithSecret_noProcessExit', () => {
        // scanFile must not call process.exit — it returns data instead
        // We verify by checking the return value (if process.exit were called,
        // the test process would die and this assertion would never run)
        const tmp = createTmpDir();
        const content = `const token = "${fakeOpenAiKey()}";\n`;
        const filePath = tmp.write('key.js', content);
        const result = scanFile(filePath);
        tmp.cleanup();
        expect(result).toBeDefined();
        expect(result.findings).not.toBeNull();
    });
});

// ─── Subprocess test: --git-precommit mode ────────────────────────────────────

describe('precommit', () => {
    it.skipIf(!gitAvailable())('precommit_stagedSecret_blocksCommit', () => {
        const tmp = createTmpDir();
        const repo = createGitRepo({ root: tmp.root });

        // Initial commit so HEAD exists
        repo.addCommit({ message: 'setup', files: [{ path: 'README.md', content: 'initial' }] });

        // Write a file with a fake AWS key and stage it
        const fakeKey = 'AKIA' + 'FAKETESTKEY1234567';   // 18 uppercase chars — regex matches first 16
        const fileContent = `export const key = "${fakeKey}";\n`;
        const leakedPath = path.join(repo.repoPath, 'leaked.js');
        fs.writeFileSync(leakedPath, fileContent);
        execFileSync('git', ['add', 'leaked.js'], { cwd: repo.repoPath, stdio: 'pipe' });

        // Run scanner subprocess in --git-precommit mode.
        // CLAUDE_PROJECT_DIR is threaded through the spawn env so the scanner's
        // getProjectRoot() resolves to THIS fixture repo, not the real repo root.
        // Without it the scanner would call `git diff --cached` in the real repo
        // (where nothing is staged with AWS keys) and return exit 0.
        const scannerPath = path.resolve(
            fileURLToPath(import.meta.url),
            '..', '..', 'secret-scanner.cjs'
        );
        let exitCode = 0;
        let stderr = '';
        try {
            execFileSync('node', [scannerPath, '--git-precommit'], {
                cwd: repo.repoPath,
                env: { ...process.env, CLAUDE_PROJECT_DIR: repo.repoPath },
                stdio: 'pipe',
            });
        } catch (err) {
            exitCode = err.status;
            stderr = err.stderr?.toString() || '';
        }

        tmp.cleanup();

        expect(exitCode).not.toBe(0);
        expect(stderr).toMatch(/AWS Access Key/);
    });

    it.skipIf(!gitAvailable())('precommit_renamedAndModifiedStaged_blocksCommit', () => {
        // F6 (260716 code review): a rename that ALSO modifies content lands at
        // git status R (rename), not M. --diff-filter=ACM silently excluded R,
        // so a secret introduced via `git mv old && edit` skipped the scan.
        const tmp = createTmpDir();
        const repo = createGitRepo({ root: tmp.root });

        repo.addCommit({
            message: 'setup',
            files: [{ path: 'old.js', content: 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n' }],
        });

        const fakeKey = 'AKIA' + 'FAKETESTKEY1234567';
        execFileSync('git', ['mv', 'old.js', 'new.js'], { cwd: repo.repoPath, stdio: 'pipe' });
        fs.appendFileSync(path.join(repo.repoPath, 'new.js'), `export const key = "${fakeKey}";\n`);
        execFileSync('git', ['add', 'new.js'], { cwd: repo.repoPath, stdio: 'pipe' });

        // Confirm the fixture actually produced a rename (status R), not a
        // plain modify — otherwise this test would pass for the wrong reason.
        const status = execFileSync('git', ['diff', '--cached', '--name-status'], { cwd: repo.repoPath, encoding: 'utf8' });
        expect(status).toMatch(/^R\d+\s/);

        const scannerPath = path.resolve(
            fileURLToPath(import.meta.url),
            '..', '..', 'secret-scanner.cjs'
        );
        let exitCode = 0;
        let stderr = '';
        try {
            execFileSync('node', [scannerPath, '--git-precommit'], {
                cwd: repo.repoPath,
                env: { ...process.env, CLAUDE_PROJECT_DIR: repo.repoPath },
                stdio: 'pipe',
            });
        } catch (err) {
            exitCode = err.status;
            stderr = err.stderr?.toString() || '';
        }

        tmp.cleanup();

        expect(exitCode).not.toBe(0);
        expect(stderr).toMatch(/AWS Access Key/);
    });

    it.skipIf(!gitAvailable())('precommit_cleanStaged_exits0', () => {
        const tmp = createTmpDir();
        const repo = createGitRepo({ root: tmp.root });

        repo.addCommit({ message: 'setup', files: [{ path: 'README.md', content: 'initial' }] });

        const cleanPath = path.join(repo.repoPath, 'clean.js');
        fs.writeFileSync(cleanPath, 'const x = 1;\n');
        execFileSync('git', ['add', 'clean.js'], { cwd: repo.repoPath, stdio: 'pipe' });

        const scannerPath = path.resolve(
            fileURLToPath(import.meta.url),
            '..', '..', 'secret-scanner.cjs'
        );
        let exitCode = 0;
        try {
            execFileSync('node', [scannerPath, '--git-precommit'], {
                cwd: repo.repoPath,
                env: { ...process.env, CLAUDE_PROJECT_DIR: repo.repoPath },
                stdio: 'pipe',
            });
        } catch (err) {
            exitCode = err.status;
        }

        tmp.cleanup();
        expect(exitCode).toBe(0);
    });
});

// ─── isBinaryStagedFile / classifyUnreadableStagedFile ────────────────────────
// The pre-commit `git show` read can fail for reasons other than "the file is
// binary" (maxBuffer exceeded, a transient git error). classifyUnreadableStagedFile
// is the pure decision that used to be inlined as a blanket warn-and-continue —
// it must now fail closed unless the file is DETECTABLY binary.

describe('isBinaryStagedFile', () => {
    it.skipIf(!gitAvailable())('isBinaryStagedFile_textFile_returnsFalse', () => {
        const tmp = createTmpDir();
        const repo = createGitRepo({ root: tmp.root });
        repo.addCommit({ message: 'setup', files: [{ path: 'README.md', content: 'initial' }] });

        fs.writeFileSync(path.join(repo.repoPath, 'plain.txt'), 'hello world\n');
        execFileSync('git', ['add', 'plain.txt'], { cwd: repo.repoPath, stdio: 'pipe' });

        const result = isBinaryStagedFile('plain.txt', repo.repoPath);
        tmp.cleanup();
        expect(result).toBe(false);
    });

    it.skipIf(!gitAvailable())('isBinaryStagedFile_binaryFile_returnsTrue', () => {
        const tmp = createTmpDir();
        const repo = createGitRepo({ root: tmp.root });
        repo.addCommit({ message: 'setup', files: [{ path: 'README.md', content: 'initial' }] });

        // NUL bytes trip git's own binary heuristic (same one `git diff` uses).
        fs.writeFileSync(
            path.join(repo.repoPath, 'blob.bin'),
            Buffer.from([0x00, 0x01, 0x02, 0x89, 0x50, 0x4e, 0x47, 0x00])
        );
        execFileSync('git', ['add', 'blob.bin'], { cwd: repo.repoPath, stdio: 'pipe' });

        const result = isBinaryStagedFile('blob.bin', repo.repoPath);
        tmp.cleanup();
        expect(result).toBe(true);
    });
});

describe('classifyUnreadableStagedFile', () => {
    it.skipIf(!gitAvailable())('classifyUnreadableStagedFile_binaryFile_skipsNotFail', () => {
        const tmp = createTmpDir();
        const repo = createGitRepo({ root: tmp.root });
        repo.addCommit({ message: 'setup', files: [{ path: 'README.md', content: 'initial' }] });
        fs.writeFileSync(
            path.join(repo.repoPath, 'blob.bin'),
            Buffer.from([0x00, 0x01, 0x02, 0x89, 0x50, 0x4e, 0x47, 0x00])
        );
        execFileSync('git', ['add', 'blob.bin'], { cwd: repo.repoPath, stdio: 'pipe' });

        const simulatedErr = new Error('simulated git show failure');
        const decision = classifyUnreadableStagedFile('blob.bin', simulatedErr, repo.repoPath);
        tmp.cleanup();

        expect(decision.action).toBe('skip');
    });

    it.skipIf(!gitAvailable())('classifyUnreadableStagedFile_nonBinaryFile_failsClosed', () => {
        // A NON-binary staged file that `git show` failed to read (simulated
        // here — e.g. a maxBuffer overrun or transient git error in reality)
        // must fail the commit closed rather than warn-and-continue.
        const tmp = createTmpDir();
        const repo = createGitRepo({ root: tmp.root });
        repo.addCommit({ message: 'setup', files: [{ path: 'README.md', content: 'initial' }] });
        fs.writeFileSync(path.join(repo.repoPath, 'plain.txt'), 'a secret might hide here\n');
        execFileSync('git', ['add', 'plain.txt'], { cwd: repo.repoPath, stdio: 'pipe' });

        const simulatedErr = new Error('simulated git show failure');
        const decision = classifyUnreadableStagedFile('plain.txt', simulatedErr, repo.repoPath);
        tmp.cleanup();

        expect(decision.action).toBe('fail');
        expect(decision.message).toMatch(/FAIL-CLOSED/);
        expect(decision.message).toContain('plain.txt');
    });
});

// ─── recordScannerBlock (S-PI.5 producer — scanner-block telemetry) ───────────
describe('recordScannerBlock', () => {
    const { recordScannerBlock } = scanner;

    function readGuardrailEvents(root) {
        const p = path.join(root, 'docs', '.output', '.state', 'telemetry', 'guardrail-events.jsonl');
        if (!fs.existsSync(p)) return [];
        return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    }

    it('emits a source-tagged guardrail block event the feedback digest counts', () => {
        const tmp = createTmpDir();
        const saved = process.env.CLAUDE_PROJECT_DIR;
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        try {
            recordScannerBlock();

            const events = readGuardrailEvents(tmp.root);
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
                event: 'guardrail',
                decision: 'block',
                rule: 'secret-scanner',
                source: 'secret-scanner',
            });

            // End-to-end: feedback-digest's readScannerBlocks must now read non-zero.
            const { readScannerBlocks } = require('../../../.agents/core/feedback-digest.js');
            expect(readScannerBlocks(tmp.root)).toBe(1);
        } finally {
            if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
            else process.env.CLAUDE_PROJECT_DIR = saved;
            tmp.cleanup();
        }
    });

    it('never throws (telemetry is best-effort, must not break the scanner exit code)', () => {
        expect(() => recordScannerBlock()).not.toThrow();
    });
});

// ─── Hook mode, end-to-end (spawned process) ─────────────────────────────────
// The REAL PreToolUse surface: JSON event on stdin → exit code + stderr.
// This layer is where the exit-1 bug lived for months while every unit test
// stayed green — Claude Code only blocks a PreToolUse call on exit 2, so the
// spawn-level exit code IS the security contract. Do not remove these.

describe('runClaudeHook (spawned process)', () => {
    const scannerPath = path.resolve(
        fileURLToPath(import.meta.url),
        '..', '..', 'secret-scanner.cjs'
    );

    function runHook(event, envRoot) {
        try {
            const stdout = execFileSync('node', [scannerPath], {
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

    it('hookMode_secretWriteEventOnStdin_exits2WithBannerOnStderr', () => {
        const tmp = createTmpDir('scanner-hook-mode');
        try {
            const result = runHook({
                tool_name: 'Write',
                tool_input: {
                    file_path: '/project/config.js',
                    content: `const key = "${fakeAwsKey()}";`,
                },
            }, tmp.root);
            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain('AWS Access Key');
        } finally {
            tmp.cleanup();
        }
    });

    it('hookMode_cleanWriteEventOnStdin_exits0', () => {
        const tmp = createTmpDir('scanner-hook-mode');
        try {
            const result = runHook({
                tool_name: 'Write',
                tool_input: {
                    file_path: '/project/hello.js',
                    content: 'console.log("hello");\n',
                },
            }, tmp.root);
            expect(result.exitCode).toBe(0);
        } finally {
            tmp.cleanup();
        }
    });

    // Non-string `content` (e.g. a numeric payload) once threw
    // `content.split is not a function`, which — uncaught — exited 1. Exit 1 is a
    // NON-blocking error in Claude Code, so the write proceeded UNSCANNED. The
    // fix coerces non-string content AND fail-closes on any scan error. The
    // contract: NEVER exit 1 here. A high-risk target still blocks (exit 2); a
    // benign target scans clean (exit 0). Either is acceptable — a fall-through
    // exit 1 is not.
    it('hookMode_nonStringContentToHighRiskFile_failsClosedExit2NotExit1', () => {
        const tmp = createTmpDir('scanner-hook-mode');
        try {
            const result = runHook({
                tool_name: 'Write',
                tool_input: { file_path: '/x/.env', content: 12345 },
            }, tmp.root);
            expect(result.exitCode).not.toBe(1); // never the fail-OPEN code
            expect(result.exitCode).toBe(2);     // .env is high-risk → block
            expect(result.stderr).toContain('Sensitive file type');
        } finally {
            tmp.cleanup();
        }
    });

    it('hookMode_nonStringContentToBenignFile_scansCleanNotExit1', () => {
        const tmp = createTmpDir('scanner-hook-mode');
        try {
            const result = runHook({
                tool_name: 'Write',
                tool_input: { file_path: '/x/hello.js', content: 12345 },
            }, tmp.root);
            expect(result.exitCode).not.toBe(1); // never the fail-OPEN code
            expect(result.exitCode).toBe(0);     // coerced + clean → allow
        } finally {
            tmp.cleanup();
        }
    });

    // Wave 5 F1: a stdin read that never completes (wedged pipe) or completes
    // with garbled/truncated content must FAIL CLOSED (block), never silently
    // pass through as "nothing to scan" — unlike every other blocking hook,
    // this one is a security gate.
    it('hookMode_malformedJsonOnStdin_failsClosedExit2NotExit0', () => {
        const tmp = createTmpDir('scanner-hook-mode');
        try {
            const result = execFileSyncWithInput('not valid json {{{', tmp.root);
            expect(result.exitCode).not.toBe(0); // never silently "nothing to scan"
            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain('FAIL-CLOSED');
        } finally {
            tmp.cleanup();
        }
    });

    it('hookMode_stdinNeverCloses_timesOutAndFailsClosedExit2', async () => {
        // spawnSync's `input` option writes then immediately closes stdin —
        // that can't simulate a genuinely wedged pipe. Use async spawn and
        // deliberately never end() the child's stdin, so the only way the
        // process exits is via readStdin's own timeout firing.
        const { spawn } = require('node:child_process');
        const tmp = createTmpDir('scanner-hook-mode');
        try {
            const child = spawn('node', [scannerPath], {
                env: {
                    ...process.env,
                    CLAUDE_PROJECT_DIR: tmp.root,
                    SECRET_SCANNER_STDIN_TIMEOUT_MS: '150',
                },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            child.stdin.write('{"tool_name":"Write","tool_input":'); // truncated; stdin intentionally left open

            let stderr = '';
            child.stderr.on('data', (chunk) => { stderr += chunk; });

            const exitCode = await new Promise((resolve) => {
                child.on('exit', (code) => resolve(code));
            });

            expect(exitCode).toBe(2);
            expect(stderr).toContain('FAIL-CLOSED');
        } finally {
            tmp.cleanup();
        }
    });

    function execFileSyncWithInput(input, envRoot) {
        try {
            const stdout = execFileSync('node', [scannerPath], {
                input,
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
});
