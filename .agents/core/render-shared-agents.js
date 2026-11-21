#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const { renderSharedAgents, loadModelAdapter, canonicalFiles, describeRetiredConflict } = require('./_lib/shared-agents');
const { renderModelProse } = require('./_lib/model-prose');
const { renderWorkflowRoutes, checkWorkflowRoutes } = require('./_lib/workflow-routes');
const { assertNoSymlinkedAncestor, safeWrite } = require('./_lib/fs-safe');
const { loadExcludedSkills, loadExcludedRoles, readUpdateConfig } = require('./template-updater');
const { checkSelectionClosure } = require('./_lib/skill-profiles');

function main(args = process.argv.slice(2)) {
    const value = flag => {
        const index = args.indexOf(flag);
        if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`render: missing ${flag} value`);
        return args[index + 1];
    };
    const root = path.resolve(args.includes('--root') ? value('--root') : (!args.includes('--prose') && args.find(a => !a.startsWith('--'))) || path.join(__dirname, '../..'));
    if (args.includes('--routes') && args.includes('--prose')) throw new Error('render: --routes and --prose are mutually exclusive');
    if (args.includes('--routes') || (args.includes('--check') && !args.includes('--prose'))) {
        const excluded = loadExcludedSkills(path.join(root, '.claude'), root);
        const pending = [];
        for (const rel of canonicalFiles(root).filter(rel => /^\.agents\/skills\/[^/]+\/references\/workflow\.md$/.test(rel))) {
            if (excluded.has(rel.split('/')[2])) continue;
            const file = path.join(root, rel);
            const original = fs.readFileSync(file, 'utf8');
            if (!/```workflow-routes|<!-- workflow-routes:diagram:/.test(original)) continue;
            assertNoSymlinkedAncestor(file, root);
            if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`workflow-routes: refusing symlinked source ${rel}`);
            if (args.includes('--check')) checkWorkflowRoutes(original);
            const rendered = renderWorkflowRoutes(original);
            if (rendered !== original) pending.push([rel, rendered]);
        }
        if (args.includes('--routes')) {
            if (!args.includes('--check') && !args.includes('--dry-run')) for (const [rel, rendered] of pending) safeWrite(path.join(root, rel), rendered, 'utf8', root);
            for (const [rel] of pending) console.log(`ROUTES ${rel}`);
            if (!pending.length) console.log('Workflow route diagrams are current.');
            return { changed: pending.map(([rel]) => rel), conflicts: [] };
        }
    }
    if (args.includes('--prose')) {
        const rel = value('--prose').replace(/\\/g, '/');
        const runtime = value('--runtime');
        if (!['claude', 'codex'].includes(runtime)) throw new Error(`model-prose: unsupported runtime ${runtime}`);
        if (!/^\.agents\/(?:skills\/.+\.md|roles\/[^/]+\.md|startup-reference\.md)$/.test(rel) || rel.split('/').some(part => part === '..' || part === '.')) throw new Error('model-prose: expected a canonical Markdown path');
        const source = path.join(root, rel);
        assertNoSymlinkedAncestor(source, root);
        const adapter = loadModelAdapter(root, runtime);
        const rendered = renderModelProse(renderWorkflowRoutes(fs.readFileSync(source, 'utf8')), runtime, adapter.tiers);
        process.stdout.write(rendered);
        return rendered;
    }
    // The project's skill selection must be closed over this tree: a kept skill or role
    // that still invokes a dropped skill fails the check (and warns on a plain render).
    const config = readUpdateConfig(path.join(root, '.claude'));
    const closure = config.ok ? checkSelectionClosure(root, config) : { ok: false, details: ['.claude/update-config.json is invalid'] };
    if (!closure.ok) {
        console.error(`PROFILE ${args.includes('--check') ? 'refused' : 'warning'}: project skill selection is not closed`);
        for (const line of closure.details) console.error(`  ${line}`);
        if (args.includes('--check')) process.exitCode = 1;
    }
    const result = renderSharedAgents(root, { dryRun: args.includes('--dry-run') || args.includes('--check'), force: args.includes('--force'), excludedSkills: loadExcludedSkills(path.join(root, '.claude'), root), excludedRoles: loadExcludedRoles(path.join(root, '.claude'), root) });
    for (const warning of result.warnings || []) console.warn(warning);
    const retired = result.retired || [];
    for (const file of result.changed) console.log(`RENDER ${file}`);
    for (const file of retired) console.log(`RETIRE ${file}`);
    const pruned = result.pruned || [];
    for (const file of pruned) console.log(`PRUNE ${file} (excluded by the project's skill selection${args.includes('--check') ? '; pending' : ''})`);
    for (const file of result.conflicts) console.error(describeRetiredConflict(root, file, result.retiredReasons)
        ? `CONFLICT ${describeRetiredConflict(root, file, result.retiredReasons)}`
        : `CONFLICT ${file}: generated output edited; move intended changes to .agents sources or native shared-agents.json, then render with --force.`);
    if (result.conflicts.length || (args.includes('--check') && (result.changed.length || retired.length || pruned.length))) process.exitCode = 1;
    if (!result.changed.length && !retired.length && !pruned.length) console.log('Shared agent projections are current.');
    return result;
}
if (require.main === module) {
    try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { main, renderSharedAgents };
