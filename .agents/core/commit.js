#!/usr/bin/env node
// .claude/core/commit.js — robust commit helper for Claude (and humans).
//
// WHY: Inlining a multiline commit message via `git commit -m "..."` is fragile —
// quoting/here-string syntax differs between bash and PowerShell, and em-dashes,
// backticks, or `@` tokens leak into the subject. File-based messages sidestep
// ALL shell escaping.
//
// WORKFLOW:
//   1. Write the commit message (subject line, blank line, body) to
//      docs/.output/.state/.commit-msg using the Write tool — no shell escaping needed.
//      (Working-tree path, NOT under .git/ — so it resolves correctly inside git
//       worktrees, where .git is a file pointer rather than a directory.)
//   2. Run:
//        node .claude/core/commit.js              # commit staged changes
//        node .claude/core/commit.js --all        # stage everything, then commit
//        node .claude/core/commit.js --paths A B  # stage exactly A and B, then commit
//        node .claude/core/commit.js --amend      # amend the last commit's message/content
//        node .claude/core/commit.js --dry-run    # print the final message, commit nothing
//
// MULTI-PROCESS SAFETY:
//   With NO --all and NO --paths, this commits ONLY what is already staged — it
//   never runs `git add` of its own, so a concurrent process (a parallel /run-todo,
//   a background agent) sharing the working tree cannot get its in-flight files
//   swept into your commit. --all (git add -A) is UNSAFE when the tree is shared.
//   --paths stages an explicit, reviewable set and is the multi-process-safe way
//   to commit specific files.
//
// GUARANTEES:
//   - Preserves supplied message content without adding attribution.
//   - Trims trailing blank / stray-token lines (e.g. a leaked '@', quote, backtick).
//   - Commits on the CURRENT branch only — never switches or creates branches.
//   - Honors git hooks (never passes --no-verify).
//
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { git } = require('./_lib/git');

// Parse argv into the flags/options the rest of the flow consumes. Pure: takes the
// already-sliced argv array (process.argv.slice(2)) so it can be tested directly.
function parseArgs(args) {
  const has = (...flags) => flags.some((f) => args.includes(f));
  const stageAll = has('--all', '-a');
  const amend = has('--amend');
  const dryRun = has('--dry-run', '-n');

  // --paths <pathspec...> — stage EXACTLY these paths (git add -- <paths>), then
  // commit only-staged. Collect every token after --paths that does NOT start with
  // '-', so trailing flags (e.g. --amend) after the path list still parse.
  let paths = null;
  const pathsIdx = args.indexOf('--paths');
  if (pathsIdx >= 0) {
    paths = [];
    for (let i = pathsIdx + 1; i < args.length && !args[i].startsWith('-'); i++) {
      paths.push(args[i]);
    }
    if (paths.length === 0) {
      throw new Error('--paths requires at least one pathspec, e.g. --paths README.md docs/x.md');
    }
  }

  // --paths and --all are mutually exclusive: one stages an explicit set, the
  // other sweeps everything. Combining them is contradictory — fail loudly.
  if (paths && stageAll) {
    throw new Error('--paths and --all are mutually exclusive (explicit set vs sweep-everything). Pick one.');
  }

  const fileIdx = args.indexOf('--file');
  const msgFile = fileIdx >= 0 ? args[fileIdx + 1] : path.join('docs', '.output', '.state', '.commit-msg');

  const mIdx = args.indexOf('-m');
  const inlineMsg = mIdx >= 0 ? args[mIdx + 1] : null;

  const noScan = has('--no-scan') || process.env.CLAUDE_COMMIT_NO_SCAN === '1';

  return { stageAll, amend, dryRun, fileIdx, msgFile, inlineMsg, noScan, paths };
}

// `git rev-parse --abbrev-ref HEAD` fails on an unborn branch (a fresh `git init`
// with zero commits yet) — HEAD is a symref with nothing to resolve to. This is
// exactly the state of a brand-new scaffolded repo's FIRST commit, so fall back to
// `symbolic-ref`, which reads the symref name directly and works with no commits.
function currentBranch() {
  try {
    return git(['symbolic-ref', '--short', 'HEAD']);
  } catch {
    return git(['rev-parse', '--abbrev-ref', 'HEAD']);
  }
}

