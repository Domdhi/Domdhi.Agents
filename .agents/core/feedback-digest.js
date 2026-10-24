#!/usr/bin/env node

/**
 * Feedback Digest — automated telemetry rollup for /review:feedback.
 *
 * WHAT THIS IS
 * ------------
 * Parses a project's captured telemetry + memory + system-file state into a
 * single structured digest. It is the AUTOMATED half of the template-feedback
 * loop: `/review:feedback` runs this for the numbers, then the agent appends a
 * qualitative self-review. The point is to flow real signal about how the
 * Domdhi.Agents toolkit performed on a project back to its maintainers —
 * for both new (/create:new-project) and existing (/onboard) projects.
 *
 * It is deliberately self-contained and `root`-parameterized (every reader
 * takes an explicit project root) so it runs headless and is unit-testable
 * without touching process-global CWD. It reuses the shared _lib helpers
 * (telemetry-paths, gate-summary) rather than re-deriving paths.
 *
 * NOT to be confused with:
 *   - metrics.js   — workflow metrics (telemetry + git + TODOs) for /status.
 *   - /listen      — post-MVP PRODUCT signals into intake/. This is TEMPLATE
 *                    health, a different axis.
 *
 * Usage:
 *   node .claude/core/feedback-digest.js [--json]
 *     (default)  print the markdown digest section to stdout
 *     --json     print the raw digest object as JSON (for aggregation)
 *
 * Exit codes: 0 always (best-effort observability; missing inputs degrade to
 * zeros/nulls rather than throwing).
 */

const fs = require('fs');
const path = require('path');
const { getJsonlPath, getTelemetryDir } = require('./_lib/telemetry-paths');
const { compartmentDir } = require('./_lib/output-paths');
const { readSummary } = require('./_lib/gate-summary');
const { aggregate: aggregateGuardrail } = require('./guardrail-stats');

