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
