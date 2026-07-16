// AC→source map (skill-merger):
//   - no marker in dest → plain overwrite (pure template skill)
//   - bare tail marker in dest → template head refreshed, dest tail preserved verbatim
//   - source's own marker stub is dropped so the marker never doubles
//   - bare tail marker in dest but NO matching marker in source → dest's own head is
//     left untouched (never duplicated) — the fully-rewritten-file regression
//   - anchored inline fence: block re-inserted at the end of its anchor heading's
//     section in the refreshed template
//   - multiple fenced blocks under the same heading preserve relative order
//   - fenced block whose anchor heading no longer exists → recovered under a
//     synthesized orphan heading at EOF, reported in the return value
//   - marker/fence sentinel text INSIDE a documentation code fence (``` or ~~~) is
//     never mistaken for a live sentinel — the code-fence-blindness regression
//   - mergeSkillFile: fresh install (no dest) → verbatim copy
//   - mergeSkillFile: dest identical to merge result → changed=false
//   - stripAdopterOwned: removes both the marker tail AND fenced-block content, used
//     by fleet:diverge so Form-2-only adopter files don't false-positive as edited

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    hasProjectAdditions,
    splitAtMarker,
    extractFencedBlocks,
    reinsertFencedBlocks,
    stripAdopterOwned,
    mergeSkillContent,
    mergeSkillFile,
} = require('../_lib/skill-merger');
const { createTmpDir } = require('./_helpers/tmp-dir');

describe('hasProjectAdditions', () => {
    it('returns false for plain template text with no sentinel', () => {
        expect(hasProjectAdditions('# Skill\n\nJust body text.\n')).toBe(false);
    });

    it('returns true for a live bare tail marker', () => {
        expect(hasProjectAdditions('# Skill\n\n<!-- @@project-additions -->\nlocal stuff\n')).toBe(true);
    });

    it('returns true for a live fence start', () => {
        expect(hasProjectAdditions('## Section\n<!-- @@project-additions:start -->\nx\n<!-- @@project-additions:end -->\n')).toBe(true);
    });

    it('ignores a marker shown as a documentation example inside a code fence', () => {
        const text = [
            '# Doctrine',
            '',
            'The sentinel line:',
            '',
            '```',
            '<!-- @@project-additions -->',
            '```',
            '',
            'Rules follow.',
        ].join('\n');
        expect(hasProjectAdditions(text)).toBe(false);
    });

    it('ignores a fence pair shown as a documentation example inside a code fence', () => {
        const text = [
            '# Doctrine',
            '```',
            '<!-- @@project-additions:start -->',
            'example',
            '<!-- @@project-additions:end -->',
            '```',
        ].join('\n');
        expect(hasProjectAdditions(text)).toBe(false);
    });

    it('still detects a live marker that appears after an illustrative code fence', () => {
        const text = [
            '# Doctrine',
            '```',
            '<!-- @@project-additions -->',
            '```',
            '',
            '## Real section',
            '<!-- @@project-additions -->',
            'real local content',
        ].join('\n');
        expect(hasProjectAdditions(text)).toBe(true);
    });
});

describe('splitAtMarker', () => {
    it('returns the whole text as head with null tail when no live marker exists', () => {
        const { head, tail } = splitAtMarker('# Skill\nbody\n');
        expect(tail).toBeNull();
        expect(head).toBe('# Skill\nbody\n');
    });

    it('splits at the marker line, keeping the marker in the tail', () => {
        const text = '# Skill\nbody\n<!-- @@project-additions -->\nlocal note\n';
        const { head, tail } = splitAtMarker(text);
        expect(head).toBe('# Skill\nbody');
        expect(tail).toBe('<!-- @@project-additions -->\nlocal note\n');
    });

    it('does not split at a marker shown inside a documentation code fence', () => {
        const text = ['# Doc', '```', '<!-- @@project-additions -->', '```', 'more body'].join('\n');
        const { head, tail } = splitAtMarker(text);
        expect(tail).toBeNull();
        expect(head).toBe(text);
    });
});

