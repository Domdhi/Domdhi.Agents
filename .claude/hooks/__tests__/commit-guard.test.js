// Tests for commit-guard.cjs (PreToolUse:Bash) — forces commits through
// .claude/core/commit.js by blocking inline `git commit -m`.
//
// Coverage:
//   - gitCommitTail: detects `git commit` only at command positions (start / after
//     &&, ||, ;, |, newline, `(`), not inside echo/quoted strings
//   - hasInlineMessageFlag: -m, -am, -cm, --message (and = form)
//   - hasFileFlag / hasAmendFlag: escape hatches
//   - usesHelper: commit.js always passes
//   - processEvent: end-to-end block/pass decisions

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  processEvent,
  gitCommitTail,
  usesHelper,
  hasFileFlag,
  hasAmendFlag,
  hasInlineMessageFlag,
} = require('../commit-guard.cjs');

const evt = (command) => ({ tool_input: { command } });

describe('gitCommitTail', () => {
  it('matches git commit at start of command', () => {
    expect(gitCommitTail('git commit -m "x"')).toBe(' -m "x"');
  });

  it('matches git commit after a shell separator', () => {
    expect(gitCommitTail('git add -A && git commit -m "x"')).toContain('-m');
    expect(gitCommitTail('foo; git commit --amend')).toContain('--amend');
  });

  it('returns null when git commit is not an invocation', () => {
    expect(gitCommitTail('echo "run git commit -m later"')).toBeNull();
    expect(gitCommitTail('git status')).toBeNull();
    expect(gitCommitTail('ls')).toBeNull();
  });
});

describe('flag detectors', () => {
  it('hasInlineMessageFlag detects -m / -am / -cm / --message', () => {
    expect(hasInlineMessageFlag(' -m "x"')).toBe(true);
    expect(hasInlineMessageFlag(' -am "x"')).toBe(true);
    expect(hasInlineMessageFlag(' -cm "x"')).toBe(true);
    expect(hasInlineMessageFlag(' --message "x"')).toBe(true);
    expect(hasInlineMessageFlag(' --message="x"')).toBe(true);
  });

  it('hasInlineMessageFlag detects ATTACHED message forms (git glues the value to the flag)', () => {
    // git accepts the value directly after the flag with no space. These slipped
    // past the old regex (char after `m` had to be space/=/end) — a live bypass
    // that also skipped commit.js's pre-commit secret scan.
    expect(hasInlineMessageFlag(' -m"x"')).toBe(true);
    expect(hasInlineMessageFlag(" -m'x'")).toBe(true);
    expect(hasInlineMessageFlag(' -mhello')).toBe(true);
    expect(hasInlineMessageFlag(' -am"x"')).toBe(true);
    expect(hasInlineMessageFlag(' -amhello')).toBe(true);
  });

  it('hasInlineMessageFlag is false for no inline message', () => {
    expect(hasInlineMessageFlag(' --amend')).toBe(false);
    expect(hasInlineMessageFlag(' -F .git/MSG')).toBe(false);
    expect(hasInlineMessageFlag('')).toBe(false);
    // Attached-form fix must not over-match message-free flags that merely
    // contain the letter m elsewhere in a long-flag token.
    expect(hasInlineMessageFlag(' --allow-empty-message')).toBe(false);
    expect(hasInlineMessageFlag(' --amend --no-edit')).toBe(false);
  });

  it('hasFileFlag / hasAmendFlag', () => {
    expect(hasFileFlag(' -F .git/MSG')).toBe(true);
    expect(hasFileFlag(' --file=.git/MSG')).toBe(true);
    expect(hasFileFlag(' -m "x"')).toBe(false);
    expect(hasAmendFlag(' --amend')).toBe(true);
    expect(hasAmendFlag(' -m "x"')).toBe(false);
  });

  it('usesHelper detects the sanctioned commit.js path', () => {
    expect(usesHelper('node .claude/core/commit.js --all')).toBe(true);
    expect(usesHelper('git commit -m "x"')).toBe(false);
  });
});

describe('processEvent', () => {
  it('BLOCKS inline git commit -m', () => {
    const r = processEvent(evt('git commit -m "feat: x"'));
    expect(r).toMatchObject({ block: true });
    expect(r.feedback).toContain('commit.js');
  });

  it('BLOCKS combined -am and after a separator', () => {
    expect(processEvent(evt('git commit -am "x"'))).toMatchObject({ block: true });
    expect(processEvent(evt('git add -A && git commit -m "x"'))).toMatchObject({ block: true });
  });

  it('BLOCKS attached-value message forms (-m"x" / -mhello / -am"x")', () => {
    // These bypassed the guard before the attached-form fix — and would have
    // committed with NO pre-commit secret scan.
    expect(processEvent(evt('git commit -m"feat: x"'))).toMatchObject({ block: true });
    expect(processEvent(evt('git commit -mhello'))).toMatchObject({ block: true });
    expect(processEvent(evt('git commit -am"x"'))).toMatchObject({ block: true });
    expect(processEvent(evt('git add -A && git commit -am"wip"'))).toMatchObject({ block: true });
  });

  it('PASSES the commit.js helper', () => {
    expect(processEvent(evt('node .claude/core/commit.js'))).toBeNull();
    expect(processEvent(evt('node .claude/core/commit.js --all'))).toBeNull();
  });

  it('PASSES file-based and editor escape hatches', () => {
    expect(processEvent(evt('git commit -F docs/.output/.state/.commit-msg'))).toBeNull();
    expect(processEvent(evt('git commit --amend'))).toBeNull();
    expect(processEvent(evt('git commit'))).toBeNull();
  });

  it('PASSES non-commit commands and empty input', () => {
    expect(processEvent(evt('git status'))).toBeNull();
    expect(processEvent(evt('echo "git commit -m fake"'))).toBeNull();
    expect(processEvent(evt(''))).toBeNull();
    expect(processEvent({})).toBeNull();
  });

  it('BLOCKS amend WITH an inline message', () => {
    expect(processEvent(evt('git commit --amend -m "x"'))).toMatchObject({ block: true });
  });
});
