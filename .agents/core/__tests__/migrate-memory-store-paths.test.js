// AC→source: migrate-memory-store-paths.js — the memory store-path codemod
// (ADR 0006 Amendment 2, Wave 1b + the .md prose-sweep extension).
// Covers: each sub-path mapping (string + path.join array forms), curated-source
// routing, idempotency, the bare-catch-all boundary guard (no over-match), and the
// prose skip-list that protects historical/append-only records and test fixtures.

import { afterEach, describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { transform, isSkippedMd, walk, isNestedCheckout } = require('../../../.agents/core/migrate-memory-store-paths');

describe('migrate-memory-store-paths — transform RULES', () => {
    it('routes each derived/transient sub-path under .state/memory-*', () => {
        const cases = [
            ['docs/.output/memories/memories.db', 'docs/.output/.state/memory-index/memories.db'],
            ['docs/.output/memories/daily', 'docs/.output/.state/memory-daily'],
            ['docs/.output/memories/_inbox', 'docs/.output/.state/memory-inbox'],
            ['docs/.output/memories/concepts', 'docs/.output/.state/memory-concepts'],
            ['docs/.output/memories/pending-curation', 'docs/.output/.state/memory-pending-curation'],
            ['docs/.output/memories/extracted', 'docs/.output/.state/memory-extracted'],
        ];
        for (const [input, expected] of cases) {
            expect(transform(input).out).toBe(expected);
        }
    });

    it('routes the curated category source onto the tracked .memory/ root', () => {
        expect(transform('docs/.output/memories/patterns/x.json').out)
            .toBe('docs/.output/.memory/patterns/x.json');
        expect(transform('docs/.output/memories/{cat}/{id}.json').out)
            .toBe('docs/.output/.memory/{cat}/{id}.json');
        // bare directory reference
        expect(transform('git add docs/.output/memories/').out)
            .toBe('git add docs/.output/.memory/');
    });

    it('rewrites the path.join array form too', () => {
        expect(transform("path.join(root, 'docs', '.output', 'memories', 'daily')").out)
            .toBe("path.join(root, 'docs', '.output', '.state', 'memory-daily')");
        expect(transform("['docs', '.output', 'memories']").out)
            .toBe("['docs', '.output', '.memory']");
    });

    it('is idempotent — a second pass changes nothing', () => {
        const once = transform('docs/.output/memories/daily and docs/.output/memories/patterns/a.json').out;
        const twice = transform(once).out;
        expect(twice).toBe(once);
        expect(twice).not.toContain('.output/memories');
    });

    it('does NOT over-match a longer token (the boundary guard)', () => {
        // a hypothetical sibling dir must survive untouched
        expect(transform('docs/.output/memories-backup/old.json').out)
            .toBe('docs/.output/memories-backup/old.json');
        expect(transform('docs/.output/memoriesX').out).toBe('docs/.output/memoriesX');
    });
});

describe('migrate-memory-store-paths — isSkippedMd (historical-record protection)', () => {
    it('skips append-only / historical records the codemod must never rewrite', () => {
        expect(isSkippedMd('docs/architecture/decisions/0006-x.md', '0006-x.md')).toBe(true);
        expect(isSkippedMd('docs/work/scratch/2026-06-14/x/r.md', 'r.md')).toBe(true);
        expect(isSkippedMd('docs/.output/handoffs/2026-06/h.md', 'h.md')).toBe(true);
        expect(isSkippedMd('docs/work/todo/TODO_wave-1b-memory-split.md', 'TODO_wave-1b-memory-split.md')).toBe(true);
        expect(isSkippedMd('docs/work/timeline.md', 'timeline.md')).toBe(true);
        expect(isSkippedMd('CHANGELOG.md', 'CHANGELOG.md')).toBe(true);
    });

    it('does NOT skip live-contract prose (commands, skills, reference docs)', () => {
        expect(isSkippedMd('.claude/commands/do.md', 'do.md')).toBe(false);
        expect(isSkippedMd('.claude/skills/session-handoff/SKILL.md', 'SKILL.md')).toBe(false);
        expect(isSkippedMd('docs/reference/concepts/memory.md', 'memory.md')).toBe(false);
        // an active (non-wave-1b) TODO is still swept
        expect(isSkippedMd('docs/work/todo/TODO_memory-value-system.md', 'TODO_memory-value-system.md')).toBe(false);
    });
});

describe('migrate-memory-store-paths — walk() scan-scope guard', () => {
    let tmp;
    afterEach(() => { if (tmp) { fs.rmSync(tmp, { recursive: true, force: true }); tmp = null; } });

    function mk(rel, body = 'x') {
        const abs = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body);
    }

    it('never descends into archived history, worktrees/, or a nested git checkout', () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmsp-walk-'));
        mk('live/keep.md');                 // ordinary file — must be collected
        mk('.archive/old.md');              // archived history — skip
        mk('_archive/older.md');            // archived history — skip
        mk('worktrees/wt/leak.md');         // conventional worktree home — skip by dir name
        mk('node_modules/dep/x.js');        // vendored — skip
        // a linked worktree placed OUTSIDE worktrees/ — marked by a `.git` entry
        mk('elsewhere/.git', 'gitdir: /somewhere');
        mk('elsewhere/leak.md');

        const found = walk(tmp).map((f) => path.relative(tmp, f).split(path.sep).join('/'));

        expect(found).toContain('live/keep.md');
        expect(found.some((f) => f.includes('.archive/') || f.includes('_archive/'))).toBe(false);
        expect(found.some((f) => f.startsWith('worktrees/'))).toBe(false);
        expect(found.some((f) => f.startsWith('node_modules/'))).toBe(false);
        expect(found.some((f) => f.startsWith('elsewhere/'))).toBe(false); // nested-checkout guard
    });

    it('isNestedCheckout detects a directory holding a .git entry', () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmsp-nested-'));
        mk('repo/.git', 'gitdir: x');
        mk('plain/file.md');
        expect(isNestedCheckout(path.join(tmp, 'repo'))).toBe(true);
        expect(isNestedCheckout(path.join(tmp, 'plain'))).toBe(false);
    });
});
