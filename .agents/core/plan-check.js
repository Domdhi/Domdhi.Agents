#!/usr/bin/env node
'use strict';

// Deterministic plan validation for a TODO: dependency order and cycles, Story Index / body
// parity, same-wave file collisions, forward outputs, agent budgets, and the derived waves,
// ready set, isolation groups and critical path.
//
// Stories, dependencies, waves, status, release and tier come from release-slice.js
// (checkReleaseSlices) and its story-header scanner; this helper adds only what they lack:
// the Files, After and Agent budget fields, and the graph arithmetic. It never edits a TODO.
//
// Two wave views. `waves` layers EVERY story (done, blocked and later included) and is the dependency graph, with
// later-release stories only in layers after every core story's. `openWaves` layers only what a run dispatches now:
// the open stories of the slice release-slice.js reports as the current `phase` (core, or later once approved; with
// --later-approved during the core phase, the open later stories follow as trailing layers), minus `[!]` blocked
// stories and minus any story that waits on a dependency that is neither done nor in that set, an unfinished
// sibling-TODO dependency included (`waiting`).
// `--waves --open` prints it and narrows `--ready` the same way.
//
// Collisions and isolation. A declared wave (the Story Index Wave column) is the author's commitment: two stories of
// one declared wave that write the same file are a WAVE_COLLISION error, unless the TODO lists that file under Shared
// Hotspot Files. A listed hotspot, and any overlap in a derived wave (a story with no declared wave, an `openWaves`
// layer), is a WAVE_COLLISION warning instead (never escalated by --strict, because worktree isolation is the
// supported way to run overlapping writers) and the group appears in `isolate`.
// `--overlap IDS` answers the same question for an exact set of stories, so a run that merged or split waves asks
// about the wave it really dispatches.

const { readTodoFile } = require('./todo-completion');
const { checkReleaseSlices, findHeaderStories, dependenciesOf, INLINE_FIELD } = require('./release-slice');

const MAX_MODIFIED = 5;
const MAX_CREATED = 2;
const USAGE = 'Usage: plan-check.js TODO_PATH [--strict] [--deps-from SIBLING_TODO]... [--ready] [--waves [--open] [--later-approved]] [--overlap ID,ID,...]';
// INLINE_FIELD (release-slice.js) splits a field written after another on one line: `**Files:** a, b · **Agent budget:** 2 modified`.
// Release-slice errors that mean the index was not read, so a body-vs-index comparison is meaningless.
const PARITY_BLOCKERS = new Set(['INVALID_TODO', 'DUPLICATE_STORY_INDEX', 'MISSING_COLUMN', 'EMPTY_STORY_INDEX', 'UNCLOSED_FENCE']);

