#!/usr/bin/env node
/**
 * Commit Guard — PreToolUse:Bash / PreToolUse:PowerShell
 *
 * Routes agent-authored inline commits through `.claude/core/commit.js` for
 * message sanitization (trailing junk / stray-token strip) and staged secret
 * scanning. Inline `git commit -m/-am` is the fumble-prone path:
 * multiline messages with em-dashes/backticks break differently under bash vs
 * PowerShell quoting (the IDEA-001 stray-`@` incident, 2026-05-30). So it is
 * blocked with guidance toward the helper.
 *
 * ALLOWED (pass through):
 *   - node .claude/core/commit.js [...]      ← the sanctioned path
 *   - git commit -F <file> / --file <file>   ← already file-based & safe
 *   - git commit --amend  (no inline -m)     ← message-preserving / editor
 *   - plain `git commit`                     ← opens the editor
 *   - git merge / revert / cherry-pick (their own -m handling)
 *
 * BLOCKED (exit 2):
 *   - git commit -m / -am / -cm / --message ...  (inline message)
 *
 * Exit codes (Claude Code semantics): 0 = pass; 2 = hard block (stderr shown).
 *
 * NOTE: commit.js runs `git commit -F` in a CHILD process, which is NOT
 * intercepted by this PreToolUse hook — so there is no recursion. The hook only
 * sees the top-level command Claude runs (`node .claude/core/commit.js ...`).
 */
'use strict';

const { readHookInput } = require('../core/_lib/hook-input');
const { splitCommandSegments, stripWrapperPrefix } = require('../core/_lib/shell-command-split');

// 5000ms ceiling on the stdin read (blocking-hook parity). Env override exists
// ONLY so a fail-closed timeout test can shrink the wait for a real spawned
// process without changing production behavior — same pattern as
// secret-scanner.cjs's SECRET_SCANNER_STDIN_TIMEOUT_MS.
const STDIN_TIMEOUT_MS = parseInt(process.env.HOOK_STDIN_TIMEOUT_MS, 10) || 5000;

/**
 * The slice of the command following the first `git commit` token — but only
 * when `git commit` is at a COMMAND position (start of string, or immediately
 * after a shell separator `&&`, `||`, `;`, `|`, newline, or `(`). This avoids
 * false-positives where `git commit -m` merely appears inside an echo or a
 * quoted string argument.
 *
 * NOTE: this narrow regex is retained for backward compatibility / direct unit
 * tests, but processEvent no longer relies on it — it recognizes `git commit`
 * as a command HEAD in ANY segment via splitCommandSegments + stripWrapperPrefix
 * (F58/F59). The old regex missed a single `&` (background), the shell keywords
 * (`if …; then git commit`, `for …; do git commit`), and wrapper prefixes
 * (`sudo|env|time|nice|nohup|xargs git commit`) — all real bypasses of the
 * mandatory commit.js pre-commit secret scan.
 */
