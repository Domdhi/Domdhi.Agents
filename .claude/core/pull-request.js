#!/usr/bin/env node
// .claude/core/pull-request.js — host-detecting PR helper for Claude (and humans).
//
// WHY: The correct PR-creation invocation + its pre/post-flight checks are
// tribal knowledge — spread across agent memory, re-derived every time, and
// dropped under pressure. This tool encodes the safe path as the DEFAULT path:
// detect the git host from `origin`, dispatch to the right CLI (GitHub `gh` or
// Azure DevOps `az`), run the pre-flight gate, create the PR with auto-merge +
// squash + delete-source baked in, then VERIFY the auto-merge actually took
// (both CLIs silently leave it unset sometimes — never trust the create output).
//
// WORKFLOW:
//   1. Write the PR body (markdown) to docs/.output/.state/.pr-body using the Write tool
//      (no shell escaping). Or pass --body-file <path>.
//   2. Run:
//        node .claude/core/pull-request.js create --title "feat: thing"
//        node .claude/core/pull-request.js create --dry-run   # print every command, do nothing
//        node .claude/core/pull-request.js status             # current branch's PR status
//        node .claude/core/pull-request.js watch              # poll the PR's CI to a terminal state
//
// HARD GUARDRAILS (never crossed):
//   - Explicit-invocation only — NEVER auto-fires. A green build is NOT approval.
//   - Current branch as-is — never re-scopes, filters commits, or switches/creates branches.
//   - Refuses on the default branch, or when behind origin/<default> (merge first).
//   - Never passes --no-verify / skips hooks / bypasses signing.
//   - --dry-run prints every command it WOULD run and does nothing.
//
// REUSE: mirrors commit.js (body-file pattern, current-branch discipline,
// module.exports for testing, require.main guard). Thin wrapper over gh/az + git —
// no new abstraction layer.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BODY_FILE = path.join('docs', '.output', '.state', '.pr-body');

// ── External-CLI spawn (az/gh are .cmd shims on Windows) ─────────────────────
// Node >= the CVE-2024-27980 fix refuses to spawn .cmd/.bat files without a shell:
// spawnSync('az', …) returns { status: null, error: ENOENT } and explicit 'az.cmd'
// returns EINVAL. (git is a real .exe, so it was unaffected — which is why `git push`
// succeeded while every `az` step "failed exit null".) Fix: on win32 spawn through the
// shell AND quote args ourselves — `shell:true` does NOT escape (DEP0190), so an
// unquoted "a b c" would re-split into three args (mangling the PR title). POSIX keeps
// the safe array form (no shell, no quoting).
const IS_WIN = process.platform === 'win32';

