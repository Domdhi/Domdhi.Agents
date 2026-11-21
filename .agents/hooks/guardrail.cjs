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
 * Subagents (a payload that carries `agent_id`) additionally get a BEST-EFFORT check of
 * the commands that write: `rm`-family deletes, redirects, `tee`, the destination of
 * `cp`/`mv`/`install`/`ln`/`rsync`, `dd of=`, `sed -i`/`perl -i`/`awk -i inplace` targets,
 * `git restore`/`checkout`/`rm`/`mv` operands, the `tar -C`/`unzip -d` extraction directory, and
 * the path literals of an inline `node -e`/`python -c` script that calls a write API, are
 * checked against the same `subagentReadOnlyPaths` tier as the Write/Edit hook
 * (`path-guardrail.cjs`). `patch`, `git apply` and `git am` are refused unless the patch file
 * can be read and none of its target files is in the tier (a patch from stdin is refused: the
 * Main Agent applies patches). Relative targets resolve against the payload `cwd` and every
 * `cd`/`pushd` earlier in the command, and `git -C dir` adds that directory; a `cd` into an
 * existing directory outside the project makes later relative targets non-project paths (not
 * checked). That is NOT a wall: an interpreter script, a path built from a
 * variable, a symlink, or a nested `claude -p` / `codex exec` run (a new main thread with no
 * `agent_id`) writes anywhere. The real backstop is the ship seal's code hash, which covers
 * the code tree including the hooks, plus review of the diff.
 *
 * Exit codes (Claude Code semantics):
 *   0 = pass — proceed silently
 *   0 + JSON permissionDecision:"ask" = confirm — user is prompted yes/no
 *   2 = blocked — hard stop (exit 1 is non-blocking in Claude Code)
 *
 * Fail closed on a load failure: the dependencies load inside a try, and a failure exits 2
 * for every payload (the hook cannot tell the main thread from a subagent without them),
 * because a crash at load time would otherwise exit 1, which does not block.
 *
 * Implementation split (P2.3): Core YAML parsing, rule matching, and response
 * building live in three _lib modules. This file owns: stdin IO, env-based
 * path resolution, stderr warnings, commit-message sanitization, process.exit.
 */
'use strict';

const path = require('path');
const fs = require('fs');

// Dependencies load inside one try: a load failure must exit 2, not die with status 1
// (non-blocking in Claude Code). Run as the hook, `runClaudeHook` reports it and exits 2;
// required by a test or helper, the error is rethrown at the bottom of this file.
let readHookInput, parseYaml, stripComment, matchesPattern, evaluate, checkPathAccess, libLoadRules, applySubagentDefaults;
let buildHookResponse, checkFreezeState, emitGuardrailHit, splitCommandSegments, stripWrapperPrefix;
let loadError = null;
try {
    ({ readHookInput } = require('../core/_lib/hook-input'));
    ({ parseYaml, stripComment } = require('../core/_lib/yaml-parser'));
    ({ matchesPattern, evaluate, checkPathAccess, loadRules: libLoadRules, applySubagentDefaults } = require('../core/_lib/guardrail-rules'));
    ({ buildHookResponse, checkFreezeState } = require('../core/_lib/command-blocker'));
    ({ emitGuardrailHit } = require('../core/_lib/hook-telemetry'));
    ({ splitCommandSegments, stripWrapperPrefix } = require('../core/_lib/shell-command-split'));
} catch (err) {
    loadError = err;
}

// 5000ms ceiling on the stdin read (blocking-hook parity). Env override exists
// ONLY so a fail-closed timeout test can shrink the wait for a real spawned
// process without changing production behavior — same pattern as
// secret-scanner.cjs's SECRET_SCANNER_STDIN_TIMEOUT_MS.
const STDIN_TIMEOUT_MS = parseInt(process.env.HOOK_STDIN_TIMEOUT_MS, 10) || 5000;

// Internal deadline for the whole run (see path-guardrail.cjs DEADLINE_MS): past it the hook
// blocks instead of letting Claude Code's non-blocking hook timeout fire. A timer cannot
// interrupt a synchronous stall; the generated wrapper's spawn timeout bounds that.
const DEADLINE_MS = parseInt(process.env.HOOK_DEADLINE_MS, 10) || 8000;

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
        // An empty quoted argument ("" or '') is a real, empty argument: keep it as '' (the
        // old `m[1] || m[2] || m[3]` pushed undefined and every string method downstream threw).
        tokens.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
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
                if (typeof tok !== 'string') continue;
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
                if (typeof tok !== 'string' || tok.startsWith('-')) continue;
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

function projectRoot() {
    return process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
}

