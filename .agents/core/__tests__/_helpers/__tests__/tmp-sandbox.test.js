import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, '..', 'tmp-sandbox.js');
const ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP', 'DOMDHI_TEST_TMP_SANDBOX'];

// When the vitest setup file is registered it already keeps one sandbox active (in the module instance Node
// cached) for this whole test file. These tests load a FRESH instance so they drive their own enter/leave pair,
// nested inside that outer sandbox, and never touch the outer one.
function freshSandbox() {
  delete require.cache[modulePath];
  return require(modulePath);
}

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
// Run with the opt-out unset even when the suite itself runs with DOMDHI_TEST_TMP_SANDBOX=off.
beforeEach(() => { delete process.env.DOMDHI_TEST_TMP_SANDBOX; });
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('tmp-sandbox', () => {
  it('enterTmpSandbox_default_redirectsOsTmpdirIntoANewDirectory', () => {
    // Arrange
    const sandbox = freshSandbox();

    // Act
    const dir = sandbox.enterTmpSandbox();

    // Assert
    expect(path.basename(dir)).toMatch(/^domdhi-tmpbox-/);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(os.tmpdir()).toBe(dir);
    expect(process.env.TMPDIR).toBe(dir);
    expect(process.env.TMP).toBe(dir);
    expect(process.env.TEMP).toBe(dir);
    sandbox.leaveTmpSandbox();
  });

  it('leaveTmpSandbox_afterTestsWroteInside_removesTheWholeTreeAndRestoresTheEnvironment', () => {
    // Arrange: a test that forgot its own cleanup, one level deep
    const before = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    const sandbox = freshSandbox();
    const dir = sandbox.enterTmpSandbox();
    const leaked = fs.mkdtempSync(path.join(os.tmpdir(), 'na718-'));
    fs.mkdirSync(path.join(leaked, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(leaked, 'a', 'b', 'file.txt'), 'x');

    // Act
    const gone = sandbox.leaveTmpSandbox();

    // Assert
    expect(gone).toBe(true);
    expect(fs.existsSync(leaked)).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
    expect({ TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }).toEqual(before);
  });

  it('enterTmpSandbox_whileActive_returnsTheSameDirectoryInsteadOfNesting', () => {
    // Arrange
    const sandbox = freshSandbox();
    const first = sandbox.enterTmpSandbox();

    // Act
    const second = sandbox.enterTmpSandbox();

    // Assert
    expect(second).toBe(first);
    sandbox.leaveTmpSandbox();
  });

  it('enterTmpSandbox_switchedOffByEnvironment_returnsNullAndLeavesTmpdirAlone', () => {
    // Arrange
    process.env.DOMDHI_TEST_TMP_SANDBOX = 'off';
    const sandbox = freshSandbox();
    const before = os.tmpdir();

    // Act
    const dir = sandbox.enterTmpSandbox();

    // Assert
    expect(dir).toBeNull();
    expect(os.tmpdir()).toBe(before);
    expect(sandbox.leaveTmpSandbox()).toBe(false);
  });

  it('leaveTmpSandbox_withoutEnter_returnsFalse', () => {
    // Arrange
    const sandbox = freshSandbox();

    // Act / Assert
    expect(sandbox.leaveTmpSandbox()).toBe(false);
  });

  it('leaveTmpSandbox_removalFails_reportsToStderrAndStillRestoresTheEnvironment', () => {
    // Arrange
    const before = process.env.TMPDIR;
    const sandbox = freshSandbox();
    const dir = sandbox.enterTmpSandbox();
    const rm = vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Act
    const gone = sandbox.leaveTmpSandbox();

    // Assert
    expect(gone).toBe(false);
    expect(rm).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(`[tmp-sandbox] could not remove ${dir}: EBUSY\n`);
    expect(process.env.TMPDIR).toBe(before);
    rm.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
