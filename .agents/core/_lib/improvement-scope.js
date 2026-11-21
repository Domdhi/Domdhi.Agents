/**
 * improvement-scope — what an improvement run may and may not edit (SF-4.3).
 *
 * One declared scope so the optimizer can never edit its own judge:
 *
 *   - EDITABLE_GLOBS       what a run MAY touch: the target skill's directory.
 *   - the protected set    what no run may touch: the SF-1.8 `subagentReadOnlyPaths` tier
 *                          (READ from the rules yaml through `_lib/guardrail-rules.js`, never
 *                          re-declared here; PROTECTED_ADDITIONS holds only what the tier does not
 *                          already carry: tests, judge code, the whole skill-creator directory (the
 *                          loop's own driver), the project rules override).
 *
 * A path matched by both lists is protected. An otherwise editable path that is executable-shaped (under a `scripts/`
 * directory, or a shell/node/python/Windows script extension) is protected too: a candidate edits a skill's prose, it never
 * adds code an agent runs. A path matched by neither is outside the scope. The
 * static tier stops a subagent's Write/Edit; this module judges the DIFF afterwards, which also
 * covers Bash writes and the directory-shaped entries the tier cannot express (a `__tests__` directory at any depth).
 *
 * Fail closed: an unusable rules file, a malformed list, a bad path, a symlink on the path, a git
 * failure and an exception inside the check all refuse; none of them is ever read as "in scope".
 *
 * Exports (see the test header for the pinned contract):
 *   EDITABLE_GLOBS, PROTECTED_ADDITIONS, RESERVED_TARGETS
 *   loadProtectedSet({root?, rulesPath?, baseCommit?})       -> {tier, additions, globs}   (throws)
 *   classify(path, {root?, target?, rulesPath?})             -> {class, path, reason, matched?}
 *   assertDiffInScope(files, {target, root?, rulesPath?})    -> {ok, violations, error?}
 *   diffFromGit(base, {root?})                               -> [{status, path, from?, untracked?}]  (throws)
 *   snapshot({base, root?, rulesPath?})                      -> {ok, baseline?, error?}
 *   checkDiffInScope({base, target, root?, rulesPath?, baseline?}) -> {ok, violations, error?}
 *
 * CLI (exit 0 in scope, 1 refused, 2 invalid input / unusable rules / git failure; JSON on stdout):
 *   node improvement-scope.js snapshot --base <commit-id> [--root <dir>] [--rules <path>] [--out <file>]
 *   node improvement-scope.js check --base <commit-id> --target <skill> [--root <dir>] [--rules <path>] [--baseline <file>]
 *   node improvement-scope.js classify <path> [--target <skill>] [--root <dir>] [--rules <path>]
 *
 * CALLER CONTRACT (the apply helper, SF-4.9, and every later consumer):
 *   1. Record the base BEFORE the run: `git rev-parse HEAD` (a full 40- or 64-hex commit id). A branch
 *      name, tag or `HEAD` is refused: the run can advance it and the diff would then be empty.
 *   2. Run `snapshot --base <id> --out <file>` before the run and keep the file where the run cannot write
 *      (outside the judged tree: both verbs refuse a `--out` or `--baseline` path under `--root`, exit 2). It records the sha256 of every git-IGNORED file that classifies protected
 *      (gate receipts, the ship seal, the failure ledger, freeze state), the repo's risky config entries
 *      (filters, hooksPath, attributesFile, fsmonitor, includes), and the ignored nested repositories and
 *      ignore files already present. `check --baseline <file>` then tolerates what already existed and
 *      refuses what is new or changed. Without a baseline EVERY ignored protected
 *      file is a violation, so the check can only pass in a tree that holds none.
 *   3. Run the check from a TRUSTED COPY of this module and of `_lib/guardrail-rules.js` (the base commit's
 *      files, e.g. `git archive <id> .agents/core/_lib | tar -x -C <tmp>`, or a `git worktree add --detach`
 *      of the base). A run that rewrote this file would otherwise be judged by its own rewritten code. The
 *      subagent tier already stops a subagent's Write/Edit of the checker; a Bash write is not stopped by it.
 *   4. Judge BEFORE `render-shared-agents.js`: a rendered copy (`.claude/skills/{target}/**`, `.codex/...`,
 *      `.agents/render-state.json`) classifies `outside-scope` by design. Verify the render afterwards with
 *      `render-shared-agents.js --check`.
 *
 * What the git check does not trust (the run can write `.git`, so none of this is taken from it):
 *   - the protected rules are read from the BASE commit (`<id>:.agents/config/guardrail-rules.yaml`, then the
 *     rendered `.claude/` copy, plus the project override beside it), not the working tree, unless `rulesPath`
 *     is given (then the caller vouches for that file);
 *   - every git call runs with replace refs, system/global config, fsmonitor and the attributes file off,
 *     and `--no-ext-diff --no-textconv`; `.git/info/exclude` and `core.excludesFile` are never consulted
 *     (only the tree's `.gitignore` files hide an untracked file), so an excluded planted file is reported;
 *   - `git ls-files -v` must show tag `H` for every tracked file: assume-unchanged (`h`) and skip-worktree
 *     (`S`) hide an edit from `git diff` and are refused;
 *   - `refs/replace/*` is refused; a repo-local filter/hooksPath/attributesFile/fsmonitor/include entry (or an
 *     `info/attributes` carrying `filter=`) is refused unless the baseline already held it;
 *   - the bytes on disk of every tracked file that is not editable are compared with the base tree's blob
 *     (hashed here, not by `git diff`, so no clean filter can lie); a CRLF/LF difference alone is tolerated
 *     (core.autocrlf);
 *   - a nested repository (an untracked directory, a gitlink not in the base) is refused.
 *
 * Known limits:
 *   - `node_modules/` is ignored state. The installed version of every `package-lock.json` (v2/v3 `packages`)
 *     entry is compared with its `node_modules/<pkg>/package.json`; a package replaced by another version
 *     is refused. A patch that keeps the version number is NOT detected: run the judge from a pristine
 *     `npm ci` worktree when that matters.
 *   - A file mode change (chmod +x) is seen only through `git diff` (so only with core.fileMode on).
 *   - Ignored paths below an ignored directory are checked only when they classify protected; a `.git`
 *     inside an ignored directory is not looked for.
 *   - A tree edited concurrently by someone else during the run shows their edit as a violation.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadRules, globMatchesPath } = require('./guardrail-rules');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..', '..');

// The authored rules location first, then the rendered copy an adopter project carries.
const RULES_CANDIDATES = ['.agents/config/guardrail-rules.yaml', '.claude/guardrail-rules.yaml'];

// What a run may edit. `{target}` is the skill name; `**` crosses directories, `*` does not.
const EDITABLE_GLOBS = Object.freeze(['.agents/skills/{target}/**']);

// Skills that may never be an improvement target: skill-creator is the loop's own driver (the eval-loop
// procedure, the review viewer, the grading schema), so optimizing it is the optimizer editing its judge.
// verification-before-completion (the ship token), code-review (severity, the one-pass rule), run-todo and do (the
// workflows that wire the judge chain) carry the judge semantics themselves: an issue row that names one of them must
// reach a person, never an improvement run. They are RESERVED rather than only listed in the intake's protectedTargets
// because a reserved target is refused at every entry point (classify, check, assertDiffInScope) and intake routes a
// refused target to protectedTargets anyway; a list that only intake reads would leave the apply-time check open.
const RESERVED_TARGETS = Object.freeze(['skill-creator', 'verification-before-completion', 'code-review', 'run-todo', 'do']);

// What SF-4.3 adds to the SF-1.8 tier. Matched with `guardrail-rules.js globMatchesPath`: a trailing
// `/` is a segment-anchored directory, `*` matches within a segment, anything else is a path suffix
// (case-insensitive). Judge code and tests are deliberately NOT in the static yaml tier (SF-4.5/4.6/4.9/4.10
// edit the judge code and the Main Agent edits tests every wave), so this diff-scope check is what protects
// them. An entry the yaml tier already carries (`evals/`, `holdout/`, `tools/harness-eval-tasks/`) is NOT
// repeated here: a list defined twice drifts, and a project override `except:` would lift only one copy.
const PROTECTED_ADDITIONS = Object.freeze([
    // tests anywhere
    '__tests__/',
    '*.test.*',
    '*.spec.*',
    // judge code (authored and rendered copies share the `core/` suffix)
    'core/skill-eval.js',
    'core/skill-evolution.js',
    'core/skill-conformance.js',
    'core/_lib/improvement-scope.js',
    'tools/harness-eval.js',
    'tools/fast-tier-eval.cjs',
    // SF-4.6: the regression evaluator and its holdout fixtures (the proposer never sees or edits them)
    'tools/skill-regress.js',
    // tools/skill-holdout/ is protected through the subagent tier entry (guardrail-rules.yaml), not repeated here
    // skill-creator is the loop's own driver: its grader, comparator and analyzer prompts and scripts, the
    // review viewer, the grading schema and its procedure all decide what the loop accepts (authored and rendered copies)
    'skill-creator/',
    // the project-owned rules override can lift tier entries
    'guardrail-rules.project.yaml',
]);

// An accepted candidate may change a skill's prose, never add code that agents later run with Bash. So a path that is
// otherwise editable but is executable-shaped is protected: anything under a `scripts/` directory, and any file whose
// extension a shell, node, python or Windows host runs. This is a rule on EDITABLE paths, not a glob in
// PROTECTED_ADDITIONS: a global `*.js` glob would also reclassify unrelated code from `outside-scope` to `protected`,
// and the yaml tier already carries skill-creator's `scripts/`. Left editable on purpose: markdown, `.dot`,
// `.html`/`.svg` assets and data files (json, yaml): a skill's assets are read by people and the viewer, not run by an
// agent. Known limit: an extensionless script outside `scripts/` (a shebang file, or a mode change on an existing file)
// is not recognised by path alone.
const EXECUTABLE_EXTENSIONS = Object.freeze([
    '.js', '.cjs', '.mjs', '.ts', '.mts', '.cts', '.tsx', '.jsx',
    '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd', '.py', '.rb', '.pl',
]);

/** The rule that makes an editable path executable-shaped (`scripts/` or `*.ext`), or undefined. */
function executableMatch(rel) {
    const segments = rel.split('/');
    if (segments.slice(0, -1).some((segment) => segment.toLowerCase() === 'scripts')) return 'scripts/';
    const ext = path.posix.extname(segments[segments.length - 1]).toLowerCase();
    return EXECUTABLE_EXTENSIONS.includes(ext) ? `*${ext}` : undefined;
}