/** cmd.exe-quote an arg iff it contains whitespace or shell metacharacters. */
function winQuote(a) {
  const s = String(a);
  return /[\s"&()<>|^@%!]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/** spawnSync a CLI safely across platforms. On win32: shell:true + per-arg quoting. */
function runTool(bin, args, opts = {}) {
  return IS_WIN
    ? spawnSync(bin, args.map(winQuote), { shell: true, ...opts })
    : spawnSync(bin, args, opts);
}

/** Exit with a spawn result's status. A failed spawn (status null) becomes exit 1, NOT 0 —
 *  `res.status || 0` would have masked an ENOENT as success (the old runStatus silent-pass bug). */
function exitFromSpawn(res) {
  if (res.status == null) {
    if (res.error) console.error(`[pr] command failed to launch: ${res.error.code || res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status);
}

/** runTool + capture stdout; throws a clear error (incl. spawn ENOENT) on non-zero/failed spawn. */
function captureTool(bin, args) {
  const r = runTool(bin, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    const code = r.error ? ` (${r.error.code})` : '';
    throw new Error(`${bin} ${args[0] || ''} failed${code}: ${(r.stderr || '').trim() || 'no stderr'}`);
  }
  return r.stdout;
}

// ── Pure helpers (exported for unit tests; no side effects) ──────────────────

/**
 * Parse a `git remote get-url origin` value into { host, org, project, repo }.
 * Supports GitHub (https + ssh) and Azure DevOps (dev.azure.com + legacy
 * *.visualstudio.com). Throws on an unrecognized host — we never guess.
 */
function parseRemoteUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('no origin remote URL — is this a git repo with an `origin`?');
  }
  // Strip a trailing slash BEFORE `.git` so `…/repo.git/` and `…/repo/` both
  // normalize (some clones/config emit a trailing slash), otherwise the `$`-anchored
  // host regexes fall through to the unrecognized-host throw.
  const u = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');

  // GitHub — https://github.com/<org>/<repo>  or  git@github.com:<org>/<repo>
  let m = u.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  if (m) return { host: 'github', org: m[1], project: null, repo: m[2] };

  // Azure DevOps (modern) — https://[user@]dev.azure.com/<org>/<project>/_git/<repo>
  m = u.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)$/i);
  if (m) return { host: 'azure', org: m[1], project: m[2], repo: m[3] };

  // Azure DevOps (legacy) — https://<org>.visualstudio.com/<project>/_git/<repo>
  m = u.match(/([^/.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)$/i);
  if (m) return { host: 'azure', org: m[1], project: m[2], repo: m[3] };

  throw new Error(`unrecognized git host in origin URL: ${url} (only GitHub and Azure DevOps are supported)`);
}

/** Parse argv (process.argv.slice(2)) into { sub, title, draft, dryRun, noWatch, force, bodyFile, id }. */
function parseArgs(args) {
  const has = (...flags) => flags.some((f) => args.includes(f));
  const valOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const sub = args.find((a) => !a.startsWith('-')) || null;
  const idRaw = valOf('--id');
  return {
    sub,
    title: valOf('--title'),
    draft: has('--draft'),
    dryRun: has('--dry-run', '-n'),
    noWatch: has('--no-watch'),
    force: has('--force'),
    bodyFile: valOf('--body-file') || DEFAULT_BODY_FILE,
    id: idRaw != null ? Number(idRaw) : null,
  };
}

/**
 * Build the `create` command sequence for a host. Pure — returns an ordered list
 * of { bin, args, label } so tests can assert the sequence without a network call.
 * The Azure auto-complete flags are on `create`; GitHub needs a separate
 * `gh pr merge --auto` step (its equivalent of Azure's --auto-complete).
 */
function buildCreatePlan({ host, branch, base, title, bodyFile, draft, project, repo }) {
  const push = { bin: 'git', args: ['push', '-u', 'origin', branch], label: 'push branch' };

  if (host === 'github') {
    const createArgs = ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', bodyFile];
    if (draft) createArgs.push('--draft');
    const mergeArgs = ['pr', 'merge', branch, '--auto', '--squash', '--delete-branch'];
    return [
      push,
      { bin: 'gh', args: createArgs, label: 'create PR' },
      { bin: 'gh', args: mergeArgs, label: 'enable auto-merge (squash + delete branch)' },
      { bin: 'gh', args: ['pr', 'view', branch, '--json', 'number,state,autoMergeRequest'], label: 'verify auto-merge took' },
    ];
  }

  // azure
  const createArgs = [
    'repos', 'pr', 'create',
    '--source-branch', branch,
    '--target-branch', base,
    '--title', title,
    '--description', `@${bodyFile}`,
    '--auto-complete', 'true',
    '--squash', 'true',
    '--delete-source-branch', 'true',
  ];
  if (project) createArgs.push('--project', project);
  if (repo) createArgs.push('--repository', repo);
  if (draft) createArgs.push('--draft', 'true');
  return [
    push,
    { bin: 'az', args: createArgs, label: 'create PR (auto-complete + squash + delete-source)' },
    // verify step is dynamic (needs the PR id from create output) — added at runtime.
  ];
}

// ── git seams ────────────────────────────────────────────────────────────────

function git(...a) {
  return execFileSync('git', a, { encoding: 'utf8' });
}

/** Resolve the remote default branch (origin/HEAD), falling back to 'main'. */
function defaultBranch() {
  try {
    const ref = git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD').trim();
    const name = ref.replace(/^refs\/remotes\/origin\//, '');
    if (name) return name;
  } catch { /* origin/HEAD not set — fall through */ }
  return 'main';
}

// ── Pre-flight gate ──────────────────────────────────────────────────────────

/**
 * Run the create pre-flight checks. Returns { branch, base }. Calls process.exit(1)
 * with a clear reason on any hard failure. `force` downgrades the (best-effort)
 * in-flight-CI check from abort to warn.
 */
function preflight({ force } = {}) {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  const base = defaultBranch();

  // 1. On a feature branch, not the default.
  if (branch === base || branch === 'main' || branch === 'master') {
    console.error(`[pr] refusing: HEAD is on '${branch}' (the default/protected branch). Create a feature branch first.`);
    process.exit(1);
  }

  // 2. Up to date with origin/<base>.
  try {
    git('fetch', 'origin', base);
    const behind = git('rev-list', '--count', `${branch}..origin/${base}`).trim();
    if (behind !== '0') {
      console.error(`[pr] refusing: branch is ${behind} commit(s) behind origin/${base}. Merge origin/${base} first (else the PR stalls on conflicts).`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`[pr] could not verify up-to-date with origin/${base}: ${e.message}`);
    if (!force) process.exit(1);
    console.error('[pr] --force given — proceeding despite the unverified base.');
  }

  return { branch, base };
}

// ── Subcommands ────────────────────────────────────────────────────────────

function runCreate(opts, remote) {
  const { title, draft, dryRun, bodyFile, force } = opts;

  if (!title) {
    console.error('[pr] create requires --title "<subject>".');
    process.exit(1);
  }

  // Pre-flight FIRST (its branch check is the most fundamental precondition and is
  // network-free — it runs before any fetch). Skipped under dry-run so a dry-run
  // never fetches/mutates. The body-file check follows: it's an input-validation
  // step, and the only network op preflight does (fetch) is read-only.
  let branch, base;
  if (dryRun) {
    branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    base = defaultBranch();
  } else {
    ({ branch, base } = preflight({ force }));
    if (!fs.existsSync(bodyFile)) {
      console.error(`[pr] body file not found: ${bodyFile}. Write the PR body there first (Write tool), or pass --body-file.`);
      process.exit(1);
    }
  }

  const plan = buildCreatePlan({
    host: remote.host, branch, base, title, bodyFile, draft,
    project: remote.project, repo: remote.repo,
  });

  if (dryRun) {
    console.log(`[pr] --dry-run — host: ${remote.host}, branch: ${branch} → ${base}. Would run:\n`);
    for (const step of plan) {
      console.log(`  # ${step.label}`);
      console.log(`  ${step.bin} ${step.args.join(' ')}`);
    }
    if (remote.host === 'azure') {
      console.log('  # verify auto-complete took (dynamic — needs the PR id from create)');
      console.log('  az repos pr show --id <N>   # assert autoCompleteSetBy is non-null');
    }
    console.log('\n[pr] dry-run only — nothing pushed, no PR created.');
    process.exit(0);
  }

  // ── Live path ──
  for (const step of plan) {
    console.log(`[pr] ${step.label}: ${step.bin} ${step.args.join(' ')}`);
    const res = runTool(step.bin, step.args, { stdio: 'inherit' });
    if (res.status !== 0) {
      const code = res.error ? `${res.status} (${res.error.code})` : `${res.status}`;
      console.error(`[pr] step failed (${step.label}), exit ${code}. Aborting.`);
      process.exit(res.status || 1);
    }
  }

  // Post-create verification — assert auto-merge/complete ACTUALLY took.
  verifyAutoComplete(remote, branch, base);
}

/** Re-query the PR and assert auto-merge/auto-complete is set. Loud failure if not. */
function verifyAutoComplete(remote, branch, base) {
  if (remote.host === 'github') {
    const out = captureTool('gh', ['pr', 'view', branch, '--json', 'number,state,autoMergeRequest']);
    let json;
    try { json = JSON.parse(out); } catch { json = {}; }
    if (!json.autoMergeRequest) {
      console.error('[pr] ⚠ auto-merge did NOT take (autoMergeRequest is null). Re-run: gh pr merge --auto --squash --delete-branch');
      process.exit(1);
    }
    console.log(`[pr] verified: PR #${json.number} state=${json.state}, auto-merge ENABLED.`);
    return;
  }
  // azure — find the PR for this branch, then assert autoCompleteSetBy.
  const showOut = captureTool('az', ['repos', 'pr', 'list', '--source-branch', branch, '--output', 'json']);
  let list;
  try { list = JSON.parse(showOut); } catch { list = []; }
  const arr = Array.isArray(list) ? list : [];
  // A branch can legitimately have >1 open PR (e.g. targeting two branches); pick the
  // one whose target is the base we just opened against, so we verify the RIGHT PR
  // rather than an arbitrary list[0]. Fall back to the full list when the target isn't
  // known or no row matches (older az output may omit targetRefName).
  const wantTarget = base ? `refs/heads/${String(base).replace(/^refs\/heads\//, '')}` : null;
  const matched = wantTarget ? arr.filter((p) => p && p.targetRefName === wantTarget) : [];
  const pool = matched.length ? matched : arr;
  const pr = pool.length ? pool[0] : null;
  if (!pr) {
    console.error('[pr] ⚠ could not find the created PR to verify auto-complete. Check manually.');
    process.exit(1);
  }
  if (!pr.autoCompleteSetBy) {
    console.error(`[pr] ⚠ auto-complete did NOT take on PR #${pr.pullRequestId} (autoCompleteSetBy is null). Re-set it.`);
    process.exit(1);
  }
  console.log(`[pr] verified: PR #${pr.pullRequestId} status=${pr.status}, auto-complete SET.`);
}

function runStatus(opts, remote) {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  if (remote.host === 'github') {
    const ref = opts.id ? String(opts.id) : branch;
    const res = runTool('gh', ['pr', 'view', ref, '--json', 'number,state,mergeStateStatus,autoMergeRequest,title', '--template',
      '{{.number}} {{.title}}\nstate: {{.state}}  merge: {{.mergeStateStatus}}\n'], { stdio: 'inherit' });
    exitFromSpawn(res);
  }
  // azure
  const args = opts.id
    ? ['repos', 'pr', 'show', '--id', String(opts.id), '--output', 'table']
    : ['repos', 'pr', 'list', '--source-branch', branch, '--output', 'table'];
  const res = runTool('az', args, { stdio: 'inherit' });
  exitFromSpawn(res);
}

function runWatch(opts, remote) {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  if (remote.host === 'github') {
    // gh's own --watch polls real state to a terminal status (no iteration counter).
    const ref = opts.id ? String(opts.id) : branch;
    const res = runTool('gh', ['pr', 'checks', ref, '--watch'], { stdio: 'inherit' });
    exitFromSpawn(res);
  }
  console.error('[pr] watch for Azure DevOps is not yet implemented — use: az repos pr show --id <N>');
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.sub || !['create', 'status', 'watch'].includes(opts.sub)) {
    console.error('[pr] usage: pull-request.js <create|status|watch> [--title T] [--draft] [--dry-run] [--no-watch] [--force] [--id N] [--body-file F]');
    process.exit(1);
  }

  let remote;
  try {
    const url = git('remote', 'get-url', 'origin').trim();
    remote = parseRemoteUrl(url);
  } catch (e) {
    console.error(`[pr] ${e.message}`);
    process.exit(1);
  }

  if (opts.sub === 'create') return runCreate(opts, remote);
  if (opts.sub === 'status') return runStatus(opts, remote);
  if (opts.sub === 'watch') return runWatch(opts, remote);
}

module.exports = { parseRemoteUrl, parseArgs, buildCreatePlan, defaultBranch, winQuote, runTool, main };

if (require.main === module) {
  main();
}
