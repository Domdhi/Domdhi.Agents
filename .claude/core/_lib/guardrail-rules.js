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
const { parseYaml } = require('./yaml-parser');

// ── Schema validators — D1 (hand-rolled, no runtime deps) ────────────────────

const STRING_TIER_KEYS = ['block_patterns', 'nudge_patterns', 'confirm_patterns', 'zeroAccessPaths', 'readOnlyPaths', 'noDeletePaths'];

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
const REGEX_TIER_KEYS = ['dangerousPatterns'];
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
    };
}

/**
 * Load and parse a guardrail-rules.yaml file from the given absolute path.
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
 *   - Four-tier keys     → must be array of strings (or empty `{}`/missing).
 *                          Invalid item type → emptyRules() (block-safe).
 *   - dangerousPatterns  → must additionally be valid RegExp sources. ANY bad
 *                          regex drops the entire tier list to [] (per-tier
 *                          fail-safe per D1).
 *
 * The block-all posture: when something looks wrong, default to "nothing is
 * specially guarded" rather than "nothing is checked at all" — the existing
 * block_patterns + confirm_patterns still fire from their YAML entries if
 * those pass validation.
 *
 * @param {string} yamlPath - Absolute path to the guardrail-rules.yaml file
 * @returns {{ block_patterns: string[], confirm_patterns: string[], dangerousPatterns: string[], zeroAccessPaths: string[], readOnlyPaths: string[], noDeletePaths: string[], path_rules?: object }}
 */
function loadRules(yamlPath) {
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

    // dangerousPatterns: per-tier fail-safe — any invalid regex drops the
    // whole list to []. Other tiers are unaffected. (D1 per-tier fail-safe.)
    const dangerous = validateTier(parsed.dangerousPatterns, { requireRegex: true });
    validated.dangerousPatterns = dangerous === null ? [] : dangerous;

    return {
        block_patterns:    validated.block_patterns,
        nudge_patterns:    validated.nudge_patterns,
        confirm_patterns:  validated.confirm_patterns,
        dangerousPatterns: validated.dangerousPatterns,
        zeroAccessPaths:   validated.zeroAccessPaths,
        readOnlyPaths:     validated.readOnlyPaths,
        noDeletePaths:     validated.noDeletePaths,
        ...(parsed.path_rules ? { path_rules: parsed.path_rules } : {}),
    };
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

    for (const pattern of dangerousPatterns) {
        if (matchesPattern(command, pattern)) {
            return { decision: 'block', pattern, tier: 'dangerousPatterns' };
        }
    }

    for (const pattern of blockPatterns) {
        if (matchesPattern(command, pattern)) {
            return { decision: 'block', pattern };
        }
    }

    for (const pattern of nudgePatterns) {
        if (matchesPattern(command, pattern)) {
            if (hasEscalationMarker(command)) {
                const reason = `Guardrail (escalated — no reversible alternative): "${pattern}" — ${command}`;
                return { decision: 'confirm', pattern, reason, escalated: true };
            }
            return { decision: 'nudge', pattern };
        }
    }

    for (const pattern of confirmPatterns) {
        if (matchesPattern(command, pattern)) {
            const reason = `Guardrail: "${pattern}" — ${command}`;
            return { decision: 'confirm', pattern, reason };
        }
    }

    return { decision: 'pass' };
}

// ── Path tier checker — A3 ───────────────────────────────────────────────────

/**
 * Test whether a file-path glob matches a given absolute path.
 *
 * Simple glob semantics:
 *   - trailing `/` means "directory prefix" (matches any file under it)
 *   - `*` matches any non-slash characters
 *   - otherwise plain substring/suffix match
 *
 * Matching is case-insensitive on Windows path strings (since the repo is
 * a Windows host in practice); comparison uses forward-slash normalized paths.
 */
function globMatchesPath(glob, absPath) {
    if (typeof glob !== 'string' || typeof absPath !== 'string') return false;
    const normGlob = glob.replace(/\\/g, '/');
    const normPath = absPath.replace(/\\/g, '/');

    // Directory-prefix glob (ends with /)
    if (normGlob.endsWith('/')) {
        const gl = normGlob.toLowerCase();        // e.g. "bin/"
        const glNoSlash = gl.slice(0, -1);        // "bin"
        const pl = normPath.toLowerCase();
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

    // Plain filename or relative path — endsWith match
    return normPath.toLowerCase().endsWith('/' + normGlob.toLowerCase())
        || normPath.toLowerCase().endsWith(normGlob.toLowerCase());
}

/**
 * Check whether an operation on an absolute path is allowed under the
 * four-tier schema. `zeroAccess` takes precedence over `readOnly` over
 * `noDelete` — first matching tier wins.
 *
 * @param {string} absPath   Absolute filesystem path (or repo-relative)
 * @param {'read'|'write'|'delete'} operation
 * @param {object} rules     Rules object from loadRules()
 * @returns {{ allowed: boolean, reason?: string, tier?: string }}
 */
function checkPathAccess(absPath, operation, rules) {
    const zeroAccess = Array.isArray(rules.zeroAccessPaths) ? rules.zeroAccessPaths : [];
    const readOnly   = Array.isArray(rules.readOnlyPaths)   ? rules.readOnlyPaths   : [];
    const noDelete   = Array.isArray(rules.noDeletePaths)   ? rules.noDeletePaths   : [];

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
    hasEscalationMarker,
    ESCALATION_MARKER,
};
