import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const store = require('../learning-intake-store');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');
let tmp;
const current = '.agents/intake/';
const legacy = '.agents/learning-intake/';
const options = () => ({ projectRoot: tmp.root, stateRoot: tmp.root, projectName: 'IntakeFixture' });
beforeEach(() => { tmp = createTmpDir(); });
afterEach(() => { tmp.cleanup(); });
function initializeLegacy() {
  const value = store.initializeProject(options());
  if (fs.existsSync(path.join(tmp.root, current))) fs.renameSync(path.join(tmp.root, current), path.join(tmp.root, legacy));
  return value;
}

describe('project-owned intake configuration paths', () => {
  it('initializes new projects under intake without creating the legacy folder', () => {
    const value = store.initializeProject(options());
    expect(JSON.parse(tmp.read(current + 'identity.json'))).toEqual(value.identity);
    expect(JSON.parse(tmp.read(current + 'policy.json'))).toEqual(value.policy);
    expect(fs.existsSync(path.join(tmp.root, legacy))).toBe(false);
    expect(value.policy.enabled).toBe(false);
  });

  it('continues a legacy identity without silently creating competing authority', () => {
    const value = initializeLegacy();
    const before = tmp.read(legacy + 'identity.json');
    expect(store.loadIdentity(options())).toEqual(value.identity);
    expect(store.initializeProject({ ...options(), projectName: 'OtherName' }).initialized).toBe(false);
    expect(tmp.read(legacy + 'identity.json')).toBe(before);
    expect(fs.existsSync(path.join(tmp.root, current))).toBe(false);
  });

  it('preserves exact identity and policy bytes after an explicit directory rename', () => {
    const value = initializeLegacy();
    const before = ['identity.json', 'policy.json'].map(name => tmp.read(legacy + name));
    fs.renameSync(path.join(tmp.root, legacy), path.join(tmp.root, current));
    expect(store.loadIdentity(options())).toEqual(value.identity);
    expect(store.loadPolicy(options())).toEqual(value.policy);
    expect(store.initializeProject(options()).initialized).toBe(false);
    expect(['identity.json', 'policy.json'].map(name => tmp.read(current + name))).toEqual(before);
  });

  it('keeps approved scope and request/event history intact through the directory rename', async () => {
    const value = initializeLegacy();
    const policy = { ...value.policy, enabled: true,
      destination: { provider: 'github', owner: 'FixtureOwner', repository: 'Toolkit', maintainerIds: [123] },
      operations: ['submit', 'reconcile', 'refresh'], triggers: ['end'] };
    policy.approval = { approvedBy: 'FixtureOwner', approvedAt: new Date().toISOString(),
      scopeHash: store.canonicalHash(store.policyScope(policy)) };
    store.validatePolicy(policy, { identity: value.identity });
    tmp.write(legacy + 'policy.json', JSON.stringify(policy));
    const core = require('../../learning-intake');
    const captured = await core.capture({ toolkitVersion: '1.0.0', component: 'core/intake', applicability: 'shared-toolkit',
      title: 'Retain reporting project authority', problem: 'A directory rename must preserve retained occurrences.',
      expected: 'Keep exact identity and history.', reproduction: 'Capture then rename the configuration directory.',
      verification: 'Read the same request and event chain.', references: [], exportApproved: true },
    { ...options(), runtime: 'codex' });
    expect(captured.ok).toBe(true);
    const beforeRequest = store.loadRequest(captured.requestId, options());
    const beforeEvents = store.readEvents(captured.requestId, options());
    const beforePolicy = tmp.read(legacy + 'policy.json');
    fs.renameSync(path.join(tmp.root, legacy), path.join(tmp.root, current));
    expect(store.loadPolicy(options())).toEqual(policy);
    expect(tmp.read(current + 'policy.json')).toBe(beforePolicy);
    expect(store.loadRequest(captured.requestId, options())).toEqual(beforeRequest);
    expect(store.readEvents(captured.requestId, options())).toEqual(beforeEvents);
  });

  it('refuses mixed current and legacy authority without changing either copy', () => {
    initializeLegacy();
    const bytes = tmp.read(legacy + 'identity.json');
    tmp.write(current + 'identity.json', bytes);
    expect(() => store.initializeProject(options())).toThrow('identity-mismatch');
    expect(() => store.loadPolicy(options())).toThrow('identity-mismatch');
    expect(tmp.read(legacy + 'identity.json')).toBe(bytes);
    expect(tmp.read(current + 'identity.json')).toBe(bytes);
    expect(fs.existsSync(path.join(tmp.root, current + 'policy.json'))).toBe(false);
  });

  it('does not repair a policy-only current folder by inventing a fresh identity', () => {
    const { policy } = initializeLegacy();
    fs.unlinkSync(path.join(tmp.root, legacy + 'identity.json'));
    fs.unlinkSync(path.join(tmp.root, legacy + 'policy.json'));
    tmp.write(current + 'policy.json', JSON.stringify(policy));
    expect(() => store.initializeProject(options())).toThrow('identity-mismatch');
    expect(fs.existsSync(path.join(tmp.root, current + 'identity.json'))).toBe(false);
  });

  it.each([current, legacy])('rejects a symlinked %s authority directory', (directory) => {
    const outside = createTmpDir();
    try {
      tmp.mkdir('.agents');
      fs.symlinkSync(outside.root, path.resolve(tmp.root, directory), process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => store.initializeProject(options())).toThrow('persistence-failed');
      expect(fs.readdirSync(outside.root)).toEqual([]);
    } finally { outside.cleanup(); }
  });

});
