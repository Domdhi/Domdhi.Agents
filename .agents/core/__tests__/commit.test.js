// Tests for commit.js — the file-based commit helper.
//
// Strategy: exercise message sanitization via `--dry-run
// --file <path>`, which reads and normalizes the message file,
// prints the result, and exits WITHOUT invoking git. No git repo needed.
//
// Coverage:
//   - never adds automatic attribution, even with a legacy environment override
//   - preserves explicitly supplied message content
//   - trims trailing junk lines (stray @, quote, backtick, blanks)
//   - exits non-zero on an empty message or a missing file
//   - -m "message" inline flag (S-PI.8): skips file read, commits via -m args array

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { createGitRepo, gitAvailable } = require('./_helpers/git-fixture');

const COMMIT_JS = path.resolve(__dirname, '../../../.agents/core/commit.js');

/** Run commit.js --dry-run against a message file. Returns {status, stdout}. */
function runDryRun(msgFile, env = {}) {
  try {
    const stdout = execFileSync(
      'node',
      [COMMIT_JS, '--dry-run', '--file', msgFile],
      { encoding: 'utf8', env: { ...process.env, ...env } },
    );
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status ?? 1, stdout: (e.stdout || '') + (e.stderr || '') };
  }
}

describe('commit.js message handling', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'commit-test-' }); });
  afterEach(() => tmp.cleanup());

  it('preserves the message without adding attribution', () => {
    const f = tmp.write('MSG', 'feat: thing\n\nbody\n');
    const { status, stdout } = runDryRun(f);
    expect(status).toBe(0);
    expect(stdout).not.toContain('Co-Authored-By:');
    expect(fs.readFileSync(f, 'utf8')).toBe('feat: thing\n\nbody\n');
  });

  it('preserves an explicitly supplied trailer without adding another', () => {
    const f = tmp.write('MSG', 'feat: thing\n\nbody\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
    const { stdout } = runDryRun(f);
    const matches = stdout.match(/Co-Authored-By: Claude <noreply@anthropic\.com>/g) || [];
    expect(matches).toHaveLength(1);
    expect(fs.readFileSync(f, 'utf8')).toBe('feat: thing\n\nbody\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
  });

  it('ignores the removed CLAUDE_COMMIT_TRAILER setting', () => {
    const f = tmp.write('MSG', 'feat: thing\n');
    const { stdout } = runDryRun(f, {
      CLAUDE_COMMIT_TRAILER: 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>',
    });
    expect(stdout).not.toContain('Co-Authored-By:');
    expect(fs.readFileSync(f, 'utf8')).toBe('feat: thing\n');
  });

  it('trims trailing stray-token / blank lines', () => {
    const f = tmp.write('MSG', 'feat: thing\n\nbody\n@\n`\n\n');
    const { stdout } = runDryRun(f);
    // The stray @ / backtick lines must not survive into the message.
    const between = stdout.split('feat: thing')[1] || '';
    expect(between).not.toMatch(/^@$/m);
    expect(between).not.toMatch(/^`$/m);
  });
});

describe('commit.js error handling', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'commit-test-' }); });
  afterEach(() => tmp.cleanup());

  it('exits non-zero on an empty message', () => {
    const f = tmp.write('MSG', '\n\n  \n');
    const { status } = runDryRun(f);
    expect(status).not.toBe(0);
  });

  it('exits non-zero when the message file is missing', () => {
    const { status } = runDryRun(path.join(tmp.root, 'does-not-exist'));
    expect(status).not.toBe(0);
  });
});

// ─── Secret-scan gate (the pre-commit hook living inside commit.js) ──────────────
// commit.js runs secret-scanner.cjs --git-precommit over the staged set before
// committing. These exercise the FULL (non-dry-run) path against a real tmp repo,
// using the real scanner (resolved relative to commit.js's __dirname). A CG- key
// also verifies the new CoinGecko pattern end-to-end through the commit flow.

/** Run commit.js (full path) in repoPath with an explicit --file. {status, stdout}. */
function runCommit(repoPath, msgFile, extraArgs = [], env = {}) {
  try {
    const stdout = execFileSync('node', [COMMIT_JS, '--file', msgFile, ...extraArgs], {
      cwd: repoPath,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repoPath, ...env },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status ?? 1, stdout: (e.stdout || '') + (e.stderr || '') };
  }
}

function commitCount(repoPath) {
  try {
    return Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: repoPath, encoding: 'utf8',
    }).trim());
  } catch { return 0; }
}

describe('commit.js secret-scan gate', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'commit-scan-' }); });
  afterEach(() => tmp.cleanup());

  // Build CG- + 22 chars without writing a matchable literal in THIS source file.
  const cgKey = 'CG-' + 'abcDEF123456ghiJKL789mn';

  it.skipIf(!gitAvailable())('blocks a commit when a staged file contains a secret', () => {
    const repo = createGitRepo({ root: tmp.root });
    fs.writeFileSync(path.join(repo.repoPath, 'README.md'), '# init\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo.repoPath, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init', '--no-verify'], { cwd: repo.repoPath, stdio: 'pipe' });
    const before = commitCount(repo.repoPath);

    fs.writeFileSync(path.join(repo.repoPath, 'config.js'), `const k = "${cgKey}";\n`);
    execFileSync('git', ['add', 'config.js'], { cwd: repo.repoPath, stdio: 'pipe' });
    const msg = path.join(tmp.root, 'MSG');
    fs.writeFileSync(msg, 'feat: add config\n');

    const { status } = runCommit(repo.repoPath, msg);
    expect(status).not.toBe(0);                       // blocked
    expect(commitCount(repo.repoPath)).toBe(before);  // no new commit
  });

  it.skipIf(!gitAvailable())('--no-scan bypasses the gate and commits', () => {
    const repo = createGitRepo({ root: tmp.root });
    fs.writeFileSync(path.join(repo.repoPath, 'README.md'), '# init\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo.repoPath, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init', '--no-verify'], { cwd: repo.repoPath, stdio: 'pipe' });
    const before = commitCount(repo.repoPath);

    fs.writeFileSync(path.join(repo.repoPath, 'config.js'), `const k = "${cgKey}";\n`);
    execFileSync('git', ['add', 'config.js'], { cwd: repo.repoPath, stdio: 'pipe' });
    const msg = path.join(tmp.root, 'MSG');
    fs.writeFileSync(msg, 'feat: add config\n');

    const { status } = runCommit(repo.repoPath, msg, ['--no-scan']);
    expect(status).toBe(0);
    expect(commitCount(repo.repoPath)).toBe(before + 1);
  });

  it.skipIf(!gitAvailable())('blocks a commit when the secret engine is missing (fail closed, with an install hint)', () => {
    const repo = createGitRepo({ root: tmp.root });
    fs.writeFileSync(path.join(repo.repoPath, 'README.md'), '# init\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo.repoPath, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init', '--no-verify'], { cwd: repo.repoPath, stdio: 'pipe' });
    const before = commitCount(repo.repoPath);

    fs.writeFileSync(path.join(repo.repoPath, 'app.js'), 'const x = 1;\n');
    execFileSync('git', ['add', 'app.js'], { cwd: repo.repoPath, stdio: 'pipe' });
    const msg = path.join(tmp.root, 'MSG');
    fs.writeFileSync(msg, 'feat: add app\n');

    const { status, stdout } = runCommit(repo.repoPath, msg, [], { AGENTS_SECRET_ENGINE_BIN: path.join(tmp.root, 'no-such-engine') });
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/FAIL-CLOSED/);
    expect(stdout).toMatch(/secret-engine-install/);
    expect(commitCount(repo.repoPath)).toBe(before);
  });

  // The message is content too: a key in "fix: rotate <key>" would land in history and, after a push, on the remote.
  describe('commit message scan', () => {
    const awsInMessage = 'AKIA' + 'QW3ERTY7UIOP' + 'AS2D';
    function stagedRepo() {
      const repo = createGitRepo({ root: tmp.root });
      fs.writeFileSync(path.join(repo.repoPath, 'README.md'), '# init\n');
      execFileSync('git', ['add', 'README.md'], { cwd: repo.repoPath, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'init', '--no-verify'], { cwd: repo.repoPath, stdio: 'pipe' });
      fs.writeFileSync(path.join(repo.repoPath, 'app.js'), 'const x = 1;\n');
      execFileSync('git', ['add', 'app.js'], { cwd: repo.repoPath, stdio: 'pipe' });
      return repo;
    }

    it.skipIf(!gitAvailable())('blocks an inline -m message that contains a key, and writes no commit', () => {
      const repo = stagedRepo();
      const before = commitCount(repo.repoPath);
      const msg = path.join(tmp.root, 'MSG');
      fs.writeFileSync(msg, 'unused\n');
      const { status, stdout } = runCommit(repo.repoPath, msg, ['-m', `fix: rotate ${awsInMessage}`]);
      expect(status).not.toBe(0);
      expect(stdout).toMatch(/commit message contains what looks like a secret/);
      expect(stdout).toMatch(/AWS Access Key/);
      expect(stdout).not.toContain(awsInMessage);
      expect(commitCount(repo.repoPath)).toBe(before);
    });

    it.skipIf(!gitAvailable())('blocks a message file that was written by something other than the Write tool', () => {
      const repo = stagedRepo();
      const before = commitCount(repo.repoPath);
      const msg = path.join(tmp.root, 'MSG');
      fs.writeFileSync(msg, `fix: rotate\n\nold key was ${awsInMessage}\n`);
      const { status } = runCommit(repo.repoPath, msg);
      expect(status).not.toBe(0);
      expect(commitCount(repo.repoPath)).toBe(before);
    });

    it.skipIf(!gitAvailable())('allows a clean message', () => {
      const repo = stagedRepo();
      const before = commitCount(repo.repoPath);
      const msg = path.join(tmp.root, 'MSG');
      fs.writeFileSync(msg, 'fix: rotate the access key\n\nThe old one was revoked.\n');
      expect(runCommit(repo.repoPath, msg).status).toBe(0);
      expect(commitCount(repo.repoPath)).toBe(before + 1);
    });

    it.skipIf(!gitAvailable())('fails closed when the engine is missing, before any commit', () => {
      const repo = stagedRepo();
      const before = commitCount(repo.repoPath);
      const msg = path.join(tmp.root, 'MSG');
      fs.writeFileSync(msg, 'fix: something\n');
      const { status } = runCommit(repo.repoPath, msg, [], { AGENTS_SECRET_ENGINE_BIN: path.join(tmp.root, 'no-such-engine') });
      expect(status).not.toBe(0);
      expect(commitCount(repo.repoPath)).toBe(before);
    });

    it.skipIf(!gitAvailable())('--no-scan covers the message check too (and is logged as a bypass)', () => {
      const repo = stagedRepo();
      const before = commitCount(repo.repoPath);
      const msg = path.join(tmp.root, 'MSG');
      fs.writeFileSync(msg, `fix: rotate ${awsInMessage}\n`);
      expect(runCommit(repo.repoPath, msg, ['--no-scan']).status).toBe(0);
      expect(commitCount(repo.repoPath)).toBe(before + 1);
    });
  });

  it.skipIf(!gitAvailable())('--no-scan is recorded as its own guardrail event (decision bypass)', () => {
    const repo = createGitRepo({ root: tmp.root });
    fs.writeFileSync(path.join(repo.repoPath, 'README.md'), '# init\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo.repoPath, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init', '--no-verify'], { cwd: repo.repoPath, stdio: 'pipe' });
    fs.writeFileSync(path.join(repo.repoPath, 'app.js'), 'const x = 1;\n');
    execFileSync('git', ['add', 'app.js'], { cwd: repo.repoPath, stdio: 'pipe' });
    const msg = path.join(tmp.root, 'MSG');
    fs.writeFileSync(msg, 'feat: add app\n');

    const { status } = runCommit(repo.repoPath, msg, ['--no-scan']);
    expect(status).toBe(0);
    const rel = fs.readdirSync(repo.repoPath, { recursive: true }).map(String).find(f => f.endsWith('guardrail-events.jsonl'));
    expect(rel, 'guardrail-events.jsonl written under the project').toBeTruthy();
    const events = fs.readFileSync(path.join(repo.repoPath, rel), 'utf8').trim().split('\n').map(JSON.parse);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'bypass', rule: 'commit-no-scan', source: 'secret-scanner' });
  });

  it.skipIf(!gitAvailable())('allows a commit when staged content is clean', () => {
    const repo = createGitRepo({ root: tmp.root });
    fs.writeFileSync(path.join(repo.repoPath, 'README.md'), '# init\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo.repoPath, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init', '--no-verify'], { cwd: repo.repoPath, stdio: 'pipe' });
    const before = commitCount(repo.repoPath);

    fs.writeFileSync(path.join(repo.repoPath, 'app.js'), 'const x = 1;\nconsole.log(x);\n');
    execFileSync('git', ['add', 'app.js'], { cwd: repo.repoPath, stdio: 'pipe' });
    const msg = path.join(tmp.root, 'MSG');
    fs.writeFileSync(msg, 'feat: add app\n');

    const { status } = runCommit(repo.repoPath, msg, [], {
      CLAUDE_COMMIT_TRAILER: 'Co-Authored-By: Codex <noreply@openai.com>',
    });
    expect(status).toBe(0);
    expect(commitCount(repo.repoPath)).toBe(before + 1);
    const message = execFileSync('git', ['log', '-1', '--format=%B'], {
      cwd: repo.repoPath, encoding: 'utf8',
    });
    expect(message.trim()).toBe('feat: add app');
  });
});

// ─── Inline -m flag (S-PI.8) ─────────────────────────────────────────────────
// commit.js now accepts `-m "message"` so callers don't need to write a
// .commit-msg file first. The existing --file path must remain unchanged.

/** Run commit.js --dry-run with an inline -m message. Returns {status, stdout}. */
function runInlineMsg(msg, env = {}) {
  try {
    const stdout = execFileSync(
      'node',
      [COMMIT_JS, '--dry-run', '-m', msg],
      { encoding: 'utf8', env: { ...process.env, ...env } },
    );
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status ?? 1, stdout: (e.stdout || '') + (e.stderr || '') };
  }
}

describe('commit.js inline -m flag', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'commit-inline-' }); });
  afterEach(() => tmp.cleanup());

  it('inlineMessage_dryRun_printsMessageWithoutAttribution', () => {
    // -m dry-run must print the supplied message
    // and the "would run: ... commit -m" variant (not -F).
    const { status, stdout } = runInlineMsg('feat: x');
    expect(status).toBe(0);
    expect(stdout).toContain('feat: x');
    expect(stdout).not.toContain('Co-Authored-By:');
    expect(stdout).toMatch(/would run:.*commit -m/);
  });

  it('inlineMessage_dryRun_doesNotRequireMsgFile', () => {
    // Running -m in a directory with NO .commit-msg file must succeed (exit 0).
    // cwd is a brand-new empty tmp dir — no docs/.output/.state/.commit-msg present.
    try {
      const stdout = execFileSync(
        'node',
        [COMMIT_JS, '--dry-run', '-m', 'feat: no file needed'],
        { encoding: 'utf8', cwd: tmp.root, env: { ...process.env } },
      );
      // stdout present means exit 0 — confirm message text is included
      expect(stdout).toContain('feat: no file needed');
    } catch (e) {
      // Any non-zero exit from this path is a test failure
      throw new Error(
        `commit.js -m exited non-zero when no .commit-msg exists.\n` +
        `Output: ${(e.stdout || '') + (e.stderr || '')}`,
      );
    }
  });

  it('defaultPath_stillWorks', () => {
    // The --file dry-run path (the original behavior) must be unaffected.
    const f = tmp.write('MSG', 'feat: unchanged default path\n\nbody text\n');
    const { status, stdout } = runDryRun(f);
    expect(status).toBe(0);
    expect(stdout).toContain('feat: unchanged default path');
    expect(stdout).not.toContain('Co-Authored-By:');
    // Default path uses -F in the would-run line, not -m
    expect(stdout).toMatch(/would run:.*commit -F/);
  });

  it.skipIf(!gitAvailable())('inlineMessage_commit_noMsgFileCreated', () => {
    // Non-dry-run -m commit: subject appears in git log and NO .commit-msg
    // file is written to the repo working tree.
    const repo = createGitRepo({ root: tmp.root });
    // Stage a clean file so there is something to commit
    fs.writeFileSync(path.join(repo.repoPath, 'app.js'), 'const x = 1;\n');
    execFileSync('git', ['add', 'app.js'], { cwd: repo.repoPath, stdio: 'pipe' });
    const before = commitCount(repo.repoPath);

    try {
      execFileSync(
        'node',
        [COMMIT_JS, '-m', 'feat: inline commit test', '--no-scan'],
        {
          cwd: repo.repoPath,
          encoding: 'utf8',
          env: { ...process.env, CLAUDE_PROJECT_DIR: repo.repoPath },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch (e) {
      throw new Error(
        `commit.js -m commit failed.\nOutput: ${(e.stdout || '') + (e.stderr || '')}`,
      );
    }

    expect(commitCount(repo.repoPath)).toBe(before + 1);

    // Confirm the complete message has no added attribution.
    const message = execFileSync('git', ['log', '-1', '--format=%B'], {
      cwd: repo.repoPath, encoding: 'utf8',
    }).trim();
    expect(message).toBe('feat: inline commit test');

    // Confirm .commit-msg was NOT created in the repo root
    const msgFilePath = path.join(repo.repoPath, 'docs', '.output', '.state', '.commit-msg');
    expect(fs.existsSync(msgFilePath)).toBe(false);
  });
});

// ─── In-process unit tests for the extracted functions (testability refactor) ────
// commit.js now wraps its imperative body in named functions gated behind
// `if (require.main === module) { main(); }`. Requiring the module no longer
// auto-runs anything, so we can import the REAL functions and exercise the
// arg-parsing, message-read, and scan-invocation paths in-process
// with mocked git/fs seams. Every assertion calls the real function from
// require('../../../.agents/core/commit') — never a re-creation (R6 honesty).

const commit = require('../../../.agents/core/commit');

describe('commit.js — module exports (in-process)', () => {
  it('exports the commit functions', () => {
    expect(typeof commit.parseArgs).toBe('function');
    expect(typeof commit.readMessage).toBe('function');
    expect(typeof commit.runScan).toBe('function');
    expect(typeof commit.main).toBe('function');
  });
});

describe('commit.js parseArgs (in-process)', () => {
  let prevNoScanEnv;
  beforeEach(() => { prevNoScanEnv = process.env.CLAUDE_COMMIT_NO_SCAN; });
  afterEach(() => {
    if (prevNoScanEnv === undefined) delete process.env.CLAUDE_COMMIT_NO_SCAN;
    else process.env.CLAUDE_COMMIT_NO_SCAN = prevNoScanEnv;
  });

  it('defaults: no flags → file-based path to docs/.output/.state/.commit-msg', () => {
    delete process.env.CLAUDE_COMMIT_NO_SCAN;
    const r = commit.parseArgs([]);
    expect(r.stageAll).toBe(false);
    expect(r.amend).toBe(false);
    expect(r.dryRun).toBe(false);
    expect(r.inlineMsg).toBe(null);
    expect(r.fileIdx).toBe(-1);
    expect(r.noScan).toBe(false);
    expect(r.msgFile).toBe(path.join('docs', '.output', '.state', '.commit-msg'));
  });

  it('parses --all / -a, --amend, and --dry-run / -n', () => {
    expect(commit.parseArgs(['--all']).stageAll).toBe(true);
    expect(commit.parseArgs(['-a']).stageAll).toBe(true);
    expect(commit.parseArgs(['--amend']).amend).toBe(true);
    expect(commit.parseArgs(['--dry-run']).dryRun).toBe(true);
    expect(commit.parseArgs(['-n']).dryRun).toBe(true);
  });

  it('parses --file <path> into msgFile and records fileIdx', () => {
    const r = commit.parseArgs(['--file', '/tmp/custom-msg']);
    expect(r.fileIdx).toBe(0);
    expect(r.msgFile).toBe('/tmp/custom-msg');
    expect(r.inlineMsg).toBe(null);
  });

  it('parses -m <message> into inlineMsg', () => {
    const r = commit.parseArgs(['-m', 'feat: thing']);
    expect(r.inlineMsg).toBe('feat: thing');
  });

  it('--no-scan flag sets noScan true', () => {
    delete process.env.CLAUDE_COMMIT_NO_SCAN;
    expect(commit.parseArgs(['--no-scan']).noScan).toBe(true);
  });

  it('CLAUDE_COMMIT_NO_SCAN=1 env var sets noScan true', () => {
    process.env.CLAUDE_COMMIT_NO_SCAN = '1';
    expect(commit.parseArgs([]).noScan).toBe(true);
  });

  // ─── --paths (multi-process-safe explicit staging) ──────────────────────────
  it('no --paths → paths is null (back-compat)', () => {
    expect(commit.parseArgs([]).paths).toBe(null);
    expect(commit.parseArgs(['--all']).paths).toBe(null);
  });

  it('--paths collects every pathspec until the next flag', () => {
    expect(commit.parseArgs(['--paths', 'a.md', 'b.md']).paths).toEqual(['a.md', 'b.md']);
    // A trailing flag stops collection; --amend after the list still parses.
    const r = commit.parseArgs(['--paths', 'a.md', '--amend']);
    expect(r.paths).toEqual(['a.md']);
    expect(r.amend).toBe(true);
  });

  it('--paths composes with --dry-run and --file', () => {
    const r = commit.parseArgs(['--paths', 'x.cs', 'y.cs', '--dry-run', '--file', 'msg.txt']);
    expect(r.paths).toEqual(['x.cs', 'y.cs']);
    expect(r.dryRun).toBe(true);
    expect(r.msgFile).toBe('msg.txt');
  });

  it('bare --paths (no pathspec) throws', () => {
    expect(() => commit.parseArgs(['--paths'])).toThrow(/at least one pathspec/);
    expect(() => commit.parseArgs(['--paths', '--amend'])).toThrow(/at least one pathspec/);
  });

  it('--paths + --all is mutually exclusive (order-independent)', () => {
    expect(() => commit.parseArgs(['--paths', 'a.md', '--all'])).toThrow(/mutually exclusive/);
    expect(() => commit.parseArgs(['--all', '--paths', 'a.md'])).toThrow(/mutually exclusive/);
  });
});

describe('commit.js readMessage (in-process)', () => {
  let tmp;
  let exitSpy;
  let errSpy;
  beforeEach(() => {
    tmp = createTmpDir({ prefix: 'commit-readmsg-' });
    // Mock process.exit to throw so we can assert on the exit path without
    // killing the test runner (process-argv-injection pattern).
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    tmp.cleanup();
  });

  it('reads a file message, normalizes CRLF, and trims trailing junk lines', () => {
    const f = tmp.write('MSG', 'feat: thing\r\n\r\nbody\r\n@\r\n`\r\n\r\n');
    const lines = commit.readMessage(null, f);
    // CRLF normalized to LF, stray @ / backtick / blank trailing lines popped.
    expect(lines).toEqual(['feat: thing', '', 'body']);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('uses the inline message directly and never touches the file', () => {
    const lines = commit.readMessage('feat: inline\n\nbody', '/nonexistent/path');
    expect(lines).toEqual(['feat: inline', '', 'body']);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits non-zero when the message file is missing (no inline msg)', () => {
    const missing = path.join(tmp.root, 'does-not-exist');
    expect(() => commit.readMessage(null, missing)).toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits non-zero when the message is empty after trimming', () => {
    const f = tmp.write('MSG', '\n\n  \n');
    expect(() => commit.readMessage(null, f)).toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('commit.js runScan (in-process)', () => {
  let exitSpy, scanTmp, prevCwd;
  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    // Run outside any repository: runScan skips its own scan when the managed git hooks are active in the
    // current repository (a developer who installed them here must not change what these tests exercise).
    prevCwd = process.cwd();
    scanTmp = createTmpDir({ prefix: 'commit-runscan-' });
    process.chdir(scanTmp.root);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    scanTmp.cleanup();
    exitSpy.mockRestore();
  });

  it('is a no-op when noScan is true (never spawns the scanner)', () => {
    // With noScan true the function returns immediately; process.exit untouched.
    expect(() => commit.runScan(true)).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // commit.js destructures { spawnSync } from node:child_process at LOAD time, so a
  // post-load spy won't bind. We spy on the shared child_process export FIRST, then
  // loadFreshCommit() re-requires commit.js so it re-destructures the spied seam.
  // This asserts the OBSERVABLE side-effect (the scanner was spawned with the right
  // args) instead of merely "it didn't throw" — a stub that early-returns would fail
  // toHaveBeenCalled, closing the invocation-path false-green.
  it('spawns secret-scanner.cjs with --git-precommit when noScan is false', () => {
    const cp = require('node:child_process');
    const spawnSpy = vi.spyOn(cp, 'spawnSync').mockReturnValue({ status: 0 });
    try {
      const fresh = loadFreshCommit();
      fresh.runScan(false);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const [bin, args] = spawnSpy.mock.calls[0];
      expect(bin).toBe(process.execPath);
      expect(args[0]).toMatch(/secret-scanner\.cjs$/);
      expect(args[1]).toBe('--git-precommit');
      expect(exitSpy).not.toHaveBeenCalled(); // status 0 → clean scan, no abort
    } finally {
      spawnSpy.mockRestore();
      loadFreshCommit(); // restore a commit instance bound to the real seam for later tests
    }
  });

  it('fails closed when the scanner file is missing (it used to warn and commit unscanned)', () => {
    const real = fs.existsSync;
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation(p => (/secret-scanner\.cjs$/.test(String(p)) ? false : real(p)));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fresh = loadFreshCommit();
      expect(() => fresh.runScan(false)).toThrow(/process\.exit\(1\)/);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/secret scanner not found/);
    } finally {
      existsSpy.mockRestore();
      errSpy.mockRestore();
      loadFreshCommit();
    }
  });

  it('fails closed when the scanner cannot be started', () => {
    const cp = require('node:child_process');
    const spawnSpy = vi.spyOn(cp, 'spawnSync').mockReturnValue({ status: null, error: new Error('spawn failed') });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fresh = loadFreshCommit();
      expect(() => fresh.runScan(false)).toThrow(/process\.exit\(1\)/);
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/could not run the secret scanner/);
    } finally {
      spawnSpy.mockRestore();
      errSpy.mockRestore();
      loadFreshCommit();
    }
  });

  it('fails closed when the scanner is killed by a signal (status null)', () => {
    const cp = require('node:child_process');
    const spawnSpy = vi.spyOn(cp, 'spawnSync').mockReturnValue({ status: null, signal: 'SIGKILL' });
    try {
      const fresh = loadFreshCommit();
      expect(() => fresh.runScan(false)).toThrow(/process\.exit\(1\)/);
    } finally {
      spawnSpy.mockRestore();
      loadFreshCommit();
    }
  });

  it('aborts the commit via process.exit(status) when the scanner returns non-zero', () => {
    const cp = require('node:child_process');
    const spawnSpy = vi.spyOn(cp, 'spawnSync').mockReturnValue({ status: 3 });
    try {
      const fresh = loadFreshCommit();
      // mocked process.exit throws, so the non-zero abort path surfaces as a throw
      expect(() => fresh.runScan(false)).toThrow(/process\.exit\(3\)/);
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(3);
    } finally {
      spawnSpy.mockRestore();
      loadFreshCommit();
    }
  });
});

// ─── In-process main() orchestration (process-argv-injection pattern) ────────────
// main() reads process.argv at call time, so we set process.argv BEFORE calling the
// freshly-required main(), mock process.exit to throw (so exit paths don't kill the
// runner), and silence console. We bust the CJS require cache so each load is fresh
// (the documented load-time-env-capture pattern). These cover the dry-run branch and
// — against a real isolated tmp repo (chdir) — the full git/commit/cleanup branch.

function loadFreshCommit() {
  delete require.cache[require.resolve('../../../.agents/core/commit')];
  return require('../../../.agents/core/commit');
}

describe('commit.js main() — dry-run (in-process)', () => {
  let tmp, exitSpy, logSpy, errSpy, writeSpy, prevArgv;
  beforeEach(() => {
    tmp = createTmpDir({ prefix: 'commit-main-dry-' });
    prevArgv = process.argv;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    process.argv = prevArgv;
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
    tmp.cleanup();
  });

  it('file-based --dry-run: normalizes the file without attribution and exits 0', () => {
    const f = tmp.write('MSG', 'feat: thing\n\nbody\n');
    process.argv = ['node', 'commit.js', '--dry-run', '--file', f];
    const fresh = loadFreshCommit();
    expect(() => fresh.main()).toThrow(/process\.exit\(0\)/);
    // writeFileSync ran in the file-based path without appending attribution.
    const rewritten = fs.readFileSync(f, 'utf8');
    expect(rewritten).toBe('feat: thing\n\nbody\n');
    // The dry-run "would run: ... -F" line was logged (file-based variant).
    const logged = logSpy.mock.calls.flat().join('\n');
    expect(logged).toMatch(/would run:.*commit -F/);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('inline -m --dry-run: never writes a file and logs the -m would-run variant', () => {
    process.argv = ['node', 'commit.js', '--dry-run', '-m', 'feat: inline'];
    const fresh = loadFreshCommit();
    expect(() => fresh.main()).toThrow(/process\.exit\(0\)/);
    const logged = logSpy.mock.calls.flat().join('\n');
    expect(logged).toMatch(/would run:.*commit -m/);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe('commit.js main() — full commit against an isolated tmp repo (in-process)', () => {
  let tmp, exitSpy, logSpy, errSpy, prevArgv, prevCwd;
  beforeEach(() => {
    tmp = createTmpDir({ prefix: 'commit-main-full-' });
    prevArgv = process.argv;
    prevCwd = process.cwd();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(prevCwd);
    process.argv = prevArgv;
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    tmp.cleanup();
  });

  it.skipIf(!gitAvailable())('--all --no-scan: stages, commits, cleans up the msg file, logs done', () => {
    const repo = createGitRepo({ root: tmp.root });
    // Write a working-tree change and the default message file inside the repo.
    fs.writeFileSync(path.join(repo.repoPath, 'app.js'), 'const x = 1;\n');
    const defaultMsg = path.join(repo.repoPath, 'docs', '.output', '.state', '.commit-msg');
    fs.mkdirSync(path.dirname(defaultMsg), { recursive: true });
    fs.writeFileSync(defaultMsg, 'feat: in-process main commit\n');

    const before = commitCount(repo.repoPath);
    process.chdir(repo.repoPath);
    // No --file → default docs/.output/.state/.commit-msg path → exercises stageAll, scan
    // bypass, the -F commit branch, AND the default-path msg-file cleanup (fileIdx<0).
    process.argv = ['node', 'commit.js', '--all', '--no-scan'];
    const fresh = loadFreshCommit();

    // main() runs to the end (no process.exit on the happy path).
    fresh.main();

    expect(commitCount(repo.repoPath)).toBe(before + 1);
    // The default msg file was deleted after the successful commit (cleanup branch).
    expect(fs.existsSync(defaultMsg)).toBe(false);
    // The supplied message made it into the commit without added attribution.
    const full = execFileSync('git', ['log', '-1', '--format=%s%n%b'], {
      cwd: repo.repoPath, encoding: 'utf8',
    });
    expect(full).toContain('feat: in-process main commit');
    expect(full).not.toContain('Co-Authored-By:');
    // The "[commit] done:" line was logged.
    const logged = logSpy.mock.calls.flat().join('\n');
    expect(logged).toMatch(/\[commit\] done:/);
  });
});

// ─── First commit into a brand-new repo (unborn HEAD) ────────────────────────────
// `git init` with zero commits yet leaves HEAD an unresolvable symref — this is
// exactly the state of a just-scaffolded repo's very first commit (e.g. after
// `publish.js`/`scaffold.js` seed a new project). `git rev-parse --abbrev-ref HEAD`
// throws in this state; commit.js must not crash on it. Builds the repo directly
// with `git init` (NOT the git-fixture helper, which seeds an initial commit and so
// never reaches an unborn HEAD).

describe('commit.js main() — first commit into a brand-new repo (unborn HEAD)', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'commit-unborn-' }); });
  afterEach(() => tmp.cleanup());

  it.skipIf(!gitAvailable())('succeeds on a freshly `git init`-ed repo with zero prior commits', () => {
    const repoPath = tmp.root;
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath, stdio: 'pipe' });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoPath, stdio: 'pipe' });
    // Confirm the fixture really is at an unborn HEAD before trusting the assertion below.
    expect(() => execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, stdio: 'pipe' }))
      .toThrow();

    fs.writeFileSync(path.join(repoPath, 'README.md'), '# init\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'pipe' });
    const msg = path.join(repoPath, 'MSG');
    fs.writeFileSync(msg, 'chore: first commit\n');

    const { status, stdout } = runCommit(repoPath, msg, ['--no-scan']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/\[commit\] branch: main/);
    expect(commitCount(repoPath)).toBe(1);
  });
});

