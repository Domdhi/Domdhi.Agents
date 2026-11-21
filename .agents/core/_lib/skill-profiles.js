'use strict';
/**
 * Skill profiles — resolve a project's effective skill and role set from the
 * toolkit-owned profiles in `.agents/adapters/skill-profiles.json`, and find
 * kept skills or roles that still invoke a dropped skill (the closure check).
 *
 * Selection (project `.claude/update-config.json`):
 *   - no `skillProfile`: every toolkit skill except `skillExclude`, every role
 *     (the behaviour before profiles existed);
 *   - `skillProfile: name`: the profile's skills + `skillInclude` - `skillExclude`,
 *     and the profile's roles.
 *
 * The toolkit universe is the union of every profile's skills and roles, so a
 * project's bespoke skills and roles are never excluded. Every toolkit skill
 * and role belongs to the `app` profile (enforced by skill-profiles-live.test.js).
 *
 * Zero runtime dependencies beyond the toolkit's own `_lib`.
 */
const fs = require('fs');
const path = require('path');
const { stripExcludedSkills } = require('./agent-merger');

const PROFILES_REL = '.agents/adapters/skill-profiles.json';
const WORKFLOWS_REL = '.agents/adapters/workflows.json';

// Skills the toolkit renamed: a project that names the old one keeps meaning the skill under its new name.
const RENAMED_SKILLS = Object.freeze({ 'learning-intake': 'intake' });

/** Add the new name of any renamed skill present in `names` (mutates and returns the Set). */
function withRenamedSkills(names) {
    for (const [from, to] of Object.entries(RENAMED_SKILLS)) if (names.has(from)) names.add(to);
    return names;
}

/**
 * "if installed" / "when installed" marks the nearest invocation on its line as
 * optional: `Run /do, then /sweep if installed.` makes only `/sweep` optional.
 */
const OPTIONAL_LINE = /\b(?:if|when) installed\b/i;
const OPTIONAL_MARK = /\b(?:if|when) installed\b/gi;
// Any invocation-shaped token: `/name`, `ns:name`, `skills/name`. Used to tell which
// invocation an "if installed" marker belongs to.
const INVOCATION_TOKEN = /(?<![\w./-])\/?[a-z][a-z0-9-]*:[a-z][\w-]*|(?<![\w./-])\/[a-z][\w-]*(?![\w/-])|skills\/[\w-]+/g;
// A block of always-delivered text that lists commands as a catalogue (each available
// only when installed) is wrapped in these markers and is not an invocation.
const CATALOGUE_START = '<!-- skill-profile:catalogue-start -->';
const CATALOGUE_END = '<!-- skill-profile:catalogue-end -->';
// Always-delivered root instructions, scanned as callers too.
const ALWAYS_DELIVERED = ['.agents/startup.md', '.agents/startup-reference.md'];

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Load the toolkit profiles. A toolkit without the file has no profiles.
 * @param {string} toolkitRoot
 * @returns {Record<string, { description?: string, skills: string[], roles: string[] }>}
 */
function loadProfiles(toolkitRoot) {
    const file = path.join(toolkitRoot, PROFILES_REL);
    if (!fs.existsSync(file)) return {};
    const data = readJson(file);
    const profiles = data && typeof data.profiles === 'object' && data.profiles ? data.profiles : {};
    for (const [name, profile] of Object.entries(profiles)) {
        const ok = profile && Array.isArray(profile.skills) && profile.skills.every(s => typeof s === 'string')
            && Array.isArray(profile.roles) && profile.roles.every(r => typeof r === 'string');
        if (!ok) throw new Error(`skill-profiles: profile "${name}" must list "skills" and "roles" as string arrays (${PROFILES_REL})`);
    }
    return profiles;
}

/** The toolkit skill and role universe: the union of every profile. */
function profileUniverse(profiles) {
    const skills = new Set();
    const roles = new Set();
    for (const profile of Object.values(profiles)) {
        for (const s of profile.skills) skills.add(s);
        for (const r of profile.roles) roles.add(r);
    }
    return { skills, roles };
}

/**
 * Resolve the effective selection for a project configuration.
 *
 * @param {object} args
 * @param {string} args.toolkitRoot — root whose `.agents/adapters/skill-profiles.json` defines the profiles
 * @param {{ skillProfile?: string, skillInclude?: string[], skillExclude?: string[] }} [args.config]
 * @returns {{ profile: string|null, keptSkills: Set<string>, keptRoles: Set<string>,
 *             excludedSkills: Set<string>, excludedRoles: Set<string>,
 *             universe: { skills: Set<string>, roles: Set<string> },
 *             errors: string[], warnings: string[] }}
 */
