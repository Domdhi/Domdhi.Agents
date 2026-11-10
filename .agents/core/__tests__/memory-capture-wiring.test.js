// AC→source map (memory capture/recall wiring):
//   - Claude settings adapter registers memory-recall (UserPromptSubmit) and memory-session-capture (SessionEnd) with timeouts
//   - every registered script exists canonically and as a generated .claude wrapper; .claude/settings.json matches the adapter
//   - the settings --merge ships both hooks to an adopter that predates them, keeping the adopter's env (opt-in flags), permissions and own hooks
//   - Codex: neither hook is registered (documented parity limit); SessionStart prime still is
//   - the new code stays zero-dependency (Node builtins and relative files only)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../../..');
const ADAPTER = path.join(ROOT, '.agents/adapters/claude/settings.json');
const { mergeSettingsFile } = require('../_lib/settings-merger');
const { createTmpDir } = require('./_helpers/tmp-dir');

const adapter = JSON.parse(fs.readFileSync(ADAPTER, 'utf8'));
const commandsOf = (hooks, event) => (hooks[event] || []).flatMap(g => g.hooks.map(h => h.command));
const entry = (hooks, event, script) => (hooks[event] || []).flatMap(g => g.hooks).find(h => h.command.includes(script));

let tmp;
beforeEach(() => { tmp = createTmpDir({ prefix: 'memory-capture-wiring-' }); });
afterEach(() => tmp.cleanup());

