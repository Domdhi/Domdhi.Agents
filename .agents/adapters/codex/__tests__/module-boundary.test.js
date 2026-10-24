import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { runInstall } = require('../../../core/install');
const { runUpdate } = require('../../../core/template-updater');
const fixtures = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('adapter module boundary in application adopters', () => {
  it.each(['install', 'update'])('%s executes registered handlers under an ESM application root', operation => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'esm adopter space '));
    fixtures.push(root);
    const app = { name: 'esm-adopter-fixture', type: 'module', private: true };
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(app));
    const installed = runInstall({ source: path.resolve('.'), target: root });
    expect(installed.ok).toBe(true);
    expect(installed.conflicts).toEqual([]);
    if (operation === 'update') {
      // An existing v6 installation can lack this previously undelivered boundary.
      const boundary = path.join(root, '.agents/adapters/package.json');
      if (fs.existsSync(boundary)) fs.unlinkSync(boundary);
      const updated = runUpdate(root, { merge: true });
      expect(updated.errors).toBe(0);
      expect(updated.conflicts).toEqual([]);
    }
    const hooks = JSON.parse(fs.readFileSync(path.join(root, '.codex/hooks.json'), 'utf8')).hooks;
    const run = (command, event) => spawnSync(command, {
      shell: true, cwd: path.join(root, 'src'), encoding: 'utf8', timeout: 15000,
      input: JSON.stringify({ cwd: root, ...event }),
      env: { ...process.env, AGENTS_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root },
    });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });

    const guard = hooks.PreToolUse.find(group => group.matcher === '^Bash$').hooks[0].command;
    const clean = run(guard, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo fixture-safe' } });
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stderr).toBe('');
    expect(clean.stdout).toBe('');

    const denied = run(guard, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git reset --hard' } });
    expect(denied.status, denied.stderr).toBe(0);
    const refusal = JSON.parse(denied.stdout).hookSpecificOutput;
    expect(refusal.permissionDecision).toBe('deny');
    expect(refusal.permissionDecisionReason).toMatch(/reset/i);
    expect(refusal.permissionDecisionReason).not.toMatch(/launcher failed|Cannot find module|not defined/);

    const scrubber = hooks.PostToolUse.find(group => group.matcher === '^Bash$').hooks[0].command;
    const redacted = run(scrubber, {
      hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'fixture-output' },
      tool_response: { stdout: 'AKIA' + 'IOSFODNN7EXAMPLE' },
    });
    expect(redacted.status, redacted.stderr).toBe(0);
    expect(JSON.parse(redacted.stdout)).toEqual({ continue: false, stopReason: '<REDACTED:AWS Access Key>' });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))).toEqual(app);
  });
});
