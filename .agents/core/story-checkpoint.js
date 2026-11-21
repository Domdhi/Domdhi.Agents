#!/usr/bin/env node
'use strict';

// Input-hash checkpoints per story: a green story is skipped on resume only while every input it was verified
// against still holds.
//
//   story-checkpoint.js hash  TODO ID [--deps-from TODO]...                 the story's 64-hex input hash
//   story-checkpoint.js check TODO ID [--plan PLAN] [--deps-from TODO]...   one JSON verdict; exit 0 = skip, 1 = rerun, 2 = usage
//
// The hash covers the story's own normalized block text (storyBlock, plan-check.js), the blob ids of its declared
// Files taken from the same treeSnapshot the gate receipts hash (gate-receipt.js), and the hashes of its hard
// dependencies. The checkpoint itself is the `- **Story checkpoints:** {ID}={hash12}@{receiptId}` Wave Log line in
// the run plan: no per-story file exists. A receipt is looked up by its id in the gate's receipt history, the current receipt
// or the by-id archive (gate-receipts/by-id) and judged
// by the gate's own reuse engine (decideReuse); the whole-tree receipt verification is never used, because a wave
// commit and its doc edits always move the whole-tree hash.
//
// Fail closed: skip needs every check to pass, and any malformed, missing or unreadable input is a rerun. Both verbs
// are read-only and write no file.
//
// Blind inputs are a rerun, never a skip: a story whose Files resolve to nothing (prose-only, absent) or only
// partly (an entry that is prose) has file content the hash cannot see; a hard dependency that is not done is not a
// settled input. Both apply transitively through the dependencies.
//
// Dependencies outside the TODO: `--deps-from SIBLING_TODO` (repeatable, as plan-check) supplies the sibling TODOs.
// A resolved external dependency is hashed exactly like a local one (its normalized block, which carries its status
// line, its Files blobs and its own dependencies) and must be done. An external dependency that is not supplied hashes
// as a bare marker and `check` reruns (EXTERNAL_DEP). Limits: a dependency's own dependencies outside the supplied
// TODOs, and anything a story reads that it does not declare in Files, are not part of the hash.
//
// The root is CLAUDE_PROJECT_DIR, else this file's repository: the same derivation gate.js uses to write the receipts
// this reads. A caller running inside a linked worktree must export CLAUDE_PROJECT_DIR for that worktree.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { storyBlock, checkPlan } = require('./plan-check');
const { readTodoFile } = require('./todo-completion');
const gateReceipt = require('./_lib/gate-receipt');

const { treeSnapshot, hashFiles, decideReuse, historyDir, globToRegExp, readReceipt, archivedReceipt, hasArchive, RECEIPT_SCHEMA } = gateReceipt;