function resolveRoot() {
    return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/** Read a JSONL file into an array of parsed objects; missing/bad lines skipped. */
function readJsonl(absPath) {
    try {
        const raw = fs.readFileSync(absPath, 'utf8');
        const out = [];
        for (const line of raw.split('\n')) {
            const t = line.trim();
            if (!t) continue;
            try { out.push(JSON.parse(t)); } catch { /* skip malformed */ }
        }
        return out;
    } catch {
        return [];
    }
}

/** Count files matching a predicate under a directory (non-recursive). */
function listDir(absDir) {
    try { return fs.readdirSync(absDir, { withFileTypes: true }); } catch { return []; }
}

/** Recursively count files satisfying `match(name)` under absDir. */
function countFilesRecursive(absDir, match) {
    let n = 0;
    for (const ent of listDir(absDir)) {
        const p = path.join(absDir, ent.name);
        if (ent.isDirectory()) n += countFilesRecursive(p, match);
        else if (match(ent.name)) n++;
    }
    return n;
}

// ── individual readers (each takes root) ────────────────────────────────────

/**
 * Read gate run counts from the telemetry store.
 *
 * DESIGN DECISION (S-PI.5): gate-run count uses a two-source strategy.
 *   Primary:  `gate_run` rows in command-usage.jsonl — these carry pass/fail
 *             outcomes, so we prefer them when present.
 *   Fallback: count `gate-*.log` files under docs/.output/.state/telemetry/logs/ —
 *             gate.js writes a timestamped log per run; no JSONL rows in older
 *             sessions means the fallback avoids a "Gate runs: 0" false zero.
 *   When JSONL has at least one gate_run row, log files are ignored entirely
 *   (counts would double-count the same runs).
 *
 * @param {string} root  Absolute project root
 * @returns {{ total: number, passed: number, failed: number, source: 'jsonl'|'logs'|'none' }}
 */
function readGateRuns(root, usageRows) {
    // Attempt primary: count gate_run rows in command-usage.jsonl.
    // F29: buildDigest parses the file once and passes the rows in — the
    // no-arg form (tests, direct callers) still reads it itself.
    const rows = usageRows || readJsonl(getJsonlPath(root, 'command-usage.jsonl'));
    let total = 0, passed = 0, failed = 0;
    for (const ev of rows) {
        if (ev.type !== 'gate_run') continue;
        total++;
        const o = ev.outcome;
        if (o === 'success' || o === 'pass') passed++;
        else if (o === 'failure' || o === 'fail') failed++;
    }
    if (total > 0) return { total, passed, failed, source: 'jsonl' };

    // Fallback: count gate-*.log files — no pass/fail info available from logs alone
    const logsDir = path.join(getTelemetryDir(root), 'logs');
    let logCount = 0;
    for (const ent of listDir(logsDir)) {
        if (ent.isFile() && ent.name.startsWith('gate-') && ent.name.endsWith('.log')) {
            logCount++;
        }
    }
    if (logCount > 0) return { total: logCount, passed: 0, failed: 0, source: 'logs' };

    return { total: 0, passed: 0, failed: 0, source: 'none' };
}

/**
 * Count secret-scanner commit blocks surfaced in the digest.
 *
 * DESIGN DECISION (S-PI.5): scanner blocks get their own digest line rather
 * than being merged into the Bash-guardrail hit counter, because the two have
 * different semantics (scanner blocks Write/Edit and git commits; guardrail
 * blocks Bash commands) and the AC explicitly permits a distinct line.
 *
 * SOURCE: guardrail-events.jsonl entries where `source === 'secret-scanner'`.
 * secret-scanner.cjs emits these via recordScannerBlock() → emitGuardrailHit
 * on both block paths (Claude Write/Edit hook and --git-precommit), so this
 * counter reflects real blocks. A 0 means no blocks occurred (or telemetry
 * predates the wiring, 2026-06-13).
 *
 * @param {string} root  Absolute project root
 * @returns {number}
 */
function readScannerBlocks(root) {
    try {
        const rows = readJsonl(getJsonlPath(root, 'guardrail-events.jsonl'));
        return rows.filter(e => e && e.source === 'secret-scanner').length;
    } catch {
        return 0;
    }
}

function readCommandUsage(root, usageRows) {
    // F29: see readGateRuns — shared single parse when called from buildDigest.
    const rows = usageRows || readJsonl(getJsonlPath(root, 'command-usage.jsonl'));
    const invocations = {};
    let selfInstrumented = 0;
    const gate = { runs: 0, pass: 0, fail: 0, unknown: 0, durations: [] };
    let lastGateOutcome = null;
    let lastGateDurationMs = null;

    for (const ev of rows) {
        if (ev.type === 'command_invocation') {
            const cmd = ev.command || 'unknown';
            invocations[cmd] = (invocations[cmd] || 0) + 1;
            if (ev.source === 'self-instrumented') selfInstrumented++;
        } else if (ev.type === 'gate_run') {
            gate.runs++;
            // Normalize outcome vocab (current + legacy); 'unknown' = no signal.
            if (ev.outcome === 'success' || ev.outcome === 'pass') gate.pass++;
            else if (ev.outcome === 'failure' || ev.outcome === 'fail') gate.fail++;
            else gate.unknown++;
            if (typeof ev.duration_ms === 'number') gate.durations.push(ev.duration_ms);
            lastGateOutcome = ev.outcome ?? lastGateOutcome;
            if (typeof ev.duration_ms === 'number') lastGateDurationMs = ev.duration_ms;
        }
    }

    const decided = gate.pass + gate.fail;
    const avgDurationMs = gate.durations.length
        ? Math.round(gate.durations.reduce((a, b) => a + b, 0) / gate.durations.length)
        : null;

    return {
        rows: rows.length,
        invocations,
        totalInvocations: Object.values(invocations).reduce((a, b) => a + b, 0),
        selfInstrumented,
        gates: {
            runs: gate.runs,
            pass: gate.pass,
            fail: gate.fail,
            unknown: gate.unknown,
            passRate: decided ? parseFloat(((gate.pass / decided) * 100).toFixed(1)) : null,
            lastOutcome: lastGateOutcome,
            lastDurationMs: lastGateDurationMs,
            avgDurationMs,
            durationsCaptured: gate.durations.length,
        },
    };
}

function readHookEvents(root) {
    const rows = readJsonl(getJsonlPath(root, 'hook-events.jsonl'));
    const byName = {};
    let failures = 0;
    for (const ev of rows) {
        const name = ev.name || 'unknown';
        byName[name] = (byName[name] || 0) + 1;
        if (ev.outcome && ev.outcome !== 'success') failures++;
    }
    return { rows: rows.length, byName, failures };
}

function readGuardrailHits(root) {
    // Reuse the guardrail-stats aggregator over guardrail-events.jsonl so the
    // hit counter feeds the periodic feedback review, not just `guardrail:stats`.
    const rows = readJsonl(getJsonlPath(root, 'guardrail-events.jsonl'));
    const agg = aggregateGuardrail(rows);
    return { total: agg.total, byDecision: agg.byDecision, byRule: agg.byRule };
}

function readSkillUsage(root) {
    const rows = readJsonl(getJsonlPath(root, 'skill-usage.jsonl'));
    let dispatches = 0;
    const skills = new Set();
    const agents = new Set();
    for (const ev of rows) {
        if (ev.type === 'agent_dispatch') {
            dispatches++;
            if (ev.agent) agents.add(ev.agent);
            for (const s of ev.skills || []) skills.add(s);
        }
    }
    return { rows: rows.length, dispatches, agents: [...agents], skillsLoaded: [...skills] };
}

function readMemoryInjection(root) {
    const rows = readJsonl(getJsonlPath(root, 'memory-injection.jsonl'));
    let injections = 0;
    let accesses = 0;
    for (const ev of rows) {
        if (ev.type === 'memory_injection') injections++;
        else if (ev.type === 'memory_access') accesses++;
    }
    return { rows: rows.length, injections, accesses };
}

function readMemoryStore(root) {
    // Split store (ADR 0006 Am. 2): JSON categories under the TRACKED .memory/;
    // the rebuilt db under the gitignored .state/memory-index/. Both are registered
    // OUTPUT_PATHS compartments — resolve their dirs through the registry (read-only
    // path resolution; the memory subsystem still owns writes) rather than re-deriving.
    const memDir = path.join(root, compartmentDir('memory'));
    const byCategory = {};
    let total = 0;
    for (const ent of listDir(memDir)) {
        if (!ent.isDirectory()) continue;
        if (ent.name === '_inbox' || ent.name === 'daily') continue; // legacy staging guard (now under .state) — harmless
        const count = listDir(path.join(memDir, ent.name))
            .filter(e => e.isFile() && e.name.endsWith('.json')).length;
        if (count > 0) { byCategory[ent.name] = count; total += count; }
    }
    const hasDb = fs.existsSync(path.join(root, compartmentDir('state/memory-index'), 'memories.db'));
    return { total, byCategory, hasDb };
}

function readSystemFiles(root) {
    const claude = path.join(root, '.claude');
    const agents = countFilesRecursive(path.join(claude, 'agents'), n => n.endsWith('.md'));
    const skills = countFilesRecursive(path.join(claude, 'skills'), n => n === 'SKILL.md');
    const commands = countFilesRecursive(path.join(claude, 'commands'), n => n.endsWith('.md'));
    const hooks = countFilesRecursive(path.join(claude, 'hooks'), n => n.endsWith('.cjs'));
    let version = null;
    try {
        version = JSON.parse(fs.readFileSync(path.join(claude, 'version.json'), 'utf8')).version || null;
    } catch { /* no version file */ }
    return { agents, skills, commands, hooks, version };
}

function inferProjectName(root) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        if (pkg.name) return pkg.name;
    } catch { /* not node */ }
    return path.basename(root);
}

