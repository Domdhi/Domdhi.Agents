// AC→source map (CR-1.2 — guardrail command-boundary bypasses, F61/F62):
//   - F62: a keyword-wrapped delete of a zeroAccessPaths file still hits the
//     non-escalatable HARD block (parity between bare and if/then-wrapped forms)
//   - F61: stripCommitMessages must NOT blank a $(...) command substitution inside
//     a -m argument before path evaluation — `echo -m "$(rm -rf .env)"` must still
//     be evaluated for the rm -rf .env target and blocked

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { processEvent } = require('../../../.agents/hooks/guardrail.cjs');
const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');

// A rules file that makes `.env` a zeroAccessPaths (non-escalatable) target.
const RULES = `
block_patterns: []
nudge_patterns:
  - "rm -rf"
zeroAccessPaths:
  - ".env"
`;

describe('guardrail: keyword/substitution delete bypasses (F61/F62)', () => {
  let tmp;
  let originalDir;

  beforeEach(() => {
    tmp = createTmpDir();
    originalDir = process.env.CLAUDE_PROJECT_DIR;
    tmp.write('.claude/guardrail-rules.yaml', RULES);
    tmp.write('.env', 'SECRET=1');
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
  });

  afterEach(() => {
    if (originalDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalDir;
    tmp.cleanup();
  });

  const hardBlocked = (cmd) => {
    const r = processEvent({ tool_input: { command: cmd } });
    return !!(r && r.block && r.telemetry && r.telemetry.tier === 'zeroAccessPaths');
  };

  it('bare `rm -rf .env` is a non-escalatable hard block (baseline)', () => {
    expect(hardBlocked('rm -rf .env')).toBe(true);
  });

  it('F62: `if true; then rm -rf .env; fi` is ALSO a hard block (keyword parity)', () => {
    expect(hardBlocked('if true; then rm -rf .env; fi')).toBe(true);
  });

  it('F62: `for i in 1; do rm -rf .env; done` is ALSO a hard block', () => {
    expect(hardBlocked('for i in 1; do rm -rf .env; done')).toBe(true);
  });

  it('F61: `echo -m "$(rm -rf .env)"` is still evaluated for the rm -rf .env target and blocked', () => {
    const r = processEvent({ tool_input: { command: 'echo -m "$(rm -rf .env)"' } });
    expect(r && r.block).toBe(true);
  });
});
