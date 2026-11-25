// SF-4.9 — apply helper and the side-door policy (deep tier: an agent changes prompts, so the helper
// must restore on every failure and never reach a remote). Written first (TDD), then hardened against the wave L1
// review and security audit (byte-exact restore, a narrow typo class, base-commit pinned text, evaluation binding,
// the documented workspace flow, a post-gate tolerance that matches what the gate writes).
//
// PINNED CONTRACT (the implementer must match these names; the AC names no export, so they are fixed here)
//
//   Module: .agents/core/_lib/skill-apply.js  (zero-dependency CommonJS, `require.main`-guarded CLI,
//   child processes by argv array with windowsHide, never a shell, never a git push/fetch/pull/remote/commit)
//
//   Exports
//     EXIT_OK = 0, EXIT_FAILED = 1, EXIT_INVALID = 2
//     classifyEdit(before, after, {pinnedTexts?: string[], exists?: (pointer) => boolean})
//                  -> {class: 'noop'|'exempt'|'behavior', kinds: string[], reason: string}
//         NEVER throws (a non-string input is `behavior`). `kinds` (sorted, unique; set when exempt) is any of
//         'typo' | 'stale-pointer' | 'pinned-text'. Lines compare one-to-one:
//           - a different line count is `behavior`; identical text is `noop`;
//           - a changed line inside a fenced code block (``` or ~~~, the fence lines included) or inside the
//             YAML frontmatter is `behavior`;
//           - pinned-text: `isPinned(newLine.trim(), path)` (a lookup the CALLER OF THE PURE FUNCTION supplies; the apply
//             helper answers it only from the base commit: a tracked test or the file's own history) says yes, AND old and
//             new are equal after lowercasing and dropping every non-alphanumeric character, AND neither line holds a
//             `<`, `>`, `|`, backtick, `@` or `--` (structure, never prose); no lookup means no pinned-text;
//           - otherwise tokens (split on whitespace) must be equal in number and every changed token pair must be
//             a typo (both purely alphabetic after stripping surrounding punctuation, both >= 5 letters, the same first
//             letter, ONE edit apart, neither a guard word (no never always only must should may might cannot shall) nor
//             a known antonym or negation pair (skip/ship reuse/refuse enable/unable accept/except ...); the OLD word
//             must not occur in the corpus (`wordCount(lowerWord)`) except in the places the delta fixes, and the NEW word
//             must occur there at least twice; no `wordCount` means no typo) or a stale-pointer (both path-like, i.e.
//             contain `/` or end .md/.js/.cjs/.mjs/.json/.yaml/.yml, after stripping surrounding punctuation and backticks;
//             `exists(old)` is false and `exists(new)` is true; with no `exists` option it is `behavior`);
//           - a changed line whose tokens are all equal after punctuation stripping is `behavior` unless pinned-text
//             matched; anything else is `behavior` (fail closed).
//     classifyChange([{path, before, after}], opts) -> {class, kinds, files: [{path, class, kinds, reason}]}
//         NEVER throws. A file with before === null or after === null (added / deleted) is `behavior`. Overall
//         `behavior` if any file is, else `exempt` if any is, else `noop`. A non-array or a malformed entry is
//         `behavior`.
//     apply(options) -> result            (synchronous; NEVER throws; the same object the CLI prints)
//     runCli(argv, {root?}) -> exit code  (argv[0] is the verb, prints exactly one JSON object on stdout)
//
//   CLI (the same through `node skill-evolution.js apply ...`, root from CLAUDE_PROJECT_DIR):
//     node skill-apply.js apply <skill> --run <workspace> [--mode propose|apply] [--branch auto/<name>]
//          [--route verdict|side-door] [--iteration <dir>] [--holdout <dir>] [--min-replicates <n>]
//          [--candidate-sha256 <hex64>] [--root <dir>]     (the hash is mandatory with --mode apply; `--pinned` is gone)
//     node skill-apply.js bind --run <workspace> [--iteration <dir>]      (records what the iteration graded)
//     Exit 0 ok (proposed, applied or bound) | 1 refused or failed (state restored or untouched) | 2 invalid input
//     (a missing/unknown flag value, a bad skill or branch name, a missing run/snapshot/candidate/iteration or
//     unparseable benchmark.json, an unknown skill directory, an empty candidate).
//     Workspace (`--run`): `skill-snapshot/` (the old canonical skill dir), `candidate/` (or the legacy
//     `skill-candidate/`; an OVERLAY copied onto `.agents/skills/<skill>/`, nothing is deleted) and
//     `iteration-<N>/` (+ `holdout/iteration-<N>/`); the verdict runs on the highest-numbered `iteration-<N>` and on
//     nothing else (`--iteration` and `--holdout` may only name those directories). The verdict route needs
//     `iteration-<N>/binding.json` ({candidateSha256, snapshotSha256}, written by `bind`) to equal the live candidate and
//     snapshot, and an accept with no held-out iteration is low power (proposed, never applied). `--mode` defaults to propose (nothing is written, no branch);
//     `--mode apply` needs `--branch auto/<name>` (a local branch the helper creates; Owner Decisions 12 and 15)
//     and a clean working tree. `--route verdict` (default) needs a fresh `skill-eval verdict` accept (a `lowPower`
//     accept is proposed, never applied); `--route side-door` needs no verdict but the CODE must classify the whole
//     delta `exempt` (the caller cannot assert it).
//
//   stdout JSON: {ok, mode, route, skill, applied, restored, failedStep?, reason?, branch?, base?, files?,
//     snapshotSha256?, canonicalSha256?, candidateSha256?, verdict?, lowPower?, lowPowerReasons?, violations?, kinds?}
//     failedStep is one of: input | dirty-tree | branch | verdict | lowpower | candidate-hash | drift | scope |
//     side-door | copy | render | render-check | conformance | gate | restore. `files` is the repo-relative,
//     forward-slash, sorted list the caller stages (propose: the files the candidate would write; apply: exactly
//     what `git status --porcelain` reports). `restored` is true iff a mutation happened and was reversed.
//     `snapshotSha256 === canonicalSha256` (64 hex) when the snapshot still matches the live skill.
//
//   Apply pipeline (a failure at any step restores the tree to the pre-apply state, deletes the branch the run
//   created, switches back to the original branch and exits 1; it never stages and never commits):
//     validate input (exit 2) -> tracked-file flags -> clean tree -> base = `git rev-parse HEAD` (full sha) -> TRUSTED COPY of `_lib` from
//     the base commit (extracted outside the repo, removed afterwards; a scope failure at this point, such as no
//     rules in the base commit, is `scope`) -> `node <copy>/improvement-scope.js snapshot --base <sha> --root <root>
//     --out <file outside the repo>` BEFORE any change -> candidate-hash pin + evaluation binding -> drift (snapshot vs live) -> scope of
//     the candidate paths -> (route verdict: verdict, then lowpower | route side-door: classification) -> byte ledger -> branch ->
//     copy -> `node <copy>/improvement-scope.js check --base <sha> --target <skill> --root <root> --baseline <file>`
//     (before render) -> `render-shared-agents.js` -> `render-shared-agents.js --check` ->
//     `skill-evolution.js check <skill> .agents/skills/<skill>/SKILL.md` -> `gate.js test` -> a final scope check
//     that refuses every changed path except the render outputs, the gate receipt, the receipt history and appended
//     failure-ledger rows.
//     So a protected candidate path reports `scope` on either route. `files` sort by code-unit order (default
//     Array#sort). The helper scripts are `<root>/.agents/core/<name>.js` (fallback `.claude/core`, `.codex/core`),
//     run with cwd = root, the parent environment inherited, stopping at the first failing step.
//
// AC -> test names
//   AC1 (verdict accept + snapshot hash + diff scope; copies, renders, --check, check, gate):
//       "apply_*", "verdict_*", "drift_*", "scope_*", "candidateHash_*", "trustedCopy_*"
//   AC2 (restore on any failure; prints the files; never commits):
//       "restore_*", "apply_success_*", "remote_*"
//   AC3 (adversarial: protected file, drift, gate failure, render conflict, clean status after restore):
//       "scope_*", "drift_*", "restore_*", "finalScope_*", "workspace_*", "binding_*", "bind_*"
//   AC4 (workflow routing, Owner Decision 11): "wiring_*", "classify*", "sideDoor_*"
//   Malformed input: "input_*";  idempotence: "idempotence_*"
//
// NOT COVERED: a real dry run on a copy of this repository (a 119 MB history and a 96 s gate). The story's Verify
//   line runs it by hand; the scratch-repo tests here use the real git, the real improvement-scope and the real
//   skill-eval, and only the render, check and gate commands are stubs.
// A failure of the restore itself (`failedStep: 'restore'`, `restored: false`) is covered on POSIX as a non-root user:
//   a directory the gate made unwritable stops both git's restore and the byte ledger's (skipped as root and on Windows).
// NOT COVERED: the helper does not roll back the gate's own receipt, receipt-history and failure-ledger rows (they are
//   the evidence of the run) nor build output the gate writes under ignored paths (coverage, caches); a gate that REWRITES
//   the failure ledger is refused as `scope` but its bytes are not put back.
// NOT COVERED: `bind`'s recency check reads file times, so a deliberate timestamp rewind defeats it; the stronger source is
//   the evaluator recording the binding itself (tools/skill-regress.js, outside this story's files). The binding's grading
//   hashes (security M3 c) catch a grading.json or benchmark.json edited, deleted or added AFTER the binding; whoever writes
//   the gradings and then runs `bind` themselves still gets a binding.
// NOT COVERED: the corpus rule is statistical: a rare rule-flipping word on neither the antonym list nor the guard list
//   can still read as a typo; the render, conformance and gate steps still run.
// NOT COVERED: SF-4.11 removes the sweep Phase 5b "do not run the full differential" override; this story must not,
//   and nothing here pins the override either way, so SF-4.11 is free to remove it.
// NOT COVERED: `_decisions.md` fingerprint lines for an applied candidate (workflow Step 6.4 prose; the AC does not
//   put them in the helper). The evolution ledger is pinned by the SF-4.10 blocks at the end of this file.
// NOT COVERED: platform-dependent symlink and executable-trap tests are skipped where the OS refuses them.

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const CORE = path.join(REPO_ROOT, '.agents', 'core');
const LIB = path.join(CORE, '_lib', 'skill-apply.js');
const EVOLUTION = path.join(CORE, 'skill-evolution.js');
const EVAL = path.join(CORE, 'skill-eval.js');
const SCOPE = path.join(CORE, '_lib', 'improvement-scope.js');

const S = new Proxy({}, { get: (_t, key) => require(LIB)[key] });

// ─── scratch repository ──────────────────────────────────────────────────────

const MIN_TIER = [
    'gate.config.json',
    '.agents/core/gate.js',
    '.agents/hooks/',
    '.agents/config/guardrail-rules.yaml',
    'evals/',
    'holdout/',
    'docs/.output/.state/telemetry/ac-verify/',
    'docs/.output/.state/telemetry/ship-seal.json',
    'docs/.output/.state/telemetry/gate-failures.jsonl',
    'docs/.output/.state/telemetry/gate-receipt.json',
    'docs/.output/.state/telemetry/gate-receipts/',
    'docs/.output/.state/freeze-state.json',
];
const tierYaml = (entries) => `subagentReadOnlyPaths:\n${entries.map((e) => `  - ${e}`).join('\n')}\n`;

const SKILL_MD = [
    '---',
    'name: alpha',
    'description: Use when testing the apply helper with a throwaway skill.',
    '---',
    '',
    '# Alpha',
    '',
    'Rule one: always run the tests.',
    'Rule two: see .claude/core/old-gate.js for the gate.',
    '',
    'See references/guide.md for details.',
    '',
].join('\n');

// A second skill gives the typo rule its corpus: the corrected words occur here more than once.
const BETA_MD = [
    '---',
    'name: beta',
    'description: Use when a second skill must carry the words the typo rule counts.',
    '---',
    '',
    '# Beta',
    '',
    'An error occurred in the first run and the same error occurred again.',
    'Refuse to separate the failing runs, and refuse to receive a late result.',
    'Keep a separate note and receive every result.',
    '',
].join('\n');

const GUIDE_MD = ['# Guide', '', 'The gate occured twice in the last run.', 'Never  skip the gate', ''].join('\n');

const STUB_RENDER = `'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const args = process.argv.slice(2);
const root = process.cwd();
if (process.env.CALL_LOG) fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ tool: 'render', args, cwd: fs.realpathSync(root), gitWorkTree: process.env.GIT_WORK_TREE || null, gitDir: process.env.GIT_DIR || null }) + '\\n');
const src = path.join(root, '.agents/skills/alpha');
const dst = path.join(root, '.claude/skills/alpha');
function walk(d, b = '') {
  const out = [];
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const rel = b ? b + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(d, e.name), rel)); else out.push(rel);
  }
  return out;
}
if (args.includes('--check')) {
  if (process.env.STUB_RENDER_CHECK === 'drift') { console.error('render drift'); process.exit(1); }
  for (const rel of walk(src)) {
    const a = fs.readFileSync(path.join(src, rel), 'utf8');
    const b = fs.existsSync(path.join(dst, rel)) ? fs.readFileSync(path.join(dst, rel), 'utf8') : null;
    if (a !== b) { console.error('stale ' + rel); process.exit(1); }
  }
  process.exit(0);
}
if (process.env.STUB_RENDER === 'conflict') {
  fs.writeFileSync(path.join(dst, 'SKILL.md'), 'PARTIAL\\n');
  fs.writeFileSync(path.join(dst, 'SKILL.md.conflict'), '<<<<<<<\\n');
  console.error('CONFLICT');
  process.exit(1);
}
for (const rel of walk(src)) {
  fs.mkdirSync(path.dirname(path.join(dst, rel)), { recursive: true });
  fs.copyFileSync(path.join(src, rel), path.join(dst, rel));
}
const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(src, 'SKILL.md'))).digest('hex');
fs.writeFileSync(path.join(root, '.agents/render-state.json'), JSON.stringify({ alpha: sha }) + '\\n');
if (process.env.STUB_RENDER === 'tamper') fs.appendFileSync(path.join(root, '.agents/hooks/h.cjs'), '// tampered\\n');
if (process.env.STUB_RENDER === 'stray') {
  fs.mkdirSync(path.join(root, '.claude/stray'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/stray/notes.txt'), 'not a render output\\n');
}
`;

const STUB_CHECK = `'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
if (process.env.CALL_LOG) fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ tool: 'skill-evolution', args, cwd: fs.realpathSync(process.cwd()) }) + '\\n');
if (process.env.STUB_CHECK === 'fail') { console.error('FAILS the skill spec'); process.exit(1); }
`;

const STUB_GATE = `'use strict';
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
if (process.env.CALL_LOG) fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ tool: 'gate', args, cwd: fs.realpathSync(process.cwd()) }) + '\\n');
const state = path.join(process.cwd(), 'docs/.output/.state');
const touch = (rel, text) => { const f = path.join(process.cwd(), rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
switch (process.env.STUB_GATE) {
  case 'receipt':
    touch('docs/.output/.state/telemetry/gate-receipt.json', '{"passed":true}\\n');
    touch('docs/.output/.state/telemetry/gate-receipts/by-id/r1.json', '{"id":"r1"}\\n');
    fs.appendFileSync(path.join(state, 'telemetry/gate-failures.jsonl'), '{"row":"appended by the gate"}\\n');
    break;
  case 'seal': touch('docs/.output/.state/telemetry/ship-seal.json', 'TAMPERED SEAL\\n'); break;
  case 'freeze': touch('docs/.output/.state/freeze-state.json', 'TAMPERED FREEZE\\n'); break;
  case 'acverify': touch('docs/.output/.state/telemetry/ac-verify/rec.json', 'TAMPERED RECORD\\n'); break;
  case 'ledger-rewrite': touch('docs/.output/.state/telemetry/gate-failures.jsonl', '{"row":"rewritten history"}\\n'); break;
  case 'tracked': fs.appendFileSync(path.join(process.cwd(), 'docs/notes.md'), 'gate edited a tracked file\\n'); break;
  case 'untracked': touch('tools/helper.txt', 'gate wrote a new file\\n'); break;
  case 'lock-ignored': {
    fs.writeFileSync(path.join(process.cwd(), '.agents/skills/alpha/notes/a.scratchnote'), 'GATE EDIT\\n');
    fs.chmodSync(path.join(process.cwd(), '.agents/skills/alpha/notes'), 0o555);
    console.error('FAILED, and the notes directory is now unwritable');
    process.exit(1);
  }
  case 'lock': {
    fs.appendFileSync(path.join(process.cwd(), '.agents/skills/alpha/references/guide.md'), 'gate scribble\\n');
    fs.chmodSync(path.join(process.cwd(), '.agents/skills/alpha/references'), 0o555);
    console.error('FAILED, and the directory is now unwritable');
    process.exit(1);
  }
  default: break;
}
if (process.env.STUB_GATE === 'red') {
  fs.writeFileSync(path.join(process.cwd(), 'docs', 'gate-junk.txt'), 'junk\\n');
  fs.appendFileSync(path.join(process.cwd(), '.agents/skills/alpha/references/guide.md'), 'gate scribble\\n');
  console.error('FAILED 3 tests');
  process.exit(1);
}
`;

// The base commit's improvement-scope gains a logging tail so a test can see WHICH copy ran, with which
// arguments, and what the live skill held at that moment (the baseline must precede the change).
const SCOPE_TAIL = `
;(function () {
  if (!process.env.SCOPE_CALL_LOG) return;
  const a = process.argv.slice(2);
  const r = a.indexOf('--root');
  let alphaSha = 'n/a';
  try {
    alphaSha = require('crypto').createHash('sha256').update(require('fs').readFileSync(require('path').join(a[r + 1], '.agents/skills/alpha/SKILL.md'))).digest('hex');
  } catch { /* not a cli call */ }
  require('fs').appendFileSync(process.env.SCOPE_CALL_LOG, JSON.stringify({ verb: a[0], args: a, file: __filename, alphaSha }) + '\\n');
})();
`;

function git(root, ...args) {
    return spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
}
function gitOut(root, ...args) {
    const r = git(root, ...args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
}

function put(root, rel, content) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
}
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

let tmpDirs = [];
function tmpDir(prefix) {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    tmpDirs.push(d);
    return d;
}
afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
});

const canSymlink = (() => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-apply-symprobe-'));
    try {
        fs.writeFileSync(path.join(r, 'a'), 'x');
        fs.symlinkSync(path.join(r, 'a'), path.join(r, 'b'));
        return true;
    } catch {
        return false;
    } finally {
        fs.rmSync(r, { recursive: true, force: true });
    }
})();
const canTrap = process.platform !== 'win32';

/** A committed scratch repo with a local bare remote whose upload/receive programs are traps. */
function makeRepo({ rules = true } = {}) {
    const base = tmpDir('skill-apply-');
    const root = path.join(base, 'repo');
    fs.mkdirSync(root);
    gitOut(root, 'init', '-q', '-b', 'main');
    if (rules) put(root, '.agents/config/guardrail-rules.yaml', tierYaml(MIN_TIER));
    for (const lib of ['improvement-scope.js', 'guardrail-rules.js', 'yaml-parser.js']) {
        let text = fs.readFileSync(path.join(CORE, '_lib', lib), 'utf8');
        if (lib === 'improvement-scope.js') text += SCOPE_TAIL;
        put(root, `.agents/core/_lib/${lib}`, text);
    }
    put(root, '.agents/core/render-shared-agents.js', STUB_RENDER);
    put(root, '.agents/core/skill-evolution.js', STUB_CHECK);
    put(root, '.agents/core/gate.js', STUB_GATE);
    put(root, '.agents/hooks/h.cjs', 'hook v1\n');
    put(root, '.agents/skills/alpha/SKILL.md', SKILL_MD);
    put(root, '.agents/skills/alpha/references/guide.md', GUIDE_MD);
    put(root, '.agents/skills/skill-creator/SKILL.md', SKILL_MD.replace(/alpha/g, 'skill-creator'));
    put(root, '.claude/skills/alpha/SKILL.md', SKILL_MD);
    put(root, '.claude/skills/alpha/references/guide.md', GUIDE_MD);
    put(root, '.agents/render-state.json', `${JSON.stringify({ alpha: sha256(SKILL_MD) })}\n`);
    put(root, '.agents/skills/beta/SKILL.md', BETA_MD);
    put(root, 'docs/notes.md', 'notes\n');
    put(root, '.gitignore', 'docs/.output/.state/\n*.scratchnote\n');
    gitOut(root, 'add', '-A');
    gitOut(root, 'commit', '-q', '-m', 'base');

    const remote = path.join(base, 'remote.git');
    gitOut(base, 'init', '-q', '--bare', remote);
    gitOut(root, 'remote', 'add', 'origin', remote);
    gitOut(root, 'push', '-q', '-u', 'origin', 'main');

    const trapLog = path.join(base, 'trap.log');
    if (canTrap) {
        const trap = path.join(base, 'trap.sh');
        fs.writeFileSync(trap, `#!/bin/sh\necho "$0 $*" >> '${trapLog}'\nexit 1\n`, { mode: 0o755 });
        gitOut(root, 'config', 'remote.origin.uploadpack', trap);
        gitOut(root, 'config', 'remote.origin.receivepack', trap);
    }
    return {
        base,
        root,
        remote,
        trapLog,
        callLog: path.join(base, 'calls.jsonl'),
        scopeLog: path.join(base, 'scope.jsonl'),
        baseSha: gitOut(root, 'rev-parse', 'HEAD'),
    };
}

// ─── evidence: a real iteration directory aggregated by the real skill-eval ──

const QUALITY = {
    accept: { evals: 2, runs: 3, withPass: true, basePass: false },
    lowpower: { evals: 1, runs: 2, withPass: true, basePass: false },
    reject: { evals: 2, runs: 3, withPass: false, basePass: false },
    regress: { evals: 2, runs: 3, withPass: false, basePass: true },
};

function buildIteration(dir, quality) {
    const q = QUALITY[quality];
    for (let e = 0; e < q.evals; e++) {
        const evalDir = path.join(dir, `eval-${e}-e${e}`);
        put(evalDir, 'eval_metadata.json', JSON.stringify({ eval_id: String(e), eval_name: `e${e}` }));
        for (const [arm, pass] of [['with_skill', q.withPass], ['old_skill', q.basePass]]) {
            for (let r = 1; r <= q.runs; r++) {
                const expectations = [0, 1, 2].map((i) => ({ text: `assertion ${i}`, passed: pass, evidence: 'recorded' }));
                put(path.join(evalDir, arm, `run-${r}`), 'grading.json', JSON.stringify({ expectations }));
            }
        }
    }
    const agg = spawnSync(process.execPath, [EVAL, 'aggregate', dir, '--skill-name', 'alpha', '--date', '2026-11-18'], { encoding: 'utf8' });
    if (agg.status !== 0) throw new Error(`fixture aggregate failed (${agg.status}): ${agg.stderr}`);
}

/** Record what the workspace's highest iteration graded (what the evaluator does after `aggregate`). */
function bindWs(ws) {
    const r = S.bind({ run: ws });
    if (!r.ok) throw new Error(`fixture bind failed: ${JSON.stringify(r)}`);
    return r;
}

/** The same tree hash the helper prints as `candidateSha256` (every file's path and sha256, in code-unit order). */
function treeSha(dir) {
    const rows = [];
    const walk = (d, prefix) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(d, e.name), rel);
            else rows.push([rel, sha256(fs.readFileSync(path.join(d, e.name)))]);
        }
    };
    walk(dir, '');
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const h = crypto.createHash('sha256');
    for (const [rel, digest] of rows) h.update(`${rel}\0${digest}\n`);
    return h.digest('hex');
}
/**
 * `gradings` as the binding documents it, computed here and not by the code under test: the sha256 of every grading.json and
 * benchmark.json under the highest iteration and under its holdout, keyed by the path relative to the workspace.
 */
function gradingFiles(ws, iteration = 'iteration-1') {
    const out = {};
    const walk = (dir, prefix) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = `${prefix}/${e.name}`;
            if (e.isDirectory()) walk(path.join(dir, e.name), rel);
            else if (e.name === 'grading.json' || e.name === 'benchmark.json') out[rel] = sha256(fs.readFileSync(path.join(dir, e.name)));
        }
    };
    walk(path.join(ws, iteration), iteration);
    if (fs.existsSync(path.join(ws, 'holdout', iteration))) walk(path.join(ws, 'holdout', iteration), `holdout/${iteration}`);
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
/** Replace the iteration's binding the way a re-evaluation would (a new binding for the files as they are now). */
function rebindWs(ws, iteration = 'iteration-1') {
    fs.rmSync(path.join(ws, iteration, 'binding.json'));
    return bindWs(ws);
}
const candidatePin = (ws) => treeSha(fs.existsSync(path.join(ws, 'candidate')) ? path.join(ws, 'candidate') : path.join(ws, 'skill-candidate'));

function liveFiles(root, skill) {
    const out = {};
    const base = path.join(root, '.agents', 'skills', skill);
    const walk = (dir, prefix) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(dir, e.name), rel);
            else out[rel] = fs.readFileSync(path.join(dir, e.name));
        }
    };
    walk(base, '');
    return out;
}

const withExtraRule = (skillMd) => skillMd.replace('See references', 'Rule three: record the failing case first.\n\nSee references');

/**
 * A scenario: scratch repo plus a workspace (OUTSIDE the repo by default, so it never dirties the tree; `wsRel` puts it
 * inside) holding the snapshot, the candidate overlay and real evidence: `iteration-1`, the held-out `holdout/iteration-1`
 * (`holdout: false` omits it) and the binding the evaluator records. `prepare(repo)` edits the repo before the snapshot is taken.
 */
function makeScenario({ quality = 'accept', skill = 'alpha', candidate, snapshot, candidateDir = 'candidate', repo: repoOpts, holdout, prepare, wsRel } = {}) {
    const repo = makeRepo(repoOpts);
    if (prepare) {
        prepare(repo);
        repo.baseSha = gitOut(repo.root, 'rev-parse', 'HEAD');
    }
    const ws = wsRel ? path.join(repo.root, wsRel) : path.join(repo.base, 'ws');
    const live = liveFiles(repo.root, skill);
    for (const [rel, buf] of Object.entries(snapshot || live)) put(ws, `skill-snapshot/${rel}`, buf);
    const cand = candidate || { 'SKILL.md': withExtraRule(live['SKILL.md'].toString('utf8')) };
    for (const [rel, text] of Object.entries(cand)) put(ws, `${candidateDir}/${rel}`, text);
    if (quality) {
        buildIteration(path.join(ws, 'iteration-1'), quality);
        const heldOut = holdout === undefined ? 'accept' : holdout;
        if (heldOut) buildIteration(path.join(ws, 'holdout', 'iteration-1'), heldOut);
        bindWs(ws);
    }
    return { repo, ws, skill, candidate: cand, live };
}

// ─── running the CLI and reading state ───────────────────────────────────────

function parseJson(r, label) {
    const out = (r.stdout || '').trim();
    try {
        return JSON.parse(out);
    } catch {
        throw new Error(`${label} did not print one JSON object (exit ${r.status}): stdout=${JSON.stringify(out.slice(0, 300))} stderr=${JSON.stringify((r.stderr || '').slice(0, 300))}`);
    }
}

