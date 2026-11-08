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
 *   - anything that skips or disables the git hooks that run the secret scan (the toolkit-managed hooks,
 *     see core/git-hooks.js), judged on the words the shell would pass git, after removing quotes
 *     ("git", $'-n', "core.hooks"Path), whatever wrapper, chain or global option they sit behind:
 *       * --no-verify (and the abbreviations git accepts) on commit, merge, am, rebase, pull, push, cherry-pick,
 *         revert; -n on commit and am, alone or in a cluster (-nm, -an, -anm)
 *       * git commit-tree (writes a commit with no hook; update-ref publishes it)
 *       * core.hooksPath, include.path, includeIf.*.path and url.*.insteadOf / pushInsteadOf as -c / --config-env operands (also --config-env as a
 *         separate argument), in `git config` writes and unsets, and in aliases
 *       * GIT_CONFIG_GLOBAL / _SYSTEM / _COUNT / _KEY_n / _VALUE_n / _PARAMETERS set anywhere in a command that
 *         runs a hook-running git subcommand (or whose value names core.hooksPath / include)
 *       * a git alias (resolved through `git config --get-regexp ^alias\.` in the repository, and through
 *         -c alias.x=...) whose expansion does any of the above
 *
 * WHAT IT CANNOT SEE (a lexical guard, not a shell): bash -c / sh -c / eval strings, values built at run time
 * ($var commit, command substitution), a different `node` on PATH, NODE_OPTIONS, files edited directly
 * (.git/config, a hooks file), and git plumbing it does not name. The pre-push hook (core/git-hooks.js) scans
 * every commit a push would publish and is the backstop for all of them; a human can always --no-verify.
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
const fs = require('fs');
const { execFileSync } = require('child_process');

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

// ── shell words ───────────────────────────────────────────────────────────────

const ANSI_C_SIMPLE = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

/** Decode the body of a $'...' string. */
function decodeAnsiC(body) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\' || i + 1 >= body.length) { out += ch; continue; }
    const e = body[++i];
    if (e in ANSI_C_SIMPLE) { out += ANSI_C_SIMPLE[e]; continue; }
    let m;
    if (e === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 1)))) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; continue; }
    if (/[0-7]/.test(e) && (m = /^[0-7]{1,3}/.exec(body.slice(i)))) { out += String.fromCharCode(parseInt(m[0], 8)); i += m[0].length - 1; continue; }
    if (e === 'u' && (m = /^[0-9a-fA-F]{1,4}/.exec(body.slice(i + 1)))) { out += String.fromCodePoint(parseInt(m[0], 16)); i += m[0].length; continue; }
    if (e === 'U' && (m = /^[0-9a-fA-F]{1,8}/.exec(body.slice(i + 1))) && parseInt(m[0], 16) <= 0x10ffff) { out += String.fromCodePoint(parseInt(m[0], 16)); i += m[0].length; continue; }
    if (e === 'c' && i + 1 < body.length) { out += String.fromCharCode(body.charCodeAt(++i) & 0x1f); continue; }
    out += '\\' + e;
  }
  return out;
}

/**
 * Split text into the words the shell would pass a program: quotes group and are removed ('..', "..", $'..',
 * $"..", \x), adjacent quoted and bare parts join into one word ("core.hooks"Path), and an unquoted word-start
 * `#` begins a comment. Pure; never throws.
 */
function tokenize(text, { winPaths = false } = {}) {
  const words = [];
  const src = String(text || '');
  let cur = '';
  let started = false;
  const push = () => { if (started) { words.push(cur); cur = ''; started = false; } };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (/\s/.test(ch)) { push(); continue; }
    if (ch === '#' && !started) break;
    if (ch === '$' && src[i + 1] === "'") {
      const end = (() => { for (let j = i + 2; j < src.length; j++) { if (src[j] === '\\') j++; else if (src[j] === "'") return j; } return -1; })();
      const stop = end < 0 ? src.length : end;
      cur += decodeAnsiC(src.slice(i + 2, stop));
      started = true;
      i = stop;
      continue;
    }
    if (ch === '$' && src[i + 1] === '"') { continue; } // $"..." is a locale-translated "..."
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end < 0 ? src.length : end;
      cur += src.slice(i + 1, stop);
      started = true;
      i = stop;
      continue;
    }
    if (ch === '"') {
      started = true;
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\' && j + 1 < src.length && /["\\$`]/.test(src[j + 1])) j++;
        cur += src[j];
      }
      i = j;
      continue;
    }
    // winPaths: a backslash before a plain character is kept, so `C:\Git\bin\git.exe` stays one path.
    if (ch === '\\' && i + 1 < src.length && winPaths && !/[\s"'\\$`#;&|()<>*?]/.test(src[i + 1])) { cur += ch; started = true; continue; }
    if (ch === '\\' && i + 1 < src.length) { cur += src[++i]; started = true; continue; }
    cur += ch;
    started = true;
  }
  push();
  return words;
}