const HASH_VERSION = 'story-checkpoint/1';
const USAGE = 'Usage: story-checkpoint.js hash TODO_PATH ID [--deps-from TODO]... | story-checkpoint.js check TODO_PATH ID [--plan PLAN_PATH] [--deps-from TODO]...';
const MAX_DEPS_FROM = 64;
const MARKER = /\[[ xX>!~]\]/g;
const CHECKPOINT_LINE = /^\s*[-*+]\s+\*\*Story checkpoints:\*\*\s*(.*)$/;
const CHECKPOINT_ENTRY = /^([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)=(.*)$/;
const CHECKPOINT_VALUE = /^([0-9a-f]{12})@([0-9a-f]{12})$/;
const RUN_TODO_PLAN = /^.+-run-todo-.+\.md$/;
const MAX_PLAN_BYTES = 8 * 1024 * 1024;

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const failure = (code, reason) => ({ ok: false, code, reason });

// ── hash ──

/**
 * The story block with its status marker and AC ticks neutralized: a `[ ]`/`[>]`/`[x]` flip on the story header or
 * on an AC bullet is progress, not an input change.
 */
function normalizedBlock(todoText, id) {
    const block = storyBlock(todoText, id);
    if (block === null) return null;
    return block.split('\n').map((line, at) => (at === 0
        ? line.replace(MARKER, '[ ]')
        : line.replace(/^(\s*[-*+]\s+)\[[ xX>!~]\]/, '$1[ ]'))).join('\n');
}

// Entries a declared Files path stands for: itself, a directory's files, or a glob's matches.
function declaredEntries(entries, declared) {
    if (/[*?]/.test(declared)) {
        const pattern = globToRegExp(declared);
        return [...entries].filter(([file]) => pattern.test(file));
    }
    if (entries.has(declared)) return [[declared, entries.get(declared)]];
    const prefix = `${declared.replace(/\/+$/, '')}/`;
    return [...entries].filter(([file]) => file.startsWith(prefix));
}

// The declared paths' files as the Map hashFiles expects: path -> `mode:blob`, or "absent" when nothing matches,
// so creating or deleting a declared path changes the hash.
function declaredFiles(entries, declaredPaths) {
    const files = new Map();
    for (const declared of declaredPaths) {
        const matched = declaredEntries(entries, declared);
        if (!matched.length) files.set(declared, 'absent');
        for (const [file, entry] of matched) files.set(file, `${entry.mode}:${entry.blob}`);
    }
    return files;
}

// Every story reachable by id: the TODO's own, then the supplied sibling TODOs' (a local id wins, as in plan-check).
// Each entry keeps the text its block is read from; checkPlan carries release-slice's status and dependencies and
// the declared Files.
function storiesById(todoText, externalTexts = []) {
    const stories = new Map();
    const add = (text, external) => {
        if (typeof text !== 'string') return;
        for (const story of checkPlan(text).stories) if (!stories.has(story.id)) stories.set(story.id, { story, text, external });
    };
    add(todoText, false);
    for (const text of Array.isArray(externalTexts) ? externalTexts : []) add(text, true);
    return stories;
}

function inputHash({ stories, snapshot, id, memo, visiting }) {
    if (memo.has(id)) return memo.get(id);
    const entry = stories.get(id);
    const block = entry ? normalizedBlock(entry.text, id) : null;
    if (!entry || block === null) return failure('UNKNOWN_STORY', `story ${id} is not in the TODO`);
    if (visiting.has(id)) return failure('HASH_UNAVAILABLE', `dependency cycle through story ${id}`);
    visiting.add(id);
    const deps = [];
    for (const dep of [...new Set(entry.story.dependencies)].sort()) {
        if (!stories.has(dep)) { deps.push([dep, 'external']); continue; } // not supplied through --deps-from: a bare marker, and check reruns
        const depHash = inputHash({ stories, snapshot, id: dep, memo, visiting });
        if (!depHash.ok) { visiting.delete(id); return failure('HASH_UNAVAILABLE', `dependency ${dep}: ${depHash.reason}`); }
        deps.push([dep, depHash.hash]);
    }
    visiting.delete(id);
    const paths = [...new Set(entry.story.files.map(file => file.path))].sort();
    const files = hashFiles(declaredFiles(snapshot.entries, paths), HASH_VERSION);
    const result = { ok: true, hash: sha256(JSON.stringify({ v: HASH_VERSION, block, files, deps })) };
    memo.set(id, result);
    return result;
}

function computeHash({ root, todoText, id, external }) {
    if (typeof todoText !== 'string' || typeof id !== 'string' || !id) return failure('UNKNOWN_STORY', 'the TODO text or story id is missing');
    const stories = storiesById(todoText, external);
    if (!stories.has(id) || stories.get(id).external || normalizedBlock(todoText, id) === null) return failure('UNKNOWN_STORY', `story ${id} is not in the TODO`);
    if (typeof root !== 'string' || !root) return failure('HASH_UNAVAILABLE', 'the project root is missing');
    const snapshot = treeSnapshot(root);
    if (!snapshot.ok) return failure('HASH_UNAVAILABLE', `tree snapshot unavailable: ${snapshot.reason}`);
    const result = inputHash({ stories, snapshot, id, memo: new Map(), visiting: new Set() });
    return result.ok ? { ...result, stories } : result;
}

/**
 * `external` is an optional array of sibling TODO texts (the `--deps-from` files) holding dependencies this TODO does not.
 * @returns {{ok:true, hash:string} | {ok:false, reason:string}} never throws
 */
function hashStory({ root, todoText, id, external } = {}) {
    let result;
    try { result = computeHash({ root, todoText, id, external }); } catch (error) { result = failure('HASH_UNAVAILABLE', `hashing failed: ${error && error.message}`); }
    return result.ok ? { ok: true, hash: result.hash } : { ok: false, reason: result.reason };
}

// ── the Wave Log checkpoint line ──

/**
 * Every `- **Story checkpoints:** {ID}={hash12}@{receiptId}` entry of a plan: Map id -> {hash12, receiptId}, or null
 * for an entry that is malformed. Later lines win, malformed included, so a later corrupt entry never falls back.
 */
function parseCheckpoints(planText) {
    const checkpoints = new Map();
    if (typeof planText !== 'string') return checkpoints;
    let fence = null;
    for (const line of planText.split(/\r?\n/)) {
        const delimiter = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
        if (fence) {
            if (delimiter && delimiter[1][0] === fence.character && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
            continue;
        }
        if (delimiter) { fence = { character: delimiter[1][0], length: delimiter[1].length }; continue; }
        const labelled = line.match(CHECKPOINT_LINE);
        if (!labelled) continue;
        for (const token of labelled[1].split(/[\s,]+/)) {
            const entry = token.match(CHECKPOINT_ENTRY);
            if (!entry) continue;
            const value = entry[2].match(CHECKPOINT_VALUE);
            checkpoints.set(entry[1], value ? { hash12: value[1], receiptId: value[2] } : null);
        }
    }
    return checkpoints;
}

// ── check ──

// Every record of every gate-receipts/*.json file as {records}, or {problem} naming the unreadable or malformed file: a
// corrupt file can hold the failed record of the receipt, so it never reads as "no failed record". A history directory
// that does not exist is an empty history (gate.js writes a row only for a project or build with a known input closure).
function allHistoryRecords(root) {
    const dir = historyDir(root);
    let names;
    try { names = fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort(); } catch (error) {
        return error && error.code === 'ENOENT' ? { records: [] } : { problem: `the gate receipt history directory is unreadable (${error && error.code})` };
    }
    const records = [];
    for (const name of names) {
        let data;
        try { data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return { problem: `the gate receipt history file ${name} is unreadable or not JSON` }; }
        if (!data || typeof data !== 'object' || !Array.isArray(data.records)) return { problem: `the gate receipt history file ${name} has no records array` };
        for (const record of data.records) {
            if (!record || typeof record !== 'object' || Array.isArray(record)) return { problem: `the gate receipt history file ${name} holds a record that is not an object` };
            records.push(record);
        }
    }
    return { records };
}

// May this passing record stand in for a rerun? The gate's own reuse engine decides, keyed by the record itself.
// Age and the forced-refresh counter do not apply to a checkpoint (a run resumed days later still skips), so both
// limits are unbounded; decideReuse still refuses a flaky record, one with no usable run time, or one dated in the future.
function recordStandsIn(record) {
    // The receipt is matched by id, so the closure key only has to be present and equal to itself (a build record may carry none).
    const closureHash = record.closureHash || record.id;
    return decideReuse({
        project: { name: record.name, reuse: true },
        command: record.command,
        closureHash,
        filter: record.filter,
        mode: record.mode,
        now: Date.now(),
        history: [{ ...record, closureHash }],
        config: { maxAgeHours: Infinity, forceRunEvery: Infinity },
    });
}

// The current `gate-receipt.json`, or the by-id archived copy of an older one (gate-receipts/by-id/{id}.json, or by-id/failed
// for a non-passing run; written by writeReceipt), can stand in for a history row: gate.js writes history only for a project or build with a known input
// closure, so a project without declared inputs has the receipt and nothing else. It stands in only when it is a
// complete, settled pass: not change-scoped, not filtered, exit 0, an unchanged tree across the run, and a passing
// build, test leg and every project.
function receiptFileProblem(receipt) {
    if (receipt.schema !== RECEIPT_SCHEMA) return 'it has an unknown schema';
    if (receipt.status !== 'passed' || receipt.exitCode !== 0) return `its status is ${receipt.status} (exit ${receipt.exitCode})`;
    if (receipt.changedOnly === true) return 'it was a change-scoped run';
    if (receipt.filter) return `it was a filtered run (${receipt.filter})`;
    if (receipt.mode !== 'normal' && receipt.mode !== 'full') return `its mode is ${JSON.stringify(receipt.mode)}`;
    if (!receipt.treeHashStart || receipt.treeHashStart !== receipt.treeHashEnd) return 'the tree changed during the run';
    if (receipt.build && receipt.build.status !== 'passed') return `its build is ${receipt.build.status}`;
    if (receipt.test && receipt.test.status !== undefined && receipt.test.status !== 'passed') return `its test leg is ${receipt.test.status}`;
    for (const project of Array.isArray(receipt.projects) ? receipt.projects : []) {
        if (!project || project.status !== 'passed') return `project ${project && project.name} is ${project && project.status}`;
    }
    return null;
}

function receiptVerdict(root, receiptId) {
    const history = allHistoryRecords(root);
    if (history.problem) return { code: 'NO_RECEIPT', reason: history.problem };
    const matching = history.records.filter(record => record.id === receiptId);
    for (const record of matching) {
        if (record.status !== 'passed') return { code: 'RECEIPT_NOT_PASSED', reason: `receipt ${receiptId} has status ${record.status} for ${record.name}` };
        const verdict = recordStandsIn(record);
        if (!verdict.reuse) return { code: 'RECEIPT_NOT_PASSED', reason: `receipt ${receiptId} (${record.name}) cannot stand in: ${verdict.reason}` };
    }
    // The current receipt is the freshest word on its id; otherwise the by-id archive resolves a receipt that later
    // gate runs overwrote (SF-2.5). Both get the same complete-pass validation.
    const current = readReceipt(root);
    const isCurrent = Boolean(current) && current.id === receiptId;
    const stored = isCurrent ? current : archivedReceipt(root, receiptId);
    if (stored) {
        const problem = receiptFileProblem(stored);
        if (problem) return { code: 'RECEIPT_NOT_PASSED', reason: `receipt ${receiptId} is the ${isCurrent ? 'current gate receipt' : 'archived gate receipt'} but ${problem}` };
    }
    if (!matching.length && !stored) return { code: 'NO_RECEIPT', reason: `receipt ${receiptId} is not in the gate receipt history, the current gate receipt or the by-id archive` };
    // A history row is one project's result, never the whole run's: a run that failed in another project, or whose build
    // had no closure row, leaves a passing row behind. Once this project's gate keeps a by-id archive, a receipt that is
    // neither current nor archived (pruned, or its archive write failed) cannot be judged whole, so it reruns. A project
    // that never wrote an archive (an older gate) keeps the history-only judgement.
    if (!stored && hasArchive(root)) {
        return { code: 'NO_RECEIPT', reason: `receipt ${receiptId} has only a partial gate history row: its whole-run record is not the current gate receipt and is gone from the by-id archive (pruned, or never archived)` };
    }
    return null;
}

// Every story a skip rests on: its transitive hard dependencies, local or supplied through --deps-from.
function ancestorsOf(stories, id) {
    const seen = new Set();
    const queue = [...stories.get(id).story.dependencies];
    while (queue.length) {
        const dep = queue.shift();
        if (seen.has(dep)) continue;
        seen.add(dep);
        if (stories.has(dep)) queue.push(...stories.get(dep).story.dependencies);
    }
    return [...seen].sort();
}

// A story whose Files the hash cannot fully see: none declared, none resolved, or an entry that is prose.
function blindFiles(story) {
    if (!story.hasFiles) return 'declares no Files';
    if (!story.filesResolved) return 'lists Files that resolve to no path';
    if (!story.filesExact) return 'lists a Files entry that is prose and may hide a path';
    return null;
}

// null when the dependencies and Files are settled inputs; otherwise the rerun verdict.
function blindInputs(stories, id) {
    const own = blindFiles(stories.get(id).story);
    if (own) return { code: 'FILES_UNRESOLVED', reason: `story ${id} ${own}, so its declared file content is not part of the hash` };
    for (const dep of ancestorsOf(stories, id)) {
        const entry = stories.get(dep);
        if (!entry) return { code: 'EXTERNAL_DEP', reason: `dependency ${dep} is not in this TODO and no --deps-from TODO supplies it` };
        if (entry.story.status !== 'done') return { code: 'DEP_NOT_DONE', reason: `dependency ${dep} is ${entry.story.status}, not [x]` };
        const depFiles = blindFiles(entry.story);
        if (depFiles) return { code: 'FILES_UNRESOLVED', reason: `dependency ${dep} ${depFiles}, so its declared file content is not part of the hash` };
    }
    return null;
}

function checkStoryUnsafe({ root, todoText, planText, id, external }) {
    const rerun = (code, reason, stale = false) => ({ id, decision: 'rerun', code, reason, stale });
    const hashed = computeHash({ root, todoText, id, external });
    if (!hashed.ok) return rerun(hashed.code, hashed.reason);
    const story = hashed.stories.get(id).story;
    if (story.status !== 'done') return rerun('NOT_DONE', `story ${id} is marked ${story.status}, not [x]`);
    const checkpoint = parseCheckpoints(planText);
    if (!checkpoint.has(id)) return rerun('NO_CHECKPOINT', `the run plan records no checkpoint for story ${id}`);
    const recorded = checkpoint.get(id);
    if (recorded === null) return rerun('CORRUPT_CHECKPOINT', `the checkpoint for story ${id} is malformed`);
    if (hashed.hash.slice(0, 12) !== recorded.hash12) {
        return rerun('STALE_GREEN', `story ${id} is [x] but its inputs changed since checkpoint ${recorded.hash12} (now ${hashed.hash.slice(0, 12)})`, true);
    }
    const blind = blindInputs(hashed.stories, id);
    if (blind) return rerun(blind.code, blind.reason);
    const receipt = receiptVerdict(root, recorded.receiptId);
    if (receipt) return rerun(receipt.code, receipt.reason);
    return { id, decision: 'skip', code: 'UNCHANGED', reason: `inputs match checkpoint ${recorded.hash12} and receipt ${recorded.receiptId} passed`, stale: false };
}

/** @returns {{id, decision:'skip'|'rerun', code:string, reason:string, stale:boolean}} never throws; anything doubtful is a rerun */
function checkStory({ root, todoText, planText, id, external } = {}) {
    try {
        return checkStoryUnsafe({ root, todoText, planText, id, external });
    } catch (error) {
        return { id, decision: 'rerun', code: 'HASH_UNAVAILABLE', reason: `check failed: ${error && error.message}`, stale: false };
    }
}

// ── CLI ──

function defaultPlanPath(root) {
    const dir = path.join(root, 'docs', '.output', 'plans');
    let names;
    try { names = fs.readdirSync(dir).filter(name => RUN_TODO_PLAN.test(name)).sort(); } catch { return null; }
    return names.length ? path.join(dir, names[names.length - 1]) : null;
}

function readPlan(file) {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_PLAN_BYTES) return null;
        return fs.readFileSync(file, 'utf8');
    } catch { return null; }
}