// `.claude/` and `.codex/` are generated projections of `.agents/` for these three trees.
function normalizePath(raw) {
    return String(raw).trim().replace(/^\.\//, '').replace(/^\.(?:claude|codex)\/(core|hooks|templates)\//, '.agents/$1/');
}

// Lines outside code fences, with the same fence rule release-slice uses.
function unfencedLines(lines) {
    const kept = [];
    let fence = null;
    for (let at = 0; at < lines.length; at++) {
        const delimiter = lines[at].match(/^\s*(`{3,}|~{3,})(.*)$/);
        if (fence) {
            if (delimiter && delimiter[1][0] === fence.character && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
            continue;
        }
        if (delimiter) { fence = { character: delimiter[1][0], length: delimiter[1].length }; continue; }
        kept.push({ at, text: lines[at] });
    }
    return kept;
}

// `## Story Index` looks like a story header whose id is "Index"; it is the table's heading.
const isIndexHeading = header => /^#{1,6}\s+Story\s+Index\b/i.test(header.status);

// A heading such as `## Story Format` also matches the story-header scanner (id "Format"); a real story body has a
// digit in its id or carries at least one story field.
const isProseHeading = header => header.depth > 0 && !/\d/.test(header.id) && Object.keys(header.fields).length === 0;

function bodyStories(lines) {
    return findHeaderStories(lines).stories.filter(header => !isIndexHeading(header) && !isProseHeading(header));
}

function splitInline(value) {
    const parts = String(value || '').split(INLINE_FIELD);
    const extras = new Map();
    for (const part of parts.slice(1)) {
        const match = part.match(/^\*\*([A-Za-z][A-Za-z ]*?):?\*\*:?\s*(.*)$/);
        if (match) extras.set(match[1].toLowerCase(), match[2]);
    }
    return { head: parts[0].trim(), extras };
}

// Split on commas that sit outside backticks and parentheses.
function splitTopLevel(text) {
    const entries = [];
    let depth = 0;
    let ticks = false;
    let start = 0;
    for (let at = 0; at < text.length; at++) {
        const ch = text[at];
        if (ch === '`') ticks = !ticks;
        else if (!ticks && ch === '(') depth++;
        else if (!ticks && ch === ')') depth = Math.max(0, depth - 1);
        else if (!ticks && depth === 0 && ch === ',') { entries.push(text.slice(start, at)); start = at + 1; }
    }
    entries.push(text.slice(start));
    return entries.map(entry => entry.trim()).filter(Boolean);
}

// Backtick spans at parenthesis depth 0 (prose parentheses such as "(used by `/x`)" are not paths).
function topLevelSpans(text) {
    const spans = [];
    let depth = 0;
    for (let at = 0; at < text.length; at++) {
        const ch = text[at];
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === '`') {
            const close = text.indexOf('`', at + 1);
            if (close < 0) break;
            if (depth === 0) spans.push({ text: text.slice(at + 1, close), start: at, end: close + 1 });
            at = close;
        }
    }
    return spans.filter(span => span.text && !/\s/.test(span.text));
}

// Split a Files entry at its first descriptor separator outside backticks and parentheses: ` - `, an em or en dash,
// or a colon. What follows describes the paths ("adds `parse()` and `run()`"), so its code spans are prose, not paths.
function cutDescriptor(text) {
    let depth = 0;
    let ticks = false;
    for (let at = 0; at < text.length; at++) {
        const ch = text[at];
        if (ch === '`') { ticks = !ticks; continue; }
        if (ticks) continue;
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (depth === 0) {
            const before = text[at - 1];
            const after = text[at + 1];
            const spaceAfter = after === undefined || /\s/.test(after);
            const dash = ch === '\u2014' || ch === '\u2013' || (ch === '-' && at > 0 && /[\s`)]/.test(before) && spaceAfter);
            if (dash || (ch === ':' && spaceAfter)) return { head: text.slice(0, at).trim(), tail: text.slice(at + 1).trim() };
        }
    }
    return { head: text.trim(), tail: null };
}

// One comma-separated Files entry: {paths: [{path, created}], exact}. Exact is a bare path with at most a (new) marker.
function parseInlineEntry(entry) {
    const exact = entry.match(/^(new\s+)?`([^`\s]+)`(?:\s*\((new)\))?$/i);
    if (exact) return { paths: [{ path: normalizePath(exact[2]), created: Boolean(exact[1] || exact[3]) }], exact: true };
    const paths = topLevelSpans(entry).map(span => ({
        path: normalizePath(span.text),
        created: /(?:^|[\s,])new\s*$/i.test(entry.slice(0, span.start)) || /^\s*\(new\)/i.test(entry.slice(span.end)),
    }));
    return { paths, exact: false };
}

// One block bullet: one or more comma-separated paths plus an optional ` - description`; the paths are created when
// the description starts with "new". The description is prose: it may name code spans, none of them are paths.
function parseBulletEntry(text) {
    const { head, tail } = cutDescriptor(text);
    // Same leading-backtick rule as epic-overlap's file entries: a bullet that opens with prose names no path.
    if (!/^(?:new\s+)?`/i.test(head)) return { paths: [], exact: false };
    const entries = splitTopLevel(head).map(parseInlineEntry);
    const created = tail !== null && /^new\b/i.test(tail);
    const paths = entries.flatMap(entry => entry.paths.map(file => ({ path: file.path, created: file.created || created })));
    return { paths, exact: entries.length > 0 && entries.every(entry => entry.exact) };
}

function blockBullets(lines, fieldAt, end) {
    const fieldLine = lines[fieldAt];
    const indent = fieldLine.match(/^\s*/)[0].length;
    const minIndent = /^\s*[-*+]\s/.test(fieldLine) ? indent + 1 : indent;
    const bullets = [];
    for (let at = fieldAt + 1; at < end; at++) {
        const text = lines[at];
        if (!text.trim()) continue;
        const bullet = text.match(/^(\s*)[-*+]\s+(.*)$/);
        if (bullet && bullet[1].length >= minIndent && !/^\*\*[^*]+:\*\*/.test(bullet[2])) { bullets.push(bullet[2]); continue; }
        if (!bullet && text.match(/^\s*/)[0].length > indent) continue; // wrapped description line
        break;
    }
    return bullets;
}

// {files: [{path, created}], exact} for a Files field; the inline text and any nested bullets both count.
function parseFiles(lines, field, end, head) {
    const found = new Map();
    let exact = true;
    const take = entry => {
        if (!entry.exact) exact = false;
        for (const file of entry.paths) {
            const prior = found.get(file.path);
            if (prior) prior.created = prior.created || file.created;
            else found.set(file.path, { path: file.path, created: file.created });
        }
    };
    const inline = cutDescriptor(head);
    for (const entry of splitTopLevel(inline.head)) take(parseInlineEntry(entry));
    if (inline.tail !== null) exact = false; // an inline description is prose, so the list is not a pure path list
    for (const bullet of blockBullets(lines, field.line - 1, end)) take(parseBulletEntry(bullet));
    return { files: [...found.values()], exact };
}

// `4 modified, 2 created`, `<=3 modified`, `0 modified, 1 created (prose)`: counts with an optional upper bound.
function parseBudget(text) {
    const count = word => {
        const match = String(text || '').match(new RegExp(`(≤|<=)?\\s*(\\d+)\\s+${word}\\b`, 'i'));
        return match ? { n: Number(match[2]), bound: Boolean(match[1]) } : null;
    };
    const modified = count('modified');
    const created = count('created');
    if (!modified && !created) return null;
    return { modified: modified || { n: 0, bound: false }, created: created || { n: 0, bound: false } };
}

// Paths listed (backticked) in bullets under `### Shared Hotspot Files`, until the next heading.
function hotspotPaths(lines) {
    const acknowledged = new Set();
    let inSection = false;
    let inBullet = false;
    for (const { text } of unfencedLines(lines)) {
        const heading = text.trim().match(/^#{1,6}\s+(.+?)\s*#*$/);
        if (heading) { inSection = /^Shared Hotspot Files\b/i.test(heading[1]); inBullet = false; continue; }
        if (!inSection) continue;
        if (/^\s*[-*+]\s/.test(text)) inBullet = true;
        else if (text.trim() && !/^\s/.test(text)) inBullet = false;
        if (!inBullet) continue;
        for (const match of text.matchAll(/`([^`\s]+)`/g)) acknowledged.add(normalizePath(match[1]));
    }
    return acknowledged;
}

function enrichStory(story, body, lines) {
    const own = key => {
        const field = body && body.fields[key];
        return field && field.line - 1 < body.end ? field : null;
    };
    const extras = new Map();
    if (body) {
        for (const field of Object.values(body.fields)) {
            if (field.line - 1 >= body.end) continue;
            for (const [name, value] of splitInline(field.value).extras) if (!extras.has(name)) extras.set(name, value);
        }
    }
    // After is its own line, or written after another field on one line (`**Dependencies:** None · **After:** F-1.1`).
    const afterField = own('after');
    const afterText = afterField ? splitInline(afterField.value).head : (extras.get('after') || '');
    const after = afterText ? dependenciesOf(afterText) : [];
    const filesField = own('files');
    const parsed = filesField ? parseFiles(lines, filesField, body.end, splitInline(filesField.value).head) : { files: [], exact: true };
    const budgetField = own('agent budget');
    const budgetText = budgetField ? splitInline(budgetField.value).head : (extras.get('agent budget') || null);
    return {
        story: { ...story, after, files: parsed.files, filesResolved: parsed.files.length > 0, hasFiles: Boolean(filesField), filesExact: parsed.exact },
        meta: { hasFiles: Boolean(filesField), exact: parsed.exact, budget: parseBudget(budgetText) },
    };
}

// Layers by longest hard-dependency chain (Kahn); anything left sits on, or behind, a cycle.
function layerStories(stories, localDeps) {
    const layerOf = new Map();
    const layers = [];
    // A later-release story runs only after the ship gate, so it never shares a layer with a core story: it becomes
    // eligible once every other story is placed (first adopter run, 2026-11-20).
    const isLater = new Set(stories.filter(story => story.release === 'later').map(story => story.id));
    let remaining = stories.map(story => story.id);
    while (remaining.length) {
        const coreLeft = remaining.some(id => !isLater.has(id));
        const layer = remaining.filter(id => (!coreLeft || !isLater.has(id)) && localDeps.get(id).every(dep => layerOf.has(dep)));
        if (!layer.length) break;
        for (const id of layer) layerOf.set(id, layers.length);
        layers.push(layer);
        remaining = remaining.filter(id => !layerOf.has(id));
    }
    return { layers, layerOf, leftover: remaining };
}

// Cycles among the stories Kahn could not place (iterative DFS; each back edge is one cycle).
function findCycles(leftover, localDeps) {
    const members = new Set(leftover);
    const state = new Map();
    const cycles = [];
    for (const root of leftover) {
        if (state.has(root)) continue;
        const stack = [{ id: root, next: 0 }];
        const path = [root];
        state.set(root, 1);
        while (stack.length) {
            const top = stack[stack.length - 1];
            const deps = localDeps.get(top.id);
            if (top.next < deps.length) {
                const dep = deps[top.next++];
                if (!members.has(dep)) continue;
                if (state.get(dep) === 1) cycles.push(path.slice(path.indexOf(dep)).concat(dep));
                else if (!state.has(dep)) { state.set(dep, 1); stack.push({ id: dep, next: 0 }); path.push(dep); }
            } else {
                state.set(top.id, 2);
                stack.pop();
                path.pop();
            }
        }
    }
    return cycles;
}

function criticalPathOf(layers, layerOf, localDeps) {
    if (!layers.length) return [];
    let current = layers[layers.length - 1][0];
    const chain = [current];
    // Follow the deepest dependency. A layer held back by the core-before-later rule (layerStories) need not have a
    // dependency in the layer just before it, so the walk stops when a story has none.
    for (;;) {
        const deps = localDeps.get(current).filter(dep => layerOf.has(dep));
        if (!deps.length) break;
        current = deps.reduce((deepest, dep) => (layerOf.get(dep) > layerOf.get(deepest) ? dep : deepest));
        chain.push(current);
    }
    return chain.reverse();
}

// Document order, except that a ready story waits for a ready story it names in `After` (a tiebreak only).
function orderReady(ready, afterOf) {
    const rank = new Map(ready.map((id, at) => [id, at]));
    const pending = new Map(ready.map(id => [id, afterOf.get(id).filter(dep => rank.has(dep) && dep !== id)]));
    const ordered = [];
    while (pending.size) {
        const free = [...pending.keys()].filter(id => pending.get(id).every(dep => !pending.has(dep)));
        const pick = (free.length ? free : [...pending.keys()]).reduce((best, id) => (rank.get(id) < rank.get(best) ? id : best));
        ordered.push(pick);
        pending.delete(pick);
    }
    return ordered;
}

// The paths that more than one of `inWave` writes, and the connected groups of stories those paths link
// (stories linked by any shared path form one isolation group). Pure: no wave bookkeeping.
function collisionsOf(inWave) {
    const writers = new Map();
    for (const story of inWave) {
        for (const file of story.files) {
            if (!writers.has(file.path)) writers.set(file.path, []);
            writers.get(file.path).push(story.id);
        }
    }
    const colliding = [...writers].filter(([, ids]) => ids.length > 1);
    const parent = new Map(inWave.map(story => [story.id, story.id]));
    const root = id => { let at = id; while (parent.get(at) !== at) at = parent.get(at); return at; };
    for (const [, ids] of colliding) for (const id of ids.slice(1)) parent.set(root(id), root(ids[0]));
    const groups = new Map();
    for (const story of inWave) {
        const owned = colliding.filter(([, ids]) => ids.includes(story.id));
        if (!owned.length) continue;
        const key = root(story.id);
        if (!groups.has(key)) groups.set(key, { stories: [], paths: [] });
        const group = groups.get(key);
        group.stories.push(story.id);
        for (const [file] of owned) if (!group.paths.includes(file)) group.paths.push(file);
    }
    return { colliding, groups: [...groups.values()] };
}

/** Validate a TODO's plan and derive its waves, ready set, isolation groups and critical path. */
function checkPlan(todoText, options = {}) {
    const strict = Boolean(options.strict);
    const external = options.external instanceof Map ? options.external : new Map();
    const base = checkReleaseSlices(todoText, { strict, external, laterApproved: Boolean(options.laterApproved) });
    const result = { ok: false, source: base.source, errors: base.errors.slice(), warnings: base.warnings.slice(), stories: [], waves: [], openWaves: [], waiting: [], ready: [], isolate: [], criticalPath: [] };
    const finish = () => { result.ok = result.errors.length === 0; return result; };
    if (typeof todoText !== 'string' || !base.source) return finish();

    const error = (code, storyId, line, message) => result.errors.push({ code, storyId, line, message });
    const warn = (code, storyId, line, message) => (strict ? result.errors : result.warnings).push({ code, storyId, line, message });

    const lines = todoText.split(/\r?\n/);
    const bodies = bodyStories(lines);
    const bodyById = new Map();
    for (const body of bodies) if (!bodyById.has(body.id)) bodyById.set(body.id, body);

    const meta = new Map();
    result.stories = base.stories.map(story => {
        const enriched = enrichStory(story, bodyById.get(story.id), lines);
        meta.set(story.id, enriched.meta);
        return enriched.story;
    });
    const byId = new Map(result.stories.map(story => [story.id, story]));

    // PARITY: the Story Index and the story bodies are two sources that must name the same stories.
    if (base.source === 'story-index' && !base.errors.some(finding => PARITY_BLOCKERS.has(finding.code))) {
        for (const story of result.stories) {
            if (!bodyById.has(story.id)) error('PARITY', story.id, story.line, `Story ${story.id} is in the Story Index but has no story body.`);
        }
        for (const body of bodies) {
            if (!byId.has(body.id)) error('PARITY', body.id, body.line, `Story ${body.id} has a story body but no Story Index row.`);
            else if (bodyById.get(body.id) !== body) error('DUPLICATE_STORY', body.id, body.line, `Story ${body.id} has a second story body; only the first is read, so the second would be neither validated nor checkpointed.`);
        }
    }

    // Hard-dependency graph over local stories; external and unknown dependencies are not graph edges.
    const localDeps = new Map(result.stories.map(story => [story.id, story.dependencies.filter(dep => byId.has(dep))]));
    for (const story of result.stories) {
        for (const dep of localDeps.get(story.id)) {
            const need = byId.get(dep);
            if (story.wave !== null && need.wave !== null && need.wave >= story.wave) {
                error('DEP_ORDER', story.id, story.line, `${story.id} (wave ${story.wave}) needs ${dep} (wave ${need.wave}), which is not in a strictly earlier wave.`);
            }
        }
    }
    const { layers, layerOf, leftover } = layerStories(result.stories, localDeps);
    for (const cycle of findCycles(leftover, localDeps)) {
        error('DEP_CYCLE', cycle[0], byId.get(cycle[0]).line, `Dependency cycle: ${cycle.join(' -> ')}.`);
    }
    result.waves = layers;
    result.criticalPath = criticalPathOf(layers, layerOf, localDeps);

    // Open waves: what a run dispatches now (see the header). Ready, below, uses the same isDone.
    const isDone = dep => (byId.has(dep) ? byId.get(dep).status === 'done' : (external.get(dep) || {}).status === 'done');
    const sliceRelease = base.phase === 'core' ? 'core' : base.phase === 'later' ? 'later' : null;
    // With the later slice approved, a run continues past the ship gate, so its open later stories follow the core
    // layers (layerStories keeps them after every core story).
    const inSlice = story => story.release === sliceRelease || (Boolean(options.laterApproved) && sliceRelease === 'core' && story.release === 'later');
    const openIds = new Set(result.stories
        .filter(story => inSlice(story) && story.status !== 'done' && story.status !== 'deferred' && story.status !== 'blocked')
        .map(story => story.id));
    for (let changed = true; changed;) {
        changed = false;
        for (const story of result.stories) {
            if (!openIds.has(story.id)) continue;
            const missing = story.dependencies.find(dep => !isDone(dep) && !openIds.has(dep));
            if (missing === undefined) continue;
            openIds.delete(story.id);
            result.waiting.push({ id: story.id, on: missing });
            changed = true;
        }
    }
    const openStories = result.stories.filter(story => openIds.has(story.id));
    const openDeps = new Map(openStories.map(story => [story.id, story.dependencies.filter(dep => openIds.has(dep))]));
    const openLayering = layerStories(openStories, openDeps);
    result.openWaves = openLayering.layers;

    // Files: unresolved, budgets, same-wave collisions and forward outputs.
    for (const story of result.stories) {
        const info = meta.get(story.id);
        if (info.hasFiles && !story.filesResolved) warn('FILES_UNRESOLVED', story.id, story.line, `Story ${story.id} lists Files but none resolves to a path.`);
        const modified = story.files.filter(file => !file.created).length;
        const created = story.files.length - modified;
        if (modified > MAX_MODIFIED) error('BUDGET', story.id, story.line, `Story ${story.id} modifies ${modified} files; the cap is ${MAX_MODIFIED}.`);
        if (created > MAX_CREATED) error('BUDGET', story.id, story.line, `Story ${story.id} creates ${created} files; the cap is ${MAX_CREATED}.`);
        if (info.budget && info.exact && story.filesResolved) {
            const agrees = (claim, actual) => (claim.bound ? actual <= claim.n : actual === claim.n);
            if (!agrees(info.budget.modified, modified) || !agrees(info.budget.created, created)) {
                const claimed = claim => `${claim.bound ? '<=' : ''}${claim.n}`;
                error('BUDGET', story.id, story.line, `Story ${story.id} Agent budget says ${claimed(info.budget.modified)} modified, ${claimed(info.budget.created)} created; the Files list has ${modified} modified, ${created} created.`);
            }
        }
    }

    const acknowledged = hotspotPaths(lines);
    const waveIds = [...new Set(result.stories.filter(story => story.wave !== null).map(story => story.wave))].sort((a, b) => a - b);
    // One wave's collisions: the stories that write a path another story of the same wave writes, and the connected
    // isolation groups they form. A derived wave (no declared wave) only warns: isolation is its remedy.
    const collide = (inWave, wave, derived) => {
        const { colliding, groups } = collisionsOf(inWave);
        for (const [file, ids] of colliding) {
            const named = ids.length === 2 ? `${ids[0]} and ${ids[1]}` : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
            const first = byId.get(ids[0]);
            if (derived) {
                result.warnings.push({ code: 'WAVE_COLLISION', storyId: first.id, line: first.line, message: `Derived wave ${wave}: ${named} all write ${file}; run them in separate worktrees (run-todo Step 3, Worktree isolation) or serialize them.` });
                continue;
            }
            // A file the TODO lists under Shared Hotspot Files is a planned shared writer: like a derived wave, the remedy
            // is worktree isolation, so it warns (never escalated by --strict) and its group is in `isolate`.
            if (acknowledged.has(file)) {
                result.warnings.push({ code: 'WAVE_COLLISION', storyId: first.id, line: first.line, message: `Wave ${wave}: ${named} all write ${file}, a listed shared hotspot; run them in separate worktrees (run-todo Step 3, Worktree isolation) or serialize them.` });
            } else error('WAVE_COLLISION', first.id, first.line, `Wave ${wave}: ${named} all write ${file}; serialize them, move one to another wave, or list the file under Shared Hotspot Files to run them in separate worktrees.`);
        }
        result.isolate.push(...groups.map(group => (derived ? { wave, derived: true, ...group } : { wave, ...group })));
    };
    for (const wave of waveIds) collide(result.stories.filter(story => story.wave === wave), wave, false);
    openLayering.layers.forEach((layer, at) => {
        const undeclared = layer.map(id => byId.get(id)).filter(story => story.wave === null);
        if (undeclared.length > 1) collide(undeclared, at + 1, true);
    });

    const creators = new Map();
    for (const story of result.stories) for (const file of story.files) if (file.created && !creators.has(file.path)) creators.set(file.path, story);
    for (const story of result.stories) {
        for (const file of story.files) {
            const creator = creators.get(file.path);
            if (file.created || !creator || creator.id === story.id || story.wave === null || creator.wave === null) continue;
            if (story.wave <= creator.wave) {
                error('FORWARD_OUTPUT', story.id, story.line, `${story.id} (wave ${story.wave}) modifies ${file.path}, which ${creator.id} creates in wave ${creator.wave}; the modifier must be in a later wave.`);
            }
        }
    }

    // Ready: open stories whose hard dependencies are all done (After is ordering only). A blocked `[!]` story is
    // skipped and reported at the end of a run (run-todo workflow), so it is never dispatchable.
    const ready = result.stories
        .filter(story => story.status !== 'done' && story.status !== 'deferred' && story.status !== 'blocked' && story.dependencies.every(isDone))
        .map(story => story.id);
    result.ready = orderReady(ready, new Map(result.stories.map(story => [story.id, story.after])));
    return finish();
}

/** The story's body block (header line up to the next story, closing heading or rule), normalized; null if unknown. */
function storyBlock(todoText, id) {
    if (typeof todoText !== 'string') return null;
    const lines = todoText.split(/\r?\n/);
    const body = bodyStories(lines).find(header => header.id === id);
    if (!body) return null;
    const block = lines.slice(body.line - 1, body.end).map(line => line.replace(/\s+$/, ''));
    while (block.length && !block[0]) block.shift();
    while (block.length && !block[block.length - 1]) block.pop();
    return block.join('\n');
}

/**
 * The Files a story declares, for callers that must act on the exact paths (the tamper baseline, the story checkpoint).
 * Every real Files shape resolves: an inline comma list with `(new)` markers, inline text with a trailing description,
 * a `new` prefix, and block bullets holding one path or several comma-separated paths with an optional description.
 *
 * @returns {null | {files: {path: string, created: boolean}[], filesResolved: boolean, hasFiles: boolean, filesExact: boolean}}
 *   null for an unknown id. `filesResolved` is true when at least one path was found; `hasFiles` says a Files field
 *   exists; `filesExact` is false when some entry was prose that may hide a path the parser could not read (for
 *   example "its test"), so the list must not be treated as complete.
 */
function storyFiles(todoText, id) {
    if (typeof todoText !== 'string' || typeof id !== 'string' || !id) return null;
    const known = checkPlan(todoText).stories.find(story => story.id === id);
    let story = known;
    if (!story) {
        const lines = todoText.split(/\r?\n/);
        const body = bodyStories(lines).find(header => header.id === id);
        if (!body) return null;
        story = enrichStory({ id }, body, lines).story;
    }
    return { files: story.files.map(file => ({ path: file.path, created: file.created })), filesResolved: story.filesResolved, hasFiles: story.hasFiles, filesExact: story.filesExact };
}

function main(args = process.argv.slice(2)) {
    const fail = (code, message) => ({ ok: false, errors: [{ code, storyId: null, line: null, message }] });
    const flags = new Set();
    const depsFrom = [];
    let overlap = null;
    let valid = args.length > 0 && !args[0].startsWith('--');
    for (let at = 1; valid && at < args.length; at++) {
        const arg = args[at];
        if ((arg === '--strict' || arg === '--ready' || arg === '--waves' || arg === '--open' || arg === '--later-approved') && !flags.has(arg)) flags.add(arg);
        else if (arg === '--deps-from' && args[at + 1] && !args[at + 1].startsWith('--') && depsFrom.length < 64) depsFrom.push(args[++at]);
        else if (arg === '--overlap' && overlap === null && args[at + 1] && !args[at + 1].startsWith('--')) overlap = args[++at].split(',').map(id => id.trim());
        else valid = false;
    }
    // --open and --later-approved shape the waves view; --overlap answers about an exact story set and stands alone.
    if (valid && (flags.has('--open') || flags.has('--later-approved')) && !flags.has('--waves')) valid = false;
    if (valid && overlap !== null && (flags.has('--waves') || flags.has('--ready') || overlap.some(id => !id))) valid = false;
    if (!valid) {
        console.log(JSON.stringify(fail('INVALID_ARGUMENTS', USAGE), null, 2));
        return 2;
    }
    let result;
    let text;
    const external = new Map();
    try {
        for (const other of depsFrom) {
            for (const story of checkReleaseSlices(readTodoFile(other)).stories) if (!external.has(story.id)) external.set(story.id, { ...story, file: other });
        }
        text = readTodoFile(args[0]);
    } catch {
        console.log(JSON.stringify(fail('INVALID_TODO_FILE', 'Every TODO must be an existing ordinary bounded file.'), null, 2));
        return 1;
    }
    try {
        result = checkPlan(text, { strict: flags.has('--strict'), external, laterApproved: flags.has('--later-approved') });
    } catch (err) {
        console.log(JSON.stringify(fail('PLAN_CHECK_FAILED', `plan-check could not analyse the TODO: ${err && err.message}`), null, 2));
        return 1;
    }
    if (overlap !== null) {
        const known = new Map(result.stories.map(story => [story.id, story]));
        const unknown = overlap.filter(id => !known.has(id));
        if (unknown.length) {
            console.log(JSON.stringify(fail('UNKNOWN_STORY', `Not a story of this TODO: ${unknown.join(', ')}.`), null, 2));
            return 1;
        }
        console.log(JSON.stringify(collisionsOf([...new Set(overlap)].map(id => known.get(id))).groups, null, 2));
        return result.ok ? 0 : 1;
    }
    const waves = flags.has('--open') ? result.openWaves : result.waves;
    const openNow = new Set(result.openWaves.flat());
    const ready = flags.has('--open') ? result.ready.filter(id => openNow.has(id)) : result.ready;
    let output = result;
    if (flags.has('--ready') && flags.has('--waves')) output = { ready, waves };
    else if (flags.has('--ready')) output = result.ready;
    else if (flags.has('--waves')) output = waves;
    console.log(JSON.stringify(output, null, 2));
    return result.ok ? 0 : 1;
}

module.exports = { checkPlan, storyBlock, storyFiles, main };
if (require.main === module) process.exitCode = main();