/** A word safe to put back into a command line: bare when it is plain, else single-quoted. */
function quoteWord(w) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

// `git commit` options whose value may be a SEPARATE word (-F file, -m msg, -C/-c commit, -t template, ...).
const SHORT_VALUE_OPTS = 'FmCct';
// ... and the long ones. Unattached (`--message msg`) the next word is the value, not a flag.
const LONG_VALUE_OPTS = /^(?:message|file|reuse-message|reedit-message|template|author|date|cleanup|fixup|squash|trailer|pathspec-from-file)$/;
// `--no-verify`, and the abbreviations git accepts (--no-veri, --no-verif: shorter ones are ambiguous with --no-verbose).
const NO_VERIFY_LONG = /^--no-veri(?:f|fy)?(?:=.*)?$/;

/**
 * Does this `git commit` flag tail skip the hooks? `--no-verify` and its abbreviations, and the short `-n`,
 * alone or inside a combined cluster (-nm, -an, -anm). A cluster is read left to right and ends at the first
 * option that takes a value (-m, -F, -C, -c, -t, -u, -S), whose remainder is that value, not more flags.
 * Words after `--` are paths.
 */
function hasNoVerifyFlag(tail) {
  return noVerifyInWords(tokenize(tail));
}

function noVerifyInWords(words) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '--') break;
    if (w.startsWith('--')) {
      if (NO_VERIFY_LONG.test(w)) return true;
      if (LONG_VALUE_OPTS.test(w.slice(2).split('=')[0]) && !w.includes('=')) i++;
      continue;
    }
    if (w.length < 2 || w[0] !== '-') continue;
    for (let j = 1; j < w.length; j++) {
      const ch = w[j];
      if (ch === 'n') return true;
      if (SHORT_VALUE_OPTS.includes(ch)) { if (j === w.length - 1) i++; break; }
      if (ch === 'u' || ch === 'S') break; // optional attached value: the rest of the word
    }
  }
  return false;
}

/** `--no-verify` (long forms only) among the words before `--`; for `git am`, also the short `-n`. */
function hasLongNoVerify(words, { shortN = false } = {}) {
  for (const w of words) {
    if (w === '--') break;
    if (NO_VERIFY_LONG.test(w)) return true;
    if (shortN && /^-[A-Za-z0-9]*n[A-Za-z0-9]*$/.test(w) && !w.startsWith('--')) return true;
  }
  return false;
}

// ── git configuration that disables or redirects hooks ───────────────────────────────────────

/** Is `key[=value]` (a -c / --config-env operand or a config key) a setting that moves, disables or includes hooks config, or rewrites remote URLs? */
function hooksConfigKey(kv) {
  const key = String(kv || '').split('=')[0].trim().toLowerCase();
  return key === 'core.hookspath' || key === 'include.path' || (key.startsWith('includeif.') && key.endsWith('.path'))
    // url.<base>.insteadOf / pushInsteadOf rewrite where git fetches and pushes: they send the push scan's
    // `ls-remote` to a decoy repository, or a push to somewhere the user did not mean.
    || /^url\..+\.(?:push)?insteadof$/.test(key);
}

const GIT_CONFIG_ENV = /^(?:GIT_CONFIG(?:_GLOBAL|_SYSTEM|_COUNT|_PARAMETERS|_KEY_\d+|_VALUE_\d+)?)=/;

