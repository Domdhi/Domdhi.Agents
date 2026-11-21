#!/usr/bin/env node
/**
 * gate-signal.js — classify the last local gate result (SF-3.4, the "gate signal" seam).
 *
 * Prints JSON `{state, signature, reason, ts, failureNames[]}` and ALWAYS exits 0, like
 * feedback-digest.js: a detector that can crash is a detector that reports nothing.
 *
 * Two more CLI modes serve `/listen gate` (SF-3.5); the default output and its exit-0 contract are unchanged:
 *   --only-if-red        exit 0; the signal above only when the state is red and its signature is not the live one in
 *                        docs/.output/.state/telemetry/listen-gate-seen.json, else `{quiet: true, state, signature, reason}`.
 *                        A seen mark is live only until the failure ledger (gate-failures.jsonl) records a passing run newer
 *                        than the mark's `markedAt`: the same red that comes back after a green is reported again
 *   --mark-seen <sig>    exit 0 and `{marked: true, signature, changed}`; exit 2 and `{marked: false, error}` when the
 *                        signature is not 16 lowercase hex characters or the seen-file path is refused. Re-marking a
 *                        signature whose mark expired rewrites it with a fresh `markedAt` (`changed: true`)
 *
 *   green    overall true, not killed, not in progress, a test leg that RAN tests and passed, a
 *            whole-suite run (not `changed only`), the summary at least as new as the last commit,
 *            and, when the project keeps gate receipts, a receipt that matches the working tree
 *   red      overall false, not killed, and the summary is newer than the last commit
 *   killed   the run was stopped from outside, or a leg hit its time limit: not a verdict on the code
 *   stale    the summary is older than the last commit, or the tree/HEAD/gate no longer match the
 *            gate receipt, so it says nothing about the tree as it is now
 *   unknown  no usable summary, an unfinished or inconsistent one, no way to date it, or a partial
 *            run (zero tests, change-scoped) that cannot vouch for the project
 *
 * Freshness is the summary's own `timestamp` against the last commit's committer time (git
 * records whole seconds, so a gate run in the same second as a later commit reads as fresh).
 * The receipt (`verifyReceiptForRoot`) closes the other hole: an edit AFTER a green gate. A project
 * with no receipt file at all does not use receipts and keeps the freshness-only rule, said in `reason`.
 * Anything that cannot be dated, and any summary `readSummary` rejects, is never green or red.
 *
 * Root: `CLAUDE_PROJECT_DIR`, else the checkout this script lives in. That is the root gate.js
 * writes the summary under, so the writer and this reader always agree.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readSummary } = require('./_lib/gate-summary');
const { verifyReceiptForRoot, receiptPath } = require('./_lib/gate-receipt');
const { gitSafe } = require('./_lib/git');
const { getTelemetryDir } = require('./_lib/telemetry-paths');
const { assertNoSymlinkedAncestor } = require('./_lib/fs-safe');

const legFailed = leg => !!(leg && typeof leg === 'object' && leg.succeeded === false);
const namesOf = leg => (leg && typeof leg === 'object' && Array.isArray(leg.failureNames) ? leg.failureNames.filter(name => typeof name === 'string').sort() : []);

/**
 * Hash of everything that makes two red results "the same failure"; times and counts are left out.
 * The test leg's names, the mode, and a failed flag per other leg (build, lint, visual, E2E), plus the
 * visual leg's own failing names so two different visual failures are not one.
 */
