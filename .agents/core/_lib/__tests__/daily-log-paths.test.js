// AC→source map (P1.2 / daily-log-paths):
//   Exports: getDailyDir(projectRoot), getDailyLogPath(date, projectRoot)
//   Path shape: <projectRoot>/docs/.output/.state/memory-daily/<YYYY-MM-DD>.md
//   getDailyLogPath accepts Date object OR 'YYYY-MM-DD' string (pass-through)

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const path = require('node:path');
const { getDailyDir, getDailyLogPath } = require('../../../../.agents/core/_lib/daily-log-paths');

describe('getDailyDir', () => {
    it('returns docs/.output/.state/memory-daily under the given project root', () => {
        const result = getDailyDir('/tmp/project');
        // path.join normalizes separators — compare in platform form
        expect(result).toBe(path.join('/tmp/project', 'docs', '.output', '.state', 'memory-daily'));
    });

    it('honors a Windows-style absolute root', () => {
        const result = getDailyDir(['C:', 'Users', 'x', 'project'].join('\\'));
        expect(result).toContain(path.join('docs', '.output', '.state', 'memory-daily'));
    });
});

describe('getDailyLogPath', () => {
    it('accepts a Date object and formats YYYY-MM-DD.md', () => {
        const date = new Date('2026-04-24T10:00:00Z');
        const result = getDailyLogPath(date, '/tmp/project');
        expect(result).toBe(path.join('/tmp/project', 'docs', '.output', '.state', 'memory-daily', '2026-04-24.md'));
    });

    it('accepts a YYYY-MM-DD string (pass-through)', () => {
        const result = getDailyLogPath('2026-04-24', '/tmp/project');
        expect(result).toBe(path.join('/tmp/project', 'docs', '.output', '.state', 'memory-daily', '2026-04-24.md'));
    });

    it('uses the provided projectRoot, not cwd', () => {
        const result = getDailyLogPath('2026-01-01', '/alt/root');
        expect(result.startsWith(path.join('/alt/root', 'docs'))).toBe(true);
    });

    it('extracts the date slice from a longer ISO string', () => {
        const result = getDailyLogPath('2026-04-24T12:34:56.789Z', '/tmp/project');
        expect(result).toBe(path.join('/tmp/project', 'docs', '.output', '.state', 'memory-daily', '2026-04-24.md'));
    });

    it('throws on a malformed date string instead of building a traversal-carrying path', () => {
        expect(() => getDailyLogPath('../../etc/passwd', '/tmp/project')).toThrow(/invalid date/);
    });

    it('throws on a non-date string', () => {
        expect(() => getDailyLogPath('not-a-date', '/tmp/project')).toThrow(/invalid date/);
    });

    it('accepts a string that merely fails calendar validity (shape check only, not calendar validity)', () => {
        // The fix's regex (^\d{4}-\d{2}-\d{2}$) checks shape, not that month 13 exists.
        const result = getDailyLogPath('2026-13-99', '/tmp/project');
        expect(result).toBe(path.join('/tmp/project', 'docs', '.output', '.state', 'memory-daily', '2026-13-99.md'));
    });
});
