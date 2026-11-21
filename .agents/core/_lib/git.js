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
 * @param {Record<string, string>} [opts.env] scoped child overrides; process.env is unchanged
 * @param {boolean}  [opts.raw] keep leading whitespace — porcelain XY status
 *                              lines start with a space; a blanket .trim()
 *                              would eat the first line's leading space and
 *                              shift the path. Trailing newlines still drop.
 * @param {string}   [opts.input] text written to git's stdin (for `--stdin` queries such as
 *                              `check-ignore -z`); stdin is closed otherwise
 * @returns {string}
 */
function git(argv, { cwd, raw, env, input } = {}) {
  if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(env))
      || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
        || typeof value !== 'string' || value.includes('\0')))) {
    throw new TypeError('Git child environment overrides must be an object of valid string entries.');
  }
  // git names with slashes mangle under MSYS path-conversion; disable it.
  const out = execFileSync('git', argv, {
    encoding: 'utf8',
    windowsHide: true,
    cwd: cwd || process.cwd(),
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
    env: { ...process.env, ...env, MSYS_NO_PATHCONV: '1' },
  });
  return raw ? out.replace(/\n+$/, '') : out.trim();
}

/** git() that swallows failure to '' — for optional/corroborating reads. */
function gitSafe(args, o) { try { return git(args, o); } catch { return ''; } }

/** git() as a boolean probe — true when the command exits 0. */
function gitOk(args, o) { try { git(args, o); return true; } catch { return false; } }

// ── the Ship-Check commit trailer ────────────────────────────────────────────
//
// A ship token in a run record is the Main Agent's own word. A wave committed with a plain `git commit -F`, or with
// commit.js without --ship-check, leaves no mark of its own, so a forgetful or headless run could record
// `--ship-token OK` for a commit nothing judged. commit.js therefore writes `Ship-Check: <first 12 of the seal's
// codeHash>` into the commit message on a passing check (the audited skip keeps its own `Ship-Check-Skip: <reason>`
// trailer), and run-record.js (finish --ship-token OK) and run-scoreboard.js look for it in the commit itself, not in
// ignored state that can be lost or written by hand.
//
// The trailer proves the commit went through `commit.js --ship-check` in a checkout whose seal verified. It is not a
// signature: whoever can run git can type the line. It closes the forgetful path and gives the scoreboard something
// checkable; adversarial integrity would need a signing key (see ship-check.js).

const SHIP_CHECK_KEY = 'Ship-Check';
const SHIP_CHECK_SKIP_KEY = 'Ship-Check-Skip';
const SHIP_CHECK_VALUE_LENGTH = 12;
const SHIP_CHECK_LINE = new RegExp(`^${SHIP_CHECK_KEY}: ([0-9a-f]{${SHIP_CHECK_VALUE_LENGTH}})$`, 'm');
const SHIP_CHECK_SKIP_LINE = new RegExp(`^${SHIP_CHECK_SKIP_KEY}: \\S`, 'm');
const COMMIT_ARG = /^[0-9a-fA-F]{4,64}$/;

/** The trailer value for a seal's code hash: its first 12 hex characters. */
function shipCheckValue(codeHash) {
  return String(codeHash).slice(0, SHIP_CHECK_VALUE_LENGTH);
}

/**
 * What a commit's trailer block says about its ship check.
 * `{ state: 'ok', shipCheck: '<12 hex>'|null, skip: boolean }`, or `{ state: 'error', reason }` when the commit cannot be
 * read (not a repository, no such commit, git missing). Never throws. `commit` is a hex sha (or null for HEAD).
 */
function readShipTrailers(root, commit) {
  const rev = commit === null || commit === undefined ? 'HEAD' : String(commit);
  if (rev !== 'HEAD' && !COMMIT_ARG.test(rev)) return { state: 'error', reason: `${JSON.stringify(rev)} is not a commit sha` };
  let out;
  try {
    // Only the trailer block (git's own parse), unfolded, one "Key: value" per line.
    out = git(['log', '-1', '--format=%(trailers:only=true,unfold=true)', rev, '--'], { cwd: root });
  } catch (error) {
    const detail = String((error && error.stderr) || (error && error.message) || error).trim().split('\n')[0];
    return { state: 'error', reason: `cannot read commit ${rev} in ${root}: ${detail}` };
  }
  const match = SHIP_CHECK_LINE.exec(out);
  return { state: 'ok', shipCheck: match ? match[1] : null, skip: SHIP_CHECK_SKIP_LINE.test(out) };
}

module.exports = {
  git, gitSafe, gitOk,
  SHIP_CHECK_KEY, SHIP_CHECK_SKIP_KEY, SHIP_CHECK_VALUE_LENGTH, shipCheckValue, readShipTrailers,
};
