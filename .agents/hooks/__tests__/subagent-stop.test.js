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

// ─── SF-3.3: run_id and wave on SubagentStop completion rows ──────────────────
//
// PINNED CONTRACT (the tests are the spec; the implementer must not edit them).
//   Pointer: docs/.output/.state/telemetry/current-run-{session}.json under the SHARED-STATE root (the `projectRoot`
//   argument of processEvent, i.e. the root skill-usage.jsonl is written under; never the `sourceRoot` the role files
//   are read from): { run_id, plan, wave, story, since } (SF-3.1 seam). Read by `_lib/run-pointer.js` readRunPointer
//   (SF-3.2), which never throws and never blocks.
//   Session source (same rule as the SF-3.2 loggers): env CLAUDE_CODE_SESSION_ID first, else the payload's
//   `session_id` (Codex SubagentStop payloads carry one); neither, a non-string, or an unsafe id -> no pointer is read.
//   Stamping: a usable pointer adds EXACTLY two keys to the persisted row: run_id and wave (the pointer's number, else
//   null). `session_id` is NOT added to the row. The reminder returned to the harness is unchanged (still only
//   `systemMessage`). Any unusable pointer (absent, unreadable, directory, symlink, FIFO, oversized, corrupt, wrong
//   shape, another session's, no/unsafe session) leaves the row exactly as before SF-3.3: both keys ABSENT (not null),
//   the row is still written, the normal reminder is still returned (never the "could not be recorded" failure message),
//   the hook exits 0 and never blocks. Payloads the hook already rejects still write nothing. Every "unchanged" case is
//   paired with a control: the same path rewritten as a valid pointer MUST stamp.
//   Documentation (AC 2): the source comments state the stamp is effective only where SubagentStop is registered:
//   Claude `settings.json` does not register it; the Codex hooks config does (`hooks-config.json`). A ground-truth guard
//   keeps that statement true.

