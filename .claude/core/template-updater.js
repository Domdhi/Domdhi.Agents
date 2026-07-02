#!/usr/bin/env node

/**
 * Template Updater — copies Template-zone files from this repo's .claude/ to a target project.
 *
 * Zone boundaries (docs/reference/customization.md):
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
 *   Mixed zone     — skip with warning, or merge with --merge (agents/*.md)
 *
 * Usage:
 *   node .claude/core/template-updater.js update <target-path>
 *   node .claude/core/template-updater.js update <target-path> --merge
 *   node .claude/core/template-updater.js update <target-path> --dry-run
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
const { applyManagedBlock }       = require('./scaffold');

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function copyFile(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
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

    const stats    = { copied: 0, merged: 0, skipped: 0, warned: 0, errors: 0 };
    const warnings = [];

    // Per-project skill exclusions — the target declares template skills it does
    // not want (e.g. tailwind-css-patterns in a non-Tailwind project). Read from
    // the target's own .claude/update-config.json (Project zone, never overwritten).
    // Without this, every update re-imports skills the project deliberately dropped.
    const excludedSkills = loadExcludedSkills(targetClaudeDir);
    if (excludedSkills.size > 0) {
        console.log(`  Excluding skills (per update-config.json): ${[...excludedSkills].join(', ')}`);
        console.log('');
    }

    // ── .claude/ files ────────────────────────────────────────────────────────

    const sourceClaudeDir = path.join(projectRoot, '.claude');

    // Skill sets for the agent-merge skills-union. A skill in a target agent's
    // frontmatter that is NOT shipped by the template (not canonical) but DOES exist
    // as a skill dir in the target is a project specialization (added by
    // /review:specialize) and must survive the merge — otherwise every update strips
    // a specialized agent's domain skills off its frontmatter.
    const listSkillDirs = (dir) => {
        try {
            return new Set(fs.readdirSync(dir, { withFileTypes: true })
                .filter(d => d.isDirectory()).map(d => d.name));
        } catch { return new Set(); }
    };
    const canonicalSkills = listSkillDirs(path.join(sourceClaudeDir, 'skills'));
    const targetSkills    = listSkillDirs(path.join(targetClaudeDir, 'skills'));

    for (const srcAbs of walkDir(sourceClaudeDir, ALWAYS_SKIP_DIRS)) {
        const relToClause = path.relative(sourceClaudeDir, srcAbs);
        const zone        = classifyClaudeFile(relToClause);
        const destAbs     = path.join(targetClaudeDir, relToClause);
        const rel         = relToClause.replace(/\\/g, '/');

        // Per-project skill exclusion — skip any file under an excluded skill dir.
        const skillMatch = rel.match(/^skills\/([^/]+)\//);
        if (skillMatch && excludedSkills.has(skillMatch[1])) {
            console.log(`  SKIP     .claude/${rel} (excluded by update-config.json)`);
            stats.skipped++;
            continue;
        }

        if (zone === 'template') {
            if (rel === 'version.json') continue; // deferred — copy last

            // Skill files get the agent-style escape hatch under --merge: a template
            // skill (skills/<name>/*.md) whose dest carries a `<!-- @@project-additions -->`
            // tail is merged — template head refreshed, adopter tail preserved — instead
            // of clobbered. Without a marker (or without --merge) it overwrites as before.
            const isSkillMd = /^skills\/[^/]+\/.*\.md$/.test(rel);
            if (options.merge && isSkillMd && fs.existsSync(destAbs) &&
                hasProjectAdditions(fs.readFileSync(destAbs, 'utf8'))) {
                if (options.dryRun) {
                    console.log(`  MERGE    .claude/${rel} — would merge (preserve project additions)`);
                    stats.merged++;
                } else {
                    tryAction(`.claude/${rel}`, () => {
                        const r = mergeSkillFile(srcAbs, destAbs);
                        console.log(`  MERGE    .claude/${rel} — ${r.detail}`);
                        stats.merged++;
                    }, stats);
                }
                continue;
            }

            if (options.dryRun) {
                console.log(`  COPY     .claude/${rel} → .claude/${rel}`);
                stats.copied++;
            } else {
                tryAction(`.claude/${rel}`, () => {
                    copyWithZoneEnforcement(srcAbs, destAbs, 'template', options);
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
                    const r = mergeSettingsFile(srcAbs, destAbs, { dryRun: options.dryRun });
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
                        const r = mergeAgentFile(srcAbs, destAbs, { canonicalSkills, targetSkills, excludedSkills });
                        console.log(`  MERGE    .claude/${rel} — ${r.detail}`);
                        stats.merged++;
                    }, stats);
                }
            } else {
                const msg = `.claude/${rel} — Mixed zone — use --merge to handle these`;
                console.log(`  WARN     ${msg}`);
                warnings.push(msg);
                stats.warned++;
            }

        } else {
            console.log(`  SKIP     .claude/${rel} (not in zone map)`);
            stats.skipped++;
        }
    }

    // ── CLAUDE.md → .claude/README.md ────────────────────────────────────────

    const claudeMdSrc = path.join(projectRoot, ROOT_DOC_REDIRECT.src);
    if (fs.existsSync(claudeMdSrc)) {
        const claudeMdDest = path.join(targetPath, ROOT_DOC_REDIRECT.dest);
        const label = `${ROOT_DOC_REDIRECT.src} → ${ROOT_DOC_REDIRECT.dest} (template docs)`;
        if (options.dryRun) {
            console.log(`  COPY     ${label}`);
            stats.copied++;
        } else {
            tryAction(label, () => {
                copyFile(claudeMdSrc, claudeMdDest);
                console.log(`  COPY     ${label}`);
                stats.copied++;
            }, stats);
        }
    }

    // ── Root-level template files ─────────────────────────────────────────────

    for (const filename of ROOT_TEMPLATE_FILES) {
        const srcAbs = path.join(projectRoot, filename);
        if (!fs.existsSync(srcAbs)) continue;
        tryAction(filename, () => {
            copyFile(srcAbs, path.join(targetPath, filename));
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
            const destAbs  = path.join(targetPath, dirName, relToDir);
            if (options.dryRun) {
                console.log(`  COPY     ${dirName}/${relNorm} → ${dirName}/${relNorm}`);
                stats.copied++;
            } else {
                tryAction(`${dirName}/${relNorm}`, () => {
                    copyFile(srcAbs, destAbs);
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
    if (fs.existsSync(gitignoreSrc)) {
        const gitignoreDest = path.join(targetPath, '.gitignore');
        tryAction('.gitignore (managed block)', () => {
            const content = fs.readFileSync(gitignoreSrc, 'utf8');
            const action  = applyManagedBlock(gitignoreDest, content, { dryRun: options.dryRun });
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

    const versionSrc  = path.join(sourceClaudeDir, 'version.json');
    const versionDest = path.join(targetClaudeDir, 'version.json');
    if (fs.existsSync(versionSrc)) {
        if (stats.errors > 0) {
            console.log('  SKIP     .claude/version.json (errors occurred — incomplete sync)');
            stats.skipped++;
        } else if (options.dryRun) {
            console.log('  COPY     .claude/version.json → .claude/version.json (last — sync marker)');
            stats.copied++;
        } else {
            tryAction('.claude/version.json', () => {
                copyFile(versionSrc, versionDest);
                console.log('  COPY     .claude/version.json (last — sync marker)');
                stats.copied++;
            }, stats);
        }
    }

    // ── Report ────────────────────────────────────────────────────────────────

    console.log('');
    console.log('─────────────────────────────────────────────');
    console.log(options.dryRun ? 'Dry run complete (no files written)' : 'Update complete');
    console.log(`  Copied  : ${stats.copied}`);
    console.log(`  Merged  : ${stats.merged}`);
    console.log(`  Skipped : ${stats.skipped}`);
    console.log(`  Warned  : ${stats.warned}`);
    if (stats.errors > 0) console.log(`  Errors  : ${stats.errors}  ← check output above`);
    if (warnings.length > 0) {
        console.log('\nWarnings:');
        warnings.forEach(w => console.log(`  ! ${w}`));
    }
    if (stats.errors > 0) process.exit(1);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`Template Updater — copies Template-zone files from this repo to a target project.

Usage:
  node .claude/core/template-updater.js update <target-path> [--merge] [--dry-run]

Zone behavior:
  Template zone   — Overwritten: commands/, core/, hooks/, skills/**/*,
                    skills-optional/, templates/, version.json, guardrail-rules.yaml
                    Skill escape hatch under --merge: a skills/<name>/*.md file whose
                    target copy carries a <!-- @@project-additions --> marker is merged
                    (template head refreshed, adopter tail below the marker preserved)
                    instead of overwritten.
  Project zone    — Skipped by default: settings.json, settings.local.json, update-config.json
                    settings.json has an escape hatch under --merge: template-owned
                    sections (hooks, plansDirectory, statusLine) are overwritten while
                    project-owned sections (permissions, env, $schema, unknown keys) are
                    preserved. settings.local.json and update-config.json are ALWAYS skipped.
  Mixed zone      — Skipped with warning (default): agents/*.md
                    With --merge: section-aware merge preserving customizations
                    (Soul Zone, Project Context, tuned descriptions, and
                    project-specific agent skills are kept)
  Exceptions      — Skipped with warning: skills/brand-guidelines/**
  Skill opt-out   — Skills named in the target's .claude/update-config.json
                    ("skillExclude": [...]) are never copied, so a project can
                    permanently drop template skills it doesn't use (e.g. Tailwind).
  Doc redirect    — Source CLAUDE.md → target .claude/README.md
  .gitignore      — Active root .gitignore: managed-block merge from
                    .claude/templates/root/gitignore (idempotent; the adopter's
                    own rules outside the managed block are preserved).

Flags:
  --merge         Section-aware merge for agents/*.md (preserves Soul Zone, Project Context,
                  tuned descriptions, and project-specific skills) AND section-aware merge
                  for settings.json (hooks + plansDirectory + statusLine updated;
                  permissions/env and all unknown keys preserved) AND skill files
                  carrying a <!-- @@project-additions --> tail (template head refreshed,
                  adopter tail preserved).
  --dry-run       Preview all actions without writing any files.

Notes:
  - Additive only: files in target not present in source are never deleted.
  - Directories in target are created as needed.`);
}

function main() {
    const [,, command, ...args] = process.argv;
    if (!command || command === '--help' || command === '-h') { printHelp(); process.exit(0); }

    const allArgs  = process.argv.slice(2);
    const options  = { merge: allArgs.includes('--merge'), dryRun: allArgs.includes('--dry-run') };

    if (command === 'update') {
        const targetPath = args.find(a => !a.startsWith('--'));
        if (!targetPath) {
            console.error('Error: update requires a target path');
            console.error('  Usage: node template-updater.js update <target-path> [--merge] [--dry-run]');
            process.exit(1);
        }
        runUpdate(path.resolve(targetPath), options);
    } else {
        console.error(`Unknown command: ${command}`);
        console.error('Run with --help to see available commands.');
        process.exit(1);
    }
}

if (require.main === module) { main(); }

// Re-export _lib symbols so existing consumers (template-updater.test.js) import
// from this file without change. walkDir shim keeps the old array-returning API.
const _libFW = require('./_lib/file-walker');
module.exports = Object.assign(
    { copyFile, runUpdate, loadExcludedSkills },
    zoneClassifier,
    agentMerger,
    settingsMerger,
    { walkDir: (dirPath) => [..._libFW.walkDir(dirPath, ALWAYS_SKIP_DIRS)] }
);
