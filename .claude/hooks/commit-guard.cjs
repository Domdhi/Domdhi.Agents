#!/usr/bin/env node
/**
 * Commit Guard — PreToolUse:Bash / PreToolUse:PowerShell
 *
 * Forces every Claude-authored commit through `.claude/core/commit.js` so the
 * Co-Authored-By trailer and message sanitization (trailing junk / stray-token
 * strip) are applied CONSISTENTLY — regardless of which developer's Claude Code
 * session runs the commit. Inline `git commit -m/-am` is the fumble-prone path:
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

/**
 * The slice of the command following the first `git commit` token — but only
 * when `git commit` is at a COMMAND position (start of string, or immediately
 * after a shell separator `&&`, `||`, `;`, `|`, newline, or `(`). This avoids
 * false-positives where `git commit -m` merely appears inside an echo or a
 * quoted string argument.
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

/**
 * @returns {null | { block: true, feedback: string }}
 */
function processEvent(data) {
  const cmd = ((data && data.tool_input && data.tool_input.command) || '').trim();
  if (!cmd) return null;

  // The helper is always allowed (it is THE sanctioned path).
  if (usesHelper(cmd)) return null;

  const tail = gitCommitTail(cmd);
  if (tail === null) return null; // not a `git commit` invocation

  if (hasFileFlag(tail)) return null;   // git commit -F <file> — already safe
  if (hasAmendFlag(tail) && !hasInlineMessageFlag(tail)) return null; // amend w/o -m

  if (!hasInlineMessageFlag(tail)) return null; // plain `git commit` → editor, fine

  return {
    block: true,
    feedback:
      '[commit-guard] BLOCKED: inline `git commit -m` is disabled for commit consistency.\n' +
      'Inline messages break across bash vs PowerShell quoting (stray `@`, mangled em-dashes)\n' +
      'and skip the Co-Authored-By trailer. Use the file-based helper instead:\n' +
      '  1. Write subject + body to docs/.output/.state/.commit-msg  (Write tool — zero shell escaping)\n' +
      '  2. node .claude/core/commit.js [--all] [--amend]\n' +
      '\n' +
      'Escape hatches (allowed): `git commit -F <file>`, `git commit --amend` (no -m), or plain\n' +
      '`git commit` to open the editor.\n'
  };
}

async function main() {
  const input = await readHookInput({ timeoutMs: null });
  if (!input.trim()) process.exit(0);

  let data;
  try { data = JSON.parse(input); } catch { process.exit(0); }

  const result = processEvent(data);
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
  usesHelper,
  hasFileFlag,
  hasAmendFlag,
  hasInlineMessageFlag,
};
