// AC→source map (CR-1.2 — commit-guard command-boundary bypasses, F58/F59):
//   - `git commit -m` must be detected & BLOCKED at ANY command head, not just
//     string-start or the narrow &&/||/;/|/(/newline set:
//       - single & (background):            `sleep 1 & git commit -m x`
//       - if/then keyword:                  `if true; then git commit -m x; fi`
//       - for/do keyword:                   `for i in 1; do git commit -m x; done`
//       - command wrappers:                 `sudo|env|time|nice|nohup|xargs git commit -m x`
//   - commit.js path still passes (sanctioned)
//   - fail-closed: parser exception → block, never allow

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { processEvent } = require('../commit-guard.cjs');

const evt = (command) => ({ tool_input: { command } });
const isBlocked = (cmd) => {
  const r = processEvent(evt(cmd));
  return !!(r && r.block);
};

describe('commit-guard: command-boundary bypasses are blocked (F58/F59)', () => {
  const bypasses = [
    'sleep 1 & git commit -m "x"',
    'if true; then git commit -m "x"; fi',
    'for i in 1; do git commit -m "x"; done',
    'sudo git commit -m "x"',
    'env FOO=bar git commit -m "x"',
    'time git commit -m "x"',
    'nice git commit -m "x"',
    'nohup git commit -m "x"',
    'xargs -I{} git commit -m "x"',
  ];

  for (const cmd of bypasses) {
    it(`blocks: ${cmd}`, () => {
      expect(isBlocked(cmd)).toBe(true);
    });
  }
});

describe('commit-guard: sanctioned & benign forms still pass', () => {
  it('commit.js helper passes', () => {
    expect(isBlocked('node .claude/core/commit.js --all')).toBe(false);
  });
  it('git commit -F <file> passes', () => {
    expect(isBlocked('git commit -F docs/.output/.state/.commit-msg')).toBe(false);
  });
  it('plain git commit (editor) passes', () => {
    expect(isBlocked('git commit')).toBe(false);
  });
  it('echo mentioning git commit -m does not false-positive', () => {
    expect(isBlocked('echo "run git commit -m to commit"')).toBe(false);
  });
});
