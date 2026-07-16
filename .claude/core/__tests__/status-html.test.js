/**
 * Tests for .claude/core/_lib/status-html.js
 *
 * Exercises: generateHtml, renderMemoryHitRateBox, renderMemoryHealthBox, esc.
 * Coverage goal: ≥70% lines on _lib/status-html.js.
 *
 * The module already exports all four functions — no refactor needed (the P2.4
 * split landed them with module.exports). Tests call the real implementations;
 * no mocks or re-creations.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

// Require _lib/status-html directly (not via status.js re-export) so
// coverage is attributed to the right file.
const STATUS_HTML_PATH = require.resolve('../_lib/status-html');
const {
    generateHtml,
    renderMemoryHitRateBox,
    renderMemoryHealthBox,
    renderGateStatusBox,
    renderCodeSizeBox,
    esc,
} = require('../_lib/status-html');

// ── Helper: minimal TODO-file fixture ────────────────────────────────────────

function makeFile(overrides = {}) {
    return {
        title: overrides.title ?? 'Test Epic',
        path: overrides.path ?? 'docs/work/todo/TODO_epic01.md',
        type: overrides.type ?? 'checklist',
        stories: {
            total: 10,
            done: 4,
            inProgress: 2,
            blocked: 0,
            deferred: 1,
            pending: 3,
            ...overrides.stories,
        },
        epics: overrides.epics ?? [],
        phases: overrides.phases ?? [],
    };
}

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'status-html-test-'));
}

// ── esc ──────────────────────────────────────────────────────────────────────

describe('status-html', () => {
    describe('esc', () => {
        it('escapes & < > " into HTML entities', () => {
            expect(esc('<b>&"</b>')).toBe('&lt;b&gt;&amp;&quot;&lt;/b&gt;');
        });

        it('leaves ordinary text unchanged', () => {
            expect(esc('hello world')).toBe('hello world');
        });

        it('coerces non-strings via String()', () => {
            expect(esc(42)).toBe('42');
        });
    });

    // ── renderMemoryHitRateBox ────────────────────────────────────────────────

    describe('renderMemoryHitRateBox', () => {
        it('returns empty string when mb is null', () => {
            expect(renderMemoryHitRateBox(null)).toBe('');
        });

        it('returns empty string when mb is undefined', () => {
            expect(renderMemoryHitRateBox(undefined)).toBe('');
        });

        it('renders green box (rate ≥ 70) with rate percentage', () => {
            const html = renderMemoryHitRateBox({ rate: 80, hits: 16, total: 20, meanRank: null });
            expect(html).toContain('80%');
            // green color
            expect(html).toContain('#3fb950');
            expect(html).toContain('Memory Hit Rate (30d)');
        });

        it('renders yellow box (50 ≤ rate < 70)', () => {
            const html = renderMemoryHitRateBox({ rate: 60, hits: 12, total: 20, meanRank: 2.5 });
            expect(html).toContain('60%');
            expect(html).toContain('#d29922');
            // meanRank included in title
            expect(html).toContain('mean rank 2.5');
        });

        it('renders red box (rate < 50)', () => {
            const html = renderMemoryHitRateBox({ rate: 40, hits: 8, total: 20, meanRank: null });
            expect(html).toContain('40%');
            expect(html).toContain('#da3633');
        });

        it('includes hits / total in title attribute', () => {
            const html = renderMemoryHitRateBox({ rate: 75, hits: 15, total: 20, meanRank: null });
            expect(html).toContain('15 hits / 20 runs');
        });
    });

    // ── renderMemoryHealthBox ─────────────────────────────────────────────────

    describe('renderMemoryHealthBox', () => {
        it('returns empty string when mm is null', () => {
            expect(renderMemoryHealthBox(null)).toBe('');
        });

        it('returns empty string when mm.total is 0', () => {
            expect(renderMemoryHealthBox({ total: 0, byCategory: {}, healthScore: 60, staleCount: 0 })).toBe('');
        });

        it('renders green box (healthScore ≥ 50) with score/70', () => {
            const html = renderMemoryHealthBox({
                total: 15,
                byCategory: { patterns: 8, decisions: 7 },
                healthScore: 62,
                staleCount: 1,
            });
            expect(html).toContain('62');
            expect(html).toContain('/70');
            expect(html).toContain('#3fb950');
            expect(html).toContain('Memory Health');
        });

        it('renders yellow box (35 ≤ healthScore < 50)', () => {
            const html = renderMemoryHealthBox({
                total: 10,
                byCategory: { patterns: 10 },
                healthScore: 42,
                staleCount: 3,
            });
            expect(html).toContain('42');
            expect(html).toContain('#d29922');
        });

        it('renders red box (healthScore < 35)', () => {
            const html = renderMemoryHealthBox({
                total: 20,
                byCategory: { patterns: 20 },
                healthScore: 20,
                staleCount: 10,
            });
            expect(html).toContain('20');
            expect(html).toContain('#da3633');
        });

        it('includes top 2 categories in title attribute', () => {
            const html = renderMemoryHealthBox({
                total: 30,
                byCategory: { patterns: 15, decisions: 10, constraints: 5 },
                healthScore: 55,
                staleCount: 2,
            });
            // top 2: patterns:15 / decisions:10 (constraints dropped)
            expect(html).toContain('patterns:15');
            expect(html).toContain('decisions:10');
            // constraints should NOT appear in top-2 truncation
            expect(html).not.toContain('constraints:5');
        });

        it('includes total and stale counts in title', () => {
            const html = renderMemoryHealthBox({
                total: 12,
                byCategory: { patterns: 12 },
                healthScore: 50,
                staleCount: 4,
            });
            expect(html).toContain('12 memories');
            expect(html).toContain('4 stale');
        });
    });

    // ── renderGateStatusBox ───────────────────────────────────────────────────

    describe('renderGateStatusBox', () => {
        it('returns empty string when gs is null', () => {
            expect(renderGateStatusBox(null)).toBe('');
        });

        it('returns empty string when overall is missing (malformed summary)', () => {
            expect(renderGateStatusBox({ stack: 'node' })).toBe('');
        });

        it('renders green PASS box with test counts and duration in title', () => {
            const html = renderGateStatusBox({
                overall: true,
                mode: 'BUILD + TEST',
                stack: 'node',
                durationMs: 13045,
                test: { passed: 2811, failed: 0, total: 2812 },
            });
            expect(html).toContain('PASS');
            expect(html).toContain('#3fb950');
            expect(html).toContain('Build Gate');
            expect(html).toContain('2811/2812 tests passed');
            expect(html).toContain('13.0s');
        });

        it('renders red FAIL box', () => {
            const html = renderGateStatusBox({ overall: false, stack: 'node' });
            expect(html).toContain('FAIL');
            expect(html).toContain('#da3633');
        });

        it('omits test counts when total is 0 (build-only run)', () => {
            const html = renderGateStatusBox({
                overall: true,
                stack: 'node',
                test: { passed: 0, failed: 0, total: 0 },
            });
            expect(html).not.toContain('tests passed');
        });
    });

    // ── renderCodeSizeBox ─────────────────────────────────────────────────────

    describe('renderCodeSizeBox', () => {
        it('returns empty string when cm is null', () => {
            expect(renderCodeSizeBox(null)).toBe('');
        });

        it('returns empty string when fileCount is 0', () => {
            expect(renderCodeSizeBox({ loc: 0, fileCount: 0, byDir: {} })).toBe('');
        });

        it('renders LOC with thousands separator and file count in title', () => {
            const html = renderCodeSizeBox({
                loc: 24481,
                fileCount: 142,
                byDir: { src: 20000, tools: 4481 },
            });
            expect(html).toContain('24,481');
            expect(html).toContain('Lines of Code');
            expect(html).toContain('142 source files');
        });

        it('includes top 3 directories in title, largest first', () => {
            const html = renderCodeSizeBox({
                loc: 100,
                fileCount: 4,
                byDir: { a: 10, b: 40, c: 30, d: 20 },
            });
            expect(html).toContain('b: 40');
            expect(html).toContain('c: 30');
            expect(html).toContain('d: 20');
            expect(html).not.toContain('a: 10');
        });
    });

    // ── generateHtml ─────────────────────────────────────────────────────────

    describe('generateHtml', () => {
        it('returns a complete HTML page string with DOCTYPE and html tags', () => {
            const tmpDir = makeTmpDir();
            try {
                const html = generateHtml([], null, null, tmpDir);
                expect(html).toContain('<!DOCTYPE html>');
                expect(html).toContain('<html lang="en">');
                expect(html).toContain('</html>');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('renders "No TODO files found in docs/" when files array is empty', () => {
            const tmpDir = makeTmpDir();
            try {
                const html = generateHtml([], null, null, tmpDir);
                expect(html).toContain('No TODO files found in docs/');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('renders "No telemetry data available" card when telemetry is null', () => {
            const tmpDir = makeTmpDir();
            try {
                const html = generateHtml([], null, null, tmpDir);
                expect(html).toContain('No telemetry data available');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('renders file cards with title, filepath, progress bar, and stat badges', () => {
            const tmpDir = makeTmpDir();
            const files = [makeFile({ title: 'My Epic', path: 'docs/work/todo/TODO_epic01.md' })];
            try {
                const html = generateHtml(files, null, null, tmpDir);
                expect(html).toContain('My Epic');
                expect(html).toContain('docs/work/todo/TODO_epic01.md');
                // progress bar width for 4/10 = 40%
                expect(html).toContain('width: 40%');
                // stat badges
                expect(html).toContain('4 done');
                expect(html).toContain('2 active');
                expect(html).toContain('1 deferred');
                expect(html).toContain('10 total');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('renders epic table rows when file has epics', () => {
            const tmpDir = makeTmpDir();
            const files = [makeFile({
                title: 'Master',
                type: 'master',
                epics: [
                    { id: '1', title: 'Core Infra', stories: 5, estHours: 12, status: 'done' },
                    { id: '2', title: 'Auth & Access', stories: 3, estHours: 8, status: 'in_progress' },
                    { id: '3', title: 'Reports Module', stories: 4, estHours: 6, status: 'blocked' },
                ],
            })];
            try {
                const html = generateHtml(files, null, null, tmpDir);
                expect(html).toContain('Core Infra');
                expect(html).toContain('Auth &amp; Access');  // esc() applied to title
                expect(html).toContain('Reports Module');
                expect(html).toContain('badge-done');
                expect(html).toContain('badge-in_progress');
                expect(html).toContain('badge-blocked');
                expect(html).toContain('12h');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('renders overall progress from master-index files only (no double-count)', () => {
            const tmpDir = makeTmpDir();
            // Master with 20 total; checklist with 5 extra — overall should show 20
            const files = [
                makeFile({ type: 'master', stories: { total: 20, done: 10, inProgress: 0, blocked: 0, deferred: 0, pending: 10 } }),
                makeFile({ type: 'checklist', stories: { total: 5, done: 5, inProgress: 0, blocked: 0, deferred: 0, pending: 0 } }),
            ];
            try {
                const html = generateHtml(files, null, null, tmpDir);
                // 10/20 = 50% overall
                expect(html).toContain('<div class="number">50%</div>');
                // summary boxes show totals from master only
                expect(html).toContain('<div class="number">10</div>'); // done
                expect(html).toContain('<div class="number">20</div>'); // total
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('renders workflow metrics with command frequency bars when telemetry is provided', () => {
            const tmpDir = makeTmpDir();
            const telemetry = {
                commands: { '/do': 15, '/todo': 8, '/end': 5 },
                gates: {},
                sessions: 7,
                memoryBenchmark: null,
            };
            const gitMetrics = { commits7d: 21, commitCount: 30, branch: 'main' };
            try {
                const html = generateHtml([], telemetry, gitMetrics, tmpDir);
                expect(html).toContain('Command Frequency');
                expect(html).toContain('/do');
                expect(html).toContain('/todo');
                expect(html).toContain('/end');
                // sessions and commits
                expect(html).toContain('<div class="number">7</div>');  // sessions
                expect(html).toContain('<div class="number">21</div>'); // commits 7d
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('renders "No command data" when telemetry has empty commands object', () => {
            const tmpDir = makeTmpDir();
            const telemetry = {
                commands: {},
                gates: {},
                sessions: 0,
                memoryBenchmark: null,
            };
            try {
                const html = generateHtml([], telemetry, null, tmpDir);
                expect(html).toContain('No command data');
                expect(html).toContain('No gate data');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('renders gate badges with traffic-light colors', () => {
            const tmpDir = makeTmpDir();
            const telemetry = {
                commands: {},
                gates: {
                    'gate:node': { pass: 9, fail: 1, rate: 90 },
                    'gate:lint': { pass: 5, fail: 5, rate: 50 },
                    'gate:e2e':  { pass: 1, fail: 9, rate: 10 },
                },
                sessions: 0,
                memoryBenchmark: null,
            };
            try {
                const html = generateHtml([], telemetry, null, tmpDir);
                expect(html).toContain('badge-gate-green');  // rate 90 ≥ 80
                expect(html).toContain('badge-gate-yellow'); // rate 50, 50 ≤ rate < 80
                expect(html).toContain('badge-gate-red');    // rate 10 < 50
                expect(html).toContain('90%');
                expect(html).toContain('50%');
                expect(html).toContain('10%');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('renders Memory Hit Rate box when telemetry.memoryBenchmark is populated', () => {
            const tmpDir = makeTmpDir();
            const telemetry = {
                commands: {},
                gates: {},
                sessions: 0,
                memoryBenchmark: { rate: 78, hits: 78, total: 100, meanRank: 1.2 },
            };
            try {
                const html = generateHtml([], telemetry, null, tmpDir);
                expect(html).toContain('Memory Hit Rate (30d)');
                expect(html).toContain('78%');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('renders Memory Health box when memMetrics 5th arg is provided', () => {
            const tmpDir = makeTmpDir();
            const memMetrics = {
                total: 25,
                byCategory: { patterns: 12, decisions: 8, constraints: 5 },
                healthScore: 58,
                staleCount: 3,
            };
            try {
                const html = generateHtml([], { commands: {}, gates: {}, sessions: 0, memoryBenchmark: null }, null, tmpDir, memMetrics);
                expect(html).toContain('Memory Health');
                expect(html).toContain('58');
                expect(html).toContain('/70');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('renders Build Gate and Lines of Code boxes when 6th/7th args are provided', () => {
            const tmpDir = makeTmpDir();
            const gateSummary = { overall: true, stack: 'node', durationMs: 5000, test: { passed: 10, failed: 0, total: 10 } };
            const codeMetrics = { loc: 1234, fileCount: 9, byDir: { src: 1234 } };
            try {
                const html = generateHtml([], { commands: {}, gates: {}, sessions: 0, memoryBenchmark: null }, null, tmpDir, null, gateSummary, codeMetrics);
                expect(html).toContain('Build Gate');
                expect(html).toContain('PASS');
                expect(html).toContain('Lines of Code');
                expect(html).toContain('1,234');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('includes decisions.html link when file exists in outputDir', () => {
            const tmpDir = makeTmpDir();
            fs.writeFileSync(path.join(tmpDir, 'decisions.html'), '<html></html>', 'utf8');
            try {
                const html = generateHtml([], null, null, tmpDir);
                expect(html).toContain('decisions.html');
                expect(html).toContain('View Decisions');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('omits decisions.html link when file does not exist in outputDir', () => {
            const tmpDir = makeTmpDir();
            try {
                const html = generateHtml([], null, null, tmpDir);
                expect(html).not.toContain('View Decisions');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('renders 0% progress when all stories are pending (no div-by-zero)', () => {
            const tmpDir = makeTmpDir();
            const files = [makeFile({ stories: { total: 5, done: 0, inProgress: 0, blocked: 0, deferred: 0, pending: 5 } })];
            try {
                const html = generateHtml(files, null, null, tmpDir);
                expect(html).toContain('width: 0%');
                expect(html).toContain('0%');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('HTML-escapes titles and paths containing special characters', () => {
            const tmpDir = makeTmpDir();
            const files = [makeFile({ title: 'Epic <Alpha> & "Beta"', path: 'docs/work/todo/TODO_epic<01>.md' })];
            try {
                const html = generateHtml(files, null, null, tmpDir);
                expect(html).toContain('Epic &lt;Alpha&gt; &amp; &quot;Beta&quot;');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        // ── CR-2.3 / F18+F19: stored XSS via attacker-influenceable Epic ID ──
        //
        // e.id is cols[0] from parseMasterIndex() — a raw markdown table cell
        // from a checked-in TODO_{Project}.md Epic Index, i.e. repo content an
        // attacker could control. It must be escaped exactly like the sibling
        // e.title field on the very next cell.

        it('HTML-escapes the epic ID (F18/F19 stored XSS)', () => {
            const tmpDir = makeTmpDir();
            const files = [makeFile({
                type: 'master',
                epics: [
                    { id: '<script>alert(document.domain)</script>', title: 'Core Infra', stories: 5, estHours: 12, status: 'done' },
                ],
            })];
            try {
                const html = generateHtml(files, null, null, tmpDir);
                expect(html).not.toContain('<script>alert(document.domain)</script>');
                expect(html).toContain('&lt;script&gt;alert(document.domain)&lt;/script&gt;');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('HTML-escapes an epic ID with an img/onerror payload (F18/F19 stored XSS)', () => {
            const tmpDir = makeTmpDir();
            const files = [makeFile({
                type: 'master',
                epics: [
                    { id: '<img src=x onerror=alert(document.domain)>', title: 'Auth', stories: 3, estHours: 8, status: 'in_progress' },
                ],
            })];
            try {
                const html = generateHtml(files, null, null, tmpDir);
                expect(html).not.toContain('<img src=x onerror=alert(document.domain)>');
                expect(html).toContain('&lt;img src=x onerror=alert(document.domain)&gt;');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('renders "N TODO files found" meta line with plural form', () => {
            const tmpDir = makeTmpDir();
            const files = [makeFile(), makeFile({ title: 'Epic 02', path: 'docs/work/todo/TODO_epic02.md' })];
            try {
                const html = generateHtml(files, null, null, tmpDir);
                expect(html).toContain('2 TODO files found');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('renders "1 TODO file found" with singular form', () => {
            const tmpDir = makeTmpDir();
            const files = [makeFile()];
            try {
                const html = generateHtml(files, null, null, tmpDir);
                expect(html).toContain('1 TODO file found');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });
    });
});
