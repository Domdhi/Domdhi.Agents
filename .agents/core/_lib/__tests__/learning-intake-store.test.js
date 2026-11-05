import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');
const { compartmentDir } = require('../output-paths');
const storePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../learning-intake-store.js');
const PROJECT = '11111111-1111-4111-8111-111111111111';
const REQUEST = '22222222-2222-4222-8222-222222222222';
const ATTEMPT = '33333333-3333-4333-8333-333333333333';
const SECOND_ATTEMPT = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-10-14T14:00:00.000Z';
const COMMIT = 'a'.repeat(40);
const HASH = 'a'.repeat(64);
const IDENTITY_FILE = '.agents/intake/identity.json';
const POLICY_FILE = '.agents/intake/policy.json';
const CEILINGS = {
  MAX_RECORD_BYTES: 65536, MAX_EXPORT_BYTES: 16384, MAX_FIELD_BYTES: 4096,
  MAX_REFERENCES: 20, MAX_RESPONSE_BYTES: 262144, MAX_BATCH: 10,
  MAX_CREATE_ATTEMPTS: 3, OPERATION_TIMEOUT_MS: 30000, MAX_RECONCILIATION_MATCHES: 2,
  MAX_MAINTAINERS: 32, MAX_RESOLUTION_COMMENTS: 100,
};

// Independent canonical oracle: event/request hashes must be interoperable after restart.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function identity(overrides = {}) {
  return { schemaVersion: 1, projectId: PROJECT, projectName: 'ToolkitFixture', createdAt: NOW, ...overrides };
}
function destination(overrides = {}) {
  return { provider: 'github', owner: 'ToolkitOwner', repository: 'Toolkit', maintainerIds: [123], ...overrides };
}
function policy(overrides = {}) {
  return {
    schemaVersion: 1, projectId: PROJECT, projectName: 'ToolkitFixture', enabled: false,
    exportProfile: 'toolkit-summary-v1', operations: [], triggers: [], limits: { ...CEILINGS }, ...overrides,
  };
}
function scope(value) {
  return {
    projectId: value.projectId, projectName: value.projectName, destination: value.destination,
    exportProfile: value.exportProfile, operations: value.operations, triggers: value.triggers, limits: value.limits,
  };
}
function approvedPolicy(overrides = {}) {
  const value = policy({ enabled: true, destination: destination(), operations: ['submit', 'reconcile', 'refresh', 'recover'], triggers: ['end'], ...overrides });
  value.approval = { approvedBy: 'FixtureMaintainer', approvedAt: NOW, scopeHash: hash(scope(value)) };
  return value;
}
function request(overrides = {}) {
  return {
    schemaVersion: 1, requestId: REQUEST, projectId: PROJECT, projectName: 'ToolkitFixture', createdAt: NOW,
    toolkitVersion: '1.0.0', toolkitCommit: COMMIT, runtime: 'codex', component: 'core/output-paths',
    applicability: 'shared-toolkit', title: 'Preserve independent learning occurrences',
    problem: 'A latest-only report loses earlier selected toolkit lessons.', expected: 'Retain each selected occurrence.',
    proposed: 'Publish immutable local records.', reproduction: 'Capture two selected lessons and restart.',
    verification: 'Inspect both occurrence IDs after restart.', references: [{ path: '.agents/core/constants.js', commit: COMMIT, sha256: HASH }],
    fingerprint: HASH, exportApproved: true, ...overrides,
  };
}
function eventId(sequence, branch = 0) {
  return `55555555-5555-4555-8555-${String(sequence * 10 + branch).padStart(12, '0')}`;
}
function event(kind, data, previous = null, overrides = {}) {
  const sequence = previous ? previous.sequence + 1 : 1;
  return {
    schemaVersion: 1, eventId: eventId(sequence), requestId: REQUEST, projectId: PROJECT, at: NOW,
    sequence, previousEventHash: previous ? hash(previous) : null, kind, data, ...overrides,
  };
}
function intentData(overrides = {}) {
  return { attemptId: ATTEMPT, requestHash: hash(request()), destination: destination(), destinationHash: hash(destination()), policyHash: hash(scope(approvedPolicy())), marker: `agents-learning-${REQUEST}`, ...overrides };
}
function receipt(overrides = {}) {
  return { issueId: 101, issueNumber: 7, url: 'https://github.com/ToolkitOwner/Toolkit/issues/7', destination: destination(), destinationHash: hash(destination()), requestHash: hash(request()), marker: `agents-learning-${REQUEST}`, receivedAt: NOW, ...overrides };
}
function submittedChain() {
  const captured = event('captured', { requestHash: hash(request()) });
  const started = event('attempt-started', { attemptId: ATTEMPT, operation: 'submit', policyHash: intentData().policyHash }, captured);
  const intent = event('create-intent', intentData(), started);
  return [captured, started, intent];
}
function acceptedResolution(overrides = {}) {
  return {
    schemaVersion: 1, requestId: REQUEST, disposition: 'accepted', rationale: 'Reviewed selected toolkit lesson.', reviewedAt: NOW,
    implementation: { reference: '.agents/core/constants.js', summary: 'Implemented immutable capture.', sourceCommit: COMMIT },
    verification: { reference: 'docs/engineering/learning-intake-validation.md', summary: 'Observed matching test results.', sourceCommit: COMMIT },
    release: { version: '1.0.1', sourceCommit: COMMIT, artifactSha256: HASH, publicationReference: 'Fixture immutable release 1.0.1', inspectedBy: 'FixtureMaintainer', inspectedAt: NOW },
    ...overrides,
  };
}

let tmp;
let external;
let idCounter;
function store() { return require('../learning-intake-store'); }
function options(extra = {}) {
  return { projectRoot: tmp.root, identity: identity(), projectName: 'ToolkitFixture', clock: () => NOW,
    newId: () => `66666666-6666-4666-8666-${String(++idCounter).padStart(12, '0')}`, ...extra };
}
function setupProject(value = policy()) {
  tmp.write(IDENTITY_FILE, JSON.stringify(identity()));
  tmp.write(POLICY_FILE, JSON.stringify(value));
}
function writeRequest(value = request(), name = value.requestId) {
  return tmp.write(`${compartmentDir('evolution/learning-requests')}/261014-1400-${name}.json`, JSON.stringify(value));
}
function writeEvents(values) {
  return values.map((value, index) => tmp.write(`${compartmentDir('evolution/learning-events')}/261014-1400-${value.eventId}-${index}.json`, JSON.stringify(value)));
}
async function errorOf(action, expectedCode) {
  let error;
  try { await action(); } catch (caught) { error = caught; }
  expect(error, 'operation must fail closed').toBeDefined();
  expect(error.code).toBe(expectedCode);
  expect(error.message).toBe(expectedCode);
  return error;
}
async function append(kind, data, previousHash = null, extra = {}) {
  return store().withRequestLock(REQUEST, (lockOwner) => store().appendEvent(REQUEST, kind, data,
    options({ lockOwner, expectedLastEventHash: previousHash, ...extra })), options());
}

beforeEach(() => {
  tmp = createTmpDir({ prefix: 'learning-store-' });
  external = createTmpDir({ prefix: 'learning-store-outside-' });
  idCounter = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  tmp.cleanup();
  external.cleanup();
});

