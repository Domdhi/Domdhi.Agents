// AC→source map (P1.6 / hook-telemetry):
//   Exports: startHookTiming(hookName), emitHookEvent(token, outcome)
//   startHookTiming returns { hookName, startMs }
//   emitHookEvent appends JSONL {event:'hook', name, duration_ms, outcome, timestamp}
//     to <telemetryDir>/hook-events.jsonl via _lib/jsonl-writer.
//   No hook adoption in this story — module-only.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const fs = require('node:fs');
const path = require('node:path');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');

let tmp;
let savedProjectDir;

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'hook-telemetry-' });
    savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
    // Re-require to pick up the env var
    delete require.cache[require.resolve('../../../../.agents/core/_lib/hook-telemetry')];
});
afterEach(() => {
    tmp.cleanup();
    if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
});

function readEvents() {
    const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'hook-events.jsonl');
    if (!fs.existsSync(jsonlPath)) return [];
    return fs.readFileSync(jsonlPath, 'utf8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l));
}

describe('startHookTiming', () => {
    it('returns a timing token with hookName and numeric startMs', () => {
        const { startHookTiming } = require('../../../../.agents/core/_lib/hook-telemetry');
        const token = startHookTiming('my-hook');
        expect(token.hookName).toBe('my-hook');
        expect(typeof token.startMs).toBe('number');
    });
});

