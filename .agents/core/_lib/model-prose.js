'use strict';

const fs = require('fs');
const path = require('path');
const { walkDir } = require('./file-walker');
const { ignoredFilter } = require('./git-ignored');

/** Resolve argument tokens without changing canonical prose or role overrides. */
function renderModelProse(text, runtime, tiers) {
    if (!['claude', 'codex'].includes(runtime)) throw new Error(`model-prose: unsupported runtime ${runtime}`);
    const rendered = text.replace(/\{\{model-arg:([a-z]+)\}\}/g, (_token, tier) => {
        if (!tiers || !Object.hasOwn(tiers, tier)) throw new Error(`model-prose: unknown ${runtime} tier ${tier}`);
        const model = tiers[tier];
        if (model === null && runtime === 'codex') return '/* omit the model parameter */';
        if (typeof model !== 'string' || !model.trim() || model !== model.trim()) throw new Error(`model-prose: unassigned or invalid ${runtime} tier ${tier}`);
        if (runtime === 'codex' && /^(?:sonnet|opus|haiku|inherit)$|^claude-/i.test(model)) throw new Error(`model-prose: invalid Codex model for tier ${tier}`);
        return `model: ${JSON.stringify(model)}`;
    });
    if (rendered.includes('{{model-arg')) throw new Error('model-prose: malformed model argument token');
    return rendered;
}

// The prose guard explicitly excludes executable model-runner and statusline constants.
// These are exact paths, not a blanket exemption for new executable code.
const EXECUTABLE_EXCLUSIONS = new Set([
    '.agents/adapters/claude/core/_lib/model-runner.js',
    '.agents/core/statusline.sh',
]);

/** Scan authored sources only; native projections necessarily contain models. */
function scanModelLiterals(root) {
    const isIgnored = ignoredFilter(root);
    const violations = [];
    let scanned = 0;
    for (const abs of walkDir(path.join(root, '.agents'), ['__tests__', 'node_modules'])) {
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        if (isIgnored(rel) || EXECUTABLE_EXCLUSIONS.has(rel) || rel === '.agents/adapters/legacy-hashes.json' || /^\.agents\/adapters\/(claude|codex)\/model-tiers\.json$/.test(rel)) continue;
        scanned++;
        const text = fs.readFileSync(abs, 'utf8');
        const pattern = /\bmodel["']?\s*:\s*(?:(["'`])(?:sonnet|opus|haiku)\1|(?:sonnet|opus|haiku)\b)|\bclaude-(?:sonnet|opus|haiku|fable)-[a-z\d]|\bgpt-\d/gi;
        for (const match of text.matchAll(pattern)) violations.push({ path: rel, line: text.slice(0, match.index).split('\n').length, literal: match[0] });
    }
    return { scanned, violations };
}

module.exports = { renderModelProse, scanModelLiterals };
