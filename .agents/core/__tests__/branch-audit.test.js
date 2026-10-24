// AC→source: branch-audit.js — safe pre-prune audit of branches + worktrees.
// Covers the pure classification/verdict core (path classification, code-file
// signature, branch + worktree verdict derivation) AND the impure git-shelling
// layer (auditBranch, listWorktrees, auditWorktree, main) against real fixture
// repos built with git-fixture.js + raw git plumbing (branching, merging,
// worktrees — beyond what the shared fixture's addCommit supports).
//
// Bug fix made while writing these tests (see auditBranch upstream detection
// below): `rev-parse branch@{u}` throws outright once the tracking ref is
// pruned, so the old code's upstreamState collapsed 'gone' into 'none' —
// the documented "PR auto-merged, source deleted" signal could never fire.
// Replaced with for-each-ref's %(upstream:track), which survives a pruned ref.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  classifyPath, branchVerdictFromCode, worktreeVerdictFromDirty, codeFileSignature,
  basenameInSiblingDir, hasShellMetachar,
  git, gitSafe, gitOk, auditBranch, listWorktrees, auditWorktree, main,
} = require('../../../.agents/core/branch-audit');
const { createTmpDir } = require('./_helpers/tmp-dir');
const { createGitRepo, gitAvailable } = require('./_helpers/git-fixture');

describe('classifyPath', () => {
  it('flags src/tests/tools as code (scrutinize)', () => {
    expect(classifyPath('src/app/main.js')).toBe('code');
    expect(classifyPath('tests/foo.test.js')).toBe('code');
    expect(classifyPath('tools/build.js')).toBe('code');
  });
  it('flags regenerable working state as disposable', () => {
    expect(classifyPath('docs/.output/plans/x.md')).toBe('disposable');
    expect(classifyPath('docs/.output/.state/.commit-msg')).toBe('disposable');
    expect(classifyPath('docs/.output/.state/.pr-body')).toBe('disposable');
    expect(classifyPath('node_modules/x/index.js')).toBe('disposable');
  });
  it('treats unknown paths as other (review)', () => {
    expect(classifyPath('design-export/logo.svg')).toBe('other');
    expect(classifyPath('README.md')).toBe('other');
  });
  // C1 regression: authored .claude/ content is real work, never "safe to remove".
  // Previously DISPOSABLE_RE matched ^\.claude\/ wholesale, so a worktree holding
  // only new uncommitted skills/agents/commands/hooks was waved through prune-plan.
  it('classifies authored .claude/ content as other (REVIEW), NOT disposable', () => {
    expect(classifyPath('.claude/skills/new-skill/SKILL.md')).not.toBe('disposable');
    expect(classifyPath('.claude/skills/new-skill/SKILL.md')).toBe('other');
    expect(classifyPath('.claude/agents/new-agent.md')).toBe('other');
    expect(classifyPath('.claude/commands/do.md')).toBe('other');
    expect(classifyPath('.claude/hooks/some-hook.cjs')).toBe('other');
  });
});

describe('hasShellMetachar', () => {
  it('rejects branch names carrying shell metacharacters', () => {
    for (const meta of ['x$(id)', 'x`id`', 'a;b', 'a|b', 'a&b', 'a(b)', 'a\nb']) {
      expect(hasShellMetachar(meta)).toBe(true);
    }
  });
  it('accepts ordinary branch names', () => {
    for (const ok of ['main', 'feature/foo', 'release-1.2', 'backup/2026-01-01', 'fix_bug']) {
      expect(hasShellMetachar(ok)).toBe(false);
    }
  });
});