const TARGET_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const GIT_MAX_BUFFER = 512 * 1024 * 1024;
const COMMIT_ID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BASELINE_VERSION = 1;

// ─── small helpers ───────────────────────────────────────────────────────────

function safeText(value) {
    try {
        return typeof value === 'string' ? value : String(value);
    } catch {
        return '';
    }
}

function errorMessage(err) {
    return err && typeof err.message === 'string' ? err.message : safeText(err);
}

function isValidTarget(target) {
    return typeof target === 'string' && TARGET_RE.test(target);
}

const TARGET_ERROR = 'target must be a skill directory name (letters, digits, ".", "_", "-")';

/** The reason a target is unusable, or undefined when it is a valid, non-reserved skill name. */
function targetProblem(target) {
    if (!isValidTarget(target)) return TARGET_ERROR;
    if (RESERVED_TARGETS.includes(target.toLowerCase())) {
        return `target "${target}" is the improvement loop's own driver or part of its judge chain and is never an editable target`;
    }
    return undefined;
}

function escapeRegExp(text) {
    return text.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
}

function globToRegExp(glob, target) {
    const slot = target === undefined ? '[^/]+' : escapeRegExp(target);
    let out = '';
    let i = 0;
    while (i < glob.length) {
        if (glob.startsWith('{target}', i)) {
            out += slot;
            i += '{target}'.length;
        } else if (glob.startsWith('**', i)) {
            out += '.+';
            i += 2;
        } else if (glob[i] === '*') {
            out += '[^/]*';
            i += 1;
        } else {
            out += escapeRegExp(glob[i]);
            i += 1;
        }
    }
    return new RegExp(`^${out}$`);
}

