#!/usr/bin/env node
'use strict';

/**
 * ac-verify.js — run, record and probe the `verify:` bindings of a TODO's acceptance criteria.
 *
 *   node ac-verify.js run --todo T --stories ID1,ID2   execute every binding, record the result
 *   node ac-verify.js red --todo T --stories ID1,ID2   the recorded-red probe: execute and classify
 *   node ac-verify.js freeze --todo T --stories ID1,ID2 [--reason R]   baseline the check files and `verify:` lines
 *   node ac-verify.js check --todo T --stories ID1,ID2   report any edit, deletion or rename since the baseline
 *   node ac-verify.js unfreeze --todo T --stories ID1,ID2   drop the freeze-state entries `freeze` added
 *   node ac-verify.js list --todo T [--stories ID1,ID2]   parse only (every story when --stories is left out): each binding
 *                                                          and whether it would be refused; runs nothing
 *
 * A binding is written inline on an AC checkbox bullet as `verify: <command> [=> exit N]` and parsed by
 * todo-completion.js (`criterion.verify = { command, expectedExit }`). `run` writes one JSON array per story to
 * docs/.output/.state/telemetry/ac-verify/{storyId}.json (the ac-verify record seam) and exits 0 only when every
 * record has status `ran` and `met: true`. `red` runs the same commands before the implementation exists and
 * exits 0 only when every one fails for a real reason (never vacuous, infrastructure, refused or timed out);
 * it writes nothing the ship check reads. The CLI prints exactly one JSON document to stdout, on success and on
 * every failure, and exits non-zero on failure (2 for invalid input or an internal error, 1 for an unmet check).
 *
 * A test written before its implementation requires a file that does not exist yet, so the runner prints
 * `Cannot find module <specifier>`. When every such specifier resolves (relative to a test file of the story, or the
 * root, with the usual extension and index resolution) to a created non-test path of the story's Files list, `red` reports
 * `red` with the digest `expected module <path> | saw Cannot find module | <test file:line>`: no stub is needed. A missing
 * test helper, a package or a path outside the Files list stays `infra` (fix the test or the Files list).
 *
 * SECURITY: the commands come from an editable document. Refusal is fail closed: an unknown or ambiguous command is
 * refused, never run. Every allowed head has a POSITIVE allowlist (its subcommands, then its options); anything not
 * listed is refused. Path-like arguments must name files inside the repository: an absolute path, a `..` segment, a
 * symlink out of the tree, a path in a folder the code hash does not cover (`docs/.output/`, `docs/work/`,
 * `docs/TODO_*.md`) or a Git-ignored path is refused, because the record's `codeHash` would not see their contents.
 * The child runs with a scrubbed environment (no `GIT_*`, `NODE_OPTIONS`, `npm_config_*` and similar), from an
 * absolute path found on PATH (never the repository), and its whole process group is killed on a timeout.
 * Output is redacted with the shared secret redactor before it is recorded or printed. A record whose binding changed
 * the code tree while it ran is `status: tree-changed`, `met: false`: that run proves nothing about the tree it was
 * asked to verify.
 *
 * What this does NOT do: an allowlisted `node`, `npm`, `npx`, `pytest`, `dotnet`, `cargo` or `go` command still runs
 * project code (a test file, a package.json script, a conftest), so the controls that matter beyond the allowlist are
 * the freeze of the check files and `verify:` lines (SF-1.2) and review.
 *
 * FREEZE (SF-1.2): `freeze` writes docs/.output/.state/telemetry/ac-verify/{storyId}.freeze.json holding the sha256 of the
 * raw bytes of every test file in the story's Files list and a sha256 of its `verify:` bindings (command and expected
 * exit, never line numbers or prose), and adds those files' absolute paths to freeze-state.json so the path hook blocks
 * Write and Edit on them. The hash is the role-independent backstop for the writes the hook never sees (`sed -i`, `cp`,
 * `tee`, a script). A baseline that exists is only rewritten with a non-blank `--reason`, appended to its history.
 * `unfreeze` removes only the freeze-state entries `freeze` recorded in the baseline and leaves the baseline, so `check`
 * still works. A story with no `verify:` bindings and no test files in its Files list has nothing to freeze: `check`
 * reports it `nothing-to-freeze` without a baseline instead of BASELINE_MISSING. `check` exits 1 for tampering (FROZEN_FILE_CHANGED, FROZEN_FILE_MISSING, VERIFY_CHANGED) and 2 for any
 * other failure (a tamper finding keeps exit 1 even when another story fails differently); freeze-state paths are exact
 * absolute paths, so the lock is inert inside a worktree (run `check` after integration, in the main checkout).
 *
 * The Files list is read with plan-check's `storyFiles` (the one Files parser; ac-verify has no parser of its own). A test
 * file shared by two stories is locked until the last story unfreezes: `_freeze-locks.json` (next to the baselines) records
 * which stories hold each frozen file and whether `freeze` added the freeze-state entry; baselines are never rewritten by
 * `unfreeze`. A listed test file that does not exist is a warning and is named in the story report (`missing`).
 *
 * The baseline is NOT tamper-proof on its own: it lives in the ignored state zone, and a Bash write that rewrites a test
 * file and its baseline together defeats `check`. Two backstops cover that: ship-check's seal hashes each sealed story's
 * baseline (a rewrite after the seal is `records-drift`), and `telemetry/ac-verify/*.freeze.json` belongs in the SF-1.8
 * protected set. A retry attempt that re-freezes a story needs `--reason` (the baseline exists); run `check` BEFORE that
 * re-freeze, or the re-freeze silently re-baselines the first attempt's tampering.
 *
 * Known limits: on Windows `npm` and `npx` are `.cmd` shims, which cannot be started without a shell, so those
 * bindings record `met: false` there; the Windows process-tree kill (`taskkill /T`) is best effort and untested off
 * Windows; a `--opt=value` value that merely starts with `/` (for example a `/regex/` pattern) is refused as a path.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync: realSpawnSync } = require('node:child_process');
const { verifyTodoCompletion, readTodoFile, VERIFY_HEADS } = require('./todo-completion');
const { findHeaderStories } = require('./release-slice');
const { codeTreeHash, headSha, isUnderExcludedDocs } = require('./_lib/gate-receipt');
const { getTelemetryDir } = require('./_lib/telemetry-paths');
const { assertNoSymlinkedAncestor } = require('./_lib/fs-safe');
const { resolveWorktreeRoot } = require('./_lib/project-root');
const { redactSecretsInText } = require('../hooks/secret-patterns.cjs');
const gate = require('./gate');
const { storyFiles } = require('./plan-check');
const { listFrozen, setFrozen, getStateFilePath } = require('./_lib/freeze-state');

const DEFAULT_TIMEOUT_MS = 300000;
const MAX_TIMEOUT_MS = 2147483647;
const OUTPUT_TAIL_BYTES = 2048;
// The window that is redacted before the final 2 KB tail is cut, so a secret straddling the cut is still caught.
const REDACTION_WINDOW_BYTES = 16 * 1024;
const MAX_CHILD_BUFFER = 64 * 1024 * 1024;
const DIGEST_MAX = 300;

const ALLOWED_HEADS = VERIFY_HEADS;
const NPM_SUBCOMMANDS = ['test', 't', 'run', 'run-script'];
// The only npm options accepted before `--`. Everything else (-C, --prefix, --node-options, -w, ...) is refused.
const NPM_FLAGS = ['--silent', '--if-present'];
const NPM_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9_:.-]*$/;
// Read-only git subcommands. Anything that writes the repository, the config or a remote is absent on purpose.
const GIT_READ_ONLY = ['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'describe',
    'blame', 'rev-list', 'merge-base', 'shortlog', 'diff-tree', 'show-ref', 'name-rev'];
// git options that write a file, read outside the repository or run a configured external program.
const GIT_FORBIDDEN_OPTIONS = /^--(?:output|no-index|contents|ext-diff|textconv)/;
// Subcommands that accept `--no-ext-diff --no-textconv`; passing them keeps a configured diff driver from running.
const GIT_DIFF_FAMILY = ['diff', 'show', 'log', 'diff-tree'];

// Option allowlists, per head. `flags` take no value; `valued` take one (`--name=v` or `--name v`), optionally
// checked against a pattern. `after` is the allowlist for tokens after a `--` (absent: `--` is refused).
const NODE_SPEC = {
    flags: ['--test', '--test-only', '--no-warnings', '--experimental-vm-modules'],
    valued: { '--test-name-pattern': null, '--test-skip-pattern': null, '--test-reporter': /^(?:spec|tap|dot|junit|lcov)$/,
        '--test-timeout': /^\d+$/, '--test-concurrency': /^\d+$/ },
};
const PYTEST_SPEC = {
    flags: ['-q', '-qq', '-v', '-vv', '-x', '-s', '-l', '--lf', '--ff', '--nf', '--co', '--collect-only', '--no-header',
        '--disable-warnings', '--showlocals', '--strict-markers', '-ra', '-rA', '-rf', '-rE', '-rs'],
    valued: { '-k': null, '-m': null, '--maxfail': /^\d+$/, '--tb': /^(?:auto|long|short|line|native|no)$/, '--durations': /^\d+$/ },
    after: { flags: [], valued: {} },
};
const GO_SPEC = {
    flags: ['-v', '-race', '-short', '-failfast', '-cover', '-json'],
    valued: { '-run': null, '-skip': null, '-count': /^\d+$/, '-p': /^\d+$/, '-timeout': /^(?:0|(?:\d+(?:\.\d+)?(?:ns|us|ms|s|m|h))+)$/ },
};
const CARGO_SPEC = {
    flags: ['--workspace', '--all', '--lib', '--bins', '--tests', '--examples', '--doc', '--all-targets', '--all-features',
        '--no-default-features', '--no-fail-fast', '--locked', '--offline', '--frozen', '-q', '--quiet', '-v'],
    valued: { '-p': null, '--package': null, '--features': null, '-F': null, '--test': null, '--bin': null,
        '--example': null, '-j': /^\d+$/, '--jobs': /^\d+$/, '--manifest-path': null },
    after: {
        flags: ['--nocapture', '--show-output', '--exact', '--ignored', '--include-ignored', '-q', '--quiet'],
        valued: { '--test-threads': /^\d+$/, '--skip': null, '-D': /^[a-z0-9_:]+$/, '-W': /^[a-z0-9_:]+$/, '-A': /^[a-z0-9_:]+$/ },
    },
};
const DOTNET_SPEC = {
    flags: ['--no-build', '--no-restore', '--nologo', '--list-tests'],
    valued: { '--filter': null, '-c': /^[A-Za-z0-9_.-]+$/, '--configuration': /^[A-Za-z0-9_.-]+$/, '-f': /^[A-Za-z0-9_.-]+$/,
        '--framework': /^[A-Za-z0-9_.-]+$/, '-v': /^(?:q|quiet|m|minimal|n|normal|d|detailed|diag|diagnostic)$/,
        '--verbosity': /^(?:q|quiet|m|minimal|n|normal|d|detailed|diag|diagnostic)$/ },
};
// Test-and-check subcommands only: nothing here installs, publishes, cleans, regenerates or runs a binary.
const GO_SUBCOMMANDS = ['test', 'vet'];
const CARGO_SUBCOMMANDS = ['test', 'check', 'clippy'];
const DOTNET_SUBCOMMANDS = ['test'];

// Variables that redirect or inject into the tools a binding starts. Never inherited by the child.
const CHILD_ENV_DROP = /^(?:GIT_.*|NODE_OPTIONS|NODE_PATH|npm_config_.*|PYTEST_ADDOPTS|PYTHONSTARTUP|GOFLAGS|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_BUILD_RUSTC_WRAPPER|DOTNET_STARTUP_HOOKS|LD_PRELOAD|DYLD_INSERT_LIBRARIES)$/i;

// Completion-shape errors from todo-completion that say nothing about whether the bindings can be run.
const TOLERATED_CODES = new Set(['STORY_NOT_COMPLETE', 'NO_CRITERIA', 'UNCHECKED_CRITERION',
    'MISSING_INDEX_STORY', 'DUPLICATE_INDEX_STORY', 'UNRECOGNIZED_INDEX_ROW']);

const INFRA_PATTERNS = [
    ['Cannot find module', /Cannot find module/],
    ['SyntaxError', /SyntaxError/],
    ['ENOENT', /\bENOENT\b/],
    ['No test files found', /No test files found/i],
];

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const stripAnsi = (text) => text.replace(ANSI, '');
const toText = (value) => (typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '');
/** The shared secret redactor (never throws; falls back to the named-provider list when the engine is missing). */
const redact = (text) => (typeof text === 'string' && text ? redactSecretsInText(text) : text);

