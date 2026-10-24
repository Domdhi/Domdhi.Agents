// Lifecycle routing through authored handoff/feedback seams; transports are fixtures.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(repoRoot, 'package.json'));
const store = require('./.agents/core/_lib/learning-intake-store');
const { createTmpDir } = require('./.agents/core/__tests__/_helpers/tmp-dir');
const { LEARNING_INTAKE_LIMITS } = require('./.agents/core/constants');
const { buildDigest, summarize, renderMarkdown } = require('./.agents/core/feedback-digest');
const { CALLERS } = require('./.agents/core/handoff-path');
const HANDOFF_CALLERS = ['end', 'do', 'run-todo', 'run-tests', 'todo'];
const NOW = '2026-10-14T14:00:00.000Z';
const PRIVATE_MEMORY = 'Dummy project-only tenant notes; never selected for toolkit export.';
const PRIVATE_ERROR = 'Dummy private remote exception body; never a lifecycle diagnostic.';
const modulePath = path.join(repoRoot, '.agents/core/learning-intake.js');
let tmp;
let state;
let serial;
let networkGuard;

function core() { return require('./.agents/core/learning-intake'); }
function source(relative) { return fs.readFileSync(path.join(repoRoot, relative), 'utf8'); }
function id() { return `88888888-8888-4888-8888-${String(++serial).padStart(12, '0')}`; }
function options(extra = {}) { return { projectRoot: tmp.root, stateRoot: state.root, runtime: 'codex', projectName: 'LifecycleFixture', clock: () => NOW, newId: id, ...extra }; }
function helperCommands(markdown) {
  return Array.from(markdown.matchAll(/^\s*node\s+(\.(?:claude|codex)\/core\/learning-intake\.js)\s+([^\r\n]+)$/gm), (match) => ({ entry: match[1], args: match[2].trim().split(/\s+/) }));
}
function sharedCommands() { return helperCommands(source('.agents/skills/session-handoff/SKILL.md')); }
function feedbackCommands() { return helperCommands(source('.agents/skills/review-feedback/references/workflow.md')); }
function lesson(changes = {}) {
  return { toolkitVersion: '1.0.0', component: 'skills/session-handoff', applicability: 'shared-toolkit',
    title: 'Retain one selected qualitative toolkit lesson', problem: 'Earlier selected occurrences disappear from a latest-only report.',
    expected: 'Each explicit selection retains independent provenance.', reproduction: 'Select two qualitative lessons and inspect retained IDs.',
    verification: 'Both records survive a restart.', references: [{ path: '.agents/skills/session-handoff/SKILL.md' }], exportApproved: true, ...changes };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function destination() { return { provider: 'github', owner: 'FixtureOwner', repository: 'FixtureToolkit', maintainerIds: [123] }; }
function approve(trigger, changes = {}) {
  const identity = store.loadIdentity(options());
  const policy = { schemaVersion: 1, projectId: identity.projectId, projectName: identity.projectName, enabled: true,
    destination: destination(), exportProfile: 'toolkit-summary-v1', operations: ['submit', 'reconcile', 'refresh'], triggers: [trigger],
    limits: { ...LEARNING_INTAKE_LIMITS }, ...changes };
  policy.approval = { approvedBy: 'FixtureMaintainer', approvedAt: NOW, scopeHash: hash(store.policyScope(policy)) };
  store.validatePolicy(policy, { identity }); tmp.write('.agents/learning-intake/policy.json', JSON.stringify(policy)); return policy;
}
function received(request, target, issueNumber = 101) {
  return { issueId: issueNumber + 1000, issueNumber, url: `https://github.com/${target.owner}/${target.repository}/issues/${issueNumber}`,
    destination: target, destinationHash: hash(target), requestHash: hash(request), marker: `agents-learning-${request.requestId}`, receivedAt: NOW };
}
function transport(overrides = {}) {
  let nextItem = 100;
  return { validateDestination: vi.fn(async target => ({ ...target })),
    create: vi.fn(async ({ request, destination: target }) => received(request, target, ++nextItem)),
    findByMarker: vi.fn(async () => ({ matches: [], inconclusive: true, observedEmpty: true })),
    show: vi.fn(async ({ receipt }) => ({ receipt, remoteState: 'open' })), ...overrides };
}
function noCalls(remote) { for (const method of ['validateDestination', 'create', 'findByMarker', 'show']) expect(remote[method], method).not.toHaveBeenCalled(); }
async function captureSelected(values) {
  const outputs = [];
  for (const value of values) {
    const captured = await core().capture(value, options());
    expect(captured.ok, 'every selected occurrence must actually persist').toBe(true);
    outputs.push(captured);
  }
  return outputs;
}
function fixtureMemory() {
  const memory = tmp.write('docs/.output/.memory/constraints/project-only.json', JSON.stringify({ id: 'project-only', category: 'constraints', content: { description: PRIVATE_MEMORY, confidence: 1 } }));
  const inbox = tmp.write('docs/.output/.state/memory-inbox/fixture.json', JSON.stringify({ category: 'patterns', suggested_id: 'fixture-inbox', content: { description: PRIVATE_MEMORY, confidence: 0.7 }, flagged_by: 'qa-engineer', flagged_at: NOW }));
  return [memory, inbox];
}
function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__' || entry.name === '_helpers') return [];
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(filename) : /\.(?:js|cjs|mjs)$/.test(entry.name) ? [filename] : [];
  });
}
function commandArgs(command, caller) {
  return command.args.map((argument) => argument === '{caller}' ? caller : argument);
}
function cli(args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (['path', 'agent_shared_state_root', 'agents_project_dir', 'agent_source_root', 'codex_project_dir', 'claude_project_dir', 'agent_project_root', 'git_dir', 'git_work_tree', 'git_common_dir', 'git_index_file', 'git_object_directory', 'git_alternate_object_directories'].includes(key.toLowerCase())) delete env[key];
  Object.assign(env, { PATH: state.root, AGENTS_RUNTIME: 'codex', AGENTS_PROJECT_DIR: tmp.root, AGENT_SHARED_STATE_ROOT: state.root });
  return spawnSync(process.execPath, [modulePath, ...args], { cwd: tmp.root, env, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 262144 });
}

