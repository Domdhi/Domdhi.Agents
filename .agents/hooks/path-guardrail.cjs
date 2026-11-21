#!/usr/bin/env node

/**
 * Path Guardrail — PreToolUse:Write/Edit Hook
 *
 * Consumes the path-tier schema from `.claude/guardrail-rules.yaml`
 * (`zeroAccessPaths` / `readOnlyPaths` / `noDeletePaths` / `subagentReadOnlyPaths`)
 * and the freeze-state file at `docs/.output/.state/freeze-state.json` to gate
 * Write, Edit, MultiEdit and NotebookEdit tool calls BEFORE Claude executes them.
 * Companion to the existing PreToolUse:Bash guardrail
 * (`.claude/hooks/guardrail.cjs`), which gates Bash deletes and, for a subagent,
 * writes to the same protected set on a best-effort basis.
 *
 * `subagentReadOnlyPaths` applies only when the payload carries `agent_id`
 * (Claude Code sets it only when the hook fires inside a subagent): the gate, its
 * judges and their whole require() closure, the hooks, the guardrail rules and
 * settings, and the judge's evidence and state files are read-only to a subagent
 * and writable by the main thread. Any defined `agent_id` value counts, an empty
 * or non-string one included.
 *
 * What the wall does NOT cover (be honest about it):
 *   - It gates the four edit tools. Bash is only a best-effort layer in `guardrail.cjs`
 *     (redirects, `tee`, `cp`/`mv`, `sed -i`, `rm`, a write call in an inline script);
 *     an interpreter script, a variable-built path or a nested `claude -p` run is not
 *     caught. The backstop for those is the ship seal's code hash plus review.
 *   - A payload without `agent_id` is the main thread to this hook, so the tier is
 *     inert for headless main-thread runs (`claude -p`, scheduled runs), agent-team
 *     teammates and T3 threads that carry no `agent_id`, and for Codex payloads today.
 *   - Windows aliases (8.3 short names, trailing dots or spaces, alternate data
 *     streams) are refused for a subagent on win32 and the lookup uses the native
 *     realpath there; that path has not been executed on a Windows host.
 * When the rules file is missing, unusable, or parses without the tier key, a subagent
 * is held to the built-in copy of the shipped list (`guardrail-rules.js`) instead of
 * passing through.
 *
 * Exit codes (Claude Code semantics):
 *   0 = pass — proceed silently
 *   2 = blocked — hard stop (exit 1 is non-blocking in Claude Code)
 *
 * Failure mode: FAIL CLOSED. Any unexpected error — a dependency that cannot be
 * loaded (we cannot even tell the main thread from a subagent, so every payload
 * blocks), an unreadable or unparseable payload, a non-string target path, a path
 * that cannot be resolved, a freeze-state, rule-load or tier-check error, a stalled
 * run past the internal deadline — exits 2, because the target's tier cannot be
 * classified and a hook that fails open is a bypass. Only telemetry errors are
 * swallowed. A missing or malformed rules file is the one soft case: the main thread
 * passes (no tier to enforce), a subagent does not. The generated wrappers
 * (`.claude/hooks/`, `.codex/hooks/`) map any child status other than 0 to 2 and
 * bound the child with a timeout, because a hook that dies before it can exit 2
 * (a syntax error in a required module exits 1) would otherwise pass the write.
 */
'use strict';

const path = require('path');
const fs = require('fs');

// Every dependency loads inside one try: a load failure (a syntax error in a required
// module, a file missing after a half-applied update, a corrupted render) must exit 2,
// not die with the default status 1 that Claude Code treats as non-blocking. When this
// file is run as the hook, `main()` reports the failure and exits 2 for any payload;
// when it is required by a test or helper, the error is rethrown.
let readHookInput, loadRules, checkPathAccess, applySubagentDefaults, BUILTIN_SUBAGENT_READ_ONLY_PATHS;
let buildHookResponse, checkFreezeState, startHookTiming, emitHookEvent;
let loadError = null;
try {
    ({ readHookInput } = require('../core/_lib/hook-input'));
    ({ loadRules, checkPathAccess, applySubagentDefaults, BUILTIN_SUBAGENT_READ_ONLY_PATHS } = require('../core/_lib/guardrail-rules'));
    ({ buildHookResponse, checkFreezeState } = require('../core/_lib/command-blocker'));
    ({ startHookTiming, emitHookEvent } = require('../core/_lib/hook-telemetry'));
} catch (err) {
    loadError = err;
}

// 5000ms ceiling on the stdin read (blocking-hook parity). Env override exists
// ONLY so a fail-closed timeout test can shrink the wait for a real spawned
// process without changing production behavior — same pattern as
// secret-scanner.cjs's SECRET_SCANNER_STDIN_TIMEOUT_MS.
const STDIN_TIMEOUT_MS = parseInt(process.env.HOOK_STDIN_TIMEOUT_MS, 10) || 5000;

