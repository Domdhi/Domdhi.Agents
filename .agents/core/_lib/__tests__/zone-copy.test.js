// AC→source map (P2.2 / zone-copy):
//   Exports: copyWithZoneEnforcement(srcPath, dstPath, zone, opts)
//   Returns: { action: string, diff?: string }
//   zone: 'template' | 'project' | 'mixed'
//   template — overwrites dest with src content
//   project  — skips, returns { action: 'skip' }
//   mixed without opts.merge — warns, returns { action: 'warn' }
//   mixed with opts.merge  — delegates to mergeAgentFile, returns { action: 'merge', changed, diff? }
//   opts.dryRun — no writes, action is 'would-copy' / 'would-merge' / 'skip' / 'warn'

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');
const { copyWithZoneEnforcement } = require('../../../../.agents/core/_lib/zone-copy');

let tmp;

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'zone-copy-test-' });
});

afterEach(() => {
    tmp.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// template zone
// ─────────────────────────────────────────────────────────────────────────────

describe('copyWithZoneEnforcement — template zone', () => {
    it('copies src to dest and returns action=copy', () => {
        const srcPath = tmp.write('src/gate.js', '// gate');
        const destPath = path.join(tmp.root, 'dest/core/gate.js');

        const result = copyWithZoneEnforcement(srcPath, destPath, 'template', {});

        expect(result.action).toBe('copy');
        expect(fs.existsSync(destPath)).toBe(true);
        expect(fs.readFileSync(destPath, 'utf8')).toBe('// gate');
    });

    it('creates parent directories when they do not exist', () => {
        const srcPath = tmp.write('src/deep/nested/file.js', 'content');
        const destPath = path.join(tmp.root, 'dest/deep/nested/file.js');

        copyWithZoneEnforcement(srcPath, destPath, 'template', {});

        expect(fs.existsSync(destPath)).toBe(true);
    });

    it('overwrites existing dest file', () => {
        const srcPath = tmp.write('src/gate.js', 'new-content');
        const destPath = tmp.write('dest/gate.js', 'old-content');

        copyWithZoneEnforcement(srcPath, destPath, 'template', {});

        expect(fs.readFileSync(destPath, 'utf8')).toBe('new-content');
    });

    it('returns action=would-copy in dry-run mode without writing', () => {
        const srcPath = tmp.write('src/gate.js', '// gate');
        const destPath = path.join(tmp.root, 'dest/core/gate.js');

        const result = copyWithZoneEnforcement(srcPath, destPath, 'template', { dryRun: true });

        expect(result.action).toBe('would-copy');
        expect(fs.existsSync(destPath)).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// project zone
// ─────────────────────────────────────────────────────────────────────────────

describe('copyWithZoneEnforcement — project zone', () => {
    it('returns action=skip without touching dest', () => {
        const srcPath = tmp.write('src/settings.json', '{}');
        const destPath = path.join(tmp.root, 'dest/settings.json');

        const result = copyWithZoneEnforcement(srcPath, destPath, 'project', {});

        expect(result.action).toBe('skip');
        expect(fs.existsSync(destPath)).toBe(false);
    });

    it('does not overwrite an existing dest file in project zone', () => {
        const srcPath = tmp.write('src/settings.json', '{"new": true}');
        const destPath = tmp.write('dest/settings.json', '{"old": true}');

        copyWithZoneEnforcement(srcPath, destPath, 'project', {});

        expect(fs.readFileSync(destPath, 'utf8')).toBe('{"old": true}');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// mixed zone — no --merge
// ─────────────────────────────────────────────────────────────────────────────

describe('copyWithZoneEnforcement — mixed zone (no merge)', () => {
    it('returns action=warn without writing', () => {
        const srcPath = tmp.write('src/agents/forge.md', '# Forge\n\n## Skills\n\nsome-skill\n');
        const destPath = path.join(tmp.root, 'dest/agents/forge.md');

        const result = copyWithZoneEnforcement(srcPath, destPath, 'mixed', {});

        expect(result.action).toBe('warn');
        expect(fs.existsSync(destPath)).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// mixed zone — with --merge
// ─────────────────────────────────────────────────────────────────────────────

describe('copyWithZoneEnforcement — mixed zone (merge)', () => {
    it('returns action=merge when dest does not exist (fresh install)', () => {
        const srcPath = tmp.write('src/agents/forge.md', '---\nname: forge\nmodel: sonnet\n---\n\n# Forge\n\n## Skills\n\nsome-skill\n');
        const destPath = path.join(tmp.root, 'dest/agents/forge.md');

        const result = copyWithZoneEnforcement(srcPath, destPath, 'mixed', { merge: true });

        expect(result.action).toBe('merge');
        expect(fs.existsSync(destPath)).toBe(true);
    });

    it('preserves personalization when merging existing dest', () => {
        const srcContent = '---\nname: forge\nmodel: sonnet\n---\n\n# Forge (Updated)\n\nNew soul.\n\n## Skills\n\nnew-skill\n';
        const destContent = '---\nname: forge\nnickname: MyForge\nmodel: sonnet\n---\n\n# Forge (Custom)\n\nCustom soul.\n\n## Skills\n\nold-skill\n';

        const srcPath = tmp.write('src/agents/forge.md', srcContent);
        const destPath = tmp.write('dest/agents/forge.md', destContent);

        const result = copyWithZoneEnforcement(srcPath, destPath, 'mixed', { merge: true });

        expect(result.action).toBe('merge');
        const merged = fs.readFileSync(destPath, 'utf8');
        // nickname preserved
        expect(merged).toContain('nickname: MyForge');
        // soul preserved
        expect(merged).toContain('Custom soul');
        // skills updated
        expect(merged).toContain('new-skill');
    });

    it('returns action=would-merge in dry-run mode without writing', () => {
        const srcPath = tmp.write('src/agents/forge.md', '---\nname: forge\nmodel: sonnet\n---\n\n# Forge\n\n## Skills\n\nsome-skill\n');
        const destPath = path.join(tmp.root, 'dest/agents/forge.md');

        const result = copyWithZoneEnforcement(srcPath, destPath, 'mixed', { merge: true, dryRun: true });

        expect(result.action).toBe('would-merge');
        expect(fs.existsSync(destPath)).toBe(false);
    });
});
