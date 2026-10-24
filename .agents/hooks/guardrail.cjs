#!/usr/bin/env node
/**
 * Guardrail — PreToolUse:Bash / PreToolUse:PowerShell Hook
 *
 * Claude Code on Windows also offers a PowerShell tool; the settings adapter
 * registers this hook for both, and the decision reads only tool_input.command.
 *
 * Reads .claude/guardrail-rules.yaml and checks the incoming shell command
 * against configured rule sets before Claude executes it.
 *
 * ADVISORY, NOT AUTHORITATIVE: this hook is a best-effort speed-bump against a
 * confused/injected agent. Command surfaces are unbounded (alternate verbs,
 * encodings, subshells), so it cannot be a hard boundary. The Claude Code
 * permission system is the real gate; the fixes here (whitespace normalization,
 * chained-delete scanning, `..` traversal blocking, alternate-verb detection)
 * close the specific documented bypasses, not the whole class.
 *
 * Exit codes (Claude Code semantics):
 *   0 = pass — proceed silently
 *   0 + JSON permissionDecision:"ask" = confirm — user is prompted yes/no
 *   2 = blocked — hard stop (exit 1 is non-blocking in Claude Code)
 *
 * Implementation split (P2.3): Core YAML parsing, rule matching, and response
 * building live in three _lib modules. This file owns: stdin IO, env-based
 * path resolution, stderr warnings, commit-message sanitization, process.exit.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { readHookInput } = require('../core/_lib/hook-input');
const { parseYaml, stripComment } = require('../core/_lib/yaml-parser');
const { matchesPattern, evaluate, checkPathAccess, loadRules: libLoadRules } = require('../core/_lib/guardrail-rules');
const { buildHookResponse, checkFreezeState } = require('../core/_lib/command-blocker');
const { emitGuardrailHit } = require('../core/_lib/hook-telemetry');
const { splitCommandSegments, stripWrapperPrefix } = require('../core/_lib/shell-command-split');

// 5000ms ceiling on the stdin read (blocking-hook parity). Env override exists
// ONLY so a fail-closed timeout test can shrink the wait for a real spawned
// process without changing production behavior — same pattern as
// secret-scanner.cjs's SECRET_SCANNER_STDIN_TIMEOUT_MS.
const STDIN_TIMEOUT_MS = parseInt(process.env.HOOK_STDIN_TIMEOUT_MS, 10) || 5000;

// ─── Path resolution ──────────────────────────────────────────────────────────

function resolveRulesPath() {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
    return path.join(projectDir, '.claude', 'guardrail-rules.yaml');
}

// ─── Rule loader (hook-level: resolves path + stderr warnings) ────────────────

/**
 * Load rules from the configured path. Returns null when the file is missing
 * or unreadable — signals processEvent() to pass through with a stderr warn.
 * The _lib loadRules(yamlPath) is silent and returns emptyRules(); this wrapper
 * preserves the historical null = "warn + pass" behavior for the hook.
 *
 * W2-2: the FINAL ruleset is produced by delegating to the F12-validated
 * `_lib/guardrail-rules.loadRules`, so the per-tier regex-source validation +
 * loud fail-safe warning reach the live Bash guard (previously this hook
 * returned the raw parsed object, so a malformed `/regex/` in a pattern tier
 * silently no-op'd here — the whole point of F12 was lost at the one hook that
 * guards destructive commands). The hook-level guards below stay for the
 * null = "warn + pass-through" contract on missing/unreadable/malformed-YAML
 * and for the specific operator warnings `_lib` (silent) does not emit.
 *
 * @returns {object|null}
 */
