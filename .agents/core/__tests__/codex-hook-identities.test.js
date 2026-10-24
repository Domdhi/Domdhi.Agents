import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hookIdentities, changedTrustHandlers } = require('../_lib/codex-hook-identities');

const handler = name => ({ type: 'command', command: `node -e "process.argv[2]='${name}.cjs'; require('./adapter').main()"`, timeout: 15 });
const config = () => ({ hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [handler('guardrail'), handler('commit-guard')] }], SessionStart: [{ matcher: '', hooks: [handler('session-start-prime')] }] } });

describe('Codex hook identity sidecar', () => {
  it('lists one deterministic stable identity and fingerprint per registered handler', () => {
    const a = hookIdentities(config());
    expect(a.handlers).toHaveLength(3);
    expect(new Set(a.handlers.map(h => h.id)).size).toBe(3);
    for (const h of a.handlers) {
      expect(h.id).toBeTypeOf('string');
      expect(h.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(h.position).toMatchObject({ group: expect.any(Number), handler: expect.any(Number) });
    }
    expect(hookIdentities(config())).toEqual(a);
    expect(changedTrustHandlers(a, hookIdentities(config()))).toBe(0);
  });
  it('preserves identities across handler reorder but counts both native-position changes', () => {
    const original = config(); const reordered = config(); reordered.hooks.PreToolUse[0].hooks.reverse();
    const a = hookIdentities(original); const b = hookIdentities(reordered);
    expect(a.handlers.map(h => h.id).sort()).toEqual(b.handlers.map(h => h.id).sort());
    expect(changedTrustHandlers(a, b)).toBe(2);
  });
  it('preserves the stable identity when an existing launcher definition changes', () => {
    const original = config(); const edited = config(); edited.hooks.PreToolUse[0].hooks[0].timeout = 20;
    const a = hookIdentities(original); const b = hookIdentities(edited);
    expect(b.handlers[0].id).toBe(a.handlers[0].id);
    expect(b.handlers[0].fingerprint).not.toBe(a.handlers[0].fingerprint);
    expect(changedTrustHandlers(a, b)).toBe(1);
  });
  it('fingerprints the Windows launcher and matcher as well as the portable command', () => {
    const original = config(); const edited = config(); edited.hooks.PreToolUse[0].hooks[0].commandWindows = 'node changed.cjs';
    expect(changedTrustHandlers(hookIdentities(original), hookIdentities(edited))).toBe(1);
    edited.hooks.PreToolUse[0].matcher = '^exec_command$';
    expect(changedTrustHandlers(hookIdentities(original), hookIdentities(edited))).toBe(2);
  });
  it('does not conflate object-key order with a definition change', () => {
    const original = config(); const reordered = config();
    reordered.hooks.PreToolUse[0].hooks[0] = { timeout: 15, command: original.hooks.PreToolUse[0].hooks[0].command, type: 'command' };
    expect(changedTrustHandlers(hookIdentities(original), hookIdentities(reordered))).toBe(0);
  });
  it('counts a combined move and edit once for each affected handler', () => {
    const original = config(); const edited = config();
    edited.hooks.PreToolUse[0].hooks.reverse(); edited.hooks.PreToolUse[0].hooks[0].timeout = 25;
    expect(changedTrustHandlers(hookIdentities(original), hookIdentities(edited))).toBe(2);
  });
  it('keeps duplicate script names distinct across different matcher groups', () => {
    const original = config(); original.hooks.PreToolUse.push({ matcher: '^mcp__.*$', hooks: [handler('guardrail')] });
    const data = hookIdentities(original);
    expect(data.handlers).toHaveLength(4);
    expect(new Set(data.handlers.map(h => h.id)).size).toBe(4);
    original.hooks.PreToolUse.push(structuredClone(original.hooks.PreToolUse[0]));
    expect(() => hookIdentities(original)).toThrow(/duplicate identity/);
  });
  it('counts new current handlers while treating first baseline and removal as no invalidation', () => {
    const original = config(); const removed = config(); removed.hooks.SessionStart = [];
    expect(changedTrustHandlers(null, hookIdentities(original))).toBe(0);
    expect(changedTrustHandlers(hookIdentities(original), hookIdentities(removed))).toBe(0);
    expect(changedTrustHandlers(hookIdentities(removed), hookIdentities(original))).toBe(1);
  });
  it('refuses malformed prior metadata rather than silently establishing a new baseline', () => {
    const next = hookIdentities(config());
    for (const prior of [{}, { schemaVersion: 2, handlers: [] }, { ...next, handlers: [...next.handlers, next.handlers[0]] }]) {
      expect(() => changedTrustHandlers(prior, next)).toThrow();
    }
  });
  it('review F3 treats script-assignment text inside arbitrary commands as ordinary command text', () => {
    const data = hookIdentities({ hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [
      { type: 'command', command: `echo "process.argv[2]='same.cjs'"` },
      { type: 'command', command: `printf "process.argv[2]='same.cjs'"` },
    ] }] } });
    expect(data.handlers).toHaveLength(2);
    expect(new Set(data.handlers.map(h => h.id)).size).toBe(2);
  });
  it('review F3 preserves actual toolkit launcher identity across a definition edit', () => {
    const original = JSON.parse(require('node:fs').readFileSync('.agents/adapters/codex/hooks-config.json', 'utf8'));
    const edited = structuredClone(original);
    const command = edited.hooks.PreToolUse[0].hooks[0].command;
    edited.hooks.PreToolUse[0].hooks[0].command = command.replace('const reason=', 'const reason =');
    expect(edited.hooks.PreToolUse[0].hooks[0].command).not.toBe(command);
    const a = hookIdentities(original); const b = hookIdentities(edited);
    expect(b.handlers[0].id).toBe(a.handlers[0].id);
    expect(changedTrustHandlers(a, b)).toBe(1);
  });
});