describe('learning-intake-store AC4.1 contracts and disabled initialization', () => {
  it('initialization_placesProjectAuthorityUnderAgents_withoutRootMetadata', () => {
    const initialized = store().initializeProject(options());
    expect(JSON.parse(tmp.read('.agents/intake/identity.json'))).toEqual(initialized.identity);
    expect(JSON.parse(tmp.read('.agents/intake/policy.json'))).toEqual(initialized.policy);
    expect(fs.existsSync(path.join(tmp.root, '.agents-learning-intake.identity.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmp.root, '.agents-learning-intake.json'))).toBe(false);
  });

  it('initialization_symlinkedAuthorityDirectory_refusesBeforeOutsideMutation', async () => {
    fs.mkdirSync(path.join(tmp.root, '.agents'), { recursive: true });
    fs.symlinkSync(external.root, path.join(tmp.root, '.agents/intake'), process.platform === 'win32' ? 'junction' : 'dir');
    await errorOf(() => store().initializeProject(options()), 'persistence-failed');
    expect(fs.readdirSync(external.root)).toEqual([]);
  });

  it.each(['projectRoot', 'stateRoot'])('absolute %s symlink ancestor refuses before any mutation', async field => {
    const actual = path.join(external.root, 'actual');
    fs.mkdirSync(path.join(actual, 'project'), { recursive: true });
    const alias = path.join(tmp.root, 'alias');
    fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = path.join(alias, 'project');
    if (field === 'projectRoot') await errorOf(() => store().initializeProject(options({ projectRoot: linked })), 'persistence-failed');
    else {
      setupProject();
      await errorOf(() => store().withRequestLock(REQUEST, () => { throw new Error('must not enter'); }, options({ stateRoot: linked })), 'persistence-failed');
    }
    expect(fs.readdirSync(path.join(actual, 'project'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('FIFO authority is refused without blocking on open', () => {
    const file = path.join(tmp.root, IDENTITY_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const created = spawnSync('mkfifo', [file]);
    expect(created.status).toBe(0);
    const script = `const s=require(${JSON.stringify(storePath)});try{s.loadIdentity({projectRoot:${JSON.stringify(tmp.root)}});process.exitCode=7;}catch(e){console.log(e.code);}`;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 1000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0); expect(child.stdout.trim()).toBe('invalid-input');
  });

  it('immutable publication syncs file and directory entries before acknowledgement', async () => {
    const kinds = [];
    const original = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { kinds.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); return original(fd); });
    await store().initializeProject(options());
    expect(kinds.filter(kind => kind === 'file').length).toBeGreaterThanOrEqual(2);
    expect(kinds.filter(kind => kind === 'directory').length).toBeGreaterThanOrEqual(2);
  });

  it('directory sync failure is a persistence refusal with retained bytes', async () => {
    const original = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('fixture sync failed'), {code:'EIO'});
      return original(fd);
    });
    await errorOf(() => store().initializeProject(options()), 'persistence-failed');
    expect(fs.existsSync(path.join(tmp.root, IDENTITY_FILE))).toBe(true);
  });

  it('new request month and compartment links are all flushed to the authority root', async () => {
    setupProject();
    const opened = new Map(); const flushed = [];
    const open = fs.openSync; const sync = fs.fsyncSync;
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => { const fd = open(...args); opened.set(fd, String(args[0])); return fd; });
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) flushed.push(path.resolve(opened.get(fd)));
      return sync(fd);
    });
    await store().publishRequest(request(), options());
    for (const relative of ['', 'docs', 'docs/.output', 'docs/.output/evolution', 'docs/.output/evolution/learning-requests', 'docs/.output/evolution/learning-requests/2026-10']) {
      expect(flushed).toContain(path.resolve(tmp.root, relative));
    }
  });

  it('publicExports_requiredStoreContract_isAvailable', () => {
    expect(fs.existsSync(storePath), 'Story 4.1 production store must exist').toBe(true);
    for (const name of ['validateRequest', 'validatePolicy', 'loadRequest', 'readEvents', 'appendEvent', 'withRequestLock',
      'initializeProject', 'publishRequest', 'loadIdentity', 'loadPolicy', 'listRequests', 'canonicalHash', 'reduceEvents']) {
      expect(typeof store()[name], name).toBe('function');
    }
  });

  it('initializeProject_uninitialized_createsOnlyImmutableIdentityAndDisabledPolicy', async () => {
    const result = await store().initializeProject(options({ newId: () => PROJECT }));

    expect(result.initialized).toBe(true);
    expect(result.identity).toEqual(identity());
    expect(result.policy).toEqual(policy());
    expect(JSON.parse(tmp.read(IDENTITY_FILE))).toEqual(result.identity);
    expect(JSON.parse(tmp.read(POLICY_FILE))).toEqual(result.policy);
    expect(result.policy).not.toHaveProperty('approval');
    expect(result.policy).not.toHaveProperty('destination');
  });

  it('initializeProject_repeatedAfterApproval_preservesIdentityAndPolicyBytes', async () => {
    setupProject(approvedPolicy());
    const beforeIdentity = tmp.read(IDENTITY_FILE);
    const beforePolicy = tmp.read(POLICY_FILE);

    const result = await store().initializeProject(options({ projectName: 'DifferentAlias', newId: () => REQUEST }));

    expect(result.initialized).toBe(false);
    expect(tmp.read(IDENTITY_FILE)).toBe(beforeIdentity);
    expect(tmp.read(POLICY_FILE)).toBe(beforePolicy);
  });

  it('initializeProject_policyMissing_preservesIdentityAndRecreatesDisabledPolicy', async () => {
    tmp.write(IDENTITY_FILE, JSON.stringify(identity()));
    const before = tmp.read(IDENTITY_FILE);

    await store().initializeProject(options({ newId: () => REQUEST }));

    expect(tmp.read(IDENTITY_FILE)).toBe(before);
    expect(JSON.parse(tmp.read(POLICY_FILE))).toEqual(policy());
  });

  it('initializeProject_policyWithoutIdentity_refusesToInferOwnership', async () => {
    tmp.write(POLICY_FILE, JSON.stringify(approvedPolicy()));
    const before = tmp.read(POLICY_FILE);

    await errorOf(() => store().initializeProject(options()), 'identity-mismatch');

    expect(tmp.read(POLICY_FILE)).toBe(before);
    expect(fs.existsSync(path.join(tmp.root, IDENTITY_FILE))).toBe(false);
  });

  it('initializeProject_corruptIdentity_retainsBytesAndFailsClosed', async () => {
    tmp.write(IDENTITY_FILE, '{invalid');

    await errorOf(() => store().initializeProject(options()), 'invalid-input');

    expect(tmp.read(IDENTITY_FILE)).toBe('{invalid');
    expect(fs.existsSync(path.join(tmp.root, POLICY_FILE))).toBe(false);
  });

  it.each([null, false, 0, ''])('initializeProject_explicitInvalidAlias_refusesBeforePublishingIdentity', async (projectName) => {
    await errorOf(() => store().initializeProject(options({ projectName })), 'invalid-input');
    expect(fs.existsSync(path.join(tmp.root, IDENTITY_FILE))).toBe(false);
    expect(fs.existsSync(path.join(tmp.root, POLICY_FILE))).toBe(false);
  });

  it('initializeProject_omittedAlias_retainsSafeDisabledDefault', async () => {
    const result = await store().initializeProject(options({ projectName: undefined, newId: () => PROJECT }));
    expect(result.identity.projectName).toBe('ToolkitProject');
    expect(result.policy.projectName).toBe('ToolkitProject');
    expect(result.policy.enabled).toBe(false);
    expect(result.policy).not.toHaveProperty('approval');
    expect(result.policy).not.toHaveProperty('destination');
  });

  it('initializeProject_concurrentCallers_shareOneImmutableIdentity', async () => {
    const results = await Promise.all([
      store().initializeProject(options({ newId: () => PROJECT })),
      store().initializeProject(options({ newId: () => REQUEST })),
    ]);

    expect(results.filter((result) => result.initialized)).toHaveLength(1);
    expect(results[0].identity).toEqual(results[1].identity);
    expect(JSON.parse(tmp.read(POLICY_FILE)).projectId).toBe(results[0].identity.projectId);
  });

  it('initializeProject_sharedMemoryRootDifferent_usesOnlyExplicitActiveProjectRoot', async () => {
    vi.stubEnv('AGENT_SHARED_STATE_ROOT', external.root);
    vi.stubEnv('CLAUDE_PROJECT_DIR', external.root);

    await store().initializeProject(options({ newId: () => PROJECT }));

    expect(JSON.parse(tmp.read(IDENTITY_FILE))).toEqual(identity());
    expect(fs.readdirSync(external.root)).toEqual([]);
  });
});

