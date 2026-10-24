// NA6.7 — the installed Claude shell hooks cover Claude Code's Windows PowerShell tool.
//
// Claude Code on Windows offers a `PowerShell` tool next to `Bash` (observed in the
// first real NA6.4 run: Claude Code 2.1.296 listed it in its init event and the model
// chose it for helper commands). A hook group registered with matcher `Bash` alone
// never runs for that tool, so a protected command could bypass the guardrail.
//
// AC1: every PreToolUse/PostToolUse group that matches Bash also matches PowerShell,
//      in the canonical adapter and its rendered projection, and nothing else is added.
// AC2: guardrail and commit-guard decide a PowerShell command exactly as the Bash form
//      (memory-capture routing is covered in .agents/hooks/__tests__/memory-capture.test.js).
// AC3 (render currency) is checked by the renderer's own --check and this projection test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ADAPTER = path.join(ROOT, '.agents', 'adapters', 'claude', 'settings.json');
const RENDERED = path.join(ROOT, '.claude', 'settings.json');

const SHELL_TOOLS = ['Bash', 'PowerShell'];
// Tools a shell hook group must never pick up by accident.
const OTHER_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'Agent', 'Task', 'Skill', 'WebFetch', 'ExitPlanMode', 'BashOutput', 'PowerShellOutput'];
// Shell hooks that must see every shell command, by event.
const SHELL_HOOKS = {
    PreToolUse: ['guardrail.cjs', 'commit-guard.cjs'],
    PostToolUse: ['post-read-scrubber.cjs', 'damage-control.cjs', 'command-usage-logger.cjs', 'memory-capture.cjs'],
};

/** Claude Code matcher semantics: empty or `*` matches every tool; otherwise an exact-or-regex tool-name pattern. */
function matches(matcher, tool) {
    if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
    return new RegExp(`^(?:${matcher})$`).test(tool);
}

function groups(settings, event) {
    return (settings.hooks && Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []);
}

const isWildcard = g => g.matcher === undefined || g.matcher === '' || g.matcher === '*';
const scripts = g => (g.hooks || []).map(h => (/hooks[\\/]([\w.-]+)/.exec(h.command || '') || [])[1]).filter(Boolean);

describe.each([
    ['canonical adapter', ADAPTER],
    ['rendered projection', RENDERED],
])('Claude shell hook coverage — %s', (_label, file) => {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));

    it.each(['PreToolUse', 'PostToolUse'])('%s: every group that matches Bash also matches PowerShell', event => {
        const shellGroups = groups(settings, event).filter(g => !isWildcard(g) && SHELL_TOOLS.some(t => matches(g.matcher, t)));
        expect(shellGroups.length).toBeGreaterThan(0);
        for (const g of shellGroups) {
            expect({ matcher: g.matcher, Bash: matches(g.matcher, 'Bash'), PowerShell: matches(g.matcher, 'PowerShell') })
                .toEqual({ matcher: g.matcher, Bash: true, PowerShell: true });
        }
    });

    it.each(['PreToolUse', 'PostToolUse'])('%s: a shell group matches no other tool', event => {
        const shellGroups = groups(settings, event).filter(g => !isWildcard(g) && SHELL_TOOLS.some(t => matches(g.matcher, t)));
        for (const g of shellGroups) {
            expect(OTHER_TOOLS.filter(t => matches(g.matcher, t))).toEqual([]);
        }
    });

    it.each(Object.entries(SHELL_HOOKS))('%s: each shell hook runs for both shell tools', (event, hooks) => {
        for (const hook of hooks) {
            const owners = groups(settings, event).filter(g => scripts(g).includes(hook));
            expect(owners.length, `${event} registers ${hook}`).toBeGreaterThan(0);
            for (const tool of SHELL_TOOLS) {
                expect(owners.some(g => matches(g.matcher, tool)), `${event} ${hook} runs for ${tool}`).toBe(true);
            }
        }
    });
});

// Review M-6: the shipped permission allowlist grants the PowerShell tool exactly what it grants Bash.
describe.each([
    ['canonical adapter', ADAPTER],
    ['rendered projection', RENDERED],
])('Claude shell permission parity — %s', (_label, file) => {
    it('every Bash(...) allow rule has an identical PowerShell(...) twin, and no PowerShell rule lacks one', () => {
        const allow = (JSON.parse(fs.readFileSync(file, 'utf8')).permissions || {}).allow || [];
        const bash = allow.filter(r => r.startsWith('Bash(')).map(r => r.slice(4)).sort();
        const powershell = allow.filter(r => r.startsWith('PowerShell(')).map(r => r.slice(10)).sort();
        expect(bash.length).toBeGreaterThan(0);
        expect(powershell).toEqual(bash);
    });
});

