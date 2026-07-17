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

  it('BLOCKS a -F file flag co-present with an inline -m (the -F allow-path must not swallow -m)', () => {
    // git accepts BOTH: it appends the inline message and the commit still
    // skips commit.js's pre-commit secret scan — so -F alone is no longer an
    // unconditional pass; it only passes when NO inline message rides with it.
    expect(processEvent(evt('git commit -F f -m "secret"'))).toMatchObject({ block: true });
    expect(processEvent(evt('git commit -m "secret" -F f'))).toMatchObject({ block: true });
    expect(processEvent(evt('git commit -F f --message="secret"'))).toMatchObject({ block: true });
    // -F with no inline message is still the sanctioned file-based escape hatch.
    expect(processEvent(evt('git commit -F docs/.output/.state/.commit-msg'))).toBeNull();
  });

  it('BLOCKS a bare env-assignment prefix on an inline commit (no `env` keyword)', () => {
    expect(processEvent(evt('FOO=bar git commit -m "secret"'))).toMatchObject({ block: true });
    expect(processEvent(evt('A=1 B=2 git commit -m "secret"'))).toMatchObject({ block: true });
    // ...but the bare-assignment prefix on a file-based commit still passes.
    expect(processEvent(evt('FOO=bar git commit -F docs/.output/.state/.commit-msg'))).toBeNull();
  });
});

// ── Finding 2 (retry): fail CLOSED on a truncated/wedged stdin read. Claude Code
//    only blocks a Bash call on exit 2; a wedged pipe / truncated JSON must BLOCK
//    (never exit 0, which would let an inline `git commit -m` skip commit.js's
//    pre-commit secret scan), WHILE a legitimate empty/valid payload still passes. ──
describe('commit-guard main fail-closed on stdin (spawned process)', () => {
  const nodePath = require('node:path');
  const { execFileSync, spawn } = require('node:child_process');
  const hookPath = require.resolve('../commit-guard.cjs');
  const REPO = nodePath.resolve(nodePath.dirname(hookPath), '..', '..');

  function runHook(input) {
    try {
      const stdout = execFileSync('node', [hookPath], {
        input,
        env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
        stdio: 'pipe',
      });
      return { exitCode: 0, stdout: stdout.toString(), stderr: '' };
    } catch (err) {
      return { exitCode: err.status, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || '' };
    }
  }

  it('malformed/truncated JSON on non-empty stdin → BLOCKS (exit 2), not exit 0', () => {
    const result = runHook('{"tool_input":{"command":"git commit -m \\"x\\""');
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('fail-closed');
  });

  it('wedged pipe (stdin never closes) → times out and BLOCKS (exit 2)', async () => {
    const child = spawn('node', [hookPath], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO, HOOK_STDIN_TIMEOUT_MS: '150' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write('{"tool_input":'); // truncated; stdin intentionally left open
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const exitCode = await new Promise((resolve) => child.on('exit', resolve));
    expect(exitCode).toBe(2);
    expect(stderr).toContain('fail-closed');
  });

  it('legitimate EMPTY stdin (clean end) → passes (exit 0), no regression', () => {
    expect(runHook('').exitCode).toBe(0);
  });

  it('legitimate VALID JSON (non-commit command) → passes (exit 0), no regression', () => {
    expect(runHook(JSON.stringify({ tool_input: { command: 'ls -la' } })).exitCode).toBe(0);
  });
});
