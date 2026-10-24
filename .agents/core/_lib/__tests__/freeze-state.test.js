import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
const require = createRequire(import.meta.url);

describe('freeze-state', () => {
    let tmpRoot;
    let originalProjectDir;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-state-'));
        originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
        process.env.CLAUDE_PROJECT_DIR = tmpRoot;
        // Bust require cache so the module re-reads CLAUDE_PROJECT_DIR each test
        delete require.cache[require.resolve('../../../../.agents/core/_lib/freeze-state')];
    });

    afterEach(() => {
        if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('isFrozen_missingStateFile_returnsFalse', () => {
        const { isFrozen } = require('../../../../.agents/core/_lib/freeze-state');
        expect(isFrozen('/absolute/any/path.ts')).toBe(false);
    });

    it('listFrozen_missingStateFile_returnsEmptyArray', () => {
        const { listFrozen } = require('../../../../.agents/core/_lib/freeze-state');
        expect(listFrozen()).toEqual([]);
    });

    it('setFrozen_thenIsFrozen_roundtripsAbsolutePath', () => {
        const { setFrozen, isFrozen } = require('../../../../.agents/core/_lib/freeze-state');
        const frozenPath = path.join(tmpRoot, 'src/app.ts');
        setFrozen([frozenPath]);
        expect(isFrozen(frozenPath)).toBe(true);
        expect(isFrozen(path.join(tmpRoot, 'src/other.ts'))).toBe(false);
    });

    it('setFrozen_persistsToDiskAtExpectedPath', () => {
        const { setFrozen } = require('../../../../.agents/core/_lib/freeze-state');
        const frozenPath = path.join(tmpRoot, 'README.md');
        setFrozen([frozenPath]);
        const stateFile = path.join(tmpRoot, 'docs', '.output', '.state', 'freeze-state.json');
        expect(fs.existsSync(stateFile)).toBe(true);
        const content = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        expect(content.frozen).toEqual([frozenPath]);
    });

    it('setFrozen_replacesExistingList_notAppends', () => {
        const { setFrozen, listFrozen } = require('../../../../.agents/core/_lib/freeze-state');
        setFrozen(['/one']);
        setFrozen(['/two', '/three']);
        expect(listFrozen().sort()).toEqual(['/three', '/two']);
    });

    it('isFrozen_malformedStateFile_returnsFalseNoThrow', () => {
        const stateDir = path.join(tmpRoot, 'docs', '.output');
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, 'freeze-state.json'), 'not valid json ///');
        const { isFrozen } = require('../../../../.agents/core/_lib/freeze-state');
        expect(isFrozen('/anything')).toBe(false);
    });
});
