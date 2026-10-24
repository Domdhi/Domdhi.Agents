// Toolkit-owned neutral pilot setup, shared by regression and local runtime checks.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { walkDir } = require('../../_lib/file-walker');
const { runInstall } = require('../../install');
const { runUpdate } = require('../../template-updater');
const { renderSharedAgents } = require('../../_lib/shared-agents');

const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };

/** Copy the toolkit's distributable sources (minus tests, helpers and the workshop's render ledger). */
function copyToolkit(toolkitRoot, dest) {
    for (const dir of ['.claude', '.agents']) {
        for (const file of walkDir(path.join(toolkitRoot, dir), ['__tests__', '_helpers', 'node_modules', '.git'])) {
            const relative = path.relative(toolkitRoot, file).replace(/\\/g, '/');
            if (relative === '.agents/render-state.json' || relative.startsWith('.agents/learning-intake/')) continue;
            copy(file, path.join(dest, path.relative(toolkitRoot, file)));
        }
    }
    copy(path.join(toolkitRoot, '.codex/shared-agents.json'), path.join(dest, '.codex/shared-agents.json'));
}

function preparePilot(workRoot, toolkitRoot) {
    const source = path.join(workRoot, 'neutral source');
    const target = path.join(workRoot, 'neutral adopter with spaces');
    const fixture = path.join(__dirname, '../_fixtures/neutral-adopter');
    copyToolkit(toolkitRoot, source);
    const settingsPath = path.join(source, '.agents/adapters/claude/settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), null, 2) + '\n');
    copy(path.join(fixture, '.agents/gate.config.json'), path.join(source, '.agents/gate.config.json'));
    for (const file of ['package.json', 'application.cjs', 'application-check.cjs']) copy(path.join(fixture, file), path.join(target, file));
    const install = runInstall({ source, target });
    if (!install.ok || install.conflicts.length) throw new Error('Neutral pilot install conflicted');

    const role = path.join(target, '.agents/roles/qa-engineer.md');
    fs.writeFileSync(role, fs.readFileSync(role, 'utf8').replace('nickname: Murphy', 'nickname: Canary').replace('I am the QA engineer.', 'I am CANARY_DISTINCT_SOUL, the QA engineer.') + '\n## Project Context\n\nCANARY_DISTINCT_CONTEXT: test the neutral arithmetic application.\n');
    const skill = path.join(target, '.agents/skills/review-specialize/SKILL.md');
    fs.appendFileSync(skill, '\n<!-- @@project-additions -->\n## Neutral Application\n\nCANARY_DISTINCT_SKILL: retain the application isolation filter.\n');
    const config = path.join(target, '.agents/gate.config.json');
    const gate = JSON.parse(fs.readFileSync(config));
    gate.lint = { command: 'node application-check.cjs lint', timeout: 30000 };
    fs.writeFileSync(config, JSON.stringify(gate, null, 2) + '\n');
    if (renderSharedAgents(target).conflicts.length) throw new Error('Neutral pilot personalization conflicted');
    for (const [rel, marker] of [['.agents/roles/qa-engineer.md', 'SHARED_PILOT_ROLE_V2'], ['.agents/skills/review-specialize/SKILL.md', 'SHARED_PILOT_SKILL_V2']]) {
        fs.appendFileSync(path.join(source, rel), `\n${marker}\n`);
    }
    return { source, target };
}

function updatePilot(source, target, options = {}) {
    const previous = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = source;
    try { return runUpdate(target, { merge: true, ...options }); }
    finally { if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = previous; }
}

/** Every file under root (nothing skipped) as relative path -> SHA-256 of its bytes. */
function snapshotDigests(root) {
    const out = {};
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(abs);
            else out[path.relative(root, abs).replace(/\\/g, '/')] = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        }
    })(root);
    return out;
}

/** Sorted relative paths added, removed or modified between two snapshotDigests results. */
function changedPaths(before, after) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(rel => before[rel] !== after[rel]).sort();
}

// Release-specific lines, one per distributed content kind, so each update's
// direction is observable in the canonical file and every native projection.
const RELEASE_MARKED = Object.freeze({
    role: '.agents/roles/qa-engineer.md',
    skill: '.agents/skills/review-specialize/SKILL.md',
    standards: '.agents/skills/baseline-fixture/SKILL.md',
    reference: '.agents/skills/baseline-fixture/references/engineering.md',
});
// Files that exist only in the newer release.
const NEXT_ONLY = Object.freeze({
    reference: '.agents/skills/baseline-fixture/references/release-next-only.md',
    helper: '.agents/core/release-next-only.js',
});

