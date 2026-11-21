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
//   - Secret-scans the staged files and the message once (by the managed git hooks when active, else itself).
//   - Preserves supplied message content without adding attribution.
//   - Trims trailing blank / stray-token lines (e.g. a leaked '@', quote, backtick).
//   - Commits on the CURRENT branch only — never switches or creates branches.
//   - Honors git hooks (never passes --no-verify).
//   - With --ship-check (and --sc-kind/--sc-plan/--sc-wave/--sc-todo/--sc-stories/--sc-skip), runs
//     ship-check.js verify before staging; a refusal, crash or timeout refuses with the index untouched.
//     The verdict covers the working tree and the commit takes the index, so after staging the two must
//     agree for every staged path (a mismatch restores the index and refuses), and a git location override
//     in the environment (GIT_INDEX_FILE and friends) is refused up front. An honoured --sc-skip travels in
//     the commit as a `Ship-Check-Skip: <reason>` trailer. A passing check travels as a
//     `Ship-Check: <first 12 of the seal's codeHash>` trailer, which `run-record.js finish --ship-token OK` and the
//     scoreboard look for in the commit itself (_lib/git.js).
//   - When the managed git hooks are not active it prints a refusal-level warning on stderr (the commit is still
//     scanned by commit.js itself): the secret and force-push backstop for raw git is missing, never silently.
//   - IMPROVEMENT CONFIG WALL. Refuses (exit 1, nothing committed) a staged change to `improvement.autoApply` or
//     anything under `improvement.graduation`, `improvement.watch` or `improvement.budget` in `.claude/gate.config.json`:
//     the switch, the thresholds that decide whether an unattended cycle may apply or keep a skill change, and the
//     cycle's spending caps are owner-only, and `readGateConfig` reads them from HEAD, so
//     an agent that can commit them can turn the wall off. The old and new values are compared as parsed JSON (a
//     whitespace or key-order edit, or any other key, never trips it); a staged file that is not a JSON object is refused
//     too. The owner override is AGENTS_ALLOW_IMPROVEMENT_CONFIG=1 on the commit.js run itself; the Bash guardrail refuses a
//     command that sets it, and the override is recorded as a 'bypass' guardrail event. Only commit.js runs this check: a
//     raw `git commit` runs the managed hooks, which scan for secrets and nothing else.
//
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { git, gitOk, SHIP_CHECK_KEY, shipCheckValue } = require('./_lib/git');
const { assertNoSymlinkedAncestor } = require('./_lib/fs-safe');
const { getJsonlPath } = require('./_lib/telemetry-paths');

const SC_OPTIONS = [
  ['--sc-kind', 'kind'], ['--sc-plan', 'plan'], ['--sc-wave', 'wave'],
  ['--sc-todo', 'todo'], ['--sc-stories', 'stories'], ['--sc-skip', 'skip'],
];
const SHIP_CHECK_TIMEOUT_MS = 300000;
// Git location overrides redirect which index / repository git reads and writes. The judge and the committer
// must look at the same ones, so --ship-check refuses to start when any is set.
const GIT_LOCATION_VARS = [
  'GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR',
];
// Variables the ship-check child must not inherit: Node preloads and module paths (NODE_*), every git
// override (GIT_*), and the state-root overrides that redirect where the audit event lands.
const CHILD_ENV_SCRUB = /^(?:NODE_|GIT_|AGENT_SHARED_STATE_ROOT$|AGENTS_PROJECT_DIR$|AGENT_SOURCE_ROOT$|CODEX_PROJECT_DIR$)/i;
const SKIP_TRAILER_MAX = 500;
// The improvement config wall (see the header). The gate configs the improvement cycle reads, and the keys under
// `improvement` it must not see an agent change. Today only `.claude/gate.config.json` is read (skill-evolution.js,
// ship-check.js and gate.js all name that path); a second location is one more entry here.
const IMPROVEMENT_CONFIG_FILES = ['.claude/gate.config.json'];
const IMPROVEMENT_GUARDED_KEYS = ['autoApply', 'graduation', 'watch', 'budget'];
const IMPROVEMENT_OVERRIDE_ENV = 'AGENTS_ALLOW_IMPROVEMENT_CONFIG';