function resolveSelection({ toolkitRoot, config = {} }) {
    const errors = [];
    const warnings = [];
    let profiles = {};
    try {
        profiles = loadProfiles(toolkitRoot);
    } catch (err) {
        errors.push(err.message);
    }
    const universe = profileUniverse(profiles);
    const exclude = withRenamedSkills(new Set(Array.isArray(config.skillExclude) ? config.skillExclude : []));
    const include = withRenamedSkills(new Set(Array.isArray(config.skillInclude) ? config.skillInclude : []));
    const profileName = typeof config.skillProfile === 'string' && config.skillProfile ? config.skillProfile : null;

    if (!profileName) {
        // Pre-profile behaviour: exclude exactly what the project lists; every role ships.
        if (include.size) warnings.push('skillInclude has no effect without skillProfile');
        return {
            profile: null,
            keptSkills: new Set([...universe.skills].filter(s => !exclude.has(s))),
            keptRoles: new Set(universe.roles),
            excludedSkills: exclude,
            excludedRoles: new Set(),
            universe, errors, warnings,
        };
    }

    const profile = Object.hasOwn(profiles, profileName) ? profiles[profileName] : null;
    if (!profile) {
        const known = Object.keys(profiles).sort().join(', ') || 'none';
        errors.push(`unknown skillProfile "${profileName}" (known profiles: ${known})`);
        return {
            profile: profileName,
            keptSkills: new Set(), keptRoles: new Set(),
            excludedSkills: new Set(exclude), excludedRoles: new Set(),
            universe, errors, warnings,
        };
    }
    for (const name of include) {
        if (!universe.skills.has(name)) warnings.push(`skillInclude names "${name}", which is not a toolkit skill`);
    }
    for (const name of exclude) {
        if (!universe.skills.has(name)) warnings.push(`skillExclude names "${name}", which is not a toolkit skill`);
    }
    const keptSkills = new Set([...profile.skills, ...include].filter(s => !exclude.has(s)));
    const keptRoles = new Set(profile.roles);
    const excludedSkills = new Set([...universe.skills].filter(s => !keptSkills.has(s)));
    for (const name of exclude) excludedSkills.add(name);
    const excludedRoles = new Set([...universe.roles].filter(r => !keptRoles.has(r)));
    return { profile: profileName, keptSkills, keptRoles, excludedSkills, excludedRoles, universe, errors, warnings };
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Workflow skills (invoked as commands) and their colon command form, from
 * `.claude/commands/{ns}/{x}.md` → `{ns}:{x}`; top-level commands have no colon form.
 */
function workflowForms(root) {
    const file = path.join(root, WORKFLOWS_REL);
    const forms = new Map();
    if (!fs.existsSync(file)) return forms;
    for (const [name, dest] of Object.entries(readJson(file))) {
        const match = /commands\/([^/]+)\/([^/]+)\.md$/.exec(String(dest));
        forms.set(name, match ? `${match[1]}:${match[2]}` : null);
    }
    return forms;
}

/**
 * Build one matcher per target skill. Forms:
 *   - `/name` slash form for any skill (not part of a longer path or word)
 *   - `skills/name` path form for any skill (a read-this-file instruction)
 *   - for workflow skills (invoked as commands): the bare hyphenated name
 *     (`review-qa`) and the colon command form (`review:qa`, `/review:qa`,
 *     `create:new-project`)
 * A knowledge skill's bare name (`tailwind-css-patterns` in a list of stack
 * examples) is a mention, not an invocation, and is not matched.
 */
function referenceMatchers(targets, root) {
    const workflows = workflowForms(root);
    const matchers = new Map();
    for (const target of targets) {
        const t = escapeRegex(target);
        const forms = [];
        if (workflows.has(target) && target.includes('-')) forms.push({ form: 'name', re: `(?<![\\w.-])${t}(?![\\w-])` });
        forms.push({ form: 'slash', re: `(?<![\\w./-])/${t}(?![\\w/-])` });
        forms.push({ form: 'path', re: `skills/${t}(?![\\w-])` });
        const colon = workflows.get(target);
        if (colon) forms.push({ form: 'colon', re: `(?<![\\w-])/?${escapeRegex(colon)}(?![\\w-])` });
        matchers.set(target, forms.map(f => ({ form: f.form, re: new RegExp(f.re) })));
    }
    return matchers;
}

// Text a skill delivers: instructions, data, and the scripts it ships.
const SCANNED_FILE = /\.(?:md|json|js|cjs|mjs|sh|py)$/;

/** Every scanned file under `dir`, following symlinked directories (adopters often link skill dirs). */
function walkFiles(dir, seen = new Set()) {
    const out = [];
    let real;
    try { real = fs.realpathSync(dir); } catch { return out; }
    if (seen.has(real)) return out;
    seen.add(real);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        let stat;
        try { stat = fs.statSync(abs); } catch { continue; } // a broken link delivers nothing
        if (stat.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
            out.push(...walkFiles(abs, seen));
        } else if (SCANNED_FILE.test(entry.name)) out.push(abs);
    }
    return out.sort();
}

