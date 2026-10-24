// AC→source map (settings-merger):
//   - hooks block overwritten from template
//   - plansDirectory default updated from template
//   - statusLine pointer overwritten from template (wiring at core/statusline.sh)
//   - permissions/env/$schema/custom keys preserved from dest
//   - --dry-run writes nothing
//   - idempotency: second run with same inputs → action='unchanged', no write
//   - missing dest file → copy template verbatim
//   - malformed dest JSON → warn and skip (never corrupt)
//   - settings.local.json + update-config.json ALWAYS skipped by template-updater

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { mergeSettingsFile, TEMPLATE_OWNED_KEYS, PROJECT_OWNED_KEYS } = require('../../../.agents/core/_lib/settings-merger');
const updater = require('../../../.agents/core/template-updater');
const { runUpdate } = updater;
const { createTmpDir } = require('./_helpers/tmp-dir');

// Symlink-capability probe — Windows checkouts without Developer Mode cannot
// create symlinks; skip those tests rather than fail (mirrors fs-safe.test.js).
const canSymlink = (() => {
    const probeDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'settings-symlink-probe-'));
    try {
        fs.writeFileSync(path.join(probeDir, 't.txt'), 'x');
        fs.symlinkSync(path.join(probeDir, 't.txt'), path.join(probeDir, 'l.txt'));
        return true;
    } catch {
        return false;
    } finally {
        fs.rmSync(probeDir, { recursive: true, force: true });
    }
})();

// ── Fixtures ───────────────────────────────────────────────────────────────────

/** Minimal template settings.json with all relevant sections */
const TEMPLATE_SETTINGS = {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    plansDirectory: './docs/.output/plans',
    statusLine: {
        type: 'command',
        command: 'bash "$CLAUDE_PROJECT_DIR/.claude/core/statusline.sh"',
    },
    env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    },
    permissions: {
        allow: ['Bash(git status)', 'Bash(node:*)'],
        deny: [],
    },
    hooks: {
        SessionStart: [
            {
                matcher: '',
                hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start-prime.cjs"' }],
            },
        ],
        PreToolUse: [
            {
                matcher: 'Write',
                hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/secret-scanner.cjs"' }],
            },
        ],
        Stop: [
            {
                matcher: '',
                hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/memory-capture.cjs"' }],
            },
        ],
    },
};

/** Adopter's existing settings.json (older — missing some hooks, different permissions) */
const ADOPTER_SETTINGS = {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    plansDirectory: './custom/plans',  // will be overwritten (template-owned)
    statusLine: {
        type: 'command',
        command: 'echo my-custom-statusline',  // will be overwritten (template-owned wiring)
    },
    env: {
        MY_PROJECT_VAR: 'hello',               // project-owned — must survive
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0',
    },
    permissions: {
        allow: ['Bash(npm:*)', 'Bash(git status)'],  // project-owned — must survive
        deny: ['Bash(rm:*)'],
    },
    hooks: {
        // Old partial hooks — will be fully replaced by template
        SessionStart: [
            {
                matcher: '',
                hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/OLD-hook.cjs"' }],
            },
        ],
    },
    myCustomKey: 'custom-value-must-survive',  // unknown top-level key
};

let tmp;

beforeEach(() => {
    tmp = createTmpDir();
});

afterEach(() => {
    tmp.cleanup();
});

// ── Policy constants sanity checks ────────────────────────────────────────────

describe('TEMPLATE_OWNED_KEYS / PROJECT_OWNED_KEYS constants', () => {
    it('TEMPLATE_OWNED_KEYS includes hooks, plansDirectory, and statusLine', () => {
        expect(TEMPLATE_OWNED_KEYS).toContain('hooks');
        expect(TEMPLATE_OWNED_KEYS).toContain('plansDirectory');
        // statusLine is wiring at core/statusline.sh — template-owned (like hooks).
        expect(TEMPLATE_OWNED_KEYS).toContain('statusLine');
    });

    it('PROJECT_OWNED_KEYS includes permissions, env, $schema', () => {
        expect(PROJECT_OWNED_KEYS).toContain('permissions');
        expect(PROJECT_OWNED_KEYS).toContain('env');
        expect(PROJECT_OWNED_KEYS).toContain('$schema');
    });

    it('hooks is NOT in PROJECT_OWNED_KEYS', () => {
        expect(PROJECT_OWNED_KEYS).not.toContain('hooks');
    });

    it('plansDirectory is NOT in PROJECT_OWNED_KEYS', () => {
        expect(PROJECT_OWNED_KEYS).not.toContain('plansDirectory');
    });

    it('statusLine is NOT in PROJECT_OWNED_KEYS', () => {
        expect(PROJECT_OWNED_KEYS).not.toContain('statusLine');
    });
});

