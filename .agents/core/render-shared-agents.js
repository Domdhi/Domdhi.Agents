#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const { renderSharedAgents, loadModelAdapter, canonicalFiles } = require('./_lib/shared-agents');
const { renderModelProse } = require('./_lib/model-prose');
const { renderWorkflowRoutes, checkWorkflowRoutes } = require('./_lib/workflow-routes');
const { assertNoSymlinkedAncestor, safeWrite } = require('./_lib/fs-safe');
const { loadExcludedSkills } = require('./template-updater');

function main(args = process.argv.slice(2)) {
    const value = flag => {
        const index = args.indexOf(flag);
        if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`render: missing ${flag} value`);
        return args[index + 1];
    };
    const root = path.resolve(args.includes('--root') ? value('--root') : (!args.includes('--prose') && args.find(a => !a.startsWith('--'))) || path.join(__dirname, '../..'));
    if (args.includes('--routes') && args.includes('--prose')) throw new Error('render: --routes and --prose are mutually exclusive');
    if (args.includes('--routes') || (args.includes('--check') && !args.includes('--prose'))) {
        const excluded = loadExcludedSkills(path.join(root, '.claude'));
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
    const result = renderSharedAgents(root, { dryRun: args.includes('--dry-run') || args.includes('--check'), force: args.includes('--force'), excludedSkills: loadExcludedSkills(path.join(root, '.claude')) });
    for (const warning of result.warnings || []) console.warn(warning);
    for (const file of result.changed) console.log(`RENDER ${file}`);
    for (const file of result.conflicts) console.error(`CONFLICT ${file}: generated output edited; move intended changes to .agents sources or native shared-agents.json, then render with --force.`);
    if (result.conflicts.length || (args.includes('--check') && result.changed.length)) process.exitCode = 1;
    if (!result.changed.length) console.log('Shared agent projections are current.');
    return result;
}
if (require.main === module) {
    try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { main, renderSharedAgents };