/** `args` are everything after the verb. `via: 'evolution'` goes through `skill-evolution.js apply`. */
function run(sc, args, { via = 'lib', env = {}, noRoot = false, verb = 'apply' } = {}) {
    const root = sc.repo.root;
    const childEnv = { ...process.env, CALL_LOG: sc.repo.callLog, SCOPE_CALL_LOG: sc.repo.scopeLog, ...env };
    let argv;
    if (via === 'evolution') {
        childEnv.CLAUDE_PROJECT_DIR = root;
        argv = [EVOLUTION, verb, ...args];
    } else {
        argv = [LIB, verb, ...args, ...(noRoot || verb === 'bind' ? [] : ['--root', root])];
    }
    const r = spawnSync(process.execPath, argv, { cwd: sc.repo.base, encoding: 'utf8', env: childEnv, timeout: 120000 });
    return { status: r.status, stderr: r.stderr, stdout: r.stdout, json: parseJson(r, `${verb} ${args.join(' ')}`) };
}

const proposeArgs = (sc, extra = []) => [sc.skill, '--run', sc.ws, ...extra];
/** `--mode apply` needs the candidate hash the propose run prints: computed from the candidate as it is NOW (`pin: false` omits it). */
const applyArgs = (sc, { branch = 'auto/x', extra = [], pin = true } = {}) => [
    sc.skill, '--run', sc.ws, '--mode', 'apply', '--branch', branch, ...(pin ? ['--candidate-sha256', candidatePin(sc.ws)] : []), ...extra,
];

function readJsonl(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// SF-4.10: the evolution ledger (`docs/.output/evolution/skills/{date}/ledger.json`) is the one audited write a refusal or a
// proposal makes inside the repository, so the tree-state helpers below leave exactly that file out; the SF-4.10 blocks at the
// end of this file assert the ledger itself.
const isLedgerFile = (rel) => /^docs\/\.output\/evolution\/skills\/\d{4}-\d{2}-\d{2}\/ledger\.json$/.test(rel);

/** repo-relative path -> sha256 of every file outside `.git`, the ignored state directory and the evolution ledger. */
function fileMap(root) {
    const out = {};
    const walk = (dir, prefix) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${e.name}` : e.name;
            if (rel === '.git' || rel === 'docs/.output/.state' || isLedgerFile(rel)) continue;
            if (e.isDirectory()) walk(path.join(dir, e.name), rel);
            else if (e.isSymbolicLink()) out[rel] = `symlink:${fs.readlinkSync(path.join(dir, e.name))}`;
            else out[rel] = sha256(fs.readFileSync(path.join(dir, e.name)));
        }
    };
    walk(root, '');
    return out;
}

function statusPaths(root) {
    // -z entries are NUL separated "XY path"; gitOut() would trim, so read stdout directly
    const raw = git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all').stdout;
    return raw.split('\0').filter(Boolean).map((e) => e.slice(3)).filter((p) => !isLedgerFile(p)).sort();
}

function localState(repo) {
    return {
        files: fileMap(repo.root),
        head: gitOut(repo.root, 'rev-parse', 'HEAD'),
        branch: gitOut(repo.root, 'symbolic-ref', '--short', 'HEAD'),
        branches: gitOut(repo.root, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').sort(),
        status: statusPaths(repo.root),
        cached: gitOut(repo.root, 'diff', '--cached', '--name-only'),
        commits: gitOut(repo.root, 'rev-list', '--all', '--count'),
        stash: gitOut(repo.root, 'stash', 'list'),
    };
}

function remoteState(repo) {
    return {
        remoteRefs: gitOut(repo.base, '--git-dir', repo.remote, 'for-each-ref'),
        trackingRefs: gitOut(repo.root, 'for-each-ref', 'refs/remotes'),
        fetchHead: fs.existsSync(path.join(repo.root, '.git', 'FETCH_HEAD')),
        config: fs.readFileSync(path.join(repo.root, '.git', 'config'), 'utf8'),
        trap: fs.existsSync(repo.trapLog) ? fs.readFileSync(repo.trapLog, 'utf8') : '',
    };
}

const norm = (p) => String(p).replace(/\\/g, '/');
const flagValue = (args, flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
};

// ─── fixture sanity (green now: proves the red tests below are red for the module, not the fixtures) ──────

describe('fixtureSanity', () => {
    it.each(['accept', 'lowpower', 'reject', 'regress'])('fixtureSanity_%sEvidence_hasTheVerdictTheScenarioNames', (quality) => {
        const dir = tmpDir('skill-apply-ev-');
        buildIteration(dir, quality);

        const r = spawnSync(process.execPath, [EVAL, 'verdict', dir], { encoding: 'utf8' });
        const v = JSON.parse(r.stdout);

        const expected = {
            accept: { status: 0, verdict: 'accept', lowPower: false },
            lowpower: { status: 0, verdict: 'accept', lowPower: true },
            reject: { status: 4, verdict: 'reject', lowPower: true },
            regress: { status: 4, verdict: 'reject', lowPower: false },
        }[quality];
        expect(r.status).toBe(expected.status);
        expect(v.verdict).toBe(expected.verdict);
        expect(v.lowPower).toBe(expected.lowPower);
    });

    it.each([
        ['.agents/skills/alpha/evals/evals.json', 'protected'],
        ['.agents/skills/alpha/holdout/case-1.json', 'protected'],
        ['.agents/skills/alpha/__tests__/alpha.test.js', 'protected'],
        ['.agents/skills/alpha/scripts/alpha.spec.js', 'protected'],
        ['.agents/skills/alpha/guardrail-rules.project.yaml', 'protected'],
        ['.agents/skills/alpha/SKILL.md', 'editable'],
        ['.agents/skills/alpha/references/guide.md', 'editable'],
    ])('fixtureSanity_scopeClassifies_%s_as_%s', (rel, cls) => {
        const repo = makeRepo();

        const r = spawnSync(process.execPath, [SCOPE, 'classify', rel, '--target', 'alpha', '--root', repo.root], { encoding: 'utf8' });

        expect(JSON.parse(r.stdout).class).toBe(cls);
    });

    it('fixtureSanity_realScopeCheck_passesAnInScopeEditAndRefusesAProtectedOne', () => {
        const repo = makeRepo();
        const snap = spawnSync(process.execPath, [SCOPE, 'snapshot', '--base', repo.baseSha, '--root', repo.root], { encoding: 'utf8' });
        put(repo.root, '.agents/skills/alpha/SKILL.md', withExtraRule(SKILL_MD));
        const ok = spawnSync(process.execPath, [SCOPE, 'check', '--base', repo.baseSha, '--target', 'alpha', '--root', repo.root], { encoding: 'utf8' });
        put(repo.root, '.agents/hooks/h.cjs', 'hook tampered\n');
        const bad = spawnSync(process.execPath, [SCOPE, 'check', '--base', repo.baseSha, '--target', 'alpha', '--root', repo.root], { encoding: 'utf8' });

        expect(snap.status, snap.stdout).toBe(0);
        expect(ok.status, ok.stdout).toBe(0);
        expect(bad.status).toBe(1);
    });

    it.skipIf(!canTrap)('fixtureSanity_remoteTrap_firesOnFetchAndPush', () => {
        const repo = makeRepo();

        const ls = git(repo.root, 'ls-remote', 'origin');
        const afterLs = fs.existsSync(repo.trapLog) ? fs.readFileSync(repo.trapLog, 'utf8') : '';
        fs.rmSync(repo.trapLog, { force: true });
        git(repo.root, 'push', 'origin', 'main');
        const afterPush = fs.existsSync(repo.trapLog) ? fs.readFileSync(repo.trapLog, 'utf8') : '';

        expect(ls.status).not.toBe(0);
        expect(afterLs).not.toBe('');
        expect(afterPush).not.toBe('');
    });
});

// ─── static pins ─────────────────────────────────────────────────────────────

function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

describe('skill-apply module surface', () => {
    it('exports_pinnedNamesAndExitCodes', () => {
        expect(fs.existsSync(LIB)).toBe(true);
        const m = require(LIB);

        expect(m.EXIT_OK).toBe(0);
        expect(m.EXIT_FAILED).toBe(1);
        expect(m.EXIT_INVALID).toBe(2);
        for (const name of ['classifyEdit', 'classifyChange', 'apply', 'runCli']) expect(typeof m[name], name).toBe('function');
    });

    it.each(['push', 'fetch', 'pull', 'remote', 'commit', 'clean', '--hard'])('source_neverNamesTheGitVerb_%s', (verb) => {
        const src = stripComments(fs.readFileSync(LIB, 'utf8'));

        const quoted = new RegExp(`['"\`]${verb.replace(/-/g, '\\-')}['"\`]`);

        expect(quoted.test(src)).toBe(false);
    });

    it('source_spawnsByArgvArrayWithWindowsHide_neverAShell', () => {
        const src = stripComments(fs.readFileSync(LIB, 'utf8'));

        expect(/shell\s*:\s*true/.test(src)).toBe(false);
        expect(/\bexecSync\s*\(|\bexec\s*\(/.test(src)).toBe(false);
        expect(/spawnSync|execFileSync/.test(src)).toBe(true);
        expect(/windowsHide\s*:\s*true/.test(src)).toBe(true);
    });
});

// ─── side-door classifier (pure) ─────────────────────────────────────────────

/** A corpus as the apply helper builds it: lower-case word counts over the skill texts. */
function corpusOf(...texts) {
    const counts = new Map();
    for (const text of texts) for (const m of text.toLowerCase().matchAll(/\p{L}+/gu)) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
    return (word) => counts.get(word) || 0;
}
// The corrected words occur in the corpus; the misspellings occur only where the delta fixes them.
const CORPUS = corpusOf(
    'An error occurred and the same error occurred again. Please receive the file and receive the answer. Run separate checks and separate runs.',
    'The gate occured twice. Please recieve the file. Run seperate checks.',
);

describe('classifyEdit: the side-door policy (Owner Decision 11)', () => {
    it.each([
        ['an inserted letter', 'The gate occured twice.', 'The gate occurred twice.'],
        ['a transposition', 'Please recieve the file.', 'Please receive the file.'],
        ['a substituted letter', 'Run seperate checks.', 'Run separate checks.'],
    ])('classifyEdit_typoFix_%s_isExempt', (_n, before, after) => {
        const r = S.classifyEdit(before, after, { wordCount: CORPUS });

        expect(r.class).toBe('exempt');
        expect(r.kinds).toEqual(['typo']);
    });

    it('classifyEdit_typoFix_withNoCorpusToProveTheMisspelling_isBehavior', () => {
        expect(S.classifyEdit('The gate occured twice.', 'The gate occurred twice.').class).toBe('behavior');
        expect(S.classifyEdit('The gate occured twice.', 'The gate occurred twice.', { wordCount: 'nope' }).class).toBe('behavior');
    });

    it('classifyEdit_identicalText_isNoop', () => {
        expect(S.classifyEdit('same\n', 'same\n').class).toBe('noop');
    });

    it.each([
        ['negation word swapped', 'Never skip the gate.', 'Ever skip the gate.'],
        ['modal swapped', 'You should run the tests.', 'You could run the tests.'],
        ['quantifier typo-shaped', 'Always run the gate.', 'Alway run the gate.'],
        ['three-letter negation', 'Do not push.', 'Do now push.'],
        ['number changed', 'Run it 3 times.', 'Run it 4 times.'],
        ['word substituted', 'Run the unit tests.', 'Run the full tests.'],
        ['word inserted', 'Run tests.', 'Run all tests.'],
        ['line added', 'one\n', 'one\ntwo\n'],
        ['line removed', 'one\ntwo\n', 'one\n'],
        ['punctuation only (not a named class)', 'Never skip the gate', 'Never skip the gate.'],
        ['whitespace only (not a named class)', 'Never skip  the gate.', 'Never skip the gate.'],
    ])('classifyEdit_behaviorEdit_%s_isBehavior', (_n, before, after) => {
        const r = S.classifyEdit(before, after, { wordCount: CORPUS });

        expect(r.class).toBe('behavior');
        expect(typeof r.reason).toBe('string');
        expect(r.reason.length).toBeGreaterThan(0);
    });

    // SF-4.9 review M4 / security M7: a "typo" that is a real word reverses a rule. Every pair below is a real
    // rule flip; the corpus is built to be the most favourable one (the old word occurs only here, the new word twice),
    // so the refusal comes from the code's own rules and never from a lucky statistic.
    it.each([
        ['skip', 'ship', 'Never skip the gate.', 'Never ship the gate.'],
        ['reuse', 'refuse', 'Compute the stamp once and reuse it.', 'Compute the stamp once and refuse it.'],
        ['same', 'some', 'Reuse the same string.', 'Reuse the some string.'],
        ['push', 'pull', 'Never push the branch.', 'Never pull the branch.'],
        ['include', 'exclude', 'Include the holdout set.', 'Exclude the holdout set.'],
        ['minimum', 'maximum', 'Use the minimum budget.', 'Use the maximum budget.'],
        ['increase', 'decrease', 'Increase the replicates.', 'Decrease the replicates.'],
        ['enable', 'unable', 'Always enable the scan.', 'Always unable the scan.'],
        ['accept', 'except', 'Accept every finding.', 'Except every finding.'],
        ['allow', 'allot', 'Allow the push.', 'Allot the push.'],
        ['stop', 'step', 'Stop when the gate is red.', 'Step when the gate is red.'],
        ['pass', 'past', 'Do not use pass here.', 'Do not use past here.'],
        ['fail', 'fall', 'Retry after fail.', 'Retry after fall.'],
        ['shall', 'small', 'The agent shall run it.', 'The agent small run it.'],
    ])('classifyEdit_meaningFlip_%s_to_%s_isBehaviorEvenWhenTheCorpusFavoursIt', (oldWord, newWord, before, after) => {
        const favourable = (word) => (word === oldWord ? 1 : word === newWord ? 2 : 0);

        const r = S.classifyEdit(before, after, { wordCount: favourable });

        expect(r.class).toBe('behavior');
    });

    it.each([
        ['the old word occurs elsewhere in the corpus (a real word, not a misspelling)', 'The gate occured twice.', 'The gate occurred twice.', (w) => (w === 'occured' ? 3 : w === 'occurred' ? 4 : 0)],
        ['the new word is not established in the corpus', 'The gate occured twice.', 'The gate occurred twice.', (w) => (w === 'occured' ? 1 : w === 'occurred' ? 1 : 0)],
        ['the first letter changes', 'A tinted pane.', 'A minted pane.', (w) => (w === 'tinted' ? 1 : w === 'minted' ? 5 : 0)],
        ['two edits apart', 'Please recieve the file.', 'Please receives the file.', (w) => (w === 'recieve' ? 1 : w === 'receives' ? 5 : 0)],
        ['the word is shorter than five letters', 'Skip here.', 'Slip here.', (w) => (w === 'skip' ? 1 : w === 'slip' ? 5 : 0)],
        ['a case-only change', 'The Gate occurred.', 'The gate occurred.', () => 5],
    ])('classifyEdit_typoRule_when_%s_isBehavior', (_n, before, after, wordCount) => {
        expect(S.classifyEdit(before, after, { wordCount }).class).toBe('behavior');
    });

    it('classifyEdit_aMisspellingFixedInOnlyOneOfSeveralPlaces_isBehaviorBecauseTheOldWordStillOccurs', () => {
        const both = 'The gate occured twice.\nThe run occured once.\n';
        const fixedOne = 'The gate occurred twice.\nThe run occured once.\n';
        const fixedBoth = 'The gate occurred twice.\nThe run occurred once.\n';
        const corpus = corpusOf(both, 'It occurred. It occurred again.');

        expect(S.classifyEdit(both, fixedOne, { wordCount: corpus }).class).toBe('behavior');
        expect(S.classifyEdit(both, fixedBoth, { wordCount: corpus }).class).toBe('exempt');
    });

    it('classifyEdit_typoInFrontmatterDescription_isBehavior', () => {
        const before = '---\nname: alpha\ndescription: Use when testing the aplpy helper.\n---\nBody\n';
        const after = '---\nname: alpha\ndescription: Use when testing the apply helper.\n---\nBody\n';

        expect(S.classifyEdit(before, after, { wordCount: () => 2 }).class).toBe('behavior');
    });

    it.each([
        ['a command word inside a fence', '```bash\nnode gate.js tset\n```\n', '```bash\nnode gate.js test\n```\n'],
        ['a tilde fence', '~~~\nrun the sutie\n~~~\n', '~~~\nrun the suite\n~~~\n'],
    ])('classifyEdit_typoInsideCodeFence_%s_isBehavior', (_n, before, after) => {
        expect(S.classifyEdit(before, after, { wordCount: () => 2 }).class).toBe('behavior');
    });

    it('classifyEdit_onlyTheProseLineChanged_afterAFenceCloses_isStillJudgedOnItsOwnLine', () => {
        const before = '```\nx\n```\nThe gate occured twice.\n';
        const after = '```\nx\n```\nThe gate occurred twice.\n';

        expect(S.classifyEdit(before, after, { wordCount: CORPUS }).class).toBe('exempt');
    });

    it('classifyEdit_oneTypoPlusOneBehaviorLine_isBehavior', () => {
        const before = 'The gate occured twice.\nRun it 3 times.\n';
        const after = 'The gate occurred twice.\nRun it 4 times.\n';

        expect(S.classifyEdit(before, after, { wordCount: CORPUS }).class).toBe('behavior');
    });

    describe('stale pointers', () => {
        const exists = (p) => new Set(['.agents/core/gate.js', '.agents/core/commit.js']).has(String(p).replace(/^\.\//, ''));

        it('classifyEdit_stalePointerNowResolving_isExempt', () => {
            const r = S.classifyEdit('see .claude/core/old-gate.js now\n', 'see .agents/core/gate.js now\n', { exists });

            expect(r.class).toBe('exempt');
            expect(r.kinds).toEqual(['stale-pointer']);
        });

        it('classifyEdit_pointerInBackticksAndPunctuation_isExempt', () => {
            const r = S.classifyEdit('See `.claude/core/old-gate.js`.\n', 'See `.agents/core/gate.js`.\n', { exists });

            expect(r.class).toBe('exempt');
            expect(r.kinds).toEqual(['stale-pointer']);
        });

        it.each([
            ['both targets exist (a retarget, not a stale fix)', 'run .agents/core/gate.js now\n', 'run .agents/core/commit.js now\n', { exists }],
            ['the new target does not exist', 'see .claude/core/old-gate.js now\n', 'see .agents/core/nope.js now\n', { exists }],
            ['no exists() to verify against', 'see .claude/core/old-gate.js now\n', 'see .agents/core/gate.js now\n', undefined],
            ['a word changes beside the pointer', 'see .claude/core/old-gate.js now\n', 'skip .agents/core/gate.js now\n', { exists }],
        ])('classifyEdit_pointerEdit_%s_isBehavior', (_n, before, after, opts) => {
            expect(S.classifyEdit(before, after, opts).class).toBe('behavior');
        });

        it('classifyEdit_typoPlusStalePointer_reportsBothKindsSorted', () => {
            const before = 'The gate occured.\nsee .claude/core/old-gate.js now\n';
            const after = 'The gate occurred.\nsee .agents/core/gate.js now\n';

            const r = S.classifyEdit(before, after, { exists, wordCount: CORPUS });

            expect(r.class).toBe('exempt');
            expect(r.kinds).toEqual(['stale-pointer', 'typo']);
        });
    });

    describe('pinned text', () => {
        const isPinned = (line) => line === 'Never skip the gate.';

        it('classifyEdit_restoresAPinnedLine_isExempt', () => {
            const r = S.classifyEdit('Never  skip the gate\n', 'Never skip the gate.\n', { isPinned });

            expect(r.class).toBe('exempt');
            expect(r.kinds).toEqual(['pinned-text']);
        });

        it('classifyEdit_pinnedLookup_isAskedForTheNewLineAndItsPath', () => {
            const asked = [];

            S.classifyChange([{ path: '.agents/skills/alpha/SKILL.md', before: 'Never  skip the gate\n', after: 'Never skip the gate.\n' }], { isPinned: (line, file) => asked.push([line, file]) && true });

            expect(asked).toEqual([['Never skip the gate.', '.agents/skills/alpha/SKILL.md']]);
        });

        it.each([
            ['the new line is not a pinned line', 'Never  skip the gate\n', 'Never skip the gate!\n'],
            ['a word differs from the pinned line', 'Always skip the gate\n', 'Never skip the gate.\n'],
        ])('classifyEdit_pinnedEdit_%s_isBehavior', (_n, before, after) => {
            expect(S.classifyEdit(before, after, { isPinned }).class).toBe('behavior');
        });

        it.each([
            ['no trusted lookup at all', undefined],
            ['a lookup that vouches for nothing', () => false],
            ['a lookup that throws', () => { throw new Error('git is gone'); }],
        ])('classifyEdit_pinnedRestore_with_%s_isBehavior', (_n, lookup) => {
            expect(S.classifyEdit('Never  skip the gate\n', 'Never skip the gate.\n', { isPinned: lookup }).class).toBe('behavior');
        });

        // SF-4.9 review M5 / security m9: even a vouched-for line may not turn a marker, a flag or a tag into something else.
        it.each([
            ['an unterminated project-additions marker', '<!-- @@project-additions:end -->\n', '<!-- @@project-additions:end\n'],
            ['a dropped command flag', 'Use --force only with approval\n', 'Use force only with approval\n'],
            ['a dropped inline code span', 'Run `gate test` before you commit\n', 'Run gate test before you commit\n'],
            ['a table pipe', 'one | two | three words here\n', 'one two three words here\n'],
            ['an import-like at sign', 'Load @docs/guide.md before you start\n', 'Load docs guide md before you start\n'],
        ])('classifyEdit_pinnedRestore_%s_isBehaviorEvenWhenTheLookupVouchesForTheLine', (_n, before, after) => {
            expect(S.classifyEdit(before, after, { isPinned: () => true }).class).toBe('behavior');
        });
    });

    it.each([[null, 'x'], ['x', undefined], [1, 2], [{}, []], [undefined, undefined]])('classifyEdit_nonStringInput_%j_%j_isBehaviorAndNeverThrows', (before, after) => {
        expect(S.classifyEdit(before, after).class).toBe('behavior');
    });
});

describe('classifyChange: a whole delta', () => {
    const typo = { path: 'references/guide.md', before: 'The gate occured.\n', after: 'The gate occurred.\n' };

    it('classifyChange_allFilesExempt_isExemptWithPerFileClasses', () => {
        const r = S.classifyChange([typo, { path: 'SKILL.md', before: 'same\n', after: 'same\n' }], { wordCount: CORPUS });

        expect(r.class).toBe('exempt');
        expect(r.kinds).toEqual(['typo']);
        expect(r.files.map((f) => [f.path, f.class])).toEqual([['references/guide.md', 'exempt'], ['SKILL.md', 'noop']]);
    });

    it.each([
        ['an added file', { path: 'references/new.md', before: null, after: 'hello\n' }],
        ['a deleted file', { path: 'references/old.md', before: 'hello\n', after: null }],
        ['a behavior edit', { path: 'SKILL.md', before: 'Run 3 times.\n', after: 'Run 4 times.\n' }],
    ])('classifyChange_%s_taintsTheWholeDelta', (_n, other) => {
        expect(S.classifyChange([typo, other], { wordCount: CORPUS }).class).toBe('behavior');
    });

    it('classifyChange_aMisspellingFixedInOneFileAndLeftInAnother_isBehaviorForTheFileThatFixedIt', () => {
        const corpus = corpusOf('The gate occured.', 'The run occured.', 'It occurred. It occurred.');

        const r = S.classifyChange([typo], { wordCount: corpus });

        expect(r.class).toBe('behavior');
        expect(r.files[0].class).toBe('behavior');
        expect(r.files[0].reason).toMatch(/occured/);
    });

    it('classifyChange_everyFileUnchanged_isNoop', () => {
        expect(S.classifyChange([{ path: 'a', before: 'x\n', after: 'x\n' }]).class).toBe('noop');
    });

    it.each([[null], ['x'], [[{ path: 'a' }]], [[null]], [[{ path: 'a', before: 3, after: 4 }]]])('classifyChange_malformedInput_%j_isBehaviorAndNeverThrows', (input) => {
        expect(S.classifyChange(input).class).toBe('behavior');
    });
});

// ─── malformed input exits 2 ─────────────────────────────────────────────────

describe('input: malformed arguments exit 2 and change nothing', () => {
    const rows = [
        ['no skill', (sc) => ['--run', sc.ws]],
        ['a path-traversal skill name', (sc) => ['../alpha', '--run', sc.ws]],
        ['a skill name with a space', (sc) => ['alpha beta', '--run', sc.ws]],
        ['an unknown skill directory', (sc) => ['ghost', '--run', sc.ws]],
        ['no --run', () => ['alpha']],
        ['a --run that does not exist', (sc) => ['alpha', '--run', path.join(sc.repo.base, 'nowhere')]],
        ['an unknown flag', (sc) => ['alpha', '--run', sc.ws, '--bogus', 'x']],
        ['an unknown --mode', (sc) => ['alpha', '--run', sc.ws, '--mode', 'bogus']],
        ['an unknown --route', (sc) => ['alpha', '--run', sc.ws, '--route', 'bogus']],
        ['--mode apply without --branch', (sc) => ['alpha', '--run', sc.ws, '--mode', 'apply']],
        ['--mode apply on main', (sc) => ['alpha', '--run', sc.ws, '--mode', 'apply', '--branch', 'main']],
        ['an empty auto/ branch', (sc) => ['alpha', '--run', sc.ws, '--mode', 'apply', '--branch', 'auto/']],
        ['a branch with ..', (sc) => ['alpha', '--run', sc.ws, '--mode', 'apply', '--branch', 'auto/../x']],
        ['a branch with a space', (sc) => ['alpha', '--run', sc.ws, '--mode', 'apply', '--branch', 'auto/a b']],
        ['a branch ending .lock', (sc) => ['alpha', '--run', sc.ws, '--mode', 'apply', '--branch', 'auto/x.lock']],
        ['--branch with propose mode', (sc) => ['alpha', '--run', sc.ws, '--branch', 'auto/x']],
        ['a malformed --candidate-sha256', (sc) => ['alpha', '--run', sc.ws, '--candidate-sha256', 'zz']],
        ['a non-numeric --min-replicates', (sc) => ['alpha', '--run', sc.ws, '--min-replicates', 'abc']],
        ['a negative --min-replicates', (sc) => ['alpha', '--run', sc.ws, '--min-replicates', '-1']],
        ['an extra positional', (sc) => ['alpha', 'beta', '--run', sc.ws]],
        // SF-4.9 review M5: the caller no longer supplies pinned text at all; the old flag is an unknown flag.
        ['the removed --pinned flag', (sc) => ['alpha', '--run', sc.ws, '--route', 'side-door', '--pinned', path.join(sc.repo.base, 'pinned.txt')]],
        // SF-4.9 review M6: the candidate hash is mandatory in --mode apply.
        ['--mode apply without --candidate-sha256', (sc) => applyArgs(sc, { pin: false })],
        ['an --iteration that is not the workspace iteration', (sc) => ['alpha', '--run', sc.ws, '--iteration', REPO_ROOT]],
        ['a --holdout outside the workspace', (sc) => ['alpha', '--run', sc.ws, '--holdout', REPO_ROOT]],
        ['--iteration on the side-door route', (sc) => ['alpha', '--run', sc.ws, '--route', 'side-door', '--iteration', path.join(sc.ws, 'iteration-1')]],
    ];

    it.each(rows)('input_%s_exits2AndChangesNothing', (_n, build) => {
        const sc = makeScenario();
        const before = localState(sc.repo);

        const r = run(sc, build(sc));

        expect(r.status, r.stderr).toBe(2);
        expect(r.json.ok).toBe(false);
        expect(r.json.failedStep).toBe('input');
        expect(typeof r.json.reason).toBe('string');
        expect(localState(sc.repo)).toEqual(before);
    });

    it('input_missingCandidateDirectory_exits2', () => {
        const sc = makeScenario();
        fs.rmSync(path.join(sc.ws, 'candidate'), { recursive: true, force: true });

        const r = run(sc, proposeArgs(sc));

        expect(r.status).toBe(2);
        expect(r.json.failedStep).toBe('input');
    });

    it('input_emptyCandidate_exits2', () => {
        const sc = makeScenario({ quality: null, candidate: {} });
        fs.mkdirSync(path.join(sc.ws, 'candidate'), { recursive: true });

        const r = run(sc, proposeArgs(sc));

        expect(r.status).toBe(2);
        expect(r.json.failedStep).toBe('input');
    });

    it('input_missingSnapshotDirectory_exits2', () => {
        const sc = makeScenario();
        fs.rmSync(path.join(sc.ws, 'skill-snapshot'), { recursive: true, force: true });

        const r = run(sc, proposeArgs(sc));

        expect(r.status).toBe(2);
        expect(r.json.failedStep).toBe('input');
    });

    it.each([
        ['no iteration directory on the verdict route', (ws) => fs.rmSync(path.join(ws, 'iteration-1'), { recursive: true, force: true })],
        ['a missing benchmark.json', (ws) => fs.rmSync(path.join(ws, 'iteration-1', 'benchmark.json'))],
        ['an unparseable benchmark.json', (ws) => fs.writeFileSync(path.join(ws, 'iteration-1', 'benchmark.json'), '{ not json')],
    ])('input_%s_exits2NotAnAccept', (_n, break_) => {
        const sc = makeScenario();
        break_(sc.ws);
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc));

        expect(r.status).toBe(2);
        expect(r.json.ok).toBe(false);
        expect(r.json.applied).toBe(false);
        expect(localState(sc.repo)).toEqual(before);
    });

    it('input_unknownVerb_exits2WithJson', () => {
        const r = spawnSync(process.execPath, [LIB, 'bogus'], { encoding: 'utf8' });

        expect(r.status).toBe(2);
        expect(JSON.parse(r.stdout.trim()).ok).toBe(false);
    });

    it('input_noVerb_exits2WithJson', () => {
        const r = spawnSync(process.execPath, [LIB], { encoding: 'utf8' });

        expect(r.status).toBe(2);
        expect(JSON.parse(r.stdout.trim()).ok).toBe(false);
    });
});

// ─── propose mode (the default: nothing is authorized) ───────────────────────

describe('propose mode: output only, the live tree is never touched', () => {
    it('propose_acceptedCandidate_printsTheFilesAndChangesNothing', () => {
        const sc = makeScenario();
        const before = localState(sc.repo);

        const r = run(sc, proposeArgs(sc));

        expect(r.status, r.stderr).toBe(0);
        expect(r.json).toMatchObject({ ok: true, mode: 'propose', route: 'verdict', applied: false, restored: false, skill: 'alpha' });
        expect(r.json.files).toEqual(['.agents/skills/alpha/SKILL.md']);
        expect(r.json.verdict.verdict).toBe('accept');
        expect(r.json.verdict.exitCode).toBe(0);
        expect(r.json.lowPower).toBe(false);
        expect(localState(sc.repo)).toEqual(before);
        expect(readJsonl(sc.repo.callLog)).toEqual([]);
    });

    it('propose_lowPowerAccept_isProposedNotRefused', () => {
        const sc = makeScenario({ quality: 'lowpower' });

        const r = run(sc, proposeArgs(sc));

        expect(r.status, r.stderr).toBe(0);
        expect(r.json.ok).toBe(true);
        expect(r.json.applied).toBe(false);
        expect(r.json.lowPower).toBe(true);
        expect(r.json.lowPowerReasons).toEqual(['evals<2', 'runs-per-arm<3', 'discordant-assertions<6']);
    });

    it('propose_defaultModeIsPropose_neverCreatesABranch', () => {
        const sc = makeScenario();

        run(sc, proposeArgs(sc));

        expect(gitOut(sc.repo.root, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main');
    });

    it('propose_candidateOverlayWithAReference_listsBothFiles', () => {
        const sc = makeScenario({ candidate: { 'SKILL.md': withExtraRule(SKILL_MD), 'references/extra.md': '# Extra\n' } });

        const r = run(sc, proposeArgs(sc));

        expect(r.json.files).toEqual(['.agents/skills/alpha/SKILL.md', '.agents/skills/alpha/references/extra.md']);
    });

    it('propose_legacySkillCandidateDirectory_isUsed', () => {
        const sc = makeScenario({ candidateDir: 'skill-candidate' });

        const r = run(sc, proposeArgs(sc));

        expect(r.status, r.stderr).toBe(0);
        expect(r.json.files).toEqual(['.agents/skills/alpha/SKILL.md']);
    });
});

// ─── the verdict gate ────────────────────────────────────────────────────────

describe('verdict: only a fresh accept applies', () => {
    it('verdict_reject_refusesAndNamesTheReasons', () => {
        const sc = makeScenario({ quality: 'reject' });
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc));

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, applied: false, failedStep: 'verdict' });
        expect(r.json.verdict.verdict).toBe('reject');
        expect(r.json.verdict.reasons).toContain('no-improvement');
        expect(localState(sc.repo)).toEqual(before);
    });

    it('verdict_gradingEditedAfterAggregate_isDataQualityAndRefused', () => {
        const sc = makeScenario({ quality: 'reject' });
        // Flip every failing baseline grading to a pass after `aggregate`: the stored benchmark no longer matches. The binding
        // is written again for the edited files (what a session that forges a grading and runs `bind` itself would do), so
        // the grading hashes agree and it is the verdict's own recompute that refuses.
        const grading = path.join(sc.ws, 'iteration-1', 'eval-0-e0', 'with_skill', 'run-1', 'grading.json');
        fs.writeFileSync(grading, JSON.stringify({ expectations: [0, 1, 2].map((i) => ({ text: `assertion ${i}`, passed: true, evidence: 'edited' })) }));
        rebindWs(sc.ws);
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc));

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('verdict');
        expect(r.json.verdict.verdict).toBe('data-quality');
        expect(localState(sc.repo)).toEqual(before);
    });

    it('verdict_latestIterationRejects_olderAcceptIsNotCherryPicked', () => {
        const sc = makeScenario({ quality: 'accept' });
        buildIteration(path.join(sc.ws, 'iteration-2'), 'reject');
        bindWs(sc.ws);
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc));

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('verdict');
        expect(r.json.verdict.iteration).toBe(path.join(sc.ws, 'iteration-2'));
        expect(localState(sc.repo)).toEqual(before);
    });

    // SF-4.9 review M6 / security M8: the evidence is the workspace's highest iteration and nothing else.
    it('verdict_aFlagNamingAnOlderFavourableIteration_isRefusedNotObeyed', () => {
        const sc = makeScenario({ quality: 'accept' });
        buildIteration(path.join(sc.ws, 'iteration-2'), 'reject');
        bindWs(sc.ws);
        const before = localState(sc.repo);

        const r = run(sc, proposeArgs(sc, ['--iteration', path.join(sc.ws, 'iteration-1')]));

        expect(r.status).toBe(2);
        expect(r.json).toMatchObject({ ok: false, failedStep: 'input' });
        expect(r.json.reason).toMatch(/highest iteration/);
        expect(localState(sc.repo)).toEqual(before);
    });

    it('verdict_aFlagNamingTheHighestIteration_isAcceptedAsTheSameDirectory', () => {
        const sc = makeScenario({ quality: 'accept' });

        const r = run(sc, proposeArgs(sc, ['--iteration', path.join(sc.ws, 'iteration-1')]));

        expect(r.status, r.stderr).toBe(0);
        expect(r.json.verdict.verdict).toBe('accept');
    });

    it('verdict_anIterationFromAnotherWorkspace_isRefusedEvenWhenItIsAnAccept', () => {
        const sc = makeScenario({ quality: 'reject' });
        const foreign = makeScenario({ quality: 'accept' });

        const r = run(sc, proposeArgs(sc, ['--iteration', path.join(foreign.ws, 'iteration-1')]));

        expect(r.status).toBe(2);
        expect(r.json.failedStep).toBe('input');
    });

    it('verdict_holdoutRegression_refuses', () => {
        const sc = makeScenario({ quality: 'accept', holdout: 'regress' });

        const r = run(sc, proposeArgs(sc));

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('verdict');
        expect(r.json.verdict.reasons).toContain('holdout-regression');
    });

    it('verdict_theHoldoutIsDerivedInsideTheWorkspace_andAFlagMayOnlyNameIt', () => {
        const sc = makeScenario({ quality: 'accept' });
        const elsewhere = path.join(sc.repo.base, 'elsewhere-holdout');
        buildIteration(elsewhere, 'regress');

        const flagged = run(sc, proposeArgs(sc, ['--holdout', elsewhere]));
        const named = run(sc, proposeArgs(sc, ['--holdout', path.join(sc.ws, 'holdout', 'iteration-1')]));

        expect(flagged.status).toBe(2);
        expect(flagged.json.failedStep).toBe('input');
        expect(named.status, named.stderr).toBe(0);
    });

    it('verdict_acceptWithNoHoldoutEvidence_isLowPowerProposedNeverApplied', () => {
        const sc = makeScenario({ quality: 'accept', holdout: false });
        const before = localState(sc.repo);

        const proposed = run(sc, proposeArgs(sc));
        const applied = run(sc, applyArgs(sc));

        expect(proposed.status, proposed.stderr).toBe(0);
        expect(proposed.json.lowPower).toBe(true);
        expect(proposed.json.lowPowerReasons).toEqual(['no-holdout-evidence']);
        expect(applied.status).toBe(1);
        expect(applied.json).toMatchObject({ ok: false, applied: false, failedStep: 'lowpower' });
        expect(localState(sc.repo)).toEqual(before);
        expect(readJsonl(sc.repo.callLog)).toEqual([]);
    });

    it('verdict_minReplicatesFlag_isPassedThrough', () => {
        const sc = makeScenario({ quality: 'accept' });

        const r = run(sc, proposeArgs(sc, ['--min-replicates', '4']));

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('verdict');
        expect(r.json.verdict.reasons).toContain('insufficient-replicates');
    });

    it('verdict_lowPowerAccept_isNeverApplied_proposalOnly', () => {
        const sc = makeScenario({ quality: 'lowpower' });
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc));

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, applied: false, failedStep: 'lowpower', lowPower: true });
        expect(r.json.files).toEqual(['.agents/skills/alpha/SKILL.md']);
        expect(localState(sc.repo)).toEqual(before);
        expect(readJsonl(sc.repo.callLog)).toEqual([]);
    });
});

