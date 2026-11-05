// AC→source map (TDD-3.5 / gate):
//   - parseBuildOutput: TS/C# style, ESLint/generic, Rust prefix, mixed, empty
//   - parseTestOutput: Vitest v1 (colon), Vitest v2 (no colon, parens), dotnet, Rust, individual failures
//   - loadConfig: auto-detects package.json / Cargo.toml / go.mod / .sln / Makefile; explicit override
//   - acquireLock / releaseLock: double-acquire fails, release re-enables; stale lock breaks only when past the 30-min ceiling AND its owner is dead; releaseLock only deletes a lock this process still owns (pid+started match)
//   - MODULE: gate.js exports { loadConfig, parseBuildOutput, parseTestOutput, acquireLock, releaseLock }
//
// Isolation strategy for env-dependent tests (loadConfig, acquireLock, releaseLock):
//   PROJECT_ROOT is frozen at module load time (Node CJS statics).
//   vi.resetModules() does not help here because we use createRequire (Node's native CJS cache),
//   not Vitest's ESM module registry.
//   Solution: delete the gate.js entry from require.cache before each re-require so that
//   Node re-executes the module with the current CLAUDE_PROJECT_DIR value.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');

// Absolute path to gate.js — used to bust require.cache
const GATE_PATH = require.resolve('../../../.agents/core/gate');

// Top-level require for pure functions — no env dependency, no need for cache busting
const { parseBuildOutput, parseTestOutput, isZeroCollected, legTimeout, formatTimeout, DEFAULT_LEG_TIMEOUT_MS } = require('../../../.agents/core/gate');
const { runInstall } = require('../../../.agents/core/install');
const { renderSharedAgents } = require('../../../.agents/core/_lib/shared-agents');