describe('basenameInSiblingDir (dir-scoped rename heuristic)', () => {
  const build = (files) => {
    const m = new Map();
    for (const f of files) {
      const b = f.split('/').pop();
      const i = f.lastIndexOf('/');
      const dir = i < 0 ? '' : f.slice(0, i);
      if (!m.has(b)) m.set(b, new Set());
      m.get(b).add(dir);
    }
    return m;
  };
  it('true for a same-parent (sibling) directory move — tools/util.js → src/util.js', () => {
    expect(basenameInSiblingDir(build(['tools/util.js']), 'src/util.js')).toBe(true);
  });
  it('true for a same-directory basename', () => {
    expect(basenameInSiblingDir(build(['src/foo/util.js']), 'src/foo/util.js')).toBe(true);
  });
  it('false for a coincidental basename in an unrelated directory (N2 fix)', () => {
    // base has lib/index.js (parent ""); new src/app/index.js (parent "src") → NOT a rename.
    expect(basenameInSiblingDir(build(['lib/index.js']), 'src/app/index.js')).toBe(false);
    expect(basenameInSiblingDir(build(['docs/README.md']), 'src/pkg/README.md')).toBe(false);
  });
  it('false when the basename is absent from base entirely', () => {
    expect(basenameInSiblingDir(build(['src/other.js']), 'src/new.js')).toBe(false);
  });
});

describe('branchVerdictFromCode', () => {
  it('REVIEW when a genuinely-new code file is present', () => {
    expect(branchVerdictFromCode(['modified', 'NEW'])).toBe('REVIEW');
  });
  it('MERGED~ when only superseded/renamed code remains', () => {
    expect(branchVerdictFromCode(['modified', 'renamed'])).toBe('MERGED~');
    expect(branchVerdictFromCode([])).toBe('MERGED~');
  });
});

describe('codeFileSignature', () => {
  it('present in base → modified (merge-noise)', () => {
    expect(codeFileSignature(true, false)).toBe('modified');
  });
  it('absent but basename elsewhere → renamed', () => {
    expect(codeFileSignature(false, true)).toBe('renamed');
  });
  it('genuinely absent → NEW (unmerged signal)', () => {
    expect(codeFileSignature(false, false)).toBe('NEW');
  });
});

