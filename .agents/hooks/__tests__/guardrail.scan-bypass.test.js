// guardrail: the audited secret-scan bypass is the USER's decision, so any agent command that assigns the
// CLAUDE_COMMIT_NO_SCAN variable, or passes commit.js --no-scan, goes to the confirm tier (SEC-MINOR-3 and its
// closure residual: the value can be written $'1', $(echo 1), `echo 1`, "1", or built by printf -v / export /
// declare / env, so the rule matches the NAME, not the literal =1).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseYaml, checkRules } = require('../guardrail.cjs');

const rules = parseYaml(fs.readFileSync(path.resolve(__dirname, '..', '..', 'config', 'guardrail-rules.yaml'), 'utf8'));
const action = cmd => checkRules(cmd, rules).action;

describe('the secret-scan bypass asks the user, however the variable is assigned', () => {
  const mustAsk = [
    'CLAUDE_COMMIT_NO_SCAN=1 git commit -F f',
    'CLAUDE_COMMIT_NO_SCAN="1" git commit -F f',
    "CLAUDE_COMMIT_NO_SCAN='1' git commit -F f",
    "CLAUDE_COMMIT_NO_SCAN=$'1' git commit -F f",
    'CLAUDE_COMMIT_NO_SCAN=$(echo 1) git commit -F f',
    'CLAUDE_COMMIT_NO_SCAN=`echo 1` git commit -F f',
    'CLAUDE_COMMIT_NO_SCAN=yes git commit -F f',                 // the scanner reads only =1, the rule asks for any value
    'CLAUDE_COMMIT_NO_SCAN=0 git commit -F f',
    'CLAUDE_COMMIT_NO_SCAN= git commit -F f',
    'export CLAUDE_COMMIT_NO_SCAN=1',
    'export CLAUDE_COMMIT_NO_SCAN="$x"',
    'export CLAUDE_COMMIT_NO_SCAN',
    'declare -x CLAUDE_COMMIT_NO_SCAN=1',
    'env CLAUDE_COMMIT_NO_SCAN=1 git commit -F f',
    'env -i CLAUDE_COMMIT_NO_SCAN=1 git commit -F f',
    'printf -v CLAUDE_COMMIT_NO_SCAN 1; export CLAUDE_COMMIT_NO_SCAN; git commit -F f',
    'read CLAUDE_COMMIT_NO_SCAN <<< 1',
    'CLAUDE_COMMIT_NO_SCAN+=1 git commit -F f',
    'git push && CLAUDE_COMMIT_NO_SCAN=1 git push',
    'CLAUDE_COMMIT_NO_"SCAN"=1 git commit -F f',                 // the name split by a quote
    'node .claude/core/commit.js --no-scan',
    'node .claude/core/commit.js --all --no-scan',
    'node .codex/core/commit.js --paths a b --no-scan',
    'node .claude/core/commit.js --no-"scan"',
    "node .claude/core/commit.js '--no-scan'",
  ];
  for (const cmd of mustAsk) {
    it(`asks: ${cmd}`, () => {
      expect(action(cmd)).toBe('confirm');
    });
  }

  const mustNotAsk = [
    'node .claude/core/commit.js --all',
    'node .claude/core/commit.js --paths a b',
    'git commit -F docs/.output/.state/.commit-msg',
    'git status',
    'CLAUDE_PROJECT_DIR=/x node .claude/core/commit.js --all',
    'echo no-scan',
    'ls',
  ];
  for (const cmd of mustNotAsk) {
    it(`does not ask: ${cmd}`, () => {
      expect(action(cmd)).not.toBe('confirm');
    });
  }
});
