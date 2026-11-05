#!/usr/bin/env node

/**
 * Template Updater — copies Template-zone files from this repo's .claude/ to a target project.
 *
 * Zone boundaries (docs/reference/agents/customization.md):
 *   Template zone  — overwrite (commands, core, hooks, skills, templates, etc.)
 *                    Skill files (skills/<name>/*.md) get an escape hatch under --merge:
 *                    a target copy carrying a <!-- @@project-additions --> tail is merged
 *                    (template head refreshed, adopter tail preserved). See _lib/skill-merger.js.
 *   Project zone   — never touch (settings.local.json, update-config.json)
 *                    settings.json is also project-zone by default, but under
 *                    --merge it becomes effectively Mixed: template-owned sections
 *                    (hooks, plansDirectory, statusLine) are overwritten while
 *                    project-owned sections (permissions, env, $schema, unknown
 *                    keys) are preserved. See _lib/settings-merger.js for the policy.
 *   Mixed zone     — merged (agents/*.md); skipped with a warning under --no-merge
 *
 * Merging is the default: the section-aware merges preserve every project-owned part, and an
 * update that skipped roles and the settings hooks was only partly applied. `--merge` is still
 * accepted (the fleet passes it); `--no-merge` opts out.
 *
 * Usage:
 *   node .claude/core/template-updater.js update <target-path>
 *   node .claude/core/template-updater.js update <target-path> --no-merge
 *   node .claude/core/template-updater.js update <target-path> --dry-run
 *
 * The CLI runs preflightUpdate (operation `update`, scope UPDATE_SCOPE) before
 * any target read that selects mutation; runUpdate is the internal engine.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const zoneClassifier   = require('./_lib/zone-classifier');
const { walkDir }      = require('./_lib/file-walker');
const agentMerger      = require('./_lib/agent-merger');
const settingsMerger   = require('./_lib/settings-merger');
const skillMerger      = require('./_lib/skill-merger');
const { copyWithZoneEnforcement } = require('./_lib/zone-copy');
const { safeCopy, assertNoSymlinkedAncestor } = require('./_lib/fs-safe');
const { applyManagedBlock }       = require('./scaffold');
const { ignoredFilter }           = require('./_lib/git-ignored');
const { hiddenManagedFiles, describeHidden } = require('./_lib/ignored-managed');
const { syncSharedAgents, syncStartupInstructions, projectionPaths, renderSharedAgents, isExcludedSkillPath, workflowMap } = require('./_lib/shared-agents');

const { classifyClaudeFile }  = zoneClassifier;
const { mergeAgentFile }      = agentMerger;
const { mergeSettingsFile }   = settingsMerger;
const { mergeSkillFile, hasProjectAdditions } = skillMerger;

const PROJECT_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');

// Source CLAUDE.md → target .claude/README.md (template docs, not project docs)
const ROOT_DOC_REDIRECT = { src: 'CLAUDE.md', dest: '.claude/README.md' };

// Root-level dirs that are Template zone (no entries today; .githooks/ was
// retired 2026-05-09 when the secret-scanner moved to a Claude Code hook).
const ROOT_TEMPLATE_FILES = [];
const ROOT_TEMPLATE_DIRS  = [];

// Dirs never propagated (keep test scaffolding local)
const ALWAYS_SKIP_DIRS = ['__tests__', '_helpers', 'node_modules'];

// Every target-relative root an ordinary update may read or write: the shared
// .agents/ sync and its native projections, the .claude/ zone walk (including
// README.md and the version marker), the managed root .gitignore block and the
// startup-instruction merge into AGENTS.md / CLAUDE.md.
const UPDATE_SCOPE = Object.freeze(['.agents', '.claude', '.codex', '.gitignore', 'AGENTS.md', 'CLAUDE.md']);

// Fixed front-door refusal text: never echo config bytes or parser errors.
const FRONT_DOOR_MESSAGES = {
    REQUEST: 'Toolkit request must specify source and target paths and a boolean dryRun.',
    TARGET: 'Target must be an existing directory; mutation is refused.',
    PATH: 'Target scope must stay inside the project without symbolic links; mutation is refused.',
    ASSETS: 'Required toolkit source assets are missing; mutation is refused.',
    CONFIG: 'Project .claude/update-config.json must be a regular JSON object whose optional skillExclude is an array of strings; mutation is refused.',
    VALIDATION: 'A toolkit validation substep failed; mutation is refused.',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function copyFile(src, dest, containRoot) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    safeCopy(src, dest, containRoot);
}

function tryAction(label, fn, stats) {
    try { fn(); } catch (err) {
        console.error(`  ERROR    ${label} — ${err.message}`);
        stats.errors++;
    }
}

/**
 * Load the set of skill names the target project has opted out of, from its
 * .claude/update-config.json (`{ "skillExclude": ["tailwind-css-patterns", ...] }`).
 * Missing/invalid config → empty set (no exclusions). Never throws.
 *
 * @param {string} targetClaudeDir  — absolute path to the target's .claude/
 * @returns {Set<string>}
 */
