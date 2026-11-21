/**
 * skill-apply — apply an accepted skill candidate as an uncommitted delta on a local `auto/` branch, and restore
 * every byte on any failure (SF-4.9). Also the side-door classifier (Owner Decision 11): the only edits that may
 * reach a skill without an eval verdict are a typo fix, a stale-pointer fix and a pinned-text restore, and the
 * CODE decides which a delta is, never the caller.
 *
 * Owner Decisions 12 and 15: propose-only. The default mode writes nothing. `--mode apply` is an explicit request
 * and still never commits, never stages, never pushes and never touches a remote: it leaves the delta uncommitted
 * on a branch it created, prints the exact files to stage, and the orchestrator commits through `commit.js`.
 * Auto-apply stays off (`improvement.autoApply` is not read here).
 *
 * Exports
 *   EXIT_OK = 0, EXIT_FAILED = 1, EXIT_INVALID = 2
 *   classifyEdit(before, after, {isPinned?, exists?, wordCount?}) -> {class: 'noop'|'exempt'|'behavior', kinds, reason}
 *   classifyChange([{path, before, after}], opts)                 -> {class, kinds, files: [{path, class, kinds, reason}]}
 *   apply(options)                                                 -> result (synchronous, never throws)
 *   bind(options)                                                  -> result (records what an iteration evaluated)
 *   appendLedger({root, date, entry})                              -> {ok, appended, file} | {ok: false, failedStep, reason}
 *   recordCommit({root, candidateSha256, commit, date?})           -> {ok, updated, ledger, revert} | {ok: false, failedStep, reason}
 *   loadLedgers(root), listLedgerFiles(root), readLedgerFile(file), withFileLock(lockFile, fn), lockPathFor(root, file),
 *   writeAtomic(file, text, root), gitFor(root), openEvidence(root), claimCommits(entries), deltaHash(digests)
 *                                                                   (the read side and the git proof, shared with skill-evolution)
 *   runCli(argv, {root?})                                          -> exit code; prints exactly one JSON object
 *
 * CLI (also `node skill-evolution.js apply|bind|record-commit ...`, root from CLAUDE_PROJECT_DIR):
 *   node skill-apply.js apply <skill> --run <workspace> [--mode propose|apply] [--branch auto/<name>]
 *        [--route verdict|side-door] [--iteration <dir>] [--holdout <dir>] [--min-replicates <n>]
 *        [--candidate-sha256 <hex64>] [--date YYYY-MM-DD] [--evidence id[,id...]] [--root <dir>]
 *   node skill-apply.js bind --run <workspace> [--iteration <dir>]
 *   node skill-apply.js record-commit --candidate-sha256 <hex64> --commit <commit id> [--date YYYY-MM-DD] [--root <dir>]
 *   Exit 0 proposed, applied, bound or recorded | 1 refused or failed (state restored or untouched) | 2 invalid input.
 *
 * The workspace (`--run`) holds `skill-snapshot/` (the old canonical skill directory, whole), `candidate/` (or the
 * legacy `skill-candidate/`; an OVERLAY copied onto `.agents/skills/<skill>/`, nothing is deleted; it may be a whole skill
 * version, as the regression tool measures one: a file byte-identical to the live one is not part of the delta and is not
 * scope-judged, only the changed and new files are) and
 * `iteration-<N>/` (with `holdout/iteration-<N>/` beside it). The verdict runs on the highest-numbered iteration of
 * the workspace and nowhere else: `--iteration` and `--holdout` are accepted only when they name exactly the
 * directories the code derives, so a foreign or older iteration can never supply the evidence.
 *
 * Binding (evaluation -> apply). The verdict route needs `iteration-<N>/binding.json` = {version: 2, iteration,
 * candidateSha256, snapshotSha256, gradings}: the hashes of the `candidate/` and `skill-snapshot/` that THAT iteration
 * graded, and `gradings`, the sha256 of every `grading.json` and `benchmark.json` under the iteration and its holdout
 * (workspace-relative path -> hash). The evaluator writes it (`bind`, run right after `skill-eval aggregate`; it refuses when
 * a candidate or snapshot file is newer than the iteration's benchmark.json). Apply (and propose, which runs the same
 * route) recomputes all of it and refuses on any mismatch, so a candidate edited after its evaluation can never ride the old
 * verdict, and neither can a grading or benchmark file that was edited, deleted or added after the binding (the grading
 * files are ordinary files a session can write, and the verdict is computed from them). A binding without `gradings`
 * (the version 1 shape) is refused like a missing one. The hashes catch an edit AFTER the binding; whoever can write the
 * gradings and then run `bind` themselves still gets a binding, which is why the evaluator that grades and binds in one
 * run (tools/skill-regress.js, through this same `bind`) is the stronger source. `--candidate-sha256` (from the propose
 * run) is mandatory in `--mode apply` on both routes: it also binds the human-visible proposal to what is applied. A verdict
 * with no holdout evidence (no `holdout/iteration-<N>/`) is a low-power accept: proposed, never applied.
 *
 * `--mode apply` needs a clean working tree (the `--run` workspace itself may sit untracked under
 * `docs/.output/evolution/`: exactly that path is excluded from the check, the scope judgement, the restore and the
 * printed `files`; an ignored location works too) and a `--branch auto/<name>` the helper creates and checks out. It
 * refuses up front when any tracked file carries assume-unchanged or skip-worktree (`git status` cannot see an edit to
 * it). Run it in a checkout (or worktree) nobody else is writing to: a failure restores the whole tree, so a concurrent
 * writer's uncommitted edit would be restored with it.
 *
 * Apply pipeline (a failure at any step restores the tree, deletes the branch this run created, switches back to
 * the original branch and exits 1):
 *   validate input -> tracked-file flags -> clean tree -> base commit -> TRUSTED COPY of `_lib` from the base commit
 *   (extracted outside the repo, removed afterwards) -> `improvement-scope snapshot` BEFORE any change (baseline outside
 *   the repo) -> candidate-hash pin and evaluation binding -> drift (snapshot vs live) -> scope of the candidate paths ->
 *   verdict + low-power check (route verdict) or classification (route side-door) -> byte ledger of every file restore
 *   needs -> branch -> copy -> `improvement-scope check` (before the render) -> render-shared-agents ->
 *   render-shared-agents --check -> skill-evolution check -> gate test -> final scope check.
 *
 * Restore is byte-exact or it does not say `restored: true`. Before the first write the helper records the bytes (and
 * modes) of the three directories the pipeline writes (`.agents|.claude|.codex/skills/<skill>/`, ignored files
 * included) and of the gate-judge state it could tamper with (ship seal, freeze state, ac-verify records). A failure
 * restores git's view (tracked paths from HEAD, new paths deleted), then those bytes, then verifies every one by sha256
 * and re-reads `git status`. Not restored, by design: the gate's own receipts, receipt history and failure-ledger rows
 * (the evidence of the run) and build output the gate writes under ignored paths (coverage, caches).
 *
 * Evolution ledger (SF-4.10). Every disposition the helper reaches (applied, dropped, staged, rejected) appends one entry to
 * `docs/.output/evolution/skills/{date}/ledger.json` (`{version: 1, entries: [...]}`, inside the registered skills
 * compartment): the skill, the evidence ids, the candidate and snapshot hashes, `delta_sha256` (the hash of the post-image of
 * every file the candidate changes: what git must show in the commit that lands it), the benchmark path, the verdict's delta,
 * replicates, holdout delta, fragile flag and token and duration totals, the disposition, the change class (the unit
 * Owner Decision 12's graduation counts), and, once an applied delta has landed on the default branch, `record-commit`
 * fills the commit and the exact `git revert <hash>` text. The helper only RECORDS that text and queues nothing itself:
 * it never reverts. The ledger is written after the pipeline and after any restore (a restore never touches it), is
 * append-only, de-duplicated while a proposal waits for its commit (a re-apply of a candidate whose earlier application already
 * holds its commit is a new application and is recorded), concurrent-safe and fail closed: a ledger that cannot be
 * read or written is never papered over, and an apply whose ledger cannot be written is restored. That exact path is
 * outside the clean-tree check, both scope judgements, the restore and the printed `files`, like the workspace.
 *
 * The ledger is EVIDENCE, not the source of truth. `record-commit` refuses a commit that is not reachable from the repository's
 * DEFAULT branch (`origin/HEAD`, else `main`, else `master`; never the HEAD of the checkout), whose diff on the skill's files
 * is not exactly the entry's `delta_sha256`, or that another entry already holds; and everything that counts an applied change
 * (graduation, `watch`, the unattended-apply gate) re-proves it from git on every read (`openEvidence`), so a hand-written entry
 * can at worst be an entry that does not count. Reverts are read from the trees, never from a commit message.
 *
 * Locks and temporary files. The lock that serialises ledger writers lives in `docs/.output/.state/locks/` and every temporary
 * file in `docs/.output/.state/tmp/` (both ignored): a writer killed mid-write leaves nothing in the tracked evolution folder.
 * The lock records the owner's pid, start time and a random token; a stale lock (older than 30 s with a dead or reused owner)
 * is broken only under an exclusive marker, after re-reading the very lock that was judged stale, and a holder releases only a
 * lock that still carries its own token. Known limits: the lock is advisory between cooperating writers (it is not an OS
 * lock), the start time is read on Linux only (elsewhere a live pid is always an owner), and a git blob that a text filter
 * (`core.autocrlf`) rewrote compares unequal to the candidate's bytes, which fails closed (the entry never counts).
 *
 * The final check after the gate tolerates only what the render and the gate legitimately write: the render outputs
 * (`.agents/render-state.json`, the two `shared-agents.json` ledgers, `.claude|.codex/skills/<skill>/**` and the generated
 * commands and prompts), the gate receipt, the receipt history, and failure-ledger rows appended to the ledger (an
 * append, or the ledger's own tail rotation; a rewrite is refused). Every other changed path is a scope violation.
 *
 * Side door. A typo fix must prove the old token is a misspelling, in code: whole-word swap of one edit (a transposition
 * counts as one) between words of five or more letters with the same first letter, where the old word occurs nowhere in
 * the skill corpus (`.agents/skills/**\/*.md`) except in the places being fixed and the new word occurs there at least
 * twice. A guard-word list and an explicit antonym and negation pair list (skip/ship, reuse/refuse, enable/unable,
 * accept/except ...) refuse the rest. A pinned-text restore is trusted only through the BASE commit: the new line must
 * already appear in a tracked test or fixture, or in the file's own history, there; the caller supplies no list. Neither
 * touches code, markers or flags (a line with `<`, `>`, `|`, a backtick, `@` or `--` is never pinned-text).
 *
 * Known limits: a process killed mid-apply leaves its branch and edits in place (the next run refuses a dirty tree);
 * the corpus rule is statistical, not a dictionary (a rare word that is a real rule flip and is on neither list can
 * still read as a typo: the render check, the conformance check and the gate still run); the corpus comes from the working
 * tree (clean in apply mode); bind's recency check reads file times, so it detects an honest edit-after-evaluation, not a
 * deliberate timestamp rewind: the evaluator that records the binding itself (skill-regress) is the stronger source.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fsSafe = require('./fs-safe');
const { dayKey } = require('./run-stamp');

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_INVALID = 2;

const SKILL_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const BRANCH_RE = /^auto\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const HEX64_RE = /^[0-9a-f]{64}$/i;
const MODES = ['propose', 'apply'];
const ROUTES = ['verdict', 'side-door'];
const HELPER_DIRS = ['.agents/core', '.claude/core', '.codex/core'];
const TELEMETRY = 'docs/.output/.state/telemetry';
// What `gate.js test` legitimately writes (all ignored state): the latest receipt, the receipt history, one failure-ledger row.
const GATE_RECEIPT = `${TELEMETRY}/gate-receipt.json`;
const GATE_RECEIPT_DIR = `${TELEMETRY}/gate-receipts/`;
const GATE_LEDGER = `${TELEMETRY}/gate-failures.jsonl`;
// Judge state the gate never writes: captured before the first change and put back on any failure.
const JUDGE_STATE = [`${TELEMETRY}/ship-seal.json`, 'docs/.output/.state/freeze-state.json', `${TELEMETRY}/ac-verify`];
const EVOLUTION_PREFIX = 'docs/.output/evolution/';
// The evolution ledger (SF-4.10): the one audited file inside the repository that a refusal or a proposal writes.
const LEDGER_DIR = ['docs', '.output', 'evolution', 'skills'];
const LEDGER_NAME = 'ledger.json';
// Locks and temporary files live in the ignored state zone, never beside the tracked ledger.
const STATE_DIR = ['docs', '.output', '.state'];
const LOCK_DIR = [...STATE_DIR, 'locks'];
const TMP_DIR = [...STATE_DIR, 'tmp'];
const LEDGER_PATH_RE = /^docs\/\.output\/evolution\/skills\/\d{4}-\d{2}-\d{2}\/ledger\.json$/;
const LEDGER_VERSION = 1;
const DISPOSITIONS = ['applied', 'dropped', 'staged', 'rejected'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A commit id: SHA-1 (40) or SHA-256 (64) object format, lower case once stored.
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const COMMIT_INPUT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const EVIDENCE_ID_RE = /^[^\s,]+$/;
const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_MS = 45 * 1000; // longer than the stale age, so a waiter that arrives just after a holder died still outlives the lock
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const LEDGER_ROTATION_OVERLAP = 100;
const STEP_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BUFFER = 256 * 1024 * 1024;
const VERDICT_FIELDS = [
    'verdict', 'exitCode', 'reasons', 'warnings', 'minReplicates', 'baselineConfig', 'delta', 'holdoutDelta',
    'fragile', 'lowPower', 'lowPowerReasons', 'nEvals', 'minRunsPerArm', 'discordantAssertions', 'totals', 'proseGrowth',
];

// ─── the side-door classifier (pure) ─────────────────────────────────────────

// Words whose one-letter change flips a rule: never read as a typo.
const GUARD_WORDS = new Set(['no', 'never', 'always', 'only', 'must', 'should', 'may', 'might', 'cannot', 'shall']);
// Known antonym, negation and look-alike pairs (unordered, lower case). The corpus rule below is the real test; this
// list names the flips a skill can contain so that they never rest on a statistic alone.
const MEANING_FLIPS = (
    'skip/ship reuse/refuse same/some push/pull include/exclude minimum/maximum increase/decrease enable/unable enable/disable '
    + 'accept/except allow/allot stop/step pass/past fail/fall shall/small shall/shell never/ever after/alter first/last allow/deny '
    + 'before/behind require/acquire prefer/defer trust/truss block/black guard/guide'
).split(' ').map((pair) => pair.split('/'));
const FLIP_SET = new Set(MEANING_FLIPS.map(([a, b]) => `${a}\0${b}`).concat(MEANING_FLIPS.map(([a, b]) => `${b}\0${a}`)));
const NEGATING_PREFIXES = ['un', 'in', 'im', 'il', 'ir', 'dis', 'non', 'de', 'ex', 'anti', 'mis'];
const POINTER_EXTENSION = /\.(md|js|cjs|mjs|json|yaml|yml)$/i;
const TYPO_MIN_LETTERS = 5;
const TYPO_MAX_DISTANCE = 1;
const TYPO_MIN_NEW_OCCURRENCES = 2;
const PIN_MIN_LENGTH = 12;
// A line that carries a marker, a command flag, a tag, a table cell, an import or an inline code span is structure, not prose.
const STRUCTURAL_CHARS = /[<>|`@]|-{2,}/;
const TEST_FILE = /(^|\/)(__tests__|tests?|fixtures?)\/|\.(test|spec)\.[^/]+$/i;

function isMeaningFlip(a, b) {
    if (FLIP_SET.has(`${a}\0${b}`)) return true;
    return NEGATING_PREFIXES.some((p) => a === `${p}${b}` || b === `${p}${a}`);
}

/** Damerau-Levenshtein distance (optimal string alignment): insert, delete, substitute, adjacent transposition. */
function editDistance(a, b) {
    const x = Array.from(a);
    const y = Array.from(b);
    const d = [];
    for (let i = 0; i <= x.length; i++) {
        d.push(new Array(y.length + 1).fill(0));
        d[i][0] = i;
    }
    for (let j = 0; j <= y.length; j++) d[0][j] = j;
    for (let i = 1; i <= x.length; i++) {
        for (let j = 1; j <= y.length; j++) {
            const cost = x[i - 1] === y[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
            }
        }
    }
    return d[x.length][y.length];
}

