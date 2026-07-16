// Supplementary adversarial coverage for CR-1.2 code-review follow-up (M3/M4) —
// two further guardrail bypasses of the non-escalatable zeroAccessPaths block,
// each confirmed with a repro. This file ADDS coverage; it never weakens
// guardrail.test.js or guardrail.bypass.test.js.
//
//   M3 — backslash-newline continuation: `rm -rf \`⏎`.env` splits on the `\n`,
//        orphaning `.env` so it is never extracted → only the escalatable
//        `rm -rf` nudge fires instead of the hard zeroAccessPaths block. Fixed
//        by the line-continuation collapse in the shared splitter.
//   M4 — UNQUOTED heredoc command substitution: an unquoted `<<EOF` body is
//        expanded by bash, so `$(rm -rf .env)` in it executes; the heredoc
//        blanking used to collapse it to `-m ""` before the delete was seen.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { processEvent } = require('../guardrail.cjs');
const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');

// `.env` is a zeroAccessPaths (non-escalatable) target; `rm -rf` is a nudge.
const RULES = `
block_patterns: []
nudge_patterns:
  - "rm -rf"
zeroAccessPaths:
  - ".env"
`;

describe('guardrail evasions — continuation & unquoted-heredoc bypasses (M3/M4)', () => {
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
  const blocked = (cmd) => {
    const r = processEvent({ tool_input: { command: cmd } });
    return !!(r && r.block);
  };

  it('baseline: bare `rm -rf .env` is a non-escalatable hard block', () => {
    expect(hardBlocked('rm -rf .env')).toBe(true);
  });

  it('M3: `rm -rf \\`⏎`.env` is ALSO a hard block (continuation collapsed)', () => {
    expect(hardBlocked('rm -rf \\\n.env')).toBe(true);
    expect(hardBlocked('rm -rf \\\r\n.env')).toBe(true);
  });

  it('M3: continuation-split delete chained after a benign command still hard-blocks', () => {
    expect(hardBlocked('echo hi && rm -rf \\\n.env')).toBe(true);
  });

  it('M4: UNQUOTED heredoc `$(cat <<EOF … $(rm -rf .env) … EOF)` is blocked', () => {
    const cmd = 'git commit -m "$(cat <<EOF\n$(rm -rf .env)\nEOF\n)"';
    expect(blocked(cmd)).toBe(true);
  });

  it('M4: a QUOTED heredoc `<<\'EOF\'` benign body is still blanked (no false positive)', () => {
    // Quoted delimiter → inert body → safe to blank → the message text
    // "rm -rf .env" is not a real delete, so this must NOT block.
    const cmd = 'git commit -m "$(cat <<\'EOF\'\nfix: prevent rm -rf .env accidents\nEOF\n)"';
    const r = processEvent({ tool_input: { command: cmd } });
    expect(r).toBeNull();
  });

  it('legit inline message mentioning a protected path is not blocked (F61 preserved)', () => {
    const r = processEvent({ tool_input: { command: 'git commit -m "fix: guard rm -rf .env"' } });
    expect(r).toBeNull();
  });
});