describe('extractFencedBlocks', () => {
    it('returns no blocks for text with no fence pair', () => {
        expect(extractFencedBlocks('## Section\nbody\n')).toEqual([]);
    });

    it('extracts a block and anchors it to the nearest preceding heading', () => {
        const text = [
            '## Escalation rules',
            '- rule one',
            '<!-- @@project-additions:start -->',
            '- MFA.Hub-specific rule',
            '<!-- @@project-additions:end -->',
        ].join('\n');
        const blocks = extractFencedBlocks(text);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].anchorHeading).toBe('## Escalation rules');
        expect(blocks[0].anchorLevel).toBe(2);
        expect(blocks[0].raw).toContain('MFA.Hub-specific rule');
    });

    it('anchors to null when the fence appears before any heading', () => {
        const text = ['<!-- @@project-additions:start -->', 'x', '<!-- @@project-additions:end -->', '## Later'].join('\n');
        const blocks = extractFencedBlocks(text);
        expect(blocks[0].anchorHeading).toBeNull();
    });

    it('extracts multiple blocks under different headings in document order', () => {
        const text = [
            '## First',
            '<!-- @@project-additions:start -->',
            'A',
            '<!-- @@project-additions:end -->',
            '## Second',
            '<!-- @@project-additions:start -->',
            'B',
            '<!-- @@project-additions:end -->',
        ].join('\n');
        const blocks = extractFencedBlocks(text);
        expect(blocks.map((b) => b.anchorHeading)).toEqual(['## First', '## Second']);
    });

    it('ignores a fence pair shown as a documentation example inside a code fence', () => {
        const text = [
            '## Real section',
            '```',
            '<!-- @@project-additions:start -->',
            'example only',
            '<!-- @@project-additions:end -->',
            '```',
        ].join('\n');
        expect(extractFencedBlocks(text)).toEqual([]);
    });

    it('takes the rest of the file when the end sentinel is missing (defensive)', () => {
        const text = ['## Section', '<!-- @@project-additions:start -->', 'unterminated'].join('\n');
        const blocks = extractFencedBlocks(text);
        expect(blocks).toHaveLength(1);
        expect(blocks[0].raw).toContain('unterminated');
    });
});

describe('reinsertFencedBlocks', () => {
    it('inserts a block at the end of its anchor heading section, before the next same-level heading', () => {
        const template = ['## Escalation rules', '- rule one', '- rule two', '', '## Next section', 'other'].join('\n');
        const blocks = [{
            anchorHeading: '## Escalation rules',
            anchorLevel: 2,
            raw: '<!-- @@project-additions:start -->\n- local rule\n<!-- @@project-additions:end -->',
        }];
        const { content, orphans } = reinsertFencedBlocks(template, blocks);
        expect(orphans).toEqual([]);
        const lines = content.split('\n');
        const localIdx = lines.findIndex((l) => l.includes('local rule'));
        const nextHeadingIdx = lines.findIndex((l) => l === '## Next section');
        expect(localIdx).toBeGreaterThan(-1);
        expect(localIdx).toBeLessThan(nextHeadingIdx);
        expect(content).toContain('- rule one');
        expect(content).toContain('other');
    });

    it('inserts before a same-or-higher-level heading, not a deeper subsection', () => {
        const template = ['## Section', 'intro', '### Subsection', 'sub body', '## Next'].join('\n');
        const blocks = [{ anchorHeading: '## Section', anchorLevel: 2, raw: 'LOCAL_MARKER' }];
        const { content } = reinsertFencedBlocks(template, blocks);
        const lines = content.split('\n');
        const localIdx = lines.indexOf('LOCAL_MARKER');
        const subIdx = lines.indexOf('### Subsection');
        const nextIdx = lines.indexOf('## Next');
        // A deeper heading (###) does not stop the section — only ## or shallower does.
        expect(localIdx).toBeGreaterThan(subIdx);
        expect(localIdx).toBeLessThan(nextIdx);
    });

    it('reports an orphan and recovers it under a synthesized heading when the anchor is gone', () => {
        const template = ['## Renamed section', 'body'].join('\n');
        const blocks = [{ anchorHeading: '## Old section', anchorLevel: 2, raw: 'ORPHANED_CONTENT' }];
        const { content, orphans } = reinsertFencedBlocks(template, blocks);
        expect(orphans).toHaveLength(1);
        expect(content).toContain('Project-Specific Additions (recovered');
        expect(content).toContain('ORPHANED_CONTENT');
    });

    it('reports a null-anchor block as an orphan', () => {
        const template = ['## Section', 'body'].join('\n');
        const blocks = [{ anchorHeading: null, anchorLevel: 0, raw: 'NO_ANCHOR' }];
        const { orphans } = reinsertFencedBlocks(template, blocks);
        expect(orphans).toHaveLength(1);
    });
});

