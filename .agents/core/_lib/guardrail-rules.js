/**
 * Guardrail Rules — rule loading, pattern matching, and command evaluation.
 *
 * Extracted from .claude/hooks/guardrail.cjs as part of the P2.3 guardrail
 * split and extended by P2.5 with a four-tier YAML schema (A3), hand-rolled
 * load-time validation with fail-safe = block (D1), and a path-access checker
 * the hook uses to enforce file-path tiers on applicable operations.
 *
 * Competitor-pattern provenance:
 *   A3 — four-tier path schema from PI Agent damage-control.
 *   D1 — Schema validation at hook load time is a blind-spot opportunity;
 *        no competitor does this (see
 *        `docs/.output/findings/research/competitive/_hooks-and-core-scripts-comparison.md` §D1).
 *
 * Four-tier schema semantics:
 *   dangerousPatterns : bash command regex — hard block (alongside block_patterns)
 *   zeroAccessPaths   : path glob — read AND write blocked
 *   readOnlyPaths     : path glob — write AND delete blocked; read allowed
 *   noDeletePaths     : path glob — delete blocked; read/write allowed
 *   subagentReadOnlyPaths : path glob — write AND delete blocked for a SUBAGENT
 *                       only (the caller passes `{agentId}` to checkPathAccess);
 *                       the main thread and reads are unaffected. Holds the gate,
 *                       its judges, the hooks, the guardrail rules and settings so
 *                       an implementer cannot weaken the judge that grades it.
 *
 * Fail-safe posture: when validation fails at the top level, return
 * emptyRules() (block-all defaults). When a single dangerousPatterns entry
 * is an invalid RegExp source, drop the entire list (block-safe per-tier).
 *
 * PATH_RULES LEGACY NOTE
 * ──────────────────────
 * The older `path_rules` top-level key from before P2.5 is still loaded and
 * returned as pass-through (for backward compat with the YAML file header).
 * evaluate() + checkPathAccess() do NOT act on `path_rules` — the four-tier
 * schema above supersedes it. The existing YAML file keeps the key for docs.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseYaml } = require('./yaml-parser');

// ── Schema validators — D1 (hand-rolled, no runtime deps) ────────────────────

// Path-glob tiers — plain strings only (no regex-source requirement; these
// are file-path globs, not bash-command patterns).
const STRING_TIER_KEYS = ['zeroAccessPaths', 'readOnlyPaths', 'noDeletePaths', 'subagentReadOnlyPaths'];

/**
 * Escalation marker an agent appends to a command to opt a `nudge` match into
 * a user confirm. The nudge tier first DENIES (exit 2) with an alternatives
 * message; the agent re-runs the same command with this trailing comment marker
 * once it has confirmed there is no reversible alternative, and the guardrail
 * then returns `confirm` (the user is prompted). Stateless by design — the
 * marker travels in the re-issued command, so it is auditable and cannot be
 * applied silently. Requires a `#` so it reads as an intentional comment.
 */
const ESCALATION_MARKER = /#\s*guardrail:confirm\b/i;

/** True when a command carries the nudge→confirm escalation marker. */
function hasEscalationMarker(command) {
    return typeof command === 'string' && ESCALATION_MARKER.test(command);
}
// Command-pattern tiers — F12: all four support the `/regex/` form (per the
// YAML file header) and evaluate()/matchesPattern() treat them identically
// at match time, so all four must be regex-source validated identically.
// A plain (non-`/…/`) string still validates fine — isValidRegexSource()
// compiles it as a literal regex source, which succeeds for ordinary text.
const REGEX_TIER_KEYS = ['dangerousPatterns', 'block_patterns', 'nudge_patterns', 'confirm_patterns'];
const ALL_TIER_KEYS = [...STRING_TIER_KEYS, ...REGEX_TIER_KEYS];

/**
 * Test that a string is a valid JavaScript RegExp source.
 * Accepts both plain patterns (case-insensitive substring if no slashes) and
 * /regex/ forms. For `/regex/` we strip the delimiters before compiling.
 */
function isValidRegexSource(s) {
    if (typeof s !== 'string' || s.length === 0) return false;
    const inner = s.startsWith('/') && s.endsWith('/') && s.length > 2 ? s.slice(1, -1) : s;
    try { new RegExp(inner); return true; } catch { return false; }
}

/**
 * Validate a tier value: undefined → [], array-of-strings → array, anything
 * else → null (signals invalid). Items must all be strings; if `requireRegex`
 * is true, items must also be valid RegExp sources.
 */
