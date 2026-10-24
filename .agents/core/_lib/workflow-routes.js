'use strict';

const START = '<!-- workflow-routes:diagram:start -->';
const END = '<!-- workflow-routes:diagram:end -->';
const BLOCK = /^```workflow-routes[ \t]*\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gm;
const TIERS = new Set(['fast', 'standard', 'deep', 'audit']);

function routeParts(text) {
    const blocks = [...text.matchAll(BLOCK)];
    if (!blocks.length && !text.includes('```workflow-routes') && !text.includes(START) && !text.includes(END)) return null;
    if (blocks.length !== 1 || text.split(START).length !== 2 || text.split(END).length !== 2) {
        throw new Error('workflow-routes: expected one route block and one managed diagram');
    }
    const start = text.indexOf(START);
    const end = text.indexOf(END);
    if (start < blocks[0].index + blocks[0][0].length || end < start) throw new Error('workflow-routes: misplaced diagram markers');
    return { block: blocks[0], start, end };
}

/** Ordered runtime-neutral dispatch metadata; no agent execution lives here. */
function parseWorkflowRoutes(text) {
    const parts = routeParts(text);
    if (!parts) return [];
    let records;
    try { records = JSON.parse(parts.block[1]); }
    catch { throw new Error('workflow-routes: route block must be valid JSON'); }
    if (!Array.isArray(records) || records.length === 0) throw new Error('workflow-routes: route array must be nonempty');
    const steps = new Set();
    for (const record of records) {
        if (!record || Array.isArray(record) || typeof record !== 'object' || Object.keys(record).sort().join(',') !== 'condition,output,role,step,tier') {
            throw new Error('workflow-routes: each route requires exactly step, role, tier, condition, output');
        }
        for (const value of Object.values(record)) if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 500) {
            throw new Error('workflow-routes: route fields must be nonempty bounded strings');
        }
        if (!/^[a-z][a-z0-9-]{0,79}$/.test(record.step) || !/^[a-z][a-z0-9-]{0,79}$/.test(record.role) || !TIERS.has(record.tier)) {
            throw new Error('workflow-routes: invalid route step, role or tier');
        }
        if (steps.has(record.step)) throw new Error(`workflow-routes: duplicate route step ${record.step}`);
        steps.add(record.step);
    }
    return records;
}

// Tokenize pseudocode without crediting dispatch-looking comments or strings.
// Triple-quoted prompts are literals too; their contents are not agent calls.
function tokens(code) {
    const out = [];
    let i = 0;
    while (i < code.length) {
        if (/\s/.test(code[i])) { i++; continue; }
        if (code[i] === '#') { const end = code.indexOf('\n', i); i = end < 0 ? code.length : end; continue; }
        if (code.startsWith('//', i)) { const end = code.indexOf('\n', i); i = end < 0 ? code.length : end; continue; }
        if (code.startsWith('/*', i)) {
            const end = code.indexOf('*/', i + 2);
            if (end < 0) throw new Error('workflow-routes: unsupported dispatch code (unclosed comment)');
            i = end + 2; continue;
        }
        if ('\'"`'.includes(code[i]) && !(code[i] === "'" && /\w/.test(code[i - 1] || ''))) {
            const sourceLine = code.slice(0, i).split('\n').length;
            const quote = code[i];
            const delimiter = code.startsWith(quote.repeat(3), i) ? quote.repeat(3) : quote;
            i += delimiter.length;
            let value = ''; let closed = false;
            while (i < code.length) {
                if (code.startsWith(delimiter, i)) { i += delimiter.length; closed = true; break; }
                if (code[i] === '\\' && i + 1 < code.length) { value += code[i + 1]; i += 2; }
                else value += code[i++];
            }
            if (!closed) throw new Error(`workflow-routes: unsupported dispatch code (unclosed string at code line ${sourceLine})`);
            out.push({ value, literal: true }); continue;
        }
        const identifier = /^[a-zA-Z_$][\w$-]*/.exec(code.slice(i));
        const value = identifier ? identifier[0] : code[i];
        out.push({ value, literal: false }); i += value.length;
    }
    return out;
}

