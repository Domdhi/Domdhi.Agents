'use strict';

// Codex hook adapter: patch conversion,
// installed-hook invocation, refusal statuses and one-response aggregation.
// Project-specific guards and PR-body behavior are intentionally not toolkit policy.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveRuntimeContext } = require('../../core/runtime-context');
function getProjectRoot() { return resolveRuntimeContext({ entrypoint: __filename }).projectRoot; }
function refusal(event, reason) {
  // Unknown/malformed input defaults to the protected PreToolUse contract.
  return !event || !['SessionStart', 'PostToolUse', 'SubagentStop', 'Stop', 'SessionEnd', 'PreCompact'].includes(event.hook_event_name)
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
    : { continue: false, stopReason: reason };
}

function patchEvents(event, { postToolUse = false } = {}) {
  if (event.tool_name !== 'apply_patch') return [event];
  const patch = event.tool_input && event.tool_input.command;
  if (typeof patch !== 'string') throw new Error('apply_patch payload has no command');
  const lines = patch.split(/\r?\n/);
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i]);
    if (!header) continue;
    let target = path.resolve(event.cwd || getProjectRoot(), header[2]);
    const body = [];
    while (++i < lines.length && !/^\*\*\* (?:Add|Update|Delete) File:|^\*\*\* End Patch$/.test(lines[i])) body.push(lines[i]);
    i--;
    if (header[1] === 'Update') {
      const move = body.find(line => line.startsWith('*** Move to: '));
      if (move) {
        events.push({ ...event, tool_name: 'Write', tool_input: { file_path: target, content: '', codex_operation: 'delete' } });
        target = path.resolve(event.cwd || getProjectRoot(), move.slice(13));
      }
    }
    // Reuse reference added-text scanning; context/removals are not new writes.
    const content = body.filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n');
    events.push({ ...event, tool_name: 'Write', tool_input: { file_path: target, content, codex_operation: header[1] === 'Delete' ? 'delete' : 'write' } });
  }
  if (!events.length) throw new Error('apply_patch contains no supported file headers');
  return events;
}

function invoke(script, event, outputs = []) {
  if (!/^[a-z-]+\.cjs$/.test(script)) throw new Error('Invalid hook script');
  const context = resolveRuntimeContext({ input: event, entrypoint: __filename });
  const result = spawnSync(process.execPath, [path.join(context.installedRoot, '.codex', 'hooks', script)], {
    input: JSON.stringify(event), encoding: 'utf8', timeout: 10000,
    cwd: context.invocationCwd, windowsHide: true,
    env: { ...process.env, AGENT_RUNTIME: 'codex', AGENTS_PROJECT_DIR: context.projectRoot,
      AGENT_SOURCE_ROOT: context.projectRoot, AGENT_SHARED_STATE_ROOT: context.sharedStateRoot,
      CODEX_PROJECT_DIR: context.projectRoot, CLAUDE_PROJECT_DIR: context.projectRoot },
  });
  if (result.error || result.status === null || (result.status !== 0 && result.status !== 2)) {
    throw new Error(`${script}: ${result.error ? result.error.message : result.stderr.trim()}`);
  }
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === 2) {
    // Windows native hooks run through PowerShell -Command, which converts
    // an external exit 2 to process exit 1 (a nonblocking hook failure).
    // Carry the original refusal through Codex's supported JSON contract.
    const reason = result.stderr.trim() || `${script}: protected action refused`;
    outputs.push(refusal(event, reason));
    return 2;
  }
  if (result.stdout.trim()) {
    let output;
    try { output = JSON.parse(result.stdout); } catch {
      if (event.hook_event_name === 'PreToolUse') throw new Error(`${script}: malformed PreToolUse JSON output`);
      output = event.hook_event_name === 'SessionStart'
        ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: result.stdout.trim() } }
        : { systemMessage: result.stdout.trim() };
    }
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error(`${script}: invalid hook output object`);
    if (output.hookSpecificOutput !== undefined && (!output.hookSpecificOutput || typeof output.hookSpecificOutput !== 'object' || Array.isArray(output.hookSpecificOutput))) throw new Error(`${script}: invalid hookSpecificOutput object`);
    if (event.hook_event_name === 'PreToolUse') {
      if (output.continue !== undefined && typeof output.continue !== 'boolean') throw new Error(`${script}: invalid continue control`);
      if (output.decision !== undefined && output.decision !== 'block') throw new Error(`${script}: invalid decision control`);
      for (const field of ['stopReason', 'reason', 'systemMessage']) if (output[field] !== undefined && typeof output[field] !== 'string') throw new Error(`${script}: invalid ${field}`);
    }
    if (output.hookSpecificOutput && output.hookSpecificOutput.updatedToolOutput !== undefined) {
      output = { continue: false, stopReason: output.hookSpecificOutput.updatedToolOutput };
    }
    if (output.hookSpecificOutput) {
      if (event.hook_event_name === 'PreToolUse') {
        const specific = output.hookSpecificOutput;
        if (specific.permissionDecision !== undefined && !['allow', 'deny', 'ask'].includes(specific.permissionDecision)) throw new Error(`${script}: invalid permissionDecision`);
        if (specific.permissionDecisionReason !== undefined && typeof specific.permissionDecisionReason !== 'string') throw new Error(`${script}: invalid permissionDecisionReason`);
        if (specific.additionalContext !== undefined && typeof specific.additionalContext !== 'string') throw new Error(`${script}: invalid additionalContext`);
      }
      output.hookSpecificOutput.hookEventName = event.hook_event_name;
      if (output.hookSpecificOutput.permissionDecision === 'ask') {
        // Codex parses ask but does not support it; continuing would bypass policy.
        output.hookSpecificOutput.permissionDecision = 'deny';
        output.hookSpecificOutput.permissionDecisionReason = (output.hookSpecificOutput.permissionDecisionReason || 'Repository policy requires approval') + '; review this action explicitly before retrying';
      }
    }
    if (event.hook_event_name === 'PreToolUse' && (output.continue === false || output.decision === 'block')) {
      output.hookSpecificOutput = { ...(output.hookSpecificOutput || {}), permissionDecision: 'deny',
        permissionDecisionReason: output.hookSpecificOutput?.permissionDecisionReason || output.stopReason || output.reason || `${script}: protected action refused`, hookEventName: 'PreToolUse' };
      delete output.continue; delete output.stopReason; delete output.decision; delete output.reason;
    }
    if (event.hook_event_name === 'PreToolUse' && output.hookSpecificOutput?.permissionDecision === 'deny') {
      if (!output.hookSpecificOutput.permissionDecisionReason?.trim()) output.hookSpecificOutput.permissionDecisionReason = `${script}: protected action refused`;
      outputs.push(output);
      return 2;
    }
    outputs.push(output);
    if (output.continue === false || output.decision === 'block') return 2;
  }
  return 0;
}