// ── Core merge behaviour ──────────────────────────────────────────────────────

describe('mergeSettingsFile — hooks block overwritten from template', () => {
    it('replaces the entire hooks block with the template value', () => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        const destPath = tmp.write('dest/settings.json', JSON.stringify(ADOPTER_SETTINGS, null, 2) + '\n');

        const result = mergeSettingsFile(srcPath, destPath);

        const out = JSON.parse(fs.readFileSync(destPath, 'utf8'));

        // Template hooks (SessionStart + PreToolUse + Stop) are present
        expect(out.hooks.SessionStart).toBeDefined();
        expect(out.hooks.PreToolUse).toBeDefined();
        expect(out.hooks.Stop).toBeDefined();

        // Old hook is gone
        const sessionStartCmds = out.hooks.SessionStart
            .flatMap(h => h.hooks)
            .map(h => h.command);
        expect(sessionStartCmds.join('')).not.toContain('OLD-hook.cjs');
        expect(sessionStartCmds.join('')).toContain('session-start-prime.cjs');

        expect(result.action).toBe('merged');
    });

    it('detail string mentions "hooks" when hooks changed', () => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        const destPath = tmp.write('dest/settings.json', JSON.stringify(ADOPTER_SETTINGS, null, 2) + '\n');

        const result = mergeSettingsFile(srcPath, destPath);

        expect(result.detail).toMatch(/hooks/);
    });

    // F17 (council-260715-2244): adopter settings.json is attacker-influenceable
    // repo content. A `"__proto__"` key parsed by JSON.parse is a plain own
    // property, but Object.assign's [[Set]] copy fires the inherited setter and
    // reassigns the merged object's prototype. The merge must keep it inert.
    it('a "__proto__" key in adopter settings cannot pollute the merged object (F17)', () => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        const destPath = tmp.write(
            'dest/settings.json',
            '{\n  "permissions": { "allow": [] },\n  "__proto__": { "polluted": "yes" },\n  "adopterKey": true\n}\n'
        );

        const result = mergeSettingsFile(srcPath, destPath);
        expect(['merged', 'unchanged']).toContain(result.action);

        // Global prototype untouched…
        expect({}.polluted).toBeUndefined();
        expect(Object.prototype.polluted).toBeUndefined();
        // …and the written file still carries the key as inert data (adopter
        // keys are never deleted) alongside preserved adopter content.
        const out = JSON.parse(fs.readFileSync(destPath, 'utf8'));
        expect(out.adopterKey).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    });
});

describe('mergeSettingsFile — plansDirectory overwritten from template', () => {
    it('replaces a custom plansDirectory with the template default', () => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        const destPath = tmp.write('dest/settings.json', JSON.stringify(ADOPTER_SETTINGS, null, 2) + '\n');

        mergeSettingsFile(srcPath, destPath);

        const out = JSON.parse(fs.readFileSync(destPath, 'utf8'));
        expect(out.plansDirectory).toBe('./docs/.output/plans');
        expect(out.plansDirectory).not.toBe('./custom/plans');
    });
});

describe('mergeSettingsFile — statusLine overwritten from template', () => {
    it('replaces the adopter statusLine pointer with the template wiring', () => {
        // statusLine points at the template-owned core/statusline.sh — it must
        // track the template, not stay frozen at the adopter's value. A genuinely
        // custom status line lives in settings.local.json (never synced).
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        const destPath = tmp.write('dest/settings.json', JSON.stringify(ADOPTER_SETTINGS, null, 2) + '\n');

        mergeSettingsFile(srcPath, destPath);

        const out = JSON.parse(fs.readFileSync(destPath, 'utf8'));
        expect(out.statusLine.command).toContain('statusline.sh');
        expect(out.statusLine.command).not.toContain('my-custom-statusline');
    });
});