function signatureOf(summary, failureNames) { // failureNames arrive sorted from classify
    const material = JSON.stringify([
        failureNames, summary.mode || null,
        legFailed(summary.build), legFailed(summary.lint),
        legFailed(summary.visual), namesOf(summary.visual), legFailed(summary.e2e),
    ]);
    return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * True when the run was stopped from outside: a top-level marker, a leg's `killedBy`, or ANY leg that
 * hit its time limit (`timedOut` on the test, visual, build, lint or E2E leg).
 */
function wasKilled(summary) {
    const legs = [summary.build, summary.test, summary.lint, summary.visual, summary.e2e];
    return !!summary.killed || legs.some(leg => leg && typeof leg === 'object' && (leg.killedBy || leg.timedOut === true));
}

/**
 * The legs that actually failed, e.g. `test leg` or `build and lint legs`. The summary's `mode` is the header text of the
 * run ("BUILD + TEST") and says what was attempted, not what failed, so it is never used here.
 */
function failedLegsText(summary) {
    const failed = [['build', summary.build], ['test', summary.test], ['lint', summary.lint], ['visual', summary.visual], ['e2e', summary.e2e]]
        .filter(([, leg]) => legFailed(leg)).map(([name]) => name);
    if (!failed.length) return 'no failing leg is recorded in the summary';
    return `${failed.join(' and ')} ${failed.length === 1 ? 'leg' : 'legs'}`;
}

function signal(state, reason, summary, failureNames = [], signature = '') {
    return { state, signature, reason, ts: summary && typeof summary.timestamp === 'string' ? summary.timestamp : null, failureNames };
}

/**
 * Pure classification.
 *
 * @param {object|null} summary      what `readSummary` returned (null = missing, corrupt, non-boolean overall)
 * @param {number|null} lastCommitMs last commit's committer time in epoch ms, null when unavailable
 * @returns {{state: string, signature: string, reason: string, ts: string|null, failureNames: string[]}}
 */
function classify(summary, lastCommitMs) {
    if (!summary || typeof summary !== 'object') return signal('unknown', 'no usable gate summary (missing, corrupt, or overall is not a boolean)', null);

    const test = summary.test && typeof summary.test === 'object' ? summary.test : null;
    const failureNames = test && Array.isArray(test.failureNames) ? test.failureNames.filter(name => typeof name === 'string').sort() : [];
    const out = (state, reason, signature = '') => signal(state, reason, summary, failureNames, signature);

    const summaryMs = Date.parse(summary.timestamp);
    if (Number.isNaN(summaryMs)) return out('unknown', 'the gate summary has no parseable timestamp');
    if (typeof lastCommitMs !== 'number' || Number.isNaN(lastCommitMs)) return out('unknown', 'the last commit time is unavailable, so freshness cannot be judged');

    // A pass at the commit's own instant still counts; a failure needs to be strictly newer to be red.
    const fresh = summary.overall === false ? summaryMs > lastCommitMs : summaryMs >= lastCommitMs;
    if (!fresh) {
        return out('stale', 'the gate summary is not newer than the last commit; re-run the gate');
    }
    if (wasKilled(summary)) return out('killed', `the gate run was killed or timed out (${summary.killed || 'leg'}); not a verdict on the code`);
    if (summary.inProgress) return out('unknown', 'a gate run is in progress or was cut off before it finished');
    if (typeof summary.error === 'string') return out('unknown', `the gate did not run: ${summary.error}`);

    if (summary.overall === false) return out('red', `the gate failed (${failedLegsText(summary)})`, signatureOf(summary, failureNames));

    if (!test) return out('unknown', 'the gate passed without a test leg (build-only or lint-only), which is not a green gate');
    if (test.succeeded !== true) return out('unknown', 'the gate reports overall passed but the test leg did not succeed');
    // A change-scoped run (`--changed`) and a run that collected no tests vouch for nothing about the project.
    if (typeof summary.mode === 'string' && /changed only/i.test(summary.mode)) return out('unknown', 'the gate ran only the tests for changed files; that is not a green project');
    if (!(typeof test.total === 'number' && test.total > 0)) return out('unknown', 'the gate passed but its test leg ran no tests; that is not a green project');
    return out('green', 'the gate passed with a test leg, at or after the last commit');
}

/** Last commit's committer time in epoch ms, or null (not a git repo, no commits, missing root). */
function lastCommitMs(root) {
    const seconds = Number(gitSafe(['log', '-1', '--format=%ct'], { cwd: root }));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** Receipt checks that mean the tree (or the gate) moved on since the receipt was written. */
const MOVED_ON_CHECKS = new Set(['treeHash', 'head', 'engine', 'config']);

/**
 * Apply the gate receipt to a result that would be green. The receipt matching the tree keeps it green;
 * no receipt file at all means the project does not use receipts and keeps the freshness-only rule; a
 * receipt that no longer matches the tree, HEAD or the gate makes it `stale`; any other receipt
 * problem, or a check that could not run, is `unknown`. Never leaves a result green on a doubt.
 */
function applyReceipt(result, root) {
    let verdict;
    try {
        verdict = verifyReceiptForRoot({ root });
    } catch (err) {
        return { ...result, state: 'unknown', reason: `the gate receipt could not be checked (${err && err.message ? err.message : err}), so the tree match is unconfirmed` };
    }
    if (verdict.ok) return { ...result, reason: `${result.reason}; the gate receipt matches the tree` };
    if (verdict.receipt === null) {
        // `readReceipt` reads a corrupt file as no receipt; a file that is there but unusable is not "no receipts".
        if (fs.existsSync(receiptPath(root))) return { ...result, state: 'unknown', reason: 'the gate receipt file exists but is unreadable, so the tree match is unconfirmed' };
        return { ...result, reason: `${result.reason}; no gate receipt exists (this project does not use receipts), so the tree match is not verified` };
    }
    const checks = verdict.reasons.map(r => r.check);
    if (checks.some(check => MOVED_ON_CHECKS.has(check))) {
        return { ...result, state: 'stale', reason: `the working tree no longer matches the last gate receipt (${[...new Set(checks)].join(', ')}); re-run the gate` };
    }
    return { ...result, state: 'unknown', reason: `the gate receipt does not vouch for this result (${[...new Set(checks)].join(', ') || 'unverified'})` };
}

/** Read and classify `root`'s last gate result. Never throws. */
function readGateSignal(root) {
    try {
        const result = classify(readSummary(root), lastCommitMs(root));
        return result.state === 'green' ? applyReceipt(result, root) : result;
    } catch (err) {
        return signal('unknown', `could not classify the gate result: ${err && err.message ? err.message : err}`, null);
    }
}

// ── SF-3.5: the seen-signature state behind `/listen gate --only-if-red` ─────────────────────────
//
// `listen-gate-seen.json` holds `{signature, markedAt}`: the last red signature `/listen` recorded. The
// dedupe is mechanical (this file's CLI modes), never an agent's judgement:
//   --only-if-red        prints the full signal only for a red signature with no live seen mark; otherwise `{quiet: true, ...}`
//   --mark-seen <sig>    records a signature (atomic, regular file only, no symlink followed)
// A mark EXPIRES when the failure ledger holds a non-killed passing row newer than `markedAt`: the failure was
// fixed at some point, so the same signature coming back is a regression to report, not a repeat to hide.
// `--only-if-red` stays read-only; expiry is computed on read, nothing is cleared. A focused (one-leg) pass
// also expires a mark: at worst one extra report, never a hidden regression. A mark whose `markedAt` cannot
// be parsed never suppresses (a damaged file reports again).

const SEEN_FILE = 'listen-gate-seen.json';
const SIGNATURE_RE = /^[0-9a-f]{16}$/;
const MAX_SEEN_BYTES = 64 * 1024; // the file is under 100 bytes; the cap only bounds a hostile one

const seenFilePath = root => path.join(getTelemetryDir(root), SEEN_FILE);

/**
 * The seen file's `{signature, markedAtMs}` (`markedAtMs` null when `markedAt` is missing or unparseable),
 * or null. Never throws and never follows a link: a missing, oversized, symlinked, non-regular, corrupt or
 * malformed file reads as "nothing seen", so a red gate is reported again rather than hidden.
 */
function readSeenMark(root) {
    let fd;
    try {
        const file = seenFilePath(root);
        if (!fs.lstatSync(file).isFile()) return null; // symlink, directory, FIFO: refused before any open
        // O_NONBLOCK: a FIFO swapped in after the lstat must not block the open forever.
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > MAX_SEEN_BYTES) return null;
        const parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.signature !== 'string') return null;
        const at = typeof parsed.markedAt === 'string' ? Date.parse(parsed.markedAt) : NaN;
        return { signature: parsed.signature, markedAtMs: Number.isNaN(at) ? null : at };
    } catch {
        return null;
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing to release */ } }
    }
}