// ─── --paths against an isolated tmp repo (the multi-process-safe path) ──────────
// Proves the headline guarantee: --paths stages ONLY the listed file, so a
// concurrent process's in-flight file (other.md) never gets swept into the commit.
// Uses the same runCommit/createGitRepo helpers as the secret-scan gate tests.

describe('commit.js --paths (full path against tmp repo)', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'commit-paths-' }); });
  afterEach(() => tmp.cleanup());

  it.skipIf(!gitAvailable())('--dry-run --paths echoes the add and stages nothing', () => {
    const repo = createGitRepo({ root: tmp.root });
    fs.writeFileSync(path.join(repo.repoPath, 'wanted.md'), 'wanted\n');
    const msg = path.join(tmp.root, 'MSG');
    fs.writeFileSync(msg, 'feat: dry run\n');

    const { status, stdout } = runCommit(repo.repoPath, msg, ['--dry-run', '--paths', 'wanted.md']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/would run: git add -- wanted\.md/);
    // Dry-run must stage nothing.
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: repo.repoPath, encoding: 'utf8',
    }).trim();
    expect(staged).toBe('');
  });

  it.skipIf(!gitAvailable())('live --paths stages ONLY the listed file, leaving a concurrent file untouched', () => {
    const repo = createGitRepo({ root: tmp.root });
    // Our file + a concurrent process's in-flight file side by side.
    fs.writeFileSync(path.join(repo.repoPath, 'wanted.md'), 'wanted\n');
    fs.writeFileSync(path.join(repo.repoPath, 'other.md'), 'concurrent\n');
    const msg = path.join(tmp.root, 'MSG');
    fs.writeFileSync(msg, 'feat: paths only\n');

    const before = commitCount(repo.repoPath);
    const { status } = runCommit(repo.repoPath, msg, ['--paths', 'wanted.md', '--no-scan']);
    expect(status).toBe(0);
    expect(commitCount(repo.repoPath)).toBe(before + 1);

    // The commit contains wanted.md and NOT other.md.
    const committed = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], {
      cwd: repo.repoPath, encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);
    expect(committed).toEqual(['wanted.md']);

    // other.md must remain untracked.
    const stillUntracked = execFileSync('git', ['status', '--porcelain', 'other.md'], {
      cwd: repo.repoPath, encoding: 'utf8',
    }).trim();
    expect(stillUntracked).toMatch(/^\?\? other\.md/);
  });

  // The source side of a `git mv` has its deletion staged and matches nothing in the worktree or the
  // index; `git add` on it fails with "pathspec did not match", so --paths must skip it.
  it.skipIf(!gitAvailable())('--paths skips a path whose deletion is already staged and commits the rename', () => {
    const repo = createGitRepo({ root: tmp.root });
    fs.writeFileSync(path.join(repo.repoPath, 'old.md'), 'moved content\n');
    execFileSync('git', ['add', 'old.md'], { cwd: repo.repoPath, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'seed', '--no-verify'], { cwd: repo.repoPath, stdio: 'pipe' });
    execFileSync('git', ['mv', 'old.md', 'new.md'], { cwd: repo.repoPath, stdio: 'pipe' });
    const msg = path.join(tmp.root, 'MSG');
    fs.writeFileSync(msg, 'refactor: rename\n');

    const before = commitCount(repo.repoPath);
    const { status, stdout } = runCommit(repo.repoPath, msg, ['--paths', 'old.md', 'new.md', '--no-scan']);
    expect(status, stdout).toBe(0);
    expect(stdout).toMatch(/old\.md: deletion already staged, skipping git add/);
    expect(commitCount(repo.repoPath)).toBe(before + 1);
    const committed = execFileSync('git', ['show', '--name-status', '--format=', '-M', 'HEAD'], {
      cwd: repo.repoPath, encoding: 'utf8',
    }).trim();
    expect(committed).toMatch(/^R\d+\s+old\.md\s+new\.md$/);
  });

  it.skipIf(!gitAvailable())('--paths still fails loudly on a path that matches nothing and has no staged deletion', () => {
    const repo = createGitRepo({ root: tmp.root });
    fs.writeFileSync(path.join(repo.repoPath, 'real.md'), 'real\n');
    const msg = path.join(tmp.root, 'MSG');
    fs.writeFileSync(msg, 'feat: typo\n');
    const before = commitCount(repo.repoPath);
    const { status, stdout } = runCommit(repo.repoPath, msg, ['--paths', 'real.md', 'raal.md', '--no-scan']);
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/raal\.md|pathspec/);
    expect(commitCount(repo.repoPath)).toBe(before);
  });

  it.skipIf(!gitAvailable())('--paths + --all exits non-zero (mutually exclusive)', () => {
    const repo = createGitRepo({ root: tmp.root });
    const msg = path.join(tmp.root, 'MSG');
    fs.writeFileSync(msg, 'feat: conflict\n');
    const { status, stdout } = runCommit(repo.repoPath, msg, ['--paths', 'x.md', '--all']);
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/mutually exclusive/);
  });
});