describe('mergeSettingsFile — project-owned keys preserved', () => {
    it('keeps the adopter\'s permissions block', () => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        const destPath = tmp.write('dest/settings.json', JSON.stringify(ADOPTER_SETTINGS, null, 2) + '\n');

        mergeSettingsFile(srcPath, destPath);

        const out = JSON.parse(fs.readFileSync(destPath, 'utf8'));
        // Must keep adopter's permissions (not template's)
        expect(out.permissions.allow).toContain('Bash(npm:*)');
        expect(out.permissions.deny).toContain('Bash(rm:*)');
    });

    it('keeps the adopter\'s env block (including project-specific vars)', () => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        const destPath = tmp.write('dest/settings.json', JSON.stringify(ADOPTER_SETTINGS, null, 2) + '\n');

        mergeSettingsFile(srcPath, destPath);

        const out = JSON.parse(fs.readFileSync(destPath, 'utf8'));
        expect(out.env.MY_PROJECT_VAR).toBe('hello');
    });

    it('keeps unknown top-level keys from the adopter', () => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        const destPath = tmp.write('dest/settings.json', JSON.stringify(ADOPTER_SETTINGS, null, 2) + '\n');

        mergeSettingsFile(srcPath, destPath);

        const out = JSON.parse(fs.readFileSync(destPath, 'utf8'));
        expect(out.myCustomKey).toBe('custom-value-must-survive');
    });
});

// ── Adopter-authored hook preservation (the Domdhi.Agents adopter-build-guard case) ────

