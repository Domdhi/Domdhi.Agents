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
 *     - permissions     — allow/ask lists and unknown keys are per-project trust decisions.
 *                         EXCEPTION — the template's permissions.deny entries are UNIONED
 *                         into the adopter's deny list (adopter entries first, then any
 *                         missing template entries): a hard-deny set must reach existing
 *                         adopters, and it can only add to what they already deny. A string
 *                         `deny` is wrapped into a one-rule list; entries that cannot be
 *                         rules (non-strings) are dropped and the result says so.
 *                         A settings.json the merger cannot parse (a UTF-8 BOM is stripped
 *                         and written back without it; `//` or block comments are not
 *                         parseable) is skipped with `denyUnionSkipped: true` and a loud
 *                         "permissions.deny union NOT applied" detail, which the updater
 *                         counts as fleet-actionable.
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

// ── permissions.deny union (SF-1.9) ───────────────────────────────────────────

/** Only strings can be Claude Code permission rules; anything else is dropped. */
const isRule = (entry) => typeof entry === 'string';

/**
 * Normalise one side of the union into `{ rules, dropped }`. A string is a one-rule list (an
 * adopter who wrote `"deny": "Bash(rm *)"` meant it, so it is wrapped, never discarded); an
 * array keeps its string entries and counts the rest as dropped; absent or null is empty; any
 * other value (object, number, boolean) cannot hold rules and counts as one dropped value.
 */
function normalizeDenyInput(list) {
    if (typeof list === 'string') return { rules: [list], dropped: 0 };
    if (Array.isArray(list)) {
        const rules = list.filter(isRule);
        return { rules, dropped: list.length - rules.length };
    }
    if (list === undefined || list === null) return { rules: [], dropped: 0 };
    return { rules: [], dropped: 1 };
}

/**
 * Union the template's `permissions.deny` into an adopter's: the adopter's own valid
 * (string) entries first, deduped with the first occurrence kept, then each template
 * entry the adopter does not already hold, in template order. A deny is a hard wall, so
 * template entries are added to the adopter's list, never a replacement for it.
 * A string on either side is wrapped into a one-rule list; non-array input and non-string
 * entries are tolerated and dropped (see `normalizeDenyInput`).
 * Always returns a fresh array. Idempotent: unionDenyList(t, unionDenyList(t, a)) equals
 * unionDenyList(t, a).
 *
 * @param {unknown} templateDeny
 * @param {unknown} adopterDeny
 * @returns {string[]}
 */
function unionDenyList(templateDeny, adopterDeny) {
    const out = [];
    const seen = new Set();
    for (const list of [adopterDeny, templateDeny]) {
        for (const entry of normalizeDenyInput(list).rules) {
            if (seen.has(entry)) continue;
            seen.add(entry);
            out.push(entry);
        }
    }
    return out;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** An own `deny` property of a permissions block, or undefined (never reads the prototype chain). */
function ownDeny(permissions) {
    return isPlainObject(permissions) && Object.prototype.hasOwnProperty.call(permissions, 'deny')
        ? permissions.deny
        : undefined;
}

/**
 * Apply the template's deny union to the merged object's `permissions`. `permissions`
 * itself stays project-owned: allow, ask and every unknown key pass through untouched; only
 * `deny` is rewritten. A template that ships no deny entries changes nothing. A non-object
 * adopter `permissions` (it cannot be valid) is replaced by an object carrying the deny.
 * Builds a fresh null-prototype object, so neither the template nor an adopter's hostile
 * key (`__proto__`) is mutated or re-set through a prototype setter.
 */
function applyDenyUnion(merged, srcObj) {
    const templateDeny = ownDeny(srcObj.permissions);
    if (normalizeDenyInput(templateDeny).rules.length === 0) return { dropped: 0 };

    const adopterDeny = ownDeny(merged.permissions);
    const next = Object.create(null);
    if (isPlainObject(merged.permissions)) {
        for (const key of Object.keys(merged.permissions)) next[key] = merged.permissions[key];
    }
    next.deny = unionDenyList(templateDeny, adopterDeny);
    merged.permissions = next;
    return { dropped: normalizeDenyInput(adopterDeny).dropped };
}

/** The "dropped entries" clause appended to a merge detail, or '' when nothing was dropped. */
function droppedNote(dropped) {
    return dropped > 0 ? `; dropped ${dropped} non-string permissions.deny entr${dropped === 1 ? 'y' : 'ies'} (not valid rules)` : '';
}

// ── Reading settings files (BOM, comments) ────────────────────────────────────

/** True when `text` holds a `//` or block comment outside a JSON string (a JSONC file). */
function hasJsonComments(text) {
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === '\\') i++;
            else if (ch === '"') inString = false;
        } else if (ch === '"') {
            inString = true;
        } else if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
            return true;
        }
    }
    return false;
}

