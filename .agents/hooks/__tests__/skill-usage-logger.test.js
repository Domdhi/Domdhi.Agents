// Tests for skill-usage-logger.cjs — dual-trigger skill telemetry (PostToolUse
// Read + Agent). Logger never blocks; we test the pure parse/resolve helpers and
// processEvent routing (without asserting file writes).

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { processEvent, parseSkillPath, resolveAgentSkills } = require('../../../.agents/hooks/skill-usage-logger.cjs');

describe('parseSkillPath', () => {
  it('extracts skill + file from a .claude/skills path', () => {
    expect(parseSkillPath('/repo/.claude/skills/dev-process/SKILL.md')).toEqual({
      skill: 'dev-process',
      file: 'SKILL.md',
    });
  });

  it('extracts nested references files', () => {
    expect(parseSkillPath('/repo/.claude/skills/example-skill/references/guide.md')).toEqual({
      skill: 'example-skill',
      file: 'references/guide.md',
    });
  });

  it('normalizes Windows separators', () => {
    expect(parseSkillPath('C:\\repo\\.claude\\skills\\code-review\\SKILL.md')).toEqual({
      skill: 'code-review',
      file: 'SKILL.md',
    });
  });

  it('returns null for non-skill paths and bad input', () => {
    expect(parseSkillPath('/repo/.claude/agents/architect.md')).toBeNull();
    expect(parseSkillPath('/repo/src/index.js')).toBeNull();
    expect(parseSkillPath(null)).toBeNull();
    expect(parseSkillPath(42)).toBeNull();
  });
});

describe('resolveAgentSkills', () => {
  it('reads the skills: frontmatter list from a real agent file', () => {
    // general-purpose ships a non-empty skills: list in this repo.
    const skills = resolveAgentSkills('general-purpose', process.cwd());
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThan(0);
  });

  it('returns [] for unknown agents and bad input', () => {
    expect(resolveAgentSkills('no-such-agent', process.cwd())).toEqual([]);
    expect(resolveAgentSkills(null, process.cwd())).toEqual([]);
    expect(resolveAgentSkills('', process.cwd())).toEqual([]);
  });
});