/** Bounded syntax/prose inventory, deliberately not a natural-language parser. */
function extractDispatchRoles(text) {
    const roles = new Set();
    const body = text.replace(BLOCK, '').replace(/<!-- workflow-routes:diagram:start -->[\s\S]*?<!-- workflow-routes:diagram:end -->/g, '').replace(/\r\n/g, '\n');
    const scan = code => {
        if (!/\b(?:Agent|Task)\s*[(.]|\bsubagent_type\b|=\s*(?:Agent|Task)\b|\b(?:dispatch|spawn)\s*`/i.test(code)) return;
        const stream = tokens(code);
        for (let i = 0; i < stream.length; i++) {
            const item = stream[i];
            const next = stream[i + 1];
            if (item.value === 'subagent_type' && next?.value === ':') {
                const role = stream[i + 2];
                if (!role?.literal || !/^[a-z][a-z0-9-]*$/.test(role.value)) throw new Error('workflow-routes: dynamic dispatch role must be declared literally');
                roles.add(role.value);
            }
            if (item.literal) continue;
            if (['Agent', 'Task'].includes(item.value) && (next?.value === '.' || stream[i - 1]?.value === '=')) throw new Error('workflow-routes: unsupported aliased/chained dispatch');
            if (item.value === 'Agent' && next?.value === '(') {
                const objectArgument = stream[i + 2]?.value === '{';
                if (!objectArgument && stream[i + 3]?.value !== ':') throw new Error('workflow-routes: dynamic Agent dispatch options');
                let depth = 1; let braces = 0; let brackets = 0; let hasRole = false;
                for (let j = i + 2; j < stream.length && depth; j++) {
                    const token = stream[j];
                    if (token.value === 'subagent_type' && stream[j + 1]?.value === ':' && depth === 1 && braces === (objectArgument ? 1 : 0) && brackets === 0) hasRole = true;
                    if (!token.literal && token.value === '(') depth++;
                    if (!token.literal && token.value === ')') depth--;
                    if (!token.literal && token.value === '{') braces++;
                    if (!token.literal && token.value === '}') braces--;
                    if (!token.literal && token.value === '[') brackets++;
                    if (!token.literal && token.value === ']') brackets--;
                }
                if (!hasRole || depth) throw new Error('workflow-routes: dynamic or incomplete Agent dispatch without a literal role');
            }
            if (item.value === 'Task' && next?.value === '(') {
                const role = stream[i + 2];
                if (!role || !/^[a-z][a-z0-9-]*$/.test(role.value)) throw new Error('workflow-routes: dynamic Task dispatch');
                roles.add(role.value);
            }
            if (/^(dispatch|spawn)$/i.test(item.value) && next?.literal && /^[a-z][a-z0-9-]*$/.test(next.value)) roles.add(next.value);
        }
    };
    // Markdown fences are structural: up to three spaces, matching marker
    // character, and a closing run at least as long as the opening run.
    const proseLines = [];
    let fence = null; let htmlComment = false; let inlineTicks = 0;
    const scanFence = () => {
        try { scan(fence.lines.join('\n')); }
        catch (err) { throw new Error(`${err.message}; fence at body line ${fence.line}`); }
    };
    for (const [index, line] of body.split('\n').entries()) {
        if (fence) {
            const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
            if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) { scanFence(); fence = null; }
            else fence.lines.push(line);
            continue;
        }
        const open = !htmlComment && inlineTicks === 0 && /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (open) { fence = { marker: open[1], lines: [], line: index + 1 }; continue; }
        let visible = '';
        for (let i = 0; i < line.length;) {
            if (htmlComment) {
                const end = line.indexOf('-->', i);
                if (end < 0) break;
                htmlComment = false; i = end + 3; continue;
            }
            if (line[i] === '`') {
                const run = /^`+/.exec(line.slice(i))[0];
                if (!inlineTicks) inlineTicks = run.length;
                else if (inlineTicks === run.length) inlineTicks = 0;
                visible += run; i += run.length; continue;
            }
            if (!inlineTicks && line.startsWith('<!--', i)) { htmlComment = true; i += 4; continue; }
            visible += line[i++];
        }
        proseLines.push(visible);
    }
    if (fence) scanFence(); // An unclosed Markdown fence extends to EOF.
    const prose = proseLines.join('\n');
    for (const match of prose.matchAll(/`([^`\n]+)`/g)) if (/subagent_type\s*:|\b(?:Agent|Task)\s*\(/.test(match[1])) scan(match[1]);
    for (const match of prose.matchAll(/\b(?:dispatch|spawn)\s+(?:one\s+)?`([a-z][a-z0-9-]*)`/gi)) roles.add(match[1]);
    return [...roles].sort();
}

const label = value => value.replace(/[&"<>\[\]{}|\r\n]/g, char => `#${char.charCodeAt(0)};`);

/** Pure projection: only the explicitly managed diagram fragment can change. */
function renderWorkflowRoutes(text) {
    const records = parseWorkflowRoutes(text);
    if (!records.length) return text;
    const declared = new Set(records.map(record => record.role));
    for (const role of extractDispatchRoles(text)) if (!declared.has(role)) throw new Error(`workflow-routes: undeclared dispatch role ${role}`);
    const lines = ['```mermaid', 'flowchart TD', '    main["Main Agent"]'];
    records.forEach((record, index) => {
        lines.push(`    r${index}["${label(record.step)}: ${label(record.role)} / ${record.tier}"]`);
        lines.push(`    main -->|"${label(record.condition)}"| r${index}`);
        lines.push(`    r${index} -->|"${label(record.output)}"| main`);
    });
    lines.push('```');
    const { start, end } = routeParts(text);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    return text.slice(0, start + START.length) + eol + lines.join(eol) + eol + text.slice(end);
}

function checkWorkflowRoutes(text) {
    if (renderWorkflowRoutes(text) !== text) throw new Error('workflow-routes: stale route diagram; run render-shared-agents.js --routes');
}

module.exports = { parseWorkflowRoutes, extractDispatchRoles, renderWorkflowRoutes, checkWorkflowRoutes };