// ─── snapshot drift ──────────────────────────────────────────────────────────

describe('drift: the snapshot must still equal the live skill', () => {
    function commitLive(sc, rel, text) {
        put(sc.repo.root, `.agents/skills/alpha/${rel}`, text);
        gitOut(sc.repo.root, 'add', '-A');
        gitOut(sc.repo.root, 'commit', '-q', '-m', 'someone edited the live skill');
    }

    it('drift_liveSkillChangedAfterTheSnapshot_refusesWithDifferingHashes', () => {
        const sc = makeScenario();
        commitLive(sc, 'SKILL.md', `${SKILL_MD}\nAn unreviewed rule.\n`);
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc));

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, applied: false, failedStep: 'drift' });
        expect(r.json.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(r.json.canonicalSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(r.json.snapshotSha256).not.toBe(r.json.canonicalSha256);
        expect(localState(sc.repo)).toEqual(before);
    });

    it('drift_candidateOverwritesALiveFileTheSnapshotNeverHeld_refuses', () => {
        const withoutGuide = { 'SKILL.md': Buffer.from(SKILL_MD) };
        const sc = makeScenario({ snapshot: withoutGuide, candidate: { 'references/guide.md': GUIDE_MD.replace('occured', 'occurred') } });
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc));

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('drift');
        expect(localState(sc.repo)).toEqual(before);
    });

    it('drift_matchingSnapshot_reportsOneSharedHash', () => {
        const sc = makeScenario();

        const r = run(sc, proposeArgs(sc));

        expect(r.json.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(r.json.snapshotSha256).toBe(r.json.canonicalSha256);
    });
});

// ─── candidate integrity ─────────────────────────────────────────────────────

describe('candidateHash: the evaluated candidate is the candidate applied', () => {
    it('candidateHash_pinnedValueFromProposeMatches_applies', () => {
        const sc = makeScenario();
        const proposed = run(sc, proposeArgs(sc));
        expect(proposed.json.candidateSha256).toMatch(/^[0-9a-f]{64}$/);

        const r = run(sc, applyArgs(sc, { extra: ['--candidate-sha256', proposed.json.candidateSha256] }));

        expect(r.status, r.stderr).toBe(0);
        expect(r.json.candidateSha256).toBe(proposed.json.candidateSha256);
    });

    it('candidateHash_candidateSwappedAfterTheProposal_refusesAndChangesNothing', () => {
        const sc = makeScenario();
        const proposed = run(sc, proposeArgs(sc));
        put(sc.ws, 'candidate/SKILL.md', `${withExtraRule(SKILL_MD)}\nSneaked in after the evaluation.\n`);
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc, { extra: ['--candidate-sha256', proposed.json.candidateSha256] }));

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('candidate-hash');
        expect(localState(sc.repo)).toEqual(before);
    });

    it('candidateHash_differentCandidates_haveDifferentHashes', () => {
        const a = run(makeScenario(), proposeArgs(makeScenario()));
        const scB = makeScenario({ candidate: { 'SKILL.md': `${withExtraRule(SKILL_MD)}\nAnother line.\n` } });
        const b = run(scB, proposeArgs(scB));

        expect(a.json.candidateSha256).not.toBe(b.json.candidateSha256);
    });
});

// ─── binding: the iteration records what it graded (SF-4.9 review M6, security M8) ──

describe('binding: the candidate applied is the candidate that was evaluated, not merely the one that was proposed', () => {
    it('binding_candidateEditedAfterTheEvaluation_isRefusedEvenWithItsOwnFreshHash', () => {
        const sc = makeScenario(); // evaluated, then bound, with the original candidate
        put(sc.ws, 'candidate/SKILL.md', `${withExtraRule(SKILL_MD)}\nSneaked in after the evaluation.\n`);
        const before = localState(sc.repo);

        const proposed = run(sc, proposeArgs(sc));
        // The edited candidate's own hash, as a propose run would print it, is no help: the iteration graded another candidate.
        const applied = run(sc, applyArgs(sc));

        for (const r of [proposed, applied]) {
            expect(r.status).toBe(1);
            expect(r.json).toMatchObject({ ok: false, applied: false, failedStep: 'candidate-hash' });
            expect(r.json.reason).toMatch(/graded/);
        }
        expect(localState(sc.repo)).toEqual(before);
        expect(readJsonl(sc.repo.callLog)).toEqual([]);
    });

    it('binding_snapshotEditedAfterTheEvaluation_isRefused', () => {
        const sc = makeScenario();
        put(sc.ws, 'skill-snapshot/references/guide.md', `${GUIDE_MD}An unevaluated line.\n`);

        const r = run(sc, proposeArgs(sc));

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('candidate-hash');
        expect(r.json.reason).toMatch(/skill-snapshot/);
    });

    it.each([
        ['missing', (file) => fs.rmSync(file)],
        ['not JSON', (file) => fs.writeFileSync(file, '{ nope')],
        ['hashes that are not sha256', (file) => fs.writeFileSync(file, JSON.stringify({ version: 1, iteration: 'iteration-1', candidateSha256: 'abc', snapshotSha256: 'def' }))],
        ['copied from another iteration', (file) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), iteration: 'iteration-9' }))],
        ['the old shape, without grading hashes', (file) => {
            const { gradings, ...old } = JSON.parse(fs.readFileSync(file, 'utf8'));
            fs.writeFileSync(file, JSON.stringify({ ...old, version: 1 }));
        }],
        ['version 2 with no gradings object', (file) => {
            const { gradings, ...rest } = JSON.parse(fs.readFileSync(file, 'utf8'));
            fs.writeFileSync(file, JSON.stringify(rest));
        }],
        ['grading hashes that are not sha256', (file) => {
            const json = JSON.parse(fs.readFileSync(file, 'utf8'));
            fs.writeFileSync(file, JSON.stringify({ ...json, gradings: { ...json.gradings, 'iteration-1/benchmark.json': 'not-a-hash' } }));
        }],
        ['grading hashes that leave out the iteration benchmark', (file) => {
            const json = JSON.parse(fs.readFileSync(file, 'utf8'));
            delete json.gradings['iteration-1/benchmark.json'];
            fs.writeFileSync(file, JSON.stringify(json));
        }],
    ])('binding_whenTheIterationBindingIs_%s_theVerdictRouteIsRefused', (_n, break_) => {
        const sc = makeScenario();
        break_(path.join(sc.ws, 'iteration-1', 'binding.json'));
        const before = localState(sc.repo);

        const proposed = run(sc, proposeArgs(sc));
        const applied = run(sc, applyArgs(sc));

        for (const r of [proposed, applied]) {
            expect(r.status).toBe(1);
            expect(r.json).toMatchObject({ ok: false, failedStep: 'candidate-hash' });
            expect(r.json.reason).toMatch(/binding\.json/);
        }
        expect(localState(sc.repo)).toEqual(before);
    });

    // Security M3 (c): the grading and benchmark files are ordinary files, and the verdict is computed from them. The binding
    // records their hashes, so an edit, a deletion or an addition after it is refused on both verbs, before any verdict runs.
    const DEV_GRADING = 'iteration-1/eval-0-e0/with_skill/run-1/grading.json';
    const HOLDOUT_GRADING = 'holdout/iteration-1/eval-0-e0/with_skill/run-1/grading.json';
    const flipped = JSON.stringify({ expectations: [0, 1, 2].map((i) => ({ text: `assertion ${i}`, passed: false, evidence: 'forged' })) });
    it.each([
        ['a dev grading.json edited', DEV_GRADING, (sc) => put(sc.ws, DEV_GRADING, flipped), /edited/],
        ['the dev benchmark.json edited', 'iteration-1/benchmark.json', (sc) => fs.appendFileSync(path.join(sc.ws, 'iteration-1', 'benchmark.json'), '\n'), /edited/],
        ['a holdout grading.json edited', HOLDOUT_GRADING, (sc) => put(sc.ws, HOLDOUT_GRADING, flipped), /edited/],
        ['the holdout benchmark.json edited', 'holdout/iteration-1/benchmark.json', (sc) => fs.appendFileSync(path.join(sc.ws, 'holdout', 'iteration-1', 'benchmark.json'), '\n'), /edited/],
        ['a dev grading.json deleted', DEV_GRADING, (sc) => fs.rmSync(path.join(sc.ws, DEV_GRADING)), /missing/],
        ['the holdout benchmark.json deleted', 'holdout/iteration-1/benchmark.json', (sc) => fs.rmSync(path.join(sc.ws, 'holdout', 'iteration-1', 'benchmark.json')), /missing/],
        ['a grading.json added to a new run', 'iteration-1/eval-0-e0/with_skill/run-4/grading.json', (sc) => put(sc.ws, 'iteration-1/eval-0-e0/with_skill/run-4/grading.json', flipped), /added/],
        ['a grading.json added to the holdout', 'holdout/iteration-1/eval-0-e0/with_skill/run-4/grading.json', (sc) => put(sc.ws, 'holdout/iteration-1/eval-0-e0/with_skill/run-4/grading.json', flipped), /added/],
    ])('binding_gradingEvidence_%s_afterTheBinding_isRefusedOnBothVerbs', (_n, file, change, verb) => {
        const sc = makeScenario();
        change(sc);
        const before = localState(sc.repo);

        const proposed = run(sc, proposeArgs(sc));
        const applied = run(sc, applyArgs(sc));

        for (const r of [proposed, applied]) {
            expect(r.status).toBe(1);
            expect(r.json).toMatchObject({ ok: false, applied: false, failedStep: 'candidate-hash' });
            expect(r.json.reason).toMatch(/grading evidence/);
            expect(r.json.reason).toContain(file);
            expect(r.json.reason).toMatch(verb);
            expect(r.json.verdict).toBeUndefined();
        }
        expect(localState(sc.repo)).toEqual(before);
        expect(readJsonl(sc.repo.callLog)).toEqual([]);
    });

    it('binding_aHoldoutThatAppearsAfterTheBinding_isRefused', () => {
        const sc = makeScenario({ holdout: false });
        buildIteration(path.join(sc.ws, 'holdout', 'iteration-1'), 'accept');

        const r = run(sc, proposeArgs(sc));

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('candidate-hash');
        expect(r.json.reason).toMatch(/holdout\/iteration-1\/benchmark\.json was added/);
    });

    it('binding_aSymlinkedGradingFile_isRefusedEvenWhenItsTargetHasTheSameBytes', () => {
        const sc = makeScenario();
        const target = path.join(sc.repo.base, 'grading-copy.json');
        fs.copyFileSync(path.join(sc.ws, DEV_GRADING), target);
        fs.rmSync(path.join(sc.ws, DEV_GRADING));
        try {
            fs.symlinkSync(target, path.join(sc.ws, DEV_GRADING));
        } catch {
            return; // the OS refuses symlinks here (Windows without the privilege): nothing to test
        }

        const r = run(sc, proposeArgs(sc));

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('candidate-hash');
        expect(r.json.reason).toMatch(/symbolic link/);
    });

    it('binding_filesThatAreNotGradingOrBenchmarkFiles_areNotPartOfTheBinding', () => {
        const sc = makeScenario();
        put(sc.ws, 'iteration-1/eval-0-e0/with_skill/run-1/timing.json', JSON.stringify({ total_tokens: 1, duration_ms: 1 }));
        put(sc.ws, 'iteration-1/eval-0-e0/with_skill/run-1/outputs/notes.txt', 'scratch\n');
        put(sc.ws, 'iteration-1/review.html', '<html></html>');

        const r = run(sc, proposeArgs(sc));

        expect(r.status, JSON.stringify(r.json)).toBe(0);
        expect(r.json.ok).toBe(true);
    });

    it('binding_theSideDoorRouteNeedsNoEvaluationAndSoNoBinding', () => {
        const sc = makeScenario({ quality: null, candidate: { 'references/guide.md': GUIDE_MD.replace('occured', 'occurred') } });

        const r = run(sc, proposeArgs(sc, ['--route', 'side-door']));

        expect(r.status, r.stderr).toBe(0);
    });

    it('binding_theHashPrintedByProposeIsTheOneBoundByTheEvaluation', () => {
        const sc = makeScenario();
        const bound = JSON.parse(fs.readFileSync(path.join(sc.ws, 'iteration-1', 'binding.json'), 'utf8'));

        const r = run(sc, proposeArgs(sc));

        expect(r.json.candidateSha256).toBe(bound.candidateSha256);
        expect(r.json.candidateSha256).toBe(candidatePin(sc.ws));
        expect(r.json.snapshotSha256).toBe(bound.snapshotSha256);
    });
});