// ── git heads ─────────────────────────────────────────────────────────────────

// git GLOBAL options that take a SEPARATE value word (`git -c user.name=x`, `git -C /path`, `git --config-env k=VAR`).
// The `--opt=value` attached forms and the no-arg flags are single words and need no value consumption.
const GIT_VALUE_OPT = /^(?:-c|-C|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env|--attr-source)$/;

// Matches the git binary's BASENAME only — never a substring of a longer word — so `legit`, `digit`,
// `git-lfs`, `gitk` are never mistaken for it. `.exe` covers the Windows basename.
const GIT_BASENAME_RE = /^git(\.exe)?$/i;

/**
 * Parse the words of a command that starts with the git binary: its global options and the subcommand.
 * Returns null when the head is not git. `config` collects `-c`/`--config-env` operands; `globalWords` is the
 * original option words (so an alias expansion can be re-evaluated behind the same options).
 */
function parseGit(words) {
  if (!words.length || !GIT_BASENAME_RE.test(words[0].split(/[\\/]/).pop())) return null;
  const config = [];
  const globalWords = [];
  let dir = null;
  let i = 1;
  for (; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith('-')) break;
    globalWords.push(w);
    if (GIT_VALUE_OPT.test(w) && i + 1 < words.length) {
      const v = words[++i];
      globalWords.push(v);
      if (w === '-c' || w === '--config-env') config.push(v);
      if (w === '-C') dir = v;
    } else if (w.startsWith('--config-env=')) {
      config.push(w.slice('--config-env='.length));
    }
  }
  return { sub: i < words.length ? words[i] : null, args: words.slice(i + 1), config, globalWords, dir };
}

// git builtins an alias cannot shadow; anything else may be an alias (looked up in the repository's config).
const BUILTINS = new Set(('add am apply archive bisect blame branch bundle cat-file checkout cherry-pick clean clone commit commit-tree config describe diff diff-tree diff-index fetch ' +
  'format-patch for-each-ref gc grep hash-object help init log ls-files ls-tree maintenance merge merge-base mv name-rev notes pull push range-diff read-tree rebase reflog remote repack reset restore ' +
  'rev-list rev-parse revert rm shortlog show show-ref sparse-checkout stash status submodule switch symbolic-ref tag update-index update-ref version whatchanged worktree write-tree').split(' '));

// Subcommands that create commits or merge, i.e. run hooks (an unknown subcommand may be an alias for one).
const HOOK_RUNNING = new Set(['commit', 'merge', 'am', 'rebase', 'pull', 'push', 'cherry-pick', 'revert', 'commit-tree']);
// Subcommands that take --no-verify to skip a hook (-n only on commit and am).
const NO_VERIFY_SUBS = new Set(['merge', 'rebase', 'pull', 'push', 'cherry-pick', 'revert', 'am']);

const HOOKS_FEEDBACK =
  '[commit-guard] BLOCKED: this command skips or disables the git hooks that run the secret scan ({reason}).\n' +
  'Do not look for another way around it. Stop and ask the user: only the user decides whether a commit\n' +
  'or push may skip the secret scan. If a hook reported a finding, fix that instead: remove the secret, or\n' +
  'ask the user to review a false positive.\n';

const hooksBlock = reason => ({ block: true, feedback: HOOKS_FEEDBACK.replace('{reason}', reason) });

