// Tests for feedback-digest.js — the automated telemetry rollup behind
// /review:feedback. Each reader takes an explicit root, so we build a synthetic
// project tree in a tmp dir and assert the digest reflects it.
//
// AC→source map (S-PI.5):
//   AC1: gate runs counted from gate_run rows in command-usage.jsonl
//        → readGateRuns / readCommandUsage gate.runs
//   AC2: gate runs fallback: count gate-*.log files when no gate_run rows exist
//        → readGateRuns file-count fallback
//   AC3: pass/fail tally reported for gate runs
//        → readCommandUsage gates.pass / gates.fail
//   AC4: scanner blocks surfaced as own digest line (scannerBlocks field)
//        → readScannerBlocks sourced from guardrail-events.jsonl source==='secret-scanner'
//   AC5: digest with gate logs + scanner events shows non-zero counts
//        → buildDigest integration test
//   AC6: regression tests that non-zero gate/scanner counts appear in markdown render
//        → renderMarkdown assertions

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
    buildDigest,
    renderMarkdown,
    summarize,
    readCommandUsage,
    readMemoryStore,
    readSystemFiles,
    readGateRuns,
    readScannerBlocks,
} = require('../../../.agents/core/feedback-digest');
const { createTmpDir } = require('./_helpers/tmp-dir');

let tmp;
beforeEach(() => {
    tmp = createTmpDir({ prefix: 'feedback-digest-' });
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
});
afterEach(() => {
    delete process.env.CLAUDE_PROJECT_DIR;
    tmp.cleanup();
});

const TEL = 'docs/.output/.state/telemetry';

