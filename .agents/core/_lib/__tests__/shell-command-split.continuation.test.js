// Supplementary coverage for CR-1.2 code-review follow-up (M1/M3 root cause):
// bash line-continuation (`\` immediately before a newline) must be collapsed
// BEFORE splitting, so a command broken across physical lines is treated as the
// single logical command bash actually runs. This file ADDS coverage; it never
// weakens shell-command-split.test.js.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  splitCommandSegments,
  collapseLineContinuations,
} = require('../../../../.agents/core/_lib/shell-command-split');

describe('collapseLineContinuations', () => {
  it('joins a backslash-newline continuation (LF)', () => {
    expect(collapseLineContinuations('git commit \\\n-m "x"')).toBe('git commit -m "x"');
  });

  it('joins a backslash-CRLF continuation', () => {
    expect(collapseLineContinuations('rm -rf \\\r\n.env')).toBe('rm -rf .env');
  });

  it('leaves a bare newline (no preceding backslash) intact', () => {
    expect(collapseLineContinuations('a\nb')).toBe('a\nb');
  });

  it('leaves a backslash NOT immediately before a newline intact', () => {
    // `\ ` then newline is not a bash continuation.
    expect(collapseLineContinuations('a\\ \nb')).toBe('a\\ \nb');
  });

  it('non-string input is returned unchanged (never throws)', () => {
    expect(collapseLineContinuations(null)).toBe(null);
    expect(collapseLineContinuations(undefined)).toBe(undefined);
  });
});

describe('splitCommandSegments — line-continuation aware (M1/M3)', () => {
  it('a continued `git commit \\`⏎`-m x` stays ONE segment with git commit at head', () => {
    const segs = splitCommandSegments('git commit \\\n-m "x"').map(s => s.trim());
    expect(segs.some(s => s.startsWith('git commit -m'))).toBe(true);
    // The orphaned `-m "x"` must NOT appear as its own leading segment.
    expect(segs.some(s => s.startsWith('-m'))).toBe(false);
  });

  it('a continued `rm -rf \\`⏎`.env` keeps `.env` on the rm segment', () => {
    const segs = splitCommandSegments('rm -rf \\\n.env').map(s => s.trim());
    expect(segs.some(s => s === 'rm -rf .env')).toBe(true);
  });

  it('continuation collapse composes with real separators', () => {
    const segs = splitCommandSegments('echo hi && rm -rf \\\n.env').map(s => s.trim());
    expect(segs).toContain('echo hi');
    expect(segs.some(s => s === 'rm -rf .env')).toBe(true);
  });
});