describe('Claude shell hook coverage — projection', () => {
    it('the rendered settings carry the canonical hooks block unchanged', () => {
        const adapter = JSON.parse(fs.readFileSync(ADAPTER, 'utf8'));
        const rendered = JSON.parse(fs.readFileSync(RENDERED, 'utf8'));
        expect(rendered.hooks).toEqual(adapter.hooks);
    });
});

describe('Claude shell hook coverage — PowerShell commands get the Bash decision', () => {
    // Protected strings live in this file, never on a command line (a live guardrail
    // hook scans the whole command it is shown).
    const PROTECTED = ['git', 'reset', '--hard', 'HEAD'].join(' ');
    const INLINE_COMMIT = ['git', 'commit', '-m', '"smoke"'].join(' ');
    let original;

    beforeAll(() => {
        original = process.env.CLAUDE_PROJECT_DIR;
        process.env.CLAUDE_PROJECT_DIR = ROOT;
    });
    afterAll(() => {
        if (original === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = original;
    });

    it('guardrail refuses the protected command identically for Bash and PowerShell', () => {
        const { processEvent } = require('../../../../.agents/hooks/guardrail.cjs');
        const bash = processEvent({ tool_name: 'Bash', tool_input: { command: PROTECTED } });
        const powershell = processEvent({ tool_name: 'PowerShell', tool_input: { command: PROTECTED } });
        expect(bash.block).toBe(true);
        expect(bash.feedback).toMatch(/GUARDRAIL/);
        expect(powershell).toEqual(bash);
    });

    // Review M-1: PowerShell's own deletion verbs and abbreviated parameters reach the
    // protected-path tiers and the recursive-delete nudge, not only the Bash spellings.
    it.each([
        ['ri .git -Recurse -Force'], ['rd -r .git'], ['rmdir .git /s /q'], ['ri .env'], ['erase .env'],
        ['cmd /c del .env'], ['cmd.exe /C del .env'], ['RI .ENV'], ['Remove-Item -Path .env'],
        ['cmd /c "del .env"'], ['cmd /c "rd /s /q .git"'], ["cmd /c 'del .env'"],
    ])('guardrail blocks the PowerShell or cmd idiom %s against a zero-access path', command => {
        const { processEvent } = require('../../../../.agents/hooks/guardrail.cjs');
        const decision = processEvent({ tool_name: 'PowerShell', tool_input: { command } });
        expect(decision && decision.block, command).toBe(true);
    });

    it.each([
        ['Remove-Item build -r -fo'], ['ri build -fo -r'], ['Remove-Item build -Rec -Forc'], ['rd build /s /q'], ['rmdir build -Recurse -Force'], ['erase /s /q build'],
    ])('guardrail nudges recursive force removal spelled %s', command => {
        const { processEvent } = require('../../../../.agents/hooks/guardrail.cjs');
        const decision = processEvent({ tool_name: 'PowerShell', tool_input: { command } });
        expect(decision && decision.block, command).toBe(true);
        expect(decision.feedback).toMatch(/GUARDRAIL/);
    });

    it.each([
        ['grep rd -r src'], ['Get-ChildItem -Recurse'], ['git log --format=%rd'], ['echo rmdir'], ['Get-Content .\\readme.md'],
    ])('guardrail leaves the benign command %s alone', command => {
        const { processEvent } = require('../../../../.agents/hooks/guardrail.cjs');
        const decision = processEvent({ tool_name: 'PowerShell', tool_input: { command } });
        expect(decision === null || !decision.block, command).toBe(true);
    });

    it('commit-guard refuses an inline commit message identically for Bash and PowerShell', () => {
        const { processEvent } = require('../../../../.agents/hooks/commit-guard.cjs');
        const bash = processEvent({ tool_name: 'Bash', tool_input: { command: INLINE_COMMIT } });
        const powershell = processEvent({ tool_name: 'PowerShell', tool_input: { command: INLINE_COMMIT } });
        expect(bash).not.toBeNull();
        expect(powershell).toEqual(bash);
    });
});
