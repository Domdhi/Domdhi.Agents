/**
 * Integration tests — gate.js stack detection (TDD-6.2)
 *
 * Each test creates a real tmp-dir fixture, invokes gate.js as a real subprocess
 * with CLAUDE_PROJECT_DIR pointed at the fixture, and asserts the correct stack
 * detection line appears in stdout.
 *
 * Non-node stacks (rust, go, dotnet, make) will fail the build command because
 * the tools are not installed in the fixture environment.  Only the stdout
 * detection line is asserted for those stacks — exit code is intentionally
 * ignored.
 *
 * The node fixture uses `node -e "..."` scripts so the build succeeds.  The
 * `--test` mode verification (AC bullet 4) also uses the node fixture so that
 * the test command also succeeds and gate writes `_latest-test.json`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('../_helpers/tmp-dir');

// Resolve gate.js once at module load — works correctly on Windows + Unix.
const __filename = fileURLToPath(import.meta.url);
const GATE_PATH = path.resolve(path.dirname(__filename), '..', '..', 'gate.js');

// ── Subprocess helper ────────────────────────────────────────────────────────

/**
 * Run gate.js against a tmp-dir project root.
 *
 * @param {string} tmpRoot  Absolute path — passed as CLAUDE_PROJECT_DIR
 * @param {string|null} flag  Optional CLI flag (e.g. '--test')
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
function runGate(tmpRoot, flag = null) {
    const args = [GATE_PATH];
    if (flag) args.push(flag);

    let exitCode = 0;
    let stdout = '';
    let stderr = '';

    try {
        stdout = execFileSync('node', args, {
            encoding: 'utf8',
            env: { ...process.env, CLAUDE_PROJECT_DIR: tmpRoot },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (err) {
        exitCode = err.status ?? 1;
        stdout = err.stdout?.toString() ?? '';
        stderr = err.stderr?.toString() ?? '';
    }

    return { exitCode, stdout, stderr };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('gate.js stack detection integration', () => {
    let tmp;

    beforeEach(() => {
        tmp = createTmpDir({ prefix: 'gate-int-' });
    });

    afterEach(() => {
        tmp.cleanup();
    });

    // ── node ─────────────────────────────────────────────────────────────────

    it('node_packageJson_detectsStackAndExitsZero', () => {
        // Build and test commands use plain `node -e` so no npm install is needed
        // and both succeed in any environment.
        tmp.write('package.json', JSON.stringify({
            name: 'fixture-node',
            version: '1.0.0',
            scripts: {
                build: 'node -e "console.log(\'build ok\')"',
                test: 'node -e "console.log(\'test ok\')"',
            },
        }));

        const { exitCode, stdout } = runGate(tmp.root);

        expect(stdout).toContain('Detected stack: node');
        expect(exitCode).toBe(0);
    });

    // ── rust ─────────────────────────────────────────────────────────────────

    it('rust_cargoToml_detectsStack', () => {
        // Cargo.toml triggers detection.  `cargo build` will fail because cargo
        // is not part of the test fixture — only stack detection is asserted.
        tmp.write('Cargo.toml', '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n');

        const { stdout } = runGate(tmp.root);

        expect(stdout).toContain('Detected stack: rust');
    });

    // ── go ───────────────────────────────────────────────────────────────────

    it('go_goMod_detectsStack', () => {
        // go.mod triggers detection.  `go build ./...` will fail if go is not
        // installed — only stack detection is asserted.
        tmp.write('go.mod', 'module example.com/test\n\ngo 1.21\n');

        const { stdout } = runGate(tmp.root);

        expect(stdout).toContain('Detected stack: go');
    });

    // ── dotnet ───────────────────────────────────────────────────────────────

    it('dotnet_projectSln_detectsStack', () => {
        // A *.sln file triggers detection.  `dotnet build` will fail if the SDK
        // is not installed — only stack detection is asserted.
        tmp.write('project.sln', 'Microsoft Visual Studio Solution File, Format Version 12.00\n');

        const { stdout } = runGate(tmp.root);

        expect(stdout).toContain('Detected stack: dotnet');
    });

    // ── make ─────────────────────────────────────────────────────────────────

    it('make_Makefile_detectsStack', () => {
        // Makefile triggers detection.  `make build` may fail on Windows if make
        // is not installed — only stack detection is asserted.
        // Tab-indented recipes are required by make syntax.
        tmp.write('Makefile', 'build:\n\t@echo build ok\ntest:\n\t@echo test ok\n');

        const { stdout } = runGate(tmp.root);

        expect(stdout).toContain('Detected stack: make');
    });

    // ── unknown ──────────────────────────────────────────────────────────────

    it('unknown_noDetectionFile_echoFallbackExitsZero', () => {
        // Empty project root — no detection files.  Gate falls back to echo
        // commands which succeed, so exit code must be 0.
        // (No files are written — tmp.root already exists and is empty.)

        const { exitCode, stdout } = runGate(tmp.root);

        expect(stdout).toContain('Detected stack: unknown');
        expect(exitCode).toBe(0);
    });

    // ── --test mode with node fixture (AC bullet 4) ───────────────────────────

    it('node_testMode_writesLatestTestJson', () => {
        // Use the same node fixture as the build-only test.  With --test, gate
        // runs the test command after build and writes _latest-test.json.
        tmp.write('package.json', JSON.stringify({
            name: 'fixture-node',
            version: '1.0.0',
            scripts: {
                build: 'node -e "console.log(\'build ok\')"',
                // Emit a parseable summary — a bare "test ok" collects 0 tests,
                // which the C11/F1 teeth now (correctly) fail as a false-green.
                test: 'node -e "console.log(\'Tests: 1 passed, 1 total\')"',
            },
        }));

        const { exitCode, stdout } = runGate(tmp.root, '--test');

        expect(stdout).toContain('Detected stack: node');
        expect(exitCode).toBe(0);

        // gate.js writes _latest-test.json when the test command runs
        const testJsonPath = path.join(
            tmp.root,
            'docs', '.output', '.state', 'telemetry', '_latest-test.json'
        );
        expect(fs.existsSync(testJsonPath)).toBe(true);

        const testJson = JSON.parse(fs.readFileSync(testJsonPath, 'utf8'));
        // command should be `npm test` (scripts.test is present)
        expect(testJson.command).toBe('npm test');
        // parseTestOutput always writes these properties
        expect(testJson).toHaveProperty('passed');
        expect(testJson).toHaveProperty('failed');
    });
});