// ── SF-1.4: commit.js --ship-check opt-in precheck ─────────────────────────────
// The precheck runs ship-check.js verify (the real judge, spawned) after the message is read and
// before anything is staged. A refusal, a crash or a timeout refuses the commit with the index untouched.
describe('commit.js --ship-check (SF-1.4)', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'commit-shipcheck-' }); });
  afterEach(() => tmp.cleanup());

  // A repo with one commit, an unstaged edit (so --paths/--all would have something to stage),
  // and a gate config that either turns the ship check off (it passes) or leaves it on with no
  // seal (it refuses, fail closed).
  function repoWith({ shipCheck } = {}) {
    const repo = createGitRepo({ root: tmp.root });
    const r = repo.repoPath;
    fs.writeFileSync(path.join(r, 'README.md'), '# init\n');
    if (shipCheck !== undefined) {
      fs.mkdirSync(path.join(r, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(r, '.claude', 'gate.config.json'), JSON.stringify({ shipCheck }));
    }
    execFileSync('git', ['add', '-A'], { cwd: r, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init', '--no-verify'], { cwd: r, stdio: 'pipe' });
    fs.writeFileSync(path.join(r, 'app.js'), 'const x = 1;\n');
    return r;
  }
  const msgFile = () => { const m = path.join(tmp.root, 'MSG'); fs.writeFileSync(m, 'feat: wave\n'); return m; };
  const staged = (r) => execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: r, encoding: 'utf8' }).trim();
  const indexTree = (r) => execFileSync('git', ['write-tree'], { cwd: r, encoding: 'utf8' }).trim();
  const WAVE = ['--ship-check', '--sc-kind', 'wave', '--sc-plan', 'docs/.output/plans/p.md', '--sc-wave', '3', '--sc-todo', 'docs/TODO_x.md', '--sc-stories', 'A-1,A-2'];

  describe('parseArgs', () => {
    it('defaults: no ship check', () => {
      const commit = require(COMMIT_JS);
      const r = commit.parseArgs([]);
      expect(r.shipCheck).toBe(false);
    });

    it('parses the boolean and every --sc-* option', () => {
      const commit = require(COMMIT_JS);
      const r = commit.parseArgs([...WAVE, '--sc-skip', 'CI only']);
      expect(r.shipCheck).toBe(true);
      expect(r.sc).toEqual({ kind: 'wave', plan: 'docs/.output/plans/p.md', wave: '3', todo: 'docs/TODO_x.md', stories: 'A-1,A-2', skip: 'CI only' });
    });

    it.each([
      ['--paths before the options', ['--paths', 'a.js', 'b.md', ...WAVE]],
      ['--paths after the options', [...WAVE, '--paths', 'a.js', 'b.md']],
      ['--paths between options', ['--ship-check', '--sc-kind', 'wave', '--paths', 'a.js', 'b.md', '--sc-plan', 'docs/.output/plans/p.md', '--sc-wave', '3', '--sc-todo', 'docs/TODO_x.md', '--sc-stories', 'A-1,A-2']],
    ])('--paths does not swallow --sc-* values (%s)', (_label, argv) => {
      const commit = require(COMMIT_JS);
      const r = commit.parseArgs(argv);
      expect(r.paths).toEqual(['a.js', 'b.md']);
      expect(r.sc.kind).toBe('wave');
      expect(r.sc.stories).toBe('A-1,A-2');
      expect(r.sc.plan).toBe('docs/.output/plans/p.md');
    });

    it('rejects an --sc-* option with no value', () => {
      const commit = require(COMMIT_JS);
      expect(() => commit.parseArgs(['--ship-check', '--sc-kind'])).toThrow(/--sc-kind/);
      expect(() => commit.parseArgs(['--ship-check', '--sc-kind', '--sc-wave', '3'])).toThrow(/--sc-kind/);
    });

    it('rejects --sc-kind other than wave|task', () => {
      const commit = require(COMMIT_JS);
      expect(() => commit.parseArgs(['--ship-check', '--sc-kind', 'story'])).toThrow(/wave\|task/);
    });

    it('rejects --sc-* options without --ship-check (they would silently do nothing)', () => {
      const commit = require(COMMIT_JS);
      expect(() => commit.parseArgs(['--sc-kind', 'task'])).toThrow(/--ship-check/);
    });
  });

  it.skipIf(!gitAvailable())('refuses when the ship check refuses: exit 1, reasons printed, nothing staged, no commit', () => {
    const r = repoWith();
    const before = commitCount(r);
    const tree0 = indexTree(r);
    const { status, stdout } = runCommit(r, msgFile(), [...WAVE, '--paths', 'app.js']);
    expect(status).toBe(1);
    expect(stdout).toMatch(/\[commit\] ship check refused/);
    // The judge's own words (its rule), not commit.js's static Fix line, which also says "seal" (REV-m6).
    expect(stdout).toMatch(/\[ship-check\] refusing: there is no ship seal/);
    expect(staged(r)).toBe('');
    expect(indexTree(r)).toBe(tree0);
    expect(commitCount(r)).toBe(before);
  });

  it.skipIf(!gitAvailable())('a refusal with --all leaves the index untouched too', () => {
    const r = repoWith();
    const tree0 = indexTree(r);
    const { status } = runCommit(r, msgFile(), [...WAVE, '--all']);
    expect(status).toBe(1);
    expect(staged(r)).toBe('');
    expect(indexTree(r)).toBe(tree0);
  });

  it.skipIf(!gitAvailable())('passes through to the commit when the ship check passes (shipCheck.enabled: false)', () => {
    const r = repoWith({ shipCheck: { enabled: false } });
    const before = commitCount(r);
    const { status, stdout } = runCommit(r, msgFile(), ['--ship-check', '--sc-kind', 'task', '--paths', 'app.js']);
    expect(status, stdout).toBe(0);
    expect(stdout).toMatch(/\[commit\] ship check passed/);
    expect(commitCount(r)).toBe(before + 1);
  });

  it.skipIf(!gitAvailable())('--amend runs the check (and is refused by it)', () => {
    const r = repoWith();
    const head0 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r, encoding: 'utf8' }).trim();
    const { status } = runCommit(r, msgFile(), [...WAVE, '--amend']);
    expect(status).toBe(1);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r, encoding: 'utf8' }).trim()).toBe(head0);
  });

  it.skipIf(!gitAvailable())('--dry-run runs the check and reports, staging nothing', () => {
    const r = repoWith();
    const { status, stdout } = runCommit(r, msgFile(), [...WAVE, '--dry-run', '--paths', 'app.js']);
    expect(status).toBe(1);
    expect(stdout).toMatch(/\[commit\] ship check refused/);
    expect(staged(r)).toBe('');
  });

  it.skipIf(!gitAvailable())('--dry-run with a passing check reports the pass and still stages nothing', () => {
    const r = repoWith({ shipCheck: { enabled: false } });
    const before = commitCount(r);
    const { status, stdout } = runCommit(r, msgFile(), ['--ship-check', '--sc-kind', 'task', '--dry-run', '--paths', 'app.js']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/\[commit\] ship check passed/);
    expect(stdout).toMatch(/--dry-run/);
    expect(staged(r)).toBe('');
    expect(commitCount(r)).toBe(before);
  });

  it.skipIf(!gitAvailable())('--no-scan does not bypass the ship check', () => {
    const r = repoWith();
    const before = commitCount(r);
    const { status } = runCommit(r, msgFile(), [...WAVE, '--no-scan', '--paths', 'app.js']);
    expect(status).toBe(1);
    expect(commitCount(r)).toBe(before);
    expect(staged(r)).toBe('');
  });

  it.skipIf(!gitAvailable())('CLAUDE_COMMIT_NO_SCAN=1 does not bypass the ship check', () => {
    const r = repoWith();
    const before = commitCount(r);
    const { status } = runCommit(r, msgFile(), [...WAVE, '--paths', 'app.js'], { CLAUDE_COMMIT_NO_SCAN: '1' });
    expect(status).toBe(1);
    expect(commitCount(r)).toBe(before);
  });

  it.skipIf(!gitAvailable())('a timed-out precheck refuses with the index untouched', () => {
    const r = repoWith({ shipCheck: { enabled: false } });
    const before = commitCount(r);
    const { status, stdout } = runCommit(r, msgFile(), ['--ship-check', '--sc-kind', 'task', '--paths', 'app.js'], { COMMIT_SHIP_CHECK_TIMEOUT_MS: '1' });
    expect(status).toBe(1);
    expect(stdout).toMatch(/ship check (?:timed out|did not finish)/i);
    expect(staged(r)).toBe('');
    expect(commitCount(r)).toBe(before);
  });

  it.skipIf(!gitAvailable())('a crashing precheck (malformed gate config) refuses with the index untouched', () => {
    const r = repoWith();
    fs.mkdirSync(path.join(r, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(r, '.claude', 'gate.config.json'), '{ not json');
    const before = commitCount(r);
    const { status } = runCommit(r, msgFile(), ['--ship-check', '--sc-kind', 'task', '--paths', 'app.js']);
    expect(status).toBe(1);
    expect(staged(r)).toBe('');
    expect(commitCount(r)).toBe(before);
  });

  it.skipIf(!gitAvailable())('--sc-skip with an empty reason refuses (the check exits 2; commit exits 1)', () => {
    const r = repoWith();
    const before = commitCount(r);
    const { status } = runCommit(r, msgFile(), ['--ship-check', '--sc-kind', 'task', '--sc-skip', '', '--paths', 'app.js']);
    expect(status).toBe(1);
    expect(commitCount(r)).toBe(before);
  });

  it.skipIf(!gitAvailable())('without --ship-check nothing changes: a plain commit with no seal still commits', () => {
    const r = repoWith();
    const before = commitCount(r);
    const { status } = runCommit(r, msgFile(), ['--paths', 'app.js']);
    expect(status).toBe(0);
    expect(commitCount(r)).toBe(before + 1);
  });

  it('the new source text avoids the phrase the git-hooks review guard forbids', () => {
    const src = fs.readFileSync(COMMIT_JS, 'utf8');
    expect(src.toLowerCase()).not.toContain(['every', 'commit', 'path'].join(' '));
  });
});