/** A copy of `source` without the injection variables, with git told never to take optional locks. */
function childEnvironment(source = process.env) {
    const env = {};
    for (const [key, value] of Object.entries(source)) if (value !== undefined && !CHILD_ENV_DROP.test(key)) env[key] = value;
    env.GIT_OPTIONAL_LOCKS = '0';
    return env;
}

// ── Tokenizing and refusal ──────────────────────────────────────────

/**
 * Whitespace splitting; single or double quotes group text into one token (a quote may start inside a
 * token, and `""` is an empty token); a backslash is an ordinary character; an unbalanced quote is refused.
 *
 * @returns {{ok:true, tokens:string[]} | {ok:false, reason:string}}
 */
function tokenizeVerify(command) {
    if (typeof command !== 'string') return { ok: false, reason: 'the command is not text' };
    const tokens = [];
    let current = '';
    let inToken = false;
    let quote = null;
    for (const ch of command) {
        if (quote) {
            if (ch === quote) quote = null; else current += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            inToken = true;
        } else if (/\s/.test(ch)) {
            if (inToken) { tokens.push(current); current = ''; inToken = false; }
        } else {
            current += ch;
            inToken = true;
        }
    }
    if (quote) return { ok: false, reason: `unbalanced ${quote === '"' ? 'double' : 'single'} quote` };
    if (inToken) tokens.push(current);
    if (!tokens.length) return { ok: false, reason: 'the command is empty' };
    return { ok: true, tokens };
}

const clip = (text, max = 80) => (text.length > max ? `${text.slice(0, max)}...` : text);
const quoted = (text) => JSON.stringify(clip(String(text)));

function isFile(file) {
    try { return fs.statSync(file).isFile(); } catch { return false; }
}