function loadExcludedSkills(targetClaudeDir) {
    const cfgPath = path.join(targetClaudeDir, 'update-config.json');
    if (!fs.existsSync(cfgPath)) return new Set();
    try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        return Array.isArray(cfg.skillExclude) ? new Set(cfg.skillExclude) : new Set();
    } catch (err) {
        console.error(`  WARN     could not parse .claude/update-config.json — ignoring exclusions (${err.message})`);
        return new Set();
    }
}

/**
 * Strict reader for the target's project-owned .claude/update-config.json, used
 * by the direct install/update front doors before any mutation. Unlike the
 * tolerant loadExcludedSkills (warn-and-ignore, kept for its existing callers),
 * a config that exists but is not a regular file, is not valid JSON, is not a
 * plain object, or carries a non-string-array skillExclude is a refusal: an
 * engine that silently ignored it would re-import skills the project dropped.
 * Never throws.
 *
 * @param {string} targetClaudeDir — absolute path to the target's .claude/
 * @returns {{ ok: true, skillExclude: string[] } | { ok: false, code: 'CONFIG', message: string }}
 */
function readUpdateConfig(targetClaudeDir) {
    const refusal = { ok: false, code: 'CONFIG', message: FRONT_DOOR_MESSAGES.CONFIG };
    try {
        const cfgPath = path.join(targetClaudeDir, 'update-config.json');
        const stat = fs.lstatSync(cfgPath, { throwIfNoEntry: false });
        if (!stat) return { ok: true, skillExclude: [] };
        if (!stat.isFile()) return refusal;
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const plain = cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg)
            && (Object.getPrototypeOf(cfg) === Object.prototype || Object.getPrototypeOf(cfg) === null);
        if (!plain) return refusal;
        if (!Object.hasOwn(cfg, 'skillExclude')) return { ok: true, skillExclude: [] };
        const list = cfg.skillExclude;
        if (!Array.isArray(list) || !list.every(name => typeof name === 'string')) return refusal;
        return { ok: true, skillExclude: [...list] };
    } catch {
        return refusal;
    }
}

function frontDoorRefusal(code, dryRun) {
    return { ok: false, exitCode: 1, errors: [{ code, message: FRONT_DOOR_MESSAGES[code] }], dryRun: dryRun === true };
}

/**
 * Validate the target mutation scope before any engine reads or writes it.
 * Existing links are refused at the read boundary as well as at write sites.
 */
function validateTargetScope(target, scope) {
    const visit = abs => {
        assertNoSymlinkedAncestor(abs, target);
        const stat = fs.lstatSync(abs, { throwIfNoEntry: false });
        if (!stat) return;
        if (stat.isSymbolicLink()) throw new Error('Symbolic link in target scope');
        if (stat.isDirectory()) {
            // A real dependency tree is never toolkit content (the update ships no file under it),
            // and package managers fill it with links such as node_modules/.bin/*.
            if (path.basename(abs) === 'node_modules') return;
            for (const name of fs.readdirSync(abs)) visit(path.join(abs, name));
        }
    };
    for (const rel of scope) {
        if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) throw new Error('Invalid scope');
        visit(path.resolve(target, rel));
    }
}

/**
 * Read-only direct-entry preflight: request → source assets → target directory
 * and contained, symlink-free mutation scope → strict project update-config.
 * Ordinary projects do not require Git metadata or an organization declaration.
 * Unexpected validation failures refuse before mutation.
 *
 * @param {{ source: string, target: string, dryRun?: boolean }} request
 * @param {{ operation: string, scope: Function, assetsPresent: Function }} spec
 */
