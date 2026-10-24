// NA5.19: in-process tests for the Codex hook dispatcher
// (.agents/adapters/codex/hooks.js), the protected-operation enforcement path
// NA6.3 relies on. The end-to-end child-process proof stays in
// runtime-adapter.test.js; V8 coverage does not measure child processes, so
// these tests drive the real module in-process with a stubbed spawnSync.
//   AC2 patchEvents: add, update, move, delete, passthrough, malformed payloads.
//       invoke: script-name refusal, exit 0 with and without output, JSON and
//       plain-text output, SessionStart context, updatedToolOutput -> stop,
//       ask -> deny, exit 2, failure statuses.
//       run/main: event mapping, multi-event aggregation, fail-closed structured refusal.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HOOKS = require.resolve('../../../../.agents/adapters/codex/hooks.js');
const ROOT = path.resolve(path.dirname(HOOKS), '../../..');
const CWD = path.join(ROOT, 'docs', 'nonexistent-cwd-for-resolution');

// Load a fresh copy of the adapter with spawnSync replaced by `impl`. The module
// destructures spawnSync at require time, so the spy must exist first.
function load(impl = () => ({ status: 0, stdout: '', stderr: '' })) {
  delete require.cache[HOOKS];
  const spawn = vi.spyOn(cp, 'spawnSync').mockImplementation(impl);
  return { adapter: require(HOOKS), spawn };
}
const reply = (stdout, status = 0, stderr = '') => () => ({ status, stdout, stderr });

afterEach(() => {
  vi.restoreAllMocks();
  delete require.cache[HOOKS];
});

