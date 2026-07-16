/**
 * git.js — the ONE git-exec wrapper for every core/ CLI (F27).
 *
 * Extracted from branch-audit.js (the most capable of the three copies that
 * used to exist — commit.js and pull-request.js each declared a bare subset
 * that never received this version's MSYS + porcelain fixes). commit.js,
 * pull-request.js, and branch-audit.js all consume this module now; declaring
 * a local `function git(...)` in a core/ CLI is a regression.
 *
 * `argv` is an argument ARRAY passed straight to git via execFileSync — NO
 * shell, so a branch name containing $(), backticks, ;, |, & can never be
 * interpreted as a command (was the RCE in the old string-interpolated
 * execSync). Every call site passes an array; string args are a programming
 * error.
 */

'use strict';

const { execFileSync } = require('node:child_process');

/**
 * Run git with the given argv array. Trims the output by default.
 *
 * @param {string[]} argv       git arguments (never a shell string)
 * @param {object}   [opts]
 * @param {string}   [opts.cwd] working directory (default: process.cwd())
 * @param {boolean}  [opts.raw] keep leading whitespace — porcelain XY status
 *                              lines start with a space; a blanket .trim()
 *                              would eat the first line's leading space and
 *                              shift the path. Trailing newlines still drop.
 * @returns {string}
 */
function git(argv, { cwd, raw } = {}) {
  // git names with slashes mangle under MSYS path-conversion; disable it.
  const out = execFileSync('git', argv, {
    encoding: 'utf8',
    cwd: cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  return raw ? out.replace(/\n+$/, '') : out.trim();
}

/** git() that swallows failure to '' — for optional/corroborating reads. */
function gitSafe(args, o) { try { return git(args, o); } catch { return ''; } }

/** git() as a boolean probe — true when the command exits 0. */
function gitOk(args, o) { try { git(args, o); return true; } catch { return false; } }

module.exports = { git, gitSafe, gitOk };