// ─── Working-directory tracking (M3) ─────────────────────────────────────────
//
// A relative target is relative to the directory the command runs in, not to the project root:
// `cd .agents/hooks && sed -i s/a/b/ guardrail.cjs` edits the hook. The payload `cwd` is the
// starting directory (the project root is always tried too, as before); each `cd`/`pushd` earlier
// in the command moves it for the later segments (`popd` returns to any directory seen so far).
// The tracking over-approximates on purpose, like the write extractors: a `cd` into a directory
// that does not exist yet keeps BOTH the old and the new directory (the `cd` may fail, or an
// earlier `mkdir` may create it), and `cd` to a variable-built path is not followed (a documented
// limit). A `cd` into an EXISTING directory outside the project moves the command out of the
// project: its later relative targets are not project paths and are not checked (a symlink is
// resolved first, so a link into the project still counts).

function realDirectory(dir) {
    try {
        const real = fs.realpathSync(dir);
        return fs.statSync(real).isDirectory() ? real : null;
    } catch {
        return null;
    }
}

/** Starting directories: the payload cwd (when absolute) and the project root. */
function baseDirectories(payloadCwd) {
    const root = path.resolve(projectRoot());
    const dirs = [];
    if (typeof payloadCwd === 'string' && path.isAbsolute(payloadCwd)) dirs.push(path.resolve(payloadCwd));
    if (!dirs.includes(root)) dirs.push(root);
    return dirs;
}

/**
 * The directory change a segment performs: `{ kind: 'cd'|'popd', target? }`, or null.
 * `cd` with no operand goes home; `pushd -n` does not change directory; `cd -` and a target
 * built from a variable are returned with an unusable target (the caller leaves the directories alone).
 *
 * @param {string} segment
 * @returns {{kind: string, target?: string}|null}
 */
function parseDirChange(segment) {
    const trimmed = normalizeSegmentHead(segment);
    const m = trimmed.match(/^(\S+)\s*([\s\S]*)$/);
    if (!m) return null;
    const verb = basenameOf(m[1]).toLowerCase();
    if (verb === 'popd') return { kind: 'popd' };
    if (!['cd', 'chdir', 'pushd', 'set-location', 'sl'].includes(verb)) return null;
    const tokens = tokenizeArgs(m[2]);
    if (verb === 'pushd' && tokens.includes('-n')) return null;
    const operands = [];
    let optionsEnded = false;
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (typeof t !== 'string') continue;
        if (!optionsEnded && /^-(path|literalpath)$/i.test(t)) { if (typeof tokens[i + 1] === 'string') operands.push(tokens[i + 1]); i++; continue; }
        if (!optionsEnded && t === '--') { optionsEnded = true; continue; }
        if (!optionsEnded && t.startsWith('-') && t.length > 1) continue; // -P, -L, -e, -@ ...
        operands.push(t);
    }
    return { kind: 'cd', target: operands[0] };
}