function loadRules() {
    const rulesPath = resolveRulesPath();

    if (!fs.existsSync(rulesPath)) {
        process.stderr.write(
            '[guardrail] WARNING: guardrail-rules.yaml not found at ' + rulesPath + '\n' +
            '[guardrail] All commands will pass through until the rule file is created.\n'
        );
        return null;
    }

    let raw;
    try { raw = fs.readFileSync(rulesPath, 'utf8'); } catch (err) {
        process.stderr.write('[guardrail] WARNING: Could not read guardrail-rules.yaml: ' + err.message + '\n[guardrail] All commands will pass through.\n');
        return null;
    }

    let rules;
    try { rules = parseYaml(raw); } catch (err) {
        process.stderr.write('[guardrail] WARNING: Could not parse guardrail-rules.yaml: ' + err.message + '\n[guardrail] All commands will pass through.\n');
        return null;
    }

    // Validate rule arrays — a YAML authoring error can corrupt them to objects.
    // Fail safe and warn rather than silently passing all commands.
    for (const key of ['block_patterns', 'nudge_patterns', 'confirm_patterns']) {
        if (rules[key] !== undefined && !Array.isArray(rules[key])) {
            process.stderr.write(
                '[guardrail] WARNING: ' + key + ' in guardrail-rules.yaml is malformed (expected array, got ' + typeof rules[key] + ').\n' +
                '[guardrail] This may be caused by a colon in a list item. Check the rule file.\n' +
                '[guardrail] All commands will pass through until the file is corrected.\n'
            );
            return null;
        }
    }

    // Warn about the legacy path_rules block ONLY when the adopter still has
    // legacy entries AND has not migrated to the enforced four-tier schema
    // (zeroAccessPaths/readOnlyPaths/noDeletePaths). Once any four-tier list is
    // populated, the schema is in use and the legacy key is just redundant — so
    // the migration NOTICE would fire on every single Bash command for no
    // actionable reason. Gating on "unmigrated" keeps the hint where it helps
    // (truly pre-P2.5 configs) and silences the per-command noise everywhere
    // else. (2026-06-06 — noise gate)
    if (rules.path_rules && typeof rules.path_rules === 'object') {
        const legacyPopulated = Object.values(rules.path_rules).some(v => Array.isArray(v) && v.length > 0);
        const fourTierPopulated = ['zeroAccessPaths', 'readOnlyPaths', 'noDeletePaths']
            .some(k => Array.isArray(rules[k]) && rules[k].length > 0);
        if (legacyPopulated && !fourTierPopulated) {
            process.stderr.write(
                '[guardrail] NOTICE: path_rules is a legacy key preserved for backward compatibility and is not enforced.\n' +
                '[guardrail] Migrate entries to zeroAccessPaths / readOnlyPaths / noDeletePaths for enforcement (Bash: guardrail.cjs; Edit/Write: path-guardrail.cjs). See the YAML file header for details.\n'
            );
        }
    }

    // Delegate to the F12-validated _lib loader for the actual ruleset: it
    // re-reads + re-parses the same file, then per-tier regex-source-validates
    // dangerousPatterns/block/nudge/confirm (dropping only a malformed tier to
    // [] with a loud stderr warning) and returns emptyRules() fail-safe on any
    // structural problem. The double-read is a small YAML per Bash command —
    // negligible next to closing a silent guard-bypass. The hook-level checks
    // above (missing/unreadable/malformed → null pass-through + specific warn)
    // already ran, so we only reach here on a structurally-valid file.
    return libLoadRules(rulesPath);
}

// ─── Pattern matching (array variant — backward compat) ───────────────────────

/**
 * Match a command against a list of pattern strings. Returns the first
 * matching pattern or null. Delegates single-pattern logic to matchesPattern().
 *
 * @param {string} command    - Command to test
 * @param {string[]} patterns - Array of pattern strings
 * @returns {string|null}
 */
function matchPatterns(command, patterns) {
    if (!Array.isArray(patterns)) return null;
    for (const pattern of patterns) {
        if (matchesPattern(command, pattern)) return pattern;
    }
    return null;
}

// ─── Rule checker (backward compat wrapper over evaluate()) ──────────────────

/**
 * Check a command against all rule sets. Block patterns take precedence.
 *
 * @param {string} command - Sanitized command to check
 * @param {object} rules   - Parsed rules with block_patterns and confirm_patterns
 * @returns {{ action: 'block'|'nudge'|'confirm'|'allow', pattern?: string }}
 */
function checkRules(command, rules) {
    const result = evaluate(command, rules);
    if (result.decision === 'block') return { action: 'block', pattern: result.pattern };
    if (result.decision === 'nudge') return { action: 'nudge', pattern: result.pattern };
    if (result.decision === 'confirm') return { action: 'confirm', pattern: result.pattern };
    return { action: 'allow' };
}

