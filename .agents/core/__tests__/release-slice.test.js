import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { checkReleaseSlices } = require('../release-slice');
const script = path.resolve('.agents/core/release-slice.js');

const HEADER = '| Story | Title | Size | Release | Tier | Wave | Status | Dependencies |\n|---|---|---|---|---|---|---|---|\n';
const row = (id, release, tier, wave, status, deps = 'None') => `| ${id} | Title ${id} | S | ${release} | ${tier} | ${wave} | ${status} | ${deps} |\n`;
const todo = rows => `# TODO: Fixture\n\n## Story Index\n\n${HEADER}${rows.join('')}\n**Total: ${rows.length} stories.**\n`;

// Mixed plan: two core waves, then one later wave.
const mixed = (statuses = ['[ ]', '[ ]', '[ ]', '[ ]']) => todo([
    row('F-1.1', 'core', 'deep', 1, statuses[0]),
    row('F-1.2', 'core', 'standard', 2, statuses[1], 'F-1.1'),
    row('F-2.1', 'later', 'deep', 3, statuses[2], 'F-1.2'),
    row('F-2.2', 'later', 'standard', 3, statuses[3], 'Story F-1.1, F-2.1'),
]);

describe('release slicing', () => {
    it('runs only the core slice while core stories are open', () => {
        const result = checkReleaseSlices(mixed(['[x]', '[ ]', '[ ]', '[ ]']));
        expect(result.ok).toBe(true);
        expect(result.phase).toBe('core');
        expect(result.next).toEqual(['F-1.2']);
        expect(result.slices).toEqual({ core: ['F-1.1', 'F-1.2'], later: ['F-2.1', 'F-2.2'] });
        expect(result.stories.map(s => s.tier)).toEqual(['deep', 'standard', 'deep', 'standard']);
    });

    it('stops at the ship gate once core is done and no go is recorded', () => {
        const result = checkReleaseSlices(mixed(['[x]', '[x]', '[ ]', '[ ]']));
        expect(result.ok).toBe(true);
        expect(result.phase).toBe('ship-gate');
        expect(result.next).toEqual([]);
    });

    it('continues into later stories only with --later-approved', () => {
        const result = checkReleaseSlices(mixed(['[x]', '[x]', '[x]', '[ ]']), { laterApproved: true });
        expect(result.phase).toBe('later');
        expect(result.next).toEqual(['F-2.2']);
    });

    it('reports complete when every story is done', () => {
        expect(checkReleaseSlices(mixed(['[x]', '[x]', '[x]', '[x]'])).phase).toBe('complete');
    });

    it('keeps a blocked core story in the core phase', () => {
        const result = checkReleaseSlices(mixed(['[x]', '[!]', '[ ]', '[ ]']));
        expect(result.phase).toBe('core');
        expect(result.next).toEqual(['F-1.2']);
    });

    it('a deferred core story leaves the slice with a warning', () => {
        const result = checkReleaseSlices(mixed(['[x]', '[~]', '[ ]', '[ ]']));
        expect(result.phase).toBe('ship-gate');
        expect(result.warnings.map(w => w.code)).toContain('CORE_STORY_DEFERRED');
    });
});

describe('plan errors', () => {
    const codes = text => checkReleaseSlices(text).errors.map(e => e.code);

    it('fails a core story that depends on a later story', () => {
        const text = todo([row('A-1', 'later', 'standard', 1, '[ ]'), row('A-2', 'core', 'deep', 2, '[ ]', 'A-1')]);
        expect(codes(text)).toContain('CORE_DEPENDS_ON_LATER');
    });

    it('fails a plan with no core slice', () => {
        expect(codes(todo([row('A-1', 'later', 'standard', 1, '[ ]')]))).toContain('NO_CORE_SLICE');
    });

    it('fails a later wave that starts before core ends', () => {
        const text = todo([row('A-1', 'core', 'deep', 1, '[ ]'), row('A-2', 'later', 'standard', 1, '[ ]'), row('A-3', 'core', 'deep', 2, '[ ]')]);
        expect(codes(text)).toContain('LATER_WAVE_BEFORE_CORE_END');
    });

    it.each([
        ['INVALID_RELEASE', row('A-1', 'mvp', 'deep', 1, '[ ]')],
        ['INVALID_TIER', row('A-1', 'core', 'high', 1, '[ ]')],
        ['INVALID_STATUS', row('A-1', 'core', 'deep', 1, 'done')],
        ['UNKNOWN_DEPENDENCY', row('A-1', 'core', 'deep', 1, '[ ]', 'Z-9')],
    ])('reports %s', (code, line) => {
        expect(codes(todo([line]))).toContain(code);
    });

    it('fails duplicate stories and mismatched rows', () => {
        expect(codes(todo([row('A-1', 'core', 'deep', 1, '[ ]'), row('A-1', 'core', 'deep', 1, '[ ]')]))).toContain('DUPLICATE_STORY');
        expect(codes(todo(['| A-1 | core | [ ] |\n']))).toContain('UNRECOGNIZED_INDEX_ROW');
    });

    it('ignores a Story Index example inside a fence and needs a real one', () => {
        const fenced = '```markdown\n## Story Index\n' + HEADER + row('A-1', 'core', 'deep', 1, '[ ]') + '```\n';
        expect(codes(fenced)).toContain('MISSING_STORY_INDEX');
    });

    it('reads a literal pipe inside a title cell', () => {
        const text = todo(['| A-1 | in \\| out | S | core | deep | 1 | [ ] | None |\n']);
        expect(checkReleaseSlices(text).ok).toBe(true);
    });
});