function isEditable(rel, target) {
    return EDITABLE_GLOBS.some((glob) => globToRegExp(glob, target).test(rel));
}

function firstProtectedMatch(globs, rel) {
    for (const glob of globs) {
        if (globMatchesPath(glob, rel)) return glob;
    }
    return undefined;
}

function insideRelative(rel) {
    return rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel) && !/^[A-Za-z]:\//.test(rel);
}

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

// ─── the protected set ───────────────────────────────────────────────────────

function resolveRulesPath(root, rulesPath) {
    if (rulesPath !== undefined && rulesPath !== null) {
        if (typeof rulesPath !== 'string' || rulesPath.length === 0) {
            throw new Error('rulesPath must be a non-empty string');
        }
        return path.resolve(root, rulesPath);
    }
    for (const candidate of RULES_CANDIDATES) {
        const full = path.join(root, candidate);
        if (fs.existsSync(full)) return full;
    }
    throw new Error(`no guardrail rules file found under ${root} (looked for ${RULES_CANDIDATES.join(', ')})`);
}

function resolveRoot(root) {
    if (root === undefined || root === null) return DEFAULT_ROOT;
    if (typeof root !== 'string' || root.length === 0) throw new Error('root must be a non-empty string');
    return path.resolve(root);
}

/**
 * The rules file and its project override as committed at `baseId`, loaded through `loadRules` from a
 * temp copy (the loader reads the override beside the rules file). The working tree is never read.
 */