function gitCommitTail(cmd) {
  const m = cmd.match(/(?:^|&&|\|\||[;|\n(])\s*git\s+commit\b([\s\S]*)$/);
  return m ? m[1] : null;
}

function usesHelper(cmd) {
  return /commit\.js\b/.test(cmd);
}

function hasFileFlag(tail) {
  return /(^|\s)(-F|--file)(\s|=|$)/.test(tail);
}

function hasAmendFlag(tail) {
  return /(^|\s)--amend(\s|=|$)/.test(tail);
}

function hasInlineMessageFlag(tail) {
  // -m, -am, -cm, -sm (combined short flags ending in m), or --message[=].
  // The value may be DETACHED (`-m "x"`, `-m=x`, `-m` then a separate token) OR
  // ATTACHED directly to the flag — git accepts `-m"x"`, `-mhello`, `-am"x"`.
  // The attached forms were previously missed (the char after `m` had to be
  // space/`=`/end), so they slipped past the guard AND skipped commit.js's
  // pre-commit secret scan. Match both: `m` followed by whitespace/`=`/end, or
  // by an attached quote or non-space value character.
  return /(^|\s)-[a-zA-Z]*m(\s|=|$)/.test(tail)
    || /(^|\s)-[a-zA-Z]*m["'\S]/.test(tail)
    || /(^|\s)--message(\s|=|$)/.test(tail);
}

const BLOCK_FEEDBACK =
  '[commit-guard] BLOCKED: inline `git commit -m` is disabled for commit consistency.\n' +
  'Inline messages break across bash vs PowerShell quoting (stray `@`, mangled em-dashes)\n' +
  'and skip the staged secret scan. Use the file-based helper instead:\n' +
  '  1. Write subject + body to docs/.output/.state/.commit-msg  (Write tool — zero shell escaping)\n' +
  '  2. node .claude/core/commit.js [--all] [--amend]\n' +
  '\n' +
  'Escape hatches (allowed): `git commit -F <file>`, `git commit --amend` (no -m), or plain\n' +
  '`git commit` to open the editor.\n';

// git GLOBAL options that take a SEPARATE value token (`git -c user.name=x`,
// `git -C /path`, `git --git-dir /path`). The `--opt=value` attached forms and
// the no-arg flags (`-p`, `--no-pager`, `--bare`, …) are single tokens and need
// no value consumption.
const GIT_VALUE_OPT = /^(?:-c|-C|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix)$/;

// Matches the git binary's BASENAME only — never a substring of a longer
// word — so `legit`, `digit`, `git-lfs`, `gitk` are never mistaken for it.
// `.exe` covers the Windows basename (`git.exe commit -m …`).
const GIT_BASENAME_RE = /^git(\.exe)?$/i;

/**
 * Is `git commit` the command HEAD of this (wrapper-stripped) segment? Returns
 * the slice after `commit` (the flag tail) or null when the segment does not
 * start with a git-commit invocation.
 *
 * F7 (260716 code review): the head is recognized by BASENAME, not a literal
 * `git` string prefix — `/usr/bin/git commit -m`, `./git commit -m`, and
 * `git.exe commit -m` all invoke the git binary and must route through the
 * same gate as a bare `git`. A leading path component (`/usr/bin/`, `./`,
 * `C:\Program Files\Git\bin\`) is stripped before the basename check.
 *
 * M2: a git GLOBAL option between `git` and the subcommand
 * (`git -c user.name=x commit -m "secret"`, `git --git-dir=… commit …`) defeats
 * a naive `^git\s+commit` match — a documented bypass CR-1.2 must harden. This
 * walks the leading option tokens (consuming the value token of the known
 * value-taking options) until it reaches `commit`, then returns the tail. A
 * non-option token that is not `commit` (e.g. `git status`) → not a commit head.
 */
function gitCommitSegmentTail(segment) {
  const headMatch = segment.match(/^(\S+)([\s\S]*)$/);
  if (!headMatch) return null;
  const basename = headMatch[1].split(/[\\/]/).pop();
  if (!GIT_BASENAME_RE.test(basename)) return null;
  let rest = headMatch[2];

  for (;;) {
    const trimmed = rest.replace(/^\s+/, '');
    const tok = trimmed.match(/^(\S+)([\s\S]*)$/);
    if (!tok) return null;                 // nothing left → not a commit
    const word = tok[1];
    if (word === 'commit') return tok[2];  // the flag tail after `commit`
    if (!word.startsWith('-')) return null; // a non-option subcommand (git status/add/…)
    // An option token: consume it, plus its value token when value-taking and
    // the value is a SEPARATE arg (`-c k=v` / `-C path`), not an attached `=`.
    let after = tok[2];
    if (GIT_VALUE_OPT.test(word)) after = after.replace(/^\s+\S+/, '');
    rest = after;
  }
}

/**
 * @returns {null | { block: true, feedback: string }}
 *
 * F58/F59: `git commit -m` is detected as a command HEAD in ANY segment — after
 * splitting the command on real shell boundaries (splitCommandSegments) and
 * peeling wrapper prefixes off each segment (stripWrapperPrefix). This blocks
 * the single-`&`, keyword-wrapped (`if/then`, `for/do`), and wrapper-prefixed
 * (`sudo|env|time|nice|nohup|xargs`) forms the old string-start-anchored regex
 * let slip past the mandatory commit.js pre-commit secret scan. Benign forms
 * (the commit.js helper, `-F`/`--file`, `--amend` without `-m`, plain
 * `git commit`, and quoted/echoed mentions) still pass.
 *
 * Fail-closed: any parser exception on a real command BLOCKS rather than
 * silently allowing an unscanned inline commit.
 */
function processEvent(data) {
  const cmd = ((data && data.tool_input && data.tool_input.command) || '').trim();
  if (!cmd) return null;

  // The helper is always allowed (it is THE sanctioned path).
  if (usesHelper(cmd)) return null;

  try {
    for (const rawSeg of splitCommandSegments(cmd)) {
      const seg = stripWrapperPrefix(String(rawSeg).trim()).trim();
      if (!seg) continue;

      const tail = gitCommitSegmentTail(seg);
      if (tail === null) continue; // this segment is not a `git commit` head

      // git commit -F <file> — already safe, BUT only when no inline `-m` rides
      // alongside it. `git commit -F f -m "<secret>"` supplies BOTH; git appends
      // the inline message and the commit still skips commit.js's pre-commit
      // secret scan, so the file flag must not short-circuit the -m check.
      if (hasFileFlag(tail) && !hasInlineMessageFlag(tail)) continue;
      if (hasAmendFlag(tail) && !hasInlineMessageFlag(tail)) continue; // amend w/o -m
      if (!hasInlineMessageFlag(tail)) continue; // plain `git commit` → editor, fine

      return { block: true, feedback: BLOCK_FEEDBACK }; // inline -m at a command head
    }
  } catch (err) {
    // Fail-closed: a parser error on a real command must not silently allow an
    // inline commit that would skip commit.js's pre-commit secret scan.
    return {
      block: true,
      feedback: '[commit-guard] BLOCKED (fail-closed on parser error): ' + (err && err.message) + '\n',
    };
  }

  return null;
}

async function main() {
  // Fail CLOSED on a wedged/truncated stdin read. A timeout or stream error
  // means the payload never arrived intact; exiting 0 would let an inline
  // `git commit -m` through that skips commit.js's pre-commit secret scan.
  // Block instead — same rationale as the processEvent catch below and
  // secret-scanner.cjs. A clean `end` (even empty) still resolves, so a
  // legitimate empty-stdin invocation is unaffected. (finding 2)
  let input;
  try {
    input = await readHookInput({ timeoutMs: STDIN_TIMEOUT_MS, failClosedOnTimeout: true });
  } catch (err) {
    process.stderr.write('[commit-guard] BLOCKED (fail-closed): stdin read did not complete — ' + (err && err.message) + '\n');
    process.exit(2);
  }
  if (!input.trim()) process.exit(0);

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    // Fail CLOSED: non-empty stdin that will not parse is a truncated/garbled
    // payload; allowing it would silently skip commit.js's pre-commit secret
    // scan on whatever inline commit it carried. Block.
    process.stderr.write('[commit-guard] BLOCKED (fail-closed): could not parse stdin payload as JSON.\n');
    process.exit(2);
  }

  // Fail-closed: processEvent already catches internally, but an unexpected
  // throw here must BLOCK (exit 2), never silently pass through an inline commit
  // that would skip commit.js's pre-commit secret scan.
  let result;
  try {
    result = processEvent(data);
  } catch (err) {
    process.stderr.write('[commit-guard] BLOCKED (fail-closed on unexpected error): ' + (err && err.message) + '\n');
    process.exit(2);
  }
  if (result && result.block) {
    process.stderr.write(result.feedback);
    process.exit(2);
  }
  process.exit(0);
}

if (require.main === module) { main(); }

module.exports = {
  processEvent,
  gitCommitTail,
  gitCommitSegmentTail,
  usesHelper,
  hasFileFlag,
  hasAmendFlag,
  hasInlineMessageFlag,
};