describe('Claude settings adapter', () => {
    it('registers per-prompt recall under UserPromptSubmit with a timeout', () => {
        const h = entry(adapter.hooks, 'UserPromptSubmit', 'memory-recall.cjs');
        expect(h).toMatchObject({ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/memory-recall.cjs"' });
        expect(h.timeout).toBeLessThanOrEqual(10);
    });
    it('registers session capture under SessionEnd next to the doc-sync hook, with a timeout', () => {
        const cmds = commandsOf(adapter.hooks, 'SessionEnd');
        expect(cmds).toEqual(expect.arrayContaining([expect.stringContaining('session-end-doc-sync.cjs'), expect.stringContaining('memory-session-capture.cjs')]));
        expect(entry(adapter.hooks, 'SessionEnd', 'memory-session-capture.cjs').timeout).toBeLessThanOrEqual(10);
    });
    it('keeps the existing memory hooks (startup prime, Stop capture)', () => {
        expect(commandsOf(adapter.hooks, 'SessionStart').join()).toContain('session-start-prime.cjs');
        expect(commandsOf(adapter.hooks, 'Stop').join()).toContain('memory-capture.cjs');
    });
    it('every registered memory script exists canonically and as a generated .claude wrapper', () => {
        for (const script of ['memory-recall.cjs', 'memory-session-capture.cjs']) {
            expect(fs.existsSync(path.join(ROOT, '.agents/hooks', script))).toBe(true);
            const wrapper = fs.readFileSync(path.join(ROOT, '.claude/hooks', script), 'utf8');
            expect(wrapper).toContain(`.agents/hooks/${script}`);
        }
        for (const lib of ['memory-notes', 'memory-recall', 'memory-extract', 'memory-context']) {
            expect(fs.existsSync(path.join(ROOT, `.claude/core/_lib/${lib}.js`))).toBe(true);
            expect(fs.existsSync(path.join(ROOT, `.codex/core/_lib/${lib}.js`))).toBe(true);
        }
        expect(fs.existsSync(path.join(ROOT, '.claude/core/memory-capture.js'))).toBe(true);
        expect(fs.existsSync(path.join(ROOT, '.codex/core/memory-capture.js'))).toBe(true);
    });
    it('the generated .claude/settings.json carries the same hooks as the adapter', () => {
        const rendered = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
        expect(rendered.hooks).toEqual(adapter.hooks);
    });
});

describe('settings --merge into an adopter that predates the hooks', () => {
    const adopterSettings = {
        $schema: 'https://example.invalid/own-schema.json',
        env: { MEMORY_CAPTURE: 'on', MEMORY_CAPTURE_KEY_COMMAND: 'get-my-key', MEMORY_EMBED_PROVIDER: 'none' },
        permissions: { allow: ['Bash(make:*)'], deny: ['Bash(rm -rf:*)'] },
        hooks: {
            SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start-prime.cjs"' }] }],
            SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/session-end-doc-sync.cjs"' }, { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/adopter-notify.cjs"' }] }],
        },
    };
    const setup = () => {
        const dest = path.join(tmp.root, '.claude/settings.json');
        tmp.write('.claude/settings.json', JSON.stringify(adopterSettings, null, 2));
        tmp.write('.claude/hooks/adopter-notify.cjs', '// adopter hook');
        return dest;
    };

    it('adds both hooks, keeps adopter env/permissions/schema and the adopter\'s own hook, and is idempotent', () => {
        const dest = setup();
        const r = mergeSettingsFile(ADAPTER, dest, {}, tmp.root);
        expect(r.action).not.toBe('unchanged');
        const merged = JSON.parse(fs.readFileSync(dest, 'utf8'));
        expect(commandsOf(merged.hooks, 'UserPromptSubmit').join()).toContain('memory-recall.cjs');
        const sessionEnd = commandsOf(merged.hooks, 'SessionEnd').join();
        expect(sessionEnd).toContain('memory-session-capture.cjs');
        expect(sessionEnd).toContain('adopter-notify.cjs');
        expect(merged.env).toEqual(adopterSettings.env);              // the opt-in flags and key command survive a template update
        expect(merged.permissions).toEqual(adopterSettings.permissions);
        expect(merged.$schema).toBe(adopterSettings.$schema);
        expect(mergeSettingsFile(ADAPTER, dest, {}, tmp.root).action).toBe('unchanged');
    });
    it('a dry run writes nothing', () => {
        const dest = setup();
        const before = fs.readFileSync(dest, 'utf8');
        mergeSettingsFile(ADAPTER, dest, { dryRun: true }, tmp.root);
        expect(fs.readFileSync(dest, 'utf8')).toBe(before);
    });
    it('the opt-in flags belong in the project-owned env block, which the template never overwrites', () => {
        expect(adapter.env.MEMORY_CAPTURE).toBeUndefined();            // the template does not turn capture on
        expect(require('../_lib/settings-merger').TEMPLATE_OWNED_KEYS).not.toContain('env');
    });
});

describe('Codex parity (documented limit)', () => {
    const codex = JSON.parse(fs.readFileSync(path.join(ROOT, '.agents/adapters/codex/hooks-config.json'), 'utf8'));
    const text = JSON.stringify(codex);
    it('registers neither new hook and no UserPromptSubmit event', () => {
        expect(Object.keys(codex.hooks)).not.toContain('UserPromptSubmit');
        expect(text).not.toContain('memory-recall.cjs');
        expect(text).not.toContain('memory-session-capture.cjs');
    });
    it('still registers the SessionStart memory prime', () => {
        expect(text).toContain('session-start-prime.cjs');
    });
});

describe('zero-dependency guard', () => {
    const FILES = ['.agents/core/memory-capture.js', '.agents/core/_lib/memory-notes.js', '.agents/core/_lib/memory-recall.js', '.agents/core/_lib/memory-extract.js', '.agents/core/_lib/memory-context.js', '.agents/hooks/memory-recall.cjs', '.agents/hooks/memory-session-capture.cjs'];
    it('requires only Node builtins and relative files', () => {
        const builtins = new Set(require('node:module').builtinModules);
        for (const f of FILES) {
            const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
            for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
                const spec = m[1].replace(/^node:/, '');
                expect(spec.startsWith('.') || builtins.has(spec), `${f} requires ${m[1]}`).toBe(true);
            }
        }
    });
});