describe('SF-3.3 SubagentStop rows carry run_id and wave from the session pointer', () => {
  const BASE_KEYS = ['agent', 'agent_id', 'agent_type', 'description', 'hook_event_name', 'last_assistant_message', 'message_truncated', 'skills', 'skills_truncated', 'timestamp', 'type'];
  const POINTER = { run_id: '261118-1200-run-todo-software-factory', plan: 'docs/.output/plans/p.md', wave: 3, story: 'SF-3.3', since: '261118-1200' };
  const posixIt = process.platform === 'win32' ? it.skip : it;
  const nonRootPosixIt = process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? it.skip : it;
  let priorSession;

  const telemetryDir = (r = root) => path.join(r, 'docs/.output/.state/telemetry');
  const pointerPath = (session, r = root) => path.join(telemetryDir(r), `current-run-${session}.json`);
  const plant = (session, body, r = root) => {
    const p = pointerPath(session, r);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
    return p;
  };
  const unplant = p => fs.rmSync(p, { recursive: true, force: true });
  const keysOf = row => Object.keys(row).sort();
  const runHook = (input, session = 'sess-a') => spawnSync(process.execPath, [hook], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, AGENTS_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root, AGENT_SHARED_STATE_ROOT: root, AGENT_SOURCE_ROOT: root, CLAUDE_CODE_SESSION_ID: session },
  });

  beforeEach(() => { priorSession = process.env.CLAUDE_CODE_SESSION_ID; process.env.CLAUDE_CODE_SESSION_ID = 'sess-a'; });
  afterEach(() => {
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession;
  });

  // ── stamping ──────────────────────────────────────────────────────────

  it('processEvent_envSessionPointer_stampsRunIdAndWaveAndNothingElse', () => {
    plant('sess-a', POINTER);

    const reminder = require(hook).processEvent(payload(), root);

    expect(rows()).toHaveLength(1);
    expect(rows()[0].run_id).toBe(POINTER.run_id);
    expect(rows()[0].wave).toBe(3);
    expect(keysOf(rows()[0])).toEqual([...BASE_KEYS, 'run_id', 'wave'].sort());
    expect(Object.keys(reminder)).toEqual(['systemMessage']);
    expect(reminder.systemMessage).toContain('CHILD_DONE');
  });

  it('processEvent_stampedRow_keepsTheCompletionFieldsIntact', () => {
    plant('sess-a', POINTER);

    require(hook).processEvent(payload(), root);

    expect(rows()[0]).toMatchObject({ type: 'agent_dispatch', hook_event_name: 'SubagentStop', agent: 'general-purpose', agent_type: 'general-purpose', agent_id: 'child-1', last_assistant_message: 'CHILD_DONE', message_truncated: false, skills: [], description: null });
  });

  it('processEvent_noEnvSessionPayloadSessionIdFallback_stampsFromPayloadSessionPointer', () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    plant('sess-p', { ...POINTER, run_id: 'run-p', wave: 4 });

    require(hook).processEvent(payload({ session_id: 'sess-p' }), root);

    expect(rows()[0]).toMatchObject({ run_id: 'run-p', wave: 4 });
    expect('session_id' in rows()[0]).toBe(false);
  });

  it('processEvent_envSessionAndDifferentPayloadSession_usesTheEnvSession', () => {
    plant('sess-a', { ...POINTER, run_id: 'run-env', wave: 1 });
    plant('sess-p', { ...POINTER, run_id: 'run-payload', wave: 2 });

    require(hook).processEvent(payload({ session_id: 'sess-p' }), root);

    expect(rows()[0]).toMatchObject({ run_id: 'run-env', wave: 1 });
  });

  it('processEvent_pointerJustAfterStartWithNullWave_stampsRunIdAndNullWave', () => {
    plant('sess-a', { ...POINTER, wave: null, story: null, plan: null });

    require(hook).processEvent(payload(), root);

    expect(rows()[0].run_id).toBe(POINTER.run_id);
    expect('wave' in rows()[0]).toBe(true);
    expect(rows()[0].wave).toBeNull();
  });

  it('processEvent_pointerWaveIsNotANumber_stampsRunIdAndNullWave', () => {
    plant('sess-a', { ...POINTER, wave: '3' });

    require(hook).processEvent(payload(), root);

    expect(rows()[0].run_id).toBe(POINTER.run_id);
    expect(rows()[0].wave).toBeNull();
  });

  it('processEvent_pointerMovesToNextWaveBetweenCompletions_eachRowCarriesItsOwnWave', () => {
    plant('sess-a', { ...POINTER, wave: 1 });
    require(hook).processEvent(payload(), root);
    plant('sess-a', { ...POINTER, wave: 2 });
    require(hook).processEvent(payload({ agent_id: 'child-2' }), root);

    expect(rows().map(r => r.wave)).toEqual([1, 2]);
  });

  it('processEvent_twoSessionsInOneTree_eachCompletionCarriesItsOwnSessionsRun', () => {
    plant('sess-a', { ...POINTER, run_id: 'run-a', wave: 1 });
    plant('sess-b', { ...POINTER, run_id: 'run-b', wave: 9 });

    require(hook).processEvent(payload(), root);
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-b';
    require(hook).processEvent(payload({ agent_id: 'child-2' }), root);

    expect(rows().map(r => [r.run_id, r.wave])).toEqual([['run-a', 1], ['run-b', 9]]);
  });

  it('processEvent_pointerIsReadFromTheSharedStateRootNotTheSourceRoot', () => {
    const source = path.join(root, 'source');
    const shared = path.join(root, 'shared');
    plant('sess-a', { ...POINTER, run_id: 'run-source' }, source);
    plant('sess-a', { ...POINTER, run_id: 'run-shared' }, shared);

    require(hook).processEvent(payload(), shared, source);

    const row = JSON.parse(fs.readFileSync(telemetry(shared), 'utf8').trim());
    expect(row.run_id).toBe('run-shared');
  });

  it('processEvent_pointerOnlyUnderTheSourceRoot_rowUnchanged', () => {
    const source = path.join(root, 'source');
    const shared = path.join(root, 'shared');
    plant('sess-a', POINTER, source);

    require(hook).processEvent(payload(), shared, source);

    const row = JSON.parse(fs.readFileSync(telemetry(shared), 'utf8').trim());
    expect(keysOf(row)).toEqual(BASE_KEYS);
  });

  it('processEvent_cwdFieldOnPayload_doesNotRedirectThePointerRead', () => {
    const decoy = path.join(root, 'decoy');
    plant('sess-a', { ...POINTER, run_id: 'run-decoy' }, decoy);
    plant('sess-a', POINTER);

    require(hook).processEvent(payload({ cwd: decoy }), root);

    expect(rows()[0].run_id).toBe(POINTER.run_id);
  });

  it.each([payload({ hook_event_name: 'PostToolUse' }), payload({ agent_type: '../outside' }), payload({ agent_id: '' })])(
    'processEvent_rejectedPayloadWithValidPointer_returnsNullAndWritesNoTelemetry: %j',
    input => {
      plant('sess-a', POINTER);

      expect(require(hook).processEvent(input, root)).toBeNull();
      expect(fs.existsSync(telemetry(root))).toBe(false);
    },
  );

  it('hookProcess_validPointer_exits0StampsTheRowAndReturnsTheNormalReminder', () => {
    plant('sess-a', POINTER);

    const result = runHook(payload());

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).systemMessage).toContain('CHILD_DONE');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ run_id: POINTER.run_id, wave: 3 });
  });

  it('hookProcess_payloadSessionIdWithoutEnv_stampsFromPayloadSession', () => {
    plant('sess-p', { ...POINTER, run_id: 'run-p', wave: 4 });
    const env = { ...process.env, AGENTS_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root, AGENT_SHARED_STATE_ROOT: root, AGENT_SOURCE_ROOT: root };
    delete env.CLAUDE_CODE_SESSION_ID;

    const result = spawnSync(process.execPath, [hook], { input: JSON.stringify(payload({ session_id: 'sess-p' })), encoding: 'utf8', timeout: 15000, windowsHide: true, env });

    expect(result.status).toBe(0);
    expect(rows()[0]).toMatchObject({ run_id: 'run-p', wave: 4 });
  });

  // ── unchanged when absent ─────────────────────────────────────────────

  it('processEvent_absentPointer_rowKeysExactlyAsBefore', () => {
    require(hook).processEvent(payload(), root);

    expect(keysOf(rows()[0])).toEqual(BASE_KEYS);
    expect('run_id' in rows()[0]).toBe(false);
    expect('wave' in rows()[0]).toBe(false);
  });

  it('hookProcess_absentPointer_exits0WritesTheUnchangedRowAndTheNormalReminder', () => {
    const result = runHook(payload());

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).systemMessage).toContain('CHILD_DONE');
    expect(keysOf(rows()[0])).toEqual(BASE_KEYS);
  });

  it('processEvent_noSessionAtAll_rowUnchangedEvenWhenPointerFilesExist', () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    plant('sess-a', POINTER);
    plant('undefined', POINTER);
    plant('null', POINTER);
    plant('', POINTER);

    require(hook).processEvent(payload(), root);
    require(hook).processEvent(payload({ session_id: 'sess-a' }), root);

    expect(keysOf(rows()[0])).toEqual(BASE_KEYS);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });

  it('processEvent_onlyAnotherSessionsPointerExists_rowUnchangedAndThatSessionStillStamps', () => {
    plant('sess-b', POINTER);

    require(hook).processEvent(payload(), root);
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-b';
    require(hook).processEvent(payload(), root);

    expect(keysOf(rows()[0])).toEqual(BASE_KEYS);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });

  // ── adversarial pointers: row unchanged, hook exits 0, a valid pointer in the same place still stamps ──

  const CORRUPT = [
    ['not JSON', '{nope'],
    ['empty file', ''],
    ['truncated JSON', '{"run_id":"r1","wa'],
    ['a JSON array', '[]'],
    ['a JSON string', '"run-1"'],
    ['JSON null', 'null'],
    ['no run_id', '{"wave":1,"plan":null,"story":null,"since":"261118-1200"}'],
    ['run_id a number', '{"run_id":7,"wave":1}'],
    ['run_id empty string', '{"run_id":"","wave":1}'],
    ['binary garbage', Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]).toString('latin1')],
  ];

  it.each(CORRUPT)('processEvent_corruptPointer_%s_rowStillWrittenUnchangedThenValidPointerStamps', (_name, body) => {
    const p = plant('sess-a', body);

    const reminder = require(hook).processEvent(payload(), root);
    unplant(p);
    plant('sess-a', POINTER);
    require(hook).processEvent(payload({ agent_id: 'child-2' }), root);

    expect(reminder.systemMessage).toContain('CHILD_DONE');
    expect(rows()).toHaveLength(2);
    expect(keysOf(rows()[0])).toEqual(BASE_KEYS);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });

  it.each(CORRUPT)('hookProcess_corruptPointer_%s_exits0WritesTheUnchangedRowAndTheNormalReminder', (_name, body) => {
    plant('sess-a', body);

    const result = runHook(payload());

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).systemMessage).toContain('CHILD_DONE');
    expect(result.stdout).not.toContain('could not be recorded');
    expect(rows()).toHaveLength(1);
    expect(keysOf(rows()[0])).toEqual(BASE_KEYS);
  });

  it('processEvent_pointerPathIsADirectory_rowUnchangedThenValidPointerStamps', () => {
    const p = pointerPath('sess-a');
    fs.mkdirSync(p, { recursive: true });

    require(hook).processEvent(payload(), root);
    unplant(p);
    plant('sess-a', POINTER);
    require(hook).processEvent(payload({ agent_id: 'child-2' }), root);

    expect(keysOf(rows()[0])).toEqual(BASE_KEYS);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });

  it('hookProcess_pointerPathIsADirectory_exits0AndWritesTheUnchangedRow', () => {
    fs.mkdirSync(pointerPath('sess-a'), { recursive: true });

    const result = runHook(payload());

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('could not be recorded');
    expect(keysOf(rows()[0])).toEqual(BASE_KEYS);
  });

  nonRootPosixIt('processEvent_pointerUnreadableMode000_rowUnchangedThenReadablePointerStamps', () => {
    const p = plant('sess-a', POINTER);
    fs.chmodSync(p, 0o000);

    require(hook).processEvent(payload(), root);
    fs.chmodSync(p, 0o600);
    require(hook).processEvent(payload({ agent_id: 'child-2' }), root);

    expect(keysOf(rows()[0])).toEqual(BASE_KEYS);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });

  nonRootPosixIt('hookProcess_pointerUnreadableMode000_exits0AndWritesTheUnchangedRow', () => {
    const p = plant('sess-a', POINTER);
    fs.chmodSync(p, 0o000);

    const result = runHook(payload());

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('could not be recorded');
    expect(keysOf(rows()[0])).toEqual(BASE_KEYS);
  });

  it('processEvent_pointerOverTheSizeCap_treatedAsCorruptRowUnchanged', () => {
    const p = plant('sess-a', JSON.stringify(POINTER) + ' '.repeat(2 * 1024 * 1024));

    require(hook).processEvent(payload(), root);
    unplant(p);
    plant('sess-a', POINTER);
    require(hook).processEvent(payload({ agent_id: 'child-2' }), root);

    expect(keysOf(rows()[0])).toEqual(BASE_KEYS);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });

  posixIt('processEvent_pointerIsASymlinkToAValidPointer_notFollowedThenValidPointerStamps', () => {
    const target = path.join(root, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify(POINTER));
    const p = pointerPath('sess-a');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.symlinkSync(target, p);

    require(hook).processEvent(payload(), root);
    unplant(p);
    plant('sess-a', POINTER);
    require(hook).processEvent(payload({ agent_id: 'child-2' }), root);

    expect(keysOf(rows()[0])).toEqual(BASE_KEYS);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });

  posixIt('hookProcess_pointerIsASymlinkToAValidPointer_exits0NotFollowedRowUnchanged', () => {
    const target = path.join(root, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify(POINTER));
    const p = pointerPath('sess-a');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.symlinkSync(target, p);

    const result = runHook(payload());

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('could not be recorded');
    expect(keysOf(rows()[0])).toEqual(BASE_KEYS);
  });

  posixIt('hookProcess_pointerIsAFifo_neverBlocksExits0AndWritesTheUnchangedRow', () => {
    // A plain open of a FIFO with no writer hangs forever; the hard spawnSync timeout turns that into result.error.
    const p = pointerPath('sess-a');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    expect(spawnSync('mkfifo', [p]).status).toBe(0);

    const result = runHook(payload());

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).systemMessage).toContain('CHILD_DONE');
    expect(keysOf(rows()[0])).toEqual(BASE_KEYS);
  });

  posixIt('hookProcess_fifoReplacedByValidPointer_nextRowStamps', () => {
    const p = pointerPath('sess-a');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    expect(spawnSync('mkfifo', [p]).status).toBe(0);
    const first = runHook(payload());
    unplant(p);
    plant('sess-a', POINTER);

    const second = runHook(payload({ agent_id: 'child-2' }));

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(keysOf(rows()[0])).toEqual(BASE_KEYS);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });

  it.each([['../evil'], ['a/b'], ['..'], ['a b'], ['sess*'], ['']])(
    'processEvent_unsafePayloadSessionId_%j_rowUnchangedAndNothingReadOutsideTheTelemetryDir',
    unsafe => {
      delete process.env.CLAUDE_CODE_SESSION_ID;
      fs.mkdirSync(path.join(telemetryDir(), 'current-run-..'), { recursive: true });
      fs.writeFileSync(path.join(telemetryDir(), 'current-run-..', 'current-run-evil.json'), JSON.stringify(POINTER));
      fs.writeFileSync(path.join(telemetryDir(), 'current-run-.json'), JSON.stringify(POINTER));
      fs.writeFileSync(path.join(root, 'docs/.output/.state/current-run-evil.json'), JSON.stringify(POINTER));
      plant('sess-a', POINTER);

      require(hook).processEvent(payload({ session_id: unsafe }), root);
      require(hook).processEvent(payload({ session_id: 'sess-a', agent_id: 'child-2' }), root);

      expect(keysOf(rows()[0])).toEqual(BASE_KEYS);
      expect(rows()[1].run_id).toBe(POINTER.run_id);
    },
  );

  it.each([[undefined], [null], [{}], [42]])('processEvent_nonStringPayloadSessionId_%j_rowUnchangedAndNoThrow', weird => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    plant('sess-a', POINTER);

    require(hook).processEvent(payload({ session_id: weird }), root);
    require(hook).processEvent(payload({ session_id: 'sess-a', agent_id: 'child-2' }), root);

    expect(rows()).toHaveLength(2);
    expect('run_id' in rows()[0]).toBe(false);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });

  it('hookProcess_telemetryFileIsADirectoryWithPointerPresent_stillSurfacesTheNonblockingWriteFailure', () => {
    // Existing failure semantics are untouched by the stamp: a write failure is reported, never a silent success.
    plant('sess-a', POINTER);
    fs.mkdirSync(telemetry(root));

    const result = runHook(payload());

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).systemMessage).toContain('could not be recorded');
    expect(result.stdout).not.toContain('CHILD_DONE');
  });

  // ── documentation: the stamp is effective only where SubagentStop is registered ──

  it('subagentStopSource_documentsRunIdStampIsEffectiveOnlyWhereTheEventIsRegistered', () => {
    const src = fs.readFileSync(hook, 'utf8');
    const comments = src.split('\n').filter(l => /^\s*(\/\/|\/?\*)/.test(l)).join('\n');

    expect(comments).toMatch(/run_id/);
    expect(comments).toMatch(/settings\.json[\s\S]{0,200}(not|n't)[\s\S]{0,60}regist|not registered[\s\S]{0,200}settings\.json/i);
    expect(comments).toMatch(/Codex[\s\S]{0,200}regist|regist[\s\S]{0,200}Codex/);
  });

  it('registrationGroundTruth_claudeSettingsDoNotRegisterSubagentStopAndCodexHooksConfigDoes', () => {
    // Guard (green by design): keeps the documented statement true. If Claude registers it later, update the comment.
    const claudeSettings = path.resolve('.claude/settings.json');
    const codexConfig = fs.readFileSync(path.resolve('.agents/adapters/codex/hooks-config.json'), 'utf8');

    expect(fs.existsSync(claudeSettings) ? fs.readFileSync(claudeSettings, 'utf8') : '').not.toContain('SubagentStop');
    expect(codexConfig).toContain('"SubagentStop"');
    expect(codexConfig).toContain('subagent-stop.cjs');
  });
});