beforeEach(() => {
  serial = 0; tmp = createTmpDir({ prefix: 'learning-lifecycle-' }); state = createTmpDir({ prefix: 'learning-lifecycle-state-' });
  tmp.root = fs.realpathSync(tmp.root); state.root = fs.realpathSync(state.root);
  vi.stubEnv('PATH', state.root); // An accidental default credential path cannot find gh.
  networkGuard = vi.spyOn(require('node:https'), 'request').mockImplementation(() => { throw new Error('fixture-network-forbidden'); });
  expect(store.initializeProject(options()).initialized).toBe(true);
});
afterEach(() => {
  try { expect(networkGuard).not.toHaveBeenCalled(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); tmp.cleanup(); state.cleanup(); }
});

describe('authored acquisition routing; native fixture execution is covered separately', () => {
  it('sharedHandoff_singleLifecycleCommand_isTheCommonExecutableAcquisitionSeam', () => {
    const shared = sharedCommands().filter((command) => command.args[0] === 'lifecycle');

    expect(shared).toHaveLength(1);
    expect(shared[0]).toEqual({ entry: '.claude/core/learning-intake.js', args: ['lifecycle', '--trigger', '{caller}'] });
    expect(new Set(CALLERS)).toEqual(new Set(HANDOFF_CALLERS));
  });

  it.each(HANDOFF_CALLERS)('workflow_%s_resolvesExistingSharedHandoffAndDoesNotCopyLifecycleLogic', (caller) => {
    const workflow = source(`.agents/skills/${caller}/references/workflow.md`);

    expect(workflow).toMatch(/\.(?:claude|agents)\/skills\/session-handoff\/SKILL\.md/);
    expect(helperCommands(workflow).filter((command) => command.args[0] === 'lifecycle')).toEqual([]);
  });

  it('reviewFeedback_singleExactLifecycleTrigger_isSeparateFromDigestCommands', () => {
    const commands = feedbackCommands();

    expect(commands.filter((command) => command.args[0] === 'lifecycle')).toEqual([
      { entry: '.claude/core/learning-intake.js', args: ['lifecycle', '--trigger', 'review-feedback'] },
    ]);
    for (const command of [...sharedCommands(), ...commands]) {
      expect(['init', 'capture', 'status', 'lifecycle']).toContain(command.args[0]);
      expect(command.args.join(' ')).not.toMatch(/\.memory|memory-inbox|memory-daily|\.jsonl/);
    }
  });

  it('forbiddenNativeHookInstallUpdateSurfaces_haveNoNewLearningIntakeImportOrInvocation', () => {
    const files = [...filesUnder(path.join(repoRoot, '.agents/hooks')), ...filesUnder(path.join(repoRoot, '.agents/adapters')),
      path.join(repoRoot, '.agents/core/install.js'), path.join(repoRoot, '.agents/core/template-updater.js')];

    expect(files.length).toBeGreaterThanOrEqual(7);
    const violations = files.filter((filename) => {
      const text = fs.readFileSync(filename, 'utf8');
      return /require\s*\([^\r\n)]*learning-intake/.test(text) || /import[^\r\n]*from\s*['"][^'"]*learning-intake/.test(text)
        || /learning-intake\.js\s+(?:lifecycle|submit|reconcile|refresh)\b/.test(text);
    }).map((filename) => path.relative(repoRoot, filename));
    expect(violations).toEqual([]);
  });
});

describe('finite core lifecycle with explicit selected lessons', () => {
  it('requiredCoreLifecycle_isAvailableForActualBehavioralChecks', () => {
    expect(fs.existsSync(modulePath), 'core milestone must exist before integration behavior can pass').toBe(true);
    expect(typeof core().lifecycle).toBe('function');
  });

  it.each(HANDOFF_CALLERS)('sharedLifecycle_%s_selectedOccurrenceUsesOneAuthorizedFiniteSeam', async (caller) => {
    approve(caller); const [selected] = await captureSelected([lesson()]); const remote = transport();
    const command = sharedCommands().find((item) => item.args[0] === 'lifecycle');
    expect(command).toBeDefined();
    const args = commandArgs(command, caller);
    expect(args).toEqual(['lifecycle', '--trigger', caller]);

    const result = await core().lifecycle(options({ trigger: args[2], transport: remote }));

    expect(result.ok).toBe(true);
    expect(remote.create).toHaveBeenCalledTimes(1);
    expect(remote.create.mock.calls[0][0].request.requestId).toBe(selected.requestId);
    expect(store.readEvents(selected.requestId, options()).status).toBe('acknowledged');
  });

  it('reviewFeedback_twoExplicitQualitativeSelections_retainTwoOccurrencesWithoutOverwritingSidecarOrReport', async () => {
    approve('review-feedback'); const memoryFiles = fixtureMemory();
    const memoryBytes = memoryFiles.map((file) => fs.readFileSync(file));
    const before = buildDigest(tmp.root);
    const sidecar = tmp.write('docs/.output/findings/reviews/feedback-261014-0715.json', JSON.stringify(before, null, 2));
    const report = tmp.write('docs/.output/findings/reviews/feedback-261014-0715.md', `${renderMarkdown(before)}\n\n## Agent Self-Review\nTwo selected toolkit lessons.\n`);
    const sidecarBytes = fs.readFileSync(sidecar); const reportBytes = fs.readFileSync(report);
    const selected = await captureSelected([lesson(), lesson({ title: 'Retain a second explicitly selected lesson' })]);
    const originalRows = selected.map(({ requestId }) => store.loadRequest(requestId, options()));
    const originalBytes = originalRows.map((row) => fs.readFileSync(path.resolve(tmp.root, row.path)));
    const command = feedbackCommands().find((item) => item.args[0] === 'lifecycle'); expect(command).toBeDefined();
    const remote = transport();

    expect((await core().lifecycle(options({ trigger: command.args[2], transport: remote }))).ok).toBe(true);

    expect(store.listRequests(options())).toHaveLength(2);
    expect(new Set(selected.map((row) => row.requestId)).size).toBe(2);
    expect(remote.create).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(sidecar)).toEqual(sidecarBytes);
    expect(fs.readFileSync(report)).toEqual(reportBytes);
    expect(originalRows.map((row) => fs.readFileSync(path.resolve(tmp.root, row.path)))).toEqual(originalBytes);
    expect(memoryFiles.map((file) => fs.readFileSync(file))).toEqual(memoryBytes);
    const after = buildDigest(tmp.root);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(Object.keys(summarize(after)).sort()).toEqual(Object.keys(summarize(before)).sort());
    expect(after.memoryStore.total).toBe(before.memoryStore.total);
    expect(JSON.stringify(remote.create.mock.calls)).not.toContain(PRIVATE_MEMORY);
  });

  it('qualitativeReconciliation_zeroSelections_createsNoLessonQuotaOrMemoryExport', async () => {
    approve('review-feedback'); const files = fixtureMemory(); const before = files.map((file) => fs.readFileSync(file));
    const remote = transport();

    expect((await core().lifecycle(options({ trigger: 'review-feedback', transport: remote }))).ok).toBe(true);

    expect(store.listRequests(options())).toEqual([]);
    expect(files.map((file) => fs.readFileSync(file))).toEqual(before);
    noCalls(remote);
  });

  it('lifecycle_boundedBatch_skipsUnselectedOccurrencesAndKeepsDistinctReceipts', async () => {
    approve('end', { limits: { ...LEARNING_INTAKE_LIMITS, MAX_BATCH: 2 } });
    const selected = await captureSelected([
      lesson({ applicability: 'project-specific', exportApproved: false }),
      lesson({ exportApproved: false }), lesson({ title: 'Eligible one' }),
      lesson({ title: 'Eligible two' }), lesson({ title: 'Eligible three' }),
    ]);
    const remote = transport();

    const result = await core().lifecycle(options({ trigger: 'end', transport: remote }));

    expect(result).toMatchObject({ ok: true, counts: { attempted: 2, succeeded: 2, failed: 0 } });
    expect(remote.create).toHaveBeenCalledTimes(2);
    expect(new Set(remote.create.mock.calls.map(([input]) => input.request.requestId)).size).toBe(2);
    expect(store.listRequests(options())).toHaveLength(5);
    const statuses = selected.map(({ requestId }) => store.readEvents(requestId, options()).status);
    expect(statuses.filter(status => status === 'acknowledged')).toHaveLength(2);
    expect(statuses[0]).toBe('project-specific');
    expect(statuses[1]).toBe('pending');
    const acknowledged = (await core().status(options())).requests.filter(row => row.status === 'acknowledged');
    expect(new Set(acknowledged.map(row => row.issue.issueId)).size).toBe(2);
    expect(new Set(acknowledged.map(row => row.issue.url)).size).toBe(2);
  });

  it('lifecycle_queueLargerThanBatch_eventuallySubmitsAndRefreshesEveryOccurrenceAtSameClock', async () => {
    approve('end', { limits: { ...LEARNING_INTAKE_LIMITS, MAX_BATCH: 1 } });
    const [first] = await captureSelected([lesson({ title: 'Older acknowledged occurrence' })]);
    const remote = transport();
    expect((await core().lifecycle(options({ trigger: 'end', transport: remote }))).ok).toBe(true);
    const later = await captureSelected(Array.from({ length: 4 }, (_, index) => lesson({ title: `Later occurrence ${index}` })));
    for (let batch = 0; batch < 9; batch++) {
      expect(await core().lifecycle(options({ trigger: 'end', transport: remote }))).toMatchObject({
        ok: true, counts: { attempted: 1, succeeded: 1, failed: 0 },
      });
    }
    const expected = new Set([first, ...later].map(row => row.requestId));
    expect(new Set(remote.create.mock.calls.map(([input]) => input.request.requestId))).toEqual(expected);
    expect(remote.create).toHaveBeenCalledTimes(5);
    expect(new Set(remote.show.mock.calls.map(([input]) => input.receipt.marker.slice('agents-learning-'.length)))).toEqual(expected);
    expect(remote.show).toHaveBeenCalledTimes(5);
  });

  it('lifecycle_notYetDueOccurrence_cannotUseTheBatchBudgetBeforeReadyPeers', async () => {
    approve('end', { limits: { ...LEARNING_INTAKE_LIMITS, MAX_BATCH: 1 } });
    const [delayed, ready] = await captureSelected([lesson({ title: 'Delayed' }), lesson({ title: 'Ready' })]);
    const nextAttemptAt = '2026-10-14T14:00:30.000Z';
    const throttled = transport({ create: vi.fn(async () => { throw Object.assign(new Error(PRIVATE_ERROR), {
      code: 'throttled', possibleWrite: false, nextAttemptAt,
    }); }) });
    expect(await core().submit(delayed.requestId, options({ transport: throttled }))).toMatchObject({ ok: false, code: 'throttled' });
    const remote = transport();
    for (let batch = 0; batch < 2; batch++) {
      const outcome = await core().lifecycle(options({ trigger: 'end', transport: remote }));
      expect(outcome.counts).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    }
    expect(remote.create).toHaveBeenCalledTimes(1);
    expect(remote.create.mock.calls[0][0].request.requestId).toBe(ready.requestId);
    expect(remote.show).toHaveBeenCalledTimes(1);
    expect(remote.show.mock.calls[0][0].receipt.marker).toBe(`agents-learning-${ready.requestId}`);
    expect(await core().lifecycle(options({ trigger: 'end', transport: remote, clock: () => nextAttemptAt }))).toMatchObject({
      ok: true, counts: { attempted: 1, succeeded: 1, failed: 0 },
    });
    expect(remote.create).toHaveBeenCalledTimes(2);
    expect(remote.create.mock.calls[1][0].request.requestId).toBe(delayed.requestId);
  });

  it('lifecycle_exhaustedOccurrence_doesNotStarveReadyPeersAfterLocalRefusals', async () => {
    approve('end', { limits: { ...LEARNING_INTAKE_LIMITS, MAX_BATCH: 1, MAX_CREATE_ATTEMPTS: 1 } });
    const [exhausted, peer] = await captureSelected([lesson({ title: 'Exhausted' }), lesson({ title: 'Acknowledged peer' })]);
    const failure = transport({ create: vi.fn(async () => { throw Object.assign(new Error(PRIVATE_ERROR), {
      code: 'auth-unavailable', possibleWrite: false,
    }); }) });
    expect((await core().submit(exhausted.requestId, options({ transport: failure }))).ok).toBe(false);
    expect((await core().submit(peer.requestId, options({ transport: transport() }))).ok).toBe(true);
    const remote = transport();
    for (let batch = 0; batch < 6; batch++) await core().lifecycle(options({ trigger: 'end', transport: remote }));
    expect(remote.create).not.toHaveBeenCalled();
    expect(remote.show).toHaveBeenCalledTimes(3);
    expect(remote.show.mock.calls.every(([input]) => input.receipt.marker === `agents-learning-${peer.requestId}`)).toBe(true);
  });

  it('lifecycle_revocationDuringBatch_preventsTheNextExternalOccurrence', async () => {
    approve('end');
    await captureSelected([lesson({ title: 'Before revocation' }), lesson({ title: 'After revocation' })]);
    const remote = transport({ create: vi.fn(async ({ request, destination: target }) => {
      const policy = store.loadPolicy(options());
      policy.enabled = false; policy.operations = []; policy.triggers = [];
      delete policy.approval; delete policy.destination;
      tmp.write('.agents/learning-intake/policy.json', JSON.stringify(policy));
      return received(request, target);
    }) });

    const result = await core().lifecycle(options({ trigger: 'end', transport: remote }));

    expect(result).toMatchObject({ ok: false, code: 'disabled', counts: { attempted: 1, succeeded: 1, failed: 0 } });
    expect(remote.create).toHaveBeenCalledTimes(1);
    expect(store.listRequests(options())).toHaveLength(2);
    expect(store.loadPolicy(options()).enabled).toBe(false);
  });

  it('lifecycle_uncertainLookupReconcilesThenRefreshes_withoutAnotherCreate', async () => {
    approve('end');
    const [selected] = await captureSelected([lesson()]);
    const failed = transport({ create: vi.fn(async () => { throw Object.assign(new Error(PRIVATE_ERROR), { code: 'write-uncertain', possibleWrite: true }); }) });
    expect((await core().submit(selected.requestId, options({ transport: failed }))).ok).toBe(false);
    const row = store.loadRequest(selected.requestId, options());
    const receipt = received(row.request, destination());
    const remote = transport({ findByMarker: vi.fn(async () => ({ matches: [receipt], inconclusive: false })) });

    expect(await core().lifecycle(options({ trigger: 'end', transport: remote }))).toMatchObject({ ok: true, counts: { attempted: 1, succeeded: 1, failed: 0 } });
    expect(remote.findByMarker).toHaveBeenCalledTimes(1);
    expect(remote.create).not.toHaveBeenCalled();
    expect(store.readEvents(selected.requestId, options()).status).toBe('acknowledged');
    expect(await core().lifecycle(options({ trigger: 'end', transport: remote }))).toMatchObject({ ok: true, counts: { attempted: 1, succeeded: 1, failed: 0 } });
    expect(remote.show).toHaveBeenCalledTimes(1);
    expect(remote.create).not.toHaveBeenCalled();
  });

  it('lifecycle_approvedRetryGrant_isNotConsumedAndUncertainZeroMatchRemainsHeld', async () => {
    approve('end', { operations: ['submit', 'reconcile', 'refresh', 'recover'] });
    const [selected] = await captureSelected([lesson()]);
    const failed = transport({ create: vi.fn(async () => { throw Object.assign(new Error(PRIVATE_ERROR), { code: 'write-uncertain', possibleWrite: true }); }) });
    await core().submit(selected.requestId, options({ transport: failed }));
    const before = store.readEvents(selected.requestId, options());
    const intent = before.events.find(event => event.kind === 'create-intent');
    expect(await core().recover(selected.requestId, { schemaVersion: 1, intentEventId: intent.eventId,
      expectedLastEventHash: before.lastEventHash, actor: 'FixtureMaintainer', decision: 'retry-create',
      reason: 'Explicitly reviewed fixture uncertainty.', acceptDuplicateRisk: true }, options())).toMatchObject({ ok: true });
    const grant = store.readEvents(selected.requestId, options()).events.find(event => event.kind === 'recovery-approved');
    const remote = transport();

    expect(await core().lifecycle(options({ trigger: 'end', transport: remote }))).toMatchObject({ ok: false, code: 'reconciliation-inconclusive' });

    expect(remote.findByMarker).toHaveBeenCalledTimes(1);
    expect(remote.create).not.toHaveBeenCalled();
    const history = store.readEvents(selected.requestId, options());
    expect(history.status).toBe('uncertain');
    expect(history.events.filter(event => event.kind === 'recovery-approved')).toHaveLength(1);
    expect(history.events.some(event => event.kind === 'create-intent' && event.data.recoveryEventId === grant.eventId)).toBe(false);
  });

  it('selectedProjectSpecificLesson_isRetainedLocallyAndNeverExportedByFeedbackTrigger', async () => {
    approve('review-feedback');
    const [selected] = await captureSelected([lesson({ applicability: 'project-specific', exportApproved: false })]);
    const remote = transport();

    await core().lifecycle(options({ trigger: 'review-feedback', transport: remote }));

    expect(store.loadRequest(selected.requestId, options()).request.applicability).toBe('project-specific');
    expect(remote.create).not.toHaveBeenCalled();
  });

  it.each([...HANDOFF_CALLERS, 'review-feedback'])('lifecycle_%s_disabledAuthority_keepsSelectedPendingVisibleWithoutWrite', async (trigger) => {
    const [selected] = await captureSelected([lesson()]); const remote = transport();

    expect(await core().lifecycle(options({ trigger, transport: remote }))).toMatchObject({ ok: true, code: 'disabled' });

    noCalls(remote);
    expect(await core().status(options())).toMatchObject({ requests: [{ requestId: selected.requestId, status: 'pending' }] });
  });

  it('lifecycle_missingIdentityAndPolicy_createsOnlyDisabledLocalDefaults', async () => {
    fs.unlinkSync(path.join(tmp.root, '.agents/learning-intake/identity.json')); fs.unlinkSync(path.join(tmp.root, '.agents/learning-intake/policy.json'));
    const remote = transport();

    expect(await core().lifecycle(options({ trigger: 'review-feedback', transport: remote }))).toMatchObject({ ok: true, code: 'disabled' });

    expect(store.loadPolicy(options()).enabled).toBe(false);
    expect(store.listRequests(options())).toEqual([]);
    noCalls(remote);
  });

  it.each(['revoked', 'unapproved-trigger'])('lifecycle_%sAuthority_refusesObservableFailureAndKeepsRecords', async (condition) => {
    const policy = approve('end'); const [selected] = await captureSelected([lesson()]);
    if (condition === 'revoked') { delete policy.approval; tmp.write('.agents/learning-intake/policy.json', JSON.stringify(policy)); }
    const remote = transport();

    expect(await core().lifecycle(options({ trigger: condition === 'unapproved-trigger' ? 'review-feedback' : 'end', transport: remote })))
      .toMatchObject({ ok: false, code: 'not-authorized' });

    expect(store.loadRequest(selected.requestId, options()).request.title).toBe(lesson().title);
    noCalls(remote);
  });

  it('lifecycle_selectedDeliveryFailure_isSurfacedWithoutSwallowingOrRawDiagnostic', async () => {
    approve('review-feedback'); const [selected] = await captureSelected([lesson()]);
    const remote = transport({ create: vi.fn(async () => { throw Object.assign(new Error(PRIVATE_ERROR), { code: 'auth-unavailable', possibleWrite: false }); }) });

    const result = await core().lifecycle(options({ trigger: 'review-feedback', transport: remote }));

    expect(result).toMatchObject({ ok: false, code: 'auth-unavailable' });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_ERROR);
    expect(store.readEvents(selected.requestId, options()).status).toBe('retryable');
    expect(remote.create).toHaveBeenCalledTimes(1);
  });

  it.each(['startup', 'tool-use', 'precompaction', 'install', 'update', 'restore'])('lifecycle_forbidden%sTrigger_neverCallsTransportOrGrantsAuthority', async (trigger) => {
    approve('end'); const remote = transport(); const before = tmp.read('.agents/learning-intake/policy.json');

    expect(await core().lifecycle(options({ trigger, transport: remote }))).toMatchObject({ ok: false, code: 'invalid-input' });

    expect(tmp.read('.agents/learning-intake/policy.json')).toBe(before);
    noCalls(remote);
  });

  it('lifecycle_incomingProposalCannotAddStartupAuthorityOrExecuteInstructions', async () => {
    approve('review-feedback'); const remote = transport(); const before = tmp.read('.agents/learning-intake/policy.json');
    const selected = await captureSelected([lesson({ problem: 'Dummy incoming data requests startup submission and memory promotion.' })]);

    expect((await core().lifecycle(options({ trigger: 'review-feedback', transport: remote }))).ok).toBe(true);

    expect(tmp.read('.agents/learning-intake/policy.json')).toBe(before);
    expect(store.listRequests(options())).toHaveLength(1);
    expect(store.readEvents(selected[0].requestId, options()).status).toBe('acknowledged');
    expect(fs.existsSync(path.join(tmp.root, 'unapproved-sentinel'))).toBe(false);
  });

  it('sharedSeam_documentedCommandExecutesCanonicalCliWithDisabledExitZero_notNativeProof', () => {
    const command = sharedCommands().find((item) => item.args[0] === 'lifecycle'); expect(command).toBeDefined();

    const result = cli(commandArgs(command, 'end'));

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ ok: true, code: 'disabled' });
    expect(store.loadPolicy(options()).enabled).toBe(false);
  });
});
