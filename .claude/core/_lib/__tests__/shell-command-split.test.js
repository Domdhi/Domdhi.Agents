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
const { splitCommandSegments, stripWrapperPrefix } = require('../shell-command-split');

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
});