function validateTier(value, { requireRegex = false } = {}) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return null;
    for (const item of value) {
        if (typeof item !== 'string') return null;
        if (requireRegex && !isValidRegexSource(item)) return null;
    }
    return value;
}

/**
 * Locate the first item in a tier array that fails string/regex validation,
 * for a specific, actionable warning message. Returns undefined if the value
 * isn't an array or every item is valid (caller only calls this once
 * validateTier() has already signalled failure).
 */
function findFirstInvalidTierItem(value, { requireRegex = false } = {}) {
    if (!Array.isArray(value)) return undefined;
    for (const item of value) {
        if (typeof item !== 'string') return item;
        if (requireRegex && !isValidRegexSource(item)) return item;
    }
    return undefined;
}

/**
 * Built-in copy of the shipped `subagentReadOnlyPaths` entries. The path hook (Write, Edit,
 * MultiEdit, NotebookEdit) and the Bash guard hold a subagent to this list when the rules file
 * is missing, unreadable, malformed, or parses but lacks the tier key (see
 * `applySubagentDefaults`), so a deleted, corrupted or truncated rules file cannot switch the
 * wall off exactly when an implementer wants it off. A test pins this list equal to the shipped
 * `.agents/config/guardrail-rules.yaml` tier in content and order, and a second test walks the
 * require() graph of the hooks and judges and fails when a reachable file is not matched here:
 * edit both lists together. Same glob rules as the rules file (`globMatchesPath`).
 */
const BUILTIN_SUBAGENT_READ_ONLY_PATHS = Object.freeze([
    'gate.config.json',
    '.agents/core/gate.js',
    '.agents/core/_lib/gate-receipt.js',
    '.agents/core/_lib/failure-ledger.js',
    '.agents/core/_lib/freeze-state.js',
    '.agents/core/_lib/guardrail-rules.js',
    '.agents/core/ac-verify.js',
    '.agents/core/ship-check.js',
    '.agents/core/commit.js',
    '.agents/core/todo-completion.js',
    '.agents/core/story-checkpoint.js',
    '.agents/core/plan-check.js',
    '.agents/core/release-slice.js',
    '.agents/core/runtime-context.js',
    '.agents/core/git-hooks.js',
    '.agents/core/build-lock-recovery.js',
    '.agents/core/_lib/attribution-ledger.js',
    '.agents/core/_lib/command-blocker.js',
    '.agents/core/_lib/fs-safe.js',
    '.agents/core/_lib/gate-summary.js',
    '.agents/core/_lib/git-hook-protocol.js',
    '.agents/core/_lib/git.js',
    '.agents/core/_lib/hook-input.js',
    '.agents/core/_lib/hook-telemetry.js',
    '.agents/core/_lib/jsonl-writer.js',
    '.agents/core/_lib/owned-process-tree.js',
    '.agents/core/_lib/project-root.js',
    '.agents/core/_lib/run-pointer.js',
    '.agents/core/_lib/secret-engine-bin.js',
    '.agents/core/_lib/shell-command-split.js',
    '.agents/core/_lib/telemetry-paths.js',
    '.agents/core/_lib/yaml-parser.js',
    '.agents/core/_lib/daily-log-paths.js',
    '.agents/core/_lib/doc-drift.js',
    '.agents/core/_lib/frontmatter.js',
    '.agents/core/_lib/hook-spawners.js',
    '.agents/core/_lib/jaccard.js',
    '.agents/core/_lib/memory-context.js',
    '.agents/core/_lib/memory-decay.js',
    '.agents/core/_lib/memory-extract.js',
    '.agents/core/_lib/memory-index-divergence.js',
    '.agents/core/_lib/memory-ingest.js',
    '.agents/core/_lib/memory-lint.js',
    '.agents/core/_lib/memory-notes.js',
    '.agents/core/_lib/memory-paths.js',
    '.agents/core/_lib/memory-recall.js',
    '.agents/core/_lib/memory-sync.js',
    '.agents/core/_lib/output-paths.js',
    '.agents/core/_lib/run-stamp.js',
    '.agents/core/_lib/sqlite-backend.js',
    '.agents/core/constants.js',
    '.agents/core/daily-log.js',
    '.agents/core/handoff-path.js',
    '.agents/core/memory-capture.js',
    '.agents/core/memory-manager-cli.js',
    '.agents/core/memory-manager.js',
    '.agents/core/profile.js',
    '.agents/hooks/',
    '.claude/hooks/',
    '.codex/hooks/',
    '.claude/core/',
    '.codex/core/',
    '.agents/config/guardrail-rules.yaml',
    'guardrail-rules.yaml',
    '.agents/adapters/claude/settings.json',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.agents/adapters/codex/',
    '.codex/hooks.json',
    '.codex/hook-identities.json',
    'docs/.output/.state/telemetry/ac-verify/',
    'docs/.output/.state/telemetry/ship-seal.json',
    'docs/.output/.state/telemetry/gate-failures.jsonl',
    'docs/.output/.state/telemetry/gate-receipt.json',
    'docs/.output/.state/telemetry/gate-receipts/',
    'docs/.output/.state/freeze-state.json',
    'vitest.config.mjs',
    'tools/run-toolkit-tests.cjs',
    '.agents/core/__tests__/_helpers/vitest-tmp-sandbox.setup.mjs',
    '.agents/core/__tests__/_helpers/tmp-sandbox.js',
    'vitest.config.ts',
    'vitest.config.mts',
    'vitest.config.cts',
    'vitest.config.js',
    'vitest.config.cjs',
    'vite.config.ts',
    'vite.config.mts',
    'vite.config.cts',
    'vite.config.js',
    'vite.config.mjs',
    'vite.config.cjs',
    'node_modules/',
    // SF-4.3: the improvement loop's judges and test data
    '.agents/skills/skill-creator/agents/',
    '.agents/skills/skill-creator/scripts/',
    'evals/',
    'tools/harness-eval-tasks/',
    'holdout/',
    'tools/skill-holdout/',
    'docs/.output/evolution/skills/*/ledger.json',
    'docs/.output/evolution/skills/revert-candidates.json',
    'docs/.output/evolution/skills/_decisions.md',
]);