function preflightFrontDoor(request, spec) {
    const dryRun = Boolean(request && request.dryRun === true);
    try {
        if (request === null || typeof request !== 'object') return frontDoorRefusal('REQUEST', dryRun);
        const { source, target } = request;
        if (typeof source !== 'string' || source === '' || typeof target !== 'string' || target === ''
            || (request.dryRun !== undefined && typeof request.dryRun !== 'boolean')) return frontDoorRefusal('REQUEST', dryRun);
        const sourceRoot = path.resolve(source);
        if (!spec.assetsPresent(sourceRoot)) return frontDoorRefusal('ASSETS', dryRun);
        const targetStat = fs.lstatSync(path.resolve(target), { throwIfNoEntry: false });
        if (!targetStat || !targetStat.isDirectory()) return frontDoorRefusal('TARGET', dryRun);
        const targetRoot = fs.realpathSync.native(target);
        let scope;
        try {
            scope = spec.scope(sourceRoot, targetRoot);
            validateTargetScope(targetRoot, scope);
        } catch {
            return frontDoorRefusal('PATH', dryRun);
        }
        if (!readUpdateConfig(path.join(targetRoot, '.claude')).ok) return frontDoorRefusal('CONFIG', dryRun);
        return { ok: true, exitCode: 0, source: sourceRoot, target: targetRoot, operation: spec.operation, scope, dryRun };
    } catch {
        return frontDoorRefusal('VALIDATION', dryRun);
    }
}

function isDirectory(abs) {
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    return Boolean(stat && stat.isDirectory());
}

function isFile(abs) {
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    return Boolean(stat && stat.isFile());
}

/** The sync-complete marker source: canonical config first, legacy .claude/ copy second. */
function hasVersionSource(source) {
    return isFile(path.join(source, '.agents', 'config', 'version.json')) || isFile(path.join(source, '.claude', 'version.json'));
}

/**
 * Direct `update` preflight (see preflightFrontDoor).
 *
 * @param {{ source: string, target: string, dryRun?: boolean }} request
 */
function preflightUpdate(request) {
    return preflightFrontDoor(request, {
        operation: 'update',
        scope: () => [...UPDATE_SCOPE],
        assetsPresent: source => isDirectory(path.join(source, '.claude')) && hasVersionSource(source),
    });
}

/**
 * Set of skill-directory names under a `.claude/skills/` dir. Counts a SYMLINKED
 * skill dir too (statSync, not Dirent.isDirectory) — an adopter's bespoke skills
 * are frequently symlinks into a shared ../.agents/skills/, and Dirent.isDirectory()
 * returns false for a symlink. If dropped from the target-skills set, those skills
 * fail mergeFrontmatter's bespoke-union check and get silently stripped off every
 * specialized agent's frontmatter on sync. Guards statSync against a broken symlink.
 * Returns an empty Set if the dir doesn't exist.
 *
 * @param {string} dir  — path to a `.claude/skills/` directory
 * @returns {Set<string>}
 */
function listSkillDirs(dir) {
    try {
        return new Set(fs.readdirSync(dir, { withFileTypes: true })
            .filter(d => {
                if (d.isDirectory()) return true;
                if (!d.isSymbolicLink()) return false;
                try { return fs.statSync(path.join(dir, d.name)).isDirectory(); }
                catch { return false; }
            })
            .map(d => d.name));
    } catch { return new Set(); }
}

// ── Main Command: update ──────────────────────────────────────────────────────

