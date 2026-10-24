/** Canonical .agents sources -> ordinary native files. No reverse import. */
'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { safeWrite, assertNoSymlinkedAncestor } = require('./fs-safe');
const { parseAgentSections, extractFieldBlock, extractSkillsList, mergeAgentContent, stripExcludedSkills } = require('./agent-merger');
const { mergeSkillContent, hasProjectAdditions } = require('./skill-merger');
const { walkDir } = require('./file-walker');
const { classifySharedFile } = require('./zone-classifier');
const { ignoredFilter } = require('./git-ignored');
const { renderModelProse } = require('./model-prose');
const { renderWorkflowRoutes } = require('./workflow-routes');
const { hookIdentities, changedTrustHandlers } = require('./codex-hook-identities');

const STATE_PATH = '.agents/render-state.json';
const HOOK_IDENTITIES_PATH = '.codex/hook-identities.json';
const HOOK_IDENTITIES_SOURCE = '.agents/core/_lib/codex-hook-identities.js';
const COMMAND_NOTICE = '<!-- Generated command entry point from ';
const normalize = text => text.replace(/\r\n/g, '\n');
const digest = text => createHash('sha256').update(typeof text === 'string' ? normalize(text) : text).digest('hex');

function read(root, rel) { return normalize(fs.readFileSync(path.join(root, rel), 'utf8')); }
function write(root, rel, content) {
    const dest = path.join(root, rel);
    assertNoSymlinkedAncestor(dest, root);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    safeWrite(dest, content, 'utf8', root);
}

