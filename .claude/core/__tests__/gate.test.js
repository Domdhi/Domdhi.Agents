// AC→source map (TDD-3.5 / gate):
//   - parseBuildOutput: TS/C# style, ESLint/generic, Rust prefix, mixed, empty
//   - parseTestOutput: Vitest v1 (colon), Vitest v2 (no colon, parens), dotnet, Rust, individual failures
//   - loadConfig: auto-detects package.json / Cargo.toml / go.mod / .sln / Makefile; explicit override
//   - acquireLock / releaseLock: double-acquire fails, release re-enables, stale lock (>10 min) breaks
//   - MODULE: gate.js exports { loadConfig, parseBuildOutput, parseTestOutput, acquireLock, releaseLock }
//
// Isolation strategy for env-dependent tests (loadConfig, acquireLock, releaseLock):
//   PROJECT_ROOT is frozen at module load time (Node CJS statics).
//   vi.resetModules() does not help here because we use createRequire (Node's native CJS cache),
//   not Vitest's ESM module registry.
//   Solution: delete the gate.js entry from require.cache before each re-require so that
//   Node re-executes the module with the current CLAUDE_PROJECT_DIR value.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');

// Absolute path to gate.js — used to bust require.cache
const GATE_PATH = require.resolve('../gate');

// Top-level require for pure functions — no env dependency, no need for cache busting
const { parseBuildOutput, parseTestOutput, isZeroCollected } = require('../gate');

// ─── parseBuildOutput ─────────────────────────────────────────────────────────