const isInside = (root, target) => {
    const rel = path.relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

/** The real path of `target`, resolved through its deepest existing ancestor; `exists` is false when the leaf is missing. */
function realDeepest(target) {
    let existing = path.resolve(target);
    const missing = [];
    for (;;) {
        try { return { real: path.join(fs.realpathSync(existing), ...missing.reverse()), exists: missing.length === 0 }; } catch {
            const parent = path.dirname(existing);
            if (parent === existing) return null;
            missing.push(path.basename(existing));
            existing = parent;
        }
    }
}

/** Which of `rels` Git ignores (tracked files never count). `{error}` when Git cannot say. */
function ignoredAmong(realRoot, rels) {
    const result = realSpawnSync('git', ['-C', realRoot, 'check-ignore', '--', ...rels], {
        encoding: 'utf8', windowsHide: true, env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) return { error: result.error.message };
    if (result.status === 1) return { ignored: [] };
    if (result.status !== 0) return { error: `git check-ignore exited ${result.status}` };
    return { ignored: toText(result.stdout).split(/\r?\n/).map(line => line.trim()).filter(Boolean) };
}

/**
 * Refuse a token that names a path the record's code hash cannot vouch for: absolute, with a `..` segment, outside the
 * repository after symlinks, inside a folder the hash excludes, or Git-ignored. A `--opt=value` is judged by its value;
 * a bare option (`--flag`) is not a path. `root` may be absent, in which case only the lexical rules apply.
 */
function pathRefusal(tokens, root) {
    let realRoot = null;
    if (typeof root === 'string' && root) { try { realRoot = fs.realpathSync(root); } catch { realRoot = null; } }
    const existing = [];
    for (const token of tokens) {
        let value = token;
        if (token.startsWith('-')) {
            const eq = token.indexOf('=');
            if (eq < 0) continue;
            value = token.slice(eq + 1);
        }
        if (!value) continue;
        if (/^(?:[\\/]|[A-Za-z]:)/.test(value)) return `refused: ${quoted(token)} is an absolute path; a binding may only name paths inside the repository`;
        if (value.split(/[\\/]/).includes('..')) return `refused: ${quoted(token)} contains a ".." segment; a binding may only name paths inside the repository`;
        if (!realRoot) continue;
        const rel = path.posix.normalize(value.replace(/\\/g, '/')).replace(/^(?:\.\/)+/, '');
        if (rel === '.' || rel === '') continue;
        const lexical = (candidate) => (/^\.git(?:\/|$)/i.test(candidate) ? 'the Git directory' : isUnderExcludedDocs(candidate) ? 'a docs output folder (docs/.output/, docs/work/, docs/TODO_*.md); a verify command names project code' : null);
        const lexicalHit = lexical(rel);
        if (lexicalHit) return `refused: ${quoted(token)} is inside ${lexicalHit}, so a change to it would not move the record's code hash`;
        const resolved = realDeepest(path.join(realRoot, rel));
        if (!resolved) return `refused: ${quoted(token)} cannot be resolved`;
        if (!isInside(realRoot, resolved.real)) return `refused: ${quoted(token)} resolves outside the repository`;
        const realRel = path.relative(realRoot, resolved.real).split(path.sep).join('/');
        const realHit = realRel ? lexical(realRel) : null;
        if (realHit) return `refused: ${quoted(token)} resolves into ${realHit}, so a change to it would not move the record's code hash`;
        if (resolved.exists && realRel) existing.push(realRel);
    }
    if (existing.length) {
        const verdict = ignoredAmong(realRoot, [...new Set(existing)]);
        if (verdict.error) return `refused: cannot tell whether the named paths are Git-ignored (${clip(verdict.error, 120)})`;
        if (verdict.ignored.length) return `refused: ${quoted(verdict.ignored[0])} is Git-ignored, so its contents are not in the record's code hash`;
    }
    return null;
}

/** Take one option at `args[i]` under `spec`: `{ next }` (the index after it and its value) or `{ reason }`. */
function consumeOption(label, args, i, spec) {
    const token = args[i];
    const eq = token.indexOf('=');
    const name = eq > 0 ? token.slice(0, eq) : token;
    if (eq < 0 && spec.flags.includes(token)) return { next: i + 1 };
    if (Object.hasOwn(spec.valued, name)) {
        const value = eq > 0 ? token.slice(eq + 1) : args[i + 1];
        if (value === undefined) return { reason: `refused: ${label} option ${quoted(name)} needs a value` };
        const pattern = spec.valued[name];
        if (pattern && !pattern.test(value)) return { reason: `refused: ${label} option ${quoted(name)} has a value outside the allowed form` };
        return { next: eq > 0 ? i + 1 : i + 2 };
    }
    return { reason: `refused: ${label} option ${quoted(token)} is not in the allowed set (${[...spec.flags, ...Object.keys(spec.valued)].join(', ') || 'none'})` };
}

/** Every option in `args` must be in `spec`; positional tokens pass. `--` is refused unless `spec.after` allows it. */
function scanOptions(label, args, spec) {
    for (let i = 0; i < args.length;) {
        const token = args[i];
        if (token === '--') {
            if (!spec.after) return `refused: ${label} "--" is not allowed`;
            return scanOptions(`${label} (after --)`, args.slice(i + 1), spec.after);
        }
        if (token === '-') return `refused: ${label} "-" (standard input) is not allowed`;
        if (!token.startsWith('-')) { i++; continue; }
        const taken = consumeOption(label, args, i, spec);
        if (taken.reason) return taken.reason;
        i = taken.next;
    }
    return null;
}

function subcommandRefusal(head, rest, subcommands, spec) {
    if (!subcommands.includes(rest[0])) return `refused: ${head} ${rest[0] === undefined ? '(no subcommand)' : quoted(rest[0])} is not allowed (allowed: ${subcommands.join(', ')})`;
    return scanOptions(`${head} ${rest[0]}`, rest.slice(1), spec);
}

/** node: safe flags first, then one script path (or none under `--test`); every later token is a script argument. */
function nodeRefusal(rest) {
    let i = 0;
    let test = false;
    while (i < rest.length && rest[i].startsWith('-')) {
        const taken = consumeOption('node', rest, i, NODE_SPEC);
        if (taken.reason) return taken.reason;
        if (rest[i] === '--test') test = true;
        i = taken.next;
    }
    if (i >= rest.length && !test) return 'refused: node needs a script path inside the repository (or --test)';
    return null;
}

/** npm: test|t|run|run-script, only the safe flags before `--`, one script name for run; everything after `--` goes to the script. */
function npmRefusal(rest, root) {
    if (!NPM_SUBCOMMANDS.includes(rest[0])) return `refused: npm ${rest[0] === undefined ? '(no subcommand)' : quoted(rest[0])} is not allowed (allowed: ${NPM_SUBCOMMANDS.join(', ')})`;
    const runs = rest[0] === 'run' || rest[0] === 'run-script';
    let scripts = 0;
    let scriptName = runs ? null : 'test';
    for (const token of rest.slice(1)) {
        if (token === '--') break;
        if (token.startsWith('-')) {
            if (!NPM_FLAGS.includes(token)) return `refused: npm option ${quoted(token)} is not in the allowed set before "--" (${NPM_FLAGS.join(', ')})`;
        } else if (runs && scripts === 0 && NPM_SCRIPT_NAME.test(token)) { scripts++; scriptName = token; }
        else return `refused: npm ${rest[0]} does not take ${quoted(token)} before "--"`;
    }
    if (runs && scripts === 0) return `refused: npm ${rest[0]} needs a script name`;
    return swallowedFilterRefusal(rest, scriptName, root);
}

// A test-name filter (`-t "x"`, `--testNamePattern=x`, `--test-name-pattern x`, `--grep x`).
const NAME_FILTER = /^(?:-t|--testNamePattern|--test-name-pattern|--grep)(?:=.*)?$/;
// A script that hands its arguments to a second package-manager run (`cd src && npm run test`, `pnpm -r test`, ...).
const REINVOKES_PACKAGE_MANAGER = /(?:^|[\s;&|(])(?:npm|pnpm|yarn|npx|bun)\s/;

/**
 * `npm run test -- file -t "name"` passes the filter to the script. When that script runs a package manager again
 * (`cd src && npm run test`), the inner run treats the filter as its own option and drops it: every test runs, passes,
 * and the criterion would be recorded met although the filter never applied. The filter must then sit behind a second
 * `--` (`npm run test -- file -- -t "name"`). Refused rather than warned, because the run itself cannot tell a dropped
 * filter from one that matched every test.
 */
function swallowedFilterRefusal(rest, scriptName, root) {
    const at = rest.findIndex(token => NAME_FILTER.test(token));
    if (at < 0 || !scriptName || typeof root !== 'string' || !root) return null;
    const separators = rest.slice(0, at).filter(token => token === '--').length;
    if (separators >= 2) return null;
    let script;
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        script = pkg && pkg.scripts && typeof pkg.scripts[scriptName] === 'string' ? pkg.scripts[scriptName] : null;
    } catch { return null; }
    if (!script || !REINVOKES_PACKAGE_MANAGER.test(` ${script}`)) return null;
    return `refused: the "${scriptName}" script (${quoted(script)}) runs a package manager again, which drops ${quoted(rest[at])}, so every test would run and the filter would prove nothing; put the filter behind a second "--" (npm run ${scriptName} -- <file> -- ${rest[at]} ...)`;
}

function npxRefusal(rest, root) {
    const bin = rest[0];
    if (bin === undefined) return 'refused: npx needs the name of a binary in node_modules/.bin';
    if (/[\\/]/.test(bin) || bin.startsWith('-') || bin === '.' || bin === '..') return `refused: npx ${quoted(bin)} is not a bare binary name`;
    if (typeof root !== 'string' || !root) return 'refused: no repository root to look up node_modules/.bin';
    const dir = path.join(root, 'node_modules', '.bin');
    const present = [bin, `${bin}.cmd`].some(name => isFile(path.join(dir, name)));
    if (!present) return `refused: npx ${quoted(bin)} is not an executable in node_modules/.bin`;
    return null;
}

function gitRefusal(rest) {
    if (!GIT_READ_ONLY.includes(rest[0])) return `refused: git ${rest[0] === undefined ? '(no subcommand)' : quoted(rest[0])} is not a read-only subcommand (allowed: ${GIT_READ_ONLY.join(', ')})`;
    const forbidden = rest.find(token => GIT_FORBIDDEN_OPTIONS.test(token));
    if (forbidden !== undefined) return `refused: git ${quoted(forbidden)} writes a file, reads outside the repository or runs a configured program`;
    return null;
}

/**
 * Why a command is refused, or null when it may run. Every unknown is a refusal.
 *
 * @param {string} command the binding as written
 * @param {{root:string}} options root is the repository root (node_modules/.bin and every path argument are checked under it)
 * @returns {string|null}
 */
function refusalReason(command, { root } = {}) {
    if (typeof command !== 'string' || !command.trim()) return 'refused: the command is empty';
    if (/[\0\r\n]/.test(command)) return 'refused: control characters (newline or NUL) in the command';
    const meta = command.match(/[;&|<>`]/) || (command.includes('$(') ? ['$('] : null);
    if (meta) return `refused: shell metacharacter ${JSON.stringify(meta[0])} (no shell is used, so chaining and redirection are not supported)`;
    const tokenized = tokenizeVerify(command);
    if (!tokenized.ok) return `refused: ${tokenized.reason}`;
    const [head, ...rest] = tokenized.tokens;
    if (!ALLOWED_HEADS.includes(head)) return `refused: ${quoted(head)} is not an allowed command (allowed: ${ALLOWED_HEADS.join(', ')})`;
    const byHead = {
        node: () => nodeRefusal(rest),
        npm: () => npmRefusal(rest, root),
        npx: () => npxRefusal(rest, root),
        git: () => gitRefusal(rest),
        pytest: () => scanOptions('pytest', rest, PYTEST_SPEC),
        go: () => subcommandRefusal('go', rest, GO_SUBCOMMANDS, GO_SPEC),
        cargo: () => subcommandRefusal('cargo', rest, CARGO_SUBCOMMANDS, CARGO_SPEC),
        dotnet: () => subcommandRefusal('dotnet', rest, DOTNET_SUBCOMMANDS, DOTNET_SPEC),
    };
    return byHead[head]() || pathRefusal(rest, root);
}

// ── Running one binding ─────────────────────────────────────────────

function timeoutMs(env) {
    const raw = env && env.AC_VERIFY_TIMEOUT_MS;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) {
        const value = Number(raw);
        if (value > 0) return Math.min(value, MAX_TIMEOUT_MS);
    }
    return DEFAULT_TIMEOUT_MS;
}

/** The last `bytes` bytes of `text`, never starting inside a multi-byte character. */
function tailOf(text, bytes = OUTPUT_TAIL_BYTES) {
    const buffer = Buffer.from(text, 'utf8');
    if (buffer.length <= bytes) return text;
    let from = buffer.length - bytes;
    while (from < buffer.length && (buffer[from] & 0xc0) === 0x80) from++;
    return buffer.subarray(from).toString('utf8');
}

/** The recorded tail: redact a wider window, then cut to the last 2 KB, so a secret at the cut is still masked. */
const recordedTail = (output) => tailOf(redact(tailOf(output, REDACTION_WINDOW_BYTES)));

/**
 * The absolute file a head resolves to, found by walking PATH. Empty and relative PATH entries, and entries inside
 * the repository, are skipped, so a `git.exe` or `pytest` placed in the repository (or reached through a `.` entry)
 * never replaces the real tool. `node` is always this process's own executable.
 *
 * @returns {{file:string} | {error:string}}
 */
function resolveHead(head, { root, env, platform = process.platform } = {}) {
    if (head === 'node') return { file: process.execPath };
    const source = env && typeof env === 'object' ? env : {};
    const key = Object.keys(source).find(name => name.toUpperCase() === 'PATH');
    const exts = platform === 'win32' ? ['.exe', '.com', '.cmd', '.bat'] : [''];
    let realRoot = null;
    try { realRoot = fs.realpathSync(root); } catch { realRoot = typeof root === 'string' ? path.resolve(root) : null; }
    for (const raw of key ? String(source[key]).split(path.delimiter) : []) {
        const dir = raw.replace(/^"(.*)"$/, '$1');
        if (!dir || !path.isAbsolute(dir)) continue;
        let realDir;
        try { realDir = fs.realpathSync(dir); } catch { continue; }
        if (realRoot && isInside(realRoot, realDir)) continue;
        for (const ext of exts) {
            const file = path.join(realDir, `${head}${ext}`);
            let runnable = false;
            try { runnable = fs.statSync(file).isFile() && (platform === 'win32' || (fs.accessSync(file, fs.constants.X_OK), true)); } catch { runnable = false; }
            if (runnable) return { file };
        }
    }
    return { error: `${head} was not found on PATH (relative entries and entries inside the repository are ignored)` };
}

/**
 * Kill a timed-out child's whole process group (POSIX: the child was started detached, so its pid is the group id;
 * Windows: `taskkill /T /F`, best effort). A pid that cannot be a real group leader is ignored, so `kill(-1)` can
 * never be reached. Returns whether a kill was attempted.
 */
function killProcessGroup(pid, { platform = process.platform, spawn = realSpawnSync, kill = process.kill } = {}) {
    if (!Number.isInteger(pid) || pid <= 1) return false;
    if (platform === 'win32') {
        try { spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }); } catch { /* best effort */ }
        return true;
    }
    try { kill(-pid, 'SIGKILL'); } catch { /* the group already exited */ }
    return true;
}

/** Run (or refuse) one binding. Throws only for an unexpected failure, which the caller turns into a non-zero exit. */
function execBinding(binding, { root, env, spawn, kill = killProcessGroup, childEnv = childEnvironment() }) {
    const reason = refusalReason(binding.command, { root });
    const ranAtMs = Date.now();
    const base = { signal: null, errorCode: null, durationMs: 0, ranAt: new Date(ranAtMs).toISOString() };
    if (reason) return { ...base, status: 'refused', exit: null, met: false, output: reason, spawned: false };
    const [head, ...args] = tokenizeVerify(binding.command).tokens;
    const resolved = resolveHead(head, { root, env: childEnv });
    if (resolved.error) {
        return { ...base, status: 'ran', exit: null, met: false, output: `[spawn error ENOENT] ${resolved.error}`, errorCode: 'ENOENT', spawned: false };
    }
    // A configured diff driver or textconv must never run for a read-only git command.
    const argv = head === 'git' && GIT_DIFF_FAMILY.includes(args[0]) ? [args[0], '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args;
    const cap = timeoutMs(env);
    const result = spawn(resolved.file, argv, {
        shell: false, windowsHide: true, cwd: root, timeout: cap, killSignal: 'SIGKILL', env: childEnv,
        detached: process.platform !== 'win32', encoding: 'utf8', maxBuffer: MAX_CHILD_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!result || typeof result !== 'object') throw new Error('the child spawner returned no result');
    const durationMs = Math.max(0, Math.round(Date.now() - ranAtMs));
    const errorCode = result.error ? (result.error.code || 'ERROR') : null;
    const timedOut = errorCode === 'ETIMEDOUT';
    // The direct child is already dead; grandchildren (npm -> sh -> node) are not.
    if (timedOut || errorCode === 'ENOBUFS') kill(result.pid);
    let output = toText(result.stdout) + toText(result.stderr);
    if (timedOut) output += `\n[timed out after ${cap} ms]`;
    else if (result.error) output += `\n[spawn error ${errorCode}] ${result.error.message}`;
    const exit = !result.error && Number.isInteger(result.status) ? result.status : null;
    const status = timedOut ? 'timeout' : 'ran';
    const exitMatches = status === 'ran' && exit !== null && exit === binding.expectedExit;
    const vacuousReason = exitMatches ? vacuousRun(output, exit) : null;
    return {
        status, exit, met: exitMatches && !vacuousReason, ...(vacuousReason ? { vacuous: true, vacuousReason } : {}),
        output, signal: result.signal || null, errorCode, durationMs, ranAt: base.ranAt, spawned: true,
    };
}

/**
 * Why a run whose exit code matched still proves nothing, or null. A test-runner summary with no passed and no failed
 * test means every test was skipped (a name filter that matched nothing exits 0 in vitest and jest) or none was
 * collected. Output without a test summary (typecheck, lint, a script) is never vacuous.
 */
function vacuousRun(output, exit) {
    const tests = gate.parseTestOutput(stripAnsi(output), exit);
    if (tests.deadProjects > 0) return 'no tests were collected';
    if (tests.total > 0 && tests.passed === 0 && tests.failed === 0) return `no test passed (${tests.skipped} skipped): a name filter that matches nothing runs no test`;
    return null;
}

// ── red classification ──────────────────────────────────────────────

/** `expected | saw | file:line` from vitest failure output, or null when the output is not vitest's. */
function vitestDigest(text) {
    const lines = text.split(/\r?\n/);
    const isFail = (line) => /^\s*FAIL {2,}\S+\.[cm]?[jt]sx?\b/.test(line);
    const at = lines.findIndex(isFail);
    if (at < 0) return null;
    let next = at + 1;
    while (next < lines.length && !lines[next].trim()) next++;
    const message = (lines[next] || '').trim();
    let location = null;
    for (let i = next; i < lines.length; i++) {
        if (i > next && isFail(lines[i])) break;
        const found = lines[i].match(/^\s*[❯›>]\s+(\S.*?):(\d+)(?::\d+)?\s*$/);
        if (found) { location = `${found[1]}:${found[2]}`; break; }
    }
    if (!location) location = lines[at].trim().replace(/^FAIL\s+/, '').split(' > ')[0];
    const parsed = message.match(/^(?:\w*Error:\s*)?expected (.+?) to (not )?(deeply equal|strictly equal|be|equal|include|contain|match|have|throw)\b(.*)$/);
    if (!parsed) return `${clip(message, 160)} | (see output) | ${location}`;
    const value = parsed[4].replace(/\s*\/\/.*$/, '').trim();
    const expected = !parsed[2] && (parsed[3] === 'be' || parsed[3] === 'equal') ? value : `${parsed[2] || ''}${parsed[3]} ${value}`.trim();
    return `${expected} | ${clip(parsed[1], 120)} | ${location}`;
}

/** The first failing line of non-vitest output, else the first line, else the exit codes. */
function plainDigest(text, outcome, expectedExit) {
    const lines = stripAnsi(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const failing = lines.find(line => /\b(?:fail(?:ed|ure|ures)?|error|assert\w*|expected|not ok|panic)\b|[✗✖×]/i.test(line));
    const line = failing || lines[0];
    if (line) return clip(line, DIGEST_MAX);
    if (outcome.exit === null) return `no exit code${outcome.signal ? ` (killed by ${outcome.signal})` : ''}, expected exit ${expectedExit}`;
    return `exit ${outcome.exit}, expected exit ${expectedExit}`;
}

// ── the missing-module rule of `red` ──
//
// A missing module is the red the check exists to prove when the specifier names a file the story itself creates. Pure
// text and path logic: the caller supplies the story's Files already split into created non-test files and test files
// (repo-relative, forward slashes). It lives in this file, not a new `_lib` one: a module this file requires would have
// to join the subagent read-only tier closure.

const MODULE_EXTENSIONS = ['.js', '.cjs', '.mjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.json'];
// A TypeScript source imported with its emitted extension (`./m.js` for `m.ts`).
const EMITTED_EXTENSIONS = { '.js': ['.ts', '.tsx', '.jsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] };
const SPECIFIER = /Cannot find module '([^'\r\n]+)'|Cannot find module "([^"\r\n]+)"/g;
const FILE_LINE = /([^\s()'"`]+?\.[cm]?[jt]sx?):(\d+)(?::\d+)?/g;

const slashed = (text) => String(text).replace(/\\/g, '/');
const rootPrefix = (root) => `${slashed(root).replace(/\/+$/, '')}/`;
const isAbsoluteSpec = (spec) => spec.startsWith('/') || /^[A-Za-z]:\//.test(spec);

/** Every repo-relative path a `require`/`import` specifier could name from each base directory. */
function specifierCandidates(specifier, baseDirs) {
    const stripped = specifier.replace(/[?#].*$/, '');
    const ext = path.posix.extname(stripped);
    const stem = stripped.slice(0, stripped.length - ext.length);
    const forms = [stripped];
    for (const extension of MODULE_EXTENSIONS) forms.push(`${stripped}${extension}`, `${stripped}/index${extension}`);
    for (const swapped of EMITTED_EXTENSIONS[ext] || []) forms.push(`${stem}${swapped}`);
    const out = new Set();
    for (const base of baseDirs) {
        for (const form of forms) out.add(path.posix.normalize(path.posix.join(base, form)));
    }
    return out;
}

/**
 * `rel:line` of the first `file:line` in the output that names one of the story's test files (node stack frames carry
 * an absolute path, vitest prints `tests/x.test.js:2:1`); else node's `Require stack` entry; else the first test file.
 */
function testLocation(text, root, tests) {
    const prefix = rootPrefix(root);
    const toRel = (file) => {
        const spec = slashed(file);
        return spec.startsWith(prefix) ? spec.slice(prefix.length) : spec.replace(/^\.\//, '');
    };
    for (const found of text.matchAll(FILE_LINE)) {
        const rel = toRel(found[1]);
        if (tests.includes(rel)) return `${rel}:${found[2]}`;
    }
    const required = text.match(/^\s*-\s+(\S+)\s*$/m);
    if (required && tests.includes(toRel(required[1]))) return toRel(required[1]);
    return tests[0] || null;
}

/**
 * The red digest `expected module <path> | saw Cannot find module | <test file:line>` when EVERY missing specifier in the
 * output resolves to a created non-test file of the story; otherwise null.
 *
 * @param {string} text   runner output, ANSI already stripped
 * @param {{root: string, created: Iterable<string>, tests: string[]}} source
 *   `created`: repo-relative created non-test Files paths; `tests`: repo-relative test Files paths
 * @returns {string|null}
 */
function missingModuleDigest(text, source) {
    if (typeof text !== 'string' || !source || typeof source.root !== 'string') return null;
    const created = new Set(source.created || []);
    const tests = Array.isArray(source.tests) ? source.tests : [];
    if (!created.size) return null;
    const specifiers = [...new Set([...text.matchAll(SPECIFIER)].map(match => match[1] || match[2]))];
    if (!specifiers.length) return null;
    const baseDirs = [...new Set([...tests.map(test => path.posix.dirname(test)), '.'])];
    const prefix = rootPrefix(source.root);
    const resolved = [];
    for (const specifier of specifiers) {
        let spec = slashed(specifier);
        // node's ESM error prints the resolved absolute path; it counts only inside the repository root.
        if (isAbsoluteSpec(spec)) {
            if (!spec.startsWith(prefix)) return null;
            spec = spec.slice(prefix.length);
        }
        const hit = [...specifierCandidates(spec, baseDirs)].find(candidate => created.has(candidate)) || aliasHit(spec, created);
        if (!hit) return null;
        resolved.push(hit);
    }
    return `expected module ${resolved.join(', ')} | saw Cannot find module | ${testLocation(text, source.root, tests) || '(see output)'}`;
}

// A path alias (`~/lib/x`, `@/lib/x`, `#/lib/x`) maps to a project folder the TODO does not name (tsconfig `paths`,
// a bundler alias), so `tsc` (TS2307) and bundlers print it unresolved. It resolves to the ONE created file whose path
// ends with the alias tail in one of the module forms; none, or more than one, is no hit (first adopter run, 2026-11-20).
const ALIAS_PREFIX = /^(?:~|@|#)\//;
function aliasHit(spec, created) {
    if (!ALIAS_PREFIX.test(spec)) return null;
    const tails = [...specifierCandidates(spec.replace(ALIAS_PREFIX, ''), ['.'])];
    const hits = [...created].filter(file => tails.some(tail => file === tail || file.endsWith(`/${tail}`)));
    return hits.length === 1 ? hits[0] : null;
}

/**
 * The story's Files split for the missing-module rule: `created` holds the repo-relative created non-test paths, `tests`
 * the repo-relative test paths. Directory and glob entries are not files and are left out. An unknown story yields empty sets.
 *
 * @returns {{root: string, created: Set<string>, tests: string[]}}
 */
function moduleSource(root, text, storyId) {
    const source = { root, created: new Set(), tests: [] };
    const found = storyFiles(text, storyId);
    if (found === null) return source;
    for (const { path: entry, created } of found.files) {
        const normal = normalizeRel(entry);
        if (normal.error || normal.glob || normal.directory) continue;
        if (isTestPath(normal.rel)) source.tests.push(normal.rel);
        else if (created) source.created.add(normal.rel);
    }
    return source;
}

/**
 * `source` is `moduleSource(...)` (or null: no Files knowledge). A test written before its implementation fails with
 * `Cannot find module <specifier>`; when that is the ONLY infrastructure signal and every specifier names a file the story
 * creates, the implementation simply does not exist yet, which is a real red (vitest also prints `Tests  no tests` for the
 * suite, so this runs before the zero-collected rule). A missing helper, a package or a path outside the Files list stays infra.
 */
function classify(binding, outcome, source = null) {
    const base = { acLine: binding.acLine, command: binding.command };
    if (outcome.status === 'refused') return { ...base, verdict: 'refused', reason: redact(outcome.output) };
    if (outcome.status === 'timeout') return { ...base, verdict: 'timeout' };
    if (outcome.errorCode === 'ENOENT') return { ...base, verdict: 'infra', infraClass: 'ENOENT' };
    // The child printed more than the buffer holds: the run is unusable, not a real red.
    if (outcome.errorCode === 'ENOBUFS') return { ...base, verdict: 'infra', infraClass: 'ENOBUFS' };
    if (outcome.errorCode) throw new Error(`the command could not be started (${outcome.errorCode}): ${clip(outcome.output, 200)}`);
    // Killed from outside (OOM killer, a signal) before it could report: infrastructure, never a real red.
    if (outcome.exit === null && outcome.signal) return { ...base, verdict: 'infra', infraClass: 'killed by signal', signal: outcome.signal };
    const text = stripAnsi(outcome.output);
    if (outcome.exit !== 0) {
        const hits = INFRA_PATTERNS.filter(([, pattern]) => pattern.test(text));
        if (hits.length === 1 && hits[0][0] === 'Cannot find module' && source) {
            const digest = missingModuleDigest(text, source);
            if (digest) return { ...base, verdict: 'red', digest: redact(digest) };
        }
        if (hits.length) return { ...base, verdict: 'infra', infraClass: hits[0][0] };
    }
    if (gate.parseTestOutput(text, outcome.exit === null ? 1 : outcome.exit).deadProjects > 0) return { ...base, verdict: 'infra', infraClass: 'zero tests collected' };
    // A matched exit code is vacuous, and so is a run in which no test passed (every test skipped by a name filter).
    if (outcome.met || outcome.vacuous) return { ...base, verdict: 'vacuous', ...(outcome.vacuous ? { reason: outcome.vacuousReason } : {}) };
    return { ...base, verdict: 'red', digest: redact(vitestDigest(text) || plainDigest(text, outcome, binding.expectedExit)) };
}

// ── Selection and orchestration ─────────────────────────────────────

const failure = (errors, exitCode = 2) => ({ ok: false, exitCode, errors, stories: [] });

/**
 * `{story}.freeze.json` lives next to `{story}.json`, so a story id ending in `.freeze` would share a file name with the
 * baseline of another story. Refuse it everywhere.
 */
function reservedStoryId(stories) {
    const id = stories.find(candidate => typeof candidate === 'string' && /\.freeze$/i.test(candidate));
    return id === undefined ? null : { code: 'STORY_ID_RESERVED', message: `Story id ${quoted(id)} ends in ".freeze", which would collide with a freeze baseline file name.` };
}

/** The selected stories' criteria split into bindings and manual criteria, or the errors that stop the run. */
function loadSelection({ root, todo, stories }) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) return { errors: [{ code: 'INVALID_ARGUMENTS', message: 'The repository root must be an absolute path.' }] };
    if (typeof todo !== 'string' || !todo) return { errors: [{ code: 'INVALID_ARGUMENTS', message: 'A TODO path is required.' }] };
    if (!Array.isArray(stories)) return { errors: [{ code: 'INVALID_ARGUMENTS', message: 'Stories must be a list of story ids.' }] };
    const reserved = reservedStoryId(stories);
    if (reserved) return { errors: [reserved] };
    // The bindings must come from a document inside the repository, where the freeze, review and hash can see it.
    const resolvedTodo = realDeepest(path.resolve(root, todo));
    let realRoot = null;
    try { realRoot = fs.realpathSync(root); } catch { realRoot = null; }
    if (resolvedTodo && realRoot && !isInside(realRoot, resolvedTodo.real)) {
        return { errors: [{ code: 'TODO_OUTSIDE_ROOT', message: 'The TODO must be inside the repository root.' }] };
    }
    let text;
    try { text = readTodoFile(path.resolve(root, todo)); } catch {
        return { errors: [{ code: 'INVALID_TODO_FILE', message: 'The TODO must be an existing ordinary bounded UTF-8 file.' }] };
    }
    const parsed = verifyTodoCompletion(text, { storyIds: stories });
    const errors = parsed.errors.filter(error => !TOLERATED_CODES.has(error.code));
    if (errors.length) return { errors };
    return {
        text,
        stories: parsed.stories.map(story => {
            const bindings = story.criteria.filter(criterion => criterion.verify)
                .map(criterion => ({ acLine: criterion.line, command: criterion.verify.command, expectedExit: criterion.verify.expectedExit }));
            return { id: story.id, line: story.line, bindings, manual: story.criteria.length - bindings.length };
        }),
    };
}

const recordDir = (root) => path.join(getTelemetryDir(root), 'ac-verify');

/** Write `value` as JSON to `file` through an unpredictable temp name and a rename; refuses a symlinked ancestor. */
function writeJsonFile(root, file, value) {
    assertNoSymlinkedAncestor(file, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // An unpredictable name opened with `wx` never follows a link someone planted at a guessable temp path.
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
        fs.renameSync(tmp, file);
    } catch (error) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* the original error is the one to report */ }
        throw error;
    }
}

const writeRecords = (root, storyId, records) => writeJsonFile(root, path.join(recordDir(root), `${storyId}.json`), records);

/** The code hash of the tree as it is now; throws when it cannot be computed. */
function treeHashNow(root) {
    const hash = codeTreeHash(root);
    if (!hash.ok) throw new Error(`the code hash cannot be computed: ${hash.reason}`);
    return hash.hash;
}

function headNow(root) {
    const head = headSha(root);
    if (!head) throw new Error('git HEAD cannot be read');
    return head;
}

function execute(mode, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const { root, todo, stories } = options;
    const env = options.env || process.env;
    const spawn = options.spawnSync || realSpawnSync;
    const kill = options.killProcessGroup || killProcessGroup;
    const childEnv = childEnvironment(process.env);
    const selection = loadSelection({ root, todo, stories });
    if (selection.errors) return failure(selection.errors);

    // One hash before anything runs. In `run` it is the "before" of the first binding and each later binding's
    // "before" is the previous binding's "after", so a binding that rewrites the tree is caught and the tree is hashed
    // once per command; `red` writes no record and hashes only this once.
    const preflight = codeTreeHash(root);
    if (!preflight.ok) return failure([{ code: 'CODE_HASH_UNAVAILABLE', message: `The repository state cannot be hashed: ${preflight.reason}` }]);
    if (mode === 'run') {
        if (!headSha(root)) return failure([{ code: 'HEAD_UNAVAILABLE', message: 'git HEAD cannot be read (a repository with no commit?).' }]);
        assertNoSymlinkedAncestor(path.join(recordDir(root), 'x.json'), root);
        fs.mkdirSync(recordDir(root), { recursive: true });
        for (const story of selection.stories) {
            const file = path.join(recordDir(root), `${story.id}.json`);
            const stat = fs.lstatSync(file, { throwIfNoEntry: false });
            if (stat && !stat.isFile()) return failure([{ code: 'RECORD_PATH_UNUSABLE', storyId: story.id, message: `${path.relative(root, file)} exists and is not a file.` }]);
        }
    }

    let treeBefore = preflight.hash;
    const reports = [];
    // `red` runs one wave: a test or a repo-wide check (a typecheck) of one story fails on a module ANOTHER story of the
    // same wave creates, which is the same real red. So the missing-module rule resolves against every selected story's
    // created files and tests (first adopter run, 2026-11-20: a typecheck binding was reported as infra for this).
    const waveSource = mode === 'run' ? null : selection.stories.reduce((union, story) => {
        const one = moduleSource(root, selection.text, story.id);
        for (const file of one.created) union.created.add(file);
        union.tests.push(...one.tests.filter(test => !union.tests.includes(test)));
        return union;
    }, { root, created: new Set(), tests: [] });
    for (const story of selection.stories) {
        const shared = { id: story.id, bindings: story.bindings.length, manual: story.manual };
        if (!story.bindings.length) {
            if (mode === 'run') writeRecords(root, story.id, []);
            reports.push({ ...shared, status: 'no-bindings', ...(mode === 'run' ? { records: [] } : { results: [] }) });
            continue;
        }
        const outcomes = story.bindings.map(binding => {
            let outcome = execBinding(binding, { root, env, spawn, kill, childEnv });
            if (mode !== 'run') return { binding, outcome };
            let treeAfter = treeBefore;
            if (outcome.spawned) {
                treeAfter = treeHashNow(root);
                if (outcome.status === 'ran' && treeAfter !== treeBefore) {
                    outcome = { ...outcome, status: 'tree-changed', met: false,
                        output: `${outcome.output}\n[tree changed while the command ran (${treeBefore.slice(0, 12)} -> ${treeAfter.slice(0, 12)}); the result proves nothing about the tree it was asked to verify]` };
                }
            }
            treeBefore = treeAfter;
            return { binding, outcome, stamp: { codeHash: treeAfter, head: headNow(root) } };
        });
        if (mode === 'run') {
            const records = outcomes.map(({ binding, outcome, stamp: at }) => ({
                story: story.id, acLine: binding.acLine, command: binding.command, expectedExit: binding.expectedExit,
                exit: outcome.exit, met: outcome.met, status: outcome.status, durationMs: outcome.durationMs,
                ...(outcome.vacuous ? { vacuous: true, vacuousReason: outcome.vacuousReason } : {}),
                outputTail: recordedTail(outcome.output), codeHash: at.codeHash, head: at.head, ranAt: outcome.ranAt,
            }));
            writeRecords(root, story.id, records);
            reports.push({ ...shared, status: records.every(r => r.status === 'ran' && r.met) ? 'passed' : 'failed', records });
        } else {
            const results = outcomes.map(({ binding, outcome }) => classify(binding, outcome, waveSource));
            reports.push({ ...shared, status: results.every(r => r.verdict === 'red') ? 'red' : 'not-red', results });
        }
    }
    const good = (report) => report.status === 'no-bindings' || report.status === (mode === 'run' ? 'passed' : 'red');
    const ok = reports.every(good);
    return { ok, exitCode: ok ? 0 : 1, errors: [], stories: reports };
}

function guarded(mode, opts) {
    try { return execute(mode, opts); } catch (error) {
        return failure([{ code: 'EXCEPTION', message: `ac-verify ${mode} failed: ${error && error.message ? error.message : String(error)}` }]);
    }
}

/** Execute every binding of the selected stories and record each result. */
const run = (opts) => guarded('run', opts);
/** The recorded-red probe: execute every binding before the implementation exists and classify each outcome. */
const red = (opts) => guarded('red', opts);

// ── freeze, check and unfreeze (SF-1.2) ─────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
const BASELINE_MAX_BYTES = 1024 * 1024;
const REASON_MAX = 500;
// A tamper finding is a fact about the code; every other failure (bad input, no baseline, unreadable file) is exit 2.
const TAMPER_CODES = new Set(['FROZEN_FILE_CHANGED', 'FROZEN_FILE_MISSING', 'VERIFY_CHANGED']);

const sha256Of = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const guardResult = (errors, warnings = [], stories = []) => {
    // Any tamper finding makes the result exit 1, so a mixed result (tamper plus an unreadable file) keeps its classification.
    const exitCode = errors.length === 0 ? 0 : errors.some(error => TAMPER_CODES.has(error.code)) ? 1 : 2;
    return { ok: exitCode === 0, exitCode, errors, warnings, stories };
};
const guardFailure = (errors) => guardResult(errors.length ? errors : [{ code: 'EXCEPTION', message: 'unknown failure' }]);

/** Run one freeze verb; an exception becomes a non-zero result, never an escape and never a success. */
function guardedFreezeVerb(name, fn, opts) {
    try { return fn(opts && typeof opts === 'object' ? opts : {}); } catch (error) {
        return guardFailure([{ code: 'EXCEPTION', message: `ac-verify ${name} failed: ${error && error.message ? error.message : String(error)}` }]);
    }
}

/** Is this Files entry a test file? Judged on the text as written, before any normalization. */
function isTestPath(raw) {
    const p = String(raw).replace(/\\/g, '/');
    const base = p.split('/').filter(Boolean).pop() || '';
    return p.includes('__tests__/') || p.includes('/tests/') || p.startsWith('tests/') || p.includes('.test.') || p.includes('.spec.') || base.startsWith('test_');
}

/** A repo-relative forward-slash path, or a reason it is not one. A trailing slash marks a directory. */
function normalizeRel(raw) {
    const text = String(raw).replace(/\\/g, '/').trim();
    if (!text || /[\0\r\n]/.test(text)) return { error: 'is empty or has control characters' };
    if (/^(?:\/|[A-Za-z]:)/.test(text)) return { error: 'is an absolute path' };
    const segments = text.split('/');
    if (segments.includes('..')) return { error: 'has a ".." segment' };
    const rel = segments.filter(segment => segment && segment !== '.').join('/');
    if (!rel) return { error: 'names the repository root' };
    return { rel, directory: text.endsWith('/'), glob: /[*?[\]{}]/.test(rel) };
}

/** The sha256 of a regular file's raw bytes, never following a symlink at the leaf. */
function hashFile(file) {
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        if (!fs.fstatSync(fd).isFile()) return { state: 'notfile' };
        return { state: 'ok', hash: sha256Of(fs.readFileSync(fd)) };
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { state: 'missing' };
        if (error.code === 'ELOOP') return { state: 'symlink' };
        return { state: 'unreadable', message: error.message };
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing to release */ } }
    }
}