/**
 * Build the full digest object for a project root.
 * @param {string} [root] project root (defaults to CLAUDE_PROJECT_DIR or cwd)
 */
function buildDigest(root = resolveRoot()) {
    const gateSummary = readSummary(root);
    // F29: command-usage.jsonl parsed ONCE — readGateRuns and readCommandUsage
    // used to each read + JSON.parse the same ~6000-line file independently.
    const usageRows = readJsonl(getJsonlPath(root, 'command-usage.jsonl'));
    return {
        generated: new Date().toISOString(),
        project: inferProjectName(root),
        system: readSystemFiles(root),
        stack: gateSummary?.stack || null,
        lastGate: gateSummary
            ? { overall: gateSummary.overall, mode: gateSummary.mode || null, durationMs: gateSummary.durationMs ?? null }
            : null,
        // S-PI.5: explicit gate-run counter (primary: gate_run JSONL rows;
        // fallback: gate-*.log file count). Separate from commands.gates so the
        // two sources can coexist without double-counting.
        gateRuns: readGateRuns(root, usageRows),
        // S-PI.5: secret-scanner commit blocks as a distinct digest line.
        // Source: guardrail-events.jsonl where source==='secret-scanner',
        // emitted by secret-scanner.cjs recordScannerBlock() since 2026-06-13.
        // Field is always present so the digest contract is stable.
        scannerBlocks: readScannerBlocks(root),
        commands: readCommandUsage(root, usageRows),
        hooks: readHookEvents(root),
        guardrail: readGuardrailHits(root),
        agents: readSkillUsage(root),
        memoryStore: readMemoryStore(root),
        memoryTelemetry: readMemoryInjection(root),
    };
}