function loadRulesFromBase(root, baseId) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'improvement-scope-rules-'));
    try {
        let found;
        for (const candidate of RULES_CANDIDATES) {
            const blob = readBaseBlob(root, baseId, candidate);
            if (blob === null) continue;
            found = candidate;
            fs.writeFileSync(path.join(tmp, 'guardrail-rules.yaml'), blob);
            const override = readBaseBlob(root, baseId, `${path.posix.dirname(candidate)}/guardrail-rules.project.yaml`);
            if (override !== null) fs.writeFileSync(path.join(tmp, 'guardrail-rules.project.yaml'), override);
            break;
        }
        if (found === undefined) {
            throw new Error(`no guardrail rules file at commit ${baseId} (looked for ${RULES_CANDIDATES.join(', ')})`);
        }
        return { rules: loadRules(path.join(tmp, 'guardrail-rules.yaml')), label: `${baseId}:${found}` };
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

/** The SF-1.8 tier from loaded rules, validated. Throws on an unusable ruleset. */
function tierFromRules(rules, label) {
    if (!rules || rules.rulesParsed !== true) {
        throw new Error(`guardrail rules at ${label} are missing or unparseable`);
    }
    const tier = rules.subagentReadOnlyPaths;
    if (!Array.isArray(tier) || tier.length === 0) {
        throw new Error(`guardrail rules at ${label} carry no subagentReadOnlyPaths tier`);
    }
    // The minimal yaml parser reads a flow map or list ("{ a: b }", "[x, y]") or a `key: value` item as a
    // plain string, so a string check alone would accept a structure that is not a path glob.
    if (!tier.every((entry) => typeof entry === 'string' && entry.length > 0 && !/^[{[]|:\s/.test(entry))) {
        throw new Error(`guardrail rules at ${label} carry a malformed subagentReadOnlyPaths entry`);
    }
    return tier;
}

/**
 * The protected set: the SF-1.8 tier read from the rules yaml, plus PROTECTED_ADDITIONS.
 * Throws when the rules cannot be loaded; there is no hard-coded fallback.
 *
 * Where the rules come from: `rulesPath` when given; else, when `baseCommit` (a full commit id) is given,
 * the rules file committed at that commit (the working tree may be the run's own); else the working tree.
 */
function loadProtectedSet(options) {
    const o = options && typeof options === 'object' ? options : {};
    const root = resolveRoot(o.root);

    let rules;
    let label;
    if ((o.rulesPath === undefined || o.rulesPath === null) && o.baseCommit !== undefined) {
        const baseId = resolveBase(root, o.baseCommit);
        try {
            ({ rules, label } = loadRulesFromBase(root, baseId));
        } catch (err) {
            throw new Error(`guardrail rules at commit ${baseId} could not be loaded: ${errorMessage(err)}`);
        }
    } else {
        label = resolveRulesPath(root, o.rulesPath);
        try {
            rules = loadRules(label);
        } catch (err) {
            throw new Error(`guardrail rules at ${label} could not be loaded: ${errorMessage(err)}`);
        }
    }
    const tier = tierFromRules(rules, label);

    return {
        tier: [...tier],
        additions: [...PROTECTED_ADDITIONS],
        globs: [...new Set([...tier, ...PROTECTED_ADDITIONS])],
    };
}

/** Classification context: the root, the target and the loaded glob list. Throws like loadProtectedSet. */
function buildContext(options) {
    const o = options && typeof options === 'object' ? options : {};
    const root = resolveRoot(o.root);
    const set = loadProtectedSet({ root, rulesPath: o.rulesPath, baseCommit: o.baseCommit });
    let rootReal = root;
    try {
        rootReal = fs.realpathSync(root);
    } catch {
        // an unresolvable root keeps the lexical form; the symlink walk then fails closed on any lstat error
    }
    return { root, rootReal, globs: set.globs, target: o.target };
}

// ─── classification ──────────────────────────────────────────────────────────

/** Normalize to a repo-relative forward-slash path, or report that it resolves outside the repo. */
function normalizeInput(input, ctx) {
    const slashed = input.replace(/\\/g, '/');

    if (path.isAbsolute(slashed)) {
        for (const base of new Set([ctx.root, ctx.rootReal])) {
            const rel = path.relative(base, slashed).replace(/\\/g, '/');
            if (insideRelative(rel)) return { rel: rel === '' ? '.' : stripTrailingSlash(rel) };
        }
        return { outside: slashed };
    }

    const normalized = stripTrailingSlash(path.posix.normalize(slashed));
    if (normalized === '..' || normalized.startsWith('../')) return { outside: normalized };
    return { rel: normalized };
}

function stripTrailingSlash(p) {
    return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** True when any component of `rel` under the root is a symlink (a dangling one included). */
function containsSymlink(ctx, rel) {
    if (rel === '.') return false;
    let current = ctx.root;
    for (const segment of rel.split('/')) {
        current = path.join(current, segment);
        let stat;
        try {
            stat = fs.lstatSync(current);
        } catch (err) {
            if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return false;
            throw err;
        }
        if (stat.isSymbolicLink()) return true;
    }
    return false;
}

function classifyWith(ctx, input) {
    if (typeof input !== 'string') {
        return { class: 'protected', path: String(input), reason: 'invalid-path' };
    }
    if (input.trim().length === 0 || input.includes('\0')) {
        return { class: 'protected', path: input, reason: 'invalid-path' };
    }

    const norm = normalizeInput(input, ctx);
    if (norm.outside !== undefined) {
        return { class: 'outside', path: norm.outside, reason: 'outside-repo' };
    }
    const rel = norm.rel;

    // Protected wins over editable, so it is decided first.
    const matched = firstProtectedMatch(ctx.globs, rel);
    if (matched !== undefined) {
        return { class: 'protected', path: rel, reason: 'protected', matched };
    }
    if (containsSymlink(ctx, rel)) {
        return { class: 'protected', path: rel, reason: 'symlink' };
    }
    if (isEditable(rel, ctx.target)) {
        const executable = executableMatch(rel);
        if (executable !== undefined) return { class: 'protected', path: rel, reason: 'protected', matched: executable };
        return { class: 'editable', path: rel, reason: 'editable' };
    }
    return { class: 'outside', path: rel, reason: 'outside-scope' };
}

function classifyError(input, err) {
    return { class: 'protected', path: safeText(input), reason: 'classify-error', error: errorMessage(err) };
}

/** classifyWith that cannot throw: any exception is a protected `classify-error`. */
function judge(ctx, input) {
    try {
        return classifyWith(ctx, input);
    } catch (err) {
        return classifyError(input, err);
    }
}

/**
 * Classify one path. Never throws; every failure is class 'protected'.
 * @returns {{class: 'editable'|'protected'|'outside', path: string, reason: string, matched?: string, error?: string}}
 */
function classify(inputPath, options) {
    try {
        const o = options && typeof options === 'object' ? options : {};
        if (o.target !== undefined) {
            const problem = targetProblem(o.target);
            if (problem !== undefined) throw new Error(problem);
        }
        return classifyWith(buildContext(o), inputPath);
    } catch (err) {
        return classifyError(inputPath, err);
    }
}

// ─── diff judging ────────────────────────────────────────────────────────────

/** A path string or a git-shaped entry -> the inputs to judge (a rename or copy: both ends). */
function entryInputs(entry) {
    if (typeof entry === 'string') return [entry];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('entry must be a path string or a {status, path, from?} object');
    }
    const entryPath = entry.path;
    const status = entry.status;
    const from = entry.from;
    if (typeof entryPath !== 'string') throw new Error('entry has no usable path');
    if (status !== undefined && typeof status !== 'string') throw new Error('entry status must be a string');
    const needsFrom = typeof status === 'string' && (status[0] === 'R' || status[0] === 'C');
    if (from !== undefined && typeof from !== 'string') throw new Error('entry from must be a string');
    if (needsFrom && from === undefined) throw new Error(`a ${status} entry needs a from path`);
    return from === undefined ? [entryPath] : [from, entryPath];
}

function judgeEntries(files, ctx) {
    const violations = [];
    let error;
    files.forEach((entry, index) => {
        let inputs;
        try {
            inputs = entryInputs(entry);
        } catch (err) {
            if (error === undefined) error = `entry ${index}: ${errorMessage(err)}`;
            return;
        }
        for (const input of inputs) {
            const result = judge(ctx, input);
            if (result.class === 'editable') continue;
            const violation = { path: result.path, input, class: result.class, reason: result.reason };
            if (result.matched !== undefined) violation.matched = result.matched;
            if (result.error !== undefined) violation.error = result.error;
            violations.push(violation);
        }
    });
    const verdict = { ok: error === undefined && violations.length === 0, violations };
    if (error !== undefined) verdict.error = error;
    return verdict;
}

function refusal(error) {
    return { ok: false, violations: [], error };
}

/**
 * Is every path in the diff editable for `target`? Never throws.
 * @param {Array<string|{status?: string, path: string, from?: string}>} files
 */
function assertDiffInScope(files, options) {
    try {
        if (!Array.isArray(files)) return refusal('files must be an array of paths or {status, path, from?} entries');
        const o = options && typeof options === 'object' ? options : {};
        const problem = targetProblem(o.target);
        if (problem !== undefined) return refusal(problem);
        let ctx;
        try {
            ctx = buildContext(o);
        } catch (err) {
            return refusal(`protected set unavailable: ${errorMessage(err)}`);
        }
        return judgeEntries(files, ctx);
    } catch (err) {
        return refusal(`scope check failed: ${errorMessage(err)}`);
    }
}

// ─── git ─────────────────────────────────────────────────────────────────────

// Variables that redirect git to another repository, config, object store or diff driver. All stripped.
const GIT_REDIRECT_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|EXTERNAL_DIFF|REPLACE_REF_BASE|CONFIG|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|ATTR_SOURCE)$/;

function gitEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (GIT_REDIRECT_ENV.test(key)) delete env[key];
    }
    // The run being judged may have written the repo config, the global config and replace refs: read none of
    // the ones the run can influence beyond the repo's own `.git/config` (inspected separately, see configFindings).
    return {
        ...env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_TERMINAL_PROMPT: '0',
    };
}

function gitArgs(args) {
    // core.fsmonitor=false: the repo config is writable by the run being judged and must not run a hook.
    return ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', `core.attributesFile=${os.devNull}`, ...args];
}

function spawnGit(root, args, encoding) {
    const result = spawnSync('git', gitArgs(args), {
        cwd: root,
        encoding,
        windowsHide: true,
        maxBuffer: GIT_MAX_BUFFER,
        env: gitEnv(),
    });
    if (result.error) throw new Error(`git ${args[0]} could not run: ${errorMessage(result.error)}`);
    if (result.status !== 0) {
        throw new Error(`git ${args[0]} failed (exit ${result.status}): ${safeText(result.stderr).trim()}`);
    }
    return result.stdout;
}

