// AC→source map (CR-1.2 — shell command-boundary splitter, F58/F59/F61/F62):
//   - splitCommandSegments: splits on ; | & && || newline $( ` ( ) AND shell
//     keywords then/do/else/elif/{/} at word boundaries
//   - stripWrapperPrefix: strips leading command wrappers (sudo, env VAR=val, time,
//     nice, nohup, xargs, command, exec, doas, builtin) so the real command head shows
//   - the two together let a guard recognize `git commit` / `rm -rf .env` as a
//     command head no matter how it is wrapped or chained

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { splitCommandSegments, stripWrapperPrefix } = require('../../../../.agents/core/_lib/shell-command-split');

describe('splitCommandSegments', () => {
  it('splits on classic metacharacter separators', () => {
    const segs = splitCommandSegments('echo hi && git commit -m x ; ls | wc').map(s => s.trim());
    expect(segs).toContain('git commit -m x');
    expect(segs).toContain('echo hi');
  });

  it('treats a single & (background) as a separator (F58/F59)', () => {
    const segs = splitCommandSegments('sleep 1 & git commit -m "x"').map(s => s.trim());
    expect(segs.some(s => s.startsWith('git commit'))).toBe(true);
  });

  it('recognizes the then keyword as a new command head (F58/F62)', () => {
    const segs = splitCommandSegments('if true; then rm -rf .env; fi').map(s => s.trim());
    expect(segs.some(s => s.startsWith('rm -rf .env'))).toBe(true);
  });

  it('recognizes the do keyword as a new command head', () => {
    const segs = splitCommandSegments('for i in 1; do git commit -m x; done').map(s => s.trim());
    expect(segs.some(s => s.startsWith('git commit'))).toBe(true);
  });

  it('recognizes else / elif as command heads', () => {
    const segs = splitCommandSegments('if x; then a; elif y; then b; else rm -rf .env; fi').map(s => s.trim());
    expect(segs.some(s => s.startsWith('rm -rf .env'))).toBe(true);
  });

  it('does not split on then/do appearing inside a larger word', () => {
    // "thendoit" must not be split — keyword match is word-bounded.
    const segs = splitCommandSegments('runthendoit --flag').map(s => s.trim());
    expect(segs).toEqual(['runthendoit --flag']);
  });

  it('splits on command-substitution boundaries', () => {
    const segs = splitCommandSegments('echo "$(rm -rf ~)"').map(s => s.trim());
    expect(segs.some(s => s.startsWith('rm -rf'))).toBe(true);
  });
});