describe('mergeSettingsFile — adopter-authored hook registrations survive', () => {
    /** Adopter settings: template hooks + one custom guard appended in the same matcher group */
    const adopterWithCustomHook = () => ({
        ...ADOPTER_SETTINGS,
        hooks: {
            PreToolUse: [
                {
                    matcher: 'Write',
                    hooks: [
                        { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/secret-scanner.cjs"' },
                        { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/adopter-build-guard.cjs"' },
                    ],
                },
            ],
        },
    });

    const writeFixture = (adopterSettings) => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        tmp.write('src/hooks/secret-scanner.cjs', '// template hook');
        tmp.write('src/hooks/session-start-prime.cjs', '// template hook');
        tmp.write('src/hooks/memory-capture.cjs', '// template hook');
        const destPath = tmp.write('dest/settings.json', JSON.stringify(adopterSettings, null, 2) + '\n');
        return { srcPath, destPath };
    };

    it('preserves a custom hook whose script exists in the adopter hooks/ dir, in the same matcher group', () => {
        const { srcPath, destPath } = writeFixture(adopterWithCustomHook());
        tmp.write('dest/hooks/adopter-build-guard.cjs', '// adopter-authored guard');

        const result = mergeSettingsFile(srcPath, destPath);

        const out = JSON.parse(fs.readFileSync(destPath, 'utf8'));
        const writeGroup = out.hooks.PreToolUse.find(g => g.matcher === 'Write');
        const cmds = writeGroup.hooks.map(h => h.command);
        expect(cmds.some(c => c.includes('secret-scanner.cjs'))).toBe(true);
        expect(cmds.some(c => c.includes('adopter-build-guard.cjs'))).toBe(true);
        // Template hooks from other events still landed
        expect(out.hooks.SessionStart).toBeDefined();
        expect(out.hooks.Stop).toBeDefined();
        expect(result.detail).toContain('adopter-build-guard.cjs');
    });

    it('creates a new matcher group when the template has no group for it', () => {
        const adopter = adopterWithCustomHook();
        adopter.hooks.PostToolUse = [
            { matcher: 'Edit', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/my-edit-audit.cjs"' }] },
        ];
        const { srcPath, destPath } = writeFixture(adopter);
        tmp.write('dest/hooks/adopter-build-guard.cjs', '// adopter-authored guard');
        tmp.write('dest/hooks/my-edit-audit.cjs', '// adopter-authored audit');

        mergeSettingsFile(srcPath, destPath);

        const out = JSON.parse(fs.readFileSync(destPath, 'utf8'));
        const editGroup = out.hooks.PostToolUse.find(g => g.matcher === 'Edit');
        expect(editGroup).toBeDefined();
        expect(editGroup.hooks[0].command).toContain('my-edit-audit.cjs');
    });

    it('drops a fossil registration whose script file no longer exists anywhere', () => {
        const { srcPath, destPath } = writeFixture(adopterWithCustomHook());
        // NOTE: dest/hooks/adopter-build-guard.cjs deliberately NOT written

        const result = mergeSettingsFile(srcPath, destPath);

        const out = JSON.parse(fs.readFileSync(destPath, 'utf8'));
        expect(JSON.stringify(out.hooks)).not.toContain('adopter-build-guard.cjs');
        expect(result.detail).not.toContain('adopter-build-guard.cjs');
    });

    it('does NOT resurrect a template hook the template moved/removed (template stays authoritative)', () => {
        // Adopter registered memory-capture under an extra matcher; the template
        // ships memory-capture (src/hooks) registered only under Stop. The adopter's
        // extra registration must follow the template layout, not be re-inserted.
        const adopter = adopterWithCustomHook();
        adopter.hooks.PostToolUse = [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/memory-capture.cjs"' }] },
        ];
        const { srcPath, destPath } = writeFixture(adopter);
        tmp.write('dest/hooks/adopter-build-guard.cjs', '// adopter-authored guard');
        tmp.write('dest/hooks/memory-capture.cjs', '// synced template hook');

        mergeSettingsFile(srcPath, destPath);

        const out = JSON.parse(fs.readFileSync(destPath, 'utf8'));
        expect(out.hooks.PostToolUse).toBeUndefined();
        // …while its template-owned Stop registration is intact
        const stopCmds = out.hooks.Stop.flatMap(g => g.hooks).map(h => h.command);
        expect(stopCmds.join('')).toContain('memory-capture.cjs');
    });

    it('preserves an inline custom command (no hooks/ script reference)', () => {
        const adopter = adopterWithCustomHook();
        adopter.hooks.Stop = [
            {
                matcher: '',
                hooks: [
                    { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/memory-capture.cjs"' },
                    { type: 'command', command: 'pwsh -File tools/notify-teams.ps1' },
                ],
            },
        ];
        const { srcPath, destPath } = writeFixture(adopter);
        tmp.write('dest/hooks/adopter-build-guard.cjs', '// adopter-authored guard');

        mergeSettingsFile(srcPath, destPath);

        const out = JSON.parse(fs.readFileSync(destPath, 'utf8'));
        const stopGroup = out.hooks.Stop.find(g => (g.matcher ?? '') === '');
        const cmds = stopGroup.hooks.map(h => h.command);
        expect(cmds).toContain('pwsh -File tools/notify-teams.ps1');
        // memory-capture appears exactly once (template copy, no duplicate)
        expect(cmds.filter(c => c.includes('memory-capture.cjs'))).toHaveLength(1);
    });

    it('is idempotent: a second merge with a preserved hook returns unchanged', () => {
        const { srcPath, destPath } = writeFixture(adopterWithCustomHook());
        tmp.write('dest/hooks/adopter-build-guard.cjs', '// adopter-authored guard');

        mergeSettingsFile(srcPath, destPath);
        const afterFirst = fs.readFileSync(destPath, 'utf8');

        const result = mergeSettingsFile(srcPath, destPath);
        expect(result.action).toBe('unchanged');
        expect(fs.readFileSync(destPath, 'utf8')).toBe(afterFirst);
    });

    it('integration via runUpdate --merge: custom hook survives a real sync pass', () => {
        process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');
        tmp.write('src/.claude/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        tmp.write('src/.claude/hooks/secret-scanner.cjs', '// template hook');
        tmp.mkdir('target/.claude');
        tmp.write('target/.claude/settings.json', JSON.stringify(adopterWithCustomHook(), null, 2) + '\n');
        tmp.write('target/.claude/hooks/adopter-build-guard.cjs', '// adopter-authored guard');

        const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
        runUpdate(path.join(tmp.root, 'target'), { merge: true });
        spy.mockRestore();
        delete process.env.CLAUDE_PROJECT_DIR;

        const out = JSON.parse(fs.readFileSync(path.join(tmp.root, 'target/.claude/settings.json'), 'utf8'));
        const cmds = out.hooks.PreToolUse.flatMap(g => g.hooks).map(h => h.command);
        expect(cmds.some(c => c.includes('adopter-build-guard.cjs'))).toBe(true);
    });
});

// ── --dry-run ─────────────────────────────────────────────────────────────────

describe('mergeSettingsFile — --dry-run', () => {
    it('does not write any files under dry-run', () => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        const before = JSON.stringify(ADOPTER_SETTINGS, null, 2) + '\n';
        const destPath = tmp.write('dest/settings.json', before);

        mergeSettingsFile(srcPath, destPath, { dryRun: true });

        // File on disk must be unchanged
        expect(fs.readFileSync(destPath, 'utf8')).toBe(before);
    });

    it('returns action=merged (not unchanged) when there are real differences', () => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        const destPath = tmp.write('dest/settings.json', JSON.stringify(ADOPTER_SETTINGS, null, 2) + '\n');

        const result = mergeSettingsFile(srcPath, destPath, { dryRun: true });

        // hooks differ → should report merged (would update)
        expect(result.action).toBe('merged');
    });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe('mergeSettingsFile — idempotency', () => {
    it('second run on same inputs returns action=unchanged and does not rewrite the file', () => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        const destPath = tmp.write('dest/settings.json', JSON.stringify(ADOPTER_SETTINGS, null, 2) + '\n');

        // First run: real merge
        mergeSettingsFile(srcPath, destPath);
        const afterFirst = fs.readFileSync(destPath, 'utf8');
        const mtimeBefore = fs.statSync(destPath).mtimeMs;

        // Tiny delay to ensure mtime would differ if the file were rewritten
        // (not needed for the assertion, but makes the test more robust on slow FSes)

        // Second run: should be unchanged
        const result = mergeSettingsFile(srcPath, destPath);

        expect(result.action).toBe('unchanged');
        // Content must be byte-identical after both runs
        expect(fs.readFileSync(destPath, 'utf8')).toBe(afterFirst);
    });
});

// ── Missing dest ──────────────────────────────────────────────────────────────

describe('mergeSettingsFile — missing dest file', () => {
    it('copies the template verbatim when dest does not exist', () => {
        const srcContent = JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n';
        const srcPath = tmp.write('src/settings.json', srcContent);
        const destPath = path.join(tmp.root, 'dest/settings.json');
        // destPath intentionally not created

        const result = mergeSettingsFile(srcPath, destPath);

        expect(result.action).toBe('copied');
        expect(fs.existsSync(destPath)).toBe(true);
        expect(fs.readFileSync(destPath, 'utf8')).toBe(srcContent);
    });

    it('under dry-run: reports copied but does not create the file', () => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        const destPath = path.join(tmp.root, 'dest/settings.json');

        const result = mergeSettingsFile(srcPath, destPath, { dryRun: true });

        expect(result.action).toBe('copied');
        expect(fs.existsSync(destPath)).toBe(false);
    });
});

// ── Malformed dest ────────────────────────────────────────────────────────────

describe('mergeSettingsFile — malformed dest JSON', () => {
    it('returns action=skipped and does not throw', () => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        const destPath = tmp.write('dest/settings.json', '{ this is not valid json !!');

        let result;
        expect(() => {
            result = mergeSettingsFile(srcPath, destPath);
        }).not.toThrow();

        expect(result.action).toBe('skipped');
        expect(result.detail).toMatch(/not valid JSON/);
    });

    it('leaves the malformed file untouched', () => {
        const badContent = '{ this is not valid json !!';
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        const destPath = tmp.write('dest/settings.json', badContent);

        mergeSettingsFile(srcPath, destPath);

        // File must be unchanged — do not corrupt
        expect(fs.readFileSync(destPath, 'utf8')).toBe(badContent);
    });
});

// ── Symlink-safe writes (2B — MAJOR: writes go through safeWrite) ──────────────

describe('mergeSettingsFile — containRoot is threaded without changing output', () => {
    it('fresh-install with containRoot writes the template verbatim as a real file', () => {
        const srcContent = JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n';
        const srcPath = tmp.write('src/settings.json', srcContent);
        const containRoot = tmp.mkdir('fresh');
        const destPath = path.join(containRoot, 'settings.json');

        const result = mergeSettingsFile(srcPath, destPath, {}, containRoot);

        expect(result.action).toBe('copied');
        expect(fs.lstatSync(destPath).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(destPath, 'utf8')).toBe(srcContent);
    });

    it('merge output is byte-identical whether or not containRoot is passed', () => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        const adopterContent = JSON.stringify(ADOPTER_SETTINGS, null, 2) + '\n';
        const destA = tmp.write('a/settings.json', adopterContent);
        const destB = tmp.write('b/settings.json', adopterContent);

        mergeSettingsFile(srcPath, destA);                                // no containRoot (legacy default)
        mergeSettingsFile(srcPath, destB, {}, path.join(tmp.root, 'b'));  // containRoot threaded

        expect(fs.readFileSync(destB, 'utf8')).toBe(fs.readFileSync(destA, 'utf8'));
    });
});