// ── Wave 3 review fixes: commit.js findings (security-auditor M1, M4, m1, m2, n2, n3; code-reviewer M2, m3, m6) ──
// Real-repo fixtures: a committed gate config, a frozen TODO, a hand-written gate receipt (the control test in
// ship-check.test.js proves the real receipt judge accepts that shape), a real `ship-check.js seal`, and then the
// real `commit.js --ship-check`. Nothing about the judge is mocked.

const SHIP_CHECK_JS = path.resolve(__dirname, '../../../.agents/core/ship-check.js');
const AC_VERIFY_JS = path.resolve(__dirname, '../../../.agents/core/ac-verify.js');
const gateReceipt = require('../_lib/gate-receipt');
const PLAN_REL = 'docs/.output/plans/261118-0000-fixture.md';
const TODO_REL = 'docs/TODO_fixture.md';
const IMPL_REL = 'src/impl.js';
const EVENTS_REL = 'docs/.output/.state/telemetry/guardrail-events.jsonl';
const REVIEW = [
  '**Review — Wave 1**',
  '- Reviewed: code-reviewer read the diff',
  '- Fixed now: none needed',
  '- Deferred: none',
  '- Skipped or light: none',
  '- Risk call: none',
  '',
].join('\n');
const PLAN_HEAD = '# Plan: fixture run\n\n### Wave 1 (2026-11-18)\n- **Stories:** T-1.1\n- **Commit:** {pending}\n\n';

