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

const { execSync } = require('child_process');

// ── path classification (pure) ────────────────────────────────────────────────
// A repo-relative path is "code" (scrutinize), "disposable" (regenerable working
// state — safe), or "other" (unknown — review). Tech-agnostic defaults; the
// disposable set covers this toolkit's own scratch files (.commit-msg/.pr-body)
// plus common regenerable artifacts.
const CODE_RE = /^(src|tests|tools)\//;
const DISPOSABLE_RE = /(^docs\/\.output\/|^\.claude\/|(^|\/)Directory\.Build\.props$|(^|\/)\.commit-msg$|(^|\/)\.pr-body$|(^|\/)node_modules\/)/;

function classifyPath(p) {
  if (CODE_RE.test(p)) return 'code';
  if (DISPOSABLE_RE.test(p)) return 'disposable';
  return 'other';
}

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
function codeFileSignature(present, basenamePresentElsewhere) {
  if (present) return 'modified';                 // exists in base → merge-noise
  if (basenamePresentElsewhere) return 'renamed'; // moved elsewhere in base
  return 'NEW';                                   // genuinely absent → unmerged signal
}

// ── git helpers (impure) ───────────────────────────────────────────────────────
function git(args, { cwd, raw } = {}) {
  // git names with slashes mangle under MSYS path-conversion; disable it.
  const out = execSync(`git ${args}`, {
    encoding: 'utf8',
    cwd: cwd || process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  // raw: keep leading whitespace (porcelain XY status lines start with a space);
  // a blanket .trim() would eat the first line's leading space and shift the path.
  return raw ? out.replace(/\n+$/, '') : out.trim();
}
function gitSafe(args, o) { try { return git(args, o); } catch { return ''; } }
function gitOk(args, o) { try { git(args, o); return true; } catch { return false; } }

// ── audits (impure) ────────────────────────────────────────────────────────────
function auditBranch(branch, ctx) {
  const { BASE, baseTree, PROTECTED, baseBasenames } = ctx;
  // backup/* are deliberate recovery snapshots — never propose for deletion.
  if (PROTECTED.has(branch) || /^backup\//.test(branch)) return { branch, verdict: 'KEEP', reason: 'protected' };

  // Upstream tracking state (gone = PR auto-deleted source = merged). Bug fix:
  // `rev-parse branch@{u}` throws OUTRIGHT once the tracking ref is pruned (the
  // exact "gone" case), so gitSafe swallowed it to '' and this always reported
  // 'none' — the documented corroborating signal could never fire. for-each-ref's
  // %(upstream:track) survives a pruned ref and reports the literal "[gone]".
  const track = gitSafe(`for-each-ref --format='%(upstream:track)' refs/heads/${branch}`).replace(/'/g, '');
  const hasUpstreamConfig = gitOk(`config --get branch.${branch}.merge`);
  let upstreamState = 'none';
  if (track.includes('[gone]')) upstreamState = 'gone';
  else if (hasUpstreamConfig) upstreamState = 'tracking';

  const ahead = gitSafe(`rev-list --count ${BASE}..${branch}`) || '0';

  // the only clean "fully merged" signal: no-op merge into base
  const mt = gitSafe(`merge-tree --write-tree ${BASE} ${branch}`);
  const mergedTree = mt.split('\n')[0];
  if (mergedTree === baseTree) {
    return { branch, verdict: 'MERGED', ahead, upstreamState, code: [], docs: [] };
  }

  // net-new files this branch would contribute on top of base
  const files = gitSafe(`diff --name-only ${baseTree} ${mergedTree}`).split('\n').filter(Boolean);
  const code = [];
  const docs = [];
  for (const f of files) {
    if (classifyPath(f) === 'code') {
      const present = gitOk(`cat-file -e ${BASE}:${f}`);
      code.push({ file: f, sig: codeFileSignature(present, baseBasenames.has(f.split('/').pop())) });
    } else {
      docs.push(f);
    }
  }

  const verdict = branchVerdictFromCode(code.map((c) => c.sig));
  return { branch, verdict, ahead, upstreamState, code, docs };
}

function listWorktrees() {
  const out = git('worktree list --porcelain');
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
  const status = (() => { try { return git('status --porcelain', { cwd: wt.path, raw: true }); } catch { return ''; } })();
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

  if (!gitOk(`rev-parse --verify ${BASE}`)) {
    console.error(`branch-audit: base ref '${BASE}' not found. Fetch first, or pass --base.`);
    process.exit(0);
  }
  const baseTree = git(`show -s --format=%T ${BASE}`); // caret-free (cmd.exe eats ^{tree})
  const current = gitSafe('rev-parse --abbrev-ref HEAD');
  const baseShort = BASE.replace(/^origin\//, '');
  const PROTECTED = new Set(['main', 'master', baseShort, current, ...EXTRA_KEEP]);
  const baseFiles = git(`ls-tree -r --name-only ${BASE}`).split('\n').filter(Boolean);
  const baseBasenames = new Set(baseFiles.map((f) => f.split('/').pop()));
  const ctx = { BASE, baseTree, PROTECTED, baseBasenames };

  const branches = git("for-each-ref --format='%(refname:short)' refs/heads/")
    .split('\n').map((s) => s.replace(/'/g, '').trim()).filter(Boolean);
  const worktrees = listWorktrees();
  const primaryPath = gitSafe('rev-parse --show-toplevel');

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
  CODE_RE, DISPOSABLE_RE,
  git, gitSafe, gitOk, auditBranch, listWorktrees, auditWorktree, main,
};

if (require.main === module) main(process.argv.slice(2));