/** Line numbers covered by a leading `---` frontmatter block (0-based, inclusive). */
function frontmatterLines(lines) {
    if (lines[0] !== '---') return new Set();
    const end = lines.indexOf('---', 1);
    if (end < 0) return new Set();
    return new Set(Array.from({ length: end + 1 }, (_, i) => i));
}

/** Lines inside a catalogue block (markers included). */
function catalogueLines(lines) {
    const skip = new Set();
    let inside = false;
    lines.forEach((line, index) => {
        if (line.includes(CATALOGUE_START)) inside = true;
        if (inside) skip.add(index);
        if (line.includes(CATALOGUE_END)) inside = false;
    });
    return skip;
}

/**
 * Is the reference at [start, end) optional? It is when an "if installed" marker on the
 * line is nearer to it than any other invocation, i.e. no other invocation token lies
 * between the reference and its nearest marker.
 */
function optionalAt(line, start, end) {
    if (!OPTIONAL_LINE.test(line)) return false;
    const marks = [...line.matchAll(OPTIONAL_MARK)].map(m => m.index);
    const tokens = [...line.matchAll(INVOCATION_TOKEN)].map(m => [m.index, m.index + m[0].length])
        .filter(([s, e]) => e <= start || s >= end); // other invocations, not this one
    const nearest = marks.reduce((best, m) => (best === null || Math.abs(m - start) < Math.abs(best - start) ? m : best), null);
    const [lo, hi] = nearest < start ? [nearest, start] : [end, nearest];
    return !tokens.some(([s, e]) => s >= lo && e <= hi);
}

function scanText({ text, caller, file, matchers, skipFrontmatter, results }) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const skip = new Set([...(skipFrontmatter ? frontmatterLines(lines) : []), ...catalogueLines(lines)]);
    lines.forEach((line, index) => {
        if (skip.has(index)) return;
        for (const [target, forms] of matchers) {
            for (const f of forms) {
                const hit = [...line.matchAll(new RegExp(f.re.source, 'g'))].find(m => !optionalAt(line, m.index, m.index + m[0].length));
                if (hit) {
                    results.push({ caller, file, line: index + 1, target, form: f.form, text: line.trim() });
                    break;
                }
            }
        }
    });
}

/**
 * A skill's delivered directory: the canonical `.agents/skills/{name}`, or the native
 * `.claude/skills/{name}` for a skill an adopter owns there (e.g. brand-guidelines).
 */
function skillDir(root, name) {
    const canonical = path.join(root, '.agents/skills', name);
    if (fs.existsSync(canonical)) return canonical;
    const native = path.join(root, '.claude/skills', name);
    return fs.existsSync(native) ? native : null;
}

/** Kept skills and roles that this tree does not contain: their invocations cannot be verified. */
function missingKept({ root, keptSkills, keptRoles }) {
    const skills = [...new Set(keptSkills)].filter(s => !skillDir(root, s)).sort();
    const roles = [...new Set(keptRoles)].filter(r => !fs.existsSync(path.join(root, '.agents/roles', `${r}.md`))).sort();
    return { skills, roles };
}

/**
 * Find references from kept skills and kept roles to dropped skills.
 *
 * @param {object} args
 * @param {string} args.root — tree whose `.agents/skills` and `.agents/roles` are scanned
 * @param {Iterable<string>} args.keptSkills
 * @param {Iterable<string>} args.keptRoles
 * @param {Iterable<string>} args.droppedSkills — the targets
 * @param {Set<string>} [args.universe] — when given, targets outside it are ignored
 * @returns {Array<{ caller: string, file: string, line: number, target: string, form: string, text: string }>}
 */
function findDanglingReferences({ root, keptSkills, keptRoles, droppedSkills, universe }) {
    // Only toolkit skills can dangle; a name outside the universe (a renamed skill's
    // old name, a typo) has no delivered body to miss.
    const dropped = new Set([...droppedSkills].filter(s => !universe || universe.has(s)));
    const results = [];
    if (!dropped.size) return results;
    const matchers = referenceMatchers([...dropped].sort(), root);
    for (const skill of [...new Set(keptSkills)].sort()) {
        if (dropped.has(skill)) continue;
        const dir = skillDir(root, skill);
        if (!dir) continue;
        for (const abs of walkFiles(dir)) {
            const text = fs.readFileSync(abs, 'utf8');
            scanText({ text, caller: `skill:${skill}`, file: path.relative(root, abs).replace(/\\/g, '/'), matchers, skipFrontmatter: false, results });
        }
    }
    for (const role of [...new Set(keptRoles)].sort()) {
        const abs = path.join(root, '.agents/roles', `${role}.md`);
        if (!fs.existsSync(abs)) continue;
        // Frontmatter `skills:` and `## Skills` path bullets are stripped on delivery;
        // other frontmatter (name, aliases, description) names the role, not an invocation.
        const text = stripExcludedSkills(fs.readFileSync(abs, 'utf8'), dropped);
        scanText({ text, caller: `role:${role}`, file: path.relative(root, abs).replace(/\\/g, '/'), matchers, skipFrontmatter: true, results });
    }
    for (const rel of ALWAYS_DELIVERED) {
        const abs = path.join(root, rel);
        if (!fs.existsSync(abs)) continue;
        scanText({ text: fs.readFileSync(abs, 'utf8'), caller: `doc:${path.basename(rel, '.md')}`, file: rel, matchers, skipFrontmatter: false, results });
    }
    return results;
}