// The env a spawned CLI sees: the vitest and CI markers would change the judge's behaviour, so they are dropped.
const DROPPED_ENV = new Set(['AGENT_SHARED_STATE_ROOT', 'AGENTS_PROJECT_DIR', 'AGENT_SOURCE_ROOT', 'CODEX_PROJECT_DIR', 'AC_VERIFY_TIMEOUT_MS', 'AGENTS_RUNTIME', 'CI']);
function cleanEnv(root, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (DROPPED_ENV.has(k) || k === 'VITEST' || k.startsWith('VITEST_') || k.startsWith('GIT_')) continue;
    env[k] = v;
  }
  return { ...env, CLAUDE_PROJECT_DIR: root, ...extra };
}

/** commit.js from `cwd` (default: the repo root) with a clean env; returns { status, stdout } (stdout + stderr merged). */
function runCommitClean(root, args, { env = {}, cwd = root } = {}) {
  const r = spawnSyncNode([COMMIT_JS, ...args], { cwd, env: cleanEnv(root, env) });
  return { status: r.status, stdout: `${r.stdout || ''}${r.stderr || ''}` };
}
function spawnSyncNode(argv, { cwd, env }) {
  return require('node:child_process').spawnSync(process.execPath, argv, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
}

const sh = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();

/**
 * A repo with one story whose AC has a `verify:` binding, committed gate config (receipt mode), a frozen baseline,
 * a passing gate receipt for the tree as it is now, and a real seal. The plan gets its review entry AFTER the seal,
 * as a wave does. Returns { root, args } where args are the standard wave arguments for commit.js.
 */
function sealedWaveRepo(parent, { seal = true } = {}) {
  const repo = createGitRepo({ root: parent });
  const root = fs.realpathSync(repo.repoPath);
  const write = (rel, content) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write('.gitignore', 'docs/.output/.state/\nnode_modules\n');
  write('ok.js', "console.log('ok');\n");
  write(IMPL_REL, 'module.exports = 1;\n');
  write('src/__tests__/a.test.js', 'expect(1).toBe(1);\n');
  write('.claude/gate.config.json', JSON.stringify({ receipts: { maxAgeHours: 24 } }));
  write(TODO_REL, [
    '# TODO: ship fixture\n',
    '* [x] **Story T-1.1 (S): Title**',
    '  * **AC:**',
    '    * [x] Adds the thing. verify: node ok.js',
    '    * [x] A manual criterion with no binding',
    '  * **Files:**',
    `    * \`${IMPL_REL}\` — fixture`,
    '    * `src/__tests__/a.test.js` — fixture',
    '  * **Estimate:** S',
    '',
  ].join('\n'));
  write(PLAN_REL, PLAN_HEAD);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'init', '--no-verify');
  const freeze = spawnSyncNode([AC_VERIFY_JS, 'freeze', '--todo', path.join(root, TODO_REL), '--stories', 'T-1.1'], { cwd: root, env: cleanEnv(root) });
  if (freeze.status !== 0) throw new Error(`fixture: ac-verify freeze failed: ${freeze.stdout}${freeze.stderr}`);
  const snap = gateReceipt.treeSnapshot(root);
  if (!snap.ok) throw new Error(`fixture: tree hash unavailable: ${snap.reason}`);
  gateReceipt.writeReceipt(root, {
    schema: gateReceipt.RECEIPT_SCHEMA, id: 'abc123def456', status: 'passed', exitCode: 0, mode: 'normal', changedOnly: false,
    head: gateReceipt.headSha(root), treeHashStart: snap.hash, treeHashEnd: snap.hash, engine: gateReceipt.engineIdentity(root),
    configHash: gateReceipt.readGateConfigFile(root).hash, build: { status: 'passed' }, projects: [],
    test: { status: 'passed' }, codeHash: gateReceipt.codeTreeHash(root).hash,
  });
  if (seal) {
    const sealed = spawnSyncNode([SHIP_CHECK_JS, 'seal', '--todo', path.join(root, TODO_REL), '--stories', 'T-1.1'], { cwd: root, env: cleanEnv(root) });
    if (sealed.status !== 0) throw new Error(`fixture: ship-check seal failed: ${sealed.stdout}${sealed.stderr}`);
  }
  write(PLAN_REL, `${PLAN_HEAD}${REVIEW}`);
  const args = ['--ship-check', '--sc-kind', 'wave', '--sc-plan', PLAN_REL, '--sc-wave', '1', '--sc-todo', TODO_REL, '--sc-stories', 'T-1.1'];
  return { root, args, write, msg: (text = 'feat: wave 1') => { const m = path.join(root, 'docs/.output/.state/MSG'); fs.mkdirSync(path.dirname(m), { recursive: true }); fs.writeFileSync(m, `${text}\n`); return m; } };
}
const events = (root) => {
  const file = path.join(root, EVENTS_REL);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

describe('commit.js --ship-check: sealed pass and honoured skip (review m6)', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'commit-sealed-' }); });
  afterEach(() => tmp.cleanup());

  it.skipIf(!gitAvailable())('a refusal carries the judge\'s own reason, not just commit.js\'s Fix line', () => {
    const w = sealedWaveRepo(tmp.root, { seal: false });
    const before = commitCount(w.root);
    const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--paths', PLAN_REL]);
    expect(status).toBe(1);
    expect(stdout).toMatch(/\[ship-check\] refusing: there is no ship seal/);
    expect(stdout).toMatch(/"rule": "no-seal"/);
    expect(commitCount(w.root)).toBe(before);
    expect(sh(w.root, 'diff', '--cached', '--name-only')).toBe('');
  });

  it.skipIf(!gitAvailable())('commits under a real seal: gate receipt, ship-check seal, review entry, then commit.js --ship-check', () => {
    const w = sealedWaveRepo(tmp.root);
    const before = commitCount(w.root);
    const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--paths', PLAN_REL]);
    expect(status, stdout).toBe(0);
    expect(stdout).toMatch(/\[commit\] ship check passed/);
    expect(commitCount(w.root)).toBe(before + 1);
    expect(sh(w.root, 'show', '--name-only', '--format=', 'HEAD')).toBe(PLAN_REL);
    // The seal is spent: a second commit under the same seal is refused (the head moved).
    w.write(PLAN_REL, `${PLAN_HEAD}${REVIEW}\nmore\n`);
    const again = runCommitClean(w.root, ['--file', w.msg('feat: second'), ...w.args, '--paths', PLAN_REL]);
    expect(again.status).toBe(1);
    expect(commitCount(w.root)).toBe(before + 1);
  });

  it.skipIf(!gitAvailable())('an honoured --sc-skip commits, adds the Ship-Check-Skip trailer, and writes the bypass event to the repo', () => {
    const w = sealedWaveRepo(tmp.root, { seal: false });
    const before = commitCount(w.root);
    const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--sc-skip', 'CI-only matrix job', '--paths', PLAN_REL]);
    expect(status, stdout).toBe(0);
    expect(commitCount(w.root)).toBe(before + 1);
    expect(sh(w.root, 'log', '-1', '--format=%B')).toBe('feat: wave 1\n\nShip-Check-Skip: CI-only matrix job');
    expect(sh(w.root, 'log', '-1', '--format=%(trailers:key=Ship-Check-Skip,valueonly)')).toBe('CI-only matrix job');
    const bypass = events(w.root).filter((e) => e.decision === 'bypass' && e.rule === 'ship-check-skip');
    expect(bypass).toHaveLength(1);
    expect(bypass[0]).toMatchObject({ event: 'guardrail', source: 'ship-check' });
  });
});

describe('security review m4: a passing ship check leaves a Ship-Check trailer in the commit', () => {
  const { readShipTrailers } = require('../_lib/git');
  const SEAL_REL = 'docs/.output/.state/telemetry/ship-seal.json';
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'commit-trailer-' }); });
  afterEach(() => tmp.cleanup());
  const sealHash = (root) => JSON.parse(fs.readFileSync(path.join(root, SEAL_REL), 'utf8')).codeHash;

  it.skipIf(!gitAvailable())('the commit carries Ship-Check: <first 12 of the seal codeHash>, as a real git trailer', () => {
    const w = sealedWaveRepo(tmp.root);
    const hash = sealHash(w.root);
    const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--paths', PLAN_REL]);
    expect(status, stdout).toBe(0);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sh(w.root, 'log', '-1', '--format=%B')).toBe(`feat: wave 1\n\nShip-Check: ${hash.slice(0, 12)}`);
    expect(sh(w.root, 'log', '-1', '--format=%(trailers:key=Ship-Check,valueonly)')).toBe(hash.slice(0, 12));
    expect(readShipTrailers(w.root, null)).toEqual({ state: 'ok', shipCheck: hash.slice(0, 12), skip: false });
  });

  it.skipIf(!gitAvailable())('the trailer joins an existing trailer block instead of opening a second paragraph', () => {
    const w = sealedWaveRepo(tmp.root);
    const hash = sealHash(w.root);
    const { status, stdout } = runCommitClean(w.root, ['--file', w.msg('feat: wave 1\n\nReviewed-by: Reviewer'), ...w.args, '--paths', PLAN_REL]);
    expect(status, stdout).toBe(0);
    expect(sh(w.root, 'log', '-1', '--format=%B')).toBe(`feat: wave 1\n\nReviewed-by: Reviewer\nShip-Check: ${hash.slice(0, 12)}`);
  });

  it.skipIf(!gitAvailable())('--dry-run previews the trailer and commits nothing', () => {
    const w = sealedWaveRepo(tmp.root);
    const hash = sealHash(w.root);
    const before = commitCount(w.root);
    const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--dry-run', '--paths', PLAN_REL]);
    expect(status, stdout).toBe(0);
    expect(stdout).toContain(`Ship-Check: ${hash.slice(0, 12)}`);
    expect(commitCount(w.root)).toBe(before);
  });

  it.skipIf(!gitAvailable())('an honoured --sc-skip carries only the skip trailer, never a Ship-Check one', () => {
    const w = sealedWaveRepo(tmp.root, { seal: false });
    const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--sc-skip', 'CI-only matrix job', '--paths', PLAN_REL]);
    expect(status, stdout).toBe(0);
    expect(readShipTrailers(w.root, null)).toEqual({ state: 'ok', shipCheck: null, skip: true });
  });

  it.skipIf(!gitAvailable())('a commit without --ship-check carries no trailer (none is invented)', () => {
    const w = sealedWaveRepo(tmp.root);
    w.write(PLAN_REL, `${PLAN_HEAD}${REVIEW}\nmore\n`);
    const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), '--paths', PLAN_REL]);
    expect(status, stdout).toBe(0);
    expect(readShipTrailers(w.root, null)).toEqual({ state: 'ok', shipCheck: null, skip: false });
  });

  it('sealedCodeHash reads the seal from the verdict document and nothing else', () => {
    const hash = 'a'.repeat(64);
    expect(commit.sealedCodeHash(JSON.stringify({ ok: true, seal: { codeHash: hash } }))).toBe(hash);
    for (const text of ['', 'not json', '{}', '{"seal":null}', JSON.stringify({ seal: { codeHash: 'abc' } }), JSON.stringify({ seal: { codeHash: 7 } })]) {
      expect(commit.sealedCodeHash(text), text).toBeNull();
    }
  });
});

