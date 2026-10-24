// AC→source map (skill-merger):
//   Exports: PROJECT_ADDITIONS_MARKER, hasProjectAdditions(text), splitAtMarker(text),
//            mergeSkillContent(src, dst), mergeSkillFile(srcPath, dstPath)
//   mergeSkillContent — dest has no marker → source verbatim (overwrite, preserved:false);
//                       dest has marker → source head + dest tail (preserved:true)
//   mergeSkillFile — dst missing: copy; dst present: refresh head, preserve tail
//                    returns { changed, preserved, detail }

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');
const {
    PROJECT_ADDITIONS_MARKER,
    hasProjectAdditions,
    splitAtMarker,
    mergeSkillContent,
    mergeSkillFile,
    stripAdopterOwned,
} = require('../../../../.agents/core/_lib/skill-merger');

let tmp;
beforeEach(() => { tmp = createTmpDir({ prefix: 'skill-merger-test-' }); });
afterEach(() => { tmp.cleanup(); });

describe('inherited inline additions', () => {
    const block = '<!-- @@project-additions:start -->\nRetained lesson.\n<!-- @@project-additions:end -->';
    const document = (foo, bar = '') => `# Skill\n\n## Foo\n\nShared body.\n\n${foo}\n\n## Bar\n\n${bar}\n`;
    const count = text => text.split(block).length - 1;

    it('retains one inherited source block and makes the second refresh byte-identical', () => {
        const source = document(block);
        const destination = source.replace('Shared body.', 'Old shared body.');
        const first = mergeSkillContent(source, destination);
        expect(first.content).toBe(source);
        expect(count(first.content)).toBe(1);
        expect(first.orphans).toEqual([]);
        expect(mergeSkillContent(source, first.content).content).toBe(first.content);
    });

    it('matches identical source content only at its own anchor and keeps the other anchor', () => {
        const source = document(block);
        const destination = document(block, block);
        const first = mergeSkillContent(source, destination);
        expect(count(first.content)).toBe(2);
        const [foo, bar] = first.content.split('## Bar');
        expect(count(foo)).toBe(1);
        expect(count(bar)).toBe(1);
        expect(mergeSkillContent(source, first.content).content).toBe(first.content);
    });

    it('consumes each inherited source occurrence once without deleting extra project occurrences', () => {
        const source = document(block);
        const first = mergeSkillContent(source, document(`${block}\n\n${block}`));
        expect(count(first.content)).toBe(2);
        expect(mergeSkillContent(source, first.content).content).toBe(first.content);
    });

    it('keeps differing source and project blocks at the same anchor without growth', () => {
        const source = document(block.replace('Retained lesson.', 'Incoming shared lesson.'));
        const first = mergeSkillContent(source, document(block));
        expect(count(first.content)).toBe(1);
        expect(first.content.split('Incoming shared lesson.').length - 1).toBe(1);
        expect(mergeSkillContent(source, first.content).content).toBe(first.content);
    });

    it.each([false, true])('keeps inline and whole-tail occurrences separate when source has an inherited block=%s', inherited => {
        const prefix = '# Skill\n\n## Foo\n\n';
        const source = prefix + 'Refreshed shared prose.\n\n' + (inherited ? block + '\n' : '');
        const inlineCount = inherited ? 2 : 1;
        const tail = PROJECT_ADDITIONS_MARKER + '\n\n' + block + '\n';
        const destination = prefix + 'Old shared prose.\n\n' + Array(inlineCount).fill(block).join('\n\n') + '\n\n' + tail;
        const first = mergeSkillContent(source, destination);
        expect(first.headSuppressed).toBe(false);
        expect(first.orphans).toEqual([]);
        expect(count(first.content)).toBe(inlineCount + 1);
        const parts = splitAtMarker(first.content);
        expect(count(parts.head)).toBe(inlineCount);
        expect(parts.tail).toBe(tail);
        expect(parts.head).toContain('Refreshed shared prose.');
        expect(parts.head).not.toContain('Old shared prose.');
        expect(mergeSkillContent(source, first.content).content).toBe(first.content);
    });
});

const MARKER = PROJECT_ADDITIONS_MARKER;

const SRC_V2 = `---
name: tailwind-css-patterns
description: Tailwind patterns
---

# Tailwind Patterns

Template body v2 — improved.
`;

const SRC_V1 = `---
name: tailwind-css-patterns
description: Tailwind patterns
---

# Tailwind Patterns

Template body v1.
`;

const DST_WITH_TAIL = `---
name: tailwind-css-patterns
description: Tailwind patterns
---

# Tailwind Patterns

Template body v1.

${MARKER}

## Project Additions

This project uses a custom \`brand-\` prefix and the \`obsidian-void\` palette.
`;

// ─────────────────────────────────────────────────────────────────────────────
// hasProjectAdditions / splitAtMarker
// ─────────────────────────────────────────────────────────────────────────────