// verb TODO ID, then `--plan PLAN` (check only) and `--deps-from TODO` (repeatable), each with a value, in any order.
function parseArgs(argv) {
    if (!Array.isArray(argv) || !argv.every(arg => typeof arg === 'string')) return null;
    const [verb, todo, id, ...rest] = argv;
    if (verb !== 'hash' && verb !== 'check') return null;
    if (!todo || !id || todo.startsWith('--') || id.startsWith('--')) return null;
    const args = { verb, todo, id, plan: null, depsFrom: [] };
    for (let at = 0; at < rest.length; at += 2) {
        const flag = rest[at];
        const value = rest[at + 1];
        if (value === undefined || value.startsWith('--')) return null;
        if (flag === '--plan' && verb === 'check' && args.plan === null) args.plan = value;
        else if (flag === '--deps-from' && args.depsFrom.length < MAX_DEPS_FROM) args.depsFrom.push(value);
        else return null;
    }
    return args;
}

// The sibling TODOs' texts, or the first read error (a dependency that cannot be read must not read as "none supplied").
function readExternal(files) {
    const texts = [];
    for (const file of files) {
        try { texts.push(readTodoFile(file)); } catch (error) { return { error: `--deps-from ${file} unreadable: ${error && error.message}` }; }
    }
    return { texts };
}

function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (!args) {
        console.error(USAGE);
        return 2;
    }
    const root = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
    let todoText = null;
    let readError = null;
    try { todoText = readTodoFile(args.todo); } catch (error) { readError = error && error.message; }
    const external = readError ? { texts: [] } : readExternal(args.depsFrom);
    if (external.error) readError = external.error;
    if (args.verb === 'hash') {
        const result = readError ? { ok: false, reason: `TODO file unreadable: ${readError}` } : hashStory({ root, todoText, id: args.id, external: external.texts });
        if (!result.ok) { console.error(result.reason); return 1; }
        console.log(result.hash);
        return 0;
    }
    let verdict;
    if (readError) {
        verdict = { id: args.id, decision: 'rerun', code: 'UNKNOWN_STORY', reason: `TODO file unreadable: ${readError}`, stale: false };
    } else {
        const planFile = args.plan || defaultPlanPath(root);
        verdict = checkStory({ root, todoText, planText: planFile ? readPlan(planFile) : null, id: args.id, external: external.texts });
    }
    console.log(JSON.stringify(verdict));
    return verdict.decision === 'skip' ? 0 : 1;
}

module.exports = { hashStory, parseCheckpoints, checkStory, main };
if (require.main === module) process.exitCode = main();
