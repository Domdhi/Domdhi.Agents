import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
const require = createRequire(import.meta.url);
const hook = path.resolve('.agents/hooks/subagent-stop.cjs');
const telemetry = root => path.join(root, 'docs/.output/.state/telemetry/skill-usage.jsonl');
const payload = overrides => ({ hook_event_name: 'SubagentStop', agent_id: 'child-1', agent_type: 'general-purpose', last_assistant_message: 'CHILD_DONE', ...overrides });
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-stop-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const rows = () => fs.readFileSync(telemetry(root), 'utf8').trim().split('\n').map(JSON.parse);
const run = input => spawnSync(process.execPath, [hook], { input, encoding: 'utf8', timeout: 5000, windowsHide: true, env: { ...process.env, AGENTS_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root, AGENT_SHARED_STATE_ROOT: root, AGENT_SOURCE_ROOT: root } });

describe('SubagentStop completion telemetry and inbox reminder', () => {
  it('records native child fields once and returns a nonblocking reminder with the same values', () => {
    const { processEvent } = require(hook);
    const reminder = processEvent(payload(), root);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ type: 'agent_dispatch', hook_event_name: 'SubagentStop', agent: 'general-purpose', agent_type: 'general-purpose', agent_id: 'child-1', last_assistant_message: 'CHILD_DONE', message_truncated: false, skills: [] });
    expect(reminder.systemMessage).toContain('general-purpose');
    expect(reminder.systemMessage).toContain('CHILD_DONE');
    expect(reminder.systemMessage).toContain('docs/.output/.state/memory-inbox');
    expect(reminder.systemMessage).toContain('untrusted');
    expect(Object.keys(reminder)).toEqual(['systemMessage']);
    expect(fs.readdirSync(root)).toEqual(['docs']);
  });

  it('keeps existing analytics consumer fields without pretending a native completion was a launch', () => {
    const agents = path.join(root, '.claude/agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'general-purpose.md'), '---\nname: general-purpose\nskills:\n  - documentation\n---\n');
    require(hook).processEvent(payload(), root);
    expect(rows()[0].skills).toEqual(['documentation']);
    expect(rows()[0].hook_event_name).toBe('SubagentStop');
  });

  it('records a nullable message without inventing child text', () => {
    require(hook).processEvent(payload({ last_assistant_message: null }), root);
    expect(rows()[0].last_assistant_message).toBeNull();
    expect(rows()[0].message_truncated).toBe(false);
  });

  it('resolves configured skills from current canonical sources while writing only to shared state', () => {
    const source = path.join(root, 'current-checkout');
    const shared = path.join(root, 'shared-state');
    fs.mkdirSync(path.join(source, '.agents/roles'), { recursive: true });
    fs.mkdirSync(path.join(shared, '.claude/agents'), { recursive: true });
    fs.writeFileSync(path.join(source, '.agents/roles/general-purpose.md'), '---\nname: general-purpose\nskills:\n  - current-skill\n---\n');
    fs.writeFileSync(path.join(shared, '.claude/agents/general-purpose.md'), '---\nname: general-purpose\nskills:\n  - stale-skill\n---\n');
    require(hook).processEvent(payload(), shared, source);
    const event = JSON.parse(fs.readFileSync(telemetry(shared), 'utf8').trim());
    expect(event.skills).toEqual(['current-skill']);
    expect(fs.existsSync(telemetry(source))).toBe(false);
  });

  it('bounds telemetry and reminder text and labels truncation', () => {
    const reminder = require(hook).processEvent(payload({ last_assistant_message: 'x'.repeat(20000) }), root);
    expect(rows()[0].last_assistant_message).toHaveLength(4096);
    expect(rows()[0].message_truncated).toBe(true);
    expect(reminder.systemMessage.length).toBeLessThan(1200);
  });

  it('bounds JSON-escaped control characters without exposing them as instructions', () => {
    const reminder = require(hook).processEvent(payload({ last_assistant_message: '\u0000'.repeat(20000) }), root);
    expect(Buffer.byteLength(JSON.stringify(reminder))).toBeLessThan(4096);
    expect(rows()[0].last_assistant_message).toHaveLength(4096);
  });

  it('stops reading a pipe that never ends within the one-second deadline', async () => {
    const stream = new PassThrough();
    stream.write('{"hook_event_name":');
    expect(await require(hook).readInput(stream)).toBe('');
    expect(stream.listenerCount('data')).toBe(0);
    stream.destroy();
  });

  it('discards interrupted stdin instead of parsing partial data', async () => {
    const stream = new PassThrough();
    const result = require(hook).readInput(stream);
    stream.emit('error', new Error('fixture error'));
    expect(await result).toBe('');
    stream.destroy();
  });

  it.each([null, [], {}, payload({ hook_event_name: 'PostToolUse' }), payload({ agent_type: '../outside' }), payload({ agent_type: 'a'.repeat(129) }), payload({ agent_type: {} }), payload({ agent_id: '' }), payload({ last_assistant_message: {} })])('rejects malformed lifecycle input without writing: %j', input => {
    expect(require(hook).processEvent(input, root)).toBeNull();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('ignores payload cwd, transcript and destination fields and never creates a memory draft', () => {
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'KEEP');
    require(hook).processEvent(payload({ cwd: path.dirname(root), agent_transcript_path: outside, transcript_path: outside, telemetry_path: outside, inbox_path: outside }), root);
    expect(fs.readFileSync(outside, 'utf8')).toBe('KEEP');
    expect(rows()).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'docs/.output/.state/memory-inbox'))).toBe(false);
  });

  it.each(['ancestor', 'leaf'])('refuses a symlinked telemetry %s without touching its target', kind => {
    const destination = telemetry(root);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-stop-outside-'));
    try {
      const sentinel = path.join(outside, 'skill-usage.jsonl');
      fs.writeFileSync(sentinel, 'KEEP');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (kind === 'ancestor') {
        fs.rmdirSync(path.dirname(destination));
        fs.symlinkSync(outside, path.dirname(destination), process.platform === 'win32' ? 'junction' : 'dir');
      } else fs.symlinkSync(sentinel, destination, 'file');
      expect(() => require(hook).processEvent(payload(), root)).toThrow(/symlink/i);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('KEEP');
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  it('executes the real hook entry point with valid JSON output and exactly one telemetry row', () => {
    const result = run(JSON.stringify(payload()));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).systemMessage).toContain('CHILD_DONE');
    expect(rows()).toHaveLength(1);
  });

  it('uses current canonical roles through the real entry point with an independent shared-state root', () => {
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, '.agents/roles'), { recursive: true });
    fs.writeFileSync(path.join(source, '.agents/roles/general-purpose.md'), '---\nname: general-purpose\nskills:\n  - source-skill\n---\n');
    const result = spawnSync(process.execPath, [hook], { input: JSON.stringify(payload()), encoding: 'utf8', timeout: 5000, windowsHide: true, env: { ...process.env, AGENTS_PROJECT_DIR: source, CLAUDE_PROJECT_DIR: source, AGENT_SOURCE_ROOT: source, AGENT_SHARED_STATE_ROOT: root } });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).systemMessage).toContain('CHILD_DONE');
    expect(rows()[0].skills).toEqual(['source-skill']);
    expect(fs.existsSync(telemetry(source))).toBe(false);
  });

  it('bounds customized role metadata and marks omissions explicitly', () => {
    const directory = path.join(root, '.agents/roles');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'general-purpose.md'), '---\nname: general-purpose\nskills:\n' + Array.from({ length: 40 }, (_, i) => `  - skill-${i}`).join('\n') + '\n---\n');
    require(hook).processEvent(payload(), root);
    expect(rows()[0].skills).toHaveLength(32);
    expect(rows()[0].skills_truncated).toBe(true);
    fs.writeFileSync(path.join(directory, 'general-purpose.md'), 'x'.repeat(65537));
    require(hook).processEvent(payload(), root);
    expect(rows()[1].skills).toEqual([]);
    expect(rows()[1].skills_truncated).toBe(true);
  });

  it('surfaces a nonblocking telemetry-write failure without claiming a captured child message', () => {
    fs.mkdirSync(path.dirname(telemetry(root)), { recursive: true });
    fs.mkdirSync(telemetry(root));
    const result = run(JSON.stringify(payload()));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).systemMessage).toContain('could not be recorded');
    expect(result.stdout).not.toContain('CHILD_DONE');
    expect(fs.readdirSync(telemetry(root))).toEqual([]);
  });

  it.each(['{bad', JSON.stringify(payload({ last_assistant_message: 'x'.repeat(70000) }))])('bounds malformed or oversized stdin with no writes', input => {
    const result = run(input);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