// ─── Command sanitization ────────────────────────────────────────────────────

/**
 * Strip git commit message content before pattern matching. Without stripping,
 * a message like 'fix: prevent git push --force' false-positives on the block
 * pattern. Handles: -m "...", -m '...', heredoc -m "$(cat <<'EOF'...EOF)".
 *
 * F61 — DO NOT blank a command substitution ($(...) or backtick) that lives
 * inside a DOUBLE-QUOTED -m argument. Bash EXECUTES such a substitution, so
 * blanking it (the old wholesale `-m "…" → -m ""`) deleted a destructive payload
 * from the guardrail's view while bash still ran it — `echo -m "$(rm -rf .env)"`
 * sailed through. A double-quoted message that contains a substitution is now
 * left intact so the downstream path/pattern evaluation (and the `$(`/backtick
 * split in splitCommandSegments) still sees the real command.
 *
 * The known-benign `$(cat <<'EOF' … EOF)` heredoc form is a message-body carrier
 * (cat is not destructive), so it is still blanked FIRST — otherwise a heredoc
 * commit body would false-positive on a block phrase it merely quotes.
 *
 * SINGLE-quoted messages are always blanked: bash does NOT perform command
 * substitution inside single quotes, so `$(…)` there is inert literal text and
 * safe to strip. Unquoted bare tokens are only blanked when they carry no
 * substitution (same reasoning as double-quoted).
 */