/** Per-binding hashes and the combined verifyHash: command and expected exit only, never line numbers or prose. */
function verifyDigest(bindings) {
    const each = bindings.map(binding => sha256Of(JSON.stringify([binding.command, binding.expectedExit])));
    return { each, hash: sha256Of(each.join('\n')) };
}

const baselinePath = (root, storyId) => path.join(recordDir(root), `${storyId}.freeze.json`);
const relFrom = (root, file) => path.relative(root, file).split(path.sep).join('/');

/**
 * Test files of one story: `{ files: {rel: sha}, missing: [rel], warnings, errors }`. The Files list comes from
 * plan-check's `storyFiles` (the one Files parser). A listed test file outside the repository fails closed.
 */
function storyTestFiles(root, realRoot, story, text) {
    const result = { files: {}, missing: [], warnings: [], errors: [] };
    const found = storyFiles(text, story.id);
    const listed = found === null ? null : found.files;
    const refuse = (entry, why) => result.errors.push({ code: 'FILES_PATH_REFUSED', story: story.id, file: entry, message: `Files entry ${quoted(entry)} ${why}; a frozen check file must be an ordinary file inside the repository.` });
    if (listed === null) {
        result.errors.push({ code: 'FILES_UNPARSEABLE', story: story.id, message: `The plan parser does not know story ${story.id}, so its Files list cannot be read and no test file can be frozen.` });
        return result;
    }
    if (found.hasFiles && !found.filesExact) result.warnings.push(`${story.id}: a Files entry is prose the plan parser could not read as a path; a test file named only there is not frozen`);
    for (const { path: entry } of listed) {
        if (!isTestPath(entry)) continue;
        const normal = normalizeRel(entry);
        if (normal.error) { refuse(entry, normal.error); continue; }
        if (normal.glob || normal.directory) { result.warnings.push(`${story.id}: Files entry ${quoted(entry)} is a ${normal.glob ? 'glob' : 'directory'}, not a file, so it was not frozen`); continue; }
        const full = path.join(root, ...normal.rel.split('/'));
        const resolved = realDeepest(full);
        if (!resolved || !isInside(realRoot, resolved.real)) { refuse(entry, 'resolves outside the repository'); continue; }
        const stat = fs.lstatSync(full, { throwIfNoEntry: false });
        if (!stat) { result.missing.push(normal.rel); result.warnings.push(`${story.id}: test file ${quoted(normal.rel)} does not exist, so it was not frozen`); continue; }
        if (!stat.isFile()) { refuse(entry, stat.isSymbolicLink() ? 'is a symlink' : 'is not an ordinary file'); continue; }
        const hashed = hashFile(full);
        if (hashed.state !== 'ok') { refuse(entry, `cannot be read (${hashed.state})`); continue; }
        result.files[normal.rel] = hashed.hash;
    }
    if (!Object.keys(result.files).length && !result.errors.length) {
        result.warnings.push(listed.length
            ? `${story.id}: no test files in the Files list; the baseline holds only the verify hash`
            : `${story.id}: no Files list found, or none of its entries is a path; no test files were frozen and the baseline holds only the verify hash`);
    }
    return result;
}

