#!/usr/bin/env node

/**
 * guardrail-stats.js — the guardrail hit counter's reporter.
 *
 * The guardrail hook (.claude/hooks/guardrail.cjs) appends one record to
 * docs/.output/.state/telemetry/guardrail-events.jsonl every time a rule fires — a
 * block, a nudge, or a confirm (allows are NOT logged). This reads that log
 * and reports how often the guardrail is being hit, broken down by decision
 * and by rule, so you can see which rules earn their keep and which are pure
 * friction.
 *
 * Each event: { event:'guardrail', decision, rule, tier, source, pathClass, timestamp }.
 * The raw command is never logged (secret safety — see hook-telemetry.js).
 * `pathClass` (C1) is a BOUNDED enum class for the first path of a delete-style
 * command ('build-artifact', 'tmp', 'node_modules', etc.) — never the raw path.
 * The "By path class" breakdown answers "is rule X just noise on disposable
 * paths?" without ever surfacing the command.
 * Events tagged source:'secret-scanner' are EXCLUDED here (they're the
 * secret-scanner's blocks, counted by feedback-digest's readScannerBlocks) so
 * this stays a pure Bash-guardrail hit counter.
 *
 * Usage:
 *   node .claude/core/guardrail-stats.js                 # human-readable table
 *   node .claude/core/guardrail-stats.js --json          # machine-readable
 *   node .claude/core/guardrail-stats.js --since 2026-06-01
 *   node .claude/core/guardrail-stats.js --top 5         # cap the per-rule list
 *
 * Exit 0 always (a reporter, not a gate).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getJsonlPath } = require('./_lib/telemetry-paths');

const PROJECT_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');

// ── Pure aggregation (exported, unit-tested) ───────────────────────────────────

/**
 * Aggregate guardrail events into counts.
 *
 * @param {object[]} events  Parsed guardrail event records.
 * @param {{ since?: string }} [opts]  ISO date (YYYY-MM-DD) lower bound, inclusive.
 * @returns {{ total:number, byDecision:object, byRule:object, byPathClass:object, range:{first:string|null,last:string|null} }}
 */
function aggregate(events, opts = {}) {
    const since = opts.since ? Date.parse(opts.since) : null;
    const byDecision = {};
    const byRule = {};
    const byPathClass = {};
    let total = 0;
    let first = null, last = null;

    for (const e of events) {
        if (!e || e.event !== 'guardrail') continue;
        // Bash-guardrail hits only. The secret-scanner shares this file but tags
        // its blocks with source:'secret-scanner' (counted by feedback-digest's
        // readScannerBlocks instead) — excluding them keeps this counter the
        // pure Bash-guardrail frequency report it documents itself to be.
        if (e.source === 'secret-scanner') continue;
        if (since != null) {
            // Policy: when --since is active, an event with no parseable timestamp
            // is EXCLUDED — we can't prove it falls within the window.
            const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
            if (Number.isNaN(t) || t < since) continue;
        }
        total++;
        const decision = e.decision || 'unknown';
        byDecision[decision] = (byDecision[decision] || 0) + 1;
        const rule = e.rule || '(unnamed)';
        byRule[rule] = (byRule[rule] || 0) + 1;
        // pathClass is optional (only delete-style hits carry it). Skip
        // null/undefined so the breakdown reflects only classified deletes.
        if (e.pathClass != null) {
            byPathClass[e.pathClass] = (byPathClass[e.pathClass] || 0) + 1;
        }
        if (e.timestamp) {
            // Numeric compare — robust to mixed timezone representations, not just
            // uniform UTC `Z` (which is all the writer emits today).
            const t = Date.parse(e.timestamp);
            if (!Number.isNaN(t)) {
                if (first === null || t < Date.parse(first)) first = e.timestamp;
                if (last === null || t > Date.parse(last)) last = e.timestamp;
            }
        }
    }
    return { total, byDecision, byRule, byPathClass, range: { first, last } };
}

/** Parse a JSONL string into an array of records, skipping malformed lines. */
function parseEvents(raw) {
    const out = [];
    for (const line of String(raw).split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { out.push(JSON.parse(t)); } catch { /* skip malformed */ }
    }
    return out;
}

/** Render the aggregate as a human-readable report string. */
function formatReport(agg, opts = {}) {
    const top = (opts.top != null && !Number.isNaN(opts.top)) ? opts.top : Infinity;
    const lines = [];
    lines.push('');
    lines.push('Guardrail hits' + (opts.since ? ` (since ${opts.since})` : ''));
    lines.push('─────────────────────────────────────');
    if (agg.total === 0) {
        lines.push('  No guardrail hits recorded yet.');
        lines.push('');
        return lines.join('\n');
    }
    lines.push(`  Total: ${agg.total}`);
    if (agg.range.first) lines.push(`  Range: ${agg.range.first.slice(0, 10)} → ${agg.range.last.slice(0, 10)}`);
    lines.push('');
    lines.push('  By decision:');
    for (const [d, n] of Object.entries(agg.byDecision).sort((a, b) => b[1] - a[1])) {
        lines.push(`    ${d.padEnd(10)} ${n}`);
    }
    lines.push('');
    lines.push('  By rule (most-hit first):');
    const rules = Object.entries(agg.byRule).sort((a, b) => b[1] - a[1]);
    const shown = rules.slice(0, top);
    for (const [r, n] of shown) {
        lines.push(`    ${String(n).padStart(4)}  ${r}`);
    }
    if (rules.length > shown.length) lines.push(`    … ${rules.length - shown.length} more rule(s)`);
    // By path class — only when delete-style hits carried a pathClass. Surfaces
    // whether a rule is firing on disposable paths (build-artifact/tmp) vs real
    // project paths, without ever logging the command itself.
    const pathClasses = Object.entries(agg.byPathClass || {}).sort((a, b) => b[1] - a[1]);
    if (pathClasses.length) {
        lines.push('');
        lines.push('  By path class (delete-style hits):');
        for (const [c, n] of pathClasses) {
            lines.push(`    ${String(n).padStart(4)}  ${c}`);
        }
    }
    lines.push('');
    return lines.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────────

function main() {
    const args = process.argv.slice(2);
    const flag = (f) => args.includes(f);
    const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
    const since = val('--since');
    const topRaw = val('--top');           // `--top 0` is valid (string '0' is falsy — guard explicitly)
    const top = topRaw !== undefined ? Number(topRaw) : undefined;

    const logPath = getJsonlPath(PROJECT_ROOT, 'guardrail-events.jsonl');
    let raw = '';
    try { raw = fs.readFileSync(logPath, 'utf8'); } catch { /* missing = no hits */ }
    const agg = aggregate(parseEvents(raw), { since });

    if (flag('--json')) {
        process.stdout.write(JSON.stringify(agg, null, 2) + '\n');
    } else {
        process.stdout.write(formatReport(agg, { since, top }));
    }
    process.exit(0);
}

if (require.main === module) main();

module.exports = { aggregate, parseEvents, formatReport };