describe('gate', () => {
  describe('parseBuildOutput', () => {
    it('parseBuildOutput_empty_succeedsWithNoErrors', () => {
      // Arrange
      const output = '';
      const exitCode = 0;

      // Act
      const result = parseBuildOutput(output, exitCode);

      // Assert
      expect(result.succeeded).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('parseBuildOutput_exitCodeNonZero_succeededFalse', () => {
      // Arrange
      const output = '';
      const exitCode = 1;

      // Act
      const result = parseBuildOutput(output, exitCode);

      // Assert
      expect(result.succeeded).toBe(false);
    });

    it('parseBuildOutput_typescriptStyle_extractsError', () => {
      // Arrange — TS/C# style: file(line,col): error CODE: message
      const output = 'src/index.ts(10,5): error TS2345: Argument of type string not assignable';
      const exitCode = 1;

      // Act
      const result = parseBuildOutput(output, exitCode);

      // Assert
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].file).toBe('src/index.ts');
      expect(result.errors[0].line).toBe(10);
      expect(result.errors[0].column).toBe(5);
      expect(result.errors[0].code).toBe('TS2345');
    });

    it('parseBuildOutput_csharpStyle_extractsError', () => {
      // Arrange — C# style is same TS pattern: file(line,col): error CSxxxx: message
      const output = 'MyProject/Program.cs(42,12): error CS0246: Type or namespace not found';
      const exitCode = 1;

      // Act
      const result = parseBuildOutput(output, exitCode);

      // Assert
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].line).toBe(42);
      expect(result.errors[0].column).toBe(12);
    });

    it('parseBuildOutput_eslintStyle_extractsError', () => {
      // Arrange — ESLint/generic style: file:line:col: error message
      const output = '/home/user/project/src/app.ts:10:5: error Unexpected token';
      const exitCode = 1;

      // Act
      const result = parseBuildOutput(output, exitCode);

      // Assert
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].line).toBe(10);
      expect(result.errors[0].column).toBe(5);
    });

    it('parseBuildOutput_eslintStylish_attributesIndentedFindingToFileLine', () => {
      // Arrange — ESLint default "stylish" formatter: path on its own line, then
      // indented `line:col  error  message  rule` findings under it.
      const output = [
        '/home/user/project/src/app.ts',
        '  10:5   error    Unexpected console statement  no-console',
        '  12:1   warning  Missing return type            @typescript-eslint/explicit-function-return-type',
      ].join('\n');
      const exitCode = 1;

      // Act
      const result = parseBuildOutput(output, exitCode);

      // Assert — the error attributes to the pending file line; the warning is bucketed separately
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].file).toBe('/home/user/project/src/app.ts');
      expect(result.errors[0].line).toBe(10);
      expect(result.errors[0].column).toBe(5);
      expect(result.errors[0].code).toBe('no-console');
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].line).toBe(12);
    });

    it('parseBuildOutput_tscBuild_notMisreadAsStylish', () => {
      // Regression guard — the stylish branch must NOT create phantom findings on
      // ordinary tsc build output (unindented `file(line,col): error` lines).
      const output = [
        'src/main.ts(5,3): error TS1005: ";" expected',
      ].join('\n');
      const exitCode = 1;

      // Act
      const result = parseBuildOutput(output, exitCode);

      // Assert — exactly one error, from the tsc pattern, not double-counted by stylish
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].line).toBe(5);
      expect(result.errors[0].code).toBe('TS1005');
    });

    it('parseBuildOutput_rustPrefix_extractsError', () => {
      // Arrange — Rust/generic prefix: error[E0308]: message
      const output = 'error[E0308]: mismatched types';
      const exitCode = 1;

      // Act
      const result = parseBuildOutput(output, exitCode);

      // Assert
      expect(result.errors).toHaveLength(1);
    });

    it('parseBuildOutput_rustPrefixNoCode_extractsError', () => {
      // Arrange — bare error prefix without brackets
      const output = 'error: cannot find value `x` in this scope';
      const exitCode = 1;

      // Act
      const result = parseBuildOutput(output, exitCode);

      // Assert
      expect(result.errors).toHaveLength(1);
    });

    it('parseBuildOutput_mixedWarningsAndErrors_extractsBoth', () => {
      // Arrange
      const output = [
        'src/main.ts(5,3): error TS1005: ";" expected',
        'src/util.ts(12,8): warning TS6133: "x" is declared but never used',
      ].join('\n');
      const exitCode = 1;

      // Act
      const result = parseBuildOutput(output, exitCode);

      // Assert
      expect(result.errors).toHaveLength(1);
      expect(result.warnings).toHaveLength(1);
    });

    it('parseBuildOutput_typescriptWarning_extractsWarning', () => {
      // Arrange
      const output = 'src/helper.ts(3,1): warning TS6133: "foo" is declared but never read';
      const exitCode = 0;

      // Act
      const result = parseBuildOutput(output, exitCode);

      // Assert
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].file).toBe('src/helper.ts');
      expect(result.succeeded).toBe(true);
    });

    it('parseBuildOutput_C2_ruffFormat_capturesReformatReason', () => {
      // C2: `ruff format --check` failure has no file:line:error shape — a real
      // failure must still yield an actionable error, not "0 errors".
      const output = '10 files would be reformatted, 1 file already formatted';
      const exitCode = 1;

      const result = parseBuildOutput(output, exitCode);

      expect(result.succeeded).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toMatch(/would be reformatted/i);
    });

    it('parseBuildOutput_C2_commandNotFound_capturesReason', () => {
      // C2: a missing tool (e.g. mypy) must surface the reason, not 0 errors.
      const output = '/bin/sh: 1: mypy: not found';
      const exitCode = 127;

      const result = parseBuildOutput(output, exitCode);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toMatch(/not found/i);
    });

    it('parseBuildOutput_C2_nonZeroEmptyOutput_synthesizesExitReason', () => {
      // C2: even with no output, a non-zero exit must not report 0 errors.
      const result = parseBuildOutput('', 2);

      expect(result.succeeded).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toMatch(/exited 2/);
    });

    it('parseBuildOutput_C2_recognizedError_noSyntheticDouble', () => {
      // When the parser already found a real error, do NOT add a synthetic one.
      const output = 'src/file.py:42: error: Cannot assign';
      const result = parseBuildOutput(output, 1);

      expect(result.errors).toHaveLength(1);
    });
  });

  // ─── parseTestOutput ───────────────────────────────────────────────────────

  describe('parseTestOutput', () => {
    it('parseTestOutput_vitestV1_allPassing', () => {
      // Arrange — Vitest/Jest v1 format with colon and "total"
      const output = 'Tests: 5 passed, 8 total';
      const exitCode = 0;

      // Act
      const result = parseTestOutput(output, exitCode);

      // Assert
      expect(result.passed).toBe(5);
      expect(result.failed).toBe(0);
      expect(result.total).toBe(8);
      expect(result.succeeded).toBe(true);
    });

    it('parseTestOutput_vitestV1_withFailures', () => {
      // Arrange
      const output = 'Tests: 5 passed, 1 failed, 2 skipped, 8 total';
      const exitCode = 1;

      // Act
      const result = parseTestOutput(output, exitCode);

      // Assert
      expect(result.passed).toBe(5);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(2);
      expect(result.total).toBe(8);
      expect(result.succeeded).toBe(false);
    });

    it('parseTestOutput_vitestV2_allPassing', () => {
      // Arrange — Vitest 2.x format: "Tests  N passed (N)" — no colon, no "total"
      const output = '      Tests  2 passed (2)';
      const exitCode = 0;

      // Act
      const result = parseTestOutput(output, exitCode);

      // Assert
      expect(result.passed).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.total).toBe(2);
      expect(result.succeeded).toBe(true);
    });

    it('parseTestOutput_vitestV2_withFailures_failedFirst', () => {
      // Arrange — When failures exist Vitest 2.x puts failed count FIRST
      const output = '      Tests  1 failed | 251 passed (252)';
      const exitCode = 1;

      // Act
      const result = parseTestOutput(output, exitCode);

      // Assert
      expect(result.passed).toBe(251);
      expect(result.failed).toBe(1);
      expect(result.total).toBe(252);
      expect(result.succeeded).toBe(false);
    });

    it('parseTestOutput_vitestV2_withSkipped', () => {
      // Arrange
      const output = '      Tests  5 passed | 2 skipped (7)';
      const exitCode = 0;

      // Act
      const result = parseTestOutput(output, exitCode);

      // Assert
      expect(result.passed).toBe(5);
      expect(result.skipped).toBe(2);
      expect(result.total).toBe(7);
    });

    it('parseTestOutput_vitestV2_withAnsiCodes_parsed', () => {
      // Arrange — Real Vitest 2.x output includes ANSI colour codes
      const output = '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m189 passed\x1b[39m\x1b[22m\x1b[90m (189)\x1b[39m';
      const exitCode = 0;

      // Act
      const result = parseTestOutput(output, exitCode);

      // Assert
      expect(result.passed).toBe(189);
      expect(result.total).toBe(189);
      expect(result.succeeded).toBe(true);
    });

    it('parseTestOutput_vitestV2_failedAnsiCodes_parsed', () => {
      // Arrange — Real Vitest 2.x failed summary with ANSI
      const output =
        '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m251 passed\x1b[39m\x1b[22m\x1b[90m (252)\x1b[39m';
      const exitCode = 1;

      // Act
      const result = parseTestOutput(output, exitCode);

      // Assert
      expect(result.passed).toBe(251);
      expect(result.failed).toBe(1);
      expect(result.total).toBe(252);
    });

    it('parseTestOutput_dotnet_extractsCounts', () => {
      // Arrange — dotnet test summary line
      const output = 'Passed! - Failed: 0, Passed: 10, Skipped: 0, Total: 10';
      const exitCode = 0;

      // Act
      const result = parseTestOutput(output, exitCode);

      // Assert
      expect(result.passed).toBe(10);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.total).toBe(10);
      expect(result.succeeded).toBe(true);
    });

    it('parseTestOutput_dotnet_withFailures', () => {
      // Arrange
      const output = 'Failed! - Failed: 2, Passed: 8, Skipped: 1, Total: 11';
      const exitCode = 1;

      // Act
      const result = parseTestOutput(output, exitCode);

      // Assert
      expect(result.failed).toBe(2);
      expect(result.passed).toBe(8);
      expect(result.total).toBe(11);
    });

    it('parseTestOutput_rust_extractsCounts', () => {
      // Arrange — Rust test result line
      const output = 'test result: ok. 14 passed; 0 failed; 3 ignored; 0 measured';
      const exitCode = 0;

      // Act
      const result = parseTestOutput(output, exitCode);

      // Assert
      expect(result.passed).toBe(14);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(3);   // "ignored" maps to skipped
      expect(result.total).toBe(17);    // passed + failed + skipped
    });

    it('parseTestOutput_rust_withFailures', () => {
      // Arrange
      const output = 'test result: FAILED. 10 passed; 2 failed; 0 ignored; 0 measured';
      const exitCode = 1;

      // Act
      const result = parseTestOutput(output, exitCode);

      // Assert
      expect(result.passed).toBe(10);
      expect(result.failed).toBe(2);
      expect(result.succeeded).toBe(false);
    });

    it('parseTestOutput_individualFailureLines_captured', () => {
      // Arrange — Individual FAIL lines are collected in failures[]
      const output = [
        '  FAIL src/foo.test.ts [10ms]',
        '  FAIL src/bar.test.ts [5ms]',
        'Tests: 0 passed, 2 failed, 2 total',
      ].join('\n');
      const exitCode = 1;

      // Act
      const result = parseTestOutput(output, exitCode);

      // Assert
      expect(result.failures).toHaveLength(2);
      expect(result.failures[0].name).toContain('src/foo.test.ts');
      expect(result.failures[1].name).toContain('src/bar.test.ts');
    });

    it('parseTestOutput_unknownFormat_zeroCountsExitCodeDrivesSuccess', () => {
      // Arrange — output with no recognizable pattern
      const output = 'done in 2.5s';
      const exitCode = 0;

      // Act
      const result = parseTestOutput(output, exitCode);

      // Assert — unknown format yields zeros but still respects exitCode
      expect(result.passed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.succeeded).toBe(true);
    });

    it('parseTestOutput_C11_pytestQuiet_allPassing', () => {
      // C11: pytest under `addopts = "-q"` prints a BARE summary with no =====
      // envelope. This is the exact line that false-greened a 32-test suite.
      const output = '32 passed in 0.47s';
      const exitCode = 0;

      const result = parseTestOutput(output, exitCode);

      expect(result.passed).toBe(32);
      expect(result.failed).toBe(0);
      expect(result.total).toBe(32);
      expect(result.succeeded).toBe(true);
    });

    it('parseTestOutput_C11_pytestQuiet_withFailures', () => {
      // Quiet summary, failures first: "1 failed, 31 passed in 0.50s"
      const output = '1 failed, 31 passed in 0.50s';
      const exitCode = 1;

      const result = parseTestOutput(output, exitCode);

      expect(result.passed).toBe(31);
      expect(result.failed).toBe(1);
      expect(result.total).toBe(32);
      expect(result.succeeded).toBe(false);
    });

    it('parseTestOutput_C11_pytestQuiet_withSkippedAndErrors', () => {
      const output = '5 passed, 2 skipped, 1 error in 1.10s';
      const exitCode = 1;

      const result = parseTestOutput(output, exitCode);

      expect(result.passed).toBe(5);
      expect(result.skipped).toBe(2);
      expect(result.failed).toBe(1); // errors fold into failed
      expect(result.total).toBe(8);
    });

    it('parseTestOutput_pytestEnvelope_stillParses', () => {
      // Guard the non-quiet (verbose) format still works after the quiet branch.
      const output = '===== 5 passed, 1 failed, 2 skipped in 1.23s =====';
      const exitCode = 1;

      const result = parseTestOutput(output, exitCode);

      expect(result.passed).toBe(5);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(2);
      expect(result.total).toBe(8);
    });

    it('parseTestOutput_pytestQuiet_doesNotMatchProse', () => {
      // A prose line that happens to contain "in 3s" must NOT be read as a summary.
      const output = 'Ran the suite in 3s and everything looked fine';
      const exitCode = 0;

      const result = parseTestOutput(output, exitCode);

      expect(result.total).toBe(0);
    });

    it('parseTestOutput_playwrightGreen_parsesPerLineSummary', () => {
      // Playwright prints each outcome on its OWN line with the duration in
      // PARENS and no "Tests:"/"total" keyword. Before the matcher, a green run
      // parsed as 0 tests → isZeroCollected false-RED. flaky counts toward passed.
      const output = '\n  14 passed (14.4s)\n  2 flaky\n  3 skipped\n';
      const exitCode = 0;

      const result = parseTestOutput(output, exitCode);

      expect(result.passed).toBe(16); // 14 passed + 2 flaky
      expect(result.skipped).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.total).toBe(19);
    });

    it('parseTestOutput_playwrightFailures_countToFailed', () => {
      const output = '  3 passed (2.1s)\n  1 failed\n  1 interrupted\n';
      const exitCode = 1;

      const result = parseTestOutput(output, exitCode);

      expect(result.passed).toBe(3);
      expect(result.failed).toBe(2); // 1 failed + 1 interrupted
      expect(result.total).toBe(5);
    });

    it('parseTestOutput_playwrightMatcher_ignoresNumberedFailureDetail', () => {
      // A numbered failure-detail line ("1) e2e/foo.spec.js …") must NOT be read
      // as "1 <outcome>" — the anchored regex requires an outcome keyword.
      const output = '  1) e2e/foo.spec.js:3:1 › renders\n  1 failed\n';
      const exitCode = 1;

      const result = parseTestOutput(output, exitCode);

      expect(result.failed).toBe(1);
      expect(result.total).toBe(1);
    });
  });

  // ─── testPassed (C11/F1 teeth) ───────────────────────────────────────────────

  describe('testPassed', () => {
    const { testPassed } = require('../gate');

    it('testPassed_zeroCollectedRealRunner_false', () => {
      // The headline C11 fix: a real runner that parsed 0 tests is a FAIL even
      // though it exited 0 and the parser said succeeded.
      const test = { succeeded: true, total: 0, exitCode: 0 };
      expect(testPassed(test, 'pytest')).toBe(false);
    });

    it('testPassed_realRunnerWithTests_true', () => {
      const test = { succeeded: true, total: 32, exitCode: 0 };
      expect(testPassed(test, 'pytest')).toBe(true);
    });

    it('testPassed_echoNoTestFallback_true', () => {
      // The echo fallback legitimately collects 0 — not a false-green.
      const test = { succeeded: true, total: 0, exitCode: 0 };
      expect(testPassed(test, 'echo "No test script"')).toBe(true);
    });

    it('testPassed_passWithNoTestsWave_true', () => {
      const test = { succeeded: true, total: 0, exitCode: 0 };
      expect(testPassed(test, 'npm test -- --changed --passWithNoTests')).toBe(true);
    });

    it('testPassed_genuineFailure_false', () => {
      const test = { succeeded: false, total: 10, exitCode: 1 };
      expect(testPassed(test, 'pytest')).toBe(false);
    });
  });

  // ─── loadConfig ────────────────────────────────────────────────────────────
  //
  // loadConfig reads PROJECT_ROOT which is computed at module load time.
  // We bust require.cache[GATE_PATH] before each re-require so Node re-executes
  // gate.js with the updated CLAUDE_PROJECT_DIR value baked into PROJECT_ROOT.

  describe('loadConfig', () => {
    let tmp;
    let savedEnv;

    beforeEach(() => {
      tmp = createTmpDir();
      savedEnv = process.env.CLAUDE_PROJECT_DIR;
    });

    afterEach(() => {
      if (savedEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = savedEnv;
      // Re-bust cache so the top-level require is not stale for other suites
      delete require.cache[GATE_PATH];
      tmp.cleanup();
    });

    function freshLoadConfig() {
      process.env.CLAUDE_PROJECT_DIR = tmp.root;
      delete require.cache[GATE_PATH];
      return require('../gate').loadConfig;
    }

    it('loadConfig_packageJson_returnsNodeStack', () => {
      // Arrange
      tmp.write('package.json', JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run' } }));
      const loadConfig = freshLoadConfig();

      // Act
      const config = loadConfig();

      // Assert
      expect(config.stack).toBe('node');
      expect(config.build.command).toBe('npm run build');
      expect(config.test.command).toBe('npm test');
    });

    it('loadConfig_e2eScript_detected_addsE2eLeg', () => {
      // R1: an E2E suite behind its own script gets a first-class e2e gate leg.
      tmp.write('package.json', JSON.stringify({ scripts: { test: 'vitest run', 'test:e2e': 'playwright test' } }));
      const loadConfig = freshLoadConfig();

      const config = loadConfig();

      expect(config.e2e.command).toBe('npm run test:e2e');
      expect(config.e2e.missing).toBeUndefined();
    });

    it('loadConfig_noE2eScript_e2eLegIsGracefulNoOp', () => {
      // A project without an E2E suite must never fail the e2e gate.
      tmp.write('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
      const loadConfig = freshLoadConfig();

      const config = loadConfig();

      expect(config.e2e.missing).toBe(true);
    });

    it('loadConfig_e2eScriptPrecedence_prefersTestE2eOverPlainE2e', () => {
      tmp.write('package.json', JSON.stringify({ scripts: { 'test:e2e': 'a', e2e: 'b' } }));
      const loadConfig = freshLoadConfig();

      const config = loadConfig();

      expect(config.e2e.command).toBe('npm run test:e2e');
    });

    it('loadConfig_explicitConfigWithoutE2e_inheritsAutoDetectedE2eLeg', () => {
      // Root-cause regression: a pre-R1 explicit gate.config.json has no e2e key.
      // The old early-return left config.e2e === undefined → the e2e leg silently
      // SKIPped (false-PASS). loadConfig must now layer the explicit config over
      // auto-detection so the omitted e2e key falls back to the detected script.
      tmp.write('package.json', JSON.stringify({ scripts: { test: 'vitest run', 'test:e2e': 'playwright test' } }));
      tmp.write('.claude/gate.config.json', JSON.stringify({
        build: { command: 'node --check x.js', timeout: 60000 },
        test: { command: 'npm test', timeout: 600000 },
        stack: 'node',
      }));
      const loadConfig = freshLoadConfig();

      const config = loadConfig();

      // Explicit keys win…
      expect(config.build.command).toBe('node --check x.js');
      // …but the omitted e2e key is filled from auto-detection (not undefined).
      expect(config.e2e).toBeDefined();
      expect(config.e2e.command).toBe('npm run test:e2e');
      expect(config.e2e.missing).toBeUndefined();
    });

    it('loadConfig_explicitConfigWithE2e_explicitWins', () => {
      // When the explicit config DOES declare e2e, it must win over auto-detect.
      tmp.write('package.json', JSON.stringify({ scripts: { test: 'vitest run', 'test:e2e': 'playwright test' } }));
      tmp.write('.claude/gate.config.json', JSON.stringify({
        test: { command: 'npm test', timeout: 600000 },
        e2e: { command: 'npm run e2e', timeout: 1200000 },
        stack: 'node',
      }));
      const loadConfig = freshLoadConfig();

      const config = loadConfig();

      expect(config.e2e.command).toBe('npm run e2e');
    });

    it('loadConfig_noBuildScript_plainJS_fallsBackToNoOp', () => {
      // F4: a plain-JS project (no build script, no tsconfig, no typescript dep)
      // must NOT run `tsc --noEmit` — it would fail the gate on a healthy repo.
      tmp.write('package.json', JSON.stringify({ name: 'my-lib' }));
      const loadConfig = freshLoadConfig();

      const config = loadConfig();

      expect(config.stack).toBe('node');
      expect(config.build.command).toMatch(/^echo /);
      expect(config.build.command).not.toContain('tsc');
    });

    it('loadConfig_noBuildScript_withTsconfig_usesTsc', () => {
      // F4: TypeScript IS detected via tsconfig.json → tsc --noEmit is correct.
      tmp.write('package.json', JSON.stringify({ name: 'my-lib' }));
      tmp.write('tsconfig.json', '{}');
      const loadConfig = freshLoadConfig();

      const config = loadConfig();

      expect(config.build.command).toBe('npx tsc --noEmit');
    });

    it('loadConfig_noBuildScript_withTypescriptDep_usesTsc', () => {
      // F4: TypeScript detected via a typescript devDependency → tsc --noEmit.
      tmp.write('package.json', JSON.stringify({ name: 'my-lib', devDependencies: { typescript: '^5.0.0' } }));
      const loadConfig = freshLoadConfig();

      const config = loadConfig();

      expect(config.build.command).toBe('npx tsc --noEmit');
    });

    it('isZeroCollected_F1_realRunnerExit0ZeroTests_flagsTrue', () => {
      // The false-green case: jest exited 0 but parser found 0 tests.
      expect(isZeroCollected('npm test', 0, 0)).toBe(true);
    });

    it('isZeroCollected_realRunnerWithTests_false', () => {
      expect(isZeroCollected('npm test', 0, 40)).toBe(false);
    });

    it('isZeroCollected_echoFallback_false', () => {
      // The "No test script" echo fallback legitimately collects 0 — not a flag.
      expect(isZeroCollected('echo "No test script"', 0, 0)).toBe(false);
    });

    it('isZeroCollected_passWithNoTests_false', () => {
      // --changed waves opt into no-match passing; 0 collected is expected.
      expect(isZeroCollected('npm test -- --changed --passWithNoTests', 0, 0)).toBe(false);
    });

    it('isZeroCollected_nonZeroExit_false', () => {
      // A failing runner is already a FAIL — not a false-green.
      expect(isZeroCollected('npm test', 1, 0)).toBe(false);
    });

    it('loadConfig_C1_python_noMypy_omitsMypyLeg', () => {
      // C1 (F4-analog): a ruff+pytest project that doesn't use mypy must NOT have
      // `mypy --strict` hard-wired into the build — it would make the gate
      // unreachable on a healthy repo.
      tmp.write('pyproject.toml', '[project]\nname = "x"\n[dependency-groups]\ndev = ["pytest", "ruff"]');
      const loadConfig = freshLoadConfig();

      const config = loadConfig();

      expect(config.stack).toBe('python');
      expect(config.build.command).toContain('ruff check');
      expect(config.build.command).not.toContain('mypy');
    });

    it('loadConfig_C1_python_mypyDeclared_includesMypyLeg', () => {
      // When the project DOES declare mypy, run it.
      tmp.write('pyproject.toml', '[project]\nname = "x"\n[tool.mypy]\nstrict = true');
      const loadConfig = freshLoadConfig();

      const config = loadConfig();

      expect(config.build.command).toContain('mypy --strict src');
    });

    it('loadConfig_cargoToml_returnsRustStack', () => {
      // Arrange
      tmp.write('Cargo.toml', '[package]\nname = "myapp"\nversion = "0.1.0"');
      const loadConfig = freshLoadConfig();

      // Act
      const config = loadConfig();

      // Assert
      expect(config.stack).toBe('rust');
      expect(config.build.command).toBe('cargo build');
      expect(config.test.command).toBe('cargo test');
    });

    it('loadConfig_goMod_returnsGoStack', () => {
      // Arrange
      tmp.write('go.mod', 'module example.com/myapp\n\ngo 1.21');
      const loadConfig = freshLoadConfig();

      // Act
      const config = loadConfig();

      // Assert
      expect(config.stack).toBe('go');
      expect(config.build.command).toBe('go build ./...');
      expect(config.test.command).toBe('go test ./...');
    });

    it('loadConfig_sln_returnsDotnetStack', () => {
      // Arrange
      tmp.write('MyApp.sln', 'Microsoft Visual Studio Solution File');
      const loadConfig = freshLoadConfig();

      // Act
      const config = loadConfig();

      // Assert — F31: dotnet legs are argv-mode (no shell-interpolated `.command`
      // string), so the solution filename is never concatenated into a shell string.
      expect(config.stack).toBe('dotnet');
      expect(config.build.command).toBeUndefined();
      expect(config.build.argv).toEqual(['dotnet', 'build', 'MyApp.sln', '--configuration', 'Release', '--verbosity', 'minimal']);
      expect(config.test.command).toBeUndefined();
      expect(config.test.argv).toEqual(['dotnet', 'test', 'MyApp.sln', '--configuration', 'Release', '--verbosity', 'minimal', '--no-build']);
    });

    it('loadConfig_slnx_returnsDotnetStack', () => {
      // Arrange
      tmp.write('MyApp.slnx', '<Solution />');
      const loadConfig = freshLoadConfig();

      // Act
      const config = loadConfig();

      // Assert
      expect(config.stack).toBe('dotnet');
      expect(config.build.argv).toContain('MyApp.slnx');
    });

    it('loadConfig_dotnet_hostileSolutionFilename_isSingleArgvElement_F31', () => {
      // F31: a crafted solution filename (readdirSync gives us whatever is on
      // disk) must never be split/reinterpreted by a shell — it must survive as
      // ONE argv element, byte-for-byte, in both the build and test legs.
      // (No literal `/` in the name — that would make tmp.write's path.join
      // create a subdirectory instead of a top-level file; `/` is disallowed in
      // a real filename anyway, so this is still a faithful RCE-shaped payload.)
      // NTFS forbids `"` in filenames (POSIX allows it) — on win32 use `'`, which is
      // legal on NTFS and keeps the same quote-breaking RCE shape.
      const hostileName = process.platform === 'win32' ? "x'; touch pwned #.sln" : 'x"; touch pwned #.sln';
      tmp.write(hostileName, 'Microsoft Visual Studio Solution File');
      const loadConfig = freshLoadConfig();

      const config = loadConfig();

      expect(config.stack).toBe('dotnet');
      // Argv-mode only — no shell-command string exists to interpolate into.
      expect(config.build.command).toBeUndefined();
      expect(config.test.command).toBeUndefined();
      expect(Array.isArray(config.build.argv)).toBe(true);
      expect(Array.isArray(config.test.argv)).toBe(true);
      // The hostile filename appears exactly once, as a single array element.
      expect(config.build.argv.filter((a) => a === hostileName)).toHaveLength(1);
      expect(config.test.argv.filter((a) => a === hostileName)).toHaveLength(1);
    });

    it('loadConfig_makefile_returnsMakeStack', () => {
      // Arrange
      tmp.write('Makefile', 'build:\n\tgo build\ntest:\n\tgo test ./...');
      const loadConfig = freshLoadConfig();

      // Act
      const config = loadConfig();

      // Assert
      expect(config.stack).toBe('make');
      expect(config.build.command).toBe('make build');
    });

    it('loadConfig_noProjectFiles_returnsUnknownStack', () => {
      // Arrange — empty tmp dir (no project files)
      const loadConfig = freshLoadConfig();

      // Act
      const config = loadConfig();

      // Assert
      expect(config.stack).toBe('unknown');
    });

    it('loadConfig_explicitConfigFile_overridesAutoDetection', () => {
      // Arrange — package.json present (would auto-detect node) but config file overrides
      tmp.write('package.json', JSON.stringify({ scripts: { build: 'tsc' } }));
      tmp.write('.claude/gate.config.json', JSON.stringify({
        build: { command: 'make release', timeout: 120000 },
        test: { command: 'make test', timeout: 300000 },
        stack: 'custom'
      }));
      const loadConfig = freshLoadConfig();

      // Act
      const config = loadConfig();

      // Assert — explicit config wins over auto-detection
      expect(config.build.command).toBe('make release');
      expect(config.test.command).toBe('make test');
      expect(config.stack).toBe('custom');
    });

    it('loadConfig_explicitConfigFile_returnsExpectedShape', () => {
      // Arrange
      tmp.write('.claude/gate.config.json', JSON.stringify({
        build: { command: 'npm run build', timeout: 300000 },
        test: { command: 'npm test', timeout: 600000 }
      }));
      const loadConfig = freshLoadConfig();

      // Act
      const config = loadConfig();

      // Assert
      expect(config).toHaveProperty('build');
      expect(config).toHaveProperty('test');
      expect(typeof config.build.command).toBe('string');
      expect(typeof config.build.timeout).toBe('number');
    });
  });

  // ─── acquireLock / releaseLock ─────────────────────────────────────────────
  //
  // GATE_DIR = path.join(PROJECT_ROOT, 'docs', '.output', '.state', 'telemetry')
  // LOCK_FILE = path.join(GATE_DIR, '.gate.lock')
  // Both are frozen at module load, so we use the same cache-bust pattern.

  describe('acquireLock / releaseLock', () => {
    let tmp;
    let savedEnv;

    beforeEach(() => {
      tmp = createTmpDir();
      savedEnv = process.env.CLAUDE_PROJECT_DIR;
    });

    afterEach(() => {
      if (savedEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = savedEnv;
      delete require.cache[GATE_PATH];
      tmp.cleanup();
    });

    function freshGate() {
      process.env.CLAUDE_PROJECT_DIR = tmp.root;
      delete require.cache[GATE_PATH];
      return require('../gate');
    }

    it('acquireLock_firstCall_returnsTrue', () => {
      // Arrange
      const { acquireLock } = freshGate();

      // Act
      const result = acquireLock();

      // Assert
      expect(result).toBe(true);
    });

    it('acquireLock_doubleAcquire_secondReturnsFalse', () => {
      // Arrange — same module instance, lock already held after first call
      const { acquireLock } = freshGate();
      acquireLock();

      // Act
      const second = acquireLock();

      // Assert
      expect(second).toBe(false);
    });

    it('releaseLock_afterAcquire_allowsReacquire', () => {
      // Arrange
      const { acquireLock, releaseLock } = freshGate();
      acquireLock();

      // Act
      releaseLock();
      const reacquired = acquireLock();

      // Assert
      expect(reacquired).toBe(true);
    });

    it('releaseLock_calledTwice_doesNotThrow', () => {
      // Arrange
      const { acquireLock, releaseLock } = freshGate();
      acquireLock();

      // Act / Assert — second release is idempotent
      releaseLock();
      expect(() => releaseLock()).not.toThrow();
    });

    it('acquireLock_staleLock_breaksAndReturnsTrue', () => {
      // Arrange — write a lock file with a started time >10 minutes ago
      // GATE_DIR = docs/.output/.state/telemetry inside PROJECT_ROOT
      const gateDir = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry');
      fs.mkdirSync(gateDir, { recursive: true });
      const lockFile = path.join(gateDir, '.gate.lock');
      const staleTime = new Date(Date.now() - 700000).toISOString(); // 700s > 600s threshold
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999, started: staleTime }));

      const { acquireLock } = freshGate();

      // Act
      const result = acquireLock();

      // Assert — stale lock is broken and acquire succeeds
      expect(result).toBe(true);
    });

    it('acquireLock_freshLock_returnsFalse', () => {
      // Arrange — write a fresh lock (under 10 minutes old)
      const gateDir = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry');
      fs.mkdirSync(gateDir, { recursive: true });
      const lockFile = path.join(gateDir, '.gate.lock');
      const freshTime = new Date(Date.now() - 5000).toISOString(); // 5s old
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid + 1, started: freshTime }));

      const { acquireLock } = freshGate();

      // Act
      const result = acquireLock();

      // Assert — active fresh lock blocks acquire
      expect(result).toBe(false);
    });
  });

  describe('runCommand — stderr capture (F31)', () => {
    const { runCommand, describeLeg, legRunnable } = require('../gate');

    it('captures stderr on a SUCCESSFUL (exit 0) command', () => {
      // Root cause of F1/F24/F31: jest prints its "Tests: N passed, N total"
      // summary to STDERR, and the old execSync path discarded stderr on exit 0
      // → the parser saw 0 tests → the false-green teeth FAILED a green suite.
      // A passing command that writes its summary to stderr must still surface it.
      const cmd = `node -e "console.error('Tests: 5 passed, 5 total'); process.exit(0)"`;
      const r = runCommand(cmd, process.cwd(), 30000);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain('Tests: 5 passed, 5 total');
    });

    it('the captured stderr feeds parseTestOutput to a real count (not zero-collected)', () => {
      const cmd = `node -e "console.error('Tests: 5 passed, 5 total'); process.exit(0)"`;
      const r = runCommand(cmd, process.cwd(), 30000);
      const combined = (r.output || '') + '\n' + (r.stderr || '');
      const parsed = parseTestOutput(combined, r.exitCode);
      expect(parsed.total).toBe(5);
      expect(parsed.passed).toBe(5);
      expect(isZeroCollected(cmd, r.exitCode, parsed.total)).toBe(false);
    });

    it('still captures stdout + stderr on a FAILING command', () => {
      const cmd = `node -e "console.log('out'); console.error('err'); process.exit(1)"`;
      const r = runCommand(cmd, process.cwd(), 30000);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('out');
      expect(r.stderr).toContain('err');
    });

    it('argv-mode (F31): shell:false makes a metacharacter-laden arg inert — no shell interpolation', () => {
      // If this arg were ever concatenated into a shell:true string (the old
      // dotnet build/test path), the embedded `;` would run `touch <proofFile>`
      // as a SECOND shell command. In argv mode, spawnSync delivers it as ONE
      // argv element to the child process; there is no shell to reinterpret it.
      const tmp = createTmpDir();
      try {
        const proofFile = path.join(tmp.root, 'PROOF');
        const hostile = `x"; touch ${proofFile} #`;
        const r = runCommand({ argv: ['node', '-e', 'console.log(process.argv[1])', hostile] }, process.cwd(), 30000);
        expect(r.exitCode).toBe(0);
        expect(r.output.trim()).toBe(hostile);
        expect(fs.existsSync(proofFile)).toBe(false);
      } finally {
        tmp.cleanup();
      }
    });

    it('argv-mode (F31): a failing argv-mode command still reports a real exit code', () => {
      const r = runCommand({ argv: ['node', '-e', 'process.exit(3)'] }, process.cwd(), 30000);
      expect(r.exitCode).toBe(3);
    });
  });

  describe('describeLeg / legRunnable (F31 display + dispatch helpers)', () => {
    const { describeLeg, legRunnable } = require('../gate');

    it('describeLeg renders a shell-mode leg as its command string', () => {
      expect(describeLeg({ command: 'npm run build', timeout: 1000 })).toBe('npm run build');
    });

    it('describeLeg renders an argv-mode leg as a space-joined display string', () => {
      expect(describeLeg({ argv: ['dotnet', 'build', 'x.sln'], timeout: 1000 })).toBe('dotnet build x.sln');
    });

    it('legRunnable passes shell-mode legs through as a string (for shell:true dispatch)', () => {
      expect(legRunnable({ command: 'npm test', timeout: 1000 })).toBe('npm test');
    });

    it('legRunnable passes argv-mode legs through as { argv } (for shell:false dispatch)', () => {
      expect(legRunnable({ argv: ['dotnet', 'test', 'x.sln'], timeout: 1000 })).toEqual({ argv: ['dotnet', 'test', 'x.sln'] });
    });
  });
});