function hasCommandSubstitution(s) {
    return /\$\(|`/.test(s);
}

function stripCommitMessages(command) {
    let result = command;
    // Heredoc message carrier $(cat <<EOF … EOF). M4: only blank it when the
    // delimiter is QUOTED (`<<'EOF'`) AND the body has no command substitution.
    // A QUOTED delimiter makes the body literal (bash performs no expansion in
    // it), so it is a safe, inert message carrier. An UNQUOTED delimiter
    // (`<<EOF`) expands the body — `$(rm -rf .env)` in it EXECUTES — so blanking
    // it would delete the destructive payload from the guardrail's view while
    // bash still runs it. Leave the unquoted form intact so the `$(` split in
    // splitCommandSegments reaches extractDeletePaths (the `hasCommandSubstitution`
    // guard on the double-quote rule below then also leaves it intact).
    result = result.replace(
        /-m\s*"\$\(cat\s*<<('?)EOF'?\s*\n([\s\S]*?)\nEOF\s*\)"/g,
        (m, q, body) => (q === "'" && !hasCommandSubstitution(body)) ? '-m ""' : m
    );
    // Double-quoted: blank ONLY when it holds no command substitution (F61).
    result = result.replace(/-m\s*"(?:[^"\\]|\\.)*"/g, (m) => hasCommandSubstitution(m) ? m : '-m ""');
    // Single-quoted: substitution is inert inside '…', so always safe to blank.
    result = result.replace(/-m\s*'[^']*'/g, "-m ''");
    // Unquoted bare token: blank unless it carries a substitution.
    result = result.replace(/-m\s+([^\s"'][^\s]*)/g, (m) => hasCommandSubstitution(m) ? m : '-m STRIPPED');
    return result;
}

// ─── Path extraction for delete-style commands (P2.5 — A3 routing) ───────────

// Command-boundary splitting is delegated to the shared _lib/shell-command-split
// module (imported as splitCommandSegments) — the single source of truth for
// both guard hooks. It splits on the classic metacharacters `&& || ; | & \n $(
// ` ( )` AND on the shell keyword statement-starts `then do else elif { }`, so a
// keyword-wrapped delete of a protected path (`if true; then rm -rf .env; fi`,
// `for i in 1; do rm -rf .env; done`) is segmented and thus still reaches the
// non-escalatable four-tier hard block — parity with the bare form (F62). The
// old local SHELL_SEPARATORS split only on metacharacters and let the keyword
// forms downgrade a zeroAccessPaths hard block to an escalatable nudge.

function tokenizeArgs(str) {
    const tokens = [];
    const tokenRe = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = tokenRe.exec(str)) !== null) {
        tokens.push(m[1] || m[2] || m[3]);
    }
    return tokens;
}

/**
 * Expose a segment's REAL verb head so the delete-verb regexes below see it no
 * matter how the invocation is wrapped or path-qualified. Two normalizations,
 * both required to close the finding-1 bypass class:
 *
 *   1. stripWrapperPrefix peels leading command wrappers (`sudo`, `env FOO=1`,
 *      bare `FOO=bar`, `nice -n10`, `nohup`, `time`, `xargs`) so the wrapper
 *      token is not mistaken for the head — `sudo rm -rf .env` → `rm -rf .env`.
 *   2. the FIRST token is basename-normalized (`headTok.split(/[\\/]/).pop()`)
 *      so a path-qualified binary matches the bare-verb regex — `/bin/rm -rf
 *      .env` → `rm -rf .env`, `/usr/bin/truncate -s0 .env` → `truncate …`.
 *
 * These two steps must ALTERNATE until the head stabilizes, not run once each.
 * A PATH-QUALIFIED WRAPPER (`/bin/sudo`, `/usr/bin/env`, `/usr/bin/nice`) is
 * invisible to stripWrapperPrefix on the first pass — its regexes anchor on the
 * bare wrapper name (`sudo`), not the path-qualified form — so a single
 * strip→basename left the head at `sudo`/`env`/`nice` and the delete-verb regex
 * never matched, silently downgrading a zeroAccessPaths hard block. Basenaming
 * `/bin/sudo` → `sudo` only helps if that bare wrapper is then re-fed to
 * stripWrapperPrefix; the loop does exactly that until neither step changes the
 * head (finding 1, full-review-260716 retry).
 *
 * This mirrors commit-guard.cjs gitCommitSegmentTail's basename treatment (R8):
 * both extractors consume splitCommandSegments output, so wrapper-stripping
 * composes identically here. PURE and never throws — stripWrapperPrefix is
 * guarded and the string ops are total (a bare token pops to itself), so the
 * guard stays fail-closed. The loop is bounded by convergence (each iteration
 * only ever shortens the head) plus a hard iteration cap as a belt-and-braces.
 *
 * @param {string} segment
 * @returns {string}
 */
function normalizeSegmentHead(segment) {
    let current = String(segment).trim();
    for (let i = 0; i < 16; i++) {
        const stripped = stripWrapperPrefix(current).trim();
        const m = stripped.match(/^(\S+)([\s\S]*)$/);
        const next = m ? m[1].split(/[\\/]/).pop() + m[2] : stripped;
        if (next === current) return current;
        current = next;
    }
    return current;
}

/**
 * Extract candidate path arguments from a delete-style shell command.
 *
 * Best-effort tokenization for `rm`, `rm -rf`, `del`, `unlink`, `Remove-Item`.
 * Returns path-like tokens (those with a `/` or `.` or trailing slash, OR
 * those that look like .env / .githooks / .eslintrc etc.). Callers resolve
 * these to absolute paths via CLAUDE_PROJECT_DIR before tier-checking.
 *
 * G1: scans EVERY command segment (split on shell separators), not just the
 * command start, so a chained/subshell delete is still tier-checked.
 *
 * @param {string} command
 * @returns {string[]}
 */
function extractDeletePaths(command) {
    if (!command || typeof command !== 'string') return [];
    const paths = [];
    for (const segment of splitCommandSegments(command)) {
        // Normalize wrappers + a path-qualified binary off the head so the verb
        // regex sees the real command — `sudo rm`, `FOO=1 rm`, `/bin/rm` all
        // reduce to `rm` (finding 1). Without this, a wrapper/path prefix
        // downgraded the non-escalatable zeroAccessPaths block to a nudge.
        let trimmed = normalizeSegmentHead(segment);
        // `cmd /c del .env` (or /k) runs the delete in cmd.exe: inspect the inner command.
        const viaCmd = trimmed.match(/^cmd(?:\.exe)?\s+\/[ck]\s+(.*)$/i);
        if (viaCmd) {
            // `cmd /c "del .env"`: one level of surrounding quotes wraps the inner command.
            const inner = viaCmd[1].trim();
            const quoted = /^(["'])(.*)\1$/.exec(inner);
            trimmed = normalizeSegmentHead(quoted ? quoted[2] : inner);
        }
        // Bash: rm [flags] args   |   Windows cmd: del/erase/rd/rmdir [flags] args
        // PowerShell: Remove-Item and its built-in aliases ri/rd/rmdir/erase/del/rm
        // (Claude Code's Windows PowerShell tool reaches this hook too)   |   POSIX: unlink path
        const match = trimmed.match(/^(rm|del|erase|unlink|Remove-Item|ri|rd|rmdir)\b\s+(.*)$/i);
        if (!match) continue;

        for (const t of tokenizeArgs(match[2])) {
            if (!t) continue;
            if (t.startsWith('-')) continue;
            if (t.startsWith('/') && !t.includes('/', 1) && t.length <= 5) continue; // short /flag
            paths.push(t);
        }
    }
    return paths;
}

/**
 * Extract candidate targets of ALTERNATE deletion/truncation verbs that the
 * `rm`-family extractor misses (G3 / M3). Covers `find … -delete`,
 * `find … -exec rm|unlink|shred|truncate`, `truncate`, `shred`, and output
 * redirection truncation (`> path`, `>> path`, `: > path`, `N> path`).
 *
 * Used ONLY by the four-tier path check, so a benign target (anything not in a
 * protected tier) is a no-op — only a protected/zeroAccess target (`.env`, a
 * read-only config) actually blocks. This closes the "choose a different tool"
 * bypass for protected paths without nudging every `find`/redirect in the repo.
 *
 * @param {string} command
 * @returns {string[]}
 */
function extractAltDeleteTargets(command) {
    if (!command || typeof command !== 'string') return [];
    const targets = [];
    const push = (t) => {
        if (!t) return;
        const clean = String(t).replace(/^["']|["']$/g, '');
        if (!clean || clean.startsWith('-') || clean.startsWith('&')) return;
        targets.push(clean);
    };

    for (const segment of splitCommandSegments(command)) {
        // Same head normalization as extractDeletePaths (finding 1): peel
        // wrappers + basename a path-qualified binary so `sudo truncate -s0
        // .env`, `env FOO=1 shred .env`, `/usr/bin/find … -delete` all expose
        // their real verb. Without it, `sudo truncate/shred` fully ALLOWED.
        const trimmed = normalizeSegmentHead(segment);

        // find … -delete   |   find … -exec rm|unlink|shred|truncate
        if (/^find\b/i.test(trimmed) && /(-delete\b|-exec\s+(rm|unlink|shred|truncate)\b)/i.test(trimmed)) {
            for (const tok of tokenizeArgs(trimmed)) {
                if (/^find$/i.test(tok)) continue;
                if (tok.startsWith('-')) continue;                     // -name, -type, -delete, -exec…
                if (tok === '+' || tok === ';' || tok === '\\;' || tok === '{}') continue; // -exec terminators
                if (/^(rm|unlink|shred|truncate)$/i.test(tok)) continue; // the exec'd verb
                push(tok);                                              // search root + -name/-path value
            }
            continue;
        }

        // truncate / shred — destructive single-file ops
        if (/^(truncate|shred)\b/i.test(trimmed)) {
            let first = true;
            for (const tok of tokenizeArgs(trimmed)) {
                if (first) { first = false; continue; } // the verb itself
                if (tok.startsWith('-')) continue;
                push(tok);
            }
            continue;
        }
    }

    // Output-redirection truncation anywhere in the command: `> path`, `>> path`,
    // `: > path`, `N> path`. The target group excludes `&` (so `2>&1` yields no
    // target) and shell separators.
    const redirRe = /\d*>>?\s*("[^"]*"|'[^']*'|[^\s;&|()<>]+)/g;
    let r;
    while ((r = redirRe.exec(command)) !== null) {
        const clean = String(r[1]).replace(/^["']|["']$/g, '');
        if (!clean || clean === '/dev/null') continue;
        push(clean);
    }

    return targets;
}

function resolveAbsPath(p) {
    if (!p) return '';
    if (path.isAbsolute(p)) return p;
    const root = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
    return path.resolve(root, p);
}

// ─── Coarse path classification for SAFE telemetry (C1) ──────────────────────
//
// SECRET SAFETY: this returns a BOUNDED enum string — never the raw path and
// never free text. It exists so guardrail-stats can answer "is rule X just
// noise on disposable paths?" WITHOUT ever logging the command (the
// hook-telemetry secret-safety contract at hook-telemetry.js:84-88 must hold).
//
// Returns null for non-delete commands (no first path to classify). Otherwise
// classifies ONLY the first extracted path token into one bounded class.
const PATH_CLASS_ENUM = Object.freeze({
    BUILD_ARTIFACT: 'build-artifact',
    TMP: 'tmp',
    NODE_MODULES: 'node_modules',
    OUTPUT_OR_VCS: 'output-or-vcs',
    HOME_OR_ROOT: 'home-or-root',
    PROJECT_PATH: 'project-path',
    UNKNOWN: 'unknown',
});

/**
 * Classify the FIRST path of a delete-style command into a bounded enum class.
 *
 * @param {string} command  The (already sanitized) shell command.
 * @returns {string|null}   One of PATH_CLASS_ENUM values, or null when the
 *                          command is not a delete-style command / has no path.
 */
// F63: `paths` is optional — processEvent extracts once and passes the result
// in, so the split+tokenize pass isn't redone here on every Bash call. The
// default keeps the one-arg form working for direct/test callers.
function classifyDeletePath(command, paths = extractDeletePaths(command)) {
    if (!paths.length) return null;

    // Normalize the first path: strip surrounding quotes, lowercase, use /.
    let p = String(paths[0]).trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
    if (!p) return PATH_CLASS_ENUM.UNKNOWN;
    const lower = p.toLowerCase();

    // home-or-root — `~`, `~/...`, or an absolute root path like `/`, `/etc`.
    // Checked first: a path starting at ~ or / is never a relative build dir.
    if (lower === '~' || lower.startsWith('~/') || lower.startsWith('~')) return PATH_CLASS_ENUM.HOME_OR_ROOT;
    if (lower === '/' || /^\/[a-z]/.test(lower)) {
        // Absolute path. /tmp and /var/folders/ are tmp; everything else rooted
        // at / is treated as a root-level (dangerous) path.
        if (lower === '/tmp' || lower.startsWith('/tmp/') || lower.startsWith('/var/folders/')) return PATH_CLASS_ENUM.TMP;
        return PATH_CLASS_ENUM.HOME_OR_ROOT;
    }

    // tmp — shell temp vars, mktemp, and relative tmp/ scratch dirs.
    if (lower.startsWith('$t') || lower.startsWith('${t') || lower === 'mktemp' || lower.startsWith('mktemp ')) return PATH_CLASS_ENUM.TMP;
    if (/^\.?\/?tmp(\/|$)/.test(lower)) return PATH_CLASS_ENUM.TMP;
    if (/(^|\/)\.sandbox(\/|$)/.test(lower)) return PATH_CLASS_ENUM.TMP;

    // node_modules — always reinstallable.
    if (/^\.?\/?node_modules(\/|$)/.test(lower)) return PATH_CLASS_ENUM.NODE_MODULES;

    // output-or-vcs — generated reports, git internals, live worktrees. These
    // are deliberately NOT exempt from the nudge, so flagging them as their own
    // class lets stats show they still (correctly) earn a hit.
    if (/^\.?\/?\.output(\/|$)/.test(lower)) return PATH_CLASS_ENUM.OUTPUT_OR_VCS;
    if (/^\.?\/?\.git(\/|$)/.test(lower)) return PATH_CLASS_ENUM.OUTPUT_OR_VCS;
    if (/^\.?\/?\.worktrees(\/|$)/.test(lower)) return PATH_CLASS_ENUM.OUTPUT_OR_VCS;

    // build-artifact — regenerable build/test output dirs.
    if (/^\.?\/?(bin|obj|dist|build|out|target|coverage|testresults|\.next)(\/|$)/.test(lower)) return PATH_CLASS_ENUM.BUILD_ARTIFACT;

    // project-path — any other relative path inside the repo (has a path-like
    // shape: a separator, a leading ./, or a plain name).
    if (lower.startsWith('./') || lower.includes('/') || /^[a-z0-9._-]+$/i.test(p)) return PATH_CLASS_ENUM.PROJECT_PATH;

    return PATH_CLASS_ENUM.UNKNOWN;
}

// ─── Event processor (testable core logic) ───────────────────────────────────

/**
 * Process a parsed hook payload and return an action result or null.
 * null = allow (no action needed).
 *
 * P2.5: after bash pattern evaluation, additionally routes delete-style
 * commands (rm / del / unlink / Remove-Item) through checkPathAccess() +
 * checkFreezeState() so `zeroAccessPaths` / `readOnlyPaths` / `noDeletePaths`
 * and frozen-investigation paths all enforce at the Bash boundary.
 *
 * @param {object} parsedJson - Parsed hook payload ({ tool_input: { command } })
 * @returns {null | { block: true, feedback: string } | { confirm: true, reason: string }}
 */
function processEvent(parsedJson) {
    const toolInput = (parsedJson && parsedJson.tool_input) || {};
    const command = (toolInput.command || '').trim();
    if (!command) return null;

    const sanitizedCommand = stripCommitMessages(command);
    const rules = loadRules();
    if (!rules) return null;

    const decision = checkRules(sanitizedCommand, rules);

    // Coarse, secret-safe path class for delete-style commands (C1). null for
    // non-delete commands; carried on the telemetry of delete-relevant branches.
    // F63: extract once — reused for the P2.5 delete-path enforcement below.
    const rawDeletePaths = extractDeletePaths(sanitizedCommand);
    const pathClass = classifyDeletePath(sanitizedCommand, rawDeletePaths);

    if (decision.action === 'block') {
        const resp = buildHookResponse('block', { command, pattern: decision.pattern });
        return { block: true, feedback: resp.stderr, telemetry: { decision: 'block', rule: decision.pattern, tier: null, pathClass } };
    }

    // P2.5 — four-tier path check for delete-style bash ops.
    // MUST run BEFORE the nudge/confirm decision: zeroAccessPaths (and a frozen
    // path) are HARD blocks that the nudge escalation marker can never override.
    // The nudge/confirm `rm`/`del`/`Remove-Item` patterns also match a protected
    // path (`rm -rf .env`), so if the nudge branch returned first, `rm -rf .env
    // # guardrail:confirm` would escalate a should-be-hard-block to a user-
    // approvable confirm — violating the "zero-access = all ops blocked"
    // invariant. Checking the path tier here keeps it non-escalatable. (sweep A1)
    const deletePaths = [
        ...rawDeletePaths, // F63: extracted once above
        ...extractAltDeleteTargets(sanitizedCommand),
    ];
    for (const p of deletePaths) {
        // G2 — path-traversal guard. A destructive target that walks upward via
        // a `..` segment either escapes the project root
        // (`dist/../../../../etc/passwd`) or launders a protected path behind an
        // allowlisted prefix (`node_modules/../.git` → PROJECT/.git). The nudge
        // allowlist matches the TEXTUAL prefix, so it would wave these through;
        // legitimate cleanup never deletes through `..`, so this is a hard,
        // non-escalatable block regardless of prefix. (M2 / G2)
        if (/(^|\/)\.\.(\/|$)/.test(String(p).replace(/\\/g, '/'))) {
            const resp = buildHookResponse('block', {
                command,
                pattern: 'delete via parent-directory traversal (`..`) is not permitted — run it manually if truly intended',
                tier: 'zeroAccessPaths',
            });
            return { block: true, feedback: resp.stderr, telemetry: { decision: 'block', rule: 'path-traversal', tier: 'zeroAccessPaths', pathClass } };
        }

        const absPath = resolveAbsPath(p);

        // Freeze-state check (A2)
        const freeze = checkFreezeState(absPath);
        if (freeze.blocked) {
            const resp = buildHookResponse('frozen', { command, frozenPath: freeze.frozenPath });
            return { block: true, feedback: resp.stderr, telemetry: { decision: 'block', rule: 'frozen-path', tier: 'frozen', pathClass } };
        }

        // Four-tier path check (A3)
        const access = checkPathAccess(absPath, 'delete', rules);
        if (!access.allowed) {
            const resp = buildHookResponse('block', {
                command,
                pattern: access.reason || 'path-tier enforcement',
                tier: access.tier,
            });
            return { block: true, feedback: resp.stderr, telemetry: { decision: 'block', rule: access.reason || 'path-tier enforcement', tier: access.tier || null, pathClass } };
        }
    }

    if (decision.action === 'nudge') {
        // Soft deny (exit 2) with an alternatives + escalation message. The agent
        // tries a reversible path first; if there is none, it re-runs with the
        // `# guardrail:confirm` marker, which evaluate() routes to a user confirm.
        const resp = buildHookResponse('nudge', { command, pattern: decision.pattern });
        return { block: true, feedback: resp.stderr, telemetry: { decision: 'nudge', rule: decision.pattern, tier: null, pathClass } };
    }
    if (decision.action === 'confirm') {
        return { confirm: true, reason: `Guardrail: "${decision.pattern}" — ${command}`, telemetry: { decision: 'confirm', rule: decision.pattern, tier: null, pathClass } };
    }

    return null;
}

// ─── Hook entry point ────────────────────────────────────────────────────────

async function runClaudeHook() {
    // Fail CLOSED on a wedged/truncated stdin read. A timeout or stream error
    // here means the payload never arrived intact — allowing (exit 0) would let
    // the destructive command this hook exists to scan proceed COMPLETELY
    // unscanned. Block instead, matching the processEvent-level catch below and
    // secret-scanner.cjs's posture. A clean `end` (even with empty data) still
    // resolves, so the legitimate empty-stdin case is unaffected. (finding 2)
    let input;
    try {
        input = await readHookInput({ timeoutMs: STDIN_TIMEOUT_MS, failClosedOnTimeout: true });
    } catch (err) {
        process.stderr.write('[guardrail] BLOCKED (fail-closed): stdin read did not complete — ' + (err && err.message) + '\n');
        process.exit(2);
    }
    if (!input.trim()) process.exit(0);

    let data;
    try {
        data = JSON.parse(input);
    } catch {
        // Fail CLOSED: non-empty stdin that will not parse is a truncated/garbled
        // payload whose command would otherwise proceed unscanned. Block.
        process.stderr.write('[guardrail] BLOCKED (fail-closed): could not parse stdin payload as JSON.\n');
        process.exit(2);
    }

    // n3 — fail CLOSED on an unexpected processEvent error. processEvent is
    // internally well-guarded (loadRules/evaluate/checkPathAccess all catch), so
    // a throw here is a should-never-happen; blocking (exit 2) rather than
    // passing through preserves the guardrail's safety posture on the surprise.
    let result;
    try {
        result = processEvent(data);
    } catch (err) {
        process.stderr.write('[guardrail] BLOCKED (fail-closed on unexpected error): ' + err.message + '\n');
        process.exit(2);
    }
    if (result === null) process.exit(0);

    // Count the hit. Best-effort + side-effect-free in processEvent (emitted here
    // at the entry point only) so unit tests of processEvent never write telemetry.
    if (result.telemetry) emitGuardrailHit(result.telemetry);

    if (result.block) {
        process.stderr.write(result.feedback);
        process.exit(2);
    }
    if (result.confirm) {
        const resp = buildHookResponse('confirm', { reason: result.reason });
        process.stdout.write(resp.stdout);
        process.exit(0);
    }
    process.exit(0);
}

if (require.main === module) { runClaudeHook(); }

// ─── Exports (backward compat) ───────────────────────────────────────────────

module.exports = {
    processEvent,
    parseYaml,           // re-exported from _lib/yaml-parser
    stripComment,        // re-exported from _lib/yaml-parser
    matchPatterns,       // array variant (takes patterns[], not single pattern)
    extractDeletePaths,       // rm-family delete targets across chained segments (G1)
    extractAltDeleteTargets,  // find/truncate/shred/redirect targets (G3)
    splitCommandSegments,     // shell-separator split used by both extractors
    stripCommitMessages,
    checkRules,          // backward compat wrapper over evaluate()
    loadRules,           // hook-level wrapper (resolves path, writes stderr warnings)
    classifyDeletePath,  // coarse, secret-safe path class for delete telemetry (C1)
    PATH_CLASS_ENUM,     // bounded enum of pathClass values (C1)
};