/**
 * Hold a subagent to the built-in tier when the loaded rules cannot be trusted to carry it.
 * `rules.rulesParsed` is true only when the shipped file parsed AND named the
 * `subagentReadOnlyPaths` key (a key lifted to empty by the project override still counts):
 * the shipped file always has the key, so a missing key means a truncated file, a tampered
 * file or an update not yet rendered, and the wall must not vanish with it. Returns `rules`
 * unchanged when it is trustworthy, otherwise a copy carrying the built-in list. Only the
 * subagent tier is replaced: every other tier keeps what the file said.
 *
 * @param {object} rules  Rules from `loadRules`, or an `emptyRules()`-shaped object
 * @returns {object}
 */
function applySubagentDefaults(rules) {
    if (rules && rules.rulesParsed === true) return rules;
    return { ...(rules || {}), subagentReadOnlyPaths: [...BUILTIN_SUBAGENT_READ_ONLY_PATHS] };
}

/**
 * Empty-rules sentinel returned when the YAML file is missing, malformed,
 * or schema-invalid. Block-safe: empty arrays for every tier means nothing
 * is blocked BUT nothing dangerous is passed through either — callers can
 * inspect `rules.block_patterns.length === 0 && ...` to surface a warning.
 */
function emptyRules() {
    return {
        block_patterns: [],
        nudge_patterns: [],
        confirm_patterns: [],
        dangerousPatterns: [],
        zeroAccessPaths: [],
        readOnlyPaths: [],
        noDeletePaths: [],
        subagentReadOnlyPaths: [],
    };
}

/**
 * Load and parse a guardrail-rules.yaml file from the given absolute path.
 * (Internal: `loadRules` below wraps this with the project-owned override.)
 *
 * Callers are responsible for constructing the path — this module does NOT
 * resolve paths internally (pattern: anchor-paths-to-project-root-not-cwd).
 *
 * Graceful degradation contract:
 *   - Missing file       → return emptyRules() (no throw, no stderr)
 *   - Unreadable file    → return emptyRules()
 *   - Malformed YAML     → return emptyRules()
 *   - Top-level non-obj  → return emptyRules()
 *   - block/confirm      → must be array (or empty `{}`/missing). Else emptyRules().
 *   - Path-glob keys     → must be array of strings (or empty `{}`/missing).
 *                          (zeroAccessPaths/readOnlyPaths/noDeletePaths/
 *                          subagentReadOnlyPaths)
 *                          Invalid item type → emptyRules() (block-safe).
 *   - Command-pattern keys (F12) — dangerousPatterns, block_patterns,
 *                          nudge_patterns, confirm_patterns → must additionally
 *                          be valid RegExp sources (a plain non-`/…/` string
 *                          validates as a literal regex source, so ordinary
 *                          substring patterns are unaffected). ANY bad regex
 *                          drops ONLY that tier's list to [] (per-tier
 *                          fail-safe per D1) AND writes a loud stderr warning
 *                          naming the tier and the offending pattern — never a
 *                          silent no-op. The YAML file header documents that
 *                          all four pattern tiers support `/regex/`, and
 *                          evaluate()/matchesPattern() treat them identically
 *                          at match time, so a malformed regex in block/nudge/
 *                          confirm gets the same fail-safe + warning
 *                          dangerousPatterns always had.
 *
 * The block-all posture: when something looks wrong, default to "nothing is
 * specially guarded" rather than "nothing is checked at all" — the existing
 * block_patterns + confirm_patterns still fire from their YAML entries if
 * those pass validation.
 *
 * @param {string} yamlPath - Absolute path to the guardrail-rules.yaml file
 * A successfully loaded ruleset carries a non-enumerable `rulesParsed` flag: the file parsed
 * to a mapping that names the `subagentReadOnlyPaths` key (an empty key counts, and so does one
 * the project override lifted to empty: that is a deliberate choice). It is absent on every
 * fail-safe `emptyRules()` return and on a parsed file that lacks the key, which lets the hooks
 * tell "the rules carry the subagent wall" from "they do not" and hold a subagent to the
 * built-in defaults (`applySubagentDefaults`). The shipped file always names the key, so a
 * missing one means tampering, truncation or an update not yet rendered (fail closed).
 *
 * @returns {{ block_patterns: string[], confirm_patterns: string[], dangerousPatterns: string[], zeroAccessPaths: string[], readOnlyPaths: string[], noDeletePaths: string[], subagentReadOnlyPaths: string[], path_rules?: object }}
 */
