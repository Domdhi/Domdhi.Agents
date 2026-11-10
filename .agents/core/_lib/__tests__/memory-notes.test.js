// AC→source map (memory-notes): native dir resolution, notes loading (live only), engine adapter (read-only, superseded excluded), shadowing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const N = require('../memory-notes');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');

let tmp;
beforeEach(() => { tmp = createTmpDir({ prefix: 'memory-notes-' }); });
afterEach(() => tmp.cleanup());

const note = (name, desc, body, extra = '') => `---\nname: ${name}\ndescription: "${desc}"\n${extra}---\n\n${body}\n`;

describe('native memory dir', () => {
    it('munges the project path the way Claude Code names its project dir', () => {
        const [input, munged] = process.platform === 'win32' ? ['C:\\work\\Project.Name', 'C--work-Project-Name'] : ['/srv/work/Project.Name', '-srv-work-Project-Name'];
        expect(N.mungePath(input)).toBe(munged);
    });
    it('honors CLAUDE_CONFIG_DIR and the MEMORY_DIR override', () => {
        const env = { CLAUDE_CONFIG_DIR: tmp.root };
        expect(N.defaultMemoryDir('/p/x', env)).toBe(path.join(tmp.root, 'projects', N.mungePath('/p/x'), 'memory'));
        expect(N.defaultMemoryDir('/p/x', { ...env, MEMORY_DIR: tmp.root + '/own' })).toBe(path.join(tmp.root, 'own'));
    });
});

describe('loadNotes', () => {
    it('loads live notes, skipping MEMORY.md, dot files, non-markdown, and retired notes', () => {
        const d = path.join(tmp.root, 'mem');
        fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'a.md'), note('alpha', 'first', 'alpha body'));
        fs.writeFileSync(path.join(d, 'MEMORY.md'), '- [alpha](a.md)\n');
        fs.writeFileSync(path.join(d, '.hidden.md'), note('h', 'h', 'h'));
        fs.writeFileSync(path.join(d, 'x.txt'), 'x');
        fs.writeFileSync(path.join(d, 'old.md'), note('old', 'retired', 'body', 'invalid_at: 2026-01-01\n'));
        fs.writeFileSync(path.join(d, 'sup.md'), note('sup', 'replaced', 'body', 'superseded_by: alpha\n'));
        const notes = N.loadNotes(d);
        expect(Object.keys(notes)).toEqual(['a.md']);
        expect(notes['a.md']).toMatchObject({ name: 'alpha', description: 'first', body: 'alpha body', source: 'notes' });
    });
    it('returns {} for a missing dir and falls back to the filename when frontmatter is absent', () => {
        expect(N.loadNotes(path.join(tmp.root, 'nope'))).toEqual({});
        const d = path.join(tmp.root, 'mem');
        fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'plain.md'), 'just text');
        expect(N.loadNotes(d)['plain.md'].name).toBe('plain');
    });
    it('changes sha when the file changes', () => {
        const d = path.join(tmp.root, 'mem');
        fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'a.md'), note('a', 'd', 'one'));
        const s1 = N.loadNotes(d)['a.md'].sha;
        fs.writeFileSync(path.join(d, 'a.md'), note('a', 'd', 'two'));
        expect(N.loadNotes(d)['a.md'].sha).not.toBe(s1);
    });
});

describe('engine adapter', () => {
    const engine = (root, cat, id, j) => {
        fs.mkdirSync(path.join(root, cat), { recursive: true });
        fs.writeFileSync(path.join(root, cat, `${id}.json`), JSON.stringify({ id, ...j }));
    };
    it('renders engine JSON as read-only documents and excludes superseded memories', () => {
        const root = path.join(tmp.root, '.memory');
        engine(root, 'constraints', 'bw-sync-first', { content: { description: 'Run bw sync before list. Cache is stale otherwise.', correct_pattern: 'bw sync', steps: ['a', 'b'] } });
        engine(root, 'patterns', 'retired', { invalid_at: '2026-02-01T00:00:00Z', content: { description: 'gone' } });
        fs.mkdirSync(path.join(root, 'patterns'), { recursive: true });
        fs.writeFileSync(path.join(root, 'patterns', 'broken.json'), '{nope');
        const docs = N.loadEngine(root);
        expect(Object.keys(docs)).toEqual(['engine:constraints/bw-sync-first.json']);
        const d = docs['engine:constraints/bw-sync-first.json'];
        expect(d.source).toBe('engine');
        expect(d.body).toContain('**Correct pattern:** bw sync');
        expect(d.body).toContain('- a\n- b');
        expect(d.description).toBe('Run bw sync before list');
    });
    it('a markdown note with the same name shadows its engine twin', () => {
        const root = path.join(tmp.root, '.memory');
        engine(root, 'constraints', 'bw-sync-first', { content: { description: 'engine copy' } });
        engine(root, 'constraints', 'other-one', { content: { description: 'only in engine' } });
        const d = path.join(tmp.root, 'mem');
        fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'bw-sync-first.md'), note('bw-sync-first', 'note copy', 'note body'));
        const corpus = N.loadCorpus({ memoryDir: d, engineRoot: root });
        expect(Object.keys(corpus).sort()).toEqual(['bw-sync-first.md', 'engine:constraints/other-one.json']);
    });
});