describe('bind: write the binding right after the evaluation', () => {
    function unbound() {
        const sc = makeScenario({ quality: null });
        buildIteration(path.join(sc.ws, 'iteration-1'), 'accept');
        buildIteration(path.join(sc.ws, 'holdout', 'iteration-1'), 'accept');
        return sc;
    }

    it('bind_writesTheCandidateAndSnapshotHashesIntoTheHighestIteration', () => {
        const sc = unbound();

        const r = run(sc, ['--run', sc.ws], { verb: 'bind' });

        expect(r.status, JSON.stringify(r.json)).toBe(0);
        expect(r.json).toMatchObject({ ok: true, bound: true, iteration: 'iteration-1', alreadyBound: false });
        const file = JSON.parse(fs.readFileSync(path.join(sc.ws, 'iteration-1', 'binding.json'), 'utf8'));
        expect(file).toEqual({
            version: 2, iteration: 'iteration-1', candidateSha256: candidatePin(sc.ws), snapshotSha256: treeSha(path.join(sc.ws, 'skill-snapshot')),
            gradings: gradingFiles(sc.ws),
        });
        // Both iterations' evidence is in it, sorted by path: 2 evals x 2 arms x 3 runs of gradings plus the benchmark, twice.
        const keys = Object.keys(file.gradings);
        expect(keys).toHaveLength(26);
        expect(keys).toContain('iteration-1/benchmark.json');
        expect(keys).toContain('holdout/iteration-1/benchmark.json');
        expect(keys).toEqual([...keys].sort());
        expect(r.json.candidateSha256).toBe(file.candidateSha256);
    });

    it('bind_aGradingEditedAfterTheFirstBind_isRefusedBecauseABindingIsWriteOnce', () => {
        const sc = unbound();
        run(sc, ['--run', sc.ws], { verb: 'bind' });
        const first = fs.readFileSync(path.join(sc.ws, 'iteration-1', 'binding.json'), 'utf8');
        put(sc.ws, 'iteration-1/eval-0-e0/with_skill/run-1/grading.json', JSON.stringify({ expectations: [{ text: 'assertion 0', passed: false, evidence: 'forged' }] }));

        const r = run(sc, ['--run', sc.ws], { verb: 'bind' });

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, bound: false, failedStep: 'binding' });
        expect(r.json.reason).toMatch(/already bound to different grading evidence/);
        expect(r.json.reason).toContain('iteration-1/eval-0-e0/with_skill/run-1/grading.json was edited');
        expect(fs.readFileSync(path.join(sc.ws, 'iteration-1', 'binding.json'), 'utf8')).toBe(first);
    });

    it('bind_anOldShapeBindingForTheSameCandidateIsNeverUpgraded', () => {
        const sc = unbound();
        run(sc, ['--run', sc.ws], { verb: 'bind' });
        const file = path.join(sc.ws, 'iteration-1', 'binding.json');
        const { gradings, ...old } = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, `${JSON.stringify({ ...old, version: 1 }, null, 2)}\n`);
        const before = fs.readFileSync(file, 'utf8');

        const r = run(sc, ['--run', sc.ws], { verb: 'bind' });

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('binding');
        expect(r.json.reason).toMatch(/without grading hashes/);
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
    });

    it('bind_aSymlinkedGradingFile_isRefusedAndNothingIsWritten', () => {
        const sc = unbound();
        const gradingFile = path.join(sc.ws, 'holdout', 'iteration-1', 'eval-0-e0', 'with_skill', 'run-1', 'grading.json');
        const target = path.join(sc.repo.base, 'grading-copy.json');
        fs.copyFileSync(gradingFile, target);
        fs.rmSync(gradingFile);
        try {
            fs.symlinkSync(target, gradingFile);
        } catch {
            return; // the OS refuses symlinks here: nothing to test
        }

        const r = run(sc, ['--run', sc.ws], { verb: 'bind' });

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, bound: false, failedStep: 'binding' });
        expect(r.json.reason).toMatch(/symbolic link/);
        expect(fs.existsSync(path.join(sc.ws, 'iteration-1', 'binding.json'))).toBe(false);
    });

    it('bind_twiceForTheSameHashes_isANoOp', () => {
        const sc = unbound();
        run(sc, ['--run', sc.ws], { verb: 'bind' });
        const first = fs.readFileSync(path.join(sc.ws, 'iteration-1', 'binding.json'), 'utf8');

        const r = run(sc, ['--run', sc.ws], { verb: 'bind' });

        expect(r.status).toBe(0);
        expect(r.json.alreadyBound).toBe(true);
        expect(fs.readFileSync(path.join(sc.ws, 'iteration-1', 'binding.json'), 'utf8')).toBe(first);
    });

    it('bind_aCandidateFileNewerThanTheAggregatedBenchmark_isRefusedAndNothingIsWritten', () => {
        const sc = unbound();
        const file = path.join(sc.ws, 'candidate', 'SKILL.md');
        fs.writeFileSync(file, `${withExtraRule(SKILL_MD)}\nEdited after the evaluation.\n`);
        const future = new Date(Date.now() + 60000);
        fs.utimesSync(file, future, future);

        const r = run(sc, ['--run', sc.ws], { verb: 'bind' });

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, bound: false, failedStep: 'binding' });
        expect(r.json.reason).toMatch(/SKILL\.md/);
        expect(fs.existsSync(path.join(sc.ws, 'iteration-1', 'binding.json'))).toBe(false);
    });

    it('bind_aSnapshotFileNewerThanTheAggregatedBenchmark_isRefused', () => {
        const sc = unbound();
        const file = path.join(sc.ws, 'skill-snapshot', 'SKILL.md');
        const future = new Date(Date.now() + 60000);
        fs.utimesSync(file, future, future);

        const r = run(sc, ['--run', sc.ws], { verb: 'bind' });

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('binding');
    });

    it('bind_isWriteOnce_aDifferentCandidateIsNeverRebound', () => {
        const sc = unbound();
        run(sc, ['--run', sc.ws], { verb: 'bind' });
        const first = fs.readFileSync(path.join(sc.ws, 'iteration-1', 'binding.json'), 'utf8');
        const file = path.join(sc.ws, 'candidate', 'SKILL.md');
        fs.writeFileSync(file, `${withExtraRule(SKILL_MD)}\nA different candidate.\n`);
        const old = new Date(Date.now() - 600000);
        fs.utimesSync(file, old, old); // older than the benchmark: only the write-once rule can refuse it

        const r = run(sc, ['--run', sc.ws], { verb: 'bind' });

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('binding');
        expect(r.json.reason).toMatch(/already bound/);
        expect(fs.readFileSync(path.join(sc.ws, 'iteration-1', 'binding.json'), 'utf8')).toBe(first);
    });

    it('bind_goesToTheHighestIterationOnly_andARunWithoutOneIsInvalidInput', () => {
        const sc = unbound();
        buildIteration(path.join(sc.ws, 'iteration-2'), 'accept');

        const older = run(sc, ['--run', sc.ws, '--iteration', path.join(sc.ws, 'iteration-1')], { verb: 'bind' });
        const latest = run(sc, ['--run', sc.ws], { verb: 'bind' });
        const none = makeScenario({ quality: null });
        const missing = run(none, ['--run', none.ws], { verb: 'bind' });

        expect(older.status).toBe(2);
        expect(latest.json.iteration).toBe('iteration-2');
        expect(fs.existsSync(path.join(sc.ws, 'iteration-1', 'binding.json'))).toBe(false);
        expect(missing.status).toBe(2);
        expect(missing.json.failedStep).toBe('input');
    });

    it.each([
        ['an unknown flag', (sc) => ['--run', sc.ws, '--mode', 'apply']],
        ['no --run', () => []],
        ['a positional argument', (sc) => ['alpha', '--run', sc.ws]],
    ])('bind_%s_exits2', (_n, build) => {
        const sc = unbound();

        const r = run(sc, build(sc), { verb: 'bind' });

        expect(r.status).toBe(2);
        expect(r.json.ok).toBe(false);
    });

    it('bind_throughTheSkillEvolutionCli_isTheSameVerb', () => {
        const sc = unbound();

        const r = run(sc, ['--run', sc.ws], { via: 'evolution', verb: 'bind' });

        expect(r.status, JSON.stringify(r.json)).toBe(0);
        expect(r.json.bound).toBe(true);
    });

    it('bind_thenApply_isTheDocumentedFlow', () => {
        const sc = unbound();
        run(sc, ['--run', sc.ws], { verb: 'bind' });

        const r = run(sc, applyArgs(sc));

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(r.json.applied).toBe(true);
    });
});

// ─── scope: protected set and the diff boundary ──────────────────────────────

describe('scope: a candidate may touch only the target skill, never the protected set', () => {
    it.each([
        'evals/evals.json',
        'holdout/case-1.json',
        '__tests__/alpha.test.js',
        'scripts/alpha.spec.js',
        'guardrail-rules.project.yaml',
    ])('scope_candidateTouching_%s_isRefusedWholeAndNothingIsApplied', (rel) => {
        const sc = makeScenario({ candidate: { 'SKILL.md': withExtraRule(SKILL_MD), [rel]: 'planted\n' } });
        const before = localState(sc.repo);

        const proposed = run(sc, proposeArgs(sc));
        const r = run(sc, applyArgs(sc));

        for (const x of [proposed, r]) {
            expect(x.status).toBe(1);
            expect(x.json).toMatchObject({ ok: false, applied: false, failedStep: 'scope' });
            expect(x.json.violations.map((v) => norm(v.path))).toContain(`.agents/skills/alpha/${rel}`);
        }
        expect(localState(sc.repo)).toEqual(before);
        expect(readJsonl(sc.repo.callLog)).toEqual([]);
    });

    it('scope_reservedTargetSkillCreator_isRefused', () => {
        const sc = makeScenario({ skill: 'skill-creator' });
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc));

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('scope');
        expect(localState(sc.repo)).toEqual(before);
    });

    it('scope_rulesMissingFromTheBaseCommit_failsClosed', () => {
        const sc = makeScenario({ repo: { rules: false } });
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc));

        expect(r.status).not.toBe(0);
        expect(r.json.ok).toBe(false);
        expect(r.json.applied).toBe(false);
        expect(r.json.failedStep).toBe('scope');
        expect(localState(sc.repo)).toEqual(before);
    });

    it.skipIf(!canSymlink)('scope_symlinkInTheCandidate_isRefusedAndNotFollowed', () => {
        const sc = makeScenario({ quality: null });
        const outside = path.join(sc.repo.base, 'outside-secret.md');
        fs.writeFileSync(outside, 'OUTSIDE CONTENT\n');
        fs.mkdirSync(path.join(sc.ws, 'candidate', 'references'), { recursive: true });
        fs.symlinkSync(outside, path.join(sc.ws, 'candidate', 'references', 'link.md'));
        // Evaluated WITH the link, so the binding holds and the scope check is what refuses it.
        buildIteration(path.join(sc.ws, 'iteration-1'), 'accept');
        buildIteration(path.join(sc.ws, 'holdout', 'iteration-1'), 'accept');
        const bound = bindWs(sc.ws);
        const before = localState(sc.repo);

        // the helper hashes a link by its target, so the pin is the hash the evaluation recorded
        const r = run(sc, applyArgs(sc, { pin: false, extra: ['--candidate-sha256', bound.candidateSha256] }));

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('scope');
        expect(localState(sc.repo)).toEqual(before);
    });

    it('scope_dirtyWorkingTree_isRefusedAndTheOthersWorkIsPreserved', () => {
        const sc = makeScenario();
        put(sc.repo.root, 'docs/someone-elses-work.md', 'work in progress\n');
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc));

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('dirty-tree');
        expect(fs.readFileSync(path.join(sc.repo.root, 'docs/someone-elses-work.md'), 'utf8')).toBe('work in progress\n');
        expect(localState(sc.repo)).toEqual(before);
    });

    it('scope_branchNameAlreadyExists_isRefusedAndTheBranchIsUntouched', () => {
        const sc = makeScenario();
        gitOut(sc.repo.root, 'branch', 'auto/x');
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc));

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('branch');
        expect(localState(sc.repo)).toEqual(before);
    });
});

// ─── the happy apply path ────────────────────────────────────────────────────

describe('apply: an accepted candidate lands as an uncommitted delta on a local auto branch', () => {
    it('apply_success_copiesRendersChecksGatesInOrderAndPrintsTheFilesToStage', () => {
        const sc = makeScenario();

        const r = run(sc, applyArgs(sc));

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(r.json).toMatchObject({ ok: true, mode: 'apply', route: 'verdict', applied: true, restored: false, branch: 'auto/x', base: sc.repo.baseSha });
        expect(fs.readFileSync(path.join(sc.repo.root, '.agents/skills/alpha/SKILL.md'), 'utf8')).toBe(sc.candidate['SKILL.md']);

        const calls = readJsonl(sc.repo.callLog).map((c) => ({ tool: c.tool, args: c.args.map(norm), cwd: c.cwd }));
        expect(calls.map((c) => c.tool)).toEqual(['render', 'render', 'skill-evolution', 'gate']);
        expect(calls[0].args).toEqual([]);
        expect(calls[1].args).toEqual(['--check']);
        expect(calls[2].args.slice(0, 2)).toEqual(['check', 'alpha']);
        expect(calls[2].args[2]).toMatch(/\.agents\/skills\/alpha\/SKILL\.md$/);
        expect(calls[3].args).toEqual(['test']);
        for (const c of calls) expect(c.cwd).toBe(sc.repo.root);

        const files = statusPaths(sc.repo.root);
        expect(files).toEqual(['.agents/render-state.json', '.agents/skills/alpha/SKILL.md', '.claude/skills/alpha/SKILL.md']);
        expect(r.json.files).toEqual(files);
        expect(r.json.snapshotSha256).toBe(r.json.canonicalSha256);
        expect(r.json.candidateSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('apply_success_neverCommitsNeverStagesAndLeavesTheNewBranchAtTheBase', () => {
        const sc = makeScenario();
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc, { branch: 'auto/skill-alpha-1' }));

        expect(r.status, r.stderr).toBe(0);
        const after = localState(sc.repo);
        expect(after.branch).toBe('auto/skill-alpha-1');
        expect(after.head).toBe(before.head);
        expect(after.commits).toBe(before.commits);
        expect(after.branches).toEqual(['refs/heads/auto/skill-alpha-1', 'refs/heads/main']);
        expect(after.cached).toBe('');
        expect(after.stash).toBe('');
        expect(gitOut(sc.repo.root, 'rev-parse', 'main')).toBe(sc.repo.baseSha);
    });

    it('apply_success_candidateOverlayWithAReference_copiesBothAndDeletesNothing', () => {
        const sc = makeScenario({ candidate: { 'SKILL.md': withExtraRule(SKILL_MD), 'references/extra.md': '# Extra\n' } });

        const r = run(sc, applyArgs(sc));

        expect(r.status, r.stderr).toBe(0);
        expect(fs.readFileSync(path.join(sc.repo.root, '.agents/skills/alpha/references/extra.md'), 'utf8')).toBe('# Extra\n');
        expect(fs.readFileSync(path.join(sc.repo.root, '.agents/skills/alpha/references/guide.md'), 'utf8')).toBe(GUIDE_MD);
        expect(r.json.files).toEqual(statusPaths(sc.repo.root));
    });
});

// ─── restore on any failure ──────────────────────────────────────────────────

describe('restore: any failure puts the tree back exactly', () => {
    const failures = [
        ['gateRed', { STUB_GATE: 'red' }, 'gate', ['render', 'render', 'skill-evolution', 'gate']],
        ['renderConflict', { STUB_RENDER: 'conflict' }, 'render', ['render']],
        ['renderCheckDrift', { STUB_RENDER_CHECK: 'drift' }, 'render-check', ['render', 'render']],
        ['conformanceFails', { STUB_CHECK: 'fail' }, 'conformance', ['render', 'render', 'skill-evolution']],
    ];

    it.each(failures)('restore_%s_restoresTheWholeTreeAndStopsAtTheFailingStep', (_name, env, step, tools) => {
        const sc = makeScenario();
        const before = localState(sc.repo);
        const remoteBefore = remoteState(sc.repo);

        const r = run(sc, applyArgs(sc), { env });

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, applied: false, restored: true, failedStep: step });
        expect(localState(sc.repo)).toEqual(before);
        expect(statusPaths(sc.repo.root)).toEqual([]);
        expect(readJsonl(sc.repo.callLog).map((c) => c.tool)).toEqual(tools);
        expect(remoteState(sc.repo)).toEqual(remoteBefore);
    });

    it('restore_gateRed_removesTheUntrackedFileAndTheScribbleTheGateLeft', () => {
        const sc = makeScenario();

        run(sc, applyArgs(sc), { env: { STUB_GATE: 'red' } });

        expect(fs.existsSync(path.join(sc.repo.root, 'docs', 'gate-junk.txt'))).toBe(false);
        expect(fs.readFileSync(path.join(sc.repo.root, '.agents/skills/alpha/references/guide.md'), 'utf8')).toBe(GUIDE_MD);
        expect(fs.readFileSync(path.join(sc.repo.root, '.claude/skills/alpha/SKILL.md'), 'utf8')).toBe(SKILL_MD);
    });

    it('restore_renderConflict_removesThePartialRenderAndTheConflictFile', () => {
        const sc = makeScenario();

        run(sc, applyArgs(sc), { env: { STUB_RENDER: 'conflict' } });

        expect(fs.existsSync(path.join(sc.repo.root, '.claude/skills/alpha/SKILL.md.conflict'))).toBe(false);
        expect(fs.readFileSync(path.join(sc.repo.root, '.claude/skills/alpha/SKILL.md'), 'utf8')).toBe(SKILL_MD);
        expect(fs.readFileSync(path.join(sc.repo.root, '.agents/skills/alpha/SKILL.md'), 'utf8')).toBe(SKILL_MD);
    });

    it('restore_afterAFailure_theCreatedBranchIsDeletedAndTheOriginalBranchIsCheckedOut', () => {
        const sc = makeScenario();

        run(sc, applyArgs(sc), { env: { STUB_GATE: 'red' } });

        expect(gitOut(sc.repo.root, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
        expect(git(sc.repo.root, 'rev-parse', '--verify', '--quiet', 'refs/heads/auto/x').status).not.toBe(0);
    });

    it('restore_aProtectedPathChangedByARenderStep_isRefusedAndRestored', () => {
        const sc = makeScenario();
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc), { env: { STUB_RENDER: 'tamper' } });

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, applied: false, restored: true, failedStep: 'scope' });
        expect(r.json.violations.map((v) => norm(v.path))).toContain('.agents/hooks/h.cjs');
        expect(localState(sc.repo)).toEqual(before);
    });

    it('restore_aRenderedCopyOutsideTheSkillDirectory_isNotAViolationOnTheSuccessPath', () => {
        const sc = makeScenario();

        const r = run(sc, applyArgs(sc));

        expect(r.status, r.stderr).toBe(0);
        expect(r.json.files).toContain('.claude/skills/alpha/SKILL.md');
        expect(r.json.violations ?? []).toEqual([]);
    });
});

// ─── byte-exact restore (SF-4.9 review M3, security m7) ──────────────────────

describe('restore is byte-exact or it does not say restored: true', () => {
    const GUIDE = '.agents/skills/alpha/references/guide.md';

    it('restore_anIgnoredFileTheCandidateOverlays_comesBackByteForByte', () => {
        const sc = makeScenario({
            candidate: { 'SKILL.md': withExtraRule(SKILL_MD), 'a.scratchnote': 'CANDIDATE NOTE\n' },
            prepare: (repo) => put(repo.root, '.agents/skills/alpha/a.scratchnote', 'MY LOCAL NOTES\n'),
        });
        const note = path.join(sc.repo.root, '.agents/skills/alpha/a.scratchnote');
        expect(git(sc.repo.root, 'check-ignore', '-q', '.agents/skills/alpha/a.scratchnote').status).toBe(0);

        const r = run(sc, applyArgs(sc), { env: { STUB_GATE: 'red' } });

        expect(r.json).toMatchObject({ ok: false, failedStep: 'gate', restored: true });
        expect(fs.readFileSync(note, 'utf8')).toBe('MY LOCAL NOTES\n');
        expect(statusPaths(sc.repo.root)).toEqual([]);
    });

    it('restore_anIgnoredFileThePipelineCreatesInASkillDirectory_isRemoved', () => {
        const sc = makeScenario({ candidate: { 'SKILL.md': withExtraRule(SKILL_MD), 'new.scratchnote': 'CANDIDATE NOTE\n' } });

        const r = run(sc, applyArgs(sc), { env: { STUB_GATE: 'red' } });

        expect(r.json).toMatchObject({ failedStep: 'gate', restored: true });
        expect(fs.existsSync(path.join(sc.repo.root, '.agents/skills/alpha/new.scratchnote'))).toBe(false);
    });

    it.each([
        ['assume-unchanged', '--assume-unchanged'],
        ['skip-worktree', '--skip-worktree'],
    ])('restore_aTrackedFileMarked_%s_isRefusedUpFrontAndTheLocalEditSurvives', (_n, flag) => {
        const sc = makeScenario({
            candidate: { 'references/guide.md': 'CANDIDATE GUIDE\n' },
            prepare: (repo) => {
                put(repo.root, GUIDE, 'MY LOCAL EDIT\n');
                gitOut(repo.root, 'update-index', flag, GUIDE);
            },
        });
        expect(statusPaths(sc.repo.root)).toEqual([]); // git status cannot see the edit: that is the hole
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc));

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, applied: false, restored: false, failedStep: 'dirty-tree' });
        expect(r.json.reason).toMatch(/assume-unchanged or skip-worktree/);
        expect(r.json.flagged).toEqual([GUIDE]);
        expect(fs.readFileSync(path.join(sc.repo.root, GUIDE), 'utf8')).toBe('MY LOCAL EDIT\n');
        expect(localState(sc.repo)).toEqual(before);
        expect(readJsonl(sc.repo.callLog)).toEqual([]);
    });

    it.skipIf(process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0))('restore_whenTheTreeCannotBePutBack_neverClaimsRestoredAndNamesTheFailure', () => {
        const sc = makeScenario();
        const references = path.join(sc.repo.root, '.agents/skills/alpha/references');

        try {
            const r = run(sc, applyArgs(sc), { env: { STUB_GATE: 'lock' } });

            expect(r.status).toBe(1);
            expect(r.json).toMatchObject({ ok: false, applied: false, restored: false, failedStep: 'restore', restoreFailedAfter: 'gate' });
            expect(r.json.reason).toMatch(/restore failed after gate/);
        } finally {
            fs.chmodSync(references, 0o755);
        }
    });

    it.skipIf(process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0))('restore_anIgnoredFileThatCannotBePutBack_isReportedNotClaimedAsRestored', () => {
        const sc = makeScenario({ prepare: (repo) => put(repo.root, '.agents/skills/alpha/notes/a.scratchnote', 'MY LOCAL NOTES\n') });
        const notes = path.join(sc.repo.root, '.agents/skills/alpha/notes');

        try {
            const r = run(sc, applyArgs(sc), { env: { STUB_GATE: 'lock-ignored' } });

            expect(statusPaths(sc.repo.root)).toEqual([]); // git sees nothing wrong: only the byte ledger knows
            expect(r.status).toBe(1);
            expect(r.json).toMatchObject({ ok: false, restored: false, failedStep: 'restore', restoreFailedAfter: 'gate' });
        } finally {
            fs.chmodSync(notes, 0o755);
        }
    });

    it('restore_theSkillDirectoryBytesAndModesAreVerifiedNotAssumed', () => {
        const sc = makeScenario();
        const before = liveFiles(sc.repo.root, 'alpha');

        run(sc, applyArgs(sc), { env: { STUB_GATE: 'red' } });

        const after = liveFiles(sc.repo.root, 'alpha');
        expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
        for (const [rel, buf] of Object.entries(before)) expect(after[rel].equals(buf), rel).toBe(true);
    });
});

// ─── the documented flow: the workspace lives under a tracked folder (SF-4.9 review M7) ──

describe('workspace: the documented flow builds it untracked under docs/.output/evolution/', () => {
    const WS_REL = 'docs/.output/evolution/skills/2026-11-18/alpha-workspace';
    const inWorkspace = (p) => p.startsWith(`${WS_REL}/`);

    it('workspace_underTheEvolutionCompartment_appliesAndTheWorkspaceIsNeitherBlockingNorPrinted', () => {
        const sc = makeScenario({ wsRel: WS_REL });
        expect(statusPaths(sc.repo.root).every(inWorkspace)).toBe(true);
        expect(statusPaths(sc.repo.root).length).toBeGreaterThan(0);
        const workspaceBefore = fileMap(sc.ws);

        const r = run(sc, applyArgs(sc));

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(r.json).toMatchObject({ ok: true, applied: true, branch: 'auto/x' });
        expect(r.json.files).toEqual(['.agents/render-state.json', '.agents/skills/alpha/SKILL.md', '.claude/skills/alpha/SKILL.md']);
        expect(statusPaths(sc.repo.root).filter((p) => !inWorkspace(p))).toEqual(r.json.files);
        expect(fileMap(sc.ws)).toEqual(workspaceBefore);
    });

    it('workspace_aFailedApplyRestoresTheTreeAndLeavesTheWorkspaceExactlyAsItWas', () => {
        const sc = makeScenario({ wsRel: WS_REL });
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc), { env: { STUB_GATE: 'red' } });

        expect(r.json).toMatchObject({ ok: false, failedStep: 'gate', restored: true });
        expect(localState(sc.repo)).toEqual(before);
        expect(fs.existsSync(path.join(sc.ws, 'candidate', 'SKILL.md'))).toBe(true);
        expect(fs.existsSync(path.join(sc.ws, 'iteration-1', 'binding.json'))).toBe(true);
    });

    it('workspace_someoneElsesUntrackedFileBesideTheWorkspace_stillBlocksTheApply', () => {
        const sc = makeScenario({ wsRel: WS_REL });
        put(sc.repo.root, 'docs/.output/evolution/skills/2026-11-18/someone-elses.md', 'work in progress\n');

        const r = run(sc, applyArgs(sc));

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('dirty-tree');
        expect(r.json.reason).toMatch(/someone-elses\.md/);
    });

    it('workspace_anIgnoredLocationWorksToo', () => {
        const sc = makeScenario({ wsRel: 'docs/.output/.state/work/2026-11-18/alpha-workspace' });

        const r = run(sc, applyArgs(sc));

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(r.json.files).toEqual(['.agents/render-state.json', '.agents/skills/alpha/SKILL.md', '.claude/skills/alpha/SKILL.md']);
    });

    it('workspace_anyOtherLocationInsideTheRepository_isRefusedBeforeAnythingHappens', () => {
        const sc = makeScenario({ wsRel: 'docs/loose-workspace' });
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc));

        expect(r.status).toBe(2);
        expect(r.json).toMatchObject({ ok: false, failedStep: 'input' });
        expect(r.json.reason).toMatch(/neither ignored by git nor under docs\/\.output\/evolution\//);
        expect(localState(sc.repo)).toEqual(before);
    });

    it('workspace_insideTheSkillDirectoryApplyWrites_isRefused', () => {
        const sc = makeScenario();
        const inside = path.join(sc.repo.root, '.agents/skills/alpha/_ws');
        fs.cpSync(sc.ws, inside, { recursive: true });

        const r = run(sc, ['alpha', '--run', inside, '--mode', 'apply', '--branch', 'auto/x', '--candidate-sha256', candidatePin(inside)]);

        expect(r.status).toBe(2);
        expect(r.json.failedStep).toBe('input');
        expect(r.json.reason).toMatch(/skill directory/);
    });

    it('workspace_proposeModeNeverCaresWhereItIs', () => {
        const sc = makeScenario({ wsRel: 'docs/loose-workspace' });

        const r = run(sc, proposeArgs(sc));

        expect(r.status, r.stderr).toBe(0);
    });
});

// ─── the post-gate check tolerates only what the gate writes (SF-4.9 review M8, security m8) ──

describe('finalScope: only the render outputs and the gate receipt, receipt history and ledger rows are tolerated', () => {
    const STATE = 'docs/.output/.state';
    const LEDGER = `${STATE}/telemetry/gate-failures.jsonl`;
    const read = (sc, rel) => fs.readFileSync(path.join(sc.repo.root, rel), 'utf8');

    it('finalScope_theGatesOwnReceiptHistoryAndAppendedLedgerRow_arePassed', () => {
        const sc = makeScenario({ prepare: (repo) => put(repo.root, LEDGER, '{"row":"one"}\n') });

        const r = run(sc, applyArgs(sc), { env: { STUB_GATE: 'receipt' } });

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(r.json.applied).toBe(true);
        expect(r.json.files).toEqual(['.agents/render-state.json', '.agents/skills/alpha/SKILL.md', '.claude/skills/alpha/SKILL.md']);
        expect(read(sc, LEDGER)).toBe('{"row":"one"}\n{"row":"appended by the gate"}\n');
    });

    it.each([
        ['the ship seal', 'seal', `${STATE}/telemetry/ship-seal.json`, 'ORIGINAL SEAL\n'],
        ['the freeze state', 'freeze', `${STATE}/freeze-state.json`, 'ORIGINAL FREEZE\n'],
        ['an ac-verify record', 'acverify', `${STATE}/telemetry/ac-verify/rec.json`, 'ORIGINAL RECORD\n'],
    ])('finalScope_aGateThatChanges_%s_isRefusedAndTheJudgeStateComesBack', (_n, mode, rel, original) => {
        const sc = makeScenario({ prepare: (repo) => put(repo.root, rel, original) });

        const r = run(sc, applyArgs(sc), { env: { STUB_GATE: mode } });

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, applied: false, restored: true, failedStep: 'scope' });
        expect(r.json.violations.map((v) => norm(v.path))).toContain(rel);
        expect(read(sc, rel)).toBe(original);
        expect(statusPaths(sc.repo.root)).toEqual([]);
        expect(gitOut(sc.repo.root, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    });

    it('finalScope_aGateThatCreatesJudgeStateThatDidNotExist_isRefusedAndTheFileIsRemoved', () => {
        const sc = makeScenario();

        const r = run(sc, applyArgs(sc), { env: { STUB_GATE: 'seal' } });

        expect(r.json).toMatchObject({ ok: false, restored: true, failedStep: 'scope' });
        expect(fs.existsSync(path.join(sc.repo.root, `${STATE}/telemetry/ship-seal.json`))).toBe(false);
    });

    it('finalScope_aGateThatRewritesTheFailureLedger_isRefused_butAnAppendIsNot', () => {
        const sc = makeScenario({ prepare: (repo) => put(repo.root, LEDGER, '{"row":"one"}\n{"row":"two"}\n') });

        const r = run(sc, applyArgs(sc), { env: { STUB_GATE: 'ledger-rewrite' } });

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, restored: true, failedStep: 'scope' });
        expect(r.json.violations.map((v) => norm(v.path))).toContain(LEDGER);
    });

    it('finalScope_aGateThatEditsAnyOtherTrackedFile_isRefusedAndTheFileComesBack', () => {
        const sc = makeScenario();

        const r = run(sc, applyArgs(sc), { env: { STUB_GATE: 'tracked' } });

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, applied: false, restored: true, failedStep: 'scope' });
        expect(r.json.violations.map((v) => norm(v.path))).toContain('docs/notes.md');
        expect(read(sc, 'docs/notes.md')).toBe('notes\n');
        expect(statusPaths(sc.repo.root)).toEqual([]);
    });

    it('finalScope_aGateThatWritesANewFileOutsideTheRenderOutputs_isRefusedAndTheFileIsRemoved', () => {
        const sc = makeScenario();

        const r = run(sc, applyArgs(sc), { env: { STUB_GATE: 'untracked' } });

        expect(r.json).toMatchObject({ ok: false, restored: true, failedStep: 'scope' });
        expect(r.json.violations.map((v) => norm(v.path))).toContain('tools/helper.txt');
        expect(fs.existsSync(path.join(sc.repo.root, 'tools/helper.txt'))).toBe(false);
    });

    it('finalScope_aRenderThatWritesAStrayFileBesideItsOutputs_isRefusedAndTheFileIsRemoved', () => {
        const sc = makeScenario();

        const r = run(sc, applyArgs(sc), { env: { STUB_RENDER: 'stray' } });

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, restored: true, failedStep: 'scope' });
        expect(r.json.violations.map((v) => norm(v.path))).toContain('.claude/stray/notes.txt');
        expect(fs.existsSync(path.join(sc.repo.root, '.claude/stray'))).toBe(false);
    });
});