// Parse argv into the flags/options the rest of the flow consumes. Pure: takes the
// already-sliced argv array (process.argv.slice(2)) so it can be tested directly.
function parseArgs(args) {
  // The --sc-* pairs are parsed out FIRST so that no value is ever re-read as one of commit.js's own flags
  // (`--sc-skip -a` must not stage everything). A value may not start with '-', and a flag may not repeat.
  const sc = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const opt = SC_OPTIONS.find(([flag]) => flag === args[i]);
    if (!opt) { rest.push(args[i]); continue; }
    const [flag, key] = opt;
    if (Object.prototype.hasOwnProperty.call(sc, key)) throw new Error(`${flag} was given more than once`);
    const value = args[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (value.startsWith('-')) throw new Error(`${flag} needs a value that does not start with "-" (got ${JSON.stringify(value)})`);
    sc[key] = value;
    i++;
  }
  args = rest;

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

  // --ship-check (SF-1.4): run ship-check.js verify before anything is staged. The --sc-* options
  // (collected above) carry its arguments.
  const shipCheck = has('--ship-check');
  if (!shipCheck && Object.keys(sc).length) {
    throw new Error(`${Object.keys(sc).map((k) => `--sc-${k}`).join(', ')} only apply with --ship-check`);
  }
  if (sc.kind !== undefined && sc.kind !== 'wave' && sc.kind !== 'task') {
    throw new Error('--sc-kind must be wave|task');
  }

  return { stageAll, amend, dryRun, fileIdx, msgFile, inlineMsg, noScan, paths, shipCheck, sc };
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

// Run the secret-scan gate.
//
// Two layers share one engine and one fail-closed contract:
//   1. The toolkit-managed git hooks (installed by git-hooks.js into the git directory, never tracked) scan a
//      raw `git commit -F` from a terminal too: pre-commit + commit-msg for commits, pre-merge-commit for merges,
//      pre-applypatch for `git am`, and pre-push for every commit a push would publish, whatever wrote it.
//      When they are installed, current and active, they ARE the scan: commit.js skips its own so the
//      staged files and the message are scanned once, not twice.
//   2. Otherwise (hooks not installed, outdated, or shadowed by a foreign core.hooksPath) commit.js scans
//      itself, exactly as it always did: secret-scanner.cjs over the staged set, then the message.
//
// FAIL CLOSED: a scanner that is missing from disk blocks the commit (it used to warn and
// commit unscanned). The scanner itself blocks when its engine is missing or broken.
//
// Bypass (rare — a reviewed false positive that cannot take a betterleaks:allow comment):
// --no-scan, or CLAUDE_COMMIT_NO_SCAN=1. A bypass is recorded as its own guardrail event
// (decision 'bypass') so the feedback digest can show how often the gate is skipped. The bypass reaches
// the hooks through the child's environment (see bypassEnv). With active hooks THEY record the event (once per
// commit); commit.js records it only when no managed hook will run.
function recordScanBypass() {
  try {
    return appendAuditEvent({
      event: 'guardrail', decision: 'bypass', rule: 'commit-no-scan', tier: null, source: 'secret-scanner', pathClass: null,
      reason: scanBypassReason(), timestamp: new Date().toISOString(),
    });
  } catch {
    return false; // telemetry is best effort and never blocks the commit
  }
}

// Which switch asked for the bypass, so the audit line says why the scan did not run.
function scanBypassReason() {
  return process.argv.slice(2).includes('--no-scan') ? 'flag --no-scan' : 'env CLAUDE_COMMIT_NO_SCAN=1';
}

// Git location overrides currently set in the environment (names only).
function gitLocationOverrides(env = process.env) {
  return GIT_LOCATION_VARS.filter((name) => env[name] !== undefined && env[name] !== '');
}

// The repository root the audit event belongs to, resolved by git from the working directory and never from
// an environment override (AGENT_SHARED_STATE_ROOT and friends redirect where telemetry lands, which is
// exactly how an audit line is lost). A linked worktree shares the main checkout's state zone, as the
// telemetry helpers do. Returns null when it cannot be verified: not a git checkout, or a git location
// override is set (then the repository git acts on is not the one the working directory names).
function verifiedAuditRoot() {
  if (gitLocationOverrides().length) return null;
  const top = git(['rev-parse', '--show-toplevel']);
  if (!top) return null;
  try {
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (common && path.basename(common) === '.git') return path.dirname(common);
  } catch { /* an old git without --path-format: the toplevel is the root */ }
  return top;
}

// Where the audit event goes, and whether that place is safe to write: the events file under the verified
// root, with no symlinked ancestor and a leaf that is absent or a regular file (a link to /dev/null swallows
// every event while the write "succeeds"). `{ file, root }`, or `{ error }` naming why not.
function auditSink() {
  try {
    const root = verifiedAuditRoot();
    if (!root) return { error: 'the repository could not be verified (not a git checkout, or a git location override is set)' };
    const file = getJsonlPath(root, 'guardrail-events.jsonl');
    assertNoSymlinkedAncestor(file, root);
    const leaf = fs.lstatSync(file, { throwIfNoEntry: false });
    if (leaf && !leaf.isFile()) return { error: `${file} is not a regular file (a symbolic link?)` };
    return { file, root };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e).split('\n')[0] };
  }
}

