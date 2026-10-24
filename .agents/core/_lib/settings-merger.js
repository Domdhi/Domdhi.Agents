/**
 * Settings Merger — section-aware merge logic for .claude/settings.json.
 *
 * Ownership split (under --merge):
 *   Template OWNS (overwrite from the workshop's settings.json):
 *     - hooks           — the hooks block; adding/changing hooks is the
 *                         primary reason this merger exists (v4.82 shipped several
 *                         new hooks that were silently absent in adopter settings).
 *                         EXCEPTION — adopter-authored hook entries survive: an entry
 *                         whose command references a script that exists in the
 *                         ADOPTER's hooks/ dir but is NOT a template hook (e.g.
 *                         an adopter's build-guard hook) is re-inserted into the
 *                         merged block under the same event + matcher. Entries whose
 *                         referenced script is missing on both sides are fossil
 *                         registrations and are dropped with the old block. Inline
 *                         commands (no hooks/<file> reference) are preserved unless
 *                         the template ships the identical command. Ordering caveat:
 *                         preserved entries are appended after the template's entries
 *                         in their matcher group.
 *     - plansDirectory  — the default plans output path
 *     - statusLine      — boilerplate wiring that points at the template-owned
 *                         core/statusline.sh script (like hooks, it's a pointer at
 *                         a synced script, NOT project config). Without this the
 *                         settings.json command line never tracks changes to how
 *                         the status line is invoked. A project that genuinely
 *                         wants a custom status line overrides it in
 *                         settings.local.json (always skipped by the sync).
 *
 *   Project KEEPS (adopter values are never overwritten; absent → fall back to template):
 *     - permissions     — allow/deny lists are per-project trust decisions
 *     - env             — project-specific environment variables
 *     - $schema         — adopter may pin a different schema URL
 *     - <any other top-level key> — forward-compatible: unknown keys survive untouched
 *
 * Only runs under --merge (options.merge in template-updater). Without --merge
 * settings.json is skipped as a pure project-zone file (existing behavior).
 *
 * Never calls process.cwd(). All paths are explicit srcAbs / destAbs arguments.
 *
 * @module settings-merger
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { safeWrite } = require('./fs-safe');

// ── Ownership Policy ──────────────────────────────────────────────────────────

/**
 * Top-level keys in settings.json that the TEMPLATE owns.
 * On every --merge run the adopter's values for these keys are overwritten
 * with the workshop's current values.
 */
const TEMPLATE_OWNED_KEYS = [
    'hooks',
    'plansDirectory',
    // statusLine is a pointer at the template-owned core/statusline.sh; treat it
    // as wiring (like hooks), not project config. Custom status lines belong in
    // settings.local.json (never synced).
    'statusLine',
];

/**
 * Top-level keys that the PROJECT owns (adopter values are kept; absent → template value).
 * This list is informational — in practice any key NOT in TEMPLATE_OWNED_KEYS is
 * project-kept, so forward-compat is guaranteed without editing this constant.
 */
const PROJECT_OWNED_KEYS = [
    '$schema',
    'permissions',
    'env',
];

// ── Adopter-hook preservation helpers ─────────────────────────────────────────

/**
 * Extract the hook script filename referenced by a hook command string, e.g.
 * 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/adopter-build-guard.cjs"' → 'adopter-build-guard.cjs'.
 * Returns null for inline commands that don't reference a hooks/ script.
 */
function extractHookScript(command) {
    if (typeof command !== 'string') return null;
    const m = command.match(/hooks[\/\\]([A-Za-z0-9._-]+)/);
    return m ? m[1] : null;
}

/** Filenames in the hooks/ dir sibling to a settings.json path (empty set if absent). */
function listHookFiles(settingsAbs) {
    try {
        return new Set(fs.readdirSync(path.join(path.dirname(settingsAbs), 'hooks')));
    } catch {
        return new Set();
    }
}

/** Walk every {type,command} entry in a hooks section: cb(event, group, entry). */
function forEachHookEntry(hooksSection, cb) {
    if (!hooksSection || typeof hooksSection !== 'object') return;
    for (const [event, groups] of Object.entries(hooksSection)) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
            if (!group || !Array.isArray(group.hooks)) continue;
            for (const entry of group.hooks) cb(event, group, entry);
        }
    }
}

/**
 * Re-insert the adopter's own hook registrations into a merged (template-copied)
 * hooks section. An entry is adopter-authored — and preserved — when its command
 * references a script that exists in the ADOPTER's hooks/ dir and is not a
 * template hook (by template hooks/ listing or template-section reference).
 * Script-referencing entries whose file is gone are fossils → dropped. Inline
 * commands are preserved unless the template ships the identical command string.
 * Mutates mergedHooks; returns the list of preserved names for reporting.
 */
/**
 * Claude Code matcher semantics: empty or `*` matches every tool; otherwise an
 * exact-or-regex tool-name pattern. An adopter pattern that is not a valid regex is
 * compared as an exact name.
 */
