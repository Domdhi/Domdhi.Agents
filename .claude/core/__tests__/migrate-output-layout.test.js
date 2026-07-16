// AC→source: migrate-output-layout.js — the .output/ taxonomy codemod (ADR 0006, Wave 2b).
// Covers: month parsing (two eras), runtime compartment enumeration + month bucketing,
// park/flag of un-dated & ad-hoc-subdir artifacts, idempotent already-bucketed skip,
// memories/ exclusion, boundary-anchored --refs (compartment relocations + .state/ gotcha),
// --verify exit semantics, and real git-mv history preservation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const mig = require('../migrate-output-layout');

function mkTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-output-'));
}
function write(root, rel, content) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
}
function mkdir(root, rel) {
    const abs = path.join(root, rel);
    fs.mkdirSync(abs, { recursive: true });
    return abs;
}

describe('monthFromName — two-era date parsing', () => {
    it('parses the YYMMDD-HHMM stamp era', () => {
        expect(mig.monthFromName('260621-1306-code-review.md')).toBe('2026-06');
        expect(mig.monthFromName('251231-2359-x.json')).toBe('2025-12');
    });
    it('parses the legacy YYYY-MM-DD era', () => {
        expect(mig.monthFromName('2026-04-20-adr-memory.md')).toBe('2026-04');
        expect(mig.monthFromName('2026-06-21.md')).toBe('2026-06'); // day-log
    });
    it('parses a run-unit DIRECTORY name (no extension)', () => {
        expect(mig.monthFromName('260621-1306-council')).toBe('2026-06');
    });
    it('parses an EMBEDDED stamp (feedback-{stamp} / council-{stamp} conventions)', () => {
        expect(mig.monthFromName('feedback-260607-1548.json')).toBe('2026-06');
        expect(mig.monthFromName('feedback-rollup-260606-2243.md')).toBe('2026-06');
        expect(mig.monthFromName('council-260621-1306')).toBe('2026-06');
    });
    it('returns null for un-dated names (never guess)', () => {
        expect(mig.monthFromName('agent-updates.md')).toBeNull();
        expect(mig.monthFromName('notes.md')).toBeNull();
        expect(mig.monthFromName('database')).toBeNull();
    });
    it('does NOT mis-parse epic-keyed retros that merely contain digits', () => {
        expect(mig.monthFromName('retro-tdd-3.md')).toBeNull();
        expect(mig.monthFromName('retro-v4.63-component-creator-split.md')).toBeNull();
        expect(mig.monthFromName('retro-platform-alignment-may-2026.md')).toBeNull();
    });
});

