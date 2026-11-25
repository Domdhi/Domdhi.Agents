#!/usr/bin/env node
'use strict';

/**
 * ship-check.js — seal and verify the evidence behind a wave (or ad-hoc task) commit.
 *
 *   node ship-check.js seal   [--docs a,b] [--todo T --stories A,B]
 *   node ship-check.js verify --kind wave|task [--plan P] [--wave N] [--todo T] [--stories A,B] [--skip "<reason>"]
 *
 * This is the judge behind the `SHIP_CHECK_OK` token: a wave may be committed only when `verify` exits 0. Both verbs
 * print exactly one JSON document to stdout (`{ok, exitCode, errors:[{rule,message,fix}], warnings, notices, skipped,
 * stories, mode?, seal?}`) and, for each error, one stderr line `[ship-check] refusing: {message}. Fix: {fix}` (the
 * shape pull-request.js uses). Exit codes: 0 ok, 1 refused, 2 invalid input or an internal error. Neither exported verb
 * ever throws; every exception becomes `{ok:false, exitCode:2, errors:[{rule:'exception'}]}` (fail closed).
 *
 * TWO PHASES. A gate receipt hashes the whole tree, and a wave edits the TODO, plan, review reports and memory after its
 * gate, so a full-tree receipt can never match at commit time. `seal` therefore runs after the last code edit: it checks
 * the gate evidence, runs the ac-verify freeze check and the `verify:` bindings ITSELF (it never trusts a record already
 * on disk: any agent can write one), and writes the ship seal using the code-only `codeTreeHash` the records and the
 * gate receipt (`receipt.codeHash`, written by gate.js at gate end) share. The seal holds exactly
 * `{head, receiptId|null, mode, codeHash, gateCodeHash, recordsHash, docs, todo, sealedAt}`:
 *   - `gateCodeHash` is the code hash with no `--docs` exclusion: the hash the receipt and every record were taken on;
 *   - `codeHash` is the same hash with the `--docs` paths excluded (equal to `gateCodeHash` when `docs` is empty). A
 *     `--docs` path is a document under docs/ (never a code file, never a directory) that the wave edits AFTER the seal;
 *     it must be unchanged between the gate and the seal, because the receipt and the records were taken on it;
 *   - `todo` is the repo-relative TODO the seal was made for (null with none): `verify` refuses a different one;
 *   - The seal records its sorted story list; a verify naming a different set is `stories-mismatch` (not `records-drift`).
 *   - With `--todo`, the seal also runs the freeze check over the TODO's other stories that already have a baseline, so a
 *     wave that edits an earlier story's frozen test is refused at its own seal, not first at the Ship gate.
 *   - `recordsHash` covers each sealed story's record file AND its ac-verify freeze baseline (`{id}.freeze.json`), so a
 *     baseline rewritten after the seal is `records-drift`.
 * `verify` runs at commit time, recomputes every part of the seal against the tree as it is now, and re-runs
 * `ac-verify check` (never `run`). The tree is hashed before the gate evidence is judged and again after the bindings
 * ran; a difference refuses the seal (`tree-changed`), so code edited while the bindings ran is never sealed.
 *
 * THREAT MODEL. The seal, the records, the receipt and the summary live in the ignored state zone, and any writer to
 * `docs/.output/.state/` can produce every one of them. This check therefore proves the SEQUENCE (gate, then bindings,
 * then seal, then commit) and prevents accidents (stale evidence, an edit after the gate, a swapped TODO or plan, a
 * stale stage); it is not adversarial integrity. It stops a writer who forges only the seal, or only the receipt, or
 * who deletes the receipt; it does not stop one who writes a schema-complete receipt (matching engine and config hashes,
 * a passed test leg and the current `codeHash`) and a matching seal. Adversarial integrity would need a signing key the
 * agent cannot read; that is a follow-up, not part of this story.
 *
 * MODES. The switches come from the COMMITTED gate config (`git show HEAD:.claude/gate.config.json`), never from the
 * working tree: a missing file at HEAD means the defaults, and a working-tree `shipCheck` object that differs from
 * HEAD's is refused with rule `config` (the switches change only through a reviewed commit). `receipt` mode is the
 * DEFAULT: `gate-receipt.json` must exist and pass `verifyReceiptEvidence` (status, exit code, schema, head, engine, config
 * hash, not change-scoped, a passed test leg, and `receipt.codeHash === the code hash`); a missing receipt refuses and
 * never downgrades. `summary` mode applies only when the committed config sets `shipCheck.requireReceipt: false`
 * (lower assurance): `_latest-summary.json` must say `overall === true`, with a succeeded, non-empty test leg and a
 * succeeded build, not change-scoped, not killed, and be newer than the newest non-doc file in the tree. `verify`
 * re-reads and re-checks that evidence (receipt: the same receipt the seal names; summary: the summary again).
 * Only the boolean `false` turns the check off (`shipCheck.enabled`); that is an AUDITED bypass (rule
 * `ship-check-disabled`) that still requires the completion check and the review entry. An unreadable or non-object
 * config refuses everything with rule `config`: the mode and the switch are unknowable, and breaking the file must
 * never downgrade or bypass the check.
 *
 * SKIP. `--skip "<reason>"` bypasses the seal-based conditions only (seal, head, code, records, ac-check, receipt,
 * unstaged-code). The completion check and the review entry are still required. An honoured skip records one `bypass`
 * guardrail event written against the verified repository root (never the AGENT_SHARED_STATE_ROOT / AGENTS_PROJECT_DIR
 * destination, never through a symlink) with the reason, kind, wave, stories and head, and is refused when that event
 * cannot be written: no bypass is silent. The event is written only when the verdict would otherwise be ok.
 *
 * INDEX. `verify` also refuses (rule `unstaged-code`) when a path the code hash covers is staged with content that
 * differs from the working tree: the hash judges working-tree bytes but a commit takes the index. Unstaged edits are
 * fine (commit.js stages them from the working tree and then checks that the staged set matches it).
 *
 * Beyond the AC text (security-conservative): `met` is recomputed from `exit === expectedExit` and a record's own `met`
 * is never trusted; a review inside a code fence, an HTML comment or an indented code block, or with unfilled `{...}`
 * bullets, does not count; `--docs` and `--todo` outside the repository (lexically or through a symlink) are refused,
 * `--plan` must resolve inside docs/.output/plans/; the seal is bound to its TODO; a symlinked seal, receipt or
 * state-zone ancestor is never read or written through; the freeze check runs before any binding so a tampered `verify:`
 * line is never executed. With no `--todo` (an ad-hoc task) the ac-verify freeze check cannot run (it needs a TODO), so
 * the frozen files are covered only by the code hash.
 *
 * BACKSTOP WARNING. `verify` also prints a refusal-level warning on stderr (never a different verdict or exit code) when
 * the managed git hooks (git-hooks.js --check) are not active in the repository: without them a raw commit is not
 * secret-scanned and a push is neither scanned nor kept from forcing, so a pass here is not the whole story and the
 * missing backstop must never be silent.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const acVerify = require('./ac-verify');
const gateReceipt = require('./_lib/gate-receipt');
const { verifyTodoCompletion, readTodoFile } = require('./todo-completion');
const { getTelemetryDir, getSummaryPath } = require('./_lib/telemetry-paths');
const { assertNoSymlinkedAncestor } = require('./_lib/fs-safe');
const { resolveWorktreeRoot } = require('./_lib/project-root');
const { emitGuardrailHitAt } = require('./_lib/hook-telemetry');

const SEAL_KEYS = ['codeHash', 'docs', 'gateCodeHash', 'head', 'mode', 'receiptId', 'recordsHash', 'sealedAt', 'stories', 'todo'];
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SEAL_MAX_BYTES = 64 * 1024;
const CONFIG_MAX_BYTES = 1024 * 1024;
const RECORDS_MAX_BYTES = 4 * 1024 * 1024;
const PLAN_MAX_BYTES = 8 * 1024 * 1024;
const SKIP_REASON_MAX = 500;
const MAX_LISTED = 20;
const GIT_MAX_BYTES = 64 * 1024 * 1024;
const PLAN_DIR = 'docs/.output/plans/';
const REVIEW_LABELS = ['reviewed', 'fixed now', 'deferred', 'skipped or light', 'risk call'];
// A code file inside docs/ stays part of the code hash; the summary-mode freshness test uses the same notion of "not a
// document" (one definition, owned by gate-receipt.js).
const { CODE_FILE_IN_DOCS } = gateReceipt;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clip = (text, max = 200) => (String(text).length > max ? `${String(text).slice(0, max)}...` : String(text));
// The runtime directory the Fix hints name: the one this script runs from (`.claude/core` or `.codex/core`); a
// source checkout (`.agents/core`) falls back to AGENTS_RUNTIME.
const OWN_RUNTIME_DIR = path.basename(path.dirname(__dirname));
const runtimeDir = (env) => (OWN_RUNTIME_DIR === '.claude' || OWN_RUNTIME_DIR === '.codex' ? OWN_RUNTIME_DIR : (env && env.AGENTS_RUNTIME === 'codex' ? '.codex' : '.claude'));
const sealPath = (root) => path.join(getTelemetryDir(root), 'ship-seal.json');
const recordFilePath = (root, id) => path.join(getTelemetryDir(root), 'ac-verify', `${id}.json`);
const baselineFilePath = (root, id) => path.join(getTelemetryDir(root), 'ac-verify', `${id}.freeze.json`);

// ── result plumbing ─────────────────────────────────────────────────

function newResult() {
    return { errors: [], warnings: [], notices: [], skipped: [], stories: [] };
}

/** Add one refusal. `message` loses a trailing period so `... . Fix: ...` reads as one sentence. */
function refuse(result, rule, message, fix) {
    result.errors.push({ rule, message: String(message).replace(/[.\s]+$/, ''), fix: String(fix) });
}

