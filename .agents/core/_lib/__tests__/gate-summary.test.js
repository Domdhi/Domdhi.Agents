// AC→source map (P1.4 / gate-summary):
//   Exports: writeSummary(projectRoot, summary), readSummary(projectRoot)
//   Path: <projectRoot>/docs/.output/.state/telemetry/_latest-summary.json
//   readSummary returns null unless typeof parsed.overall === 'boolean'
//   (load-bearing — command-usage-logger depends on null for exit-code fallback)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const fs = require('node:fs');
const path = require('node:path');
const { writeSummary, readSummary } = require('../../../../.agents/core/_lib/gate-summary');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');

let tmp;
beforeEach(() => { tmp = createTmpDir({ prefix: 'gate-summary-' }); });
afterEach(() => { tmp.cleanup(); });

describe('writeSummary / readSummary roundtrip', () => {
    it('roundtrip returns the same object', () => {
        writeSummary(tmp.root, { overall: true, build: { succeeded: true } });
        const result = readSummary(tmp.root);
        expect(result).toEqual({ overall: true, build: { succeeded: true } });
    });

    it('writeSummary creates parent directories as needed', () => {
        writeSummary(tmp.root, { overall: false });
        const expected = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', '_latest-summary.json');
        expect(fs.existsSync(expected)).toBe(true);
    });

    it('writeSummary pretty-prints JSON (indented, not minified)', () => {
        writeSummary(tmp.root, { overall: true, nested: { a: 1 } });
        const raw = fs.readFileSync(
            path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', '_latest-summary.json'),
            'utf8'
        );
        expect(raw).toContain('\n');
        expect(raw).toContain('  ');
    });
});

describe('readSummary null-return contract', () => {
    it('returns null when the summary file does not exist', () => {
        expect(readSummary(tmp.root)).toBeNull();
    });

    it('returns null on invalid JSON', () => {
        const dir = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '_latest-summary.json'), '{ not json');
        expect(readSummary(tmp.root)).toBeNull();
    });

    it('returns null when overall field is missing', () => {
        writeSummary(tmp.root, { build: { succeeded: true } });
        expect(readSummary(tmp.root)).toBeNull();
    });

    it('returns null when overall is not a boolean (load-bearing — do not widen)', () => {
        writeSummary(tmp.root, { overall: 'true' });
        expect(readSummary(tmp.root)).toBeNull();
    });

    it('returns null when overall is null', () => {
        writeSummary(tmp.root, { overall: null });
        expect(readSummary(tmp.root)).toBeNull();
    });
});