describe.skipIf(!canSymlink)('mergeSettingsFile — symlink-safe writes (2B)', () => {
    it('does NOT follow a symlinked settings.json LEAF — external target unchanged, link replaced by a real file', () => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        // A victim file OUTSIDE the adopter root, holding valid-JSON (but foreign) content.
        const externalContent = JSON.stringify({ permissions: { allow: ['Bash(external)'] }, externalMarker: 'UNTOUCHED' }, null, 2) + '\n';
        const victim = tmp.write('external/victim.json', externalContent);
        // The adopter's settings.json is a symlink pointing at that external victim.
        const containRoot = tmp.mkdir('adopter');
        const destPath = path.join(containRoot, 'settings.json');
        fs.symlinkSync(victim, destPath);

        const result = mergeSettingsFile(srcPath, destPath, {}, containRoot);

        // The external target is byte-for-byte unchanged — the write did NOT follow the link.
        expect(fs.readFileSync(victim, 'utf8')).toBe(externalContent);
        // The dest is now a regular file (link replaced), carrying the merged output.
        expect(fs.lstatSync(destPath).isSymbolicLink()).toBe(false);
        const out = JSON.parse(fs.readFileSync(destPath, 'utf8'));
        expect(out.hooks.SessionStart).toBeDefined();
        expect(result.action).toBe('merged');
    });

    it('refuses to write settings.json through a symlinked ANCESTOR dir up to containRoot', () => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        // An external directory the attacker wants writes redirected into, seeded with a victim.
        const externalDir = tmp.mkdir('external-claude');
        const victim = tmp.write('external-claude/victim.txt', 'VICTIM-CONTENT');
        // Adopter root whose `.claude` is a symlink to that external directory.
        const containRoot = tmp.mkdir('adopter');
        fs.symlinkSync(externalDir, path.join(containRoot, '.claude'), 'dir');
        const destPath = path.join(containRoot, '.claude', 'settings.json');

        expect(() => mergeSettingsFile(srcPath, destPath, {}, containRoot)).toThrow(/symlinked ancestor/);

        // The external victim is untouched and no settings.json leaked through the link.
        expect(fs.readFileSync(victim, 'utf8')).toBe('VICTIM-CONTENT');
        expect(fs.existsSync(path.join(externalDir, 'settings.json'))).toBe(false);
    });
});