/** The final document: exit 2 for invalid input or an exception, 1 for any other refusal, 0 when nothing failed. */
function conclude(result, extra = {}) {
    const exitCode = result.errors.length === 0 ? 0 : result.errors.some((e) => e.rule === 'invalid-args' || e.rule === 'exception') ? 2 : 1;
    const out = { ok: exitCode === 0, exitCode, errors: result.errors, warnings: result.warnings, notices: result.notices, skipped: result.skipped, stories: result.stories };
    if (extra.mode) out.mode = extra.mode;
    if (extra.seal) out.seal = extra.seal;
    return out;
}

function invalid(message, env) {
    const result = newResult();
    refuse(result, 'invalid-args', message, `see the usage in ${runtimeDir(env)}/core/ship-check.js (seal [--docs a,b] [--todo T --stories A,B] | verify --kind wave|task ...)`);
    return conclude(result);
}

function exceptionResult(error) {
    const result = newResult();
    const text = error && typeof error.message === 'string' ? error.message : 'unknown failure';
    refuse(result, 'exception', `ship-check failed: ${clip(text)}`, 'fix the reported cause and run the command again; the check fails closed');
    return conclude(result);
}

// ── filesystem and git helpers ──────────────────────────────────────

/** A bounded read of an ordinary, non-symlinked file: `{state:'ok', bytes}`, `{state:'missing'}` or `{state:'bad', reason}`. */
function readBounded(file, maxBytes) {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { state: 'missing' };
        return { state: 'bad', reason: `cannot stat (${error.code || 'error'})` };
    }
    if (stat.isSymbolicLink()) return { state: 'bad', reason: 'is a symlink' };
    if (!stat.isFile()) return { state: 'bad', reason: 'is not an ordinary file' };
    if (stat.size > maxBytes) return { state: 'bad', reason: `is larger than ${maxBytes} bytes` };
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        if (!fs.fstatSync(fd).isFile()) return { state: 'bad', reason: 'is not an ordinary file' };
        return { state: 'ok', bytes: fs.readFileSync(fd) };
    } catch (error) {
        if (error.code === 'ELOOP') return { state: 'bad', reason: 'is a symlink' };
        return { state: 'bad', reason: `cannot be read (${error.code || 'error'})` };
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing to release */ } }
    }
}

/** `readBounded` for a state-zone file: a symlinked ancestor directory is refused too, not only a symlinked leaf. */
function readState(root, file, maxBytes) {
    try { assertNoSymlinkedAncestor(file, root); } catch { return { state: 'bad', reason: 'sits inside a symlinked directory' }; }
    return readBounded(file, maxBytes);
}

const isInside = (root, target) => {
    const rel = path.relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

/** The real path of `target` through its deepest existing ancestor (a missing leaf is allowed); null when unresolvable. */
function realDeepest(target) {
    let existing = path.resolve(target);
    const missing = [];
    for (;;) {
        try { return path.join(fs.realpathSync(existing), ...missing.reverse()); } catch {
            const parent = path.dirname(existing);
            if (parent === existing) return null;
            missing.push(path.basename(existing));
            existing = parent;
        }
    }
}

/** `{ok:true, rel, real}` (repo-relative, forward slashes) when `raw` resolves inside the repository after symlinks. */
function repoRelative(root, cwd, raw) {
    if (typeof raw !== 'string' || !raw.trim() || /[\0\r\n]/.test(raw)) return { ok: false };
    let realRoot;
    try { realRoot = fs.realpathSync(root); } catch { return { ok: false }; }
    const real = realDeepest(path.resolve(cwd, raw));
    if (!real || !isInside(realRoot, real)) return { ok: false };
    return { ok: true, rel: path.relative(realRoot, real).split(path.sep).join('/'), real };
}

/** git stdout, or null on any failure. The GIT_* environment is dropped: it must not redirect the judge to another index. */
function gitOut(root, args) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
    const result = spawnSync('git', ['-C', root, ...args], {
        encoding: 'utf8', env: { ...env, GIT_OPTIONAL_LOCKS: '0', MSYS_NO_PATHCONV: '1' }, windowsHide: true, maxBuffer: GIT_MAX_BYTES, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) return null;
    return result.stdout;
}

/** True when `root` is the top of its git working tree (the directory every hash and event is anchored to). */
function isRepoRoot(root) {
    const top = gitOut(root, ['rev-parse', '--show-toplevel']);
    if (top === null) return false;
    try { return fs.realpathSync(top.trim()) === fs.realpathSync(root); } catch { return false; }
}

// ── gate config ─────────────────────────────────────────────────────

const GATE_CONFIG_REL = '.claude/gate.config.json';
const CONFIG_REPAIR_FIX = `repair ${GATE_CONFIG_REL} (valid JSON, an object at the top level) or remove it`;

/** A deterministic string for a JSON value (object keys sorted), so two configs compare by content. */
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return value === undefined ? 'undefined' : JSON.stringify(value);
}