describe('rewriteLine — compartment relocations & .state/ gotcha', () => {
    it('relocates findings-group compartments (docs-prefixed)', () => {
        expect(mig.rewriteLine('see docs/.output/reviews/x.md').text)
            .toBe('see docs/.output/findings/reviews/x.md');
        expect(mig.rewriteLine('docs/.output/investigations/y.md').text)
            .toBe('docs/.output/findings/investigations/y.md');
        expect(mig.rewriteLine('docs/.output/research/z.md').text)
            .toBe('docs/.output/findings/research/z.md');
    });

    it('relocates evolution-group compartments incl. the skills/agents renames', () => {
        expect(mig.rewriteLine('docs/.output/triage/2026-06-21.md').text)
            .toBe('docs/.output/evolution/triage/2026-06-21.md');
        expect(mig.rewriteLine('docs/.output/skill-evolution/run/').text)
            .toBe('docs/.output/evolution/skills/run/');
        expect(mig.rewriteLine('docs/.output/agent-updates/2026-06-21.md').text)
            .toBe('docs/.output/evolution/agents/2026-06-21.md');
    });

    it('rewrites the bare .output/ prefix form too (one rule, both forms)', () => {
        expect(mig.rewriteLine('.output/reviews/x.md').text).toBe('.output/findings/reviews/x.md');
        expect(mig.rewriteLine('.output/intake/2026-06-21.md').text)
            .toBe('.output/evolution/intake/2026-06-21.md');
    });

    it('preserves the tail past the matched compartment (council sub-path)', () => {
        expect(mig.rewriteLine('docs/.output/reviews/council-260621/x.md').text)
            .toBe('docs/.output/findings/reviews/council-260621/x.md');
    });

    it('rewrites the Wave 1 .state/ prose gotcha', () => {
        expect(mig.rewriteLine('write docs/.output/.commit-msg').text)
            .toBe('write docs/.output/.state/.commit-msg');
        expect(mig.rewriteLine('docs/.output/.pr-body').text)
            .toBe('docs/.output/.state/.pr-body');
        expect(mig.rewriteLine('docs/.output/telemetry/foo.json').text)
            .toBe('docs/.output/.state/telemetry/foo.json');
        expect(mig.rewriteLine('docs/.output/work/2026-06/task/').text)
            .toBe('docs/.output/.state/work/2026-06/task/');
        expect(mig.rewriteLine('docs/.output/freeze-state.json').text)
            .toBe('docs/.output/.state/freeze-state.json');
    });

    it('does NOT touch plans/ or handoffs/ (bucket-only, path unchanged)', () => {
        expect(mig.rewriteLine('docs/.output/plans/260621-1306-do-x.md').changed).toBe(false);
        expect(mig.rewriteLine('docs/.output/handoffs/260621-1456-end-main.md').changed).toBe(false);
    });

    it('does NOT touch memories/ (Wave 1b owns that split)', () => {
        expect(mig.rewriteLine('docs/.output/memories/patterns/x.json').changed).toBe(false);
        expect(mig.rewriteLine('docs/.output/memories/_inbox/y.json').changed).toBe(false);
    });

    it('respects the trailing boundary (.output/work vs .output/workspace)', () => {
        expect(mig.rewriteLine('docs/.output/workspace/x').changed).toBe(false);
        expect(mig.rewriteLine('docs/.output/work').text).toBe('docs/.output/.state/work');
    });

    it('is idempotent — re-running over rewritten text is a no-op', () => {
        const once = mig.rewriteLine('docs/.output/reviews/x.md and docs/.output/telemetry/y').text;
        const twice = mig.rewriteLine(once).text;
        expect(twice).toBe(once);
        expect(mig.rewriteLine(once).changed).toBe(false);
    });

    it('skips a line carrying the migrate:keep marker', () => {
        const line = 'legacy: docs/.output/reviews/x.md  <!-- migrate:keep -->';
        expect(mig.rewriteLine(line).changed).toBe(false);
    });
});

describe('findSurvivors — verify detection', () => {
    it('flags a surviving legacy compartment token', () => {
        const hits = mig.findSurvivors('still writes docs/.output/reviews/x.md');
        expect(hits.some((h) => h.token === '.output/reviews')).toBe(true);
    });
    it('returns nothing for a fully-migrated line', () => {
        expect(mig.findSurvivors('docs/.output/findings/reviews/x.md is canonical')).toEqual([]);
    });
    it('ignores keep-marked lines', () => {
        expect(mig.findSurvivors('docs/.output/reviews/x.md  migrate:keep')).toEqual([]);
    });
});

describe('isPathSkipped — allowlist', () => {
    it('skips archive, generated output, ADRs, changelog, and the migration codemods', () => {
        expect(mig.isPathSkipped('docs/work/todo/_archive/cycle-1/TODO_x.md')).toBe(true);
        expect(mig.isPathSkipped('docs/.output/reviews/2026-06-20-adr-x.md')).toBe(true);
        expect(mig.isPathSkipped('docs/architecture/decisions/0006-output-taxonomy-lifecycle.md')).toBe(true);
        expect(mig.isPathSkipped('CHANGELOG.md')).toBe(true);
        expect(mig.isPathSkipped('.claude/core/migrate-output-layout.js')).toBe(true);
        expect(mig.isPathSkipped('.claude/core/migrate-docs-domains.js')).toBe(true);
        expect(mig.isPathSkipped('node_modules/x/index.js')).toBe(true);
    });
    it('skips linked worktrees (a separate checkout, not ours to rewrite)', () => {
        expect(mig.isPathSkipped('.claude/worktrees/feature-x/.claude/commands/do.md')).toBe(true);
        expect(mig.isPathSkipped('worktrees/wt/CLAUDE.md')).toBe(true);
    });
    it('does NOT skip ordinary template files', () => {
        expect(mig.isPathSkipped('.claude/commands/do.md')).toBe(false);
        expect(mig.isPathSkipped('docs/reference/system-map.md')).toBe(false);
        expect(mig.isPathSkipped('CLAUDE.md')).toBe(false);
    });
});