function frontmatterMask(lines) {
    const mask = lines.map(() => false);
    if (lines.length === 0 || !/^---\s*$/.test(lines[0])) return mask;
    let end = lines.length - 1; // an unterminated block protects the whole file
    for (let i = 1; i < lines.length; i++) {
        if (/^---\s*$/.test(lines[i])) {
            end = i;
            break;
        }
    }
    for (let i = 0; i <= end; i++) mask[i] = true;
    return mask;
}

/** True for every line of a fenced code block, its fence lines included. */
function fenceMask(lines) {
    const mask = [];
    let open = null;
    for (const line of lines) {
        const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (open === null) {
            if (m) {
                open = { ch: m[1][0], len: m[1].length };
                mask.push(true);
            } else {
                mask.push(false);
            }
        } else {
            mask.push(true);
            if (m && m[1][0] === open.ch && m[1].length >= open.len && m[2].trim() === '') open = null;
        }
    }
    return mask;
}

/** Per token: true when it contains a backtick or sits inside an inline code span (command text is never a typo). */
function inlineCodeFlags(tokens) {
    let open = false;
    return tokens.map((token) => {
        const ticks = (token.match(/`/g) || []).length;
        const flagged = open || ticks > 0;
        if (ticks % 2 === 1) open = !open;
        return flagged;
    });
}

const normalizeForPin = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * A typo is a whole-word swap that FIXES A MISSPELLING: one edit, five letters or more, the same first letter, and the
 * old word occurs nowhere in the corpus except in the places this delta fixes (checked once per delta, see
 * `unfixedMisspellings`) while the new word is established there. `ctx.wordCount` is required: without a corpus nothing
 * is a typo.
 */
function typoKind(a, b, inCode, ctx) {
    if (inCode || ctx === undefined || typeof ctx.wordCount !== 'function') return null;
    const ma = a.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su);
    const mb = b.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su);
    if (!ma || !mb || ma[1] !== mb[1] || ma[3] !== mb[3]) return null;
    if (!/^\p{L}+$/u.test(ma[2]) || !/^\p{L}+$/u.test(mb[2])) return null;
    const x = ma[2].toLowerCase();
    const y = mb[2].toLowerCase();
    if (x === y) return null; // a case-only change is not a typo fix
    if (Array.from(x).length < TYPO_MIN_LETTERS || Array.from(y).length < TYPO_MIN_LETTERS) return null;
    if (Array.from(x)[0] !== Array.from(y)[0]) return null;
    if (GUARD_WORDS.has(x) || GUARD_WORDS.has(y) || isMeaningFlip(x, y)) return null;
    if (editDistance(x, y) > TYPO_MAX_DISTANCE) return null;
    if (ctx.wordCount(y) < TYPO_MIN_NEW_OCCURRENCES) return null;
    ctx.replaced.set(x, (ctx.replaced.get(x) || 0) + 1);
    ctx.fileWords.add(x);
    return 'typo';
}

function pointerParts(token) {
    const m = token.match(/^([`'"(\[{<]*)(.*?)([`'")\]}>,;:!?.]*)$/s);
    if (!m) return null;
    const core = m[2];
    if (core === '' || !(core.includes('/') || POINTER_EXTENSION.test(core))) return null;
    return { lead: m[1], core, trail: m[3] };
}

function stalePointerKind(a, b, exists) {
    if (typeof exists !== 'function') return null;
    const pa = pointerParts(a);
    const pb = pointerParts(b);
    if (!pa || !pb || pa.lead !== pb.lead || pa.trail !== pb.trail || pa.core === pb.core) return null;
    try {
        return !exists(pa.core) && exists(pb.core) === true ? 'stale-pointer' : null;
    } catch {
        return null;
    }
}

/** True when `isPinned` (a trusted lookup the caller of the pure function supplies) vouches for the new line. */
function pinnedKind(oldLine, newLine, ctx) {
    if (typeof ctx.isPinned !== 'function') return false;
    const text = newLine.trim();
    if (text.length < PIN_MIN_LENGTH || STRUCTURAL_CHARS.test(oldLine) || STRUCTURAL_CHARS.test(newLine)) return false;
    if (normalizeForPin(oldLine) !== normalizeForPin(newLine)) return false;
    try {
        return ctx.isPinned(text, ctx.filePath) === true;
    } catch {
        return false;
    }
}

function classifyLine(oldLine, newLine, ctx) {
    if (pinnedKind(oldLine, newLine, ctx)) return { kinds: ['pinned-text'] };
    const a = oldLine.trim().split(/\s+/);
    const b = newLine.trim().split(/\s+/);
    if (a.length !== b.length) return { reason: 'the token count changed' };
    const flagsA = inlineCodeFlags(a);
    const flagsB = inlineCodeFlags(b);
    const kinds = [];
    for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        const kind = typoKind(a[i], b[i], flagsA[i] || flagsB[i], ctx) || stalePointerKind(a[i], b[i], ctx.exists);
        if (kind === null) return { reason: `"${a[i]}" -> "${b[i]}" is not a typo or a stale pointer` };
        kinds.push(kind);
    }
    if (kinds.length === 0) return { reason: 'only whitespace or punctuation changed' };
    return { kinds };
}

/** The misspellings of this delta that still occur elsewhere in the corpus: [{word, remaining}]. */
function unfixedMisspellings(wordCount, replaced) {
    const out = [];
    for (const [word, fixed] of replaced) {
        const remaining = wordCount(word) - fixed;
        if (remaining > 0) out.push({ word, remaining });
    }
    return out;
}

const misspellingReason = (bad) => `the old word "${bad[0].word}" still occurs ${bad[0].remaining} time(s) elsewhere in the skill corpus, so this is not a misspelling being fixed`;

function classifyOne(before, after, o, replaced, filePath) {
    if (typeof before !== 'string' || typeof after !== 'string') {
        return { class: 'behavior', kinds: [], reason: 'input is not text', typoWords: new Set() };
    }
    if (before === after) return { class: 'noop', kinds: [], reason: 'identical text', typoWords: new Set() };
    const oldLines = before.split('\n');
    const newLines = after.split('\n');
    if (oldLines.length !== newLines.length) {
        return { class: 'behavior', kinds: [], reason: `the line count changed (${oldLines.length} -> ${newLines.length})`, typoWords: new Set() };
    }
    const ctx = {
        wordCount: typeof o.wordCount === 'function' ? o.wordCount : undefined,
        isPinned: o.isPinned,
        exists: o.exists,
        filePath,
        replaced,
        fileWords: new Set(),
    };
    const fmOld = frontmatterMask(oldLines);
    const fmNew = frontmatterMask(newLines);
    const fenceOld = fenceMask(oldLines);
    const fenceNew = fenceMask(newLines);
    const kinds = new Set();
    const behavior = (reason) => ({ class: 'behavior', kinds: [], reason, typoWords: ctx.fileWords });
    for (let i = 0; i < oldLines.length; i++) {
        if (oldLines[i] === newLines[i]) continue;
        if (fmOld[i] || fmNew[i]) return behavior(`line ${i + 1} is inside the frontmatter`);
        if (fenceOld[i] || fenceNew[i]) return behavior(`line ${i + 1} is inside a fenced code block`);
        const verdict = classifyLine(oldLines[i], newLines[i], ctx);
        if (verdict.kinds === undefined) return behavior(`line ${i + 1}: ${verdict.reason}`);
        for (const kind of verdict.kinds) kinds.add(kind);
    }
    const sorted = [...kinds].sort();
    return { class: 'exempt', kinds: sorted, reason: `every changed line is exempt (${sorted.join(', ')})`, typoWords: ctx.fileWords };
}

/**
 * Classify one text edit. `noop` (identical), `exempt` (every changed line is a typo, a stale pointer or a pinned-text
 * restore) or `behavior` (anything else, and every malformed input). Never throws.
 *
 * options (all optional; an absent one switches its class OFF, never on):
 *   wordCount(lowerCaseWord) -> occurrences in the skill corpus   (the typo class needs it)
 *   isPinned(line, path)     -> true when a trusted source already carries that line   (the pinned-text class)
 *   exists(pointer)          -> true when the path exists          (the stale-pointer class)
 */
function classifyEdit(before, after, options) {
    try {
        const o = options && typeof options === 'object' ? options : {};
        const replaced = new Map();
        const r = classifyOne(before, after, o, replaced, undefined);
        if (r.class === 'exempt' && r.kinds.includes('typo')) {
            const bad = unfixedMisspellings(o.wordCount, replaced);
            if (bad.length > 0) return { class: 'behavior', kinds: [], reason: misspellingReason(bad) };
        }
        return { class: r.class, kinds: r.kinds, reason: r.reason };
    } catch (err) {
        return { class: 'behavior', kinds: [], reason: `classification failed: ${errorMessage(err)}` };
    }
}

/**
 * Classify a whole delta: `behavior` when any file is (an added or deleted file always is), `exempt` when at least one
 * file is exempt and none is behavior, else `noop`. The misspelling rule is judged over the whole delta (a misspelling
 * fixed in one file and left in another is not a misspelling being fixed). Never throws.
 */
function classifyChange(changes, options) {
    try {
        if (!Array.isArray(changes)) return { class: 'behavior', kinds: [], files: [], reason: 'changes is not an array' };
        const o = options && typeof options === 'object' ? options : {};
        const replaced = new Map();
        const files = changes.map((entry) => {
            if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') {
                return { path: String(entry && entry.path), class: 'behavior', kinds: [], reason: 'malformed entry', typoWords: new Set() };
            }
            if (entry.before === null || entry.after === null) {
                return { path: entry.path, class: 'behavior', kinds: [], reason: entry.before === null ? 'a file was added' : 'a file was deleted', typoWords: new Set() };
            }
            const r = classifyOne(entry.before, entry.after, o, replaced, entry.path);
            return { path: entry.path, class: r.class, kinds: r.kinds, reason: r.reason, typoWords: r.typoWords };
        });
        const bad = unfixedMisspellings(o.wordCount, replaced);
        if (bad.length > 0) {
            const badWords = new Set(bad.map((b) => b.word));
            for (const f of files) {
                if (f.class === 'exempt' && [...f.typoWords].some((w) => badWords.has(w))) {
                    f.class = 'behavior';
                    f.kinds = [];
                    f.reason = misspellingReason(bad);
                }
            }
        }
        const clean = files.map(({ typoWords, ...rest }) => rest);
        const kinds = [...new Set(clean.flatMap((f) => f.kinds))].sort();
        if (clean.some((f) => f.class === 'behavior')) return { class: 'behavior', kinds, files: clean };
        return { class: clean.some((f) => f.class === 'exempt') ? 'exempt' : 'noop', kinds, files: clean };
    } catch (err) {
        return { class: 'behavior', kinds: [], files: [], reason: `classification failed: ${errorMessage(err)}` };
    }
}

// ─── small helpers ───────────────────────────────────────────────────────────

class Refusal extends Error {
    constructor(step, reason, extra) {
        super(reason);
        this.step = step;
        this.extra = extra || {};
    }
}

function errorMessage(err) {
    return err && typeof err.message === 'string' ? err.message : String(err);
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function tail(text, max) {
    const s = String(text || '').trim();
    return s.length > max ? `...${s.slice(s.length - max)}` : s;
}

function isDirectory(p) {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function isUnder(parent, child) {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realOrSelf(p) {
    try {
        return fs.realpathSync(p);
    } catch {
        return path.resolve(p);
    }
}

function defaultRoot() {
    return process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..', '..');
}

// ─── git (argv arrays only, never a shell, no remote verbs, hooks off) ───────

const GIT_REDIRECT_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CONFIG|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|PREFIX)$/;

function makeGit(root, noHooksDir) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) if (!GIT_REDIRECT_ENV.test(key)) env[key] = value;
    env.GIT_LITERAL_PATHSPECS = '1';
    // `-C <root>` as well as `cwd`: the probe is anchored to the named repository, never to wherever a redirecting variable points.
    const prefix = ['--no-optional-locks', '-C', root, '-c', `core.hooksPath=${noHooksDir}`, '-c', 'core.fsmonitor=false'];
    // `check-ignore` refuses pathspec magic, so it alone runs without GIT_LITERAL_PATHSPECS (it takes plain paths, never patterns).
    const plainEnv = { ...env };
    delete plainEnv.GIT_LITERAL_PATHSPECS;
    const run = (args, options) => {
        const o = options || {};
        const r = spawnSync('git', [...prefix, ...args], {
            cwd: root,
            env: o.plainPaths ? plainEnv : env,
            input: o.input,
            encoding: o.buffer ? null : 'utf8',
            maxBuffer: MAX_BUFFER,
            windowsHide: true,
        });
        return {
            status: r.error ? null : r.status,
            stdout: r.stdout === null || r.stdout === undefined ? (o.buffer ? Buffer.alloc(0) : '') : r.stdout,
            stderr: r.stderr ? String(r.stderr) : (r.error ? errorMessage(r.error) : ''),
        };
    };
    const out = (args) => {
        const r = run(args);
        if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${tail(r.stderr, 400)}`);
        return r.stdout.trim();
    };
    return { run, out };
}

/** A read-only git runner for `root`: `-C <root>`, no hooks, and without the GIT_DIR / GIT_WORK_TREE family (the shared reader of the audit trail). */
function gitFor(root) {
    return makeGit(path.resolve(root), os.devNull);
}

/** `git status` entries as [{xy, path, orig?}] (untracked files listed one by one). */
function statusEntries(git) {
    const r = git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (r.status !== 0) throw new Error(`git status failed: ${tail(r.stderr, 400)}`);
    const tokens = r.stdout.split('\0');
    const entries = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '') continue;
        const entry = { xy: token.slice(0, 2), path: token.slice(3) };
        if (entry.xy[0] === 'R' || entry.xy[0] === 'C' || entry.xy[1] === 'R' || entry.xy[1] === 'C') entry.orig = tokens[++i];
        entries.push(entry);
    }
    return entries;
}

const underPrefix = (p, prefix) => prefix !== null && (p === prefix.slice(0, -1) || p.startsWith(prefix));

/**
 * True for an evolution audit record: a ledger (`docs/.output/evolution/skills/{date}/ledger.json`, whatever its date) or
 * the revert-candidate queue `watch` writes (`docs/.output/evolution/skills/revert-candidates.json`). Neither is part of a
 * delta, so an untracked or modified one never blocks, and is never restored away by, the next apply.
 */
const REVERT_QUEUE_PATH = 'docs/.output/evolution/skills/revert-candidates.json';
const isLedgerPath = (p) => {
    const rel = String(p).replace(/\\/g, '/');
    return LEDGER_PATH_RE.test(rel) || rel === REVERT_QUEUE_PATH;
};

/**
 * `git status` entries minus the `--run` workspace when it sits inside the repository (`state.exclude`, a `dir/` prefix)
 * and minus every evolution ledger: the ledger is an audit record the run writes on purpose, so an earlier run's ledger
 * (untracked, or a committed one an earlier run modified) never blocks, and is never restored away by, the next apply.
 */
function visibleEntries(git, state) {
    const prefix = state.exclude === undefined ? null : state.exclude;
    return statusEntries(git).filter((e) => !underPrefix(e.path, prefix) && !isLedgerPath(e.path));
}

/** Tracked files `git ls-files -v` tags other than `H`: assume-unchanged (`h`) and skip-worktree (`S`) hide edits from `git status`. */
function flaggedTrackedFiles(git) {
    const r = git.run(['ls-files', '-v', '-z']);
    if (r.status !== 0) throw new Error(`git ls-files failed: ${tail(r.stderr, 400)}`);
    return r.stdout.split('\0').filter((l) => l !== '' && l[0] !== 'H').map((l) => ({ tag: l[0], path: l.slice(2) }));
}

// ─── trees, hashes and the workspace ─────────────────────────────────────────

/** Every file below `dir` as [{rel, abs, kind: 'file'|'symlink'|'other'}], forward-slash, sorted by code unit. */
function walkTree(dir) {
    const out = [];
    const visit = (abs, rel) => {
        for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
            const r = rel === '' ? ent.name : `${rel}/${ent.name}`;
            const a = path.join(abs, ent.name);
            if (ent.isSymbolicLink()) out.push({ rel: r, abs: a, kind: 'symlink' });
            else if (ent.isDirectory()) visit(a, r);
            else if (ent.isFile()) out.push({ rel: r, abs: a, kind: 'file' });
            else out.push({ rel: r, abs: a, kind: 'other' });
        }
    };
    visit(dir, '');
    return out.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
}

function entryDigest(entry) {
    if (entry.kind === 'file') return sha256(fs.readFileSync(entry.abs));
    if (entry.kind === 'symlink') return `link:${fs.readlinkSync(entry.abs)}`;
    return 'other';
}

/** One hash over a tree: every relative path with the digest of its content, in sorted order. */
function treeHash(entries) {
    const h = crypto.createHash('sha256');
    for (const e of entries) h.update(`${e.rel}\0${entryDigest(e)}\n`);
    return h.digest('hex');
}

function readOrNull(abs) {
    try {
        return fs.lstatSync(abs).isFile() ? fs.readFileSync(abs) : null;
    } catch {
        return null;
    }
}

/** A text file as a string; a file with a NUL byte stays a Buffer so the classifier calls it behavior. */
function asText(buf) {
    return buf === null ? null : (buf.includes(0) ? buf : buf.toString('utf8'));
}

function latestIteration(workspace) {
    let best = null;
    for (const ent of fs.readdirSync(workspace, { withFileTypes: true })) {
        const m = ent.isDirectory() ? ent.name.match(/^iteration-(\d+)$/) : null;
        if (m && (best === null || Number(m[1]) > best.n)) best = { n: Number(m[1]), dir: path.join(workspace, ent.name) };
    }
    return best === null ? null : best.dir;
}

/** The corpus the typo rule judges against: every word of every markdown file under `.agents/skills/`, lower case, counted. */
function buildWordCounts(root) {
    const counts = new Map();
    const base = path.join(root, '.agents', 'skills');
    if (!isDirectory(base)) return counts;
    let entries;
    try {
        entries = walkTree(base);
    } catch {
        return counts;
    }
    for (const e of entries) {
        if (e.kind !== 'file' || !/\.md$/i.test(e.rel)) continue;
        let text;
        try {
            if (fs.statSync(e.abs).size > 4 * 1024 * 1024) continue;
            text = fs.readFileSync(e.abs, 'utf8');
        } catch {
            continue;
        }
        for (const m of text.toLowerCase().matchAll(/\p{L}+/gu)) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
    }
    return counts;
}

/**
 * The pinned-text lookup, answered ONLY from the base commit (never from the working tree, never from the caller): the
 * line already appears in a tracked test or fixture there, or the file's own history there already held it (a restore).
 */
function makePinnedLookup(git, base) {
    return (line, relPath) => {
        if (typeof line !== 'string' || line.length < PIN_MIN_LENGTH) return false;
        const grep = git.run(['grep', '-l', '-F', '-e', line, base]);
        if (grep.status === 0) {
            const prefix = `${base}:`;
            for (const hit of grep.stdout.split('\n')) {
                const file = hit.startsWith(prefix) ? hit.slice(prefix.length) : hit;
                if (file !== '' && TEST_FILE.test(file)) return true;
            }
        }
        if (typeof relPath !== 'string' || relPath === '') return false;
        const log = git.run(['log', '-n', '1', '--format=%H', `-S${line}`, base, '--', relPath]);
        return log.status === 0 && log.stdout.trim() !== '';
    };
}

// ─── byte ledger: what restore needs, independent of git ─────────────────────

function removeEmptyParents(root, abs) {
    let dir = path.dirname(abs);
    while (isUnder(root, dir) && dir !== root && path.basename(dir) !== '.git') {
        try {
            fs.rmdirSync(dir);
        } catch {
            return;
        }
        dir = path.dirname(dir);
    }
}

function captureInto(root, rel, into, budget) {
    const abs = path.join(root, ...rel.split('/'));
    let st;
    try {
        st = fs.lstatSync(abs);
    } catch {
        return; // absent: nothing to restore, anything that appears there later is removed
    }
    if (st.isSymbolicLink()) {
        into.set(rel, { kind: 'symlink', target: fs.readlinkSync(abs) });
        return;
    }
    if (st.isDirectory()) {
        for (const name of fs.readdirSync(abs).sort()) captureInto(root, `${rel}/${name}`, into, budget);
        return;
    }
    if (!st.isFile()) throw new Refusal('input', `${rel} is not a regular file, a directory or a symlink: the helper cannot restore it`);
    budget.bytes += st.size;
    if (budget.bytes > budget.max) throw new Refusal('input', `the directories apply writes hold more than ${budget.max} bytes: too large to snapshot for a byte-exact restore`);
    const bytes = fs.readFileSync(abs);
    into.set(rel, { kind: 'file', bytes, sha: sha256(bytes), mode: st.mode & 0o777 });
}

/** The bytes, modes and link targets of every file below `rels` (tracked, untracked, ignored or flagged alike). */
function takeLedger(root, rels) {
    const entries = new Map();
    const budget = { bytes: 0, max: MAX_SNAPSHOT_BYTES };
    for (const rel of rels) captureInto(root, rel, entries, budget);
    return { rels, entries };
}

function sameEntry(a, b) {
    if (a === undefined || b === undefined || a.kind !== b.kind) return false;
    if (a.kind === 'symlink') return a.target === b.target;
    return a.sha === b.sha && (process.platform === 'win32' || a.mode === b.mode);
}

/** Put every ledger path back to its recorded bytes, delete what did not exist, then verify each by sha256. Throws if any differs. */
function restoreLedger(root, ledger) {
    const unlimited = { bytes: 0, max: Infinity };
    const abs = (rel) => path.join(root, ...rel.split('/'));
    const current = new Map();
    for (const rel of ledger.rels) captureInto(root, rel, current, unlimited);
    for (const rel of current.keys()) {
        if (ledger.entries.has(rel)) continue;
        fs.rmSync(abs(rel), { force: true });
        removeEmptyParents(root, abs(rel));
    }
    for (const [rel, want] of ledger.entries) {
        if (sameEntry(want, current.get(rel))) continue;
        const file = abs(rel);
        fs.rmSync(file, { recursive: true, force: true }); // a directory or a link where a file belongs
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (want.kind === 'symlink') {
            fs.symlinkSync(want.target, file);
        } else {
            fs.writeFileSync(file, want.bytes);
            if (process.platform !== 'win32') fs.chmodSync(file, want.mode);
        }
    }
    const after = new Map();
    for (const rel of ledger.rels) captureInto(root, rel, after, unlimited);
    const wrong = [...new Set([...ledger.entries.keys(), ...after.keys()])].filter((rel) => !sameEntry(ledger.entries.get(rel), after.get(rel)));
    if (wrong.length > 0) throw new Error(`${wrong.length} file(s) are not byte-exact after the restore: ${wrong.slice(0, 5).join(', ')}`);
}

/** The failure ledger may only grow (or rotate its own tail): `before` is a prefix of `after`, or its last lines lead `after`. */
function isAppendOnly(before, after) {
    if (after === null) return before === null;
    if (before === null || before.length === 0) return true;
    if (after.length >= before.length && after.subarray(0, before.length).equals(before)) return true;
    const oldLines = before.toString('utf8').split('\n');
    const newLines = after.toString('utf8').split('\n');
    if (oldLines[oldLines.length - 1] === '') oldLines.pop();
    if (newLines[newLines.length - 1] === '') newLines.pop();
    for (let k = 1; k <= oldLines.length - LEDGER_ROTATION_OVERLAP; k++) {
        const kept = oldLines.slice(k);
        if (newLines.length >= kept.length && kept.every((line, i) => newLines[i] === line)) return true;
    }
    return false;
}

// ─── input ───────────────────────────────────────────────────────────────────

function branchProblem(branch) {
    if (typeof branch !== 'string' || !BRANCH_RE.test(branch)) return 'a branch name must be auto/<name> (letters, digits, ".", "_", "-", "/")';
    if (branch.includes('..') || branch.includes('//') || /[\/.]$/.test(branch)) return 'a branch name must not contain "..", "//" or end in "/" or "."';
    if (branch.split('/').some((segment) => segment.startsWith('.') || segment.endsWith('.lock'))) return 'a branch segment must not start with "." or end in ".lock"';
    return null;
}

/** The workspace directories every verb needs. Throws an `input` refusal. */
function readWorkspace(runArg) {
    const bad = (reason) => new Refusal('input', reason);
    if (typeof runArg !== 'string' || runArg === '') throw bad('--run <workspace> is required');
    const run = path.resolve(runArg);
    if (!isDirectory(run)) throw bad(`workspace is not a directory: ${run}`);
    const snapshotDir = path.join(run, 'skill-snapshot');
    if (!isDirectory(snapshotDir)) throw bad(`workspace has no skill-snapshot/ directory: ${run}`);
    const candidateDir = [path.join(run, 'candidate'), path.join(run, 'skill-candidate')].find(isDirectory);
    if (candidateDir === undefined) throw bad(`workspace has no candidate/ (or skill-candidate/) directory: ${run}`);
    if (fs.lstatSync(candidateDir).isSymbolicLink() || fs.lstatSync(snapshotDir).isSymbolicLink()) throw bad('the snapshot and candidate directories must not be symlinks');
    const candidate = walkTree(candidateDir);
    if (candidate.length === 0) throw bad('the candidate directory holds no files');
    return { run, runReal: realOrSelf(run), snapshotDir, candidateDir, candidate };
}

/** The one iteration that may supply evidence: the highest `iteration-<N>/` directly inside the workspace. */
function resolveIteration(ws, iterationArg) {
    const latest = latestIteration(ws.run);
    if (latest === null) throw new Refusal('input', 'the verdict route needs an iteration-<N>/ directory in the workspace');
    if (iterationArg !== undefined && realOrSelf(path.resolve(String(iterationArg))) !== realOrSelf(latest)) {
        throw new Refusal('input', `--iteration must be the highest iteration-<N> directory of --run (${latest}); a foreign or older iteration is never judged`);
    }
    return latest;
}

/** The holdout of the chosen iteration inside the workspace (`<run>/holdout/iteration-<N>`), or null when it holds none. `--holdout` may only name it. */
function resolveHoldout(iteration, holdoutArg) {
    const expected = path.join(path.dirname(iteration), 'holdout', path.basename(iteration));
    if (holdoutArg !== undefined && realOrSelf(path.resolve(String(holdoutArg))) !== realOrSelf(expected)) {
        throw new Refusal('input', `--holdout must be ${expected} (the holdout of the chosen iteration inside --run)`);
    }
    let st = null;
    try {
        st = fs.lstatSync(expected);
    } catch {
        st = null;
    }
    if (st === null) {
        if (holdoutArg !== undefined) throw new Refusal('input', `--holdout is not a directory: ${expected}`);
        return null;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Refusal('input', `${expected} must be a real directory`);
    return expected;
}

function validate(o) {
    const bad = (reason) => new Refusal('input', reason);
    if (typeof o.skill !== 'string' || !SKILL_RE.test(o.skill)) throw bad('skill must be a skill directory name (letters, digits, ".", "_", "-")');
    const root = path.resolve(typeof o.root === 'string' && o.root !== '' ? o.root : defaultRoot());
    if (!isDirectory(root)) throw bad(`root is not a directory: ${root}`);
    const skillDir = path.join(root, '.agents', 'skills', o.skill);
    if (!isDirectory(skillDir)) throw bad(`unknown skill directory: .agents/skills/${o.skill}`);

    const mode = o.mode === undefined ? 'propose' : o.mode;
    if (!MODES.includes(mode)) throw bad(`--mode must be one of ${MODES.join(', ')}`);
    const route = o.route === undefined ? 'verdict' : o.route;
    if (!ROUTES.includes(route)) throw bad(`--route must be one of ${ROUTES.join(', ')}`);

    let branch = null;
    if (mode === 'apply') {
        if (o.branch === undefined) throw bad('--mode apply needs --branch auto/<name>');
        const problem = branchProblem(o.branch);
        if (problem !== null) throw bad(problem);
        branch = o.branch;
    } else if (o.branch !== undefined) {
        throw bad('--branch only applies with --mode apply');
    }

    if (o.candidateSha256 !== undefined && !(typeof o.candidateSha256 === 'string' && HEX64_RE.test(o.candidateSha256))) {
        throw bad('--candidate-sha256 must be 64 hex characters');
    }
    if (mode === 'apply' && o.candidateSha256 === undefined) {
        throw bad('--mode apply needs --candidate-sha256 <candidateSha256 printed by the propose run>: the candidate applied must be the one that was proposed');
    }
    let minReplicates;
    if (o.minReplicates !== undefined) {
        if (!/^[1-9]\d*$/.test(String(o.minReplicates))) throw bad('--min-replicates must be a positive integer');
        minReplicates = String(o.minReplicates);
    }
    if (o.date !== undefined && !validDate(o.date)) throw bad('--date must be a YYYY-MM-DD date (a real calendar day)');
    const date = o.date === undefined ? dayKey() : o.date;
    const evidence = parseEvidence(o.evidence);

    const ws = readWorkspace(o.run);
    let iteration = null;
    let holdout = null;
    if (route === 'verdict') {
        iteration = resolveIteration(ws, o.iteration);
        try {
            JSON.parse(fs.readFileSync(path.join(iteration, 'benchmark.json'), 'utf8'));
        } catch (err) {
            throw bad(`iteration benchmark.json is missing or unparseable (run skill-eval aggregate): ${errorMessage(err)}`);
        }
        holdout = resolveHoldout(iteration, o.holdout);
    } else if (o.iteration !== undefined || o.holdout !== undefined) {
        throw bad('--iteration and --holdout only apply to the verdict route');
    }

    return {
        root, skill: o.skill, skillDir, skillRel: `.agents/skills/${o.skill}`, mode, route, branch, run: ws.run, runReal: ws.runReal,
        snapshotDir: ws.snapshotDir, candidateDir: ws.candidateDir, candidate: ws.candidate, iteration, holdout, minReplicates,
        candidatePin: o.candidateSha256, date, evidence,
    };
}

/** `--evidence id[,id...]` (a string, or an array of ids) -> the ids. Every id is non-empty with no whitespace and no comma. */
function parseEvidence(value) {
    if (value === undefined) return [];
    const ids = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(',') : null);
    if (ids === null) throw new Refusal('input', '--evidence must be a comma-separated list of evidence ids');
    for (const id of ids) {
        if (typeof id !== 'string' || !EVIDENCE_ID_RE.test(id)) {
            throw new Refusal('input', `--evidence ids must be non-empty with no whitespace and no comma (got ${JSON.stringify(id)})`);
        }
    }
    return [...ids];
}

/** The binding shape this code writes and reads: version 2 added `gradings` (the hashes of the grading and benchmark files). */
const BINDING_VERSION = 2;
/** The files whose content decides a verdict and that a session can write: the grader output and the aggregate. */
const GRADING_FILE_NAMES = new Set(['grading.json', 'benchmark.json']);

/**
 * The sha256 of every `grading.json` and `benchmark.json` under the iteration and under its holdout (null when it has none),
 * keyed by the path relative to the workspace (`iteration-1/eval-0-e0/with_skill/run-1/grading.json`,
 * `holdout/iteration-1/benchmark.json`) and sorted by code unit. A symbolic link or special file under one of those names is a
 * refusal: the reader would follow it, so the hash would not describe what is read.
 */
function gradingHashes(iteration, holdout, step) {
    const name = path.basename(iteration);
    const roots = [[iteration, name]];
    if (holdout !== null) roots.push([holdout, `holdout/${name}`]);
    const rows = [];
    for (const [dir, prefix] of roots) {
        for (const e of walkTree(dir)) {
            if (!GRADING_FILE_NAMES.has(e.rel.slice(e.rel.lastIndexOf('/') + 1))) continue;
            const key = `${prefix}/${e.rel}`;
            if (e.kind !== 'file') {
                throw new Refusal(step, `${key} is a ${e.kind === 'symlink' ? 'symbolic link' : 'special file'}, not a regular file; the grading evidence must be plain files so its hash describes what is read`);
            }
            rows.push([key, sha256(fs.readFileSync(e.abs))]);
        }
    }
    rows.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    return Object.fromEntries(rows);
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** What differs between the bound grading hashes and the files now: edited, missing and added paths, sorted. */
function gradingDifferences(bound, now) {
    const out = [];
    for (const key of Object.keys(bound).sort()) {
        if (!hasOwn(now, key)) out.push(`${key} is missing`);
        else if (now[key] !== bound[key]) out.push(`${key} was edited`);
    }
    for (const key of Object.keys(now).sort()) if (!hasOwn(bound, key)) out.push(`${key} was added`);
    return out;
}

/** Refuse unless every grading and benchmark file under the iteration and its holdout is byte-for-byte what the binding recorded. */
function assertGradingsBound(v, binding) {
    const name = path.basename(v.iteration);
    const diff = gradingDifferences(binding.gradings, gradingHashes(v.iteration, v.holdout, 'candidate-hash'));
    if (diff.length > 0) {
        throw new Refusal('candidate-hash', `the grading evidence of ${name} changed after it was bound (${diff.slice(0, 5).join('; ')}${diff.length > 5 ? `; and ${diff.length - 5} more` : ''}); the verdict is computed from those files, so re-evaluate into a new iteration`);
    }
}

/** `iteration-<N>/binding.json`: what that iteration graded: the candidate and snapshot hashes and the grading file hashes. */
function readBinding(iteration) {
    const name = path.basename(iteration);
    const file = path.join(iteration, 'binding.json');
    const missing = (why) => new Refusal('candidate-hash', `${name}/binding.json ${why}: bind the evaluation right after it ran (\`skill-evolution.js bind --run <workspace>\`) so the candidate applied is the candidate that was graded`);
    let json;
    try {
        if (!fs.lstatSync(file).isFile()) throw new Error('not a regular file');
        json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        throw missing('is missing or unreadable');
    }
    if (json === null || typeof json !== 'object' || !HEX64_RE.test(String(json.candidateSha256)) || !HEX64_RE.test(String(json.snapshotSha256)) || json.iteration !== name) {
        throw missing(`is malformed or belongs to another iteration (it needs candidateSha256, snapshotSha256 and iteration "${name}")`);
    }
    const grades = json.gradings;
    if (json.version !== BINDING_VERSION || grades === null || typeof grades !== 'object' || Array.isArray(grades)) {
        throw missing(`has no grading hashes (it is not a version ${BINDING_VERSION} binding: it needs a "gradings" object of grading.json and benchmark.json hashes)`);
    }
    const gradings = {};
    for (const [key, hash] of Object.entries(grades)) {
        if (typeof hash !== 'string' || !HEX64_RE.test(hash)) throw missing(`has a grading hash for ${JSON.stringify(key)} that is not a sha256`);
        gradings[key] = hash.toLowerCase();
    }
    if (!hasOwn(gradings, `${name}/benchmark.json`)) throw missing(`does not cover ${name}/benchmark.json`);
    return { candidateSha256: String(json.candidateSha256).toLowerCase(), snapshotSha256: String(json.snapshotSha256).toLowerCase(), gradings };
}

// ─── the trusted judge ───────────────────────────────────────────────────────

function makeTmp(root) {
    const tmp = realOrSelf(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-apply-')));
    if (isUnder(realOrSelf(root), tmp)) throw new Refusal('scope', `the temporary directory ${tmp} is inside the judged tree; point TMPDIR outside it`);
    fs.mkdirSync(path.join(tmp, 'no-hooks'));
    return tmp;
}

/** Extract the base commit's `_lib` files (blobs directly in the directory) into `<tmp>/trusted`; return the checker path. */
function extractTrusted(git, tmp, base) {
    for (const dir of HELPER_DIRS.map((d) => `${d}/_lib`)) {
        const ls = git.run(['ls-tree', '-z', base, `${dir}/`]);
        if (ls.status !== 0) continue;
        const blobs = ls.stdout.split('\0').filter(Boolean).map((line) => {
            const tab = line.indexOf('\t');
            const [mode, type, oid] = line.slice(0, tab).split(' ');
            return { mode, type, oid, name: path.posix.basename(line.slice(tab + 1)) };
        }).filter((e) => e.type === 'blob' && (e.mode === '100644' || e.mode === '100755'));
        if (!blobs.some((e) => e.name === 'improvement-scope.js')) continue;
        const cat = git.run(['cat-file', '--batch'], { input: `${blobs.map((e) => e.oid).join('\n')}\n`, buffer: true });
        if (cat.status !== 0) throw new Refusal('scope', `could not read the trusted copy from ${base}: ${tail(cat.stderr, 300)}`);
        const target = path.join(tmp, 'trusted');
        fs.mkdirSync(target);
        let pos = 0;
        for (const e of blobs) {
            const nl = cat.stdout.indexOf(0x0a, pos);
            const header = nl === -1 ? [] : cat.stdout.toString('utf8', pos, nl).split(' ');
            if (header[1] !== 'blob') throw new Refusal('scope', `could not read the trusted copy of ${e.name} from ${base}`);
            const size = Number(header[2]);
            fs.writeFileSync(path.join(target, e.name), cat.stdout.subarray(nl + 1, nl + 1 + size));
            pos = nl + 1 + size + 1;
        }
        return path.join(target, 'improvement-scope.js');
    }
    throw new Refusal('scope', `no improvement-scope.js in the base commit ${base} (looked in ${HELPER_DIRS.map((d) => `${d}/_lib`).join(', ')})`);
}

// The caller's git redirects (a hook's GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE) never reach the render, the check or the gate:
// makeGit strips them for the helper's own git calls and these children get the same filter.
function stepEnv(root) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) if (!GIT_REDIRECT_ENV.test(key)) env[key] = value;
    env.CLAUDE_PROJECT_DIR = root;
    return env;
}

function runNode(root, script, args) {
    const r = spawnSync(process.execPath, [script, ...args], {
        cwd: root,
        env: stepEnv(root),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: MAX_BUFFER,
        timeout: STEP_TIMEOUT_MS,
        windowsHide: true,
    });
    const output = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.error) return { status: null, stdout: r.stdout || '', output: `${output}\n${errorMessage(r.error)}` };
    return { status: r.status, stdout: r.stdout || '', output };
}

function runScope(ctx, verb, args) {
    const r = runNode(ctx.root, ctx.scopeFile, [verb, ...args]);
    let json = null;
    try {
        json = JSON.parse(r.stdout.trim());
    } catch {
        json = null;
    }
    return { status: r.status, json, output: r.output };
}

/** Paths a refused scope result names, or the reason it could not run. Throws a `scope` refusal. */
function scopeRefusal(prefix, r, keep) {
    const j = r.json;
    if (r.status === 1 && j && Array.isArray(j.violations)) {
        const violations = keep(j.violations);
        if (violations.length > 0) {
            throw new Refusal('scope', `${prefix}: ${violations.length} path(s) outside the editable scope: ${violations.slice(0, 5).map((v) => v.path).join(', ')}`, { violations });
        }
        return;
    }
    throw new Refusal('scope', `${prefix}: the scope check could not run (${(j && (j.error || j.reason)) || tail(r.output, 300)})`);
}

function classifyCandidatePaths(ctx, v) {
    const violations = [];
    for (const e of v.candidate) {
        const rel = `${v.skillRel}/${e.rel}`;
        if (e.kind !== 'file') {
            violations.push({ path: rel, class: 'protected', reason: e.kind === 'symlink' ? 'symlink' : 'not-a-regular-file' });
            continue;
        }
        // A candidate that is a whole skill version (what `skill-regress.js run` measures and leaves in the workspace) carries files
        // it did not change, among them a skill's `scripts/` and `evals/`. A file byte-identical to the live one is no part of the
        // delta, so it is not judged: the changed and new files are. (A symlink above is judged whatever it points at.)
        const live = readOrNull(path.join(v.skillDir, ...e.rel.split('/')));
        if (live !== null && live.equals(fs.readFileSync(e.abs))) continue;
        const r = runScope(ctx, 'classify', [rel, '--target', v.skill, '--root', ctx.root]);
        if (r.status === 0 && r.json && r.json.class === 'editable') continue;
        if (r.status === 1 && r.json && typeof r.json.class === 'string') {
            violations.push({ path: r.json.path || rel, class: r.json.class, reason: r.json.reason });
            continue;
        }
        throw new Refusal('scope', `the scope check could not classify ${rel}: ${(r.json && (r.json.error || r.json.reason)) || tail(r.output, 300)}`);
    }
    if (violations.length > 0) {
        throw new Refusal('scope', `the candidate touches ${violations.length} path(s) outside the editable scope: ${violations.slice(0, 5).map((x) => x.path).join(', ')}`, { violations });
    }
}

// ─── the verdict ─────────────────────────────────────────────────────────────

const EVAL_SCRIPT = path.join(__dirname, '..', 'skill-eval.js');

function runVerdict(v) {
    const args = ['verdict', v.iteration];
    if (v.holdout !== null) args.push('--holdout', v.holdout);
    if (v.minReplicates !== undefined) args.push('--min-replicates', v.minReplicates);
    const r = runNode(v.root, EVAL_SCRIPT, args);
    let json = null;
    try {
        json = JSON.parse(r.stdout.trim());
    } catch {
        json = null;
    }
    if (json === null || ![0, 3, 4].includes(r.status)) {
        throw new Refusal('input', `skill-eval verdict could not run (exit ${r.status}): ${tail(r.output, 400)}`);
    }
    const compact = { iteration: v.iteration };
    for (const key of VERDICT_FIELDS) if (json[key] !== undefined) compact[key] = json[key];
    compact.exitCode = r.status;
    return compact;
}

// ─── restore ─────────────────────────────────────────────────────────────────

/**
 * Put the tree back to the committed base: tracked paths from HEAD, new paths deleted, branch switched back and removed,
 * then the byte ledger (the skill directories, ignored files included, and the judge state), each file verified by sha256,
 * and finally `git status`. It throws unless every one of those holds, so `restored: true` is only ever a verified claim.
 */
function restoreTree(git, state) {
    const entries = visibleEntries(git, state);
    const fromHead = new Set();
    const created = new Set();
    for (const e of entries) {
        if (e.xy === '??') {
            created.add(e.path);
        } else if (e.xy[0] === 'A' || e.xy[0] === 'C' || e.xy[0] === 'R') {
            created.add(e.path);
            if (e.orig !== undefined) fromHead.add(e.orig);
        } else {
            fromHead.add(e.path);
        }
    }
    for (const p of created) {
        if (!p.endsWith('/')) git.run(['rm', '-q', '--cached', '--force', '--ignore-unmatch', '--', p]);
        const abs = path.join(state.root, p);
        if (isUnder(state.root, abs) && !p.endsWith('/')) {
            fs.rmSync(abs, { force: true });
            removeEmptyParents(state.root, abs);
        }
    }
    const heads = [...fromHead];
    for (let i = 0; i < heads.length; i += 100) {
        const r = git.run(['checkout', '-q', 'HEAD', '--', ...heads.slice(i, i + 100)]);
        if (r.status !== 0) throw new Error(`could not restore tracked paths: ${tail(r.stderr, 300)}`);
    }
    if (state.ledger !== null) restoreLedger(state.root, state.ledger);

    const current = git.run(['symbolic-ref', '-q', '--short', 'HEAD']);
    if (state.origBranch !== null && current.stdout.trim() !== state.origBranch) {
        const r = git.run(['checkout', '-q', state.origBranch, '--']);
        if (r.status !== 0) throw new Error(`could not switch back to ${state.origBranch}: ${tail(r.stderr, 300)}`);
    }
    if (state.branchCreated) {
        const tip = git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${state.branch}`]);
        if (tip.status === 0 && tip.stdout.trim() !== state.base) {
            throw new Error(`branch ${state.branch} has moved off the base commit; left in place`);
        }
        if (tip.status === 0) {
            const r = git.run(['branch', '-D', state.branch]);
            if (r.status !== 0) throw new Error(`could not delete branch ${state.branch}: ${tail(r.stderr, 300)}`);
        }
    }
    const left = visibleEntries(git, state);
    if (left.length > 0) throw new Error(`the tree is not back to the base: ${left.slice(0, 5).map((e) => e.path).join(', ')}`);
}

// ─── the pipeline ────────────────────────────────────────────────────────────

function findHelper(root, name) {
    for (const dir of HELPER_DIRS) {
        const file = path.join(root, dir, `${name}.js`);
        if (fs.existsSync(file)) return file;
    }
    return null;
}

function stepFailure(step, label, r) {
    return new Refusal(step, `${label} exited ${r.status === null ? 'abnormally' : r.status}: ${tail(r.output, 1500)}`);
}

/** What `render-shared-agents.js` writes for a skill edit: its ledgers and the native projections of the skill and its commands. */
function isRenderOutput(rel, skill) {
    if (rel === '.agents/render-state.json' || rel === '.claude/shared-agents.json' || rel === '.codex/shared-agents.json') return true;
    return ['.claude', '.codex'].some((dir) => rel.startsWith(`${dir}/skills/${skill}/`) || rel.startsWith(`${dir}/commands/`) || rel.startsWith(`${dir}/prompts/`));
}

/**
 * Whether a scope violation found AFTER the gate is something the render or the gate legitimately wrote: only the render
 * outputs, the gate receipt, the receipt history and (append-only) failure-ledger rows. Anything else, a changed ship seal,
 * freeze state or ac-verify record, a rewritten ledger, any other tracked file, is a violation.
 */
function toleratedAfterGate(violation, skill, ledgerAppendOnly) {
    const p = typeof violation.path === 'string' ? violation.path.replace(/\\/g, '/') : '';
    if (violation.class === 'outside') return isRenderOutput(p, skill);
    if (violation.class === 'protected' && violation.reason === 'protected') {
        if (p === GATE_RECEIPT || p.startsWith(GATE_RECEIPT_DIR)) return true;
        if (p === GATE_LEDGER) return ledgerAppendOnly;
    }
    return false;
}

/**
 * The `--run` workspace inside the repository: a `dir/` prefix to leave out of the clean-tree check, the scope judgement, the
 * restore and the printed files (the workflows build it untracked under `docs/.output/evolution/`), `null` when it is outside
 * the repository or at an ignored path. Refuses any other in-repository location: it would be dirty, or be restored away.
 */
function workspaceExclusion(git, v) {
    const rootReal = realOrSelf(v.root);
    if (!isUnder(rootReal, v.runReal)) return null;
    const rel = path.relative(rootReal, v.runReal).split(path.sep).join('/');
    const refuse = (why) => new Refusal('input', `the workspace ${v.run} ${why}`);
    if (rel === '') throw refuse('is the repository root');
    if (rel === '.git' || rel.startsWith('.git/')) throw refuse('is inside .git');
    const written = [v.skillDir, path.join(v.root, '.claude', 'skills', v.skill), path.join(v.root, '.codex', 'skills', v.skill)];
    if (written.some((dir) => isUnder(realOrSelf(dir), v.runReal))) throw refuse('is inside a skill directory that apply writes');
    if (git.run(['check-ignore', '-q', '--', rel], { plainPaths: true }).status === 0) return null;
    if (rel.startsWith(EVOLUTION_PREFIX)) return `${rel}/`;
    throw refuse(`is inside the repository but neither ignored by git nor under ${EVOLUTION_PREFIX}: move it to one of those so the clean-tree check and the restore leave it alone`);
}

// ─── what the ledger records about a run ─────────────────────────────────────

/** The tree hashes of the candidate and the snapshot, and the snapshot's entries (the drift check reads them). */
function computeHashes(v) {
    const snapshotEntries = walkTree(v.snapshotDir);
    return { candidateSha: treeHash(v.candidate), snapshotEntries, snapshotSha: treeHash(snapshotEntries) };
}

/**
 * The hash of the delta this candidate applies: every candidate file that differs from the live skill (a file byte-identical to
 * the live one is no part of it), as a path and the sha256 of its content. It is what `git` must show on the skill's files in the
 * commit that lands the change (`openEvidence`), so a whole-skill candidate and a one-file overlay are proven the same way.
 * Null when the candidate holds anything but regular files.
 */
function candidateDeltaHash(v) {
    const digests = new Map();
    for (const e of v.candidate) {
        if (e.kind !== 'file') return null;
        const bytes = fs.readFileSync(e.abs);
        const live = readOrNull(path.join(v.skillDir, ...e.rel.split('/')));
        if (live !== null && live.equals(bytes)) continue;
        digests.set(e.rel, sha256(bytes));
    }
    return deltaHash(digests);
}

/** The highest iteration's benchmark.json: repo-relative with forward slashes when the workspace is inside the root, else absolute. */
function benchmarkRef(v) {
    const file = path.join(v.iteration, 'benchmark.json');
    const rootReal = realOrSelf(v.root);
    const real = realOrSelf(file);
    return isUnder(rootReal, real) ? path.relative(rootReal, real).split(path.sep).join('/') : file;
}

/** True when `after` still holds every line of `before`, in order: only lines were added. */
function keepsEveryLine(before, after) {
    const kept = after.split('\n');
    let at = 0;
    for (const line of before.split('\n')) {
        while (at < kept.length && kept[at] !== line) at++;
        if (at === kept.length) return false;
        at++;
    }
    return true;
}

/**
 * The change class of a verdict-route candidate, the unit Owner Decision 12's graduation counts: `additive-reference` when
 * every file the candidate changes lies under `references/` and keeps every line of its live counterpart (a new file is
 * additive), else `behavior`. Read before anything is copied, while the live skill is still the one that was evaluated.
 */
function verdictChangeClass(v) {
    let changed = 0;
    for (const e of v.candidate) {
        if (e.kind !== 'file') return 'behavior';
        const live = readOrNull(path.join(v.skillDir, ...e.rel.split('/')));
        const after = fs.readFileSync(e.abs);
        if (live !== null && live.equals(after)) continue;
        changed++;
        if (!e.rel.startsWith('references/')) return 'behavior';
        if (live === null) continue;
        const was = asText(live);
        const now = asText(after);
        if (typeof was !== 'string' || typeof now !== 'string' || !keepsEveryLine(was, now)) return 'behavior';
    }
    return changed > 0 ? 'additive-reference' : 'behavior';
}

/**
 * Everything the ledger entry needs that exists before the pipeline can fail: the hashes, the benchmark and the verdict-route
 * change class. Null when the candidate or snapshot cannot even be hashed (the run then fails at the candidate-hash step and
 * nothing is recorded: there is nothing to identify the proposal by).
 */
function ledgerSeed(v) {
    let hashes;
    try {
        hashes = computeHashes(v);
    } catch {
        return null;
    }
    let deltaSha = null;
    try {
        deltaSha = candidateDeltaHash(v);
    } catch {
        deltaSha = null; // a candidate that cannot be read gets no delta hash: its entry can never be proven, so it never counts
    }
    const seed = { root: v.root, date: v.date, skill: v.skill, skillRel: v.skillRel, evidence: v.evidence, benchmark: null, changeClass: null, deltaSha, ...hashes };
    if (v.route === 'verdict') {
        seed.benchmark = benchmarkRef(v);
        try {
            seed.changeClass = verdictChangeClass(v);
        } catch {
            seed.changeClass = 'behavior';
        }
    }
    return seed;
}

const finiteOrNull = (n) => (isFiniteNumber(n) ? n : null);
const spendOrNull = (s) => (isPlainObject(s) && isFiniteNumber(s.with_skill) && isFiniteNumber(s.baseline) ? { with_skill: s.with_skill, baseline: s.baseline } : null);

/** The disposition a result maps to, or null when nothing was decided (invalid input) or the ledger itself failed. */
function dispositionOf(res) {
    if (res.ok === true) return res.applied === true ? 'applied' : 'staged';
    const step = res.failedStep === 'restore' ? res.restoreFailedAfter : res.failedStep;
    if (step === undefined || step === 'input' || step === 'ledger') return null;
    if (step === 'verdict') return 'rejected';
    if (step === 'lowpower') return 'staged';
    return 'dropped';
}

function ledgerEntryFor(state, res, disposition) {
    const seed = state.seed;
    const verdict = isPlainObject(res.verdict) ? res.verdict : null;
    const totals = verdict !== null && isPlainObject(verdict.totals) ? verdict.totals : null;
    return {
        skill: seed.skill,
        path: seed.skillRel,
        evidence: seed.evidence,
        candidate_sha256: seed.candidateSha,
        snapshot_sha256: seed.snapshotSha,
        delta_sha256: seed.deltaSha,
        benchmark: seed.benchmark,
        delta: verdict === null ? null : finiteOrNull(verdict.delta),
        replicates: verdict !== null && Number.isInteger(verdict.minRunsPerArm) && verdict.minRunsPerArm >= 0 ? verdict.minRunsPerArm : null,
        holdout_delta: verdict === null ? null : finiteOrNull(verdict.holdoutDelta),
        fragile: verdict !== null && typeof verdict.fragile === 'boolean' ? verdict.fragile : null,
        tokens: totals === null ? null : spendOrNull(totals.tokens),
        duration_ms: totals === null ? null : spendOrNull(totals.duration_ms),
        disposition,
        commit: null,
        revert: null,
        applied_at: disposition === 'applied' ? new Date().toISOString() : null,
        change_class: state.sideDoor ? state.sideDoorClass : seed.changeClass,
    };
}

/**
 * Record what the run decided. Success adds `res.ledger`; a ledger that cannot be written turns a successful run into a
 * `ledger` failure (so an apply is restored) and is only noted on a run that had already failed: that run keeps its own reason.
 */
function recordDisposition(state, res) {
    const disposition = dispositionOf(res);
    if (disposition === null || state.seed === null) return;
    const written = appendLedger({ root: state.seed.root, date: state.seed.date, entry: ledgerEntryFor(state, res, disposition) });
    if (written.ok) {
        res.ledger = ledgerRel(state.seed.date);
        return;
    }
    if (res.ok === true) {
        if (res.applied === true) delete res.files; // the delta is about to be restored: nothing left to stage
        res.ok = false;
        res.applied = false;
        res.failedStep = 'ledger';
        res.reason = `the evolution ledger could not be written (${written.reason}); the run is not recorded, so it is not kept`;
    } else {
        res.ledgerError = written.reason;
    }
}

function pipeline(o, res, state) {
    state.step = 'input';
    const v = validate(o);
    res.mode = v.mode;
    res.route = v.route;
    res.skill = v.skill;
    state.root = v.root;
    state.sideDoor = v.route === 'side-door';
    state.seed = ledgerSeed(v);
    state.tmp = makeTmp(v.root);
    const git = makeGit(v.root, path.join(state.tmp, 'no-hooks'));
    state.git = git;

    let base;
    try {
        base = git.out(['rev-parse', 'HEAD']);
    } catch (err) {
        throw new Refusal('input', `root is not a git work tree with a commit: ${errorMessage(err)}`);
    }
    state.base = base;
    res.base = base;

    if (v.mode === 'apply') {
        state.step = 'dirty-tree';
        // `git status` cannot see an edit to an assume-unchanged or skip-worktree file, so a restore could not be verified: refuse.
        const flagged = flaggedTrackedFiles(git);
        if (flagged.length > 0) {
            throw new Refusal('dirty-tree', `${flagged.length} tracked file(s) carry assume-unchanged or skip-worktree (${flagged.slice(0, 5).map((f) => f.path).join(', ')}); git status cannot see edits to them, so apply could not restore the tree byte-exactly. Clear the flag (git update-index --no-assume-unchanged or --no-skip-worktree) first`, { flagged: flagged.map((f) => f.path) });
        }
        state.exclude = workspaceExclusion(git, v);
        const dirty = visibleEntries(git, state);
        if (dirty.length > 0) {
            throw new Refusal('dirty-tree', `the working tree has ${dirty.length} uncommitted path(s) (${dirty.slice(0, 5).map((e) => e.path).join(', ')}); apply needs a clean tree`);
        }
        const head = git.run(['symbolic-ref', '-q', '--short', 'HEAD']);
        if (head.status !== 0 || head.stdout.trim() === '') throw new Refusal('branch', 'HEAD is detached; check out a branch first');
        state.origBranch = head.stdout.trim();
    }
    // The workspace and every evolution ledger are outside the scope judgement: neither is part of the delta.
    const inWorkspace = (violation) => {
        const p = String(violation.path).replace(/\\/g, '/');
        return underPrefix(p, state.exclude) || isLedgerPath(p);
    };

    state.step = 'scope';
    const ctx = { root: v.root, scopeFile: extractTrusted(git, state.tmp, base) };
    let baselineFile = null;
    if (v.mode === 'apply') {
        baselineFile = path.join(state.tmp, 'improvement-baseline.json');
        const snap = runScope(ctx, 'snapshot', ['--base', base, '--root', v.root, '--out', baselineFile]);
        if (snap.status !== 0) {
            throw new Refusal('scope', `the scope baseline could not be taken (${(snap.json && snap.json.error) || tail(snap.output, 300)})`);
        }
    }

    state.step = 'candidate-hash';
    const hashes = state.seed !== null ? state.seed : computeHashes(v);
    const candidateSha = hashes.candidateSha;
    res.candidateSha256 = candidateSha;
    if (v.candidatePin !== undefined && v.candidatePin.toLowerCase() !== candidateSha) {
        throw new Refusal('candidate-hash', `the candidate directory hashes to ${candidateSha}, not the pinned ${v.candidatePin.toLowerCase()}; it changed after the proposal`);
    }
    const snapshotEntries = hashes.snapshotEntries;
    const snapshotSha = hashes.snapshotSha;
    if (v.route === 'verdict') {
        // Bind evaluation -> apply: the iteration recorded what it graded; the candidate and snapshot applied must be those.
        const binding = readBinding(v.iteration);
        const name = path.basename(v.iteration);
        if (binding.candidateSha256 !== candidateSha) {
            throw new Refusal('candidate-hash', `the candidate directory hashes to ${candidateSha} but ${name} graded ${binding.candidateSha256}; it changed after the evaluation, re-evaluate it`);
        }
        if (binding.snapshotSha256 !== snapshotSha) {
            throw new Refusal('candidate-hash', `the skill-snapshot directory hashes to ${snapshotSha} but ${name} graded ${binding.snapshotSha256}; it changed after the evaluation, re-evaluate it`);
        }
        // ...and the evidence the verdict is computed from is the evidence that was bound (checked again once the verdict ran).
        assertGradingsBound(v, binding);
        state.binding = binding;
    }

    state.step = 'drift';
    const canonicalEntries = walkTree(v.skillDir);
    res.snapshotSha256 = snapshotSha;
    res.canonicalSha256 = treeHash(canonicalEntries);
    if (res.snapshotSha256 !== res.canonicalSha256) {
        const digests = (entries) => new Map(entries.map((e) => [e.rel, entryDigest(e)]));
        const snap = digests(snapshotEntries);
        const live = digests(canonicalEntries);
        const differing = [...new Set([...snap.keys(), ...live.keys()])].filter((rel) => snap.get(rel) !== live.get(rel)).sort();
        throw new Refusal('drift', `the live skill no longer matches the evaluated snapshot (${differing.slice(0, 8).join(', ')}); re-evaluate against the current skill`);
    }

    state.step = 'scope';
    classifyCandidatePaths(ctx, v);

    const delta = v.candidate.map((e) => {
        const live = readOrNull(path.join(v.skillDir, ...e.rel.split('/')));
        return { rel: e.rel, before: live, after: fs.readFileSync(e.abs) };
    });
    const changed = delta.filter((d) => d.before === null || !d.before.equals(d.after));
    if (changed.length === 0) throw new Refusal('input', 'the candidate changes nothing against the live skill');
    const wouldWrite = changed.map((d) => `${v.skillRel}/${d.rel}`).sort();

    if (v.route === 'verdict') {
        state.step = 'verdict';
        const verdict = runVerdict(v);
        // The verdict was computed from the files on disk while it ran: they must still be the bound ones.
        assertGradingsBound(v, state.binding);
        res.verdict = verdict;
        if (verdict.verdict !== 'accept') {
            throw new Refusal('verdict', `the verdict is ${verdict.verdict}${Array.isArray(verdict.reasons) && verdict.reasons.length > 0 ? ` (${verdict.reasons.join(', ')})` : ''}`);
        }
        // An accept with no holdout evidence is a low-power accept: Owner Decision 12's criteria assume a holdout.
        const reasons = verdict.lowPower === true && Array.isArray(verdict.lowPowerReasons) ? [...verdict.lowPowerReasons] : [];
        if (v.holdout === null) reasons.push('no-holdout-evidence');
        res.lowPower = verdict.lowPower === true || v.holdout === null;
        if (res.lowPower) res.lowPowerReasons = reasons;
        if (res.lowPower && v.mode === 'apply') {
            state.step = 'lowpower';
            throw new Refusal('lowpower', `a low-power accept is proposed, never applied (${res.lowPowerReasons.join(', ')})`, { files: wouldWrite });
        }
    } else {
        state.step = 'side-door';
        const exists = (pointer) => {
            const rel = String(pointer).replace(/\\/g, '/').replace(/^\.\//, '');
            if (rel === '' || path.isAbsolute(rel) || rel.split('/').includes('..')) return false;
            return [v.root, v.skillDir].some((base2) => fs.existsSync(path.join(base2, rel)));
        };
        const counts = buildWordCounts(v.root);
        const wordCount = (word) => counts.get(word) || 0;
        const change = classifyChange(
            delta.map((d) => ({ path: `${v.skillRel}/${d.rel}`, before: asText(d.before), after: asText(d.after) })),
            { exists, wordCount, isPinned: makePinnedLookup(git, base) },
        );
        res.classification = { class: change.class, files: change.files.map((f) => ({ path: f.path, class: f.class, kinds: f.kinds })) };
        // The ledger's change class: the kinds when the whole delta is exempt, else it is plain behavior.
        state.sideDoorClass = change.class === 'exempt' && change.kinds.length > 0 ? change.kinds.join('+') : 'behavior';
        if (change.class !== 'exempt') {
            const first = change.files.find((f) => f.class === 'behavior');
            throw new Refusal('side-door', `the delta is not a typo, stale-pointer or pinned-text fix and needs the verdict route${first ? ` (${first.path}: ${first.reason})` : ''}`);
        }
        res.kinds = change.kinds;
    }

    if (v.mode === 'propose') {
        res.ok = true;
        res.files = wouldWrite;
        return;
    }

    // ── apply: from here on the tree changes, and any failure restores it ──
    const scripts = {};
    for (const [step, name] of [['render', 'render-shared-agents'], ['conformance', 'skill-evolution'], ['gate', 'gate']]) {
        scripts[step] = findHelper(v.root, name);
        if (scripts[step] === null) throw new Refusal(step, `${name}.js was not found under ${HELPER_DIRS.join(', ')}`);
    }

    state.step = 'branch';
    if (git.run(['show-ref', '--verify', '--quiet', `refs/heads/${v.branch}`]).status === 0) {
        throw new Refusal('branch', `branch ${v.branch} already exists; choose another name`);
    }
    // Everything restore needs that git does not carry: the bytes of the three directories the pipeline writes (ignored files
    // included) and of the judge state a tampering gate could change; the failure ledger's bytes for the append-only check.
    state.ledger = takeLedger(v.root, [v.skillRel, `.claude/skills/${v.skill}`, `.codex/skills/${v.skill}`, ...JUDGE_STATE]);
    state.gateLedgerBefore = readOrNull(path.join(v.root, ...GATE_LEDGER.split('/')));
    state.mutated = true;
    state.branch = v.branch;
    const created = git.run(['checkout', '-q', '--no-track', '-b', v.branch]);
    if (created.status !== 0) throw new Refusal('branch', `could not create branch ${v.branch}: ${tail(created.stderr, 300)}`);
    state.branchCreated = true;
    res.branch = v.branch;

    state.step = 'copy';
    for (const e of v.candidate) {
        const dest = path.join(v.skillDir, ...e.rel.split('/'));
        if (!isUnder(v.skillDir, dest)) throw new Refusal('copy', `candidate path escapes the skill directory: ${e.rel}`);
        try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(e.abs, dest);
        } catch (err) {
            throw new Refusal('copy', `could not copy ${e.rel}: ${errorMessage(err)}`);
        }
    }

    const checkArgs = ['--base', base, '--target', v.skill, '--root', v.root, '--baseline', baselineFile];
    state.step = 'scope';
    const preRender = runScope(ctx, 'check', checkArgs);
    if (preRender.status !== 0) scopeRefusal('before the render', preRender, (list) => list.filter((x) => !inWorkspace(x)));

    state.step = 'render';
    const render = runNode(v.root, scripts.render, []);
    if (render.status !== 0) throw stepFailure('render', 'render-shared-agents', render);
    state.step = 'render-check';
    const renderCheck = runNode(v.root, scripts.render, ['--check']);
    if (renderCheck.status !== 0) throw stepFailure('render-check', 'render-shared-agents --check', renderCheck);
    state.step = 'conformance';
    const conformance = runNode(v.root, scripts.conformance, ['check', v.skill, `${v.skillRel}/SKILL.md`]);
    if (conformance.status !== 0) throw stepFailure('conformance', 'skill-evolution check', conformance);
    state.step = 'gate';
    const gate = runNode(v.root, scripts.gate, ['test']);
    if (gate.status !== 0) throw stepFailure('gate', 'gate test', gate);

    state.step = 'scope';
    const finalCheck = runScope(ctx, 'check', checkArgs);
    if (finalCheck.status !== 0) {
        const ledgerAppendOnly = isAppendOnly(state.gateLedgerBefore, readOrNull(path.join(v.root, ...GATE_LEDGER.split('/'))));
        scopeRefusal('after the gate', finalCheck, (list) => list.filter((x) => !inWorkspace(x) && !toleratedAfterGate(x, v.skill, ledgerAppendOnly)));
    }

    res.files = visibleEntries(git, state).map((e) => e.path).sort();
    res.ok = true;
    res.applied = true;
}

const FAILED_STEPS = new Set(['input', 'dirty-tree', 'branch', 'verdict', 'lowpower', 'candidate-hash', 'drift', 'scope', 'side-door', 'copy', 'render', 'render-check', 'conformance', 'gate', 'restore']);

function baseResult(o) {
    return {
        ok: false,
        mode: typeof o.mode === 'string' ? o.mode : 'propose',
        route: typeof o.route === 'string' ? o.route : 'verdict',
        skill: typeof o.skill === 'string' ? o.skill : null,
        applied: false,
        restored: false,
    };
}

/** Apply (or propose) an accepted candidate. Synchronous; never throws; the result is what the CLI prints. */
function apply(options) {
    const o = options && typeof options === 'object' ? options : {};
    const res = baseResult(o);
    const state = {
        step: 'input', root: null, tmp: null, git: null, base: null, origBranch: null, branch: null, branchCreated: false, mutated: false,
        exclude: null, ledger: null, gateLedgerBefore: null, seed: null, sideDoor: false, sideDoorClass: null, binding: null,
    };
    try {
        pipeline(o, res, state);
    } catch (err) {
        res.ok = false;
        res.applied = false;
        if (err instanceof Refusal) {
            res.failedStep = err.step;
            res.reason = err.message;
            Object.assign(res, err.extra);
        } else {
            res.failedStep = FAILED_STEPS.has(state.step) ? state.step : 'input';
            res.reason = `unexpected error in ${state.step}: ${errorMessage(err)}`;
        }
    }
    // A run that succeeded is recorded BEFORE the restore decision: an apply whose ledger cannot be written is not kept.
    // Every other run is recorded AFTER the restore, which never touches the ledger.
    const recordedFirst = res.ok === true;
    if (recordedFirst) recordDisposition(state, res);
    if (!res.ok && state.mutated && state.git !== null) {
        try {
            restoreTree(state.git, state);
            res.restored = true;
        } catch (err) {
            res.restored = false;
            res.restoreFailedAfter = res.failedStep;
            res.failedStep = 'restore';
            res.reason = `restore failed after ${res.restoreFailedAfter}: ${errorMessage(err)}`;
        }
    }
    if (!recordedFirst) recordDisposition(state, res);
    if (state.tmp !== null) {
        try {
            fs.rmSync(state.tmp, { recursive: true, force: true });
        } catch {
            // the temporary directory is outside the repository; a leftover is harmless
        }
    }
    return res;
}

// ─── the evolution ledger (SF-4.10) ──────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * One ledger entry with every key present, in the order they are written. The key list below is the one place the 18 keys
 * are named: the writer, the validator and the readers all derive from it.
 */
function blankEntry() {
    return {
        skill: null,
        path: null,
        evidence: null,
        candidate_sha256: null,
        snapshot_sha256: null,
        delta_sha256: null,
        benchmark: null,
        delta: null,
        replicates: null,
        holdout_delta: null,
        fragile: null,
        tokens: null,
        duration_ms: null,
        disposition: null,
        commit: null,
        revert: null,
        applied_at: null,
        change_class: null,
    };
}
const ENTRY_KEYS = Object.keys(blankEntry());

/** The exact text of the pointer an applied entry carries once its commit is known: a command to READ, never to run here. */
const revertText = (hash) => `git revert ${hash}`;

const isInstant = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

/** A real calendar day written YYYY-MM-DD (2026-02-30 is not one). */
function validDate(date) {
    if (typeof date !== 'string' || !DATE_RE.test(date)) return false;
    const [y, m, d] = date.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function spendProblem(name, v) {
    if (v === null) return null;
    if (!isPlainObject(v) || Object.keys(v).sort().join() !== 'baseline,with_skill' || !isFiniteNumber(v.with_skill) || !isFiniteNumber(v.baseline)) {
        return `${name} must be null or {with_skill, baseline} numbers`;
    }
    return null;
}

/** Why `entry` is not a valid ledger entry, or null. Used on every write and on every read: the two never disagree. */
function entryProblem(entry) {
    if (!isPlainObject(entry)) return 'an entry must be an object';
    const have = Object.keys(entry).sort();
    const want = [...ENTRY_KEYS].sort();
    if (have.length !== want.length || have.some((k, i) => k !== want[i])) {
        const missing = want.filter((k) => !have.includes(k));
        const extra = have.filter((k) => !want.includes(k));
        return `an entry must have exactly the ${want.length} ledger keys (missing: ${missing.join(', ') || 'none'}; unexpected: ${extra.join(', ') || 'none'})`;
    }
    if (typeof entry.skill !== 'string' || !SKILL_RE.test(entry.skill)) return 'skill must be a skill directory name';
    if (entry.path !== `.agents/skills/${entry.skill}`) return `path must be exactly ".agents/skills/${entry.skill}"`;
    if (!Array.isArray(entry.evidence) || entry.evidence.some((id) => typeof id !== 'string' || !EVIDENCE_ID_RE.test(id))) {
        return 'evidence must be an array of ids with no whitespace and no comma';
    }
    for (const key of ['candidate_sha256', 'snapshot_sha256']) {
        if (typeof entry[key] !== 'string' || !/^[0-9a-f]{64}$/.test(entry[key])) return `${key} must be 64 lower-case hex characters`;
    }
    if (entry.delta_sha256 !== null && (typeof entry.delta_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.delta_sha256))) return 'delta_sha256 must be null or 64 lower-case hex characters';
    if (entry.benchmark !== null && (typeof entry.benchmark !== 'string' || entry.benchmark === '')) return 'benchmark must be null or a non-empty path';
    for (const key of ['delta', 'holdout_delta']) {
        if (entry[key] !== null && !isFiniteNumber(entry[key])) return `${key} must be null or a finite number`;
    }
    if (entry.replicates !== null && !(Number.isInteger(entry.replicates) && entry.replicates >= 0)) return 'replicates must be null or a non-negative integer';
    if (entry.fragile !== null && typeof entry.fragile !== 'boolean') return 'fragile must be null or a boolean';
    const spend = spendProblem('tokens', entry.tokens) || spendProblem('duration_ms', entry.duration_ms);
    if (spend !== null) return spend;
    if (!DISPOSITIONS.includes(entry.disposition)) return `disposition must be one of ${DISPOSITIONS.join(', ')}`;
    if (entry.commit !== null && (typeof entry.commit !== 'string' || !COMMIT_RE.test(entry.commit))) return 'commit must be null or a 40 (or 64) lower-case hex character commit id';
    if (entry.commit === null ? entry.revert !== null : entry.revert !== revertText(entry.commit)) return `revert must be null exactly when commit is null, else exactly "${revertText('<commit>')}"`;
    if (entry.commit !== null && entry.disposition !== 'applied') return 'only an applied entry can hold a commit';
    if (entry.disposition === 'applied' ? !isInstant(entry.applied_at) : entry.applied_at !== null) return 'applied_at must be an ISO-8601 UTC instant exactly on an applied entry, else null';
    if (entry.change_class !== null && (typeof entry.change_class !== 'string' || entry.change_class === '')) return 'change_class must be null or a non-empty string';
    return null;
}

/** The entry as it is written: the 17 keys in their documented order, deep-copied (the caller's object is never kept). */
function canonicalEntry(entry) {
    const out = blankEntry();
    for (const key of ENTRY_KEYS) out[key] = JSON.parse(JSON.stringify(entry[key]));
    return out;
}

function ledgerDocProblem(doc) {
    if (!isPlainObject(doc)) return 'the document must be an object';
    if (Object.keys(doc).sort().join() !== 'entries,version') return 'the document must hold exactly "version" and "entries"';
    if (doc.version !== LEDGER_VERSION) return `version must be ${LEDGER_VERSION}`;
    if (!Array.isArray(doc.entries)) return 'entries must be an array';
    for (let i = 0; i < doc.entries.length; i++) {
        const problem = entryProblem(doc.entries[i]);
        if (problem !== null) return `entries[${i}]: ${problem}`;
    }
    return null;
}

const ledgerRel = (date) => `${LEDGER_DIR.join('/')}/${date}/${LEDGER_NAME}`;
const ledgerFile = (root, date) => path.join(root, ...LEDGER_DIR, date, LEDGER_NAME);

/**
 * The parsed ledger at `file` (`{version, entries}`), or null when there is none. Throws an Error that names the file when it
 * exists but cannot be read or is not a valid ledger: a broken audit trail is never read as an empty one.
 */
function readLedgerFile(file) {
    let text;
    try {
        if (!fs.lstatSync(file).isFile()) throw new Error('it is not a regular file');
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return null;
        throw new Error(`the evolution ledger ${file} cannot be read: ${errorMessage(err)}`);
    }
    let doc;
    try {
        doc = JSON.parse(text);
    } catch (err) {
        throw new Error(`the evolution ledger ${file} is not valid JSON: ${errorMessage(err)}`);
    }
    const problem = ledgerDocProblem(doc);
    if (problem !== null) throw new Error(`the evolution ledger ${file} is not a valid ledger: ${problem}`);
    return doc;
}

/** Every dated ledger file below `root`, oldest date first: [{date, file, rel}]. A directory that cannot be listed throws. */
function listLedgerFiles(root) {
    const base = path.join(root, ...LEDGER_DIR);
    let dirents;
    try {
        dirents = fs.readdirSync(base, { withFileTypes: true });
    } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
        throw new Error(`${base} cannot be listed: ${errorMessage(err)}`);
    }
    const out = [];
    for (const ent of dirents) {
        if (!validDate(ent.name)) continue;
        const file = path.join(base, ent.name, LEDGER_NAME);
        try {
            fs.lstatSync(file);
        } catch (err) {
            if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) continue;
            throw new Error(`${file} cannot be inspected: ${errorMessage(err)}`);
        }
        out.push({ date: ent.name, file, rel: ledgerRel(ent.name) });
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Every ledger below `root`, oldest date first: [{date, file, rel, entries}]. Throws (naming the file) on a broken ledger. */
function loadLedgers(root) {
    const out = [];
    for (const item of listLedgerFiles(root)) {
        const doc = readLedgerFile(item.file);
        if (doc !== null) out.push({ ...item, entries: doc.entries });
    }
    return out;
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ─── locks: in the ignored state zone, broken only under a marker ────────────

const lockDirOf = (root) => path.join(path.resolve(root), ...LOCK_DIR);

/**
 * The lock file that guards `file` (a path inside `root`): under `docs/.output/.state/locks/`, named after the file's
 * repository-relative path. Never inside the tracked evolution folder, so a writer that dies holding it leaves nothing there
 * for `git status`, the clean-tree check or a careless `git add` to find.
 */
function lockPathFor(root, file) {
    const rel = path.relative(path.resolve(root), path.resolve(file)).split(path.sep).join('/');
    return path.join(lockDirOf(root), `${rel.replace(/[^A-Za-z0-9._-]/g, '_')}.lock`);
}

/** The start time of a process (field 22 of /proc/<pid>/stat on Linux), or null where it cannot be read: it tells a reused pid from the owner. */
function processStart(pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const field = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
        return field === undefined || field === '' ? null : field;
    } catch {
        return null;
    }
}

/** What a lock file holds right now: {raw, owner: {pid, start, token} | null, ino, mtimeMs}, or null when there is no file. */
function readLock(lockFile) {
    let st;
    let raw;
    try {
        st = fs.lstatSync(lockFile);
        raw = st.isFile() ? fs.readFileSync(lockFile, 'utf8') : '';
    } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
        throw err;
    }
    let owner = null;
    try {
        const parsed = JSON.parse(raw);
        if (isPlainObject(parsed) && Number.isInteger(parsed.pid) && parsed.pid > 0 && typeof parsed.token === 'string') {
            owner = { pid: parsed.pid, start: typeof parsed.start === 'string' ? parsed.start : null, token: parsed.token };
        }
    } catch {
        const bare = /^\d+\s*$/.test(raw) ? Number.parseInt(raw, 10) : NaN; // the earlier format: the pid alone
        if (Number.isInteger(bare) && bare > 0) owner = { pid: bare, start: null, token: raw };
    }
    return { raw, owner, ino: st.ino, mtimeMs: st.mtimeMs };
}

/** True when the lock is older than LOCK_STALE_MS and its owner is gone: dead, a reused pid, or never recorded. Doubt keeps it held. */
function lockIsStale(lock) {
    if (Date.now() - lock.mtimeMs < LOCK_STALE_MS) return false;
    if (lock.owner === null) return true;
    try {
        process.kill(lock.owner.pid, 0);
    } catch (err) {
        return Boolean(err) && err.code === 'ESRCH';
    }
    const now = lock.owner.start === null ? null : processStart(lock.owner.pid);
    return now !== null && now !== lock.owner.start;
}

/**
 * Remove the lock `judged` was read from, only while it is still that very file. Breaking is serialised by an exclusive
 * `<lock>.break` marker: only its holder unlinks, and only after re-reading the lock and finding the same inode, mtime and bytes
 * it judged stale, so a fresh lock another writer created in the meantime is never unlinked. The caller re-reads either way.
 */
function breakStaleLock(lockFile, judged) {
    const marker = `${lockFile}.break`;
    let fd;
    try {
        fd = fs.openSync(marker, 'wx');
    } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
        try {
            if (Date.now() - fs.lstatSync(marker).mtimeMs >= LOCK_STALE_MS) fs.unlinkSync(marker); // its holder died inside the marker
        } catch {
            // gone already
        }
        return;
    }
    try {
        fs.closeSync(fd);
        const now = readLock(lockFile);
        if (now !== null && now.ino === judged.ino && now.mtimeMs === judged.mtimeMs && now.raw === judged.raw && lockIsStale(now)) fs.unlinkSync(lockFile);
    } catch {
        // someone else moved first: the caller re-reads
    } finally {
        try {
            fs.unlinkSync(marker);
        } catch {
            // already gone
        }
    }
}

/** Remove the lock only when it still holds `mine`: a lock that was wrongly broken and re-taken is never deleted by its old holder. */
function releaseLock(lockFile, mine) {
    try {
        if (fs.readFileSync(lockFile, 'utf8') === mine) fs.unlinkSync(lockFile);
    } catch {
        // already gone
    }
}

/**
 * Run `fn` while holding `lockFile` (created exclusively; it records this process's pid, start time and a random token).
 * Writers in separate processes queue on it. A lock older than LOCK_STALE_MS whose owner is gone is broken through
 * `breakStaleLock`; waiting longer than LOCK_WAIT_MS throws. The lock is released only if it still holds this writer's token.
 */
function withFileLock(lockFile, fn) {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    const mine = `${JSON.stringify({ pid: process.pid, start: processStart(process.pid), token: crypto.randomBytes(16).toString('hex') })}\n`;
    for (;;) {
        let fd;
        try {
            fd = fs.openSync(lockFile, 'wx');
        } catch (err) {
            if (!err || err.code !== 'EEXIST') throw err;
            const held = readLock(lockFile);
            if (held !== null && lockIsStale(held)) {
                breakStaleLock(lockFile, held);
                sleepSync(1 + Math.floor(Math.random() * 5));
                continue;
            }
            if (Date.now() >= deadline) throw new Error(`timed out after ${LOCK_WAIT_MS} ms waiting for the lock ${lockFile}`);
            sleepSync(5 + Math.floor(Math.random() * 20));
            continue;
        }
        try {
            fs.writeSync(fd, mine);
        } catch (err) {
            fs.closeSync(fd);
            try {
                fs.unlinkSync(lockFile);
            } catch {
                // already gone
            }
            throw err;
        }
        fs.closeSync(fd);
        break;
    }
    try {
        return fn();
    } finally {
        releaseLock(lockFile, mine);
    }
}

/**
 * Write `text` to `file` atomically (a rename, so readers see the old or the new content, never a partial one) through a
 * temporary file in `docs/.output/.state/tmp/`: a writer killed mid-write leaves its temporary file in the ignored zone, never
 * beside the tracked file. Guards symlinked ancestors up to `root`. Falls back to the same-directory write where a rename
 * across the two directories is not possible.
 */
function writeAtomic(file, text, root) {
    const rootAbs = path.resolve(root);
    fsSafe.safeMkdirp(path.dirname(file), rootAbs);
    const tmpDir = path.join(rootAbs, ...TMP_DIR);
    fsSafe.safeMkdirp(tmpDir, rootAbs);
    const tmp = path.join(tmpDir, `${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    fsSafe.safeWrite(tmp, text, undefined, rootAbs);
    try {
        fs.renameSync(tmp, file);
    } catch (err) {
        try {
            fs.unlinkSync(tmp);
        } catch {
            // already gone
        }
        if (err && err.code === 'EXDEV') {
            fsSafe.safeWriteAtomic(file, text, rootAbs);
            return;
        }
        throw err;
    }
}

function writeLedgerDoc(file, doc, root) {
    writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`, root);
}

const sameProposal = (a, b) => a.skill === b.skill && a.candidate_sha256 === b.candidate_sha256
    && a.snapshot_sha256 === b.snapshot_sha256 && a.disposition === b.disposition;

function appendLedgerUnsafe(options) {
    const bad = (reason) => ({ ok: false, failedStep: 'input', reason });
    if (!isPlainObject(options)) return bad('appendLedger needs an options object {root, date, entry}');
    if (typeof options.root !== 'string' || options.root === '' || !isDirectory(options.root)) return bad('root must be an existing directory');
    if (!validDate(options.date)) return bad('date must be a real YYYY-MM-DD calendar date');
    const problem = entryProblem(options.entry);
    if (problem !== null) return bad(`invalid ledger entry: ${problem}`);
    const root = path.resolve(options.root);
    const file = ledgerFile(root, options.date);
    const entry = canonicalEntry(options.entry);
    fsSafe.safeMkdirp(path.dirname(file), root);
    fsSafe.safeMkdirp(lockDirOf(root), root);
    const appended = withFileLock(lockPathFor(root, file), () => {
        const doc = readLedgerFile(file) || { version: LEDGER_VERSION, entries: [] };
        const newest = doc.entries[doc.entries.length - 1];
        // An entry that already holds its commit is a landed change: applying the same candidate again (after a revert) is a new
        // application and is recorded as one. Only a proposal that is still waiting for its commit is de-duplicated.
        if (newest !== undefined && newest.commit === null && sameProposal(newest, entry)) return false;
        doc.entries.push(entry);
        writeLedgerDoc(file, doc, root);
        return true;
    });
    return { ok: true, appended, file };
}

/**
 * Append one entry to `docs/.output/evolution/skills/{date}/ledger.json` under `root`. Append-only (an existing entry is never
 * edited here), de-duplicated against the newest entry of the file while that entry has no commit (same skill, hashes and
 * disposition), safe against simultaneous writers (a lock in the ignored state zone), and fail closed: an existing ledger that
 * is not a valid document is never overwritten. Never throws.
 *   -> {ok: true, appended, file} | {ok: false, failedStep: 'input' | 'ledger', reason}
 */
function appendLedger(options) {
    try {
        return appendLedgerUnsafe(options);
    } catch (err) {
        return { ok: false, failedStep: 'ledger', reason: `the evolution ledger could not be written: ${errorMessage(err)}` };
    }
}

/** The index of the newest applied entry of `doc` for this candidate that holds no commit yet, or -1. */
function newestUncommitted(doc, sha) {
    for (let i = doc.entries.length - 1; i >= 0; i--) {
        const e = doc.entries[i];
        if (e.disposition === 'applied' && e.candidate_sha256 === sha && e.commit === null) return i;
    }
    return -1;
}

// ─── git proof: only a change that really landed on the default branch counts ─

/**
 * The ledger is evidence, not the source of truth. An applied entry counts toward graduation, `watch` and the unattended-apply
 * gate only when git proves it:
 *   - its commit is reachable from the repository's DEFAULT branch (`origin/HEAD`, else `main`, else `master`; never the HEAD of
 *     the current checkout),
 *   - the diff of that commit against its first parent, on the skill's files, is exactly the change the entry evaluated:
 *     `delta_sha256` is the hash of the post-image of every file the candidate changed (a path, a NUL, the sha256 of its content),
 *     recomputed here from git's own blobs. A squash merge or a rebase is matched by this diff, not by ancestry,
 *   - one commit serves one entry,
 * and reverts are read from the tree, not from a message: the entry is reverted when the default branch's later history restores
 * the pre-image of its files, and a revert that is itself reverted is a net no-op unless another ledger entry re-applied it.
 * A forged entry can therefore at worst be an entry that does not count; a real commit of a skill change that the loop never
 * evaluated can be claimed by an entry only when its diff is byte for byte the one the entry names.
 */

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** One hash over a delta: every changed path with the sha256 of its post-image (or `deleted`), in code-unit order. */
function deltaHash(digests) {
    const h = crypto.createHash('sha256');
    for (const rel of [...digests.keys()].sort(byCodeUnit)) h.update(`${rel}\0${digests.get(rel)}\n`);
    return h.digest('hex');
}

/** The default branch's refs that exist: `refs/heads/<name>` and `refs/remotes/origin/<name>`. {name: null, refs: []} when it cannot be resolved. */
function defaultBranchRefs(git) {
    const exists = (ref) => git.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0;
    let name = null;
    const head = git.run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    if (head.status === 0) {
        const m = head.stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
        if (m !== null) name = m[1];
    }
    if (name === null) name = ['main', 'master'].find((n) => exists(`refs/heads/${n}`) || exists(`refs/remotes/origin/${n}`)) || null;
    if (name === null) return { name: null, refs: [] };
    return { name, refs: [`refs/heads/${name}`, `refs/remotes/origin/${name}`].filter(exists) };
}

/**
 * A read-only view of the repository at `root` for the proofs above. Every call is a git query (rev-parse, symbolic-ref,
 * merge-base, rev-list, ls-tree, cat-file) run with `-C <root>` and without the redirecting GIT_* variables: nothing here writes, resets,
 * reverts or touches a ref. Answers are cached for the life of the object.
 *   assess(entry, others) -> {state, reason?, commitTime?}
 *     state: 'no-commit' | 'not-merged' | 'unverified' | 'reverted' | 'live'
 *     others: the commits of the OTHER entries of the same skill (a revert that is followed by one of them is not undone)
 */
function openEvidence(root) {
    const git = makeGit(path.resolve(root), os.devNull);
    const must = (args, options) => {
        const r = git.run(args, options);
        if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${tail(r.stderr, 300)}`);
        return r.stdout;
    };
    let def = null;
    const ancestors = new Map();
    const trees = new Map();
    const changes = new Map();
    const times = new Map();
    const getDefault = () => {
        if (def === null) def = defaultBranchRefs(git);
        return def;
    };
    const isAncestor = (a, b) => {
        const key = `${a}\0${b}`;
        if (!ancestors.has(key)) ancestors.set(key, git.run(['merge-base', '--is-ancestor', a, b]).status === 0);
        return ancestors.get(key);
    };
    const containing = (commit) => getDefault().refs.find((ref) => isAncestor(commit, ref)) || null;
    /** Map of path-below-`dir` -> "mode type oid" for every file of `dir` at `rev`. */
    const treeMap = (rev, dir) => {
        const key = `${rev}\0${dir}`;
        if (trees.has(key)) return trees.get(key);
        const map = new Map();
        for (const rec of must(['ls-tree', '-r', '-z', rev, '--', `${dir}/`]).split('\0')) {
            if (rec === '') continue;
            const tab = rec.indexOf('\t');
            const meta = rec.slice(0, tab).split(' ');
            map.set(rec.slice(tab + 1).slice(dir.length + 1), `${meta[0]} ${meta[1]} ${meta[2]}`);
        }
        trees.set(key, map);
        return map;
    };
    /** What `commit` changed below `dir`, against its first parent (the empty tree for a root commit). */
    const changeOf = (commit, dir) => {
        const key = `${commit}\0${dir}`;
        if (changes.has(key)) return changes.get(key);
        const parent = must(['rev-list', '--parents', '-n', '1', commit]).trim().split(' ')[1] || null;
        const post = treeMap(commit, dir);
        const pre = parent === null ? new Map() : treeMap(parent, dir);
        const rels = [...new Set([...pre.keys(), ...post.keys()])].filter((rel) => (pre.get(rel) || null) !== (post.get(rel) || null)).sort(byCodeUnit);
        const digests = new Map();
        let unsupported = false;
        for (const rel of rels) {
            const after = post.get(rel);
            if (after === undefined) {
                digests.set(rel, 'deleted');
                continue;
            }
            const [mode, type, oid] = after.split(' ');
            if (type !== 'blob' || mode === '120000') {
                unsupported = true;
                continue;
            }
            const blob = git.run(['cat-file', 'blob', oid], { buffer: true });
            if (blob.status !== 0) {
                unsupported = true;
                continue;
            }
            digests.set(rel, sha256(blob.stdout));
        }
        const change = { rels, digests, unsupported, pre, post };
        changes.set(key, change);
        return change;
    };
    const committerTime = (commit) => {
        if (!times.has(commit)) times.set(commit, new Date(Number.parseInt(must(['show', '-s', '--format=%ct', commit]).trim(), 10) * 1000).toISOString());
        return times.get(commit);
    };
    /** Does the default branch's history after `commit` leave its change undone? Read from the trees; the commit messages are never consulted. */
    const revertedLater = (commit, tip, dir, change, others) => {
        const classify = (map) => {
            let atPost = 0;
            let atPre = 0;
            for (const rel of change.rels) {
                const v = map.get(rel) || null;
                if (v === (change.post.get(rel) || null)) atPost++;
                else if (v === (change.pre.get(rel) || null)) atPre++;
            }
            return { allPost: atPost === change.rels.length, anyPre: atPre > 0 };
        };
        const later = must(['rev-list', '--first-parent', '--ancestry-path', '--reverse', `${commit}..${tip}`, '--', dir]).split('\n').filter((l) => l !== '');
        let reverted = false;
        let prev = commit;
        for (const step of later) {
            const s = classify(treeMap(step, dir));
            if (s.anyPre) reverted = true;
            // The change is back in place. That undoes a revert unless another ledger entry's commit is what put it back: a loop
            // that re-applied a reverted change has still been reverted once.
            else if (s.allPost && reverted && !others.some((x) => isAncestor(x, step) && !isAncestor(x, prev))) reverted = false;
            prev = step;
        }
        return reverted;
    };
    const assess = (entry, others) => {
        if (entry.commit === null) return { state: 'no-commit' };
        const known = getDefault();
        if (known.refs.length === 0) return { state: 'not-merged', reason: 'the default branch cannot be resolved (origin/HEAD, main or master)' };
        const unverified = (reason) => ({ state: 'unverified', reason });
        try {
            const tip = containing(entry.commit);
            if (tip === null) return { state: 'not-merged', reason: `${entry.commit} is not reachable from the default branch (${known.name})` };
            const dir = `.agents/skills/${entry.skill}`;
            const change = changeOf(entry.commit, dir);
            if (change.rels.length === 0) return unverified(`it changes no file of ${dir}`);
            if (change.unsupported || typeof entry.delta_sha256 !== 'string' || deltaHash(change.digests) !== entry.delta_sha256) {
                return unverified(`its diff on ${dir} is not the change this entry evaluated`);
            }
            return { state: revertedLater(entry.commit, tip, dir, change, others) ? 'reverted' : 'live', commitTime: committerTime(entry.commit) };
        } catch (err) {
            return unverified(`git could not prove it: ${errorMessage(err)}`);
        }
    };
    return { defaultBranch: () => getDefault(), assess };
}

/**
 * Who owns each commit of the applied entries, and what each entry's revert state may depend on. `entries` is the applied entries
 * oldest first (by `applied_at`, then recording order). One commit serves one entry: the first to claim it keeps it.
 *   -> {owner: Map<commit, entry>, othersOf(entry): commits of the other owned entries of the same skill}
 */
function claimCommits(entries) {
    const owner = new Map();
    for (const e of entries) if (e.commit !== null && !owner.has(e.commit)) owner.set(e.commit, e);
    return {
        owner,
        othersOf: (entry) => [...owner].filter(([commit, e]) => e !== entry && e.skill === entry.skill && commit !== entry.commit).map(([commit]) => commit),
    };
}

function recordCommitUnsafe(o) {
    const bad = (reason) => ({ ok: false, failedStep: 'input', reason });
    const refuse = (reason) => ({ ok: false, failedStep: 'record', reason });
    if (!isPlainObject(o)) return bad('recordCommit needs an options object {root, candidateSha256, commit}');
    const root = path.resolve(typeof o.root === 'string' && o.root !== '' ? o.root : defaultRoot());
    if (!isDirectory(root)) return bad(`root is not a directory: ${root}`);
    if (typeof o.candidateSha256 !== 'string' || !HEX64_RE.test(o.candidateSha256)) return bad('--candidate-sha256 must be 64 hex characters');
    if (typeof o.commit !== 'string' || !COMMIT_INPUT_RE.test(o.commit)) return bad('--commit must be a 40-character (or 64-character) commit id');
    if (o.date !== undefined && !validDate(o.date)) return bad('--date must be a YYYY-MM-DD date (a real calendar day)');
    const sha = o.candidateSha256.toLowerCase();
    const commit = o.commit.toLowerCase();

    // The commit may serve one entry only, wherever that entry's ledger is.
    const holderOf = (ledgers) => {
        for (const item of ledgers) for (const e of item.entries) if (e.disposition === 'applied' && e.commit === commit) return e;
        return null;
    };
    const holder = holderOf(loadLedgers(root));
    if (holder !== null) {
        if (holder.candidate_sha256 === sha) return { ok: true, updated: false, ledger: ledgerHolding(root, holder), revert: holder.revert };
        return refuse(`commit ${commit} is already recorded for another candidate (${holder.candidate_sha256}); one commit serves one entry`);
    }

    const ledgers = (o.date === undefined ? listLedgerFiles(root).reverse() : [{ date: o.date, file: ledgerFile(root, o.date), rel: ledgerRel(o.date) }]);
    let target = null; // newest ledger holding an applied entry for this candidate that has no commit yet
    let heldElsewhere = null;
    for (const item of ledgers) {
        const doc = readLedgerFile(item.file);
        if (doc === null) continue;
        if (target === null && newestUncommitted(doc, sha) !== -1) target = { ...item, entry: doc.entries[newestUncommitted(doc, sha)] };
        const held = doc.entries.find((e) => e.disposition === 'applied' && e.candidate_sha256 === sha && e.commit !== null);
        if (heldElsewhere === null && held !== undefined) heldElsewhere = held;
    }
    if (target === null) {
        return refuse(heldElsewhere !== null
            ? `the applied entry for ${sha} already holds commit ${heldElsewhere.commit}; a recorded commit is write-once`
            : `no applied ledger entry for candidate ${sha} is waiting for a commit`);
    }

    // Proof, before anything is written: the commit is on the default branch and its diff on the skill is the evaluated change.
    const proof = openEvidence(root).assess({ ...target.entry, commit }, []);
    if (proof.state === 'not-merged') {
        return refuse(`${commit} is not recorded: ${proof.reason}. Record the commit that holds the change on the default branch (the fast-forward, the merge or the squash commit), not one that is only on a branch`);
    }
    if (proof.state === 'unverified') return refuse(`${commit} is not recorded: ${proof.reason}`);

    fsSafe.safeMkdirp(lockDirOf(root), root);
    return withFileLock(lockPathFor(root, target.file), () => {
        const doc = readLedgerFile(target.file);
        const index = doc === null ? -1 : newestUncommitted(doc, sha);
        if (index === -1) return refuse(`the applied entry for ${sha} changed while its commit was being recorded; run record-commit again`);
        if (holderOf(loadLedgers(root)) !== null) return refuse(`commit ${commit} was recorded for another entry while this one was being recorded; one commit serves one entry`);
        doc.entries[index].commit = commit;
        doc.entries[index].revert = revertText(commit);
        writeLedgerDoc(target.file, doc, root);
        return { ok: true, updated: true, ledger: target.rel, revert: revertText(commit) };
    });
}

/** The repository-relative ledger path that holds `entry` (an entry already read from a ledger of `root`). */
function ledgerHolding(root, entry) {
    for (const item of loadLedgers(root)) if (item.entries.some((e) => e.disposition === 'applied' && e.commit === entry.commit && e.candidate_sha256 === entry.candidate_sha256)) return item.rel;
    return null;
}

/**
 * Fill in the commit of the newest applied entry for a candidate, and the exact `git revert <commit>` text that undoes it:
 * once, after the change has landed on the default branch. Write-once (the same commit again is a no-op, a different one is
 * refused). The commit must be reachable from the default branch, its diff on the skill's files must be exactly the change the
 * entry evaluated, and no other entry may hold it. The helper never runs the revert. Never throws.
 *   -> {ok: true, updated, ledger, revert} | {ok: false, failedStep: 'input' | 'record' | 'ledger', reason}
 */
function recordCommit(options) {
    try {
        return recordCommitUnsafe(options);
    } catch (err) {
        return { ok: false, failedStep: 'ledger', reason: `the evolution ledger could not be updated: ${errorMessage(err)}` };
    }
}

// ─── bind: record what an iteration evaluated ────────────────────────────────

/**
 * Write `iteration-<N>/binding.json` for the workspace's highest iteration: the sha256 of the `candidate/` and
 * `skill-snapshot/` trees as they are NOW, and of every `grading.json` and `benchmark.json` under the iteration and its holdout.
 * Run it right after `skill-eval aggregate` of BOTH (or let the evaluator that ran the candidate do it): a holdout aggregated
 * after the bind is an added file and apply refuses it. It refuses when a candidate or snapshot file is newer than the
 * iteration's benchmark.json, because that file was edited after the evaluation was aggregated. Write-once: an existing
 * binding for the same hashes is a no-op, one for different hashes (or the old shape without grading hashes) is refused.
 * Never throws; the result is what the CLI prints.
 */
function bind(options) {
    const o = options && typeof options === 'object' ? options : {};
    const res = { ok: false, verb: 'bind', bound: false };
    try {
        const ws = readWorkspace(o.run);
        const iteration = resolveIteration(ws, o.iteration);
        const name = path.basename(iteration);
        const benchmark = path.join(iteration, 'benchmark.json');
        let benchmarkMtime;
        try {
            JSON.parse(fs.readFileSync(benchmark, 'utf8'));
            benchmarkMtime = fs.statSync(benchmark).mtimeMs;
        } catch (err) {
            throw new Refusal('input', `${name}/benchmark.json is missing or unparseable (run skill-eval aggregate first): ${errorMessage(err)}`);
        }
        const snapshotEntries = walkTree(ws.snapshotDir);
        const stale = [...ws.candidate, ...snapshotEntries].filter((e) => fs.lstatSync(e.abs).mtimeMs > benchmarkMtime);
        if (stale.length > 0) {
            throw new Refusal('binding', `${stale.length} candidate or snapshot file(s) changed after ${name} was aggregated (${stale.slice(0, 5).map((e) => e.rel).join(', ')}): the evaluation did not grade them; re-evaluate before binding`);
        }
        const gradings = gradingHashes(iteration, resolveHoldout(iteration, undefined), 'binding');
        const record = { version: BINDING_VERSION, iteration: name, candidateSha256: treeHash(ws.candidate), snapshotSha256: treeHash(snapshotEntries), gradings };
        const file = path.join(iteration, 'binding.json');
        let existing = null;
        try {
            existing = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            if (!(err && err.code === 'ENOENT')) throw new Refusal('binding', `${name}/binding.json exists but is unreadable: ${errorMessage(err)}`);
        }
        if (existing !== null) {
            if (existing.candidateSha256 !== record.candidateSha256 || existing.snapshotSha256 !== record.snapshotSha256) {
                throw new Refusal('binding', `${name} is already bound to a different candidate or snapshot (${existing.candidateSha256}); a binding is write-once, re-evaluate into a new iteration`);
            }
            const bound = existing.version === BINDING_VERSION && existing.gradings !== null && typeof existing.gradings === 'object' && !Array.isArray(existing.gradings) ? existing.gradings : null;
            if (bound === null) {
                throw new Refusal('binding', `${name} is already bound without grading hashes (an old-shape binding); a binding is write-once, re-evaluate into a new iteration`);
            }
            const diff = gradingDifferences(bound, gradings);
            if (diff.length > 0) {
                throw new Refusal('binding', `${name} is already bound to different grading evidence (${diff.slice(0, 5).join('; ')}); a binding is write-once, re-evaluate into a new iteration`);
            }
        } else {
            fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
        }
        Object.assign(res, { ok: true, bound: true, iteration: name, candidateSha256: record.candidateSha256, snapshotSha256: record.snapshotSha256, alreadyBound: existing !== null });
    } catch (err) {
        res.ok = false;
        res.bound = false;
        res.failedStep = err instanceof Refusal ? err.step : 'input';
        res.reason = err instanceof Refusal ? err.message : `unexpected error: ${errorMessage(err)}`;
    }
    return res;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const APPLY_FLAGS = {
    '--run': 'run', '--mode': 'mode', '--branch': 'branch', '--route': 'route', '--iteration': 'iteration', '--holdout': 'holdout',
    '--min-replicates': 'minReplicates', '--candidate-sha256': 'candidateSha256', '--date': 'date', '--evidence': 'evidence', '--root': 'root',
};
const BIND_FLAGS = { '--run': 'run', '--iteration': 'iteration' };
const RECORD_FLAGS = { '--candidate-sha256': 'candidateSha256', '--commit': 'commitId', '--date': 'date', '--root': 'root' };

function parseFlags(rest, flags, positionalName) {
    const options = {};
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
        const token = rest[i];
        if (token.startsWith('--')) {
            const key = flags[token];
            if (key === undefined) throw new Error(`unknown flag ${token}`);
            const value = rest[i + 1];
            if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`);
            options[key] = value;
            i++;
        } else {
            positional.push(token);
        }
    }
    if (positionalName === null && positional.length > 0) throw new Error(`unexpected argument ${positional[0]}`);
    if (positional.length > 1) throw new Error(`unexpected extra argument ${positional[1]}`);
    if (positional.length === 1) options[positionalName] = positional[0];
    return options;
}

function emit(result) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

const USAGE = 'usage: skill-apply.js apply <skill> --run <workspace> [--mode propose|apply] [--branch auto/<name>] [--route verdict|side-door] [--iteration <dir>] [--holdout <dir>] [--min-replicates <n>] [--candidate-sha256 <hex64>] [--date YYYY-MM-DD] [--evidence id[,id...]] [--root <dir>]\n'
    + '       skill-apply.js bind --run <workspace> [--iteration <dir>]\n'
    + '       skill-apply.js record-commit --candidate-sha256 <hex64> --commit <commit id> [--date YYYY-MM-DD] [--root <dir>]\n';

function usageFailure(reason) {
    emit({ ok: false, applied: false, restored: false, failedStep: 'input', reason });
    process.stderr.write(USAGE);
    return EXIT_INVALID;
}

function runCli(argv, options) {
    const args = Array.isArray(argv) ? argv : [];
    const verb = args[0];
    if (verb !== 'apply' && verb !== 'bind' && verb !== 'record-commit') {
        return usageFailure(verb === undefined ? 'a verb is required (apply, bind or record-commit)' : `unknown verb ${verb}`);
    }
    let parsed;
    try {
        if (verb === 'apply') parsed = parseFlags(args.slice(1), APPLY_FLAGS, 'skill');
        else parsed = parseFlags(args.slice(1), verb === 'bind' ? BIND_FLAGS : RECORD_FLAGS, null);
    } catch (err) {
        return usageFailure(errorMessage(err));
    }
    if (verb === 'record-commit') {
        if (parsed.root === undefined && options && typeof options.root === 'string') parsed.root = options.root;
        const result = recordCommit({ root: parsed.root, candidateSha256: parsed.candidateSha256, commit: parsed.commitId, date: parsed.date });
        emit(result);
        process.stderr.write(`[SKILL-APPLY] ${result.ok ? `${result.updated ? 'recorded' : 'already recorded'} ${result.revert} in ${result.ledger}` : `${result.failedStep}: ${result.reason}`}\n`);
        if (result.ok) return EXIT_OK;
        return result.failedStep === 'input' ? EXIT_INVALID : EXIT_FAILED;
    }
    if (verb === 'bind') {
        const result = bind(parsed);
        emit(result);
        process.stderr.write(`[SKILL-APPLY] ${result.ok ? `bound ${result.iteration} to candidate ${result.candidateSha256}` : `${result.failedStep}: ${result.reason}`}\n`);
        if (result.ok) return EXIT_OK;
        return result.failedStep === 'input' ? EXIT_INVALID : EXIT_FAILED;
    }
    if (parsed.root === undefined && options && typeof options.root === 'string') parsed.root = options.root;
    const result = apply(parsed);
    emit(result);
    if (result.ok && result.applied) {
        process.stderr.write(`[SKILL-APPLY] applied ${result.skill} on local branch ${result.branch}, uncommitted. Stage these files, commit through commit.js, never push: ${result.files.join(' ')}\n`);
        process.stderr.write(`[SKILL-APPLY] disposition recorded in ${result.ledger}; once the change is on the default branch, run record-commit --candidate-sha256 ${result.candidateSha256} --commit <hash> to fill in the commit and its revert pointer\n`);
    } else if (!result.ok) {
        process.stderr.write(`[SKILL-APPLY] ${result.failedStep}: ${result.reason}\n`);
    }
    if (result.ok) return EXIT_OK;
    return result.failedStep === 'input' ? EXIT_INVALID : EXIT_FAILED;
}

module.exports = {
    EXIT_OK,
    EXIT_FAILED,
    EXIT_INVALID,
    classifyEdit,
    classifyChange,
    apply,
    bind,
    appendLedger,
    recordCommit,
    loadLedgers,
    listLedgerFiles,
    readLedgerFile,
    withFileLock,
    lockPathFor,
    readLock, // test seams for the stale-lock protocol
    breakStaleLock,
    writeAtomic,
    gitFor,
    openEvidence,
    claimCommits,
    deltaHash,
    validDate,
    revertText,
    runCli,
};

if (require.main === module) {
    let code;
    try {
        code = runCli(process.argv.slice(2), {});
    } catch (err) {
        process.stderr.write(`skill-apply: ${errorMessage(err)}\n`);
        code = EXIT_INVALID;
    }
    process.exitCode = code;
}