describe('processEvent — subagent dispatch (the S-PI.4 producer)', () => {
  let sandbox;
  let prevProjectDir;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-usage-'));
    // Seed a minimal agent definition so resolveAgentSkills finds a skills: list.
    const agentsDir = path.join(sandbox, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'general-purpose.md'),
      '---\nname: general-purpose\nskills:\n  - full-output-enforcement\n  - systematic-debugging\n---\n\nBody.\n',
    );
    prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = sandbox;
  });

  afterEach(() => {
    if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function readRows() {
    const jsonl = path.join(sandbox, 'docs', '.output', '.state', 'telemetry', 'skill-usage.jsonl');
    if (!fs.existsSync(jsonl)) return [];
    return fs.readFileSync(jsonl, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it('emits an agent_dispatch event for a Task-named tool payload', () => {
    const event = processEvent({
      tool_name: 'Task',
      tool_input: { subagent_type: 'general-purpose', description: 'x' },
    });
    expect(event).not.toBeNull();
    expect(event.type).toBe('agent_dispatch');
    expect(event.agent).toBe('general-purpose');
    expect(event.description).toBe('x');
    expect(Array.isArray(event.skills)).toBe(true);
    expect(event.skills.length).toBeGreaterThan(0);
  });

  it('appends the agent_dispatch row to skill-usage.jsonl on a Task dispatch', () => {
    processEvent({
      tool_name: 'Task',
      tool_input: { subagent_type: 'general-purpose', description: 'do work' },
    });
    const rows = readRows();
    const dispatches = rows.filter((r) => r.type === 'agent_dispatch');
    expect(dispatches.length).toBe(1);
    expect(dispatches[0].agent).toBe('general-purpose');
    // feedback-digest readSkillUsage() keys on exactly these fields.
    expect(dispatches[0]).toHaveProperty('timestamp');
    expect(dispatches[0]).toHaveProperty('skills');
  });

  it('still emits for the legacy Agent tool name', () => {
    const event = processEvent({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'general-purpose' },
    });
    expect(event).not.toBeNull();
    expect(event.type).toBe('agent_dispatch');
    expect(event.agent).toBe('general-purpose');
  });
});

// ─── SF-3.3: run_id and wave on agent_dispatch rows ───────────────────────────
//
// PINNED CONTRACT (the tests are the spec; the implementer must not edit them).
//   Pointer: docs/.output/.state/telemetry/current-run-{session}.json under the hook's resolved project root (the same
//   root skill-usage.jsonl is written under): { run_id, plan, wave, story, since } (the "run id and session pointer"
//   seam, SF-3.1). Read by `_lib/run-pointer.js` readRunPointer (SF-3.2), which never throws and never blocks.
//   Session source (same rule as command-usage-logger, SF-3.2): env CLAUDE_CODE_SESSION_ID first, else the hook payload's
//   `session_id`; neither, or an unsafe id (SESSION_RE) -> no pointer is read.
//   Stamping: a usable pointer adds EXACTLY two keys to the `agent_dispatch` row: run_id (the pointer's string) and
//   wave (the pointer's number, else null). `session_id` is NOT added to the row (only the two keys). `skill_read` rows
//   are NEVER stamped (the AC names agent_dispatch only), even with a valid pointer. Any unusable pointer (absent,
//   unreadable, directory, symlink, FIFO, oversized, corrupt, wrong shape, another session's, no/unsafe session) leaves
//   the row exactly as before SF-3.3: both keys ABSENT (not null), the row is still written, the hook exits 0 and never
//   blocks. Every "unchanged" case is paired with a control: the same path rewritten as a valid pointer MUST stamp.
//   The row that is returned by processEvent equals the row appended to skill-usage.jsonl.

describe('SF-3.3 agent_dispatch rows carry run_id and wave from the session pointer', () => {
  const { spawnSync } = require('node:child_process');
  const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skill-usage-logger.cjs');
  const TELEMETRY = ['docs', '.output', '.state', 'telemetry'];
  const POINTER = { run_id: '261118-1200-run-todo-software-factory', plan: 'docs/.output/plans/p.md', wave: 3, story: 'SF-3.3', since: '261118-1200' };
  const DISPATCH_KEYS = ['agent', 'description', 'skills', 'timestamp', 'type'];
  const READ_KEYS = ['file', 'skill', 'timestamp', 'type'];
  const DISPATCH = { tool_name: 'Task', tool_input: { subagent_type: 'general-purpose', description: 'do work' } };
  const posixIt = process.platform === 'win32' ? it.skip : it;
  const nonRootPosixIt = process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? it.skip : it;
  let tmp;
  let priorProjectDir;
  let priorSession;

  const telemetryDir = () => path.join(tmp, ...TELEMETRY);
  const jsonlPath = () => path.join(telemetryDir(), 'skill-usage.jsonl');
  const pointerPath = (session) => path.join(telemetryDir(), `current-run-${session}.json`);
  const plant = (session, body) => {
    const p = pointerPath(session);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
    return p;
  };
  const unplant = (p) => fs.rmSync(p, { recursive: true, force: true });
  const rows = () => (fs.existsSync(jsonlPath()) ? fs.readFileSync(jsonlPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const keysOf = (row) => Object.keys(row).sort();
  // The real hook as the harness runs it. A hard timeout turns a blocked pointer read into res.error.
  const runHook = (payload, session = 'sess-a') => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmp, CLAUDE_CODE_SESSION_ID: session },
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-usage-sf33-'));
    fs.mkdirSync(path.join(tmp, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'agents', 'general-purpose.md'), '---\nname: general-purpose\nskills:\n  - full-output-enforcement\n---\n\nBody.\n');
    priorProjectDir = process.env.CLAUDE_PROJECT_DIR;
    priorSession = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_PROJECT_DIR = tmp;
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-a';
  });

  afterEach(() => {
    if (priorProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = priorProjectDir;
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ── stamping ──────────────────────────────────────────────────────────

  it('processEvent_agentDispatchWithEnvSessionPointer_stampsRunIdAndWaveAndNothingElse', () => {
    plant('sess-a', POINTER);

    const event = processEvent(DISPATCH);

    expect(event.run_id).toBe(POINTER.run_id);
    expect(event.wave).toBe(3);
    expect(keysOf(event)).toEqual([...DISPATCH_KEYS, 'run_id', 'wave'].sort());
    expect(rows()).toEqual([event]);
  });

  it.each([
    ['legacy Agent tool name', { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose' } }],
    ['subagent_type on an unrecognised tool name', { tool_name: 'Delegate', tool_input: { subagent_type: 'general-purpose' } }],
    ['no subagent_type (defaults to general-purpose)', { tool_name: 'Task', tool_input: { description: 'x' } }],
  ])('processEvent_agentDispatch_%s_stampsRunIdAndWave', (_name, payload) => {
    plant('sess-a', POINTER);

    processEvent(payload);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ type: 'agent_dispatch', run_id: POINTER.run_id, wave: 3 });
  });

  it('processEvent_stampedRow_keepsAgentSkillsAndDescriptionIntact', () => {
    plant('sess-a', POINTER);

    const event = processEvent(DISPATCH);

    expect(event).toMatchObject({ type: 'agent_dispatch', agent: 'general-purpose', skills: ['full-output-enforcement'], description: 'do work' });
  });

  it('processEvent_noEnvSessionPayloadSessionIdFallback_stampsFromPayloadSessionPointer', () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    plant('sess-p', { ...POINTER, run_id: 'run-p', wave: 4 });

    const event = processEvent({ ...DISPATCH, session_id: 'sess-p' });

    expect(event).toMatchObject({ run_id: 'run-p', wave: 4 });
    expect('session_id' in event).toBe(false);
  });

  it('processEvent_envSessionAndDifferentPayloadSession_usesTheEnvSession', () => {
    plant('sess-a', { ...POINTER, run_id: 'run-env', wave: 1 });
    plant('sess-p', { ...POINTER, run_id: 'run-payload', wave: 2 });

    const event = processEvent({ ...DISPATCH, session_id: 'sess-p' });

    expect(event).toMatchObject({ run_id: 'run-env', wave: 1 });
  });

  it('processEvent_pointerJustAfterStartWithNullWave_stampsRunIdAndNullWave', () => {
    plant('sess-a', { ...POINTER, wave: null, story: null, plan: null });

    const event = processEvent(DISPATCH);

    expect(event.run_id).toBe(POINTER.run_id);
    expect('wave' in event).toBe(true);
    expect(event.wave).toBeNull();
  });

  it('processEvent_pointerWaveIsNotANumber_stampsRunIdAndNullWave', () => {
    plant('sess-a', { ...POINTER, wave: '3' });

    const event = processEvent(DISPATCH);

    expect(event.run_id).toBe(POINTER.run_id);
    expect(event.wave).toBeNull();
  });

  it('processEvent_pointerMovesToNextWaveBetweenDispatches_eachRowCarriesItsOwnWave', () => {
    plant('sess-a', { ...POINTER, wave: 1 });
    processEvent(DISPATCH);
    plant('sess-a', { ...POINTER, wave: 2 });
    processEvent(DISPATCH);

    expect(rows().map((r) => r.wave)).toEqual([1, 2]);
  });

  it('processEvent_twoSessionsInOneTree_eachDispatchCarriesItsOwnSessionsRun', () => {
    plant('sess-a', { ...POINTER, run_id: 'run-a', wave: 1 });
    plant('sess-b', { ...POINTER, run_id: 'run-b', wave: 9 });

    processEvent(DISPATCH);
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-b';
    processEvent(DISPATCH);

    expect(rows().map((r) => [r.run_id, r.wave])).toEqual([['run-a', 1], ['run-b', 9]]);
  });

  it('processEvent_cwdFieldOnPayload_doesNotRedirectThePointerRead', () => {
    const decoy = path.join(tmp, 'decoy');
    fs.mkdirSync(path.join(decoy, ...TELEMETRY), { recursive: true });
    fs.writeFileSync(path.join(decoy, ...TELEMETRY, 'current-run-sess-a.json'), JSON.stringify({ ...POINTER, run_id: 'run-decoy' }));
    plant('sess-a', POINTER);

    const event = processEvent({ ...DISPATCH, cwd: decoy });

    expect(event.run_id).toBe(POINTER.run_id);
  });

  it('processEvent_skillReadRowWithValidPointer_isNeverStamped', () => {
    plant('sess-a', POINTER);

    const event = processEvent({ tool_name: 'Read', tool_input: { file_path: '/repo/.claude/skills/dev-process/SKILL.md' } });

    expect(keysOf(event)).toEqual(READ_KEYS);
    expect(keysOf(rows()[0])).toEqual(READ_KEYS);
  });

  it('hookProcess_validPointer_exits0AndStampsTheRow', () => {
    plant('sess-a', POINTER);

    const res = runHook(DISPATCH);

    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ type: 'agent_dispatch', run_id: POINTER.run_id, wave: 3 });
  });

  // ── unchanged when absent ─────────────────────────────────────────────

  it('processEvent_absentPointer_rowKeysExactlyAsBefore', () => {
    const event = processEvent(DISPATCH);

    expect(keysOf(event)).toEqual(DISPATCH_KEYS);
    expect('run_id' in event).toBe(false);
    expect('wave' in event).toBe(false);
    expect(keysOf(rows()[0])).toEqual(DISPATCH_KEYS);
  });

  it('hookProcess_absentPointer_exits0AndWritesTheUnchangedRow', () => {
    const res = runHook(DISPATCH);

    expect(res.status).toBe(0);
    expect(keysOf(rows()[0])).toEqual(DISPATCH_KEYS);
  });

  it('processEvent_noSessionAtAll_rowUnchangedEvenWhenPointerFilesExist', () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    plant('sess-a', POINTER);
    plant('undefined', POINTER);
    plant('null', POINTER);
    plant('', POINTER);

    processEvent(DISPATCH);
    processEvent({ ...DISPATCH, session_id: 'sess-a' });

    expect(keysOf(rows()[0])).toEqual(DISPATCH_KEYS);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });

  it('processEvent_onlyAnotherSessionsPointerExists_rowUnchangedAndThatSessionStillStamps', () => {
    plant('sess-b', POINTER);

    processEvent(DISPATCH);
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-b';
    processEvent(DISPATCH);

    expect(keysOf(rows()[0])).toEqual(DISPATCH_KEYS);
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

    const first = processEvent(DISPATCH);
    unplant(p);
    plant('sess-a', POINTER);
    processEvent(DISPATCH);

    expect(first).not.toBeNull();
    expect(rows()).toHaveLength(2);
    expect(keysOf(rows()[0])).toEqual(DISPATCH_KEYS);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });

  it.each(CORRUPT)('hookProcess_corruptPointer_%s_exits0AndWritesTheUnchangedRow', (_name, body) => {
    plant('sess-a', body);

    const res = runHook(DISPATCH);

    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(rows()).toHaveLength(1);
    expect(keysOf(rows()[0])).toEqual(DISPATCH_KEYS);
  });

  it('processEvent_pointerPathIsADirectory_rowUnchangedThenValidPointerStamps', () => {
    const p = pointerPath('sess-a');
    fs.mkdirSync(p, { recursive: true });

    processEvent(DISPATCH);
    unplant(p);
    plant('sess-a', POINTER);
    processEvent(DISPATCH);

    expect(keysOf(rows()[0])).toEqual(DISPATCH_KEYS);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });

  it('hookProcess_pointerPathIsADirectory_exits0AndWritesTheUnchangedRow', () => {
    fs.mkdirSync(pointerPath('sess-a'), { recursive: true });

    const res = runHook(DISPATCH);

    expect(res.status).toBe(0);
    expect(keysOf(rows()[0])).toEqual(DISPATCH_KEYS);
  });

  nonRootPosixIt('processEvent_pointerUnreadableMode000_rowUnchangedThenReadablePointerStamps', () => {
    const p = plant('sess-a', POINTER);
    fs.chmodSync(p, 0o000);

    processEvent(DISPATCH);
    fs.chmodSync(p, 0o600);
    processEvent(DISPATCH);

    expect(keysOf(rows()[0])).toEqual(DISPATCH_KEYS);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });

  nonRootPosixIt('hookProcess_pointerUnreadableMode000_exits0AndWritesTheUnchangedRow', () => {
    const p = plant('sess-a', POINTER);
    fs.chmodSync(p, 0o000);

    const res = runHook(DISPATCH);

    expect(res.status).toBe(0);
    expect(keysOf(rows()[0])).toEqual(DISPATCH_KEYS);
  });

  it('processEvent_pointerOverTheSizeCap_treatedAsCorruptRowUnchanged', () => {
    const p = plant('sess-a', JSON.stringify(POINTER) + ' '.repeat(2 * 1024 * 1024));

    processEvent(DISPATCH);
    unplant(p);
    plant('sess-a', POINTER);
    processEvent(DISPATCH);

    expect(keysOf(rows()[0])).toEqual(DISPATCH_KEYS);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });

  posixIt('hookProcess_pointerIsASymlinkToAValidPointer_exits0NotFollowedRowUnchanged', () => {
    const target = path.join(tmp, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify(POINTER));
    const p = pointerPath('sess-a');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.symlinkSync(target, p);

    const res = runHook(DISPATCH);

    expect(res.status).toBe(0);
    expect(keysOf(rows()[0])).toEqual(DISPATCH_KEYS);
  });

  posixIt('processEvent_pointerIsASymlinkToAValidPointer_notFollowedThenValidPointerStamps', () => {
    const target = path.join(tmp, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify(POINTER));
    const p = pointerPath('sess-a');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.symlinkSync(target, p);

    processEvent(DISPATCH);
    unplant(p);
    plant('sess-a', POINTER);
    processEvent(DISPATCH);

    expect(keysOf(rows()[0])).toEqual(DISPATCH_KEYS);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });

  posixIt('hookProcess_pointerIsAFifo_neverBlocksExits0AndWritesTheUnchangedRow', () => {
    // A plain open of a FIFO with no writer hangs forever; the hard spawnSync timeout turns that into res.error.
    const p = pointerPath('sess-a');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    expect(spawnSync('mkfifo', [p]).status).toBe(0);

    const res = runHook(DISPATCH);

    expect(res.error).toBeUndefined();
    expect(res.signal).toBeNull();
    expect(res.status).toBe(0);
    expect(keysOf(rows()[0])).toEqual(DISPATCH_KEYS);
  });

  posixIt('hookProcess_fifoReplacedByValidPointer_nextRowStamps', () => {
    const p = pointerPath('sess-a');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    expect(spawnSync('mkfifo', [p]).status).toBe(0);
    const first = runHook(DISPATCH);
    unplant(p);
    plant('sess-a', POINTER);

    const second = runHook(DISPATCH);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(keysOf(rows()[0])).toEqual(DISPATCH_KEYS);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });

  it.each([['../evil'], ['a/b'], ['..'], ['a b'], ['sess*'], ['']])(
    'processEvent_unsafePayloadSessionId_%j_rowUnchangedAndNothingReadOutsideTheTelemetryDir',
    (unsafe) => {
      delete process.env.CLAUDE_CODE_SESSION_ID;
      fs.mkdirSync(path.join(telemetryDir(), 'current-run-..'), { recursive: true });
      fs.writeFileSync(path.join(telemetryDir(), 'current-run-..', 'current-run-evil.json'), JSON.stringify(POINTER));
      fs.writeFileSync(path.join(telemetryDir(), 'current-run-.json'), JSON.stringify(POINTER));
      fs.writeFileSync(path.join(tmp, 'docs', '.output', '.state', 'current-run-evil.json'), JSON.stringify(POINTER));
      plant('sess-a', POINTER);

      processEvent({ ...DISPATCH, session_id: unsafe });
      processEvent({ ...DISPATCH, session_id: 'sess-a' });

      expect(keysOf(rows()[0])).toEqual(DISPATCH_KEYS);
      expect(rows()[1].run_id).toBe(POINTER.run_id);
    },
  );

  it.each([[undefined], [null], [{}], [42]])('processEvent_nonStringPayloadSessionId_%j_rowUnchangedAndNoThrow', (weird) => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    plant('sess-a', POINTER);

    processEvent({ ...DISPATCH, session_id: weird });
    processEvent({ ...DISPATCH, session_id: 'sess-a' });

    expect(rows()).toHaveLength(2);
    expect('run_id' in rows()[0]).toBe(false);
    expect(rows()[1].run_id).toBe(POINTER.run_id);
  });
});


