#!/usr/bin/env node
'use strict';
/**
 * skill-profile — inspect a project's skill selection.
 *
 *   node .claude/core/skill-profile.js check [--root DIR]
 *     Prints the profile, kept/excluded skills and roles, and whether the
 *     selection is closed (no kept skill or role invokes a dropped skill).
 *     Exit 0 when closed, 1 otherwise.
 *
 *   node .claude/core/skill-profile.js suggest <skill>... [--root DIR]
 *     Prints the kept skills that must also be dropped (transitively) to drop
 *     the named skills, and roles that still name them.
 *
 * DIR defaults to the current project. Its .claude/update-config.json is the
 * selection; its .agents/adapters/skill-profiles.json defines the profiles.
 */
const path = require('path');
const { readUpdateConfig } = require('./template-updater');
const { checkSelectionClosure, resolveSelection, suggestClosure } = require('./_lib/skill-profiles');

function parseRoot(args) {
    const index = args.indexOf('--root');
    if (index < 0) return path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('skill-profile: missing --root value');
    return path.resolve(args[index + 1]);
}

function list(names) {
    const sorted = [...names].sort();
    return sorted.length ? sorted.join(', ') : '(none)';
}

function main(args = process.argv.slice(2), out = console.log, err = console.error) {
    const [command, ...rest] = args;
    const root = parseRoot(rest);
    const config = readUpdateConfig(path.join(root, '.claude'));
    if (!config.ok) {
        err(config.message);
        return 1;
    }
    if (command === 'check') {
        const result = checkSelectionClosure(root, config);
        const sel = result.selection;
        out(`Profile        : ${sel.profile || '(none — skillExclude only)'}`);
        out(`Kept skills    : ${sel.keptSkills.size}`);
        out(`Excluded skills: ${list([...sel.excludedSkills].filter(s => sel.universe.skills.has(s)))}`);
        out(`Excluded roles : ${list(sel.excludedRoles)}`);
        for (const warning of sel.warnings) out(`WARN ${warning}`);
        for (const line of result.unverified || []) out(`NOTE ${line}`);
        if (result.ok) {
            out('Closure        : closed');
            return 0;
        }
        err('Closure        : NOT closed');
        for (const line of result.details) err(`  ${line}`);
        return 1;
    }
    if (command === 'suggest') {
        const names = rest.filter((arg, i) => !arg.startsWith('--') && rest[i - 1] !== '--root');
        if (!names.length) {
            err('skill-profile suggest: name at least one skill');
            return 1;
        }
        const sel = resolveSelection({ toolkitRoot: root, config });
        const unknown = names.filter(n => !sel.universe.skills.has(n));
        if (unknown.length) {
            err(`skill-profile suggest: not toolkit skills: ${unknown.join(', ')}`);
            return 1;
        }
        const result = suggestClosure({ root, keptSkills: sel.keptSkills, keptRoles: sel.keptRoles, droppedSkills: [...sel.excludedSkills, ...names].filter(s => sel.universe.skills.has(s)) });
        out(`To drop ${names.join(', ')}, also drop: ${list(result.skills)}`);
        if (result.roles.length) out(`Roles or docs that still name a dropped skill: ${list(result.roles)}`);
        return 0;
    }
    err('Usage: skill-profile.js check [--root DIR] | suggest <skill>... [--root DIR]');
    return 1;
}

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { main };
