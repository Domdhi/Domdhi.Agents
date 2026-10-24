// Supplementary adversarial coverage for CR-1.2 (F58/F59) — evasions from the
// findings class that the pre-written commit-guard.bypass.test.js does not spell
// out one-by-one. All must BLOCK (they are inline `git commit -m` at a command
// head no matter how wrapped/chained); the benign column must still PASS.
//
// This file ADDS coverage — it never weakens commit-guard.test.js or
// commit-guard.bypass.test.js.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { processEvent } = require('../../../.agents/hooks/commit-guard.cjs');

const evt = (command) => ({ tool_input: { command } });
const isBlocked = (cmd) => {
  const r = processEvent(evt(cmd));
  return !!(r && r.block);
};

describe('commit-guard evasions — additional wrapper/keyword/chain forms BLOCK', () => {
  const mustBlock = [
    // stacked wrappers
    'sudo env FOO=1 nice git commit -m "x"',
    'sudo nohup git commit -m "x"',
    'time nice -n 10 git commit -m "x"',
    // other single wrappers named in the findings
    'command git commit -m "x"',
    'exec git commit -m "x"',
    'doas git commit -m "x"',
    'builtin git commit -m "x"',
    'nice -n10 git commit -m "x"',
    'env FOO=bar BAZ=1 git commit -m "x"',
    // other shell-keyword statement-starts
    'while true; do git commit -m "x"; done',
    'if [ -f a ]; then git commit -m "x"; else true; fi',
    'if x; then true; else git commit -m "x"; fi',
    // background single-& before a wrapped commit
    'sleep 1 & sudo git commit -m "x"',
    // subshell / command substitution nesting
    '(git commit -m "x")',
    'x=$(git commit -m "x")',
    // attached-value forms behind a wrapper
    'sudo git commit -mhello',
    'env A=1 git commit -m"feat: y"',
    // M1 — backslash-newline line continuation: bash rejoins into one inline
    // commit; the guard must collapse the continuation before splitting.
    'git commit \\\n-m "secret"',
    'git commit \\\r\n-m "secret"',
    'git add -A && git commit \\\n-m "secret"',
    // M2 — git GLOBAL options between `git` and `commit`.
    'git -c user.name=x commit -m "secret"',
    'git -c user.email=x -c commit.gpgsign=false commit -m "secret"',
    'git --git-dir=/foo/.git commit -m "secret"',
    'git -C /some/path commit -m "secret"',
    'git --no-pager commit -m "secret"',
    'sudo git -c user.name=x commit -m "secret"',   // M2 behind a wrapper
    // F7 (260716 code review) — a leading path or the Windows .exe basename
    // must not defeat the head match; only the basename token is checked.
    '/usr/bin/git commit -m "x"',
    './git commit -m "x"',
    '../bin/git commit -m "x"',
    'git.exe commit -m "x"',
    'GIT.EXE commit -m "x"',
    'C:\\Git\\bin\\git.exe commit -m "x"',
    'sudo /usr/bin/git commit -m "x"',   // absolute path behind a wrapper
    // M — BARE env-assignment prefix (no `env` keyword). `env FOO=bar git commit`
    // was already caught; the bare form slipped past the splitter, skipping
    // commit.js's pre-commit secret scan + trailer.
    'FOO=bar git commit -m "secret"',
    'A=1 B=2 git commit -m "secret"',
    'FOO=bar git commit -mhello',          // bare assignment + attached-value form
    'sudo FOO=1 git commit -m "x"',        // bare assignment nested under a wrapper
    // M — `-F` file flag no longer short-circuits a co-present inline `-m`. git
    // appends the inline message and the commit still skips commit.js's scan.
    'git commit -F docs/.output/.state/.commit-msg -m "secret"',
    'git commit -m "secret" -F docs/.output/.state/.commit-msg',
    'git commit -F f --message="secret"',
    'FOO=bar git commit -F f -m "secret"', // bare env + -F + inline -m
  ];

  for (const cmd of mustBlock) {
    it(`blocks: ${cmd}`, () => {
      expect(isBlocked(cmd)).toBe(true);
    });
  }
});

describe('commit-guard evasions — benign look-alikes still PASS', () => {
  const mustPass = [
    // the sanctioned helper behind a wrapper is still the helper
    'sudo node .claude/core/commit.js --all',
    // a command that merely names a wrapper word but is not a git commit
    'time ls -la',
    'nice -n 10 npm test',
    // "git commit" mentioned inside a quoted argument of a non-commit head,
    // with NO shell keyword/separator inside the quotes to mis-split on.
    'grep -r "git commit -m" .',
    // wrapped file-based / editor forms are the allowed escape hatches
    'sudo git commit -F docs/.output/.state/.commit-msg',
    'if true; then git commit --amend; fi',
    // M2 — a git global option before a NON-commit subcommand is not a commit.
    'git -c user.name=x status',
    'git --git-dir=/foo/.git log --oneline',
    'git -C /some/path status',
    // M2 — global option before a file-based/editor commit stays an escape hatch.
    'git -c user.name=x commit -F docs/.output/.state/.commit-msg',
    'git -c user.name=x commit --amend',
    // M — the `-F` escape hatch stays valid when NO inline -m rides alongside,
    // including behind a bare env-assignment prefix.
    'FOO=bar git commit -F docs/.output/.state/.commit-msg',
    'FOO=bar git commit --amend',
    // M1 — a continuation that rejoins into a plain editor commit still passes.
    'git commit \\\n--amend',
    // F7 (260716 code review) — the basename match must stay strict equality,
    // never a substring: these are all DIFFERENT binaries that merely contain
    // "git" as a substring of their name, not the git binary itself.
    'legit commit -m "x"',
    'digit commit -m "x"',
    '/usr/bin/legit commit -m "x"',
    'git-lfs commit -m "x"',
    'gitk commit -m "x"',
  ];

  for (const cmd of mustPass) {
    it(`passes: ${cmd}`, () => {
      expect(isBlocked(cmd)).toBe(false);
    });
  }
});

describe('commit-guard evasions — documented SAFE over-blocks (fail-closed direction)', () => {
  // The guard is textual, not a real shell parser (see the guardrail.cjs header:
  // advisory, not authoritative). A shell keyword or separator INSIDE a quoted
  // string is treated as a statement boundary, so a benign echo that quotes both
  // a keyword and `git commit -m` over-blocks. This is the SAFE direction (the
  // finding class is guard-BYPASS / fail-open) and is consistent with the
  // pre-existing behavior: the old regex already over-blocked
  // `echo "a; git commit -m x"` on the quoted `;`. The user's escape is the
  // sanctioned commit.js helper, which they should use regardless.
  const overBlocked = [
    'echo "then git commit -m fake"',   // quoted `then` mis-read as a statement start
    'echo "a; git commit -m x"',        // quoted `;` — over-blocked under the OLD guard too
  ];

  for (const cmd of overBlocked) {
    it(`over-blocks (safe): ${cmd}`, () => {
      expect(isBlocked(cmd)).toBe(true);
    });
  }
});