describe('legacy TODOs', () => {
    const legacy = '## Story Index\n\n| Story | Title | Wave | Status | Dependencies |\n|---|---|---|---|---|\n| L-1 | One | 1 | [x] | None |\n| L-2 | Two | 2 | [ ] | L-1 |\n';

    it('treats every story as core with a warning', () => {
        const result = checkReleaseSlices(legacy);
        expect(result.ok).toBe(true);
        expect(result.legacy).toBe(true);
        expect(result.phase).toBe('core');
        expect(result.next).toEqual(['L-2']);
        expect(result.warnings.map(w => w.code)).toEqual(['MISSING_RELEASE_COLUMN', 'MISSING_TIER_COLUMN']);
    });

    it('fails under --strict, the /todo self-review mode', () => {
        const result = checkReleaseSlices(legacy, { strict: true });
        expect(result.ok).toBe(false);
        expect(result.errors.map(e => e.code)).toEqual(['MISSING_RELEASE_COLUMN', 'MISSING_TIER_COLUMN']);
    });
});

describe('per-epic checklists without a Story Index', () => {
    const epic = (one = '', two = '[ ]', deps = 'Story 1.1') => `# Epic 1\n\n## Story 1.1: Engine ${one}\n\n**Dependencies:** None\n**Release:** core\n**Risk tier:** deep — money math\n\n**Tasks:**\n- [ ] Build\n\n---\n\n## Story 1.2: Saved plans ${two}\n\n**Dependencies:** ${deps}\n**Release:** later\n**Risk tier:** standard — wiring only\n`;

    it('reads Release, tier with its trigger, and an unmarked header as pending', () => {
        const result = checkReleaseSlices(epic());
        expect(result.ok).toBe(true);
        expect(result.source).toBe('story-headers');
        expect(result.stories.map(s => [s.id, s.release, s.tier, s.status])).toEqual([['1.1', 'core', 'deep', 'pending'], ['1.2', 'later', 'standard', 'pending']]);
        expect(result.next).toEqual(['1.1']);
    });

    it('reaches the ship gate from header markers', () => {
        expect(checkReleaseSlices(epic('[x]')).phase).toBe('ship-gate');
    });

    it('treats an untagged legacy checklist as one core slice', () => {
        const legacy = '## Story 2.1: One [x]\n**Dependencies:** None\n\n## Story 2.2: Two\n**Dependencies:** Story 2.1\n';
        const result = checkReleaseSlices(legacy);
        expect(result.ok).toBe(true);
        expect(result.legacy).toBe(true);
        expect(result.next).toEqual(['2.2']);
        expect(checkReleaseSlices(legacy, { strict: true }).ok).toBe(false);
    });
});

describe('dependencies across TODO files', () => {
    const other = (status, release = 'core') => new Map([['9.1', { id: '9.1', release, status, file: 'TODO_epic09.md' }]]);
    const text = todo([row('A-1', 'core', 'deep', 1, '[ ]', '9.1'), row('A-2', 'core', 'standard', 1, '[ ]')]);

    it('holds a story whose external dependency is open', () => {
        const result = checkReleaseSlices(text, { external: other('pending') });
        expect(result.ok).toBe(true);
        expect(result.blocked).toEqual(['A-1']);
        expect(result.next).toEqual(['A-2']);
        expect(result.external).toEqual([{ storyId: 'A-1', dependency: '9.1', file: 'TODO_epic09.md', status: 'pending' }]);
    });

    it('releases the story once the external dependency is done', () => {
        expect(checkReleaseSlices(text, { external: other('done') }).next).toEqual(['A-1', 'A-2']);
    });

    it('a deferred external dependency still holds the story', () => {
        expect(checkReleaseSlices(text, { external: other('deferred') }).blocked).toEqual(['A-1']);
    });

    it('fails a core story that depends on an external later story', () => {
        expect(checkReleaseSlices(text, { external: other('done', 'later') }).errors.map(e => e.code)).toContain('CORE_DEPENDS_ON_LATER');
    });

    it('fails an external dependency that no TODO declares', () => {
        expect(checkReleaseSlices(text).errors.map(e => e.code)).toContain('UNKNOWN_DEPENDENCY');
    });
});