/** Read and validate `{storyId}.freeze.json`: `{ baseline }` or `{ error }`. Never follows a symlink. */
function readBaseline(root, storyId) {
    const file = baselinePath(root, storyId);
    const label = relFrom(root, file);
    const fail = (code, message) => ({ error: { code, story: storyId, message } });
    assertNoSymlinkedAncestor(file, root);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return fail('BASELINE_MISSING', `No freeze baseline for ${storyId} (${label}); run freeze first.`);
    if (!stat.isFile() || stat.size > BASELINE_MAX_BYTES) return fail('BASELINE_MALFORMED', `${label} is not an ordinary bounded file.`);
    let fd;
    let parsed;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch (error) {
        if (error && error.code === 'ELOOP') return fail('BASELINE_MALFORMED', `${label} is a symlink.`);
        if (error instanceof SyntaxError) return fail('BASELINE_MALFORMED', `${label} is not valid JSON.`);
        throw error;
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing to release */ } }
    }
    const isRel = (value) => typeof value === 'string' && !normalizeRel(value).error && normalizeRel(value).rel === value;
    const valid = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.story === storyId
        && parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)
        && Object.entries(parsed.files).every(([rel, hash]) => isRel(rel) && typeof hash === 'string' && HEX64.test(hash))
        && typeof parsed.verifyHash === 'string' && HEX64.test(parsed.verifyHash)
        && Array.isArray(parsed.history) && parsed.history.every(entry => entry && typeof entry === 'object' && typeof entry.at === 'string')
        && (parsed.verifyBindings === undefined || (Array.isArray(parsed.verifyBindings) && parsed.verifyBindings.every(hash => typeof hash === 'string' && HEX64.test(hash))))
        && (parsed.frozenAdded === undefined || (Array.isArray(parsed.frozenAdded) && parsed.frozenAdded.every(isRel)));
    if (!valid) return fail('BASELINE_MALFORMED', `${label} does not hold {story, files, verifyHash, history}.`);
    return { baseline: parsed };
}