/**
 * Parse an adopter settings.json. A leading UTF-8 BOM (Windows editors, PowerShell 5
 * `Set-Content -Encoding UTF8`) is stripped; the merge writes the file back without it. JSON
 * with comments is NOT parsed: dropping the adopter's comments on rewrite would corrupt the
 * file, so it is refused, loudly, with the deny union reported as not applied.
 *
 * @param {string} text
 * @returns {{ ok: true, obj: object, hadBom: boolean } | { ok: false, detail: string }}
 */
function parseSettingsText(text) {
    const hadBom = text.charCodeAt(0) === 0xFEFF;
    const body = hadBom ? text.slice(1) : text;
    try {
        return { ok: true, obj: JSON.parse(body), hadBom };
    } catch (err) {
        const why = hasJsonComments(body) ? 'it contains // or /* */ comments' : err.message;
        return {
            ok: false,
            detail: `target settings.json is not valid JSON (${why}) — skipping to avoid corruption; ` +
                'permissions.deny union NOT applied, so the hard-deny wall is missing here: fix the file (remove any comments) or ' +
                'add the template permissions.deny entries by hand',
        };
    }
}

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

    const parsedDest = parseSettingsText(fs.readFileSync(destAbs, 'utf8'));
    if (!parsedDest.ok) {
        // Unparseable (corrupt, or JSONC comments) — warn and skip; never corrupt the adopter's
        // file. The detail says the deny union was NOT applied; the updater counts it as actionable.
        return { action: 'skipped', detail: parsedDest.detail, denyUnionSkipped: true };
    }
    const destObj = parsedDest.obj;

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

    // permissions stays project-owned, but the template's deny entries are unioned in.
    const denyBefore = JSON.stringify(ownDeny(destObj.permissions));
    const { dropped } = applyDenyUnion(merged, srcObj);
    const denyChanged = JSON.stringify(ownDeny(merged.permissions)) !== denyBefore;

    const notices = shellNotices(shellGaps, merged.permissions);
    const shellNote = (notices.length > 0 ? `; PowerShell not covered: ${notices.join('; ')}` : '') +
        droppedNote(dropped) + (parsedDest.hadBom ? '; removed the UTF-8 BOM' : '');

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
        if (denyChanged) changed.push('permissions.deny');
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
    if (denyChanged) updatedKeys.push('permissions.deny');
    const detail = updatedKeys.length > 0
        ? `merged (updated: ${updatedKeys.join(', ')}${preservedNote})`
        : `merged (no template-owned key changes; project-owned keys preserved${preservedNote})`;

    return { action: 'merged', detail: `${detail}${shellNote}`, notices };
}

/**
 * Compute, without writing, the adopter settings.json that results from applying ONLY the
 * template's `permissions.deny` union: every other key (hooks, allow, ask, env, ...) stays
 * exactly as the adopter has it. For callers that keep an existing settings.json but must still
 * ship the hard-deny wall (install.js on a `.claude/` that already has one). The caller writes
 * `content` (through its own atomic/contained write path) when `action` is 'merged'.
 *
 * @param {string} srcAbs  — absolute path to the template settings.json
 * @param {string} destAbs — absolute path to the existing adopter settings.json
 * @returns {{ action: 'merged'|'unchanged'|'skipped', detail: string, content?: string, denyUnionSkipped?: boolean }}
 */
function planDenyUnion(srcAbs, destAbs) {
    let srcObj;
    try {
        srcObj = JSON.parse(fs.readFileSync(srcAbs, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
        return { action: 'skipped', detail: `could not read/parse template settings.json — ${err.message}`, denyUnionSkipped: true };
    }
    const parsedDest = parseSettingsText(fs.readFileSync(destAbs, 'utf8'));
    if (!parsedDest.ok) return { action: 'skipped', detail: parsedDest.detail, denyUnionSkipped: true };

    const merged = Object.create(null);
    for (const key of Object.keys(parsedDest.obj)) merged[key] = parsedDest.obj[key];
    const { dropped } = applyDenyUnion(merged, srcObj);

    const content = JSON.stringify(merged, null, 2) + '\n';
    const extra = droppedNote(dropped) + (parsedDest.hadBom ? '; removed the UTF-8 BOM' : '');
    if (content === fs.readFileSync(destAbs, 'utf8')) return { action: 'unchanged', detail: 'permissions.deny already complete' };
    return { action: 'merged', detail: `permissions.deny union applied${extra}`, content };
}

module.exports = {
    mergeSettingsFile,
    planDenyUnion,
    // Expose policy constants so tests can verify they are correct
    TEMPLATE_OWNED_KEYS,
    PROJECT_OWNED_KEYS,
    // Exposed for unit tests
    extractHookScript,
    unionDenyList,
};
