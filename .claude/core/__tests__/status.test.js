import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
const require = createRequire(import.meta.url);

// regenerateMasterIndex AC→source map (S-PI.9):
//   - AC: reusable regen reuses status.js projection logic, idempotent + offline
//       → 'idempotent — second regen byte-identical', 'no network' (pure fs, asserted by offline fixtures)
//   - AC: regen refreshes TODO_{Project}.md from backlog.md + per-epic checklists + git
//       → 'flips an epic to [x] when its checklist is fully done',
//         'Phase Map Done + Total recomputed from checklists'
//   - AC: never hand-edits master as independent source / leaves unresolvable rows untouched
//       → 'epic with missing checklist left unchanged'
//   - AC: no-ops safely when project has no master index
//       → 'no master index returns {skipped} and writes nothing'  (also THIS repo — no master)
//   - AC: /review:status unchanged; lifecycle commands keep tracker live   // [inspection — command wiring, see below]
//   - AC: gate.js test passes                                              // [inspection — full suite run]
//
// Command-wiring ACs (do.md / end.md / run-todo.md / run-tests.md call
// `node status.js --regen-master` at wrap-up) are [inspection] — verified by
// reading the command files, not unit-testable here.

describe('status', () => {
    it('loads without side effects and exports helpers', () => {
        const exports = require('../status');
        expect(exports).toBeDefined();
        expect(typeof exports.findTodoFiles).toBe('function');
        expect(typeof exports.parseTodoFile).toBe('function');
        expect(typeof exports.generateHtml).toBe('function');
        expect(typeof exports.esc).toBe('function');
    });

    it('generateHtml re-export uses the new (files, telemetry, gitMetrics, outputDir) signature', () => {
        // Regression guard for the P2.4 code-review M-1 — the re-export is now
        // `_lib/status-html.generateHtml` and has a different signature from the
        // pre-split version. This test proves the chain is live and the new
        // signature returns a string rather than throwing.
        const { generateHtml } = require('../status');

        const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
        try {
            const files = [];
            const telemetry = { commands: {}, gates: {}, sessions: 0, memoryBenchmark: null };
            const gitMetrics = { commitCount: 0, branch: 'main', lastCommitAt: null, commits7d: 0 };
            const html = generateHtml(files, telemetry, gitMetrics, outputDir);
            expect(typeof html).toBe('string');
            expect(html.length).toBeGreaterThan(0);
        } finally {
            try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });

    it('esc re-export correctly escapes HTML special characters', () => {
        const { esc } = require('../status');
        expect(esc('<b>&"</b>')).toBe('&lt;b&gt;&amp;&quot;&lt;/b&gt;');
    });

    it('generateHtml accepts memMetrics 5th arg and renders Memory Health box when populated', () => {
        // Closes the M-3 deferred integration from the P2.4 code review:
        // loadMemoryMetrics output now flows through to the rendered dashboard.
        const { generateHtml } = require('../status');
        const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-mm-test-'));
        try {
            const memMetrics = {
                total: 12,
                byCategory: { patterns: 7, decisions: 5 },
                healthScore: 62,
                staleCount: 1,
            };
            const html = generateHtml(
                [],
                { commands: {}, gates: {}, sessions: 0, memoryBenchmark: null },
                { commitCount: 0, branch: 'main', lastCommitAt: null, commits7d: 0 },
                outputDir,
                memMetrics,
            );
            expect(html).toContain('Memory Health');
            expect(html).toContain('62');
        } finally {
            try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });

    it('generateHtml omits Memory Health box when memMetrics is null/missing (backward-compat)', () => {
        // Existing 4-arg callers must keep working.
        const { generateHtml } = require('../status');
        const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-mm-bc-test-'));
        try {
            const html = generateHtml(
                [],
                { commands: {}, gates: {}, sessions: 0, memoryBenchmark: null },
                { commitCount: 0, branch: 'main', lastCommitAt: null, commits7d: 0 },
                outputDir,
            );
            expect(html).not.toContain('Memory Health');
        } finally {
            try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });

    // ── F20: per-epic checklist parsing (## Story headers, not bold checkboxes) ──
    describe('parseTodoFile — per-epic checklist (F20)', () => {
        const writeTmp = (name, content) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-f20-'));
            const file = path.join(dir, name);
            fs.writeFileSync(file, content, 'utf8');
            return { dir, file };
        };

        it('counts ## Story headers as stories and derives status from task checkboxes', () => {
            const { parseTodoFile } = require('../status');
            const content = [
                '# TODO: Epic 03',
                '',
                '## Story 3.1: First story',
                '**Tasks:**',
                '- [x] do a thing',
                '- [x] do another thing',
                '',
                '## Story 3.2: Second story',
                '**Tasks:**',
                '- [x] partly done',
                '- [ ] not yet',
                '',
                '## Story 3.3: Third story',
                '**Tasks:**',
                '- [ ] untouched',
                '- [ ] also untouched',
            ].join('\n');
            const { dir, file } = writeTmp('TODO_epic03_demo.md', content);
            try {
                const r = parseTodoFile(file);
                expect(r.type).toBe('checklist');
                expect(r.stories.total).toBe(3);       // three ## Story headers
                expect(r.stories.done).toBe(1);        // 3.1 all tasks checked
                expect(r.stories.inProgress).toBe(1);  // 3.2 partial
                expect(r.stories.pending).toBe(1);     // 3.3 none
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('C13: counts epic-story-ID headers (## Story E11-S1), not just dotted IDs', () => {
            // The brownfield backlog chain numbers stories `E11-S1`, `E0-S2` — the
            // old storyHeader regex `[\d.]+` only matched dotted `1.2`, so these
            // fell through to the legacy parser and counted 0.
            const { parseTodoFile } = require('../status');
            const content = [
                '# TODO: Epic 11 — Hardening',
                '',
                '## Story E11-S1: Add path tests',
                '**Tasks:**',
                '- [x] write tests',
                '- [x] verify',
                '',
                '## Story E11-S2: Next thing',
                '**Tasks:**',
                '- [ ] todo',
            ].join('\n');
            const { dir, file } = writeTmp('TODO_epic11_hardening.md', content);
            try {
                const r = parseTodoFile(file);
                expect(r.type).toBe('checklist');
                expect(r.stories.total).toBe(2);   // both E11-S* headers counted
                expect(r.stories.done).toBe(1);    // E11-S1 all tasks checked
                expect(r.stories.pending).toBe(1); // E11-S2 untouched
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('does NOT count bold prose annotations between stories as stories (F21 root)', () => {
            const { parseTodoFile } = require('../status');
            const content = [
                '# TODO: Epic 06',
                '',
                '## Story 6.1: Only real story',
                '**Tasks:**',
                '- [ ] task',
                '',
                '- [ ] **Optimization note: this is prose, not a story**',
                '- [ ] **Another note formatted as a bold checkbox**',
            ].join('\n');
            const { dir, file } = writeTmp('TODO_epic06_demo.md', content);
            try {
                const r = parseTodoFile(file);
                expect(r.stories.total).toBe(1); // only the ## Story header, not the bold prose
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    // ── F21: grand totals dedup master vs per-epic ──
    describe('computeGrandTotals (F21)', () => {
        it('uses the master index only when present (no double-count with per-epic)', () => {
            const { computeGrandTotals } = require('../status');
            const files = [
                { type: 'master',    stories: { total: 40, done: 5, inProgress: 0, blocked: 0, deferred: 0, pending: 35 } },
                { type: 'checklist', stories: { total: 7,  done: 1, inProgress: 0, blocked: 0, deferred: 0, pending: 6 } },
                { type: 'checklist', stories: { total: 4,  done: 0, inProgress: 0, blocked: 0, deferred: 0, pending: 4 } },
            ];
            const t = computeGrandTotals(files);
            expect(t.total).toBe(40); // master is canonical — per-epic NOT added (would be 51)
            expect(t.done).toBe(5);
        });

        it('falls back to summing checklists when no master index exists', () => {
            const { computeGrandTotals } = require('../status');
            const files = [
                { type: 'checklist', stories: { total: 7, done: 1, inProgress: 0, blocked: 0, deferred: 0, pending: 6 } },
                { type: 'checklist', stories: { total: 4, done: 2, inProgress: 0, blocked: 0, deferred: 0, pending: 2 } },
            ];
            const t = computeGrandTotals(files);
            expect(t.total).toBe(11);
            expect(t.done).toBe(3);
        });
    });

    // ── R7: story-header status marker + trailing-section checkbox leakage ──
    describe('parseTodoFile — header marker authority + section leakage (R7)', () => {
        const writeTmp = (name, content) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-r7-'));
            const file = path.join(dir, name);
            fs.writeFileSync(file, content, 'utf8');
            return { dir, file };
        };

        it('honors the story HEADER [x] marker even when task checkboxes are unchecked', () => {
            // /run-todo marks the story done at its `## Story … [x]` header at wave
            // commit; status must count it done regardless of sub-task box state.
            const { parseTodoFile } = require('../status');
            const content = [
                '# TODO: Epic 03',
                '',
                '## Story 3.1 (Config): Shared Settings Schema `[x]` **[CP — critical path]**',
                '**Tasks:**',
                '- [ ] seed defaults',   // unchecked sub-tasks…
                '- [ ] wire helper',
                '',
                '## Story 3.5 (Backend): Per-Site Resolution `[ ]`',
                '**Tasks:**',
                '- [x] resolve order',   // …vs a header marked [ ] with a checked task
            ].join('\n');
            const { dir, file } = writeTmp('TODO_epic03_demo.md', content);
            try {
                const r = parseTodoFile(file);
                expect(r.stories.total).toBe(2);
                expect(r.stories.done).toBe(1);     // 3.1 — header [x] wins over unchecked tasks
                expect(r.stories.pending).toBe(1);  // 3.5 — header [ ] wins over a checked task
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('does NOT leak trailing ## Validation checkboxes into the last story', () => {
            // The `[CP]` annotation is multi-char and must NOT be read as a marker,
            // so 3.7 (header has no status bracket) derives from its own tasks only —
            // the ## Validation boxes below must not attach to it.
            const { parseTodoFile } = require('../status');
            const content = [
                '# TODO: Epic 03',
                '',
                '## Story 3.7 (Frontend): Options preset management',
                '**Tasks:**',
                '- [x] build UI',
                '- [x] persist',
                '',
                '## Validation',
                '- [ ] defaults identical across files',
                '- [ ] npm test green',
            ].join('\n');
            const { dir, file } = writeTmp('TODO_epic03_val.md', content);
            try {
                const r = parseTodoFile(file);
                expect(r.stories.total).toBe(1);   // only Story 3.7 — Validation is not a story
                expect(r.stories.done).toBe(1);    // 3.7's own tasks all [x]; Validation boxes excluded
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    // ── S-PI.9: regenerateMasterIndex — generated-projection refresh ──
    //
    // CJS-cache note: status.js freezes PROJECT_ROOT at module load from
    // process.env.CLAUDE_PROJECT_DIR. To exercise the regen against a tmp project
    // root we delete the require.cache entry and re-require with the tmp env set
    // (mirrors gate.test.js lines 5-12). regenerateMasterIndex also takes an
    // explicit projectRoot arg, but findTodoFiles() inside it reads the frozen
    // module-level PROJECT_ROOT — so the cache-bust is mandatory.
    describe('regenerateMasterIndex (S-PI.9)', () => {
        const STATUS_PATH = require.resolve('../status.js');
        let saved;

        const loadStatusWithRoot = (root) => {
            delete require.cache[STATUS_PATH];
            saved = process.env.CLAUDE_PROJECT_DIR;
            process.env.CLAUDE_PROJECT_DIR = root;
            return require('../status.js');
        };

        afterEach(() => {
            if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
            else process.env.CLAUDE_PROJECT_DIR = saved;
            delete require.cache[STATUS_PATH];
            saved = undefined;
        });

        // Build a synthetic project: master index + per-epic checklists + backlog.
        const makeProject = ({ master, epic01, epic02, backlog } = {}) => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-regen-'));
            fs.mkdirSync(path.join(root, 'docs', 'work', 'todo'), { recursive: true });
            if (master !== undefined) fs.writeFileSync(path.join(root, 'docs', 'TODO_MyProj.md'), master, 'utf8');
            if (epic01 !== undefined) fs.writeFileSync(path.join(root, 'docs', 'work', 'todo', 'TODO_epic01_alpha.md'), epic01, 'utf8');
            if (epic02 !== undefined) fs.writeFileSync(path.join(root, 'docs', 'work', 'todo', 'TODO_epic02_beta.md'), epic02, 'utf8');
            if (backlog !== undefined) fs.writeFileSync(path.join(root, 'docs', 'work', 'backlog.md'), backlog, 'utf8');
            return root;
        };

        const MASTER = [
            '# TODO: MyProj',
            '',
            '> Master implementation index. Generated by `/create:project-todo`.',
            '> Last updated: 2020-01-01',
            '',
            '## Phase Map',
            '',
            '| Phase | Name | Goal | Epics | Stories | Done | Status |',
            '|-------|------|------|-------|---------|------|--------|',
            '| 0 | Foundation | set up | 2 | 5 | 0 | PENDING |',
            '| **Total** | | | **2** | **5** | **0** | **0%** |',
            '',
            '## Epic Index',
            '',
            '| Epic | Title | Stories | Est. Hours | Status | Checklist |',
            '|------|-------|---------|-----------|--------|-----------|',
            '| 1 | Alpha | 2 | 5.5h | [ ] | [TODO](todo/TODO_epic01_alpha.md) |',
            '| 2 | Beta | 3 | 12h | [ ] | [TODO](todo/TODO_epic02_beta.md) |',
            '',
            '> **Status key:** `[ ]` Not started · `[>]` In progress · `[x]` Complete',
            '',
        ].join('\n');

        // Epic 01: 2 stories, BOTH done.
        const EPIC01_ALL_DONE = [
            '# TODO: Epic 01 — Alpha',
            '',
            '## Story 1.1: First `[x]`',
            '- [x] task',
            '',
            '## Story 1.2: Second `[x]`',
            '- [x] task',
            '',
        ].join('\n');

        // Epic 02: 3 stories, NONE done.
        const EPIC02_NONE = [
            '# TODO: Epic 02 — Beta',
            '',
            '## Story 2.1: A `[ ]`',
            '- [ ] task',
            '',
            '## Story 2.2: B `[ ]`',
            '- [ ] task',
            '',
            '## Story 2.3: C `[ ]`',
            '- [ ] task',
            '',
        ].join('\n');

        const BACKLOG = [
            '# Backlog',
            '',
            '## Phase 0: Foundation (Sprint 1)',
            '',
            '### Epic 1: Alpha',
            '* **Story 1.1: First**',
            '### Epic 2: Beta',
            '* **Story 2.1: A**',
            '',
        ].join('\n');

        it('regenerateMasterIndex_epicFullyDone_flipsStatusToX', () => {
            const root = makeProject({ master: MASTER, epic01: EPIC01_ALL_DONE, epic02: EPIC02_NONE, backlog: BACKLOG });
            try {
                const { regenerateMasterIndex } = loadStatusWithRoot(root);
                const res = regenerateMasterIndex(root, { today: '2026-06-13' });
                expect(res.updated).toBe(true);
                const out = fs.readFileSync(path.join(root, 'docs', 'TODO_MyProj.md'), 'utf8');
                // Epic 1 fully done → [x]; Epic 2 untouched → [ ]
                expect(out).toMatch(/\| 1 \| Alpha \| 2 \| 5\.5h \| \[x\] \|/);
                expect(out).toMatch(/\| 2 \| Beta \| 3 \| 12h \| \[ \] \|/);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });

        // Epic 01: 2 stories, one BLOCKED via its header marker.
        const EPIC01_BLOCKED = [
            '# TODO: Epic 01 — Alpha',
            '',
            '## Story 1.1: First `[!]`',
            '- [ ] task',
            '',
            '## Story 1.2: Second `[ ]`',
            '- [ ] task',
            '',
        ].join('\n');

        it('regenerateMasterIndex_epicBlocked_preservesBangMarker (M4)', () => {
            // A blocked story in the checklist must surface as [!] on the epic row —
            // the old markerFor(done,total) had no blocked param and reverted it to [ ].
            const root = makeProject({ master: MASTER, epic01: EPIC01_BLOCKED, epic02: EPIC02_NONE, backlog: BACKLOG });
            try {
                const { regenerateMasterIndex } = loadStatusWithRoot(root);
                regenerateMasterIndex(root, { today: '2026-06-13' });
                const out = fs.readFileSync(path.join(root, 'docs', 'TODO_MyProj.md'), 'utf8');
                // Epic 1 has a blocked story → [!], not [ ] or [>].
                expect(out).toMatch(/\| 1 \| Alpha \| 2 \| 5\.5h \| \[!\] \|/);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });

        it('regenerateMasterIndex_recomputesPhaseMapDoneAndTotal', () => {
            const root = makeProject({ master: MASTER, epic01: EPIC01_ALL_DONE, epic02: EPIC02_NONE, backlog: BACKLOG });
            try {
                const { regenerateMasterIndex } = loadStatusWithRoot(root);
                regenerateMasterIndex(root, { today: '2026-06-13' });
                const out = fs.readFileSync(path.join(root, 'docs', 'TODO_MyProj.md'), 'utf8');
                // Phase 0 has epics 1+2; epic 1 done=2, epic 2 done=0 → phase Done=2 of 5.
                expect(out).toMatch(/\| 0 \| Foundation \| set up \| 2 \| 5 \| 2 \| IN PROGRESS \|/);
                // Total row: done 2 of 5 → 40%.
                expect(out).toMatch(/\| \*\*Total\*\* \|  \|  \| \*\*2\*\* \| \*\*5\*\* \| \*\*2\*\* \| \*\*40%\*\* \|/);
                // Last updated refreshed.
                expect(out).toContain('> Last updated: 2026-06-13');
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });

        it('regenerateMasterIndex_runTwice_isByteIdentical', () => {
            const root = makeProject({ master: MASTER, epic01: EPIC01_ALL_DONE, epic02: EPIC02_NONE, backlog: BACKLOG });
            try {
                const { regenerateMasterIndex } = loadStatusWithRoot(root);
                regenerateMasterIndex(root, { today: '2026-06-13' });
                const first = fs.readFileSync(path.join(root, 'docs', 'TODO_MyProj.md'), 'utf8');
                regenerateMasterIndex(root, { today: '2026-06-13' });
                const second = fs.readFileSync(path.join(root, 'docs', 'TODO_MyProj.md'), 'utf8');
                expect(second).toBe(first); // idempotent on identical checkbox state
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });

        it('regenerateMasterIndex_noMasterIndex_returnsSkippedAndWritesNothing', () => {
            // No master file at all (mirrors THIS repo — no TODO_{Project}.md exists).
            const root = makeProject({ epic01: EPIC01_ALL_DONE });
            try {
                const { regenerateMasterIndex } = loadStatusWithRoot(root);
                const res = regenerateMasterIndex(root, { today: '2026-06-13' });
                expect(res.skipped).toBe(true);
                expect(res.reason).toBe('no master index');
                expect(fs.existsSync(path.join(root, 'docs', 'TODO_MyProj.md'))).toBe(false);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });

        it('regenerateMasterIndex_partialPhase_refreshesDoneFromResolvedEpics', () => {
            // Phase 0 holds epics 1+2; epic 2's checklist does not exist yet
            // (unscaffolded — the greenfield norm). The phase must still refresh its
            // Done from the RESOLVED epic 1 (done=2) instead of going stale, while
            // epic 2's own Epic-Index row is left unchanged. This is the Markets
            // case: Epic 6 done while 7–9 aren't created — the phase shows progress.
            const root = makeProject({ master: MASTER, epic01: EPIC01_ALL_DONE, backlog: BACKLOG });
            // intentionally do NOT write epic02
            try {
                const { regenerateMasterIndex } = loadStatusWithRoot(root);
                regenerateMasterIndex(root, { today: '2026-06-13' });
                const out = fs.readFileSync(path.join(root, 'docs', 'TODO_MyProj.md'), 'utf8');
                // Epic 1 resolved + done → [x].
                expect(out).toMatch(/\| 1 \| Alpha \| 2 \| 5\.5h \| \[x\] \|/);
                // Epic 2 checklist missing → Epic-Index row unchanged, still [ ].
                expect(out).toMatch(/\| 2 \| Beta \| 3 \| 12h \| \[ \] \|/);
                // Phase 0 row refreshes from resolved epic 1 (was Done 0 PENDING).
                expect(out).toMatch(/\| 0 \| Foundation \| set up \| 2 \| 5 \| 2 \| IN PROGRESS \|/);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });

        it('regenerateMasterIndex_partialPhase_neverLowersExistingDone', () => {
            // M1 guard: a phase with an unresolved epic must NOT drop a higher prior
            // Done (the unresolved epic may carry real, un-recomputable progress).
            // Prior Done 9 > recomputed 2 → keep 9; only the Total recomputes.
            const masterHighPrior = MASTER.replace(
                '| 0 | Foundation | set up | 2 | 5 | 0 | PENDING |',
                '| 0 | Foundation | set up | 2 | 5 | 9 | IN PROGRESS |',
            );
            const root = makeProject({ master: masterHighPrior, epic01: EPIC01_ALL_DONE, backlog: BACKLOG });
            // intentionally do NOT write epic02 (unresolved)
            try {
                const { regenerateMasterIndex } = loadStatusWithRoot(root);
                regenerateMasterIndex(root, { today: '2026-06-13' });
                const out = fs.readFileSync(path.join(root, 'docs', 'TODO_MyProj.md'), 'utf8');
                // Phase 0 Done stays 9 (not lowered to 2) — never drop a contribution.
                expect(out).toMatch(/\| 0 \| Foundation \| set up \| 2 \| 5 \| 9 \| IN PROGRESS \|/);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });

        it('regenerateMasterIndex_checklistExpanded_recomputesStoriesTotal', () => {
            // SINGLE-SOURCE INVARIANT (the "Done 33 of 16" Markets drift): /todo
            // split epic 1 from 2 planned stories into 4 scaffolded stories, all
            // done. Done (4) must NOT be shown against the stale plan (2); the
            // Stories denominator is recomputed from the SAME checklist → 4/4 at
            // the epic, and the phase + grand Total grow to match.
            const epic01Expanded = [
                '# TODO: Epic 01 — Alpha',
                '',
                '## Story 1.1: a `[x]`', '- [x] t',
                '## Story 1.2: b `[x]`', '- [x] t',
                '## Story 1.3: c `[x]`', '- [x] t',
                '## Story 1.4: d `[x]`', '- [x] t',
                '',
            ].join('\n');
            const root = makeProject({ master: MASTER, epic01: epic01Expanded, epic02: EPIC02_NONE, backlog: BACKLOG });
            try {
                const { regenerateMasterIndex } = loadStatusWithRoot(root);
                regenerateMasterIndex(root, { today: '2026-06-13' });
                const out = fs.readFileSync(path.join(root, 'docs', 'TODO_MyProj.md'), 'utf8');
                // Epic 1: Stories recomputed 2 → 4, Status [x] (4/4). Denominator
                // follows the checklist, never the stale plan.
                expect(out).toMatch(/\| 1 \| Alpha \| 4 \| 5\.5h \| \[x\] \|/);
                // Epic 2 unchanged: 3 stories, none done.
                expect(out).toMatch(/\| 2 \| Beta \| 3 \| 12h \| \[ \] \|/);
                // Phase 0 = epic1(4) + epic2(3) = 7 stories, 4 done. NOT 4 of 5.
                expect(out).toMatch(/\| 0 \| Foundation \| set up \| 2 \| 7 \| 4 \| IN PROGRESS \|/);
                // Grand Total: 4 of 7 → 57%.
                expect(out).toMatch(/\| \*\*Total\*\* \|  \|  \| \*\*2\*\* \| \*\*7\*\* \| \*\*4\*\* \| \*\*57%\*\* \|/);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });

        it('regenerateMasterIndex_extraPhColumn_resolvesColumnsByHeader', () => {
            // Markets layout: the Epic Index carries an extra "Ph" column, shifting
            // Status from index 4 to 5. Header-based resolution must write Status to
            // the right column and leave the Est. column untouched (the old
            // hardcoded cells[4] clobbered Est. with a checkbox).
            const masterPh = [
                '# TODO: MyProj',
                '> Last updated: 2020-01-01',
                '',
                '## Phase Map',
                '| Phase | Name | Goal | Epics | Stories | Done | Status |',
                '|-------|------|------|-------|---------|------|--------|',
                '| 0 | Foundation | set up | 2 | 5 | 0 | PENDING |',
                '| **Total** | | | **2** | **5** | **0** | **0%** |',
                '',
                '## Epic Index',
                '| Epic | Title | Ph | Stories | Est. | Status | Checklist |',
                '|------|-------|----|---------|------|--------|-----------|',
                '| 1 | Alpha | 0 | 2 | 8h | [ ] | [TODO](todo/TODO_epic01_alpha.md) |',
                '| 2 | Beta | 0 | 3 | 12h | [ ] | [TODO](todo/TODO_epic02_beta.md) |',
                '',
            ].join('\n');
            const root = makeProject({ master: masterPh, epic01: EPIC01_ALL_DONE, epic02: EPIC02_NONE, backlog: BACKLOG });
            try {
                const { regenerateMasterIndex } = loadStatusWithRoot(root);
                regenerateMasterIndex(root, { today: '2026-06-13' });
                const out = fs.readFileSync(path.join(root, 'docs', 'TODO_MyProj.md'), 'utf8');
                // Status (index 5) flips to [x]; Est. (index 4) stays "8h" — NOT clobbered.
                expect(out).toMatch(/\| 1 \| Alpha \| 0 \| 2 \| 8h \| \[x\] \|/);
                // Epic 2: none done → Status stays [ ], Est. "12h" preserved.
                expect(out).toMatch(/\| 2 \| Beta \| 0 \| 3 \| 12h \| \[ \] \|/);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });
    });

    // ── Legacy parseChecklist — bold-checkbox and table-status formats ──
    //
    // When a checklist file has NO `## Story N.M:` headers, parseChecklist falls
    // through to the legacy path that counts only bold-prefixed checkboxes
    // (`- [x] **Story title**`) and table status cells (`| [x] |`).
    describe('parseTodoFile — legacy checklist format (bold checkboxes + table status)', () => {
        const writeTmp = (name, content) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-legacy-'));
            const file = path.join(dir, name);
            fs.writeFileSync(file, content, 'utf8');
            return { dir, file };
        };

        it('counts bold-prefixed checkboxes as stories with correct status markers', () => {
            const { parseTodoFile } = require('../status');
            const content = [
                '# TODO: Legacy Checklist',
                '',
                '- [x] **Story 1: Completed story**',
                '- [>] **Story 2: In-progress story**',
                '- [!] **Story 3: Blocked story**',
                '- [~] **Story 4: Deferred story**',
                '- [ ] **Story 5: Pending story**',
                '',
                '- [ ] non-bold task (should be ignored)',
                '- [x] plain checkbox (not bold — ignored)',
            ].join('\n');
            const { dir, file } = writeTmp('TODO_epic_legacy.md', content);
            try {
                const r = parseTodoFile(file);
                expect(r.type).toBe('checklist');
                expect(r.stories.total).toBe(5);
                expect(r.stories.done).toBe(1);
                expect(r.stories.inProgress).toBe(1);
                expect(r.stories.blocked).toBe(1);
                expect(r.stories.deferred).toBe(1);
                expect(r.stories.pending).toBe(1);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('counts table status cells (| [x] | format) as stories', () => {
            // The /todo output format uses table rows with a Status column
            const { parseTodoFile } = require('../status');
            const content = [
                '# TODO: Sprint Checklist',
                '',
                '| Story | Description | Status |',
                '|-------|-------------|--------|',
                '| S1 | First story | [x] |',
                '| S2 | Second story | [>] |',
                '| S3 | Third story | [ ] |',
            ].join('\n');
            const { dir, file } = writeTmp('TODO_sprint.md', content);
            try {
                const r = parseTodoFile(file);
                expect(r.type).toBe('checklist');
                expect(r.stories.total).toBe(3);
                expect(r.stories.done).toBe(1);
                expect(r.stories.inProgress).toBe(1);
                expect(r.stories.pending).toBe(1);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    // ── computeTelemetryMetrics — JSONL parsing ──
    describe('computeTelemetryMetrics', () => {
        const makeTelemetryProject = (jsonlLines) => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-tel-'));
            const telDir = path.join(root, 'docs', '.output', '.state', 'telemetry');
            fs.mkdirSync(telDir, { recursive: true });
            fs.writeFileSync(
                path.join(telDir, 'command-usage.jsonl'),
                jsonlLines.join('\n'),
                'utf8',
            );
            return root;
        };

        it('returns null when telemetry file does not exist', () => {
            const { computeTelemetryMetrics } = require('../status');
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-notel-'));
            try {
                const result = computeTelemetryMetrics(root);
                expect(result).toBeNull();
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });

        it('returns null when telemetry file is empty', () => {
            const { computeTelemetryMetrics } = require('../status');
            const root = makeTelemetryProject(['']);
            try {
                const result = computeTelemetryMetrics(root);
                expect(result).toBeNull();
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });

        it('counts command_invocation entries and aggregates gate_run outcomes', () => {
            const { computeTelemetryMetrics } = require('../status');
            const jsonl = [
                JSON.stringify({ type: 'command_invocation', command: '/do', timestamp: '2026-06-01T00:00:00Z' }),
                JSON.stringify({ type: 'command_invocation', command: '/do', timestamp: '2026-06-02T00:00:00Z' }),
                JSON.stringify({ type: 'command_invocation', command: '/todo', timestamp: '2026-06-03T00:00:00Z' }),
                JSON.stringify({ type: 'gate_run', command: 'gate:node', outcome: 'success', timestamp: '2026-06-01T00:00:00Z' }),
                JSON.stringify({ type: 'gate_run', command: 'gate:node', outcome: 'failure', timestamp: '2026-06-02T00:00:00Z' }),
                JSON.stringify({ type: 'gate_run', command: 'gate:node', outcome: 'success', timestamp: '2026-06-03T00:00:00Z' }),
                'not valid json',
            ];
            const root = makeTelemetryProject(jsonl);
            try {
                const result = computeTelemetryMetrics(root);
                expect(result).not.toBeNull();
                expect(result.commands['/do']).toBe(2);
                expect(result.commands['/todo']).toBe(1);
                expect(result.gates['gate:node'].pass).toBe(2);
                expect(result.gates['gate:node'].fail).toBe(1);
                // 2 pass out of 3 total = 67% (Math.round(2/3*100))
                expect(result.gates['gate:node'].rate).toBe(67);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });

        it('supports legacy pass/fail outcome strings for backward-compat', () => {
            const { computeTelemetryMetrics } = require('../status');
            const jsonl = [
                JSON.stringify({ type: 'gate_run', command: 'gate:cargo', outcome: 'pass', timestamp: '2026-06-01T00:00:00Z' }),
                JSON.stringify({ type: 'gate_run', command: 'gate:cargo', outcome: 'fail', timestamp: '2026-06-01T00:00:00Z' }),
            ];
            const root = makeTelemetryProject(jsonl);
            try {
                const result = computeTelemetryMetrics(root);
                expect(result.gates['gate:cargo'].pass).toBe(1);
                expect(result.gates['gate:cargo'].fail).toBe(1);
                expect(result.gates['gate:cargo'].rate).toBe(50);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });

        it('counts session directories under docs/.output/.state/sessions/', () => {
            const { computeTelemetryMetrics } = require('../status');
            const root = makeTelemetryProject([
                JSON.stringify({ type: 'command_invocation', command: '/do', timestamp: '2026-06-01T00:00:00Z' }),
            ]);
            const sessionsDir = path.join(root, 'docs', '.output', '.state', 'sessions');
            fs.mkdirSync(path.join(sessionsDir, 'session-01'), { recursive: true });
            fs.mkdirSync(path.join(sessionsDir, 'session-02'), { recursive: true });
            // A file in the sessions dir should not count
            fs.writeFileSync(path.join(sessionsDir, 'not-a-dir.txt'), 'x');
            try {
                const result = computeTelemetryMetrics(root);
                expect(result.sessions).toBe(2);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });

        it('ignores gate_run entries with unknown outcome', () => {
            const { computeTelemetryMetrics } = require('../status');
            const jsonl = [
                JSON.stringify({ type: 'gate_run', command: 'gate:node', outcome: 'unknown', timestamp: '2026-06-01T00:00:00Z' }),
                JSON.stringify({ type: 'command_invocation', command: '/do', timestamp: '2026-06-01T00:00:00Z' }),
            ];
            const root = makeTelemetryProject(jsonl);
            try {
                const result = computeTelemetryMetrics(root);
                // gate:node exists but has 0 pass + 0 fail → rate 0
                expect(result.gates['gate:node'].pass).toBe(0);
                expect(result.gates['gate:node'].fail).toBe(0);
                expect(result.gates['gate:node'].rate).toBe(0);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });

        it('parses memory-benchmark.jsonl and returns hit rate for last 30 days', () => {
            const { computeTelemetryMetrics } = require('../status');
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-membench-'));
            const telDir = path.join(root, 'docs', '.output', '.state', 'telemetry');
            fs.mkdirSync(telDir, { recursive: true });
            // Need a command-usage.jsonl so computeTelemetryMetrics doesn't return null
            fs.writeFileSync(
                path.join(telDir, 'command-usage.jsonl'),
                JSON.stringify({ type: 'command_invocation', command: '/do', timestamp: '2026-06-01T00:00:00Z' }),
                'utf8',
            );
            // Build memory-benchmark.jsonl with 3 recent hits and 1 miss
            const recentDate = new Date();
            recentDate.setUTCDate(recentDate.getUTCDate() - 5);
            const recentISO = recentDate.toISOString();
            const entries = [
                JSON.stringify({ type: 'memory_benchmark', timestamp: recentISO, hit: true, retrieval_rank: 1 }),
                JSON.stringify({ type: 'memory_benchmark', timestamp: recentISO, hit: true, retrieval_rank: 2 }),
                JSON.stringify({ type: 'memory_benchmark', timestamp: recentISO, hit: false, retrieval_rank: null }),
                // Old entry outside 30-day window — should be ignored
                JSON.stringify({ type: 'memory_benchmark', timestamp: '2020-01-01T00:00:00Z', hit: false, retrieval_rank: 5 }),
                // Wrong type — should be ignored
                JSON.stringify({ type: 'other', timestamp: recentISO, hit: true }),
                'bad json line',
            ];
            fs.writeFileSync(path.join(telDir, 'memory-benchmark.jsonl'), entries.join('\n'), 'utf8');
            try {
                const result = computeTelemetryMetrics(root);
                expect(result).not.toBeNull();
                expect(result.memoryBenchmark).not.toBeNull();
                expect(result.memoryBenchmark.total).toBe(3);   // 3 recent entries counted
                expect(result.memoryBenchmark.hits).toBe(2);    // 2 hits
                expect(result.memoryBenchmark.rate).toBe(67);   // Math.round(2/3*100)
                // meanRank: only entries with numeric retrieval_rank are included
                // entries have ranks 1, 2 (null excluded) → mean = (1+2)/2 = 1.5
                expect(result.memoryBenchmark.meanRank).toBe(1.5);
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });
    });

    // ── printTextSummary — console output ──
    describe('printTextSummary', () => {
        it('prints "No TODO files found." when files array is empty', () => {
            const { printTextSummary } = require('../status');
            const output = [];
            const spy = vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
            try {
                printTextSummary([], null, null, null);
                expect(output.some(l => l.includes('No TODO files found.'))).toBe(true);
            } finally {
                spy.mockRestore();
            }
        });

        it('prints progress bar and story counts for each file', () => {
            const { printTextSummary } = require('../status');
            const files = [{
                title: 'My Epic',
                path: 'docs/work/todo/TODO_epic01.md',
                type: 'checklist',
                stories: { total: 10, done: 4, inProgress: 2, blocked: 0, deferred: 1, pending: 3 },
                epics: [],
                phases: [],
            }];
            const output = [];
            const spy = vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
            try {
                printTextSummary(files, null, null, null);
                const combined = output.join('\n');
                expect(combined).toContain('My Epic');
                expect(combined).toContain('40%');
                expect(combined).toContain('4/10');
                expect(combined).toContain('2 active');
                expect(combined).toContain('1 deferred');
            } finally {
                spy.mockRestore();
            }
        });

        it('prints epic list when file has epics', () => {
            const { printTextSummary } = require('../status');
            const files = [{
                title: 'Master Tracker',
                path: 'docs/TODO_MyProj.md',
                type: 'master',
                stories: { total: 8, done: 8, inProgress: 0, blocked: 0, deferred: 0, pending: 0 },
                epics: [
                    { id: '1', title: 'Alpha', stories: 4, estHours: 10, status: 'done' },
                    { id: '2', title: 'Beta', stories: 4, estHours: 8, status: 'in_progress' },
                ],
                phases: [],
            }];
            const output = [];
            const spy = vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
            try {
                printTextSummary(files, null, null, null);
                const combined = output.join('\n');
                expect(combined).toContain('[x] Epic 1: Alpha');
                expect(combined).toContain('[>] Epic 2: Beta');
            } finally {
                spy.mockRestore();
            }
        });

        it('prints telemetry metrics when telemetry object is provided', () => {
            const { printTextSummary } = require('../status');
            const files = [{
                title: 'Epic 01',
                path: 'docs/work/todo/TODO_epic01.md',
                type: 'checklist',
                stories: { total: 5, done: 3, inProgress: 1, blocked: 0, deferred: 0, pending: 1 },
                epics: [],
                phases: [],
            }];
            const telemetry = {
                commands: { '/do': 12, '/todo': 7 },
                gates: { 'gate:node': { pass: 10, fail: 2, rate: 83 } },
                sessions: 5,
                memoryBenchmark: { rate: 75, hits: 15, total: 20, meanRank: 1.5 },
            };
            const gitMetrics = { commits7d: 14 };
            const output = [];
            const spy = vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
            try {
                printTextSummary(files, telemetry, gitMetrics, null);
                const combined = output.join('\n');
                expect(combined).toContain('/do (12)');
                expect(combined).toContain('83% pass');
                expect(combined).toContain('Commits (7d): 14');
                expect(combined).toContain('Sessions: 5');
                // Memory hit rate: 75% → Green tag
                expect(combined).toContain('75%');
                expect(combined).toContain('Green');
            } finally {
                spy.mockRestore();
            }
        });

        it('prints memory health metrics when memMetrics is provided', () => {
            const { printTextSummary } = require('../status');
            const files = [{
                title: 'Epic 01',
                path: 'docs/work/todo/TODO_epic01.md',
                type: 'checklist',
                stories: { total: 2, done: 1, inProgress: 0, blocked: 0, deferred: 0, pending: 1 },
                epics: [],
                phases: [],
            }];
            const telemetry = {
                commands: {},
                gates: {},
                sessions: 0,
                memoryBenchmark: null,
            };
            const memMetrics = {
                total: 20,
                byCategory: { patterns: 10, decisions: 10 },
                healthScore: 55,
                staleCount: 2,
            };
            const output = [];
            const spy = vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
            try {
                printTextSummary(files, telemetry, null, memMetrics);
                const combined = output.join('\n');
                // healthScore 55 >= 50 → Green
                expect(combined).toContain('55/70');
                expect(combined).toContain('Green');
                expect(combined).toContain('20 total');
                expect(combined).toContain('2 stale');
            } finally {
                spy.mockRestore();
            }
        });

        it('prints TOTAL line when multiple files are present', () => {
            const { printTextSummary } = require('../status');
            const files = [
                {
                    title: 'Epic 01', path: 'docs/work/todo/TODO_epic01.md', type: 'checklist',
                    stories: { total: 5, done: 5, inProgress: 0, blocked: 0, deferred: 0, pending: 0 },
                    epics: [], phases: [],
                },
                {
                    title: 'Epic 02', path: 'docs/work/todo/TODO_epic02.md', type: 'checklist',
                    stories: { total: 5, done: 0, inProgress: 0, blocked: 0, deferred: 0, pending: 5 },
                    epics: [], phases: [],
                },
            ];
            const output = [];
            const spy = vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
            try {
                printTextSummary(files, null, null, null);
                const combined = output.join('\n');
                expect(combined).toContain('TOTAL:');
                expect(combined).toContain('5/10');
                expect(combined).toContain('50%');
            } finally {
                spy.mockRestore();
            }
        });
    });

    // ── parseTodoFile — master index parsing (parseMasterIndex) ──
    describe('parseTodoFile — master index with Phase Map and Epic Index', () => {
        const writeTmp = (name, content) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-master-'));
            const file = path.join(dir, name);
            fs.writeFileSync(file, content, 'utf8');
            return { dir, file };
        };

        it('identifies master index by ## Phase Map heading and parses phases + epics', () => {
            const { parseTodoFile } = require('../status');
            const content = [
                '# TODO: MyProj',
                '',
                '## Phase Map',
                '',
                '| Phase | Name | Goal | Epics | Stories | Done | Status |',
                '|-------|------|------|-------|---------|------|--------|',
                '| 1 | Bootstrap | set up | 2 | 8 | 3 | IN PROGRESS |',
                '| **Total** | | | **2** | **8** | **3** | **37%** |',
                '',
                '## Epic Index',
                '',
                '| Epic | Title | Phase | Stories | Est. Hours | Status | Checklist |',
                '|------|-------|-------|---------|-----------|--------|-----------|',
                '| 1 | Core | 1 | 4 | 10h | [x] | [TODO](todo/TODO_epic01.md) |',
                '| 2 | Auth | 1 | 4 | 8h | [>] | [TODO](todo/TODO_epic02.md) |',
                '',
            ].join('\n');
            const { dir, file } = writeTmp('TODO_MyProj.md', content);
            try {
                const r = parseTodoFile(file);
                expect(r.type).toBe('master');
                expect(r.phases.length).toBe(1);
                expect(r.phases[0].id).toBe('1');
                expect(r.phases[0].stories).toBe(8);
                expect(r.phases[0].done).toBe(3);
                expect(r.epics.length).toBe(2);
                expect(r.epics[0].status).toBe('done');
                expect(r.epics[1].status).toBe('in_progress');
                // stories aggregated from Phase Map rows
                expect(r.stories.total).toBe(8);
                expect(r.stories.done).toBe(3);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('derives stories.total from epics when Phase Map has zero totals', () => {
            // When phase rows show 0/0, parseMasterIndex falls back to epic-level aggregation
            const { parseTodoFile } = require('../status');
            const content = [
                '# TODO: MyProj',
                '',
                '## Epic Index',
                '',
                '| Epic | Title | Phase | Stories | Est. Hours | Status | Checklist |',
                '|------|-------|-------|---------|-----------|--------|-----------|',
                '| 1 | Core | 1 | 4 | 10h | [x] | [TODO](todo/TODO_epic01.md) |',
                '| 2 | Auth | 1 | 6 | 8h | [ ] | [TODO](todo/TODO_epic02.md) |',
                '| 3 | Admin | 1 | 2 | 4h | [!] | [TODO](todo/TODO_epic03.md) |',
                '| 4 | Reports | 1 | 3 | 6h | [~] | [TODO](todo/TODO_epic04.md) |',
                '',
            ].join('\n');
            const { dir, file } = writeTmp('TODO_MyProj2.md', content);
            try {
                const r = parseTodoFile(file);
                expect(r.type).toBe('master');
                // total from epics: 4+6+2+3 = 15
                expect(r.stories.total).toBe(15);
                // done from epics with status 'done': 4
                expect(r.stories.done).toBe(4);
                // status enum checks
                expect(r.epics[2].status).toBe('blocked');
                expect(r.epics[3].status).toBe('deferred');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});