/** The `shipCheck` value in the gate config at HEAD: `{shipCheck}` (undefined when the file or HEAD is absent) or `{error}`. */
function committedShipCheck(root) {
    if (gitOut(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']) === null) return { shipCheck: undefined };
    const listing = gitOut(root, ['ls-tree', '-z', 'HEAD', '--', GATE_CONFIG_REL]);
    if (listing === null) return { error: `${GATE_CONFIG_REL} cannot be looked up at HEAD`, fix: 'make sure git can read the repository, then run the command again' };
    if (!listing) return { shipCheck: undefined };
    const bytes = gitOut(root, ['show', `HEAD:${GATE_CONFIG_REL}`]);
    if (bytes === null) return { error: `${GATE_CONFIG_REL} cannot be read at HEAD`, fix: 'make sure git can read the repository, then run the command again' };
    let parsed;
    try { parsed = JSON.parse(bytes); } catch { return { error: `${GATE_CONFIG_REL} at HEAD is not valid JSON`, fix: `commit a repaired ${GATE_CONFIG_REL}, then run the command again` }; }
    if (!isPlainObject(parsed)) return { error: `${GATE_CONFIG_REL} at HEAD is not a JSON object`, fix: `commit a repaired ${GATE_CONFIG_REL}, then run the command again` };
    return { shipCheck: parsed.shipCheck };
}

/**
 * `{mode, enabled}` or `{error, fix}`. The switches come from the config COMMITTED at HEAD, never from the working
 * tree: the file is untracked or editable by any agent, and an off switch must leave history. A working-tree `shipCheck`
 * that differs from HEAD's is refused, so a switch changes only through a commit. An absent working-tree file is an empty
 * config; an unreadable or non-object one is an error (the mode and the switch are unknowable).
 */
function loadGateConfig(root) {
    const read = readBounded(path.join(root, '.claude', 'gate.config.json'), CONFIG_MAX_BYTES);
    let config = {};
    if (read.state === 'bad') return { error: `${GATE_CONFIG_REL} ${read.reason}`, fix: CONFIG_REPAIR_FIX };
    if (read.state === 'ok') {
        let parsed;
        try { parsed = JSON.parse(read.bytes.toString('utf8')); } catch { return { error: `${GATE_CONFIG_REL} is not valid JSON`, fix: CONFIG_REPAIR_FIX }; }
        if (!isPlainObject(parsed)) return { error: `${GATE_CONFIG_REL} is not a JSON object`, fix: CONFIG_REPAIR_FIX };
        config = parsed;
    }
    const committed = committedShipCheck(root);
    if (committed.error) return committed;
    if (canonical(config.shipCheck) !== canonical(committed.shipCheck)) {
        return {
            error: `the shipCheck settings in the working-tree ${GATE_CONFIG_REL} differ from the ones committed at HEAD (the switches are read from HEAD)`,
            fix: `restore the committed shipCheck settings, or commit the change on its own and review it before relying on it`,
        };
    }
    const shipCheck = isPlainObject(committed.shipCheck) ? committed.shipCheck : {};
    // Receipt mode is the default. A missing receipt is a refusal, never a downgrade; only the committed
    // `shipCheck.requireReceipt: false` selects the lower-assurance summary mode.
    return { config, mode: shipCheck.requireReceipt === false ? 'summary' : 'receipt', enabled: shipCheck.enabled !== false };
}

const configRefusal = (result, loaded) => refuse(result, 'config', loaded.error, loaded.fix);

// ── options ─────────────────────────────────────────────────────────

/** Validate and default the options for one verb: `{error}` or `{value}`. Reads only the documented properties. */
function normalizeOptions(opts, verb) {
    if (!opts || typeof opts !== 'object') return { error: 'options are required' };
    const root = opts.root;
    if (typeof root !== 'string' || !path.isAbsolute(root)) return { error: 'the repository root must be an absolute path' };
    const cwd = opts.cwd === undefined ? root : opts.cwd;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { error: 'the working directory must be an absolute path' };
    const env = opts.env === undefined || opts.env === null ? process.env : opts.env;
    if (typeof env !== 'object') return { error: 'env must be an object' };
    const stories = opts.stories === undefined ? [] : opts.stories;
    if (!Array.isArray(stories) || stories.some((id) => typeof id !== 'string' || !id)) return { error: 'stories must be a list of story ids' };
    const todo = opts.todo === undefined || opts.todo === null ? null : opts.todo;
    if (todo !== null && (typeof todo !== 'string' || !todo.trim())) return { error: 'the TODO path must be text' };
    if ((todo !== null) !== (stories.length > 0)) return { error: '--todo and --stories come together or not at all' };
    const value = { root, cwd, env, stories, todo };
    if (verb === 'seal') {
        const docs = opts.docs === undefined ? [] : opts.docs;
        if (!Array.isArray(docs) || docs.some((entry) => typeof entry !== 'string')) return { error: 'docs must be a list of paths' };
        return { value: { ...value, docs } };
    }
    const kind = opts.kind;
    if (kind !== 'wave' && kind !== 'task') return { error: '--kind must be "wave" or "task"' };
    let plan = null;
    let wave = null;
    if (kind === 'wave') {
        if (typeof opts.plan !== 'string' || !opts.plan.trim()) return { error: '--kind wave requires --plan' };
        if (!Number.isInteger(opts.wave) || opts.wave < 1) return { error: '--kind wave requires --wave as a positive integer' };
        if (todo === null) return { error: '--kind wave requires --todo and --stories' };
        plan = opts.plan;
        wave = opts.wave;
    } else if ((opts.plan !== undefined && opts.plan !== null) || (opts.wave !== undefined && opts.wave !== null)) {
        return { error: '--plan and --wave only apply to --kind wave' };
    }
    let skip = null;
    if (opts.skip !== undefined) {
        if (typeof opts.skip !== 'string' || !opts.skip.trim()) return { error: '--skip needs a reason' };
        const reason = opts.skip.trim();
        if (reason.length > SKIP_REASON_MAX || /[\0-\x1f\x7f]/.test(reason)) return { error: `--skip reason must be one line of at most ${SKIP_REASON_MAX} characters` };
        skip = reason;
    }
    return { value: { ...value, kind, plan, wave, skip } };
}

// ── seal contents ───────────────────────────────────────────────────

/**
 * sha256 over the selected stories' record files AND their ac-verify freeze baselines on disk. A missing or unusable
 * file is a distinct marker, never skipped. The baselines are inside the seal because a rewritten baseline (a dropped
 * file entry, a new hash) re-baselines the tamper check without touching the code tree, and a Bash write can do it.
 */
function recordsDigest(root, ids) {
    const lines = [...new Set(ids)].sort().map((id) => {
        if (!SAFE_STORY_ID.test(id)) return `${id}\0invalid\0invalid\n`;
        const part = (file) => {
            const read = readState(root, file, RECORDS_MAX_BYTES);
            return read.state === 'ok' ? sha256(read.bytes) : read.state;
        };
        return `${id}\0${part(recordFilePath(root, id))}\0${part(baselineFilePath(root, id))}\n`;
    });
    return sha256(lines.join(''));
}

/**
 * Judge every record of the stories that have bindings. One error per bad record. `met` is recomputed from the exit
 * (a record's own `met` is never trusted); a record must carry the expected code hash.
 *
 * @param {{id:string, bindings:number}[]} specs
 * @returns {{errors:{rule:string, message:string}[], failed:Set<string>}}
 */
function checkRecords(root, specs, expectedCodeHash) {
    const errors = [];
    const failed = new Set();
    for (const { id, bindings } of specs) {
        if (!bindings) continue;
        const flag = (rule, message) => { errors.push({ rule, message }); failed.add(id); };
        const read = SAFE_STORY_ID.test(id) ? readState(root, recordFilePath(root, id), RECORDS_MAX_BYTES) : { state: 'bad' };
        let records = null;
        if (read.state === 'ok') {
            try { const parsed = JSON.parse(read.bytes.toString('utf8')); if (Array.isArray(parsed)) records = parsed; } catch { records = null; }
        }
        for (let index = 0; index < bindings; index++) {
            const record = records ? records[index] : null;
            if (!isPlainObject(record)) { flag('record-missing', `${id}: no ac-verify record for binding ${index + 1}`); continue; }
            const where = `${id} binding ${index + 1} (TODO line ${clip(record.acLine, 12)})`;
            if (record.status === 'refused') flag('record-refused', `${where}: the command was refused`);
            else if (record.status === 'timeout') flag('record-timeout', `${where}: the command timed out`);
            else if (record.status === 'tree-changed') flag('record-tree-changed', `${where}: the command changed the code tree while it ran`);
            else if (record.status === 'ran') {
                const met = Number.isInteger(record.exit) && Number.isInteger(record.expectedExit) && record.exit === record.expectedExit;
                if (met && record.vacuous === true) flag('record-unmet', `${where}: exit ${clip(record.exit, 12)} as expected, but ${clip(String(record.vacuousReason || 'no test passed'), 120)}`);
                else if (!met || record.met !== true) flag('record-unmet', `${where}: exit ${clip(record.exit, 12)}, expected exit ${clip(record.expectedExit, 12)}`);
            } else flag('record-unmet', `${where}: unknown record status ${JSON.stringify(clip(record.status, 20))}`);
            if (record.codeHash !== expectedCodeHash) flag('record-stale', `${where}: the record was taken on a different code tree than the seal`);
        }
    }
    return { errors, failed };
}

/**
 * The summary-mode reasons the gate summary is not acceptable evidence (empty when it is). A summary is test evidence
 * only when it holds a succeeded, non-empty, unkilled test leg and a succeeded build and the run was not change-scoped:
 * `gate.js e2e` with no e2e script and a build-only run both write `overall: true` and ran no tests.
 */
function summaryProblems(root) {
    const file = getSummaryPath(root);
    const read = readState(root, file, CONFIG_MAX_BYTES);
    if (read.state !== 'ok') return [`there is no valid _latest-summary.json (${read.state === 'missing' ? 'missing' : `it ${read.reason}`})`];
    let summary = null;
    try { summary = JSON.parse(read.bytes.toString('utf8')); } catch { summary = null; }
    if (!isPlainObject(summary) || typeof summary.overall !== 'boolean') return ['there is no valid _latest-summary.json (unreadable or without a boolean overall)'];
    const problems = [];
    if (summary.overall !== true) problems.push('the latest gate summary is not a pass (overall is not true)');
    if (summary.killed !== undefined && summary.killed !== null && summary.killed !== false) problems.push('the latest gate run was killed');
    if (typeof summary.mode === 'string' && /changed only/i.test(summary.mode)) problems.push('the latest gate run was change-scoped (--changed); it does not cover the whole suite');
    const test = summary.test;
    if (!isPlainObject(test) || test.succeeded !== true) problems.push('the latest gate summary has no passing test leg (a build-only, e2e-only or skipped run is not test evidence)');
    else if (test.zeroCollected === true || test.timedOut === true || test.killedBy) problems.push('the latest gate summary test leg collected no tests, timed out or was killed');
    if (!isPlainObject(summary.build) || summary.build.succeeded !== true) problems.push('the latest gate summary has no succeeded build');
    let summaryMtime;
    try { summaryMtime = fs.lstatSync(file).mtimeMs; } catch { return [...problems, 'the gate summary cannot be stat-ed']; }
    const listing = gitOut(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (listing === null) return [...problems, 'the tree cannot be listed to compare against the summary'];
    let newest = 0;
    let newestFile = null;
    for (const rel of listing.split('\0').filter(Boolean)) {
        if (rel.startsWith('docs/') && !CODE_FILE_IN_DOCS.test(rel)) continue;
        let mtime;
        try { mtime = fs.lstatSync(path.join(root, rel)).mtimeMs; } catch { continue; }
        if (mtime > newest) { newest = mtime; newestFile = rel; }
    }
    if (newestFile !== null && newest >= summaryMtime) problems.push(`${newestFile} is not older than the gate summary, so the summary may not cover it`);
    return problems;
}

/**
 * The gate receipt as evidence for the code hash `codeHash`: `{receipt, problems}` (empty problems when it is a valid,
 * passed, whole-suite receipt for exactly this code). Read with the same symlink posture as every other state file.
 */
function receiptEvidence(root, codeHash) {
    const read = readState(root, gateReceipt.receiptPath(root), CONFIG_MAX_BYTES);
    if (read.state === 'missing') return { receipt: null, problems: ['there is no gate receipt (docs/.output/.state/telemetry/gate-receipt.json): receipt mode never falls back to a summary'] };
    if (read.state === 'bad') return { receipt: null, problems: [`the gate receipt ${read.reason}`] };
    let receipt = null;
    try { receipt = JSON.parse(read.bytes.toString('utf8')); } catch { receipt = null; }
    if (!isPlainObject(receipt)) return { receipt: null, problems: ['the gate receipt is not a JSON object'] };
    const verdict = gateReceipt.verifyReceiptEvidence({ root, receipt, codeHash });
    const problems = verdict.reasons.map((reason) => reason.message);
    if (typeof receipt.id !== 'string' || !receipt.id) problems.push('the gate receipt has no id');
    return { receipt, problems };
}

/** The code hash with no exclusion (`base`: what the receipt and the records cover) and with the `--docs` paths excluded (`sealed`). */
function codeHashes(root, docs) {
    const base = gateReceipt.codeTreeHash(root);
    if (!base.ok) return base;
    if (!docs.length) return { ok: true, base: base.hash, sealed: base.hash };
    const excluded = gateReceipt.codeTreeHash(root, { extraExclude: docs });
    if (!excluded.ok) return excluded;
    return { ok: true, base: base.hash, sealed: excluded.hash };
}

/** Root-level instruction files `--docs` may name besides documents under docs/. */
const ROOT_INSTRUCTION_DOCS = new Set(['CLAUDE.md', 'AGENTS.md']);

/** Why a repo-relative `--docs` entry may not be excluded from the code hash (null when it may). */
function docsEntryProblem(root, rel) {
    // The root instruction files carry counts that API stories update (first adopter run, 2026-11-20); they are prose, not code.
    if (ROOT_INSTRUCTION_DOCS.has(rel)) {
        try { if (!fs.lstatSync(path.join(root, rel)).isFile()) return 'is not an ordinary file'; } catch { /* a not-yet-existing document is fine */ }
        return null;
    }
    if (typeof rel !== 'string' || !rel.startsWith('docs/') || rel.split('/').includes('..') || rel.endsWith('/')) return 'is not a document under docs/ (or a root CLAUDE.md or AGENTS.md)';
    if (CODE_FILE_IN_DOCS.test(rel)) return 'is a code file (code under docs/ stays in the code hash)';
    try { if (fs.lstatSync(path.join(root, rel)).isDirectory()) return 'is a directory (name individual documents)'; } catch { /* a not-yet-existing document is fine */ }
    return null;
}

/**
 * Code paths that are STAGED (index differs from HEAD) with content that also differs from the working tree; null when
 * git cannot say. A path not staged at all is fine: the commit helper stages it from the working tree the hash judged.
 * A staged path whose staged bytes are not the working-tree bytes would be committed unsealed.
 */
function unstagedCodePaths(root, docs) {
    const worktree = gitOut(root, ['diff', '--name-only', '-z']);
    if (worktree === null) return null;
    const hasHead = gitOut(root, ['rev-parse', '--verify', '-q', 'HEAD']) !== null;
    const staged = gitOut(root, hasHead ? ['diff', '--cached', '--name-only', '-z'] : ['ls-files', '-z']);
    if (staged === null) return null;
    const stagedSet = new Set(staged.split('\0').filter(Boolean));
    return worktree.split('\0').filter(Boolean)
        .filter((rel) => stagedSet.has(rel))
        .filter((rel) => !gateReceipt.isCodeHashExcluded(rel) && !docs.some((extra) => rel === extra || rel.startsWith(`${extra}/`)));
}

function removeSeal(root) {
    const file = sealPath(root);
    assertNoSymlinkedAncestor(file, root);
    fs.rmSync(file, { force: true });
}

/** Write the seal through an unpredictable temp name and a rename; a symlink at the seal path was removed first. */
function writeSeal(root, seal) {
    const file = sealPath(root);
    assertNoSymlinkedAncestor(file, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(tmp, `${JSON.stringify(seal, null, 2)}\n`, { flag: 'wx' });
        fs.renameSync(tmp, file);
    } catch (error) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* the original error is the one to report */ }
        throw error;
    }
}

/** Read and validate the seal: `{seal}`, `{missing:true}` or `{bad:reason}`. */
function readSeal(root) {
    const read = readState(root, sealPath(root), SEAL_MAX_BYTES);
    if (read.state === 'missing') return { missing: true };
    if (read.state === 'bad') return { bad: `the seal ${read.reason}` };
    let parsed;
    try { parsed = JSON.parse(read.bytes.toString('utf8')); } catch { return { bad: 'the seal is not valid JSON' }; }
    if (!isPlainObject(parsed)) return { bad: 'the seal is not a JSON object' };
    const keys = Object.keys(parsed).sort();
    if (keys.length !== SEAL_KEYS.length || keys.some((key, i) => key !== SEAL_KEYS[i])) return { bad: `the seal must hold exactly ${SEAL_KEYS.join(', ')}` };
    const okMode = parsed.mode === 'receipt' || parsed.mode === 'summary';
    const okReceipt = parsed.mode === 'receipt' ? typeof parsed.receiptId === 'string' && parsed.receiptId.length > 0 : parsed.receiptId === null;
    const valid = typeof parsed.head === 'string' && /^[0-9a-f]{40,64}$/.test(parsed.head)
        && okMode && okReceipt
        && typeof parsed.codeHash === 'string' && HEX64.test(parsed.codeHash)
        && typeof parsed.gateCodeHash === 'string' && HEX64.test(parsed.gateCodeHash)
        && typeof parsed.recordsHash === 'string' && HEX64.test(parsed.recordsHash)
        && Array.isArray(parsed.docs) && parsed.docs.every((entry) => typeof entry === 'string')
        && (parsed.todo === null || (typeof parsed.todo === 'string' && parsed.todo.length > 0 && !/[\0\r\n]/.test(parsed.todo)))
        && typeof parsed.sealedAt === 'string' && !Number.isNaN(Date.parse(parsed.sealedAt))
        && Array.isArray(parsed.stories) && parsed.stories.every((entry) => typeof entry === 'string');
    if (!valid) return { bad: 'a seal field is missing or has the wrong type' };
    return { seal: parsed };
}

// ── seal ────────────────────────────────────────────────────────────

const gateFix = (env) => `node ${runtimeDir(env)}/core/gate.js test`;
const sealFix = (env) => `node ${runtimeDir(env)}/core/ship-check.js seal [--docs <paths>] [--todo <TODO> --stories <IDS>]`;

const { TAMPER_CODES } = acVerify;

/**
 * The freeze check over the TODO's OTHER stories that already have a baseline (earlier waves), so a wave that edits an
 * earlier story's frozen test is refused at its own seal, not at the Ship gate (first adopter run, 2026-11-20).
 * Fails closed: each earlier story is checked ALONE (so one story's parse error can neither hide another's tamper
 * finding nor trip the 128-story selection limit), and anything that stops a check from completing is a refusal naming
 * the story. Returns null when every earlier story checks clean, else `{ tamper, other, ids }`: the tamper findings
 * (with the story ids to re-baseline) and every other error.
 */
function earlierBaselineCheck(root, todo, stories) {
    let text;
    try { text = readTodoFile(path.resolve(root, todo)); } catch {
        return { tamper: [], other: [{ code: 'INVALID_TODO_FILE', message: 'the TODO cannot be read, so the earlier stories\' frozen files cannot be checked' }], ids: [] };
    }
    const selected = new Set(stories);
    const tamper = [];
    const other = [];
    for (const id of acVerify.storyIdsOf(text)) {
        if (selected.has(id) || !fs.existsSync(baselineFilePath(root, id))) continue;
        const checked = acVerify.check({ root, todo, stories: [id] });
        const errors = Array.isArray(checked.errors) ? checked.errors : [];
        if (!checked.ok && !errors.length) other.push({ code: 'error', story: id, message: `earlier story ${id}: ac-verify check failed with exit ${checked.exitCode}` });
        for (const e of errors) {
            if (e && TAMPER_CODES.has(e.code)) tamper.push({ ...e, story: e.story || id });
            else other.push({ ...e, story: (e && e.story) || id, message: `earlier story ${id}: ${e && e.message}` });
        }
    }
    if (!tamper.length && !other.length) return null;
    return { tamper, other, ids: [...new Set(tamper.map((e) => e.story))] };
}

/** Fold ac-verify's `{errors}` list into refusals under one rule. */
function foldAcErrors(result, rule, acResult, fix) {
    const items = Array.isArray(acResult && acResult.errors) ? acResult.errors : [];
    if (!items.length) refuse(result, rule, `ac-verify ${rule === 'ac-run' ? 'run' : 'check'} failed with exit ${acResult && acResult.exitCode}`, fix);
    for (const item of items.slice(0, MAX_LISTED)) refuse(result, rule, `${item.code || 'error'}: ${clip(item.message, 300)}`, fix);
    if (items.length > MAX_LISTED) refuse(result, rule, `${items.length - MAX_LISTED} more ac-verify errors not listed`, fix);
}

/** The gate-evidence refusals for `mode` against the base code hash: `{problems, receiptId}`. */
function gateEvidence(root, mode, baseHash) {
    if (mode === 'receipt') {
        const { receipt, problems } = receiptEvidence(root, baseHash);
        return { problems, receiptId: receipt && typeof receipt.id === 'string' ? receipt.id : null };
    }
    return { problems: summaryProblems(root), receiptId: null };
}

function sealImpl(opts) {
    const normal = normalizeOptions(opts, 'seal');
    if (normal.error) return invalid(normal.error, opts && opts.env);
    const { root, cwd, env, stories, todo } = normal.value;
    const result = newResult();
    // A refused seal leaves no seal, including one that was valid before.
    removeSeal(root);

    const loaded = loadGateConfig(root);
    if (loaded.error) {
        configRefusal(result, loaded);
        return conclude(result);
    }

    const docs = [];
    for (const raw of normal.value.docs) {
        const found = repoRelative(root, cwd, raw);
        const problem = found.ok ? docsEntryProblem(root, found.rel) : 'is not a path inside the repository';
        if (problem) refuse(result, 'docs-path', `--docs path ${JSON.stringify(clip(raw, 100))} ${problem}`, 'pass only document paths under docs/ inside the repository (relative or absolute); code files and directories are never excluded from the code hash');
        else docs.push(found.rel);
    }
    // The TODO is resolved once; every later read uses this real path, never the lexical argument again.
    const todoFound = todo === null ? null : repoRelative(root, cwd, todo);
    if (todoFound && !todoFound.ok) refuse(result, 'invalid-args', '--todo is not a path inside the repository', 'pass the TODO file that lives in this repository');
    if (result.errors.length) return conclude(result, { mode: loaded.mode });

    const mode = loaded.mode;
    const head = gateReceipt.headSha(root);
    if (!head) {
        refuse(result, mode, 'git HEAD cannot be read (a repository with no commit?)', 'make a first commit, run the gate, then seal');
        return conclude(result, { mode });
    }
    // The code is hashed BEFORE the gate evidence is judged and again after the bindings ran: a difference means code
    // changed in the window (a concurrent writer, a binding), and a seal over it would cover code the gate never saw.
    const before = codeHashes(root, docs);
    if (!before.ok) {
        refuse(result, mode, `the code hash cannot be computed: ${clip(before.reason, 200)}`, 'resolve the repository state the hash reports, then seal again');
        return conclude(result, { mode });
    }

    const evidence = gateEvidence(root, mode, before.base);
    if (mode === 'receipt' && evidence.problems.length) {
        refuse(result, 'receipt', `no valid gate receipt for this exact code: ${clip(evidence.problems.join('; '), 400)}`, `${gateFix(env)}, then seal again`);
    } else if (mode === 'summary') {
        for (const problem of evidence.problems) refuse(result, 'summary', problem, `${gateFix(env)}, then seal again (summary mode is lower assurance than receipts)`);
    }

    let ran = null;
    if (todoFound !== null) {
        // The freeze check comes first: a tampered `verify:` line must never be executed.
        const checked = acVerify.check({ root, todo: todoFound.real, stories });
        const earlier = checked.ok ? earlierBaselineCheck(root, todoFound.real, stories) : null;
        if (!checked.ok) foldAcErrors(result, 'ac-check', checked, 'restore the frozen check files and verify: lines, or re-baseline with ac-verify.js freeze --reason "<why>", then seal again');
        else if (earlier) {
            if (earlier.tamper.length) foldAcErrors(result, 'ac-check', { errors: earlier.tamper }, `an earlier story's frozen file changed in this wave: restore it, or re-baseline that story with ac-verify.js freeze --stories ${earlier.ids.join(',')} --reason "<why>" (then unfreeze), then seal again`);
            if (earlier.other.length) foldAcErrors(result, 'ac-check', { errors: earlier.other }, 'an earlier story that has a freeze baseline cannot be checked (see the story named above): repair its verify: line or baseline, or re-baseline it with ac-verify.js freeze --reason "<why>", then seal again');
        } else {
            ran = acVerify.run({ root, todo: todoFound.real, stories, env });
            if (!ran.ok) {
                const lines = [];
                for (const report of Array.isArray(ran.stories) ? ran.stories : []) {
                    for (const record of Array.isArray(report.records) ? report.records : []) {
                        if (record.status !== 'ran' || record.met !== true) lines.push(`${report.id} (TODO line ${record.acLine}): ${record.status}${record.status === 'ran' ? `, exit ${record.exit}, expected ${record.expectedExit}` : ''}`);
                    }
                }
                if ((ran.errors || []).length || !lines.length) foldAcErrors(result, 'ac-run', ran, 'fix the selection or the TODO so ac-verify run can start');
                for (const line of lines.slice(0, MAX_LISTED)) refuse(result, 'ac-run', `a verify: binding is not met: ${line}`, 'make the binding pass (or correct its command), then run the gate and seal again');
                if (lines.length > MAX_LISTED) refuse(result, 'ac-run', `${lines.length - MAX_LISTED} more unmet bindings not listed`, 'make the bindings pass, then seal again');
            }
            result.stories = (Array.isArray(ran.stories) ? ran.stories : []).map((report) => ({ id: report.id, bindings: report.bindings, manual: report.manual, status: report.status }));
        }
    }
    if (result.errors.length) return conclude(result, { mode });

    const after = codeHashes(root, docs);
    if (!after.ok) {
        refuse(result, mode, `the code hash cannot be computed: ${clip(after.reason, 200)}`, 'resolve the repository state the hash reports, then seal again');
        return conclude(result, { mode });
    }
    if (after.base !== before.base || after.sealed !== before.sealed) {
        refuse(result, 'tree-changed', 'the code changed while the seal ran (after the gate evidence was judged), so the evidence does not cover the code that would be sealed', `${gateFix(env)} on the final code with no other writer active, then seal again`);
        return conclude(result, { mode });
    }
    // The evidence is judged again at the last moment: the receipt the seal names must still be the one on disk.
    const again = gateEvidence(root, mode, after.base);
    if (again.problems.length || again.receiptId !== evidence.receiptId) {
        refuse(result, mode, 'the gate evidence changed while the seal ran', `${gateFix(env)}, then seal again`);
        return conclude(result, { mode });
    }
    // Judge the records the run just wrote, not only its exit: they are what the seal commits to.
    if (ran) {
        const judged = checkRecords(root, ran.stories.map((report) => ({ id: report.id, bindings: report.bindings })), after.base);
        for (const error of judged.errors) refuse(result, 'ac-run', error.message, 'run the gate and seal again; the records must be produced by this seal run');
        if (result.errors.length) return conclude(result, { mode });
    }
    const seal = {
        head, receiptId: evidence.receiptId, mode, codeHash: after.sealed, gateCodeHash: after.base,
        recordsHash: recordsDigest(root, stories), docs, todo: todoFound ? todoFound.rel : null, stories: [...stories].sort(), sealedAt: new Date().toISOString(),
    };
    writeSeal(root, seal);
    return conclude(result, { mode, seal });
}

// ── verify ──────────────────────────────────────────────────────────

/**
 * The plan's lines as a reader sees them, with text for the lines that are prose: a line inside a fenced code block is
 * null, and text inside an HTML comment is removed (a comment is not rendered, so it is not a review entry). Indented
 * code blocks are handled by the heading pattern (it allows at most three leading spaces).
 */
function unfencedLines(text) {
    const out = [];
    let fence = null;
    let inComment = false;
    for (const raw of text.split(/\r?\n/)) {
        if (fence) {
            const closing = raw.match(/^\s*(`{3,}|~{3,})(.*)$/);
            if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length && !closing[2].trim()) fence = null;
            out.push(null);
            continue;
        }
        let line = '';
        let rest = raw;
        for (;;) {
            if (inComment) {
                const end = rest.indexOf('-->');
                if (end === -1) break;
                rest = rest.slice(end + 3);
                inComment = false;
            } else {
                const start = rest.indexOf('<!--');
                if (start === -1) { line += rest; break; }
                line += rest.slice(0, start);
                rest = rest.slice(start + 4);
                inComment = true;
            }
        }
        const delimiter = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
        if (delimiter) { fence = { character: delimiter[1][0], length: delimiter[1].length }; out.push(null); continue; }
        out.push(line);
    }
    return out;
}

/**
 * Why the plan has no usable `**Review — Wave N**` entry (any of the three dashes), or null when it has one: the heading
 * followed directly by a bullet list that holds each of the five labelled bullets (Reviewed, Fixed now, Deferred,
 * Skipped or light, Risk call) once, filled (not empty, not a `{placeholder}`). Extra bullets in the list are allowed
 * (first adopter run, 2026-11-20: a sixth bullet made a complete entry fail with no reason given).
 */
function reviewEntryProblem(text, wave) {
    // At most three leading spaces (a list-item marker is allowed): four or more is an indented code block.
    const heading = new RegExp(`^ {0,3}(?:[-*+]\\s+)?\\*\\*Review\\s+[—–-]\\s+Wave\\s+${wave}\\*\\*\\s*$`);
    const lines = unfencedLines(text);
    let problem = 'there is no such heading';
    for (let at = 0; at < lines.length; at++) {
        if (lines[at] === null || !heading.test(lines[at])) continue;
        const found = new Map();
        for (let next = at + 1; next < lines.length; next++) {
            const line = lines[next];
            const bullet = line === null ? null : line.match(/^\s*[-*+]\s+(.*)$/);
            if (!bullet) break;
            const labelled = bullet[1].match(/^([^:]+):\s*(.*)$/);
            if (!labelled) continue;
            const label = labelled[1].trim().toLowerCase();
            if (REVIEW_LABELS.includes(label) && !found.has(label)) found.set(label, labelled[2].trim());
        }
        const missing = REVIEW_LABELS.filter(label => !found.has(label));
        const empty = REVIEW_LABELS.filter(label => found.has(label) && (!found.get(label) || /^\{[^{}]*\}$/.test(found.get(label))));
        if (!missing.length && !empty.length) return null;
        problem = [missing.length ? `missing ${missing.join(', ')}` : '', empty.length ? `empty or a placeholder: ${empty.join(', ')}` : ''].filter(Boolean).join('; ');
    }
    return problem;
}

const hasReviewEntry = (text, wave) => reviewEntryProblem(text, wave) === null;

/** Write one audited bypass event against the verified repository root; null when it could not be written. */
function recordBypass(root, rule, reason, context) {
    if (!isRepoRoot(root)) return null;
    const head = gateReceipt.headSha(root);
    return emitGuardrailHitAt(root, {
        decision: 'bypass', rule, source: 'ship-check', reason, kind: context.kind, wave: context.wave, stories: context.stories, ...(head ? { head } : {}),
    });
}

const EVENT_FIX = 'make docs/.output/.state/telemetry/guardrail-events.jsonl a regular, writable file inside the repository (not a symlink or a directory), then run again';

function verifyImpl(opts) {
    const normal = normalizeOptions(opts, 'verify');
    if (normal.error) return invalid(normal.error, opts && opts.env);
    const { root, cwd, env, stories, todo, kind, plan, wave, skip } = normal.value;
    const result = newResult();

    const loaded = loadGateConfig(root);
    if (loaded.error) {
        configRefusal(result, loaded);
        return conclude(result);
    }
    // `enabled: false` (read from the committed config) is an audited bypass like --skip: it skips the seal-based
    // conditions only, and the completion check and the review entry are still required.
    const disabled = !loaded.enabled;
    if (disabled) result.notices.push({ rule: 'disabled', message: 'shipCheck.enabled is false in the committed gate config: the seal-based ship checks are disabled for this project (audited bypass); the completion check and the review entry still apply' });

    // The TODO is resolved once; every later read uses the real path.
    const todoFound = todo === null ? null : repoRelative(root, cwd, todo);
    if (todoFound && !todoFound.ok) refuse(result, 'invalid-args', '--todo is not a path inside the repository', 'pass the TODO file that lives in this repository');
    const planFound = plan === null ? null : repoRelative(root, cwd, plan);
    if (planFound && !planFound.ok) refuse(result, 'invalid-args', '--plan is not a path inside the repository', 'pass the run plan that lives in this repository');
    else if (planFound && !planFound.rel.startsWith(PLAN_DIR)) refuse(result, 'invalid-args', `--plan must be a run plan under ${PLAN_DIR}`, `pass the run plan from ${PLAN_DIR}`);
    if (result.errors.length) return conclude(result);

    let sealed = null;
    let specs = [];

    // Completion (never skipped when a TODO is given).
    let parsed = null;
    if (todoFound === null) {
        result.skipped.push({ rule: 'no-todo', message: 'no --todo (ad-hoc task): the completion check and the record check are skipped' });
    } else {
        try {
            parsed = verifyTodoCompletion(readTodoFile(todoFound.real), { storyIds: stories });
        } catch {
            refuse(result, 'completion', 'the TODO cannot be read as an ordinary bounded file', 'pass an existing TODO file');
        }
        if (parsed) {
            for (const error of parsed.errors.slice(0, MAX_LISTED)) {
                refuse(result, 'completion', `${error.code}${error.storyId ? ` ${error.storyId}` : ''}${error.line ? ` (TODO line ${error.line})` : ''}: ${clip(error.message, 200)}`,
                    'finish or explicitly dispose of the listed work, mark each story [x], then verify again');
            }
            if (parsed.errors.length > MAX_LISTED) refuse(result, 'completion', `${parsed.errors.length - MAX_LISTED} more completion errors not listed`, 'finish the stories, then verify again');
            specs = parsed.stories.map((story) => {
                const bindings = story.criteria.filter((criterion) => criterion.verify).length;
                return { id: story.id, bindings, manual: story.criteria.length - bindings };
            });
        }
    }

    // Review entry (wave only; never skipped by --skip or by enabled: false).
    if (kind === 'wave') {
        const read = readBounded(planFound.real, PLAN_MAX_BYTES);
        if (read.state !== 'ok') refuse(result, 'review', `the plan cannot be read${read.reason ? ` (${read.reason})` : ' (missing)'}`, 'pass the run plan that holds the wave log');
        else {
            const problem = reviewEntryProblem(read.bytes.toString('utf8'), wave);
            if (problem) refuse(result, 'review', `the plan has no filled "**Review — Wave ${wave}**" entry with the five bullets Reviewed, Fixed now, Deferred, Skipped or light and Risk call (${problem}); other bullets in the entry are allowed`,
                `add the review entry for wave ${wave} to the plan's wave log (see review-cadence.md), outside any code fence, HTML comment or indented block`);
        }
    }

    let mode = loaded.mode;
    const unverified = () => specs.map((spec) => ({ id: spec.id, bindings: spec.bindings, manual: spec.manual, status: spec.bindings ? 'unverified' : 'no-bindings' }));
    const bypassing = skip !== null || disabled;

    if (!bypassing) {
        const read = readSeal(root);
        if (read.missing) refuse(result, 'no-seal', 'there is no ship seal', `run ${sealFix(env)} after the last code edit`);
        else if (read.bad) refuse(result, 'bad-seal', read.bad, `run ${sealFix(env)} to write a fresh seal`);
        else sealed = read.seal;
    }

    if (sealed) {
        mode = sealed.mode;
        const reseal = `run the gate (${gateFix(env)}) and ${sealFix(env)} again`;
        if (sealed.head !== gateReceipt.headSha(root)) refuse(result, 'head-mismatch', 'HEAD moved since the seal was written', reseal);

        const docsProblem = sealed.docs.map((rel) => ({ rel, problem: docsEntryProblem(root, rel) })).find((entry) => entry.problem);
        if (docsProblem) refuse(result, 'docs-path', `the sealed docs path ${JSON.stringify(clip(docsProblem.rel, 100))} ${docsProblem.problem}`, reseal);
        if (sealed.docs.length === 0 && sealed.gateCodeHash !== sealed.codeHash) refuse(result, 'bad-seal', 'the seal names no docs but its two code hashes differ', `run ${sealFix(env)} to write a fresh seal`);
        const hashed = docsProblem ? { ok: false, reason: 'the sealed docs list is not valid' } : codeHashes(root, sealed.docs);
        if (!hashed.ok) refuse(result, 'code-drift', `the code hash cannot be computed: ${clip(hashed.reason, 200)}`, reseal);
        else if (hashed.sealed !== sealed.codeHash) refuse(result, 'code-drift', 'the code changed after the seal', `re-gate and re-seal: ${reseal}`);

        // The seal belongs to one TODO: another file with the same verify: lines and every story ticked must not pass.
        const todoNow = todoFound ? todoFound.rel : null;
        if (todoNow !== sealed.todo) {
            refuse(result, 'todo-mismatch', `the seal was written for ${sealed.todo === null ? 'no TODO' : `the TODO ${JSON.stringify(clip(sealed.todo, 120))}`} but this run names ${todoNow === null ? 'none' : JSON.stringify(clip(todoNow, 120))}`,
                `verify with the TODO the seal was made for, or seal again with this one: ${sealFix(env)}`);
        }

        // Gate evidence, re-checked now: the receipt the seal names must still be the one on disk, valid for this code.
        if (loaded.mode === 'receipt' && sealed.mode !== 'receipt') {
            refuse(result, 'receipt', 'the seal was taken in summary mode but this project requires receipts', `${gateFix(env)}, then ${sealFix(env)}`);
        } else if (sealed.mode === 'receipt') {
            const { receipt, problems } = receiptEvidence(root, sealed.gateCodeHash);
            if (receipt && receipt.id !== sealed.receiptId) refuse(result, 'receipt', 'the gate receipt on disk is not the one the seal names', `${gateFix(env)}, then ${sealFix(env)}`);
            else if (problems.length) refuse(result, 'receipt', `the gate receipt the seal names no longer holds: ${clip(problems.join('; '), 400)}`, `${gateFix(env)}, then ${sealFix(env)}`);
        } else {
            for (const problem of summaryProblems(root)) refuse(result, 'summary', problem, `${gateFix(env)}, then ${sealFix(env)} (summary mode is lower assurance than receipts)`);
        }

        // The hash judges working-tree bytes but a commit takes the index: any code path where the two differ is refused.
        const unstaged = unstagedCodePaths(root, sealed.docs);
        if (unstaged === null) refuse(result, 'unstaged-code', 'git cannot compare the index with the working tree', 'make sure git can read the repository, then verify again');
        else if (unstaged.length) {
            refuse(result, 'unstaged-code', `the index differs from the working tree for code the seal covers: ${unstaged.slice(0, 5).map((rel) => JSON.stringify(clip(rel, 80))).join(', ')}${unstaged.length > 5 ? ` and ${unstaged.length - 5} more` : ''}`,
                'stage the final content of those files (or restore them) so the commit takes exactly the sealed code, then verify again');
        }

        if (todoFound !== null) {
            const checked = acVerify.check({ root, todo: todoFound.real, stories });
            if (!checked.ok) foldAcErrors(result, 'ac-check', checked, 'restore the frozen check files and verify: lines, or re-baseline with ac-verify.js freeze --reason "<why>", then re-gate and seal again');
            const sealedSet = sealed.stories.join(',');
            const verifySet = [...stories].sort().join(',');
            if (sealedSet !== verifySet) {
                // Different story sets hash different files, so a records-drift here would wrongly read as tampering.
                refuse(result, 'stories-mismatch', `the seal named ${sealedSet || 'no stories'} but this commit names ${verifySet}`,
                    `seal again with --stories ${verifySet} (the seal already checks earlier stories' baselines), or commit with the seal's stories`);
            } else if (recordsDigest(root, stories) !== sealed.recordsHash) refuse(result, 'records-drift', 'the ac-verify records or freeze baselines changed since the seal', reseal);
            const judged = checkRecords(root, specs, sealed.gateCodeHash);
            for (const error of judged.errors) refuse(result, error.rule, error.message, reseal);
            result.stories = specs.map((spec) => ({ id: spec.id, bindings: spec.bindings, manual: spec.manual, status: !spec.bindings ? 'no-bindings' : judged.failed.has(spec.id) ? 'failed' : 'passed' }));
        }
    } else {
        result.stories = unverified();
    }

    if (bypassing && result.errors.length === 0) {
        // No bypass is silent: each audit event must exist before the bypass is honoured.
        const context = { kind, wave, stories };
        if (disabled) {
            const event = recordBypass(root, 'ship-check-disabled', 'shipCheck.enabled is false in the committed gate config', context);
            if (!event) refuse(result, 'disabled', 'the audited bypass event for shipCheck.enabled false could not be written, so the check is refused', EVENT_FIX);
        }
        if (skip !== null && result.errors.length === 0) {
            const event = recordBypass(root, 'ship-check-skip', skip, context);
            if (!event) refuse(result, 'skip', 'the audited bypass event could not be written, so the skip is refused', EVENT_FIX);
            else result.skipped.push({ rule: 'skip', message: 'seal, head, code, records, freeze, receipt and index checks skipped by --skip (audited)', reason: skip });
        }
    }
    return conclude(result, { mode, ...(sealed ? { seal: sealed } : {}) });
}

// ── exports and CLI ─────────────────────────────────────────────────

function guarded(fn, opts) {
    try { return fn(opts); } catch (error) { return exceptionResult(error); }
}

/** Run the ac-verify checks and write the ship seal. Never throws. */
const seal = (opts) => guarded(sealImpl, opts);
/** Judge a wave or task against its seal. Never throws. */
const verify = (opts) => guarded(verifyImpl, opts);

const USAGE = 'Usage: ship-check.js seal [--docs a,b] [--todo T --stories A,B] | verify --kind wave|task [--plan P] [--wave N] [--todo T] [--stories A,B] [--skip "<reason>"]';
const FLAGS = {
    seal: ['--docs', '--todo', '--stories'],
    verify: ['--kind', '--plan', '--wave', '--todo', '--stories', '--skip'],
};

/** Parse argv into verb options: `{error}` or `{verb, opts}`. Every flag takes one value and appears once. */
function parseArgs(argv) {
    const [verb, ...rest] = argv;
    if (verb !== 'seal' && verb !== 'verify') return { error: `unknown or missing verb. ${USAGE}` };
    const values = {};
    for (let i = 0; i < rest.length; i += 2) {
        const flag = rest[i];
        const value = rest[i + 1];
        if (!FLAGS[verb].includes(flag) || Object.hasOwn(values, flag)) return { error: `unexpected argument ${JSON.stringify(clip(flag, 40))}. ${USAGE}` };
        if (typeof value !== 'string' || value.startsWith('--')) return { error: `${flag} needs a value. ${USAGE}` };
        values[flag] = value;
    }
    const opts = {};
    if (values['--todo'] !== undefined) opts.todo = values['--todo'];
    if (values['--stories'] !== undefined) opts.stories = values['--stories'].split(',');
    if (verb === 'seal') {
        if (values['--docs'] !== undefined) opts.docs = values['--docs'].split(',');
        return { verb, opts };
    }
    if (values['--kind'] !== undefined) opts.kind = values['--kind'];
    if (values['--plan'] !== undefined) opts.plan = values['--plan'];
    if (values['--wave'] !== undefined) {
        if (!/^[1-9]\d{0,8}$/.test(values['--wave'])) return { error: `--wave must be a positive integer. ${USAGE}` };
        opts.wave = Number(values['--wave']);
    }
    if (values['--skip'] !== undefined) opts.skip = values['--skip'];
    return { verb, opts };
}

function emit(result) {
    for (const error of result.errors) process.stderr.write(`[ship-check] refusing: ${error.message}. Fix: ${error.fix}\n`);
    for (const entry of result.skipped) process.stderr.write(`[ship-check] skipped (${entry.rule}): ${entry.message}${entry.reason ? ` Reason: ${entry.reason}` : ''}\n`);
    for (const entry of result.notices) process.stderr.write(`[ship-check] notice (${entry.rule}): ${entry.message}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

/** Print the missing-backstop warning for `verify` (see BACKSTOP WARNING). Never changes the verdict or the exit code. */
function warnHooksMissing(root, env) {
    try {
        const lines = require('./git-hooks').backstopWarning(root, { who: 'ship-check', coreDir: `${runtimeDir(env)}/core` });
        if (lines) for (const line of lines) process.stderr.write(`${line}\n`);
    } catch (error) {
        process.stderr.write(`[ship-check] WARNING: could not check whether the managed git hooks are active (${String(error && error.message ? error.message : error).split('\n')[0]}). Treat the secret and force-push backstop as missing.\n`);
    }
}

function main(argv = process.argv.slice(2)) {
    let result;
    try {
        const parsed = parseArgs(argv);
        if (parsed.error) result = invalid(parsed.error, process.env);
        else {
            const root = path.resolve(resolveWorktreeRoot(process.cwd()));
            if (parsed.verb === 'verify') warnHooksMissing(root, process.env);
            const run = parsed.verb === 'seal' ? seal : verify;
            result = run({ ...parsed.opts, root, cwd: process.cwd(), env: process.env });
        }
    } catch (error) {
        result = exceptionResult(error);
    }
    try { emit(result); } catch { /* a closed stdout must not turn a refusal into a pass: the exit code carries it */ }
    return result.exitCode;
}

/**
 * After commit.js has staged the wave (and checked the staged set equals the working tree), confirm the code is still
 * the sealed code: closes the window between `verify` and `git add`. `{ok:true}` when it matches, or when the committed
 * config disables the check; `{ok:false, reason}` otherwise. Never throws.
 */
function stagedMatchesSeal(root) {
    try {
        const loaded = loadGateConfig(root);
        if (loaded.error) return { ok: false, reason: loaded.error };
        if (!loaded.enabled) return { ok: true, disabled: true };
        const sealed = readSeal(root);
        if (sealed.missing) return { ok: false, reason: 'the seal disappeared after the ship check' };
        if (sealed.bad) return { ok: false, reason: sealed.bad };
        const now = gateReceipt.codeTreeHash(root, { extraExclude: sealed.seal ? sealed.seal.docs : sealed.docs });
        const codeHash = sealed.seal ? sealed.seal.codeHash : sealed.codeHash;
        if (!now.ok) return { ok: false, reason: now.reason };
        if (now.hash !== codeHash) return { ok: false, reason: 'the code changed between the ship check and staging' };
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: error && error.message ? error.message : String(error) };
    }
}

module.exports = { seal, verify, main, stagedMatchesSeal, warnHooksMissing };
if (require.main === module) process.exitCode = main();
