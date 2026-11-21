#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const MAX_TODO_BYTES = 2 * 1024 * 1024;
const STORY_ID = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const MARKER = /\[([ xX>!~*BC])\]/g;
// A checkbox marker anywhere in a command would be miscounted by status.js and metrics.js, which match one unanchored.
const MARKER_ANYWHERE = /\[[ xX>!~*BC]\]/;
// The first words ac-verify.js will run. Owned here because ac-verify requires this module, never the reverse.
const VERIFY_HEADS = ['node', 'npx', 'npm', 'git', 'pytest', 'dotnet', 'cargo', 'go'];
// Names Windows reserves as devices; a story id is a record file name (`{storyId}.json`), and `CON.json` is the console there.
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;

/** [start, end) ranges of the inline code spans in `text` (a backtick run closes at the next run of equal length). */
function codeSpanRanges(text) {
    const runs = Array.from(text.matchAll(/`+/g));
    const next = [];
    const seen = new Map();
    for (let at = runs.length - 1; at >= 0; at--) {
        next[at] = seen.get(runs[at][0].length);
        seen.set(runs[at][0].length, at);
    }
    const ranges = [];
    for (let at = 0; at < runs.length; at++) {
        const close = next[at];
        if (close === undefined) continue;
        ranges.push([runs[at].index, runs[close].index + runs[close][0].length]);
        at = close;
    }
    return ranges;
}

function withoutCodeSpans(text) {
    const pieces = [];
    let start = 0;
    for (const [from, to] of codeSpanRanges(text)) {
        pieces.push(text.slice(start, from));
        start = to;
    }
    pieces.push(text.slice(start));
    return pieces.join('');
}

/** `text` with every code-span character replaced by a space, so indexes still line up with the original. */
function maskCodeSpans(text) {
    let masked = text;
    for (const [from, to] of codeSpanRanges(text)) masked = masked.slice(0, from) + ' '.repeat(to - from) + masked.slice(to);
    return masked;
}

/**
 * A `verify` that was written in a variant form (capital `Verify:`, full-width colon, wrapped in backticks or
 * bold) and is followed by something that starts like a runnable command. Such a bullet would otherwise silently
 * become a manual criterion, which is how a binding is defanged, so it is an error instead. A bullet that merely
 * mentions the word (`the \`verify:\` line`, `**E2E verify:** seed a store`) is prose and stays manual.
 */
function variantVerify(content) {
    for (const match of content.matchAll(/(?<![\w-])verify\s*[:\uFF1A]/gi)) {
        const after = content.slice(match.index + match[0].length).replace(/^[\s*_`]+/, '');
        const word = after.match(/^[A-Za-z]+/);
        if (word && VERIFY_HEADS.includes(word[0])) {
            return { error: `verify: found "${match[0]}" written in a variant form. The only binding form is a lowercase "verify:" with an ASCII colon, outside code spans and bold, followed by the command.` };
        }
    }
    return null;
}

/**
 * The `verify: <command> [=> exit N]` binding of an acceptance-criterion bullet (a lowercase `verify:`
 * outside code spans, not glued to a word, not a bold or italic label). Returns null when the bullet has
 * none, `{ command, expectedExit }` when it parses, and `{ error }` when it is malformed or was written in
 * a variant form that would otherwise defang it silently. The command is taken from the original text, never
 * the code-span-masked copy, so it is exactly what the author wrote, and it must not contain a checkbox marker.
 */
function parseVerifyBinding(content) {
    const masked = maskCodeSpans(content);
    for (const found of masked.matchAll(/(?<![\w-])verify:/g)) {
        // `**E2E verify:** text` and `**verify:**` are bold labels in prose, not bindings.
        if (/\*$/.test(content.slice(0, found.index)) || /^[*_]/.test(content.slice(found.index + 'verify:'.length))) continue;
        const rest = content.slice(found.index + 'verify:'.length).trim();
        const parts = rest.split('=>');
        const command = parts[0].trim();
        if (!command) return { error: 'verify: needs a command before any "=> exit N".' };
        if (MARKER_ANYWHERE.test(command)) return { error: 'verify: the command must not contain a checkbox marker such as "[ ]" or "[x]".' };
        if (parts.length === 1) return { command, expectedExit: 0 };
        const code = parts.length === 2 ? parts[1].trim().match(/^exit\s+(\d{1,3})$/) : null;
        if (!code || Number(code[1]) > 255) return { error: 'verify: expects "<command> => exit N" with one N from 0 to 255 and nothing after it.' };
        return { command, expectedExit: Number(code[1]) };
    }
    return variantVerify(content);
}

/** Verify selected story completion without changing the TODO or its criteria. */
function verifyTodoCompletion(text, options = {}) {
    const result = { ok: false, stories: [], errors: [], unchecked: [] };
    const error = (code, storyId, line, message) => result.errors.push({ code, storyId, line, message });
    const storyIds = options?.storyIds;
    if (!Array.isArray(storyIds) || !storyIds.length || storyIds.length > 128
        || storyIds.some(id => typeof id !== 'string' || id.length > 64 || !STORY_ID.test(id) || WINDOWS_RESERVED.test(id.split('.')[0]))
        || new Set(storyIds.map(id => id.toLowerCase())).size !== storyIds.length) {
        // Reserved Windows device names and ids that differ only by case would share one record file on Windows.
        error('INVALID_STORY_IDS', null, null, 'Select unique, exact story IDs (no Windows device names such as CON or NUL, and no two ids that differ only by case).');
        return result;
    }
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_TODO_BYTES
        || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) {
        error('INVALID_TODO', null, null, 'TODO must be bounded UTF-8 text.');
        return result;
    }
    const selected = new Set(storyIds);
    const declarations = new Map(storyIds.map(id => [id, []]));
    const rows = new Map(storyIds.map(id => [id, []]));
    let current = null;
    let suspended = null;
    let fence = null;
    let indexPresent = false;
    let inIndex = false;
    let columns = null;
    const markers = line => Array.from(line.matchAll(MARKER), match => match[1].toLowerCase());
    const lines = text.split(/\r?\n/);
    for (let at = 0; at < lines.length; at++) {
        const line = lines[at];
        const trimmed = line.trim();
        const number = at + 1;
        const delimiter = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
        if (fence) {
            if (delimiter && delimiter[1][0] === fence.character
                && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
            continue;
        }
        if (delimiter) {
            fence = { character: delimiter[1][0], length: delimiter[1].length, line: number };
            continue;
        }
        const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
        if (heading && /^Story Index(?:\s+and\s+.+)?\s*#*$/i.test(heading[2])) {
            indexPresent = true;
            inIndex = true;
            columns = null;
            current = null;
            suspended = null;
            continue;
        }
        const header = heading
            ? heading[2].match(/^Story\s+([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)(?=\s|:|$)/i)
            : trimmed.match(/^[-*+]\s+(?:\[[ xX>!~*BC]\]\s+)?\*\*Story\s+([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)(?=\s|:|\*\*|$)/i);
        if (header) {
            inIndex = false;
            columns = null;
            current = { id: header[1], line: number, depth: heading ? heading[1].length : 0, markers: markers(trimmed), criteria: [] };
            suspended = null;
            if (selected.has(current.id)) declarations.get(current.id).push(current);
            continue;
        }
        if (heading && /^Story\s+/i.test(heading[2])) {
            current = null;
            suspended = null;
            inIndex = false;
            continue;
        }
        const criterionSection = heading ? /^(?:AC|Acceptance Criteria|Tasks|Subtasks)\b/i.test(heading[2])
            : /^(?:[-*+]\s+)?\*\*(?:AC|Acceptance Criteria|Tasks|Subtasks)\b/i.test(trimmed);
        if (suspended && criterionSection && (!heading || !suspended.depth || heading[1].length > suspended.depth)) {
            current = suspended;
            suspended = null;
        }
        const notesSection = heading ? /^(?:Validation|Notes)\b/i.test(heading[2])
            : /^(?:[-*+]\s+)?\*\*(?:Validation|Notes)\b/i.test(trimmed);
        if (heading && suspended && heading[1].length <= suspended.depth) suspended = null;
        if (heading || notesSection) {
            if (heading) inIndex = false;
            if (current && (!heading || heading[1].length <= current.depth
                || /^(?:Validation|Notes)\b/i.test(heading[2])
                || (!current.depth && !criterionSection))) {
                suspended = notesSection && (!heading || heading[1].length > current.depth) ? current : null;
                current = null;
            }
        }
        if (/^(?:---+|\*\*\*+|___+)\s*$/.test(trimmed)) { current = null; suspended = null; }
        if (inIndex && /^\|.*\|$/.test(trimmed)) {
            const cells = trimmed.slice(1, -1).split('|').map(cell => cell.trim());
            const labels = cells.map(cell => cell.replace(/[*`]/g, '').toLowerCase());
            const storyColumn = labels.findIndex(cell => cell === 'story' || cell === 'id');
            const statusColumn = labels.indexOf('status');
            if (storyColumn >= 0 && statusColumn >= 0) {
                columns = labels.filter(cell => cell === 'story' || cell === 'id').length === 1
                    && labels.filter(cell => cell === 'status').length === 1
                    ? { story: storyColumn, status: statusColumn, count: cells.length } : null;
            } else if (columns) {
                const value = (cells[columns.story] || '').replace(/[*`]/g, '');
                const id = value.match(/^(?:Story\s+)?([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)(?=\s|$)/i)?.[1];
                if (selected.has(id)) {
                    if (cells.length !== columns.count) error('UNRECOGNIZED_INDEX_ROW', id, number, 'Selected index row must match its declared table columns.');
                    rows.get(id).push({ line: number, markers: cells.length === columns.count ? markers(cells[columns.status] || '') : [] });
                }
            }
        }
        if (!current || !selected.has(current.id)) continue;
        const checkbox = line.match(/^\s*(?:[-*+]|\d+[.)])\s+\[([^\]\r\n]*)\]\s*(.*)$/);
        if (!checkbox) continue;
        const content = checkbox[2];
        if (![' ', 'x', '>', '!', '~', '?', 's', '*', 'b', 'c'].includes(checkbox[1].toLowerCase())) {
            error('UNRECOGNIZED_CRITERION_STATE', current.id, number, 'Use a recognized checklist state and verify or explicitly dispose of unfinished work.');
        }
        // A bracketed disposition is explicit; incidental words never waive work.
        const annotations = withoutCodeSpans(content).matchAll(/\[(cut|superseded|moved|not-applicable):\s*([^\]\r\n]+)\]/gi);
        const dispositions = Array.from(annotations);
        const disposition = dispositions.length === 1 ? dispositions[0] : null;
        const reason = disposition?.[2].trim();
        const criterion = { line: number, text: content, checked: checkbox[1].toLowerCase() === 'x',
            disposition: reason ? { type: disposition[1].toLowerCase(), reason } : null };
        const binding = parseVerifyBinding(content);
        if (binding?.error) error('BAD_VERIFY', current.id, number, binding.error);
        else if (binding) criterion.verify = binding;
        current.criteria.push(criterion);
        if (!criterion.checked && !criterion.disposition) result.unchecked.push({ storyId: current.id, line: number, text: content });
    }
    if (fence) error('UNCLOSED_FENCE', null, fence.line, 'Unclosed fence can conceal story criteria.');
    for (const id of storyIds) {
        const found = declarations.get(id);
        if (found.length !== 1) {
            error(found.length ? 'DUPLICATE_STORY' : 'MISSING_STORY', id, null, 'Select one recognized declaration for this exact story ID.');
            continue;
        }
        const story = found[0];
        let status = story.markers;
        if (indexPresent) {
            const indexed = rows.get(id);
            if (indexed.length !== 1) error(indexed.length ? 'DUPLICATE_INDEX_STORY' : 'MISSING_INDEX_STORY', id, null, 'Story Index must contain exactly one selected story row.');
            status = indexed.length === 1 ? indexed[0].markers : [];
        }
        if (status.length !== 1 || status[0] !== 'x') error('STORY_NOT_COMPLETE', id, story.line, 'Selected story must have one authoritative [x] marker.');
        if (!story.criteria.length) error('NO_CRITERIA', id, story.line, 'No checklist criteria were recognized; silence is not completion proof.');
        for (const item of result.unchecked.filter(item => item.storyId === id)) error('UNCHECKED_CRITERION', id, item.line, 'Verify the criterion or record an explicit disposition before completing the story.');
        result.stories.push({ id, line: story.line, marker: status.length === 1 ? status[0] : null, criteria: story.criteria });
    }
    result.ok = result.errors.length === 0;
    return result;
}

function selfTest() {
    const text = '## Story CONTROL-1 [x]\n- [ ] bounded unfinished criterion\n';
    const unfinished = verifyTodoCompletion(text, { storyIds: ['CONTROL-1'] });
    const checked = verifyTodoCompletion(text.replace('- [ ]', '- [x]'), { storyIds: ['CONTROL-1'] });
    const ok = !unfinished.ok && unfinished.unchecked.length === 1
        && unfinished.unchecked[0].storyId === 'CONTROL-1'
        && unfinished.unchecked[0].text === 'bounded unfinished criterion'
        && unfinished.errors.some(error => error.code === 'UNCHECKED_CRITERION') && checked.ok;
    return { ok, positiveControl: ok ? 'unfinished criterion detected' : 'failed', checkedControl: checked.ok ? 'passed' : 'failed' };
}

/** Read a TODO as bounded UTF-8 from an ordinary, non-symlinked file; throws on anything else. */
function readTodoFile(input) {
    const file = path.resolve(input);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TODO_BYTES) throw new Error('Invalid TODO input.');
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.size > MAX_TODO_BYTES) throw new Error('Invalid TODO input.');
        const bytes = Buffer.alloc(MAX_TODO_BYTES + 1);
        let size = 0;
        while (size < bytes.length) {
            const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
            if (!count) break;
            size += count;
        }
        if (size > MAX_TODO_BYTES) throw new Error('Invalid TODO input.');
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function main(args = process.argv.slice(2)) {
    let result;
    if (args.length === 1 && args[0] === '--self-test') result = selfTest();
    else if (args.length === 3 && args[1] === '--stories' && typeof args[0] === 'string' && !args[0].startsWith('--')) {
        try {
            const text = readTodoFile(args[0]);
            result = verifyTodoCompletion(text, { storyIds: args[2].split(',') });
        } catch {
            result = { ok: false, stories: [], errors: [{ code: 'INVALID_TODO_FILE', storyId: null, line: null, message: 'TODO must be an existing ordinary bounded file.' }], unchecked: [] };
        }
    } else result = { ok: false, stories: [], errors: [{ code: 'INVALID_ARGUMENTS', storyId: null, line: null, message: 'Usage: todo-completion.js TODO_PATH --stories ID1,ID2 | --self-test' }], unchecked: [] };
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
}

module.exports = { verifyTodoCompletion, readTodoFile, selfTest, main, MAX_TODO_BYTES, VERIFY_HEADS };
if (require.main === module) process.exitCode = main();