// ── Integration via runUpdate ─────────────────────────────────────────────────

describe('runUpdate — settings.json merge integration', () => {
    let originalProjectDir;

    beforeEach(() => {
        originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
    });

    afterEach(() => {
        if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    });

    const run = (opts) => {
        process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');
        const spy = vi.spyOn(console, 'log').mockImplementation(() => { });
        runUpdate(path.join(tmp.root, 'target'), opts || {});
        spy.mockRestore();
    };

    it('WITHOUT --merge: settings.json is skipped (project zone)', () => {
        tmp.write('src/.claude/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        tmp.mkdir('target/.claude');
        const before = JSON.stringify(ADOPTER_SETTINGS, null, 2) + '\n';
        tmp.write('target/.claude/settings.json', before);

        run({});  // no --merge

        // File must be byte-unchanged
        expect(fs.readFileSync(path.join(tmp.root, 'target/.claude/settings.json'), 'utf8')).toBe(before);
    });

    it('WITH --merge: hooks block is overwritten', () => {
        tmp.write('src/.claude/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        tmp.mkdir('target/.claude');
        tmp.write('target/.claude/settings.json', JSON.stringify(ADOPTER_SETTINGS, null, 2) + '\n');

        run({ merge: true });

        const out = JSON.parse(fs.readFileSync(path.join(tmp.root, 'target/.claude/settings.json'), 'utf8'));
        const sessionCmds = out.hooks.SessionStart.flatMap(h => h.hooks).map(h => h.command);
        expect(sessionCmds.join('')).toContain('session-start-prime.cjs');
        expect(sessionCmds.join('')).not.toContain('OLD-hook.cjs');
    });

    it('WITH --merge: permissions preserved', () => {
        tmp.write('src/.claude/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        tmp.mkdir('target/.claude');
        tmp.write('target/.claude/settings.json', JSON.stringify(ADOPTER_SETTINGS, null, 2) + '\n');

        run({ merge: true });

        const out = JSON.parse(fs.readFileSync(path.join(tmp.root, 'target/.claude/settings.json'), 'utf8'));
        expect(out.permissions.allow).toContain('Bash(npm:*)');
        expect(out.permissions.deny).toContain('Bash(rm:*)');
    });

    it('WITH --merge: settings.local.json is still ALWAYS skipped', () => {
        tmp.write('src/.claude/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        tmp.write('src/.claude/settings.local.json', JSON.stringify({ localKey: 'template-local' }, null, 2) + '\n');
        tmp.mkdir('target/.claude');
        const localBefore = JSON.stringify({ localKey: 'my-local' }, null, 2) + '\n';
        tmp.write('target/.claude/settings.local.json', localBefore);

        run({ merge: true });

        // settings.local.json must be untouched
        expect(fs.readFileSync(path.join(tmp.root, 'target/.claude/settings.local.json'), 'utf8')).toBe(localBefore);
    });

    it('WITH --merge + --dry-run: settings.json not written', () => {
        tmp.write('src/.claude/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        tmp.mkdir('target/.claude');
        const before = JSON.stringify(ADOPTER_SETTINGS, null, 2) + '\n';
        tmp.write('target/.claude/settings.json', before);

        run({ merge: true, dryRun: true });

        expect(fs.readFileSync(path.join(tmp.root, 'target/.claude/settings.json'), 'utf8')).toBe(before);
    });

    it('WITH --merge: unchanged after second run (idempotency)', () => {
        tmp.write('src/.claude/settings.json', JSON.stringify(TEMPLATE_SETTINGS, null, 2) + '\n');
        tmp.mkdir('target/.claude');
        tmp.write('target/.claude/settings.json', JSON.stringify(ADOPTER_SETTINGS, null, 2) + '\n');

        run({ merge: true });
        const afterFirst = fs.readFileSync(path.join(tmp.root, 'target/.claude/settings.json'), 'utf8');

        const logged = [];
        process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');
        const spy2 = vi.spyOn(console, 'log').mockImplementation((...args) => {
            logged.push(args.join(' '));
        });
        runUpdate(path.join(tmp.root, 'target'), { merge: true });
        spy2.mockRestore();

        expect(fs.readFileSync(path.join(tmp.root, 'target/.claude/settings.json'), 'utf8')).toBe(afterFirst);
        // Should report SKIP (unchanged), not MERGE
        const settingsLines = logged.filter(l => l.includes('settings.json'));
        expect(settingsLines.some(l => l.includes('SKIP'))).toBe(true);
    });
});

// NA6.7/NA6.11: the template's shell hooks match Bash|PowerShell, and its allowlist grants
// PowerShell twins. An adopter's own Bash-only shell hook and its Bash-only allow rules are
// kept as they are (adopter-owned), so the merge names them in a PowerShell notice.
describe('mergeSettingsFile — PowerShell coverage notice for adopter-owned shell settings', () => {
    const SHELL_TEMPLATE = {
        ...TEMPLATE_SETTINGS,
        permissions: { allow: ['Bash(git status)', 'Bash(node:*)', 'PowerShell(git status)', 'PowerShell(node:*)'], deny: [] },
        hooks: {
            ...TEMPLATE_SETTINGS.hooks,
            PreToolUse: [
                ...TEMPLATE_SETTINGS.hooks.PreToolUse,
                { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guardrail.cjs"' }] },
            ],
        },
    };
    const guard = name => ({ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${name}"` });
    const write = (adopter, hookFiles = []) => {
        const srcPath = tmp.write('src/settings.json', JSON.stringify(SHELL_TEMPLATE, null, 2) + '\n');
        for (const f of ['secret-scanner.cjs', 'session-start-prime.cjs', 'memory-capture.cjs', 'guardrail.cjs']) tmp.write(`src/hooks/${f}`, '// template hook');
        for (const f of hookFiles) tmp.write(`dest/hooks/${f}`, '// adopter-authored');
        const destPath = tmp.write('dest/settings.json', JSON.stringify(adopter, null, 2) + '\n');
        return { srcPath, destPath };
    };

    it('names a preserved adopter hook on Bash only and a Bash allow rule without its twin, and leaves both unchanged', () => {
        const adopter = {
            ...ADOPTER_SETTINGS,
            permissions: { allow: ['Bash(npm:*)', 'Bash(git status)', 'PowerShell(git status)'], deny: [] },
            hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [guard('adopter-build-guard.cjs')] }] },
        };
        const { srcPath, destPath } = write(adopter, ['adopter-build-guard.cjs']);
        const result = mergeSettingsFile(srcPath, destPath);
        expect(result.notices).toEqual([
            'adopter hook adopter-build-guard.cjs (PreToolUse matcher "Bash") does not match PowerShell',
            'allow rule Bash(npm:*) has no PowerShell(npm:*) twin',
        ]);
        expect(result.detail).toContain('PowerShell not covered: adopter hook adopter-build-guard.cjs (PreToolUse matcher "Bash") does not match PowerShell; allow rule Bash(npm:*) has no PowerShell(npm:*) twin');
        const out = JSON.parse(fs.readFileSync(destPath, 'utf8'));
        expect(out.permissions.allow).toEqual(['Bash(npm:*)', 'Bash(git status)', 'PowerShell(git status)']);
        expect(out.hooks.PreToolUse.find(g => g.matcher === 'Bash').hooks).toEqual([guard('adopter-build-guard.cjs')]);
    });

    it('emits no notice for adopter hooks that cover both shells or neither, nor for template hooks', () => {
        const adopter = {
            ...ADOPTER_SETTINGS,
            permissions: { allow: ['Bash(npm:*)', 'PowerShell(npm:*)', 'Read'], deny: [] },
            hooks: {
                PreToolUse: [
                    { matcher: 'Bash|PowerShell', hooks: [guard('both-shells.cjs'), guard('guardrail.cjs')] },
                    { matcher: 'Write', hooks: [guard('write-only.cjs')] },
                    { matcher: '', hooks: [guard('every-tool.cjs')] },
                ],
            },
        };
        const { srcPath, destPath } = write(adopter, ['both-shells.cjs', 'write-only.cjs', 'every-tool.cjs', 'guardrail.cjs']);
        const result = mergeSettingsFile(srcPath, destPath);
        expect(result.notices).toEqual([]);
        expect(result.detail).not.toContain('PowerShell not covered');
    });

    it('reports the notice on a dry run without writing, and again when the merge is otherwise unchanged', () => {
        const adopter = { ...ADOPTER_SETTINGS, permissions: { allow: ['Bash(npm:*)'], deny: [] }, hooks: {} };
        const { srcPath, destPath } = write(adopter);
        const before = fs.readFileSync(destPath, 'utf8');
        const dry = mergeSettingsFile(srcPath, destPath, { dryRun: true });
        expect(dry.notices).toEqual(['allow rule Bash(npm:*) has no PowerShell(npm:*) twin']);
        expect(dry.detail).toContain('PowerShell not covered');
        expect(fs.readFileSync(destPath, 'utf8')).toBe(before);
        mergeSettingsFile(srcPath, destPath);
        const again = mergeSettingsFile(srcPath, destPath);
        expect(again.action).toBe('unchanged');
        expect(again.notices).toEqual(['allow rule Bash(npm:*) has no PowerShell(npm:*) twin']);
        expect(again.detail).toContain('PowerShell not covered');
    });
});