describe('learning-intake-store AC4.1 strict DTOs, hashes and finite bounds', () => {
  it('validateRequest_schemaValid_retainsExactSelectedEvidence', () => {
    expect(store().validateRequest(request())).toEqual(request());
    expect(store().validateRequest(request({ applicability: 'project-specific', exportApproved: false, runtime: 'claude' })))
      .toEqual(request({ applicability: 'project-specific', exportApproved: false, runtime: 'claude' }));
  });

  it.each([
    ['unknown top-level key', { rawConversation: 'private fixture text' }],
    ['UUID case', { requestId: REQUEST.toUpperCase().replace('22222222', 'ABCDEFAB') }],
    ['invalid UUID', { requestId: '../escape' }],
    ['invalid project ID', { projectId: 'not-a-uuid' }],
    ['control in alias', { projectName: 'Fixture\nOwner' }],
    ['invalid calendar date', { createdAt: '2026-02-30T14:00:00.000Z' }],
    ['non-UTC date', { createdAt: '2026-10-14T14:00:00+01:00' }],
    ['invalid commit', { toolkitCommit: 'main' }],
    ['invalid fingerprint', { fingerprint: '1234' }],
    ['unsupported runtime', { runtime: 'other' }],
    ['unsupported applicability', { applicability: 'global-memory' }],
    ['nonboolean approval', { exportApproved: 'true' }],
    ['empty title', { title: '' }],
    ['array narrative', { problem: [] }],
    ['byte limit', { problem: 'é'.repeat(2049) }],
    ['reference count', { references: Array.from({ length: 21 }, () => ({ path: '.agents/core/constants.js' })) }],
    ['nested unknown key', { references: [{ path: '.agents/core/constants.js', body: 'fixture contents' }] }],
    ['nested invalid hash', { references: [{ path: '.agents/core/constants.js', sha256: 'latest' }] }],
  ])('validateRequest_%s_refusesWithoutMutation', async (_label, changes) => {
    const value = request(changes);
    const before = JSON.stringify(value);

    await errorOf(() => store().validateRequest(value), 'invalid-input');

    expect(JSON.stringify(value)).toBe(before);
  });

  it('validateRequest_unsupportedVersion_reportsExplicitClassification', async () => {
    await errorOf(() => store().validateRequest(request({ schemaVersion: 2 })), 'unsupported-version');
  });

  it.each(['__proto__', 'constructor', 'prototype'])('validateRequest_%sAtAnyDepth_refusesPrototypeKeys', async (key) => {
    const top = JSON.parse(JSON.stringify(request()));
    Object.defineProperty(top, key, { value: { polluted: true }, enumerable: true });
    const nested = request({ references: [JSON.parse(`{"path":".agents/core/constants.js","${key}":{}}`)] });

    await errorOf(() => store().validateRequest(top), 'invalid-input');
    await errorOf(() => store().validateRequest(nested), 'invalid-input');

    expect({}.polluted).toBeUndefined();
  });

  it('validateRequest_nonPlainPrototype_refusesInheritedProperties', async () => {
    const inherited = Object.assign(Object.create({ invisibleApproval: true }), request());
    await errorOf(() => store().validateRequest(inherited), 'invalid-input');
  });

  it.each(['../private.js', '.agents/../private.js', '/etc/passwd', 'C:\\private.js', 'https://fixture.invalid/file', '.agents//../private.js', 'docs/private.md'])
  ('validateRequest_referencePath_%s_refusesEscapeOrPrivateSource', async (reference) => {
    await errorOf(() => store().validateRequest(request({ references: [{ path: reference }] })), 'invalid-input');
  });

  it('validateRequest_windowsSharedReference_normalizesSeparators', () => {
    const result = store().validateRequest(request({ references: [{ path: '.codex\\core\\gate.js' }] }));
    expect(result.references).toEqual([{ path: '.codex/core/gate.js' }]);
  });

  it('canonicalHash_reorderedObjects_matchesIndependentSha256AndPreservesArrayOrder', () => {
    const first = { z: [3, { b: 2, a: 1 }], a: 'é' };
    const second = { a: 'é', z: [3, { a: 1, b: 2 }] };

    expect(store().canonicalHash(first)).toBe(hash(first));
    expect(store().canonicalHash(second)).toBe(hash(first));
    expect(store().canonicalHash({ z: [1, 2] })).not.toBe(store().canonicalHash({ z: [2, 1] }));
  });

  it.each([undefined, NaN, Infinity, 1n, () => {}, { value: undefined }, [undefined]])
  ('canonicalHash_unsupportedJsonValue_refusesRatherThanSilentlyDropping', async (value) => {
    await errorOf(() => store().canonicalHash(value), 'invalid-input');
  });

  it('canonicalHash_excessivelyNestedInput_hasClassifiedFailureBeforeStackExhaustion', async () => {
    let value = {};
    for (let depth = 0; depth < 100; depth++) value = { child: value };
    await errorOf(() => store().canonicalHash(value), 'invalid-input');
  });

  it('canonicalHash_accessorInput_refusesWithoutExecutingGetter', async () => {
    const getter = vi.fn(() => { throw new Error('dummy private accessor detail'); });
    const value = Object.defineProperty({}, 'field', { get: getter, enumerable: true });
    await errorOf(() => store().canonicalHash(value), 'invalid-input');
    expect(getter).not.toHaveBeenCalled();
  });

  it('validateRequest_invalidUtf16_refusesRatherThanChangingImmutableEvidence', async () => {
    await errorOf(() => store().validateRequest(request({ problem: '\uD800' })), 'invalid-input');
  });

  it('validatePolicy_disabledAndApprovedScopes_retainExactValidatedShape', () => {
    expect(store().validatePolicy(policy(), { identity: identity() })).toEqual(policy());
    expect(store().validatePolicy(approvedPolicy(), { identity: identity() })).toEqual(approvedPolicy());
  });

  it.each([
    ['identity mismatch', { projectId: REQUEST }, 'identity-mismatch'],
    ['alias mismatch', { projectName: 'OtherProject' }, 'identity-mismatch'],
    ['extra field', { credentials: 'dummy-fixture' }, 'invalid-input'],
    ['unsupported version', { schemaVersion: 2 }, 'unsupported-version'],
    ['unknown profile', { exportProfile: 'full-repository' }, 'invalid-input'],
    ['unknown operation', { operations: ['publish'] }, 'invalid-input'],
    ['duplicate operation', { operations: ['submit', 'submit'] }, 'invalid-input'],
    ['startup trigger', { triggers: ['startup'] }, 'invalid-input'],
    ['duplicate trigger', { triggers: ['end', 'end'] }, 'invalid-input'],
    ['unknown limit', { limits: { ...CEILINGS, INFINITE: 1 } }, 'invalid-input'],
  ])('validatePolicy_%s_refusesBeforeAuthorityUse', async (_label, changes, code) => {
    await errorOf(() => store().validatePolicy(policy(changes), { identity: identity() }), code);
  });

  it.each(Object.keys(CEILINGS))('validatePolicy_%s_onlyPermitsFinitePositiveNarrowing', async (key) => {
    for (const value of [0, -1, NaN, Infinity, CEILINGS[key] + 1, 1.5]) {
      await errorOf(() => store().validatePolicy(policy({ limits: { ...CEILINGS, [key]: value } }), { identity: identity() }), 'invalid-input');
    }
    const narrowed = policy({ limits: { ...CEILINGS, [key]: 1 } });
    expect(store().validatePolicy(narrowed, { identity: identity() })).toEqual(narrowed);
  });

  it('validatePolicy_changedApprovedScope_rejectsDigestMismatch', async () => {
    const value = approvedPolicy();
    value.destination = destination({ repository: 'OtherProject' });
    await errorOf(() => store().validatePolicy(value, { identity: identity() }), 'scope-mismatch');
  });

  it('validatePolicy_enabledWithoutApproval_refusesAuthority', async () => {
    const value = policy({ enabled: true, destination: destination(), operations: ['submit'] });
    await errorOf(() => store().validatePolicy(value, { identity: identity() }), 'not-authorized');
  });

  it.each(['../owner', 'https://github.com/owner', 'owner/repo', '', 'a'.repeat(40)])('validatePolicy_invalidOwner_%s_refusesDestination', async (owner) => {
    await errorOf(() => store().validatePolicy(approvedPolicy({ destination: destination({ owner }) }), { identity: identity() }), 'invalid-input');
  });

  it.each(['../repo', 'owner/repo', '', '.', '..', 'repo?query', 'a'.repeat(101)])('validateDestination_invalidRepository_%s_refuses', async (repository) => {
    await errorOf(() => store().validateDestination(destination({ repository })), 'invalid-input');
  });

  it.each([[0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], ['123'], [123, 123], Array.from({length: 33}, (_, index) => index + 1)])('validateDestination_invalidMaintainers_%j_refuses', async (maintainerIds) => {
    await errorOf(() => store().validateDestination(destination({ maintainerIds })), 'invalid-input');
  });

  it('validateDestination_legacyAzureSchema_isNotSilentlyMigrated', async () => {
    await errorOf(() => store().validateDestination({ organization: 'https://dev.azure.com/example-legacy', project: 'Legacy', area: 'Legacy', workItemType: 'Task' }), 'invalid-input');
    expect(store().validateDestination(destination({ maintainerIds: [] }))).toEqual(destination({ maintainerIds: [] }));
  });

  it('validatePolicy_narrowerMaintainerCapAndChangedTrustedIds_failClosed', async () => {
    const limited = approvedPolicy({ destination: destination({ maintainerIds: [123, 456] }), limits: { ...CEILINGS, MAX_MAINTAINERS: 1 } });
    await errorOf(() => store().validatePolicy(limited), 'invalid-input');
    const changed = approvedPolicy();
    changed.destination.maintainerIds = [456];
    await errorOf(() => store().validatePolicy(changed), 'scope-mismatch');
  });

  it('validateReceipt_oldBackendMarker_isRefused', async () => {
    await errorOf(() => store().validateReceipt(receipt({ marker: `legacy-learning-${REQUEST}` })), 'invalid-input');
  });

  it('namedLimits_andRegisteredOutputCompartments_matchAcceptedCeilingsAndZones', () => {
    const { LEARNING_INTAKE_LIMITS, OUTPUT_PATHS } = require('../../constants');

    expect(LEARNING_INTAKE_LIMITS).toEqual(CEILINGS);
    expect(OUTPUT_PATHS['evolution/learning-requests']).toMatchObject({ zone: 'durable', shape: 'discrete', bucket: 'month' });
    expect(OUTPUT_PATHS['evolution/learning-events']).toMatchObject({ zone: 'durable', shape: 'discrete', bucket: 'month' });
    expect(OUTPUT_PATHS['state/learning-intake']).toMatchObject({ zone: 'state', bucket: 'none' });
  });
});