/**
 * Two immutable local release checkouts built from the current toolkit without
 * Git history: "release previous" and "release next". Each has a distinct
 * canonical version, distinct marker lines in a role, a shared skill and the
 * baseline-fixture skill and reference, and (like a real checkout) its own
 * toolkit tests and project memory, so their non-import is observable. Only the
 * next release ships NEXT_ONLY files. Each release is rendered, like a published
 * checkout. digests are taken after construction so a
 * test can prove neither release tree was mutated by install, update or restore.
 */
function prepareReleasePair(workRoot, toolkitRoot) {
    const previous = path.join(workRoot, 'release previous');
    const next = path.join(workRoot, 'release next');
    copyToolkit(toolkitRoot, previous);
    // Release fixtures use serialized adapter defaults. The workshop's existing
    // adapter bytes are project-owned and need not already have a trailing LF.
    const settingsPath = path.join(previous, '.agents/adapters/claude/settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), null, 2) + '\n');
    const fixtureRoot = path.join(previous, '.agents/skills/baseline-fixture');
    fs.mkdirSync(path.join(fixtureRoot, 'references'), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'SKILL.md'), '---\nname: baseline-fixture\ndescription: Disposable release fixture.\n---\n\n# Baseline fixture\n\nLoad only the necessary domain fixture.\n');
    fs.writeFileSync(path.join(fixtureRoot, 'references/engineering.md'), '# Disposable engineering fixture\n');
    for (const rel of ['.agents/core/__tests__/shared-agents.test.js', '.agents/core/__tests__/_helpers/shared-pilot.cjs']) {
        copy(path.join(toolkitRoot, rel), path.join(previous, rel));
    }
    fs.mkdirSync(path.join(previous, 'docs/.output/.memory/constraints'), { recursive: true });
    fs.writeFileSync(path.join(previous, 'docs/.output/.memory/constraints/release-source-only-memory.json'), JSON.stringify({ id: 'release-source-only-memory', content: { description: 'RELEASE_SOURCE_MEMORY' } }, null, 2) + '\n');
    fs.mkdirSync(path.join(previous, '.claude/agent-memory/general-purpose'), { recursive: true });
    fs.writeFileSync(path.join(previous, '.claude/agent-memory/general-purpose/RELEASE_SOURCE_AGENT_MEMORY.md'), '# RELEASE_SOURCE_AGENT_MEMORY\n');
    fs.cpSync(previous, next, { recursive: true });

    const toolkitVersion = JSON.parse(fs.readFileSync(path.join(toolkitRoot, '.agents/config/version.json'), 'utf8'));
    const versions = { previous: `${toolkitVersion.version}.1-release-previous`, next: `${toolkitVersion.version}.2-release-next` };
    const markers = { previous: {}, next: {} };
    for (const [label, root] of [['previous', previous], ['next', next]]) {
        fs.writeFileSync(path.join(root, '.agents/config/version.json'), JSON.stringify({ ...toolkitVersion, version: versions[label] }, null, 2) + '\n');
        for (const [kind, rel] of Object.entries(RELEASE_MARKED)) {
            markers[label][kind] = `RELEASE_${label.toUpperCase()}_${kind.toUpperCase()}`;
            fs.appendFileSync(path.join(root, rel), `\n${markers[label][kind]}\n`);
        }
    }
    fs.writeFileSync(path.join(next, NEXT_ONLY.reference), '# Release next only\n\nRELEASE_NEXT_ONLY_REFERENCE\n');
    fs.mkdirSync(path.dirname(path.join(next, NEXT_ONLY.helper)), { recursive: true });
    fs.writeFileSync(path.join(next, NEXT_ONLY.helper), "'use strict';\n// RELEASE_NEXT_ONLY_HELPER\nmodule.exports = {};\n");
    // A published release checkout has its native projections rendered from its own
    // canonical sources. The copy omits the workshop ledger and may catch unrendered
    // workshop edits, so each release renders once here (fixture construction only;
    // the adopter is never forced).
    for (const root of [previous, next]) {
        if (renderSharedAgents(root, { force: true }).conflicts.length) throw new Error(`Release render conflicted: ${root}`);
    }
    return {
        previous, next, versions, markers, marked: RELEASE_MARKED, nextOnly: NEXT_ONLY,
        digests: { previous: snapshotDigests(previous), next: snapshotDigests(next) },
    };
}

module.exports = { copyToolkit, preparePilot, updatePilot, snapshotDigests, changedPaths, prepareReleasePair };
