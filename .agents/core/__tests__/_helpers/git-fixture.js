/**
 * git-fixture — spins up isolated git repos on disk for tests that call execSync('git ...').
 * CommonJS (not ESM) — loaded via createRequire() bridge in test files.
 *
 * Usage:
 *   const { createGitRepo, gitAvailable } = require('./git-fixture');
 *   const repo = createGitRepo({ root: '/tmp/my-repo' });
 *   // repo.repoPath, repo.addCommit({ message, date, files }), repo.addCommitOnDate(message, isoDate)
 */

const { execSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Returns true if `git` is on PATH.
 * @returns {boolean}
 */
function gitAvailable() {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates an isolated git repository at `root`.
 *
 * @param {{ root: string, commits?: Array<{ message: string, date?: string, files?: Array<{ path: string, content?: string }> }> }} options
 * @returns {{ repoPath: string, addCommit: Function, addCommitOnDate: Function, addEmptyCommitsOnDates: Function } | null}
 *   Returns null (with a stderr note) if git is not on PATH.
 */
function createGitRepo({ root, commits = [] } = {}) {
  if (!gitAvailable()) {
    process.stderr.write('[git-fixture] git not on PATH — fixture returned null\n');
    return null;
  }
  if (!root) throw new Error('[git-fixture] createGitRepo requires { root }');

  const repoPath = root;
  fs.mkdirSync(repoPath, { recursive: true });

  /**
   * Run a git command inside the repo, optionally with extra env vars.
   * Always passes cwd as an option (not via shell cd) to stay cross-platform.
   */
  const run = (cmd, env = {}) =>
    execSync(cmd, {
      cwd: repoPath,
      stdio: 'pipe',
      env: { ...process.env, ...env },
    });

  run('git init -b main');
  run('git config user.name "Test"');
  run('git config user.email "test@example.com"');
  run('git config commit.gpgsign false');
  // Initial empty commit so HEAD exists on `main`
  run('git commit --allow-empty -m "initial"');

  /**
   * Add a commit to the repo, optionally writing files first.
   *
   * @param {{ message: string, date?: string, files?: Array<{ path: string, content?: string }> }} options
   */
  function addCommit({ message, date, files = [] }) {
    for (const f of files) {
      const full = path.join(repoPath, f.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content ?? '');
      // Use JSON.stringify so paths with spaces are safely quoted
      run(`git add ${JSON.stringify(f.path)}`);
    }

    const env = date
      ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      : {};

    const cmd =
      files.length > 0
        ? `git commit -m ${JSON.stringify(message)}`
        : `git commit --allow-empty -m ${JSON.stringify(message)}`;

    run(cmd, env);
  }

  /**
   * Add an empty commit with a forced author + committer date.
   * Dates must be ISO 8601 (e.g. '2024-06-15T12:00:00').
   * Critical for getActiveDaysSince and gen-timeline tests.
   *
   * @param {string} message
   * @param {string} isoDate   ISO 8601 datetime string
   */
  function addCommitOnDate(message, isoDate) {
    addCommit({ message, date: isoDate, files: [] });
  }

  /**
   * Append dated empty commits in one import, retaining the current parent tree.
   * Dates are stored at Git's whole-second precision in UTC. This fixture-only
   * shortcut bypasses commit hooks and signing; it does not replace addCommit.
   * Validate the entire batch before Git can change a ref.
   *
   * @param {Array<{message: string, date: string}>} entries
   */
  function addEmptyCommitsOnDates(entries) {
    if (!Array.isArray(entries) || entries.length > 1000) {
      throw new Error('[git-fixture] dated batch must be an array of at most 1000 commits');
    }
    let bytes = 0;
    const commits = Array.from(entries, entry => {
      if (!entry || typeof entry !== 'object' || typeof entry.message !== 'string'
          || entry.message.includes('\0')) {
        throw new Error('[git-fixture] dated commit requires a string message without NUL');
      }
      const message = Buffer.from(entry.message, 'utf8');
      bytes += message.length;
      if (message.length > 65536 || bytes > 8388608) {
        throw new Error('[git-fixture] dated batch messages exceed fixture limits');
      }
      const instant = typeof entry.date === 'string' && entry.date.trim()
        ? Date.parse(entry.date) : NaN;
      if (!Number.isFinite(instant) || instant < 0) {
        throw new Error('[git-fixture] dated commit requires a valid date on or after 1970-01-01');
      }
      return { message, seconds: Math.floor(instant / 1000) };
    });
    if (!commits.length) return;

    const options = {
      cwd: repoPath, encoding: 'utf8', windowsHide: true,
      timeout: 20000, maxBuffer: 1048576,
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    const ref = execFileSync('git', ['symbolic-ref', '--quiet', 'HEAD'], options).trim();
    const parent = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], options).trim();
    if (!/^refs\/heads\/[^\s\x00-\x1f\x7f]+$/.test(ref)
        || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(parent)) {
      throw new Error('[git-fixture] dated batch requires an attached branch with an existing commit');
    }
    const chunks = [];
    commits.forEach(({ message, seconds }, index) => {
      chunks.push(Buffer.from(`commit ${ref}\nmark :${index + 1}\nauthor Test <test@example.com> ${seconds} +0000\ncommitter Test <test@example.com> ${seconds} +0000\ndata ${message.length}\n`));
      chunks.push(message);
      chunks.push(Buffer.from(`\nfrom ${index === 0 ? parent : ':' + index}\n\n`));
    });
    chunks.push(Buffer.from('done\n'));
    execFileSync('git', ['fast-import', '--quiet', '--done', '--date-format=raw'], {
      ...options, input: Buffer.concat(chunks),
    });
  }

  // Seed repo with any initial commits provided at construction time
  for (const c of commits) {
    addCommit(c);
  }

  return { repoPath, addCommit, addCommitOnDate, addEmptyCommitsOnDates };
}

/**
 * Copies a disposable, self-contained repository without sharing objects or files.
 * No Git subprocesses run here; callers initialize a seed once and mutate only copies.
 * The destination may be absent or an empty ordinary directory.
 *
 * @param {{ source: string, root: string }} options
 * @returns {{ repoPath: string }}
 */
function copyGitRepo({ source, root } = {}) {
  if (typeof source !== 'string' || !source || typeof root !== 'string' || !root) {
    throw new Error('[git-fixture] copyGitRepo requires { source, root }');
  }
  const sourcePath = path.resolve(source);
  const repoPath = path.resolve(root);
  // Ancestor links can alias a descendant destination or copy into another tree.
  // Inspect before normal copying; existsSync alone misses dangling link leaves.
  function inspectAncestors(target) {
    for (let candidate = target; ; candidate = path.dirname(candidate)) {
      try {
        const stat = fs.lstatSync(candidate);
        if (stat.isSymbolicLink()) throw new Error('[git-fixture] copy paths must not contain symbolic links');
        if (candidate !== target && !stat.isDirectory()) throw new Error('[git-fixture] copy ancestors must be ordinary directories');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (candidate === path.dirname(candidate)) break;
    }
  }
  inspectAncestors(sourcePath);
  inspectAncestors(repoPath);
  const relative = path.relative(sourcePath, repoPath);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('[git-fixture] copy destination must be outside its source');
  }
  const ordinaryDirectory = target => {
    const stat = fs.lstatSync(target);
    return stat.isDirectory() && !stat.isSymbolicLink();
  };
  const metadata = path.join(sourcePath, '.git');
  if (!ordinaryDirectory(sourcePath) || !ordinaryDirectory(metadata)) {
    throw new Error('[git-fixture] copy source must have an ordinary .git directory');
  }
  for (const entry of ['commondir', 'gitdir', 'worktrees', 'objects/info/alternates', 'objects/info/http-alternates']) {
    if (fs.existsSync(path.join(metadata, entry))) {
      throw new Error('[git-fixture] copy source must not share Git metadata');
    }
  }
  // Refuse links and special files before copying rather than following external bytes.
  function inspect(directory) {
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error('[git-fixture] copy source must contain only ordinary files and directories');
      }
      if (stat.isDirectory()) inspect(target);
    }
  }
  inspect(sourcePath);
  if (fs.existsSync(repoPath) && (!ordinaryDirectory(repoPath) || fs.readdirSync(repoPath).length !== 0)) {
    throw new Error('[git-fixture] copy destination must be unoccupied');
  }
  // mode: 0 requests a normal physical copy, without clone/reflink or hardlink flags.
  fs.cpSync(sourcePath, repoPath, { recursive: true, force: false, errorOnExist: true, mode: 0 });
  return { repoPath };
}

module.exports = { createGitRepo, gitAvailable, copyGitRepo };