function matcherMatches(matcher, tool) {
    if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
    try { return new RegExp(`^(?:${matcher})$`).test(tool); } catch { return String(matcher) === tool; }
}

/**
 * Adopter-owned shell settings the PowerShell tool bypasses. The template's shell hooks
 * match Bash|PowerShell and its allowlist grants PowerShell twins, but an adopter's own
 * hook keeps its matcher and `permissions` is project-owned, so neither changes on
 * update; each gap is reported, never rewritten. (Claude Code on Windows offers a
 * PowerShell tool beside Bash.)
 */
function shellNotices(shellGaps, permissions) {
    const notices = shellGaps.map(g => `adopter hook ${g.name} (${g.event} matcher "${g.matcher}") does not match PowerShell`);
    const allow = permissions && Array.isArray(permissions.allow) ? permissions.allow : [];
    for (const rule of allow) {
        if (typeof rule !== 'string' || !rule.startsWith('Bash(')) continue;
        const twin = `PowerShell(${rule.slice('Bash('.length)}`;
        if (!allow.includes(twin)) notices.push(`allow rule ${rule} has no ${twin} twin`);
    }
    return notices;
}

function preserveAdopterHooks(mergedHooks, destHooks, srcHooks, srcAbs, destAbs, shellGaps = []) {
    const templateFiles = listHookFiles(srcAbs);
    const destFiles = listHookFiles(destAbs);
    const templateCmds = new Set();
    const templateRefs = new Set();
    forEachHookEntry(srcHooks, (event, group, entry) => {
        if (!entry || typeof entry.command !== 'string') return;
        templateCmds.add(entry.command);
        const ref = extractHookScript(entry.command);
        if (ref) templateRefs.add(ref);
    });

    const norm = (m) => (m === undefined || m === null) ? '' : String(m);
    const preserved = [];
    forEachHookEntry(destHooks, (event, group, entry) => {
        const cmd = entry && entry.command;
        if (typeof cmd !== 'string') return;
        const ref = extractHookScript(cmd);
        const keep = ref
            ? (!templateFiles.has(ref) && !templateRefs.has(ref) && destFiles.has(ref))
            : !templateCmds.has(cmd);
        if (!keep) return;

        if (!Array.isArray(mergedHooks[event])) mergedHooks[event] = [];
        let target = mergedHooks[event].find(g => g && norm(g.matcher) === norm(group.matcher));
        if (!target) {
            target = Object.prototype.hasOwnProperty.call(group, 'matcher')
                ? { matcher: group.matcher, hooks: [] }
                : { hooks: [] };
            mergedHooks[event].push(target);
        }
        if (!Array.isArray(target.hooks)) target.hooks = [];
        if (!target.hooks.some(e => e && e.command === cmd)) {
            target.hooks.push(entry);
            preserved.push(ref || cmd);
            if (matcherMatches(group.matcher, 'Bash') && !matcherMatches(group.matcher, 'PowerShell')) {
                shellGaps.push({ name: ref || cmd, event, matcher: String(group.matcher) });
            }
        }
    });
    return preserved;
}

// ── Merge Logic ───────────────────────────────────────────────────────────────

/**
 * Merge the template's settings.json (srcAbs) into the adopter's settings.json
 * (destAbs) using the ownership policy above.
 *
 * Returns a result object matching the house style of agent-merger.js:
 *   { action: 'copied'|'merged'|'unchanged'|'skipped', detail: string }
 *
 * Behavior:
 *   - destAbs missing → treat as a fresh project, copy template verbatim.
 *   - destAbs unparseable → warn and skip (never corrupt adopter files).
 *   - Idempotent: running twice on unchanged inputs returns action='unchanged'.
 *   - Respects options.dryRun — logs what WOULD happen but writes nothing.
 *
 * Writes go through fs-safe's `safeWrite` so a symlinked `settings.json` leaf (or a
 * symlinked ancestor dir up to `containRoot`) is never followed out of the adopter
 * tree — matching how copyFile threads containRoot elsewhere in template-updater.
 *
 * @param {string} srcAbs   — absolute path to the template settings.json
 * @param {string} destAbs  — absolute path to the target settings.json
 * @param {{ dryRun?: boolean }} [options]
 * @param {string} [containRoot] — destination project root; enables the
 *                                 symlinked-ancestor guard (optional, backward-compatible)
 * @returns {{ action: string, detail: string }}
 */