// ── Wave 4 Group B review: M2 (the pointer root) and a hook-level FIFO pointer ────────────────────────────────
describe('M2 a linked-worktree SubagentStop row is stamped from the pointer under the main worktree', () => {
  const { createLinkedWorktree } = require('../../core/__tests__/_helpers/linked-worktree');
  const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
  const gitIt = hasGit ? it : it.skip;
  const POINTER = { run_id: '261118-1200-run-todo-wt', plan: null, wave: 2, story: null, since: '261118-1200' };
  let fx = null;
  let priorSession;
  let priorShared;

  beforeEach(() => {
    priorSession = process.env.CLAUDE_CODE_SESSION_ID;
    priorShared = process.env.AGENT_SHARED_STATE_ROOT;
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-wt';
    delete process.env.AGENT_SHARED_STATE_ROOT;
  });
  afterEach(() => {
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession;
    if (priorShared !== undefined) process.env.AGENT_SHARED_STATE_ROOT = priorShared;
    if (fx) { fx.cleanup(); fx = null; }
  });

  gitIt('processEvent_projectRootIsTheLinkedWorktree_stampsFromThePointerUnderTheMainWorktree', () => {
    fx = createLinkedWorktree();
    const pointer = path.join(fx.main, 'docs/.output/.state/telemetry/current-run-sess-wt.json');
    fs.mkdirSync(path.dirname(pointer), { recursive: true });
    fs.writeFileSync(pointer, JSON.stringify(POINTER));

    require(hook).processEvent(payload(), fx.linked);

    const row = JSON.parse(fs.readFileSync(path.join(fx.linked, 'docs/.output/.state/telemetry/skill-usage.jsonl'), 'utf8').trim());
    expect(row).toMatchObject({ run_id: POINTER.run_id, wave: 2 });
  });

  (process.platform === 'win32' ? it.skip : it)('hookProcess_pointerIsAFifo_neverBlocksExits0AndWritesTheUnchangedRow', () => {
    const pointer = path.join(root, 'docs/.output/.state/telemetry/current-run-sess-a.json');
    fs.mkdirSync(path.dirname(pointer), { recursive: true });
    expect(spawnSync('mkfifo', [pointer]).status).toBe(0);

    const res = spawnSync(process.execPath, [hook], {
      input: JSON.stringify(payload()), encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, AGENTS_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root, AGENT_SHARED_STATE_ROOT: root, AGENT_SOURCE_ROOT: root, CLAUDE_CODE_SESSION_ID: 'sess-a' },
    });

    expect(res.error).toBeUndefined();
    expect(res.signal).toBeNull();
    expect(res.status).toBe(0);
    const row = JSON.parse(fs.readFileSync(path.join(root, 'docs/.output/.state/telemetry/skill-usage.jsonl'), 'utf8').trim());
    expect('run_id' in row).toBe(false);
  });
});