/** Run read-only git in `root`; throws on a spawn error or a non-zero exit. */
function runGit(root, args) {
    return spawnGit(root, args, 'utf8');
}

/** runGit for binary output (a blob). */
function runGitBuffer(root, args) {
    return spawnGit(root, args, 'buffer');
}

function splitNul(text) {
    return text.split('\0').filter((token) => token.length > 0);
}

function parseNameStatus(text) {
    const tokens = splitNul(text);
    const entries = [];
    let i = 0;
    while (i < tokens.length) {
        const status = tokens[i++][0];
        if (status === 'R' || status === 'C') {
            const from = tokens[i++];
            const to = tokens[i++];
            if (from === undefined || to === undefined) throw new Error('git diff output ended inside a rename or copy entry');
            entries.push({ status, path: to, from });
        } else {
            const file = tokens[i++];
            if (file === undefined) throw new Error('git diff output ended after a status');
            entries.push({ status, path: file });
        }
    }
    return entries;
}

/**
 * A base that is a full commit id the repository really has. A branch, tag or `HEAD` is refused: the run
 * can advance it (commit onto it) and the diff would then be empty. Returns the id; throws otherwise.
 */
function resolveBase(root, base) {
    if (typeof base !== 'string' || !COMMIT_ID_RE.test(base)) {
        throw new Error('base must be a full 40- or 64-digit lowercase hex commit id recorded before the run (a branch, tag or HEAD can be advanced by the run)');
    }
    const resolved = runGit(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).trim();
    if (resolved !== base) throw new Error(`base ${base} is not a commit id (it resolves to ${resolved})`);
    return base;
}

/** The base tree as [{mode, type, oid, path}] (`git ls-tree -r`, replace refs ignored). */
function listBaseTree(root, baseId) {
    const entries = [];
    for (const token of splitNul(runGit(root, ['ls-tree', '-r', '-z', '--full-tree', baseId]))) {
        const tab = token.indexOf('\t');
        const [mode, type, oid] = token.slice(0, tab).split(' ');
        if (tab < 0 || oid === undefined) throw new Error('git ls-tree output was not understood');
        entries.push({ mode, type, oid, path: token.slice(tab + 1) });
    }
    return entries;
}

/** The blob of `rel` at `baseId`, or null when the commit has no such file. */
function readBaseBlob(root, baseId, rel) {
    const listing = splitNul(runGit(root, ['ls-tree', '-z', baseId, '--', rel]));
    if (listing.length === 0) return null;
    const tab = listing[0].indexOf('\t');
    const [, type, oid] = listing[0].slice(0, tab).split(' ');
    if (type !== 'blob' || oid === undefined) return null;
    return runGitBuffer(root, ['cat-file', 'blob', oid]);
}

/**
 * Everything changed since `base` in the working tree of `root`: committed, staged and unstaged
 * work (`git diff --name-status -z <base>`) plus untracked files (status 'A', untracked: true; an
 * untracked directory, which git reports for a nested repository, keeps its trailing `/`).
 * Only the tree's own `.gitignore` files hide an untracked file: `.git/info/exclude` and
 * `core.excludesFile` are the run's to write and are not consulted.
 * Throws on a git failure, a base that is not a full commit id, or a root
 * that is not the repository top level (git reports paths relative to the top level).
 */