/** The signature in the seen file (live or expired), or null. */
function readSeenSignature(root) {
    const mark = readSeenMark(root);
    return mark ? mark.signature : null;
}

/**
 * True when the failure ledger holds a non-killed passing row newer than `sinceMs`. Never throws: an
 * unreadable ledger reads as "no pass seen" (the mark stays live; the ledger is advisory).
 */
function passedSince(root, sinceMs) {
    try {
        const rows = require('./_lib/failure-ledger').readLedger({ root });
        return rows.some(r => {
            if (!r || r.passed !== true || (r.killed != null && r.killed !== false && r.killed !== '')) return false;
            const at = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
            return !Number.isNaN(at) && at > sinceMs;
        });
    } catch {
        return false;
    }
}

/** True when `mark` should suppress a red with its signature: a parseable `markedAt` and no pass since. */
function isLive(root, mark) {
    return !!mark && mark.markedAtMs !== null && !passedSince(root, mark.markedAtMs);
}

/**
 * `--only-if-red`: the full signal when it is red and its signature is not the seen one, else a quiet
 * result that carries the real state. Read-only.
 */
function onlyIfRed(root) {
    const result = readGateSignal(root);
    if (result.state !== 'red') {
        return { quiet: true, state: result.state, signature: result.signature, reason: `the gate is not red (${result.state}): ${result.reason}` };
    }
    const mark = readSeenMark(root);
    if (mark && mark.signature === result.signature && isLive(root, mark)) {
        return { quiet: true, state: result.state, signature: result.signature, reason: 'this failure signature was already recorded in listen-gate-seen.json' };
    }
    return result;
}