// ── Wave 4 Group B review: M2 (the pointer root) and a hook-level FIFO pointer ────────────────────────────────
describe('M2 a linked-worktree dispatch row is stamped from the pointer under the main worktree', () => {
  const { spawnSync } = require('node:child_process');
  const { createLinkedWorktree } = require('../../core/__tests__/_helpers/linked-worktree');
  const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
  const gitIt = hasGit ? it : it.skip;
  const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skill-usage-logger.cjs');
  const TELEMETRY = ['docs', '.output', '.state', 'telemetry'];
  const POINTER = { run_id: '261118-1200-run-todo-wt', plan: null, wave: 2, story: null, since: '261118-1200' };
  const DISPATCH = { tool_name: 'Task', tool_input: { subagent_type: 'general-purpose', description: 'do work' } };
  let fx = null;
  let priorProjectDir;
  let priorSession;

  beforeEach(() => {
    priorProjectDir = process.env.CLAUDE_PROJECT_DIR;
    priorSession = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-wt';
  });
  afterEach(() => {
    if (priorProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = priorProjectDir;
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession;
    if (fx) { fx.cleanup(); fx = null; }
  });

  gitIt('processEvent_claudeProjectDirIsTheLinkedWorktree_stampsFromThePointerUnderTheMainWorktree', () => {
    fx = createLinkedWorktree();
    process.env.CLAUDE_PROJECT_DIR = fx.linked;
    const pointer = path.join(fx.main, ...TELEMETRY, 'current-run-sess-wt.json');
    fs.mkdirSync(path.dirname(pointer), { recursive: true });
    fs.writeFileSync(pointer, JSON.stringify(POINTER));

    const event = processEvent(DISPATCH);

    expect(event).toMatchObject({ type: 'agent_dispatch', run_id: POINTER.run_id, wave: 2 });
  });

  (process.platform === 'win32' ? it.skip : it)('hookProcess_pointerIsAFifo_neverBlocksExits0AndWritesTheUnchangedRow', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-usage-fifo-'));
    try {
      const pointer = path.join(tmp, ...TELEMETRY, 'current-run-sess-a.json');
      fs.mkdirSync(path.dirname(pointer), { recursive: true });
      expect(spawnSync('mkfifo', [pointer]).status).toBe(0);

      const res = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify(DISPATCH),
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmp, CLAUDE_CODE_SESSION_ID: 'sess-a' },
        encoding: 'utf8', timeout: 15000, windowsHide: true,
      });

      expect(res.error).toBeUndefined();
      expect(res.signal).toBeNull();
      expect(res.status).toBe(0);
      const row = JSON.parse(fs.readFileSync(path.join(tmp, ...TELEMETRY, 'skill-usage.jsonl'), 'utf8').trim());
      expect(Object.keys(row).sort()).toEqual(['agent', 'description', 'skills', 'timestamp', 'type']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('n5 stampRun keeps the agent_dispatch row when the pointer lookup itself throws', () => {
  const { stampRun } = require('../../../.agents/hooks/skill-usage-logger.cjs');
  const POINTER = { run_id: '261118-1200-run-todo-software-factory', plan: null, wave: 2, story: 'SF-3.3', since: '261118-1200' };

  it('stampRun_aRootThatMakesPointerRootThrow_returnsTheRowUnchangedWithoutThrowing', () => {
    const row = { timestamp: 't', type: 'agent_dispatch', agent: 'general-purpose', skills: [], description: null };
    let out;

    expect(() => { out = stampRun(row, 12345, 'sess-a'); }).not.toThrow();

    expect(out).toBe(row);
    expect(Object.keys(out).sort()).toEqual(['agent', 'description', 'skills', 'timestamp', 'type']);
  });

  it('stampRun_aUsablePointer_stampsRunIdAndWave', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-usage-n5-'));
    try {
      const pointer = path.join(tmp, 'docs', '.output', '.state', 'telemetry', 'current-run-sess-n5.json');
      fs.mkdirSync(path.dirname(pointer), { recursive: true });
      fs.writeFileSync(pointer, JSON.stringify(POINTER));

      const out = stampRun({ type: 'agent_dispatch' }, tmp, 'sess-n5');

      expect(out).toEqual({ type: 'agent_dispatch', run_id: POINTER.run_id, wave: 2 });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('stampRun_noSessionOrNoPointer_leavesTheRowUnchanged', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-usage-n5-'));
    try {
      expect(stampRun({ type: 'agent_dispatch' }, tmp, null)).toEqual({ type: 'agent_dispatch' });
      expect(stampRun({ type: 'agent_dispatch' }, tmp, 'sess-none')).toEqual({ type: 'agent_dispatch' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