describe('mergeSkillContent', () => {
    it('overwrites verbatim when dest has no project additions', () => {
        const src = '# Skill v2\nnew body\n';
        const dst = '# Skill v1\nold body\n';
        const { content, preserved, orphans } = mergeSkillContent(src, dst);
        expect(content).toBe(src);
        expect(preserved).toBe(false);
        expect(orphans).toEqual([]);
    });

    it('preserves a bare tail marker section and drops the source stub if present', () => {
        const src = '# Skill v2\nnew body\n<!-- @@project-additions -->\n';
        const dst = '# Skill v1\nold body\n<!-- @@project-additions -->\nadopter notes\n';
        const { content, preserved } = mergeSkillContent(src, dst);
        expect(preserved).toBe(true);
        expect(content).toContain('# Skill v2');
        expect(content).toContain('new body');
        expect(content).toContain('adopter notes');
        expect(content).not.toContain('old body');
        // The marker line must not appear twice.
        expect(content.split('<!-- @@project-additions -->').length - 1).toBe(1);
    });

    it('does not duplicate content when the dest has a bare marker but the source has none (the fully-rewritten-file regression)', () => {
        // This is the shape of a reference doc an adopter rewrote almost entirely for
        // their own stack (every code example translated) while the template's own
        // copy of the same file never adopted the marker convention. Blindly using
        // "source has no marker -> src.head = whole source" duplicated the entire
        // shared body (a real shipped bug: two "## The Iron Law" sections in one file).
        const src = [
            '# TDD Enforcement Reference',
            '',
            '## The Iron Law',
            '',
            'NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST',
            '',
            '```typescript',
            'test(\'example\', () => {});',
            '```',
        ].join('\n');
        const dst = [
            '# TDD Enforcement Reference',
            '',
            '<!-- @@project-additions -->',
            '',
            '## The Iron Law',
            '',
            'NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST',
            '',
            '```csharp',
            '[Fact] public void Example() {}',
            '```',
        ].join('\n');
        const { content, preserved, headSuppressed } = mergeSkillContent(src, dst);
        expect(preserved).toBe(true);
        // Exactly one "## The Iron Law" heading — not duplicated.
        expect((content.match(/^## The Iron Law$/gm) || []).length).toBe(1);
        expect(content).toContain('[Fact] public void Example() {}');
        expect(content).not.toContain('test(\'example\', () => {});');
        // A genuine rewrite (the tail duplicates half the head's headings here) DOES
        // suppress the head refresh — this is the true-rewrite case F2 must keep.
        expect(headSuppressed).toBe(true);
    });

    it('does not suppress the head refresh on a single benign heading-name collision (F2)', () => {
        // The tail's "## Notes" section coincidentally shares a name with one of many
        // unrelated headings in the template head — this must NOT read as a rewrite of
        // the head and freeze every other template update.
        const src = [
            '# Skill v2',
            '## Setup',
            'new setup steps',
            '## Usage',
            'new usage steps',
            '## Notes',
            'generic template notes',
        ].join('\n');
        const dst = [
            '# Skill v1',
            '## Setup',
            'old setup steps',
            '## Usage',
            'old usage steps',
            '<!-- @@project-additions -->',
            '## Notes',
            'adopter-specific notes',
        ].join('\n');
        const { content, preserved, headSuppressed } = mergeSkillContent(src, dst);
        expect(preserved).toBe(true);
        expect(headSuppressed).toBe(false);
        // The head refreshed from source — new setup/usage steps landed.
        expect(content).toContain('new setup steps');
        expect(content).toContain('new usage steps');
        expect(content).not.toContain('old setup steps');
        // The adopter's tail (including its own "## Notes") is still preserved.
        expect(content).toContain('adopter-specific notes');
    });

    it('does not duplicate a Form-2 block that lives inside the Form-1 collision fallback head (combined-forms regression)', () => {
        // When Form 1 falls back to the dest's own (unrefreshed) head — because the
        // tail collides with the head candidate — that head may itself already contain
        // a Form-2 fenced block (e.g. an earlier section's anchored addition). Blindly
        // re-inserting on top of an already-present block duplicated it (a real shipped
        // bug: "## Test Strategy Template"'s example appeared twice in one file).
        const src = [
            '## Test Strategy Template',
            'generic placeholder example',
            '',
            '## Project-Specific Test Patterns',
            'generic self-description',
        ].join('\n');
        const dst = [
            '## Test Strategy Template',
            '',
            '<!-- @@project-additions:start -->',
            'concrete xUnit/bUnit example',
            '<!-- @@project-additions:end -->',
            '',
            '## Project-Specific Test Patterns',
            '<!-- @@project-additions -->',
            'MFA.Hub-specific conventions',
        ].join('\n');
        const { content } = mergeSkillContent(src, dst);
        expect((content.match(/concrete xUnit\/bUnit example/g) || []).length).toBe(1);
        expect((content.match(/^## Test Strategy Template$/gm) || []).length).toBe(1);
    });

    it('preserves an anchored fenced block across a template rewrite of the same section', () => {
        const src = [
            '## Escalation rules',
            '- new rule from the template',
            '',
            '## Other section',
            'unrelated',
        ].join('\n');
        const dst = [
            '## Escalation rules',
            '- old rule from the template',
            '<!-- @@project-additions:start -->',
            '- MFA.Hub-specific escalation rule',
            '<!-- @@project-additions:end -->',
            '',
            '## Other section',
            'unrelated',
        ].join('\n');
        const { content, preserved, orphans } = mergeSkillContent(src, dst);
        expect(preserved).toBe(true);
        expect(orphans).toEqual([]);
        expect(content).toContain('new rule from the template');
        expect(content).not.toContain('old rule from the template');
        expect(content).toContain('MFA.Hub-specific escalation rule');
    });

    it('does not treat a documentation example fence in dest as real project additions', () => {
        const src = '# Skill v2\nnew body\n';
        const dst = ['# Skill v1', 'old body', '```', '<!-- @@project-additions -->', '```'].join('\n');
        const { content, preserved } = mergeSkillContent(src, dst);
        expect(preserved).toBe(false);
        expect(content).toBe(src.replace(/\r\n/g, '\n'));
    });
});

describe('stripAdopterOwned', () => {
    it('returns the text unchanged when there is no project addition of either form', () => {
        const text = '## Section\nbody\n';
        expect(stripAdopterOwned(text)).toBe(text.replace(/\r\n/g, '\n'));
    });

    it('strips the bare tail marker section', () => {
        const text = '## Section\nbody\n<!-- @@project-additions -->\nadopter tail\n';
        const stripped = stripAdopterOwned(text);
        expect(stripped).not.toContain('adopter tail');
        expect(stripped).toContain('body');
    });

    it('strips anchored fenced-block content even with no bare tail marker (Form 2 only)', () => {
        const text = [
            '## Escalation rules',
            '- rule one',
            '<!-- @@project-additions:start -->',
            '- MFA.Hub-specific rule',
            '<!-- @@project-additions:end -->',
            '',
            '## Next',
            'other',
        ].join('\n');
        const stripped = stripAdopterOwned(text);
        expect(stripped).not.toContain('MFA.Hub-specific rule');
        expect(stripped).not.toContain('@@project-additions:start');
        expect(stripped).toContain('- rule one');
        expect(stripped).toContain('other');
    });

    it('makes two adopters with different local fenced content compare equal (the fleet:diverge false-positive fix)', () => {
        const templateHead = ['## Escalation rules', '- rule one', '', '## Next', 'other'].join('\n');
        const adopterA = [
            '## Escalation rules',
            '- rule one',
            '<!-- @@project-additions:start -->',
            '- Adopter A-specific rule',
            '<!-- @@project-additions:end -->',
            '',
            '## Next',
            'other',
        ].join('\n');
        const adopterB = [
            '## Escalation rules',
            '- rule one',
            '<!-- @@project-additions:start -->',
            '- Totally different Adopter B rule',
            '<!-- @@project-additions:end -->',
            '',
            '## Next',
            'other',
        ].join('\n');
        expect(stripAdopterOwned(adopterA)).toBe(templateHead);
        expect(stripAdopterOwned(adopterB)).toBe(templateHead);
    });
});

describe('mergeSkillFile', () => {
    let tmp;
    afterEach(() => tmp && tmp.cleanup());

    it('copies verbatim when dest does not exist (fresh install)', () => {
        tmp = createTmpDir();
        const src = tmp.write('src/SKILL.md', '# Skill\nbody\n');
        const dst = tmp.root + '/dst/SKILL.md';
        const result = mergeSkillFile(src, dst);
        expect(result.changed).toBe(true);
        expect(result.preserved).toBe(false);
        expect(result.detail).toBe('copied (fresh install)');
    });

    it('reports changed=false when merge output equals existing dest content', () => {
        tmp = createTmpDir();
        const text = '# Skill\nbody\n';
        const src = tmp.write('src/SKILL.md', text);
        const dst = tmp.write('dst/SKILL.md', text);
        const result = mergeSkillFile(src, dst);
        expect(result.changed).toBe(false);
        expect(result.detail).toBe('unchanged');
    });

    it('writes an orphan warning into detail when an anchor heading is missing', () => {
        tmp = createTmpDir();
        const src = tmp.write('src/SKILL.md', '## Renamed\nbody\n');
        const dst = tmp.write(
            'dst/SKILL.md',
            ['## Old heading', '<!-- @@project-additions:start -->', 'local', '<!-- @@project-additions:end -->'].join('\n'),
        );
        const result = mergeSkillFile(src, dst);
        expect(result.orphans).toHaveLength(1);
        expect(result.detail).toContain('WARNING');
        expect(result.detail).toContain('orphaned');
    });

    it('surfaces a visible WARNING in detail when a true-rewrite tail suppresses the head refresh (F2)', () => {
        tmp = createTmpDir();
        const src = tmp.write('src/SKILL.md', [
            '# TDD Enforcement Reference',
            '',
            '## The Iron Law',
            '',
            'NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST',
        ].join('\n'));
        const dst = tmp.write('dst/SKILL.md', [
            '# TDD Enforcement Reference',
            '',
            '<!-- @@project-additions -->',
            '',
            '## The Iron Law',
            '',
            'NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST (adopter-translated)',
        ].join('\n'));
        const result = mergeSkillFile(src, dst);
        expect(result.headSuppressed).toBe(true);
        expect(result.detail).toContain('WARNING');
        expect(result.detail).toContain('SUPPRESSED');
    });

    it('does not warn and refreshes the head on a single benign heading collision (F2)', () => {
        tmp = createTmpDir();
        const src = tmp.write('src/SKILL.md', [
            '# Skill v2', '## Setup', 'new setup steps', '## Usage', 'new usage', '## Notes', 'template notes',
        ].join('\n'));
        const dst = tmp.write('dst/SKILL.md', [
            '# Skill v1', '## Setup', 'old setup steps', '## Usage', 'old usage',
            '<!-- @@project-additions -->', '## Notes', 'adopter notes',
        ].join('\n'));
        const result = mergeSkillFile(src, dst);
        expect(result.headSuppressed).toBe(false);
        expect(result.detail).not.toContain('WARNING');
        expect(result.changed).toBe(true);
    });
});