describe('SEC-M1 / REV-M2: the verdict covers the working tree, the commit takes the index', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'commit-m1-' }); });
  afterEach(() => tmp.cleanup());

  it.skipIf(!gitAvailable()).each([
    'GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR',
  ])('%s set: refused up front, nothing staged, nothing committed', (name) => {
    const w = sealedWaveRepo(tmp.root);
    const before = commitCount(w.root);
    const tree0 = sh(w.root, 'write-tree');
    const value = name === 'GIT_INDEX_FILE' ? path.join(w.root, 'docs/.output/.state/alt-index') : path.join(w.root, '.git');
    const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--paths', PLAN_REL], { env: { [name]: value } });
    expect(status).toBe(1);
    expect(stdout).toMatch(new RegExp(`ship check refused: ${name} is set`));
    expect(commitCount(w.root)).toBe(before);
    expect(sh(w.root, 'write-tree')).toBe(tree0);
    expect(sh(w.root, 'diff', '--cached', '--name-only')).toBe('');
  });

  it.skipIf(!gitAvailable())('T7: an alternate index holding a payload is not committed under a passing verdict', () => {
    const w = sealedWaveRepo(tmp.root);
    const head0 = sh(w.root, 'rev-parse', 'HEAD');
    // Build the alternate index: HEAD plus a payload in src/impl.js that the working tree never had.
    const altEnv = { ...process.env, GIT_INDEX_FILE: path.join(w.root, 'docs/.output/.state/alt-index') };
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: w.root, env: altEnv });
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: w.root, input: 'PAYLOAD\n', encoding: 'utf8' }).trim();
    execFileSync('git', ['update-index', '--cacheinfo', `100644,${blob},${IMPL_REL}`], { cwd: w.root, env: altEnv });
    const { status } = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--paths', PLAN_REL], { env: { GIT_INDEX_FILE: altEnv.GIT_INDEX_FILE } });
    expect(status).toBe(1);
    expect(sh(w.root, 'rev-parse', 'HEAD')).toBe(head0);
    expect(sh(w.root, 'show', `HEAD:${IMPL_REL}`)).toBe('module.exports = 1;');
  });

  it.skipIf(!gitAvailable())('T4: code staged earlier and then reverted in the working tree is refused (by the judge or the guard), index untouched', () => {
    const w = sealedWaveRepo(tmp.root);
    const head0 = sh(w.root, 'rev-parse', 'HEAD');
    // Stage a BAD version early, then put the sealed content back in the working tree: the seal still matches.
    w.write(IMPL_REL, 'module.exports = "BAD";\n');
    sh(w.root, 'add', IMPL_REL);
    w.write(IMPL_REL, 'module.exports = 1;\n');
    const tree0 = sh(w.root, 'write-tree');
    const { status } = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--paths', PLAN_REL]);
    expect(status).toBe(1);
    expect(sh(w.root, 'rev-parse', 'HEAD')).toBe(head0);
    expect(sh(w.root, 'write-tree')).toBe(tree0);
    expect(sh(w.root, 'show', `HEAD:${IMPL_REL}`)).toBe('module.exports = 1;');
  });

  it.skipIf(!gitAvailable())('a stale stage the judge does not look at (a doc outside the code hash) is refused after staging, and the index is restored exactly', () => {
    const w = sealedWaveRepo(tmp.root);
    const head0 = sh(w.root, 'rev-parse', 'HEAD');
    // docs/work/ is not code: the verdict cannot see it. Stage version 1, then change the file on disk.
    w.write('docs/work/notes.md', 'version 1\n');
    sh(w.root, 'add', 'docs/work/notes.md');
    w.write('docs/work/notes.md', 'version 2\n');
    const tree0 = sh(w.root, 'write-tree');
    const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--paths', PLAN_REL]);
    expect(status).toBe(1);
    expect(stdout).toMatch(/\[commit\] ship check passed/);
    expect(stdout).toMatch(/staged content differs from the working tree/);
    expect(stdout).toContain('docs/work/notes.md');
    expect(stdout).toMatch(/the index was restored/);
    expect(sh(w.root, 'rev-parse', 'HEAD')).toBe(head0);
    // Restored exactly: the earlier stage is still there, the plan this run added is not.
    expect(sh(w.root, 'write-tree')).toBe(tree0);
    expect(sh(w.root, 'diff', '--cached', '--name-only')).toBe('docs/work/notes.md');
  });

  it.skipIf(!gitAvailable())('a staged path deleted from the working tree is refused and the index is restored', () => {
    const w = sealedWaveRepo(tmp.root);
    w.write('src/extra.js', 'x\n');
    sh(w.root, 'add', 'src/extra.js');
    fs.rmSync(path.join(w.root, 'src/extra.js'));
    const tree0 = sh(w.root, 'write-tree');
    const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--paths', PLAN_REL]);
    expect(status).toBe(1);
    expect(stdout).toContain('src/extra.js');
    expect(sh(w.root, 'write-tree')).toBe(tree0);
  });

  it.skipIf(!gitAvailable())('control: with the index and the working tree in agreement the same run commits', () => {
    const w = sealedWaveRepo(tmp.root);
    const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--paths', PLAN_REL]);
    expect(status, stdout).toBe(0);
  });

  describe('stagedPathsDifferingFromWorktree (in-process, plain repo)', () => {
    let prev;
    beforeEach(() => { prev = process.cwd(); });
    afterEach(() => process.chdir(prev));

    function repo() {
      const r = createGitRepo({ root: tmp.root });
      const root = fs.realpathSync(r.repoPath);
      fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
      fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
      sh(root, 'add', '-A');
      sh(root, 'commit', '-q', '-m', 'init', '--no-verify');
      process.chdir(root);
      return root;
    }

    it.skipIf(!gitAvailable())('reports a modified, a deleted and a reappeared-after-staged-deletion path, and nothing for an agreeing path', () => {
      const root = repo();
      fs.writeFileSync(path.join(root, 'new.txt'), 'v1\n');
      fs.writeFileSync(path.join(root, 'del.txt'), 'd\n');
      fs.writeFileSync(path.join(root, 'same.txt'), 's\n');
      sh(root, 'add', 'new.txt', 'del.txt', 'same.txt');
      fs.writeFileSync(path.join(root, 'new.txt'), 'v2\n');            // modified after staging
      fs.rmSync(path.join(root, 'del.txt'));                           // deleted after staging
      sh(root, 'rm', '--cached', '-q', 'a.txt');                       // staged deletion ...
      expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(true);      // ... whose file is still on disk (untracked)
      expect(commit.stagedPathsDifferingFromWorktree(root).sort()).toEqual(['a.txt', 'del.txt', 'new.txt']);
    });

    it.skipIf(!gitAvailable())('is empty when everything staged matches the working tree', () => {
      const root = repo();
      fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
      sh(root, 'add', 'a.txt');
      expect(commit.stagedPathsDifferingFromWorktree(root)).toEqual([]);
    });

    it.skipIf(!gitAvailable())('an unborn index works: the staged file differing from disk is found, the restore goes back to the empty tree', () => {
      const r = createGitRepo({ root: tmp.root });
      const root = fs.realpathSync(r.repoPath);
      process.chdir(root);
      const preTree = sh(root, 'write-tree');
      fs.writeFileSync(path.join(root, 'first.txt'), 'v1\n');
      sh(root, 'add', 'first.txt');
      fs.writeFileSync(path.join(root, 'first.txt'), 'v2\n');
      expect(commit.stagedPathsDifferingFromWorktree(root)).toEqual(['first.txt']);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`process.exit(${code})`); });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(() => commit.assertStagedMatchesWorktree(preTree)).toThrow(/process\.exit\(1\)/);
      } finally {
        exitSpy.mockRestore();
        errSpy.mockRestore();
      }
      expect(sh(root, 'write-tree')).toBe(preTree);
      expect(sh(root, 'diff', '--cached', '--name-only')).toBe('');
    });
  });
});

describe('SEC-m1: the ship-check child does not inherit preloads, git overrides or state-root overrides', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'commit-m1env-' }); });
  afterEach(() => tmp.cleanup());

  it('shipCheckEnv scrubs NODE_*, GIT_* and the state-root overrides, keeps AGENTS_RUNTIME and PATH, and pins CLAUDE_PROJECT_DIR', () => {
    const env = commit.shipCheckEnv('/repo/root', {
      PATH: '/usr/bin', HOME: '/tmp/x', AGENTS_RUNTIME: 'codex', CLAUDE_PROJECT_DIR: '/elsewhere',
      NODE_OPTIONS: '--require x.js', NODE_PATH: '/np', NODE_REPL_EXTERNAL_MODULE: 'm', node_options: '--require y.js',
      GIT_DIR: '/g', GIT_INDEX_FILE: '/i', GIT_CONFIG_GLOBAL: '/c',
      AGENT_SHARED_STATE_ROOT: '/void', AGENTS_PROJECT_DIR: '/p', AGENT_SOURCE_ROOT: '/s', CODEX_PROJECT_DIR: '/cx',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/tmp/x', AGENTS_RUNTIME: 'codex', CLAUDE_PROJECT_DIR: '/repo/root' });
  });

  it.skipIf(!gitAvailable())('a NODE_OPTIONS preload that forces ship-check to exit 0 does not turn a refusal into a commit', () => {
    const w = sealedWaveRepo(tmp.root, { seal: false });
    const preload = path.join(w.root, 'docs/.output/.state/force-zero.cjs');
    fs.mkdirSync(path.dirname(preload), { recursive: true });
    // Only the judge is forced to 0 (commit.js's own exit code must stay honest, so the test is not vacuous).
    fs.writeFileSync(preload, "if (/ship-check\\.js$/.test(process.argv[1] || '')) process.on('exit', () => { process.exitCode = 0; });\n");
    const before = commitCount(w.root);
    const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--paths', PLAN_REL], { env: { NODE_OPTIONS: `--require ${preload}` } });
    expect(status).toBe(1);
    expect(stdout).toMatch(/there is no ship seal/);
    expect(commitCount(w.root)).toBe(before);
  });
});