// ─── the helper's children never inherit a caller's git redirects (security n2) ──

describe('environment: render, check and gate run with the same git redirect filter the helper uses', () => {
    it('environment_gitRedirectsInTheCallersEnvironment_neverReachTheRenderStep', () => {
        const sc = makeScenario();

        const r = run(sc, applyArgs(sc), { env: { GIT_WORK_TREE: path.join(sc.repo.base, 'elsewhere'), GIT_DIR: path.join(sc.repo.base, 'elsewhere', '.git') } });

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        const renders = readJsonl(sc.repo.callLog).filter((c) => c.tool === 'render');
        expect(renders.length).toBe(2);
        for (const c of renders) expect([c.gitWorkTree, c.gitDir]).toEqual([null, null]);
    });
});

// ─── trusted copy and the baseline ───────────────────────────────────────────

describe('trustedCopy: the judge runs from the base commit, the baseline predates the change', () => {
    function applyAndScopeCalls() {
        const sc = makeScenario();
        const original = sha256(SKILL_MD);
        const candidate = sha256(sc.candidate['SKILL.md']);
        const r = run(sc, applyArgs(sc));
        expect(r.status, r.stderr).toBe(0);
        return { sc, calls: readJsonl(sc.repo.scopeLog), original, candidate };
    }

    it('trustedCopy_snapshotRunsBeforeTheChangeAndCheckRunsAfterTheCopy', () => {
        const { calls, original, candidate } = applyAndScopeCalls();

        const snapshotIdx = calls.findIndex((c) => c.verb === 'snapshot');
        const firstCheckIdx = calls.findIndex((c) => c.verb === 'check');

        expect(snapshotIdx).toBeGreaterThanOrEqual(0);
        expect(firstCheckIdx).toBeGreaterThan(snapshotIdx);
        expect(calls[snapshotIdx].alphaSha).toBe(original);
        expect(calls[firstCheckIdx].alphaSha).toBe(candidate);
    });

    it('trustedCopy_everyJudgeRunIsAnExtractedBaseCopyOutsideTheRepoAndTheToolkit_removedAfterwards', () => {
        const { sc, calls } = applyAndScopeCalls();

        expect(calls.length).toBeGreaterThanOrEqual(2);
        for (const c of calls) {
            const file = norm(c.file);
            expect(path.basename(file)).toBe('improvement-scope.js');
            expect(file.startsWith(`${norm(sc.repo.root)}/`)).toBe(false);
            expect(file.startsWith(`${norm(REPO_ROOT)}/`)).toBe(false);
            expect(fs.existsSync(c.file)).toBe(false);
        }
    });

    it('trustedCopy_flagsCarryTheFullShaTheRootTheTargetAndAnOutOfRepoBaseline', () => {
        const { sc, calls } = applyAndScopeCalls();

        const snap = calls.find((c) => c.verb === 'snapshot');
        const out = flagValue(snap.args, '--out');
        expect(flagValue(snap.args, '--base')).toBe(sc.repo.baseSha);
        expect(sc.repo.baseSha).toMatch(/^[0-9a-f]{40}$/);
        expect(norm(flagValue(snap.args, '--root'))).toBe(norm(sc.repo.root));
        expect(norm(path.resolve(out)).startsWith(`${norm(sc.repo.root)}/`)).toBe(false);
        for (const c of calls.filter((x) => x.verb === 'check')) {
            expect(flagValue(c.args, '--base')).toBe(sc.repo.baseSha);
            expect(flagValue(c.args, '--target')).toBe('alpha');
            expect(norm(flagValue(c.args, '--root'))).toBe(norm(sc.repo.root));
            expect(flagValue(c.args, '--baseline')).toBe(out);
        }
    });
});

// ─── never touches a remote ──────────────────────────────────────────────────

describe('remote: nothing is pushed, fetched or configured', () => {
    it.each([
        ['success', {}, 0],
        ['gate failure', { STUB_GATE: 'red' }, 1],
        ['render conflict', { STUB_RENDER: 'conflict' }, 1],
    ])('remote_%s_leavesTheBareRemoteTheTrackingRefsTheConfigAndTheTrapUntouched', (_n, env, status) => {
        const sc = makeScenario();
        const before = remoteState(sc.repo);

        const r = run(sc, applyArgs(sc), { env });

        expect(r.status).toBe(status);
        expect(remoteState(sc.repo)).toEqual(before);
        expect(before.trap).toBe('');
        expect(git(sc.repo.root, 'config', '--get', 'branch.auto/x.remote').status).not.toBe(0);
    });

    it('remote_proposeAndRefusedRuns_leaveTheRemoteUntouchedToo', () => {
        const sc = makeScenario({ quality: 'reject' });
        const before = remoteState(sc.repo);

        run(sc, proposeArgs(sc));
        run(sc, applyArgs(sc));

        expect(remoteState(sc.repo)).toEqual(before);
    });
});

// ─── side-door route ─────────────────────────────────────────────────────────

describe('sideDoor: typo, stale-pointer and pinned-text fixes may skip the verdict; behavior edits may not', () => {
    const TYPO = { 'references/guide.md': GUIDE_MD.replace('occured', 'occurred') };

    it('sideDoor_typoFixWithNoIterationAtAll_appliesThroughTheSameGuards', () => {
        const sc = makeScenario({ quality: null, candidate: TYPO });

        const r = run(sc, applyArgs(sc, { extra: ['--route', 'side-door'] }));

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(r.json).toMatchObject({ ok: true, route: 'side-door', applied: true, kinds: ['typo'] });
        expect(r.json.verdict ?? null).toBeNull();
        expect(fs.readFileSync(path.join(sc.repo.root, '.agents/skills/alpha/references/guide.md'), 'utf8')).toBe(TYPO['references/guide.md']);
        expect(readJsonl(sc.repo.callLog).map((c) => c.tool)).toEqual(['render', 'render', 'skill-evolution', 'gate']);
        expect(r.json.files).toEqual(statusPaths(sc.repo.root));
    });

    it('sideDoor_staleSkillPointerWhoseNewTargetExists_appliesAsStalePointer', () => {
        const fixed = SKILL_MD.replace('.claude/core/old-gate.js', '.agents/core/gate.js');
        const sc = makeScenario({ quality: null, candidate: { 'SKILL.md': fixed } });

        const r = run(sc, applyArgs(sc, { extra: ['--route', 'side-door'] }));

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(r.json.kinds).toEqual(['stale-pointer']);
    });

    it('sideDoor_staleSkillPointerWhoseNewTargetIsMissing_isRefused', () => {
        const wrong = SKILL_MD.replace('.claude/core/old-gate.js', '.agents/core/not-a-file.js');
        const sc = makeScenario({ quality: null, candidate: { 'SKILL.md': wrong } });
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc, { extra: ['--route', 'side-door'] }));

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('side-door');
        expect(localState(sc.repo)).toEqual(before);
    });

    // SF-4.9 review M5 / security m9: pinned text is vouched for by the BASE commit, never by the caller.
    describe('pinned text', () => {
        const PINNED = 'Never skip the gate.';
        const FIXED = { 'references/guide.md': GUIDE_MD.replace('Never  skip the gate', PINNED) };
        const GUIDE = '.agents/skills/alpha/references/guide.md';
        const commitAll = (repo, message) => {
            gitOut(repo.root, 'add', '-A');
            gitOut(repo.root, 'commit', '-q', '-m', message);
        };

        it('sideDoor_pinnedText_theNewLineIsInTheFilesOwnHistoryAtTheBaseCommit_applies', () => {
            const sc = makeScenario({
                quality: null,
                candidate: FIXED,
                prepare: (repo) => {
                    put(repo.root, GUIDE, FIXED['references/guide.md']);
                    commitAll(repo, 'the line as it was');
                    put(repo.root, GUIDE, GUIDE_MD);
                    commitAll(repo, 'someone double-spaced it');
                },
            });

            const r = run(sc, applyArgs(sc, { extra: ['--route', 'side-door'] }));

            expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
            expect(r.json.kinds).toEqual(['pinned-text']);
            expect(fs.readFileSync(path.join(sc.repo.root, GUIDE), 'utf8')).toBe(FIXED['references/guide.md']);
        });

        it('sideDoor_pinnedText_aTrackedTestAtTheBaseCommitHoldsTheLine_applies', () => {
            const sc = makeScenario({
                quality: null,
                candidate: FIXED,
                prepare: (repo) => {
                    put(repo.root, 'tests/guide-pins.test.js', `expect(guide).toContain('${PINNED}');\n`);
                    commitAll(repo, 'a test pins the line');
                },
            });

            const r = run(sc, applyArgs(sc, { extra: ['--route', 'side-door'] }));

            expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
            expect(r.json.kinds).toEqual(['pinned-text']);
        });

        it('sideDoor_pinnedText_aLineNoTrustedSourceHolds_isRefusedAndNothingChanges', () => {
            const sc = makeScenario({ quality: null, candidate: FIXED });
            const before = localState(sc.repo);

            const r = run(sc, applyArgs(sc, { extra: ['--route', 'side-door'] }));

            expect(r.status).toBe(1);
            expect(r.json).toMatchObject({ ok: false, applied: false, failedStep: 'side-door' });
            expect(localState(sc.repo)).toEqual(before);
        });

        it('sideDoor_pinnedText_aTestFileThatIsOnlyInTheWorkingTree_doesNotVouchForTheLine', () => {
            const sc = makeScenario({ quality: null, candidate: FIXED });
            put(sc.repo.root, 'tests/guide-pins.test.js', `expect(guide).toContain('${PINNED}');\n`);

            const r = run(sc, proposeArgs(sc, ['--route', 'side-door']));

            expect(r.status).toBe(1);
            expect(r.json.failedStep).toBe('side-door');
        });

        it('sideDoor_pinnedText_aNonTestFileHoldingTheLineIsNotAPin', () => {
            const sc = makeScenario({
                quality: null,
                candidate: FIXED,
                prepare: (repo) => {
                    put(repo.root, 'docs/quotes.md', `${PINNED}\n`);
                    commitAll(repo, 'a doc quotes the line');
                },
            });

            const r = run(sc, proposeArgs(sc, ['--route', 'side-door']));

            expect(r.status).toBe(1);
            expect(r.json.failedStep).toBe('side-door');
        });

        it('sideDoor_pinnedText_anUnterminatedProjectAdditionsMarker_isRefusedEvenWhenATestPinsIt', () => {
            const MARKER = '<!-- @@project-additions:end -->';
            const broken = `${GUIDE_MD}${MARKER}\n`;
            const sc = makeScenario({
                quality: null,
                candidate: { 'references/guide.md': `${GUIDE_MD}<!-- @@project-additions:end\n` },
                prepare: (repo) => {
                    put(repo.root, GUIDE, broken);
                    put(repo.root, 'tests/marker-pins.test.js', "expect(text).toContain('<!-- @@project-additions:end');\n");
                    commitAll(repo, 'a marker line and a test that mentions its prefix');
                },
            });
            const before = localState(sc.repo);

            const r = run(sc, applyArgs(sc, { extra: ['--route', 'side-door'] }));

            expect(r.status).toBe(1);
            expect(r.json).toMatchObject({ ok: false, applied: false, failedStep: 'side-door' });
            expect(localState(sc.repo)).toEqual(before);
        });

        it('sideDoor_pinnedText_theCallerCannotSupplyAList_theOldFlagIsAnUnknownFlag', () => {
            const sc = makeScenario({ quality: null, candidate: FIXED });
            const pinned = path.join(sc.repo.base, 'pinned.txt');
            fs.writeFileSync(pinned, `${PINNED}\n`);
            const before = localState(sc.repo);

            const r = run(sc, applyArgs(sc, { extra: ['--route', 'side-door', '--pinned', pinned] }));

            expect(r.status).toBe(2);
            expect(r.json).toMatchObject({ ok: false, failedStep: 'input' });
            expect(r.json.reason).toMatch(/unknown flag --pinned/);
            expect(localState(sc.repo)).toEqual(before);
        });
    });

    // SF-4.9 review M4 / security M7: a typo has to be a misspelling, proven by the skill corpus.
    describe('typo corpus', () => {
        const GUIDE = '.agents/skills/alpha/references/guide.md';
        const commitAll = (repo, message) => {
            gitOut(repo.root, 'add', '-A');
            gitOut(repo.root, 'commit', '-q', '-m', message);
        };

        it('sideDoor_typo_aWordThatReversesTheRule_isRefusedEvenThoughTheNewWordIsEstablished', () => {
            const withLine = `${GUIDE_MD}Compute the stamp once and reuse it.\n`;
            const sc = makeScenario({
                quality: null,
                candidate: { 'references/guide.md': withLine.replace('and reuse it', 'and refuse it') },
                prepare: (repo) => {
                    put(repo.root, GUIDE, withLine);
                    commitAll(repo, 'a rule about reuse');
                },
            });
            const before = localState(sc.repo);

            const r = run(sc, applyArgs(sc, { extra: ['--route', 'side-door'] }));

            expect(r.status).toBe(1);
            expect(r.json).toMatchObject({ ok: false, applied: false, failedStep: 'side-door' });
            expect(r.json.reason).toMatch(/reuse/);
            expect(localState(sc.repo)).toEqual(before);
        });

        it('sideDoor_typo_theSameMisspellingLeftElsewhere_isNotAFixOfAMisspelling', () => {
            const sc = makeScenario({
                quality: null,
                candidate: { 'references/guide.md': GUIDE_MD.replace('occured', 'occurred') },
                prepare: (repo) => {
                    put(repo.root, '.agents/skills/alpha/SKILL.md', `${SKILL_MD}The run occured once.\n`);
                    put(repo.root, '.claude/skills/alpha/SKILL.md', `${SKILL_MD}The run occured once.\n`);
                    commitAll(repo, 'the misspelling appears twice');
                },
            });

            const r = run(sc, proposeArgs(sc, ['--route', 'side-door']));

            expect(r.status).toBe(1);
            expect(r.json.failedStep).toBe('side-door');
            expect(r.json.reason).toMatch(/occured/);
        });

        it('sideDoor_typo_everyOccurrenceOfTheMisspellingFixedTogether_isExempt', () => {
            const skillMd = `${SKILL_MD}The run occured once.\n`;
            const sc = makeScenario({
                quality: null,
                candidate: { 'references/guide.md': GUIDE_MD.replace('occured', 'occurred'), 'SKILL.md': skillMd.replace('occured', 'occurred') },
                prepare: (repo) => {
                    put(repo.root, '.agents/skills/alpha/SKILL.md', skillMd);
                    put(repo.root, '.claude/skills/alpha/SKILL.md', skillMd);
                    commitAll(repo, 'the misspelling appears twice');
                },
            });

            const r = run(sc, proposeArgs(sc, ['--route', 'side-door']));

            expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
            expect(r.json.kinds).toEqual(['typo']);
        });
    });

    it.each([
        ['a new rule line', { 'SKILL.md': withExtraRule(SKILL_MD) }],
        ['a new reference file', { 'references/extra.md': '# Extra\n' }],
        ['a changed word', { 'references/guide.md': GUIDE_MD.replace('last run', 'first run') }],
    ])('sideDoor_%s_isABehaviorEditAndTheCodeRefusesTheSideDoor', (_n, candidate) => {
        const sc = makeScenario({ quality: null, candidate });
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc, { extra: ['--route', 'side-door'] }));

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, applied: false, failedStep: 'side-door' });
        expect(localState(sc.repo)).toEqual(before);
        expect(readJsonl(sc.repo.callLog)).toEqual([]);
    });

    it('sideDoor_proposeMode_reportsTheClassAndChangesNothing', () => {
        const sc = makeScenario({ quality: null, candidate: TYPO });
        const before = localState(sc.repo);

        const r = run(sc, proposeArgs(sc, ['--route', 'side-door']));

        expect(r.status, r.stderr).toBe(0);
        expect(r.json).toMatchObject({ ok: true, mode: 'propose', route: 'side-door', applied: false, kinds: ['typo'] });
        expect(localState(sc.repo)).toEqual(before);
    });

    it('sideDoor_typoFixOnTheDefaultRoute_stillNeedsAVerdictAndARejectWins', () => {
        const sc = makeScenario({ quality: 'reject', candidate: TYPO });

        const viaVerdict = run(sc, applyArgs(sc));
        const viaSideDoor = run(sc, applyArgs(sc, { extra: ['--route', 'side-door'] }));

        expect(viaVerdict.status).toBe(1);
        expect(viaVerdict.json.failedStep).toBe('verdict');
        expect(viaSideDoor.status, viaSideDoor.stderr).toBe(0);
    });

    it('sideDoor_stillFacesDrift_scopeAndTheGate', () => {
        const drifted = makeScenario({ quality: null, candidate: TYPO });
        put(drifted.repo.root, '.agents/skills/alpha/SKILL.md', `${SKILL_MD}\nlate edit\n`);
        gitOut(drifted.repo.root, 'add', '-A');
        gitOut(drifted.repo.root, 'commit', '-q', '-m', 'late edit');
        const protectedCandidate = makeScenario({ quality: null, candidate: { ...TYPO, 'evals/evals.json': 'The gate occured.\n' } });
        const red = makeScenario({ quality: null, candidate: TYPO });
        const redBefore = localState(red.repo);

        const d = run(drifted, applyArgs(drifted, { extra: ['--route', 'side-door'] }));
        const p = run(protectedCandidate, applyArgs(protectedCandidate, { extra: ['--route', 'side-door'] }));
        const g = run(red, applyArgs(red, { extra: ['--route', 'side-door'] }), { env: { STUB_GATE: 'red' } });

        expect(d.json.failedStep).toBe('drift');
        expect(p.json.failedStep).toBe('scope');
        expect(g.json).toMatchObject({ failedStep: 'gate', restored: true });
        expect(localState(red.repo)).toEqual(redBefore);
    });
});

// ─── idempotence ─────────────────────────────────────────────────────────────

describe('idempotence', () => {
    it('idempotence_proposeTwice_printsTheSameResultAndChangesNothing', () => {
        const sc = makeScenario();
        const before = localState(sc.repo);

        const a = run(sc, proposeArgs(sc));
        const b = run(sc, proposeArgs(sc));

        expect(b.json).toEqual(a.json);
        expect(localState(sc.repo)).toEqual(before);
    });

    it('idempotence_failedApplyTwice_failsTheSameWayBothTimesFromTheSameCleanState', () => {
        const sc = makeScenario();
        const before = localState(sc.repo);

        const a = run(sc, applyArgs(sc), { env: { STUB_GATE: 'red' } });
        const mid = localState(sc.repo);
        const b = run(sc, applyArgs(sc), { env: { STUB_GATE: 'red' } });

        expect([a.status, b.status]).toEqual([1, 1]);
        expect(b.json.failedStep).toBe(a.json.failedStep);
        expect(mid).toEqual(before);
        expect(localState(sc.repo)).toEqual(before);
    });

    it('idempotence_afterARestoredFailure_theSameBranchNameIsFreeAndTheRetrySucceeds', () => {
        const sc = makeScenario();

        const failed = run(sc, applyArgs(sc), { env: { STUB_GATE: 'red' } });
        const retried = run(sc, applyArgs(sc));

        expect(failed.status).toBe(1);
        expect(retried.status, retried.stderr).toBe(0);
        expect(gitOut(sc.repo.root, 'symbolic-ref', '--short', 'HEAD')).toBe('auto/x');
    });

    it('idempotence_reapplyingAnAlreadyCommittedCandidate_isRefusedAsDriftAndAddsNothing', () => {
        const sc = makeScenario();
        const first = run(sc, applyArgs(sc));
        expect(first.status, first.stderr).toBe(0);
        gitOut(sc.repo.root, 'add', '--', ...first.json.files);
        gitOut(sc.repo.root, 'commit', '-q', '-m', 'apply alpha');
        const before = localState(sc.repo);

        const second = run(sc, applyArgs(sc, { branch: 'auto/y' }));

        expect(second.status).toBe(1);
        expect(second.json).toMatchObject({ ok: false, applied: false, failedStep: 'drift' });
        expect(localState(sc.repo)).toEqual(before);
        expect(fs.readFileSync(path.join(sc.repo.root, '.agents/skills/alpha/SKILL.md'), 'utf8').match(/Rule three/g)).toHaveLength(1);
    });
});

// ─── the skill-evolution.js apply subcommand ─────────────────────────────────

describe('skill-evolution apply: the same contract through the existing CLI', () => {
    it('evolution_apply_acceptedCandidate_appliesWithTheSameJsonAndExitCode', () => {
        const sc = makeScenario();

        const r = run(sc, applyArgs(sc), { via: 'evolution' });

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(r.json).toMatchObject({ ok: true, mode: 'apply', applied: true, branch: 'auto/x' });
        expect(r.json.files).toEqual(statusPaths(sc.repo.root));
    });

    it('evolution_apply_gateRed_exits1AndRestores', () => {
        const sc = makeScenario();
        const before = localState(sc.repo);

        const r = run(sc, applyArgs(sc), { via: 'evolution', env: { STUB_GATE: 'red' } });

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('gate');
        expect(localState(sc.repo)).toEqual(before);
    });

    it('evolution_apply_badUsage_exits2', () => {
        const sc = makeScenario();

        const r = run(sc, ['alpha', '--run', sc.ws, '--mode', 'bogus'], { via: 'evolution' });

        expect(r.status).toBe(2);
        expect(r.json.failedStep).toBe('input');
    });

    it('evolution_usage_namesApply', () => {
        const r = spawnSync(process.execPath, [EVOLUTION], { encoding: 'utf8' });

        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/\bapply\b/);
    });
});

// ─── workflow wiring pins (the AC names these workflow strings; pinned, never edited here) ─────────────────

function section(file, startRe, endRe) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const start = text.search(startRe);
    if (start === -1) throw new Error(`section start ${startRe} not found in ${file}`);
    const rest = text.slice(start + 1);
    const end = rest.search(endRe);
    return end === -1 ? text.slice(start) : text.slice(start, start + 1 + end);
}

