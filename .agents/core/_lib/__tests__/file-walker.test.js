// AC→source map (P2.2 / file-walker):
//   Exports: walkDir*(rootDir, skipList) — generator yielding absolute file paths
//   skipList: array of directory names to skip (e.g. ['__tests__', '_helpers', 'node_modules'])
//   Uses temp dirs — never creates fixtures inside the repo

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const path = require('node:path');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');
const { walkDir } = require('../../../../.agents/core/_lib/file-walker');

let tmp;

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'file-walker-test-' });
});

afterEach(() => {
    tmp.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// walkDir generator
// ─────────────────────────────────────────────────────────────────────────────

describe('walkDir', () => {
    it('yields all files in a flat directory', () => {
        tmp.write('flat/a.md', 'a');
        tmp.write('flat/b.js', 'b');
        tmp.write('flat/c.cjs', 'c');

        const results = [...walkDir(path.join(tmp.root, 'flat'), [])];
        const names = results.map(f => path.basename(f)).sort();
        expect(names).toEqual(['a.md', 'b.js', 'c.cjs']);
    });

    it('yields files from nested subdirectories recursively', () => {
        tmp.write('tree/a.md', 'a');
        tmp.write('tree/sub/b.md', 'b');
        tmp.write('tree/sub/deep/c.md', 'c');

        const results = [...walkDir(path.join(tmp.root, 'tree'), [])];
        expect(results).toHaveLength(3);
    });

    it('skips directories named in the skipList', () => {
        tmp.write('proj/__tests__/foo.test.js', 'test');
        tmp.write('proj/real.js', 'real');

        const results = [...walkDir(path.join(tmp.root, 'proj'), ['__tests__'])];
        const names = results.map(f => path.basename(f));
        expect(names).toContain('real.js');
        expect(names).not.toContain('foo.test.js');
    });

    it('skips _helpers directory when listed in skipList', () => {
        tmp.write('proj/_helpers/helper.js', 'helper');
        tmp.write('proj/main.js', 'main');

        const results = [...walkDir(path.join(tmp.root, 'proj'), ['_helpers'])];
        const names = results.map(f => path.basename(f));
        expect(names).toContain('main.js');
        expect(names).not.toContain('helper.js');
    });

    it('skips node_modules when listed in skipList', () => {
        tmp.write('proj/node_modules/dep/index.js', 'dep');
        tmp.write('proj/src/index.js', 'src');

        const results = [...walkDir(path.join(tmp.root, 'proj'), ['node_modules'])];
        expect(results).toContain(path.join(tmp.root, 'proj', 'src', 'index.js'));
        expect(results).not.toContain(path.join(tmp.root, 'proj', 'node_modules', 'dep', 'index.js'));
    });

    it('skips multiple directories when all are in skipList', () => {
        tmp.write('proj/__tests__/test.js', 't');
        tmp.write('proj/_helpers/util.js', 'u');
        tmp.write('proj/node_modules/pkg/index.js', 'n');
        tmp.write('proj/legit/real.js', 'r');

        const results = [...walkDir(path.join(tmp.root, 'proj'), ['__tests__', '_helpers', 'node_modules'])];
        expect(results).toContain(path.join(tmp.root, 'proj', 'legit', 'real.js'));
        expect(results).not.toContain(path.join(tmp.root, 'proj', '__tests__', 'test.js'));
        expect(results).not.toContain(path.join(tmp.root, 'proj', '_helpers', 'util.js'));
        expect(results).not.toContain(path.join(tmp.root, 'proj', 'node_modules', 'pkg', 'index.js'));
        expect(results).toHaveLength(1);
    });

    it('yields absolute paths', () => {
        tmp.write('proj/file.md', 'content');
        const results = [...walkDir(path.join(tmp.root, 'proj'), [])];
        expect(results[0]).toBe(path.join(tmp.root, 'proj', 'file.md'));
    });

    it('returns no files for a non-existent directory', () => {
        const results = [...walkDir(path.join(tmp.root, 'does-not-exist'), [])];
        expect(results).toHaveLength(0);
    });

    it('works with an empty skipList — no directories skipped', () => {
        tmp.write('proj/__tests__/test.js', 'test');
        tmp.write('proj/real.js', 'real');

        // With empty skipList, __tests__ is NOT skipped
        const results = [...walkDir(path.join(tmp.root, 'proj'), [])];
        const names = results.map(f => path.basename(f));
        expect(names).toContain('test.js');
        expect(names).toContain('real.js');
    });
});
