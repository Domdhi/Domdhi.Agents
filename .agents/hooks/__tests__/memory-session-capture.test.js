// AC→source map (memory-session-capture hook, SessionEnd):
//   - OPT-IN: nothing happens unless MEMORY_CAPTURE=on AND a provider is configured; no process is started otherwise
//   - when on: ONE detached child runs `memory-capture.js capture --session <transcript> --then-index` with a log file
//   - the hook never throws and always exits 0
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HOOK = path.resolve(__dirname, '../memory-session-capture.cjs');
const CLAUDE_WRAPPER = path.resolve(__dirname, '../../../.claude/hooks/memory-session-capture.cjs');
const hook = require('../memory-session-capture.cjs');
const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');

const KEYS = ['AGENT_SHARED_STATE_ROOT', 'AGENTS_PROJECT_DIR', 'MEMORY_PROFILE', 'MEMORY_CAPTURE', 'MEMORY_CAPTURE_PROVIDER', 'MEMORY_CAPTURE_MODEL', 'MEMORY_CAPTURE_KEY_COMMAND', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'MEMORY_SYNC', 'MEMORY_DIR', 'MEMORY_CAPTURE_INNER'];
const saved = {};
let tmp, transcript, spawn, child;

beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    tmp = createTmpDir({ prefix: 'memory-session-capture-' });
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, { AGENT_SHARED_STATE_ROOT: tmp.root, AGENTS_PROJECT_DIR: tmp.root, MEMORY_PROFILE: 'standard', CLAUDE_CONFIG_DIR: path.join(tmp.root, 'claude') });
    transcript = path.join(tmp.root, 'abc.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    child = { unref: vi.fn() };
    spawn = vi.fn(() => child);
});
afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    tmp.cleanup();
});

const syncedFile = name => path.join(tmp.root, 'docs', '.output', '.memory', 'notes', name);

describe('notes sync at session end (separate opt-in: MEMORY_SYNC=on)', () => {
    const mkNote = () => { const d = path.join(tmp.root, 'mem'); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'a.md'), '---\nname: a\ndescription: "d"\n---\n\nbody\n'); process.env.MEMORY_DIR = d; };
    it('pushes the notes into the tracked folder without capture, a provider or a child process', () => {
        mkNote();
        process.env.MEMORY_SYNC = 'on';
        expect(fire()).toBe(false);
        expect(fs.existsSync(syncedFile('a.md'))).toBe(true);
        expect(spawn).not.toHaveBeenCalled();
    });
    it('does nothing when MEMORY_SYNC is off, and never fails the hook', () => {
        mkNote();
        expect(fire()).toBe(false);
        expect(fs.existsSync(syncedFile('a.md'))).toBe(false);
        process.env.MEMORY_SYNC = 'on';
        process.env.MEMORY_DIR = path.join(tmp.root, 'does-not-exist');
        expect(() => fire()).not.toThrow();
    });
    it('is skipped under MEMORY_PROFILE=minimal', () => {
        mkNote();
        Object.assign(process.env, { MEMORY_SYNC: 'on', MEMORY_PROFILE: 'minimal' });
        fire();
        expect(fs.existsSync(syncedFile('a.md'))).toBe(false);
    });
});

const fire = (input = { transcript_path: transcript }) => hook.processEvent(input, { spawn });

describe('keyless provider and the recursion guard', () => {
    it('claude-cli needs no key, but is still opt-in: it starts exactly one detached child', () => {
        Object.assign(process.env, { MEMORY_CAPTURE: 'on', MEMORY_CAPTURE_PROVIDER: 'claude-cli' });
        expect(hook.providerConfigured(process.env)).toBe(true);
        expect(fire()).toBe(true);
        expect(spawn).toHaveBeenCalledTimes(1);
        process.env.MEMORY_CAPTURE = 'off';
        spawn.mockClear();
        expect(fire()).toBe(false);
        expect(spawn).not.toHaveBeenCalled();
    });
    it('never captures (or syncs) inside the capture\'s own claude -p child, even with everything enabled', () => {
        Object.assign(process.env, { MEMORY_CAPTURE: 'on', MEMORY_CAPTURE_PROVIDER: 'claude-cli', MEMORY_SYNC: 'on', MEMORY_CAPTURE_INNER: '1' });
        expect(fire()).toBe(false);
        expect(spawn).not.toHaveBeenCalled();
    });
});