function runUpdate(targetPath, options) {
    options = options || {};
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || PROJECT_ROOT;

    if (!fs.existsSync(targetPath)) {
        console.error(`Error: target path does not exist: ${targetPath}`);
        process.exit(1);
    }
    const targetClaudeDir = path.join(targetPath, '.claude');
    if (!fs.existsSync(targetClaudeDir)) {
        console.error(`Error: target path does not contain a .claude/ directory: ${targetPath}`);
        console.error('  This tool only updates existing .claude/ installations.');
        process.exit(1);
    }

    console.log(`Template Updater${options.dryRun ? ' (DRY RUN)' : ''}`);
    console.log(`  Source : ${projectRoot}`);
    console.log(`  Target : ${targetPath}`);
    console.log('');

    const stats    = { copied: 0, merged: 0, skipped: 0, warned: 0, mergeWarned: 0, errors: 0, conflicts: [] };
    const warnings = [];

    // Per-project skill exclusions — the target declares template skills it does
    // not want (e.g. tailwind-css-patterns in a non-Tailwind project). Read from
    // the target's own .claude/update-config.json (Project zone, never overwritten).
    // Without this, every update re-imports skills the project deliberately dropped.
    // Git-ignored source files are local state (for example a *.log inside a
    // shipped skill directory); they never update. A failed query in a real
    // checkout throws here, before any target write.
    const isIgnored = ignoredFilter(projectRoot, { failureMessage: 'Update source ignored-file query failed; nothing was written.' });

    const excludedSkills = loadExcludedSkills(targetClaudeDir);
    if (excludedSkills.size > 0) {
        console.log(`  Excluding skills (per update-config.json): ${[...excludedSkills].join(', ')}`);
        console.log('');
    }

    // ── .claude/ files ────────────────────────────────────────────────────────

    const sourceClaudeDir = path.join(projectRoot, '.claude');
    const projections = projectionPaths(projectRoot);

    // Skill sets for the agent-merge skills-union. A skill in a target agent's
    // frontmatter that is NOT shipped by the template (not canonical) but DOES exist
    // as a skill dir in the target is a project specialization (added by
    // /review:specialize) and must survive the merge — otherwise every update strips
    // a specialized agent's domain skills off its frontmatter.
    // A Git-ignored local skill in the source is not template-owned: counting it
    // would let the skills union strip an adopter's same-named specialization.
    const canonicalSkills = new Set([...listSkillDirs(path.join(sourceClaudeDir, 'skills'))].filter(s => !isIgnored(`.claude/skills/${s}/SKILL.md`)));
    const targetSkills    = listSkillDirs(path.join(targetClaudeDir, 'skills'));
    for (const s of listSkillDirs(path.join(projectRoot, '.agents/skills'))) if (!isIgnored(`.agents/skills/${s}/SKILL.md`)) canonicalSkills.add(s);
    for (const s of listSkillDirs(path.join(targetPath, '.agents/skills'))) targetSkills.add(s);

    let sharedUpdateReady = false;
    tryAction('.agents shared update', () => {
        const r = syncSharedAgents(projectRoot, targetPath, { ...options, canonicalSkills, targetSkills, excludedSkills, deferredOutputs: new Set(['.claude/version.json']) });
        sharedUpdateReady = r.conflicts.length === 0;
        stats.copied += r.copied; stats.merged += r.merged; stats.skipped += r.skipped;
        stats.conflicts.push(...r.conflicts);
        for (const rel of r.changed) console.log(`  ${options.dryRun ? 'PLAN' : 'UPDATE'}   ${rel}`);
        for (const rel of r.conflicts) {
            const warning = `${rel} — generated output edited; review canonical source before rendering`;
            console.log(`  CONFLICT ${warning}`); warnings.push(warning); stats.warned++; stats.mergeWarned++;
        }
        for (const warning of r.warnings) { console.log(`  WARN     ${warning}`); warnings.push(warning); stats.warned++; stats.mergeWarned++; }
    }, stats);

    // A projection conflict or failed shared phase leaves the update incomplete:
    // stop before the .claude/ walk, root docs, the managed .gitignore block and
    // the version marker, matching install's refuse-before-write behavior.
    if (!sharedUpdateReady) {
        console.log('');
        console.log('─────────────────────────────────────────────');
        console.log(`Update INCOMPLETE — ${stats.conflicts.length ? 'generated projection conflict' : 'shared update failed'}; no further files were written and .claude/version.json was not updated.`);
        for (const warning of warnings) console.log(`  ! ${warning}`);
        if (stats.errors > 0) process.exit(1);
        return stats;
    }

    for (const srcAbs of walkDir(sourceClaudeDir, ALWAYS_SKIP_DIRS)) {
        const relToClause = path.relative(sourceClaudeDir, srcAbs);
        const zone        = classifyClaudeFile(relToClause);
        const destAbs     = path.join(targetClaudeDir, relToClause);
        const rel         = relToClause.replace(/\\/g, '/');
        if (projections.has(`.claude/${rel}`)) continue;
        if (isIgnored(`.claude/${rel}`)) continue;

        // Per-project skill exclusion — skip any file under an excluded skill dir.
        if (isExcludedSkillPath(`.claude/${rel}`, excludedSkills, workflowMap(projectRoot))) {
            console.log(`  SKIP     .claude/${rel} (excluded by update-config.json)`);
            stats.skipped++;
            continue;
        }

        if (zone === 'template') {
            if (rel === 'version.json') continue; // deferred — copy last
            if (fs.existsSync(destAbs) && !fs.lstatSync(destAbs).isSymbolicLink() && fs.readFileSync(srcAbs).equals(fs.readFileSync(destAbs))) {
                stats.skipped++; continue;
            }

            // Skill files get the agent-style escape hatch under --merge: a template
            // skill (skills/<name>/*.md) whose dest carries a `<!-- @@project-additions -->`
            // tail is merged — template head refreshed, adopter tail preserved — instead
            // of clobbered. Without a marker (or without --merge) it overwrites as before.
            const isSkillMd = /^skills\/[^/]+\/.*\.md$/.test(rel);
            if (options.merge && isSkillMd && fs.existsSync(destAbs) &&
                hasProjectAdditions(fs.readFileSync(destAbs, 'utf8'))) {
                if (options.dryRun) {
                    // Dry-run skips the real mergeSkillFile call, so r.headSuppressed /
                    // r.orphans are never computed here — the head-suppression + orphan
                    // WARN a live run would emit below cannot be previewed. Flag that so
                    // an operator previewing risk before committing isn't misled by silence.
                    console.log(`  MERGE    .claude/${rel} — would merge (preserve project additions; head-suppression/orphan warnings not previewable in --dry-run)`);
                    stats.merged++;
                } else {
                    tryAction(`.claude/${rel}`, () => {
                        const r = mergeSkillFile(srcAbs, destAbs, targetPath);
                        console.log(`  MERGE    .claude/${rel} — ${r.detail}`);
                        stats[r.changed ? 'merged' : 'skipped']++;
                        // A suppressed head refresh or an orphaned project-addition block
                        // means the merge didn't fully apply cleanly — r.detail already
                        // carries the WARNING text, but without this it's buried inside a
                        // MERGE line and invisible to stats.warned / the fleet rollup.
                        if (r.headSuppressed || (r.orphans && r.orphans.length)) {
                            const msg = `.claude/${rel} — ${r.detail}`;
                            console.log(`  WARN     ${msg}`);
                            warnings.push(msg);
                            stats.warned++;
                            // Tracked separately from the generic `warned` counter (Wave 6
                            // review NIT): the other 3 WARN sources in this file (settings
                            // merge skip, project-exception zone, mixed-without-merge) are
                            // pre-existing/expected states an operator doesn't need to act
                            // on — folding them into fleet.js's rollup digest alongside a
                            // genuinely actionable "this skill's head refresh froze" signal
                            // would make "N warned" impossible to triage at a glance. Only
                            // THIS site (a merge that didn't fully apply cleanly) counts here.
                            stats.mergeWarned++;
                        }
                    }, stats);
                }
                continue;
            }

            if (options.dryRun) {
                console.log(`  COPY     .claude/${rel} → .claude/${rel}`);
                stats.copied++;
            } else {
                tryAction(`.claude/${rel}`, () => {
                    copyWithZoneEnforcement(srcAbs, destAbs, 'template', { ...options, containRoot: targetPath });
                    console.log(`  COPY     .claude/${rel}`);
                    stats.copied++;
                }, stats);
            }

        } else if (zone === 'project') {
            // settings.json gets a section-aware merge under --merge:
            //   template-owned sections (hooks, plansDirectory, statusLine) are
            //   overwritten; project-owned sections (permissions, env, $schema,
            //   and any unknown top-level keys) are preserved verbatim.
            // settings.local.json and update-config.json are ALWAYS skipped —
            //   they carry per-machine state the template must never touch.
            if (options.merge && rel === 'settings.json') {
                tryAction(`.claude/${rel}`, () => {
                    const r = mergeSettingsFile(srcAbs, destAbs, { dryRun: options.dryRun }, targetPath);
                    if (r.action === 'unchanged') {
                        console.log(`  SKIP     .claude/${rel} (settings merge — ${r.detail})`);
                        stats.skipped++;
                    } else if (r.action === 'skipped') {
                        console.log(`  WARN     .claude/${rel} — ${r.detail}`);
                        stats.warned++;
                    } else {
                        // 'merged' or 'copied'
                        const verb = options.dryRun ? 'MERGE(dry)' : 'MERGE';
                        console.log(`  ${verb}    .claude/${rel} — ${r.detail}`);
                        stats.merged++;
                    }
                }, stats);
            } else {
                console.log(`  SKIP     .claude/${rel} (project zone)`);
                stats.skipped++;
            }

        } else if (zone === 'project-exception') {
            const msg = `.claude/${rel} — Project zone exception`;
            console.log(`  WARN     ${msg}`);
            warnings.push(msg);
            stats.warned++;

        } else if (zone === 'mixed') {
            if (options.merge) {
                if (options.dryRun) {
                    const destExists = fs.existsSync(destAbs);
                    console.log(`  MERGE    .claude/${rel} — ${destExists ? 'would merge (section-aware)' : 'would copy (fresh install)'}`);
                    stats.merged++;
                } else {
                    tryAction(`.claude/${rel}`, () => {
                        const r = mergeAgentFile(srcAbs, destAbs, { canonicalSkills, targetSkills, excludedSkills, containRoot: targetPath });
                        console.log(`  MERGE    .claude/${rel} — ${r.detail}`);
                        stats[r.changed ? 'merged' : 'skipped']++;
                    }, stats);
                }
            } else {
                const msg = `.claude/${rel} — Mixed zone — skipped under --no-merge`;
                console.log(`  WARN     ${msg}`);
                warnings.push(msg);
                stats.warned++;
            }

        } else {
            console.log(`  SKIP     .claude/${rel} (not in zone map)`);
            stats.skipped++;
        }
    }

    tryAction('native startup instructions', () => {
        if (!sharedUpdateReady) return;
        for (const rel of syncStartupInstructions(targetPath, { dryRun: options.dryRun, applyManagedBlock, available: fs.existsSync(path.join(projectRoot, '.agents/startup.md')) })) {
            console.log(`  ${options.dryRun ? 'PLAN' : 'MERGE'}    ${rel} (shared startup rules; project prose retained)`);
            stats.merged++;
        }
    }, stats);

    // ── CLAUDE.md → .claude/README.md ────────────────────────────────────────

    const claudeMdSrc = path.join(projectRoot, ROOT_DOC_REDIRECT.src);
    if (fs.existsSync(claudeMdSrc) && !(fs.existsSync(path.join(targetPath, ROOT_DOC_REDIRECT.dest)) && fs.readFileSync(claudeMdSrc).equals(fs.readFileSync(path.join(targetPath, ROOT_DOC_REDIRECT.dest))))) {
        const claudeMdDest = path.join(targetPath, ROOT_DOC_REDIRECT.dest);
        const label = `${ROOT_DOC_REDIRECT.src} → ${ROOT_DOC_REDIRECT.dest} (template docs)`;
        if (options.dryRun) {
            console.log(`  COPY     ${label}`);
            stats.copied++;
        } else {
            tryAction(label, () => {
                copyFile(claudeMdSrc, claudeMdDest, targetPath);
                console.log(`  COPY     ${label}`);
                stats.copied++;
            }, stats);
        }
    }

    // ── Root-level template files ─────────────────────────────────────────────

    for (const filename of ROOT_TEMPLATE_FILES) {
        const srcAbs = path.join(projectRoot, filename);
        if (!fs.existsSync(srcAbs) || isIgnored(filename)) continue;
        tryAction(filename, () => {
            copyFile(srcAbs, path.join(targetPath, filename), targetPath);
            console.log(`  COPY     ${filename}`);
            stats.copied++;
        }, stats);
    }

    // ── .githooks/ (Template zone at repo root) ───────────────────────────────

    for (const dirName of ROOT_TEMPLATE_DIRS) {
        const srcDir = path.join(projectRoot, dirName);
        if (!fs.existsSync(srcDir)) continue;
        for (const srcAbs of walkDir(srcDir, ALWAYS_SKIP_DIRS)) {
            const relToDir = path.relative(srcDir, srcAbs);
            const relNorm  = relToDir.replace(/\\/g, '/');
            if (isIgnored(`${dirName}/${relNorm}`)) continue;
            const destAbs  = path.join(targetPath, dirName, relToDir);
            if (options.dryRun) {
                console.log(`  COPY     ${dirName}/${relNorm} → ${dirName}/${relNorm}`);
                stats.copied++;
            } else {
                tryAction(`${dirName}/${relNorm}`, () => {
                    copyFile(srcAbs, destAbs, targetPath);
                    console.log(`  COPY     ${dirName}/${relNorm}`);
                    stats.copied++;
                }, stats);
            }
        }
    }

    // ── Root .gitignore managed block ─────────────────────────────────────────
    // The .claude walk above syncs the INERT .claude/templates/root/gitignore,
    // but the ACTIVE root .gitignore is a separate file scaffold.js seeds once at
    // setup time. Without this step, ignore-rule changes (e.g. v4.63 untracking
    // docs/.output/memories/ — path-lint:keep) never reach existing adopters on sync. Merge the
    // managed block here — idempotent: replaces an existing block in place,
    // appends one if absent, and leaves the adopter's own rules untouched.
    const gitignoreSrc = path.join(sourceClaudeDir, 'templates', 'root', 'gitignore');
    let gitignoreAction = 'unchanged';
    if (fs.existsSync(gitignoreSrc)) {
        const gitignoreDest = path.join(targetPath, '.gitignore');
        tryAction('.gitignore (managed block)', () => {
            const content = fs.readFileSync(gitignoreSrc, 'utf8');
            const action  = applyManagedBlock(gitignoreDest, content, { dryRun: options.dryRun, containRoot: targetPath });
            gitignoreAction = action;
            if (action === 'unchanged') {
                console.log('  SKIP     .gitignore (managed block — unchanged)');
                stats.skipped++;
            } else {
                console.log(`  MERGE    .gitignore (managed block — ${action})`);
                stats.merged++;
            }
        }, stats);
    }

    // ── version.json — last (sync-complete marker) ────────────────────────────

    const canonicalVersion = path.join(projectRoot, '.agents/config/version.json');
    const versionSrc  = fs.existsSync(canonicalVersion) ? canonicalVersion : path.join(sourceClaudeDir, 'version.json');
    const versionDest = path.join(targetClaudeDir, 'version.json');
    if (fs.existsSync(versionSrc) && !(fs.existsSync(versionDest) && fs.readFileSync(versionSrc).equals(fs.readFileSync(versionDest)))) {
        if (stats.errors > 0 || stats.conflicts.length > 0) {
            console.log('  SKIP     .claude/version.json (errors or conflicts occurred — incomplete sync)');
            stats.skipped++;
        } else if (options.dryRun) {
            console.log('  COPY     .claude/version.json → .claude/version.json (last — sync marker)');
            stats.copied++;
        } else {
            tryAction('.claude/version.json', () => {
                if (fs.existsSync(canonicalVersion)) {
                    const rendered = renderSharedAgents(targetPath, { onlyOutputs: new Set(['.claude/version.json']), excludedSkills, adoptPaths: new Set(['.claude/version.json']) });
                    if (rendered.conflicts.length) throw new Error(`Generated version marker conflict: ${rendered.conflicts.join(', ')}`);
                } else copyFile(versionSrc, versionDest, targetPath);
                console.log('  COPY     .claude/version.json (last — sync marker)');
                stats.copied++;
            }, stats);
        }
    }

    // ── Ignore rules that hide managed files ──────────────────────────────────
    // A notice, not a warning: it is not counted in Warned and never changes the
    // exit status, so an adopter whose own rule hides a managed file still gets a
    // clean repeated update. The managed block above has already been merged on a
    // live run, so a rule inside it is judged as the update leaves it.
    const hiddenResult = hiddenManagedFiles(targetPath);
    const hiddenManaged = describeHidden(hiddenResult);
    if (options.dryRun && gitignoreAction !== 'unchanged' && hiddenResult.hidden.some(item => item.origin === 'managed-block')) {
        hiddenManaged.push('  (dry run: the managed .gitignore block change planned above is not applied, so rules inside that block are shown as they stand now)');
    }

    // ── Report ────────────────────────────────────────────────────────────────

    console.log('');
    console.log('─────────────────────────────────────────────');
    console.log(options.dryRun ? 'Dry run complete (no files written)' : 'Update complete');
    console.log(`  Copied  : ${stats.copied}`);
    console.log(`  Merged  : ${stats.merged}`);
    console.log(`  Skipped : ${stats.skipped}`);
    console.log(`  Warned  : ${stats.warned}`);
    if (stats.mergeWarned > 0) console.log(`  MergeWarned : ${stats.mergeWarned}  ← fleet-actionable (head-refresh suppressed / orphaned block)`);
    if (stats.errors > 0) console.log(`  Errors  : ${stats.errors}  ← check output above`);
    if (warnings.length > 0) {
        console.log('\nWarnings:');
        warnings.forEach(w => console.log(`  ! ${w}`));
    }
    if (hiddenManaged.length > 0) {
        console.log('');
        hiddenManaged.forEach(line => console.log(line));
    }
    if (stats.errors > 0) process.exit(1);
    return stats;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`Template Updater — copies Template-zone files from this repo to a target project.

Usage:
  node .claude/core/template-updater.js update <target-path> [--no-merge] [--dry-run]

Preflight:
  Source assets, target path containment and symbolic links are checked before
  mutation. The target's .claude/update-config.json, when present, must be valid.
  A refusal prints a fixed CODE: message and writes nothing (dry-run included).

Zone behavior:
  Template zone   — Overwritten: commands/, core/, hooks/, skills/**/*,
                    skills-optional/, templates/, version.json, guardrail-rules.yaml
                    Skill escape hatch (merge is the default): a skills/<name>/*.md file whose
                    target copy carries a <!-- @@project-additions --> marker is merged
                    (template head refreshed, adopter tail below the marker preserved)
                    instead of overwritten.
  Project zone    — Skipped by default: settings.json, settings.local.json, update-config.json
                    settings.json has an escape hatch (merge is the default): template-owned
                    sections (hooks, plansDirectory, statusLine) are overwritten while
                    project-owned sections (permissions, env, $schema, unknown keys) are
                    preserved. settings.local.json and update-config.json are ALWAYS skipped.
  Mixed zone      — Section-aware merge preserving customizations (Soul Zone,
                    Project Context, tuned descriptions, and project-specific
                    agent skills are kept): agents/*.md
                    With --no-merge: skipped with a warning
  Exceptions      — Skipped with warning: skills/brand-guidelines/**
  Skill opt-out   — Skills named in the target's .claude/update-config.json
                    ("skillExclude": [...]) are never copied, so a project can
                    permanently drop template skills it doesn't use (e.g. Tailwind).
  Doc redirect    — Source CLAUDE.md → target .claude/README.md
  .gitignore      — Active root .gitignore: managed-block merge from
                    .claude/templates/root/gitignore (idempotent; the adopter's
                    own rules outside the managed block are preserved).

Flags:
  --merge         Accepted for compatibility; merging is the default. It is the section-aware
                  merge for agents/*.md (preserves Soul Zone, Project Context, tuned
                  descriptions, and project-specific skills) AND for settings.json
                  (hooks + plansDirectory + statusLine updated; permissions/env and all
                  unknown keys preserved) AND for skill files carrying a
                  <!-- @@project-additions --> tail (template head refreshed, adopter
                  tail preserved).
  --no-merge      Skip those merges: mixed-zone files and settings.json are left as they are
                  and reported as warnings, and a skill tail is overwritten. A partial update.
  --dry-run       Preview all actions without writing any files (preflight still runs).

Notes:
  - Additive only: files in target not present in source are never deleted.
  - Directories in target are created as needed.`);
}