// Internal deadline for the whole run: past it the hook blocks (exit 2) instead of letting
// Claude Code's own hook timeout fire, which does not block. The timer covers an async stall
// (a wedged stdin read, a hung telemetry write). It cannot interrupt a SYNCHRONOUS stall (a
// filesystem call on a dead network mount blocks the event loop), so the generated wrapper
// also bounds this process with a spawn timeout and settings.json sets a hook timeout above
// both. Env override only so a test can shrink the wait, like the stdin timeout above.
const DEADLINE_MS = parseInt(process.env.HOOK_DEADLINE_MS, 10) || 8000;

// Tools whose tool_input includes a file path the guardrail should gate.
// Write / Edit / MultiEdit all use `tool_input.file_path`.
// NotebookEdit uses `tool_input.notebook_path` — see getTargetPath below.
const GATED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Extract the target file path from a parsed tool_input, accounting for the
 * NotebookEdit field-name divergence. Returns '' when no path is present.
 */
function getTargetPath(toolName, toolInput) {
    if (!toolInput) return '';
    if (toolName === 'NotebookEdit') return toolInput.notebook_path || '';
    return toolInput.file_path || '';
}

// ─── Path resolution ──────────────────────────────────────────────────────────

function getProjectRoot() {
    return process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
}

function resolveRulesPath() {
    return path.join(getProjectRoot(), '.claude', 'guardrail-rules.yaml');
}

/**
 * Resolve a tool-input path to a normalized absolute path (`..`, `.` and doubled
 * separators collapsed; relative paths anchored to the project root). Throws a
 * TypeError for a non-string — the caller turns any throw into a block.
 */
function resolveAbsPath(p) {
    if (typeof p !== 'string') throw new TypeError(`path must be a string, got ${p === null ? 'null' : typeof p}`);
    if (!p) return '';
    return path.resolve(getProjectRoot(), p);
}

const MAX_SYMLINK_HOPS = 40;

/**
 * `fs.realpathSync` on POSIX. On win32 the native implementation, which returns the on-disk
 * long name and case (the JS one keeps the spelling it was given), so `CLAUDE~1` and a
 * differently-cased name resolve to the real protected path.
 */