describe('opt-in gating', () => {
    it('does nothing by default, even with a key available', () => {
        process.env.ANTHROPIC_API_KEY = 'sk-test';
        expect(fire()).toBe(false);
        expect(spawn).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(tmp.root, 'docs'))).toBe(false);
    });
    it('does nothing when enabled but no provider is configured (capture off, recall unaffected)', () => {
        process.env.MEMORY_CAPTURE = 'on';
        expect(fire()).toBe(false);
        expect(spawn).not.toHaveBeenCalled();
    });
    it('does nothing under MEMORY_PROFILE=minimal', () => {
        Object.assign(process.env, { MEMORY_CAPTURE: 'on', ANTHROPIC_API_KEY: 'k', MEMORY_PROFILE: 'minimal' });
        expect(fire()).toBe(false);
    });
    it('ignores a missing, non-jsonl or absent transcript', () => {
        Object.assign(process.env, { MEMORY_CAPTURE: 'on', ANTHROPIC_API_KEY: 'k' });
        expect(fire({})).toBe(false);
        expect(fire({ transcript_path: path.join(tmp.root, 'missing.jsonl') })).toBe(false);
        fs.writeFileSync(path.join(tmp.root, 'x.txt'), 'x');
        expect(fire({ transcript_path: path.join(tmp.root, 'x.txt') })).toBe(false);
        expect(spawn).not.toHaveBeenCalled();
    });
    it('openai provider needs a model', () => {
        Object.assign(process.env, { MEMORY_CAPTURE: 'on', MEMORY_CAPTURE_PROVIDER: 'openai' });
        expect(fire()).toBe(false);
        process.env.MEMORY_CAPTURE_MODEL = 'qwen3.5:9b';
        expect(fire()).toBe(true);
    });
});

describe('when enabled', () => {
    for (const [label, env] of [['an API key', { ANTHROPIC_API_KEY: 'sk-test' }], ['a key command', { MEMORY_CAPTURE_KEY_COMMAND: 'get-key' }]]) {
        it(`starts exactly one detached capture child with ${label}`, () => {
            Object.assign(process.env, { MEMORY_CAPTURE: 'on', ...env });
            expect(fire()).toBe(true);
            expect(spawn).toHaveBeenCalledTimes(1);
            const [cmd, args, opts] = spawn.mock.calls[0];
            expect(cmd).toBe(process.execPath);
            expect(args[0]).toMatch(/core[\\/]memory-capture\.js$/);
            expect(args.slice(1)).toEqual(['capture', '--session', transcript, '--max-keep', '8', '--quiet', '--then-index']);
            expect(opts).toMatchObject({ detached: true, windowsHide: true });
            expect(child.unref).toHaveBeenCalled();
            const log = path.join(tmp.root, 'docs', '.output', '.state', 'memory-notes', 'capture.log');
            expect(fs.readFileSync(log, 'utf8')).toContain('capture abc.jsonl');
            expect(opts.stdio[0]).toBe('ignore');
        });
    }
    it('MEMORY_CAPTURE accepts on/1/true/yes and rejects anything else', () => {
        process.env.ANTHROPIC_API_KEY = 'k';
        for (const v of ['on', '1', 'true', 'YES']) { process.env.MEMORY_CAPTURE = v; expect(fire()).toBe(true); }
        for (const v of ['off', '0', '', 'maybe']) { process.env.MEMORY_CAPTURE = v; expect(fire()).toBe(false); }
    });
});

describe('as a process', () => {
    const run = (script, input) => spawnSync(process.execPath, [script], { input, encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env } });
    for (const [label, script] of [['canonical hook', HOOK], ['generated .claude wrapper', CLAUDE_WRAPPER]]) {
        it(`${label}: exits 0 silently on garbage, empty, or disabled input`, () => {
            for (const input of ['{nope', '', JSON.stringify({ transcript_path: transcript }), 'null']) {
                const r = run(script, input);
                expect(r.status).toBe(0);
                expect(r.stdout).toBe('');
            }
            expect(fs.existsSync(path.join(tmp.root, 'docs', '.output', '.state', 'memory-notes'))).toBe(false);   // disabled by default: no log, no state (only the standard hook telemetry)
        });
    }
});
