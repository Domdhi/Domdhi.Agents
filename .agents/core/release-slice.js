#!/usr/bin/env node
'use strict';

// Release-slice check for a TODO's Story Index.
//
// /todo tags every story `core` or `later` and a risk tier (`deep` or
// `standard`). /run-todo runs the core slice first and stops at a ship gate
// before any `later` story; it passes --later-approved only after the owner's
// go is recorded in the run plan. This helper reads only the Story Index table,
// never edits the TODO, and reports which slice runs next.

const { readTodoFile, MAX_TODO_BYTES } = require('./todo-completion');

const STORY_ID = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const RELEASES = new Set(['core', 'later']);
const TIERS = new Set(['deep', 'standard']);
const NO_DEPENDENCY = /^(?:none|n\/a|-+|—|–)?$/i;

const clean = cell => String(cell || '').replace(/[*`_]/g, '').trim();

function splitCells(trimmed) {
    // `\|` is a literal pipe inside a cell, not a column break.
    return trimmed.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim());
}

function storyIdOf(cell) {
    return clean(cell).match(/^(?:Story\s+)?([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)(?=\s|$)/i)?.[1] || null;
}

function statusOf(cell, unmarked = 'unknown') {
    const markers = Array.from(String(cell || '').matchAll(/\[([ xX>!~])\]/g), match => match[1].toLowerCase());
    if (!markers.length) return unmarked;
    if (markers.length !== 1) return 'unknown';
    return { x: 'done', '>': 'in-progress', '!': 'blocked', '~': 'deferred', ' ': 'pending' }[markers[0]];
}

function dependenciesOf(cell) {
    const text = clean(cell);
    if (NO_DEPENDENCY.test(text)) return [];
    return text.split(/[,;]|\s+and\s+/i)
        .map(part => part.trim().replace(/^Story\s+/i, '').replace(/\s*\(.*\)$/, '').trim())
        .filter(part => part && !NO_DEPENDENCY.test(part));
}

function findIndex(lines) {
    let fence = null;
    let inIndex = false;
    let header = null;
    const rows = [];
    let indexCount = 0;
    for (let at = 0; at < lines.length; at++) {
        const trimmed = lines[at].trim();
        const delimiter = lines[at].match(/^\s*(`{3,}|~{3,})(.*)$/);
        if (fence) {
            if (delimiter && delimiter[1][0] === fence.character && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
            continue;
        }
        if (delimiter) { fence = { character: delimiter[1][0], length: delimiter[1].length }; continue; }
        const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
        if (heading) {
            inIndex = /^Story Index(?:\s+and\s+.+)?\s*#*$/i.test(heading[1]);
            if (inIndex) { indexCount++; header = null; }
            continue;
        }
        if (!inIndex || !/^\|.*\|$/.test(trimmed)) continue;
        const cells = splitCells(trimmed);
        if (cells.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
        if (!header) { header = { cells: cells.map(cell => clean(cell).toLowerCase()), line: at + 1 }; continue; }
        rows.push({ cells, line: at + 1 });
    }
    return { header, rows, indexCount, unclosedFence: Boolean(fence) };
}