/**
 * Callers that must also be dropped to close a requested exclusion, found
 * transitively over kept skills (roles are reported, not dropped: they are
 * chosen by the profile).
 *
 * @returns {{ skills: string[], roles: string[], references: object[] }}
 */
function suggestClosure({ root, keptSkills, keptRoles, droppedSkills }) {
    const kept = new Set(keptSkills);
    const dropped = new Set(droppedSkills);
    for (const s of dropped) kept.delete(s);
    const added = new Set();
    const roles = new Set();
    let references = [];
    for (;;) {
        references = findDanglingReferences({ root, keptSkills: kept, keptRoles, droppedSkills: dropped });
        const callers = new Set(references.filter(r => r.caller.startsWith('skill:')).map(r => r.caller.slice(6)));
        for (const r of references) if (r.caller.startsWith('role:') || r.caller.startsWith('doc:')) roles.add(r.caller);
        if (!callers.size) break;
        for (const c of callers) { kept.delete(c); dropped.add(c); added.add(c); }
    }
    return { skills: [...added].sort(), roles: [...roles].sort(), references };
}

/** Human-readable refusal listing, one reference per line. */
function formatDangling(references) {
    return references.map(r => `  ${r.caller} → ${r.target} (${r.file}:${r.line})`).join('\n');
}

/**
 * Resolve a project configuration against a toolkit tree and check that the
 * selection is closed. `details` are the lines a refusal prints: resolution
 * errors, or each dangling reference followed by the smallest fix.
 *
 * @param {string} toolkitRoot — the tree whose skills and roles would be delivered
 * @param {object} config — the project's update-config.json object
 * @returns {{ ok: boolean, selection: object, references: object[], details: string[], unverified?: string[] }}
 */
function checkSelectionClosure(toolkitRoot, config = {}) {
    const selection = resolveSelection({ toolkitRoot, config });
    if (selection.errors.length) return { ok: false, selection, references: [], details: selection.errors };
    const args = { root: toolkitRoot, keptSkills: selection.keptSkills, keptRoles: selection.keptRoles, droppedSkills: selection.excludedSkills, universe: selection.universe.skills };
    // A kept skill or role absent from this tree delivers nothing, so it cannot dangle here,
    // but its invocations were not checked either: say so instead of claiming it closed.
    // The update/install preflight scans the source tree, where every kept skill exists.
    const missing = missingKept(args);
    const unverified = [];
    if (missing.skills.length) unverified.push(`unverified (kept but not in this tree): skills ${missing.skills.join(', ')}`);
    if (missing.roles.length) unverified.push(`unverified (kept but not in this tree): roles ${missing.roles.join(', ')}`);
    const references = findDanglingReferences(args);
    if (!references.length) return { ok: true, selection, references, details: [], unverified };
    const targets = [...new Set(references.map(r => r.target))].sort();
    const closure = suggestClosure({ ...args, droppedSkills: [...selection.excludedSkills].filter(s => selection.universe.skills.has(s)) });
    const details = ['kept skills or roles still invoke a dropped skill:', ...references.map(r => `  ${r.caller} → ${r.target} (${r.file}:${r.line})`)];
    details.push(`fix: keep ${targets.join(', ')} (${selection.profile ? 'add to skillInclude or remove from skillExclude' : 'remove from skillExclude'})`);
    if (closure.skills.length) details.push(`  or also drop ${closure.skills.join(', ')} (skillExclude)`);
    if (closure.roles.length) details.push(`  roles or docs that still name a dropped skill: ${closure.roles.join(', ')} (choose a profile without them, or mark the line "if installed" in the toolkit)`);
    return { ok: false, selection, references, details, unverified };
}

module.exports = {
    PROFILES_REL,
    RENAMED_SKILLS,
    OPTIONAL_LINE,
    CATALOGUE_START,
    CATALOGUE_END,
    withRenamedSkills,
    missingKept,
    loadProfiles,
    profileUniverse,
    resolveSelection,
    findDanglingReferences,
    suggestClosure,
    formatDangling,
    checkSelectionClosure,
};