// Lock bookkeeping (F5). Two stories can freeze the same test file; the freeze-state entry must outlive the first
// `unfreeze` while the second story still needs it. `_freeze-locks.json` (a leading `_` can never be a story id, so it
// cannot collide with a `{id}.json` record) maps each frozen file to the stories that hold it and says whether `freeze`
// added the freeze-state entry (an entry that was already there is never removed). The baselines stay immutable after
// `freeze`, so the ship seal that covers them is not disturbed by an `unfreeze`.
const LOCKS_FILE = '_freeze-locks.json';
const locksPath = (root) => path.join(recordDir(root), LOCKS_FILE);

/** The lock map `{ '<rel>': { holders: [storyId], added: boolean } }`, `{}` when there is no file, or `{ error }`. */
function readLocks(root) {
    const file = locksPath(root);
    const label = relFrom(root, file);
    const malformed = (why) => ({ error: { code: 'LOCKS_MALFORMED', message: `${label} ${why}; delete it to fall back to the baselines' own record of what freeze added.` } });
    assertNoSymlinkedAncestor(file, root);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return { locks: {}, prior: null };
    if (!stat.isFile() || stat.size > BASELINE_MAX_BYTES) return malformed('is not an ordinary bounded file');
    let parsed;
    let prior;
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        prior = fs.readFileSync(fd);
        parsed = JSON.parse(prior.toString('utf8'));
    } catch (error) {
        if (error && error.code === 'ELOOP') return malformed('is a symlink');
        if (error instanceof SyntaxError) return malformed('is not valid JSON');
        throw error;
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing to release */ } }
    }
    const isRel = (value) => typeof value === 'string' && !normalizeRel(value).error && normalizeRel(value).rel === value;
    const locks = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.locks : null;
    const valid = locks && typeof locks === 'object' && !Array.isArray(locks)
        && Object.entries(locks).every(([rel, entry]) => isRel(rel) && entry && typeof entry === 'object' && typeof entry.added === 'boolean'
            && Array.isArray(entry.holders) && entry.holders.every(holder => typeof holder === 'string' && holder));
    if (!valid) return malformed('does not hold {locks: {path: {holders, added}}}');
    return { locks: Object.fromEntries(Object.entries(locks).map(([rel, entry]) => [rel, { holders: [...entry.holders], added: entry.added }])), prior };
}