const USAGE = '  Usage: node template-updater.js update <target-path> [--no-merge] [--dry-run]';

function main() {
    const [,, command, ...args] = process.argv;
    if (!command || command === '--help' || command === '-h') { printHelp(); process.exit(0); }

    if (command === 'update') {
        if (args.includes('--merge') && args.includes('--no-merge')) {
            console.error('template-updater: --merge and --no-merge contradict each other; pass at most one.');
            console.error(USAGE);
            process.exitCode = 1;
            return;
        }
        const options    = { merge: !args.includes('--no-merge'), dryRun: args.includes('--dry-run') };
        const targetPath = args.find(a => !a.startsWith('--'));
        if (!targetPath) {
            console.error('Error: update requires a target path');
            console.error(USAGE);
            process.exitCode = 1;
            return;
        }
        const projectRoot = process.env.CLAUDE_PROJECT_DIR || PROJECT_ROOT;
        const verified = preflightUpdate({ source: projectRoot, target: path.resolve(targetPath), dryRun: options.dryRun });
        if (!verified.ok) {
            for (const error of verified.errors) console.error(`  ${error.code}: ${error.message}${error.reason ? ` [${error.reason}]` : ''}`);
            console.error('template-updater: update preflight refused; nothing was written.');
            process.exitCode = 1;
            return;
        }
        console.log('Preflight: source assets and target paths verified');
        let result;
        try { result = runUpdate(verified.target, options); } catch (err) {
            console.error(`template-updater: ERROR — ${err.message}`);
            process.exitCode = 1;
            return;
        }
        if (result.conflicts.length) process.exitCode = 1;
    } else {
        console.error(`Unknown command: ${command}`);
        console.error('Run with --help to see available commands.');
        process.exit(1);
    }
}

if (require.main === module) { main(); }

// Re-export _lib symbols so existing consumers (template-updater.test.js) import
// from this file without change. walkDir shim keeps the old array-returning API.
// F57: skillMerger included — the stated contract is "re-export _lib symbols",
// and it was the one imported module the list silently omitted.
const _libFW = require('./_lib/file-walker');
module.exports = Object.assign(
    {
        copyFile, runUpdate, loadExcludedSkills, listSkillDirs,
        UPDATE_SCOPE, ROOT_DOC_REDIRECT, preflightUpdate, preflightFrontDoor, readUpdateConfig,
    },
    zoneClassifier,
    agentMerger,
    settingsMerger,
    skillMerger,
    { walkDir: (dirPath) => [..._libFW.walkDir(dirPath, ALWAYS_SKIP_DIRS)] }
);