// Per-epic checklists (/create:project-epics-todo) have no Story Index: each
// `## Story N.M: Title [x]` header (or `* **Story N.M (S): Title**` bullet)
// carries its own **Release:**, **Risk tier:**, **Dependencies:** lines.
function findHeaderStories(lines) {
    let fence = null;
    let current = null;
    const stories = [];
    for (let at = 0; at < lines.length; at++) {
        const trimmed = lines[at].trim();
        const delimiter = lines[at].match(/^\s*(`{3,}|~{3,})(.*)$/);
        if (fence) {
            if (delimiter && delimiter[1][0] === fence.character && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
            continue;
        }
        if (delimiter) { fence = { character: delimiter[1][0], length: delimiter[1].length }; continue; }
        const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
        const header = heading
            ? heading[2].match(/^Story\s+([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)(?=\s|:|$)/i)
            : trimmed.match(/^[-*+]\s+(?:\[[ xX>!~]\]\s+)?\*\*Story\s+([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)(?=\s|:|\*\*|$)/i);
        if (header) {
            current = { id: header[1], line: at + 1, depth: heading ? heading[1].length : 0, status: trimmed, fields: {} };
            stories.push(current);
            continue;
        }
        if (heading && current && (!current.depth || heading[1].length <= current.depth)) { current = null; continue; }
        if (!current) continue;
        const field = trimmed.match(/^(?:[-*+]\s+)?\*\*(Release|Risk tier|Tier|Dependencies|Depends on|Wave):?\*\*:?\s*(.*)$/i);
        if (field) {
            const key = field[1].toLowerCase().replace(/^risk tier$/, 'tier').replace(/^depends on$/, 'dependencies');
            if (!(key in current.fields)) current.fields[key] = { value: field[2], line: at + 1 };
        }
    }
    return { stories, unclosedFence: Boolean(fence) };
}

/** Classify a TODO's stories into core/later slices and report the next slice to run. */
function checkReleaseSlices(text, options = {}) {
    const strict = Boolean(options.strict);
    const laterApproved = Boolean(options.laterApproved);
    const result = { ok: false, source: null, legacy: false, phase: null, next: [], blocked: [], external: [], coreOpenElsewhere: [], slices: { core: [], later: [] }, stories: [], errors: [], warnings: [] };
    const error = (code, storyId, line, message) => result.errors.push({ code, storyId, line, message });
    const warn = (code, storyId, line, message) => result.warnings.push({ code, storyId, line, message });

    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_TODO_BYTES) {
        error('INVALID_TODO', null, null, 'TODO must be bounded UTF-8 text.');
        return result;
    }
    const lines = text.split(/\r?\n/);
    const { header, rows, indexCount, unclosedFence } = findIndex(lines);
    if (unclosedFence) error('UNCLOSED_FENCE', null, null, 'An unclosed fence can conceal the Story Index.');
    if (indexCount > 1) {
        error('DUPLICATE_STORY_INDEX', null, null, 'The TODO needs at most one Story Index table.');
        return result;
    }
    const seen = new Map();
    const addStory = (id, line, cells) => {
        if (!id || !STORY_ID.test(id)) { error('INVALID_STORY_ID', null, line, 'Story has no recognizable story ID.'); return; }
        if (seen.has(id)) { error('DUPLICATE_STORY', id, line, 'Each story appears once.'); return; }
        const release = cells.release === null ? 'core' : clean(cells.release).toLowerCase();
        if (!RELEASES.has(release)) error('INVALID_RELEASE', id, line, 'Release must be core or later.');
        // A tier cell may carry its trigger after the keyword: "deep — auth path".
        const tier = cells.tier === null ? null : (clean(cells.tier).toLowerCase().match(/^[a-z]+/)?.[0] || '');
        if (tier !== null && !TIERS.has(tier)) error('INVALID_TIER', id, line, 'Tier must be deep or standard.');
        // An unmarked story header is pending; a Story Index status cell must carry a marker.
        const status = statusOf(cells.status, cells.unmarked || 'unknown');
        if (status === 'unknown') error('INVALID_STATUS', id, line, 'Status needs exactly one marker: [ ], [>], [x], [!] or [~].');
        const waveText = clean(cells.wave);
        const wave = /^\d+$/.test(waveText) ? Number(waveText) : null;
        const story = { id, line, release, tier, status, wave, dependencies: dependenciesOf(cells.deps) };
        seen.set(id, story);
        result.stories.push(story);
    };

    if (header) {
        result.source = 'story-index';
        const column = name => {
            const found = header.cells.reduce((hits, cell, at) => (name.test(cell) ? hits.concat(at) : hits), []);
            if (found.length > 1) error('AMBIGUOUS_COLUMN', null, header.line, `Story Index has more than one ${name.source} column.`);
            return found.length === 1 ? found[0] : -1;
        };
        const columns = {
            story: column(/^(?:story|id)$/),
            release: column(/^release$/),
            tier: column(/^(?:risk\s+)?tier$/),
            status: column(/^status$/),
            wave: column(/^wave$/),
            deps: column(/^(?:dependencies|depends on|deps)$/),
        };
        if (columns.story < 0 || columns.status < 0) {
            error('MISSING_COLUMN', null, header.line, 'Story Index needs one Story and one Status column.');
            return result;
        }
        if (columns.release < 0) {
            result.legacy = true;
            (strict ? error : warn)('MISSING_RELEASE_COLUMN', null, header.line, 'No Release column: every story is treated as core (one slice). New TODOs must tag core | later.');
        }
        if (columns.tier < 0) (strict ? error : warn)('MISSING_TIER_COLUMN', null, header.line, 'No Tier column: assign each story deep | standard at planning time.');
        const cell = (cells, at) => (at < 0 ? null : cells[at]);
        for (const row of rows) {
            if (row.cells.length !== header.cells.length) {
                error('UNRECOGNIZED_INDEX_ROW', null, row.line, 'Story Index row must match its header columns.');
                continue;
            }
            addStory(storyIdOf(row.cells[columns.story]), row.line, {
                release: cell(row.cells, columns.release), tier: cell(row.cells, columns.tier), status: row.cells[columns.status],
                wave: cell(row.cells, columns.wave) || '', deps: cell(row.cells, columns.deps) || '',
            });
        }
    } else {
        result.source = 'story-headers';
        const { stories } = findHeaderStories(lines);
        if (!stories.length) {
            error('MISSING_STORY_INDEX', null, null, 'No Story Index table and no story headers were found.');
            return result;
        }
        const missing = key => stories.some(story => !(key in story.fields));
        if (missing('release')) {
            result.legacy = true;
            (strict ? error : warn)('MISSING_RELEASE_COLUMN', null, null, 'A story has no **Release:** line: untagged stories are treated as core. New TODOs must tag core | later.');
        }
        if (missing('tier')) (strict ? error : warn)('MISSING_TIER_COLUMN', null, null, 'A story has no **Risk tier:** line: assign deep | standard at planning time.');
        for (const story of stories) {
            const value = key => (key in story.fields ? story.fields[key].value : null);
            addStory(story.id, story.line, {
                release: value('release'), tier: value('tier'), status: story.status, unmarked: 'pending',
                wave: value('wave') || '', deps: value('dependencies') || '',
            });
        }
    }
    if (!result.stories.length) error('EMPTY_STORY_INDEX', null, header?.line ?? null, 'The TODO lists no stories.');

    const external = options.external instanceof Map ? options.external : new Map();
    const blocked = new Set();
    for (const story of result.stories) {
        if (RELEASES.has(story.release)) result.slices[story.release].push(story.id);
        for (const dep of story.dependencies) {
            const local = seen.get(dep);
            const target = local || external.get(dep);
            if (!target) {
                error('UNKNOWN_DEPENDENCY', story.id, story.line, `Dependency ${dep} is in neither this TODO nor a --deps-from TODO.`);
                continue;
            }
            if (!local) {
                result.external.push({ storyId: story.id, dependency: dep, file: target.file, status: target.status });
                if (target.status !== 'done' && story.status !== 'done') {
                    blocked.add(story.id);
                    warn('EXTERNAL_DEPENDENCY_OPEN', story.id, story.line, `Waits on ${dep} in ${target.file}, which is not done.`);
                }
            }
            if (story.release === 'core' && target.release === 'later') {
                error('CORE_DEPENDS_ON_LATER', story.id, story.line, `Core story depends on later story ${dep}; the core slice must ship on its own.`);
            }
        }
        if (story.status === 'deferred' && story.release === 'core') warn('CORE_STORY_DEFERRED', story.id, story.line, 'A deferred core story leaves the core slice; record why in the plan.');
    }
    // The release slice spans the whole feature: every --deps-from TODO joins the union,
    // so an all-later epic file is valid when core stories live in a sibling file.
    const elsewhere = [...external.values()].filter(story => !seen.has(story.id));
    const unionHasCore = result.slices.core.length > 0 || elsewhere.some(story => story.release === 'core');
    if (result.stories.length && !unionHasCore) error('NO_CORE_SLICE', null, header?.line ?? null, 'Mark the stories that ship first as core, in this TODO or a --deps-from TODO.');

    const coreWaves = result.stories.filter(s => s.release === 'core' && s.wave !== null).map(s => s.wave);
    const laterWaves = result.stories.filter(s => s.release === 'later' && s.wave !== null).map(s => s.wave);
    if (coreWaves.length && laterWaves.length && Math.max(...coreWaves) >= Math.min(...laterWaves)) {
        error('LATER_WAVE_BEFORE_CORE_END', null, header?.line ?? null, 'Every core wave must finish before the first later wave; no wave mixes core and later stories.');
    }

    result.blocked = [...blocked];
    const open = release => result.stories.filter(s => s.release === release && s.status !== 'done' && s.status !== 'deferred').map(s => s.id);
    const ready = ids => ids.filter(id => !blocked.has(id));
    const coreOpen = open('core');
    const laterOpen = open('later');
    result.coreOpenElsewhere = elsewhere
        .filter(story => story.release === 'core' && story.status !== 'done' && story.status !== 'deferred')
        .map(story => ({ id: story.id, file: story.file }));
    if (coreOpen.length || result.coreOpenElsewhere.length) { result.phase = 'core'; result.next = ready(coreOpen); }
    else if (laterOpen.length && !laterApproved) { result.phase = 'ship-gate'; result.next = []; }
    else if (laterOpen.length) { result.phase = 'later'; result.next = ready(laterOpen); }
    else result.phase = 'complete';

    result.ok = result.errors.length === 0;
    return result;
}

// --deps-from names every sibling TODO of the feature: it resolves cross-file
// dependencies and makes the core slice and the ship gate feature-wide.
const USAGE = 'Usage: release-slice.js TODO_PATH [--strict] [--later-approved] [--deps-from SIBLING_TODO]...';

function main(args = process.argv.slice(2)) {
    const fail = (code, message) => ({ ok: false, errors: [{ code, storyId: null, line: null, message }] });
    let result;
    const flags = new Set();
    const depsFrom = [];
    let valid = args.length > 0 && !args[0].startsWith('--');
    for (let at = 1; valid && at < args.length; at++) {
        const arg = args[at];
        if ((arg === '--strict' || arg === '--later-approved') && !flags.has(arg)) flags.add(arg);
        else if (arg === '--deps-from' && args[at + 1] && !args[at + 1].startsWith('--') && depsFrom.length < 64) depsFrom.push(args[++at]);
        else valid = false;
    }
    if (!valid) result = fail('INVALID_ARGUMENTS', USAGE);
    else {
        try {
            const external = new Map();
            for (const other of depsFrom) {
                const parsed = checkReleaseSlices(readTodoFile(other));
                for (const story of parsed.stories) if (!external.has(story.id)) external.set(story.id, { ...story, file: other });
            }
            result = checkReleaseSlices(readTodoFile(args[0]), { strict: flags.has('--strict'), laterApproved: flags.has('--later-approved'), external });
        } catch {
            result = fail('INVALID_TODO_FILE', 'Every TODO must be an existing ordinary bounded file.');
        }
    }
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
}

module.exports = { checkReleaseSlices, main };
if (require.main === module) process.exitCode = main();