describe('SEC-m2 / REV-m3 / SEC-n3: --sc-* argument grammar', () => {
  it('an --sc-* value that starts with "-" is an error (never re-read as another flag)', () => {
    expect(() => commit.parseArgs(['--ship-check', '--sc-skip', '-a'])).toThrow(/--sc-skip needs a value that does not start with "-"/);
    expect(() => commit.parseArgs(['--ship-check', '--sc-plan', '-m', '--sc-kind', 'wave'])).toThrow(/--sc-plan/);
    expect(() => commit.parseArgs(['--ship-check', '--sc-todo', '--file', 'x'])).toThrow(/--sc-todo/);
    expect(() => commit.parseArgs(['--ship-check', '--sc-stories', '--all'])).toThrow(/--sc-stories/);
    expect(() => commit.parseArgs(['--ship-check', '--sc-skip', '--dry-run'])).toThrow(/--sc-skip/);
  });

  it('a duplicated --sc-* flag is an error, not silently the first value', () => {
    expect(() => commit.parseArgs(['--ship-check', '--sc-skip', 'x', '--sc-skip', 'y'])).toThrow(/--sc-skip was given more than once/);
    expect(() => commit.parseArgs(['--ship-check', '--sc-kind', 'wave', '--sc-kind', 'task'])).toThrow(/--sc-kind was given more than once/);
  });

  it('values are parsed out first, so the rest of the line still parses on its own terms', () => {
    const r = commit.parseArgs(['--ship-check', '--sc-skip', 'reason words', '--sc-plan', 'p.md', '-m', 'feat: x', '--paths', 'a.js', '--amend']);
    expect(r.sc).toEqual({ skip: 'reason words', plan: 'p.md' });
    expect(r.inlineMsg).toBe('feat: x');
    expect(r.paths).toEqual(['a.js']);
    expect(r.amend).toBe(true);
    expect(r.stageAll).toBe(false);
  });

  it('an empty --sc-skip reason is still accepted by the parser (the judge refuses it)', () => {
    expect(commit.parseArgs(['--ship-check', '--sc-skip', '']).sc).toEqual({ skip: '' });
  });

  it.skipIf(!gitAvailable())('`--sc-skip -a` stages nothing and commits nothing (it used to run git add -A)', () => {
    const tmp = createTmpDir({ prefix: 'commit-m2-' });
    try {
      const w = sealedWaveRepo(tmp.root);
      w.write('stray.txt', 'unrelated work in the shared tree\n');
      const before = commitCount(w.root);
      const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), '--ship-check', '--sc-kind', 'task', '--sc-skip', '-a']);
      expect(status).toBe(1);
      expect(stdout).toMatch(/--sc-skip needs a value that does not start with "-"/);
      expect(sh(w.root, 'diff', '--cached', '--name-only')).toBe('');
      expect(commitCount(w.root)).toBe(before);
    } finally {
      tmp.cleanup();
    }
  });

  it.skipIf(!gitAvailable())('a relative --sc-plan / --sc-todo resolves against the caller\'s directory, not the repository root', () => {
    const tmp = createTmpDir({ prefix: 'commit-n3-' });
    try {
      const w = sealedWaveRepo(tmp.root);
      const before = commitCount(w.root);
      // From docs/: the plan is .output/plans/..., the TODO is TODO_fixture.md; --paths is relative to docs/ too.
      const planFromDocs = PLAN_REL.replace(/^docs\//, '');
      const args = ['--file', w.msg(), '--ship-check', '--sc-kind', 'wave', '--sc-plan', planFromDocs, '--sc-wave', '1', '--sc-todo', 'TODO_fixture.md', '--sc-stories', 'T-1.1', '--paths', planFromDocs];
      const { status, stdout } = runCommitClean(w.root, args, { cwd: path.join(w.root, 'docs') });
      expect(status, stdout).toBe(0);
      expect(commitCount(w.root)).toBe(before + 1);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('SEC-M4: the skip and the scan bypass are audited where they cannot be redirected or swallowed', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'commit-m4-' }); });
  afterEach(() => tmp.cleanup());

  it('withTrailer starts a trailer paragraph, or joins an existing trailer block', () => {
    expect(commit.withTrailer('feat: x\n', 'Ship-Check-Skip', 'why')).toBe('feat: x\n\nShip-Check-Skip: why\n');
    expect(commit.withTrailer('feat: x\n\nbody text\n', 'Ship-Check-Skip', 'why')).toBe('feat: x\n\nbody text\n\nShip-Check-Skip: why\n');
    expect(commit.withTrailer('feat: x\n\nbody\n\nRefs: #1\n', 'Ship-Check-Skip', 'why')).toBe('feat: x\n\nbody\n\nRefs: #1\nShip-Check-Skip: why\n');
  });

  it('sanitizeTrailerValue makes the reason one bounded line with no control characters', () => {
    expect(commit.sanitizeTrailerValue(`a\r\nb\tc\u0000d${String.fromCharCode(0x2028)}e`)).toBe('a b c d e');
    expect(commit.sanitizeTrailerValue(`  ${'x'.repeat(900)}  `)).toBe('x'.repeat(500));
  });

  it.skipIf(!gitAvailable())('--dry-run with an honoured skip prints the trailer and commits nothing', () => {
    const w = sealedWaveRepo(tmp.root, { seal: false });
    const before = commitCount(w.root);
    const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--sc-skip', 'manual UI check', '--dry-run', '--paths', PLAN_REL]);
    expect(status, stdout).toBe(0);
    expect(stdout).toMatch(/Ship-Check-Skip: manual UI check/);
    expect(commitCount(w.root)).toBe(before);
  });

  it.skipIf(!gitAvailable())('T6: AGENT_SHARED_STATE_ROOT cannot redirect the skip audit event away from the repository', () => {
    const w = sealedWaveRepo(tmp.root, { seal: false });
    const voidRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'commit-void-'));
    try {
      const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--sc-skip', 'redirect attempt', '--paths', PLAN_REL], { env: { AGENT_SHARED_STATE_ROOT: voidRoot, AGENTS_PROJECT_DIR: voidRoot } });
      expect(status, stdout).toBe(0);
      expect(events(w.root).filter((e) => e.rule === 'ship-check-skip')).toHaveLength(1);
      expect(fs.readdirSync(voidRoot)).toEqual([]);
    } finally {
      fs.rmSync(voidRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(!gitAvailable() || process.platform === 'win32')('T6b: a symlinked events file refuses the skip: nothing is committed', () => {
    const w = sealedWaveRepo(tmp.root, { seal: false });
    const eventsFile = path.join(w.root, EVENTS_REL);
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    fs.symlinkSync('/dev/null', eventsFile);
    const before = commitCount(w.root);
    const { status } = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--sc-skip', 'swallowed', '--paths', PLAN_REL]);
    expect(status).toBe(1);
    expect(commitCount(w.root)).toBe(before);
  });

  describe('recordScanBypass (the commit-no-scan sibling)', () => {
    function stagedApp() {
      const w = sealedWaveRepo(tmp.root, { seal: false });
      w.write('app.js', 'const x = 1;\n');
      sh(w.root, 'add', 'app.js');
      return w;
    }

    it.skipIf(!gitAvailable())('records the bypass against the repository with the reason (flag vs env)', () => {
      const w = stagedApp();
      expect(runCommitClean(w.root, ['--file', w.msg(), '--no-scan']).status).toBe(0);
      const viaFlag = events(w.root).filter((e) => e.rule === 'commit-no-scan');
      expect(viaFlag).toHaveLength(1);
      expect(viaFlag[0]).toMatchObject({ event: 'guardrail', decision: 'bypass', source: 'secret-scanner', reason: 'flag --no-scan' });
      w.write('app2.js', 'const y = 2;\n');
      sh(w.root, 'add', 'app2.js');
      expect(runCommitClean(w.root, ['--file', w.msg('feat: two')], { env: { CLAUDE_COMMIT_NO_SCAN: '1' } }).status).toBe(0);
      const all = events(w.root).filter((e) => e.rule === 'commit-no-scan');
      expect(all).toHaveLength(2);
      expect(all[1].reason).toBe('env CLAUDE_COMMIT_NO_SCAN=1');
    });

    it.skipIf(!gitAvailable())('AGENT_SHARED_STATE_ROOT does not redirect the event', () => {
      const w = stagedApp();
      const voidRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'commit-void-'));
      try {
        expect(runCommitClean(w.root, ['--file', w.msg(), '--no-scan'], { env: { AGENT_SHARED_STATE_ROOT: voidRoot } }).status).toBe(0);
        expect(events(w.root).filter((e) => e.rule === 'commit-no-scan')).toHaveLength(1);
        expect(fs.readdirSync(voidRoot)).toEqual([]);
      } finally {
        fs.rmSync(voidRoot, { recursive: true, force: true });
      }
    });

    it.skipIf(!gitAvailable() || process.platform === 'win32')('a symlinked events file is refused: the bypass is reported as NOT recorded and the link target is untouched', () => {
      const w = stagedApp();
      const target = path.join(w.root, 'docs/.output/.state/elsewhere.jsonl');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '');
      const link = path.join(w.root, EVENTS_REL);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link);
      const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), '--no-scan']);
      expect(status).toBe(0);
      expect(stdout).toMatch(/NOT recorded/);
      expect(fs.readFileSync(target, 'utf8')).toBe('');
    });

    it.skipIf(!gitAvailable() || process.platform === 'win32')('a symlinked telemetry directory is refused too', () => {
      const w = stagedApp();
      const outside = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'commit-outside-'));
      try {
        const telemetry = path.join(w.root, 'docs/.output/.state/telemetry');
        fs.rmSync(telemetry, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(telemetry), { recursive: true });
        fs.symlinkSync(outside, telemetry);
        const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), '--no-scan']);
        expect(status).toBe(0);
        expect(stdout).toMatch(/NOT recorded/);
        expect(fs.readdirSync(outside)).toEqual([]);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it.skipIf(!gitAvailable())('a git location override means the repository is unverified: NOT recorded', () => {
      const w = stagedApp();
      const { status, stdout } = runCommitClean(w.root, ['--file', w.msg(), '--no-scan'], { env: { GIT_DIR: path.join(w.root, '.git') } });
      expect(status).toBe(0);
      expect(stdout).toMatch(/NOT recorded/);
      expect(events(w.root).filter((e) => e.rule === 'commit-no-scan')).toHaveLength(0);
    });
  });
});