function run(event) {
  const script = process.argv[2];
  if (!script) throw new Error('Missing shared hook script');
  let nativeEvent = event;
  if (script === 'post-read-scrubber.cjs') {
    const response = event.tool_response;
    const text = typeof response === 'string' ? response
      : response && Array.isArray(response.content) ? response.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
      : response && (response.output || response.stdout || response.text || response.content);
    // Scrubber expects a string and recognizes Bash/Read, unlike MCP wire output.
    nativeEvent = { ...event, tool_name: 'Bash', tool_response: typeof text === 'string' ? text : response };
  }
  if (script === 'skill-usage-logger.cjs' && event.tool_name === 'spawn_agent') nativeEvent = { ...event, tool_name: 'Agent' };
  const postToolUse = script === 'memory-guard.cjs' || script === 'edit-capture.cjs';
  const events = ['secret-scanner.cjs', 'path-guardrail.cjs', 'memory-guard.cjs', 'edit-capture.cjs'].includes(script) ? patchEvents(nativeEvent, { postToolUse }) : [nativeEvent];
  if (script === 'edit-capture.cjs') for (const input of events) input.tool_name = 'Edit';
  const outputs = [];
  for (const input of events) if (invoke(script, input, outputs) === 2) break;
  if (outputs.length) {
    const combined = {};
    for (const output of outputs) {
      if (output.systemMessage) combined.systemMessage = [combined.systemMessage, output.systemMessage].filter(Boolean).join('\n');
      if (output.continue === false) { combined.continue = false; combined.stopReason = output.stopReason; }
      if (output.decision === 'block') { combined.decision = 'block'; combined.reason = output.reason; }
      if (output.hookSpecificOutput) {
        const current = combined.hookSpecificOutput || {};
        const next = output.hookSpecificOutput;
        const deny = current.permissionDecision === 'deny' ? current : next;
        combined.hookSpecificOutput = { ...current, ...deny };
        if (next.additionalContext) combined.hookSpecificOutput.additionalContext = [current.additionalContext, next.additionalContext].filter(Boolean).join('\n');
      }
    }
    process.stdout.write(JSON.stringify(combined) + '\n');
  }
  return 0;
}
function main() {
  let event = null;
  try {
    event = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid hook event object');
    if (!['PreToolUse', 'PostToolUse', 'SubagentStop', 'SessionStart', 'Stop', 'SessionEnd', 'PreCompact'].includes(event.hook_event_name)) throw new Error('Invalid hook event name');
    return run(event);
  } catch (error) {
    process.stderr.write(`[codex-adapter] ${error.message}\n`);
    // A successful shell transport does not grant the operation: the explicit
    // stop is what blocks it, including malformed input or a crashed guard.
    process.stdout.write(JSON.stringify(refusal(event, `[codex-adapter] ${error.message}`)) + '\n');
    return 0;
  }
}
if (require.main === module) process.exitCode = main();
module.exports = { patchEvents, invoke, main };