/** freeze-state.json is only touched through an ordinary file with no symlinked ancestor inside the repository. */
function assertStateWritable(root) {
    const file = getStateFilePath();
    if (isInside(root, file)) assertNoSymlinkedAncestor(file, root);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error(`${file} exists and is not an ordinary file; refusing to write freeze-state through it`);
}

/** Validate the reason: `{ reason }` (trimmed, possibly empty) or `{ error }`. */
function cleanReason(reason) {
    if (reason === undefined || reason === null) return { reason: '' };
    if (typeof reason !== 'string') return { error: 'The reason must be text.' };
    const trimmed = reason.trim();
    if (trimmed.length > REASON_MAX) return { error: `The reason is longer than ${REASON_MAX} characters.` };
    if (/[\0-\x1f\x7f]/.test(trimmed)) return { error: 'The reason must be one line of plain text.' };
    return { reason: trimmed };
}

function executeFreeze(options) {
    const { root, todo, stories } = options;
    const reasonCheck = cleanReason(options.reason);
    const selection = loadSelection({ root, todo, stories });
    if (selection.errors) return guardFailure(selection.errors);
    if (reasonCheck.error) return guardFailure([{ code: 'INVALID_ARGUMENTS', message: reasonCheck.error }]);
    const reason = reasonCheck.reason;
    const realRoot = fs.realpathSync(root);

    const dir = recordDir(root);
    assertNoSymlinkedAncestor(path.join(dir, 'x.json'), root);
    assertStateWritable(root);

    const errors = [];
    const warnings = [];
    const plan = [];
    const current = listFrozen();
    const claimed = new Set(current);
    const lockRead = readLocks(root);
    let locks = lockRead.locks;
    let locksPrior = lockRead.prior || null;
    if (lockRead.error) {
        warnings.push(`${lockRead.error.message.split(';')[0]}; it was rebuilt from this freeze only`);
        locks = {};
        locksPrior = fs.lstatSync(locksPath(root), { throwIfNoEntry: false })?.isFile() ? fs.readFileSync(locksPath(root)) : null;
    }
    const at = new Date().toISOString();
    for (const story of selection.stories) {
        const file = baselinePath(root, story.id);
        const stat = fs.lstatSync(file, { throwIfNoEntry: false });
        if (stat && !stat.isFile()) { errors.push({ code: 'RECORD_PATH_UNUSABLE', story: story.id, message: `${relFrom(root, file)} exists and is not a file.` }); continue; }
        if (stat && !reason) { errors.push({ code: 'REASON_REQUIRED', story: story.id, message: `A freeze baseline for ${story.id} already exists; re-baselining needs --reason "<why>" (it is kept in the history).` }); continue; }
        let history = [];
        let previouslyAdded = [];
        let prior = null;
        if (stat) {
            prior = fs.readFileSync(file);
            const existing = readBaseline(root, story.id);
            if (existing.baseline) { history = existing.baseline.history; previouslyAdded = existing.baseline.frozenAdded || []; } else warnings.push(`${story.id}: the existing baseline was unreadable (${existing.error.code}) and was replaced; its history is lost`);
        }
        const tests = storyTestFiles(root, realRoot, story, selection.text);
        errors.push(...tests.errors);
        warnings.push(...tests.warnings);
        // An entry already in freeze-state was not added by freeze unless an earlier baseline of this story recorded it.
        const added = new Set(previouslyAdded);
        for (const rel of Object.keys(tests.files)) {
            const absolute = path.join(root, ...rel.split('/'));
            if (!claimed.has(absolute)) { claimed.add(absolute); added.add(rel); }
            // Every story that freezes a file holds its lock, not only the first one to claim it.
            const lock = locks[rel] || (locks[rel] = { holders: [], added: false });
            lock.added = lock.added || !current.includes(absolute);
            if (!lock.holders.includes(story.id)) lock.holders.push(story.id);
        }
        const digest = verifyDigest(story.bindings);
        plan.push({
            file, prior, missing: tests.missing,
            baseline: {
                story: story.id, files: tests.files, verifyHash: digest.hash, verifyBindings: digest.each,
                frozenAdded: [...added], history: [...history, { at, ...(reason ? { reason } : {}) }],
            },
        });
    }
    if (errors.length) return guardResult(errors, warnings);

    // Baselines first, freeze-state last: a lock is never set without its evidence, and a failed write is rolled back.
    const written = [];
    const rollback = () => {
        for (const item of written.reverse()) {
            try { if (item.prior) fs.writeFileSync(item.file, item.prior); else fs.rmSync(item.file, { force: true }); } catch { /* best effort: the original error is the one to report */ }
        }
    };
    try {
        fs.mkdirSync(dir, { recursive: true });
        for (const item of plan) { writeJsonFile(root, item.file, item.baseline); written.push(item); }
        if (Object.keys(locks).length || locksPrior) {
            const item = { file: locksPath(root), prior: locksPrior };
            writeJsonFile(root, item.file, { locks });
            written.push(item);
        }
        const additions = [...claimed].filter(entry => !current.includes(entry));
        if (additions.length) setFrozen([...current, ...additions]);
    } catch (error) {
        rollback();
        throw error;
    }
    return guardResult([], warnings, plan.map(item => ({
        id: item.baseline.story, status: 'frozen', files: Object.keys(item.baseline.files), frozen: item.baseline.frozenAdded,
        verifyBindings: item.baseline.verifyBindings.length, baseline: relFrom(root, item.file),
        ...(item.missing.length ? { missing: item.missing } : {}),
    })));
}

/** True when freeze would record nothing for the story: no verify: bindings and no test files (listed or missing). */
function nothingToFreeze(root, story, text) {
    if (story.bindings.length) return false;
    try {
        const tests = storyTestFiles(root, fs.realpathSync(root), story, text);
        return !tests.errors.length && !Object.keys(tests.files).length && !tests.missing.length;
    } catch {
        return false;
    }
}

