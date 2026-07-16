#!/usr/bin/env node

/**
 * Edit Capture Hook (AMEM-6.1)
 *
 * PostToolUse:Edit hook — captures edits to canonical docs (CLAUDE.md, architecture,
 * skills) as daily-log entries so explicit-knowledge evolution is visible to the
 * memory pipeline before compaction.
 *
 * Runs only when MEMORY_PROFILE=strict — edits are high-signal but high-volume.
 * Non-blocking (always exits 0).
 */

const fs = require('fs');
const path = require('path');
const { isAtLeast } = require('../core/profile');
const { readHookInput } = require('../core/_lib/hook-input');

const CANONICAL_PATTERNS = [
    /(^|\/)CLAUDE\.md$/,
    /\/docs\/architecture\/overview\.md$/,
    /\/\.claude\/skills\/[^/]+\/SKILL\.md$/
];

function isCanonicalDoc(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    return CANONICAL_PATTERNS.some(p => p.test(normalized));
}

function hasTemplateMarker(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(256);
        const bytes = fs.readSync(fd, buf, 0, 256, 0);
        fs.closeSync(fd);
        const firstLine = buf.slice(0, bytes).toString('utf8').split('\n')[0];
        return firstLine.includes('<!-- @@template -->');
    } catch {
        return false;
    }
}

function shouldCapture(filePath) {
    if (!isAtLeast('strict')) return false;
    return isCanonicalDoc(filePath);
}

function processEvent(parsedJson) {
    const filePath = parsedJson?.tool_input?.file_path;
    const oldString = parsedJson?.tool_input?.old_string || '';
    const newString = parsedJson?.tool_input?.new_string || '';

    if (!filePath) return { captured: false };

    // Edge case: both strings empty
    if (oldString.length === 0 && newString.length === 0) return { captured: false };

    // shouldCapture includes profile gate AND canonical match
    if (!shouldCapture(filePath)) return { captured: false };

    // Template skip — templates have <!-- @@template --> as first line
    if (hasTemplateMarker(filePath)) return { captured: false };

    // Compute diff summary
    const projectDir = process.env.CLAUDE_PROJECT_DIR
        || path.resolve(__dirname, '..', '..');
    const relPath = path.relative(projectDir, filePath).replace(/\\/g, '/');
    const keyChange = newString.slice(0, 80).replace(/\s+/g, ' ').trim();
    const summary = `edited ${relPath}: -${oldString.length} chars, +${newString.length} chars; key change: ${keyChange}`;

    try {
        const DailyLog = require('../core/daily-log');
        const log = new DailyLog(projectDir);
        log.captureNote('**Canonical Doc Edit** — ' + summary, 'edit-capture');
        return { captured: true };
    } catch {
        // DailyLog unavailable — fail silently
        return { captured: false };
    }
}

async function main() {
    // Profile gate — only runs under strict
    if (!isAtLeast('strict')) { process.exit(0); }

    const raw = await readHookInput();
    if (!raw) { process.exit(0); }

    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        process.exit(0);
    }

    processEvent(data);
    process.exit(0);
}

if (require.main === module) {
    // P1.7 — hook duration instrumentation (F60), same pattern as siblings.
    const { startHookTiming, emitHookEvent } = require('../core/_lib/hook-telemetry');
    const _hookToken = startHookTiming('edit-capture');
    process.on('exit', () => {
        try { emitHookEvent(_hookToken, 'success'); } catch { /* never fail on telemetry */ }
    });
    main().catch(() => process.exit(0));
}

module.exports = { processEvent, shouldCapture, isCanonicalDoc };