describe('SEC-n2 / REV-N1: the fix hint names the runtime the file was installed into', () => {
  it('runtimeCoreDir follows the install directory, and AGENTS_RUNTIME only for the authored .agents copy', () => {
    expect(commit.runtimeCoreDir('/work/proj/.claude/core', {})).toBe('.claude/core');
    expect(commit.runtimeCoreDir('/work/proj/.codex/core', {})).toBe('.codex/core');
    expect(commit.runtimeCoreDir('/work/proj/.codex/core', { AGENTS_RUNTIME: 'claude' })).toBe('.codex/core');
    expect(commit.runtimeCoreDir('/work/proj/.agents/core', { AGENTS_RUNTIME: 'codex' })).toBe('.codex/core');
    expect(commit.runtimeCoreDir('/work/proj/.agents/core', {})).toBe('.claude/core');
  });

  it.skipIf(!gitAvailable())('the printed Fix line uses it', () => {
    const tmp = createTmpDir({ prefix: 'commit-n2-' });
    try {
      const w = sealedWaveRepo(tmp.root, { seal: false });
      const claude = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--paths', PLAN_REL]);
      expect(claude.stdout).toMatch(/\[commit\] Fix: run the gate, `node \.claude\/core\/ship-check\.js seal`/);
      const codex = runCommitClean(w.root, ['--file', w.msg(), ...w.args, '--paths', PLAN_REL], { env: { AGENTS_RUNTIME: 'codex' } });
      expect(codex.stdout).toMatch(/\[commit\] Fix: run the gate, `node \.codex\/core\/ship-check\.js seal`/);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('orchestrator fix: staged code must still equal the sealed code (closes the verify → git add window)', () => {
  it('stagedMatchesSeal refuses when the code changed after the seal, and accepts the sealed tree', () => {
    const shipCheck = require(path.resolve(__dirname, '../ship-check.js'));
    expect(typeof shipCheck.stagedMatchesSeal).toBe('function');
    const tmp = createTmpDir({ prefix: 'commit-sealmatch-' });
    try {
      const repo = createGitRepo({ root: tmp.root });
      const r = repo.repoPath;
      fs.writeFileSync(path.join(r, 'a.js'), 'one\n');
      execFileSync('git', ['add', '-A'], { cwd: r, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'init', '--no-verify'], { cwd: r, stdio: 'pipe' });
      const gr = require(path.resolve(__dirname, '../_lib/gate-receipt.js'));
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r, encoding: 'utf8' }).trim();
      const codeHash = gr.codeTreeHash(r).hash;
      const dir = path.join(r, 'docs/.output/.state/telemetry');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'ship-seal.json'), JSON.stringify({
        codeHash, docs: [], gateCodeHash: codeHash, head, mode: 'receipt', receiptId: 'r1',
        recordsHash: 'a'.repeat(64), sealedAt: new Date().toISOString(), stories: [], todo: null,
      }));
      expect(shipCheck.stagedMatchesSeal(r)).toEqual({ ok: true });
      fs.writeFileSync(path.join(r, 'a.js'), 'two\n');
      const after = shipCheck.stagedMatchesSeal(r);
      expect(after.ok).toBe(false);
      expect(after.reason).toMatch(/code changed/);
      fs.rmSync(path.join(dir, 'ship-seal.json'));
      expect(shipCheck.stagedMatchesSeal(r)).toMatchObject({ ok: false, reason: expect.stringMatching(/disappeared/) });
    } finally {
      tmp.cleanup();
    }
  });
});

// ─── Security M3 (a): the improvement config wall ────────────────────────────────
// A staged change to `improvement.autoApply` or anything under `improvement.graduation`, `.watch` or `.budget` in `.claude/gate.config.json` is
// refused unless the owner sets AGENTS_ALLOW_IMPROVEMENT_CONFIG=1 on the run. Real scratch git repos (no remote at all), the
// real commit.js and the real secret scanner; the old and new values are compared as parsed JSON.

describe('commit.js improvement config wall (security M3 a)', () => {
  const CONFIG_REL = '.claude/gate.config.json';
  const OVERRIDE = 'AGENTS_ALLOW_IMPROVEMENT_CONFIG';
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'commit-improvement-' }); });
  afterEach(() => tmp.cleanup());

  const q = (r, ...args) => execFileSync('git', args, { cwd: r, encoding: 'utf8', stdio: 'pipe' }).trim();
  const write = (r, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true });
    fs.writeFileSync(path.join(r, rel), text);
  };
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const msg = (r) => { const file = path.join(r, '.git', 'M3-MSG'); fs.writeFileSync(file, 'chore: change something\n'); return file; };

  /** A repo whose HEAD holds `config` (a value, or a raw string) as the gate config; `null` commits no config at all. */
  function repoWith(config) {
    const r = createGitRepo({ root: tmp.root }).repoPath;
    write(r, 'README.md', '# fixture\n');
    q(r, 'add', 'README.md');
    if (config !== null) {
      write(r, CONFIG_REL, typeof config === 'string' ? config : json(config));
      q(r, 'add', CONFIG_REL);
    }
    q(r, 'commit', '-q', '-m', 'init', '--no-verify');
    return r;
  }
  /** Stage `config` as the new gate config (a value, or a raw string). */
  function stage(r, config) {
    write(r, CONFIG_REL, typeof config === 'string' ? config : json(config));
    q(r, 'add', CONFIG_REL);
  }
  const run = (r, extra = [], env = {}) => runCommitClean(r, ['--file', msg(r), ...extra], { env });
  const eventsOf = (r) => {
    const file = path.join(r, EVENTS_REL);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  const BASE = { build: { command: 'npm run build' }, improvement: { autoApply: 'off', graduation: { consecutive: 3, maxReverts: 1 }, watch: { runs: 5 } } };
  const edit = (fn) => { const copy = JSON.parse(JSON.stringify(BASE)); fn(copy); return copy; };

  describe('refused: nothing is committed and the staged change is left in the index', () => {
    it.skipIf(!gitAvailable()).each([
      ['autoApply turned on', BASE, (c) => { c.improvement.autoApply = 'on'; }, /improvement\.autoApply/],
      ['autoApply set where it was absent', { build: BASE.build }, (c) => { c.improvement = { autoApply: 'off' }; }, /improvement\.autoApply/],
      ['graduation.consecutive lowered', BASE, (c) => { c.improvement.graduation.consecutive = 1; }, /improvement\.graduation/],
      ['graduation.maxReverts raised', BASE, (c) => { c.improvement.graduation.maxReverts = 50; }, /improvement\.graduation/],
      ['a new key added under graduation', BASE, (c) => { c.improvement.graduation.extra = true; }, /improvement\.graduation/],
      ['graduation removed', BASE, (c) => { delete c.improvement.graduation; }, /improvement\.graduation/],
      ['improvement removed altogether', BASE, (c) => { delete c.improvement; }, /improvement\.autoApply/],
      ['autoApply given another type of value', BASE, (c) => { c.improvement.autoApply = ['on']; }, /improvement\.autoApply/],
      ['watch.runs changed', BASE, (c) => { c.improvement.watch.runs = 8; }, /improvement\.watch/],
      ['a budget block added', BASE, (c) => { c.improvement.budget = { maxRuns: 500 }; }, /improvement\.budget/],
    ])('%s', (_name, before, change, pattern) => {
      const r = repoWith(before);
      const next = JSON.parse(JSON.stringify(before));
      change(next);
      stage(r, next);
      const head = q(r, 'rev-parse', 'HEAD');
      const tree = q(r, 'write-tree');

      const { status, stdout } = run(r);

      expect(status, stdout).toBe(1);
      expect(stdout).toMatch(pattern);
      expect(stdout).toMatch(/self-improvement switches/);
      expect(stdout).toMatch(/Fix: unstage it \(git restore --staged \.claude\/gate\.config\.json\)/);
      expect(stdout).toContain(OVERRIDE);
      expect(stdout).toContain('nothing was committed');
      expect(q(r, 'rev-parse', 'HEAD')).toBe(head);
      expect(q(r, 'write-tree')).toBe(tree);
      expect(q(r, 'diff', '--cached', '--name-only')).toBe(CONFIG_REL);
    });

    it.skipIf(!gitAvailable())('the gate config deleted from the index while it held autoApply', () => {
      const r = repoWith(edit((c) => { c.improvement.autoApply = 'on'; }));
      q(r, 'rm', '-q', CONFIG_REL);
      const { status, stdout } = run(r);
      expect(status, stdout).toBe(1);
      expect(stdout).toMatch(/improvement\.autoApply/);
    });

    it.skipIf(!gitAvailable())('the first commit of a repository that sets autoApply (unborn HEAD)', () => {
      const r = tmp.root;
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: r, stdio: 'pipe' });
      q(r, 'config', 'user.name', 'Test');
      q(r, 'config', 'user.email', 'test@example.com');
      q(r, 'config', 'commit.gpgsign', 'false');
      stage(r, { improvement: { autoApply: 'on' } });
      const { status, stdout } = run(r);
      expect(status, stdout).toBe(1);
      expect(stdout).toMatch(/improvement\.autoApply/);
      expect(commitCount(r)).toBe(0);
    });

    it.skipIf(!gitAvailable())('the same change reached through --paths and through --all', () => {
      for (const flags of [['--paths', CONFIG_REL], ['--all']]) {
        const sub = createTmpDir({ prefix: 'commit-improvement-x-' });
        try {
          const r = createGitRepo({ root: sub.root }).repoPath;
          write(r, CONFIG_REL, json(BASE));
          q(r, 'add', CONFIG_REL);
          q(r, 'commit', '-q', '-m', 'init', '--no-verify');
          write(r, CONFIG_REL, json(edit((c) => { c.improvement.autoApply = 'on'; })));
          const before = commitCount(r);
          const { status, stdout } = run(r, flags);
          expect(status, `${flags.join(' ')}: ${stdout}`).toBe(1);
          expect(stdout).toMatch(/improvement\.autoApply/);
          expect(commitCount(r)).toBe(before);
        } finally {
          sub.cleanup();
        }
      }
    });

    it.skipIf(!gitAvailable())('an --amend that adds the change', () => {
      const r = repoWith(BASE);
      stage(r, edit((c) => { c.improvement.autoApply = 'on'; }));
      const head = q(r, 'rev-parse', 'HEAD');
      const { status, stdout } = run(r, ['--amend']);
      expect(status, stdout).toBe(1);
      expect(q(r, 'rev-parse', 'HEAD')).toBe(head);
    });

    it.skipIf(!gitAvailable()).each([
      ['not valid JSON', '{ "improvement": { "autoApply": "on" '],
      ['a JSON array', '[]\n'],
      ['a bare string', '"on"\n'],
      ['an empty file', ''],
    ])('a staged config that is %s cannot be judged and is refused', (_name, text) => {
      const r = repoWith(BASE);
      stage(r, text);
      const before = commitCount(r);
      const { status, stdout } = run(r);
      expect(status, stdout).toBe(1);
      expect(stdout).toMatch(/cannot be checked/);
      expect(stdout).toMatch(/Fix: unstage it/);
      expect(commitCount(r)).toBe(before);
    });

    it.skipIf(!gitAvailable())('a staged symlink in place of the config cannot be judged and is refused', () => {
      const r = repoWith(BASE);
      fs.rmSync(path.join(r, CONFIG_REL));
      try {
        fs.symlinkSync('/etc/hostname', path.join(r, CONFIG_REL));
      } catch {
        return; // the OS refuses symlinks here: nothing to test
      }
      q(r, 'add', CONFIG_REL);
      const { status, stdout } = run(r);
      expect(status, stdout).toBe(1);
      expect(stdout).toMatch(/cannot be checked/);
    });
  });

  describe('not refused: an unrelated or equivalent edit is no false positive', () => {
    it.skipIf(!gitAvailable())('the whole file reformatted and every key reordered, the same values', () => {
      const r = repoWith(BASE);
      const shuffled = { improvement: { watch: { runs: 5 }, graduation: { maxReverts: 1, consecutive: 3 }, autoApply: 'off' }, build: { command: 'npm run build' } };
      stage(r, `${JSON.stringify(shuffled)}\n`);
      expect(q(r, 'diff', '--cached', '--name-only')).toBe(CONFIG_REL);
      const before = commitCount(r);
      const { status, stdout } = run(r);
      expect(status, stdout).toBe(0);
      expect(commitCount(r)).toBe(before + 1);
    });

    it.skipIf(!gitAvailable())('another key of the gate config changed (the build command), improvement untouched', () => {
      const r = repoWith(BASE);
      stage(r, edit((c) => { c.build.command = 'npm run build -- --prod'; c.test = { command: 'npm test' }; }));
      const before = commitCount(r);
      const { status, stdout } = run(r);
      expect(status, stdout).toBe(0);
      expect(commitCount(r)).toBe(before + 1);
    });

    it.skipIf(!gitAvailable())('another improvement key changed: one outside the wall (scope) commits', () => {
      const r = repoWith(BASE);
      stage(r, edit((c) => { c.improvement.scope = ['docs/']; }));
      const { status, stdout } = run(r);
      expect(status, stdout).toBe(0);
    });

    it.skipIf(!gitAvailable())('a config that sets no guarded key is added for the first time', () => {
      const r = repoWith(null);
      stage(r, { build: { command: 'npm run build' } });
      const { status, stdout } = run(r);
      expect(status, stdout).toBe(0);
    });

    it.skipIf(!gitAvailable())('the same change in a working tree that is NOT staged does not trip it: only the index counts', () => {
      const r = repoWith(BASE);
      write(r, CONFIG_REL, json(edit((c) => { c.improvement.autoApply = 'on'; })));
      write(r, 'notes.md', 'notes\n');
      q(r, 'add', 'notes.md');
      const { status, stdout } = run(r);
      expect(status, stdout).toBe(0);
      expect(q(r, 'show', `HEAD:${CONFIG_REL}`)).toContain('"off"');
    });

    it.skipIf(!gitAvailable())('a malformed config that is already in HEAD and is not staged again is not read', () => {
      const r = repoWith('{ not json');
      write(r, 'notes.md', 'notes\n');
      q(r, 'add', 'notes.md');
      const { status, stdout } = run(r);
      expect(status, stdout).toBe(0);
    });

    it.skipIf(!gitAvailable())('a HEAD config that does not parse, fixed by a staged one that sets no guarded key', () => {
      const r = repoWith('{ not json');
      stage(r, { build: { command: 'npm run build' } });
      const { status, stdout } = run(r);
      expect(status, stdout).toBe(0);
    });

    it.skipIf(!gitAvailable())('an --amend of a commit that already carries the change adds nothing new', () => {
      const r = repoWith(BASE);
      stage(r, edit((c) => { c.improvement.autoApply = 'on'; }));
      expect(run(r, [], { [OVERRIDE]: '1' }).status).toBe(0);
      const { status, stdout } = run(r, ['--amend']);
      expect(status, stdout).toBe(0);
    });

    it.skipIf(!gitAvailable())('a repository with no gate config at all commits as before', () => {
      const r = repoWith(null);
      write(r, 'app.js', 'const x = 1;\n');
      q(r, 'add', 'app.js');
      const { status, stdout } = run(r);
      expect(status, stdout).toBe(0);
    });
  });

  describe('the owner override', () => {
    it.skipIf(!gitAvailable())('AGENTS_ALLOW_IMPROVEMENT_CONFIG=1 commits the change, warns, and records a bypass event', () => {
      const r = repoWith(BASE);
      stage(r, edit((c) => { c.improvement.autoApply = 'on'; c.improvement.graduation.consecutive = 2; }));
      const before = commitCount(r);

      const { status, stdout } = run(r, [], { [OVERRIDE]: '1' });

      expect(status, stdout).toBe(0);
      expect(commitCount(r)).toBe(before + 1);
      expect(q(r, 'show', `HEAD:${CONFIG_REL}`)).toContain('"on"');
      expect(stdout).toMatch(/allowed by AGENTS_ALLOW_IMPROVEMENT_CONFIG=1/);
      expect(stdout).toMatch(/Recorded in guardrail-events\.jsonl/);
      const events = eventsOf(r).filter((e) => e.rule === 'commit-improvement-config');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event: 'guardrail', decision: 'bypass', source: 'commit.js' });
      expect(events[0].reason).toContain('improvement.autoApply');
      expect(events[0].reason).toContain('improvement.graduation');
    });

    it.skipIf(!gitAvailable())('only the exact value 1 overrides', () => {
      const r = repoWith(BASE);
      stage(r, edit((c) => { c.improvement.autoApply = 'on'; }));
      for (const value of ['0', 'true', 'yes', '']) {
        const { status, stdout } = run(r, [], { [OVERRIDE]: value });
        expect(status, `value ${JSON.stringify(value)}: ${stdout}`).toBe(1);
      }
    });

    it.skipIf(!gitAvailable())('the secret-scan bypass is not the override', () => {
      const r = repoWith(BASE);
      stage(r, edit((c) => { c.improvement.autoApply = 'on'; }));
      const { status, stdout } = run(r, ['--no-scan']);
      expect(status, stdout).toBe(1);
      expect(stdout).toMatch(/self-improvement switches/);
    });
  });
});