/** Aliases the repository (and the user's global config) defines: Map name -> expansion. Cached per call chain. */
function readRepoAliases(dir) {
  const aliases = new Map();
  try {
    const out = execFileSync('git', ['config', '--get-regexp', '^alias\\.'], {
      cwd: dir && fs.existsSync(dir) ? dir : process.cwd(), encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      const m = /^alias\.(\S+)(?: (.*))?$/.exec(line);
      if (m) aliases.set(m[1].toLowerCase(), m[2] || '');
    }
  } catch { /* no repository, no aliases, or git missing: nothing to resolve */ }
  return aliases;
}

const MAX_ALIAS_DEPTH = 4;

/**
 * Evaluate what a `git config` invocation (its words after `config`) would do to the hook configuration.
 * Reading a key is allowed; setting or unsetting core.hooksPath / include paths, and defining an alias whose
 * expansion skips hooks, is not.
 */
function checkConfigWrite(args, ctx, depth) {
  const READ = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--show-origin', '--show-scope', '--name-only']);
  const VALUE_OPTS = new Set(['-f', '--file', '--blob', '--default', '--type', '--includes']);
  const positional = [];
  let unset = false;
  let read = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (READ.has(w)) read = true;
    else if (/^--(?:unset|unset-all|replace-all|add)$/.test(w)) unset = true;
    else if (VALUE_OPTS.has(w)) i++;
    else if (!w.startsWith('-')) positional.push(w);
  }
  // git >= 2.46 subcommand syntax: `git config set [--scope] <key> <value>`, `git config unset [--scope] <key>`
  // (also `get`, `list`, `edit`, `rename-section`, `remove-section`). The verb is the first positional word.
  const verb = (positional[0] || '').toLowerCase();
  if (verb === 'set' || verb === 'unset') {
    positional.shift();
    unset = true; // either verb changes the setting
  } else if (verb === 'get' || verb === 'list') {
    return null;
  }
  const key = (positional[0] || '').toLowerCase();
  if (!key || read) return null;
  const writes = positional.length >= 2 || unset;
  if (writes && hooksConfigKey(key)) return hooksBlock(`git config ${key} would move, disable, include or rewrite the hooks configuration or the remote URLs for every later commit or push`);
  if (writes && key.startsWith('alias.') && positional[1]) {
    return evaluateExpansion(positional[1], { globalWords: [], rest: [] }, ctx, depth + 1, `the alias ${key}`);
  }
  return null;
}

/** Evaluate the command an alias would run. `!shell` aliases are shell text; others are git subcommand words. */
function evaluateExpansion(expansion, g, ctx, depth, what) {
  if (depth > MAX_ALIAS_DEPTH) return hooksBlock(`${what} nests aliases too deeply to evaluate`);
  if (expansion.startsWith('!')) {
    const shell = [expansion.slice(1), ...g.rest.map(quoteWord)].join(' ');
    for (const seg of splitCommandSegments(shell)) {
      const v = checkSegment(seg, ctx, depth);
      if (v) return v;
    }
    return null;
  }
  const synthetic = ['git', ...g.globalWords, ...tokenize(expansion), ...g.rest].map(quoteWord).join(' ');
  return checkGit(synthetic, ctx, depth);
}

/**
 * Judge one command that starts with the git binary. Returns null or { block, feedback }.
 * @param {string} cmd  the command text, head first (wrappers already stripped)
 */
function checkGit(cmd, ctx, depth = 0) {
  // POSIX reading first (g\it is git); then the Windows reading, where C:\Git\bin\git.exe is one path.
  const g = parseGit(tokenize(cmd)) || parseGit(tokenize(cmd, { winPaths: true }));
  if (!g) return null;
  const inline = new Map();
  for (const kv of g.config) {
    if (hooksConfigKey(kv)) return hooksBlock('a -c / --config-env override of core.hooksPath, an include path or url.*.insteadOf / pushInsteadOf');
    const m = /^alias\.([^=]+)=(.*)$/i.exec(kv);
    if (m) inline.set(m[1].toLowerCase(), m[2]);
  }
  const sub = g.sub;
  if (!sub) return null;
  if (HOOK_RUNNING.has(sub) || !BUILTINS.has(sub)) ctx.state.hookGit = true;

  if (sub === 'commit') {
    // The flag words come from the dequoted words; the -m / -F / --amend reading keeps the regex helpers on the
    // raw tail (the words joined when the head only parses as git after dequoting, e.g. g\\it commit).
    const tail = gitCommitSegmentTail(cmd) ?? ` ${g.args.join(' ')}`;
    if (noVerifyInWords(g.args) || hasNoVerifyFlag(tail)) return hooksBlock('git commit --no-verify / -n');
    if (ctx.helper) return null;
    // git commit -F <file> — already safe, BUT only when no inline `-m` rides alongside it. `git commit -F f -m
    // "<secret>"` supplies BOTH; git appends the inline message and the commit still skips commit.js's scan.
    if (hasFileFlag(tail) && !hasInlineMessageFlag(tail)) return null;
    if (hasAmendFlag(tail) && !hasInlineMessageFlag(tail)) return null; // amend w/o -m
    if (!hasInlineMessageFlag(tail)) return null;                       // plain `git commit` → editor, fine
    return { block: true, feedback: BLOCK_FEEDBACK };                   // inline -m at a command head
  }
  if (sub === 'commit-tree') return hooksBlock('git commit-tree writes a commit with no hook');
  if (NO_VERIFY_SUBS.has(sub)) {
    return hasLongNoVerify(g.args, { shortN: sub === 'am' }) ? hooksBlock(`git ${sub} --no-verify`) : null;
  }
  if (sub === 'config') return checkConfigWrite(g.args, ctx, depth);
  if (!BUILTINS.has(sub)) {
    let expansion = inline.get(sub.toLowerCase());
    if (expansion === undefined) {
      if (!ctx.aliases.has(g.dir || '')) ctx.aliases.set(g.dir || '', readRepoAliases(g.dir));
      expansion = ctx.aliases.get(g.dir || '').get(sub.toLowerCase());
    }
    if (expansion !== undefined) return evaluateExpansion(expansion, { globalWords: g.globalWords, rest: g.args }, ctx, depth + 1, `the alias ${sub}`);
  }
  return null;
}