function loadShippedRules(yamlPath) {
    if (!fs.existsSync(yamlPath)) {
        return emptyRules();
    }

    let raw;
    try {
        raw = fs.readFileSync(yamlPath, 'utf8');
    } catch {
        return emptyRules();
    }

    let parsed;
    try {
        parsed = parseYaml(raw);
    } catch {
        return emptyRules();
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return emptyRules();
    }

    // Coerce empty `{}` (the minimal YAML parser's representation of a key with
    // no children, e.g. `noDeletePaths:`) to []. Without this, every empty tier
    // key would invalidate the ruleset since arrays are required downstream.
    for (const key of ALL_TIER_KEYS) {
        const v = parsed[key];
        if (v !== undefined && !Array.isArray(v)) {
            if (typeof v === 'object' && v !== null && Object.keys(v).length === 0) {
                parsed[key] = [];
            }
            // Other non-array values fall through to per-tier validation below.
        }
    }

    // block/nudge/confirm must be arrays — else fail safe globally (P2.3 contract).
    for (const key of ['block_patterns', 'nudge_patterns', 'confirm_patterns']) {
        const v = parsed[key];
        if (v !== undefined && !Array.isArray(v)) return emptyRules();
    }

    const validated = {};
    for (const key of STRING_TIER_KEYS) {
        const v = validateTier(parsed[key]);
        if (v === null) return emptyRules();
        validated[key] = v;
    }

    // Command-pattern tiers (F12): dangerousPatterns, block_patterns,
    // nudge_patterns, confirm_patterns — per-tier fail-safe. ANY invalid
    // regex source in a tier drops ONLY that tier's list to [] (other tiers
    // are unaffected) AND writes a loud, non-silent stderr warning naming the
    // tier and the offending pattern — a malformed pattern must never become
    // a silent no-op that looks like a working rule.
    for (const key of REGEX_TIER_KEYS) {
        const v = validateTier(parsed[key], { requireRegex: true });
        if (v === null) {
            const badItem = findFirstInvalidTierItem(parsed[key], { requireRegex: true });
            console.error(
                `[guardrail-rules] WARNING: "${key}" in guardrail-rules.yaml contains an invalid pattern` +
                (badItem !== undefined ? ` (${JSON.stringify(badItem)})` : '') +
                ` — this tier has been dropped to empty (fail-safe). Fix or remove the offending entry.`
            );
            validated[key] = [];
        } else {
            validated[key] = v;
        }
    }

    const rules = {
        block_patterns:    validated.block_patterns,
        nudge_patterns:    validated.nudge_patterns,
        confirm_patterns:  validated.confirm_patterns,
        dangerousPatterns: validated.dangerousPatterns,
        zeroAccessPaths:   validated.zeroAccessPaths,
        readOnlyPaths:     validated.readOnlyPaths,
        noDeletePaths:     validated.noDeletePaths,
        subagentReadOnlyPaths: validated.subagentReadOnlyPaths,
        ...(parsed.path_rules ? { path_rules: parsed.path_rules } : {}),
    };
    return parsed.subagentReadOnlyPaths !== undefined ? markRulesParsed(rules) : rules;
}