describe('n5 stampRun keeps the completion row when the pointer lookup itself throws', () => {
  const POINTER = { run_id: '261118-1200-run-todo-software-factory', plan: null, wave: 2, story: 'SF-3.3', since: '261118-1200' };

  it('stampRun_aRootThatMakesPointerRootThrow_returnsTheRowUnchangedWithoutThrowing', () => {
    const row = { type: 'agent_dispatch', agent: 'general-purpose' };
    let out;

    expect(() => { out = require(hook).stampRun(row, 12345, 'sess-a'); }).not.toThrow();

    expect(out).toBe(row);
    expect(Object.keys(out).sort()).toEqual(['agent', 'type']);
  });

  it('stampRun_aUsablePointer_stampsRunIdAndWave', () => {
    const pointer = path.join(root, 'docs/.output/.state/telemetry/current-run-sess-n5.json');
    fs.mkdirSync(path.dirname(pointer), { recursive: true });
    fs.writeFileSync(pointer, JSON.stringify(POINTER));
    const prior = process.env.AGENT_SHARED_STATE_ROOT;
    delete process.env.AGENT_SHARED_STATE_ROOT;
    try {
      expect(require(hook).stampRun({ type: 'agent_dispatch' }, root, 'sess-n5')).toEqual({ type: 'agent_dispatch', run_id: POINTER.run_id, wave: 2 });
    } finally {
      if (prior !== undefined) process.env.AGENT_SHARED_STATE_ROOT = prior;
    }
  });
});