/** The words of one shell segment, with the environment assignments that precede or follow the head noted. */
function checkSegment(rawSeg, ctx, depth = 0) {
  const raw = String(rawSeg).trim();
  if (!raw) return null;
  const words = tokenize(raw);
  for (const w of words) {
    if (GIT_CONFIG_ENV.test(w)) {
      ctx.state.configEnv = true;
      if (/hookspath|include|insteadof/i.test(w)) return hooksBlock(`${w.split('=')[0]} names core.hooksPath, an include path or url.*.insteadOf`);
    }
  }
  // Both the raw and the quote-normalized segment are judged: the wrapper stripper reads plain words.
  const normalized = words.map(quoteWord).join(' ');
  const candidates = [...new Set([stripWrapperPrefix(raw).trim(), stripWrapperPrefix(normalized).trim()])];
  for (const cand of candidates) {
    const v = checkGit(cand, ctx, depth);
    if (v) return v;
  }
  return null;
}

/**
 * @returns {null | { block: true, feedback: string }}
 *
 * F58/F59: git is recognized as a command HEAD in ANY segment — after splitting the command on real shell
 * boundaries (splitCommandSegments) and peeling wrapper prefixes off each segment (stripWrapperPrefix). This
 * blocks the single-`&`, keyword-wrapped (`if/then`, `for/do`), and wrapper-prefixed
 * (`sudo|env|time|nice|nohup|xargs`) forms. Benign forms (the commit.js helper, `-F`/`--file`, `--amend`
 * without `-m`, plain `git commit`, and quoted/echoed mentions) still pass.
 *
 * Fail-closed: any parser exception on a real command BLOCKS rather than silently allowing an unscanned commit.
 */
function processEvent(data) {
  const cmd = ((data && data.tool_input && data.tool_input.command) || '').trim();
  if (!cmd) return null;

  // The helper is THE sanctioned path, so an inline -m that rides in its (possibly quoted) arguments is not
  // examined. The hooks-skipping forms are examined in EVERY segment regardless: a helper elsewhere in the
  // command ("node commit.js && git commit -n -F f") must not excuse them.
  const ctx = { helper: usesHelper(cmd), state: { configEnv: false, hookGit: false }, aliases: new Map() };

  try {
    for (const rawSeg of splitCommandSegments(cmd)) {
      const v = checkSegment(rawSeg, ctx);
      if (v) return v;
    }
    // GIT_CONFIG_* exported or prefixed in one segment bends the hooks of a commit made in another.
    if (ctx.state.configEnv && ctx.state.hookGit) return hooksBlock('GIT_CONFIG_* in the environment of a command that commits, merges or pushes');
  } catch (err) {
    // Fail-closed: a parser error on a real command must not silently allow an unscanned commit.
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
  tokenize,
  hasNoVerifyFlag,
  hooksConfigKey,
  parseGit,
};