describe('learning-intake-store AC4.1 immutable request and event publication', () => {
  beforeEach(() => setupProject());

  it('publishRequest_andInitialEvent_areReadBackWithIndependentHashes', async () => {
    const published = await store().publishRequest(request(), options());
    const captured = await append('captured', { requestHash: published.requestHash });

    expect(published.request).toEqual(request());
    expect(published.requestHash).toBe(hash(request()));
    expect(store().loadRequest(REQUEST, options())).toEqual(published);
    expect(JSON.parse(fs.readFileSync(path.resolve(tmp.root, published.path), 'utf8'))).toEqual(request());
    expect(JSON.parse(fs.readFileSync(path.resolve(tmp.root, captured.path), 'utf8'))).toEqual(captured.event);
    expect(captured.eventHash).toBe(hash(captured.event));
    expect(store().readEvents(REQUEST, options())).toEqual({ events: [captured.event], status: 'pending', lastEventHash: captured.eventHash });
    expect(store().listRequests(options()).map((row) => row.request.requestId)).toEqual([REQUEST]);
  });

  it('publishRequest_existingOccurrence_refusesReplacementAndPreservesBytes', async () => {
    const published = await store().publishRequest(request(), options());
    const original = fs.readFileSync(path.resolve(tmp.root, published.path));

    await errorOf(() => store().publishRequest(request({ title: 'Attempted replacement' }), options()), 'corrupt-history');

    expect(fs.readFileSync(path.resolve(tmp.root, published.path))).toEqual(original);
    expect(store().loadRequest(REQUEST, options()).request.title).toBe(request().title);
  });

  it('publishRequest_concurrentSameId_onlyOneImmutableOccurrenceWins', async () => {
    const results = await Promise.allSettled([
      store().publishRequest(request(), options()), store().publishRequest(request({ title: 'Second caller' }), options()),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(store().listRequests(options())).toHaveLength(1);
    expect(store().loadRequest(REQUEST, options()).request).toEqual(results.find((result) => result.status === 'fulfilled').value.request);
  });

  it('publishRequest_flushFailure_surfacesFailureAndPublishesNoAuthority', async () => {
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('dummy private fixture I/O detail'); });

    await errorOf(() => store().publishRequest(request(), options()), 'persistence-failed');

    expect(store().listRequests(options())).toEqual([]);
  });

  it('publishRequest_atomicLinkFailure_surfacesFailureAndPublishesNoAuthority', async () => {
    vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => { throw new Error('dummy private fixture publication detail'); });

    await errorOf(() => store().publishRequest(request(), options()), 'persistence-failed');

    expect(store().listRequests(options())).toEqual([]);
  });

  it('readEvents_requestWithoutInitialEvent_isHeldAfterInterruptedCapture', () => {
    writeRequest();
    expect(store().readEvents(REQUEST, options())).toEqual({ events: [], status: 'held', lastEventHash: null });
  });

  it('loadRequest_ignoredStateAbsent_recoversSameDurableBytes', async () => {
    const published = await store().publishRequest(request(), options());
    const captured = await append('captured', { requestHash: published.requestHash });
    const state = path.join(tmp.root, compartmentDir('state/learning-intake'));
    if (fs.existsSync(state)) fs.rmSync(state, { recursive: true });

    expect(store().loadRequest(REQUEST, options())).toEqual(published);
    expect(store().readEvents(REQUEST, options())).toEqual({ events: [captured.event], status: 'pending', lastEventHash: captured.eventHash });
  });

  it('listRequests_temporaryPartialFiles_doNotBecomeCapturedOccurrences', () => {
    writeRequest();
    tmp.write(`${compartmentDir('evolution/learning-requests')}/interrupted.json.tmp`, '{partial');

    expect(store().listRequests(options()).map((row) => row.request.requestId)).toEqual([REQUEST]);
  });

  it('loadRequest_duplicateIdAtDifferentFilenames_holdsRatherThanSelectingNewest', async () => {
    writeRequest();
    const duplicate = writeRequest(request({ title: 'Divergent copy' }), `other-${REQUEST}`);
    const before = fs.readFileSync(duplicate);

    await errorOf(() => store().loadRequest(REQUEST, options()), 'corrupt-history');

    expect(fs.readFileSync(duplicate)).toEqual(before);
  });

  it('loadRequest_malformedJson_keepsCorruptAuthorityAndBoundedDiagnostic', async () => {
    const saved = writeRequest();
    fs.writeFileSync(saved, '{dummy private fixture body');

    await errorOf(() => store().loadRequest(REQUEST, options()), 'corrupt-history');

    expect(fs.readFileSync(saved, 'utf8')).toBe('{dummy private fixture body');
  });

  it('loadRequest_oversizedBytes_refusesBeforeParsingAndPreservesContent', async () => {
    const saved = writeRequest();
    const oversized = ' '.repeat(CEILINGS.MAX_RECORD_BYTES + 1);
    fs.writeFileSync(saved, oversized);

    await errorOf(() => store().loadRequest(REQUEST, options()), 'corrupt-history');

    expect(fs.readFileSync(saved, 'utf8')).toBe(oversized);
  });

  it('publishRequest_foreignIdentity_refusesWithoutPublishing', async () => {
    await errorOf(() => store().publishRequest(request({ projectId: ATTEMPT }), options()), 'identity-mismatch');
    expect(store().listRequests(options())).toEqual([]);
  });

  it.each(['../outside', '/absolute', 'not-a-uuid'])('loadRequest_untrustedId_%s_refusesBeforeFileAccess', async (id) => {
    await errorOf(() => store().loadRequest(id, options()), 'invalid-input');
  });

  it('publishRequest_outputAncestorJunction_refusesWithoutOutsideWrites', async () => {
    fs.symlinkSync(external.root, path.join(tmp.root, 'docs'), 'junction');

    await errorOf(() => store().publishRequest(request(), options()), 'persistence-failed');

    expect(fs.readdirSync(external.root)).toEqual([]);
  });

  it('loadRequest_outputAncestorJunction_refusesOutsideAuthority', async () => {
    const rel = `${compartmentDir('evolution/learning-requests')}/261014-1400-${REQUEST}.json`;
    external.write(rel.replace(/^docs\//, ''), JSON.stringify(request()));
    fs.symlinkSync(external.root, path.join(tmp.root, 'docs'), 'junction');

    await errorOf(() => store().loadRequest(REQUEST, options()), 'persistence-failed');
  });

  it('publishRequest_referenceAncestorJunction_refusesExportableOutsideEvidence', async () => {
    fs.mkdirSync(path.join(tmp.root, '.agents'), { recursive: true });
    fs.symlinkSync(external.root, path.join(tmp.root, '.agents', 'core'), 'junction');
    external.write('constants.js', 'dummy fixture evidence');

    await errorOf(() => store().publishRequest(request(), options()), 'invalid-input');

    expect(store().listRequests(options())).toEqual([]);
  });
});

describe('learning-intake-store AC4.1 event schemas and transition integrity', () => {
  beforeEach(() => { setupProject(); writeRequest(); });

  it('readEvents_restartAfterCreateIntent_derivesUncertainWithoutLockOrReceipt', () => {
    const values = submittedChain();
    writeEvents(values);

    expect(store().readEvents(REQUEST, options())).toEqual({ events: values, status: 'uncertain', lastEventHash: hash(values.at(-1)) });
  });

  it('readEvents_exactReceiptAfterIntent_derivesAcknowledged', () => {
    const values = submittedChain();
    values.push(event('acknowledged', { receipt: receipt() }, values.at(-1)));
    writeEvents(values);

    expect(store().readEvents(REQUEST, options())).toEqual({ events: values, status: 'acknowledged', lastEventHash: hash(values.at(-1)) });
  });

  it('readEvents_sameSequenceBranches_holdsAllBytesRatherThanPickingTime', async () => {
    const first = event('captured', { requestHash: hash(request()) });
    const a = event('blocked', { code: 'not-authorized', operation: 'submit' }, first);
    const b = event('blocked', { code: 'disabled', operation: 'submit' }, first, { eventId: eventId(2, 1), at: '2026-10-14T15:00:00.000Z' });
    const saved = writeEvents([first, a, b]);
    const before = saved.map((file) => fs.readFileSync(file));

    await errorOf(() => store().readEvents(REQUEST, options()), 'corrupt-history');

    expect(saved.map((file) => fs.readFileSync(file))).toEqual(before);
  });

  it.each([
    ['unknown key', { surprise: 'untrusted' }], ['unsupported version', { schemaVersion: 2 }],
    ['foreign project', { projectId: ATTEMPT }], ['foreign request', { requestId: ATTEMPT }],
    ['invalid event ID', { eventId: 'bad' }], ['invalid date', { at: 'tomorrow' }],
    ['wrong sequence', { sequence: 3 }], ['wrong parent', { previousEventHash: HASH }],
    ['unknown kind', { kind: 'run-remote-command' }], ['captured hash mismatch', { data: { requestHash: 'b'.repeat(64) } }],
    ['captured data extra', { data: { requestHash: hash(request()), token: 'dummy fixture' } }],
  ])('readEvents_%s_isCorruptHeldAuthority', async (_label, changes) => {
    const saved = writeEvents([event('captured', { requestHash: hash(request()) }, null, changes)])[0];
    const before = fs.readFileSync(saved);

    await errorOf(() => store().readEvents(REQUEST, options()), 'corrupt-history');

    expect(fs.readFileSync(saved)).toEqual(before);
  });

  it('readEvents_missingParent_holdsRatherThanSkippingBrokenEvent', async () => {
    const values = submittedChain();
    writeEvents([values[0], values[2]]);
    await errorOf(() => store().readEvents(REQUEST, options()), 'corrupt-history');
  });

  it('readEvents_acknowledgedWithoutCreateIntent_refusesIllegalTransition', async () => {
    const captured = event('captured', { requestHash: hash(request()) });
    writeEvents([captured, event('acknowledged', { receipt: receipt() }, captured)]);
    await errorOf(() => store().readEvents(REQUEST, options()), 'corrupt-history');
  });

  it('readEvents_secondCreateWithoutReviewedRecovery_refusesDuplicateWriteAuthority', async () => {
    const values = submittedChain();
    values.push(event('attempt-started', { attemptId: SECOND_ATTEMPT, operation: 'submit', policyHash: intentData().policyHash }, values.at(-1)));
    values.push(event('create-intent', intentData({ attemptId: SECOND_ATTEMPT }), values.at(-1)));
    writeEvents(values);
    await errorOf(() => store().readEvents(REQUEST, options()), 'corrupt-history');
  });

  it.each(['auth-unavailable', 'access-denied', 'destination-unavailable', 'invalid-input', 'throttled'])
  ('readEvents_definitiveRejection%s_retainsIntentAndAllowsKnownNoncommitRetry', (code) => {
    const values = submittedChain();
    values.push(event('retryable', { attemptId: ATTEMPT, code }, values.at(-1)));
    values.push(event('attempt-started', { attemptId: SECOND_ATTEMPT, operation: 'submit', policyHash: intentData().policyHash }, values.at(-1)));
    values.push(event('create-intent', intentData({ attemptId: SECOND_ATTEMPT }), values.at(-1)));
    writeEvents(values);

    const observed = store().readEvents(REQUEST, options());
    expect(observed.status).toBe('uncertain');
    expect(observed.events.filter((item) => item.kind === 'create-intent')).toHaveLength(2);
    expect(observed.events[2]).toEqual(values[2]);
  });

  it('readEvents_ambiguousFailureCalledRetryable_neverGrantsAnotherCreate', async () => {
    const values = submittedChain();
    values.push(event('retryable', { attemptId: ATTEMPT, code: 'network-unavailable' }, values.at(-1)));
    writeEvents(values);
    expect(store().readEvents(REQUEST, options()).status).toBe('uncertain');

    const next = event('attempt-started', { attemptId: SECOND_ATTEMPT, operation: 'submit', policyHash: intentData().policyHash }, values.at(-1));
    await errorOf(() => store().reduceEvents([...values, next, event('create-intent', intentData({ attemptId: SECOND_ATTEMPT }), next)], request()), 'corrupt-history');
  });

  it.each(['refresh', 'reconcile'])('readEvents_%sBeforeRequiredRemoteState_refusesIllegalOperation', async (operation) => {
    const captured = event('captured', { requestHash: hash(request()) });
    await errorOf(() => store().reduceEvents([captured, event('attempt-started', { attemptId: ATTEMPT, operation, policyHash: intentData().policyHash }, captured)], request()), 'corrupt-history');
  });

  it.each([
    ['destination digest', { destinationHash: 'b'.repeat(64) }],
    ['marker', { marker: `agents-learning-${ATTEMPT}` }],
    ['request digest', { requestHash: 'b'.repeat(64) }],
    ['unknown data', { rawError: 'dummy private remote message' }],
  ])('readEvents_intentInvalid%s_refusesImmutableBindings', async (_label, changes) => {
    const values = submittedChain();
    values[2] = { ...values[2], data: intentData(changes) };
    writeEvents(values);
    await errorOf(() => store().readEvents(REQUEST, options()), 'corrupt-history');
  });

  it.each([
    ['nonpositive ID', { issueId: 0 }], ['nonpositive number', { issueNumber: 0 }], ['mismatched issue number', { issueNumber: 8 }], ['remote URL', { url: 'https://fixture.invalid/101' }],
    ['foreign receiver', { destination: destination({ repository: 'OtherProject' }) }],
    ['foreign request hash', { requestHash: 'b'.repeat(64) }], ['foreign marker', { marker: `agents-learning-${ATTEMPT}` }],
  ])('readEvents_receiptInvalid%s_refusesAcknowledgement', async (_label, changes) => {
    const values = submittedChain();
    values.push(event('acknowledged', { receipt: receipt(changes) }, values.at(-1)));
    writeEvents(values);
    await errorOf(() => store().readEvents(REQUEST, options()), 'corrupt-history');
  });

  it.each([
    ['blocked unsafe diagnostic', 'blocked', { code: 'dummy private server body', operation: 'submit' }],
    ['blocked unknown operation', 'blocked', { code: 'not-authorized', operation: 'publish' }],
    ['started invalid UUID', 'attempt-started', { attemptId: 'bad', operation: 'submit', policyHash: HASH }],
    ['retryable invalid date', 'retryable', { attemptId: ATTEMPT, code: 'throttled', nextAttemptAt: 'later' }],
    ['uncertain foreign attempt', 'uncertain', { attemptId: SECOND_ATTEMPT, code: 'write-uncertain' }],
    ['refresh raw error', 'refresh-failed', { code: 'dummy private remote body' }],
  ])('readEvents_%s_refusesEventSpecificMalformedData', async (_label, kind, data) => {
    const values = submittedChain();
    values.push(event(kind, data, values.at(-1)));
    writeEvents(values);
    await errorOf(() => store().readEvents(REQUEST, options()), 'corrupt-history');
  });

  it.each(['later', '2026-10-14T14:00:30.000Z'])('readEvents_refreshThrottleDate_%s_isValidatedInAcknowledgedHistory', value => {
    const values = submittedChain();
    values.push(event('acknowledged', { receipt: receipt() }, values.at(-1)));
    values.push(event('refresh-failed', { code: 'throttled', nextAttemptAt: value }, values.at(-1)));
    writeEvents(values);
    if (value === 'later') expect(() => store().readEvents(REQUEST, options())).toThrow();
    else expect(store().readEvents(REQUEST, options()).events.at(-1).data.nextAttemptAt).toBe(value);
  });

  it('readEvents_acceptedRelease_hasCompleteLinkedEvidence', () => {
    const values = submittedChain();
    values.push(event('acknowledged', { receipt: receipt() }, values.at(-1)));
    values.push(event('resolution-observed', { resolution: acceptedResolution(), remoteState: 'Closed' }, values.at(-1)));
    writeEvents(values);

    expect(store().readEvents(REQUEST, options()).events.at(-1).data.resolution).toEqual(acceptedResolution());
  });

  it.each([null, false, 0, ''])('validateEvent_falsyRequiredRemoteData_refusesIncompleteDto', async (value) => {
    await errorOf(() => store().validateEvent(event('acknowledged', { receipt: value })), 'invalid-input');
    await errorOf(() => store().validateEvent(event('resolution-observed', { resolution: value, remoteState: 'Closed' })), 'invalid-input');
  });

  it.each([null, false, 0, ''])('readEvents_falsyResolution_isCorruptHeldAuthority', async (value) => {
    const values = submittedChain();
    values.push(event('acknowledged', { receipt: receipt() }, values.at(-1)));
    values.push(event('resolution-observed', { resolution: value, remoteState: 'Closed' }, values.at(-1)));
    writeEvents(values);
    await errorOf(() => store().readEvents(REQUEST, options()), 'corrupt-history');
  });

  it.each([null, false, 0, ''])('appendEvent_falsyResolution_keepsPreviousValidHeadWithoutPublication', async (value) => {
    const values = submittedChain();
    values.push(event('acknowledged', { receipt: receipt() }, values.at(-1)));
    writeEvents(values);
    const control = await append('resolution-observed', { resolution: acceptedResolution(), remoteState: 'Closed' }, hash(values.at(-1)));
    await errorOf(() => append('resolution-observed', { resolution: value, remoteState: 'Closed' }, control.eventHash), 'corrupt-history');
    const observed = store().readEvents(REQUEST, options());
    expect(observed.lastEventHash).toBe(control.eventHash);
    expect(observed.events).toHaveLength(5);
    expect(observed.events.at(-1).data.resolution).toEqual(acceptedResolution());
  });

  it.each(['resolution-observed', 'refresh-failed'])('readEvents_%sClosesRefreshAttempt_nextAuthorizedRefreshRemainsValid', (kind) => {
    const values = submittedChain();
    values.push(event('acknowledged', { receipt: receipt() }, values.at(-1)));
    values.push(event('attempt-started', { attemptId: SECOND_ATTEMPT, operation: 'refresh', policyHash: intentData().policyHash }, values.at(-1)));
    const data = kind === 'resolution-observed' ? { resolution: acceptedResolution(), remoteState: 'Closed' } : { code: 'network-unavailable' };
    values.push(event(kind, data, values.at(-1)));
    values.push(event('attempt-started', { attemptId: PROJECT, operation: 'refresh', policyHash: intentData().policyHash }, values.at(-1)));
    values.push(event(kind, data, values.at(-1)));
    writeEvents(values);
    const observed = store().readEvents(REQUEST, options());
    expect(observed.status).toBe('acknowledged');
    expect(observed.events.filter((item) => item.kind === 'attempt-started')).toHaveLength(3);
  });

  it('readEvents_refreshObservedWithoutResolution_closesMatchingAttemptAndRetainsPriorEvidence', () => {
    const values = submittedChain();
    values.push(event('acknowledged', { receipt: receipt() }, values.at(-1)));
    values.push(event('resolution-observed', { resolution: acceptedResolution(), remoteState: 'Closed' }, values.at(-1)));
    for (const attemptId of [SECOND_ATTEMPT, PROJECT]) {
      values.push(event('attempt-started', { attemptId, operation: 'refresh', policyHash: intentData().policyHash }, values.at(-1)));
      values.push(event('refresh-observed', { attemptId, remoteState: 'Active' }, values.at(-1)));
    }
    writeEvents(values);
    const observed = store().readEvents(REQUEST, options());
    expect(observed.status).toBe('acknowledged');
    expect(observed.events.filter((item) => item.kind === 'refresh-observed')).toHaveLength(2);
    expect(observed.events.filter((item) => item.kind === 'resolution-observed')[0].data.resolution).toEqual(acceptedResolution());
    expect(observed.events.at(-1).data).not.toHaveProperty('resolution');
  });

  it.each(['missing attempt', 'different attempt', 'submit attempt', 'without receipt'])('reduceEvents_refreshObserved_%sIsCorrupt', async (scenario) => {
    const values = submittedChain();
    if (scenario !== 'without receipt') values.push(event('acknowledged', { receipt: receipt() }, values.at(-1)));
    if (scenario !== 'missing attempt') values.push(event('attempt-started', { attemptId: SECOND_ATTEMPT,
      operation: scenario === 'submit attempt' || scenario === 'without receipt' ? 'submit' : 'refresh', policyHash: intentData().policyHash }, values.at(-1)));
    values.push(event('refresh-observed', { attemptId: scenario === 'different attempt' ? PROJECT : SECOND_ATTEMPT, remoteState: 'Active' }, values.at(-1)));
    await errorOf(() => store().reduceEvents(values, request()), 'corrupt-history');
  });

  it.each([{}, { attemptId: SECOND_ATTEMPT }, { attemptId: SECOND_ATTEMPT, remoteState: null },
    { attemptId: SECOND_ATTEMPT, remoteState: '' }, { attemptId: SECOND_ATTEMPT, remoteState: 'Active', resolution: null },
    { attemptId: 'invalid', remoteState: 'Active' }])('validateEvent_refreshObservedStrictData_%jRefuses', async (data) => {
    await errorOf(() => store().validateEvent(event('refresh-observed', data)), 'invalid-input');
  });

  it.each([
    ['missing implementation', { implementation: undefined }], ['missing verification', { verification: undefined }],
    ['duplicate disposition', { disposition: 'duplicate', duplicateOf: 102 }],
    ['mismatched evidence commit', { verification: { reference: 'fixture verification', summary: 'Observed checks.', sourceCommit: 'b'.repeat(40) } }],
    ['missing publication', { release: { ...acceptedResolution().release, publicationReference: '' } }],
    ['foreign request', { requestId: ATTEMPT }],
  ])('readEvents_releaseInvalid%s_holdsRatherThanClaimingPublication', async (_label, changes) => {
    const values = submittedChain();
    values.push(event('acknowledged', { receipt: receipt() }, values.at(-1)));
    values.push(event('resolution-observed', { resolution: acceptedResolution(changes), remoteState: 'Closed' }, values.at(-1)));
    writeEvents(values);
    await errorOf(() => store().readEvents(REQUEST, options()), 'corrupt-history');
  });

  it('readEvents_reviewedRetry_requiresCompleteHistoricalBindingsAndOneUse', async () => {
    const values = submittedChain();
    const priorIntent = values.at(-1);
    const recovery = event('recovery-approved', {
      intentEventId: priorIntent.eventId, actor: 'FixtureMaintainer', decision: 'retry-create', reason: 'Reviewed ambiguous fixture create.',
      acceptDuplicateRisk: true, requestHash: hash(request()), destination: destination(), destinationHash: hash(destination()),
      policyHash: intentData().policyHash, exportProfile: 'toolkit-summary-v1',
    }, priorIntent);
    values.push(recovery);
    values.push(event('attempt-started', { attemptId: SECOND_ATTEMPT, operation: 'submit', policyHash: intentData().policyHash }, values.at(-1)));
    values.push(event('create-intent', intentData({ attemptId: SECOND_ATTEMPT, recoveryEventId: recovery.eventId }), values.at(-1)));
    writeEvents(values);
    expect(store().readEvents(REQUEST, options()).status).toBe('uncertain');

    values.push(event('attempt-started', { attemptId: PROJECT, operation: 'submit', policyHash: intentData().policyHash }, values.at(-1)));
    values.push(event('create-intent', intentData({ attemptId: PROJECT, recoveryEventId: recovery.eventId }), values.at(-1)));
    // Replace only this test's fixture history with a new independent fixture root.
    const secondRoot = external.root;
    external.write(IDENTITY_FILE, JSON.stringify(identity()));
    external.write(POLICY_FILE, JSON.stringify(policy()));
    external.write(`${compartmentDir('evolution/learning-requests')}/261014-1400-${REQUEST}.json`, JSON.stringify(request()));
    for (const value of values) external.write(`${compartmentDir('evolution/learning-events')}/261014-1400-${value.eventId}.json`, JSON.stringify(value));
    await errorOf(() => store().readEvents(REQUEST, options({ projectRoot: secondRoot })), 'corrupt-history');
  });

  it.each([
    ['missing bindings', { requestHash: undefined }], ['duplicate risk refused', { acceptDuplicateRisk: false }],
    ['wrong request', { requestHash: 'b'.repeat(64) }], ['wrong intent', { intentEventId: ATTEMPT }],
    ['wrong receiver digest', { destinationHash: 'b'.repeat(64) }], ['unknown export profile', { exportProfile: 'raw-source' }],
  ])('readEvents_reviewedRetryInvalid%s_refusesCreateGrant', async (_label, changes) => {
    const values = submittedChain();
    values.push(event('recovery-approved', {
      intentEventId: values.at(-1).eventId, actor: 'FixtureMaintainer', decision: 'retry-create', reason: 'Reviewed fixture recovery.',
      acceptDuplicateRisk: true, requestHash: hash(request()), destination: destination(), destinationHash: hash(destination()),
      policyHash: intentData().policyHash, exportProfile: 'toolkit-summary-v1', ...changes,
    }, values.at(-1)));
    writeEvents(values);
    await errorOf(() => store().readEvents(REQUEST, options()), 'corrupt-history');
  });

  it('readEvents_localLockRelease_forbidsOutboundBindings', async () => {
    const values = submittedChain();
    values.push(event('recovery-approved', {
      intentEventId: values.at(-1).eventId, actor: 'FixtureMaintainer', decision: 'release-lock', reason: 'Reviewed abandoned fixture owner.',
      acceptDuplicateRisk: false, ownerNonce: '7'.repeat(32), requestHash: hash(request()),
    }, values.at(-1)));
    writeEvents(values);
    await errorOf(() => store().readEvents(REQUEST, options()), 'corrupt-history');
  });

  it('appendEvent_wrongExpectedHead_refusesWithoutExtendingChain', async () => {
    const first = await append('captured', { requestHash: hash(request()) });

    await errorOf(() => append('blocked', { code: 'disabled', operation: 'submit' }, HASH), 'corrupt-history');

    expect(store().readEvents(REQUEST, options())).toEqual({ events: [first.event], status: 'pending', lastEventHash: first.eventHash });
  });

  it('appendEvent_withoutMatchingLockOwner_refusesMutation', async () => {
    await errorOf(() => store().appendEvent(REQUEST, 'captured', { requestHash: hash(request()) }, options({ expectedLastEventHash: null })), 'lock-held');
    expect(store().readEvents(REQUEST, options()).events).toEqual([]);
  });

  it('appendEvent_illegalTransition_retainsOnlyValidInitialEvent', async () => {
    const first = await append('captured', { requestHash: hash(request()) });

    await errorOf(() => append('acknowledged', { receipt: receipt() }, first.eventHash), 'corrupt-history');

    expect(store().readEvents(REQUEST, options()).events).toEqual([first.event]);
  });
});

describe('learning-intake-store AC4.1 exclusive owner locks', () => {
  beforeEach(() => { setupProject(); writeRequest(); });

  it('withRequestLock_overlappingSameId_onlyOneOwnerExtendsChain', async () => {
    let entered;
    let release;
    const started = new Promise((resolve) => { entered = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    let callbackCount = 0;
    const first = store().withRequestLock(REQUEST, async (lockOwner) => {
      callbackCount += 1;
      entered();
      await blocked;
      return store().appendEvent(REQUEST, 'captured', { requestHash: hash(request()) }, options({ lockOwner, expectedLastEventHash: null }));
    }, options());
    await started;

    try {
      await errorOf(() => store().withRequestLock(REQUEST, () => { callbackCount += 1; }, options()), 'lock-held');
    } finally { release(); }
    const result = await first;

    expect(callbackCount).toBe(1);
    expect(store().readEvents(REQUEST, options()).events).toEqual([result.event]);
  });

  it('withRequestLock_callbackThrows_preservesFailureAndReleasesOwnLock', async () => {
    const failure = new Error('dummy callback failure');

    await expect(store().withRequestLock(REQUEST, () => { throw failure; }, options())).rejects.toBe(failure);

    expect(await store().withRequestLock(REQUEST, () => 'next-owner', options())).toBe('next-owner');
  });

  it.each([null, false, 0, '', undefined])('exclusiveLocks_falsyThrownValue_isPropagatedAndOwnLockReleased', async (value) => {
    for (const name of ['withRequestLock', 'withRecoveryGuard']) {
      const sentinel = Symbol('callback did not reject');
      let observed = sentinel;
      try { await store()[name](REQUEST, () => { throw value; }, options()); }
      catch (failure) { observed = failure; }
      expect(observed, name).toBe(value);
      expect(await store()[name](REQUEST, () => 'next-owner', options())).toBe('next-owner');
    }
  });

  it('withRequestLock_ownerNonceReplaced_neverRemovesAnotherOwnerLock', async () => {
    let heldPath;
    const foreignNonce = 'f'.repeat(32);

    await store().withRequestLock(REQUEST, (lockOwner) => {
      heldPath = path.resolve(tmp.root, lockOwner.path);
      const original = JSON.parse(fs.readFileSync(heldPath, 'utf8'));
      expect(original.nonce).toBe(lockOwner.nonce);
      fs.writeFileSync(heldPath, JSON.stringify({ ...original, nonce: foreignNonce }));
    }, options());

    expect(JSON.parse(fs.readFileSync(heldPath, 'utf8')).nonce).toBe(foreignNonce);
    await errorOf(() => store().withRequestLock(REQUEST, () => 'must-not-run', options()), 'lock-held');
  });

  it('withRequestLock_agedLockWithoutAbandonmentProof_neverAutomaticallySteals', async () => {
    let heldPath;
    await store().withRequestLock(REQUEST, (lockOwner) => {
      heldPath = path.resolve(tmp.root, lockOwner.path);
      const old = JSON.parse(fs.readFileSync(heldPath, 'utf8'));
      fs.writeFileSync(heldPath, JSON.stringify({ ...old, nonce: 'e'.repeat(32), pid: 99999999, createdAt: '2000-01-01T00:00:00.000Z' }));
    }, options());
    const bytes = fs.readFileSync(heldPath);

    await errorOf(() => store().withRequestLock(REQUEST, () => 'must-not-run', options()), 'lock-held');

    expect(fs.readFileSync(heldPath)).toEqual(bytes);
  });

  it('withRequestLock_stateAncestorJunction_refusesWithoutOutsideWrites', async () => {
    fs.mkdirSync(path.join(tmp.root, 'docs', '.output'), { recursive: true });
    fs.symlinkSync(external.root, path.join(tmp.root, 'docs', '.output', '.state'), 'junction');

    await errorOf(() => store().withRequestLock(REQUEST, () => 'must-not-run', options()), 'persistence-failed');

    expect(fs.readdirSync(external.root)).toEqual([]);
  });

  it('withRecoveryGuard_overlappingSameId_onlyOneReviewedRecoveryOwner', async () => {
    let entered;
    let release;
    const started = new Promise((resolve) => { entered = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    let callbacks = 0;
    const first = store().withRecoveryGuard(REQUEST, async () => { callbacks++; entered(); await blocked; }, options());
    await started;
    try {
      await errorOf(() => store().withRecoveryGuard(REQUEST, () => { callbacks++; }, options()), 'lock-held');
    } finally { release(); }
    await first;
    expect(callbacks).toBe(1);
    await store().withRecoveryGuard(REQUEST, () => { callbacks++; }, options());
    expect(callbacks).toBe(2);
  });

  it('releaseReviewedLock_withoutRecoveryGuard_refusesEvenMatchingOwner', async () => {
    await store().withRequestLock(REQUEST, async (owner) => {
      await errorOf(() => store().releaseReviewedLock(REQUEST, owner.nonce, options()), 'lock-held');
      expect(store().loadLock(REQUEST, options()).nonce).toBe(owner.nonce);
    }, options());
  });

  it('releaseReviewedLock_recoveryGuardAndExactNonce_removeOnlyReviewedLock', async () => {
    let observed;
    await store().withRequestLock(REQUEST, (owner) => {
      observed = { ...owner, nonce: 'e'.repeat(32), pid: 99999999 };
      const { path: _ignored, ...record } = observed;
      fs.writeFileSync(path.resolve(tmp.root, owner.path), JSON.stringify(record));
    }, options());
    const before = fs.readFileSync(path.resolve(tmp.root, observed.path));
    await store().withRecoveryGuard(REQUEST, async (recoveryOwner) => {
      await errorOf(() => store().releaseReviewedLock(REQUEST, 'f'.repeat(32), options({ recoveryOwner })), 'lock-held');
      expect(fs.readFileSync(path.resolve(tmp.root, observed.path))).toEqual(before);
      await errorOf(() => store().releaseReviewedLock(REQUEST, observed.nonce, options({ recoveryOwner })), 'corrupt-history');
      const approved = store().appendEvent(REQUEST, 'recovery-approved', {
        intentEventId: null, actor: 'FixtureMaintainer', decision: 'release-lock', reason: 'Reviewed abandoned fixture owner.',
        acceptDuplicateRisk: false, ownerNonce: observed.nonce,
      }, options({ lockOwner: observed, expectedLastEventHash: null }));
      await errorOf(() => store().releaseReviewedLock(REQUEST, observed.nonce, options({ recoveryOwner, expectedLastEventHash: HASH })), 'corrupt-history');
      expect(store().releaseReviewedLock(REQUEST, observed.nonce, options({ recoveryOwner, expectedLastEventHash: approved.eventHash }))).toEqual({ removed: true });
    }, options());
    expect(store().loadLock(REQUEST, options())).toBeNull();
  });
});
