/**
 * Settings Merger — section-aware merge logic for .claude/settings.json.
 *
 * Ownership split (under --merge):
 *   Template OWNS (overwrite from the workshop's settings.json):
 *     - hooks           — the entire hooks block; adding/changing hooks is the
 *                         primary reason this merger exists (v4.82 shipped several
 *                         new hooks that were silently absent in adopter settings)
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
 * settings.json is skipped as a pure project-zone file (existing behaviour).
 *
 * Never calls process.cwd(). All paths are explicit srcAbs / destAbs arguments.
 *
 * @module settings-merger
 */

'use strict';

const fs = require('fs');

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

// ── Merge Logic ───────────────────────────────────────────────────────────────

/**
 * Merge the template's settings.json (srcAbs) into the adopter's settings.json
 * (destAbs) using the ownership policy above.
 *
 * Returns a result object matching the house style of agent-merger.js:
 *   { action: 'copied'|'merged'|'unchanged'|'skipped', detail: string }
 *
 * Behaviour:
 *   - destAbs missing → treat as a fresh project, copy template verbatim.
 *   - destAbs unparseable → warn and skip (never corrupt adopter files).
 *   - Idempotent: running twice on unchanged inputs returns action='unchanged'.
 *   - Respects options.dryRun — logs what WOULD happen but writes nothing.
 *
 * @param {string} srcAbs   — absolute path to the template settings.json
 * @param {string} destAbs  — absolute path to the target settings.json
 * @param {{ dryRun?: boolean }} [options]
 * @returns {{ action: string, detail: string }}
 */
function mergeSettingsFile(srcAbs, destAbs, options) {
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
        fs.writeFileSync(destAbs, out, 'utf8');
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

    // For project-owned keys that are absent in dest, fall back to template value.
    // This handles the first-run case where an adopter's old settings.json predates
    // a key the template now ships as a default.
    for (const key of PROJECT_OWNED_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(merged, key) &&
            Object.prototype.hasOwnProperty.call(srcObj, key)) {
            merged[key] = srcObj[key];
        }
    }

    // ── Serialize ─────────────────────────────────────────────────────────────

    const out = JSON.stringify(merged, null, 2) + '\n';

    // ── Idempotency check ─────────────────────────────────────────────────────

    const existing = fs.readFileSync(destAbs, 'utf8');
    if (out === existing) {
        return { action: 'unchanged', detail: 'unchanged' };
    }

    // ── Dry-run ───────────────────────────────────────────────────────────────

    if (options.dryRun) {
        const changed = TEMPLATE_OWNED_KEYS.filter(k =>
            JSON.stringify(destObj[k]) !== JSON.stringify(srcObj[k])
        );
        const detail = changed.length > 0
            ? `would update: ${changed.join(', ')}`
            : 'would merge (project-owned keys added from template)';
        return { action: 'merged', detail };
    }

    // ── Write ─────────────────────────────────────────────────────────────────

    fs.writeFileSync(destAbs, out, 'utf8');

    const updatedKeys = TEMPLATE_OWNED_KEYS.filter(k =>
        JSON.stringify(destObj[k]) !== JSON.stringify(srcObj[k])
    );
    const detail = updatedKeys.length > 0
        ? `merged (updated: ${updatedKeys.join(', ')})`
        : 'merged (no template-owned key changes; project-owned keys preserved)';

    return { action: 'merged', detail };
}

module.exports = {
    mergeSettingsFile,
    // Expose policy constants so tests can verify they are correct
    TEMPLATE_OWNED_KEYS,
    PROJECT_OWNED_KEYS,
};