describe('codex hook adapter — patchEvents (NA5.19)', () => {
  it('passesANonPatchEventThroughUnchanged', () => {
    const { adapter } = load();
    const event = { tool_name: 'Bash', tool_input: { command: 'ls' } };
    expect(adapter.patchEvents(event)).toEqual([event]);
  });

  it('convertsAddUpdateMoveAndDeleteIntoWriteEventsWithOnlyAddedText', () => {
    const { adapter } = load();
    const command = [
      '*** Begin Patch',
      '*** Add File: new.txt', '+line one', '+line two',
      '*** Update File: old.txt', '*** Move to: moved.txt', '@@', ' context', '-removed', '+added',
      '*** Delete File: gone.txt',
      '*** End Patch',
    ].join('\n');
    const events = adapter.patchEvents({ tool_name: 'apply_patch', cwd: CWD, tool_input: { command } });
    expect(events.map(e => [path.relative(CWD, e.tool_input.file_path), e.tool_input.codex_operation, e.tool_input.content])).toEqual([
      ['new.txt', 'write', 'line one\nline two'],
      ['old.txt', 'delete', ''],
      ['moved.txt', 'write', 'added'],
      ['gone.txt', 'delete', ''],
    ]);
    expect(events.every(e => e.tool_name === 'Write' && e.cwd === CWD)).toBe(true);
  });

  it('resolvesPatchPathsAgainstTheProjectRootWhenTheEventHasNoCwd', () => {
    const { adapter } = load();
    const [event] = adapter.patchEvents({ tool_name: 'apply_patch', tool_input: { command: '*** Add File: rel.txt\n+x' } });
    expect(path.isAbsolute(event.tool_input.file_path)).toBe(true);
    expect(path.basename(event.tool_input.file_path)).toBe('rel.txt');
  });

  it('refusesAPatchWithoutACommandOrWithoutSupportedHeaders', () => {
    const { adapter } = load();
    expect(() => adapter.patchEvents({ tool_name: 'apply_patch', tool_input: {} })).toThrow('apply_patch payload has no command');
    expect(() => adapter.patchEvents({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** End Patch' } })).toThrow('apply_patch contains no supported file headers');
  });
});

describe('codex hook adapter — invoke (NA5.19)', () => {
  const event = { hook_event_name: 'PreToolUse', cwd: CWD, tool_name: 'Write' };

  it('refusesAScriptNameThatIsNotAPlainHookFile', () => {
    const { adapter, spawn } = load();
    expect(() => adapter.invoke('../evil.cjs', event)).toThrow('Invalid hook script');
    expect(() => adapter.invoke('Secret.cjs', event)).toThrow('Invalid hook script');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('runsTheInstalledCodexHookWithTheEventOnStdinAndTheCodexRuntimeEnvironment', () => {
    const { adapter, spawn } = load();
    const outputs = [];
    expect(adapter.invoke('secret-scanner.cjs', event, outputs)).toBe(0);
    expect(outputs).toEqual([]);
    const [exe, args, options] = spawn.mock.calls[0];
    expect(exe).toBe(process.execPath);
    expect(args).toEqual([path.join(ROOT, '.codex', 'hooks', 'secret-scanner.cjs')]);
    expect(JSON.parse(options.input)).toEqual(event);
    expect(options.windowsHide).toBe(true);
    expect(options.env.AGENT_RUNTIME).toBe('codex');
    expect(options.env.CLAUDE_PROJECT_DIR).toBe(options.env.CODEX_PROJECT_DIR);
  });

  it('turnsAnAskDecisionIntoDenyBecauseCodexCannotPromptAndStampsTheEventName', () => {
    const { adapter } = load(reply(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Other', permissionDecision: 'ask', permissionDecisionReason: 'Needs approval' } })));
    const outputs = [];
    expect(adapter.invoke('path-guardrail.cjs', event, outputs)).toBe(2);
    expect(outputs).toEqual([{ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'Needs approval; review this action explicitly before retrying',
    } }]);
  });

  it('suppliesADefaultReasonWhenAnAskDecisionHasNone', () => {
    const { adapter } = load(reply(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask' } })));
    const outputs = [];
    adapter.invoke('path-guardrail.cjs', event, outputs);
    expect(outputs[0].hookSpecificOutput.permissionDecisionReason).toBe('Repository policy requires approval; review this action explicitly before retrying');
  });

  it('turnsUpdatedToolOutputIntoAStopBecauseCodexDoesNotHonorReplacementOutput', () => {
    const { adapter } = load(reply(JSON.stringify({ hookSpecificOutput: { updatedToolOutput: 'REDACTED' } })));
    const outputs = [];
    adapter.invoke('post-read-scrubber.cjs', { ...event, hook_event_name: 'PostToolUse' }, outputs);
    expect(outputs).toEqual([{ continue: false, stopReason: 'REDACTED' }]);
  });

  it('wrapsPlainTextAsSessionStartContextOrAsASystemMessage', () => {
    const { adapter } = load(reply('  plain context  \n'));
    const outputs = [];
    adapter.invoke('session-start-prime.cjs', { ...event, hook_event_name: 'SessionStart' }, outputs);
    adapter.invoke('memory-capture.cjs', { ...event, hook_event_name: 'PostToolUse' }, outputs);
    expect(outputs).toEqual([
      { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'plain context' } },
      { systemMessage: 'plain context' },
    ]);
  });

  it('returnsTwoForABlockingExitAndForwardsTheHookStderr', () => {
    const { adapter } = load(reply('', 2, 'blocked by policy\n'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const outputs = [];
    expect(adapter.invoke('secret-scanner.cjs', event, outputs)).toBe(2);
    expect(outputs).toEqual([{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'blocked by policy' } }]);
    expect(stderr).toHaveBeenCalledWith('blocked by policy\n');
  });

  it.each([
    ['a failing exit status', () => ({ status: 1, stdout: '', stderr: ' crashed \n' }), 'secret-scanner.cjs: crashed'],
    ['a spawn error', () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn ENOENT') }), 'secret-scanner.cjs: spawn ENOENT'],
    ['a killed or timed-out child', () => ({ status: null, stdout: '', stderr: 'timed out' }), 'secret-scanner.cjs: timed out'],
  ])('throwsOn %s so the dispatcher fails closed', (_label, impl, message) => {
    const { adapter } = load(impl);
    expect(() => adapter.invoke('secret-scanner.cjs', event, [])).toThrow(message);
  });
});

describe('codex hook adapter — run and main (NA5.19)', () => {
  const argv = process.argv;
  afterEach(() => { process.argv = argv; });

  function runMain(script, event, impl) {
    const loaded = load(impl);
    // Only stdin (fd 0) is replaced; every other read reaches the real function.
    const realReadFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => (file === 0 ? JSON.stringify(event) : realReadFileSync.call(fs, file, ...rest)));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.argv = [argv[0], HOOKS, ...(script ? [script] : [])];
    const code = loaded.adapter.main();
    return { code, stdout, stderr, spawn: loaded.spawn };
  }
  const written = spy => spy.mock.calls.map(call => call[0]).join('');

  it('aggregatesEveryPatchFileIntoOneResponseWhereDenyWinsAndContextAccumulates', () => {
    const responses = [
      { systemMessage: 'first', hookSpecificOutput: { permissionDecision: 'allow', additionalContext: 'ctx one' } },
      { systemMessage: 'second', decision: 'block', reason: 'blocked', continue: false, stopReason: 'stop',
        hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'secret found', additionalContext: 'ctx two' } },
    ];
    let call = 0;
    const event = { hook_event_name: 'PreToolUse', cwd: CWD, tool_name: 'apply_patch', tool_input: { command: '*** Add File: a.txt\n+a\n*** Add File: b.txt\n+b' } };
    const { code, stdout, spawn } = runMain('secret-scanner.cjs', event, () => ({ status: 0, stdout: JSON.stringify(responses[call++]), stderr: '' }));
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(written(stdout))).toEqual({
      systemMessage: 'first\nsecond',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'secret found', additionalContext: 'ctx one\nctx two' },
    });
  });

  it('keepsAnEarlierDenyWhenALaterFileAllows', () => {
    const responses = [
      { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'first file is protected' } },
      { hookSpecificOutput: { permissionDecision: 'allow', permissionDecisionReason: 'second file is fine' } },
    ];
    let call = 0;
    const event = { hook_event_name: 'PreToolUse', cwd: CWD, tool_name: 'apply_patch', tool_input: { command: '*** Add File: a.txt\n+a\n*** Add File: b.txt\n+b' } };
    const { stdout, spawn } = runMain('path-guardrail.cjs', event, () => ({ status: 0, stdout: JSON.stringify(responses[call++]), stderr: '' }));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(written(stdout)).hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'first file is protected',
    });
  });

  it('stopsAtTheFirstBlockingFileAndEmitsStructuredDeny', () => {
    const event = { hook_event_name: 'PreToolUse', cwd: CWD, tool_name: 'apply_patch', tool_input: { command: '*** Add File: a.txt\n+a\n*** Add File: b.txt\n+b' } };
    const { code, spawn, stdout } = runMain('path-guardrail.cjs', event, reply('', 2));
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(written(stdout))).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'path-guardrail.cjs: protected action refused' } });
  });

  it.each(['{bad', 'null', '[]', '"text"', '{"hookSpecificOutput":[]}', '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":42}}', '{"continue":"false"}', '{"stopReason":42}', '{"decision":42}', '{"hookSpecificOutput":{"permissionDecision":"bogus"}}'])('refuses malformed PreToolUse child output before a later allow: %s', malformed => {
    let call = 0;
    const event = { hook_event_name: 'PreToolUse', cwd: CWD, tool_name: 'apply_patch', tool_input: { command: '*** Add File: a.txt\n+a\n*** Add File: b.txt\n+b' } };
    const { code, stdout, spawn } = runMain('path-guardrail.cjs', event, () => ({ status: 0, stdout: ++call === 1 ? malformed : JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }), stderr: '' }));
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    const output = JSON.parse(written(stdout));
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/codex-adapter/);
  });

  it('mapsMcpReadOutputToTheBashStringTheScrubberExpects', () => {
    const event = { hook_event_name: 'PostToolUse', cwd: CWD, tool_name: 'mcp__files__read', tool_response: { content: [{ type: 'text', text: 'alpha' }, { type: 'image' }, { type: 'text', text: 'beta' }] } };
    const { code, spawn } = runMain('post-read-scrubber.cjs', event);
    expect(code).toBe(0);
    const sent = JSON.parse(spawn.mock.calls[0][2].input);
    expect(sent.tool_name).toBe('Bash');
    expect(sent.tool_response).toBe('alpha\nbeta');
  });

  it.each([
    ['output', { output: 'from output' }, 'from output'],
    ['plain string', 'from string', 'from string'],
    ['unrecognized shape', { other: 1 }, { other: 1 }],
  ])('mapsAScrubberResponseGivenAs %s', (_label, response, expected) => {
    const { spawn } = runMain('post-read-scrubber.cjs', { hook_event_name: 'PostToolUse', cwd: CWD, tool_name: 'Read', tool_response: response });
    expect(JSON.parse(spawn.mock.calls[0][2].input).tool_response).toEqual(expected);
  });

  it('mapsCodexSpawnAgentToAgentForSkillUsageLogging', () => {
    const { spawn } = runMain('skill-usage-logger.cjs', { hook_event_name: 'PostToolUse', cwd: CWD, tool_name: 'spawn_agent' });
    expect(JSON.parse(spawn.mock.calls[0][2].input).tool_name).toBe('Agent');
  });

  it('passesNativeSubagentStopFieldsAndNonblockingReminderThrough', () => {
    const event = { hook_event_name: 'SubagentStop', cwd: CWD, agent_id: 'child-1', agent_type: 'general-purpose', last_assistant_message: 'CHILD_DONE' };
    const { spawn, stdout } = runMain('subagent-stop.cjs', event, reply(JSON.stringify({ systemMessage: 'Review the memory inbox' })));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spawn.mock.calls[0][2].input)).toEqual(event);
    expect(JSON.parse(written(stdout))).toEqual({ systemMessage: 'Review the memory inbox' });
  });

  it('reportsEditCaptureEventsAsEdits', () => {
    const event = { hook_event_name: 'PostToolUse', cwd: CWD, tool_name: 'apply_patch', tool_input: { command: '*** Add File: a.txt\n+a' } };
    const { spawn } = runMain('edit-capture.cjs', event);
    expect(JSON.parse(spawn.mock.calls[0][2].input).tool_name).toBe('Edit');
  });

  it('failsClosedWithStructuredStopWhenTheScriptArgumentIsMissing', () => {
    const { code, stdout, stderr, spawn } = runMain(null, { hook_event_name: 'PreToolUse', cwd: CWD });
    expect(code).toBe(0);
    expect(JSON.parse(written(stdout))).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[codex-adapter] Missing shared hook script' } });
    expect(spawn).not.toHaveBeenCalled();
    expect(written(stderr)).toBe('[codex-adapter] Missing shared hook script\n');
  });

  it('failsClosedWithExitTwoWhenAHookCrashes', () => {
    const { code, stdout, stderr } = runMain('secret-scanner.cjs', { hook_event_name: 'PreToolUse', cwd: CWD, tool_name: 'Write' }, reply('', 1, 'boom'));
    expect(code).toBe(0);
    expect(JSON.parse(written(stdout))).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[codex-adapter] secret-scanner.cjs: boom' } });
    expect(written(stderr)).toBe('[codex-adapter] secret-scanner.cjs: boom\n');
  });
  it.each(['SessionStart', 'PostToolUse', 'SubagentStop'])('keeps the supported %s error stop distinct from PreToolUse denial', hook_event_name => {
    const { code, stdout } = runMain('memory-capture.cjs', { hook_event_name, cwd: CWD }, reply('', 1, 'crashed'));
    expect(code).toBe(0);
    expect(JSON.parse(written(stdout))).toEqual({ continue: false, stopReason: '[codex-adapter] memory-capture.cjs: crashed' });
  });
  it.each([{}, { hook_event_name: 42 }, { hook_event_name: 'unknown' }])('defaults malformed event identity to supported PreToolUse deny: %j', event => {
    const { code, stdout, spawn } = runMain('secret-scanner.cjs', event);
    expect(code).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    const output = JSON.parse(written(stdout));
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/Invalid hook event/);
  });

});
