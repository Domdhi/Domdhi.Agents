/**
 * Zone Classifier — classifies paths relative to .claude/ into template/project/mixed zones.
 *
 * Zone definitions mirror the zone map in docs/reference/agents/customization.md:
 *   Template zone  — overwrite in target (commands, core, hooks, skills, templates, etc.)
 *                    Skill .md files have a --merge escape hatch in template-updater.js: a
 *                    target copy carrying a <!-- @@project-additions --> tail is merged, not
 *                    clobbered (template head refreshed, adopter tail preserved). The crude
 *                    precedent is the skills/brand-guidelines/** project-exception below; the
 *                    marker is the general, section-level version of it.
 *   Project zone   — never touch by default (settings.json, settings.local.json,
 *                    update-config.json). Note: settings.json has a section-aware
 *                    --merge escape hatch in template-updater.js (template-owned sections
 *                    hooks + plansDirectory + statusLine overwritten; project-owned
 *                    sections preserved).
 *                    classifyClaudeFile() still returns 'project' for settings.json —
 *                    the special-casing lives in template-updater, not here.
 *   Mixed zone     — skip with warning, or merge with --merge (agents/*.md)
 *
 * IMPORTANT: Do NOT speculatively generalize this module for publish.js usage.
 * Only cover the cases currently inlined in template-updater.js. Research notes
 * in the TODO explicitly say: "publish.js may adopt zone-classifier.js in a
 * follow-up; do not speculatively generalize."
 *
 * @module zone-classifier
 */

'use strict';

// ── Zone Data ─────────────────────────────────────────────────────────────────

/**
 * Template zone — overwrite in target.
 * core/ and hooks/ use ** (recursive) so subdirectories like core/_lib/ are
 * classified 'template' and propagate on `template-updater update`. A single
 * star (`core/*.js`) silently skipped every file under core/_lib/ after the
 * library split, so downstreams received zero _lib/ updates. ALWAYS_SKIP_DIRS
 * keeps __tests__/ out at the file-walker level.
 */
const TEMPLATE_GLOBS = [
    'commands/**/*.md',
    'core/**/*.js',
    'hooks/**/*.cjs',
    'skills/**/*',
    'skills-optional/**/*',
    'templates/**/*',
    'version.json',
    'guardrail-rules.yaml',
];

/**
 * Project zone — never touch by default (exact paths relative to .claude/).
 *
 * settings.json is listed here but has a section-aware --merge escape hatch in
 * template-updater.js: when options.merge is set, template-updater calls
 * _lib/settings-merger.js instead of skipping, overwriting only the template-owned
 * sections (hooks, plansDirectory) while preserving project-owned ones.
 * settings.local.json and update-config.json are ALWAYS skipped (no escape hatch).
 */
const PROJECT_FILES = [
    'settings.json',
    'settings.local.json',
    // Per-project updater config (e.g. skillExclude). Owned by the target — the
    // updater reads it to decide what to skip, so it must never be overwritten.
    'update-config.json',
];

/**
 * Project zone exceptions — glob-matched paths that would otherwise hit
 * TEMPLATE_GLOBS but are project-owned. The whole brand-guidelines/ subtree
 * is preserved so any sub-docs added in the target (examples, palette files,
 * references) stay project-owned.
 */
const PROJECT_EXCEPTIONS = [
    'skills/brand-guidelines/**',
];

/** Mixed zone — skip with warning unless --merge. */
const MIXED_GLOBS = [
    'agents/*.md',
];

// ── Glob Matching ─────────────────────────────────────────────────────────────

/**
 * Convert a simple glob pattern (supporting ** and *) to a RegExp.
 *
 * VERBATIM from template-updater.js:40 — the replace(/\\/g, '/') normalization
 * is Windows path handling and MUST NOT be removed or refactored away.
 *
 * Only the subset of glob syntax used in the zone map is needed:
 *   **  → match any path segments (including none)
 *   *   → match any single path segment component (no slashes)
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegex(pattern) {
    // Normalize slashes
    const normalized = pattern.replace(/\\/g, '/');
    // Split on ** first to avoid ** fragments being re-processed by * replacement.
    // Then process each segment independently.
    const parts = normalized.split('**');
    const regParts = parts.map((part) => {
        // Escape regex special chars in this literal part
        let escaped = part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        // Replace * (single-star) within this part with [^/]*
        escaped = escaped.replace(/\*/g, '[^/]*');
        return escaped;
    });

    // Rejoin with the appropriate regex for **
    // /**/ => (/.*)?/   (zero or more path segments including none)
    // /**$ => (/.*)?    (trailing — match nothing or a subtree)
    // ^**/ => (.*/)?    (leading — match at any depth)
    // else  => .*       (remaining bare **)
    let regStr = '';
    for (let i = 0; i < regParts.length; i++) {
        regStr += regParts[i];
        if (i < regParts.length - 1) {
            // This is a ** junction. Determine context from surrounding parts.
            const prev = regParts[i];
            const next = regParts[i + 1];
            const prevEndsSlash = prev.endsWith('/');
            const nextStartsSlash = next.startsWith('/');
            const isFirst = i === 0 && prev === '';
            const isLast = i === regParts.length - 2 && next === '';

            if (isFirst && nextStartsSlash) {
                // ^**/ pattern
                regStr += '(.*/)?';
                // consume the leading slash from next
                regParts[i + 1] = regParts[i + 1].slice(1);
            } else if (isLast && prevEndsSlash) {
                // /**$ pattern — remove trailing slash already added from prev
                regStr = regStr.slice(0, -1); // remove the trailing /
                regStr += '(/.*)?';
            } else if (prevEndsSlash && nextStartsSlash) {
                // /**/ pattern — remove trailing slash already added from prev
                regStr = regStr.slice(0, -1); // remove the trailing /
                regStr += '(/.*)?';
                // consume the leading slash from next
                regParts[i + 1] = regParts[i + 1].slice(1);
            } else {
                regStr += '.*';
            }
        }
    }

    return new RegExp('^' + regStr + '$');
}

/**
 * Test whether a relative path matches any of the provided glob patterns.
 *
 * Normalizes backslashes to forward slashes before matching — Windows-safe.
 *
 * @param {string} relPath
 * @param {string[]} globs
 * @returns {boolean}
 */
function matchesAnyGlob(relPath, globs) {
    const normalized = relPath.replace(/\\/g, '/');
    return globs.some(g => globToRegex(g).test(normalized));
}

/**
 * Classify a path relative to .claude/ into its zone.
 *
 * Evaluation order matters — PROJECT_EXCEPTIONS and PROJECT_FILES are checked
 * before TEMPLATE_GLOBS so that exceptions win.
 *
 * @param {string} relPath  — path relative to .claude/, using / or \ separators
 * @returns {'template'|'project'|'project-exception'|'mixed'|'unknown'}
 */
function classifyClaudeFile(relPath) {
    const normalized = relPath.replace(/\\/g, '/');

    if (PROJECT_FILES.includes(normalized)) return 'project';
    if (matchesAnyGlob(normalized, PROJECT_EXCEPTIONS)) return 'project-exception';
    if (matchesAnyGlob(normalized, MIXED_GLOBS)) return 'mixed';
    if (matchesAnyGlob(normalized, TEMPLATE_GLOBS)) return 'template';
    return 'unknown';
}

module.exports = {
    globToRegex,
    matchesAnyGlob,
    classifyClaudeFile,
    // Expose zone data for orchestrator consumption
    TEMPLATE_GLOBS,
    PROJECT_FILES,
    PROJECT_EXCEPTIONS,
    MIXED_GLOBS,
};