// ── markdown rendering ───────────────────────────────────────────────────────

function pct(n) { return n === null ? 'n/a' : `${n}%`; }
function ms(n) { return n === null ? 'n/a' : `${n}ms`; }

function renderMarkdown(d) {
    const L = [];
    L.push('## Telemetry Digest (automated)');
    L.push('');
    L.push(`- **Project**: ${d.project}  ·  **Template**: v${d.system.version || '?'}  ·  **Stack**: ${d.stack || 'unknown'}`);
    L.push(`- **Generated**: ${d.generated}`);
    L.push('');
    L.push('### System files');
    L.push(`- agents ${d.system.agents} · skills ${d.system.skills} · commands ${d.system.commands} · hooks ${d.system.hooks}`);
    L.push('');
    L.push('### Commands');
    const cmds = Object.entries(d.commands.invocations).sort((a, b) => b[1] - a[1]);
    L.push(`- invocations logged: **${d.commands.totalInvocations}** (${d.commands.selfInstrumented} self-instrumented)`);
    if (cmds.length) L.push(`  - ${cmds.map(([k, v]) => `${k}×${v}`).join(', ')}`);
    else L.push('  - none captured (user-typed commands without self-instrumentation leave no row)');
    L.push('');
    // S-PI.5: Gate runs section — shows the run counter from the dedicated
    // readGateRuns reader (JSONL rows primary, log-file count fallback).
    L.push('### Gate runs');
    const gr2 = d.gateRuns || { total: 0, passed: 0, failed: 0, source: 'none' };
    L.push(`- gate-runs: **${gr2.total}** · passed ${gr2.passed} · failed ${gr2.failed} · source ${gr2.source}`);
    L.push('');
    L.push('### Gate');
    const g = d.commands.gates;
    L.push(`- runs **${g.runs}** · pass ${g.pass} · fail ${g.fail} · unknown ${g.unknown} · pass-rate ${pct(g.passRate)}`);
    L.push(`- duration: last ${ms(g.lastDurationMs)} · avg ${ms(g.avgDurationMs)} (${g.durationsCaptured}/${g.runs} captured)`);
    if (d.lastGate) L.push(`- last summary: overall ${d.lastGate.overall ? 'PASS' : 'FAIL'} · mode ${d.lastGate.mode || '?'} · ${ms(d.lastGate.durationMs)}`);
    L.push('');
    L.push('### Hooks');
    L.push(`- total fires: **${d.hooks.rows}** · failures: ${d.hooks.failures}`);
    const hk = Object.entries(d.hooks.byName).sort((a, b) => b[1] - a[1]);
    if (hk.length) L.push(`  - ${hk.map(([k, v]) => `${k}×${v}`).join(', ')}`);
    L.push('');
    L.push('### Guardrail hits');
    const gr = d.guardrail || { total: 0, byDecision: {}, byRule: {} };
    const decisions = Object.entries(gr.byDecision).sort((a, b) => b[1] - a[1]);
    L.push(`- hits logged: **${gr.total}**${decisions.length ? ` (${decisions.map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
    const topRules = Object.entries(gr.byRule).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (topRules.length) L.push(`  - top rules: ${topRules.map(([k, v]) => `${v}× ${k.length > 50 ? k.slice(0, 47) + '…' : k}`).join('; ')}`);
    L.push('');
    // S-PI.5: Scanner blocks — distinct from Bash-guardrail hits; sourced from
    // guardrail-events.jsonl entries tagged source==='secret-scanner'
    // (emitted by secret-scanner.cjs recordScannerBlock() on every block).
    L.push('### Scanner blocks');
    L.push(`- scanner-blocks: **${d.scannerBlocks ?? 0}** (Write/Edit + commit blocks by secret-scanner)`);
    L.push('');
    L.push('### Agent dispatches');
    L.push(`- dispatches: **${d.agents.dispatches}** · agents: ${d.agents.agents.join(', ') || 'none'}`);
    if (d.agents.skillsLoaded.length) L.push(`  - skills auto-loaded: ${d.agents.skillsLoaded.join(', ')}`);
    L.push('');
    L.push('### Memory');
    const mc = Object.entries(d.memoryStore.byCategory).map(([k, v]) => `${k} ${v}`).join(', ');
    L.push(`- stored: **${d.memoryStore.total}**${mc ? ` (${mc})` : ''} · db ${d.memoryStore.hasDb ? 'present' : 'absent'}`);
    L.push(`- injection telemetry: ${d.memoryTelemetry.injections} injections, ${d.memoryTelemetry.accesses} accesses`);
    L.push('');
    return L.join('\n');
}

/** Compact frontmatter-ready summary for cross-project aggregation. */
function summarize(d) {
    return {
        project: d.project,
        template_version: d.system.version,
        stack: d.stack,
        generated: d.generated,
        commands_logged: d.commands.totalInvocations,
        // S-PI.5: gate_runs now sourced from readGateRuns (JSONL primary, log fallback)
        gate_runs: d.gateRuns ? d.gateRuns.total : d.commands.gates.runs,
        gate_pass_rate: d.commands.gates.passRate,
        gate_avg_ms: d.commands.gates.avgDurationMs,
        hook_fires: d.hooks.rows,
        hook_failures: d.hooks.failures,
        guardrail_hits: d.guardrail ? d.guardrail.total : 0,
        // S-PI.5: secret-scanner commit blocks as a distinct summary field
        scanner_blocks: d.scannerBlocks ?? 0,
        agent_dispatches: d.agents.dispatches,
        memories: d.memoryStore.total,
        system: d.system,
    };
}

if (require.main === module) {
    const wantJson = process.argv.includes('--json');
    const digest = buildDigest();
    if (wantJson) process.stdout.write(JSON.stringify(digest, null, 2) + '\n');
    else process.stdout.write(renderMarkdown(digest) + '\n');
    process.exit(0);
}

module.exports = {
    buildDigest,
    renderMarkdown,
    summarize,
    // exported for focused testing
    readCommandUsage,
    readHookEvents,
    readSkillUsage,
    readMemoryStore,
    readSystemFiles,
    // S-PI.5: new readers for gate-run counting and scanner-block visibility
    readGateRuns,
    readScannerBlocks,
};