describe('emitHookEvent', () => {
    it('writes a JSONL record with name, duration_ms, outcome, timestamp', async () => {
        const { startHookTiming, emitHookEvent } = require('../../../../.agents/core/_lib/hook-telemetry');
        const token = startHookTiming('unit-test-hook');
        await new Promise((r) => setTimeout(r, 5));
        emitHookEvent(token, 'success');

        const events = readEvents();
        expect(events).toHaveLength(1);
        expect(events[0].event).toBe('hook');
        expect(events[0].name).toBe('unit-test-hook');
        expect(events[0].outcome).toBe('success');
        expect(typeof events[0].duration_ms).toBe('number');
        expect(events[0].duration_ms).toBeGreaterThanOrEqual(0);
        expect(typeof events[0].timestamp).toBe('string');
    });

    it('honors the outcome parameter passed in', () => {
        const { startHookTiming, emitHookEvent } = require('../../../../.agents/core/_lib/hook-telemetry');
        const token = startHookTiming('hook-a');
        emitHookEvent(token, 'failure');

        const events = readEvents();
        expect(events[0].outcome).toBe('failure');
    });

    it('two concurrent tokens produce independent records', () => {
        const { startHookTiming, emitHookEvent } = require('../../../../.agents/core/_lib/hook-telemetry');
        const t1 = startHookTiming('hook-a');
        const t2 = startHookTiming('hook-b');
        emitHookEvent(t1, 'success');
        emitHookEvent(t2, 'unknown');

        const events = readEvents();
        expect(events).toHaveLength(2);
        const names = events.map(e => e.name).sort();
        expect(names).toEqual(['hook-a', 'hook-b']);
    });

    it('duration_ms is non-negative', () => {
        const { startHookTiming, emitHookEvent } = require('../../../../.agents/core/_lib/hook-telemetry');
        const token = startHookTiming('zero-duration');
        emitHookEvent(token, 'success');
        const events = readEvents();
        expect(events[0].duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('tail-rotates hook-events.jsonl when over MAX_LINES (1000) — keeps TAIL_KEEP (500)', () => {
        const {
            startHookTiming,
            emitHookEvent,
            HOOK_EVENTS_MAX_LINES,
            HOOK_EVENTS_TAIL_KEEP,
        } = require('../../../../.agents/core/_lib/hook-telemetry');

        // Seed past the cap. We don't need exactly 1100 — any number > MAX_LINES
        // forces a rotation on the appendJsonl call after the threshold.
        const seedCount = HOOK_EVENTS_MAX_LINES + 100;
        for (let i = 0; i < seedCount; i++) {
            const t = startHookTiming(`rot-test-${i}`);
            emitHookEvent(t, 'success');
        }

        const events = readEvents();
        // appendJsonl trims to tailKeep when (and only when) count > maxLines.
        // After a single rotation at the maxLines+1 boundary, count drops to
        // tailKeep; subsequent appends bring it back up but never re-cross
        // maxLines on this seed. So we expect the file to be:
        //   - strictly smaller than what we wrote (rotation occurred), and
        //   - bounded by maxLines (next rotation hasn't fired yet).
        expect(events.length).toBeLessThan(seedCount);
        expect(events.length).toBeLessThanOrEqual(HOOK_EVENTS_MAX_LINES);
        // The last event we wrote must be in the kept tail window.
        const lastName = `rot-test-${seedCount - 1}`;
        expect(events.some(e => e.name === lastName)).toBe(true);
    });
});

describe('emitGuardrailHit', () => {
    function readGuardrailEvents() {
        const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'guardrail-events.jsonl');
        if (!fs.existsSync(jsonlPath)) return [];
        return fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    }

    it('writes a guardrail record with decision, rule, tier, timestamp', () => {
        const { emitGuardrailHit } = require('../../../../.agents/core/_lib/hook-telemetry');
        const written = emitGuardrailHit({ decision: 'block', rule: 'rm -rf /', tier: null });

        const events = readGuardrailEvents();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ event: 'guardrail', decision: 'block', rule: 'rm -rf /', tier: null });
        expect(typeof events[0].timestamp).toBe('string');
        expect(written.decision).toBe('block');
    });

    it('defaults missing rule/tier to null and preserves the tier when given', () => {
        const { emitGuardrailHit } = require('../../../../.agents/core/_lib/hook-telemetry');
        emitGuardrailHit({ decision: 'block', rule: 'path-tier enforcement', tier: 'zeroAccess' });
        emitGuardrailHit({ decision: 'nudge' });

        const events = readGuardrailEvents();
        expect(events[0].tier).toBe('zeroAccess');
        expect(events[1].rule).toBeNull();
        expect(events[1].tier).toBeNull();
    });

    it('records the pathClass field when given and defaults it to null otherwise (C1)', () => {
        const { emitGuardrailHit } = require('../../../../.agents/core/_lib/hook-telemetry');
        emitGuardrailHit({ decision: 'nudge', rule: 'rm -rf', pathClass: 'build-artifact' });
        emitGuardrailHit({ decision: 'confirm', rule: 'git push --force' }); // non-delete — no pathClass

        const events = readGuardrailEvents();
        expect(events[0].pathClass).toBe('build-artifact');
        expect(events[1].pathClass).toBeNull();
    });

    it('records the source field when given and defaults it to null otherwise', () => {
        const { emitGuardrailHit } = require('../../../../.agents/core/_lib/hook-telemetry');
        emitGuardrailHit({ decision: 'block', rule: 'secret-scanner', source: 'secret-scanner' });
        emitGuardrailHit({ decision: 'block', rule: 'rm -rf /' }); // Bash guardrail — no source

        const events = readGuardrailEvents();
        expect(events[0].source).toBe('secret-scanner');
        expect(events[1].source).toBeNull();
    });

    it('records bounded rule names and a count, and drops anything else (secret-scanner telemetry)', () => {
        const { emitGuardrailHit } = require('../../../../.agents/core/_lib/hook-telemetry');
        emitGuardrailHit({ decision: 'block', rule: 'secret-scanner', source: 'secret-scanner', patterns: ['Stripe Key', 'Password Assignment'], count: 2 });
        emitGuardrailHit({ decision: 'block', rule: 'secret-scanner', source: 'secret-scanner' });
        emitGuardrailHit({ decision: 'block', rule: 'secret-scanner', source: 'secret-scanner', patterns: 'Stripe Key', count: -1 });
        emitGuardrailHit({ decision: 'block', rule: 'secret-scanner', source: 'secret-scanner', patterns: [1, null, '', 'x'.repeat(100), ...Array.from({ length: 30 }, (_, i) => `r${i}`)], count: 1.5 });

        const events = readGuardrailEvents();
        expect(events[0]).toMatchObject({ patterns: ['Stripe Key', 'Password Assignment'], count: 2 });
        expect(events[1]).not.toHaveProperty('patterns');
        expect(events[1]).not.toHaveProperty('count');
        expect(events[2]).not.toHaveProperty('patterns');
        expect(events[2]).not.toHaveProperty('count');
        expect(events[3].patterns).toHaveLength(20);
        expect(events[3].patterns[0]).toHaveLength(64);
        expect(events[3]).not.toHaveProperty('count');
    });

    it('never throws and returns null on a malformed hit (telemetry is best-effort)', () => {
        const { emitGuardrailHit } = require('../../../../.agents/core/_lib/hook-telemetry');
        expect(emitGuardrailHit(null)).toBeNull();
        expect(emitGuardrailHit({})).toBeNull();          // no decision
        expect(readGuardrailEvents()).toHaveLength(0);
    });

    it('returns null when the event could not be written, so a caller never claims a record that is not there (SEC-MAJOR-2)', () => {
        const blocker = path.join(tmp.root, 'not-a-directory');
        fs.writeFileSync(blocker, 'x');
        process.env.CLAUDE_PROJECT_DIR = blocker;       // the telemetry directory cannot be created under a file
        delete require.cache[require.resolve('../../../../.agents/core/_lib/hook-telemetry')];
        const { emitGuardrailHit } = require('../../../../.agents/core/_lib/hook-telemetry');
        expect(emitGuardrailHit({ decision: 'bypass', rule: 'git-hook-no-scan', source: 'secret-scanner' })).toBeNull();
    });

    it('returns the entry when it was written', () => {
        const { emitGuardrailHit } = require('../../../../.agents/core/_lib/hook-telemetry');
        const entry = emitGuardrailHit({ decision: 'bypass', rule: 'git-hook-no-scan', source: 'secret-scanner' });
        expect(entry).toMatchObject({ decision: 'bypass', rule: 'git-hook-no-scan' });
        expect(readGuardrailEvents()).toHaveLength(1);
    });

    it('tail-rotates guardrail-events.jsonl past MAX_LINES (5000) down to TAIL_KEEP (4000)', () => {
        const { emitGuardrailHit, GUARDRAIL_EVENTS_MAX_LINES, GUARDRAIL_EVENTS_TAIL_KEEP } = require('../../../../.agents/core/_lib/hook-telemetry');
        const seed = GUARDRAIL_EVENTS_MAX_LINES + 50;
        for (let i = 0; i < seed; i++) emitGuardrailHit({ decision: 'block', rule: `r-${i}`, tier: null });
        const events = readGuardrailEvents();
        expect(events.length).toBeLessThan(seed);                       // rotation fired
        expect(events.length).toBeLessThanOrEqual(GUARDRAIL_EVENTS_MAX_LINES);
        expect(events.length).toBeGreaterThanOrEqual(GUARDRAIL_EVENTS_TAIL_KEEP);
        expect(events.some(e => e.rule === `r-${seed - 1}`)).toBe(true); // newest kept
    });
});