function realpath(p) {
    return process.platform === 'win32' ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

/**
 * Windows path-alias spellings that open a protected file without matching its name
 * lexically: a segment ending in a dot or a space (`settings.json.`), an alternate data
 * stream or other colon after the drive (`settings.json::$DATA`), an 8.3 short name
 * (`CLAUDE~1`), a wildcard or other character Windows refuses in a name. The `\\?\`,
 * `\\.\` and drive prefixes are stripped first, with the `UNC\` marker of an extended path. Pure
 * (takes the raw string), so it is testable on any platform; the caller applies it only to
 * a subagent on win32.
 *
 * @param {string} p  The tool-input path as given
 * @returns {boolean} true when the path uses an alias spelling
 */
function hasWindowsAliasSegment(p) {
    if (typeof p !== 'string') return false;
    let rest = p.replace(/^[\\/]{2}[?.][\\/]/, '');
    rest = rest.replace(/^UNC[\\/]/i, '');
    rest = rest.replace(/^[A-Za-z]:(?=$|[\\/])/, '');
    for (const segment of rest.split(/[\\/]+/)) {
        if (!segment || segment === '.' || segment === '..') continue;
        if (/[. ]$/.test(segment)) return true;
        if (/[:<>"|?*]/.test(segment)) return true;
        if (/~\d/.test(segment)) return true;
    }
    return false;
}

/**
 * `realpath` that also works for a path that does not exist yet: resolve the deepest
 * existing ancestor through the filesystem and re-append the missing tail. A dangling
 * symlink is followed to its target, because a write through it creates the target.
 * Throws on anything other than "does not exist" (a symlink loop, a permission error,
 * an invalid path) so the caller fails closed.
 */
function realpathLenient(absPath, hops = 0) {
    if (hops > MAX_SYMLINK_HOPS) throw new Error(`too many symlink levels resolving ${absPath}`);
    try {
        return realpath(absPath);
    } catch (err) {
        if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) throw err;
    }
    let isLink = false;
    try {
        isLink = fs.lstatSync(absPath).isSymbolicLink();
    } catch (err) {
        if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) throw err;
    }
    if (isLink) {
        // Dangling: realpath failed but the entry is a link. Follow it one hop and resolve its target.
        return realpathLenient(path.resolve(path.dirname(absPath), fs.readlinkSync(absPath)), hops + 1);
    }
    const parent = path.dirname(absPath);
    if (parent === absPath) return absPath;
    return path.join(realpathLenient(parent, hops), path.basename(absPath));
}

/**
 * The paths the tier checks run against: the normalized lexical path first, then its
 * filesystem-resolved form when that differs. The lexical form protects a symlinked
 * protected path (an adopter's `.claude/settings.json` link) by its name; the resolved
 * form catches an innocuous name that links INTO a protected path.
 */
function resolveCandidatePaths(targetPath) {
    const lexical = resolveAbsPath(targetPath);
    const real = realpathLenient(lexical);
    return real === lexical ? [lexical] : [lexical, real];
}

// ─── Event processor (testable core logic) ────────────────────────────────────

/**
 * Build the block result every fail-closed branch returns.
 */
function failClosed(toolName, targetPath, pattern) {
    const resp = buildHookResponse('block', {
        command: `${toolName} ${typeof targetPath === 'string' ? targetPath : JSON.stringify(targetPath)}`,
        pattern,
        tier: 'fail-closed',
    });
    return { block: true, feedback: resp.stderr };
}

/**
 * Process a parsed PreToolUse hook payload. Returns a block result or null.
 * Never throws: any exception while classifying the target becomes a block result,
 * so an unexpected error cannot reach the entry point's catch and pass the write.
 *
 * @param {object} parsedJson  Parsed hook payload — {tool_name, tool_input:{file_path}, agent_id?, agent_type?}
 * @returns {null | { block: true, feedback: string }}
 */
function processEvent(parsedJson) {
    let toolName = '';
    let targetPath = '';
    try {
        toolName = (parsedJson && parsedJson.tool_name) || '';
        if (!GATED_TOOLS.has(toolName)) return null;

        const toolInput = parsedJson.tool_input || {};
        targetPath = getTargetPath(toolName, toolInput);
        if (!targetPath) return null;

        return classify(parsedJson, toolName, toolInput, targetPath);
    } catch (err) {
        return failClosed(toolName, targetPath, `guardrail error (${(err && err.message) || 'unknown'}) — failing closed`);
    }
}

function classify(parsedJson, toolName, toolInput, targetPath) {
    // A non-string path (a number, an object) is not a file path: resolving it would
    // throw, and "cannot tell where this writes" must block, not pass.
    if (typeof targetPath !== 'string') {
        return failClosed(toolName, targetPath, 'tool path is not a string — failing closed');
    }

    // agent_id is present only when the hook fires inside a subagent. ANY defined value
    // marks one (checkPathAccess applies `!== undefined`), so it is passed through untouched.
    const context = { agentId: parsedJson.agent_id, agentType: parsedJson.agent_type };
    const isSubagent = context.agentId !== undefined;

    // A subagent on win32 does not get to use a Windows alias spelling of a path: the lexical
    // tier match cannot see through one, and no honest write needs one.
    if (isSubagent && process.platform === 'win32' && hasWindowsAliasSegment(targetPath)) {
        return failClosed(toolName, targetPath, 'Windows path alias (trailing dot or space, stream, short name) is not permitted for a subagent — failing closed');
    }
    const candidates = resolveCandidatePaths(targetPath);

    // 1. Freeze-state check (A2) — /investigate-locked paths.
    for (const candidate of candidates) {
        const freeze = checkFreezeState(candidate);
        if (freeze.blocked) {
            const resp = buildHookResponse('frozen', {
                command: `${toolName} ${targetPath}`,
                frozenPath: freeze.frozenPath,
            });
            return { block: true, feedback: resp.stderr };
        }
    }

    // 2. Path-tier check (A3). A missing/malformed rules file → emptyRules → every
    // tier empty, so the main thread passes through (the Bash hook's graceful posture).
    //
    // hooks-m3 — fail CLOSED on an UNEXPECTED error. `_lib/loadRules` is graceful
    // (missing/unreadable/malformed → emptyRules(), never throws), so the soft
    // tiers still pass through when rules are simply absent. Reaching a catch
    // here means a genuine surprise where we cannot classify the target's tier —
    // block rather than silently permit what could be a zeroAccessPaths write.
    let rules;
    try {
        rules = loadRules(resolveRulesPath());
    } catch {
        return failClosed(toolName, targetPath, 'guardrail rule-load error — failing closed');
    }

    // A subagent must not be freed by a missing or corrupt rules file, or by one that parses but
    // lacks the tier key: hold it to the built-in list unless the loaded rules carry the tier
    // (a key the project override lifted to empty is deliberate and is honored).
    if (isSubagent) rules = applySubagentDefaults(rules);

    const operation = toolInput.codex_operation === 'delete' ? 'delete' : 'write';
    for (const candidate of candidates) {
        let access;
        try {
            access = checkPathAccess(candidate, operation, rules, context);
        } catch {
            return failClosed(toolName, targetPath, 'guardrail tier-check error — failing closed');
        }
        if (!access.allowed) {
            const resp = buildHookResponse('block', {
                command: `${toolName} ${targetPath}`,
                pattern: access.reason || 'path-tier enforcement',
                tier: access.tier,
            });
            return { block: true, feedback: resp.stderr };
        }
    }

    return null;
}

// ─── Hook entry point ─────────────────────────────────────────────────────────

async function runClaudeHook() {
    if (loadError) {
        // We cannot read the payload with the broken helpers, so we cannot tell the main thread
        // from a subagent: block everything. A person repairs the install (re-render the toolkit).
        process.stderr.write('[path-guardrail] BLOCKED (fail-closed): could not load its dependencies — ' + (loadError && loadError.message) + '\n' +
            '[path-guardrail] Repair or re-render the toolkit (node .claude/core/render-shared-agents.js) outside this session; every write is blocked until then.\n');
        process.exit(2);
    }

    // Deadline watchdog: see DEADLINE_MS. unref'd so it never keeps the process alive.
    const watchdog = setTimeout(() => {
        try { process.stderr.write('[path-guardrail] BLOCKED (fail-closed): deadline of ' + DEADLINE_MS + 'ms exceeded.\n'); } catch { /* swallow */ }
        process.exit(2);
    }, DEADLINE_MS);
    watchdog.unref();

    const t = startHookTiming('path-guardrail');
    let outcome = 'success';

    try {
        // Fail CLOSED on a wedged/truncated stdin read or an unparseable non-empty
        // payload. Either means the Write/Edit target never arrived intact — the
        // graceful outer catch below (exit 0) would let it through with NO path-tier
        // enforcement, silently permitting what could be a zeroAccessPaths write.
        // Block instead, matching secret-scanner.cjs and the two Bash guards. A
        // clean `end` (even empty) still resolves, so a legitimate empty-stdin
        // invocation is unaffected. These blocks emit + exit BEFORE the outer catch
        // so the rejection is not reclassified as a graceful failure. (finding 2)
        let input;
        try {
            input = await readHookInput({ timeoutMs: STDIN_TIMEOUT_MS, failClosedOnTimeout: true });
        } catch (err) {
            outcome = 'blocked';
            process.stderr.write('[path-guardrail] BLOCKED (fail-closed): stdin read did not complete — ' + (err && err.message) + '\n');
            try { emitHookEvent(t, outcome); } catch { /* never crash on telemetry */ }
            process.exit(2);
        }
        if (!input.trim()) return;

        let data;
        try {
            data = JSON.parse(input);
        } catch {
            outcome = 'blocked';
            process.stderr.write('[path-guardrail] BLOCKED (fail-closed): could not parse stdin payload as JSON.\n');
            try { emitHookEvent(t, outcome); } catch { /* never crash on telemetry */ }
            process.exit(2);
        }

        // Valid JSON that is not an object (null, a number, an array) is not a hook payload.
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
            outcome = 'blocked';
            process.stderr.write('[path-guardrail] BLOCKED (fail-closed): stdin payload is not a JSON object.\n');
            try { emitHookEvent(t, outcome); } catch { /* never crash on telemetry */ }
            process.exit(2);
        }

        const result = processEvent(data);
        if (result && result.block) {
            outcome = 'blocked';
            process.stderr.write(result.feedback);
            try { emitHookEvent(t, outcome); } catch { /* never crash on telemetry */ }
            process.exit(2);
        }
    } catch (err) {
        // Fail CLOSED: processEvent never throws, so reaching here is a genuine surprise and the
        // write's tier is unknown. Exit 2 (a swallowed error exiting 0 is a bypass).
        outcome = 'failure';
        try { process.stderr.write(`[path-guardrail] BLOCKED (fail-closed): unexpected error — ${err && err.message}\n`); } catch { /* swallow */ }
        try { emitHookEvent(t, outcome); } catch { /* never crash on telemetry */ }
        process.exit(2);
    } finally {
        try { emitHookEvent(t, outcome); } catch { /* never crash on telemetry */ }
    }

    process.exit(0);
}

if (require.main === module) {
    runClaudeHook();
} else if (loadError) {
    // Required by a test or helper with a broken dependency: do not export a half-loaded hook.
    throw loadError;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    processEvent,
    resolveAbsPath,
    realpathLenient,
    hasWindowsAliasSegment,
    getTargetPath,
    GATED_TOOLS,
    BUILTIN_SUBAGENT_READ_ONLY_PATHS,
};
