/**
 * linked-worktree — a real git repository (the "main" worktree) with one linked worktree, for tests that must run
 * the actual helper and hook processes the way a linked-worktree session does. CommonJS; load via createRequire().
 *
 * The main worktree's tracked files are copies of the toolkit files a test names, so a process started from
 * `<linked>/.agents/...` finds its siblings and resolves its repository from its own location, as a worktree
 * checkout of the real toolkit does.
 *
 * Usage:
 *   const { createLinkedWorktree } = require('./linked-worktree');
 *   const fx = createLinkedWorktree({ copy: ['.agents/core/run-record.js', '.agents/core/_lib'] });
 *   // fx.main, fx.linked  (both realpath'd absolute paths), fx.cleanup()
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TOOLKIT = path.resolve(__dirname, '..', '..', '..', '..');

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * @param {{ copy?: string[] }} [options]  Toolkit-relative files or directories to track in the repository
 *   (a directory is copied without its `__tests__`).
 * @returns {{ main: string, linked: string, cleanup: () => void }}
 */
function createLinkedWorktree({ copy = [] } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-wt-')));
  const main = path.join(base, 'main');
  const linked = path.join(base, 'linked');
  fs.mkdirSync(main, { recursive: true });
  for (const rel of copy) {
    const src = path.join(TOOLKIT, rel);
    const dest = path.join(main, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true, filter: (file) => path.basename(file) !== '__tests__' });
  }
  fs.writeFileSync(path.join(main, '.gitignore'), 'docs/.output/.state/\n');
  git(main, ['init', '-q', '-b', 'main']);
  git(main, ['add', '-A']);
  git(main, ['commit', '-q', '-m', 'fixture']);
  git(main, ['worktree', 'add', '-q', '-b', 'wt', linked]);
  return {
    main,
    linked,
    cleanup() { fs.rmSync(base, { recursive: true, force: true }); },
  };
}

module.exports = { createLinkedWorktree };