/** Attach the non-enumerable `rulesParsed` flag (see loadShippedRules). */
function markRulesParsed(rules) {
    Object.defineProperty(rules, 'rulesParsed', { value: true, enumerable: false });
    return rules;
}

// ── Project-owned override ───────────────────────────────────────────────────
//
// `<rules>.project.yaml` beside the shipped rules (for `guardrail-rules.yaml`:
// `guardrail-rules.project.yaml`) belongs to the project. The toolkit never writes,
// ships or overwrites it, so a project can adjust the shipped tiers without
// editing a managed file that every update would then refuse.
//
//   - Any tier key (the eight in ALL_TIER_KEYS) lists ADDITIONS, unioned with the
//     shipped entries. Additions can only strengthen the ruleset.
//   - `except:` lifts EXACT shipped entries from `readOnlyPaths`, `noDeletePaths` and
//     `subagentReadOnlyPaths` only (configuration files a project edits routinely, and
//     subagent-wall entries a project's own agents must write). The zero-access tier and
//     the command tiers cannot be loosened from here.
//
// Fail closed: a file that cannot be read or parsed, names an unknown key, holds a
// non-list tier, an invalid regex or an exception outside the two tiers is refused
// as a whole with a stderr warning and the shipped rules stand. A stale exception
// (an entry the shipped tier no longer holds) warns and the rest applies.
const OVERRIDE_EXCEPT_KEYS = ['readOnlyPaths', 'noDeletePaths', 'subagentReadOnlyPaths'];
const OVERRIDE_MAX_BYTES = 64 * 1024;

function overridePathFor(yamlPath) {
    const parsed = path.parse(yamlPath);
    return path.join(parsed.dir, `${parsed.name}.project${parsed.ext || '.yaml'}`);
}

function applyProjectOverride(rules, yamlPath) {
    const overridePath = overridePathFor(yamlPath);
    if (!fs.existsSync(overridePath)) return rules;
    const refuse = (why) => {
        console.error(`[guardrail-rules] WARNING: project override ${overridePath} refused (${why}) — the shipped rules stand.`);
        return rules;
    };

    let parsed;
    try {
        if (fs.statSync(overridePath).size > OVERRIDE_MAX_BYTES) return refuse(`larger than ${OVERRIDE_MAX_BYTES / 1024} KiB`);
        parsed = parseYaml(fs.readFileSync(overridePath, 'utf8'));
    } catch {
        return refuse('unreadable or malformed');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return refuse('not a mapping');

    // The minimal parser reads a key with no children as an empty object.
    const listOf = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0 ? [] : value);

    const additions = {};
    for (const key of Object.keys(parsed)) {
        if (key === 'except') continue;
        if (!ALL_TIER_KEYS.includes(key)) return refuse(`unknown key "${key}"`);
        const list = listOf(parsed[key]);
        const regex = REGEX_TIER_KEYS.includes(key);
        if (validateTier(list, { requireRegex: regex }) === null) return refuse(`"${key}" must be a list of ${regex ? 'valid patterns' : 'strings'}`);
        additions[key] = list;
    }

    const exceptions = {};
    if (parsed.except !== undefined) {
        // An empty list (`except: []`, or a key whose children the parser read as none) is an empty mapping.
        const except = Array.isArray(parsed.except) && parsed.except.length === 0 ? {} : parsed.except;
        if (except === null || typeof except !== 'object' || Array.isArray(except)) return refuse('"except" must be a mapping');
        // A mis-indented `except:` parses as an empty mapping: say so instead of lifting nothing silently.
        if (Object.keys(except).length === 0) console.error(`[guardrail-rules] WARNING: project override ${overridePath} has an empty "except" — check its indentation; nothing was lifted.`);
        for (const key of Object.keys(except)) {
            if (!OVERRIDE_EXCEPT_KEYS.includes(key)) return refuse(`"except" may only name ${OVERRIDE_EXCEPT_KEYS.join(' and ')}, not "${key}"`);
            const list = listOf(except[key]);
            if (validateTier(list) === null) return refuse(`"except.${key}" must be a list of strings`);
            exceptions[key] = list;
        }
    }

    const merged = { ...rules };
    for (const [key, list] of Object.entries(additions)) {
        merged[key] = [...merged[key], ...list.filter((entry) => !merged[key].includes(entry))];
    }
    for (const [key, list] of Object.entries(exceptions)) {
        for (const entry of list) {
            if (!merged[key].includes(entry)) {
                console.error(`[guardrail-rules] WARNING: project override ${overridePath} excepts "${entry}" from ${key}, which the shipped rules do not list — ignored.`);
            }
        }
        merged[key] = merged[key].filter((entry) => !list.includes(entry));
    }
    return merged;
}