describe('feature-wide slices across per-epic files', () => {
    const allLater = (status = '[ ]') => todo([row('7.1', 'later', 'deep', 1, status), row('7.2', 'later', 'standard', 2, '[ ]', '7.1')]);
    const sibling = (status, release = 'core') => new Map([['10.3', { id: '10.3', release, status, file: 'TODO_epic10.md' }]]);

    it('an all-later file waits while core is open in a sibling file', () => {
        const result = checkReleaseSlices(allLater(), { strict: true, external: sibling('pending') });
        expect(result.ok).toBe(true);
        expect(result.phase).toBe('core');
        expect(result.next).toEqual([]);
        expect(result.coreOpenElsewhere).toEqual([{ id: '10.3', file: 'TODO_epic10.md' }]);
    });

    it('later approval cannot start later work before the feature core is done', () => {
        expect(checkReleaseSlices(allLater(), { laterApproved: true, external: sibling('pending') }).phase).toBe('core');
    });

    it('reaches the ship gate once the sibling core is done', () => {
        const result = checkReleaseSlices(allLater(), { strict: true, external: sibling('done') });
        expect(result.phase).toBe('ship-gate');
        expect(checkReleaseSlices(allLater(), { laterApproved: true, external: sibling('done') }).next).toEqual(['7.1', '7.2']);
    });

    it('fails an all-later file when no file in the feature has core', () => {
        expect(checkReleaseSlices(allLater(), { external: sibling('done', 'later') }).errors.map(e => e.code)).toContain('NO_CORE_SLICE');
        expect(checkReleaseSlices(allLater()).errors.map(e => e.code)).toContain('NO_CORE_SLICE');
    });
});

describe('CLI', () => {
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

    it('reports the ship gate for a file and exits 0', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-slice-'));
        try {
            const file = path.join(dir, 'TODO.md');
            fs.writeFileSync(file, mixed(['[x]', '[x]', '[ ]', '[ ]']));
            const gate = run(file, '--strict');
            expect(gate.status).toBe(0);
            expect(JSON.parse(gate.stdout).phase).toBe('ship-gate');
            expect(JSON.parse(run(file, '--later-approved').stdout).phase).toBe('later');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('resolves --deps-from TODOs', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-slice-'));
        try {
            const main = path.join(dir, 'TODO_a.md');
            const dep = path.join(dir, 'TODO_b.md');
            fs.writeFileSync(main, todo([row('A-1', 'core', 'deep', 1, '[ ]', 'B-1')]));
            fs.writeFileSync(dep, todo([row('B-1', 'core', 'standard', 1, '[x]')]));
            expect(JSON.parse(run(main).stdout).errors[0].code).toBe('UNKNOWN_DEPENDENCY');
            const result = JSON.parse(run(main, '--deps-from', dep, '--strict').stdout);
            expect(result.ok).toBe(true);
            expect(result.next).toEqual(['A-1']);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('rejects unknown flags and missing files', () => {
        expect(run('x.md', '--deps-from').status).toBe(1);
        expect(run('x.md', '--yolo').status).toBe(1);
        expect(JSON.parse(run('x.md', '--yolo').stdout).errors[0].code).toBe('INVALID_ARGUMENTS');
        expect(JSON.parse(run(path.join(os.tmpdir(), 'no-such-todo.md')).stdout).errors[0].code).toBe('INVALID_TODO_FILE');
    });
});

describe('workflow wiring', () => {
    const read = rel => fs.readFileSync(path.resolve(rel), 'utf8');

    it('/todo self-review runs the strict release check', () => {
        expect(read('.agents/skills/todo/references/workflow.md')).toContain('release-slice.js "{TODO_PATH}" --strict');
    });

    it('/run-todo stops at the ship gate and needs a recorded go for later stories', () => {
        const text = read('.agents/skills/run-todo/references/workflow.md');
        expect(text).toContain('release-slice.js "{TODO_PATH}"');
        expect(text).toContain('#### Step 9a: Ship gate (core slice complete)');
        expect(text).toContain('--later-approved');
        expect(text).toContain('**Later slice go:**');
    });
});