function diffFromGit(base, options) {
    const o = options && typeof options === 'object' ? options : {};
    const root = resolveRoot(o.root);
    const baseId = resolveBase(root, base);

    const prefix = runGit(root, ['rev-parse', '--show-prefix']).trim();
    if (prefix !== '') throw new Error(`root ${root} is not the repository top level (inside ${prefix})`);

    const tracked = parseNameStatus(runGit(root, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', '--no-textconv', baseId, '--']));
    const untracked = splitNul(runGit(root, ['ls-files', '--others', '--exclude-per-directory=.gitignore', '-z']))
        .map((file) => ({ status: 'A', path: file, untracked: true }));
    return [...tracked, ...untracked];
}

/** True when a path has a `node_modules` segment: installed dependencies, not the repo's own files. */
function inNodeModules(file) {
    return file.split('/').includes('node_modules');
}

/** Files and directories git ignores through the tree's `.gitignore` files only, below any `node_modules`. */
function listIgnored(root) {
    const files = [];
    const dirs = [];
    for (const entry of splitNul(runGit(root, ['ls-files', '--others', '--ignored', '--exclude-per-directory=.gitignore', '-z']))) {
        if (inNodeModules(entry)) continue;
        if (entry.endsWith('/')) dirs.push(entry);
        else files.push(entry);
    }
    return { files, dirs };
}

/** sha256 of what is on disk at `rel`: file bytes, a symlink's target text, or a marker for anything else. */
function hashOnDisk(root, rel) {
    const full = path.join(root, rel);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return sha256(`symlink:${fs.readlinkSync(full)}`);
    if (stat.isFile()) return sha256(fs.readFileSync(full));
    return sha256('special');
}

/** {path: sha256} of every git-ignored file that classifies protected (`listIgnored` already skips installed dependencies). */
function ignoredProtectedHashes(ctx, ignoredFiles) {
    const out = {};
    for (const file of ignoredFiles) {
        if (firstProtectedMatch(ctx.globs, file) === undefined) continue;
        out[file] = hashOnDisk(ctx.root, file);
    }
    return out;
}

// ─── tamper detection (the run can write `.git`) ──────────────────────────────

/** Repo-local config entries that make git run code or rewrite content. */
const RISKY_CONFIG = [
    /^filter\..+\.(clean|smudge|process)$/i,
    /^core\.(hookspath|attributesfile|fsmonitor)$/i,
    /^include(if\..+)?\.path$/i,
    /^diff\.external$/i,
    /^diff\..+\.(textconv|command)$/i,
];

/** [{key, id}] for each risky repo-local config entry and a filter-carrying `info/attributes`; id = key=sha256(value). */
function configFindings(root) {
    const findings = [];
    const listing = runGit(root, ['config', '--local', '--list', '-z']);
    for (const token of splitNul(listing)) {
        const nl = token.indexOf('\n');
        const key = nl < 0 ? token : token.slice(0, nl);
        const value = nl < 0 ? '' : token.slice(nl + 1);
        if (RISKY_CONFIG.some((re) => re.test(key))) findings.push({ key, id: `${key}=${sha256(value)}` });
    }
    const commonDir = runGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    let attributes = null;
    try {
        attributes = fs.readFileSync(path.join(commonDir, 'info', 'attributes'), 'utf8');
    } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err;
    }
    if (attributes !== null && /\bfilter\s*=/.test(attributes)) {
        findings.push({ key: 'info/attributes', id: `info/attributes=${sha256(attributes)}` });
    }
    return findings;
}

function tamperViolation(p, reason, extra) {
    return { path: p, input: p, class: 'protected', reason, ...extra };
}

/** Tracked files whose `git ls-files -v` tag is not `H`: assume-unchanged (`h`) and skip-worktree (`S`) hide edits from git diff. */
function indexFlagViolations(root) {
    const out = [];
    for (const token of splitNul(runGit(root, ['ls-files', '-v', '-z']))) {
        const tag = token[0];
        if (tag !== 'H') out.push(tamperViolation(token.slice(2), 'index-flag', { tag }));
    }
    return out;
}

function replaceRefViolations(root) {
    return runGit(root, ['for-each-ref', '--format=%(refname)', 'refs/replace/'])
        .split('\n')
        .filter((line) => line.length > 0)
        .map((ref) => tamperViolation(ref, 'replace-ref'));
}

function configViolations(root, baseline) {
    const known = new Set(baseline ? baseline.config : []);
    return configFindings(root)
        .filter((finding) => !known.has(finding.id))
        .map((finding) => tamperViolation(`.git/config:${finding.key}`, 'git-config'));
}

/** Gitlinks (mode 160000) in the index that the base tree does not carry identically. */
function gitlinkViolations(root, baseTree) {
    const baseLinks = new Map(baseTree.filter((e) => e.mode === '160000').map((e) => [e.path, e.oid]));
    const out = [];
    for (const token of splitNul(runGit(root, ['ls-files', '-s', '-z']))) {
        const tab = token.indexOf('\t');
        const [mode, oid] = token.slice(0, tab).split(' ');
        const file = token.slice(tab + 1);
        if (mode === '160000' && baseLinks.get(file) !== oid) out.push(tamperViolation(file, 'nested-repo'));
    }
    return out;
}

/** An installed package whose version differs from package-lock.json (v2/v3 `packages`). See the header's limits. */
function nodeModulesViolations(root) {
    const lockPath = path.join(root, 'package-lock.json');
    if (!fs.existsSync(lockPath) || !fs.existsSync(path.join(root, 'node_modules'))) return [];
    let lock;
    try {
        lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch (err) {
        return [tamperViolation('package-lock.json', 'node-modules-unverifiable', { error: errorMessage(err) })];
    }
    const packages = lock && typeof lock.packages === 'object' && lock.packages !== null ? lock.packages : {};
    const out = [];
    for (const [key, entry] of Object.entries(packages)) {
        if (!key.startsWith('node_modules/') || !entry || entry.link === true || typeof entry.version !== 'string') continue;
        let installed;
        try {
            installed = JSON.parse(fs.readFileSync(path.join(root, key, 'package.json'), 'utf8')).version;
        } catch (err) {
            if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) continue;
            out.push(tamperViolation(key, 'node-modules-unverifiable', { error: errorMessage(err) }));
            continue;
        }
        if (installed !== entry.version) {
            out.push(tamperViolation(key, 'node-modules-drift', { locked: entry.version, installed: safeText(installed) }));
        }
    }
    return out;
}

/** git's blob id of `buf` (sha1 or sha256 by the length of `oid`), computed here so no git filter can alter it. */
function blobOid(buf, oid) {
    const hash = crypto.createHash(oid.length === 64 ? 'sha256' : 'sha1');
    hash.update(`blob ${buf.length}\0`);
    hash.update(buf);
    return hash.digest('hex');
}

function normalizeCrlf(buf) {
    return buf.toString('latin1').replace(/\r\n/g, '\n');
}

/**
 * Tracked files that are not editable, compared byte for byte with the base tree's blob. `git diff` trusts the
 * index flags, replace refs and clean filters; the bytes on disk do not. `covered` holds paths a diff entry
 * already names.
 */
function diskMismatchEntries(ctx, baseTree, baseId, covered) {
    const entries = [];
    for (const item of baseTree) {
        if (item.type !== 'blob' || covered.has(item.path)) continue;
        if (firstProtectedMatch(ctx.globs, item.path) === undefined && isEditable(item.path, ctx.target)) continue;
        const full = path.join(ctx.root, item.path);
        let stat;
        try {
            stat = fs.lstatSync(full);
        } catch (err) {
            if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
                entries.push({ status: 'D', path: item.path });
                continue;
            }
            throw err;
        }
        if (item.mode === '120000') {
            const same = stat.isSymbolicLink() && blobOid(Buffer.from(fs.readlinkSync(full)), item.oid) === item.oid;
            if (!same) entries.push({ status: 'M', path: item.path });
            continue;
        }
        if (stat.isSymbolicLink() || !stat.isFile()) {
            entries.push({ status: 'M', path: item.path });
            continue;
        }
        const bytes = fs.readFileSync(full);
        if (blobOid(bytes, item.oid) === item.oid) continue;
        // core.autocrlf legitimately changes line endings on disk; any other difference is an edit.
        const blob = runGitBuffer(ctx.root, ['cat-file', 'blob', item.oid]);
        if (normalizeCrlf(bytes) !== normalizeCrlf(blob)) entries.push({ status: 'M', path: item.path });
    }
    return entries;
}

// ─── baseline ────────────────────────────────────────────────────────────────

/** The ignored nested repositories and ignore files present now ({nestedRepos, ignoreFiles}): state a run did not make. */
function ignoredShape(root, ignored) {
    const ignoreFiles = {};
    for (const file of ignored.files.filter((f) => path.posix.basename(f) === '.gitignore')) {
        ignoreFiles[file] = hashOnDisk(root, file);
    }
    return { nestedRepos: [...ignored.dirs], ignoreFiles };
}

