#!/usr/bin/env node

/**
 * branch-audit.js — safe pre-prune audit of local branches + worktrees.
 *
 * WHY THIS EXISTS
 * ---------------
 * Parallel agent work leaves a graveyard of local branches and git worktrees.
 * Deciding what's safe to delete by hand is slow AND dangerous — a blind prune
 * has near-missed real work (an already-merged branch whose worktree held
 * UNCOMMITTED source that existed nowhere else; an 84-file untracked export).
 * And `git branch -d` REFUSES squash-merged branches (the squash isn't an
 * ancestor), so people reach for `-D` and lose the safety net entirely.
 *
 * The naive signals all lie:
 *   - `git log origin/main..branch` shows commits for squash-merged branches
 *     (the squash commit has a different hash) → false "unmerged".
 *   - `git diff origin/main...branch` (three-dot) shows ALL the branch's changes
 *     for a fully-merged branch (the merge-base never moved) → false "unmerged".
 *   - `merge-tree` net-new OVER-reports: when main advanced past the branch on a
 *     shared file, re-merging re-applies the branch's now-superseded hunks, so a
 *     merged branch still shows "net-new" on files it no longer owns.
 *
 * WHAT ACTUALLY WORKS (encoded here)
 * ----------------------------------
 *   - Branch is fully merged IFF `merge-tree --write-tree base branch` yields a
 *     tree IDENTICAL to base's tree (a true no-op merge). The only clean signal.
 *   - When it differs, the DECISIVE unmerged-code signal is a code file the
 *     branch ADDS that `base` lacks ENTIRELY — but first rule out a rename:
 *     if a file of the same basename exists elsewhere in base, it almost
 *     certainly moved. Modified-but-present code files are merge-noise.
 *   - Classify net-new by PATH: src/|tests/|tools/ = code (scrutinize);
 *     everything else (docs/, .claude/) = disposable straggler.
 *   - `[upstream: gone]` = the PR auto-completed and deleted its source branch =
 *     merged. A strong corroborating signal.
 *   - WORKTREES are the real hazard: a clean branch can have a DIRTY worktree
 *     with uncommitted code or valuable untracked files. Always inspect
 *     `git status` per worktree and classify the dirty paths before removing.
 *
 * USAGE
 *   node .claude/core/branch-audit.js              # full report (branches + worktrees)
 *   node .claude/core/branch-audit.js --base <ref> # compare against a ref other than origin/main
 *   node .claude/core/branch-audit.js --keep a,b   # never-flag-for-delete branches (always kept: current, main, base)
 *   node .claude/core/branch-audit.js --worktrees  # only the worktree dirty audit
 *   node .claude/core/branch-audit.js --branches   # only the branch merge audit
 *   node .claude/core/branch-audit.js --prune-plan # print the exact (unexecuted) git commands to clean the SAFE set
 *   node .claude/core/branch-audit.js --json       # machine-readable
 *
 * This tool NEVER deletes anything. It reports verdicts and, with --prune-plan,
 * prints commands for you to review and run. Exit 0 always (read-only).
 *
 * VERDICTS
 *   branch   MERGED       no-op merge into base — 100% contained, safe to delete
 *            MERGED~       differs only by superseded/renamed code or doc stragglers — safe (corroborate w/ upstream gone)
 *            REVIEW        adds code file(s) absent from base (not a rename) — possible unmerged work, inspect first
 *            KEEP          protected (current / main / base / --keep)
 *   worktree CLEAN         no uncommitted changes — safe to remove
 *            DIRTY-DOCS    only disposable dirt (docs/.output, .claude shims) — safe to remove
 *            DIRTY-OTHER   untracked non-code, non-disposable paths (e.g. an export) — REVIEW before removing
 *            DIRTY-CODE    uncommitted src/tests/tools changes — PRESERVE (commit/stash before removing)
 */

'use strict';