/**
 * Load the shipped rules at `yamlPath` and apply the project-owned override beside
 * them, if any. Same graceful-degradation contract as the shipped loader; a missing
 * or unusable shipped file returns the empty rules and the override is not read.
 *
 * @param {string} yamlPath - Absolute path to the guardrail-rules.yaml file
 */
function loadRules(yamlPath) {
    const rules = loadShippedRules(yamlPath);
    if (!fs.existsSync(yamlPath)) return rules;
    // applyProjectOverride copies the rules on a successful merge, which drops the
    // non-enumerable flag; carry it across.
    const merged = applyProjectOverride(rules, yamlPath);
    return rules.rulesParsed === true ? markRulesParsed(merged) : merged;
}

/**
 * Test whether a single command string matches a single pattern string.
 *
 * Two pattern formats are supported:
 *   - Plain string — case-insensitive substring match
 *   - /regex/      — JavaScript regex wrapped in slashes (case-insensitive)
 *
 * Invalid regex patterns return false (do not throw).
 * Empty patterns return false.
 */
function matchesPattern(command, pattern) {
    if (!pattern || typeof pattern !== 'string') return false;

    // Regex pattern: /expr/
    if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
        const expr = pattern.slice(1, -1);
        try {
            const re = new RegExp(expr, 'i');
            return re.test(command);
        } catch {
            return false;
        }
    }

    // Plain substring match (case-insensitive), whitespace-normalized (C3).
    // Collapsing runs of whitespace to a single space on BOTH the command and
    // the pattern means token-separating whitespace variations cannot evade a
    // multi-token block/nudge pattern: `git  push  --force` (double space) and
    // `git\tpush\t--force` (tabs) still match the "git push --force" family, as
    // do `format  c:`, `dd  if=/dev/zero`, etc. Regex patterns (handled above)
    // are NOT normalized here — they carry their own `\s+` tolerance.
    const cmdStr = typeof command === 'string' ? command : '';
    const normCommand = cmdStr.replace(/\s+/g, ' ').toLowerCase();
    const normPattern = pattern.replace(/\s+/g, ' ').toLowerCase();
    return normCommand.includes(normPattern);
}