/**
 * Take the run-start baseline: the sha256 of every git-ignored protected file and the risky repo config
 * entries already present. Never throws.
 * @returns {{ok: true, baseline: {version: number, base: string, ignoredProtected: object, config: string[], nestedRepos: string[], ignoreFiles: object}} | {ok: false, error: string}}
 */
function snapshot(options) {
    try {
        const o = options && typeof options === 'object' ? options : {};
        const root = resolveRoot(o.root);
        const baseId = resolveBase(root, o.base);
        const ctx = buildContext({ root, rulesPath: o.rulesPath, baseCommit: baseId });
        const baseline = {
            version: BASELINE_VERSION,
            base: baseId,
            ignoredProtected: ignoredProtectedHashes(ctx, listIgnored(root).files),
            config: configFindings(root).map((finding) => finding.id),
            ...ignoredShape(root, listIgnored(root)),
        };
        return { ok: true, baseline };
    } catch (err) {
        return { ok: false, error: `snapshot failed: ${errorMessage(err)}` };
    }
}

/** A baseline object or the path of a baseline file -> a validated baseline bound to `baseId`. Throws. */
function resolveBaseline(input, baseId) {
    let baseline = input;
    if (typeof input === 'string') {
        try {
            baseline = JSON.parse(fs.readFileSync(input, 'utf8'));
        } catch (err) {
            throw new Error(`baseline ${input} could not be read: ${errorMessage(err)}`);
        }
    }
    const valid = baseline !== null && typeof baseline === 'object' && !Array.isArray(baseline)
        && baseline.version === BASELINE_VERSION
        && baseline.ignoredProtected !== null && typeof baseline.ignoredProtected === 'object' && !Array.isArray(baseline.ignoredProtected)
        && Object.values(baseline.ignoredProtected).every((hash) => typeof hash === 'string')
        && Array.isArray(baseline.config) && baseline.config.every((id) => typeof id === 'string')
        && Array.isArray(baseline.nestedRepos) && baseline.nestedRepos.every((dir) => typeof dir === 'string')
        && baseline.ignoreFiles !== null && typeof baseline.ignoreFiles === 'object' && !Array.isArray(baseline.ignoreFiles)
        && Object.values(baseline.ignoreFiles).every((hash) => typeof hash === 'string');
    if (!valid) throw new Error('baseline is malformed (expected the output of the snapshot verb)');
    if (baseline.base !== baseId) throw new Error(`baseline was taken at ${safeText(baseline.base)}, not at base ${baseId}`);
    return baseline;
}

/**
 * Ignored protected files that appeared or changed since the baseline, and baseline files that vanished.
 * Without a baseline every ignored protected file counts (an ignore rule must not hide a write).
 */
function ignoredProtectedEntries(ctx, ignoredFiles, baseline) {
    const current = ignoredProtectedHashes(ctx, ignoredFiles);
    const entries = [];
    for (const [file, hash] of Object.entries(current)) {
        if (baseline === undefined) {
            entries.push({ status: 'A', path: file, ignored: true });
        } else if (baseline.ignoredProtected[file] !== hash) {
            entries.push({ status: file in baseline.ignoredProtected ? 'M' : 'A', path: file, ignored: true });
        }
    }
    if (baseline !== undefined) {
        for (const file of Object.keys(baseline.ignoredProtected)) {
            if (!(file in current)) entries.push({ status: 'D', path: file, ignored: true });
        }
    }
    return entries;
}

// ─── the after-the-fact check ────────────────────────────────────────────────

/**
 * The after-the-fact check: judge every file changed since `base` (Bash writes included), then refuse any
 * sign that the diff itself was blinded (see the header). Never throws; a git failure, bad target or
 * unusable rules is `ok: false` with an `error`.
 */
function checkDiffInScope(options) {
    try {
        const o = options && typeof options === 'object' ? options : {};
        const problem = targetProblem(o.target);
        if (problem !== undefined) return refusal(problem);
        let ctx;
        let diff;
        let baseline;
        let extra;
        let more;
        try {
            const root = resolveRoot(o.root);
            const baseId = resolveBase(root, o.base);
            ctx = buildContext({ root, target: o.target, rulesPath: o.rulesPath, baseCommit: baseId });
            baseline = o.baseline === undefined ? undefined : resolveBaseline(o.baseline, baseId);
            diff = diffFromGit(baseId, { root });
            const baseTree = listBaseTree(root, baseId);
            const covered = new Set(diff.flatMap((entry) => (entry.from === undefined ? [entry.path] : [entry.path, entry.from])));
            const ignored = listIgnored(root);

            const knownNested = new Set(baseline ? baseline.nestedRepos : []);
            const knownIgnoreFiles = baseline ? baseline.ignoreFiles : {};
            const plantedIgnoreFiles = Object.keys(ignoredShape(root, ignored).ignoreFiles)
                .filter((file) => knownIgnoreFiles[file] !== hashOnDisk(root, file));

            extra = [
                ...indexFlagViolations(root),
                ...replaceRefViolations(root),
                ...configViolations(root, baseline),
                ...gitlinkViolations(root, baseTree),
                ...nodeModulesViolations(root),
                ...[...diff.filter((e) => e.untracked && e.path.endsWith('/')).map((e) => e.path), ...ignored.dirs.filter((dir) => !knownNested.has(dir))]
                    .map((dir) => tamperViolation(dir, 'nested-repo')),
                ...plantedIgnoreFiles.map((file) => tamperViolation(file, 'planted-ignore-file')),
            ];
            more = [
                ...diskMismatchEntries(ctx, baseTree, baseId, covered),
                ...ignoredProtectedEntries(ctx, ignored.files, baseline),
            ];
        } catch (err) {
            return refusal(`git: ${errorMessage(err)}`);
        }
        const verdict = judgeEntries([...diff.filter((e) => !e.path.endsWith('/')), ...more], ctx);
        if (extra.length > 0) {
            verdict.violations.push(...extra);
            verdict.ok = false;
        }
        return verdict;
    } catch (err) {
        return refusal(`scope check failed: ${errorMessage(err)}`);
    }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_INVALID = 2;
const FLAGS = new Set(['--base', '--target', '--root', '--rules', '--out', '--baseline']);

function parseArgs(argv) {
    const [verb, ...rest] = argv;
    const flags = {};
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
        const token = rest[i];
        if (token.startsWith('--')) {
            if (!FLAGS.has(token)) throw new Error(`unknown flag ${token}`);
            const value = rest[++i];
            if (value === undefined) throw new Error(`${token} needs a value`);
            flags[token.slice(2)] = value;
        } else {
            positional.push(token);
        }
    }
    return { verb, flags, positional };
}