// Append one audit line to <verified root>/docs/.output/.state/telemetry/guardrail-events.jsonl, opened
// O_NOFOLLOW so a swap after the sink check cannot redirect it. Returns true only when the line was written;
// never throws.
function appendAuditEvent(entry) {
  try {
    const sink = auditSink();
    if (sink.error) return false;
    fs.mkdirSync(path.dirname(sink.file), { recursive: true });
    assertNoSymlinkedAncestor(sink.file, sink.root);
    const fd = fs.openSync(sink.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o644);
    try {
      fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

// The environment the child `git commit` runs with. A bypass must also skip the managed hooks, and they honor
// CLAUDE_COMMIT_NO_SCAN=1. Nothing else is passed: whether the hooks record the event is decided from files in
// the git dir, never from a flag the environment could set.
function bypassEnv(noScan) {
  return noScan ? { ...process.env, CLAUDE_COMMIT_NO_SCAN: '1' } : process.env;
}

// Are the managed hooks the ones git will actually run for this commit? Any doubt answers no, so commit.js
// scans itself.
function managedHooksActive() {
  try {
    return require('./git-hooks').isActive(process.cwd());
  } catch {
    return false;
  }
}

// The commit message is content too: a key pasted into "fix: rotate <key>" lands in history and, after a
// push, on the remote. It goes through the same engine as the staged files and fails closed the same way.
// The scan itself is shared with the managed commit-msg hook (secret-scanner.cjs scanCommitMessage).
function scanMessage(message) {
  const { scanCommitMessage } = require('../hooks/secret-scanner.cjs');
  const { formatFindings, installHint } = require('../hooks/secret-patterns.cjs');
  const result = scanCommitMessage(message);
  if (result.status === 'engine-error') {
    const err = result.error;
    console.error(`[commit] ABORT: the secret engine could not scan the commit message (${err.message}). ${err.code === 'ENGINE_UNAVAILABLE' ? installHint() : ''}`);
    process.exit(1);
  }
  if (result.status === 'findings') {
    console.error(formatFindings(result.findings));
    console.error('[commit] ABORT: the commit message contains what looks like a secret. Remove it and re-run.');
    process.exit(1);
  }
}

function runScan(noScan, message) {
  if (noScan) {
    if (managedHooksActive()) {
      // The hooks see CLAUDE_COMMIT_NO_SCAN=1 and record the event themselves, once; commit.js adds none.
      console.warn('[commit] WARNING: secret scan bypassed (--no-scan / CLAUDE_COMMIT_NO_SCAN=1). The managed git hooks record the bypass.');
    } else {
      console.warn(recordScanBypass()
        ? '[commit] WARNING: secret scan bypassed (--no-scan / CLAUDE_COMMIT_NO_SCAN=1). Recorded in guardrail-events.jsonl.'
        : '[commit] WARNING: secret scan bypassed (--no-scan / CLAUDE_COMMIT_NO_SCAN=1). NOT recorded: guardrail-events.jsonl could not be written.');
    }
    return;
  }
  if (managedHooksActive()) {
    console.log('[commit] secret scan: handled by the managed git hooks (pre-commit scans the staged files, commit-msg the message).');
    return;
  }
  const scanner = path.join(__dirname, '..', 'hooks', 'secret-scanner.cjs');
  if (!fs.existsSync(scanner)) {
    console.error(`[commit] ABORT: secret scanner not found at ${scanner}. Refusing to commit without a secret scan (restore it, or pass --no-scan if you accept that).`);
    process.exit(1);
  }
  const scan = spawnSync(process.execPath, [scanner, '--git-precommit'], { stdio: 'inherit', windowsHide: true });
  if (scan.error) {
    console.error(`[commit] ABORT: could not run the secret scanner (${scan.error.message}).`);
    process.exit(1);
  }
  if (scan.status !== 0) {
    console.error('[commit] secret scan blocked the commit. Remove the secret, add a betterleaks:allow comment to a reviewed false positive, or (last resort) --no-scan / CLAUDE_COMMIT_NO_SCAN=1.');
    process.exit(scan.status || 1);
  }
  if (typeof message === 'string' && message.trim()) scanMessage(message);
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

// The core directory the fix hint names: the runtime this file was installed into (.claude/core or
// .codex/core). The authored copy under .agents/core falls back to AGENTS_RUNTIME, as ship-check does.
function runtimeCoreDir(dirname = __dirname, env = process.env) {
  const parent = path.basename(path.dirname(dirname));
  if (parent === '.claude' || parent === '.codex') return `${parent}/core`;
  return `${env.AGENTS_RUNTIME === 'codex' ? '.codex' : '.claude'}/core`;
}

// The environment the ship-check child runs with: the caller's, minus Node preloads, git overrides and the
// state-root overrides, with the project pinned to the verified root. AGENTS_RUNTIME is kept as given.
function shipCheckEnv(root, env = process.env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (!CHILD_ENV_SCRUB.test(name) && name.toUpperCase() !== 'CLAUDE_PROJECT_DIR') out[name] = value;
  }
  out.CLAUDE_PROJECT_DIR = root;
  return out;
}

// The repository top-level, or the working directory outside a checkout.
function repoRoot() {
  try { return git(['rev-parse', '--show-toplevel']); } catch { return process.cwd(); }
}

// The seal's code hash from the verdict document ship-check.js verify printed on stdout, or null when it carries none
// (an audited skip or a disabled check has no seal).
function sealedCodeHash(stdout) {
  try {
    const verdict = JSON.parse(stdout);
    const hash = verdict && verdict.seal ? verdict.seal.codeHash : null;
    return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

// Say, on stderr and unmistakably, that the managed git hooks are not active in this checkout. Never blocks the
// commit (commit.js scans for itself when the hooks are absent); a failure to find out is reported, not swallowed.
function warnHooksMissing() {
  try {
    const lines = require('./git-hooks').backstopWarning(process.cwd(), { who: 'commit', coreDir: runtimeCoreDir() });
    if (lines) for (const line of lines) console.error(line);
  } catch (e) {
    console.error(`[commit] WARNING: could not check whether the managed git hooks are active (${String(e && e.message ? e.message : e).split('\n')[0]}). Treat the secret and force-push backstop as missing.`);
  }
}

// Spawn ship-check.js verify (the judge, in its own process so a crash or a hang cannot take the
// commit with it). Anything but exit 0 refuses: exit 1, nothing staged. A pass returns the 12-character
// `Ship-Check` trailer value (the seal's code hash), or null when the verdict carries no seal.
function runShipCheck(sc) {
  const overrides = gitLocationOverrides();
  if (overrides.length) {
    console.error(`[commit] ship check refused: ${overrides.join(', ')} ${overrides.length === 1 ? 'is' : 'are'} set. The verdict covers the working tree and the commit takes the index, so the judge and the committer must use the same repository and index. Unset ${overrides.length === 1 ? 'it' : 'them'} and run again (nothing staged).`);
    process.exit(1);
  }
  // An honoured skip is an audited bypass. The judge writes the event, but a sink that swallows it (a symlinked
  // events file) or sits outside the repository would make the bypass silent: refuse before the judge runs.
  if (sc.skip !== undefined) {
    const sink = auditSink();
    if (sink.error) {
      console.error(`[commit] ship check refused: the skip cannot be audited (${sink.error}). Fix the events file under docs/.output/.state/telemetry/, or run the gate and seal instead (nothing staged).`);
      process.exit(1);
    }
  }
  const root = repoRoot();
  const argv = [path.join(__dirname, 'ship-check.js'), 'verify', '--kind', sc.kind || 'wave'];
  // The child runs from the repository root; a relative plan/todo names a file relative to the CALLER's directory.
  if (sc.plan !== undefined) argv.push('--plan', path.resolve(process.cwd(), sc.plan));
  if (sc.wave !== undefined) argv.push('--wave', sc.wave);
  if (sc.todo !== undefined) argv.push('--todo', path.resolve(process.cwd(), sc.todo));
  if (sc.stories !== undefined) argv.push('--stories', sc.stories);
  if (sc.skip !== undefined) argv.push('--skip', sc.skip);
  const envTimeout = Number(process.env.COMMIT_SHIP_CHECK_TIMEOUT_MS);
  const timeout = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : SHIP_CHECK_TIMEOUT_MS;
  let res;
  try {
    res = spawnSync(process.execPath, argv, {
      cwd: root, encoding: 'utf8', timeout, windowsHide: true,
      env: shipCheckEnv(root),
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    res = { status: null, error: e, stdout: '', stderr: '' };
  }
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (res.status === 0) {
    console.log('[commit] ship check passed');
    if (out) console.log(out);
    const codeHash = sealedCodeHash(res.stdout || '');
    if (codeHash === null && sc.skip === undefined) {
      console.error(`[commit] WARNING: the ship check passed but its verdict carries no seal (the check is disabled in the gate config), so no ${SHIP_CHECK_KEY} trailer is written and \`run-record.js finish --ship-token OK\` will refuse this commit.`);
    }
    return codeHash === null ? null : shipCheckValue(codeHash);
  }
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  console.error(timedOut
    ? `[commit] ship check refused: the ship check timed out after ${timeout} ms (nothing staged)`
    : `[commit] ship check refused (exit ${res.status === null ? (res.signal || 'error') : res.status}; nothing staged)`);
  if (out) console.error(out);
  if (res.error && !timedOut) console.error(`[commit] ${res.error.message}`);
  console.error(`[commit] Fix: run the gate, \`node ${runtimeCoreDir()}/ship-check.js seal\`, then commit again; or pass --sc-skip "<reason>" for an audited bypass.`);
  process.exit(1);
}

// The staged paths whose index content differs from the working tree: modified or deleted after staging
// (`git diff` against the index), plus staged deletions whose file is back on disk (untracked, so `git diff`
// cannot see it). The ship-check verdict hashes the working tree, so every staged path must be the same bytes
// in both places for the verdict to describe what a commit would take.
function stagedPathsDifferingFromWorktree(root) {
  const nul = (out) => out.split('\0').filter(Boolean);
  const staged = new Set(nul(git(['diff', '--cached', '--name-only', '--no-renames', '-z'], { raw: true })));
  const differing = nul(git(['diff', '--name-only', '--no-renames', '-z'], { raw: true })).filter((p) => staged.has(p));
  const removed = nul(git(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=D', '-z'], { raw: true }));
  for (const p of removed) {
    if (fs.lstatSync(path.join(root, p), { throwIfNoEntry: false })) differing.push(p);
  }
  return [...new Set(differing)];
}

// After staging, under --ship-check: refuse when the index and the working tree disagree on a staged path, and
// restore the index exactly as it was before commit.js staged anything (the tree captured up front).
function assertStagedMatchesWorktree(preTree) {
  let differing;
  try {
    differing = stagedPathsDifferingFromWorktree(repoRoot());
  } catch (e) {
    differing = null;
    console.error(`[commit] ship check refused: could not compare the staged content with the working tree (${e.message.split('\n')[0]}).`);
  }
  if (differing && !differing.length) return;
  if (differing) {
    console.error('[commit] ship check refused: staged content differs from the working tree for:');
    for (const p of differing.slice(0, 20)) console.error(`  ${p}`);
    if (differing.length > 20) console.error(`  ... and ${differing.length - 20} more`);
    console.error('[commit] The ship check judged the working tree; a commit takes the index. Re-stage (or restore) those paths, run the gate and `ship-check.js seal` again, then commit.');
  }
  try {
    git(['read-tree', preTree]);
    console.error('[commit] the index was restored to its state before this run.');
  } catch (e) {
    console.error(`[commit] WARNING: could not restore the index to ${preTree} (${e.message.split('\n')[0]}). Inspect \`git status\` before committing.`);
  }
  process.exit(1);
}

function assertStagedMatchesSeal(preTree) {
  let verdict;
  try {
    verdict = require('./ship-check').stagedMatchesSeal(repoRoot());
  } catch (e) {
    verdict = { ok: false, reason: e.message.split('\n')[0] };
  }
  if (verdict && verdict.ok) return;
  console.error(`[commit] ship check refused after staging: ${verdict ? verdict.reason : 'no verdict'}. Run the gate and \`ship-check.js seal\` again, then commit.`);
  try {
    git(['read-tree', preTree]);
    console.error('[commit] the index was restored to its state before this run.');
  } catch (e) {
    console.error(`[commit] WARNING: could not restore the index to ${preTree} (${e.message.split('\n')[0]}). Inspect \`git status\` before committing.`);
  }
  process.exit(1);
}

// One line, no control characters, bounded: a skip reason that rides into the commit message.
function sanitizeTrailerValue(value) {
  return String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SKIP_TRAILER_MAX);
}

// Append a `Key: value` trailer to a commit message (one trailing newline kept). It joins the last paragraph
// when that paragraph is already all trailers, else it starts its own paragraph, so git reads it as a trailer.
function withTrailer(message, key, value) {
  const body = message.replace(/\s+$/, '');
  const paragraphs = body.split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1].split('\n');
  const isTrailerBlock = paragraphs.length > 1 && last.every((line) => /^[A-Za-z][A-Za-z0-9-]*: \S/.test(line));
  return `${body}${isTrailerBlock ? '\n' : '\n\n'}${key}: ${value}\n`;
}

// ── the improvement config wall ──────────────────────────────────────────────

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// JSON.stringify with every object's keys sorted, so two parsed values compare equal exactly when they hold the
// same data, whatever order the file wrote its keys in.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The blob a path holds in HEAD (side 'head') or in the index (side 'index'), read by object id so no filter or
// working-tree state can differ from what the commit takes. { state: 'absent' }, { state: 'blob', oid, text }, or
// { state: 'error', reason } for what cannot be read as a file (a submodule, an unmerged entry, an unreadable object).
function readGuardedBlob(root, rel, side) {
  const where = side === 'head' ? 'HEAD' : 'the index';
  try {
    let entries;
    if (side === 'head') {
      if (!gitOk(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: root })) return { state: 'absent' }; // unborn branch
      entries = git(['ls-tree', '-z', 'HEAD', '--', rel], { cwd: root, raw: true }).split('\0').filter(Boolean);
    } else {
      entries = git(['ls-files', '-s', '-z', '--', rel], { cwd: root, raw: true }).split('\0').filter(Boolean);
    }
    if (entries.length === 0) return { state: 'absent' };
    if (entries.length > 1) return { state: 'error', reason: `${rel} has ${entries.length} entries in ${where} (an unmerged path?)` };
    // ls-tree prints "<mode> <type> <oid>\t<path>", ls-files -s prints "<mode> <oid> <stage>\t<path>".
    const match = side === 'head'
      ? /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t/.exec(entries[0])
      : /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t/.exec(entries[0]);
    if (!match) return { state: 'error', reason: `${rel} has an entry in ${where} that this check cannot read` };
    const mode = match[1];
    const oid = side === 'head' ? match[3] : match[2];
    const kind = side === 'head' ? match[2] : 'blob';
    const stage = side === 'head' ? '0' : match[3];
    if (stage !== '0') return { state: 'error', reason: `${rel} is unmerged in ${where}` };
    if (kind !== 'blob' || mode === '160000') return { state: 'error', reason: `${rel} is not a regular file in ${where}` };
    return { state: 'blob', oid, text: git(['cat-file', 'blob', oid], { cwd: root, raw: true }) };
  } catch (e) {
    return { state: 'error', reason: `${rel} could not be read from ${where} (${String(e && e.message ? e.message : e).split('\n')[0]})` };
  }
}

// The guarded values of one gate config blob, canonicalised: { values: { autoApply, graduation, watch, budget } } (undefined where
// the key is absent), or { error } when the text is not a JSON object. An absent file holds nothing.
function guardedImprovementValues(blob) {
  if (blob.state === 'absent') return { values: Object.fromEntries(IMPROVEMENT_GUARDED_KEYS.map((key) => [key, undefined])) };
  let parsed;
  try {
    parsed = JSON.parse(blob.text);
  } catch (e) {
    return { error: `it is not valid JSON (${e.message})` };
  }
  if (!isPlainObject(parsed)) return { error: 'it does not hold a JSON object' };
  const improvement = isPlainObject(parsed.improvement) ? parsed.improvement : {};
  return { values: Object.fromEntries(IMPROVEMENT_GUARDED_KEYS.map((key) => [key, improvement[key] === undefined ? undefined : stableJson(improvement[key])])) };
}

// What the staged index changes in the guarded config files against HEAD: { changes: ['<file>: improvement.<key>', ...],
// problems: ['<why a file could not be judged>', ...] }. A file whose blob is the same in both is not read at all, so
// an unchanged (even malformed) config never trips it. HEAD is the base for an --amend too: the wall is about what
// the commit adds to the history `readGateConfig` reads.
function improvementConfigChanges(root) {
  const changes = [];
  const problems = [];
  for (const rel of IMPROVEMENT_CONFIG_FILES) {
    const before = readGuardedBlob(root, rel, 'head');
    const after = readGuardedBlob(root, rel, 'index');
    if (after.state === 'error') { problems.push(after.reason); continue; }
    if (before.state === 'error') { problems.push(before.reason); continue; }
    if (before.state === after.state && before.oid === after.oid) continue;
    const next = guardedImprovementValues(after);
    if (next.error) { problems.push(`${rel} is staged but ${next.error}, so a change to a guarded improvement key (${IMPROVEMENT_GUARDED_KEYS.join(', ')}) cannot be ruled out`); continue; }
    // A HEAD blob that does not parse already fails readGateConfig closed; reading it as holding nothing means a staged
    // fix that sets a guarded key is still refused, and one that sets none is not.
    const prior = guardedImprovementValues(before);
    const prev = prior.values || guardedImprovementValues({ state: 'absent' }).values;
    for (const key of IMPROVEMENT_GUARDED_KEYS) {
      if (prev[key] !== next.values[key]) changes.push(`${rel}: improvement.${key}`);
    }
  }
  return { changes, problems };
}

// Refuse (exit 1, nothing committed, the index left as the caller staged it) a staged change to the improvement
// config, unless the owner set AGENTS_ALLOW_IMPROVEMENT_CONFIG=1 for this run; an honoured override is recorded.
function assertImprovementConfigUnchanged(root = repoRoot()) {
  const { changes, problems } = improvementConfigChanges(root);
  if (!changes.length && !problems.length) return;
  if (process.env[IMPROVEMENT_OVERRIDE_ENV] === '1') {
    const what = [...changes, ...problems].join('; ');
    const recorded = appendAuditEvent({
      event: 'guardrail', decision: 'bypass', rule: 'commit-improvement-config', tier: null, source: 'commit.js', pathClass: null,
      reason: `env ${IMPROVEMENT_OVERRIDE_ENV}=1: ${what}`.slice(0, 500), timestamp: new Date().toISOString(),
    });
    console.warn(`[commit] WARNING: the improvement config change was allowed by ${IMPROVEMENT_OVERRIDE_ENV}=1 (${what}). ${recorded ? 'Recorded in guardrail-events.jsonl.' : 'NOT recorded: guardrail-events.jsonl could not be written.'}`);
    return;
  }
  console.error(changes.length
    ? `[commit] ABORT: the staged change edits the self-improvement switches (${changes.join(', ')}). They decide whether an unattended cycle may apply a skill change without a human merge, so only the repository owner changes them; nothing was committed.`
    : `[commit] ABORT: the staged self-improvement config cannot be checked (${problems.join('; ')}); nothing was committed.`);
  if (changes.length && problems.length) console.error(`[commit] Also: ${problems.join('; ')}.`);
  const files = IMPROVEMENT_CONFIG_FILES.join(' ');
  console.error(`[commit] Fix: unstage it (git restore --staged ${files}) and commit the rest; the repository owner who means the change runs ${IMPROVEMENT_OVERRIDE_ENV}=1 node ${runtimeCoreDir()}/commit.js ... on the commit itself.`);
  process.exit(1);
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

  warnHooksMissing();

  const lines = readMessage(inlineMsg, msgFile);
  let finalMsg = `${lines.join('\n').replace(/\s+$/, '')}\n`;

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

  // The ship check runs after the message is read and before anything is staged, so a refusal
  // leaves the index exactly as it was. --no-scan and CLAUDE_COMMIT_NO_SCAN do not touch it.
  const shipValue = parsed.shipCheck ? runShipCheck(parsed.sc) : null;

  // An honoured --sc-skip travels with the commit it enabled as a `Ship-Check-Skip: <reason>` trailer, so the
  // audit survives the loss of the state zone. A passing check travels as `Ship-Check: <seal codeHash, first 12>`.
  // Written back to the message file too (-F reads it), and before the dry-run print so the preview is exact.
  if (parsed.shipCheck && parsed.sc.skip !== undefined) {
    finalMsg = withTrailer(finalMsg, 'Ship-Check-Skip', sanitizeTrailerValue(parsed.sc.skip));
    if (!inlineMsg) fs.writeFileSync(msgFile, finalMsg, 'utf8');
  } else if (shipValue) {
    finalMsg = withTrailer(finalMsg, SHIP_CHECK_KEY, shipValue);
    if (!inlineMsg) fs.writeFileSync(msgFile, finalMsg, 'utf8');
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

  // Under --ship-check the index as it is now is what a refusal after staging must restore. write-tree reifies
  // it without mutating it (an unborn branch gives the empty tree); when it cannot be captured (unmerged
  // entries) nothing could be restored, so refuse before staging anything.
  let preTree = null;
  if (parsed.shipCheck) {
    try {
      preTree = git(['write-tree']);
    } catch (e) {
      console.error(`[commit] ship check refused: could not snapshot the index before staging (${e.message.split('\n')[0]}). Resolve it first (nothing staged).`);
      process.exit(1);
    }
  }

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

  // The verdict covers the working tree and the commit takes the index: they must agree on every staged path.
  if (parsed.shipCheck) assertStagedMatchesWorktree(preTree);
  // ...and the staged code must still be the sealed code: closes the window between the verdict and `git add`.
  if (parsed.shipCheck && parsed.sc.skip === undefined) assertStagedMatchesSeal(preTree);

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

  // The improvement config wall reads the index between the tree capture above and the tree re-check below, so a
  // concurrent `git add` after the check changes the tree and aborts the commit instead of riding past it.
  assertImprovementConfigUnchanged();

  runScan(noScan, finalMsg);

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
  const res = spawnSync('git', commitArgs, { stdio: 'inherit', windowsHide: true, env: bypassEnv(noScan) });
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

module.exports = {
  parseArgs, readMessage, runScan, runShipCheck, main, currentBranch, bypassEnv, managedHooksActive,
  runtimeCoreDir, shipCheckEnv, gitLocationOverrides, withTrailer, sanitizeTrailerValue, appendAuditEvent,
  stagedPathsDifferingFromWorktree, assertStagedMatchesWorktree, sealedCodeHash, warnHooksMissing,
  improvementConfigChanges, assertImprovementConfigUnchanged, IMPROVEMENT_OVERRIDE_ENV, IMPROVEMENT_CONFIG_FILES,
};
