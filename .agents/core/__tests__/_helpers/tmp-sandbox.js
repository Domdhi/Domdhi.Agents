/**
 * Per-test-file temp sandbox.
 * CommonJS (not ESM) so the vitest setup file and the unit tests share one implementation.
 *
 * Tests resolve their scratch space through os.tmpdir(), which Node reads from TMPDIR (TMP/TEMP on
 * Windows) on every call, and child processes inherit that environment. enterTmpSandbox() points all
 * three at a fresh directory; leaveTmpSandbox() restores them and removes the directory tree. Anything
 * a test file, a helper, or a detached child it started created in "the temp dir" is therefore removed
 * when the file finishes, whether or not that test remembered its own cleanup (an unremoved
 * directory per test filled a 9.8 GiB tmpfs and failed 14 e2e tests with ENOSPC).
 *
 * This is a backstop for the lifetime of one test file. Tests still clean up after themselves so a long
 * file does not pile up directories while it runs. Set DOMDHI_TEST_TMP_SANDBOX=off to run without the
 * sandbox, which is how a leaking test is found.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_ENV = ['TMPDIR', 'TMP', 'TEMP'];
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

let active = null;

function sandboxDisabled(env = process.env) {
  return /^(off|0|false)$/i.test(String(env.DOMDHI_TEST_TMP_SANDBOX || ''));
}

/**
 * Redirect os.tmpdir() to a fresh directory. Idempotent while a sandbox is active.
 * @returns {string|null} the sandbox directory, or null when disabled
 */
function enterTmpSandbox() {
  if (sandboxDisabled()) return null;
  if (active) return active.dir;
  const saved = {};
  for (const key of TMP_ENV) saved[key] = process.env[key];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domdhi-tmpbox-'));
  for (const key of TMP_ENV) process.env[key] = dir;
  active = { dir, saved };
  return dir;
}

/**
 * Restore the temp environment and remove the sandbox directory tree.
 * A lock error (Windows EPERM/EBUSY, a late child still writing) is retried; it is never swallowed
 * silently: a directory that cannot be removed is reported to stderr and left for the OS to reap.
 * @returns {boolean} true when a sandbox was active and is now gone
 */
function leaveTmpSandbox() {
  if (!active) return false;
  const { dir, saved } = active;
  active = null;
  for (const key of TMP_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  try {
    fs.rmSync(dir, RM_OPTIONS);
  } catch (err) {
    process.stderr.write(`[tmp-sandbox] could not remove ${dir}: ${err.code || err.message}\n`);
  }
  return !fs.existsSync(dir);
}

module.exports = { enterTmpSandbox, leaveTmpSandbox, sandboxDisabled };