describe('wiring: workflows route behavior edits through the verdict path (Owner Decision 11)', () => {
    const exemptClasses = (s) => {
        expect(s).toMatch(/typo/i);
        expect(s).toMatch(/stale[- ]pointer/i);
        expect(s).toMatch(/pinned[- ]text/i);
    };

    it('wiring_evolveStep6_callsTheApplyHelperInsteadOfTheHandRunSequence', () => {
        const s = section('.agents/skills/review-evolve-skills/references/workflow.md', /^### Step 6/m, /^### Step 7/m);

        expect(s).toMatch(/skill-evolution\.js apply\s+<skill-name>\s+--run\s+\S+/);
        expect(s).toMatch(/--branch auto\//);
        expect(s).toMatch(/propose/i);
        expect(s).not.toMatch(/render-shared-agents\.js\s*\n\s*node \.claude\/core\/render-shared-agents\.js --check/);
    });

    it('wiring_sweepPhase3_routesSkillBehaviorEditsThroughVerdictAndNamesTheSideDoorClasses', () => {
        const s = section('.agents/skills/sweep/references/workflow.md', /^## Phase 3/m, /^## Phase 4/m);

        expect(s).toMatch(/skill-evolution\.js apply/);
        expect(s).toMatch(/verdict/);
        expect(s).toMatch(/--route side-door/);
        exemptClasses(s);
        const skillBullet = s.split('\n').find((l) => /^\s*-\s+`Skill:/.test(l));
        expect(skillBullet, 'the `Skill:` bullet must exist').toBeDefined();
        expect(skillBullet).toMatch(/verdict|skill-evolution\.js apply/);
    });

    it('wiring_retroStep65_routesSingleTargetSkillRecsThroughVerdictAndNamesTheSideDoorClasses', () => {
        const s = section('.agents/skills/retro/references/workflow.md', /^### 6\.5\./m, /^### 7\./m);

        expect(s).toMatch(/skill-evolution\.js apply/);
        expect(s).toMatch(/verdict/);
        expect(s).toMatch(/--route side-door/);
        exemptClasses(s);
        expect(s).not.toContain('- Single-target System Improvement recs (update this skill, add this agent step, fix this command line) are applied.');
    });

    it.each([
        ['.agents/skills/sweep/references/workflow.md', /^## Phase 3/m, /^## Phase 4/m],
        ['.agents/skills/retro/references/workflow.md', /^### 6\.5\./m, /^### 7\./m],
    ])('wiring_%s_staysProposeOnlyWithoutAnExplicitAuthorization', (file, start, end) => {
        const s = section(file, start, end);

        expect(s).toMatch(/propose/i);
        expect(s).toMatch(/auto\//);
    });

    // SF-4.9 review M5/M6/M7: the workflows describe the flow the helper actually runs.
    it('wiring_evolveStep5_bindsTheEvaluationAndNamesTheHoldoutWhereTheEvaluatorWritesIt', () => {
        const step5 = section('.agents/skills/review-evolve-skills/references/workflow.md', /^### Step 5/m, /^### Step 6/m);

        expect(step5).toMatch(/skill-evolution\.js bind --run <workspace>/);
        expect(step5).toMatch(/binding\.json/);
        expect(step5).toMatch(/--holdout <workspace>\/holdout\/iteration-1/);
        expect(fs.readFileSync(path.join(REPO_ROOT, '.agents/skills/review-evolve-skills/references/workflow.md'), 'utf8')).not.toContain('holdout-iteration');
    });

    it('wiring_evolveStep6_pinsTheCandidateHashRequiresTheBindingAndSaysWhereTheWorkspaceMayLive', () => {
        const s = section('.agents/skills/review-evolve-skills/references/workflow.md', /^### Step 6/m, /^### Step 7/m);

        expect(s).toMatch(/--mode apply --branch auto\/\S+ --candidate-sha256 \{candidateSha256/);
        expect(s).toMatch(/binding\.json/);
        expect(s).toMatch(/docs\/\.output\/evolution\//);
        expect(s).toMatch(/assume-unchanged or skip-worktree/);
        expect(s).toMatch(/failedStep: restore/);
        expect(s).not.toMatch(/--pinned/);
    });

    it.each([
        ['.agents/skills/sweep/references/workflow.md', /^## Phase 3/m, /^## Phase 4/m],
        ['.agents/skills/retro/references/workflow.md', /^### 6\.5\./m, /^### 7\./m],
    ])('wiring_%s_hasNoCallerSuppliedPinnedListAndPinsTheCandidateHashOnApply', (file, start, end) => {
        const s = section(file, start, end);

        expect(s).not.toMatch(/--pinned/);
        expect(s).toMatch(/--mode apply --branch auto\/\S+ --candidate-sha256 \{candidateSha256/);
    });

    it('wiring_sweepPhase3_runsTheSkillRowsBeforeTheMemoryWritesThatWouldDirtyTheTree', () => {
        const s = section('.agents/skills/sweep/references/workflow.md', /^## Phase 3/m, /^## Phase 4/m);

        const improvements = s.search(/^1\. System Improvements/m);
        const memory = s.search(/^2\. Memory extraction/m);

        expect(improvements).toBeGreaterThanOrEqual(0);
        expect(memory).toBeGreaterThan(improvements);
        expect(s).toMatch(/needs a clean one/);
    });

    it.each([
        '.agents/skills/review-evolve-skills/references/workflow.md',
        '.agents/skills/sweep/references/workflow.md',
        '.agents/skills/retro/references/workflow.md',
    ])('wiring_%s_documentsTheWorkspaceWhereTheHelperExcludesItFromTheCleanTreeCheck', (file) => {
        const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

        // the workspace of every documented flow sits under the compartment the helper leaves out of its clean-tree check
        expect(text).toMatch(/docs\/\.output\/evolution\/skills\/\{date\}\/(<skill>|\{skill\}|<skill-name>)-workspace\//);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// SF-4.10: the evolution ledger (deep tier: the audit trail of self-modification). Written first (TDD).
//
// PINNED CONTRACT. The implementer must match these names and shapes; the tests are the spec. The `status`, `watch` and
// graduation half of the story is pinned in skill-evolution.test.js (the second SF-4.10 header there); this file pins what
// `_lib/skill-apply.js` writes and what its CLI accepts.
//
// Ledger file: `docs/.output/evolution/skills/{date}/ledger.json` under the ROOT (the registered skills compartment).
//   {date} is `--date YYYY-MM-DD` (option `date`), default the LOCAL day of the run. The document is exactly
//   `{ "version": 1, "entries": [ <entry>, ... ] }`, entries in the order they were recorded.
//
// CONTRACT CHANGES made by the wave-L2 review fixes (the ledger is EVIDENCE, git is the proof; see the SF-4.10 review-fix blocks
// at the end of this file): the entry has an 18th key `delta_sha256`; `path` is exactly `.agents/skills/<skill>`; a commit is a 40-
// or 64-hex id; the lock and temporary files live in `docs/.output/.state/` (never in the date directory); the de-duplication
// skips only an entry that still waits for its commit; and `record-commit` refuses a commit that is not reachable from the
// repository's DEFAULT branch, whose diff on the skill's files is not exactly `delta_sha256`, or that another entry holds
// (so the record-commit tests below merge the apply branch into `main` first).
//
// Entry (the AC fields, plus `applied_at` and `change_class`, which the later bullets name): EXACTLY these 18 keys
//   skill            the skill directory name
//   path             `.agents/skills/<skill>`
//   evidence         string[] of evidence fingerprints (option `evidence`: a string "id,id" or an array; CLI `--evidence id,id`;
//                    default []); every id is non-empty with no whitespace and no `,`; anything else is an input error
//   candidate_sha256 the 64-hex tree hash of `candidate/` (the helper's `candidateSha256`); ALWAYS set
//   snapshot_sha256  the 64-hex tree hash of `skill-snapshot/` (the helper's `snapshotSha256`); ALWAYS set
//   delta_sha256     the 64-hex hash of the delta the candidate applies: for every candidate file that differs from the live skill,
//                    `<path>\0<sha256 of its content>\n` in code-unit order (a file byte-identical to the live one is no part of it)
//   benchmark        verdict route: the highest iteration's `benchmark.json`, repo-relative with forward slashes when the
//                    workspace is inside the root, else the absolute path; side-door route: null
//   delta, replicates, holdout_delta, fragile, tokens, duration_ms
//                    copied from the verdict the run actually ran: `delta`, `minRunsPerArm` (the replicates the evidence HAS,
//                    not the minimum asked for), `holdoutDelta`, `fragile`, `totals.tokens`, `totals.duration_ms`
//                    (`tokens` and `duration_ms` are `{with_skill, baseline}` objects). Every one is null when no verdict ran
//                    (side-door route, or a refusal before the verdict step); holdout_delta is also null with no holdout.
//   disposition      applied | dropped | staged | rejected, mapped from the result:
//                      ok and applied                          -> applied
//                      ok, propose mode                        -> staged
//                      failedStep 'lowpower'                   -> staged   (a low-power accept is proposed, never applied)
//                      failedStep 'verdict'                    -> rejected (reject, data-quality or holdout regression)
//                      failedStep 'ledger'                     -> nothing is recorded (the write itself failed)
//                      failedStep 'input'                      -> NOT recorded at all (nothing was decided; exit 2)
//                      every other failedStep (dirty-tree, branch, candidate-hash, drift, scope, side-door, copy, render,
//                      render-check, conformance, gate, restore) -> dropped
//   commit           null on every disposition except a later `record-commit` on an `applied` entry (below)
//   revert           `git revert <commit>` exactly when commit is set, else null (a command to READ; no code here runs it)
//   applied_at       an ISO-8601 UTC instant (`new Date().toISOString()`) taken when the apply succeeded; null unless applied
//   change_class     verdict route: `additive-reference` when EVERY file the candidate changes lies under `references/` and the
//                    candidate keeps every line of its live counterpart (new files count as additive), else `behavior`;
//                    side-door route: the classification kinds sorted and joined with `+` (`typo`, `stale-pointer`,
//                    `pinned-text`, `stale-pointer+typo`, ...); null when the side-door classification never ran
//
// Result JSON: a recorded run gains `ledger` (the repo-relative ledger path above). A run with nothing recorded has no `ledger`
//   key. The result carries NO per-call detail (no id, no `appended` flag), so a repeated identical run prints the identical
//   result (the existing idempotence pin `b.json toEqual a.json`). The printed `files` never lists the ledger.
//
// Write rules
//   - Written AFTER the pipeline and after any restore, so a restore never touches it: a failed apply neither deletes nor
//     rewrites the entries that were already there, tracked or untracked.
//   - The ledger path (any `docs/.output/evolution/skills/{date}/ledger.json`) is outside the clean-tree check, the scope
//     judgement and the restore, exactly like the workspace: an earlier run's ledger never blocks the next apply.
//   - Append-only: an existing entry is never edited, reordered or removed. The one permitted in-place change is
//     `record-commit` filling commit and revert from null, once.
//   - De-duplicated: an entry equal in (skill, candidate_sha256, snapshot_sha256, disposition) to the NEWEST entry of that
//     file is not appended again while that entry holds no commit (the same proposal run twice leaves one `staged` row); an
//     applied entry that already holds its commit is never a duplicate: a re-apply after a revert is a new application.
//   - Concurrent-safe: simultaneous writers (separate processes) each land exactly once; the file is always valid JSON; nothing
//     but `ledger.json` is ever in the date directory (the lock and the temporary file live in `docs/.output/.state/`).
//   - Fail closed: an existing ledger that is not a valid document is never overwritten (the write fails, bytes unchanged). A
//     ledger that cannot be written makes the run fail with failedStep 'ledger' and `ok: false`; an apply whose ledger cannot be
//     written is RESTORED (no unrecorded applied delta stays behind).
//
// Exports added to skill-apply.js. The existing pin `source_neverNamesTheGitVerb_commit` forbids the quoted string literal
//   'commit' anywhere in the module: build entries with object literals, and do not keep a quoted key list that holds it.
//   appendLedger({root, date, entry}) -> {ok: true, appended: boolean, file: <absolute path>}
//                                      | {ok: false, failedStep: 'input'|'ledger', reason}      (never throws)
//       `entry` must be a valid entry (exactly the 18 keys, a valid disposition, lower-case 64-hex hashes, an array of
//       evidence ids, commit/revert consistent as above, a commit only on `applied`, applied_at an ISO string iff `applied`);
//       an invalid entry, date or root is `input`, an unreadable or invalid EXISTING ledger or a failed write is `ledger`.
//   recordCommit({root, candidateSha256, commit, date?}) -> {ok: true, updated: boolean, ledger, revert} | {ok: false, failedStep, reason}
//       Finds the NEWEST `applied` entry whose candidate_sha256 matches and whose commit is null (scanning every date's ledger,
//       newest date first, or just `date`), and sets commit and `revert: git revert <commit>`. The same commit again is a
//       no-op `updated: false`; a different commit for an entry that already holds one is refused (write-once).
//   CLI verb (also `node skill-evolution.js record-commit ...`):
//       record-commit --candidate-sha256 <hex64> --commit <hex40> [--date YYYY-MM-DD] [--root <dir>]
//       prints one JSON object; exit 0 ok | 1 refused (no such applied entry, a different commit already recorded, the commit is
//       not a commit of this repository: failedStep 'record') | 2 invalid input (missing flag, unknown flag, a hash that is
//       not hex64 / hex40, a bad date)
//   `apply` gains `--date YYYY-MM-DD` and `--evidence id[,id...]`; `bind` is unchanged. A date is a REAL calendar date
//   (2026-02-30 is refused, with a reason that matches /--date must be a YYYY-MM-DD date/ on the CLI); an evidence problem names `--evidence`. skill-evolution.js usage text keeps
//   the prefix `intake|check|status|apply|bind` (the existing pin) and appends the new verbs.
//
// AC -> test names
//   AC1 "ledger_*", "dispositions_*", "appendLedger_*", "recordCommit_*", "spend_*", "changeClass_*"  (`status` lists it: skill-evolution.test.js)
//   Malformed input exits 2: "input_*", "appendLedger_invalid*", "recordCommit_malformed*";  idempotence: "dedupe_*"
//
// NOT COVERED: a failure of the `copy` step (no portable way to make the copy fail after the scope check); the `restore`
//   disposition runs on POSIX as a non-root user only; a writer killed while holding the ledger's lock (the lock design is the
//   implementer's: the pin is that nothing is left behind after a normal write); the Windows path.
// ═════════════════════════════════════════════════════════════════════════════

const { spawn: spawnAsync } = require('node:child_process');

const L_DATE = '2026-11-18';
const LEDGER_DIR_REL = (date = L_DATE) => `docs/.output/evolution/skills/${date}`;
const LEDGER_REL = (date = L_DATE) => `${LEDGER_DIR_REL(date)}/ledger.json`;
const LEDGER_KEYS = [
    'applied_at', 'benchmark', 'candidate_sha256', 'change_class', 'commit', 'delta', 'delta_sha256', 'disposition', 'duration_ms',
    'evidence', 'fragile', 'holdout_delta', 'path', 'replicates', 'revert', 'skill', 'snapshot_sha256', 'tokens',
];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX64 = /^[0-9a-f]{64}$/;

const readLedgerDoc = (root, date = L_DATE) => JSON.parse(fs.readFileSync(path.join(root, LEDGER_REL(date)), 'utf8'));
const ledgerEntries = (root, date = L_DATE) => readLedgerDoc(root, date).entries;
const ledgerBytes = (root, date = L_DATE) => fs.readFileSync(path.join(root, LEDGER_REL(date)), 'utf8');
const dateFlag = ['--date', L_DATE];
const proposeDated = (sc, extra = []) => proposeArgs(sc, [...dateFlag, ...extra]);
const applyDated = (sc, opts = {}) => applyArgs(sc, { ...opts, extra: [...dateFlag, ...(opts.extra || [])] });

/** The same verdict the helper judges, computed by skill-eval directly (never by the code under test). */
function independentVerdict(ws) {
    const holdout = path.join(ws, 'holdout', 'iteration-1');
    const args = ['verdict', path.join(ws, 'iteration-1'), ...(fs.existsSync(holdout) ? ['--holdout', holdout] : [])];
    const r = spawnSync(process.execPath, [EVAL, ...args], { encoding: 'utf8' });
    return JSON.parse(r.stdout);
}

/** Give every run of the dev iteration a timing.json, re-aggregate and re-bind: 2 evals x 3 runs per arm. */
function addTiming(sc) {
    const dir = path.join(sc.ws, 'iteration-1');
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || !/^eval-/.test(e.name)) continue;
        for (const [arm, tokens, ms] of [['with_skill', 1000, 2000], ['old_skill', 400, 900]]) {
            for (let r = 1; r <= 3; r++) put(path.join(dir, e.name, arm, `run-${r}`), 'timing.json', JSON.stringify({ total_tokens: tokens, duration_ms: ms }));
        }
    }
    const agg = spawnSync(process.execPath, [EVAL, 'aggregate', dir, '--skill-name', 'alpha', '--date', '2026-11-18'], { encoding: 'utf8' });
    if (agg.status !== 0) throw new Error(`fixture re-aggregate failed (${agg.status}): ${agg.stderr}`);
    rebindWs(sc.ws);
}

const hexOf = (seed) => crypto.createHash('sha256').update(String(seed)).digest('hex');
/** The delta hash by its documented definition, never by the code under test: changed candidate files only, path NUL content-sha256. */
function expectedDeltaHash(sc) {
    const rows = [];
    for (const [rel, text] of Object.entries(sc.candidate)) {
        const bytes = Buffer.from(text);
        if (sc.live[rel] !== undefined && Buffer.from(sc.live[rel]).equals(bytes)) continue;
        rows.push([rel, sha256(bytes)]);
    }
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const h = crypto.createHash('sha256');
    for (const [rel, digest] of rows) h.update(`${rel}\0${digest}\n`);
    return h.digest('hex');
}
const validEntry = (over = {}) => ({
    skill: 'alpha',
    path: '.agents/skills/alpha',
    evidence: ['fp-1'],
    candidate_sha256: hexOf('candidate'),
    snapshot_sha256: hexOf('snapshot'),
    delta_sha256: hexOf('delta'),
    benchmark: '/ws/iteration-1/benchmark.json',
    delta: 0.5,
    replicates: 3,
    holdout_delta: 0.25,
    fragile: false,
    tokens: { with_skill: 10, baseline: 5 },
    duration_ms: { with_skill: 20, baseline: 10 },
    disposition: 'staged',
    commit: null,
    revert: null,
    applied_at: null,
    change_class: 'behavior',
    ...over,
});
/** A ledger-blocking fixture: the date directory's path is an ignored regular file, so the tree stays clean but nothing can be written there. */
const blockTheLedgerDirectory = (repo) => {
    put(repo.root, '.gitignore', `docs/.output/.state/\n*.scratchnote\n${LEDGER_DIR_REL()}\n`);
    gitOut(repo.root, 'add', '-A');
    gitOut(repo.root, 'commit', '-q', '-m', 'ignore the blocker');
    put(repo.root, LEDGER_DIR_REL(), 'a file where the date directory has to be\n');
};

describe('SF-4.10 ledger: an applied run records every field the AC lists, exactly', () => {
    it('ledger_appliedRun_writesTheExactKeysWithTheIndependentlyComputedEvidence', () => {
        const sc = makeScenario();
        const verdict = independentVerdict(sc.ws);
        const t0 = Date.now();

        const r = run(sc, applyDated(sc, { extra: ['--evidence', 'fp-a,fp-b'] }));

        const t1 = Date.now();
        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(r.json.ledger).toBe(LEDGER_REL());
        const doc = readLedgerDoc(sc.repo.root);
        expect(Object.keys(doc).sort()).toEqual(['entries', 'version']);
        expect(doc.version).toBe(1);
        expect(doc.entries).toHaveLength(1);
        const e = doc.entries[0];
        expect(Object.keys(e).sort()).toEqual(LEDGER_KEYS);
        expect(e).toMatchObject({
            skill: 'alpha',
            path: '.agents/skills/alpha',
            evidence: ['fp-a', 'fp-b'],
            candidate_sha256: candidatePin(sc.ws),
            snapshot_sha256: treeSha(path.join(sc.ws, 'skill-snapshot')),
            benchmark: path.join(sc.ws, 'iteration-1', 'benchmark.json'),
            replicates: 3,
            disposition: 'applied',
            commit: null,
            revert: null,
            change_class: 'behavior',
        });
        expect(e.candidate_sha256).toMatch(HEX64);
        expect(e.snapshot_sha256).toMatch(HEX64);
        expect(e.delta_sha256).toBe(expectedDeltaHash(sc));
        expect(e.delta).toBe(verdict.delta);
        expect(e.delta).toBeGreaterThan(0);
        expect(e.holdout_delta).toBe(verdict.holdoutDelta);
        expect(e.holdout_delta).toBeGreaterThanOrEqual(0);
        expect(e.fragile).toBe(verdict.fragile);
        expect(e.tokens).toEqual(verdict.totals.tokens);
        expect(e.duration_ms).toEqual(verdict.totals.duration_ms);
        expect(e.applied_at).toMatch(ISO_UTC);
        expect(Date.parse(e.applied_at)).toBeGreaterThanOrEqual(t0);
        expect(Date.parse(e.applied_at)).toBeLessThanOrEqual(t1);
        expect(r.json.files).not.toContain(LEDGER_REL());
    });

    it('spend_tokensAndDurationsAreTheSummedTimingTotalsOfTheRuns_notZeroAndNotHandCopied', () => {
        const sc = makeScenario();
        addTiming(sc);
        const verdict = independentVerdict(sc.ws);
        expect(verdict.totals).toEqual({ tokens: { with_skill: 6000, baseline: 2400 }, duration_ms: { with_skill: 12000, baseline: 5400 } });

        const r = run(sc, proposeDated(sc));

        expect(r.status, r.stderr).toBe(0);
        const e = ledgerEntries(sc.repo.root)[0];
        expect(e.tokens).toEqual({ with_skill: 6000, baseline: 2400 });
        expect(e.duration_ms).toEqual({ with_skill: 12000, baseline: 5400 });
    });

    it('ledger_aWorkspaceInsideTheRepository_recordsTheBenchmarkPathRepoRelative', () => {
        const wsRel = `${LEDGER_DIR_REL()}/alpha-workspace`;
        const sc = makeScenario({ wsRel });

        const r = run(sc, proposeDated(sc));

        expect(r.status, r.stderr).toBe(0);
        expect(ledgerEntries(sc.repo.root)[0].benchmark).toBe(`${wsRel}/iteration-1/benchmark.json`);
    });

    it('ledger_sideDoorRun_hasNoBenchmarkAndNoVerdictFieldsAndRecordsTheKinds', () => {
        const sc = makeScenario({ quality: null, candidate: { 'references/guide.md': GUIDE_MD.replace('occured', 'occurred') } });

        const r = run(sc, proposeDated(sc, ['--route', 'side-door']));

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        const e = ledgerEntries(sc.repo.root)[0];
        expect(Object.keys(e).sort()).toEqual(LEDGER_KEYS);
        expect(e).toMatchObject({
            disposition: 'staged', benchmark: null, delta: null, replicates: null, holdout_delta: null, fragile: null,
            tokens: null, duration_ms: null, change_class: 'typo',
        });
        expect(e.candidate_sha256).toMatch(HEX64);
        expect(e.snapshot_sha256).toMatch(HEX64);
    });

    it('ledger_aRefusalBeforeTheVerdict_keepsTheHashesAndLeavesTheVerdictFieldsNull', () => {
        const sc = makeScenario();
        put(sc.repo.root, 'docs/someone-elses-work.md', 'work in progress\n');

        const r = run(sc, applyDated(sc));

        expect(r.json.failedStep).toBe('dirty-tree');
        const e = ledgerEntries(sc.repo.root)[0];
        expect(e).toMatchObject({
            disposition: 'dropped', delta: null, replicates: null, holdout_delta: null, fragile: null, tokens: null, duration_ms: null,
            commit: null, revert: null, applied_at: null, candidate_sha256: candidatePin(sc.ws), snapshot_sha256: treeSha(path.join(sc.ws, 'skill-snapshot')),
            benchmark: path.join(sc.ws, 'iteration-1', 'benchmark.json'),
        });
    });

    it('ledger_aGateFailureAfterAnAcceptedVerdict_stillCarriesThatVerdictsEvidence', () => {
        const sc = makeScenario();
        const verdict = independentVerdict(sc.ws);

        const r = run(sc, applyDated(sc), { env: { STUB_GATE: 'red' } });

        expect(r.json).toMatchObject({ failedStep: 'gate', restored: true });
        const e = ledgerEntries(sc.repo.root)[0];
        expect(e).toMatchObject({ disposition: 'dropped', delta: verdict.delta, holdout_delta: verdict.holdoutDelta, replicates: 3, applied_at: null });
    });

    it('ledger_aRejectedVerdict_recordsTheRejectingDeltaAndNeverAnAppliedAt', () => {
        const sc = makeScenario({ quality: 'reject' });
        const verdict = independentVerdict(sc.ws);

        const r = run(sc, applyDated(sc));

        expect(r.json.failedStep).toBe('verdict');
        const e = ledgerEntries(sc.repo.root)[0];
        expect(e).toMatchObject({ disposition: 'rejected', delta: verdict.delta, replicates: 3, applied_at: null, commit: null, revert: null });
        expect(e.delta).toBe(0);
    });

    it('ledger_dateDefaultsToTheLocalDayOfTheRun', () => {
        const sc = makeScenario();
        const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const before = day(new Date());

        const r = run(sc, proposeArgs(sc));

        const after = day(new Date());
        expect(r.status, r.stderr).toBe(0);
        expect([before, after]).toContain(r.json.ledger.split('/').at(-2));
        expect(r.json.ledger).toMatch(/^docs\/\.output\/evolution\/skills\/\d{4}-\d{2}-\d{2}\/ledger\.json$/);
        expect(fs.existsSync(path.join(sc.repo.root, r.json.ledger))).toBe(true);
    });

    it('ledger_theFlagsAreAcceptedThroughTheExistingSkillEvolutionCli', () => {
        const sc = makeScenario();

        const r = run(sc, proposeDated(sc, ['--evidence', 'fp-x']), { via: 'evolution' });

        expect(r.status, r.stderr).toBe(0);
        expect(r.json.ledger).toBe(LEDGER_REL());
        expect(ledgerEntries(sc.repo.root)[0].evidence).toEqual(['fp-x']);
    });
});

describe('SF-4.10 dispositions: every outcome the helper can reach is recorded, none is silently dropped', () => {
    const commitLive = (sc) => {
        put(sc.repo.root, '.agents/skills/alpha/SKILL.md', `${SKILL_MD}\nAn unreviewed rule.\n`);
        gitOut(sc.repo.root, 'add', '-A');
        gitOut(sc.repo.root, 'commit', '-q', '-m', 'someone edited the live skill');
    };
    // [name, scenario, mode, options, failedStep the run must report, disposition the ledger must hold]
    const table = [
        ['applied', () => makeScenario(), 'apply', {}, undefined, 'applied'],
        ['stagedByPropose', () => makeScenario(), 'propose', {}, undefined, 'staged'],
        ['stagedByLowPower', () => makeScenario({ quality: 'lowpower' }), 'apply', {}, 'lowpower', 'staged'],
        ['rejectedByVerdict', () => makeScenario({ quality: 'reject' }), 'apply', {}, 'verdict', 'rejected'],
        ['rejectedByHoldoutRegression', () => makeScenario({ holdout: 'regress' }), 'propose', {}, 'verdict', 'rejected'],
        ['droppedByDirtyTree', () => { const sc = makeScenario(); put(sc.repo.root, 'docs/x.md', 'dirty\n'); return sc; }, 'apply', {}, 'dirty-tree', 'dropped'],
        ['droppedByExistingBranch', () => { const sc = makeScenario(); gitOut(sc.repo.root, 'branch', 'auto/x'); return sc; }, 'apply', {}, 'branch', 'dropped'],
        ['droppedByCandidateEditedAfterEvaluation', () => { const sc = makeScenario(); put(sc.ws, 'candidate/SKILL.md', `${withExtraRule(SKILL_MD)}\nSneaked in.\n`); return sc; }, 'apply', {}, 'candidate-hash', 'dropped'],
        ['droppedByDrift', () => { const sc = makeScenario(); commitLive(sc); return sc; }, 'apply', {}, 'drift', 'dropped'],
        ['droppedByProtectedCandidatePath', () => makeScenario({ candidate: { 'SKILL.md': withExtraRule(SKILL_MD), 'evals/evals.json': 'planted\n' } }), 'apply', {}, 'scope', 'dropped'],
        ['droppedBySideDoorRefusal', () => makeScenario({ quality: null }), 'apply', { extra: ['--route', 'side-door'] }, 'side-door', 'dropped'],
        ['droppedByRenderConflict', () => makeScenario(), 'apply', { env: { STUB_RENDER: 'conflict' } }, 'render', 'dropped'],
        ['droppedByRenderCheckDrift', () => makeScenario(), 'apply', { env: { STUB_RENDER_CHECK: 'drift' } }, 'render-check', 'dropped'],
        ['droppedByConformance', () => makeScenario(), 'apply', { env: { STUB_CHECK: 'fail' } }, 'conformance', 'dropped'],
        ['droppedByGateRed', () => makeScenario(), 'apply', { env: { STUB_GATE: 'red' } }, 'gate', 'dropped'],
        ['droppedByFinalScopeViolation', () => makeScenario(), 'apply', { env: { STUB_RENDER: 'tamper' } }, 'scope', 'dropped'],
    ];

    it.each(table)('dispositions_%s_recordsExactlyOneEntryWithTheMappedDisposition', (_name, make, mode, opts, step, disposition) => {
        const sc = make();
        const args = mode === 'apply' ? applyDated(sc, { extra: opts.extra }) : proposeDated(sc, opts.extra);

        const r = run(sc, args, { env: opts.env || {} });

        expect(r.json.failedStep).toBe(step);
        expect(r.json.ledger).toBe(LEDGER_REL());
        const entries = ledgerEntries(sc.repo.root);
        expect(entries).toHaveLength(1);
        expect(entries[0].disposition).toBe(disposition);
        expect(Object.keys(entries[0]).sort()).toEqual(LEDGER_KEYS);
        expect(entries[0].skill).toBe('alpha');
        expect(entries[0].commit).toBeNull();
        expect(entries[0].revert).toBeNull();
        if (disposition === 'applied') expect(entries[0].applied_at).toMatch(ISO_UTC);
        else expect(entries[0].applied_at).toBeNull();
    });

    it.skipIf(process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0))('dispositions_droppedByARestoreThatCouldNotFinish_isStillRecorded', () => {
        const sc = makeScenario();
        const references = path.join(sc.repo.root, '.agents/skills/alpha/references');

        try {
            const r = run(sc, applyDated(sc), { env: { STUB_GATE: 'lock' } });

            expect(r.json).toMatchObject({ failedStep: 'restore', restored: false });
            const entries = ledgerEntries(sc.repo.root);
            expect(entries).toHaveLength(1);
            expect(entries[0].disposition).toBe('dropped');
        } finally {
            fs.chmodSync(references, 0o755);
        }
    });

    // [name, args, the reason the helper must give]. The reason must NOT be "unknown flag": the new flags have to be accepted first,
    // otherwise these would pass for the wrong reason before the feature exists.
    it.each([
        ['aMissingWorkspace', (sc) => ['alpha', '--date', L_DATE, '--root', sc.repo.root], /--run <workspace> is required/],
        ['anUnknownSkill', (sc) => ['zzz-no-such-skill', '--run', sc.ws, '--date', L_DATE, '--root', sc.repo.root], /unknown skill directory/],
        ['aNativeOnlyProjectSkill', (sc) => {
            fs.mkdirSync(path.join(sc.repo.root, '.claude', 'skills', 'native-only'), { recursive: true });
            fs.writeFileSync(path.join(sc.repo.root, '.claude', 'skills', 'native-only', 'SKILL.md'), '# Native only\n');
            return ['native-only', '--run', sc.ws, '--date', L_DATE, '--root', sc.repo.root];
        }, /\.claude\/skills\/native-only is a project-owned native-only skill.*direct edit/],
        ['aBadMode', (sc) => ['alpha', '--run', sc.ws, '--mode', 'bogus', '--date', L_DATE, '--root', sc.repo.root], /--mode must be one of/],
        ['aMalformedDate', (sc) => ['alpha', '--run', sc.ws, '--date', 'yesterday', '--root', sc.repo.root], /--date must be a YYYY-MM-DD date/],
        ['anImpossibleCalendarDate', (sc) => ['alpha', '--run', sc.ws, '--date', '2026-02-30', '--root', sc.repo.root], /--date must be a YYYY-MM-DD date/],
        ['aMalformedEvidenceId', (sc) => ['alpha', '--run', sc.ws, '--date', L_DATE, '--evidence', 'has space,ok', '--root', sc.repo.root], /--evidence/],
    ])('input_%s_exitsTwoWithTheRealReasonAndWritesNoLedger', (_name, argsOf, reason) => {
        const sc = makeScenario();

        const r = run(sc, argsOf(sc), { noRoot: true });

        expect(r.status).toBe(2);
        expect(r.json.failedStep).toBe('input');
        expect(r.json.reason).toMatch(reason);
        expect(r.json.reason).not.toMatch(/unknown flag/);
        expect(r.json.ledger).toBeUndefined();
        expect(fs.existsSync(path.join(sc.repo.root, 'docs/.output/evolution'))).toBe(false);
    });
});

describe('SF-4.10 change class: the graduation unit is recorded per entry', () => {
    const guideWithBullet = `${GUIDE_MD}A new bullet line.\n`;
    it.each([
        ['additiveReferenceFile', { candidate: { 'references/extra.md': '# Extra\n' } }, [], 'additive-reference'],
        ['additiveLinesInAnExistingReference', { candidate: { 'references/guide.md': guideWithBullet } }, [], 'additive-reference'],
        ['aChangedLineInAReference', { candidate: { 'references/guide.md': GUIDE_MD.replace('twice', 'thrice') } }, [], 'behavior'],
        ['aSkillMdEditEvenWhenItOnlyAddsALine', {}, [], 'behavior'],
        ['anAdditiveReferencePlusASkillMdEdit', { candidate: { 'SKILL.md': withExtraRule(SKILL_MD), 'references/extra.md': '# Extra\n' } }, [], 'behavior'],
        ['aSideDoorTypo', { quality: null, candidate: { 'references/guide.md': GUIDE_MD.replace('occured', 'occurred') } }, ['--route', 'side-door'], 'typo'],
        ['aSideDoorStalePointer', { quality: null, candidate: { 'SKILL.md': SKILL_MD.replace('.claude/core/old-gate.js', '.agents/core/gate.js') } }, ['--route', 'side-door'], 'stale-pointer'],
    ])('changeClass_%s_isRecordedAs_%s', (_name, scenario, extra, expected) => {
        const sc = makeScenario(scenario);

        const r = run(sc, proposeDated(sc, extra));

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(ledgerEntries(sc.repo.root)[0].change_class).toBe(expected);
    });
});

describe('SF-4.10 append-only: earlier entries survive every later run, restore included', () => {
    it('ledger_aSecondDispositionOfTheSameCandidate_appendsAndNeverReplaces', () => {
        const sc = makeScenario();

        const proposed = run(sc, proposeDated(sc));
        const staged = ledgerEntries(sc.repo.root)[0];
        const applied = run(sc, applyDated(sc));

        expect(proposed.status, proposed.stderr).toBe(0);
        expect(applied.status, `${applied.stderr}\n${JSON.stringify(applied.json)}`).toBe(0);
        const entries = ledgerEntries(sc.repo.root);
        expect(entries.map((e) => e.disposition)).toEqual(['staged', 'applied']);
        expect(entries[0]).toEqual(staged);
        expect(entries[0].candidate_sha256).toBe(entries[1].candidate_sha256);
    });

    it('ledger_afterAProposalTheUntrackedLedgerDoesNotBlockTheApplyAndIsNotPrinted', () => {
        const sc = makeScenario();
        run(sc, proposeDated(sc));
        expect(git(sc.repo.root, 'status', '--porcelain', '--untracked-files=all').stdout).toContain(LEDGER_REL());

        const r = run(sc, applyDated(sc));

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(r.json.failedStep).toBeUndefined();
        expect(r.json.files).toEqual(statusPaths(sc.repo.root));
        expect(r.json.files).not.toContain(LEDGER_REL());
    });

    it('ledger_anUntrackedRevertCandidateQueueDoesNotBlockTheApplyAndIsNotPrinted', () => {
        // `watch` writes docs/.output/evolution/skills/revert-candidates.json; like the ledger it is an audit record,
        // so an untracked queue never blocks the next apply (orchestrator fix, wave L2 ledger-integrity report item 4).
        const sc = makeScenario();
        const queue = 'docs/.output/evolution/skills/revert-candidates.json';
        fs.mkdirSync(path.dirname(path.join(sc.repo.root, queue)), { recursive: true });
        fs.writeFileSync(path.join(sc.repo.root, queue), JSON.stringify({ version: 1, candidates: [] }) + '\n');

        const r = run(sc, applyDated(sc));

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(r.json.failedStep).toBeUndefined();
        expect(r.json.files).not.toContain(queue);
        expect(fs.existsSync(path.join(sc.repo.root, queue))).toBe(true);
    });

    it('restore_aFailedApplyNeverDeletesOrRewritesTheEarlierUntrackedLedger', () => {
        const sc = makeScenario();
        run(sc, proposeDated(sc));
        const staged = readLedgerDoc(sc.repo.root).entries[0];
        const before = localState(sc.repo);

        const r = run(sc, applyDated(sc), { env: { STUB_GATE: 'red' } });

        expect(r.json).toMatchObject({ ok: false, failedStep: 'gate', restored: true });
        const entries = ledgerEntries(sc.repo.root);
        expect(entries.map((e) => e.disposition)).toEqual(['staged', 'dropped']);
        expect(entries[0]).toEqual(staged);
        expect(localState(sc.repo)).toEqual(before);
    });

    it('restore_aCommittedLedgerSurvivesAFailedApplyAndTheModifiedFileDoesNotBlockTheRetry', () => {
        const committed = validEntry({ candidate_sha256: hexOf('earlier-candidate'), disposition: 'rejected' });
        const sc = makeScenario({
            prepare: (repo) => {
                put(repo.root, LEDGER_REL(), `${JSON.stringify({ version: 1, entries: [committed] }, null, 2)}\n`);
                gitOut(repo.root, 'add', '-A');
                gitOut(repo.root, 'commit', '-q', '-m', 'an earlier ledger');
            },
        });
        const headLedger = gitOut(sc.repo.root, 'show', `HEAD:${LEDGER_REL()}`);

        const failed = run(sc, applyDated(sc), { env: { STUB_GATE: 'red' } });
        const retried = run(sc, applyDated(sc));

        expect(failed.json).toMatchObject({ failedStep: 'gate', restored: true });
        expect(retried.status, `${retried.stderr}\n${JSON.stringify(retried.json)}`).toBe(0);
        expect(retried.json.failedStep).toBeUndefined();
        const entries = ledgerEntries(sc.repo.root);
        expect(entries.map((e) => e.disposition)).toEqual(['rejected', 'dropped', 'applied']);
        expect(entries[0]).toEqual(committed);
        expect(gitOut(sc.repo.root, 'show', `HEAD:${LEDGER_REL()}`)).toBe(headLedger);
    });

    it('dedupe_theSameProposalRunTwice_leavesOneStagedEntry', () => {
        const sc = makeScenario();

        const a = run(sc, proposeDated(sc));
        const b = run(sc, proposeDated(sc));

        expect(b.json).toEqual(a.json);
        expect(ledgerEntries(sc.repo.root)).toHaveLength(1);
    });

    it('ledger_afterAnyWrite_theDateDirectoryHoldsOnlyTheLedger', () => {
        const sc = makeScenario();

        run(sc, proposeDated(sc));
        run(sc, applyDated(sc), { env: { STUB_GATE: 'red' } });

        expect(fs.readdirSync(path.join(sc.repo.root, LEDGER_DIR_REL()))).toEqual(['ledger.json']);
    });
});

describe('SF-4.10 fail closed: an audit trail that cannot be written or read is never papered over', () => {
    it('ledger_aProposalWhoseLedgerCannotBeWritten_failsWithTheLedgerStepAndExitsOne', () => {
        const sc = makeScenario({ prepare: blockTheLedgerDirectory });

        const r = run(sc, proposeDated(sc));

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, failedStep: 'ledger' });
        expect(r.json.reason).toMatch(/ledger/);
    });

    it('ledger_anApplyWhoseLedgerCannotBeWritten_isRestoredNotLeftApplied', () => {
        const sc = makeScenario({ prepare: blockTheLedgerDirectory });
        const before = localState(sc.repo);

        const r = run(sc, applyDated(sc));

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, applied: false, failedStep: 'ledger', restored: true });
        expect(localState(sc.repo)).toEqual(before);
        expect(git(sc.repo.root, 'rev-parse', '--verify', '--quiet', 'refs/heads/auto/x').status).not.toBe(0);
    });

    it('appendLedger_anExistingLedgerThatIsNotValidJson_isNeverOverwritten', () => {
        const root = tmpDir('ledger-corrupt-');
        put(root, LEDGER_REL(), '{ "version": 1, "entries": [ truncated');
        const bytes = ledgerBytes(root);

        const r = S.appendLedger({ root, date: L_DATE, entry: validEntry() });

        expect(r).toMatchObject({ ok: false, failedStep: 'ledger' });
        expect(ledgerBytes(root)).toBe(bytes);
    });

    it.each([
        ['aWrongVersion', { version: 2, entries: [] }],
        ['entriesNotAnArray', { version: 1, entries: {} }],
        ['anEntryMissingAKey', { version: 1, entries: [(() => { const e = validEntry(); delete e.fragile; return e; })()] }],
    ])('appendLedger_existingLedgerWith_%s_isRefusedAndLeftAlone', (_name, doc) => {
        const root = tmpDir('ledger-shape-');
        put(root, LEDGER_REL(), `${JSON.stringify(doc)}\n`);
        const bytes = ledgerBytes(root);

        const r = S.appendLedger({ root, date: L_DATE, entry: validEntry() });

        expect(r).toMatchObject({ ok: false, failedStep: 'ledger' });
        expect(ledgerBytes(root)).toBe(bytes);
    });
});

describe('SF-4.10 appendLedger: the writer itself', () => {
    const fresh = () => tmpDir('ledger-append-');

    it('appendLedger_firstEntry_createsTheVersionedDocumentAndReturnsTheFile', () => {
        const root = fresh();

        const r = S.appendLedger({ root, date: L_DATE, entry: validEntry() });

        expect(r).toEqual({ ok: true, appended: true, file: path.join(root, LEDGER_REL()) });
        expect(readLedgerDoc(root)).toEqual({ version: 1, entries: [validEntry()] });
    });

    it('appendLedger_secondEntry_keepsTheFirstByteForByteAndOrdersByRecording', () => {
        const root = fresh();
        const first = validEntry({ candidate_sha256: hexOf('one') });
        const second = validEntry({ candidate_sha256: hexOf('two'), disposition: 'rejected' });
        S.appendLedger({ root, date: L_DATE, entry: first });
        const firstJson = JSON.stringify(ledgerEntries(root)[0]);

        const r = S.appendLedger({ root, date: L_DATE, entry: second });

        expect(r.ok).toBe(true);
        const entries = ledgerEntries(root);
        expect(entries.map((e) => e.candidate_sha256)).toEqual([hexOf('one'), hexOf('two')]);
        expect(JSON.stringify(entries[0])).toBe(firstJson);
    });

    it('dedupe_anEntryEqualToTheNewestOneInSkillHashesAndDisposition_isNotAppended', () => {
        const root = fresh();
        S.appendLedger({ root, date: L_DATE, entry: validEntry() });
        const first = JSON.stringify(ledgerEntries(root)[0]);

        const again = S.appendLedger({ root, date: L_DATE, entry: validEntry({ evidence: ['fp-other'], delta: 0.9 }) });
        const other = S.appendLedger({ root, date: L_DATE, entry: validEntry({ disposition: 'rejected' }) });

        expect(again).toEqual({ ok: true, appended: false, file: path.join(root, LEDGER_REL()) });
        expect(other.appended).toBe(true);
        expect(ledgerEntries(root)).toHaveLength(2);
        expect(JSON.stringify(ledgerEntries(root)[0])).toBe(first);
    });

    it.each([
        ['aMissingKey', (e) => { delete e.fragile; }],
        ['anExtraKey', (e) => { e.note = 'extra'; }],
        ['anUnknownDisposition', (e) => { e.disposition = 'merged'; }],
        ['aShortCandidateHash', (e) => { e.candidate_sha256 = e.candidate_sha256.slice(1); }],
        ['anUpperCaseSnapshotHash', (e) => { e.snapshot_sha256 = e.snapshot_sha256.toUpperCase(); }],
        ['evidenceNotAnArray', (e) => { e.evidence = 'fp-1'; }],
        ['anEvidenceIdWithWhitespace', (e) => { e.evidence = ['has space']; }],
        ['aCommitWithoutTheRevertCommand', (e) => { e.disposition = 'applied'; e.applied_at = new Date().toISOString(); e.commit = 'a'.repeat(40); }],
        ['aRevertCommandThatDoesNotNameTheCommit', (e) => { e.disposition = 'applied'; e.applied_at = new Date().toISOString(); e.commit = 'a'.repeat(40); e.revert = `git revert ${'b'.repeat(40)}`; }],
        ['aRevertCommandWithoutACommit', (e) => { e.revert = `git revert ${'a'.repeat(40)}`; }],
        ['aCommitOnANonAppliedEntry', (e) => { e.commit = 'a'.repeat(40); e.revert = `git revert ${'a'.repeat(40)}`; }],
        ['anAppliedEntryWithoutAnAppliedAt', (e) => { e.disposition = 'applied'; }],
        ['anAppliedAtOnANonAppliedEntry', (e) => { e.applied_at = new Date().toISOString(); }],
    ])('appendLedger_invalid_%s_isRefusedAsInputAndNothingIsWritten', (_name, mutate) => {
        const root = fresh();
        const entry = validEntry();
        mutate(entry);

        const r = S.appendLedger({ root, date: L_DATE, entry });

        expect(r).toMatchObject({ ok: false, failedStep: 'input' });
        expect(fs.existsSync(path.join(root, 'docs/.output/evolution'))).toBe(false);
    });

    it.each([
        ['aBadDate', { date: '2026-13-45' }],
        ['anImpossibleCalendarDate', { date: '2026-02-30' }],
        ['aNonStringDate', { date: 20261118 }],
        ['aMissingRoot', { root: path.join(os.tmpdir(), 'ledger-no-such-root-dir') }],
    ])('appendLedger_invalid_%s_isRefusedAsInput', (_name, over) => {
        const root = fresh();

        const r = S.appendLedger({ root, date: L_DATE, entry: validEntry(), ...over });

        expect(r).toMatchObject({ ok: false, failedStep: 'input' });
    });

    it('appendLedger_garbageOptions_neverThrowAndAreRefused', () => {
        for (const bad of [undefined, null, 'x', 7, [], { root: 5 }]) {
            let r;
            expect(() => { r = S.appendLedger(bad); }).not.toThrow();
            expect(r.ok).toBe(false);
        }
    });

    it('appendLedger_eightProcessesAtTheSameInstant_eachLandsExactlyOnceAndTheFileStaysValid', async () => {
        const root = fresh();
        const child = `
const { appendLedger } = require(${JSON.stringify(LIB)});
const [root, date, startAt] = process.argv.slice(1);
while (Date.now() < Number(startAt)) { /* spin until the shared start instant */ }
const r = appendLedger({ root, date, entry: JSON.parse(process.env.LEDGER_ENTRY) });
process.stdout.write(JSON.stringify(r));
process.exit(r.ok ? 0 : 1);
`;
        const startAt = String(Date.now() + 2500);
        const hashes = Array.from({ length: 8 }, (_v, i) => hexOf(`writer-${i}`));

        const results = await Promise.all(hashes.map((h) => new Promise((resolve) => {
            const p = spawnAsync(process.execPath, ['-e', child, root, L_DATE, startAt], {
                env: { ...process.env, LEDGER_ENTRY: JSON.stringify(validEntry({ candidate_sha256: h })) },
                windowsHide: true,
            });
            let out = '';
            p.stdout.on('data', (d) => { out += d; });
            p.on('close', (code) => resolve({ code, out }));
        })));

        expect(results.map((r) => r.code)).toEqual(Array(8).fill(0));
        expect(results.map((r) => JSON.parse(r.out).appended)).toEqual(Array(8).fill(true));
        const entries = ledgerEntries(root);
        expect(entries).toHaveLength(8);
        expect(new Set(entries.map((e) => e.candidate_sha256))).toEqual(new Set(hashes));
        expect(fs.readdirSync(path.join(root, LEDGER_DIR_REL()))).toEqual(['ledger.json']);
    }, 60000);
});

/**
 * An applied scenario whose files were committed by the "orchestrator" on the apply branch and fast-forwarded into `main` (a
 * commit that is only on a branch is refused: the default branch is where a change counts); the checkout is left on `main`.
 * Returns the commit and the candidate hash.
 */
function appliedAndCommitted() {
    const sc = makeScenario();
    const applied = run(sc, applyDated(sc));
    expect(applied.status, `${applied.stderr}\n${JSON.stringify(applied.json)}`).toBe(0);
    gitOut(sc.repo.root, 'add', '--', ...applied.json.files);
    gitOut(sc.repo.root, 'commit', '-q', '-m', 'apply alpha');
    const commit = gitOut(sc.repo.root, 'rev-parse', 'HEAD');
    gitOut(sc.repo.root, 'checkout', '-q', 'main');
    gitOut(sc.repo.root, 'merge', '-q', '--ff-only', 'auto/x');
    return { sc, commit, sha: applied.json.candidateSha256 };
}
describe('SF-4.10 record-commit: the commit and its revert pointer are filled in once, after the orchestrator commits', () => {
    const record = (sc, args, via = 'lib') => run(sc, args, { verb: 'record-commit', via });

    it('recordCommit_anAppliedEntry_getsTheCommitAndExactlyGitRevertThatHash', () => {
        const { sc, commit, sha } = appliedAndCommitted();
        const before = ledgerEntries(sc.repo.root)[0];

        const r = record(sc, ['--candidate-sha256', sha, '--commit', commit, '--date', L_DATE]);

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(r.json).toMatchObject({ ok: true, updated: true, ledger: LEDGER_REL(), revert: `git revert ${commit}` });
        const after = ledgerEntries(sc.repo.root);
        expect(after).toHaveLength(1);
        expect(after[0]).toEqual({ ...before, commit, revert: `git revert ${commit}` });
    });

    it('recordCommit_withoutADate_findsTheEntryInWhicheverDayLedgerHoldsIt', () => {
        const { sc, commit, sha } = appliedAndCommitted();

        const r = record(sc, ['--candidate-sha256', sha, '--commit', commit]);

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(ledgerEntries(sc.repo.root)[0].commit).toBe(commit);
    });

    it('recordCommit_theSameCommitAgain_isAByteIdenticalNoOp', () => {
        const { sc, commit, sha } = appliedAndCommitted();
        record(sc, ['--candidate-sha256', sha, '--commit', commit]);
        const bytes = ledgerBytes(sc.repo.root);

        const r = record(sc, ['--candidate-sha256', sha, '--commit', commit]);

        expect(r.status).toBe(0);
        expect(r.json).toMatchObject({ ok: true, updated: false });
        expect(ledgerBytes(sc.repo.root)).toBe(bytes);
    });

    it('recordCommit_aDifferentCommitForAnEntryThatAlreadyHoldsOne_isRefusedWriteOnce', () => {
        const { sc, commit, sha } = appliedAndCommitted();
        record(sc, ['--candidate-sha256', sha, '--commit', commit]);
        put(sc.repo.root, 'docs/another.md', 'another\n');
        gitOut(sc.repo.root, 'add', '-A');
        gitOut(sc.repo.root, 'commit', '-q', '-m', 'another commit');
        const other = gitOut(sc.repo.root, 'rev-parse', 'HEAD');
        const bytes = ledgerBytes(sc.repo.root);

        const r = record(sc, ['--candidate-sha256', sha, '--commit', other]);

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, failedStep: 'record' });
        expect(ledgerBytes(sc.repo.root)).toBe(bytes);
    });

    it('recordCommit_aStagedEntryWithTheSameCandidate_isNotAnAppliedEntryAndIsRefused', () => {
        const sc = makeScenario();
        const proposed = run(sc, proposeDated(sc));
        const commit = gitOut(sc.repo.root, 'rev-parse', 'HEAD');
        const bytes = ledgerBytes(sc.repo.root);

        const r = record(sc, ['--candidate-sha256', proposed.json.candidateSha256, '--commit', commit]);

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, failedStep: 'record' });
        expect(ledgerBytes(sc.repo.root)).toBe(bytes);
    });

    it('recordCommit_aWellFormedHashThatIsNotACommitOfThisRepository_isRefusedNotRecorded', () => {
        const { sc, sha } = appliedAndCommitted();
        const bytes = ledgerBytes(sc.repo.root);

        const r = record(sc, ['--candidate-sha256', sha, '--commit', 'a'.repeat(40)]);

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, failedStep: 'record' });
        expect(ledgerBytes(sc.repo.root)).toBe(bytes);
    });

    it('recordCommit_noEntryForThatCandidate_isRefused', () => {
        const { sc, commit } = appliedAndCommitted();

        const r = record(sc, ['--candidate-sha256', hexOf('nobody'), '--commit', commit]);

        expect(r.status).toBe(1);
        expect(r.json.failedStep).toBe('record');
    });

    it.each([
        ['noCandidateHash', (c) => ['--commit', c]],
        ['noCommit', (_c, s) => ['--candidate-sha256', s]],
        ['aShortCommit', (c, s) => ['--candidate-sha256', s, '--commit', c.slice(0, 12)]],
        ['aNonHexCandidate', (c) => ['--candidate-sha256', 'z'.repeat(64), '--commit', c]],
        ['aBadDate', (c, s) => ['--candidate-sha256', s, '--commit', c, '--date', 'soon']],
        ['anUnknownFlag', (c, s) => ['--candidate-sha256', s, '--commit', c, '--force', 'yes']],
    ])('recordCommit_malformed_%s_exitsTwoAndChangesNothing', (_name, argsOf) => {
        const { sc, commit, sha } = appliedAndCommitted();
        const bytes = ledgerBytes(sc.repo.root);

        const r = record(sc, argsOf(commit, sha));

        expect(r.status).toBe(2);
        expect(r.json.failedStep).toBe('input');
        expect(ledgerBytes(sc.repo.root)).toBe(bytes);
    });

    it('recordCommit_throughTheExistingSkillEvolutionCli_isRoutedWithTheSameContract', () => {
        const { sc, commit, sha } = appliedAndCommitted();

        const r = record(sc, ['--candidate-sha256', sha, '--commit', commit], 'evolution');

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(ledgerEntries(sc.repo.root)[0].revert).toBe(`git revert ${commit}`);
    });

    it('recordCommit_theRecordedRevertCommandReallyRevertsThatCommit_whenAMaintainerRunsIt', () => {
        const { sc, commit, sha } = appliedAndCommitted();
        const recorded = record(sc, ['--candidate-sha256', sha, '--commit', commit]).json.revert;

        const argv = recorded.split(' ').slice(1);
        const reverted = git(sc.repo.root, ...argv, '--no-edit');

        expect(argv).toEqual(['revert', commit]);
        expect(reverted.status, reverted.stderr).toBe(0);
        expect(fs.readFileSync(path.join(sc.repo.root, '.agents/skills/alpha/SKILL.md'), 'utf8')).toBe(SKILL_MD);
    });
});

describe('SF-4.10 never reverts: a spy on child_process sees every git argv the audit trail runs', () => {
    // The pin is structural, not textual: a preload patches child_process in the CLI under test and logs the argv of every git it
    // spawns. A quoted-literal grep is defeated by `['re' + 'vert']`; a spy is not.
    const READ_ONLY_VERBS = new Set(['rev-parse', 'symbolic-ref', 'merge-base', 'rev-list', 'ls-tree', 'cat-file', 'show', 'log']);
    const FORBIDDEN_TOKENS = ['revert', 'reset', 'push', 'update-ref', 'checkout', 'switch', 'merge', 'rebase', 'cherry-pick', 'stash', 'fetch', 'pull', 'clean', 'commit', 'remote'];

    const PRELOAD = `'use strict';
const cp = require('child_process');
const fs = require('fs');
const log = process.env.SPY_LOG;
const note = (file, args) => {
  if (!/(^|[\\\\/])git(\\.exe)?$/.test(String(file))) return;
  fs.appendFileSync(log, JSON.stringify(Array.isArray(args) ? args : []) + '\\n');
};
for (const name of ['spawnSync', 'execFileSync', 'spawn', 'execFile']) {
  const original = cp[name];
  cp[name] = function (file, args, ...rest) {
    note(file, args);
    return original.call(this, file, args, ...rest);
  };
}
`;

    /** The git verb of an argv: the first token that is not a global option (`-C dir`, `-c k=v`, `--flag`). */
    function gitVerb(argv) {
        for (let i = 0; i < argv.length; i++) {
            if (argv[i] === '-C' || argv[i] === '-c') i++;
            else if (!String(argv[i]).startsWith('-')) return argv[i];
        }
        return '';
    }
    /** The argv that is not a plain read: a verb outside the read-only list, or any forbidden token, or a force-delete of a branch. */
    function violations(calls) {
        return calls.filter((argv) => {
            const verb = gitVerb(argv);
            return !READ_ONLY_VERBS.has(verb) || argv.some((a) => FORBIDDEN_TOKENS.includes(a)) || (verb === 'branch');
        });
    }
    const readCalls = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

    function spyRun(root, preload, log, argv) {
        return spawnSync(process.execPath, ['-r', preload, ...argv], {
            cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root, SPY_LOG: log },
        });
    }

    it.each([
        ['revert', ['revert', 'HEAD']],
        ['reset', ['reset', '--soft', 'HEAD~1']],
        ['push', ['push', 'origin', 'main']],
        ['update-ref', ['update-ref', 'refs/heads/x', 'HEAD']],
        ['branch -D', ['branch', '-D', 'x']],
        ['a verb split from its literal', ['re' + 'vert', 'HEAD']],
        ['checkout', ['-C', '.', 'checkout', 'main']],
    ])('control_aSpawnedGit_%s_isCaughtByTheSpy', (_name, argv) => {
        const base = tmpDir('spy-control-');
        const preload = path.join(base, 'preload.cjs');
        const script = path.join(base, 'violator.js');
        const log = path.join(base, 'spy.log');
        fs.writeFileSync(preload, PRELOAD);
        fs.writeFileSync(script, `require('child_process').spawnSync('git', ${JSON.stringify(argv)}, { cwd: ${JSON.stringify(base)}, stdio: 'ignore' });\n`);

        spyRun(base, preload, log, [script]);

        const calls = readCalls(log);
        expect(calls).toEqual([argv]);
        expect(violations(calls)).toEqual([argv]);
    });

    /** A queue entry `watch` could have written for the recorded commit, so the intake has something to prove. */
    function plantQueue(root, commit, sha) {
        const entry = ledgerEntries(root)[0];
        const candidate = {
            kind: 'revert', skill: 'alpha', commit, candidate_sha256: sha, revert: `git revert ${commit}`, applied_at: entry.applied_at,
            metrics: [{ metric: 'success_rate', before: 100, after: 0 }], fingerprint: `rv-${sha256(commit).slice(0, 12)}`,
        };
        put(root, 'docs/.output/evolution/skills/revert-candidates.json', `${JSON.stringify({ version: 1, candidates: [candidate] })}\n`);
    }

    it.each([
        ['watch', ['watch'], true, false],
        ['status', ['status'], true, false],
        ['intake with a queued candidate', ['intake', '--json'], true, true],
        ['record-commit', null, false, false],
    ])('spy_%s_runsOnlyReadOnlyGitAndNeverTheForbiddenTokens', (name, args, recordFirst, queue) => {
        const { sc, commit, sha } = appliedAndCommitted();
        gitOut(sc.repo.root, 'checkout', '-q', '-b', 'side');
        if (recordFirst) {
            const recorded = run(sc, ['--candidate-sha256', sha, '--commit', commit], { verb: 'record-commit' });
            expect(recorded.status, `${recorded.stderr}\n${JSON.stringify(recorded.json)}`).toBe(0);
        }
        if (queue) plantQueue(sc.repo.root, commit, sha);
        const preload = path.join(sc.repo.base, 'preload.cjs');
        const log = path.join(sc.repo.base, 'spy.log');
        fs.writeFileSync(preload, PRELOAD);

        const r = spyRun(sc.repo.root, preload, log, [EVOLUTION, ...(args || ['record-commit', '--candidate-sha256', sha, '--commit', commit])]);

        expect(r.status, `${name}: ${r.stderr}`).toBe(0);
        const calls = readCalls(log);
        expect(calls.length, 'the spy saw the git calls').toBeGreaterThan(0);
        expect(violations(calls), JSON.stringify(violations(calls))).toEqual([]);
    });
});

describe('SF-4.10 exports: the ledger writer and the commit recorder', () => {
    it('exports_theLedgerWriterAndTheCommitRecorder', () => {
        const m = require(LIB);

        for (const name of ['appendLedger', 'recordCommit', 'withFileLock', 'lockPathFor', 'writeAtomic', 'openEvidence', 'claimCommits', 'deltaHash']) {
            expect(typeof m[name], name).toBe('function');
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// SF-4.10 wave-L2 review fixes. The ledger is evidence; git is the proof (Main Agent design decision). Every test below fails
// without its fix: the forged or foreign commit was recorded, the lock race lost entries, the temporary and lock files sat in
// the tracked folder, a re-apply was swallowed, a 64-hex commit was refused.
//
// NOT COVERED: a Windows run (the lock's start-time check reads /proc on Linux only); a writer killed between the lock's
//   creation and its first byte (it is read as an unowned lock and broken once it is 30 s old: the 30 s age is not waited for here).
// ═════════════════════════════════════════════════════════════════════════════

describe('SF-4.10 record-commit: only a change git proves on the default branch is recorded', () => {
    /** Apply on the branch and commit there, without merging: a commit that exists only on `auto/x`. */
    function appliedOnBranch() {
        const sc = makeScenario();
        const applied = run(sc, applyDated(sc));
        expect(applied.status, `${applied.stderr}\n${JSON.stringify(applied.json)}`).toBe(0);
        gitOut(sc.repo.root, 'add', '--', ...applied.json.files);
        gitOut(sc.repo.root, 'commit', '-q', '-m', 'apply alpha');
        return { sc, commit: gitOut(sc.repo.root, 'rev-parse', 'HEAD'), sha: applied.json.candidateSha256 };
    }
    const record = (sc, commit, sha, extra = []) => run(sc, ['--candidate-sha256', sha, '--commit', commit, ...extra], { verb: 'record-commit' });
    const refused = (r) => {
        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(1);
        expect(r.json).toMatchObject({ ok: false, failedStep: 'record' });
    };

    it('recordCommit_aCommitThatIsOnlyOnTheApplyBranch_isRefusedAndTheLedgerKeepsNoCommit', () => {
        const { sc, commit, sha } = appliedOnBranch();
        const bytes = ledgerBytes(sc.repo.root);

        const r = record(sc, commit, sha);

        refused(r);
        expect(r.json.reason).toMatch(/not reachable from the default branch \(main\)/);
        expect(ledgerBytes(sc.repo.root)).toBe(bytes);
    });

    it('recordCommit_theCheckedOutBranchIsNeverTheJudge_theDefaultBranchIs', () => {
        const { sc, commit, sha } = appliedOnBranch();
        // HEAD is auto/x and holds the commit; main does not. Merging into main is what makes it count.
        gitOut(sc.repo.root, 'checkout', '-q', 'main');
        gitOut(sc.repo.root, 'merge', '-q', '--ff-only', 'auto/x');
        gitOut(sc.repo.root, 'checkout', '-q', '-b', 'elsewhere', 'main~1');

        const r = record(sc, commit, sha);

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(ledgerEntries(sc.repo.root)[0].commit).toBe(commit);
    });

    it('recordCommit_theDefaultBranchComesFromOriginHead_notFromTheNameMain', () => {
        const { sc, commit, sha } = appliedOnBranch();
        gitOut(sc.repo.root, 'branch', 'trunk', commit);
        gitOut(sc.repo.root, 'update-ref', 'refs/remotes/origin/trunk', commit);
        const before = record(sc, commit, sha);
        refused(before);
        gitOut(sc.repo.root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');

        const after = record(sc, commit, sha);

        expect(after.status, `${after.stderr}\n${JSON.stringify(after.json)}`).toBe(0);
        expect(ledgerEntries(sc.repo.root)[0].commit).toBe(commit);
    });

    it('recordCommit_aCommitOnTheDefaultBranchThatDoesNotChangeTheSkill_isRefused', () => {
        const { sc, sha } = appliedOnBranch();
        gitOut(sc.repo.root, 'checkout', '-q', 'main');
        put(sc.repo.root, 'docs/unrelated.md', 'unrelated\n');
        gitOut(sc.repo.root, 'add', '-A');
        gitOut(sc.repo.root, 'commit', '-q', '-m', 'an unrelated change');
        const unrelated = gitOut(sc.repo.root, 'rev-parse', 'HEAD');
        const bytes = ledgerBytes(sc.repo.root);

        const r = record(sc, unrelated, sha);

        refused(r);
        expect(r.json.reason).toMatch(/changes no file of \.agents\/skills\/alpha/);
        expect(ledgerBytes(sc.repo.root)).toBe(bytes);
    });

    it('recordCommit_aCommitThatEditsTheSkillDifferentlyFromTheEvaluatedCandidate_isRefused', () => {
        const { sc, sha } = appliedOnBranch();
        gitOut(sc.repo.root, 'checkout', '-q', 'main');
        put(sc.repo.root, '.agents/skills/alpha/SKILL.md', `${SKILL_MD}\nSomething nobody evaluated.\n`);
        gitOut(sc.repo.root, 'add', '-A');
        gitOut(sc.repo.root, 'commit', '-q', '-m', 'a different edit of the same skill');
        const other = gitOut(sc.repo.root, 'rev-parse', 'HEAD');

        const r = record(sc, other, sha);

        refused(r);
        expect(r.json.reason).toMatch(/not the change this entry evaluated/);
    });

    it('recordCommit_aCommitThatAddsAnExtraSkillFileToTheEvaluatedChange_isRefused', () => {
        const { sc, sha } = appliedOnBranch();
        gitOut(sc.repo.root, 'checkout', '-q', 'main');
        gitOut(sc.repo.root, 'checkout', '-q', 'auto/x', '--', '.agents/skills/alpha/SKILL.md');
        put(sc.repo.root, '.agents/skills/alpha/references/smuggled.md', 'not part of the evaluated candidate\n');
        gitOut(sc.repo.root, 'add', '-A');
        gitOut(sc.repo.root, 'commit', '-q', '-m', 'the evaluated change plus a smuggled file');
        const smuggled = gitOut(sc.repo.root, 'rev-parse', 'HEAD');

        const r = record(sc, smuggled, sha);

        refused(r);
        expect(r.json.reason).toMatch(/not the change this entry evaluated/);
    });

    it('recordCommit_aSquashMerge_isMatchedByItsDiffNotByAncestry', () => {
        const { sc, commit, sha } = appliedOnBranch();
        gitOut(sc.repo.root, 'checkout', '-q', 'main');
        gitOut(sc.repo.root, 'merge', '-q', '--squash', 'auto/x');
        gitOut(sc.repo.root, 'commit', '-q', '-m', 'squash of the apply branch');
        const squash = gitOut(sc.repo.root, 'rev-parse', 'HEAD');
        expect(squash).not.toBe(commit);
        expect(git(sc.repo.root, 'merge-base', '--is-ancestor', commit, 'main').status).not.toBe(0);

        const r = record(sc, squash, sha);

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(ledgerEntries(sc.repo.root)[0].commit).toBe(squash);
    });

    it('recordCommit_aNoFastForwardMergeCommit_isMatchedByItsDiffAgainstTheFirstParent', () => {
        const { sc, sha } = appliedOnBranch();
        gitOut(sc.repo.root, 'checkout', '-q', 'main');
        put(sc.repo.root, 'docs/main-moves.md', 'main moved on\n');
        gitOut(sc.repo.root, 'add', '-A');
        gitOut(sc.repo.root, 'commit', '-q', '-m', 'main moves on');
        gitOut(sc.repo.root, 'merge', '-q', '--no-ff', 'auto/x', '-m', 'merge the apply branch');
        const merge = gitOut(sc.repo.root, 'rev-parse', 'HEAD');

        const r = record(sc, merge, sha);

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(ledgerEntries(sc.repo.root)[0].commit).toBe(merge);
    });

    it('recordCommit_oneCommitCannotServeTwoEntries', () => {
        const { sc, commit, sha } = appliedAndCommittedForTwo();
        const forgedSha = hexOf('a candidate that never ran');
        const first = ledgerEntries(sc.repo.root)[0];
        // A forged second entry with the same delta, waiting for a commit.
        const forged = { ...first, candidate_sha256: forgedSha, commit: null, revert: null, applied_at: new Date().toISOString() };
        expect(S.appendLedger({ root: sc.repo.root, date: L_DATE, entry: forged })).toMatchObject({ ok: true, appended: true });
        expect(record(sc, commit, sha).json.ok).toBe(true);
        const bytes = ledgerBytes(sc.repo.root);

        const r = record(sc, commit, forgedSha);

        refused(r);
        expect(r.json.reason).toMatch(/one commit serves one entry/);
        expect(ledgerBytes(sc.repo.root)).toBe(bytes);
    });

    /** An applied, merged scenario whose entry is NOT recorded yet. */
    function appliedAndCommittedForTwo() {
        const { sc, commit, sha } = appliedOnBranch();
        gitOut(sc.repo.root, 'checkout', '-q', 'main');
        gitOut(sc.repo.root, 'merge', '-q', '--ff-only', 'auto/x');
        return { sc, commit, sha };
    }

    it.each([
        ['aSixtyFourHexCommit_isSyntacticallyAcceptedAndRefusedAsNotACommit', 'a'.repeat(64)],
    ])('recordCommit_%s', (_name, id) => {
        const { sc, sha } = appliedAndCommittedForTwo();

        const r = record(sc, id, sha);

        expect(r.status).toBe(1);
        expect(r.json).toMatchObject({ ok: false, failedStep: 'record' });
    });

    it('recordCommit_aHeadThatPointsAtAnotherRepository_isNeverFollowed', () => {
        const { sc, commit, sha } = appliedAndCommittedForTwo();
        const other = tmpDir('skill-apply-other-');
        gitOut(other, 'init', '-q', '-b', 'main');
        put(other, 'x.txt', 'x\n');
        gitOut(other, 'add', '-A');
        gitOut(other, 'commit', '-q', '-m', 'unrelated repository');

        const r = run(sc, ['--candidate-sha256', sha, '--commit', commit], { verb: 'record-commit', env: { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other } });

        expect(r.status, `${r.stderr}\n${JSON.stringify(r.json)}`).toBe(0);
        expect(ledgerEntries(sc.repo.root)[0].commit).toBe(commit);
    });
});

describe('SF-4.10 ledger entries: path, delta and commit id are validated, a re-apply is recorded', () => {
    const fresh = () => tmpDir('ledger-review-');
    const applied = (over = {}) => validEntry({ disposition: 'applied', applied_at: '2026-11-18T10:00:00.000Z', ...over });
    const A40 = 'a'.repeat(40);

    it.each([
        ['aPathThatIsNotTheSkillsDirectory', { path: '../../etc' }],
        ['aPathOfAnotherSkill', { path: '.agents/skills/beta' }],
        ['aMalformedDeltaHash', { delta_sha256: 'xyz' }],
        ['anUpperCaseDeltaHash', { delta_sha256: hexOf('d').toUpperCase() }],
    ])('appendLedger_invalid_%s_isRefusedAsInput', (_name, over) => {
        const root = fresh();

        const r = S.appendLedger({ root, date: L_DATE, entry: validEntry(over) });

        expect(r).toMatchObject({ ok: false, failedStep: 'input' });
        expect(fs.existsSync(path.join(root, 'docs/.output/evolution'))).toBe(false);
    });

    it('appendLedger_aNullDeltaHash_isAcceptedForAnEntryWhoseCandidateCouldNotBeHashed', () => {
        const root = fresh();

        const r = S.appendLedger({ root, date: L_DATE, entry: validEntry({ delta_sha256: null }) });

        expect(r.ok).toBe(true);
    });

    it('appendLedger_aSha256ObjectFormatCommit_isAValidAppliedEntry', () => {
        const root = fresh();
        const id = 'b'.repeat(64);

        const r = S.appendLedger({ root, date: L_DATE, entry: applied({ commit: id, revert: `git revert ${id}` }) });

        expect(r).toMatchObject({ ok: true, appended: true });
    });

    it('appendLedger_aReApplyOfACandidateWhoseEarlierApplicationHoldsItsCommit_isRecordedAsANewApplication', () => {
        const root = fresh();
        const first = applied({ commit: A40, revert: `git revert ${A40}` });
        const reapplied = applied({ applied_at: '2026-11-19T09:00:00.000Z' });
        S.appendLedger({ root, date: L_DATE, entry: first });

        const r = S.appendLedger({ root, date: L_DATE, entry: reapplied });

        expect(r).toMatchObject({ ok: true, appended: true });
        const entries = ledgerEntries(root);
        expect(entries.map((e) => [e.commit, e.applied_at])).toEqual([[A40, '2026-11-18T10:00:00.000Z'], [null, '2026-11-19T09:00:00.000Z']]);
    });

    it('appendLedger_theSameAppliedProposalWhileItStillWaitsForItsCommit_isStillDeduplicated', () => {
        const root = fresh();
        S.appendLedger({ root, date: L_DATE, entry: applied() });

        const again = S.appendLedger({ root, date: L_DATE, entry: applied({ applied_at: '2026-11-19T09:00:00.000Z' }) });

        expect(again).toMatchObject({ ok: true, appended: false });
        expect(ledgerEntries(root)).toHaveLength(1);
    });
});

describe('SF-4.10 lock: a stale lock is broken without losing a writer, and nothing is left in the tracked folder', () => {
    const WRITER = `
const { appendLedger } = require(${JSON.stringify(LIB)});
const [root, date, startAt] = process.argv.slice(1);
while (Date.now() < Number(startAt)) { /* spin until the shared start instant */ }
const r = appendLedger({ root, date, entry: JSON.parse(process.env.LEDGER_ENTRY) });
process.stdout.write(JSON.stringify(r));
process.exit(r.ok ? 0 : 1);
`;
    const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);

    /** An aged lock whose owner is gone, where the writer's lock for `date`'s ledger would be. */
    function plantStaleLock(root, date, owner = { pid: deadPid(), start: null, token: 'dead-owner' }) {
        const lock = S.lockPathFor(root, path.join(root, LEDGER_REL(date)));
        fs.mkdirSync(path.dirname(lock), { recursive: true });
        fs.writeFileSync(lock, `${JSON.stringify(owner)}\n`);
        const old = new Date(Date.now() - 120 * 1000);
        fs.utimesSync(lock, old, old);
        return lock;
    }

    function startWriters(root, count, startAfter, tag) {
        const startAt = String(Date.now() + startAfter);
        const hashes = Array.from({ length: count }, (_v, i) => hexOf(`${tag}-writer-${i}`));
        const done = hashes.map((h) => new Promise((resolve) => {
            const p = spawnAsync(process.execPath, ['-e', WRITER, root, L_DATE, startAt], {
                env: { ...process.env, LEDGER_ENTRY: JSON.stringify(validEntry({ candidate_sha256: h })) },
                windowsHide: true,
            });
            let out = '';
            p.stdout.on('data', (d) => { out += d; });
            p.on('close', (code) => resolve({ code, out }));
        }));
        return { hashes, done };
    }

    it('lock_theLockLivesInTheIgnoredStateZone_neverBesideTheLedger', () => {
        const root = tmpDir('lock-path-');
        const file = path.join(root, LEDGER_REL());

        const lock = S.lockPathFor(root, file);

        expect(path.relative(root, lock).split(path.sep).slice(0, 3)).toEqual(['docs', '.output', '.state']);
        expect(path.dirname(lock)).not.toBe(path.dirname(file));
    });

    it('lock_tenWritersRacingForAStaleLockOfADeadOwner_loseNoEntryInAnyRound', async () => {
        // The race is probabilistic (the review saw 7 of 25 rounds lose entries on the old protocol, a rerun of it 2 of 15): the
        // deterministic pins of the same protocol are the breakStaleLock tests below.
        const rounds = 15;
        for (let round = 0; round < rounds; round++) {
            const root = tmpDir(`lock-race-${round}-`);
            fs.mkdirSync(path.join(root, LEDGER_DIR_REL()), { recursive: true });
            plantStaleLock(root, L_DATE);
            const { hashes, done } = startWriters(root, 10, 2000, `r${round}`);

            const results = await Promise.all(done);

            expect(results.map((r) => r.code), `round ${round}`).toEqual(Array(10).fill(0));
            const entries = ledgerEntries(root);
            expect(entries.length, `round ${round}: every writer reported success, so every entry must be there`).toBe(10);
            expect(new Set(entries.map((e) => e.candidate_sha256))).toEqual(new Set(hashes));
        }
    }, 240000);

    it('lock_aLockOfALiveOwnerIsNeverBrokenHoweverOldItIs', async () => {
        const root = tmpDir('lock-live-');
        const file = path.join(root, LEDGER_REL());
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const holder = `
const { withFileLock, lockPathFor } = require(${JSON.stringify(LIB)});
const [root, file, flag] = process.argv.slice(1);
withFileLock(lockPathFor(root, file), () => {
  require('fs').writeFileSync(flag, 'held');
  const until = Date.now() + 1500;
  while (Date.now() < until) { /* hold it */ }
  require('fs').writeFileSync(flag + '.done', String(Date.now()));
});
`;
        const flag = path.join(root, 'flag');
        const p = spawnAsync(process.execPath, ['-e', holder, root, file, flag], { windowsHide: true });
        const closed = new Promise((resolve) => p.on('close', resolve));
        while (!fs.existsSync(flag)) await new Promise((r) => setTimeout(r, 10));
        const lock = S.lockPathFor(root, file);
        const old = new Date(Date.now() - 600 * 1000);
        fs.utimesSync(lock, old, old);

        const result = S.appendLedger({ root, date: L_DATE, entry: validEntry() });
        const finished = Date.now();
        await closed;

        expect(result.ok).toBe(true);
        expect(Number(fs.readFileSync(`${flag}.done`, 'utf8')), 'the writer only got in after the live holder was done').toBeLessThanOrEqual(finished);
    }, 60000);

    it.skipIf(!fs.existsSync('/proc/self/stat'))('lock_aLockWhoseRecordedStartTimeIsNotTheLivePidsStartTime_isAReusedPidAndIsBroken', () => {
        const root = tmpDir('lock-reuse-');
        fs.mkdirSync(path.join(root, LEDGER_DIR_REL()), { recursive: true });
        plantStaleLock(root, L_DATE, { pid: process.pid, start: '1', token: 'a previous process that had this pid' });

        const r = S.appendLedger({ root, date: L_DATE, entry: validEntry() });

        expect(r).toMatchObject({ ok: true, appended: true });
    });

    it('lock_breakingTheLockThatWasJudgedStale_neverUnlinksAFreshLockAnotherWriterTookInTheMeantime', () => {
        const root = tmpDir('lock-fresh-');
        const lock = plantStaleLock(root, L_DATE);
        const judged = S.readLock(lock);
        const fresh = `${JSON.stringify({ pid: process.pid, start: null, token: 'the writer that broke it first and took the lock' })}\n`;
        fs.unlinkSync(lock);
        fs.writeFileSync(lock, fresh); // the lock another writer holds now: a new file at the same path

        S.breakStaleLock(lock, judged);

        expect(fs.readFileSync(lock, 'utf8')).toBe(fresh);
        expect(fs.existsSync(`${lock}.break`), 'the marker is released').toBe(false);
    });

    it('lock_aLockThatIsStillTheFileThatWasJudgedStale_isBrokenAndTheMarkerIsReleased', () => {
        const root = tmpDir('lock-break-');
        const lock = plantStaleLock(root, L_DATE);

        S.breakStaleLock(lock, S.readLock(lock));

        expect(fs.existsSync(lock)).toBe(false);
        expect(fs.existsSync(`${lock}.break`)).toBe(false);
    });

    it('lock_whileAnotherBreakerHoldsTheMarker_theStaleLockIsLeftAlone', () => {
        const root = tmpDir('lock-marker-');
        const lock = plantStaleLock(root, L_DATE);
        fs.writeFileSync(`${lock}.break`, 'another breaker\n');

        S.breakStaleLock(lock, S.readLock(lock));

        expect(fs.existsSync(lock)).toBe(true);
        expect(fs.existsSync(`${lock}.break`)).toBe(true);
    });

    it('lock_aMarkerLeftByABreakerThatDied_isClearedOnceItIsStale', () => {
        const root = tmpDir('lock-marker-stale-');
        const lock = plantStaleLock(root, L_DATE);
        const marker = `${lock}.break`;
        fs.writeFileSync(marker, 'a breaker that died\n');
        const old = new Date(Date.now() - 120 * 1000);
        fs.utimesSync(marker, old, old);

        S.breakStaleLock(lock, S.readLock(lock));

        expect(fs.existsSync(marker)).toBe(false);
        expect(fs.existsSync(lock), 'the lock itself is broken by the next attempt').toBe(true);
    });

    it('lock_theHolderReleasesOnlyALockThatStillCarriesItsOwnToken', () => {
        const root = tmpDir('lock-own-');
        const lock = path.join(root, 'locks', 'x.lock');
        const theirs = `${JSON.stringify({ pid: process.pid, start: null, token: 'another writer took the lock' })}\n`;

        S.withFileLock(lock, () => {
            fs.writeFileSync(lock, theirs); // the lock was wrongly broken and taken by someone else
        });

        expect(fs.readFileSync(lock, 'utf8')).toBe(theirs);
    });

    it('lock_aLockThatIsStillOurs_isRemovedWhenTheWorkIsDone', () => {
        const root = tmpDir('lock-release-');
        const lock = path.join(root, 'locks', 'y.lock');

        const result = S.withFileLock(lock, () => {
            expect(fs.existsSync(lock)).toBe(true);
            return 'done';
        });

        expect(result).toBe('done');
        expect(fs.existsSync(lock)).toBe(false);
    });

    it('lock_aThrowInsideTheWork_stillReleasesTheLock', () => {
        const root = tmpDir('lock-throw-');
        const lock = path.join(root, 'locks', 'z.lock');

        expect(() => S.withFileLock(lock, () => { throw new Error('boom'); })).toThrow('boom');

        expect(fs.existsSync(lock)).toBe(false);
    });

    it('lock_theWaitIsLongerThanTheStaleAge_soAWaiterThatArrivesJustAfterACrashOutlivesTheLock', () => {
        const src = fs.readFileSync(LIB, 'utf8');
        const wait = Number(/const LOCK_WAIT_MS = (\d+) \* 1000/.exec(src)[1]);
        const stale = Number(/const LOCK_STALE_MS = (\d+) \* 1000/.exec(src)[1]);

        expect(wait).toBeGreaterThan(stale);
    });

    it('lock_eightWritersNeverShowALockOrATemporaryFileInTheTrackedDateDirectory', async () => {
        const root = tmpDir('lock-tracked-');
        const dir = path.join(root, LEDGER_DIR_REL());
        const seen = new Set();
        const poll = setInterval(() => {
            try {
                for (const name of fs.readdirSync(dir)) seen.add(name);
            } catch {
                // the directory is not there yet
            }
        }, 1);
        const { done } = startWriters(root, 8, 1500, 'tracked');

        const results = await Promise.all(done);
        clearInterval(poll);

        expect(results.map((r) => r.code)).toEqual(Array(8).fill(0));
        expect([...seen]).toEqual(['ledger.json']);
        expect(fs.readdirSync(path.join(root, 'docs/.output/.state'))).toEqual(expect.arrayContaining(['locks', 'tmp']));
    }, 60000);

    it('lock_aWriterKilledWhileHoldingTheLock_leavesNothingGitCanSeeInTheTree', async () => {
        const sc = makeScenario();
        const file = path.join(sc.repo.root, LEDGER_REL());
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const holder = `
const { withFileLock, lockPathFor } = require(${JSON.stringify(LIB)});
const [root, file] = process.argv.slice(1);
withFileLock(lockPathFor(root, file), () => { process.stdout.write('held\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000); });
`;
        const p = spawnAsync(process.execPath, ['-e', holder, sc.repo.root, file], { windowsHide: true });
        await new Promise((resolve) => p.stdout.once('data', resolve));
        const closed = new Promise((resolve) => p.on('close', resolve));
        p.kill('SIGKILL');
        await closed;

        const status = git(sc.repo.root, 'status', '--porcelain', '--untracked-files=all').stdout;

        expect(fs.existsSync(S.lockPathFor(sc.repo.root, file)), 'the dead writer left its lock').toBe(true);
        expect(status).toBe('');
    }, 60000);
});
