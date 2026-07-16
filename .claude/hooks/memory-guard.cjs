#!/usr/bin/env node

/**
 * Memory Guard Hook
 *
 * PostToolUse:Write hook — monitors memory directory writes and warns
 * when a category approaches its limit. Non-blocking (always exits 0).
 *
 * Exit codes:
 *   0 = always (PostToolUse hooks cannot block)
 */

const fs = require('fs');
const path = require('path');
const { isAtLeast } = require('../core/profile');
const CONSTANTS = require('../core/constants');

const MAX_MEMORIES_PER_CATEGORY = parseInt(process.env.MEMORY_MAX_PER_CATEGORY, 10) || CONSTANTS.MEMORY_FILTERS.MEMORY_MAX_PER_CATEGORY;

// F65: shared stdin plumbing — the local copy this replaced had the same
// TTY guard + 1000ms timeout readHookInput() defaults to.
const { readHookInput } = require('../core/_lib/hook-input');
const readStdin = () => readHookInput();

/**
 * Count .json files in a category directory.
 * Returns 0 on missing directory or read error (graceful).
 *
 * @param {string} categoryDir - Absolute path to the category directory
 * @returns {number}
 */
function countMemoriesInCategory(categoryDir) {
    try {
        return fs.readdirSync(categoryDir).filter(f => f.endsWith('.json')).length;
    } catch {
        return 0;
    }
}

/**
 * Process a PostToolUse:Write event and emit warnings if a memory category
 * is approaching or at its limit.
 *
 * @param {object} parsedJson - Parsed hook event: { tool_input: { file_path } }
 * @returns {null} Always returns null (side effect is stderr warnings)
 */
function processEvent(parsedJson) {
    // MEMORY_PROFILE gate — minimal profile suppresses all guard warnings
    if (!isAtLeast('standard')) { return null; }

    const filePath = parsedJson?.tool_input?.file_path || '';

    // Only care about writes to the curated JSON source (.memory/ — ADR 0006
    // Am. 2; the store split moved the category JSON out of the old `memories/`
    // dir). `.state/memory-inbox` drafts and `.state/memory-daily` logs do NOT
    // contain the `.memory` path segment, so the per-category guard ignores them.
    if (!filePath.includes('.memory') || !filePath.endsWith('.json')) {
        return null;
    }

    // Extract category from path: .../.memory/{category}/file.json
    const parts = filePath.replace(/\\/g, '/').split('/');
    const memoriesIdx = parts.indexOf('.memory');
    if (memoriesIdx === -1 || memoriesIdx + 1 >= parts.length) {
        return null;
    }

    const category = parts[memoriesIdx + 1];
    const categoryDir = path.dirname(filePath);

    const count = countMemoriesInCategory(categoryDir);

    if (count >= MAX_MEMORIES_PER_CATEGORY) {
        process.stderr.write(
            `\n  ⚠️  Memory guard: ${category} has ${count} entries (max ${MAX_MEMORIES_PER_CATEGORY}). Consider pruning stale memories.\n\n`
        );
    } else if (count >= MAX_MEMORIES_PER_CATEGORY * CONSTANTS.MEMORY_FILTERS.MEMORY_NEAR_LIMIT_PCT) {
        process.stderr.write(
            `\n  ℹ️  Memory guard: ${category} is ${Math.round(count / MAX_MEMORIES_PER_CATEGORY * 100)}% full (${count}/${MAX_MEMORIES_PER_CATEGORY}).\n\n`
        );
    }

    return null;
}

async function main() {
    const input = await readStdin();
    if (!input) { process.exit(0); }

    let data;
    try {
        data = JSON.parse(input);
    } catch {
        process.exit(0);
    }

    processEvent(data);
    process.exit(0);
}

if (require.main === module) {
    // P1.7 — hook duration instrumentation (F66), same pattern as siblings.
    const { startHookTiming, emitHookEvent } = require('../core/_lib/hook-telemetry');
    const _hookToken = startHookTiming('memory-guard');
    process.on('exit', () => {
        try { emitHookEvent(_hookToken, 'success'); } catch { /* never fail on telemetry */ }
    });
    main().catch(() => process.exit(0));
}

module.exports = { processEvent, countMemoriesInCategory };