function writeJsonl(relPath, rows) {
    tmp.write(relPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

// ── existing reader tests ────────────────────────────────────────────────────

describe('readCommandUsage', () => {
    it('countsInvocations_selfInstrumented_andGateOutcomes', () => {
        writeJsonl(`${TEL}/command-usage.jsonl`, [
            { type: 'command_invocation', command: 'onboard', source: 'self-instrumented' },
            { type: 'command_invocation', command: 'review:specialize' },
            { type: 'gate_run', command: 'gate:test', outcome: 'success', duration_ms: 4000 },
            { type: 'gate_run', command: 'gate:build', outcome: 'failure', duration_ms: 2000 },
            { type: 'gate_run', command: 'gate:test', outcome: 'unknown' },
        ]);
        const r = readCommandUsage(tmp.root);
        expect(r.totalInvocations).toBe(2);
        expect(r.selfInstrumented).toBe(1);
        expect(r.invocations.onboard).toBe(1);
        expect(r.gates.runs).toBe(3);
        expect(r.gates.pass).toBe(1);
        expect(r.gates.fail).toBe(1);
        expect(r.gates.unknown).toBe(1);
        expect(r.gates.passRate).toBe(50); // 1 pass / 2 decided
        expect(r.gates.avgDurationMs).toBe(3000); // (4000+2000)/2
    });

    it('missingFile_degradesToZeros', () => {
        const r = readCommandUsage(tmp.root);
        expect(r.totalInvocations).toBe(0);
        expect(r.gates.runs).toBe(0);
        expect(r.gates.passRate).toBeNull();
    });
});

describe('readMemoryStore', () => {
    it('countsJsonByCategory_excludesDailyAndInbox', () => {
        tmp.write('docs/.output/.memory/patterns/a.json', '{}');
        tmp.write('docs/.output/.memory/patterns/b.json', '{}');
        tmp.write('docs/.output/.memory/decisions/adr-001.json', '{}');
        tmp.write('docs/.output/.state/memory-daily/2026-06-06.md', '# log'); // excluded
        tmp.write('docs/.output/.state/memory-inbox/draft.json', '{}'); // excluded
        const r = readMemoryStore(tmp.root);
        expect(r.total).toBe(3);
        expect(r.byCategory).toEqual({ patterns: 2, decisions: 1 });
    });
});

describe('readSystemFiles', () => {
    it('countsAgentsSkillsCommandsHooks_andVersion', () => {
        tmp.write('.claude/agents/architect.md', '# a');
        tmp.write('.claude/agents/doc-writer.md', '# b');
        tmp.write('.claude/skills/code-review/SKILL.md', '# s');
        tmp.write('.claude/skills/code-review/references/x.md', 'ignored'); // not SKILL.md
        tmp.write('.claude/commands/onboard.md', '# c');
        tmp.write('.claude/commands/review/feedback.md', '# c2');
        tmp.write('.claude/hooks/guardrail.cjs', '//h');
        tmp.write('.claude/version.json', JSON.stringify({ version: '4.46.0' }));
        const r = readSystemFiles(tmp.root);
        expect(r.agents).toBe(2);
        expect(r.skills).toBe(1);
        expect(r.commands).toBe(2);
        expect(r.hooks).toBe(1);
        expect(r.version).toBe('4.46.0');
    });
});

// ── S-PI.5: readGateRuns (AC1, AC2, AC3) ────────────────────────────────────

describe('readGateRuns', () => {
    // AC1: gate runs counted from gate_run rows in command-usage.jsonl
    it('countsGateRuns_fromCommandUsageJsonl_withPassFail', () => {
        writeJsonl(`${TEL}/command-usage.jsonl`, [
            { type: 'gate_run', command: 'gate:test', outcome: 'success', duration_ms: 4000 },
            { type: 'gate_run', command: 'gate:build', outcome: 'failure', duration_ms: 2000 },
            { type: 'gate_run', command: 'gate:test', outcome: 'unknown' },
        ]);
        const r = readGateRuns(tmp.root);
        expect(r.total).toBe(3);
        expect(r.passed).toBe(1);
        expect(r.failed).toBe(1);
        expect(r.source).toBe('jsonl');
    });

    // AC2: fallback to gate-*.log file count when no gate_run rows exist
    it('fallsBackToLogFiles_whenNoGateRunRows', () => {
        // No command-usage.jsonl gate_run rows; write log files instead
        tmp.write(`${TEL}/logs/gate-2026-06-13T10-00-00-000Z.log`, 'gate output 1');
        tmp.write(`${TEL}/logs/gate-2026-06-13T11-00-00-000Z.log`, 'gate output 2');
        tmp.write(`${TEL}/logs/other-hook.log`, 'not a gate log'); // must not count
        const r = readGateRuns(tmp.root);
        expect(r.total).toBe(2);
        // No pass/fail info from log files alone
        expect(r.passed).toBe(0);
        expect(r.failed).toBe(0);
        expect(r.source).toBe('logs');
    });

    // AC2: when gate_run rows exist, log files are ignored (JSONL wins)
    it('prefersJsonl_overLogFiles_whenBothExist', () => {
        writeJsonl(`${TEL}/command-usage.jsonl`, [
            { type: 'gate_run', command: 'gate:test', outcome: 'success', duration_ms: 1000 },
        ]);
        tmp.write(`${TEL}/logs/gate-2026-06-13T10-00-00-000Z.log`, 'extra run');
        tmp.write(`${TEL}/logs/gate-2026-06-13T11-00-00-000Z.log`, 'extra run 2');
        const r = readGateRuns(tmp.root);
        // JSONL has 1 row; log files have 2 — JSONL wins
        expect(r.total).toBe(1);
        expect(r.source).toBe('jsonl');
    });

    // AC2: no JSONL, no log files → graceful zeros
    it('missingEverything_degradesToZeros', () => {
        const r = readGateRuns(tmp.root);
        expect(r.total).toBe(0);
        expect(r.passed).toBe(0);
        expect(r.failed).toBe(0);
        expect(r.source).toBe('none');
    });
});

// ── S-PI.5: readScannerBlocks (AC4) ─────────────────────────────────────────

describe('readScannerBlocks', () => {
    // AC4: scanner blocks counted from guardrail-events.jsonl where source==='secret-scanner'
    it('countsScannerBlocks_fromGuardrailEvents_withSourceField', () => {
        writeJsonl(`${TEL}/guardrail-events.jsonl`, [
            { event: 'guardrail', decision: 'block', rule: 'secret-scanner', source: 'secret-scanner', timestamp: '2026-06-13T10:00:00Z' },
            { event: 'guardrail', decision: 'block', rule: 'secret-scanner', source: 'secret-scanner', timestamp: '2026-06-13T11:00:00Z' },
            { event: 'guardrail', decision: 'block', rule: 'git push --force', tier: null, timestamp: '2026-06-13T09:00:00Z' }, // not scanner
        ]);
        const n = readScannerBlocks(tmp.root);
        expect(n).toBe(2);
    });

    // AC4: no scanner events → 0 (not throw)
    it('noScannerEvents_returnsZero', () => {
        writeJsonl(`${TEL}/guardrail-events.jsonl`, [
            { event: 'guardrail', decision: 'block', rule: 'git push --force', tier: null },
        ]);
        expect(readScannerBlocks(tmp.root)).toBe(0);
    });

    // AC4: missing file → 0
    it('missingFile_returnsZero', () => {
        expect(readScannerBlocks(tmp.root)).toBe(0);
    });
});

// ── S-PI.5: buildDigest integration (AC5) ───────────────────────────────────

describe('buildDigest — S-PI.5 gate + scanner fields', () => {
    // AC5: digest with gate logs + scanner events shows non-zero counts
    it('gateLogsAndScannerEvents_showNonZeroCounts', () => {
        // Gate runs from log files (fallback path — no command-usage gate_run rows)
        tmp.write(`${TEL}/logs/gate-2026-06-13T10-00-00-000Z.log`, 'gate output');
        tmp.write(`${TEL}/logs/gate-2026-06-13T11-00-00-000Z.log`, 'gate output 2');
        // Scanner block events in guardrail-events.jsonl
        writeJsonl(`${TEL}/guardrail-events.jsonl`, [
            { event: 'guardrail', decision: 'block', rule: 'secret-scanner', source: 'secret-scanner', timestamp: '2026-06-13T10:00:00Z' },
        ]);

        const d = buildDigest(tmp.root);
        // gateRuns field from the new top-level reader
        expect(d.gateRuns.total).toBe(2);
        expect(d.gateRuns.source).toBe('logs');
        // scannerBlocks field
        expect(d.scannerBlocks).toBe(1);
    });

    // AC5: gate runs from JSONL show non-zero and include pass/fail
    it('gateRunsFromJsonl_showPassFailInDigest', () => {
        writeJsonl(`${TEL}/command-usage.jsonl`, [
            { type: 'gate_run', outcome: 'success', duration_ms: 1000 },
            { type: 'gate_run', outcome: 'failure', duration_ms: 500 },
        ]);

        const d = buildDigest(tmp.root);
        expect(d.gateRuns.total).toBe(2);
        expect(d.gateRuns.passed).toBe(1);
        expect(d.gateRuns.failed).toBe(1);
        expect(d.gateRuns.source).toBe('jsonl');
        expect(d.scannerBlocks).toBe(0);
    });

    // AC6: regression — non-zero counts appear in markdown render
    it('renderMarkdown_showsGateRunsAndScannerBlocks_asNonZero', () => {
        writeJsonl(`${TEL}/command-usage.jsonl`, [
            { type: 'gate_run', outcome: 'success', duration_ms: 2000 },
        ]);
        writeJsonl(`${TEL}/guardrail-events.jsonl`, [
            { event: 'guardrail', decision: 'block', rule: 'secret-scanner', source: 'secret-scanner', timestamp: '2026-06-13T10:00:00Z' },
            { event: 'guardrail', decision: 'block', rule: 'secret-scanner', source: 'secret-scanner', timestamp: '2026-06-13T11:00:00Z' },
        ]);

        const d = buildDigest(tmp.root);
        const md = renderMarkdown(d);

        // Gate section must not say "runs 0"
        expect(md).toContain('### Gate');
        expect(md).toMatch(/gate-runs:.*\*\*1\*\*/);
        // Scanner blocks section present with non-zero count
        expect(md).toContain('### Scanner blocks');
        expect(md).toMatch(/scanner-blocks:.*\*\*2\*\*/);
    });
});

// ── existing integration tests (unchanged) ───────────────────────────────────

describe('buildDigest + render + summarize', () => {
    it('producesCoherentDigest_andRenderableMarkdown', () => {
        writeJsonl(`${TEL}/command-usage.jsonl`, [
            { type: 'command_invocation', command: 'onboard', source: 'self-instrumented' },
            { type: 'gate_run', command: 'gate:test', outcome: 'success', duration_ms: 3963 },
        ]);
        writeJsonl(`${TEL}/hook-events.jsonl`, [
            { event: 'hook', name: 'memory-capture', outcome: 'success' },
            { event: 'hook', name: 'path-guardrail', outcome: 'success' },
        ]);
        writeJsonl(`${TEL}/skill-usage.jsonl`, [
            { type: 'agent_dispatch', agent: 'general-purpose', skills: ['systematic-debugging'] },
        ]);
        writeJsonl(`${TEL}/guardrail-events.jsonl`, [
            { event: 'guardrail', decision: 'block', rule: 'git push --force', tier: null },
            { event: 'guardrail', decision: 'nudge', rule: 'rm -rf build', tier: null },
            { event: 'guardrail', decision: 'block', rule: 'git push --force', tier: null },
        ]);
        tmp.write(`${TEL}/_latest-summary.json`, JSON.stringify({ overall: true, mode: 'BUILD + TEST', stack: 'node', durationMs: 3963 }));
        tmp.write('docs/.output/.memory/patterns/a.json', '{}');
        tmp.write('.claude/version.json', JSON.stringify({ version: '4.46.0' }));

        const d = buildDigest(tmp.root);
        expect(d.stack).toBe('node');
        expect(d.lastGate.overall).toBe(true);
        expect(d.commands.gates.lastDurationMs).toBe(3963);
        expect(d.hooks.rows).toBe(2);
        expect(d.guardrail.total).toBe(3);
        expect(d.guardrail.byDecision).toEqual({ block: 2, nudge: 1 });
        expect(d.agents.dispatches).toBe(1);
        expect(d.memoryStore.total).toBe(1);
        // S-PI.5: gateRuns and scannerBlocks present
        expect(d.gateRuns).toBeDefined();
        expect(d.gateRuns.total).toBe(1); // 1 gate_run row
        expect(d.scannerBlocks).toBe(0);  // no source:'secret-scanner' events above

        const md = renderMarkdown(d);
        expect(md).toContain('Telemetry Digest (automated)');
        expect(md).toContain('### Gate'); // gate section rendered
        expect(md).toContain('### Guardrail hits'); // guardrail counter feeds the digest
        expect(md).toContain('self-instrumented');
        // S-PI.5: new sections present in render
        expect(md).toContain('### Gate runs');
        expect(md).toContain('### Scanner blocks');

        const s = summarize(d);
        expect(s.template_version).toBe('4.46.0');
        expect(s.gate_runs).toBe(1);
        expect(s.guardrail_hits).toBe(3);
        expect(s.memories).toBe(1);
        // S-PI.5: summarize includes scanner_blocks
        expect(s.scanner_blocks).toBe(0);
    });

    it('emptyProject_doesNotThrow', () => {
        expect(() => buildDigest(tmp.root)).not.toThrow();
        const d = buildDigest(tmp.root);
        expect(() => renderMarkdown(d)).not.toThrow();
    });
});
