import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const store = require('../_lib/learning-intake-store');
const { createGithubTransport } = require('../learning-intake-github');
const { createTmpDir } = require('./_helpers/tmp-dir');
const { copyToolkit } = require('./_helpers/shared-pilot.cjs');
const { runInstall } = require('../install');
const { LEARNING_INTAKE_LIMITS } = require('../constants');
const { compartmentDir } = require('../_lib/output-paths');
const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../learning-intake.js');
const NOW = '2026-10-14T14:00:00.000Z';
const COMMIT = 'a'.repeat(40);
const PRIVATE_ERROR = 'dummy private fixture token and remote exception body';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POLICY_FILE = '.agents/learning-intake/policy.json';
let tmp;
let state;
let other;
let serial;

function core() { return require('../learning-intake'); }
function nextId() { return `77777777-7777-4777-8777-${String(++serial).padStart(12, '0')}`; }
function options(extra = {}) {
  return { projectRoot: tmp.root, stateRoot: state.root, projectName: 'ToolkitFixture', runtime: 'codex', clock: () => NOW, newId: nextId, ...extra };
}
function destination(changes = {}) {
  return { provider: 'github', owner: 'ToolkitOwner', repository: 'Toolkit', maintainerIds: [123], ...changes };
}
function lesson(changes = {}) {
  return { toolkitVersion: '1.0.0', toolkitCommit: COMMIT, component: 'core/output-paths', applicability: 'shared-toolkit',
    title: 'Retain selected toolkit lessons', problem: 'A latest-only report loses earlier selected occurrences.',
    expected: 'Retain independent occurrence identity.', proposed: 'Publish immutable local records.',
    reproduction: 'Capture two selected lessons and restart.', verification: 'Inspect both request IDs.',
    references: [{ path: '.agents/core/constants.js', commit: COMMIT, sha256: 'a'.repeat(64) }], exportApproved: true, ...changes };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function writePolicy(value) { tmp.write(POLICY_FILE, JSON.stringify(value)); return value; }
function approve(changes = {}) {
  const identity = store.loadIdentity(options());
  const value = { schemaVersion: 1, projectId: identity.projectId, projectName: identity.projectName, enabled: true,
    destination: destination(), exportProfile: 'toolkit-summary-v1', operations: ['submit', 'reconcile', 'refresh', 'recover'],
    triggers: ['end'], limits: { ...LEARNING_INTAKE_LIMITS }, ...changes };
  value.approval = { approvedBy: 'FixtureMaintainer', approvedAt: NOW, scopeHash: store.canonicalHash(store.policyScope(value)) };
  expect(value.approval.scopeHash).toBe(hash(store.policyScope(value)));
  store.validatePolicy(value, { identity });
  return writePolicy(value);
}
function disable() {
  const value = store.loadPolicy(options());
  value.enabled = false; value.operations = []; value.triggers = [];
  delete value.destination; delete value.approval;
  return writePolicy(value);
}
async function seed(changes = {}) {
  const identity = store.loadIdentity(options());
  const value = { schemaVersion: 1, requestId: nextId(), projectId: identity.projectId, projectName: identity.projectName,
    createdAt: NOW, runtime: 'codex', fingerprint: hash(lesson(changes)), ...lesson(changes) };
  const published = await store.publishRequest(value, options());
  expect(published.request).toEqual(value);
  await store.withRequestLock(value.requestId, (lockOwner) => store.appendEvent(value.requestId, 'captured', { requestHash: published.requestHash }, options({ lockOwner, expectedLastEventHash: null })), options());
  return value.requestId;
}
function history(id) { return store.readEvents(id, options()); }
function intent(id) { return history(id).events.filter((event) => event.kind === 'create-intent').at(-1); }
function receipt(id, target = destination(), changes = {}) {
  return { issueId: 101, issueNumber: 101, url: `https://github.com/${target.owner}/${target.repository}/issues/101`,
    destination: target, destinationHash: hash(target), requestHash: store.loadRequest(id, options()).requestHash,
    marker: `agents-learning-${id}`, receivedAt: NOW, ...changes };
}
function remoteError(code, possibleWrite = false, extra = {}) {
  return Object.assign(new Error(PRIVATE_ERROR), { code, possibleWrite, ...extra });
}
function transport(overrides = {}) {
  return {
    validateDestination: vi.fn(async (target) => ({ ...target })),
    findByMarker: vi.fn(async () => ({ matches: [], inconclusive: true, observedEmpty: true })),
    create: vi.fn(async ({ destination: target, request }) => receipt(request.requestId, target)),
    show: vi.fn(async ({ receipt: received }) => ({ receipt: received, remoteState: 'New' })),
    ...overrides,
  };
}
function noCalls(remote) { for (const method of ['validateDestination', 'findByMarker', 'create', 'show']) expect(remote[method], method).not.toHaveBeenCalled(); }
function exactRemoteMatch() {
  return vi.fn(async ({ destination: target, marker }) => ({ matches: [receipt(marker.slice('agents-learning-'.length), target)], inconclusive: false }));
}
function refused(result, code) {
  expect(result).toMatchObject({ ok: false, code });
  expect(typeof result.status).toBe('string');
  expect(JSON.stringify(result)).not.toContain(PRIVATE_ERROR);
  return result;
}
async function uncertain(remote = transport({ create: vi.fn(async () => { throw remoteError('write-uncertain', true); }) })) {
  approve();
  const id = await seed();
  refused(await core().submit(id, options({ transport: remote })), 'write-uncertain');
  expect(history(id).status).toBe('uncertain');
  return { id, remote };
}
function recoveryInput(id, changes = {}) {
  return { schemaVersion: 1, intentEventId: intent(id)?.eventId ?? null, expectedLastEventHash: history(id).lastEventHash,
    actor: 'FixtureMaintainer', decision: 'retry-create', reason: 'Reviewed uncertain fixture write.', acceptDuplicateRisk: true, ...changes };
}
async function staleOwner(id, changes = {}) {
  let observed;
  await store.withRequestLock(id, (owner) => {
    observed = { ...owner, nonce: 'e'.repeat(32), pid: 99999999, host: os.hostname(), ...changes };
    const { path: relative, ...saved } = observed;
    fs.writeFileSync(path.resolve(state.root, relative), JSON.stringify(saved));
  }, options());
  expect(store.loadLock(id, options())).toEqual(observed);
  return observed;
}
function failPublication(kind) {
  const original = fs.linkSync.bind(fs);
  return vi.spyOn(fs, 'linkSync').mockImplementation((source, target, ...rest) => {
    const value = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (value.kind === kind) throw new Error(PRIVATE_ERROR);
    return original(source, target, ...rest);
  });
}
function resolution(id, changes = {}) {
  return { schemaVersion: 1, requestId: id, disposition: 'accepted', rationale: 'Reviewed selected toolkit lesson.', reviewedAt: NOW,
    implementation: { reference: '.agents/core/constants.js', summary: 'Implemented local capture.', sourceCommit: COMMIT },
    verification: { reference: 'docs/engineering/learning-intake-validation.md', summary: 'Observed exact verification.', sourceCommit: COMMIT },
    release: { version: '1.0.1', sourceCommit: COMMIT, artifactSha256: 'a'.repeat(64), publicationReference: 'Fixture immutable release 1.0.1', inspectedBy: 'FixtureMaintainer', inspectedAt: NOW }, ...changes };
}
function cli(args) {
  const env = { ...process.env };
  for (const key of ['AGENT_SOURCE_ROOT', 'CODEX_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', 'AGENT_PROJECT_ROOT']) delete env[key];
  Object.assign(env, { AGENTS_RUNTIME: 'codex', AGENTS_PROJECT_DIR: tmp.root, AGENT_SHARED_STATE_ROOT: state.root });
  // Node uses its absolute executable. Empty fixture PATH prevents real GitHub CLI
  // authentication if a denied/uncertain CLI regression accidentally reaches transport.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = other.root;
  return spawnSync(process.execPath, [modulePath, ...args], { cwd: tmp.root, env, encoding: 'utf8', timeout: 10000, maxBuffer: 262144, windowsHide: true });
}
function cliJson(result) {
  expect(result.error).toBeUndefined();
  expect(result.stderr).not.toContain(PRIVATE_ERROR);
  const value = JSON.parse(result.stdout.trim());
  expect(typeof value.code).toBe('string');
  return value;
}

beforeEach(() => {
  serial = 0;
  tmp = createTmpDir({ prefix: 'learning-core-' });
  state = createTmpDir({ prefix: 'learning-core-state-' });
  other = createTmpDir({ prefix: 'learning-core-outside-' });
  const initialized = store.initializeProject(options());
  expect(initialized.initialized).toBe(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); tmp.cleanup(); state.cleanup(); other.cleanup(); });

describe('learning-intake SEC-1 authority at actual authenticated HTTP dispatch', () => {
  function actualAdapter({ mutateAtToken, mutateAfterRoute, onMutation, existing } = {}) {
    let tokens = 0; const calls = []; const target = destination();
    const item = (number, body) => ({id:number,number,state:'open',title:'Fixture lesson',body,
      html_url:`https://github.com/${target.owner}/${target.repository}/issues/${number}`,
      url:`https://api.github.com/repos/${target.owner}/${target.repository}/issues/${number}`,
      repository_url:`https://api.github.com/repos/${target.owner}/${target.repository}`});
    const remote = createGithubTransport({
      getToken: async () => { if (++tokens === mutateAtToken) onMutation(); return 'dummy-fixture-token'; },
      request: async input => {
        const url = new URL(input.url); calls.push({method:input.method,route:url.pathname}); let body;
        if(input.method==='POST' && url.pathname.endsWith('/issues')) body=item(101,JSON.parse(input.body).body);
        else if(url.pathname==='/search/issues') body={total_count:existing?2:0,incomplete_results:false,items:existing?[existing(101),existing(102)]:[]};
        else if(existing && /\/issues\/\d+$/.test(url.pathname)) body=existing(Number(url.pathname.split('/').at(-1)));
        else if(url.pathname===`/repos/${target.owner}/${target.repository}`) body={id:1,name:target.repository,full_name:`${target.owner}/${target.repository}`,owner:{login:target.owner},html_url:`https://github.com/${target.owner}/${target.repository}`,has_issues:true,archived:false,disabled:false};
        else throw new Error('unexpected fixture route');
        if(mutateAfterRoute && url.pathname.includes(mutateAfterRoute)) onMutation();
        return {statusCode:input.method==='POST'?201:200,headers:{},body:JSON.stringify(body)};
      },
    });
    return {remote,calls,creates:()=>calls.filter(call=>call.method==='POST' && call.route.endsWith('/issues')).length};
  }

  it.each([
    { name: 'disabled', mutate: () => disable() },
    { name: 'operation-revoked', mutate: () => approve({ operations: ['refresh'] }) },
    { name: 'trigger-revoked', mutate: () => approve({ triggers: ['todo'] }) },
    { name: 'receiver-changed', mutate: () => approve({ destination: destination({ repository: 'Other' }) }) },
    { name: 'ceiling-changed', mutate: () => approve({ limits: { ...LEARNING_INTAKE_LIMITS, MAX_CREATE_ATTEMPTS: 1 } }) },
  ])('tokenWindow_$name: preventsCreate_andRetainsIntent', async ({ mutate }) => {
    approve(); const id = await seed();
    const harness = actualAdapter({ mutateAtToken: 3, onMutation: mutate });
    const observed = await core().submit(id, options({ transport: harness.remote, trigger: 'end' }));
    expect(observed.ok).toBe(false);
    expect(harness.creates()).toBe(0);
    expect(history(id).events.filter(event => event.kind === 'create-intent')).toHaveLength(1);
    expect(history(id).events.some(event => event.kind === 'acknowledged')).toBe(false);
    expect(JSON.stringify(observed)).not.toContain('dummy-fixture-token');
  });

  it.each(['/repos/ToolkitOwner/Toolkit','/search/issues'])('destinationSibling_%s_revocationPreventsFollowingHTTP', async route => {
    approve(); const id = await seed(); const harness = actualAdapter({mutateAfterRoute:route,onMutation:disable});
    expect((await core().submit(id, options({transport:harness.remote}))).ok).toBe(false);
    expect(harness.calls).toHaveLength(route==='/search/issues'?2:1); expect(harness.creates()).toBe(0);
  });

  it('unchangedAuthority_actualAdapterStillAcknowledgesExactlyOneCreate', async () => {
    approve(); const id = await seed(); const harness = actualAdapter();
    expect(await core().submit(id, options({ transport: harness.remote }))).toMatchObject({ ok: true, status: 'acknowledged' });
    expect(harness.creates()).toBe(1);
  });

  it('candidateSibling_revocationAfterFirstRead_preventsSecondCandidateHTTP', async () => {
    approve(); const id = await seed();
    const row = store.loadRequest(id, options());
    const escaped = JSON.stringify({ schemaVersion: 1, requestHash: row.requestHash, request: row.request })
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const target = destination();
    const harness = actualAdapter({ mutateAfterRoute:'/issues/101',onMutation:disable,
      existing:number=>({id:number,number,state:'open',title:'Fixture lesson',
        html_url:`https://github.com/${target.owner}/${target.repository}/issues/${number}`,
        url:`https://api.github.com/repos/${target.owner}/${target.repository}/issues/${number}`,
        repository_url:`https://api.github.com/repos/${target.owner}/${target.repository}`,
        body:`agents-learning-${id}\nAGENTS_LEARNING_REQUEST_V1:<pre>${escaped}</pre>`}),
    });
    expect((await core().submit(id, options({ transport: harness.remote }))).ok).toBe(false);
    expect(harness.calls.filter(call => /\/issues\/\d+$/.test(call.route))).toHaveLength(1);
    expect(harness.creates()).toBe(0);
  });

  it('cancelledReviewedRecovery_preservesUncertaintyAndUsedGrant_afterApprovalRestored', async () => {
    const { id } = await uncertain();
    expect(await core().recover(id, recoveryInput(id), options())).toMatchObject({ ok: true });
    const harness = actualAdapter({ mutateAtToken: 3, onMutation: disable });
    expect((await core().submit(id, options({ transport: harness.remote }))).ok).toBe(false);
    expect(harness.creates()).toBe(0);
    expect(history(id).events.filter(event => event.kind === 'create-intent')).toHaveLength(2);
    expect(intent(id).data.recoveryEventId).toBeTruthy();
    approve();
    const again = actualAdapter();
    expect(await core().submit(id, options({ transport: again.remote }))).toMatchObject({ ok: false, code: 'write-uncertain', status: 'uncertain' });
    expect(again.calls).toEqual([]);
  });
});

describe('learning-intake AC4.3 offline capture and strict selected input', () => {
  it('publicExports_requiredOrchestratorContract_isAvailable', () => {
    expect(fs.existsSync(modulePath), 'Story 4.3 production orchestrator must exist').toBe(true);
    for (const method of ['initProject', 'init', 'capture', 'status', 'submit', 'reconcile', 'refresh', 'recover', 'lifecycle']) expect(typeof core()[method], method).toBe('function');
  });

  it('initProject_existingApprovedPolicy_preservesExactBytesWithoutTransport', async () => {
    approve();
    const before = tmp.read(POLICY_FILE);
    const remote = transport();

    expect(await core().initProject(options({ transport: remote }))).toMatchObject({ ok: true, code: 'ok', status: 'already-initialized' });

    expect(tmp.read(POLICY_FILE)).toBe(before);
    noCalls(remote);
  });

  it('init_uninitializedFacade_createsDisabledDefaultsWithoutInferredAuthority', async () => {
    fs.unlinkSync(path.join(tmp.root, '.agents/learning-intake/identity.json')); fs.unlinkSync(path.join(tmp.root, POLICY_FILE));
    const remote = transport();

    expect(await core().init({ projectName: 'NewFixture' }, options({ transport: remote }))).toMatchObject({ ok: true, code: 'ok', status: 'initialized' });

    expect(store.loadIdentity(options()).projectName).toBe('NewFixture');
    expect(store.loadPolicy(options())).toMatchObject({ enabled: false, operations: [], triggers: [] });
    expect(store.loadPolicy(options())).not.toHaveProperty('destination');
    expect(store.loadPolicy(options())).not.toHaveProperty('approval');
    noCalls(remote);
  });

  it('capture_notInitialized_refusesWithoutInventingProjectOwnership', async () => {
    fs.unlinkSync(path.join(tmp.root, '.agents/learning-intake/identity.json')); fs.unlinkSync(path.join(tmp.root, POLICY_FILE));
    const remote = transport();

    refused(await core().capture(lesson(), options({ transport: remote })), 'not-initialized');

    expect(fs.existsSync(path.join(tmp.root, '.agents/learning-intake/identity.json'))).toBe(false);
    noCalls(remote);
  });

  it('capture_status_disabledDelivery_retainsDurableSelectedOccurrenceOffline', async () => {
    const remote = transport();
    const captured = await core().capture(lesson(), options({ transport: remote }));

    expect(captured).toMatchObject({ ok: true, code: 'ok', status: 'pending' });
    expect(captured.requestId).toMatch(UUID);
    const saved = store.loadRequest(captured.requestId, options()).request;
    expect(saved).toMatchObject({ ...lesson(), runtime: 'codex', projectId: store.loadIdentity(options()).projectId, createdAt: NOW });
    expect(saved.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(history(captured.requestId).events.map((event) => event.kind)).toEqual(['captured']);
    expect(await core().status(options({ transport: remote }))).toMatchObject({ ok: true, requests: [{ requestId: captured.requestId, status: 'pending' }] });
    noCalls(remote);
  });

  it('capture_recurringSimilarLessons_keepsTwoDistinctOccurrencesAtSameFingerprint', async () => {
    const first = await core().capture(lesson(), options());
    const second = await core().capture(lesson(), options());

    expect(first.ok).toBe(true); expect(second.ok).toBe(true);
    expect(new Set([first.requestId, second.requestId]).size).toBe(2);
    expect(store.loadRequest(first.requestId, options()).request.fingerprint).toBe(store.loadRequest(second.requestId, options()).request.fingerprint);
    const summary = await core().status(options());
    expect(summary.requests).toHaveLength(2);
    expect(new Set(summary.requests.map((row) => row.requestId))).toEqual(new Set([first.requestId, second.requestId]));
  });

  it.each([['project-specific', { applicability: 'project-specific' }, 'not-transferable'], ['unapproved export', { exportApproved: false }, 'protected-export']])
  ('submit_%s_keepsLocalKnowledgeAndMakesNoExternalCalls', async (_label, changes, code) => {
    approve();
    const id = await seed(changes);
    const remote = transport();

    refused(await core().submit(id, options({ transport: remote })), code);

    expect(store.loadRequest(id, options()).request).toMatchObject(changes);
    expect(history(id).events.at(-1)).toMatchObject({ kind: 'blocked', data: { code, operation: 'submit' } });
    noCalls(remote);
  });

  it.each([
    ['raw conversation', { rawConversation: 'dummy private conversation' }],
    ['caller project ID', { projectId: '11111111-1111-4111-8111-111111111111' }],
    ['caller request ID', { requestId: '22222222-2222-4222-8222-222222222222' }],
    ['caller hash', { fingerprint: 'a'.repeat(64) }], ['unsupported applicability', { applicability: 'global-memory' }],
    ['private evidence path', { references: [{ path: 'docs/private-app-records.md' }] }],
  ])('capture_%s_refusesStrictInputWithoutPublishing', async (_label, changes) => {
    const remote = transport();

    refused(await core().capture(lesson(changes), options({ transport: remote })), 'invalid-input');

    expect(store.listRequests(options())).toEqual([]);
    noCalls(remote);
  });

  it('capture_firstEventPublicationFailure_reportsFailureAndRetainsHeldRequest', async () => {
    failPublication('captured');

    refused(await core().capture(lesson(), options()), 'persistence-failed');

    const rows = store.listRequests(options());
    expect(rows).toHaveLength(1);
    expect(history(rows[0].request.requestId).status).toBe('held');
  });

  it('submit_existingScannerDetectsSyntheticSecret_neverTransmitsProtectedLesson', async () => {
    approve();
    const synthetic = 'gh' + 'p_' + 'DUMMYONLY'.repeat(4);
    const id = await seed({ problem: `Synthetic detector fixture ${synthetic}` });
    const remote = transport();

    const result = refused(await core().submit(id, options({ transport: remote })), 'protected-export');

    expect(JSON.stringify(result)).not.toContain(synthetic);
    expect(history(id).events.at(-1).kind).toBe('blocked');
    noCalls(remote);
  });

  it('capture_existingScannerDetectsSyntheticSecret_refusesCredentialPersistence', async () => {
    const synthetic = 'gh' + 'p_' + 'DUMMYONLY'.repeat(4);
    const result = refused(await core().capture(lesson({ problem: `Synthetic detector fixture ${synthetic}` }), options()), 'protected-export');
    expect(JSON.stringify(result)).not.toContain(synthetic);
    expect(store.listRequests(options())).toHaveLength(0);
  });

  it('submit_narrowedExportBudget_refusesBeforeExternalCalls', async () => {
    approve({ limits: { ...LEARNING_INTAKE_LIMITS, MAX_EXPORT_BYTES: 512 } });
    const id = await seed();
    const remote = transport();

    refused(await core().submit(id, options({ transport: remote })), 'protected-export');

    noCalls(remote);
  });
});

describe('learning-intake AC4.3 exact current authority and intent-before-write', () => {
  it('submit_credentialLookingApprovedDestination_refusesBeforeAnyExternalOperation', async () => {
    const synthetic = 'gh' + 'p_' + 'DUMMYONLY'.repeat(4);
    approve({ destination: destination({ repository: synthetic }) });
    const id = await seed(); const remote = transport();
    const outcome = refused(await core().submit(id, options({ transport: remote })), 'protected-export');
    expect(JSON.stringify(outcome)).not.toContain(synthetic);
    noCalls(remote);
  });
  it.each([
    ['disabled', (value) => { value.enabled = false; }, 'disabled'],
    ['approval revoked', (value) => { delete value.approval; }, 'not-authorized'],
    ['foreign identity', (value) => { value.projectId = nextId(); }, 'identity-mismatch'],
    ['destination changed', (value) => { value.destination = destination({ repository: 'NewProject' }); }, 'scope-mismatch'],
    ['operations changed', (value) => { value.operations = ['refresh']; }, 'scope-mismatch'],
    ['triggers changed', (value) => { value.triggers = ['todo']; }, 'scope-mismatch'],
    ['limits changed', (value) => { value.limits.MAX_BATCH = 1; }, 'scope-mismatch'],
    ['profile changed', (value) => { value.exportProfile = 'raw-source'; }, 'invalid-input'],
  ])('submit_%s_refusesBeforeAnyExternalOperation', async (_label, mutate, code) => {
    const value = approve();
    const id = await seed();
    mutate(value); writePolicy(value);
    const remote = transport();

    refused(await core().submit(id, options({ transport: remote })), code);

    noCalls(remote);
    expect(history(id).events.at(-1)).toMatchObject({ kind: 'blocked', data: { code, operation: 'submit' } });
  });

  it('submit_currentApprovedScopeExcludesSubmit_refusesWithoutDestinationRead', async () => {
    approve({ operations: ['refresh'] });
    const id = await seed(); const remote = transport();

    refused(await core().submit(id, options({ transport: remote })), 'not-authorized');

    noCalls(remote);
  });

  it('submit_malformedPolicy_refusesAndRetainsInvalidAuthorityBytes', async () => {
    approve(); const id = await seed(); const damaged = '{dummy malformed fixture policy';
    tmp.write(POLICY_FILE, damaged); const remote = transport();

    refused(await core().submit(id, options({ transport: remote })), 'invalid-input');

    expect(tmp.read(POLICY_FILE)).toBe(damaged);
    noCalls(remote);
  });

  it('submit_validApprovedOccurrence_persistsFullBoundIntentBeforePostAndExactReceipt', async () => {
    const policy = approve();
    const id = await seed();
    const remote = transport({ create: vi.fn(async (payload) => {
      const current = history(id);
      expect(current.status).toBe('uncertain');
      expect(current.events.map((event) => event.kind)).toEqual(['captured', 'attempt-started', 'create-intent']);
      expect(current.events.at(-1).data).toMatchObject({ requestHash: hash(payload.request), destination: destination(),
        destinationHash: hash(destination()), policyHash: hash(store.policyScope(policy)), marker: `agents-learning-${id}` });
      expect(store.loadLock(id, options())).toMatchObject({ requestId: id, operation: 'submit' });
      return receipt(id);
    }) });

    const result = await core().submit(id, options({ transport: remote }));

    expect(result).toMatchObject({ ok: true, code: 'ok', status: 'acknowledged', requestId: id, issue: receipt(id) });
    expect(remote.create).toHaveBeenCalledTimes(1);
    expect(history(id).events.map((event) => event.kind)).toEqual(['captured', 'attempt-started', 'create-intent', 'acknowledged']);
    expect(store.loadLock(id, options())).toBeNull();
  });

  it('submit_existingExactOccurrence_adoptsValidatedReceiptWithoutAnotherPost', async () => {
    approve(); const id = await seed(); const remote = transport({ findByMarker: exactRemoteMatch() });
    expect(await core().submit(id, options({ transport: remote }))).toMatchObject({ ok: true, status: 'acknowledged', issue: receipt(id) });
    expect(remote.create).not.toHaveBeenCalled();
    expect(history(id).events.at(-1).kind).toBe('reconciled');
    expect(history(id).events.filter((event) => event.kind === 'create-intent')).toHaveLength(1);
  });

  it.each([
    ['unknown empty', () => ({ matches: [], inconclusive: true })],
    ['false empty assertion', () => ({ matches: [], inconclusive: true, observedEmpty: false })],
    ['truthy empty assertion', () => ({ matches: [], inconclusive: true, observedEmpty: 'yes' })],
    ['multiple exact', (id) => ({ matches: [receipt(id), receipt(id, destination(), { issueId: 102, issueNumber: 102, url: `https://github.com/${destination().owner}/${destination().repository}/issues/102` })], inconclusive: true })],
  ])('submit_freshPreflight_%s_neverPostsWithoutAnObservedEmptyQuery', async (_label, result) => {
    approve(); const id = await seed(); const remote = transport({ findByMarker: vi.fn(async () => result(id)) });
    refused(await core().submit(id, options({ transport: remote })), 'reconciliation-inconclusive');
    expect(remote.create).not.toHaveBeenCalled();
    expect(history(id).events.some((event) => event.kind === 'acknowledged' || event.kind === 'reconciled')).toBe(false);
  });

  it('submit_overlappingSameOccurrence_onlyOneOwnerCanCreate', async () => {
    approve(); const id = await seed();
    let entered; let release;
    const started = new Promise((resolve) => { entered = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    const remote = transport({ create: vi.fn(async () => { entered(); await waiting; return receipt(id); }) });
    const first = core().submit(id, options({ transport: remote }));
    await started;
    try { refused(await core().submit(id, options({ transport: remote })), 'lock-held'); }
    finally { release(); }

    expect((await first).ok).toBe(true);
    expect(remote.create).toHaveBeenCalledTimes(1);
    expect(history(id).events.filter((event) => event.kind === 'acknowledged')).toHaveLength(1);
  });

  it.each([
    ['foreign request hash', { requestHash: 'b'.repeat(64) }],
    ['foreign marker', { marker: 'agents-learning-22222222-2222-4222-8222-222222222222' }],
    ['foreign receiver', { destination: destination({ repository: 'OtherProject' }) }],
  ])('submit_%sFromInjectedAdapter_refusesFalseAcknowledgement', async (_label, changes) => {
    approve(); const id = await seed();
    const remote = transport({ create: vi.fn(async () => receipt(id, destination(), changes)) });

    refused(await core().submit(id, options({ transport: remote })), 'write-uncertain');

    expect(history(id).status).toBe('uncertain');
    expect(history(id).events.some((event) => event.kind === 'acknowledged')).toBe(false);
  });

  it('submit_failedAcknowledgementPublication_isUncertainOnRestart', async () => {
    approve(); const id = await seed();
    const remote = transport();
    failPublication('acknowledged');

    refused(await core().submit(id, options({ transport: remote })), 'persistence-failed');
    vi.restoreAllMocks();

    expect(history(id).status).toBe('uncertain');
    const second = transport();
    refused(await core().submit(id, options({ transport: second })), 'write-uncertain');
    expect(second.create).not.toHaveBeenCalled();
  });

  it('submit_createIntentPublicationFailure_neverCallsPost', async () => {
    approve(); const id = await seed(); const remote = transport(); failPublication('create-intent');

    refused(await core().submit(id, options({ transport: remote })), 'persistence-failed');

    expect(remote.create).not.toHaveBeenCalled();
    expect(history(id).events.some((event) => event.kind === 'create-intent')).toBe(false);
  });

  it.each([null, undefined, false])('submit_falsyThrownTransportFailure_neverSwallowsPossibleWrite', async (value) => {
    approve(); const id = await seed();
    const remote = transport({ create: vi.fn(async () => { throw value; }) });

    refused(await core().submit(id, options({ transport: remote })), 'write-uncertain');

    expect(history(id).status).toBe('uncertain');
    expect(history(id).events.some((event) => event.kind === 'acknowledged')).toBe(false);
  });
});

describe('learning-intake AC4.3 uncertainty and historical-destination reconciliation', () => {
  it('submit_lostResponseThenRestart_neverAutomaticallyCreatesAgain', async () => {
    const { id } = await uncertain();
    const before = history(id).events;
    const remote = transport();

    refused(await core().submit(id, options({ transport: remote })), 'write-uncertain');

    expect(remote.create).not.toHaveBeenCalled();
    expect(history(id).events.slice(0, before.length)).toEqual(before);
    expect(history(id).status).toBe('uncertain');
  });

  it('reconcile_oneExactHistoricalMatch_acknowledgesWithoutNewCreate', async () => {
    const { id } = await uncertain(); const remote = transport({ findByMarker: exactRemoteMatch() });

    expect(await core().reconcile(id, options({ transport: remote }))).toMatchObject({ ok: true, code: 'ok', status: 'acknowledged', issue: receipt(id) });

    expect(remote.findByMarker).toHaveBeenCalledWith({ destination: destination(), marker: `agents-learning-${id}`, requestHash: store.loadRequest(id, options()).requestHash, projectId: store.loadIdentity(options()).projectId }, expect.any(Function));
    expect(remote.create).not.toHaveBeenCalled();
    expect(history(id).events.at(-1).kind).toBe('reconciled');
  });

  it.each(['zero', 'observed-zero', 'multiple', 'inconclusive', 'mismatched'])('reconcile_%sMatches_staysHeldWithoutRetryPermission', async (shape) => {
    const { id } = await uncertain();
    const matches = shape === 'zero' || shape === 'observed-zero' ? [] : shape === 'multiple' ? [receipt(id), receipt(id, destination(), { issueId: 102, issueNumber: 102, url: `https://github.com/${destination().owner}/${destination().repository}/issues/102` })]
      : shape === 'mismatched' ? [receipt(id, destination(), { requestHash: 'b'.repeat(64) })] : [receipt(id)];
    const remote = transport({ findByMarker: vi.fn(async () => ({ matches, inconclusive: ['inconclusive', 'observed-zero'].includes(shape), ...(shape === 'observed-zero' ? { observedEmpty: true } : {}) })) });

    refused(await core().reconcile(id, options({ transport: remote })), 'reconciliation-inconclusive');

    expect(history(id).status).toBe('uncertain');
    expect(history(id).events.some((event) => event.kind === 'recovery-approved')).toBe(false);
    expect(remote.create).not.toHaveBeenCalled();
  });

  it('reconcile_reapprovedDestinationB_doesNotAuthorizeHistoricalAOrRedirectLookup', async () => {
    const { id } = await uncertain(); const original = intent(id).data.destination;
    approve({ destination: destination({ repository: 'ReceiverB' }) });
    const remote = transport({ findByMarker: exactRemoteMatch() });

    refused(await core().reconcile(id, options({ transport: remote })), 'scope-mismatch');

    noCalls(remote);
    expect(intent(id).data.destination).toEqual(original);
    approve({ destination: original });
    expect((await core().reconcile(id, options({ transport: remote }))).ok).toBe(true);
    expect(remote.findByMarker.mock.calls[0][0].destination).toEqual(original);
  });

  it('reconcile_removedPolicyDestination_preservesHistoricalAAndCallsNothing', async () => {
    const { id } = await uncertain(); disable(); const remote = transport();

    refused(await core().reconcile(id, options({ transport: remote })), 'disabled');

    noCalls(remote);
    expect(intent(id).data.destination).toEqual(destination());
  });

  it('status_corruptChain_isHeldAndRetainsDamagedAuthority', async () => {
    const id = await seed();
    const event = history(id).events[0];
    const eventDir = path.join(tmp.root, path.posix.dirname(compartmentDir('evolution/learning-events')), NOW.slice(0, 7));
    const file = fs.readdirSync(eventDir).find((name) => name.includes(event.eventId));
    const damaged = '{dummy corrupt fixture authority'; fs.writeFileSync(path.join(eventDir, file), damaged);

    refused(await core().status(options({ requestId: id })), 'corrupt-history');

    expect(fs.readFileSync(path.join(eventDir, file), 'utf8')).toBe(damaged);
  });
});

describe('learning-intake AC4.3 explicitly reviewed one-use retry recovery', () => {
  it('recover_reviewedRetry_derivesExactBindingsAndIsConsumedByOneIntent', async () => {
    const { id } = await uncertain(); const previous = intent(id); const remote = transport();
    const policy = store.loadPolicy(options()); const before = history(id).events;

    expect(await core().recover(id, recoveryInput(id), options({ transport: remote }))).toMatchObject({ ok: true, code: 'ok', status: 'uncertain' });

    noCalls(remote);
    const grant = history(id).events.at(-1);
    expect(grant.kind).toBe('recovery-approved');
    expect(grant.data).toEqual({ intentEventId: previous.eventId, actor: 'FixtureMaintainer', decision: 'retry-create', reason: 'Reviewed uncertain fixture write.',
      acceptDuplicateRisk: true, requestHash: hash(store.loadRequest(id, options()).request), destination: previous.data.destination,
      destinationHash: hash(previous.data.destination), policyHash: hash(store.policyScope(policy)), exportProfile: 'toolkit-summary-v1' });
    expect(history(id).events.slice(0, before.length)).toEqual(before);
    expect((await core().submit(id, options({ transport: remote }))).ok).toBe(true);
    expect(intent(id).data.recoveryEventId).toBe(grant.eventId);
    expect(history(id).events.filter((event) => event.kind === 'create-intent' && event.data.recoveryEventId === grant.eventId)).toHaveLength(1);
    await core().submit(id, options({ transport: remote }));
    expect(remote.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['duplicate risk refused', { acceptDuplicateRisk: false }, 'invalid-input'],
    ['stale event hash', { expectedLastEventHash: 'a'.repeat(64) }, 'corrupt-history'],
    ['foreign intent', { intentEventId: '11111111-1111-4111-8111-111111111111' }, 'corrupt-history'],
    ['caller supplied bindings', { policyHash: 'a'.repeat(64) }, 'invalid-input'],
  ])('recover_%s_refusesWithoutGrantOrExternalCalls', async (_label, changes, code) => {
    const { id } = await uncertain(); const remote = transport();

    refused(await core().recover(id, recoveryInput(id, changes), options({ transport: remote })), code);

    noCalls(remote);
    expect(history(id).events.some((event) => event.kind === 'recovery-approved')).toBe(false);
  });

  it('recover_currentApprovedScopeLacksRecover_refusesReviewGrant', async () => {
    const { id } = await uncertain(); approve({ operations: ['submit', 'reconcile', 'refresh'] });
    const remote = transport();

    refused(await core().recover(id, recoveryInput(id), options({ transport: remote })), 'not-authorized');

    noCalls(remote);
  });

  it('submit_consumedRetryGrantThenAnotherLostResponse_cannotReuseGrantAfterRestart', async () => {
    const { id } = await uncertain();
    expect((await core().recover(id, recoveryInput(id), options())).ok).toBe(true);
    const grant = history(id).events.at(-1);
    const remote = transport({ create: vi.fn(async () => { throw remoteError('write-uncertain', true); }) });

    refused(await core().submit(id, options({ transport: remote })), 'write-uncertain');
    refused(await core().submit(id, options({ transport: remote })), 'write-uncertain');

    expect(remote.create).toHaveBeenCalledTimes(1);
    expect(history(id).events.filter((event) => event.kind === 'create-intent')).toHaveLength(2);
    expect(history(id).events.filter((event) => event.kind === 'create-intent' && event.data.recoveryEventId === grant.eventId)).toHaveLength(1);
  });

  it('submit_reviewedGrantThenCorruptedImmutableRequest_refusesOldHashWithoutNetwork', async () => {
    const { id } = await uncertain();
    expect((await core().recover(id, recoveryInput(id), options())).ok).toBe(true);
    const row = store.loadRequest(id, options());
    const damaged = { ...row.request, problem: 'Changed immutable fixture after review.' };
    fs.writeFileSync(path.resolve(tmp.root, row.path), JSON.stringify(damaged));
    const remote = transport();

    refused(await core().submit(id, options({ transport: remote })), 'corrupt-history');

    noCalls(remote);
    expect(JSON.parse(fs.readFileSync(path.resolve(tmp.root, row.path), 'utf8'))).toEqual(damaged);
  });

  it.each([
    ['destination', { destination: destination({ repository: 'ReceiverB' }) }],
    ['operation scope', { operations: ['submit', 'recover'] }], ['trigger scope', { triggers: ['todo'] }],
    ['limit scope', { limits: { ...LEARNING_INTAKE_LIMITS, MAX_BATCH: 1 } }],
  ])('submit_reviewedGrantThenChanged%sOnRestart_refusesOldGrantAtConsumption', async (_label, changes) => {
    const { id } = await uncertain();
    expect((await core().recover(id, recoveryInput(id), options())).ok).toBe(true);
    const oldGrant = history(id).events.at(-1); approve(changes); const remote = transport();

    refused(await core().submit(id, options({ transport: remote })), 'scope-mismatch');

    expect(remote.create).not.toHaveBeenCalled();
    expect(history(id).status).toBe('uncertain');
    expect(history(id).events.some((event) => event.kind === 'create-intent' && event.data.recoveryEventId === oldGrant.eventId)).toBe(false);
  });
});

describe('learning-intake AC4.3 offline reviewed abandoned-owner release', () => {
  it('recover_releaseLockDisabledPolicy_persistsDecisionBeforeRemovingExactDeadLocalOwner', async () => {
    const { id } = await uncertain(); disable(); const owner = await staleOwner(id); const remote = transport();
    const lockPath = path.resolve(state.root, owner.path); const unlink = fs.unlinkSync.bind(fs);
    let durableDecisionObserved = false;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((filename) => {
      if (path.resolve(filename) === lockPath) {
        const current = history(id); const decision = current.events.at(-1);
        expect(current.status).toBe('uncertain');
        expect(decision).toMatchObject({ kind: 'recovery-approved', data: { decision: 'release-lock', ownerNonce: owner.nonce, acceptDuplicateRisk: false } });
        expect(decision.data).not.toHaveProperty('policyHash');
        expect(decision.data).not.toHaveProperty('destination');
        durableDecisionObserved = true;
      }
      return unlink(filename);
    });
    const processProbe = vi.fn(() => 'absent');

    expect(await core().recover(id, recoveryInput(id, { decision: 'release-lock', acceptDuplicateRisk: false, ownerNonce: owner.nonce }), options({ transport: remote, processProbe })))
      .toMatchObject({ ok: true, code: 'ok' });

    expect(durableDecisionObserved).toBe(true);
    expect(processProbe).toHaveBeenCalledWith(owner.pid);
    expect(store.loadLock(id, options())).toBeNull();
    noCalls(remote);
    approve();
    refused(await core().submit(id, options({ transport: remote })), 'write-uncertain');
    expect(remote.create).not.toHaveBeenCalled();
  });

  it.each(['alive', 'unknown', 'unexpected', undefined])('recover_processProbe%s_refusesLiveReusedOrAmbiguousOwner', async (probeResult) => {
    const { id } = await uncertain(); disable(); const owner = await staleOwner(id); const remote = transport();
    const before = fs.readFileSync(path.resolve(state.root, owner.path));

    refused(await core().recover(id, recoveryInput(id, { decision: 'release-lock', acceptDuplicateRisk: false, ownerNonce: owner.nonce }), options({ transport: remote, processProbe: () => probeResult })), 'lock-held');

    expect(fs.readFileSync(path.resolve(state.root, owner.path))).toEqual(before);
    expect(history(id).events.some((event) => event.kind === 'recovery-approved')).toBe(false);
    noCalls(remote);
  });

  it('recover_foreignHost_refusesEvenWhenInjectedProbeSaysAbsent', async () => {
    const { id } = await uncertain(); disable(); const owner = await staleOwner(id, { host: 'different-fixture-host' });
    const processProbe = vi.fn(() => 'absent');

    refused(await core().recover(id, recoveryInput(id, { decision: 'release-lock', acceptDuplicateRisk: false, ownerNonce: owner.nonce }), options({ processProbe })), 'lock-held');

    expect(processProbe).not.toHaveBeenCalled();
    expect(store.loadLock(id, options()).nonce).toBe(owner.nonce);
  });

  it.each([['wrong nonce', { ownerNonce: 'd'.repeat(32) }, 'lock-held'], ['stale chain', { expectedLastEventHash: 'a'.repeat(64) }, 'corrupt-history']])
  ('recover_release%s_refusesExactReviewedBindingMismatch', async (_label, changes, code) => {
    const { id } = await uncertain(); const owner = await staleOwner(id);

    refused(await core().recover(id, recoveryInput(id, { decision: 'release-lock', acceptDuplicateRisk: false, ownerNonce: owner.nonce, ...changes }), options({ processProbe: () => 'absent' })), code);

    expect(store.loadLock(id, options()).nonce).toBe(owner.nonce);
  });

  it('recover_exclusiveRecoveryGuardAlreadyHeld_refusesConcurrentReviewedMutation', async () => {
    const { id } = await uncertain(); const owner = await staleOwner(id);
    let entered; let release;
    const started = new Promise((resolve) => { entered = resolve; }); const waiting = new Promise((resolve) => { release = resolve; });
    const held = store.withRecoveryGuard(id, async () => { entered(); await waiting; }, options()); await started;
    try {
      refused(await core().recover(id, recoveryInput(id, { decision: 'release-lock', acceptDuplicateRisk: false, ownerNonce: owner.nonce }), options({ processProbe: () => 'absent' })), 'lock-held');
    } finally { release(); await held; }
    expect(store.loadLock(id, options()).nonce).toBe(owner.nonce);
  });

  it('recover_publicationFailure_retainsAbandonedLockAndNeverGrantsCreate', async () => {
    const { id } = await uncertain(); disable(); const owner = await staleOwner(id); failPublication('recovery-approved');

    refused(await core().recover(id, recoveryInput(id, { decision: 'release-lock', acceptDuplicateRisk: false, ownerNonce: owner.nonce }), options({ processProbe: () => 'absent' })), 'persistence-failed');

    expect(store.loadLock(id, options()).nonce).toBe(owner.nonce);
    expect(history(id).events.some((event) => event.kind === 'recovery-approved')).toBe(false);
  });

  it.each([['ESRCH', true], ['EPERM', false], ['EACCES', false]])('recover_defaultProcessProbe%s_acceptsOnlyDefinitelyAbsentLocalPid', async (code, allowed) => {
    const { id } = await uncertain(); disable(); const owner = await staleOwner(id);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(PRIVATE_ERROR), { code }); });

    const result = await core().recover(id, recoveryInput(id, { decision: 'release-lock', acceptDuplicateRisk: false, ownerNonce: owner.nonce }), options());

    expect(kill).toHaveBeenCalledWith(owner.pid, 0);
    if (allowed) { expect(result.ok).toBe(true); expect(store.loadLock(id, options())).toBeNull(); }
    else { refused(result, 'lock-held'); expect(store.loadLock(id, options()).nonce).toBe(owner.nonce); }
  });
});

describe('learning-intake AC4.3 finite retries, throttle delays and lifecycle batches', () => {
  it('submit_knownNoWriteRejection_retainsOriginalReceiverBeforeAnyRetryTransport', async () => {
    approve(); const id = await seed();
    const first = transport({ create: vi.fn(async () => { throw remoteError('auth-unavailable', false); }) });
    refused(await core().submit(id, options({ transport: first })), 'auth-unavailable');
    const original = intent(id);
    approve({ destination: destination({ repository: 'ReceiverB' }) });
    const redirected = transport();
    refused(await core().submit(id, options({ transport: redirected })), 'scope-mismatch');
    noCalls(redirected);
    expect(intent(id)).toEqual(original);
    approve({ destination: original.data.destination });
    const resumed = transport();
    expect((await core().submit(id, options({ transport: resumed }))).ok).toBe(true);
    expect(resumed.create.mock.calls[0][0].destination).toEqual(original.data.destination);
  });

  it.each(['reconcile', 'refresh'])('lifecycle_%sThrottle_retainsDelayAcrossRepeatedInvocationsThenResumesAtBound', async operation => {
    let id;
    if (operation === 'reconcile') ({ id } = await uncertain());
    else {
      approve(); id = await seed();
      expect((await core().submit(id, options({ transport: transport() }))).ok).toBe(true);
    }
    const nextAttemptAt = '2026-10-14T14:00:30.000Z';
    const method = operation === 'reconcile' ? 'findByMarker' : 'show';
    const successful = operation === 'reconcile'
      ? { matches: [receipt(id)], inconclusive: false }
      : { receipt: receipt(id), remoteState: 'open' };
    const call = vi.fn().mockRejectedValueOnce(remoteError('throttled', false, { nextAttemptAt })).mockResolvedValue(successful);
    const remote = transport({ [method]: call });
    refused(await core().lifecycle(options({ trigger: 'end', transport: remote })), 'throttled');
    expect(history(id).events.at(-1)).toMatchObject({
      kind: operation === 'reconcile' ? 'retryable' : 'refresh-failed', data: { code: 'throttled', nextAttemptAt },
    });
    for (let repeat = 0; repeat < 2; repeat++) {
      refused(await core().lifecycle(options({ trigger: 'end', transport: remote })), 'throttled');
      expect(call).toHaveBeenCalledTimes(1);
    }
    expect((await core().lifecycle(options({ trigger: 'end', transport: remote, clock: () => nextAttemptAt }))).ok).toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
    expect(history(id).status).toBe('acknowledged');
  });

  it.each(['auth-unavailable', 'access-denied', 'destination-unavailable', 'invalid-input', 'throttled'])
  ('submit_knownNoCommit%s_retainsAttemptThenAllowsBoundedLaterRetry', async (code) => {
    approve(); const id = await seed();
    const remote = transport({ create: vi.fn().mockRejectedValueOnce(remoteError(code, false)).mockResolvedValueOnce(receipt(id)) });

    refused(await core().submit(id, options({ transport: remote })), code);
    const first = history(id).events;
    expect(first.some((event) => event.kind === 'retryable')).toBe(true);
    expect((await core().submit(id, options({ transport: remote }))).ok).toBe(true);

    expect(remote.create).toHaveBeenCalledTimes(2);
    expect(history(id).events.slice(0, first.length)).toEqual(first);
    expect(history(id).events.filter((event) => event.kind === 'create-intent')).toHaveLength(2);
  });

  it('submit_attemptBudgetAcrossRepeatedInvocations_neverSilentlyResets', async () => {
    approve({ limits: { ...LEARNING_INTAKE_LIMITS, MAX_CREATE_ATTEMPTS: 2 } }); const id = await seed();
    const remote = transport({ create: vi.fn(async () => { throw remoteError('auth-unavailable', false); }) });

    refused(await core().submit(id, options({ transport: remote })), 'auth-unavailable');
    refused(await core().submit(id, options({ transport: remote })), 'auth-unavailable');
    refused(await core().submit(id, options({ transport: remote })), 'budget-exhausted');

    expect(remote.create).toHaveBeenCalledTimes(2);
    expect(history(id).events.filter((event) => event.kind === 'create-intent')).toHaveLength(2);
  });

  it('submit_interruptedReadBeforeCreateIntent_restartCanResumeWithoutCorruptingHistory', async () => {
    const policy = approve(); const id = await seed(); const attemptId = nextId();
    await store.withRequestLock(id, (lockOwner) => store.appendEvent(id, 'attempt-started', {
      attemptId, operation: 'submit', policyHash: policy.approval.scopeHash,
    }, options({ lockOwner, expectedLastEventHash: history(id).lastEventHash })), options());
    const before = history(id).events; const remote = transport();
    expect((await core().submit(id, options({ transport: remote }))).ok).toBe(true);
    expect(history(id).events.slice(0, before.length)).toEqual(before);
    expect(history(id).events.filter((event) => event.kind === 'create-intent')).toHaveLength(1);
    expect(remote.create).toHaveBeenCalledTimes(1);
  });

  it('submit_approvedCeilingWideningAndRestart_onlyPermitsRemainingCumulativeAttempt', async () => {
    approve({ limits: { ...LEARNING_INTAKE_LIMITS, MAX_CREATE_ATTEMPTS: 2 } }); const id = await seed();
    const remote = transport({ create: vi.fn(async () => { throw remoteError('auth-unavailable', false); }) });
    for (let i = 0; i < 2; i++) refused(await core().submit(id, options({ transport: remote })), 'auth-unavailable');
    approve({ triggers: ['end', 'todo'], limits: { ...LEARNING_INTAKE_LIMITS, MAX_CREATE_ATTEMPTS: 3 } });
    delete require.cache[require.resolve('../learning-intake')];
    refused(await core().submit(id, options({ transport: remote })), 'auth-unavailable');
    refused(await core().submit(id, options({ transport: remote })), 'budget-exhausted');
    expect(remote.create).toHaveBeenCalledTimes(3);
    expect(history(id).events.filter((event) => event.kind === 'create-intent')).toHaveLength(3);
  });

  it('recover_cumulativeCeilingExhausted_refusesNewRetryGrantAndRetainsHistory', async () => {
    approve(); const id = await seed();
    const remote = transport({ create: vi.fn(async () => { throw remoteError('write-uncertain', true); }) });
    for (let i = 0; i < 3; i++) {
      if (i > 0) expect((await core().recover(id, recoveryInput(id), options())).ok).toBe(true);
      refused(await core().submit(id, options({ transport: remote })), 'write-uncertain');
    }
    const before = history(id).events;
    refused(await core().recover(id, recoveryInput(id), options()), 'budget-exhausted');
    expect(history(id).events.filter((event) => event.kind === 'recovery-approved')).toHaveLength(2);
    expect(history(id).events.slice(0, before.length)).toEqual(before);
    expect(remote.create).toHaveBeenCalledTimes(3);
  });

  it('submit_validatedThrottleDelay_preventsPrematureCallsThenResumesAfterBound', async () => {
    approve(); const id = await seed(); const nextAttemptAt = '2026-10-14T14:00:30.000Z';
    const remote = transport({ create: vi.fn().mockRejectedValueOnce(remoteError('throttled', false, { nextAttemptAt })).mockResolvedValueOnce(receipt(id)) });

    refused(await core().submit(id, options({ transport: remote })), 'throttled');
    expect(history(id).events.at(-1)).toMatchObject({ kind: 'retryable', data: { nextAttemptAt } });
    refused(await core().submit(id, options({ transport: remote })), 'throttled');
    expect(remote.create).toHaveBeenCalledTimes(1);
    expect((await core().submit(id, options({ transport: remote, clock: () => '2026-10-14T14:00:31.000Z' }))).ok).toBe(true);
    expect(remote.create).toHaveBeenCalledTimes(2);
  });

  async function receivedForThrottle() {
    approve(); const id = await seed();
    expect((await core().submit(id, options({ transport: transport() }))).ok).toBe(true);
    return id;
  }

  it('reconcile_validatedThrottleDelay_survivesRestartAndHoldsUncertainCreate', async () => {
    const { id } = await uncertain();
    const nextAttemptAt = '2026-10-14T14:00:30.000Z';
    const priorIntent = intent(id);
    const remote = transport({ findByMarker: vi.fn()
      .mockRejectedValueOnce(remoteError('throttled', false, { nextAttemptAt }))
      .mockImplementation(async () => ({ matches: [receipt(id)], inconclusive: false })) });

    refused(await core().reconcile(id, options({ transport: remote })), 'throttled');
    expect(history(id).events.at(-1)).toMatchObject({ kind: 'retryable', data: { code: 'throttled', nextAttemptAt } });
    delete require.cache[require.resolve('../learning-intake')];
    refused(await core().reconcile(id, options({ transport: remote })), 'throttled');
    expect(remote.findByMarker).toHaveBeenCalledTimes(1);
    expect(history(id).status).toBe('uncertain');
    expect(intent(id)).toEqual(priorIntent);
    expect(remote.create).not.toHaveBeenCalled();

    expect((await core().reconcile(id, options({ transport: remote, clock: () => '2026-10-14T14:00:31.000Z' }))).ok).toBe(true);
    expect(remote.findByMarker).toHaveBeenCalledTimes(2);
    expect(remote.create).not.toHaveBeenCalled();
  });

  it('refresh_validatedThrottleDelay_retainsStaleResolutionAndResumesAfterBound', async () => {
    const id = await receivedForThrottle();
    const prior = { schemaVersion: 1, requestId: id, disposition: 'accepted', rationale: 'Reviewed fixture.', reviewedAt: NOW };
    const nextAttemptAt = '2026-10-14T14:00:30.000Z';
    const observation = { receipt: receipt(id), remoteState: 'Active', resolution: prior };
    const remote = transport({ show: vi.fn().mockResolvedValueOnce(observation)
      .mockRejectedValueOnce(remoteError('throttled', false, { nextAttemptAt })).mockResolvedValue(observation) });
    expect((await core().refresh(id, options({ transport: remote }))).ok).toBe(true);

    expect(refused(await core().refresh(id, options({ transport: remote })), 'throttled')).toMatchObject({ stale: true, resolution: prior });
    expect(history(id).events.at(-1)).toMatchObject({ kind: 'refresh-failed', data: { code: 'throttled', nextAttemptAt } });
    delete require.cache[require.resolve('../learning-intake')];
    expect((await core().status(options({ requestId: id }))).requests[0]).toMatchObject({ stale: true, resolution: prior });
    refused(await core().refresh(id, options({ transport: remote })), 'throttled');
    expect(remote.show).toHaveBeenCalledTimes(2);
    expect(remote.create).not.toHaveBeenCalled();

    expect(await core().refresh(id, options({ transport: remote, clock: () => '2026-10-14T14:00:31.000Z' }))).toMatchObject({ ok: true, stale: false, resolution: prior });
    expect(remote.show).toHaveBeenCalledTimes(3);
    expect(history(id).events.filter(event => event.kind === 'create-intent')).toHaveLength(1);
  });

  it.each(['reconcile', 'refresh'])('%s_throttleDeadline_isAlsoEnforcedThroughLifecycle', async operation => {
    const id = operation === 'reconcile' ? (await uncertain()).id : await receivedForThrottle();
    const method = operation === 'reconcile' ? 'findByMarker' : 'show';
    const remote = transport({ [method]: vi.fn(async () => { throw remoteError('throttled', false, { nextAttemptAt: '2026-10-14T14:00:30.000Z' }); }) });
    refused(await core()[operation](id, options({ transport: remote })), 'throttled');

    await core().lifecycle(options({ transport: remote, trigger: 'end' }));

    expect(remote[method]).toHaveBeenCalledTimes(1);
    expect(remote.create).not.toHaveBeenCalled();
  });

  it.each(['reconcile', 'refresh'])('%s_invalidThrottleDelay_isNeverRetainedAsAuthority', async operation => {
    const id = operation === 'reconcile' ? (await uncertain()).id : await receivedForThrottle();
    const method = operation === 'reconcile' ? 'findByMarker' : 'show';
    const remote = transport({ [method]: vi.fn(async () => { throw remoteError('throttled', false, { nextAttemptAt: '2026-10-16T14:00:30.000Z' }); }) });

    refused(await core()[operation](id, options({ transport: remote })), 'throttled');

    expect(history(id).events.some(event => Object.hasOwn(event.data, 'nextAttemptAt'))).toBe(false);
    expect(remote[method]).toHaveBeenCalledTimes(1);
    expect(remote.create).not.toHaveBeenCalled();
  });

  it('lifecycle_disabledDefaults_initializeLocallyAndPerformNoTransport', async () => {
    fs.unlinkSync(path.join(tmp.root, '.agents/learning-intake/identity.json')); fs.unlinkSync(path.join(tmp.root, POLICY_FILE));
    const remote = transport();

    expect(await core().lifecycle(options({ trigger: 'end', transport: remote }))).toMatchObject({ ok: true, code: 'disabled' });

    expect(store.loadPolicy(options()).enabled).toBe(false);
    noCalls(remote);
  });

  it.each(['startup', 'precompaction', 'tool-use', 'install', 'update', 'restore', 'unexpected'])('lifecycle_%sTrigger_isNeverAuthorizedForNetwork', async (trigger) => {
    approve(); await seed(); const remote = transport();

    refused(await core().lifecycle(options({ trigger, transport: remote })), 'invalid-input');

    noCalls(remote);
  });

  it('lifecycle_validButUnapprovedTrigger_refusesNetwork', async () => {
    approve({ triggers: ['end'] }); await seed(); const remote = transport();

    refused(await core().lifecycle(options({ trigger: 'todo', transport: remote })), 'not-authorized');

    noCalls(remote);
  });

  it('lifecycle_narrowedBatchTwoProcessesExactlyTwoOfThreeOccurrences', async () => {
    approve({ limits: { ...LEARNING_INTAKE_LIMITS, MAX_BATCH: 2 } });
    const ids = await Promise.all([seed(), seed({ title: 'Second selected lesson' }), seed({ title: 'Third selected lesson' })]);
    const remote = transport();

    const result = await core().lifecycle(options({ trigger: 'end', transport: remote }));

    expect(result.ok).toBe(true);
    expect(remote.create).toHaveBeenCalledTimes(2);
    expect(ids.filter((id) => history(id).status === 'acknowledged')).toHaveLength(2);
    expect(ids.filter((id) => history(id).status === 'pending')).toHaveLength(1);
    expect(Object.values(result.counts).every((count) => Number.isSafeInteger(count) && count >= 0)).toBe(true);
  });

  it('lifecycle_oneAttemptedFailure_foldsNonzeroResultAndPreservesOtherOccurrences', async () => {
    approve(); const first = await seed(); const second = await seed({ title: 'Other selected lesson' });
    const remote = transport({ create: vi.fn(async ({ request }) => { if (request.requestId === first) throw remoteError('auth-unavailable', false); return receipt(request.requestId); }) });

    refused(await core().lifecycle(options({ trigger: 'end', transport: remote })), 'auth-unavailable');

    expect(store.listRequests(options())).toHaveLength(2);
    expect(history(first).status).toBe('retryable');
    expect(history(second).status).toBe('acknowledged');
  });

  it('lifecycle_triggerRevokedBetweenItems_refusesNextExternalOperation', async () => {
    approve(); const first = await seed(); const second = await seed({ title: 'Second selected lesson' });
    const remote = transport({ create: vi.fn(async ({ request }) => {
      approve({ triggers: ['todo'] }); return receipt(request.requestId);
    }) });
    refused(await core().lifecycle(options({ trigger: 'end', transport: remote })), 'not-authorized');
    expect(remote.create).toHaveBeenCalledTimes(1);
    expect(history(first).status).toBe('acknowledged');
    expect(history(second).events.some((event) => event.kind === 'create-intent')).toBe(false);
  });

  it('lifecycle_triggerRevokedDuringDestinationRead_refusesFollowingLookup', async () => {
    approve(); const id = await seed();
    const remote = transport({ validateDestination: vi.fn(async (target) => {
      approve({ triggers: ['todo'] });
      return { ...target };
    }) });
    refused(await core().lifecycle(options({ trigger: 'end', transport: remote })), 'not-authorized');
    expect(remote.findByMarker).not.toHaveBeenCalled();
    expect(remote.create).not.toHaveBeenCalled();
    expect(history(id).events.some((event) => event.kind === 'create-intent')).toBe(false);
  });

  it('lifecycle_approvedBatchNarrowedAfterFirstItem_stopsAtCurrentCeiling', async () => {
    approve({ limits: { ...LEARNING_INTAKE_LIMITS, MAX_BATCH: 3 } });
    const first = await seed(); const second = await seed({ title: 'Second selected lesson' });
    const remote = transport({ create: vi.fn(async ({ request }) => {
      approve({ limits: { ...LEARNING_INTAKE_LIMITS, MAX_BATCH: 1 } }); return receipt(request.requestId);
    }) });
    expect(await core().lifecycle(options({ trigger: 'end', transport: remote }))).toMatchObject({ ok: true, counts: { attempted: 1, succeeded: 1, failed: 0 } });
    expect(remote.create).toHaveBeenCalledTimes(1);
    expect(history(first).status).toBe('acknowledged');
    expect(history(second).status).toBe('pending');
  });
});

describe('learning-intake AC4.3 maintainer refresh preserves separate evidence states', () => {
  async function acknowledged() { approve(); const id = await seed(); expect((await core().submit(id, options({ transport: transport() }))).ok).toBe(true); return id; }

  it.each([false, true])('refresh_remoteStateDetectedCredential_resolution%s_refusesBeforePersistingObservation', async (withResolution) => {
    const id = await acknowledged(); const synthetic = 'gh' + 'p_' + 'DUMMYONLY'.repeat(4);
    const remote = transport({ show: vi.fn(async () => ({ receipt: receipt(id), remoteState: synthetic, ...(withResolution ? { resolution: resolution(id) } : {}) })) });
    const outcome = refused(await core().refresh(id, options({ transport: remote })), 'protected-export');
    expect(JSON.stringify(outcome)).not.toContain(synthetic);
    expect(JSON.stringify(history(id))).not.toContain(synthetic);
    expect(history(id).events.at(-1)).toMatchObject({ kind: 'refresh-failed', data: { code: 'protected-export' } });
    expect((await core().status(options({ requestId: id }))).ok).toBe(true);
  });

  it('refresh_authorityRefusal_marksPriorResolutionStaleAcrossRestart', async () => {
    const id = await acknowledged(); const valid = resolution(id);
    const remote = transport({ show: vi.fn(async () => ({ receipt: receipt(id), remoteState: 'Closed', resolution: valid })) });
    expect(await core().refresh(id, options({ transport: remote }))).toMatchObject({ resolution: valid, stale: false });
    disable(); remote.show.mockClear();
    refused(await core().refresh(id, options({ transport: remote })), 'disabled');
    delete require.cache[require.resolve('../learning-intake')];
    expect(await core().status(options({ requestId: id }))).toMatchObject({ requests: [{ resolution: valid, stale: true }] });
    expect(remote.show).not.toHaveBeenCalled();
  });

  it('refresh_repeatedWithoutEnvelope_finishesBothAttemptsWithoutInventingDisposition', async () => {
    const id = await acknowledged(); const remote = transport();
    for (let i = 0; i < 2; i++) {
      const actual = await core().refresh(id, options({ transport: remote }));
      expect(actual).toMatchObject({ ok: true, status: 'acknowledged', remoteState: 'New', stale: false });
      expect(actual).not.toHaveProperty('resolution');
    }
    const events = history(id).events;
    expect(events.filter((event) => event.kind === 'refresh-observed')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'refresh-failed' || event.kind === 'resolution-observed')).toHaveLength(0);
    expect(remote.show).toHaveBeenCalledTimes(2);
  });

  it('refresh_envelopeRemoved_preservesHistoricalResolutionAsStaleUntilNewValidEnvelope', async () => {
    const id = await acknowledged(); const valid = resolution(id);
    const remote = transport({ show: vi.fn().mockResolvedValueOnce({ receipt: receipt(id), remoteState: 'Closed', resolution: valid })
      .mockResolvedValueOnce({ receipt: receipt(id), remoteState: 'Active' })
      .mockResolvedValueOnce({ receipt: receipt(id), remoteState: 'Closed', resolution: valid }) });
    expect((await core().refresh(id, options({ transport: remote }))).stale).toBe(false);
    expect(await core().refresh(id, options({ transport: remote }))).toMatchObject({ ok: true, resolution: valid, remoteState: 'Active', stale: true });
    expect(await core().status(options({ requestId: id }))).toMatchObject({ requests: [{ resolution: valid, stale: true }] });
    expect(await core().refresh(id, options({ transport: remote }))).toMatchObject({ ok: true, resolution: valid, stale: false });
  });

  it('refresh_noEnvelopeCompletionWriteFailure_isPersistenceFailureNotSuccess', async () => {
    const id = await acknowledged(); const remote = transport(); const broken = failPublication('refresh-observed');
    refused(await core().refresh(id, options({ transport: remote })), 'persistence-failed');
    broken.mockRestore();
    expect(history(id).events.filter((event) => event.kind === 'refresh-observed')).toHaveLength(0);
    expect(remote.show).toHaveBeenCalledTimes(1);
  });

  it('refresh_completionPublicationFailure_preservesPriorEvidenceAsStaleAcrossRestart', async () => {
    const id = await acknowledged(); const valid = resolution(id);
    const remote = transport({ show: vi.fn()
      .mockResolvedValueOnce({ receipt: receipt(id), remoteState: 'Closed', resolution: valid })
      .mockResolvedValueOnce({ receipt: receipt(id), remoteState: 'Active' })
      .mockResolvedValueOnce({ receipt: receipt(id), remoteState: 'Closed', resolution: valid }) });
    expect(await core().refresh(id, options({ transport: remote }))).toMatchObject({ resolution: valid, stale: false });
    const broken = failPublication('refresh-observed');
    refused(await core().refresh(id, options({ transport: remote })), 'persistence-failed');
    broken.mockRestore();
    delete require.cache[require.resolve('../learning-intake')];
    expect(await core().status(options({ requestId: id }))).toMatchObject({ requests: [{ resolution: valid, stale: true }] });
    expect(history(id).events.at(-1)).toMatchObject({ kind: 'attempt-started', data: { operation: 'refresh' } });
    expect(await core().refresh(id, options({ transport: remote }))).toMatchObject({ resolution: valid, stale: false });
    expect(remote.create).not.toHaveBeenCalled();
    expect(history(id).events.filter((event) => event.kind === 'resolution-observed')).toHaveLength(2);
  });

  it('refresh_interruptedReadAfterAcknowledgement_restartCanFinishFreshObservation', async () => {
    const id = await acknowledged(); const policy = store.loadPolicy(options());
    await store.withRequestLock(id, (lockOwner) => store.appendEvent(id, 'attempt-started', {
      attemptId: nextId(), operation: 'refresh', policyHash: policy.approval.scopeHash,
    }, options({ lockOwner, expectedLastEventHash: history(id).lastEventHash })), options());
    const before = history(id).events; const remote = transport();
    expect(await core().refresh(id, options({ transport: remote }))).toMatchObject({ ok: true, remoteState: 'New', stale: false });
    expect(history(id).events.slice(0, before.length)).toEqual(before);
    expect(history(id).events.at(-1).kind).toBe('refresh-observed');
    expect(remote.create).not.toHaveBeenCalled();
    expect(remote.show).toHaveBeenCalledTimes(1);
  });

  it('refresh_acceptedWithoutRelease_keepsDispositionSeparateFromPublication', async () => {
    const id = await acknowledged();
    const accepted = { schemaVersion: 1, requestId: id, disposition: 'accepted', rationale: 'Queued for toolkit work.', reviewedAt: NOW };
    const remote = transport({ show: vi.fn(async () => ({ receipt: receipt(id), remoteState: 'Closed', resolution: accepted })) });

    expect(await core().refresh(id, options({ transport: remote }))).toMatchObject({ ok: true, resolution: accepted, stale: false });

    const summary = await core().status(options({ requestId: id }));
    expect(summary.requests[0].resolution).toEqual(accepted);
    expect(summary.requests[0].resolution).not.toHaveProperty('release');
    expect(summary.requests[0]).not.toHaveProperty('installedVersion');
  });

  it('refresh_repeatedValidReleaseThenFailure_preservesLastValidResolutionAndResumes', async () => {
    const id = await acknowledged(); const valid = resolution(id);
    const remote = transport({ show: vi.fn()
      .mockResolvedValueOnce({ receipt: receipt(id), remoteState: 'Closed', resolution: valid })
      .mockResolvedValueOnce({ receipt: receipt(id), remoteState: 'Closed', resolution: valid })
      .mockRejectedValueOnce(remoteError('network-unavailable', false))
      .mockResolvedValueOnce({ receipt: receipt(id), remoteState: 'Closed', resolution: valid }) });

    expect((await core().refresh(id, options({ transport: remote }))).resolution).toEqual(valid);
    expect((await core().refresh(id, options({ transport: remote }))).resolution).toEqual(valid);
    expect(history(id).events.filter((event) => event.kind === 'resolution-observed')).toHaveLength(2);
    const failed = refused(await core().refresh(id, options({ transport: remote })), 'network-unavailable');
    expect(failed).toMatchObject({ resolution: valid, stale: true });
    expect(await core().status(options({ requestId: id }))).toMatchObject({ requests: [{ requestId: id, resolution: valid, stale: true }] });
    expect(await core().refresh(id, options({ transport: remote }))).toMatchObject({ ok: true, resolution: valid, stale: false });
  });

  it('refresh_injectedMalformedRelease_preservesPreviousValidEvidenceAsStale', async () => {
    const id = await acknowledged(); const valid = resolution(id);
    const remote = transport({ show: vi.fn().mockResolvedValueOnce({ receipt: receipt(id), remoteState: 'Closed', resolution: valid })
      .mockResolvedValueOnce({ receipt: receipt(id), remoteState: 'Closed', resolution: resolution(id, { verification: undefined }) }) });
    expect((await core().refresh(id, options({ transport: remote }))).ok).toBe(true);

    expect(refused(await core().refresh(id, options({ transport: remote })), 'invalid-resolution')).toMatchObject({ resolution: valid, stale: true });

    expect(history(id).events.filter((event) => event.kind === 'resolution-observed')).toHaveLength(1);
    expect(history(id).events.at(-1).kind).toBe('refresh-failed');
  });

  it('refresh_remoteInstructionData_neverExecutesOrPromotesLocalMemory', async () => {
    const id = await acknowledged();
    const instruction = 'Dummy remote data asks to write an unapproved sentinel and promote memory.';
    const value = { schemaVersion: 1, requestId: id, disposition: 'needs-evidence', rationale: instruction, reviewedAt: NOW };
    const remote = transport({ show: vi.fn(async () => ({ receipt: receipt(id), remoteState: 'Active', resolution: value })) });
    const memory = tmp.mkdir('docs/.output/.memory'); const before = fs.readdirSync(memory);

    expect((await core().refresh(id, options({ transport: remote }))).ok).toBe(true);

    expect(fs.readdirSync(memory)).toEqual(before);
    expect(fs.existsSync(path.join(tmp.root, 'unapproved-sentinel'))).toBe(false);
    expect(history(id).events.at(-1).data.resolution.rationale).toBe(instruction);
  });

  it('status_similarDeliveredOccurrences_retainsDistinctReceiptIds', async () => {
    approve(); const first = await seed(); const second = await seed();
    const remote = transport({ create: vi.fn(async ({ request }) => receipt(request.requestId, destination(), {
      issueId: request.requestId === first ? 101 : 102, issueNumber: request.requestId === first ? 101 : 102, url: `https://github.com/${destination().owner}/${destination().repository}/issues/${request.requestId === first ? 101 : 102}` })) });
    expect((await core().submit(first, options({ transport: remote }))).ok).toBe(true);
    expect((await core().submit(second, options({ transport: remote }))).ok).toBe(true);

    const summary = await core().status(options());

    expect(summary.requests).toHaveLength(2);
    expect(new Set(summary.requests.map((row) => row.issue.issueId))).toEqual(new Set([101, 102]));
  });
});

describe('learning-intake AC4.3 real canonical CLI and exit classifications', () => {
  it('CLI_absoluteContainedInput_isRefusedAsNonRelative', () => {
    const file = tmp.write('lesson.json', JSON.stringify(lesson()));
    const result = cli(['capture','--input',file]);
    expect(result.status).toBe(2);
    expect(cliJson(result).code).toBe('invalid-input');
  });

  it.skipIf(process.platform === 'win32')('CLI_FIFOInput_isRefusedWithoutBlocking', () => {
    const file = path.join(tmp.root,'fifo-input');
    const made = spawnSync('mkfifo',[file]);
    expect(made.status).toBe(0);
    const result = cli(['capture','--input','fifo-input']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(cliJson(result).code).toBe('invalid-input');
  });

  it.each(['claude','codex'])('%s installed native CLI initializes and captures offline under exact fixture context', runtime => {
    vi.spyOn(console,'log').mockImplementation(()=>{});
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    const toolkit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const source = path.join(other.root,'source');
    const target = path.join(other.root,'native adopter with spaces');
    copyToolkit(toolkit,source);
    fs.mkdirSync(target,{recursive:true});
    const installed = runInstall({source,target});
    expect(installed.ok).toBe(true);
    const put = (relative,value) => {
      const file=path.join(target,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));
    };
    put('inputs/init.json',{projectName:'NativeFixture'});
    put('inputs/lesson.json',lesson());
    const env={...process.env};
    for(const key of ['AGENTS_RUNTIME','AGENT_RUNTIME','AGENT_SOURCE_ROOT','CODEX_PROJECT_DIR','CLAUDE_PROJECT_DIR','AGENTS_PROJECT_DIR','AGENT_PROJECT_ROOT','AGENT_SHARED_STATE_ROOT'])delete env[key];
    Object.assign(env,{AGENTS_PROJECT_DIR:target,AGENT_SHARED_STATE_ROOT:state.root,PATH:state.root});
    const entry=path.join(target,'.'+runtime,'core/learning-intake.js');
    const invoke=args=>spawnSync(process.execPath,[entry,...args],{cwd:other.root,env,encoding:'utf8',timeout:10000,maxBuffer:262144});
    const initialized=invoke(['init','--input','inputs/init.json']);
    expect(initialized.status,initialized.stderr).toBe(0);
    expect(cliJson(initialized)).toMatchObject({ok:true,status:'initialized'});
    const captured=invoke(['capture','--input','inputs/lesson.json']);
    expect(captured.status,captured.stderr).toBe(0);
    const occurrence=cliJson(captured);
    const inspected=invoke(['status','--id',occurrence.requestId]);
    expect(inspected.status,inspected.stderr).toBe(0);
    expect(cliJson(inspected).requests[0]).toMatchObject({requestId:occurrence.requestId,runtime,status:'pending'});
    expect(store.readEvents(occurrence.requestId,{projectRoot:target,stateRoot:state.root}).events.map(event=>event.kind)).toEqual(['captured']);
    const policy=JSON.parse(fs.readFileSync(path.join(target,POLICY_FILE),'utf8'));
    expect(policy.enabled).toBe(false);
    expect(fs.existsSync(path.join(target,'tools/run-toolkit-tests.cjs'))).toBe(false);
  });

  it('CLI_initCaptureStatus_containedJsonInput_performsActualOfflineWorkflowWithExitZero', () => {
    const input = tmp.write('docs/modules/learning-intake/lesson.json', JSON.stringify(lesson()));
    const captured = cli(['capture', '--input', path.relative(tmp.root, input)]);

    expect(captured.status).toBe(0); const created = cliJson(captured);
    expect(created).toMatchObject({ ok: true, code: 'ok', status: 'pending' });
    expect(created.requestId).toMatch(UUID);
    expect(store.loadRequest(created.requestId, options()).request.runtime).toBe('codex');
    const summary = cli(['status', '--id', created.requestId]);
    expect(summary.status).toBe(0);
    expect(cliJson(summary)).toMatchObject({ requests: [{ requestId: created.requestId, status: 'pending' }] });
  });

  it.each([
    ['unknown command', ['publish']], ['unknown flag', ['status', '--unsafe']],
    ['missing ID', ['submit']], ['invalid ID', ['status', '--id', '../escape']],
    ['duplicate option', ['status', '--id', '11111111-1111-4111-8111-111111111111', '--id', '22222222-2222-4222-8222-222222222222']],
  ])('CLI_%s_exitsTwoWithoutRawDiagnostics', (_label, args) => {
    const result = cli(args);
    expect(result.status).toBe(2);
    expect(cliJson(result)).toMatchObject({ ok: false, code: 'invalid-input' });
  });

  it('CLI_inputOutsideCheckout_refusesTraversalWithExitTwo', () => {
    const outside = other.write('lesson.json', JSON.stringify(lesson()));
    const result = cli(['capture', '--input', path.relative(tmp.root, outside)]);

    expect(result.status).toBe(2);
    expect(cliJson(result)).toMatchObject({ ok: false, code: 'invalid-input' });
    expect(store.listRequests(options())).toEqual([]);
  });

  it('CLI_inputAncestorJunction_refusesOutsidePayloadWithExitTwo', () => {
    other.write('lesson.json', JSON.stringify(lesson()));
    fs.symlinkSync(other.root, path.join(tmp.root, 'linked-input'), 'junction');
    const result = cli(['capture', '--input', 'linked-input/lesson.json']);

    expect(result.status).toBe(2);
    expect(cliJson(result)).toMatchObject({ ok: false, code: 'invalid-input' });
  });

  it('CLI_malformedJsonAndStrictUnknownInput_eachExitTwo', () => {
    tmp.write('docs/modules/learning-intake/broken.json', '{broken fixture input');
    tmp.write('docs/modules/learning-intake/unknown.json', JSON.stringify(lesson({ rawConversation: 'dummy fixture' })));
    for (const name of ['broken', 'unknown']) {
      const result = cli(['capture', '--input', `docs/modules/learning-intake/${name}.json`]);
      expect(result.status).toBe(2);
      expect(cliJson(result)).toMatchObject({ ok: false, code: 'invalid-input' });
    }
  });

  it('CLI_disabledSubmit_exitsThreeWithObservableAuthorityRefusal', async () => {
    const id = await seed(); const result = cli(['submit', '--id', id]);

    expect(result.status).toBe(3);
    expect(cliJson(result)).toMatchObject({ ok: false, code: 'disabled', requestId: id });
  });

  it('CLI_uncertainSubmit_exitsFourWithoutNetworkAttempt', async () => {
    const { id } = await uncertain(); const result = cli(['submit', '--id', id]);

    expect(result.status).toBe(4);
    expect(cliJson(result)).toMatchObject({ ok: false, code: 'write-uncertain' });
    expect(history(id).events.filter((event) => event.kind === 'create-intent')).toHaveLength(1);
  });

  it('CLI_lockConflict_exitsFiveWithoutStealingOwner', async () => {
    approve(); const id = await seed(); const owner = await staleOwner(id); const result = cli(['submit', '--id', id]);

    expect(result.status).toBe(5);
    expect(cliJson(result)).toMatchObject({ ok: false, code: 'lock-held' });
    expect(store.loadLock(id, options()).nonce).toBe(owner.nonce);
  });
});