describe('worktreeVerdictFromDirty', () => {
  it('DIRTY-CODE when any code path is dirty', () => {
    expect(worktreeVerdictFromDirty(['disposable', 'code'])).toBe('DIRTY-CODE');
  });
  it('DIRTY-OTHER when non-code, non-disposable dirt exists', () => {
    expect(worktreeVerdictFromDirty(['disposable', 'other'])).toBe('DIRTY-OTHER');
  });
  it('DIRTY-DOCS when only disposable dirt', () => {
    expect(worktreeVerdictFromDirty(['disposable', 'disposable'])).toBe('DIRTY-DOCS');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Impure layer — real git repos. git-fixture's addCommit doesn't cover
// branching/merging/worktrees, so a small raw-git helper supplements it here.
// ─────────────────────────────────────────────────────────────────────────

/** Run a git command in `cwd`, mirroring git-fixture.js's own run() convention. */
function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

/**
 * Normalize a Node-fs-sourced path (e.g. from mkdtempSync) to the form git's
 * porcelain output uses: forward slashes, and — on Windows — the long directory
 * name rather than an 8.3 short name. Some Windows profiles (a username with a
 * dot, e.g. "first.last") get %TEMP% set to its short-name alias
 * ("FIRST~1.LAS"); mkdtempSync preserves that alias, but git-for-windows
 * resolves and reports the long name with forward slashes. Without this,
 * asserting `listWorktrees()[i].path === repoPath` fails on those machines
 * even though both sides name the same directory.
 */
function gitPath(p) {
  return require('node:fs').realpathSync.native(p).split(path.sep).join('/');
}

/** git show -s --format=%T <ref> — the tree id, used to build an auditBranch ctx. */
function treeOf(ref, cwd) {
  return sh(`git show -s --format=%T ${ref}`, cwd).trim();
}

function baseCtx(repoPath, overrides = {}) {
  const baseByBasename = new Map();
  for (const f of sh('git ls-tree -r --name-only main', repoPath).split('\n').filter(Boolean)) {
    const b = f.split('/').pop();
    const i = f.lastIndexOf('/');
    const dir = i < 0 ? '' : f.slice(0, i);
    if (!baseByBasename.has(b)) baseByBasename.set(b, new Set());
    baseByBasename.get(b).add(dir);
  }
  return {
    BASE: 'main',
    baseTree: treeOf('main', repoPath),
    PROTECTED: new Set(['main']),
    baseByBasename,
    ...overrides,
  };
}

describe.skipIf(!gitAvailable())('auditBranch (real git)', () => {
  let tmp;
  let repo;
  let repoPath;
  let origCwd;

  beforeEach(() => {
    tmp = createTmpDir({ prefix: 'branch-audit-test-' });
    repoPath = path.join(tmp.root, 'repo');
    repo = createGitRepo({ root: repoPath });
    // auditBranch's git/gitSafe/gitOk calls take no explicit cwd — they shell
    // out relative to process.cwd(), so the fixture repo must be current.
    origCwd = process.cwd();
    process.chdir(repoPath);
  });

  afterEach(() => {
    process.chdir(origCwd);
    tmp.cleanup();
  });

  it('MERGED when the branch contributes no tree changes over base', () => {
    sh('git branch noop-branch', repoPath);
    const result = auditBranch('noop-branch', baseCtx(repoPath));
    expect(result.verdict).toBe('MERGED');
    expect(result.branch).toBe('noop-branch');
  });

  it('REVIEW with mixed modified + genuinely-new code, plus a docs straggler', () => {
    sh('mkdir -p tools src', repoPath);
    require('node:fs').writeFileSync(path.join(repoPath, 'tools/util.js'), 'x\n');
    require('node:fs').writeFileSync(path.join(repoPath, 'docs.md'), 'doc\n');
    sh('git add tools/util.js docs.md', repoPath);
    sh(`git commit -F ${writeMsg(tmp, 'seed')}`, repoPath);
    sh('git branch feature', repoPath);
    sh('git checkout feature -q', repoPath);
    require('node:fs').appendFileSync(path.join(repoPath, 'tools/util.js'), 'y\n');
    require('node:fs').writeFileSync(path.join(repoPath, 'src/newthing.js'), 'z\n');
    require('node:fs').appendFileSync(path.join(repoPath, 'docs.md'), 'more\n');
    sh('git add -A', repoPath);
    sh(`git commit -F ${writeMsg(tmp, 'changes')}`, repoPath);
    sh('git checkout main -q', repoPath);

    const result = auditBranch('feature', baseCtx(repoPath));
    expect(result.verdict).toBe('REVIEW');
    expect(result.code.some((c) => c.file === 'tools/util.js' && c.sig === 'modified')).toBe(true);
    expect(result.code.some((c) => c.file === 'src/newthing.js' && c.sig === 'NEW')).toBe(true);
    expect(result.docs).toEqual(['docs.md']);
  });

  it('MERGED~ when a code file was renamed (git mv) and content is otherwise unchanged', () => {
    require('node:fs').mkdirSync(path.join(repoPath, 'tools'), { recursive: true });
    require('node:fs').writeFileSync(path.join(repoPath, 'tools/util.js'), 'x\n');
    sh('git add tools/util.js', repoPath);
    sh(`git commit -F ${writeMsg(tmp, 'seed')}`, repoPath);
    sh('git branch feature', repoPath);
    sh('git checkout feature -q', repoPath);
    sh('mkdir -p src', repoPath);
    sh('git mv tools/util.js src/util.js', repoPath);
    sh(`git commit -F ${writeMsg(tmp, 'move')}`, repoPath);
    sh('git checkout main -q', repoPath);

    const result = auditBranch('feature', baseCtx(repoPath));
    expect(result.verdict).toBe('MERGED~');
    expect(result.code).toEqual([{ file: 'src/util.js', sig: 'renamed' }]);
  });

  it('KEEP (protected) for a branch in the PROTECTED set — never shells out to git', () => {
    // No such branch need exist: the protected check short-circuits before any git call.
    const result = auditBranch('main', baseCtx(repoPath, { PROTECTED: new Set(['main']) }));
    expect(result).toEqual({ branch: 'main', verdict: 'KEEP', reason: 'protected' });
  });

  it('KEEP (protected) for any backup/* branch regardless of PROTECTED set', () => {
    const result = auditBranch('backup/2026-01-01', baseCtx(repoPath, { PROTECTED: new Set() }));
    expect(result.verdict).toBe('KEEP');
    expect(result.reason).toBe('protected');
  });

  it('upstreamState "none" for a branch with no upstream configured', () => {
    sh('git branch plain-branch', repoPath);
    const result = auditBranch('plain-branch', baseCtx(repoPath));
    expect(result.upstreamState).toBe('none');
  });

  it('upstreamState "tracking" when the remote-tracking ref exists and is current', () => {
    sh('git branch tracked-branch', repoPath);
    fakeUpstream(repoPath, 'tracked-branch', { deleteRef: false });
    const result = auditBranch('tracked-branch', baseCtx(repoPath));
    expect(result.upstreamState).toBe('tracking');
  });

  it('upstreamState "gone" when the remote-tracking ref was pruned (PR auto-merged)', () => {
    // Regression test for the bug found while writing this suite: the branch
    // still HAS upstream config (branch.X.remote/.merge) but the tracking ref
    // itself no longer exists — the real-world shape of `git fetch --prune`
    // after a squash-merge auto-deletes the source branch.
    sh('git branch gone-branch', repoPath);
    fakeUpstream(repoPath, 'gone-branch', { deleteRef: true });
    const result = auditBranch('gone-branch', baseCtx(repoPath));
    expect(result.upstreamState).toBe('gone');
  });

  // F24/F25 (council-260715-2244): main() batches upstream tracking (one
  // for-each-ref + one config --get-regexp) and BASE-tree membership (one
  // ls-tree Set) into ctx; auditBranch must consume those instead of spawning
  // per-branch/per-file git. Prove consumption by handing ctx maps that
  // CONTRADICT the real repo state — the batched value must win.
  it('consumes ctx.trackByBranch/upstreamConfigured/baseFilesSet instead of re-spawning git (F24/F25)', () => {
    sh('git branch batched-branch', repoPath);
    // Real repo: no upstream at all. Batched maps claim [gone] — map must win.
    const goneCtx = baseCtx(repoPath, {
      trackByBranch: new Map([['batched-branch', '[gone]']]),
      upstreamConfigured: new Set(),
    });
    expect(auditBranch('batched-branch', goneCtx).upstreamState).toBe('gone');

    const trackingCtx = baseCtx(repoPath, {
      trackByBranch: new Map([['batched-branch', '']]),
      upstreamConfigured: new Set(['batched-branch']),
    });
    expect(auditBranch('batched-branch', trackingCtx).upstreamState).toBe('tracking');

    // F25: a branch adding a genuinely-new code file classifies via
    // baseFilesSet. A set that (falsely) claims the file exists in BASE must
    // flip the signature from NEW to modified — proving no cat-file spawn.
    require('node:fs').mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    require('node:fs').writeFileSync(path.join(repoPath, 'src/brand-new.js'), 'n\n');
    sh('git checkout -b f25-branch -q', repoPath);
    sh('git add src/brand-new.js', repoPath);
    sh(`git commit -F ${writeMsg(tmp, 'new file')}`, repoPath);
    sh('git checkout main -q', repoPath);

    const honestSet = baseCtx(repoPath, { baseFilesSet: new Set() });
    const resultNew = auditBranch('f25-branch', honestSet);
    expect(resultNew.code.some((c) => c.file === 'src/brand-new.js' && c.sig === 'NEW')).toBe(true);

    const lyingSet = baseCtx(repoPath, { baseFilesSet: new Set(['src/brand-new.js']) });
    const resultPresent = auditBranch('f25-branch', lyingSet);
    expect(resultPresent.code.some((c) => c.file === 'src/brand-new.js' && c.sig === 'modified')).toBe(true);
  });
});

/** Write a commit message to a throwaway file (git commit -F avoids the repo's own commit-guard hook, which only intercepts this project's Bash tool calls, not subprocess git). */
function writeMsg(tmp, text) {
  return tmp.write(`.msg-${Math.random().toString(36).slice(2)}.txt`, text + '\n');
}

/**
 * Simulate a remote-tracking branch for `branch` in `repoPath`: adds a dummy
 * `origin` remote (never fetched from) plus a manually created
 * refs/remotes/origin/<branch> ref, then wires branch.<branch>.remote/.merge
 * so `%(upstream:track)` can resolve it. With deleteRef:true, the tracking ref
 * is removed afterward (config survives) — the "gone" real-world shape.
 */
function fakeUpstream(repoPath, branch, { deleteRef }) {
  try { sh('git remote add origin /nonexistent/dummy.git', repoPath); } catch { /* already added */ }
  const sha = sh('git rev-parse main', repoPath).trim();
  sh(`git update-ref refs/remotes/origin/${branch} ${sha}`, repoPath);
  sh(`git config branch.${branch}.remote origin`, repoPath);
  sh(`git config branch.${branch}.merge refs/heads/${branch}`, repoPath);
  if (deleteRef) sh(`git update-ref -d refs/remotes/origin/${branch}`, repoPath);
}

describe.skipIf(!gitAvailable())('git / gitSafe / gitOk (real git)', () => {
  let tmp;
  let repoPath;

  beforeEach(() => {
    tmp = createTmpDir({ prefix: 'branch-audit-helpers-test-' });
    repoPath = path.join(tmp.root, 'repo');
    createGitRepo({ root: repoPath });
  });

  afterEach(() => { tmp.cleanup(); });

  it('git() runs a real command and trims trailing whitespace', () => {
    const out = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
    expect(out).toBe('main');
  });

  it('git() with raw:true preserves leading whitespace (porcelain XY columns)', () => {
    require('node:fs').writeFileSync(path.join(repoPath, 'untracked.txt'), 'x\n');
    const out = git(['status', '--porcelain'], { cwd: repoPath, raw: true });
    expect(out.startsWith('??')).toBe(true);
  });

  it('gitSafe() returns "" instead of throwing on an invalid command', () => {
    expect(gitSafe(['not-a-real-git-subcommand'], { cwd: repoPath })).toBe('');
  });

  it('gitOk() is true for a valid ref and false for an invalid one', () => {
    expect(gitOk(['rev-parse', '--verify', 'main'], { cwd: repoPath })).toBe(true);
    expect(gitOk(['rev-parse', '--verify', 'totally-bogus-ref'], { cwd: repoPath })).toBe(false);
  });

  // C1 regression: a branch/argument carrying a command-substitution payload must
  // NEVER reach a shell. With execFileSync(argv) the metachars are inert literals —
  // git rejects the ref, no proof file is ever written.
  it('git() never shells out — a $()-payload argument cannot execute a command', () => {
    const proof = path.join(repoPath, 'PROOF_RCE');
    // gitSafe swallows git's "unknown revision" error; the point is the side effect.
    gitSafe(['rev-parse', '--verify', 'x$(touch ' + proof + ')'], { cwd: repoPath });
    gitSafe(['for-each-ref', '--format=%(refname:short)', 'refs/heads/x`touch ' + proof + '`'], { cwd: repoPath });
    expect(require('node:fs').existsSync(proof)).toBe(false);
  });
});

describe.skipIf(!gitAvailable())('listWorktrees / auditWorktree (real git)', () => {
  let tmp;
  let repoPath;
  let origCwd;

  beforeEach(() => {
    tmp = createTmpDir({ prefix: 'branch-audit-wt-test-' });
    repoPath = path.join(tmp.root, 'repo');
    createGitRepo({ root: repoPath });
    // Seed tracked placeholders so a later untracked file under the same dir
    // reports its FULL path (git collapses a wholly-untracked dir to just
    // "dir/" otherwise), matching real-world dirty-path classification.
    const fs = require('node:fs');
    fs.mkdirSync(path.join(repoPath, 'docs/.output'), { recursive: true });
    fs.mkdirSync(path.join(repoPath, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'docs/.output/.gitkeep'), '');
    fs.writeFileSync(path.join(repoPath, 'tests/.gitkeep'), '');
    sh('git add -A', repoPath);
    sh(`git commit -F ${writeMsg(tmp, 'seed placeholders')}`, repoPath);
    origCwd = process.cwd();
    process.chdir(repoPath);
  });

  afterEach(() => {
    process.chdir(origCwd);
    tmp.cleanup();
  });

  it('listWorktrees() reports the primary worktree with its branch', () => {
    const trees = listWorktrees();
    expect(trees.length).toBe(1);
    expect(trees[0].path).toBe(gitPath(repoPath));
    expect(trees[0].branch).toBe('main');
  });

  it('listWorktrees() includes a linked worktree added via git worktree add', () => {
    const wtPath = path.join(tmp.root, 'wt1');
    sh(`git worktree add "${wtPath}" -b wt1-branch -q`, repoPath);
    const trees = listWorktrees();
    expect(trees.length).toBe(2);
    expect(trees.some((t) => t.path === gitPath(wtPath) && t.branch === 'wt1-branch')).toBe(true);
  });

  it('auditWorktree: CLEAN when there are no uncommitted changes', () => {
    const result = auditWorktree({ path: repoPath, branch: 'main' });
    expect(result.verdict).toBe('CLEAN');
    expect(result.dirty).toEqual([]);
  });

  it('auditWorktree: DIRTY-CODE when an uncommitted code file is present', () => {
    const wtPath = path.join(tmp.root, 'wt-code');
    sh(`git worktree add "${wtPath}" -b wt-code-branch -q`, repoPath);
    require('node:fs').writeFileSync(path.join(wtPath, 'tests/new.test.js'), 'x\n');
    const result = auditWorktree({ path: wtPath, branch: 'wt-code-branch' });
    expect(result.verdict).toBe('DIRTY-CODE');
    expect(result.dirty.some((d) => d.path === 'tests/new.test.js' && d.kind === 'code')).toBe(true);
  });

  it('auditWorktree: DIRTY-DOCS when only disposable working state is dirty', () => {
    const wtPath = path.join(tmp.root, 'wt-docs');
    sh(`git worktree add "${wtPath}" -b wt-docs-branch -q`, repoPath);
    require('node:fs').writeFileSync(path.join(wtPath, 'docs/.output/plan.md'), 'x\n');
    const result = auditWorktree({ path: wtPath, branch: 'wt-docs-branch' });
    expect(result.verdict).toBe('DIRTY-DOCS');
    expect(result.dirty.every((d) => d.kind === 'disposable')).toBe(true);
  });

  it('auditWorktree: DIRTY-OTHER when an unclassified untracked path is dirty', () => {
    const wtPath = path.join(tmp.root, 'wt-other');
    sh(`git worktree add "${wtPath}" -b wt-other-branch -q`, repoPath);
    require('node:fs').writeFileSync(path.join(wtPath, 'random-export.csv'), 'x\n');
    const result = auditWorktree({ path: wtPath, branch: 'wt-other-branch' });
    expect(result.verdict).toBe('DIRTY-OTHER');
    expect(result.dirty.some((d) => d.path === 'random-export.csv' && d.kind === 'other')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// main() — CLI wiring, run in-process (mocked exit/console + chdir into the
// fixture) so v8 coverage instruments the branch/report/exit paths. A couple
// of subprocess smoke tests round out real end-to-end verification.
// ─────────────────────────────────────────────────────────────────────────

describe.skipIf(!gitAvailable())('main (CLI wiring, in-process)', () => {
  let tmp;
  let repoPath;
  let origCwd;

  beforeEach(() => {
    tmp = createTmpDir({ prefix: 'branch-audit-main-test-' });
    repoPath = path.join(tmp.root, 'repo');
    createGitRepo({ root: repoPath });
    sh('git branch feature', repoPath);
    origCwd = process.cwd();
    process.chdir(repoPath);
  });

  afterEach(() => {
    process.chdir(origCwd);
    tmp.cleanup();
  });

  /** Run main(argv) with process.exit/console mocked; exit throws to halt like a real exit would. */
  function runMain(argv) {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let exitCode;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      exitCode = code;
      throw new Error(`__EXIT_${code}__`);
    });
    try {
      main(argv);
    } catch (e) {
      if (!/^__EXIT_/.test(e.message)) throw e;
    }
    const logs = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    const errs = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    return { exitCode, logs, errs };
  }

  it('errors (exit 0, read-only) when --base does not resolve', () => {
    const { exitCode, errs } = runMain([]); // default --base origin/main, no such ref here
    expect(exitCode).toBe(0);
    expect(errs).toContain("base ref 'origin/main' not found");
  });

  it('--json emits a machine-readable report with branches + worktrees, then exits 0', () => {
    const { exitCode, logs } = runMain(['--base', 'main', '--json']);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(logs);
    expect(parsed.base).toBe('main');
    expect(Array.isArray(parsed.branches)).toBe(true);
    expect(Array.isArray(parsed.worktrees)).toBe(true);
    expect(parsed.branches.some((b) => b.branch === 'feature')).toBe(true);
    expect(parsed.branches.find((b) => b.branch === 'main').verdict).toBe('KEEP');
  });

  it('--branches restricts output to the branch section only', () => {
    const { logs } = runMain(['--base', 'main', '--branches']);
    expect(logs).toContain('BRANCHES vs main');
    expect(logs).not.toContain('WORKTREES');
  });

  it('--worktrees restricts output to the worktree section only', () => {
    const { logs } = runMain(['--base', 'main', '--worktrees']);
    expect(logs).toContain('WORKTREES');
    expect(logs).not.toContain('BRANCHES vs');
  });

  it('--keep protects an extra branch from being proposed for deletion', () => {
    const { logs } = runMain(['--base', 'main', '--branches', '--keep', 'feature']);
    // "feature" contributes no tree changes -> would otherwise be MERGED (safe-to-delete)
    expect(logs).toMatch(/KEEP\s+feature/);
  });

  it('--prune-plan prints git commands for the safe set and calls out REVIEW items', () => {
    require('node:fs').mkdirSync(path.join(repoPath, 'tests'), { recursive: true });
    require('node:fs').writeFileSync(path.join(repoPath, 'tests/new.test.js'), 'x\n');
    sh('git checkout feature -q', repoPath);
    sh('git add tests/new.test.js', repoPath);
    sh(`git commit -F ${writeMsg(tmp, 'add new code')}`, repoPath);
    sh('git checkout main -q', repoPath);

    const { logs } = runMain(['--base', 'main', '--prune-plan']);
    expect(logs).toContain('PRUNE PLAN');
    expect(logs).toContain('REVIEW first');
    expect(logs).not.toContain('git branch -D feature'); // REVIEW branches must never appear in the executable plan
  });

  it('exit code is always 0 (read-only tool) even on a full run', () => {
    const { exitCode } = runMain(['--base', 'main']);
    expect(exitCode).toBe(0);
  });

  // C1 end-to-end regression: a repo carrying a branch whose name is a command-
  // substitution payload (git allows $ ( ) > `` etc. in ref names). main() must
  // skip it with a stderr warning and — because git() no longer shells — must not
  // execute the payload. Proven by the absence of the proof file the payload writes.
  it('skips a branch whose name is an RCE payload and never executes it', () => {
    // Space-free, colon-free payload (git ref-format forbids spaces and colons):
    // if ever shelled, `id>PROOF_RCE` would write the proof file into cwd (repoPath).
    sh("git branch 'x$(id>PROOF_RCE)'", repoPath);
    const { exitCode, errs } = runMain(['--base', 'main', '--json']);
    expect(exitCode).toBe(0);
    expect(require('node:fs').existsSync(path.join(repoPath, 'PROOF_RCE'))).toBe(false);
    expect(errs).toContain('skipping branch with unsafe name');
  });

  it('renders the MERGED~ detail line (superseded/renamed code + doc stragglers) in the human-readable table', () => {
    require('node:fs').mkdirSync(path.join(repoPath, 'tools'), { recursive: true });
    require('node:fs').writeFileSync(path.join(repoPath, 'tools/util.js'), 'x\n');
    require('node:fs').writeFileSync(path.join(repoPath, 'docs.md'), 'doc\n');
    sh('git add tools/util.js docs.md', repoPath);
    sh(`git commit -F ${writeMsg(tmp, 'seed')}`, repoPath);
    sh('git branch renamed-branch', repoPath);
    sh('git checkout renamed-branch -q', repoPath);
    sh('mkdir -p src', repoPath);
    sh('git mv tools/util.js src/util.js', repoPath);
    require('node:fs').appendFileSync(path.join(repoPath, 'docs.md'), 'more\n');
    sh('git add -A', repoPath);
    sh(`git commit -F ${writeMsg(tmp, 'move + doc straggler')}`, repoPath);
    sh('git checkout main -q', repoPath);

    const { logs } = runMain(['--base', 'main', '--branches']);
    expect(logs).toMatch(/MERGED~\s+renamed-branch.*\(1 superseded\/renamed code, 1 doc straggler\)/);
  });

  it('lists per-file dirty paths for a DIRTY-CODE worktree in the human-readable table', () => {
    // A tracked placeholder under tests/ first — otherwise git collapses a
    // wholly-untracked "tests/" directory to just "tests/" in --porcelain,
    // instead of the specific new file path.
    require('node:fs').mkdirSync(path.join(repoPath, 'tests'), { recursive: true });
    require('node:fs').writeFileSync(path.join(repoPath, 'tests/.gitkeep'), '');
    sh('git add tests/.gitkeep', repoPath);
    sh(`git commit -F ${writeMsg(tmp, 'seed tests dir')}`, repoPath);

    const wtPath = path.join(tmp.root, 'wt-dirty-code');
    sh(`git worktree add "${wtPath}" -b wt-dirty-branch -q`, repoPath);
    require('node:fs').writeFileSync(path.join(wtPath, 'tests/uncommitted.test.js'), 'x\n');

    const { logs } = runMain(['--base', 'main']);
    expect(logs).toContain('DIRTY-CODE');
    expect(logs).toContain('tests/uncommitted.test.js');
    expect(logs).toContain('<code>');
  });
});

describe.skipIf(!gitAvailable())('branch-audit.js CLI (subprocess smoke test)', () => {
  let tmp;
  let repoPath;

  beforeEach(() => {
    tmp = createTmpDir({ prefix: 'branch-audit-subprocess-test-' });
    repoPath = path.join(tmp.root, 'repo');
    createGitRepo({ root: repoPath });
  });

  afterEach(() => { tmp.cleanup(); });

  it('runs end-to-end as a real subprocess and exits 0 with valid JSON', () => {
    const scriptPath = path.resolve(__dirname, '../../../.agents/core/branch-audit.js');
    const { execFileSync } = require('node:child_process');
    const stdout = execFileSync('node', [scriptPath, '--base', 'main', '--json'], {
      cwd: repoPath,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.base).toBe('main');
    expect(Array.isArray(parsed.branches)).toBe(true);
  });
});
