/**
 * attribution-ledger — cross-subagent change-attribution ledger (S-PI.7).
 *
 * Records WHICH agent touched WHICH files per dispatch, so unattributed
 * working-tree changes are SURFACED (not wrongly reverted) at wrap-up.
 *
 * The lead session dispatches sub-agents; sub-agents edit files; at wrap-up the
 * lead stages and commits. Without a ledger the lead cannot tell "a file I (the
 * lead) edited" from "a file a sub-agent edited" — so a well-meaning cleanup
 * (`git checkout <file>`) can silently revert a sub-agent's real work. This
 * ledger gives wrap-up the attribution it needs to DESCRIBE-and-ASK instead of
 * blindly reverting.
 *
 * Day-rotated telemetry (Run-Stamp Convention, .agents/startup-reference.md): the file is
 * `attribution-{YYMMDD}.jsonl` and entries APPEND within the day — it is NOT
 * run-stamped into a fresh file per entry. Each entry carries its own
 * `timestamp`; the filename carries the date.
 *
 * Exports:
 *   appendAttribution(entry, opts) → written entry  (never throws on bad entry)
 *   readAttribution(date)          → array of entries (empty on missing file)
 *
 * CLI:
 *   node attribution-ledger.js append '<json>'   — append one entry, print it
 *   node attribution-ledger.js read [YYMMDD]     — print the day's entries
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { appendJsonl } = require('./jsonl-writer');
const { getJsonlPath } = require('./telemetry-paths');
const { resolveProjectRoot } = require('./project-root');

function getProjectRoot() {
    return resolveProjectRoot(path.resolve(__dirname, '..', '..', '..'));
}

/**
 * Derive the {YYMMDD} stamp for a Date (defaults to now). Same convention as
 * other day-rotated telemetry logs — local date, zero-padded.
 * @param {Date} [d]
 * @returns {string} e.g. "260613"
 */
function dateStamp(d = new Date()) {
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yy}${mm}${dd}`;
}

/**
 * Filename for a given {YYMMDD} stamp.
 * @param {string} stamp
 * @returns {string}
 */
function ledgerFilename(stamp) {
    return `attribution-${stamp}.jsonl`;
}

/**
 * Append one attribution entry to today's ledger.
 *
 * Never throws on a malformed entry — coerces minimally:
 *   story_id      → String (or null)
 *   agent         → String (or null)
 *   model         → String (or null)
 *   files_touched → Array  (defaults to [])
 *   status        → String (or null)
 * Stamps `timestamp` (ISO) itself.
 *
 * @param {object} entry  { story_id, agent, model, files_touched:[], status }
 * @param {object} [opts]
 * @param {string} [opts.root]  Override project root (testing).
 * @returns {object} the written entry (with timestamp)
 */
function appendAttribution(entry, opts = {}) {
    const e = entry && typeof entry === 'object' ? entry : {};
    const record = {
        timestamp: new Date().toISOString(),
        story_id: e.story_id != null ? String(e.story_id) : null,
        agent: e.agent != null ? String(e.agent) : null,
        model: e.model != null ? String(e.model) : null,
        files_touched: Array.isArray(e.files_touched) ? e.files_touched : [],
        status: e.status != null ? String(e.status) : null,
    };
    const root = opts.root || getProjectRoot();
    const jsonlPath = getJsonlPath(root, ledgerFilename(dateStamp()));
    appendJsonl(jsonlPath, record);
    return record;
}

/**
 * Read back the attribution entries for a given {YYMMDD} stamp (today if omitted).
 *
 * @param {string} [date]  {YYMMDD} stamp; defaults to today.
 * @param {object} [opts]
 * @param {string} [opts.root]  Override project root (testing).
 * @returns {object[]} parsed entries (empty array if the file is missing/empty)
 */
function readAttribution(date, opts = {}) {
    const stamp = date || dateStamp();
    const root = opts.root || getProjectRoot();
    const jsonlPath = getJsonlPath(root, ledgerFilename(stamp));
    let content;
    try {
        content = fs.readFileSync(jsonlPath, 'utf8');
    } catch {
        return []; // missing file → no entries
    }
    return content
        .split('\n')
        .filter(l => l.trim())
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
}

module.exports = { appendAttribution, readAttribution, dateStamp, ledgerFilename };

// --- CLI ----------------------------------------------------------------------
if (require.main === module) {
    const [cmd, arg] = process.argv.slice(2);
    if (cmd === 'append') {
        let parsed = {};
        try { parsed = JSON.parse(arg || '{}'); } catch { parsed = {}; }
        const written = appendAttribution(parsed);
        process.stdout.write(JSON.stringify(written) + '\n');
    } else if (cmd === 'read') {
        const entries = readAttribution(arg);
        process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
    } else {
        process.stderr.write(
            'usage: node attribution-ledger.js append \'<json>\' | read [YYMMDD]\n'
        );
        process.exit(1);
    }
}