// Normalize static Git-push arguments without executing a shell or expanding
// variables/substitutions. The general splitter deliberately splits raw text;
// using it here would mistake quoted remote/config data for command boundaries.
// Keep this view supplemental and Git-specific: all original raw rules still run.
function gitPushCandidates(command) {
    if (typeof command !== 'string') return [];
    const segments = [];
    let words = [], word = '', started = false, quote = null;
    const finishWord = () => {
        if (started) words.push(word);
        word = ''; started = false;
    };
    const finishSegment = () => {
        finishWord();
        if (words.length) segments.push(words);
        words = [];
    };
    for (let i = 0; i < command.length; i++) {
        const ch = command[i], next = command[i + 1];
        if (quote === "'") {
            if (ch === "'") quote = null;
            else word += ch;
            continue;
        }
        if (ch === '\\' || ch === '`') {
            // In double quotes Bash preserves backslashes before non-special
            // characters: "\\:ref" is a literal backslash, not an empty source.
            const escapes = !quote || ch === '`' || (next !== undefined && /[\$`"\\\r\n]/.test(next));
            if (next !== undefined && escapes) {
                if (next === '\r' && command[i + 2] === '\n') i += 2;
                else {
                    if (next !== '\n') { word += next; started = true; }
                    i++;
                }
                continue;
            }
        }
        if (quote === '"') {
            if (ch === '"') quote = null;
            else word += ch;
        } else if (ch === "'" || ch === '"') {
            quote = ch; started = true;
        } else if (/[;&|\r\n()]/.test(ch)) {
            finishSegment();
        } else if (/\s/.test(ch)) {
            finishWord();
        } else {
            word += ch; started = true;
        }
    }
    finishSegment();
    const valueOptions = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env']);
    const candidates = [];
    // Encode separators/whitespace that belong to a TOKEN so existing bounded
    // patterns cannot reinterpret them as a new argument or shell command.
    const encode = value => value.replace(/[\s;&|()]/g, '\ufffd');
    for (const tokens of segments) {
        for (let i = 0; i < tokens.length; i++) {
            if (!/^git(?:\.exe)?$/i.test(tokens[i].split(/[\\/]/).pop())) continue;
            let j = i + 1;
            while (j < tokens.length && tokens[j].startsWith('-')) {
                const option = tokens[j++];
                if (valueOptions.has(option)) j++;
            }
            if (tokens[j] === 'push') candidates.push(['git', 'push', ...tokens.slice(j + 1).map(encode)].join(' '));
        }
    }
    return candidates;
}

/**
 * Evaluate a bash command against the loaded rule set.
 *
 * Precedence: dangerousPatterns → block_patterns → nudge_patterns →
 * confirm_patterns → pass. dangerousPatterns are treated as hard blocks (same
 * semantics as block_patterns) but are part of the four-tier A3 schema and can
 * be extended independently of the historical block_patterns list.
 *
 * The `nudge` tier sits between hard-block and confirm: on a plain match it
 * returns `decision: 'nudge'` (the hook denies with an alternatives message so
 * the agent tries a reversible path first). If the command carries the
 * escalation marker (`# guardrail:confirm`), the same match instead returns
 * `decision: 'confirm'` (escalated) so the user is prompted. Hard blocks take
 * precedence and ignore the marker — they are never escalatable.
 */
function evaluate(command, rules) {
    const dangerousPatterns = Array.isArray(rules.dangerousPatterns) ? rules.dangerousPatterns : [];
    const blockPatterns     = Array.isArray(rules.block_patterns)    ? rules.block_patterns    : [];
    const nudgePatterns     = Array.isArray(rules.nudge_patterns)    ? rules.nudge_patterns    : [];
    const confirmPatterns   = Array.isArray(rules.confirm_patterns)  ? rules.confirm_patterns  : [];
    const pushCandidates = gitPushCandidates(command);
    const matches = pattern => {
        if (matchesPattern(command, pattern)) return true;
        if (typeof pattern !== 'string') return false;
        const lower = pattern.toLowerCase();
        const gitPushPattern = (lower.startsWith('/git\\b') && lower.includes('push\\b')) || /^git\s+push\b/i.test(pattern);
        return gitPushPattern && pushCandidates.some(candidate => matchesPattern(candidate, pattern));
    };

    for (const pattern of dangerousPatterns) {
        if (matches(pattern)) {
            return { decision: 'block', pattern, tier: 'dangerousPatterns' };
        }
    }

    for (const pattern of blockPatterns) {
        if (matches(pattern)) {
            return { decision: 'block', pattern };
        }
    }

    for (const pattern of nudgePatterns) {
        if (matches(pattern)) {
            if (hasEscalationMarker(command)) {
                const reason = `Guardrail (escalated — no reversible alternative): "${pattern}" — ${command}`;
                return { decision: 'confirm', pattern, reason, escalated: true };
            }
            return { decision: 'nudge', pattern };
        }
    }

    for (const pattern of confirmPatterns) {
        if (matches(pattern)) {
            const reason = `Guardrail: "${pattern}" — ${command}`;
            return { decision: 'confirm', pattern, reason };
        }
    }

    return { decision: 'pass' };
}

// ── Path tier checker — A3 ───────────────────────────────────────────────────

/**
 * Case-fold a path string the way Windows (NTFS) compares names: upper-case, then lower-case.
 * Plain `toLowerCase` leaves characters that only fold through their upper-case form
 * (`U+017F` long s uppercases to `S`) distinct from the ASCII letter NTFS treats them as,
 * so a name spelled with one would slip past a lexical match. Both sides of every
 * comparison go through the same fold, so ordinary paths match exactly as before.
 */
function fold(value) {
    return value.toUpperCase().toLowerCase();
}

/**
 * Test whether a file-path glob matches a given absolute path.
 *
 * Simple glob semantics:
 *   - trailing `/` means "directory prefix" (matches any file under it)
 *   - `*` matches any non-slash characters
 *   - otherwise plain substring/suffix match
 *
 * Matching is case-insensitive (NTFS-style fold, see `fold`); comparison uses
 * forward-slash normalized paths. Plain entries are unanchored suffix matches.
 */
function globMatchesPath(glob, absPath) {
    if (typeof glob !== 'string' || typeof absPath !== 'string') return false;
    const normGlob = fold(glob.replace(/\\/g, '/'));
    const normPath = fold(absPath.replace(/\\/g, '/'));

    // Directory-prefix glob (ends with /)
    if (normGlob.endsWith('/')) {
        const gl = normGlob;                      // e.g. "bin/"
        const glNoSlash = gl.slice(0, -1);        // "bin"
        const pl = normPath;
        // Segment-boundary anchored (m2): a `bin/` glob must match the directory
        // itself or files under it, but NOT an unrelated path that merely
        // contains the substring (`cabin/foo`, `cobweb/`). It matches when:
        //   - the path is inside that directory     ".../bin/..."
        //   - the path IS that directory (no slash)  ".../bin"   (G2 — path.resolve
        //     collapses `node_modules/../.git` to a trailing-slash-free dir)
        //   - the path itself starts with the glob   "bin/..." / "bin"
        return pl.includes('/' + gl)
            || pl.endsWith('/' + glNoSlash)
            || pl === glNoSlash
            || pl.startsWith(gl);
    }

    // Wildcard glob — convert to regex (only * supported for now)
    if (normGlob.includes('*')) {
        const escaped = normGlob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
        try {
            const re = new RegExp('(^|/)' + escaped + '$', 'i');
            return re.test(normPath);
        } catch {
            return false;
        }
    }

    // Plain filename or relative path — endsWith match. This is an UNANCHORED suffix match
    // (`gate.config.json` also matches `x-gate.config.json`): harmless for a deny list, which only
    // ever over-blocks, but never reuse this matcher for an allow list.
    return normPath.endsWith('/' + normGlob) || normPath.endsWith(normGlob);
}

/**
 * Check whether an operation on an absolute path is allowed under the
 * tier schema. `zeroAccess` takes precedence over `readOnly` over the
 * subagent tier over `noDelete` — first matching tier wins.
 *
 * `context` is optional: `{ agentId, agentType }` from the hook payload. A caller
 * that omits it (or passes an `agentId` of `undefined`) gets exactly the behaviour
 * of the original three-argument form. ANY defined `agentId` — an empty string,
 * zero, an object, `null` — marks a subagent, because the payload field is present
 * only when the hook fires inside a subagent and a value we cannot interpret must
 * not be read as "the main thread". `agentType` alone does NOT mark a subagent
 * (`claude --agent X` stamps it on the main thread). A subagent's write or delete
 * of a `subagentReadOnlyPaths` match is blocked; a read is allowed.
 *
 * @param {string} absPath   Absolute filesystem path (or repo-relative)
 * @param {'read'|'write'|'delete'} operation
 * @param {object} rules     Rules object from loadRules()
 * @param {{ agentId?: *, agentType?: string }} [context]
 * @returns {{ allowed: boolean, reason?: string, tier?: string }}
 */
function checkPathAccess(absPath, operation, rules, context) {
    const zeroAccess = Array.isArray(rules.zeroAccessPaths) ? rules.zeroAccessPaths : [];
    const readOnly   = Array.isArray(rules.readOnlyPaths)   ? rules.readOnlyPaths   : [];
    const noDelete   = Array.isArray(rules.noDeletePaths)   ? rules.noDeletePaths   : [];
    const subagentRO = Array.isArray(rules.subagentReadOnlyPaths) ? rules.subagentReadOnlyPaths : [];
    const isSubagent = context !== null && typeof context === 'object' && context.agentId !== undefined;

    // Tier 1: zeroAccessPaths — blocks ALL operations
    for (const glob of zeroAccess) {
        if (globMatchesPath(glob, absPath)) {
            return {
                allowed: false,
                tier: 'zeroAccessPaths',
                reason: `Path is in zero-access tier (matched: ${glob})`,
            };
        }
    }

    // Tier 2: readOnlyPaths — blocks write + delete
    for (const glob of readOnly) {
        if (globMatchesPath(glob, absPath)) {
            if (operation === 'write' || operation === 'delete') {
                return {
                    allowed: false,
                    tier: 'readOnlyPaths',
                    reason: `Path is read-only (matched: ${glob})`,
                };
            }
        }
    }

    // Tier 2b: subagentReadOnlyPaths — blocks write + delete for a subagent only
    if (isSubagent && (operation === 'write' || operation === 'delete')) {
        for (const glob of subagentRO) {
            if (globMatchesPath(glob, absPath)) {
                return {
                    allowed: false,
                    tier: 'subagentReadOnlyPaths',
                    reason: `Path is read-only for subagents (matched: ${glob})`,
                };
            }
        }
    }

    // Tier 3: noDeletePaths — blocks delete only
    for (const glob of noDelete) {
        if (globMatchesPath(glob, absPath)) {
            if (operation === 'delete') {
                return {
                    allowed: false,
                    tier: 'noDeletePaths',
                    reason: `Path is protected from deletion (matched: ${glob})`,
                };
            }
        }
    }

    return { allowed: true };
}

module.exports = {
    loadRules,
    matchesPattern,
    evaluate,
    checkPathAccess,
    globMatchesPath, // exposed for tests + potential reuse
    BUILTIN_SUBAGENT_READ_ONLY_PATHS,
    applySubagentDefaults,
    hasEscalationMarker,
    ESCALATION_MARKER,
};