/**
 * `--mark-seen`: record `signature`. Throws on a bad signature or a refused path (symlinked ancestor,
 * a leaf that is a symlink, directory or other non-regular file); the caller turns that into exit 2.
 * The write goes to an exclusive, no-follow temp file in the same folder and is renamed into place, so a
 * reader sees the old file or the new one, never half of one.
 * @returns {{marked: true, signature: string, changed: boolean}}
 */
function markSeen(root, signature) {
    if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) {
        throw new Error('the signature must be 16 lowercase hex characters (the signature field of the gate signal)');
    }
    const file = seenFilePath(root);
    const dir = path.dirname(file);
    assertNoSymlinkedAncestor(file, root); // before mkdir, so a symlinked ancestor is never created through
    fs.mkdirSync(dir, { recursive: true });

    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) throw new Error(`refusing to replace ${file}: it is not a regular file`);
    // Same signature and the mark is still live: nothing to write. An expired mark (a pass landed since) is
    // rewritten with a fresh markedAt, or the next poll would read it as expired again and report forever.
    const current = existing ? readSeenMark(root) : null;
    if (current && current.signature === signature && isLive(root, current)) return { marked: true, signature, changed: false };

    const tmp = path.join(dir, `${SEEN_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(tmp, flags, 0o644);
    try {
        try {
            fs.writeFileSync(fd, JSON.stringify({ signature, markedAt: new Date().toISOString() }, null, 2) + '\n');
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
    } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
    }
    return { marked: true, signature, changed: true };
}

if (require.main === module) {
    // The root gate.js writes the summary under. exitCode, not exit(): a large failureNames list written to
    // an asynchronous pipe must flush before the process ends.
    const root = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
    const args = process.argv.slice(2);
    const markAt = args.indexOf('--mark-seen');
    let output;
    process.exitCode = 0; // the default and `--only-if-red` modes always exit 0; only `--mark-seen` can exit 2
    if (markAt !== -1) {
        try {
            output = markSeen(root, args[markAt + 1]);
        } catch (err) {
            output = { marked: false, error: err && err.message ? err.message : String(err) };
            process.exitCode = 2;
        }
    } else if (args.includes('--only-if-red')) {
        output = onlyIfRed(root);
    } else {
        output = readGateSignal(root);
    }
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

module.exports = { classify, readGateSignal, onlyIfRed, markSeen, readSeenSignature, seenFilePath };
