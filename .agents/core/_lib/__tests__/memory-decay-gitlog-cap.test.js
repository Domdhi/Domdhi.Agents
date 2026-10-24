// AC→source map (M4 / memory-decay git-log cap):
//   createActiveDaysResolver.ensureCache runs a SYNCHRONOUS execSync('git log …').
//   session-start-prime's advertised 2s hard-timeout is a setTimeout — it cannot
//   preempt a blocked event loop — so the git log MUST be bounded with -n <cap>,
//   otherwise a huge repo blocks every session start up to the inner 5s ceiling.
//   This asserts the command carries a generous -n cap.
//
// Mock strategy mirrors memory-extractor.test.js: memory-decay does
// `const { execSync } = require('child_process')`, capturing the reference at load.
// We must install our wrapper on child_process BEFORE requiring memory-decay.

import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const childProcess = require('child_process');
const _origExecSync = childProcess.execSync;
let lastCmd = null;
childProcess.execSync = function (cmd) {
  lastCmd = String(cmd);
  return ''; // empty commit list — resolver builds an empty cache, no real repo needed
};

// NOW load — its destructured execSync binds our wrapper.
const { createActiveDaysResolver } = require('../../../../.agents/core/_lib/memory-decay');

afterAll(() => { childProcess.execSync = _origExecSync; });

describe('createActiveDaysResolver git-log cap (M4)', () => {
  it('bounds the commit scan with a generous -n so the sync execSync never runs unbounded', () => {
    lastCmd = null;
    const resolver = createActiveDaysResolver({ projectRoot: '/nonexistent-for-test' });
    // Lazy: the git log fires on the first getActiveDaysSince.
    const days = resolver.getActiveDaysSince('2020-01-01T00:00:00Z');

    expect(lastCmd).not.toBeNull();
    expect(lastCmd).toContain('git log');
    const capMatch = lastCmd.match(/-n\s+(\d+)/);
    expect(capMatch).not.toBeNull();               // the -n cap must be present
    expect(Number(capMatch[1])).toBeGreaterThanOrEqual(2000); // generous — normal repos unaffected

    // Empty commit list → zero active days, no throw.
    expect(days).toBe(0);
  });
});