// Read + normalize the raw message text. With an inline -m string, use it directly
// (never touch the file). Otherwise require the file to exist, then read it.
// Exits the process (code 1) on a missing file — same as the original top-level body.
function readMessage(inlineMsg, msgFile) {
  // When -m is provided, skip the file existence check and file read entirely.
  if (!inlineMsg && !fs.existsSync(msgFile)) {
    console.error(`[commit] message file not found: ${msgFile}`);
    console.error('[commit] Write your subject + body there first (Write tool), then re-run.');
    process.exit(1);
  }

  // Read, normalize line endings, and trim trailing junk lines.
  // When -m is used, take the inline string directly (never touch the file).
  let lines = inlineMsg
    ? inlineMsg.replace(/\r\n/g, '\n').split('\n')
    : fs.readFileSync(msgFile, 'utf8').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && /^[\s@'"`]*$/.test(lines[lines.length - 1])) lines.pop();

  if (!lines.join('\n').trim()) {
    console.error('[commit] message is empty after trimming. Aborting.');
    process.exit(1);
  }

  return lines;
}

// Run the secret-scan gate (the pre-commit hook, living in our own flow).
// A plain .git/hooks/pre-commit was retired (fossil-prone across the fleet), and
// the PreToolUse:Write/Edit scanner only sees Claude's Write/Edit tool — NOT files
// that reach the index via Bash, scripts, or a human's terminal. commit.js IS the
// project's commit path, so the staged-content scan lives here: it runs
// secret-scanner.cjs over the staged set and aborts the commit on a finding.
// Bypass (rare — e.g. a deliberately-redacted example that still matches a
// pattern): --no-scan, or CLAUDE_COMMIT_NO_SCAN=1.
function runScan(noScan) {
  if (noScan) return;
  const scanner = path.join(__dirname, '..', 'hooks', 'secret-scanner.cjs');
  if (fs.existsSync(scanner)) {
    const scan = spawnSync(process.execPath, [scanner, '--git-precommit'], { stdio: 'inherit', windowsHide: true });
    if (scan.status !== 0) {
      console.error('[commit] secret scan blocked the commit. Remove the secret, or override with --no-scan / CLAUDE_COMMIT_NO_SCAN=1 (NOT recommended).');
      process.exit(scan.status || 1);
    }
  } else {
    console.warn(`[commit] WARNING: secret scanner not found at ${scanner} — committing WITHOUT a secret scan.`);
  }
}

// A path whose deletion is already staged (e.g. the source side of a `git mv`)
// matches nothing in the worktree or index, so `git add` would fail with
// "pathspec did not match". Its change is already staged — skip it. Typos still
// reach `git add` and fail loudly. Used by the live run and by --dry-run so the
// dry-run output names exactly what the live run would add.
function pathsToAdd(paths, announce = true) {
  return paths.filter((p) => {
    if (fs.existsSync(p) || git(['ls-files', '--', p])) return true;
    if (git(['diff', '--cached', '--name-only', '--diff-filter=D', '--', p])) {
      if (announce) console.log(`[commit] ${p}: deletion already staged, skipping git add`);
      return false;
    }
    return true;
  });
}

function main() {
  const args = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    console.error(`[commit] ${e.message}`);
    process.exit(1);
  }
  const { stageAll, amend, dryRun, fileIdx, msgFile, inlineMsg, noScan, paths } = parsed;

  const lines = readMessage(inlineMsg, msgFile);
  const finalMsg = `${lines.join('\n').replace(/\s+$/, '')}\n`;

  // Only write finalMsg back to the file when using the file-based path.
  // When -m is used we never create a file (that's the whole point).
  // NOTE: this write happens BEFORE the dry-run bail below, on purpose — a
  // --dry-run with a file-based message still normalizes the .commit-msg file
  // so the caller can inspect the exact final message on disk.
  // Do NOT move this below the `if (dryRun)` check: that would silently
  // change dry-run to leave the file un-normalized.
  if (!inlineMsg) {
    fs.writeFileSync(msgFile, finalMsg, 'utf8');
  }

  if (dryRun) {
    console.log('[commit] --dry-run — final message below, nothing committed:\n');
    console.log('────────────────────────────────────────');
    process.stdout.write(finalMsg);
    console.log('────────────────────────────────────────');
    if (paths) {
      const wouldAdd = pathsToAdd(paths, false);
      console.log(wouldAdd.length ? `[commit] would run: git add -- ${wouldAdd.join(' ')}` : '[commit] would run: no git add (every listed path is already staged)');
    }
    const stagePrefix = stageAll ? 'add -A && ' : '';
    if (inlineMsg) {
      console.log(`[commit] would run: git ${stagePrefix}commit -m <msg>${amend ? ' --amend' : ''}`);
    } else {
      console.log(`[commit] would run: git ${stagePrefix}commit -F ${msgFile}${amend ? ' --amend' : ''}`);
    }
    process.exit(0);
  }

  const branch = currentBranch();
  console.log(`[commit] branch: ${branch}`);

  if (paths) {
    // Stage EXACTLY the listed paths. NOTE: --paths *adds* to the index — any
    // files staged before this call are still committed. For strict isolation,
    // commit from a clean index.
    const toAdd = pathsToAdd(paths);
    if (toAdd.length) git(['add', '--', ...toAdd]);
    console.log(`[commit] staged paths: ${paths.join(' ')}`);
    const stagedSet = git(['diff', '--cached', '--name-only']);
    console.log('[commit] staged set now:');
    console.log(stagedSet ? stagedSet.split('\n').map((f) => `  ${f}`).join('\n') : '  (nothing staged)');
  } else if (stageAll) {
    git(['add', '-A']);
    console.log('[commit] staged all changes (git add -A)');
  }

  // TOCTOU guard for the scan→commit window. runScan reads the STAGED content
  // (`git show :<file>`); a concurrent stager (`git add` from a parallel
  // /run-todo or a background agent sharing this working tree) could slip
  // unscanned content into the shared index between the scan and the commit.
  // `git write-tree` reifies the current index into a tree oid WITHOUT mutating
  // it, so capturing the oid before the scan and re-checking it immediately
  // before the commit detects any index change under us. With the only-staged
  // default and a single stager the oids always match and this never fires.
  let stagedTreeOid = null;
  try { stagedTreeOid = git(['write-tree']); } catch { /* unborn/empty index — no tree to guard */ }

  runScan(noScan);

  if (stagedTreeOid !== null) {
    let treeNow = null;
    try { treeNow = git(['write-tree']); } catch { /* leave null → skip the compare */ }
    if (treeNow !== null && treeNow !== stagedTreeOid) {
      console.error('[commit] ABORT: the staged set changed between the secret scan and the commit (a concurrent `git add`?). Re-run so the new content is scanned before it is committed.');
      process.exit(1);
    }
  }

  // When -m is used, pass the final message directly via args array (safe — spawnSync
  // does NOT go through a shell, so no quoting risk). Otherwise use -F for file-based.
  const commitArgs = inlineMsg
    ? ['commit', '-m', finalMsg, ...(amend ? ['--amend'] : [])]
    : ['commit', '-F', msgFile, ...(amend ? ['--amend'] : [])];

  // Use spawnSync with inherited stdio so hook output streams through live.
  const res = spawnSync('git', commitArgs, { stdio: 'inherit', windowsHide: true });
  if (res.status !== 0) {
    console.error(`[commit] git commit failed (exit ${res.status}).`);
    process.exit(res.status || 1);
  }

  // Clean up the default message file after a successful commit so the next commit
  // starts from a blank slate — and so the Write tool never has to read-before-write
  // a stale leftover. Custom --file paths are deliberately left untouched.
  // When -m is used, no file was written so there is nothing to delete.
  if (fileIdx < 0 && !inlineMsg) {
    try {
      fs.rmSync(msgFile);
    } catch {
      /* best-effort — a leftover msg file is harmless, it's overwritten next commit */
    }
  }

  console.log(`[commit] done: ${git(['log', '-1', '--format=%h %s'])}`);
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, readMessage, runScan, main, currentBranch };