function field(frontmatter, key) {
    const lines = frontmatter.split('\n');
    const block = extractFieldBlock(lines, key);
    if (!block) throw new Error(`shared-agents: missing ${key} in canonical frontmatter`);
    const value = lines[block.start].slice(lines[block.start].indexOf(':') + 1).trim();
    if (value === '>' || value === '|') return lines.slice(block.start + 1, block.end).map(l => l.trim()).join(' ');
    return value.replace(/^['"]|['"]$/g, '');
}

function canonicalFiles(root) {
    const files = [];
    const state = fs.existsSync(path.join(root, STATE_PATH)) ? JSON.parse(read(root, STATE_PATH)) : {};
    // Git-ignored files under these trees are local state, never canonical
    // sources; a failed query in a real checkout throws. This holds
    // for adopter renders too: a projection rendered before its source became
    // ignored stops being an output. Unchanged, it is left in place and never
    // written or deleted; edited, or with its source removed, it is reported as
    // a conflict (fail-safe).
    const isIgnored = ignoredFilter(root);
    for (const dir of ['.agents/skills', '.agents/roles', '.agents/core', '.agents/hooks', '.agents/templates', '.agents/adapters', '.agents/config']) {
        for (const abs of walkDir(path.join(root, dir), ['__tests__', '_helpers', 'node_modules'])) {
            const rel = path.relative(root, abs).replace(/\\/g, '/');
            if (isIgnored(rel)) continue;
            // Native command selectors are derived from existing authored workflows,
            // not new canonical skills to project back into Claude.
            if (abs.endsWith(`${path.sep}SKILL.md`) && !fs.existsSync(path.join(path.dirname(abs), 'references/workflow.md')) && (state[rel] || fs.readFileSync(abs, 'utf8').includes(COMMAND_NOTICE))) continue;
            files.push(rel);
        }
    }
    for (const rel of ['.agents/startup.md', '.agents/startup-reference.md', '.agents/README.md']) if (fs.existsSync(path.join(root, rel))) files.push(rel);
    if (fs.existsSync(path.join(root, '.agents/gate.config.json'))) files.push('.agents/gate.config.json');
    return files.sort();
}

function workflowMap(root, files = new Map()) {
    const rel = '.agents/adapters/workflows.json';
    return files.has(rel) ? JSON.parse(files.get(rel)) : fs.existsSync(path.join(root, rel)) ? JSON.parse(read(root, rel)) : {};
}

// Imported modules retain their exports; executable entry points run as the
// actual main module with the original arguments, cwd and stdio. Native gate
// execution pins its project context so an inherited workshop root cannot select
// another checkout's commands or lock; imported helpers retain their root seam.
function compatibilityWrapper(source, output) {
    const runtimeDefault = output.startsWith('.codex/') ? "if (!process.env.AGENTS_RUNTIME && !process.env.AGENT_RUNTIME) process.env.AGENTS_RUNTIME = 'codex';\n" : '';
    const relative = path.posix.relative(path.posix.dirname(output), source);
    const gateEnvironment = source === '.agents/core/gate.js'
        ? ", env: { ...process.env, CLAUDE_PROJECT_DIR: require('path').resolve(__dirname, '..', '..'), AGENTS_PROJECT_DIR: require('path').resolve(__dirname, '..', '..') }"
        : '';
    return `#!/usr/bin/env node\n'use strict';\n// Generated compatibility entry point from ${source}.\n${runtimeDefault}const entry = require('path').resolve(__dirname, ${JSON.stringify(relative)});\nif (require.main === module) {\n    const result = require('child_process').spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true${gateEnvironment} });\n    if (result.error) throw result.error;\n    if (result.signal) process.kill(process.pid, result.signal);\n    else process.exitCode = result.status === null ? 1 : result.status;\n} else module.exports = require(entry);\n`;
}

function commandFiles(root) {
    // A Git-ignored local command must not become a generated selector skill
    // here or in an adopter.
    const isIgnored = ignoredFilter(root);
    return [...walkDir(path.join(root, '.claude/commands'), ['__tests__', '_helpers', 'node_modules'])]
        .filter(file => file.endsWith('.md'))
        .map(file => path.relative(root, file).replace(/\\/g, '/'))
        .filter(rel => !isIgnored(rel)).sort();
}

function commandEntries(root, commands = commandFiles(root), sources = canonicalFiles(root), excludedSkills = new Set()) {
    const entries = new Map();
    const names = new Set();
    for (const source of commands) {
        const name = source.slice('.claude/commands/'.length, -3).replace(/\//g, '-');
        if (names.has(name)) throw new Error(`shared-agents: command skill name collision: ${name}`);
        names.add(name);
        if (excludedSkills.has(name)) continue;
        // A migrated canonical skill already supplies the native selector.
        if (sources.includes(`.agents/skills/${name}/SKILL.md`)) continue;
        entries.set(`.agents/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: "Run the ${name} workflow when explicitly requested. Uses the existing authored command and its completion rules."\n---\n\n${COMMAND_NOTICE}${source}; edit that source, then render. -->\n\n# ${name}\n\nRead \`${source}\` before acting, then follow its workflow using the user's arguments. Read referenced skills, templates and role instructions only when the current step needs them. Existing project instructions and user authorization apply.\n\n## Runtime adaptation\n\nFor Codex, read \`.agents/adapters/codex/execution.md\` and apply its native tool and model rules.\n`);
    }
    return entries;
}

/** Apply the same opt-out to canonical skills, legacy skills and command selectors. */
function isExcludedSkillPath(rel, excludedSkills, workflows = {}) {
    if (!excludedSkills?.size) return false;
    const skill = /^\.(?:agents|claude)\/skills\/([^/]+)\//.exec(rel);
    if (skill && excludedSkills.has(skill[1])) return true;
    const command = /^\.claude\/commands\/(.+)\.md$/.exec(rel);
    if (command && excludedSkills.has(command[1].replace(/\//g, '-'))) return true;
    return Object.entries(workflows).some(([name, dest]) => dest === rel && excludedSkills.has(name));
}

/** Reuse the existing managed-block merger; adopter prose remains outside it. */
function syncStartupInstructions(root, options = {}) {
    if (!options.available && !fs.existsSync(path.join(root, '.agents/startup.md'))) return [];
    const { applyManagedBlock } = options;
    if (typeof applyManagedBlock !== 'function') throw new Error('Startup instruction sync requires the managed-block merger from its caller.');
    const directives = new Map([
        ['CLAUDE.md', '@.agents/startup.md'],
        ['AGENTS.md', 'Read `.agents/startup.md` before task work and retain its required rules on resume. Read `.agents/startup-reference.md` only for sections triggered by the current task; preserve project-owned instructions. In Codex, execute helper commands through `.codex/core/`; translate `.claude/core/` examples in shared guidance to that prefix.'],
    ]);
    const changed = [];
    // Preview both roots before writing either, including malformed marker errors.
    for (const [rel, content] of directives) {
        const dest = path.join(root, rel);
        assertNoSymlinkedAncestor(dest, root);
        if (fs.existsSync(dest) && fs.lstatSync(dest).isSymbolicLink()) throw new Error(`shared-agents: preserve symlinked project instructions: ${rel}`);
        if (applyManagedBlock(dest, content, { dryRun: true, containRoot: root, startup: true }) !== 'unchanged') changed.push(rel);
    }
    if (!options.dryRun) for (const rel of changed) applyManagedBlock(path.join(root, rel), directives.get(rel), { containRoot: root, startup: true });
    return changed;
}

/** Native paths managed by a canonical skill or role; other files stay legacy. */
function projectionPaths(root) {
    const out = new Set(commandEntries(root).keys());
    if (fs.existsSync(path.join(root, '.agents/adapters/codex/hooks-config.json'))) {
        out.add('.codex/hooks.json');
        out.add(HOOK_IDENTITIES_PATH);
    }
    for (const dest of Object.values(workflowMap(root))) out.add(dest);
    for (const rel of canonicalFiles(root)) {
        if (/^\.agents\/(core|hooks|templates)\//.test(rel)) out.add(rel.replace('.agents/', '.claude/'));
        if (/^\.agents\/(core|hooks)\//.test(rel)) out.add(rel.replace('.agents/', '.codex/'));
        if (rel.startsWith('.agents/config/')) out.add(rel.replace('.agents/config/', '.claude/'));
        if (rel === '.agents/gate.config.json') out.add('.claude/gate.config.json');
        const skill = /^\.agents\/skills\/([^/]+)\/(.+)$/.exec(rel);
        if (skill) {
            out.add(`.claude/skills/${skill[1]}/${skill[2]}`);
            if (skill[1] === 'review-specialize' && skill[2] === 'SKILL.md') out.add('.claude/commands/review/specialize.md');
        }
        const role = /^\.agents\/roles\/([^/]+)\.md$/.exec(rel);
        if (role) { out.add(`.claude/agents/${role[1]}.md`); out.add(`.codex/agents/${role[1]}.toml`); }
    }
    return out;
}

function addMarkdownNotice(text, source) {
    const notice = `<!-- Generated from ${source}; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->\n`;
    const match = /^---\n[\s\S]*?\n---\n/.exec(text);
    if (!match) throw new Error(`shared-agents: invalid frontmatter in ${source}`);
    return match[0] + '\n' + notice + text.slice(match[0].length).replace(/^\n+/, '\n');
}

/**
 * The canonical paths an output would be rendered from, mirroring the rules in
 * renderSharedAgents. Used only to tell a source that still exists on disk (hidden by
 * an ignore rule) from one that was removed.
 */
function candidateSourcesOf(output, workflows) {
    const candidates = [];
    if (output === '.codex/hooks.json' || output === HOOK_IDENTITIES_PATH) candidates.push('.agents/adapters/codex/hooks-config.json');
    let match;
    if ((match = /^\.claude\/skills\/([^/]+)\/(.+)$/.exec(output))) candidates.push(`.agents/skills/${match[1]}/${match[2]}`);
    if ((match = /^\.(?:claude|codex)\/(core|hooks)\/(.+)$/.exec(output))) candidates.push(`.agents/${match[1]}/${match[2]}`);
    if ((match = /^\.claude\/templates\/(.+)$/.exec(output))) candidates.push(`.agents/templates/${match[1]}`);
    if ((match = /^\.claude\/agents\/([^/]+)\.md$/.exec(output)) || (match = /^\.codex\/agents\/([^/]+)\.toml$/.exec(output))) candidates.push(`.agents/roles/${match[1]}.md`);
    if ((match = /^\.claude\/([^/]+)$/.exec(output))) candidates.push(`.agents/config/${match[1]}`);
    for (const [name, dest] of Object.entries(workflows || {})) {
        if (dest === output) candidates.push(`.agents/skills/${name}/references/workflow.md`, `.agents/skills/${name}/SKILL.md`);
    }
    return candidates;
}

/** Load adapter defaults and native overrides against the prospective tier map. */
function loadModelAdapter(root, runtime, files = new Map()) {
    const get = rel => files.has(rel) ? files.get(rel) : read(root, rel);
    const nativeRel = `.${runtime}/shared-agents.json`;
    const canonicalRel = `.agents/adapters/${runtime}/shared-agents.json`;
    const exists = rel => files.has(rel) || fs.existsSync(path.join(root, rel));
    const defaults = exists(canonicalRel) ? JSON.parse(get(canonicalRel)) : { roles: {} };
    const native = exists(nativeRel) ? JSON.parse(get(nativeRel)) : { roles: {} };
    const registries = [defaults.roles || {}, native.roles || {}];
    const tierRel = `.agents/adapters/${runtime}/model-tiers.json`;
    const usesTiers = registries.some(roles => Object.values(roles).some(settings => Object.hasOwn(settings, 'tier')));
    let tiers;
    if (usesTiers || exists(tierRel)) {
        tiers = JSON.parse(get(tierRel)).tiers;
        if (!tiers || Array.isArray(tiers) || typeof tiers !== 'object' || Object.keys(tiers).sort().join(',') !== 'audit,deep,fast,standard') {
            throw new Error(`shared-agents: ${tierRel} must define exactly the fast, standard, deep and audit tiers`);
        }
        for (const [tier, model] of Object.entries(tiers)) {
            if (model !== null && (typeof model !== 'string' || !model.trim() || model !== model.trim())) {
                throw new Error(`shared-agents: invalid model for ${runtime} tier ${tier}; use a model string or null`);
            }
        }
        if (runtime === 'claude' && tiers.audit === null) throw new Error('shared-agents: Claude audit tier must not be unassigned');
        // Validate declarations even when a project override shadows them.
        for (const roles of registries) for (const settings of Object.values(roles)) {
            if (Object.hasOwn(settings, 'tier') && (typeof settings.tier !== 'string' || !Object.hasOwn(tiers, settings.tier))) {
                throw new Error(`shared-agents: unknown ${runtime} tier ${JSON.stringify(settings.tier)}`);
            }
        }
    }
    const roles = {};
    for (const name of new Set(registries.flatMap(registry => Object.keys(registry)))) {
        const override = native.roles?.[name] || {};
        const settings = { ...defaults.roles?.[name], ...override };
        if (!Object.hasOwn(settings, 'tier')) { roles[name] = settings; continue; }
        // A native tier replaces an inherited legacy model; an explicit
        // native model always remains the project's chosen override.
        if (Object.hasOwn(override, 'tier') && !Object.hasOwn(override, 'model')) delete settings.model;
        const model = Object.hasOwn(settings, 'model') ? settings.model : tiers[settings.tier];
        if (runtime === 'claude' && model === null) throw new Error(`shared-agents: unassigned Claude tier ${settings.tier} for ${name}`);
        roles[name] = {};
        for (const [key, value] of Object.entries(settings)) {
            if (key === 'tier') {
                // Keep the historical model-field position and Claude bytes.
                if (model !== null) roles[name].model = model;
            } else if (key !== 'model') roles[name][key] = value;
        }
    }
    return { ...defaults, ...native, roles, tiers };
}

/** Render native surfaces without mutating canonical skills or role settings. */
function renderSharedAgents(root, options = {}) {
    root = path.resolve(root);
    const outputs = new Map();
    assertNoSymlinkedAncestor(path.join(root, STATE_PATH), root);
    const priorState = fs.existsSync(path.join(root, STATE_PATH)) ? JSON.parse(read(root, STATE_PATH)) : {};
    const files = options.files || new Map();
    // Both install and update preview prospective canonical copies here. A new
    // helper path can already be adopter-owned despite lacking a ledger entry.
    if (!priorState[HOOK_IDENTITIES_SOURCE]) {
        const existing = path.join(root, HOOK_IDENTITIES_SOURCE);
        assertNoSymlinkedAncestor(existing, root);
        const stat = fs.lstatSync(existing, { throwIfNoEntry: false });
        if (stat?.isSymbolicLink()) throw new Error(`shared-agents: refusing symlinked ${HOOK_IDENTITIES_SOURCE}`);
        const incoming = files.has(HOOK_IDENTITIES_SOURCE) ? files.get(HOOK_IDENTITIES_SOURCE) : fs.readFileSync(path.join(__dirname, 'codex-hook-identities.js'));
        if (stat && digest(fs.readFileSync(existing)) !== digest(incoming)) {
            return { changed: [], conflicts: [HOOK_IDENTITIES_SOURCE] };
        }
    }
    const get = rel => files.has(rel) ? files.get(rel) : read(root, rel);
    const claude = loadModelAdapter(root, 'claude', files);
    const codex = loadModelAdapter(root, 'codex', files);
    const prose = (text, runtime) => renderModelProse(renderWorkflowRoutes(text), runtime, runtime === 'claude' ? claude.tiers : codex.tiers);
    const content = (source, runtime) => {
        const raw = files.has(source) ? files.get(source) : fs.readFileSync(path.join(root, source));
        return source.endsWith('.md') && /\{\{model-arg|```workflow-routes/.test(raw.toString()) ? prose(raw.toString(), runtime) : raw;
    };
    const sources = [...new Set([...canonicalFiles(root), ...files.keys()])].sort();
    for (const [rel, text] of commandEntries(root, options.commands, sources, options.excludedSkills)) outputs.set(rel, text);
    for (const [name, dest] of Object.entries(workflowMap(root, files))) {
        if (options.excludedSkills?.has(name)) continue;
        const source = `.agents/skills/${name}/references/workflow.md`;
        const metadataRel = '.agents/adapters/claude/workflow-metadata.json';
        const metadata = files.has(metadataRel) || fs.existsSync(path.join(root, metadataRel)) ? JSON.parse(get(metadataRel)) : {};
        if (sources.includes(source)) outputs.set(dest, metadata[name] ? addMarkdownNotice(`---\n${metadata[name]}\n---\n\n` + prose(get(source), 'claude'), source) : `<!-- Generated from ${source}; edit the canonical workflow, then render. -->\n` + prose(get(source), 'claude'));
        else if (sources.includes(`.agents/skills/${name}/SKILL.md`)) outputs.set(dest, addMarkdownNotice(prose(get(`.agents/skills/${name}/SKILL.md`), 'claude'), `.agents/skills/${name}/SKILL.md`));
    }
    for (const source of sources) {
        if (source === '.agents/adapters/codex/hooks-config.json') {
            const config = get(source);
            outputs.set('.codex/hooks.json', config);
            outputs.set(HOOK_IDENTITIES_PATH, JSON.stringify(hookIdentities(JSON.parse(config)), null, 2) + '\n');
            continue;
        }
        if (source === '.agents/adapters/claude/settings.json') {
            const native = '.claude/settings.json';
            const exists = fs.existsSync(path.join(root, native));
            // Native settings become project-owned as soon as their registered
            // defaults are edited. The section-aware updater still merges them.
            if (!exists || digest(read(root, native)) === digest(get(source)) || (priorState[native] && digest(read(root, native)) === priorState[native])) outputs.set(native, get(source));
            continue;
        }
        if (source === '.agents/config/guardrail-rules.project.yaml') continue;
        if (source.startsWith('.agents/config/')) { outputs.set(source.replace('.agents/config/', '.claude/'), files.has(source) ? files.get(source) : fs.readFileSync(path.join(root, source))); continue; }
        if (/^\.agents\/(core|hooks)\//.test(source)) {
            const native = source.replace('.agents/', '.codex/');
            outputs.set(native, /\.(js|cjs)$/.test(source) ? compatibilityWrapper(source, native) : files.has(source) ? files.get(source) : fs.readFileSync(path.join(root, source)));
        }
        if (/^\.agents\/(core|hooks|templates)\//.test(source)) {
            const output = source.replace('.agents/', '.claude/');
            outputs.set(output, /\.(js|cjs)$/.test(source) ? compatibilityWrapper(source, output) : files.has(source) ? files.get(source) : fs.readFileSync(path.join(root, source)));
            continue;
        }
        if (source === '.agents/gate.config.json') {
            outputs.set('.claude/gate.config.json', JSON.stringify(JSON.parse(get(source)), null, 2) + '\n');
            continue;
        }
        const skill = /^\.agents\/skills\/([^/]+)\/(.+)$/.exec(source);
        if (skill) {
            const [, name, rel] = skill;
            if (options.excludedSkills?.has(name)) continue;
            if (rel !== 'SKILL.md') {
                // Supporting scripts/assets remain ordinary files and resolve
                // relative to either runtime's native skill entry point.
                outputs.set(`.claude/skills/${name}/${rel}`, content(source, 'claude'));
                continue;
            }
            const text = get(source);
            if (field(parseAgentSections(text).frontmatter, 'name') !== name) throw new Error(`shared-agents: skill name must match ${name}`);
            const output = addMarkdownNotice(prose(text, 'claude'), source);
            outputs.set(`.claude/skills/${name}/SKILL.md`, output);
            if (name === 'review-specialize') outputs.set('.claude/commands/review/specialize.md', output);
            continue;
        }
        const role = /^\.agents\/roles\/([^/]+)\.md$/.exec(source);
        if (!role) continue;
        const name = role[1];
        const text = stripExcludedSkills(get(source), options.excludedSkills);
        const fm = parseAgentSections(text).frontmatter;
        if (field(fm, 'name') !== name) throw new Error(`shared-agents: role name must match ${name}`);
        if (/^(model|tools|disallowedTools|memory|permissionMode|maxTurns)\s*:/m.test(fm)) throw new Error(`shared-agents: runtime settings belong in native adapters, not ${source}`);
        const body = text.replace(/^---\n[\s\S]*?\n---\n+/, '');
        const identity = [`Canonical role source: ${source}.`];
        for (const key of ['nickname', 'aliases']) {
            if (extractFieldBlock(fm.split('\n'), key)) identity.push(`${key}: ${field(fm, key)}`);
        }
        const skills = extractSkillsList(fm.split('\n'))?.items || [];
        if (skills.length) {
            identity.push('Read these skills at the start of the task:');
            for (const skill of skills) {
                const canonical = `.agents/skills/${skill}/SKILL.md`;
                identity.push(`- ${sources.includes(canonical) ? canonical : `.claude/skills/${skill}/SKILL.md`}`);
            }
        }
        const native = Object.entries(claude.roles?.[name] || {}).map(([key, value]) => {
            if (!/^(model|tools|disallowedTools|memory|permissionMode|maxTurns)$/.test(key)) throw new Error(`shared-agents: unsupported Claude role setting ${key}`);
            return `${key}: ${JSON.stringify(value)}`;
        });
        outputs.set(`.claude/agents/${name}.md`, addMarkdownNotice(`---\n${fm}${native.length ? '\n' + native.join('\n') : ''}\n---\n\n${prose(body, 'claude')}`, source));
        const nativeCodex = Object.entries(codex.roles?.[name] || {}).map(([key, value]) => {
            if (!/^(model|model_reasoning_effort|sandbox_mode)$/.test(key) || typeof value !== 'string') throw new Error(`shared-agents: unsupported Codex role setting ${key}`);
            return `${key} = ${JSON.stringify(value)}`;
        });
        // JSON escaping is a subset of TOML basic-string escaping, including
        // quotes, backslashes and newlines in arbitrary Markdown instructions.
        outputs.set(`.codex/agents/${name}.toml`, [
            `# Generated from ${source}; edit the canonical source and render.`,
            `name = ${JSON.stringify(name)}`,
            `description = ${JSON.stringify(field(fm, 'description'))}`,
            ...nativeCodex,
            `developer_instructions = ${JSON.stringify(identity.join('\n') + '\n\n' + prose(body, 'codex'))}`,
            '',
        ].join('\n'));
    }

    const selected = rel => !options.deferredOutputs?.has(rel) && (!options.onlyOutputs || options.onlyOutputs.has(rel));
    // Deferred outputs retain their previous ledger entry until their caller
    // completes all phases (the updater's version is a sync-complete marker).
    for (const rel of outputs.keys()) if (!selected(rel)) outputs.delete(rel);
    for (const rel of outputs.keys()) assertNoSymlinkedAncestor(path.join(root, rel), root);

    const previous = priorState;
    const next = { ...previous };
    // An updater can replace a generated selector with an authored skill. Once
    // that canonical input is accepted, retire its old output-ledger entry.
    for (const rel of sources) if (/^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(rel) && !outputs.has(rel)) delete next[rel];
    // Canonical hashes are the updater's accepted-input baseline, not a record
    // of what was most recently rendered. Bootstrap missing entries for legacy
    // checkouts, then advance them only for the install/update's accepted files.
    // A local source edit followed by any render must remain detectable at sync.
    for (const rel of sources) if (/^\.agents\/(core|hooks|templates|config|adapters)\//.test(rel) && (files.has(rel) || !previous[rel])) next[rel] = digest(files.has(rel) ? files.get(rel) : fs.readFileSync(path.join(root, rel)));
    const result = { changed: [], conflicts: [] };
    // Metadata cannot consume a pending trust warning before the native
    // registrations change. A sidecar-only selection must describe installed hooks.
    if (outputs.has(HOOK_IDENTITIES_PATH) && !outputs.has('.codex/hooks.json')) {
        const nativePath = path.join(root, '.codex/hooks.json');
        assertNoSymlinkedAncestor(nativePath, root);
        const native = fs.lstatSync(nativePath, { throwIfNoEntry: false });
        if (native?.isSymbolicLink()) throw new Error('shared-agents: refusing symlinked .codex/hooks.json');
        const desired = JSON.parse(outputs.get(HOOK_IDENTITIES_PATH));
        const installed = native?.isFile() ? hookIdentities(JSON.parse(read(root, '.codex/hooks.json'))) : null;
        if (!installed || changedTrustHandlers(installed, desired) || changedTrustHandlers(desired, installed)) {
            return { changed: [], conflicts: ['.codex/hooks.json'] };
        }
    }
    if (outputs.has(HOOK_IDENTITIES_PATH) || outputs.has('.codex/hooks.json')) {
        const sidecar = path.join(root, HOOK_IDENTITIES_PATH);
        assertNoSymlinkedAncestor(sidecar, root);
        const existing = fs.lstatSync(sidecar, { throwIfNoEntry: false });
        if (existing?.isSymbolicLink()) throw new Error(`shared-agents: refusing symlinked ${HOOK_IDENTITIES_PATH}`);
        // This new output has no legacy adoption path. Even identical unmanaged
        // bytes belong to the adopter until explicitly resolved outside render.
        if (existing && !previous[HOOK_IDENTITIES_PATH]) {
            if (outputs.has(HOOK_IDENTITIES_PATH)) result.conflicts.push(HOOK_IDENTITIES_PATH);
        } else {
            const prior = existing ? JSON.parse(read(root, HOOK_IDENTITIES_PATH)) : null;
            const nextIdentities = hookIdentities(JSON.parse(get('.agents/adapters/codex/hooks-config.json')));
            const invalidated = changedTrustHandlers(prior, nextIdentities);
            if (invalidated) result.warnings = [`this change invalidates trust for ${invalidated} handlers`];
        }
    }
    // A ledger entry that is no longer an output is reported (its canonical source was removed, or the
    // output was edited). One case is not: the canonical source is still on disk but a project ignore
    // rule now hides it from the render, and the output is byte-for-byte what was rendered. Nothing
    // was edited and nothing was removed, so it neither conflicts nor is rewritten or deleted.
    const sourceHiddenByIgnoreAndOutputUnchanged = rel => {
        const sourceCandidates = candidateSourcesOf(rel, workflowMap(root, files));
        if (!sourceCandidates.some(source => fs.existsSync(path.join(root, source)))) return false;
        try {
            const bytes = fs.readFileSync(path.join(root, rel));
            return digest(bytes) === previous[rel] || digest(bytes.toString('utf8')) === previous[rel];
        } catch {
            return false; // unreadable: keep reporting it, as before
        }
    };
    for (const rel of Object.keys(previous)) if (selected(rel) && !isExcludedSkillPath(rel, options.excludedSkills, workflowMap(root, files)) && !outputs.has(rel) && rel !== '.claude/settings.json' && !rel.startsWith('.agents/') && fs.existsSync(path.join(root, rel)) && !sourceHiddenByIgnoreAndOutputUnchanged(rel)) result.conflicts.push(rel);
    // Validate every output before any write: a conflict cannot leave the other
    // runtime silently updated while the edited projection stays behind.
    for (const [rel, content] of outputs) {
        const exists = fs.existsSync(path.join(root, rel));
        const current = exists ? (Buffer.isBuffer(content) ? fs.readFileSync(path.join(root, rel)) : read(root, rel)) : null;
        if (exists && digest(current) === digest(content)) { next[rel] = digest(content); continue; }
        if (exists && !options.force && !options.adoptPaths?.has(rel) && (!previous[rel] || digest(current) !== previous[rel])) result.conflicts.push(rel);
        result.changed.push(rel);
        next[rel] = digest(content);
    }
    if (!options.dryRun && result.conflicts.length === 0) {
        for (const rel of result.changed) write(root, rel, outputs.get(rel));
        if (JSON.stringify(previous) !== JSON.stringify(next)) write(root, STATE_PATH, JSON.stringify(next, null, 2) + '\n');
    }
    return result;
}

/**
 * Ordinary update: reuse the existing content mergers before rendering. The
 * entire shared change is planned first, so dry-run and conflicts write nothing.
 * A legacy native role/skill can seed project-owned zones on its first update;
 * this relies on today's files, never on migration history.
 */
function syncSharedAgents(source, target, options = {}) {
    const result = { copied: 0, merged: 0, skipped: 0, conflicts: [], warnings: [], changed: [] };
    const incoming = canonicalFiles(source);
    const sourceState = fs.existsSync(path.join(target, STATE_PATH)) ? JSON.parse(read(target, STATE_PATH)) : {};
    for (const rel of incoming) if (/^\.agents\/(core|hooks|templates|config|adapters)\//.test(rel) && sourceState[rel] && fs.existsSync(path.join(target, rel)) && digest(fs.readFileSync(path.join(target, rel))) !== sourceState[rel]) result.conflicts.push(rel);
    if (result.conflicts.length) return result;
    if (!incoming.length) return result;
    const before = renderSharedAgents(target, { dryRun: true, excludedSkills: options.excludedSkills, deferredOutputs: options.deferredOutputs });
    if (before.conflicts.length) { result.conflicts = before.conflicts; return result; }
    const files = new Map();
    const adoptPaths = new Set();
    const migratedNative = new Map();
    const hashPath = path.join(source, '.agents/adapters/legacy-hashes.json');
    const legacyHashes = fs.existsSync(hashPath) ? JSON.parse(fs.readFileSync(hashPath, 'utf8')) : {};
    const managedLegacy = rel => fs.existsSync(path.join(target, rel)) && legacyHashes[rel]?.includes(digest(read(target, rel)));
    for (const rel of projectionPaths(source)) if (managedLegacy(rel)) adoptPaths.add(rel);
    const workflows = workflowMap(source);
    const pending = [];
    const queue = (rel, content, merged) => {
        const dest = path.join(target, rel);
        const current = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
        files.set(rel, content);
        if (current && digest(Buffer.isBuffer(content) ? current : current.toString('utf8')) === digest(content)) { result.skipped++; return; }
        pending.push([rel, content]);
        result.changed.push(rel);
        result[merged ? 'merged' : 'copied']++;
    };
    for (const rel of incoming) {
        const skill = /^\.agents\/skills\/([^/]+)\/(.+)$/.exec(rel);
        if (skill && options.excludedSkills?.has(skill[1])) { result.skipped++; continue; }
        const zone = classifySharedFile(rel);
        if (zone === 'project-exception') { result.skipped++; continue; }
        const dest = path.join(target, rel);
        assertNoSymlinkedAncestor(dest, target);
        if (zone === 'project' && fs.existsSync(dest)) { result.skipped++; continue; }
        const role = /^\.agents\/roles\/([^/]+)\.md$/.exec(rel);
        let legacy = role ? `.claude/agents/${role[1]}.md` : skill ? `.claude/skills/${skill[1]}/${skill[2]}` : null;
        if (skill && skill[2] === 'references/workflow.md' && workflows[skill[1]]) legacy = workflows[skill[1]];
        // The old specialization front door was a slash command, before it
        // became a native skill. Its marked project additions survive adoption.
        if (rel === '.agents/skills/review-specialize/SKILL.md' && !fs.existsSync(path.join(target, legacy))) legacy = '.claude/commands/review/specialize.md';
        if (/^\.agents\/(core|hooks|templates|config)\//.test(rel)) {
            const native = rel.startsWith('.agents/config/') ? rel.replace('.agents/config/', '.claude/') : rel.replace('.agents/', '.claude/');
            const nativeAbs = path.join(target, native);
            if (fs.existsSync(nativeAbs)) {
                const old = fs.readFileSync(nativeAbs);
                const incomingBytes = fs.readFileSync(path.join(source, rel));
                const sourceNative = path.join(source, native);
                if (digest(old) === digest(incomingBytes) || (fs.existsSync(sourceNative) && digest(old) === digest(fs.readFileSync(sourceNative)))) adoptPaths.add(native);
            }
        }
        const existing = fs.existsSync(dest) ? dest : legacy && fs.existsSync(path.join(target, legacy)) ? path.join(target, legacy) : null;
        if (existing) assertNoSymlinkedAncestor(existing, target);
        if (role && existing && !options.merge) {
            result.warnings.push(`${rel}: mixed zone; skipped under --no-merge (the default merge preserves role customizations)`);
            result.skipped++; continue;
        }
        let content = rel.endsWith('.md') ? read(source, rel) : fs.readFileSync(path.join(source, rel));
        if (role && existing) {
            const old = normalize(fs.readFileSync(existing, 'utf8'));
            const r = mergeAgentContent(content, old, options);
            content = r.content;
            if (existing !== dest) {
                const fm = parseAgentSections(old).frontmatter;
                const native = {};
                for (const key of ['model', 'tools', 'disallowedTools', 'memory', 'permissionMode', 'maxTurns']) {
                    if (!extractFieldBlock(fm.split('\n'), key)) continue;
                    const value = field(fm, key);
                    native[key] = key === 'maxTurns' ? Number(value) : value;
                }
                migratedNative.set(role[1], native);
                content = content.replace(/^<!-- Generated[^\n]*-->\n?/gm, '');
                adoptPaths.add(legacy);
            }
        } else if (role && rel.endsWith('.md')) {
            // A role the target does not have yet is written fresh. It still drops the skills the project
            // excludes; otherwise the next update (the merge path, which does) would rewrite it.
            content = stripExcludedSkills(content, options.excludedSkills);
        } else if ((skill || rel === '.agents/startup.md') && existing && options.merge && rel.endsWith('.md') && hasProjectAdditions(fs.readFileSync(existing, 'utf8'))) {
            const r = mergeSkillContent(content, fs.readFileSync(existing, 'utf8'));
            content = r.content;
            if (r.headSuppressed || r.orphans.length) result.warnings.push(`${rel}: ${r.headSuppressed ? 'head refresh suppressed' : 'orphaned project additions recovered'}`);
        }
        if (existing && existing !== dest && skill) {
            adoptPaths.add(`.claude/skills/${skill[1]}/${skill[2]}`);
            if (skill[2] === 'references/workflow.md' && (managedLegacy(legacy) || (options.merge && hasProjectAdditions(fs.readFileSync(existing, 'utf8'))))) adoptPaths.add(legacy);
            if (skill[1] === 'review-specialize') adoptPaths.add('.claude/commands/review/specialize.md');
        }
        queue(rel, content, Boolean(existing));
    }
    for (const runtime of ['claude', 'codex']) {
        const rel = `.${runtime}/shared-agents.json`;
        const src = path.join(source, rel);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(target, rel);
        assertNoSymlinkedAncestor(dest, target);
        const defaults = JSON.parse(read(source, rel));
        const obj = fs.existsSync(dest) ? JSON.parse(read(target, rel)) : { ...defaults, roles: {} };
        obj.roles = { ...defaults.roles, ...obj.roles };
        if (runtime === 'claude') for (const [name, native] of migratedNative) obj.roles[name] = { ...obj.roles[name], ...native };
        queue(rel, JSON.stringify(obj, null, 2) + '\n', fs.existsSync(dest));
    }
    const commands = commandFiles(source);
    const preview = renderSharedAgents(target, { dryRun: true, files, adoptPaths, excludedSkills: options.excludedSkills, deferredOutputs: options.deferredOutputs, commands });
    result.warnings.push(...(preview.warnings || []));
    if (preview.conflicts.length) { result.conflicts = preview.conflicts; result.copied = result.merged = 0; result.changed = []; return result; }
    result.changed.push(...preview.changed);
    result.copied += preview.changed.length;
    if (!options.dryRun) {
        for (const [rel, content] of pending) write(target, rel, content);
        const rendered = renderSharedAgents(target, { files, adoptPaths, excludedSkills: options.excludedSkills, deferredOutputs: options.deferredOutputs, commands });
        result.conflicts.push(...rendered.conflicts);
    }
    return result;
}

module.exports = { loadModelAdapter, renderSharedAgents, syncSharedAgents, syncStartupInstructions, projectionPaths, canonicalFiles, commandFiles, workflowMap, isExcludedSkillPath, STATE_PATH };