// ── path classification (pure) ────────────────────────────────────────────────
// A repo-relative path is "code" (scrutinize), "disposable" (regenerable working
// state — safe), or "other" (unknown — review). Tech-agnostic defaults; the
// disposable set covers this toolkit's own scratch files (.commit-msg/.pr-body)
// plus common regenerable artifacts.
//
// DISPOSABLE is deliberately narrow — it must NOT wave through authored `.claude/`
// content (a new SKILL.md, agent/command .md, hook .cjs). Those are real work; a
// worktree holding only new uncommitted `.claude/` files must classify as 'other'
// (REVIEW), never 'disposable' (safe-to-remove). Generated `.claude/` state lives
// under docs/.output/.state/, which the docs/.output/ branch already covers.
const CODE_RE = /^(src|tests|tools)\//;
const DISPOSABLE_RE = /(^docs\/\.output\/|(^|\/)Directory\.Build\.props$|(^|\/)\.commit-msg$|(^|\/)\.pr-body$|(^|\/)node_modules\/)/;

function classifyPath(p) {
  if (CODE_RE.test(p)) return 'code';
  if (DISPOSABLE_RE.test(p)) return 'disposable';
  return 'other';
}

// ── branch-name safety (defense-in-depth) ─────────────────────────────────────
// git() no longer touches a shell (execFileSync argv), so metacharacters in a
// branch name can't inject. This is a belt-and-suspenders reject of enumerated
// names carrying shell metacharacters ($ ` ; | & ( ) newline) — the toolkit
// never legitimately audits such a branch, so skipping one is lossless.
//
// Deliberately does NOT reject a leading `-` (which would let a branch name be
// misread as a flag by git in an argv position, e.g. `git merge-tree --write-tree
// BASE -branch`). Every branch name this file processes comes from `git
// for-each-ref --format=%(refname:short) refs/heads/` (main(), above) — never
// from arbitrary/attacker-controlled input — and `git check-ref-format` refuses
// to create a ref that starts with `-` in the first place, so a leading-`-`
// branch name is not a state git itself can ever produce here. If a future
// change ever threads a branch name from a source OTHER than for-each-ref (e.g.
// a CLI flag), that assumption breaks and this function would need an explicit
// leading-`-` guard (or the call sites would need `--`-guarding before the ref
// argv position) — this comment exists so that change doesn't quietly reopen
// the gap.
const SHELL_METACHAR_RE = /[$`;|&()\n]/;
function hasShellMetachar(name) { return SHELL_METACHAR_RE.test(name); }

/**
 * Derive a branch verdict from the net-new code-file signatures of a non-no-op
 * merge. `codeSigs` is an array of 'NEW' | 'modified' | 'renamed'. A genuinely
 * absent ('NEW') code file is the only unmerged-work signal; everything else is
 * merge-noise → MERGED~ (effectively contained).
 */
function branchVerdictFromCode(codeSigs) {
  return codeSigs.some((s) => s === 'NEW') ? 'REVIEW' : 'MERGED~';
}

/** Derive a worktree verdict from the classified kinds of its dirty paths. */
function worktreeVerdictFromDirty(kinds) {
  if (kinds.some((k) => k === 'code')) return 'DIRTY-CODE';
  if (kinds.some((k) => k === 'other')) return 'DIRTY-OTHER';
  return 'DIRTY-DOCS';
}

/** Classify a net-new code file against base: 'modified' | 'renamed' | 'NEW'. */
function codeFileSignature(present, basenameInSiblingDir) {
  if (present) return 'modified';             // exists in base → merge-noise
  if (basenameInSiblingDir) return 'renamed'; // same basename in same/sibling dir → a move
  return 'NEW';                               // genuinely absent → unmerged signal
}

const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const parentOf = (dir) => { const i = dir.lastIndexOf('/'); return i < 0 ? '' : dir.slice(0, i); };

/**
 * Rename heuristic, scoped to the same-or-sibling directory. A net-new code file
 * `f` looks like a move ONLY if base holds the same basename under a directory
 * sharing `f`'s parent directory — not merely *anywhere* in base. Without the
 * scope, a genuinely new `index.js`/`README.md` is waved through as "renamed"
 * because its basename coincides with an unrelated file elsewhere (N2).
 * `byBasename` maps basename → Set<dirname> over base's files.
 */
function basenameInSiblingDir(byBasename, f) {
  const dirs = byBasename.get(f.split('/').pop());
  if (!dirs) return false;
  const fParent = parentOf(dirOf(f));
  for (const d of dirs) { if (parentOf(d) === fParent) return true; }
  return false;
}

// ── git helpers (impure) ───────────────────────────────────────────────────────
// Shared argv-array wrapper (F27) — this file's original implementation moved
// verbatim to _lib/git.js so commit.js/pull-request.js stop re-declaring subsets.
// Re-exported below: tests and callers import git/gitSafe/gitOk from here.
const { git, gitSafe, gitOk } = require('./_lib/git');

// ── audits (impure) ────────────────────────────────────────────────────────────
function auditBranch(branch, ctx) {
  const { BASE, baseTree, PROTECTED, baseByBasename } = ctx;
  // backup/* are deliberate recovery snapshots — never propose for deletion.
  if (PROTECTED.has(branch) || /^backup\//.test(branch)) return { branch, verdict: 'KEEP', reason: 'protected' };

  // Upstream tracking state (gone = PR auto-deleted source = merged). Bug fix:
  // `rev-parse branch@{u}` throws OUTRIGHT once the tracking ref is pruned (the
  // exact "gone" case), so gitSafe swallowed it to '' and this always reported
  // 'none' — the documented corroborating signal could never fire. for-each-ref's
  // %(upstream:track) survives a pruned ref and reports the literal "[gone]".
  // F24: main() batches this for ALL branches in two upfront calls (one
  // for-each-ref, one config --get-regexp) threaded through ctx — the
  // per-branch spawns below are the fallback for hand-built ctx (tests,
  // library callers) so behavior is identical either way.
  const track = ctx.trackByBranch
    ? (ctx.trackByBranch.get(branch) || '')
    : gitSafe(['for-each-ref', '--format=%(upstream:track)', 'refs/heads/' + branch]);
  const hasUpstreamConfig = ctx.upstreamConfigured
    ? ctx.upstreamConfigured.has(branch)
    : gitOk(['config', '--get', 'branch.' + branch + '.merge']);
  let upstreamState = 'none';
  if (track.includes('[gone]')) upstreamState = 'gone';
  else if (hasUpstreamConfig) upstreamState = 'tracking';

  const ahead = gitSafe(['rev-list', '--count', BASE + '..' + branch]) || '0';

  // the only clean "fully merged" signal: no-op merge into base
  const mt = gitSafe(['merge-tree', '--write-tree', BASE, branch]);
  const mergedTree = mt.split('\n')[0];
  if (mergedTree === baseTree) {
    return { branch, verdict: 'MERGED', ahead, upstreamState, code: [], docs: [] };
  }

  // net-new files this branch would contribute on top of base
  const files = gitSafe(['diff', '--name-only', baseTree, mergedTree]).split('\n').filter(Boolean);
  const code = [];
  const docs = [];
  for (const f of files) {
    if (classifyPath(f) === 'code') {
      // F25: BASE's full tree listing is already in memory (main() loads it to
      // build baseByBasename) — answer "does BASE contain f" from that Set
      // instead of a git cat-file spawn per file. Per-file spawn remains only
      // for hand-built ctx without the Set.
      const present = ctx.baseFilesSet
        ? ctx.baseFilesSet.has(f)
        : gitOk(['cat-file', '-e', BASE + ':' + f]);
      code.push({ file: f, sig: codeFileSignature(present, basenameInSiblingDir(baseByBasename, f)) });
    } else {
      docs.push(f);
    }
  }

  const verdict = branchVerdictFromCode(code.map((c) => c.sig));
  return { branch, verdict, ahead, upstreamState, code, docs };
}

function listWorktrees() {
  const out = git(['worktree', 'list', '--porcelain']);
  const trees = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: null }; trees.push(cur); }
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === 'detached' && cur) cur.branch = '(detached)';
  }
  return trees;
}
function auditWorktree(wt) {
  const status = (() => { try { return git(['status', '--porcelain'], { cwd: wt.path, raw: true }); } catch { return ''; } })();
  if (!status) return { ...wt, verdict: 'CLEAN', dirty: [] };
  const dirty = status.split('\n').filter(Boolean).map((l) => {
    const xy = l.slice(0, 2);
    const p = l.slice(3).replace(/^"(.*)"$/, '$1').split(' -> ').pop();
    return { xy, path: p, kind: classifyPath(p) };
  });
  return { ...wt, verdict: worktreeVerdictFromDirty(dirty.map((d) => d.kind)), dirty };
}

// ── CLI ────────────────────────────────────────────────────────────────────────
function main(argv) {
  const flag = (name) => argv.includes(name);
  const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
  const BASE = opt('--base', 'origin/main');
  const EXTRA_KEEP = (opt('--keep', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ONLY_WT = flag('--worktrees');
  const ONLY_BR = flag('--branches');
  const PRUNE_PLAN = flag('--prune-plan');
  const JSON_OUT = flag('--json');

  if (!gitOk(['rev-parse', '--verify', BASE])) {
    console.error(`branch-audit: base ref '${BASE}' not found. Fetch first, or pass --base.`);
    process.exit(0);
  }
  const baseTree = git(['show', '-s', '--format=%T', BASE]); // caret-free (cmd.exe eats ^{tree})
  const current = gitSafe(['rev-parse', '--abbrev-ref', 'HEAD']);
  const baseShort = BASE.replace(/^origin\//, '');
  const PROTECTED = new Set(['main', 'master', baseShort, current, ...EXTRA_KEEP]);
  const baseFiles = git(['ls-tree', '-r', '--name-only', BASE]).split('\n').filter(Boolean);
  // basename → set of the directories it appears in, for the same/sibling-dir rename heuristic.
  const baseByBasename = new Map();
  for (const f of baseFiles) {
    const b = f.split('/').pop();
    let dirs = baseByBasename.get(b);
    if (!dirs) baseByBasename.set(b, (dirs = new Set()));
    dirs.add(dirOf(f));
  }
  // F25: the same listing answers per-file "present in BASE?" — no cat-file spawns.
  const baseFilesSet = new Set(baseFiles);

  // F24: batch the per-branch upstream-tracking spawns. ONE for-each-ref lists
  // every local branch's %(upstream:track); ONE config --get-regexp lists every
  // branch with upstream config (the exact predicate the old per-branch
  // `config --get branch.<b>.merge` probed). 4N+ spawns → N+2 for N branches.
  // NUL separator — `|` is legal in a ref name, and a branch literally named
  // `a|b` with a gone upstream would mis-key a pipe-split map onto branch `a`.
  // Git forbids NUL in ref names, so %00 can never collide.
  const trackByBranch = new Map();
  for (const line of gitSafe(['for-each-ref', '--format=%(refname:short)%00%(upstream:track)', 'refs/heads/']).split('\n')) {
    const sep = line.indexOf('\0');
    if (sep > 0) trackByBranch.set(line.slice(0, sep), line.slice(sep + 1));
  }
  const upstreamConfigured = new Set();
  for (const line of gitSafe(['config', '--get-regexp', '^branch\\..*\\.merge$']).split('\n')) {
    const m = line.match(/^branch\.(.+)\.merge(\s|$)/);
    if (m) upstreamConfigured.add(m[1]);
  }

  const ctx = { BASE, baseTree, PROTECTED, baseByBasename, baseFilesSet, trackByBranch, upstreamConfigured };

  const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
    .split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((b) => {
      // Defense-in-depth: git() no longer shells, but never process a branch whose
      // name carries shell metacharacters — skip it loudly rather than audit it.
      if (hasShellMetachar(b)) { console.error(`branch-audit: skipping branch with unsafe name: ${b}`); return false; }
      return true;
    });
  const worktrees = listWorktrees();
  const primaryPath = gitSafe(['rev-parse', '--show-toplevel']);

  const branchReports = (ONLY_WT ? [] : branches.map((b) => auditBranch(b, ctx)));
  const worktreeReports = (ONLY_BR ? [] : worktrees.map(auditWorktree));
  const checkedOut = new Set(worktrees.map((w) => w.branch).filter(Boolean));

  if (JSON_OUT) {
    console.log(JSON.stringify({ base: BASE, branches: branchReports, worktrees: worktreeReports }, null, 2));
    process.exit(0);
  }

  const M = { MERGED: '✓', 'MERGED~': '✓', REVIEW: '⚠', KEEP: '•', CLEAN: '✓', 'DIRTY-DOCS': '✓', 'DIRTY-OTHER': '⚠', 'DIRTY-CODE': '⚠' };

  if (!ONLY_WT) {
    console.log(`\n── BRANCHES vs ${BASE} ${'─'.repeat(40)}`);
    for (const r of branchReports.sort((a, b) => a.verdict.localeCompare(b.verdict) || a.branch.localeCompare(b.branch))) {
      const up = r.upstreamState ? ` up:${r.upstreamState}` : '';
      let detail = '';
      if (r.verdict === 'REVIEW') detail = '  ' + r.code.filter((c) => c.sig === 'NEW').map((c) => `NEW ${c.file}`).join(', ');
      else if (r.verdict === 'MERGED~') {
        const bits = [];
        if (r.code.length) bits.push(`${r.code.length} superseded/renamed code`);
        if (r.docs.length) bits.push(`${r.docs.length} doc straggler${r.docs.length > 1 ? 's' : ''}`);
        detail = '  (' + bits.join(', ') + ')';
      }
      const wt = checkedOut.has(r.branch) ? ' [in worktree]' : '';
      console.log(`  ${M[r.verdict]} ${r.verdict.padEnd(8)} ${r.branch}${up}${wt}${detail}`);
    }
  }

  if (!ONLY_BR) {
    console.log(`\n── WORKTREES ${'─'.repeat(48)}`);
    for (const r of worktreeReports) {
      const tag = r.path === primaryPath ? ' (primary)' : '';
      console.log(`  ${M[r.verdict]} ${r.verdict.padEnd(11)} ${r.branch || '(none)'}${tag}  ${r.path}`);
      if (r.verdict === 'DIRTY-CODE' || r.verdict === 'DIRTY-OTHER') {
        for (const d of r.dirty.filter((d) => d.kind !== 'disposable')) console.log(`        ${d.xy} ${d.path}  <${d.kind}>`);
      }
    }
  }

  const safeBranches = branchReports.filter((r) => (r.verdict === 'MERGED' || r.verdict === 'MERGED~') && !checkedOut.has(r.branch));
  const reviewBranches = branchReports.filter((r) => r.verdict === 'REVIEW');
  const safeWts = worktreeReports.filter((r) => r.path !== primaryPath && (r.verdict === 'CLEAN' || r.verdict === 'DIRTY-DOCS'));
  const preserveWts = worktreeReports.filter((r) => r.verdict === 'DIRTY-CODE' || r.verdict === 'DIRTY-OTHER');

  console.log(`\n── SUMMARY ${'─'.repeat(50)}`);
  console.log(`  safe to delete : ${safeBranches.length} branches, ${safeWts.length} worktrees`);
  if (reviewBranches.length) console.log(`  ⚠ REVIEW first : ${reviewBranches.map((r) => r.branch).join(', ')}`);
  if (preserveWts.length) console.log(`  ⚠ PRESERVE     : ${preserveWts.map((r) => `${r.branch || r.path} (${r.verdict})`).join(', ')}`);
  console.log(`  protected      : ${[...PROTECTED].filter((b) => branches.includes(b)).join(', ')}`);

  if (PRUNE_PLAN) {
    console.log(`\n── PRUNE PLAN (review, then run manually) ${'─'.repeat(20)}`);
    console.log('  # worktrees first (a branch checked out in a worktree cannot be deleted)');
    for (const w of safeWts) console.log(`  git worktree remove --force "${w.path}"`);
    if (safeWts.length) console.log('  git worktree prune');
    for (const b of safeBranches) console.log(`  git branch -D ${b}`);
    if (reviewBranches.length || preserveWts.length) console.log('  # NOT included above — resolve the ⚠ items by hand first.');
  }

  process.exit(0);
}

module.exports = {
  classifyPath, branchVerdictFromCode, worktreeVerdictFromDirty, codeFileSignature,
  basenameInSiblingDir, hasShellMetachar,
  CODE_RE, DISPOSABLE_RE,
  git, gitSafe, gitOk, auditBranch, listWorktrees, auditWorktree, main,
};

if (require.main === module) main(process.argv.slice(2));
