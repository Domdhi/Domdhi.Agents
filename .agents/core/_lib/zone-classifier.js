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
 *                    sections preserved; adopter-AUTHORED hook entries — scripts in
 *                    the adopter's hooks/ dir the template doesn't ship — are
 *                    re-inserted, not clobbered; see _lib/settings-merger.js).
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
 *
 * core/**\/* is extension-agnostic (not core/**\/*.js) — matching the pattern
 * already used by skills/**\/* and templates/**\/*. An extension-restricted glob
 * silently classified non-.js core files (core/statusline.sh, core/package.json)
 * as 'unknown', which template-updater sync then skipped — those files never
 * reached onboarded adopters (F21). __tests__/_helpers/node_modules are still
 * excluded at the file-walker level (ALWAYS_SKIP_DIRS), independent of this glob.
 *
 * agents-optional/**\/* sits in the same bucket as skills-optional/**\/*: install.js
 * and tools/publish.js already treat the two as parallel concepts (both excluded
 * from scaffold/publish), so they must classify — and therefore propagate on sync
 * — identically (F20).
 */
const TEMPLATE_GLOBS = [
    'commands/**/*.md',
    'core/**/*',
    'hooks/**/*.cjs',
    'skills/**/*',
    'skills-optional/**/*',
    'agents-optional/**/*',
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
    'shared-agents.json',
    // Project-owned guardrail override: the loader merges it beside the shipped
    // guardrail-rules.yaml (template zone). Never delivered, never overwritten.
    'guardrail-rules.project.yaml',
];

/**
 * Project zone exceptions — glob-matched paths that would otherwise hit
 * TEMPLATE_GLOBS but are project-owned. The whole brand-guidelines/ subtree
 * is preserved so any sub-docs added in the target (examples, palette files,
 * references) stay project-owned. The ghostwriting voice folder is personal data
 * the project fills in (the shipped fingerprint is a blank template), so an
 * update must never replace a filled copy.
 */
const PROJECT_EXCEPTIONS = [
    'skills/brand-guidelines/**',
    'skills/ghostwriting/references/_voice/**',
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
// F22: compiled-pattern memo. matchesAnyGlob() recompiles each glob for every
// file classified — a template-updater/fleet walk over this repo's own 389
// .claude/ files paid 1,000+ redundant compilations. The glob vocabulary is a
// small static set (zone tables + manifest), so cache by pattern source. The
// cached RegExp carries no /g flag, so .test() is stateless and safe to share.
const _globRegexCache = new Map();

function globToRegex(pattern) {
    const cached = _globRegexCache.get(pattern);
    if (cached) return cached;
    const compiled = compileGlobToRegex(pattern);
    _globRegexCache.set(pattern, compiled);
    return compiled;
}

function compileGlobToRegex(pattern) {
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

/**
 * Project-owned configuration that install and update never deliver. Legacy
 * distribution configuration remains excluded for migration compatibility.
 * .codex/config.toml is created by each project's Codex app, so
 * it is never a canonical source or a rendered output and an adopter's own copy
 * is left alone.
 */
const WORKSHOP_ONLY_SHARED = new Set([
    '.agents/config/distribution-policy.json',
    '.agents/config/distribution-policy.local.json',
    '.codex/config.toml',
    // The project-owned guardrail override lives in .claude/; a copy under the
    // canonical config tree is never delivered or rendered either.
    '.agents/config/guardrail-rules.project.yaml',
]);

/** Canonical paths use the same ownership model as the legacy native files. */
function classifySharedFile(relPath) {
    const rel = relPath.replace(/\\/g, '/');
    // Legacy distribution authority is project-owned: a target must not inherit
    // another project's configuration or distribute on
    // its own. An adopter's own copy, if any, is project-owned and left untouched.
    // tools/publish.js excludes the same canonical/native pair from runtime artifacts.
    if (WORKSHOP_ONLY_SHARED.has(rel)) return 'project-exception';
    if (/^\.agents\/(core|hooks|templates|config)\//.test(rel)) return 'template';
    if (rel.startsWith('.agents/adapters/')) return 'template';
    if (rel === '.agents/gate.config.json') return 'project';
    if (/^\.agents\/roles\/[^/]+\.md$/.test(rel)) return 'mixed';
    if (rel.startsWith('.agents/skills/')) return classifyClaudeFile(rel.slice('.agents/'.length));
    if (rel === '.claude/shared-agents.json' || rel === '.codex/shared-agents.json') return 'project';
    return 'unknown';
}

module.exports = {
    globToRegex,
    matchesAnyGlob,
    classifyClaudeFile,
    classifySharedFile,
    WORKSHOP_ONLY_SHARED,
    // Expose zone data for orchestrator consumption
    TEMPLATE_GLOBS,
    PROJECT_FILES,
    PROJECT_EXCEPTIONS,
    MIXED_GLOBS,
};