describe('effectiveRefRewrites — tracked-work carve-out', () => {
    function gitInit(root) {
        execFileSync('git', ['init', '-q'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    }
    const hasWorkRule = (rules) => rules.some(([t]) => t === mig.WORK_REF_RULE_TOKEN);

    it('keeps the full ruleset when .output/work has NO tracked files (workshop case)', () => {
        const root = mkTmp();
        gitInit(root);
        const r = mig.effectiveRefRewrites(root);
        expect(r.suppressedWork).toBe(false);
        expect(r.trackedCount).toBe(0);
        expect(hasWorkRule(r.rules)).toBe(true);
    });

    it('drops the work→.state rule when .output/work has tracked files (adopter case)', () => {
        const root = mkTmp();
        gitInit(root);
        write(root, 'docs/.output/work/FINDINGS.md', 'durable cited content');
        execFileSync('git', ['add', 'docs/.output/work/FINDINGS.md'], { cwd: root });
        const r = mig.effectiveRefRewrites(root);
        expect(r.suppressedWork).toBe(true);
        expect(r.trackedCount).toBe(1);
        expect(hasWorkRule(r.rules)).toBe(false);
        // every OTHER rule survives — only the work token is dropped
        expect(r.rules.length).toBe(mig.REF_REWRITES.length - 1);
    });

    it('--migrate-tracked-work forces the full ruleset even with tracked work files', () => {
        const root = mkTmp();
        gitInit(root);
        write(root, 'docs/.output/work/FINDINGS.md', 'x');
        execFileSync('git', ['add', 'docs/.output/work/FINDINGS.md'], { cwd: root });
        const r = mig.effectiveRefRewrites(root, { force: true });
        expect(r.suppressedWork).toBe(false);
        expect(hasWorkRule(r.rules)).toBe(true);
    });

    it('trackedWorkFiles returns [] in a non-git directory (degrades safe)', () => {
        const root = mkTmp();
        expect(mig.trackedWorkFiles(root)).toEqual([]);
    });

    it('carve-out holds when projectRoot is a SUBDIR of the git toplevel (F4 regression)', () => {
        // The :/ -magic pathspec must anchor to the repo root regardless of CWD. With a
        // CWD-relative `--` pathspec this returns [] (suppressedWork:false) and silently
        // re-enables the de-tracking the carve-out exists to prevent — the F4 bug.
        const root = mkTmp();
        gitInit(root);
        write(root, 'docs/.output/work/FINDINGS.md', 'durable cited content');
        execFileSync('git', ['add', 'docs/.output/work/FINDINGS.md'], { cwd: root });
        const sub = path.join(root, 'docs', 'engineering');
        fs.mkdirSync(sub, { recursive: true });
        const r = mig.effectiveRefRewrites(sub);   // projectRoot BELOW the git toplevel
        expect(r.suppressedWork).toBe(true);
        expect(r.trackedCount).toBe(1);
        expect(hasWorkRule(r.rules)).toBe(false);
    });

    it('the carve-out keeps .output/work citations intact while still rewriting others', () => {
        const root = mkTmp();
        gitInit(root);
        write(root, 'docs/.output/work/FINDINGS.md', 'x');
        execFileSync('git', ['add', 'docs/.output/work/FINDINGS.md'], { cwd: root });
        write(root, 'CLAUDE.md', 'see docs/.output/work/FINDINGS.md and docs/.output/reviews/r.md');
        const { rules } = mig.effectiveRefRewrites(root);
        mig.runRefs(root, { apply: true, paths: ['CLAUDE.md'], rules });
        const after = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
        expect(after).toContain('docs/.output/work/FINDINGS.md');          // citation preserved
        expect(after).toContain('docs/.output/findings/reviews/r.md');     // other rule still applied
    });
});

describe('collectFiles — nested-checkout guard', () => {
    it('never descends into a directory holding a .git entry', () => {
        const root = mkTmp();
        fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(root, '.claude/keep.md'), 'x');
        fs.mkdirSync(path.join(root, '.claude/wt'), { recursive: true });
        fs.writeFileSync(path.join(root, '.claude/wt/.git'), 'gitdir: /elsewhere'); // linked worktree marker
        fs.writeFileSync(path.join(root, '.claude/wt/leak.md'), 'x');

        const found = mig.collectFiles(path.join(root, '.claude'), root, [])
            .map((f) => path.relative(root, f).split(path.sep).join('/'));

        expect(found).toContain('.claude/keep.md');
        expect(found.some((f) => f.includes('/wt/'))).toBe(false);
    });
});

describe('planMoves — runtime enumeration + month bucketing', () => {
    let root, out;
    beforeEach(() => { root = mkTmp(); out = path.join(root, 'docs/.output'); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    const norm = (p) => p.replace(/\\/g, '/');

    it('buckets discrete findings files by their filename date (both eras)', () => {
        write(out, 'reviews/260621-1306-code-review.md', '#');
        write(out, 'reviews/2026-04-20-adr-x.md', '#');
        write(out, 'investigations/260601-0900-bug.md', '#');
        write(out, 'research/260615-1200-market.md', '#');
        const { moves } = mig.planMoves(out);
        const pairs = moves.map((m) => [norm(m.from), norm(m.to)]);
        expect(pairs).toContainEqual(['reviews/260621-1306-code-review.md', 'findings/reviews/2026-06/260621-1306-code-review.md']);
        expect(pairs).toContainEqual(['reviews/2026-04-20-adr-x.md', 'findings/reviews/2026-04/2026-04-20-adr-x.md']);
        expect(pairs).toContainEqual(['investigations/260601-0900-bug.md', 'findings/investigations/2026-06/260601-0900-bug.md']);
        expect(pairs).toContainEqual(['research/260615-1200-market.md', 'findings/research/2026-06/260615-1200-market.md']);
    });

    it('buckets day-log compartments into evolution/ by month', () => {
        write(out, 'triage/2026-06-21.md', '#');
        write(out, 'agent-updates/2026-06-18.md', '#');
        write(out, 'intake/2026-05-30.md', '#');
        const { moves } = mig.planMoves(out);
        const pairs = moves.map((m) => [norm(m.from), norm(m.to)]);
        expect(pairs).toContainEqual(['triage/2026-06-21.md', 'evolution/triage/2026-06/2026-06-21.md']);
        expect(pairs).toContainEqual(['agent-updates/2026-06-18.md', 'evolution/agents/2026-06/2026-06-18.md']);
        expect(pairs).toContainEqual(['intake/2026-05-30.md', 'evolution/intake/2026-05/2026-05-30.md']);
    });

    it('moves run-unit DIRECTORIES whole into evolution/ by their date', () => {
        write(out, 'skill-evolution/260620-1000-skillx/iteration-1.md', '#');
        write(out, 'canary/260619-0800-deploy/canary-08-00.md', '#');
        const { moves } = mig.planMoves(out);
        const pairs = moves.map((m) => [norm(m.from), norm(m.to), m.isDir]);
        expect(pairs).toContainEqual(['skill-evolution/260620-1000-skillx', 'evolution/skills/2026-06/260620-1000-skillx', true]);
        expect(pairs).toContainEqual(['canary/260619-0800-deploy', 'evolution/canary/2026-06/260619-0800-deploy', true]);
    });

    it('parks un-dated files (reported, never moved/guessed)', () => {
        write(out, 'reviews/summary.md', '#');           // no date
        write(out, 'agent-updates.md', '#');             // loose legacy root file, undated
        const { moves, parked } = mig.planMoves(out);
        const parkedFroms = parked.map((p) => norm(p.from));
        expect(parkedFroms).toContain('reviews/summary.md');
        expect(parkedFroms).toContain('agent-updates.md');
        expect(moves.map((m) => norm(m.from))).not.toContain('reviews/summary.md');
    });

    it('flags ad-hoc non-date subdirs under discrete compartments (the database/958 anti-pattern)', () => {
        write(out, 'investigations/database/958.md', '#');
        write(out, 'research/competitive/notes.md', '#');   // real adopter: named topic-dir
        const { moves, parked } = mig.planMoves(out);
        const flagged = parked.find((p) => norm(p.from) === 'investigations/database');
        expect(flagged).toBeTruthy();
        expect(flagged.reason).toMatch(/adhoc|subdir|forbidden/i);
        expect(parked.map((p) => norm(p.from))).toContain('research/competitive');
        // the dirs are NOT moved
        const movedFroms = moves.map((m) => norm(m.from));
        expect(movedFroms).not.toContain('investigations/database');
        expect(movedFroms).not.toContain('research/competitive');
    });

    it('buckets DATED day-folders as units (legacy organize.cjs day-dirs)', () => {
        write(out, 'research/2026-02-16/raw.md', '#');
        write(out, 'plans/2026-04-12/plan.md', '#');
        const { moves } = mig.planMoves(out);
        const pairs = moves.map((m) => [norm(m.from), norm(m.to), m.isDir]);
        expect(pairs).toContainEqual(['research/2026-02-16', 'findings/research/2026-02/2026-02-16', true]);
        expect(pairs).toContainEqual(['plans/2026-04-12', 'plans/2026-04/2026-04-12', true]);
    });

    it('buckets files carrying an EMBEDDED stamp (feedback-{stamp})', () => {
        write(out, 'reviews/feedback-260607-1548.json', '#');
        write(out, 'reviews/feedback-rollup-260606-2243.md', '#');
        const { moves } = mig.planMoves(out);
        const pairs = moves.map((m) => [norm(m.from), norm(m.to)]);
        expect(pairs).toContainEqual(['reviews/feedback-260607-1548.json', 'findings/reviews/2026-06/feedback-260607-1548.json']);
        expect(pairs).toContainEqual(['reviews/feedback-rollup-260606-2243.md', 'findings/reviews/2026-06/feedback-rollup-260606-2243.md']);
    });

    it('still parks genuinely undated durable files (epic-keyed retros)', () => {
        write(out, 'reviews/retro-cycle-2.md', '#');
        write(out, 'triage/_decisions.md', '#');
        const { moves, parked } = mig.planMoves(out);
        const parkedFroms = parked.map((p) => norm(p.from));
        expect(parkedFroms).toContain('reviews/retro-cycle-2.md');
        expect(parkedFroms).toContain('triage/_decisions.md');
        expect(moves.map((m) => norm(m.from))).not.toContain('reviews/retro-cycle-2.md');
    });

    it('skips already-bucketed month dirs at their final location (idempotent)', () => {
        write(out, 'handoffs/2026-06/260621-1456-end-main.md', '#');
        write(out, 'plans/2026-06/260621-1306-do-x.md', '#');
        const { moves, skipped } = mig.planMoves(out);
        expect(moves.map((m) => norm(m.from))).not.toContain('handoffs/2026-06');
        expect(skipped.map((s) => norm(s.from))).toContain('handoffs/2026-06');
        expect(skipped.map((s) => norm(s.from))).toContain('plans/2026-06');
    });

    it('buckets loose handoffs/plans files into their own month folder (same parent)', () => {
        write(out, 'plans/260621-1306-do-x.md', '#');
        write(out, 'handoffs/260620-1100-end-main.md', '#');
        const { moves } = mig.planMoves(out);
        const pairs = moves.map((m) => [norm(m.from), norm(m.to)]);
        expect(pairs).toContainEqual(['plans/260621-1306-do-x.md', 'plans/2026-06/260621-1306-do-x.md']);
        expect(pairs).toContainEqual(['handoffs/260620-1100-end-main.md', 'handoffs/2026-06/260620-1100-end-main.md']);
    });

    it('never touches memories/ (Wave 1b)', () => {
        write(out, 'memories/patterns/x.json', '#');
        write(out, 'memories/memories.db', '#');
        const { moves, parked } = mig.planMoves(out);
        const all = [...moves.map((m) => norm(m.from)), ...parked.map((p) => norm(p.from))];
        expect(all.some((f) => f.startsWith('memories/'))).toBe(false);
    });
});

describe('datedHoming — --date-undated gives parked artifacts a real create-date', () => {
    let root, out;
    beforeEach(() => { root = mkTmp(); out = path.join(root, 'docs/.output'); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
    const norm = (p) => p.replace(/\\/g, '/');
    // deterministic injected stamp — no git needed
    const fixedStamp = () => '260614-2135';

    it('dates an undated file into its create-month bucket (prefix preserves the slug)', () => {
        write(out, 'reviews/retro-cycle-2.md', '#');
        const { parked } = mig.planMoves(out);
        const { homed } = mig.datedHoming(parked, out, { stampFn: fixedStamp });
        const pairs = homed.map((m) => [norm(m.from), norm(m.to)]);
        expect(pairs).toContainEqual(['reviews/retro-cycle-2.md', 'findings/reviews/2026-06/260614-2135-retro-cycle-2.md']);
    });

    it('dates an ad-hoc subdir as a run-unit (isDir preserved)', () => {
        write(out, 'research/competitive/notes.md', '#');
        const { parked } = mig.planMoves(out);
        const { homed } = mig.datedHoming(parked, out, { stampFn: fixedStamp });
        const entry = homed.find((m) => norm(m.from) === 'research/competitive');
        expect(entry).toBeTruthy();
        expect(norm(entry.to)).toBe('findings/research/2026-06/260614-2135-competitive');
        expect(entry.isDir).toBe(true);
    });

    it('keeps ledger/index files at the compartment ROOT — no date, no month', () => {
        write(out, 'triage/_decisions.md', '#');
        write(out, 'research/README.md', '#');
        const { parked } = mig.planMoves(out);
        const { homed } = mig.datedHoming(parked, out, { stampFn: fixedStamp });
        const pairs = homed.map((m) => [norm(m.from), norm(m.to)]);
        expect(pairs).toContainEqual(['triage/_decisions.md', 'evolution/triage/_decisions.md']);
        expect(pairs).toContainEqual(['research/README.md', 'findings/research/README.md']);
    });

    it('leaves an item parked when its create-date cannot be resolved (never guessed)', () => {
        write(out, 'reviews/retro-x.md', '#');
        const { parked } = mig.planMoves(out);
        const { homed, stillParked } = mig.datedHoming(parked, out, { stampFn: () => null });
        expect(homed).toEqual([]);
        expect(stillParked.map((p) => norm(p.from))).toContain('reviews/retro-x.md');
        expect(stillParked[0].reason).toMatch(/no create-date/);
    });

    it('runMove({dateUndated}) folds homing into the result and shrinks parked', () => {
        write(out, 'reviews/260601-0900-real.md', '#');   // normal move
        write(out, 'reviews/retro-y.md', '#');             // parked → homed
        // no git in this tmp tree, so createStamp falls back to fs birthtime (present)
        const r = mig.runMove(out, { apply: false, dateUndated: true });
        expect(r.moves.some((m) => norm(m.from) === 'reviews/260601-0900-real.md')).toBe(true);
        expect(r.homed.some((m) => norm(m.from) === 'reviews/retro-y.md')).toBe(true);
        expect(r.parked.length).toBe(0);   // fs birthtime resolved the date
    });
});

describe('runMove — git mv history preservation', () => {
    let root, out;
    beforeEach(() => { root = mkTmp(); out = path.join(root, 'docs/.output'); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('dry-run plans without touching disk', () => {
        write(out, 'reviews/260621-1306-x.md', '#');
        const r = mig.runMove(out, { apply: false });
        expect(r.moves.length).toBeGreaterThan(0);
        expect(fs.existsSync(path.join(out, 'reviews/260621-1306-x.md'))).toBe(true);
        expect(fs.existsSync(path.join(out, 'findings/reviews/2026-06/260621-1306-x.md'))).toBe(false);
    });

    it('applies real git mv (history-preserving) when the tree is tracked', () => {
        execFileSync('git', ['init', '-q'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
        write(out, 'reviews/260621-1306-x.md', '# review\n');
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root });

        mig.runMove(out, { apply: true });
        expect(fs.existsSync(path.join(out, 'findings/reviews/2026-06/260621-1306-x.md'))).toBe(true);
        expect(fs.existsSync(path.join(out, 'reviews/260621-1306-x.md'))).toBe(false);
        const status = execFileSync('git', ['status', '--porcelain', '--find-renames'], { cwd: root }).toString();
        expect(status).toMatch(/^R/m);
        expect(status).toContain('reviews/260621-1306-x.md');
        expect(status).toContain('findings/reviews/2026-06/260621-1306-x.md');
    });
});

describe('runRefs / runVerify — fileset rewrite & exit semantics', () => {
    let root;
    beforeEach(() => { root = mkTmp(); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('dry-run reports changes without writing; apply writes', () => {
        write(root, '.claude/commands/x.md', 'writes docs/.output/reviews/r.md\n');
        const dry = mig.runRefs(root, { apply: false, paths: ['.claude'] });
        expect(dry.changedFiles.length).toBe(1);
        expect(fs.readFileSync(path.join(root, '.claude/commands/x.md'), 'utf8'))
            .toContain('.output/reviews/'); // unchanged on disk

        mig.runRefs(root, { apply: true, paths: ['.claude'] });
        expect(fs.readFileSync(path.join(root, '.claude/commands/x.md'), 'utf8'))
            .toBe('writes docs/.output/findings/reviews/r.md\n');
    });

    it('honors the skip-allowlist — archive and generated .output untouched', () => {
        write(root, 'docs/work/todo/_archive/old.md', 'docs/.output/reviews/x.md\n');
        write(root, 'docs/.output/reviews/2026-06/note.md', 'docs/.output/reviews/x.md\n');
        write(root, '.claude/commands/y.md', 'docs/.output/reviews/x.md\n');
        const r = mig.runRefs(root, { apply: true, paths: ['.', 'docs'] });
        const changed = r.changedFiles.map((f) => f.file.replace(/\\/g, '/'));
        expect(changed).toContain('.claude/commands/y.md');
        expect(changed).not.toContain('docs/work/todo/_archive/old.md');
        expect(changed.some((f) => f.includes('.output/'))).toBe(false);
    });

    it('runVerify finds a planted legacy token and is clean after apply', () => {
        write(root, '.claude/commands/z.md', 'docs/.output/triage/2026-06-21.md\n');
        const before = mig.runVerify(root, { paths: ['.claude'] });
        expect(before.violations.length).toBe(1);
        expect(before.violations[0].token).toBe('.output/triage');

        mig.runRefs(root, { apply: true, paths: ['.claude'] });
        const after = mig.runVerify(root, { paths: ['.claude'] });
        expect(after.violations).toEqual([]);
    });
});

// F52 (council-260715-2244) + W6-M1: the batched first-add map. The header
// sentinel must be shape-matched — repo paths legitimately start with '@'
// (`@scope/pkg/x.js`), and a bare startsWith('@') parse swallowed such a FILE
// line as a header, clobbering the current stamp and dropping every path after
// it in that commit (live repro emptied the whole map).
describe('buildCreateStampMap — one batched git pass (F52), @-path safe (W6-M1)', () => {
    function gitAvailable() {
        try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
    }

    it.skipIf(!gitAvailable())('maps every file to its first-add stamp even when an @-prefixed path shares the commit', () => {
        const root = mkTmp();
        try {
            const run = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: '2026-05-01T10:00:00', GIT_COMMITTER_DATE: '2026-05-01T10:00:00' } });
            run(['init', '-b', 'main']);
            run(['config', 'user.name', 'T']);
            run(['config', 'user.email', 't@example.com']);
            run(['config', 'commit.gpgsign', 'false']);
            write(root, '@scope/pkg/a.js', 'a');
            write(root, 'plain.md', 'p');
            write(root, 'zz-after.md', 'z');
            run(['add', '-A']);
            run(['commit', '-m', 'seed']);

            const hist = mig.buildCreateStampMap(root);
            expect(hist).toBeTruthy();
            // All three files stamped — including the @-path itself and the
            // files listed AFTER it in the same commit (the old parse dropped both).
            expect(hist.map.get('@scope/pkg/a.js')).toBe('260501-1000');
            expect(hist.map.get('plain.md')).toBe('260501-1000');
            expect(hist.map.get('zz-after.md')).toBe('260501-1000');

            // stampFromMap resolves files directly and directories by prefix.
            expect(mig.stampFromMap(hist, path.join(root, 'plain.md'))).toBe('260501-1000');
            expect(mig.stampFromMap(hist, path.join(root, '@scope'))).toBe('260501-1000');
            expect(mig.stampFromMap(hist, path.join(root, 'never-added.md'))).toBeNull();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
