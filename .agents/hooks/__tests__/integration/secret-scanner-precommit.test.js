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
const { createFakeEngineKit } = require('../_helpers/fake-engine');
const { SIGNATURES } = require('../_helpers/engine-signatures');

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
function runScanner(repoPath, env = {}) {
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    try {
        stdout = execFileSync('node', [SCANNER_PATH, '--git-precommit'], {
            cwd: repoPath,
            env: { ...process.env, CLAUDE_PROJECT_DIR: repoPath, ...env },
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

    it.skipIf(!gitAvailable())('formDataRead_allowsCommit_butLiteralFallbackBlocks', () => {
        const repo = createGitRepo({ root: tmp.root });
        const target = path.join(repo.repoPath, 'account.tsx');
        const read = 'const currentPassword = (formData.get("currentPassword") as string | null) ?? "";';
        fs.writeFileSync(target, read);
        execFileSync('git', ['add', 'account.tsx'], { cwd: repo.repoPath, stdio: 'pipe' });
        expect(runScanner(repo.repoPath).exitCode).toBe(0);
        fs.writeFileSync(target, read.replace('?? ""', '?? "Winter2024Pass"'));
        execFileSync('git', ['add', 'account.tsx'], { cwd: repo.repoPath, stdio: 'pipe' });
        expect(runScanner(repo.repoPath).exitCode).not.toBe(0);
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

    // ── the engine is part of the gate: if it cannot scan, the commit cannot pass ──

    it.skipIf(!gitAvailable())(
        'engineMissing_blocksTheCommit_withAnInstallHint',
        () => {
            const repo = createGitRepo({ root: tmp.root });
            fs.writeFileSync(path.join(repo.repoPath, 'app.js'), 'const x = 1;\n');
            execFileSync('git', ['add', 'app.js'], { cwd: repo.repoPath, stdio: 'pipe' });

            const { exitCode, stderr } = runScanner(repo.repoPath, { AGENTS_SECRET_ENGINE_BIN: path.join(tmp.root, 'no-such-engine') });

            expect(exitCode).toBe(1);
            expect(stderr).toMatch(/FAIL-CLOSED/);
            expect(stderr).toMatch(/secret-engine-install/);
            expect(stderr).toMatch(/staged files were not scanned/);
        }
    );

    it.skipIf(!gitAvailable())(
        'engineFailing_blocksTheCommit',
        () => {
            const repo = createGitRepo({ root: tmp.root });
            fs.writeFileSync(path.join(repo.repoPath, 'app.js'), 'const x = 1;\n');
            execFileSync('git', ['add', 'app.js'], { cwd: repo.repoPath, stdio: 'pipe' });
            const kit = createFakeEngineKit(path.join(tmp.root, 'kit'));
            const bad = kit.exe(path.join(tmp.root, 'bad-engine' + (process.platform === 'win32' ? '.exe' : '')));

            const { exitCode, stderr } = runScanner(repo.repoPath, { AGENTS_SECRET_ENGINE_BIN: bad, ...kit.childEnv("process.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(9));") });

            expect(exitCode).toBe(1);
            expect(stderr).toMatch(/exited with status 9/);
        }
    );

    it.skipIf(!gitAvailable())(
        'blockedCommit_onAGenericMatch_leavesTheMarkerToTheUser_notTheInertNoVerifyFlag',
        () => {
            const repo = createGitRepo({ root: tmp.root });
            fs.writeFileSync(path.join(repo.repoPath, 'app.js'), `const password = "${['Zx9Qm4', 'Lp2Rt7'].join('')}";\n`);
            execFileSync('git', ['add', 'app.js'], { cwd: repo.repoPath, stdio: 'pipe' });

            const { exitCode, stderr } = runScanner(repo.repoPath);

            expect(exitCode).toBe(1);
            expect(stderr).toMatch(/the\s+user \(not the agent\) may add/);
            expect(stderr).toMatch(/betterleaks:allow/);
            expect(stderr).toMatch(/path:rule:line/);
            expect(stderr).not.toMatch(/--no-verify/);
        }
    );

    it.skipIf(!gitAvailable())(
        'blockedCommit_onANamedProviderKey_neverSuggestsTheMarker',
        () => {
            const repo = createGitRepo({ root: tmp.root });
            fs.writeFileSync(path.join(repo.repoPath, 'pay.js'), `const k = "${['sk_', 'live_', 'aB3xK9mP2qR7tY1wZ5nC8vD4'].join('')}";\n`);
            execFileSync('git', ['add', 'pay.js'], { cwd: repo.repoPath, stdio: 'pipe' });

            const { exitCode, stderr } = runScanner(repo.repoPath);

            expect(exitCode).toBe(1);
            expect(stderr).toMatch(/Stripe Key/);
            expect(stderr).not.toMatch(/betterleaks:allow/);
            expect(stderr).not.toMatch(/--no-verify/);
            expect(stderr).toMatch(/Do not mark a real key as allowed/);
        }
    );

    // A file that starts with an archive signature used to be skipped by the engine and committed unscanned.
    it.skipIf(!gitAvailable()).each(SIGNATURES)(
        'stagedFileBehind_%s_signature_stillBlocksTheCommit',
        (_label, prefix) => {
            const repo = createGitRepo({ root: tmp.root });
            fs.writeFileSync(path.join(repo.repoPath, 'notes.md'), `${prefix}\nKEY=${['AKIA', 'QW3ERTY7UIOPAS2D'].join('')}\n`);
            execFileSync('git', ['add', 'notes.md'], { cwd: repo.repoPath, stdio: 'pipe' });

            const { exitCode, stderr } = runScanner(repo.repoPath);

            expect(exitCode).toBe(1);
            expect(stderr).toMatch(/AWS Access Key/);
        }
    );

    it.skipIf(!gitAvailable())(
        'allowMarkerOnTheSameLine_letsAReviewedFalsePositivePass',
        () => {
            const repo = createGitRepo({ root: tmp.root });
            fs.writeFileSync(path.join(repo.repoPath, 'pay.js'), `const k = "${['sk_', 'live_', 'aB3xK9mP2qR7tY1wZ5nC8vD4'].join('')}"; // betterleaks:allow\n`);
            execFileSync('git', ['add', 'pay.js'], { cwd: repo.repoPath, stdio: 'pipe' });

            expect(runScanner(repo.repoPath).exitCode).toBe(0);
        }
    );

    // A fake engine that reports the right byte count and no findings must not get a staged key through, whatever
    // the environment says. (NODE_ENV=test or VITEST used to skip the identity check.)
    it.skipIf(!gitAvailable()).each([
        ['NODE_ENV=test', { NODE_ENV: 'test' }],
        ['VITEST=1', { VITEST: '1' }],
        ['every test switch at once', { NODE_ENV: 'test', VITEST: '1', CI: 'true', SECRET_ENGINE_VERIFY_IN_TESTS: '0', SECRET_ENGINE_SKIP_VERIFY: '1', SECRET_ENGINE_TIMEOUT_MS: '1' }],
    ])(
        'impostorEngine_with_%s_stillBlocksTheCommit',
        (_label, hostile) => {
            const repo = createGitRepo({ root: tmp.root });
            fs.writeFileSync(path.join(repo.repoPath, 'pay.js'), `const k = "${['AKIA', 'QW3ERTY7UIOPAS2D'].join('')}";\n`);
            execFileSync('git', ['add', 'pay.js'], { cwd: repo.repoPath, stdio: 'pipe' });
            const kit = createFakeEngineKit(path.join(tmp.root, 'kit'));
            const impostor = "const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{const n=Buffer.concat(c).length;process.stderr.write('INF scanned ~'+n+' bytes ('+n+' B) in 1ms\\n');console.log('[]');});";
            const env = { ...hostile, AGENTS_SECRET_ENGINE_BIN: kit.exe(), ...kit.childEnvWithoutPins(impostor) };

            const { exitCode, stderr } = runScanner(repo.repoPath, env);

            expect(exitCode).toBe(1);
            expect(stderr).toMatch(/not the pinned build/);
            expect(stderr).toMatch(/staged files were not scanned/);
        }
    );

    it.skipIf(!gitAvailable())(
        'theSameImpostor_withTheFakesOwnPinsLoaded_isAccepted_provingTheTestSeamAndNotTheEnvironmentDecides',
        () => {
            const repo = createGitRepo({ root: tmp.root });
            fs.writeFileSync(path.join(repo.repoPath, 'pay.js'), `const k = "${['AKIA', 'QW3ERTY7UIOPAS2D'].join('')}";\n`);
            execFileSync('git', ['add', 'pay.js'], { cwd: repo.repoPath, stdio: 'pipe' });
            const kit = createFakeEngineKit(path.join(tmp.root, 'kit'));
            const impostor = "const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{const n=Buffer.concat(c).length;process.stderr.write('INF scanned ~'+n+' bytes ('+n+' B) in 1ms\\n');console.log('[]');});";

            const { exitCode } = runScanner(repo.repoPath, { AGENTS_SECRET_ENGINE_BIN: kit.exe(), ...kit.childEnv(impostor) });

            expect(exitCode).toBe(0);   // the fake says "no findings" and its hash is pinned in that process only
        }
    );
});