describe('hasProjectAdditions', () => {
    it('detects the marker', () => {
        expect(hasProjectAdditions(DST_WITH_TAIL)).toBe(true);
    });
    it('is false when absent', () => {
        expect(hasProjectAdditions(SRC_V2)).toBe(false);
    });
});

describe('splitAtMarker', () => {
    it('returns null tail when no marker', () => {
        const { head, tail } = splitAtMarker(SRC_V2);
        expect(tail).toBeNull();
        expect(head).toBe(SRC_V2);
    });
    it('keeps the marker line intact in the tail', () => {
        const { head, tail } = splitAtMarker(DST_WITH_TAIL);
        expect(tail.startsWith(MARKER)).toBe(true);
        expect(head.includes(MARKER)).toBe(false);
        expect(head).toContain('Template body v1.');
    });
    it('handles a marker on the first line', () => {
        const text = `${MARKER}\nproject only\n`;
        const { head, tail } = splitAtMarker(text);
        expect(head).toBe('');
        expect(tail).toBe(text);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeSkillContent
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeSkillContent', () => {
    it('overwrites when dest has no marker (preserved:false)', () => {
        const r = mergeSkillContent(SRC_V2, SRC_V1);
        expect(r.preserved).toBe(false);
        expect(r.content).toBe(SRC_V2);
    });

    it('refreshes head and preserves tail when dest has marker', () => {
        const r = mergeSkillContent(SRC_V2, DST_WITH_TAIL);
        expect(r.preserved).toBe(true);
        // head refreshed to v2
        expect(r.content).toContain('Template body v2 — improved.');
        expect(r.content).not.toContain('Template body v1.');
        // tail preserved
        expect(r.content).toContain('obsidian-void');
        expect(r.content).toContain(MARKER);
        // exactly one marker
        expect(r.content.split(MARKER).length - 1).toBe(1);
    });

    it('does not duplicate the marker when source also ships a stub', () => {
        const srcWithStub = `${SRC_V2}\n${MARKER}\n`;
        const r = mergeSkillContent(srcWithStub, DST_WITH_TAIL);
        expect(r.content.split(MARKER).length - 1).toBe(1);
        // the dest's real additions win, not the source stub
        expect(r.content).toContain('obsidian-void');
        expect(r.content).toContain('Template body v2 — improved.');
    });

    it('ends with a trailing newline', () => {
        const r = mergeSkillContent(SRC_V2, DST_WITH_TAIL);
        expect(r.content.endsWith('\n')).toBe(true);
    });

    it('places exactly one blank line before the marker', () => {
        const r = mergeSkillContent(SRC_V2, DST_WITH_TAIL);
        const idx = r.content.indexOf(MARKER);
        const before = r.content.slice(0, idx);
        expect(before.endsWith('\n\n')).toBe(true);
        expect(before.endsWith('\n\n\n')).toBe(false);
    });

    it('normalizes CRLF in the overwrite path', () => {
        const r = mergeSkillContent('a\r\nb\r\n', 'old\n');
        expect(r.content).toBe('a\nb\n');
    });

    it('reinserts a fenced block AFTER a code example containing heading-shaped lines, never inside it', () => {
        // Live bug (2026-07-16, adopter qa-engineer sync): the anchor section's body is
        // a ```markdown example whose first line is `# Test Strategy: {Project Name}` —
        // the fence-blind next-heading scan saw that as the section end and spliced the
        // adopter's block INSIDE the code example, stranding its markers where the
        // fence-aware marker scan ignores them (silent clobber on the next sync).
        const src = [
            '# QA', '',
            '## Test Strategy Template', '',
            '```markdown',
            '# Test Strategy: {Project Name}',
            '## Testing Pyramid',
            'table here',
            '```', '',
            '## Test Patterns', '',
            'generic patterns', '',
        ].join('\n');
        const block = [
            '<!-- @@project-additions:start -->',
            'project strategy variant',
            '<!-- @@project-additions:end -->',
        ].join('\n');
        const dst = [
            '# QA', '',
            '## Test Strategy Template', '',
            block, '',
            '## Test Patterns', '',
            'old generic patterns', '',
        ].join('\n');

        const r = mergeSkillContent(src, dst);
        // The block must land between the example's closing fence and ## Test Patterns.
        const blockIdx = r.content.indexOf(block);
        expect(blockIdx).toBeGreaterThan(r.content.indexOf('table here\n```'));
        expect(blockIdx).toBeLessThan(r.content.indexOf('## Test Patterns'));
        // And the block's markers must still be OUTSIDE any fence (re-mergeable):
        // a second merge must keep exactly one copy, not clobber or duplicate it.
        const r2 = mergeSkillContent(src, r.content);
        expect(r2.content.split('project strategy variant').length - 1).toBe(1);
    });

    it('preserves BOTH blocks when two distinct anchored fences have byte-identical content (regression)', () => {
        // Bug: reinsertFencedBlocks used to pre-check idempotency via a content-wide
        // search for `block.raw` before inserting each block. Two DIFFERENT blocks
        // (different anchor headings) with byte-identical raw text collided: once
        // the first block was inserted under its heading, the second block's search
        // found that just-inserted copy and was skipped as "already present" — its
        // own insertion under its OWN heading never happened, silently dropping it.
        const block = [
            '<!-- @@project-additions:start -->',
            'shared identical text',
            '<!-- @@project-additions:end -->',
        ].join('\n');
        const src = [
            '# Skill', '',
            '## Foo', '',
            'generic foo body', '',
            '## Bar', '',
            'generic bar body', '',
        ].join('\n');
        const dst = [
            '# Skill', '',
            '## Foo', '',
            'generic foo body', '',
            block, '',
            '## Bar', '',
            'generic bar body', '',
            block, '',
        ].join('\n');

        const r = mergeSkillContent(src, dst);
        // Both occurrences must survive — one under ## Foo, one under ## Bar.
        expect(r.content.split('shared identical text').length - 1).toBe(2);
        const fooIdx = r.content.indexOf('## Foo');
        const barIdx = r.content.indexOf('## Bar');
        const firstBlockIdx = r.content.indexOf('shared identical text');
        const secondBlockIdx = r.content.indexOf('shared identical text', firstBlockIdx + 1);
        expect(firstBlockIdx).toBeGreaterThan(fooIdx);
        expect(firstBlockIdx).toBeLessThan(barIdx);
        expect(secondBlockIdx).toBeGreaterThan(barIdx);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// stripAdopterOwned — sibling of reinsertFencedBlocks, also uses
// findLineSubsequence per-block. Wave 6 review flagged this as verified-but-
// untested: unlike reinsertFencedBlocks, this function does NOT need identity
// between a logical block and its physical occurrence — each loop iteration
// searches the ALREADY-MUTATED `lines` array (prior occurrences spliced out),
// so two byte-identical blocks correctly resolve to two distinct occurrences,
// removed one at a time. This test proves that claim rather than just asserting it.
// ─────────────────────────────────────────────────────────────────────────────

describe('stripAdopterOwned', () => {
    it('strips BOTH occurrences of two distinct anchored fences with byte-identical content', () => {
        const block = [
            '<!-- @@project-additions:start -->',
            'shared identical text',
            '<!-- @@project-additions:end -->',
        ].join('\n');
        const text = [
            '# Skill', '',
            '## Foo', '',
            'generic foo body', '',
            block, '',
            '## Bar', '',
            'generic bar body', '',
            block, '',
        ].join('\n');

        const stripped = stripAdopterOwned(text);

        expect(stripped).not.toContain('shared identical text');
        expect(stripped).toContain('## Foo');
        expect(stripped).toContain('## Bar');
        expect(stripped).toContain('generic foo body');
        expect(stripped).toContain('generic bar body');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeSkillFile
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeSkillFile', () => {
    it('copies on fresh install (dst missing)', () => {
        const src = path.join(tmp.root, 'src.md');
        const dst = path.join(tmp.root, 'sub', 'dst.md');
        fs.writeFileSync(src, SRC_V2);
        const r = mergeSkillFile(src, dst);
        expect(r.changed).toBe(true);
        expect(r.preserved).toBe(false);
        expect(fs.readFileSync(dst, 'utf8')).toBe(SRC_V2);
    });

    it('preserves the project tail across a head refresh', () => {
        const src = path.join(tmp.root, 'src.md');
        const dst = path.join(tmp.root, 'dst.md');
        fs.writeFileSync(src, SRC_V2);
        fs.writeFileSync(dst, DST_WITH_TAIL);
        const r = mergeSkillFile(src, dst);
        expect(r.changed).toBe(true);
        expect(r.preserved).toBe(true);
        const out = fs.readFileSync(dst, 'utf8');
        expect(out).toContain('Template body v2 — improved.');
        expect(out).toContain('obsidian-void');
    });

    it('reports unchanged when head already current and tail intact', () => {
        const src = path.join(tmp.root, 'src.md');
        const dst = path.join(tmp.root, 'dst.md');
        fs.writeFileSync(src, SRC_V2);
        // dst built from the same v2 head + a tail → a second merge is a no-op
        fs.writeFileSync(dst, DST_WITH_TAIL);
        mergeSkillFile(src, dst);              // first merge → v2 head + tail
        const r = mergeSkillFile(src, dst);    // second merge → identical
        expect(r.changed).toBe(false);
        expect(r.preserved).toBe(true);
    });

    it('overwrites a markerless dst (no project additions)', () => {
        const src = path.join(tmp.root, 'src.md');
        const dst = path.join(tmp.root, 'dst.md');
        fs.writeFileSync(src, SRC_V2);
        fs.writeFileSync(dst, SRC_V1);
        const r = mergeSkillFile(src, dst);
        expect(r.preserved).toBe(false);
        expect(fs.readFileSync(dst, 'utf8')).toBe(SRC_V2);
    });
});