function mergeSettingsFile(srcAbs, destAbs, options, containRoot) {
    options = options || {};

    // ── Read template (src) ───────────────────────────────────────────────────

    let srcObj;
    try {
        srcObj = JSON.parse(fs.readFileSync(srcAbs, 'utf8'));
    } catch (err) {
        return { action: 'skipped', detail: `could not read/parse template settings.json — ${err.message}` };
    }

    // ── Fresh install: dest missing ───────────────────────────────────────────

    if (!fs.existsSync(destAbs)) {
        if (options.dryRun) {
            return { action: 'copied', detail: 'would copy (fresh install — dest missing)' };
        }
        const out = JSON.stringify(srcObj, null, 2) + '\n';
        fs.mkdirSync(require('path').dirname(destAbs), { recursive: true });
        safeWrite(destAbs, out, 'utf8', containRoot);
        return { action: 'copied', detail: 'copied (fresh install — dest missing)' };
    }

    // ── Read dest ─────────────────────────────────────────────────────────────

    let destObj;
    try {
        destObj = JSON.parse(fs.readFileSync(destAbs, 'utf8'));
    } catch (err) {
        // Unparseable — warn and skip; never corrupt the adopter's file.
        return { action: 'skipped', detail: `target settings.json is not valid JSON — skipping to avoid corruption (${err.message})` };
    }

    // ── Build merged object ───────────────────────────────────────────────────

    // Start from dest so all project-owned + unknown keys are preserved.
    // F17: null-prototype copy, not Object.assign({}, destObj) — destObj is
    // JSON.parse'd ADOPTER content, and a `"__proto__"` key that JSON.parse
    // stores as a plain own property would be re-set through the inherited
    // Object.prototype.__proto__ SETTER by Object.assign's [[Set]] copy,
    // silently reassigning the merged object's prototype (verified live).
    // Own-key defineProperty-shaped copy onto a null-prototype object keeps
    // every key inert data; JSON.stringify output is unchanged.
    const merged = Object.create(null);
    for (const key of Object.keys(destObj)) merged[key] = destObj[key];

    // Overwrite template-owned keys with the template's current values
    for (const key of TEMPLATE_OWNED_KEYS) {
        if (Object.prototype.hasOwnProperty.call(srcObj, key)) {
            merged[key] = srcObj[key];
        }
        // If the template no longer ships a formerly-template-owned key, we leave
        // whatever the adopter has (safe: we do not delete adopter keys).
    }

    // hooks exception: re-insert the adopter's OWN hook registrations (e.g. a
    // project-authored PreToolUse guard) into the freshly template-copied block —
    // deep-clone first so srcObj is never mutated.
    let preservedHooks = [];
    const shellGaps = [];
    if (Object.prototype.hasOwnProperty.call(srcObj, 'hooks') &&
        destObj.hooks && typeof destObj.hooks === 'object') {
        merged.hooks = JSON.parse(JSON.stringify(srcObj.hooks));
        preservedHooks = preserveAdopterHooks(merged.hooks, destObj.hooks, srcObj.hooks, srcAbs, destAbs, shellGaps);
    }

    // For project-owned keys that are absent in dest, fall back to template value.
    // This handles the first-run case where an adopter's old settings.json predates
    // a key the template now ships as a default.
    for (const key of PROJECT_OWNED_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(merged, key) &&
            Object.prototype.hasOwnProperty.call(srcObj, key)) {
            merged[key] = srcObj[key];
        }
    }

    const notices = shellNotices(shellGaps, merged.permissions);
    const shellNote = notices.length > 0 ? `; PowerShell not covered: ${notices.join('; ')}` : '';

    // ── Serialize ─────────────────────────────────────────────────────────────

    const out = JSON.stringify(merged, null, 2) + '\n';

    // ── Idempotency check ─────────────────────────────────────────────────────

    const existing = fs.readFileSync(destAbs, 'utf8');
    if (out === existing) {
        return { action: 'unchanged', detail: `unchanged${shellNote}`, notices };
    }

    // ── Dry-run ───────────────────────────────────────────────────────────────

    const preservedNote = preservedHooks.length > 0
        ? `; preserved ${preservedHooks.length} adopter hook(s): ${preservedHooks.join(', ')}`
        : '';

    if (options.dryRun) {
        const changed = TEMPLATE_OWNED_KEYS.filter(k =>
            JSON.stringify(destObj[k]) !== JSON.stringify(merged[k])
        );
        const detail = changed.length > 0
            ? `would update: ${changed.join(', ')}${preservedNote}`
            : `would merge (project-owned keys added from template)${preservedNote}`;
        return { action: 'merged', detail: `${detail}${shellNote}`, notices };
    }

    // ── Write ─────────────────────────────────────────────────────────────────

    safeWrite(destAbs, out, 'utf8', containRoot);

    const updatedKeys = TEMPLATE_OWNED_KEYS.filter(k =>
        JSON.stringify(destObj[k]) !== JSON.stringify(merged[k])
    );
    const detail = updatedKeys.length > 0
        ? `merged (updated: ${updatedKeys.join(', ')}${preservedNote})`
        : `merged (no template-owned key changes; project-owned keys preserved${preservedNote})`;

    return { action: 'merged', detail: `${detail}${shellNote}`, notices };
}

module.exports = {
    mergeSettingsFile,
    // Expose policy constants so tests can verify they are correct
    TEMPLATE_OWNED_KEYS,
    PROJECT_OWNED_KEYS,
    // Exposed for unit tests
    extractHookScript,
};