// SA-3: port the configuration-only missing-leg policy to a neutral adopter.
describe('neutral adopter application gate ownership', () => {
  let tmp, target;
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '_fixtures/neutral-adopter');
  beforeEach(() => {
    tmp = createTmpDir();
    target = tmp.mkdir('neutral adopter with spaces');
    for (const file of ['package.json', 'application.cjs', 'application-check.cjs']) fs.copyFileSync(path.join(fixture, file), path.join(target, file));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); tmp.cleanup(); });
  const gate = (root, mode) => execFileSync(process.execPath, [GATE_PATH, mode], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });

  it('install_canonicalMissingAgentLint_applicationBuildTestCoveragePreflightAndSecurityStayActiveAfterAgentEdit', () => {
    const stats = runInstall({ source: fixture, target });
    expect(stats.ok).toBe(true);
    const config = JSON.parse(fs.readFileSync(path.join(target, '.claude/gate.config.json')));
    expect(config.lint).toEqual({ missing: true });
    expect(fs.existsSync(path.join(target, '.claude/core/__tests__'))).toBe(false);
    expect(gate(target, 'build')).toContain('Overall: PASSED');
    const unit = gate(target, 'test');
    expect(unit).toContain('Tests: PASSED (2 passed, 0 failed, 1 skipped)');
    expect(unit).toContain('Lint: SKIPPED');
    const summary = JSON.parse(fs.readFileSync(path.join(target, 'docs/.output/.state/telemetry/_latest-test.json')));
    expect(summary.passed).toBe(2);
    // Put a trap suite on the adopter and edit an agent file: routing stays the same.
    tmp.write('neutral adopter with spaces/.claude/core/__tests__/agent-suite-trap.cjs', fs.readFileSync(path.join(fixture, '.claude/core/__tests__/agent-suite-trap.cjs')));
    tmp.write('neutral adopter with spaces/.claude/agents/local-role.md', '# Edited agent\n');
    expect(gate(target, 'test')).toContain('Overall: PASSED');
    expect(gate(target, 'e2e')).toContain('Overall: PASSED');
    execFileSync(process.execPath, [path.join(target, 'application-check.cjs'), 'preflight'], { cwd: target });
    const records = fs.readFileSync(path.join(target, 'application-checks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(records.map(r => r.mode)).toEqual(['build', 'build', 'test', 'build', 'test', 'integration', 'preflight', 'build', 'test', 'security']);
    expect(records.filter(r => r.mode === 'test').every(r => r.flags.includes('--coverage') && r.flags.includes('--filter=Category!=Integration'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'AGENT_SUITE_RAN'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'docs/.output/.state/telemetry/.gate.lock'))).toBe(false);
  });

  it('render_genuineApplicationLint_preservesAndExecutesTheApplicationLeg', () => {
    runInstall({ source: fixture, target });
    const canonical = path.join(target, '.agents/gate.config.json');
    const config = JSON.parse(fs.readFileSync(canonical));
    config.lint = { command: 'node application-check.cjs lint', timeout: 30000 };
    fs.writeFileSync(canonical, JSON.stringify(config, null, 2) + '\n');
    renderSharedAgents(target);
    expect(gate(target, 'test')).toContain('Lint: PASSED');
    const records = fs.readFileSync(path.join(target, 'application-checks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(records.map(r => r.mode)).toEqual(['build', 'test', 'lint']);
  });

  // An argv-mode or multi-leg lint/e2e configuration has no `.command`; it must run through the
  // same leg helpers the build and test legs use, and the display string must be recorded.
  const records = root => fs.readFileSync(path.join(root, 'application-checks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const withCanonicalLegs = (legs) => {
    runInstall({ source: fixture, target });
    const canonical = path.join(target, '.agents/gate.config.json');
    const config = JSON.parse(fs.readFileSync(canonical));
    Object.assign(config, legs);
    fs.writeFileSync(canonical, JSON.stringify(config, null, 2) + '\n');
    renderSharedAgents(target);
  };

  it('render_argvLintLeg_runsThroughTheLegHelpersAndRecordsTheDisplayedCommand', () => {
    withCanonicalLegs({ lint: { argv: ['node', 'application-check.cjs', 'lint'], timeout: 30000 } });
    expect(gate(target, 'test')).toContain('Lint: PASSED');
    expect(records(target).map(r => r.mode)).toEqual(['build', 'test', 'lint']);
    const summary = JSON.parse(fs.readFileSync(path.join(target, 'docs/.output/.state/telemetry/_latest-lint.json'), 'utf8'));
    expect(summary.command).toBe('node application-check.cjs lint');
  });

  it('render_multiLegLintLeg_runsEveryLegAndRecordsTheJoinedCommand', () => {
    withCanonicalLegs({
      lint: { legs: [
        { argv: ['node', 'application-check.cjs', 'lint'], timeout: 30000 },
        { argv: ['node', 'application-check.cjs', 'lint'], timeout: 30000 },
      ], timeout: 60000 },
    });
    expect(gate(target, 'test')).toContain('Lint: PASSED');
    expect(records(target).map(r => r.mode)).toEqual(['build', 'test', 'lint', 'lint']);
    const summary = JSON.parse(fs.readFileSync(path.join(target, 'docs/.output/.state/telemetry/_latest-lint.json'), 'utf8'));
    expect(summary.command).toBe('node application-check.cjs lint && node application-check.cjs lint');
  });

  it('render_multiLegTestLeg_runsEveryLegThroughTheLegHelpers', () => {
    const testLeg = { argv: ['node', 'application-check.cjs', 'test', '--filter=Category!=Integration', '--coverage'], timeout: 30000 };
    withCanonicalLegs({ test: { legs: [testLeg, testLeg], timeout: 60000 } });
    expect(gate(target, 'test')).toContain('Overall: PASSED');
    expect(records(target).map(r => r.mode)).toEqual(['build', 'test', 'test']);
    const summary = JSON.parse(fs.readFileSync(path.join(target, 'docs/.output/.state/telemetry/_latest-test.json'), 'utf8'));
    expect(summary.command).toBe(`${testLeg.argv.join(' ')} && ${testLeg.argv.join(' ')}`);
  });

  it('render_argvE2eLeg_runsThroughTheLegHelpersAndRecordsTheDisplayedCommand', () => {
    withCanonicalLegs({ e2e: { argv: ['node', 'application-check.cjs', 'integration', '--isolated'], timeout: 30000 } });
    expect(gate(target, 'e2e')).toContain('Overall: PASSED');
    expect(records(target).map(r => r.mode)).toEqual(['integration']);
    const summary = JSON.parse(fs.readFileSync(path.join(target, 'docs/.output/.state/telemetry/_latest-e2e.json'), 'utf8'));
    expect(summary.command).toBe('node application-check.cjs integration --isolated');
  });

  // The test leg's time limit is configurable and named in the run; a killed run says so (NA6.22).
  const sleepLeg = (timeout) => ({ argv: ['node', '-e', 'setTimeout(() => {}, 60000)'], timeout });
  const gateOutcome = (root, mode, env = {}) => {
    const childEnv = { ...process.env, CLAUDE_PROJECT_DIR: root, ...env };
    if (!('GATE_TEST_TIMEOUT_MS' in env)) delete childEnv.GATE_TEST_TIMEOUT_MS;
    try {
      return { code: 0, out: execFileSync(process.execPath, [GATE_PATH, mode], { cwd: root, encoding: 'utf8', env: childEnv }) };
    } catch (error) {
      return { code: error.status, out: String(error.stdout) };
    }
  };

  it('timeout_environmentOverride_limitsTheTestLegAndIsNamedWithItsSource', () => {
    withCanonicalLegs({ test: sleepLeg(600000) });
    const result = gateOutcome(target, 'test', { GATE_TEST_TIMEOUT_MS: '1500' });
    expect(result.code).toBe(1);
    expect(result.out).toContain('Test time limit: 1500 ms (environment GATE_TEST_TIMEOUT_MS)');
    expect(result.out).toContain('Tests: TIMED OUT');
    expect(result.out).toContain('killed at 1500 ms');
    const latest = JSON.parse(fs.readFileSync(path.join(target, 'docs/.output/.state/telemetry/_latest-test.json'), 'utf8'));
    expect(latest.timedOut).toBe(true);
    // The kill is recorded in both latest files so a reader never mistakes it for "0 passed, 0 failed".
    expect(latest.timeoutMs).toBe(1500);
    expect(latest.timeoutMessage).toBe('TIMED OUT after 1.5 s');
    const summary = JSON.parse(fs.readFileSync(path.join(target, 'docs/.output/.state/telemetry/_latest-summary.json'), 'utf8'));
    expect(summary.test).toMatchObject({ timedOut: true, timeoutMs: 1500, timeoutMessage: 'TIMED OUT after 1.5 s' });
    const log = fs.readdirSync(path.join(target, 'docs/.output/.state/telemetry/logs')).sort().pop();
    expect(fs.readFileSync(path.join(target, 'docs/.output/.state/telemetry/logs', log), 'utf8'))
      .toContain('Test time limit: 1500 ms (environment GATE_TEST_TIMEOUT_MS)');
  });

  // The visual-regression leg is opt-in, full-gate only and local only (never in CI).
  const visualEnv = { CI: '' };
  const passingVisual = { argv: ['node', 'application-check.cjs', 'integration', '--isolated'], timeout: 30000 };
  const latestVisual = root => JSON.parse(fs.readFileSync(path.join(root, 'docs/.output/.state/telemetry/_latest-visual.json'), 'utf8'));
  const latestSummary = root => JSON.parse(fs.readFileSync(path.join(root, 'docs/.output/.state/telemetry/_latest-summary.json'), 'utf8'));

  it('visual_notConfigured_isSkippedAndNeverFailsTheGate', () => {
    withCanonicalLegs({});
    const result = gateOutcome(target, 'test', visualEnv);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Visual: SKIPPED (no visual gate configured)');
    expect(fs.existsSync(path.join(target, 'docs/.output/.state/telemetry/_latest-visual.json'))).toBe(false);
    expect(latestSummary(target).visual).toBeUndefined();
  });

  it('visual_argvLeg_runsThroughTheLegHelpersAndRecordsTheDisplayedCommand', () => {
    withCanonicalLegs({ visual: passingVisual });
    const result = gateOutcome(target, 'test', visualEnv);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Visual: PASSED (1 passed, 0 failed)');
    expect(records(target).map(r => r.mode)).toEqual(['build', 'test', 'integration']);
    expect(latestVisual(target).command).toBe('node application-check.cjs integration --isolated');
    expect(latestSummary(target).visual).toMatchObject({ succeeded: true, passed: 1, failed: 0, skipped: false, zeroCollected: false });
  });

  it('visual_failingLeg_failsTheGateAndSaysHowToInspect', () => {
    withCanonicalLegs({ visual: { argv: ['node', '-e', 'console.log("Tests: 1 passed, 1 failed, 0 skipped, 2 total"); process.exit(1)'], timeout: 30000 } });
    const result = gateOutcome(target, 'test', visualEnv);
    expect(result.code).toBe(1);
    expect(result.out).toContain('Visual: FAILED (1 passed, 1 failed)');
    expect(result.out).toContain('Visual diffs: inspect');
    expect(latestSummary(target).visual).toMatchObject({ succeeded: false, failed: 1 });
  });

  it('visual_zeroSnapshotsCollected_isAFailureNotAFalseGreen', () => {
    withCanonicalLegs({ visual: { argv: ['node', '-e', 'console.log("nothing ran")'], timeout: 30000 } });
    const result = gateOutcome(target, 'test', visualEnv);
    expect(result.code).toBe(1);
    expect(result.out).toContain('Visual: FAILED (0 snapshots collected)');
    expect(latestSummary(target).visual).toMatchObject({ succeeded: false, zeroCollected: true });
  });

  it('visual_ciSetToAnOffSpelling_stillRunsTheLeg', () => {
    withCanonicalLegs({ visual: passingVisual });
    for (const off of ['false', '0']) {
      const result = gateOutcome(target, 'test', { CI: off });
      expect(result.out, `CI=${off}`).toContain('Visual: PASSED');
    }
  });

  it('visual_withoutATimeout_getsTheDefaultLimit_andAKilledRunIsReportedAsTimedOut', () => {
    expect(legTimeout({ argv: ['x'] })).toBe(DEFAULT_LEG_TIMEOUT_MS);
    expect(legTimeout({ argv: ['x'], timeout: 0 })).toBe(DEFAULT_LEG_TIMEOUT_MS);
    expect(legTimeout({ argv: ['x'], timeout: 1500 })).toBe(1500);
    withCanonicalLegs({ visual: sleepLeg(1500) });
    const result = gateOutcome(target, 'test', visualEnv);
    expect(result.code).toBe(1);
    expect(result.out).toContain('Visual: FAILED (TIMED OUT after 1.5 s)');
    expect(latestVisual(target)).toMatchObject({ timedOut: true, timeoutMs: 1500 });
    expect(latestSummary(target).visual).toMatchObject({ succeeded: false, timedOut: true, timeoutMessage: 'TIMED OUT after 1.5 s' });
  });

  it('formatTimeout_rendersSecondsBelowAMinuteAndMinutesAbove', () => {
    expect(formatTimeout(1500)).toBe('1.5 s');
    expect(formatTimeout(59000)).toBe('59 s');
    expect(formatTimeout(60000)).toBe('1 min');
    expect(formatTimeout(2700000)).toBe('45 min');
  });

  it('visual_inCi_isSkippedWithoutRunningTheCommand', () => {
    withCanonicalLegs({ visual: passingVisual });
    const result = gateOutcome(target, 'test', { CI: 'true' });
    expect(result.code).toBe(0);
    expect(result.out).toContain('Visual: SKIPPED (CI');
    expect(records(target).map(r => r.mode)).toEqual(['build', 'test']);
    expect(latestSummary(target).visual).toMatchObject({ succeeded: true, skipped: true });
  });

  it('visual_fastTier_doesNotRunTheLeg', () => {
    withCanonicalLegs({ visual: passingVisual });
    const result = gateOutcome(target, '--no-build', visualEnv);
    expect(result.out).not.toContain('Visual');
    expect(records(target).map(r => r.mode)).not.toContain('integration');
  });

  it('visual_skippedWhenTheBuildFails', () => {
    withCanonicalLegs({
      build: { argv: ['node', '-e', 'process.exit(1)'], timeout: 30000 },
      visual: passingVisual,
    });
    const result = gateOutcome(target, 'test', visualEnv);
    expect(result.code).toBe(1);
    expect(result.out).toContain('Skipping visual');
    // No application check ran at all: the failed build stopped the test and visual legs.
    expect(fs.existsSync(path.join(target, 'application-checks.jsonl'))).toBe(false);
  });

  it('timeout_configKey_limitsTheTestLegWhenNoEnvironmentOverrideIsSet', () => {
    withCanonicalLegs({ test: sleepLeg(1500) });
    const result = gateOutcome(target, 'test');
    expect(result.code).toBe(1);
    expect(result.out).toContain('Test time limit: 1500 ms (.claude/gate.config.json test.timeout)');
    expect(result.out).toContain('Tests: TIMED OUT');
  });

  it('timeout_environmentOverrideBeatsTheConfigKeyBothWays', () => {
    withCanonicalLegs({ test: sleepLeg(1500) });
    // A higher override lets a leg the config key would have killed finish: the fixture leg is fast.
    const fast = { argv: ['node', 'application-check.cjs', 'test', '--filter=Category!=Integration', '--coverage'], timeout: 1000 };
    const canonical = path.join(target, '.agents/gate.config.json');
    const config = JSON.parse(fs.readFileSync(canonical));
    config.test = fast;
    fs.writeFileSync(canonical, JSON.stringify(config, null, 2) + '\n');
    renderSharedAgents(target);
    const result = gateOutcome(target, 'test', { GATE_TEST_TIMEOUT_MS: '120000' });
    expect(result.out).toContain('Test time limit: 120000 ms (environment GATE_TEST_TIMEOUT_MS)');
    expect(result.out).toContain('Overall: PASSED');
  });

  it('timeout_invalidEnvironmentValue_warnsAndFallsBackToTheConfiguredLimit', () => {
    withCanonicalLegs({ test: { argv: ['node', 'application-check.cjs', 'test', '--filter=Category!=Integration', '--coverage'], timeout: 90000 } });
    const result = gateOutcome(target, 'test', { GATE_TEST_TIMEOUT_MS: '600' });
    expect(result.out).toContain('Warning: GATE_TEST_TIMEOUT_MS="600" is not whole milliseconds');
    expect(result.out).toContain('Test time limit: 90000 ms (.claude/gate.config.json test.timeout)');
    expect(result.out).toContain('Overall: PASSED');
  });
});

describe('resolveTestTimeout (NA6.22)', () => {
  const { resolveTestTimeout, DEFAULT_TEST_TIMEOUT_MS } = require('../../../.agents/core/gate');

  it('default_noConfigNoEnvironment_staysSixHundredSeconds', () => {
    expect(DEFAULT_TEST_TIMEOUT_MS).toBe(600000);
    expect(resolveTestTimeout({ command: 'npm test' }, false, {})).toEqual({ timeoutMs: 600000, source: 'default', warning: undefined });
  });

  it('detectedStackLimit_isKeptAndLabeledAsTheStackDefault', () => {
    expect(resolveTestTimeout({ command: 'pytest', timeout: 1200000 }, false, {}))
      .toEqual({ timeoutMs: 1200000, source: 'detected stack default', warning: undefined });
  });

  it('configKey_winsOverTheDetectedLimit', () => {
    expect(resolveTestTimeout({ command: 'npm test', timeout: 900000 }, true, {}).source).toBe('.claude/gate.config.json test.timeout');
  });

  it('environment_winsOverEverythingWhenWholeMillisecondsInRange', () => {
    const resolved = resolveTestTimeout({ command: 'npm test', timeout: 900000 }, true, { GATE_TEST_TIMEOUT_MS: ' 1800000 ' });
    expect(resolved).toEqual({ timeoutMs: 1800000, source: 'environment GATE_TEST_TIMEOUT_MS' });
  });

  it.each(['600', '0', '-5', '1.5', '1e6', 'abc', '86400001', '999'])(
    'environment_%s_isRefusedWithAWarningAndTheConfiguredLimitStands', (value) => {
      const resolved = resolveTestTimeout({ command: 'npm test' }, false, { GATE_TEST_TIMEOUT_MS: value });
      expect(resolved.timeoutMs).toBe(600000);
      expect(resolved.source).toBe('default');
      expect(resolved.warning).toContain('GATE_TEST_TIMEOUT_MS');
    });

  it.each([['"600000"'], [0], [-5], [1.5]])('configTimeout_%s_isIgnoredWithAWarningAndTheDefaultApplies', (value) => {
    const resolved = resolveTestTimeout({ command: 'npm test', timeout: JSON.parse(String(value)) }, true, {});
    expect(resolved.timeoutMs).toBe(600000);
    expect(resolved.warning).toContain('test.timeout');
  });

  it('environment_emptyString_isTreatedAsUnset', () => {
    expect(resolveTestTimeout({ command: 'npm test' }, false, { GATE_TEST_TIMEOUT_MS: '' }).warning).toBeUndefined();
  });
});

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
      const sourceFile = ['', 'home', 'user', 'project', 'src', 'app.ts'].join('/');
      const output = `${sourceFile}:10:5: error Unexpected token`;
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
      const sourceFile = ['', 'home', 'user', 'project', 'src', 'app.ts'].join('/');
      const output = [
        sourceFile,
        '  10:5   error    Unexpected console statement  no-console',
        '  12:1   warning  Missing return type            @typescript-eslint/explicit-function-return-type',
      ].join('\n');
      const exitCode = 1;

      // Act
      const result = parseBuildOutput(output, exitCode);

      // Assert — the error attributes to the pending file line; the warning is bucketed separately
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].file).toBe(sourceFile);
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

    // ── monorepo: one summary block PER package ───────────────────────────────
    // A workspace run (pnpm -r, turbo, cargo --workspace, tox) prints one summary per
    // package. Assigning kept only the last, so an earlier package's failures vanished
    // and a trailing empty package zeroed the total.

    it('parseTestOutput_monorepoVitestV2_accumulatesEveryPackage', () => {
      const output = [
        ' Tests  5 passed (5)',
        ' Tests  2 failed | 3 passed (5)',
      ].join('\n');

      const result = parseTestOutput(output, 1);

      expect(result.passed).toBe(8);
      expect(result.failed).toBe(2);
      expect(result.total).toBe(10);
      expect(result.succeeded).toBe(false);
    });

    it('parseTestOutput_monorepoVitestV1_accumulatesEveryPackage', () => {
      const output = ['Tests: 3 passed, 3 total', 'Tests: 4 passed, 1 failed, 5 total'].join('\n');

      const result = parseTestOutput(output, 1);

      expect(result.passed).toBe(7);
      expect(result.failed).toBe(1);
      expect(result.total).toBe(8);
    });

    it('parseTestOutput_monorepoRust_failingEarlierCrateIsNotHiddenByGreenLastCrate', () => {
      const output = [
        'test result: FAILED. 4 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out',
        'test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out',
      ].join('\n');

      const result = parseTestOutput(output, 101);

      expect(result.passed).toBe(7);
      expect(result.failed).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.total).toBe(10);
      expect(result.succeeded).toBe(false);
    });

    it('parseTestOutput_monorepoRust_trailingEmptyCrateDoesNotZeroTheTotal', () => {
      const output = [
        'test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
        'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
      ].join('\n');

      const result = parseTestOutput(output, 0);

      expect(result.total).toBe(6);
      expect(isZeroCollected(result)).toBe(false);
      expect(result.succeeded).toBe(true);
    });

    it('parseTestOutput_monorepoPytest_accumulatesEveryPackage', () => {
      const output = [
        '===== 4 passed in 0.50s =====',
        '===== 1 failed, 2 passed in 0.70s =====',
      ].join('\n');

      const result = parseTestOutput(output, 1);

      expect(result.passed).toBe(6);
      expect(result.failed).toBe(1);
      expect(result.total).toBe(7);
      expect(result.succeeded).toBe(false);
    });

    // ── false-green: a package that never ran its tests ───────────────────────

    it('parseTestOutput_projectCollectedNoTests_failsEvenWhenRunnerExitsZero', () => {
      // vitest exits 0 after a pool/worker crash, and the other package's summary
      // lands last — the healthy tallies used to hide the dead project completely.
      const output = [
        ' Tests  no tests',
        ' Tests  12 passed (12)',
      ].join('\n');

      const result = parseTestOutput(output, 0);

      expect(result.deadProjects).toBe(1);
      expect(result.passed).toBe(12);
      expect(result.succeeded).toBe(false);
    });

    it('parseTestOutput_reportedErrorsOutsideCounts_failsEvenWhenAllCollectedPass', () => {
      const output = [
        ' Tests  8 passed (8)',
        ' Errors  2 errors',
      ].join('\n');

      const result = parseTestOutput(output, 0);

      expect(result.errorCount).toBe(2);
      expect(result.succeeded).toBe(false);
    });

    it('parseTestOutput_reportedErrors_matchedBehindWorkspaceRunnerPrefix', () => {
      // `pnpm -r` prefixes every line with "<pkg> test: ", so an anchored pattern
      // would silently never match in the exact monorepo case this exists for.
      const output = [
        'web test:  Tests  8 passed (8)',
        'web test:  Errors  1 error',
      ].join('\n');

      const result = parseTestOutput(output, 0);

      expect(result.errorCount).toBe(1);
      expect(result.succeeded).toBe(false);
    });

    it('parseTestOutput_proseMentioningErrors_isNotCountedAsReportedErrors', () => {
      // The two-space gap before the count is what keeps prose from matching.
      const output = ['Tests: 3 passed, 3 total', 'Errors 1 error was logged by the app'].join('\n');

      const result = parseTestOutput(output, 0);

      expect(result.errorCount).toBe(0);
      expect(result.succeeded).toBe(true);
    });

    it('parseTestOutput_singleCleanRun_hasNoDeadProjectsOrErrors', () => {
      const result = parseTestOutput('Tests: 5 passed, 5 total', 0);

      expect(result.deadProjects).toBe(0);
      expect(result.errorCount).toBe(0);
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
    const { testPassed } = require('../../../.agents/core/gate');

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
      return require('../../../.agents/core/gate').loadConfig;
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
      // Also LOW (F31-analog): the build is argv-mode multi-leg, not a shell
      // string — see loadConfig_python_argvMode_hardensAgainstShellInterpolation.
      tmp.write('pyproject.toml', '[project]\nname = "x"\n[dependency-groups]\ndev = ["pytest", "ruff"]');
      const loadConfig = freshLoadConfig();

      const config = loadConfig();

      expect(config.stack).toBe('python');
      expect(config.build.command).toBeUndefined();
      expect(config.build.legs).toEqual([
        { argv: ['ruff', 'check', 'src', 'tests'] },
        { argv: ['ruff', 'format', '--check', 'src', 'tests'] },
      ]);
    });

    it('loadConfig_C1_python_mypyDeclared_includesMypyLeg', () => {
      // When the project DOES declare mypy, run it.
      tmp.write('pyproject.toml', '[project]\nname = "x"\n[tool.mypy]\nstrict = true');
      const loadConfig = freshLoadConfig();

      const config = loadConfig();

      expect(config.build.legs).toHaveLength(3);
      expect(config.build.legs[2]).toEqual({ argv: ['mypy', '--strict', 'src'] });
    });

    it('loadConfig_python_testLeg_isArgvMode', () => {
      // LOW (F31-analog): pytest must run argv-mode too — `${prefix}pytest` was
      // the same shell-interpolation hazard as the ruff/mypy legs.
      tmp.write('pyproject.toml', '[project]\nname = "x"\n[dependency-groups]\ndev = ["pytest", "ruff"]');
      const loadConfig = freshLoadConfig();

      const config = loadConfig();

      expect(config.test.command).toBeUndefined();
      expect(config.test.argv).toEqual(['pytest']);
    });

    it('loadConfig_python_argvMode_hardensAgainstShellInterpolation', () => {
      // LOW: gate.js ran Python legs under shell:true, interpolating PROJECT_ROOT
      // (via the .venv/bin prefix) into the shell string. A checkout path with a
      // shell metachar (e.g. `/home/<name>/my repo;id/`) would execute the `;id`
      // segment. This asserts the fix directly: a PROJECT_ROOT containing a
      // space + `;` metachar must still produce argv-mode legs whose elements
      // carry the raw venv path verbatim as ONE argv element — never
      // concatenated into a shell string that a shell could reinterpret.
      const hostileTmp = createTmpDir({ prefix: 'gate py hostile;id-' });
      try {
        hostileTmp.write('pyproject.toml', '[project]\nname = "x"\n[tool.mypy]\nstrict = true');
        const venvBinDir = path.join(hostileTmp.root, '.venv', 'bin');
        fs.mkdirSync(venvBinDir, { recursive: true });
        fs.writeFileSync(path.join(venvBinDir, 'ruff'), '');
        fs.writeFileSync(path.join(venvBinDir, 'mypy'), '');
        fs.writeFileSync(path.join(venvBinDir, 'pytest'), '');

        process.env.CLAUDE_PROJECT_DIR = hostileTmp.root;
        delete require.cache[GATE_PATH];
        const config = require('../../../.agents/core/gate').loadConfig();

        expect(config.stack).toBe('python');
        // No shell-command string anywhere in build/test — argv-mode only.
        expect(config.build.command).toBeUndefined();
        expect(config.test.command).toBeUndefined();

        const expectedRuff = path.join(venvBinDir, 'ruff');
        const expectedMypy = path.join(venvBinDir, 'mypy');
        const expectedPytest = path.join(venvBinDir, 'pytest');

        expect(config.build.legs).toEqual([
          { argv: [expectedRuff, 'check', 'src', 'tests'] },
          { argv: [expectedRuff, 'format', '--check', 'src', 'tests'] },
          { argv: [expectedMypy, '--strict', 'src'] },
        ]);
        expect(config.test.argv).toEqual([expectedPytest]);

        // The hostile path segment survives verbatim as part of a single argv
        // element (never split into a separate token the way a shell would).
        expect(config.build.legs[0].argv[0]).toContain(';id');
        expect(config.build.legs[0].argv).toHaveLength(4); // [bin, 'check', 'src', 'tests'] — no extra tokens
      } finally {
        delete require.cache[GATE_PATH];
        hostileTmp.cleanup();
      }
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

    it.each(['sln', 'slnx'])('loadConfig_dependencyOnlyPackageAnd%s_usesApplicationDotnetGate', extension => {
      tmp.write(`MyApp.${extension}`, extension === 'slnx' ? '<Solution />' : 'Microsoft Visual Studio Solution File');
      tmp.write('package.json', JSON.stringify({ private: true, devDependencies: { '@playwright/test': 'fixture' } }));
      const config = freshLoadConfig()();
      expect(config.stack).toBe('dotnet');
      expect(config.build.argv).toEqual(['dotnet', 'build', `MyApp.${extension}`, '--configuration', 'Release', '--verbosity', 'minimal']);
      expect(config.test.argv).toEqual(['dotnet', 'test', `MyApp.${extension}`, '--configuration', 'Release', '--verbosity', 'minimal', '--no-build']);
    });

    it('loadConfig_dependencyOnlyPackagePartialPolicy_preservesDotnetBuildAndTest', () => {
      tmp.write('MyApp.slnx', '<Solution />');
      tmp.write('package.json', JSON.stringify({ devDependencies: { '@playwright/test': 'fixture' } }));
      tmp.write('.claude/gate.config.json', JSON.stringify({ lint: { command: 'application-lint', timeout: 1000 } }));
      const config = freshLoadConfig()();
      expect(config.build.argv.slice(0, 3)).toEqual(['dotnet', 'build', 'MyApp.slnx']);
      expect(config.test.argv.slice(0, 3)).toEqual(['dotnet', 'test', 'MyApp.slnx']);
      expect(config.lint.command).toBe('application-lint');
    });

    it('loadConfig_dependencyOnlyPackageWithExplicitNodePolicy_preservesOwnerCommands', () => {
      tmp.write('MyApp.slnx', '<Solution />');
      tmp.write('package.json', JSON.stringify({ devDependencies: { '@playwright/test': 'fixture' } }));
      tmp.write('.claude/gate.config.json', JSON.stringify({ stack: 'node', build: { command: 'owner-build' }, test: { command: 'owner-test' } }));
      const config = freshLoadConfig()();
      expect(config.stack).toBe('node');
      expect(config.build.command).toBe('owner-build');
      expect(config.test.command).toBe('owner-test');
    });

    it('loadConfig_mixedSolutionWithNodeScripts_preservesNodeBuildAndTest', () => {
      tmp.write('MyApp.slnx', '<Solution />');
      tmp.write('package.json', JSON.stringify({ scripts: { build: 'fixture-build', test: 'fixture-test' } }));
      const config = freshLoadConfig()();
      expect(config.stack).toBe('node');
      expect(config.build.command).toBe('npm run build');
      expect(config.test.command).toBe('npm test');
    });

    it.each(['config', 'devDependency', 'dependency'])('loadConfig_mixedSolutionWithTypeScript_%s_preservesNodeDetection', source => {
      tmp.write('MyApp.slnx', '<Solution />');
      const pkg = source === 'config' ? {} : { [source === 'devDependency' ? 'devDependencies' : 'dependencies']: { typescript: 'fixture' } };
      tmp.write('package.json', JSON.stringify(pkg));
      if (source === 'config') tmp.write('tsconfig.json', '{}');
      const config = freshLoadConfig()();
      expect(config.stack).toBe('node');
      expect(config.build.command).toBe('npx tsc --noEmit');
    });

    it('loadConfig_mixedSolutionWithPartialBuildPolicy_preservesOwnerBuildAndDotnetTest', () => {
      tmp.write('MyApp.slnx', '<Solution />');
      tmp.write('package.json', JSON.stringify({ devDependencies: { '@playwright/test': 'fixture' } }));
      tmp.write('.claude/gate.config.json', JSON.stringify({ build: { command: 'owner-build' } }));
      const config = freshLoadConfig()();
      expect(config.stack).toBe('dotnet');
      expect(config.build.command).toBe('owner-build');
      expect(config.test.argv.slice(0, 3)).toEqual(['dotnet', 'test', 'MyApp.slnx']);
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
      tmp.write('package.json', JSON.stringify({ devDependencies: { '@playwright/test': 'fixture' } }));
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
      return require('../../../.agents/core/gate');
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

    // GATE_DIR = docs/.output/.state/telemetry inside PROJECT_ROOT
    function gateDir() {
      const dir = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
    function lockPath() { return path.join(gateDir(), '.gate.lock'); }
    // A PID guaranteed not to be running: spawn a child that exits immediately;
    // by the time spawnSync returns, that PID is dead. Used to exercise the
    // stale-break path's liveness gate deterministically.
    function deadPid() {
      const { spawnSync } = require('node:child_process');
      const r = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
      return r.pid;
    }

    // The lock protocol this platform's gate writes: the Windows owned lease, or
    // the uncontained POSIX protocol elsewhere. Windows-only recovery stays
    // Windows-only; every other platform breaks a verified dead-owner idle lock itself.
    const producerProtocol = process.platform === 'win32' ? 'domdhi-gate/lease-v2' : 'domdhi-gate/uncontained-posix-v1';

    it('acquireLock_staleLockDeadOwner_breaksAndReturnsTrue', () => {
      // Arrange — lock older than STALE_LOCK_MS whose owner is dead
      const staleTime = new Date(Date.now() - 2000000).toISOString(); // ~33m > 30m ceiling
      fs.writeFileSync(lockPath(), JSON.stringify({ protocol: producerProtocol, phase: 'idle', pid: deadPid(), started: staleTime }));

      const { acquireLock } = freshGate();

      // Act
      const result = acquireLock();

      // Assert — abandoned lock (old + dead owner) is broken and acquire succeeds
      expect(result).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('acquireLock_staleUncontainedPosixLockDeadOwner_isBrokenAndReacquired', () => {
      const staleTime = new Date(Date.now() - 2000000).toISOString();
      fs.writeFileSync(lockPath(), JSON.stringify({ protocol: 'domdhi-gate/uncontained-posix-v1', phase: 'idle', pid: deadPid(), started: staleTime }));
      const { acquireLock, releaseLock } = freshGate();

      expect(acquireLock()).toBe(true);
      const held = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
      expect(held).toMatchObject({ pid: process.pid, protocol: 'domdhi-gate/uncontained-posix-v1', phase: 'idle' });
      releaseLock();
    });

    it.skipIf(process.platform === 'win32')('acquireLock_uncontainedPosixLock_withLiveOwnerOrLiveChildOrFreshAge_isPreservedExactly', () => {
      const old = new Date(Date.now() - 2000000).toISOString();
      const fresh = new Date(Date.now() - 1000).toISOString();
      const { acquireLock } = freshGate();
      for (const lock of [
        { protocol: 'domdhi-gate/uncontained-posix-v1', phase: 'idle', pid: process.pid, started: old },
        { protocol: 'domdhi-gate/uncontained-posix-v1', phase: 'idle', pid: deadPid(), started: old, childPid: process.pid },
        { protocol: 'domdhi-gate/uncontained-posix-v1', phase: 'idle', pid: deadPid(), started: fresh },
        { protocol: 'domdhi-gate/uncontained-posix-v1', phase: 'running', treeInProgress: true, pid: deadPid(), started: old },
      ]) {
        const original = JSON.stringify(lock);
        fs.writeFileSync(lockPath(), original);
        expect(acquireLock(), original).toBe(false);
        expect(fs.readFileSync(lockPath(), 'utf8')).toBe(original);
      }
    });

    // Outside Windows no lease helper can recover a lock, so the gate retires abandoned
    // legacy and unreadable locks itself, on positive proof only, keeping their bytes.
    describe.skipIf(process.platform === 'win32')('POSIX abandoned legacy and unreadable locks', () => {
      const old = () => new Date(Date.now() - 2000000).toISOString();
      const kept = () => fs.readdirSync(gateDir()).filter(name => name.startsWith('.gate.lock.abandoned-'));
      function ageFile(seconds) {
        const when = new Date(Date.now() - seconds * 1000);
        fs.utimesSync(lockPath(), when, when);
      }

      it('acquireLock_legacyPidStartedLock_staleWithDeadOwner_isBrokenAndItsBytesKept', () => {
        const original = JSON.stringify({ pid: deadPid(), started: old() });
        fs.writeFileSync(lockPath(), original);
        const { acquireLock, releaseLock } = freshGate();
        expect(acquireLock()).toBe(true);
        expect(JSON.parse(fs.readFileSync(lockPath(), 'utf8'))).toMatchObject({ pid: process.pid, protocol: 'domdhi-gate/uncontained-posix-v1' });
        expect(kept().map(name => fs.readFileSync(path.join(gateDir(), name), 'utf8'))).toEqual([original]);
        releaseLock();
      });

      it.each([
        ['fresh age', () => ({ pid: deadPid(), started: new Date(Date.now() - 1000).toISOString() })],
        ['live owner', () => ({ pid: process.pid, started: old() })],
        ['live child', () => ({ pid: deadPid(), started: old(), childPid: process.pid })],
        ['running tree marker', () => ({ pid: deadPid(), started: old(), treeInProgress: true })],
        ['unconfirmed termination', () => ({ pid: deadPid(), started: old(), terminationUnconfirmed: true })],
        ['unknown phase', () => ({ pid: deadPid(), started: old(), phase: 'running' })],
        ['unparseable start time', () => ({ pid: deadPid(), started: 'not a date' })],
        ['Windows lease protocol, which only the lease helper may recover', () => ({ protocol: 'domdhi-gate/lease-v2', phase: 'idle', pid: deadPid(), started: old() })],
      ])('acquireLock_legacyShapedLock_%s_isHeldWithExactBytesAndNothingKept', (_name, build) => {
        const original = JSON.stringify(build());
        fs.writeFileSync(lockPath(), original);
        const { acquireLock } = freshGate();
        expect(acquireLock()).toBe(false);
        expect(fs.readFileSync(lockPath(), 'utf8')).toBe(original);
        expect(kept()).toEqual([]);
      });

      it.each([
        ['empty file', ''],
        ['truncated JSON', '{"pid":'],
        ['non-object JSON', 'null'],
      ])('acquireLock_unreadableLock_%s_pastTheStaleCeiling_isBrokenAndItsBytesKept', (_name, content) => {
        fs.writeFileSync(lockPath(), content);
        ageFile(2000);
        const { acquireLock, releaseLock } = freshGate();
        expect(acquireLock()).toBe(true);
        expect(kept().map(name => fs.readFileSync(path.join(gateDir(), name), 'utf8'))).toEqual([content]);
        releaseLock();
      });

      it.each(['', '{"pid":'])('acquireLock_unreadableLock_%j_writtenJustNow_isHeldBecauseAGateMayStillBeWritingIt', content => {
        fs.writeFileSync(lockPath(), content);
        const { acquireLock } = freshGate();
        expect(acquireLock()).toBe(false);
        expect(fs.readFileSync(lockPath(), 'utf8')).toBe(content);
        expect(kept()).toEqual([]);
      });

      it('acquireLock_unreadableLock_replacedByALiveLockBeforeTheBreak_isNotDeleted', () => {
        fs.writeFileSync(lockPath(), '');
        ageFile(2000);
        const replacement = JSON.stringify({ protocol: 'domdhi-gate/uncontained-posix-v1', phase: 'idle', pid: process.pid, started: new Date().toISOString() });
        const { acquireLock } = freshGate();
        const realRead = fs.readFileSync;
        let reads = 0;
        const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
          const bytes = realRead(file, ...rest);
          if (file === lockPath() && ++reads === 1) fs.writeFileSync(file, replacement);
          return bytes;
        });
        try {
          expect(acquireLock()).toBe(false);
          expect(realRead(lockPath(), 'utf8')).toBe(replacement);
          expect(kept()).toEqual([]);
        } finally { spy.mockRestore(); }
      });
    });

    it('acquireLock_staleOwnerWithLiveChild_preservesTheExactLock', () => {
      const original = JSON.stringify({
        pid: deadPid(),
        started: new Date(Date.now() - 2000000).toISOString(),
        childPid: process.pid,
      });
      fs.writeFileSync(lockPath(), original);
      const { acquireLock } = freshGate();

      expect(acquireLock()).toBe(false);
      expect(fs.readFileSync(lockPath(), 'utf8')).toBe(original);
    });

    it.each([
      { treeInProgress: true },
      { treeInProgress: false },
      { terminationUnconfirmed: true },
    ])('acquireLock_unresolvedTreeHazard_%j_preservesTheExactLock', (hazard) => {
      // A vanished wrapper and shell do not establish that grandchildren exited.
      // Ordinary acquire cannot replace the explicit recovery evidence path.
      const original = JSON.stringify({
        pid: deadPid(),
        childPid: deadPid(),
        started: new Date(Date.now() - 2000000).toISOString(),
        ...hazard,
      });
      fs.writeFileSync(lockPath(), original);
      const { acquireLock } = freshGate();

      expect(acquireLock()).toBe(false);
      expect(fs.readFileSync(lockPath(), 'utf8')).toBe(original);
    });

    it('acquireLock_staleOwnerWithUnknownChildIdentity_preservesTheExactLock', () => {
      const original = JSON.stringify({
        pid: deadPid(),
        started: new Date(Date.now() - 2000000).toISOString(),
        childPid: null,
      });
      fs.writeFileSync(lockPath(), original);
      const { acquireLock } = freshGate();

      expect(acquireLock()).toBe(false);
      expect(fs.readFileSync(lockPath(), 'utf8')).toBe(original);
    });

    it.each([0, null])('acquireLock_unknownOwner_%s_preservesTheExactLock', (pid) => {
      const original = JSON.stringify({ protocol: 'domdhi-gate/lease-v2', phase: 'idle', pid, started: new Date(Date.now() - 2000000).toISOString() });
      fs.writeFileSync(lockPath(), original);
      const { acquireLock } = freshGate();
      expect(acquireLock()).toBe(false);
      expect(fs.readFileSync(lockPath(), 'utf8')).toBe(original);
    });

    it('acquireLock_deniedProcessProbe_preservesTheExactLock', () => {
      const owner = deadPid();
      const original = JSON.stringify({ protocol: 'domdhi-gate/lease-v2', phase: 'idle', pid: owner, started: new Date(Date.now() - 2000000).toISOString() });
      fs.writeFileSync(lockPath(), original);
      const { acquireLock } = freshGate();
      const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
      try {
        expect(acquireLock()).toBe(false);
        expect(fs.readFileSync(lockPath(), 'utf8')).toBe(original);
      } finally { probe.mockRestore(); }
    });

    it('acquireLock_corruptPayload_preservesDiagnosticBytes', () => {
      const original = '{interrupted write';
      fs.writeFileSync(lockPath(), original);
      const { acquireLock } = freshGate();
      expect(acquireLock()).toBe(false);
      expect(fs.readFileSync(lockPath(), 'utf8')).toBe(original);
    });

    it('acquireLock_oldLockLiveOwner_doesNotBreak_returnsFalse', () => {
      // Arrange — lock is OLD (past the ceiling) but its owner is STILL ALIVE.
      // This is the legitimately-long-suite case: it must NOT be broken. Use this
      // process's own PID as a guaranteed-live owner.
      const oldTime = new Date(Date.now() - 2000000).toISOString(); // ~33m > 30m ceiling
      fs.writeFileSync(lockPath(), JSON.stringify({ protocol: 'domdhi-gate/lease-v2', phase: 'idle', pid: process.pid, started: oldTime }));

      const { acquireLock } = freshGate();

      // Act
      const result = acquireLock();

      // Assert — live owner is never broken regardless of age
      expect(result).toBe(false);
      // And the owner's lock is untouched
      const stillThere = JSON.parse(fs.readFileSync(lockPath(), 'utf-8'));
      expect(stillThere.pid).toBe(process.pid);
      expect(stillThere.started).toBe(oldTime);
    });

    it('acquireLock_midAgeLock_doesNotBreak_returnsFalse', () => {
      // Arrange — lock older than the OLD 10-min ceiling but under the new 30-min
      // one, dead owner. Proves the ceiling was actually raised: this would have
      // broken under the old 600000ms threshold, must not now.
      const { STALE_LOCK_MS } = require('../../../.agents/core/gate');
      expect(STALE_LOCK_MS).toBe(1800000);
      const midTime = new Date(Date.now() - 1000000).toISOString(); // ~16m: >10m, <30m
      fs.writeFileSync(lockPath(), JSON.stringify({ protocol: 'domdhi-gate/lease-v2', phase: 'idle', pid: deadPid(), started: midTime }));

      const { acquireLock } = freshGate();

      // Act
      const result = acquireLock();

      // Assert — not yet stale under the raised ceiling
      expect(result).toBe(false);
    });

    it('acquireLock_freshLock_returnsFalse', () => {
      // Arrange — write a fresh lock (a few seconds old)
      const freshTime = new Date(Date.now() - 5000).toISOString(); // 5s old
      fs.writeFileSync(lockPath(), JSON.stringify({ protocol: 'domdhi-gate/lease-v2', phase: 'idle', pid: process.pid + 1, started: freshTime }));

      const { acquireLock } = freshGate();

      // Act
      const result = acquireLock();

      // Assert — active fresh lock blocks acquire
      expect(result).toBe(false);
    });

    // ─── ownership guard (the race this story closes) ───────────────────────
    // Gate A's lock gets broken by B (a slow suite past a too-short ceiling), B
    // installs its own lock, then A exits and its releaseLock() must NOT delete
    // B's lock — else a third gate runs concurrently against the same tree.

    it('releaseLock_foreignLock_doesNotDelete', () => {
      // Arrange — a lock owned by ANOTHER process; this process never acquired it
      const foreign = { pid: deadPid(), started: new Date(Date.now() - 1000).toISOString() };
      fs.writeFileSync(lockPath(), JSON.stringify(foreign));

      const { releaseLock } = freshGate(); // ownLockStarted is null in this fresh module

      // Act
      releaseLock();

      // Assert — foreign lock is left intact for its real owner
      expect(fs.existsSync(lockPath())).toBe(true);
      const after = JSON.parse(fs.readFileSync(lockPath(), 'utf-8'));
      expect(after.pid).toBe(foreign.pid);
      expect(after.started).toBe(foreign.started);
    });

    it('releaseLock_lockReplacedAfterAcquire_doesNotDeleteReplacement', () => {
      // Arrange — THIS process acquires, then its lock is broken+replaced by a new
      // owner reusing the SAME pid but a different `started` (the PID-reuse edge
      // the started-match guard defends). releaseLock must honor `started`, not
      // pid alone, and leave the replacement intact.
      const { acquireLock, releaseLock } = freshGate();
      acquireLock();
      const replacement = { pid: process.pid, started: new Date(Date.now() + 1000).toISOString() };
      fs.writeFileSync(lockPath(), JSON.stringify(replacement));

      // Act
      releaseLock();

      // Assert — replacement (different `started`) survives
      expect(fs.existsSync(lockPath())).toBe(true);
      const after = JSON.parse(fs.readFileSync(lockPath(), 'utf-8'));
      expect(after.started).toBe(replacement.started);
    });

    it('releaseLock_ownLock_deletesFile', () => {
      // Arrange — this process legitimately owns the lock
      const { acquireLock, releaseLock } = freshGate();
      acquireLock();
      expect(fs.existsSync(lockPath())).toBe(true);

      // Act
      releaseLock();

      // Assert — own lock IS removed
      expect(fs.existsSync(lockPath())).toBe(false);
    });

    it('isProcessAlive_selfPid_true_deadPid_false', () => {
      const { isProcessAlive } = freshGate();
      expect(isProcessAlive(process.pid)).toBe(true);
      expect(isProcessAlive(deadPid())).toBe(false);
      expect(isProcessAlive(-1)).toBe(false);
      expect(isProcessAlive('nan')).toBe(false);
    });

    // ─── stale-break race (the TOCTOU this fix closes) ──────────────────────
    // Two gates can independently observe the SAME stale+dead lock and both
    // decide to break it. The first breaks it and installs its own fresh, LIVE
    // lock; the second must NOT then unlink that live lock (which would let both
    // run concurrently against the same tree). We inject the race by swapping the
    // on-disk lock between the inspection read and the pre-unlink re-read.

    it('acquireLock_twoProcessesRaceStaleBreak_loserDoesNotDeleteFreshLock', () => {
      // Arrange — a stale, dead-owner lock both gates would agree to break
      const staleTime = new Date(Date.now() - 2000000).toISOString(); // ~33m
      const stale = { protocol: producerProtocol, phase: 'idle', pid: deadPid(), started: staleTime };
      fs.writeFileSync(lockPath(), JSON.stringify(stale));

      const { acquireLock } = freshGate();

      // The winner's fresh, LIVE lock that lands in the break window (this
      // process's own pid → guaranteed alive, different `started`).
      const freshLive = { pid: process.pid, started: new Date().toISOString() };
      const realRead = fs.readFileSync;
      let lockReads = 0;
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
        const data = realRead(p, ...rest);
        if (typeof p === 'string' && p.endsWith('.gate.lock')) {
          lockReads += 1;
          // After OUR inspection read (which returns the stale content captured
          // above), the winner breaks the stale lock and installs its live one —
          // so our pre-unlink re-read sees a DIFFERENT lock.
          if (lockReads === 1) fs.writeFileSync(lockPath(), JSON.stringify(freshLive));
        }
        return data;
      });

      // Act
      let result;
      try {
        result = acquireLock();
      } finally {
        spy.mockRestore();
      }

      // Assert — we lost the break race and must be blocked, NOT holding a lock we
      // stole by deleting the winner's live one.
      expect(result).toBe(false);
      expect(fs.existsSync(lockPath())).toBe(true);
      const after = JSON.parse(fs.readFileSync(lockPath(), 'utf-8'));
      expect(after.pid).toBe(freshLive.pid);
      expect(after.started).toBe(freshLive.started);
    });

    it.each([
      { childPid: process.pid },
      { treeInProgress: true },
      { treeInProgress: false },
      { terminationUnconfirmed: true },
      { leaseId: 'replacement-lease' },
    ])('acquireLock_changedPayloadBeforeUnlink_%j_preservesReplacement', (change) => {
      const stale = { protocol: producerProtocol, phase: 'idle', pid: deadPid(), started: new Date(Date.now() - 2000000).toISOString() };
      const replacement = JSON.stringify({ ...stale, ...change });
      fs.writeFileSync(lockPath(), JSON.stringify(stale));
      const { acquireLock } = freshGate();
      const realRead = fs.readFileSync;
      let reads = 0;
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
        const bytes = realRead(file, ...rest);
        if (file === lockPath() && ++reads === 1) fs.writeFileSync(file, replacement);
        return bytes;
      });
      try {
        expect(acquireLock()).toBe(false);
        expect(realRead(lockPath(), 'utf8')).toBe(replacement);
      } finally { spy.mockRestore(); }
    });

    it('acquireLock_probeBecomesUnknownBeforeUnlink_preservesExactBytes', () => {
      const owner = deadPid();
      const original = JSON.stringify({ protocol: producerProtocol, phase: 'idle', pid: owner, started: new Date(Date.now() - 2000000).toISOString() });
      fs.writeFileSync(lockPath(), original);
      const { acquireLock } = freshGate();
      const realKill = process.kill.bind(process);
      let probes = 0;
      const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid !== owner) return realKill(pid, signal);
        throw Object.assign(new Error('probe'), { code: ++probes === 1 ? 'ESRCH' : 'EACCES' });
      });
      try {
        expect(acquireLock()).toBe(false);
        expect(fs.readFileSync(lockPath(), 'utf8')).toBe(original);
        expect(probes).toBe(2);
      } finally { spy.mockRestore(); }
    });

    it('acquireLock_staleBreakUnlinkENOENT_doesNotThrow_reacquires', () => {
      // Arrange — a stale, dead-owner lock. Simulate another gate breaking it in
      // the window between our matching re-read and our unlink, so our own unlink
      // hits ENOENT. That must be treated as "someone else broke it", not crash.
      const staleTime = new Date(Date.now() - 2000000).toISOString(); // ~33m
      const stale = { protocol: producerProtocol, phase: 'idle', pid: deadPid(), started: staleTime };
      fs.writeFileSync(lockPath(), JSON.stringify(stale));

      const { acquireLock } = freshGate();

      const realRead = fs.readFileSync;
      let lockReads = 0;
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
        if (typeof p === 'string' && p.endsWith('.gate.lock')) {
          lockReads += 1;
          // Re-read (#2) still MATCHES the stale lock (so we proceed to unlink),
          // but the file vanishes right after — the next unlink will ENOENT.
          if (lockReads === 2) { fs.unlinkSync(lockPath()); return JSON.stringify(stale); }
          if (lockReads === 1) return JSON.stringify(stale);
        }
        return realRead(p, ...rest);
      });

      // Act
      let result;
      try {
        result = (() => acquireLock())();
      } finally {
        spy.mockRestore();
      }

      // Assert — no throw; the vanished lock lets us cleanly reacquire.
      expect(result).toBe(true);
      const after = JSON.parse(fs.readFileSync(lockPath(), 'utf-8'));
      expect(after.pid).toBe(process.pid);
    });
  });

  describe('runCommand — stderr capture (F31)', () => {
    const { runCommand, describeLeg, legRunnable } = require('../../../.agents/core/gate');

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

  describe('runCommand — multi-leg (LOW python argv fix)', () => {
    const { runCommand } = require('../../../.agents/core/gate');

    it('runs every leg and reports exitCode 0 when all legs pass', () => {
      const r = runCommand({
        legs: [
          { argv: ['node', '-e', 'console.log("leg1")'] },
          { argv: ['node', '-e', 'console.log("leg2")'] },
        ],
      }, process.cwd(), 30000);

      expect(r.exitCode).toBe(0);
      expect(r.output).toContain('leg1');
      expect(r.output).toContain('leg2');
    });

    it('stops at the first failing leg and does not run the rest (&& short-circuit)', () => {
      const r = runCommand({
        legs: [
          { argv: ['node', '-e', 'console.log("leg1"); process.exit(1)'] },
          { argv: ['node', '-e', 'console.log("leg2-should-not-run")'] },
        ],
      }, process.cwd(), 30000);

      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('leg1');
      expect(r.output).not.toContain('leg2-should-not-run');
    });

    it('concatenates stdout/stderr across legs in run order for the shared parsers', () => {
      const r = runCommand({
        legs: [
          { argv: ['node', '-e', 'console.error("err1")'] },
          { argv: ['node', '-e', 'console.error("err2")'] },
        ],
      }, process.cwd(), 30000);

      expect(r.exitCode).toBe(0);
      expect(r.stderr.indexOf('err1')).toBeLessThan(r.stderr.indexOf('err2'));
    });
  });

  describe('describeLeg / legRunnable (F31 display + dispatch helpers)', () => {
    const { describeLeg, legRunnable } = require('../../../.agents/core/gate');

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

    it('describeLeg renders a multi-leg config joined with " && " (reads like the shell chain it replaces)', () => {
      const leg = {
        legs: [
          { argv: ['ruff', 'check', 'src', 'tests'] },
          { argv: ['ruff', 'format', '--check', 'src', 'tests'] },
          { argv: ['mypy', '--strict', 'src'] },
        ],
        timeout: 300000,
      };
      expect(describeLeg(leg)).toBe('ruff check src tests && ruff format --check src tests && mypy --strict src');
    });

    it('legRunnable normalizes a multi-leg config to { legs: [...runnable] } for runCommand dispatch', () => {
      const leg = {
        legs: [
          { argv: ['ruff', 'check', 'src', 'tests'] },
          { command: 'echo hi' },
        ],
        timeout: 300000,
      };
      expect(legRunnable(leg)).toEqual({
        legs: [
          { argv: ['ruff', 'check', 'src', 'tests'] },
          'echo hi',
        ],
      });
    });
  });
});