function executeCheck(options) {
    const { root, todo, stories } = options;
    const selection = loadSelection({ root, todo, stories });
    if (selection.errors) return guardFailure(selection.errors);
    const errors = [];
    const reports = [];
    for (const story of selection.stories) {
        const loaded = readBaseline(root, story.id);
        if (loaded.error && loaded.error.code === 'BASELINE_MISSING' && nothingToFreeze(root, story, selection.text)) {
            // A story with no verify: bindings and no test files in its Files list (only [manual] ACs) gives freeze nothing
            // to hold, so there is nothing a missing baseline could hide (first adopter run, 2026-11-20).
            reports.push({ id: story.id, status: 'nothing-to-freeze' });
            continue;
        }
        if (loaded.error) { errors.push(loaded.error); reports.push({ id: story.id, status: 'no-baseline' }); continue; }
        const { baseline } = loaded;
        const found = [];
        for (const [rel, expected] of Object.entries(baseline.files)) {
            const full = path.join(root, ...rel.split('/'));
            const hashed = hashFile(full);
            if (hashed.state === 'ok' && hashed.hash === expected) continue;
            if (hashed.state === 'missing') found.push({ code: 'FROZEN_FILE_MISSING', story: story.id, file: rel, message: `Frozen file ${rel} is missing (deleted or renamed).` });
            else if (hashed.state === 'unreadable') found.push({ code: 'FROZEN_FILE_UNREADABLE', story: story.id, file: rel, message: `Frozen file ${rel} cannot be read (${clip(hashed.message, 120)}).` });
            else found.push({ code: 'FROZEN_FILE_CHANGED', story: story.id, file: rel, message: `Frozen file ${rel} changed since it was frozen${hashed.state === 'ok' ? '' : ` (it is now ${hashed.state === 'symlink' ? 'a symlink' : 'not an ordinary file'})`}.` });
        }
        const digest = verifyDigest(story.bindings);
        if (digest.hash !== baseline.verifyHash) {
            const before = baseline.verifyBindings;
            const sameCount = Array.isArray(before) && before.length === digest.each.length;
            const index = sameCount ? digest.each.findIndex((hash, i) => hash !== before[i]) : -1;
            const where = index >= 0 ? story.bindings[index].acLine : undefined;
            found.push({
                code: 'VERIFY_CHANGED', story: story.id, ...(where === undefined ? {} : { acLine: where }),
                message: where === undefined
                    ? `The verify: bindings of ${story.id} changed since they were frozen (a binding was added or removed).`
                    : `A verify: binding of ${story.id} changed since it was frozen (TODO line ${where}).`,
            });
        }
        errors.push(...found);
        reports.push({ id: story.id, status: found.length ? 'tampered' : 'unchanged', files: Object.keys(baseline.files).length, findings: found.length });
    }
    return guardResult(errors, [], reports);
}

function executeUnfreeze(options) {
    const { root, stories } = options;
    if (typeof root !== 'string' || !path.isAbsolute(root)) return guardFailure([{ code: 'INVALID_ARGUMENTS', message: 'The repository root must be an absolute path.' }]);
    if (!Array.isArray(stories)) return guardFailure([{ code: 'INVALID_ARGUMENTS', message: 'Stories must be a list of story ids.' }]);
    const reserved = reservedStoryId(stories);
    if (reserved) return guardFailure([reserved]);
    // The same story-id validation as every other verb; an empty TODO text asks for nothing but that check.
    const invalid = verifyTodoCompletion('', { storyIds: stories }).errors.filter(error => error.code === 'INVALID_STORY_IDS');
    if (invalid.length) return guardFailure(invalid);
    const errors = [];
    const remove = new Set();
    const reports = [];
    const lockRead = readLocks(root);
    if (lockRead.error) return guardResult([lockRead.error]);
    const locks = lockRead.locks;
    const before = JSON.stringify(locks);
    for (const id of stories) {
        const loaded = readBaseline(root, id);
        if (loaded.error) { errors.push(loaded.error); continue; }
        const addedByBaseline = new Set(loaded.baseline.frozenAdded || []);
        // Everything this story holds, plus what its baseline says freeze added (a lost lock file falls back to that).
        const rels = new Set([...Object.keys(locks).filter(rel => locks[rel].holders.includes(id)), ...addedByBaseline]);
        let removed = 0;
        let retained = 0;
        for (const rel of rels) {
            const entry = locks[rel];
            const absolute = path.join(root, ...rel.split('/'));
            if (!entry) { if (addedByBaseline.has(rel)) { remove.add(absolute); removed++; } continue; }
            entry.holders = entry.holders.filter(holder => holder !== id);
            if (entry.holders.length) { retained++; continue; }
            delete locks[rel];
            if (entry.added) { remove.add(absolute); removed++; }
        }
        reports.push({ id, status: 'unfrozen', removed, ...(retained ? { retained } : {}) });
    }
    if (errors.length) return guardResult(errors);
    assertStateWritable(root);
    // Bookkeeping first: if the freeze-state write then fails, the lock stays (safe) and a retry still finds the entry.
    if (JSON.stringify(locks) !== before) writeJsonFile(root, locksPath(root), { locks });
    const current = listFrozen();
    const next = current.filter(entry => !remove.has(entry));
    if (next.length !== current.length) setFrozen(next);
    return guardResult([], [], reports);
}

/** Baseline the check files and `verify:` lines of the selected stories and lock the files against Write and Edit. */
const freeze = (opts) => guardedFreezeVerb('freeze', executeFreeze, opts);

/**
 * Parse only: every binding of the selected stories with the refusal it would get, or null. Nothing is executed and
 * nothing is written, so authors can check bindings while writing the TODO. Exits 0 only when no binding is refused.
 */
function list(opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    try {
        let stories = options.stories;
        if (stories === undefined) {
            // Every story of the TODO: an authoring check runs before anyone picks a wave.
            let text;
            try { text = readTodoFile(path.resolve(options.root, options.todo)); } catch {
                return failure([{ code: 'INVALID_TODO_FILE', message: 'The TODO must be an existing ordinary bounded UTF-8 file.' }]);
            }
            // A heading such as `## Story Index` parses as a story named `Index`; real story ids carry a number.
            stories = [...new Set(findHeaderStories(text.split(/\r?\n/)).stories.map(story => story.id).filter(id => /\d/.test(id)))];
            if (!stories.length) return { ok: true, exitCode: 0, errors: [], refused: 0, stories: [] };
        }
        const selection = loadSelection({ ...options, stories });
        if (selection.errors) return failure(selection.errors);
        const listed = selection.stories.map(story => ({
            id: story.id, manual: story.manual,
            bindings: story.bindings.map(binding => ({ ...binding, refusal: refusalReason(binding.command, { root: options.root }) })),
        }));
        const refused = listed.reduce((count, story) => count + story.bindings.filter(binding => binding.refusal).length, 0);
        return { ok: refused === 0, exitCode: refused ? 1 : 0, errors: [], refused, stories: listed };
    } catch (error) {
        return failure([{ code: 'EXCEPTION', message: `ac-verify list failed: ${error && error.message ? error.message : String(error)}` }]);
    }
}
/** Report any edit, deletion or rename of a frozen file and any edit of a `verify:` binding since the baseline. */
const check = (opts) => guardedFreezeVerb('check', executeCheck, opts);
/** Remove only the freeze-state entries `freeze` added; the baseline stays so `check` keeps working. */
const unfreeze = (opts) => guardedFreezeVerb('unfreeze', executeUnfreeze, opts);

// ── CLI ─────────────────────────────────────────────────────────────

const USAGE = 'Usage: ac-verify.js run|red|check|unfreeze --todo TODO_PATH --stories ID1,ID2 | list --todo TODO_PATH [--stories ID1,ID2] | freeze --todo TODO_PATH --stories ID1,ID2 [--reason TEXT]';
const VERBS = ['run', 'red', 'freeze', 'check', 'unfreeze', 'list'];

function parseArgs(argv) {
    const [verb, ...rest] = argv;
    if (!VERBS.includes(verb)) return { error: `Unknown or missing verb. ${USAGE}` };
    const allowed = verb === 'freeze' ? ['--todo', '--stories', '--reason'] : ['--todo', '--stories'];
    const values = {};
    for (let i = 0; i < rest.length; i += 2) {
        const flag = rest[i];
        const value = rest[i + 1];
        if (!allowed.includes(flag) || Object.hasOwn(values, flag)) return { error: `Unexpected argument ${JSON.stringify(clip(String(flag)))}. ${USAGE}` };
        if (typeof value !== 'string' || !value || value.startsWith('--')) return { error: `${flag} needs a value. ${USAGE}` };
        values[flag] = value;
    }
    if (!values['--todo'] || (!values['--stories'] && verb !== 'list')) return { error: `--todo and --stories are required. ${USAGE}` };
    return { verb, todo: values['--todo'], stories: values['--stories'] ? values['--stories'].split(',') : undefined, reason: values['--reason'] };
}

const VERB_FUNCTIONS = { run, red, freeze, check, unfreeze, list };

function main(argv = process.argv.slice(2)) {
    let result;
    try {
        const parsed = parseArgs(argv);
        if (parsed.error) result = failure([{ code: 'INVALID_ARGUMENTS', message: parsed.error }]);
        else {
            const root = path.resolve(resolveWorktreeRoot(process.cwd()));
            const opts = { root, todo: path.resolve(process.cwd(), parsed.todo), stories: parsed.stories, env: process.env };
            if (parsed.verb === 'freeze' && parsed.reason !== undefined) opts.reason = parsed.reason;
            result = VERB_FUNCTIONS[parsed.verb](opts);
        }
    } catch (error) {
        result = failure([{ code: 'EXCEPTION', message: `ac-verify failed: ${error && error.message ? error.message : String(error)}` }]);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : (result.exitCode || 1);
}

module.exports = { run, red, freeze, check, unfreeze, list, tokenizeVerify, refusalReason, childEnvironment, resolveHead, killProcessGroup, missingModuleDigest, main };
if (require.main === module) process.exitCode = main();