function applyDirChange(dirs, change, allDirs) {
    if (change.kind === 'popd') return Array.from(allDirs);
    let target = change.target;
    if (target === undefined) target = '~';
    if (target === '-' || target === '' || /[$`*?]/.test(target)) return dirs; // unknown destination
    if (target === '~' || target.startsWith('~/')) target = path.join(process.env.HOME || require('os').homedir(), target.slice(1));
    const next = [];
    const add = (d) => { if (!next.includes(d)) next.push(d); };
    for (const current of dirs) {
        const resolved = path.resolve(current, target);
        const real = realDirectory(resolved);
        if (real) add(real);
        else { add(resolved); add(current); }
    }
    return next;
}

/**
 * Split a command into ordered segments, each with the directories it may run in. A command with
 * no directory change is ONE step over the whole text (the same extraction as before).
 *
 * @param {string} command
 * @param {string[]} baseDirs
 * @returns {{ steps: {text: string, dirs: string[]}[], allDirs: string[], changed: boolean }}
 */
function planCommand(command, baseDirs) {
    const single = { steps: [{ text: command, dirs: baseDirs }], allDirs: baseDirs, changed: false };
    if (typeof command !== 'string' || !command) return single;
    const all = new Set(baseDirs);
    const steps = [];
    let dirs = baseDirs.slice();
    let changed = false;
    for (const segment of splitQuoteAware(command)) {
        steps.push({ text: segment, dirs });
        const change = parseDirChange(segment);
        if (!change) continue;
        changed = true;
        dirs = applyDirChange(dirs, change, all);
        for (const d of dirs) all.add(d);
    }
    return changed ? { steps, allDirs: Array.from(all), changed } : single;
}

function insideProject(abs, baseDirs) {
    const roots = new Set(baseDirs);
    for (const d of baseDirs) { try { roots.add(fs.realpathSync(d)); } catch { /* not on disk */ } }
    for (const r of roots) {
        const rel = path.relative(r, abs);
        if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
    }
    return false;
}

/**
 * The absolute spellings of one candidate path: itself when absolute, else once per directory the
 * command may run in. After a `cd`, a directory outside the project (and outside the payload cwd)
 * yields a path that is not a project path, so it is dropped.
 */
function resolveCandidates(p, dirs, baseDirs, changed) {
    if (typeof p !== 'string' || !p) return [];
    if (path.isAbsolute(p)) return [p];
    const out = [];
    for (const d of dirs) {
        const abs = path.resolve(d, p);
        if (changed && !baseDirs.includes(d) && !insideProject(abs, baseDirs)) continue;
        if (!out.includes(abs)) out.push(abs);
    }
    return out;
}

/** Run an extractor over every step; pair each raw candidate with its absolute spellings. */
function collectTargets(plan, baseDirs, extractor) {
    const out = [];
    for (const step of plan.steps) {
        for (const p of extractor(step.text)) {
            if (typeof p !== 'string' || !p) continue;
            out.push({ p, abs: resolveCandidates(p, step.dirs, baseDirs, plan.changed) });
        }
    }
    return out;
}

// ─── Best-effort write targets for a SUBAGENT (SF-1.8) ───────────────────────
//
// The Write/Edit hook is the wall; these extractors only make the common Bash spellings
// of the same write hit the same tier. They over-approximate on purpose (every operand
// of `sed -i` is a candidate, a copy's destination is also tried as a directory): a
// candidate only blocks when it matches a protected entry, so a benign operand is a no-op.

const COPY_LIKE_VERBS = new Set(['cp', 'install', 'ln', 'rsync', 'mv']);
// Verbs whose flag set marks an in-place edit of the file operands.
const INPLACE_FLAG = /^-[A-Za-z]*i/;
const INTERPRETER_HEAD = /(^|[\s;&|(`'"=/\\])(node|nodejs|python[0-9.]*|py|ruby|perl|php|deno|bun|pwsh|powershell)(\.exe)?\s+/i;
const INLINE_CODE_FLAG = /\s(-e|-c|-p|--eval|--print|-command)\b/i;
// A write API in an inline script: a call or an open for writing.
const WRITE_API = /(write|append|copyfile|copy2?\b|rename|unlink|rmsync|\.rm\(|truncate|createwritestream|symlink|shutil|os\.remove|os\.replace|set-content|out-file|add-content|\bcp\b|\bmv\b|\btee\b|open\([^)]*['"][wa]\+?b?['"])/i;

// The shared segment splitter cuts at every parenthesis, quoted or not, which severs the file
// operand from a quoted script that contains one (`sed -i 's/exit(2)/exit(0)/' gate.js` splits
// into `sed -i 's/exit`, `2`, `/exit`, `0`, `/' gate.js`). For the write extractor, shell
// metacharacters inside a quoted span are masked before the split and restored after it. A
// double-quoted span that holds an executing substitution (`$(` or a backtick) is left alone,
// so a command hidden in one is still split out.
const MASKED = { ';': '\uE001', '&': '\uE002', '|': '\uE003', '(': '\uE004', ')': '\uE005', '{': '\uE006', '}': '\uE007', '\n': '\uE008' };
const UNMASKED = Object.fromEntries(Object.entries(MASKED).map(([plain, masked]) => [masked, plain]));

function splitQuoteAware(command) {
    const masked = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (span) => {
        if (span[0] === '"' && /\$\(|`/.test(span)) return span;
        return span.replace(/[;&|(){}\n]/g, (c) => MASKED[c]);
    });
    return splitCommandSegments(masked).map((segment) => segment.replace(/[\uE001-\uE008]/g, (c) => UNMASKED[c]));
}

function basenameOf(token) {
    return String(token).split(/[\\/]/).filter(Boolean).pop() || '';
}

/**
 * Write targets of the file-copying and in-place-editing verbs in one command.
 *
 * @param {string} command
 * @returns {string[]} candidate path strings (relative or absolute), possibly empty
 */
function extractWriteTargets(command) {
    if (!command || typeof command !== 'string') return [];
    const targets = [];
    for (const segment of splitQuoteAware(command)) {
        const trimmed = normalizeSegmentHead(segment);
        const m = trimmed.match(/^(\S+)\s*([\s\S]*)$/);
        if (!m) continue;
        const verb = basenameOf(m[1]).toLowerCase().replace(/\.exe$/, '');
        const tokens = tokenizeArgs(m[2]);
        if (verb === 'git') { targets.push(...gitWriteTargets(tokens)); continue; }
        if (verb === 'patch' || verb === 'gpatch') { targets.push(...patchOperandTargets(tokens)); continue; }
        // Option arguments that are not operands: the value of `-t`/`--target-directory`, `awk -i inplace`.
        const optionValue = new Set();
        let targetDir = null;
        for (let i = 0; i < tokens.length; i++) {
            if (typeof tokens[i] !== 'string') continue;
            if (tokens[i] === '-t' || tokens[i] === '--target-directory') { targetDir = tokens[i + 1] || null; optionValue.add(i + 1); }
            else if (tokens[i].startsWith('--target-directory=')) targetDir = tokens[i].slice('--target-directory='.length);
            else if ((verb === 'awk' || verb === 'gawk') && tokens[i] === '-i' && tokens[i + 1] === 'inplace') optionValue.add(i + 1);
        }
        const operands = tokens.filter((t, i) => t && typeof t === 'string' && !t.startsWith('-') && !optionValue.has(i));

        if (COPY_LIKE_VERBS.has(verb)) {
            if (targetDir) {
                targets.push(targetDir);
                for (const src of operands) targets.push(targetDir + '/' + basenameOf(src));
            } else if (operands.length > 0) {
                const dest = operands[operands.length - 1];
                targets.push(dest);
                // The destination may be an existing directory: the file lands under it.
                for (const src of operands.slice(0, -1)) targets.push(dest + '/' + basenameOf(src));
                // `mv` also removes its sources.
                if (verb === 'mv') targets.push(...operands.slice(0, -1));
            }
            continue;
        }
        if (verb === 'tee') { targets.push(...operands); continue; }
        if (verb === 'dd') {
            for (const t of tokens) if (/^of=/i.test(t)) targets.push(t.slice(3));
            continue;
        }
        if (verb === 'sed' || verb === 'perl' || verb === 'ruby') {
            if (tokens.some((t) => INPLACE_FLAG.test(t) || t === '--in-place' || t.startsWith('--in-place='))) targets.push(...operands);
            continue;
        }
        if (verb === 'awk' || verb === 'gawk') {
            const at = tokens.indexOf('-i');
            if (at !== -1 && tokens[at + 1] === 'inplace') targets.push(...operands);
        }
    }
    return targets;
}

// ─── git, patch and extraction forms (M3 / security m2) ───────────────────────

const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);

function joinDir(dir, p) {
    return String(dir).replace(/[\\/]+$/, '') + '/' + p;
}

/**
 * Split the tokens after `git` into the global options' directories (`-C dir`, `--work-tree dir`),
 * the subcommand and its arguments.
 */
function parseGit(tokens) {
    const dirs = [];
    let i = 0;
    for (; i < tokens.length; i++) {
        const t = tokens[i];
        if (typeof t !== 'string' || !t.startsWith('-')) break;
        if ((t === '-C' || t === '--work-tree') && typeof tokens[i + 1] === 'string') { dirs.push(tokens[i + 1]); i++; }
        else if (t.startsWith('--work-tree=')) dirs.push(t.slice('--work-tree='.length));
        else if (GIT_VALUE_OPTIONS.has(t)) i++;
    }
    const sub = typeof tokens[i] === 'string' ? tokens[i].toLowerCase() : '';
    return { dirs, sub, args: tokens.slice(i + 1) };
}

/** Pathspec operands of `git restore`/`git checkout` (the files the command overwrites), or null. */
function gitPathspecs(g) {
    const args = g.args;
    if (g.sub === 'restore') {
        const staged = args.includes('--staged') || args.includes('-S');
        const worktree = args.includes('--worktree') || args.includes('-W');
        if (staged && !worktree) return []; // index only: the working tree is untouched
        const valueOptions = new Set(['-s', '--source', '--pathspec-from-file', '--conflict', '-U', '--unified', '--inter-hunk-context']);
        const operands = [];
        for (let i = 0; i < args.length; i++) {
            const t = args[i];
            if (typeof t !== 'string') continue;
            if (valueOptions.has(t)) { i++; continue; }
            if (t.startsWith('-')) continue;
            operands.push(t);
        }
        return operands;
    }
    if (g.sub === 'checkout') {
        const dashdash = args.indexOf('--');
        if (dashdash !== -1) return args.slice(dashdash + 1).filter((t) => typeof t === 'string');
        return args.filter((t) => typeof t === 'string' && !t.startsWith('-'));
    }
    return null;
}

/** Candidate write targets of a `git` command line: restore/checkout pathspecs, `rm` and `mv` operands. */
function gitWriteTargets(tokens) {
    const g = parseGit(tokens);
    const raw = [];
    if (g.sub === 'restore' || g.sub === 'checkout') raw.push(...(gitPathspecs(g) || []));
    else if (g.sub === 'rm') {
        if (!g.args.includes('--cached')) raw.push(...g.args.filter((t) => typeof t === 'string' && t && !t.startsWith('-')));
    } else if (g.sub === 'mv') {
        const ops = g.args.filter((t) => typeof t === 'string' && t && !t.startsWith('-'));
        raw.push(...ops);
        if (ops.length > 1) for (const src of ops.slice(0, -1)) raw.push(ops[ops.length - 1] + '/' + basenameOf(src));
    }
    const out = [];
    for (const p of raw) {
        if (!p) continue;
        out.push(p);
        if (!path.isAbsolute(p)) for (const d of g.dirs) out.push(joinDir(d, p));
    }
    return out;
}

/**
 * Directories a command writes INTO without naming the files: the `tar -C`/`unzip -d` extraction
 * directory and the directory pathspecs of `git restore`/`git checkout`. A caller asks whether the
 * directory holds a protected path (the member names are inside the archive and unknown).
 *
 * @param {string} command
 * @returns {string[]}
 */
function extractDirectoryWrites(command) {
    if (!command || typeof command !== 'string') return [];
    const dirs = [];
    for (const segment of splitQuoteAware(command)) {
        const trimmed = normalizeSegmentHead(segment);
        const m = trimmed.match(/^(\S+)\s*([\s\S]*)$/);
        if (!m) continue;
        const verb = basenameOf(m[1]).toLowerCase().replace(/\.exe$/, '');
        const tokens = tokenizeArgs(m[2]).filter((t) => typeof t === 'string');
        if (verb === 'tar' || verb === 'gtar' || verb === 'bsdtar') {
            const extract = tokens.some((t, i) => t === '--extract' || t === '--get'
                || (/^-[A-Za-z]+$/.test(t) && t.includes('x'))
                || (i === 0 && /^[A-Za-z]+$/.test(t) && t.includes('x')));
            if (!extract) continue;
            for (let i = 0; i < tokens.length; i++) {
                const t = tokens[i];
                if ((t === '-C' || t === '--directory') && tokens[i + 1]) { dirs.push(tokens[i + 1]); i++; }
                else if (t.startsWith('--directory=')) dirs.push(t.slice('--directory='.length));
                else if (/^-C./.test(t)) dirs.push(t.slice(2));
            }
        } else if (verb === 'unzip') {
            for (let i = 0; i < tokens.length; i++) {
                const t = tokens[i];
                if (t === '-d' && tokens[i + 1]) { dirs.push(tokens[i + 1]); i++; }
                else if (/^-d./.test(t)) dirs.push(t.slice(2));
            }
        } else if (verb === 'git') {
            const g = parseGit(tokens);
            for (const p of gitPathspecs(g) || []) {
                if (!p) continue;
                dirs.push(p);
                if (!path.isAbsolute(p)) for (const d of g.dirs) dirs.push(joinDir(d, p));
            }
        }
    }
    return dirs;
}

/** `patch ORIGFILE`: the operands of `patch` are files it overwrites (the first) and the patch itself. */
function patchOperandTargets(tokens) {
    const operands = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (typeof t !== 'string') continue;
        if (t === '-i' || t === '--input' || t === '-d' || t === '--directory' || t === '-o' || t === '--output' || t === '-r' || t === '--reject-file' || t === '-F' || t === '-V' || t === '-B' || t === '-Y' || t === '-z') { i++; continue; }
        if (t === '<') { i++; continue; }
        if (t.startsWith('-') || t.startsWith('<')) continue;
        operands.push(t);
    }
    return operands.slice(0, 2);
}

/**
 * The patch applications in a command: `patch`, `git apply` and `git am`. A patch names its target
 * files inside itself, so the caller reads the patch file (`files`); a patch from stdin cannot be
 * read (`stdin`). `readOnly` marks the forms that apply nothing (`git apply --check`, `patch --dry-run`).
 *
 * @param {string} command
 * @returns {{verb: string, files: string[], stdin: boolean, readOnly: boolean}[]}
 */
function extractPatchApplications(command) {
    if (!command || typeof command !== 'string') return [];
    const apps = [];
    for (const segment of splitQuoteAware(command)) {
        const trimmed = normalizeSegmentHead(segment);
        const m = trimmed.match(/^(\S+)\s*([\s\S]*)$/);
        if (!m) continue;
        const verb = basenameOf(m[1]).toLowerCase().replace(/\.exe$/, '');
        const tokens = tokenizeArgs(m[2]).filter((t) => typeof t === 'string');
        const files = [];
        let stdin = false;
        let readOnly = false;
        if (verb === 'patch' || verb === 'gpatch') {
            readOnly = tokens.includes('--dry-run') || tokens.includes('--check') || tokens.includes('-C');
            for (let i = 0; i < tokens.length; i++) {
                const t = tokens[i];
                if ((t === '-i' || t === '--input') && tokens[i + 1]) { files.push(tokens[i + 1]); i++; }
                else if (t.startsWith('--input=')) files.push(t.slice('--input='.length));
                else if (t === '<' && tokens[i + 1]) { files.push(tokens[i + 1]); i++; }
                else if (/^<<</.test(t) || /^<<-?/.test(t)) stdin = true;
                else if (/^<[^<]/.test(t)) files.push(t.slice(1));
            }
            // `patch ORIGFILE PATCHFILE`: the second operand is the patch.
            const operands = patchOperandTargets(tokens);
            if (operands.length === 2) files.push(operands[1]);
            if (files.length === 0) stdin = true;
            apps.push({ verb: 'patch', files, stdin, readOnly });
            continue;
        }
        if (verb !== 'git') continue;
        const g = parseGit(tokens);
        if (g.sub !== 'apply' && g.sub !== 'am') continue;
        if (g.sub === 'apply') {
            const reads = ['--check', '--stat', '--numstat', '--summary'].some((f) => g.args.includes(f));
            readOnly = reads && !g.args.includes('--apply');
        }
        for (const t of g.args) {
            if (t === '-') stdin = true;
            else if (!t.startsWith('-') && !t.startsWith('<')) files.push(t);
        }
        for (let i = 0; i < g.args.length; i++) {
            if (g.args[i] === '<' && g.args[i + 1]) files.push(g.args[i + 1]);
            else if (/^<[^<]/.test(g.args[i])) files.push(g.args[i].slice(1));
            else if (/^<</.test(g.args[i])) stdin = true;
        }
        // A bare `<` redirect target was pushed as an operand above; drop the literal `<`.
        const cleaned = files.filter((f) => f !== '<');
        if (cleaned.length === 0) stdin = true;
        apps.push({ verb: 'git ' + g.sub, files: cleaned, stdin, readOnly });
    }
    return apps;
}

/** Target file paths named inside a unified/git/context patch or an mbox of patches. */
function patchTargets(text) {
    const targets = new Set();
    const add = (p) => { if (p && p !== '/dev/null') targets.add(p); };
    for (const line of String(text).split(/\r?\n/)) {
        let m;
        if ((m = /^(?:\+\+\+|---|\*\*\*) (\S+)/.exec(line))) add(m[1]);
        else if ((m = /^diff --git (\S+) (\S+)/.exec(line))) { add(m[1]); add(m[2]); }
        else if ((m = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line))) add(m[1].trim());
        else if ((m = /^Index: (\S+)/.exec(line))) add(m[1]);
    }
    return Array.from(targets);
}

/**
 * Whether a subagent may write into a directory: the directory itself, a directory inside a
 * protected directory entry, or a directory that holds a protected entry (an archive member or a
 * restored pathspec can be any file below it).
 *
 * @returns {{ allowed: boolean, reason?: string, tier?: string }}
 */
function checkDirectoryWrite(absDir, rules, context) {
    const direct = checkPathAccess(absDir, 'write', rules, context);
    if (!direct.allowed) return direct;
    const inside = checkPathAccess(path.join(absDir, '_'), 'write', rules, context);
    if (!inside.allowed) return inside;
    const roots = new Set([path.resolve(projectRoot())]);
    try { roots.add(fs.realpathSync(projectRoot())); } catch { /* not on disk */ }
    const dir = path.resolve(absDir);
    for (const tier of ['zeroAccessPaths', 'readOnlyPaths', 'subagentReadOnlyPaths']) {
        for (const glob of Array.isArray(rules[tier]) ? rules[tier] : []) {
            if (typeof glob !== 'string' || glob.includes('*')) continue;
            for (const root of roots) {
                const entry = path.resolve(root, glob.replace(/\\/g, '/'));
                if (entry === dir || entry.startsWith(dir + path.sep)) {
                    return { allowed: false, tier, reason: 'Directory holds a protected path (matched: ' + glob + ')' };
                }
            }
        }
    }
    return { allowed: true };
}

/**
 * Path literals of an inline interpreter script that calls a write API
 * (`node -e "fs.writeFileSync('x', ...)"`, `python -c "open('x','w')..."`). Scans the whole
 * command, not its segments: the segment splitter cuts an inline script at its parentheses.
 * Best-effort: a path built from variables is invisible, and a script file is not read.
 *
 * @param {string} command
 * @returns {string[]}
 */
function extractInlineScriptTargets(command) {
    if (!command || typeof command !== 'string') return [];
    if (!INTERPRETER_HEAD.test(command) || !INLINE_CODE_FLAG.test(command) || !WRITE_API.test(command)) return [];
    // Every quoted literal, nested ones included: scan from each quote character to its
    // partner instead of consuming the outer literal, because a shell-quoted script carries
    // its own string literals (`node -e "fs.writeFileSync('x', '')"`).
    const targets = [];
    for (let i = 0; i < command.length; i++) {
        const quote = command[i];
        if (quote !== '"' && quote !== "'" && quote !== '`') continue;
        let j = i + 1;
        while (j < command.length && command[j] !== quote) j += command[j] === '\\' ? 2 : 1;
        if (j >= command.length) continue;
        const literal = command.slice(i + 1, j).trim().replace(/\\+$/, '');
        if (literal && literal.length <= 400 && !/\s/.test(literal)) targets.push(literal);
    }
    return targets;
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

/** A hard block for a path-tier refusal. */
function denyResult(command, access, pathClass) {
    const resp = buildHookResponse('block', {
        command,
        pattern: access.reason || 'path-tier enforcement',
        tier: access.tier,
    });
    return { block: true, feedback: resp.stderr, telemetry: { decision: 'block', rule: access.reason || 'path-tier enforcement', tier: access.tier || null, pathClass } };
}

const MAX_PATCH_BYTES = 8 * 1024 * 1024;

/**
 * Decide one patch application for a subagent: refuse when the patch cannot be read (stdin, a missing
 * or oversized file) or when any file it targets is in a protected tier.
 */
function checkPatchApplication(app, dirs, baseDirs, changed, rules, context) {
    if (app.readOnly) return { allowed: true };
    const refuse = (why) => ({ allowed: false, tier: 'subagentReadOnlyPaths', reason: '`' + app.verb + '` ' + why + ': a subagent does not apply patches, the Main Agent applies them' });
    if (app.stdin) return refuse('applies a patch whose target files cannot be checked (read from stdin)');
    for (const file of app.files) {
        let text = null;
        for (const abs of resolveCandidates(file, dirs, baseDirs, changed)) {
            try {
                if (fs.statSync(abs).size > MAX_PATCH_BYTES) return refuse('applies a patch too large to check');
                text = fs.readFileSync(abs, 'utf8');
                break;
            } catch { /* try the next spelling */ }
        }
        if (text === null) return refuse('applies a patch file that cannot be read (' + file + ')');
        for (const target of patchTargets(text)) {
            for (const abs of resolveCandidates(target, dirs, baseDirs, changed)) {
                const access = checkPathAccess(abs, 'write', rules, context);
                if (!access.allowed) return access;
            }
        }
    }
    return { allowed: true };
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

    // agent_id is present only inside a subagent; ANY defined value marks one (the same rule
    // as checkPathAccess and path-guardrail.cjs), so it is passed through untouched.
    const context = { agentId: parsedJson && parsedJson.agent_id, agentType: parsedJson && parsedJson.agent_type };
    const isSubagent = context.agentId !== undefined;

    let rules = loadRules();
    if (!rules) {
        // A missing or unusable rules file passes the main thread through (warned), but a
        // subagent is still held to the built-in subagent tier.
        if (!isSubagent) return null;
        rules = { block_patterns: [], nudge_patterns: [], confirm_patterns: [], dangerousPatterns: [], zeroAccessPaths: [], readOnlyPaths: [], noDeletePaths: [], subagentReadOnlyPaths: [] };
    }
    if (isSubagent) rules = applySubagentDefaults(rules);

    const decision = checkRules(sanitizedCommand, rules);

    // M3 — relative targets resolve against the payload cwd and any `cd`/`pushd` earlier in the
    // command, not only the project root.
    const baseDirs = baseDirectories(parsedJson && parsedJson.cwd);
    const plan = planCommand(sanitizedCommand, baseDirs);

    // Coarse, secret-safe path class for delete-style commands (C1). null for
    // non-delete commands; carried on the telemetry of delete-relevant branches.
    // F63: extract once — reused for the P2.5 delete-path enforcement below.
    const rmTargets = collectTargets(plan, baseDirs, extractDeletePaths);
    const rawDeletePaths = rmTargets.map((t) => t.p);
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
    const deleteTargets = [
        ...rmTargets, // F63: extracted once above
        ...collectTargets(plan, baseDirs, extractAltDeleteTargets),
    ];
    for (const target of deleteTargets) {
        const p = target.p;
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

        for (const absPath of target.abs) {
            // Freeze-state check (A2)
            const freeze = checkFreezeState(absPath);
            if (freeze.blocked) {
                const resp = buildHookResponse('frozen', { command, frozenPath: freeze.frozenPath });
                return { block: true, feedback: resp.stderr, telemetry: { decision: 'block', rule: 'frozen-path', tier: 'frozen', pathClass } };
            }

            // Four-tier path check (A3). The context makes a subagent's delete of a
            // subagentReadOnlyPaths entry block too (SF-1.8).
            const access = checkPathAccess(absPath, 'delete', rules, context);
            if (!access.allowed) return denyResult(command, access, pathClass);
        }
    }

    // SF-1.8 — best-effort write check for a subagent: the destinations of cp/mv/tee/dd/sed -i
    // and the path literals of an inline write script go through the same tier as the Write
    // hook. Not a wall (see the header); runs before the nudge for the same reason as above.
    if (isSubagent) {
        const writeTargets = [
            ...collectTargets(plan, baseDirs, extractWriteTargets),
            // An inline script is scanned whole (the segment splitter cuts it at its parentheses), so
            // its relative literals are tried under every directory the command visits.
            ...extractInlineScriptTargets(sanitizedCommand).map((p) => ({ p, abs: resolveCandidates(p, plan.allDirs, baseDirs, plan.changed) })),
        ];
        for (const target of writeTargets) {
            for (const absPath of target.abs) {
                const access = checkPathAccess(absPath, 'write', rules, context);
                if (!access.allowed) return denyResult(command, access, pathClass);
            }
        }
        // tar -C / unzip -d / git restore <dir>: the files written are not named, so the directory must not hold a protected path.
        for (const target of collectTargets(plan, baseDirs, extractDirectoryWrites)) {
            for (const absPath of target.abs) {
                const access = checkDirectoryWrite(absPath, rules, context);
                if (!access.allowed) return denyResult(command, access, pathClass);
            }
        }
        // patch / git apply / git am: the target files are inside the patch.
        for (const step of plan.steps) {
            for (const app of extractPatchApplications(step.text)) {
                const access = checkPatchApplication(app, step.dirs, baseDirs, plan.changed, rules, context);
                if (!access.allowed) return denyResult(command, access, pathClass);
            }
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
    if (loadError) {
        // Without its helpers the hook cannot read the payload or tell the main thread from a
        // subagent: block everything until a person repairs the install.
        process.stderr.write('[guardrail] BLOCKED (fail-closed): could not load its dependencies — ' + (loadError && loadError.message) + '\n' +
            '[guardrail] Repair or re-render the toolkit (node .claude/core/render-shared-agents.js) outside this session; every shell command is blocked until then.\n');
        process.exit(2);
    }
    const watchdog = setTimeout(() => {
        try { process.stderr.write('[guardrail] BLOCKED (fail-closed): deadline of ' + DEADLINE_MS + 'ms exceeded.\n'); } catch { /* swallow */ }
        process.exit(2);
    }, DEADLINE_MS);
    watchdog.unref();

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

if (require.main === module) {
    runClaudeHook();
} else if (loadError) {
    // Required by a test or helper with a broken dependency: do not export a half-loaded hook.
    throw loadError;
}

// ─── Exports (backward compat) ───────────────────────────────────────────────

module.exports = {
    processEvent,
    parseYaml,           // re-exported from _lib/yaml-parser
    stripComment,        // re-exported from _lib/yaml-parser
    matchPatterns,       // array variant (takes patterns[], not single pattern)
    extractDeletePaths,       // rm-family delete targets across chained segments (G1)
    extractAltDeleteTargets,  // find/truncate/shred/redirect targets (G3)
    extractWriteTargets,      // cp/mv/tee/dd/sed -i destinations (SF-1.8, subagent only)
    extractInlineScriptTargets, // path literals of an inline write script (SF-1.8, subagent only)
    extractDirectoryWrites,   // tar -C / unzip -d / git restore directories (subagent only)
    extractPatchApplications, // patch / git apply / git am (subagent only)
    tokenizeArgs,             // quote-aware argument split (an empty quoted argument stays '')
    parseDirChange,           // cd / pushd / popd detection (M3)
    planCommand,              // ordered segments with the directories each may run in (M3)
    splitCommandSegments,     // shell-separator split used by both extractors
    stripCommitMessages,
    checkRules,          // backward compat wrapper over evaluate()
    loadRules,           // hook-level wrapper (resolves path, writes stderr warnings)
    classifyDeletePath,  // coarse, secret-safe path class for delete telemetry (C1)
    PATH_CLASS_ENUM,     // bounded enum of pathClass values (C1)
};