describe('stripWrapperPrefix', () => {
  it('strips sudo', () => {
    expect(stripWrapperPrefix('sudo git commit -m x').trim()).toBe('git commit -m x');
  });

  it('strips env with VAR=val assignments', () => {
    expect(stripWrapperPrefix('env FOO=bar BAZ=1 git commit -m x').trim()).toBe('git commit -m x');
  });

  it('strips time / nice / nohup', () => {
    expect(stripWrapperPrefix('time git commit -m x').trim()).toBe('git commit -m x');
    expect(stripWrapperPrefix('nice git commit -m x').trim()).toBe('git commit -m x');
    expect(stripWrapperPrefix('nohup git commit -m x').trim()).toBe('git commit -m x');
  });

  it('strips nice with a -n level', () => {
    expect(stripWrapperPrefix('nice -n 10 git commit -m x').trim()).toBe('git commit -m x');
  });

  it('strips xargs (with flags)', () => {
    expect(stripWrapperPrefix('xargs -I{} git commit -m x').trim()).toBe('git commit -m x');
  });

  it('strips command / exec / doas / builtin', () => {
    expect(stripWrapperPrefix('command git commit -m x').trim()).toBe('git commit -m x');
    expect(stripWrapperPrefix('exec git commit -m x').trim()).toBe('git commit -m x');
    expect(stripWrapperPrefix('doas git commit -m x').trim()).toBe('git commit -m x');
  });

  it('leaves a bare command untouched', () => {
    expect(stripWrapperPrefix('git commit -m x').trim()).toBe('git commit -m x');
  });

  it('strips stacked wrappers', () => {
    expect(stripWrapperPrefix('sudo env FOO=1 nice git commit -m x').trim()).toBe('git commit -m x');
  });

  // ── Bare inline env-assignment prefix (no `env` keyword) — the shared-splitter
  //    root fix for the commit-guard M and guardrail finding-1 bypasses. `FOO=bar
  //    git commit` used to skip commit.js's scan; `FOO=bar rm -rf .env` downgraded
  //    the zeroAccessPaths hard block to an escalatable nudge. ──
  it('strips a single bare VAR=val assignment prefix', () => {
    expect(stripWrapperPrefix('FOO=bar git commit -m x').trim()).toBe('git commit -m x');
    expect(stripWrapperPrefix('FOO=bar rm -rf .env').trim()).toBe('rm -rf .env');
  });

  it('strips multiple stacked bare assignments', () => {
    expect(stripWrapperPrefix('A=1 B=2 C=3 git commit -m x').trim()).toBe('git commit -m x');
    expect(stripWrapperPrefix('A=1 B=2 rm -rf .env').trim()).toBe('rm -rf .env');
  });

  it('strips an assignment with an empty value (VAR=)', () => {
    expect(stripWrapperPrefix('FOO= rm -rf .env').trim()).toBe('rm -rf .env');
  });

  it('strips a bare assignment nested under another wrapper', () => {
    expect(stripWrapperPrefix('sudo FOO=1 rm -rf .env').trim()).toBe('rm -rf .env');
    expect(stripWrapperPrefix('FOO=1 nice -n10 rm -rf .env').trim()).toBe('rm -rf .env');
  });

  it('treats a name literally called env with an assignment as a bare assignment, not the env command', () => {
    // `env=1` is a variable named `env`, NOT the env(1) wrapper — the `env`
    // branch needs whitespace after the token, so this falls to the bare form.
    expect(stripWrapperPrefix('env=1 git commit -m x').trim()).toBe('git commit -m x');
  });

  it('does NOT consume a leading `=` with no variable name (a lone `x=` from a $( split)', () => {
    // `x=$(...)` splits on `$(` to a bare `x=` segment; with no trailing command
    // it must be left intact (a name-less `=value` never matches).
    expect(stripWrapperPrefix('x=').trim()).toBe('x=');
    expect(stripWrapperPrefix('=foo bar').trim()).toBe('=foo bar');
  });

  it('leaves a bare command whose first token merely contains `=` in a later token untouched', () => {
    // `git -c user.email=x commit` — the head `git` is not an assignment, so the
    // bare-assignment branch must not fire (the `-c …=x` is a git option, handled
    // downstream by the commit-guard's own option walker).
    expect(stripWrapperPrefix('git -c user.email=x commit -m y').trim()).toBe('git -c user.email=x commit -m y');
  });

  // ── env OWN option flags (MAJOR-2): env's flags must be stripped too, not just
  //    NAME=value assignments, or a flag-decorated destructive verb bypasses the
  //    zeroAccess `.env` block. ──
  it('strips env option flags (no-value, lone-dash, long, combined) to the real head', () => {
    expect(stripWrapperPrefix('env -i rm .env').trim()).toBe('rm .env');
    expect(stripWrapperPrefix('env - rm .env').trim()).toBe('rm .env');
    expect(stripWrapperPrefix('env --ignore-environment rm -rf .env').trim()).toBe('rm -rf .env');
    expect(stripWrapperPrefix('env -0 -v rm .env').trim()).toBe('rm .env');
  });

  it('strips env value-taking flags with a SEPARATE value (-u NAME / -C DIR) without leaving the value as the head', () => {
    expect(stripWrapperPrefix('env -u PATH rm .env').trim()).toBe('rm .env');
    const home = ['', 'home', 'dom'].join('/');
    expect(stripWrapperPrefix(`env -C ${home} rm -rf .env`).trim()).toBe('rm -rf .env');
    expect(stripWrapperPrefix('env --unset PATH rm .env').trim()).toBe('rm .env');
    expect(stripWrapperPrefix('env --unset=PATH rm .env').trim()).toBe('rm .env');
  });

  it('strips a mix of env flags and assignments interleaved', () => {
    expect(stripWrapperPrefix('env -i A=1 -u PATH rm .env').trim()).toBe('rm .env');
  });

  it('does not over-strip benign env usage (leaves a non-delete head)', () => {
    expect(stripWrapperPrefix('env -i printenv').trim()).toBe('printenv');
    expect(stripWrapperPrefix('env FOO=1 node build.js').trim()).toBe('node build.js');
  });

  // ── nice arbitrary flags (MAJOR-2 same-class): --adjustment and any leading flag ──
  it('strips nice --adjustment (attached or separate) and arbitrary flags', () => {
    expect(stripWrapperPrefix('nice --adjustment=10 rm .env').trim()).toBe('rm .env');
    expect(stripWrapperPrefix('nice --adjustment 10 rm -rf .env').trim()).toBe('rm -rf .env');
    expect(stripWrapperPrefix('nice -n 5 rm .env').trim()).toBe('rm .env');
  });

  // ── timeout / stdbuf wrappers (MAJOR-2 same-class) ──
  it('strips timeout + its flags + the DURATION positional', () => {
    expect(stripWrapperPrefix('timeout 5 rm .env').trim()).toBe('rm .env');
    expect(stripWrapperPrefix('timeout 5s truncate -s0 .env').trim()).toBe('truncate -s0 .env');
    expect(stripWrapperPrefix('timeout -k 10 5 rm .env').trim()).toBe('rm .env');
    expect(stripWrapperPrefix('timeout --signal=9 5 shred .env').trim()).toBe('shred .env');
  });

  it('strips stdbuf buffering options (attached and separate)', () => {
    expect(stripWrapperPrefix('stdbuf -oL rm .env').trim()).toBe('rm .env');
    expect(stripWrapperPrefix('stdbuf -o L rm -rf .env').trim()).toBe('rm -rf .env');
  });

  it('never throws on odd wrapper input (fail-closed guarantee)', () => {
    for (const s of ['env', 'env ', 'nice', 'timeout', 'stdbuf -', 'env -u']) {
      expect(() => stripWrapperPrefix(s)).not.toThrow();
    }
  });
});