function emit(result) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

function usageError(message) {
    emit({ ok: false, error: message });
    process.stderr.write(
        'usage: improvement-scope.js snapshot --base <commit-id> [--root <dir>] [--rules <path>] [--out <file>]\n' +
        '       improvement-scope.js check --base <commit-id> --target <skill> [--root <dir>] [--rules <path>] [--baseline <file>]\n' +
        '       improvement-scope.js classify <path> [--target <skill>] [--root <dir>] [--rules <path>]\n',
    );
    return EXIT_INVALID;
}

/** The deepest existing ancestor of `file` resolved through symlinks, with the not-yet-existing tail re-appended. */
function realPathOrAncestor(file) {
    let current = path.resolve(file);
    const tail = [];
    for (;;) {
        try {
            return path.join(fs.realpathSync(current), ...tail.reverse());
        } catch (err) {
            const parent = path.dirname(current);
            if (parent === current || !err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) return path.resolve(file);
            tail.push(path.basename(current));
            current = parent;
        }
    }
}

/** True when `file` (which may not exist yet) is the root or lies under it, after symlink resolution on both sides. */
function isUnderRoot(file, root) {
    const rel = path.relative(realPathOrAncestor(root), realPathOrAncestor(file)).replace(/\\/g, '/');
    return insideRelative(rel);
}

/** A usage error when the snapshot file would live inside the judged tree, where the run can write it. Null when fine. */
function baselineLocationProblem(flagName, file, rootOption) {
    const root = rootOption === undefined ? DEFAULT_ROOT : rootOption;
    if (!isUnderRoot(file, root)) return null;
    return `${flagName} ${file} is inside the judged tree (--root ${root}); keep the baseline where the run cannot write it, outside the repository`;
}

function scopeOptions(flags) {
    const options = {};
    if (flags.target !== undefined) options.target = flags.target;
    if (flags.root !== undefined) options.root = path.resolve(flags.root);
    if (flags.rules !== undefined) options.rulesPath = path.resolve(flags.rules);
    return options;
}

function runCli(argv) {
    let parsed;
    try {
        parsed = parseArgs(argv);
    } catch (err) {
        return usageError(errorMessage(err));
    }
    const { verb, flags, positional } = parsed;

    if (verb === 'snapshot') {
        if (positional.length > 0) return usageError('snapshot takes no positional arguments');
        if (flags.base === undefined) return usageError('snapshot needs --base <commit-id>');
        for (const flag of ['target', 'baseline']) {
            if (flags[flag] !== undefined) return usageError(`snapshot does not take --${flag}`);
        }
        const options = scopeOptions(flags);
        if (flags.out !== undefined) {
            const problem = baselineLocationProblem('--out', path.resolve(flags.out), options.root);
            if (problem !== null) return usageError(problem);
        }
        const result = snapshot({ ...options, base: flags.base });
        if (!result.ok) {
            emit(result);
            return EXIT_INVALID;
        }
        if (flags.out === undefined) {
            emit(result);
            return EXIT_OK;
        }
        try {
            fs.writeFileSync(path.resolve(flags.out), `${JSON.stringify(result.baseline, null, 2)}\n`, { mode: 0o600 });
        } catch (err) {
            emit({ ok: false, error: `baseline could not be written: ${errorMessage(err)}` });
            return EXIT_INVALID;
        }
        emit({ ok: true, out: path.resolve(flags.out), ignoredProtected: Object.keys(result.baseline.ignoredProtected).length });
        return EXIT_OK;
    }

    if (verb === 'check') {
        if (positional.length > 0) return usageError('check takes no positional arguments');
        if (flags.base === undefined) return usageError('check needs --base <commit-id>');
        if (flags.target === undefined) return usageError('check needs --target <skill>');
        if (flags.out !== undefined) return usageError('check does not take --out');
        const options = { ...scopeOptions(flags), base: flags.base };
        if (flags.baseline !== undefined) {
            options.baseline = path.resolve(flags.baseline);
            const problem = baselineLocationProblem('--baseline', options.baseline, options.root);
            if (problem !== null) return usageError(problem);
        }
        const result = checkDiffInScope(options);
        emit(result);
        if (result.error !== undefined) return EXIT_INVALID;
        return result.ok ? EXIT_OK : EXIT_REFUSED;
    }

    if (verb === 'classify') {
        if (positional.length !== 1) return usageError('classify needs exactly one <path>');
        if (flags.base !== undefined) return usageError('classify does not take --base');
        for (const flag of ['out', 'baseline']) {
            if (flags[flag] !== undefined) return usageError(`classify does not take --${flag}`);
        }
        const options = scopeOptions(flags);
        if (options.target !== undefined) {
            const problem = targetProblem(options.target);
            if (problem !== undefined) return usageError(problem);
        }
        try {
            loadProtectedSet(options);
        } catch (err) {
            return usageError(`protected set unavailable: ${errorMessage(err)}`);
        }
        const result = classify(positional[0], options);
        emit(result);
        if (result.reason === 'invalid-path' || result.reason === 'classify-error') return EXIT_INVALID;
        return result.class === 'editable' ? EXIT_OK : EXIT_REFUSED;
    }

    return usageError(verb === undefined ? 'a verb is required (snapshot | check | classify)' : `unknown verb ${verb}`);
}

module.exports = {
    EDITABLE_GLOBS,
    PROTECTED_ADDITIONS,
    RESERVED_TARGETS,
    loadProtectedSet,
    classify,
    assertDiffInScope,
    diffFromGit,
    snapshot,
    checkDiffInScope,
};

if (require.main === module) {
    let code;
    try {
        code = runCli(process.argv.slice(2));
    } catch (err) {
        process.stderr.write(`improvement-scope: ${errorMessage(err)}\n`);
        code = EXIT_INVALID;
    }
    process.exitCode = code;
}
