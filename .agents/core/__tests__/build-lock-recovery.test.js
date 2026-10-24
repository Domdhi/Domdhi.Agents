import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const helper = path.resolve('.agents/core/build-lock-recovery.js');
const roots = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const lockAt = root => path.join(root, 'docs/.output/.state/telemetry/.gate.lock');
function api() {
  expect(fs.existsSync(helper), 'supported lock recovery helper is missing').toBe(true);
  return require(helper);
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate recovery space '));
  roots.push(root);
  return root;
}
function put(root, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  fs.mkdirSync(path.dirname(lockAt(root)), { recursive: true });
  fs.writeFileSync(lockAt(root), bytes);
  return bytes;
}
function deadPid() {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  expect(result.status).toBe(0);
  return result.pid;
}
function instrumentedApi({ spawn, filesystem = fs }) {
  const module = { exports: {} };
  const localRequire = createRequire(helper);
  vm.runInNewContext(fs.readFileSync(helper, 'utf8'), {
    module, exports: module.exports, __filename: helper, __dirname: path.dirname(helper),
    require: id => id === 'fs' ? filesystem : id === 'child_process' ? { spawnSync: spawn } : localRequire(id),
    process, Buffer, console,
  });
  return module.exports;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('supported build/test lock recovery', () => {
  it('recover_compilerPreparation_doesNotCreateThroughUncheckedProjectAncestors', () => {
    const root = fixture();
    const original = put(root, { pid: deadPid(), started: new Date().toISOString(), protocol: 'domdhi-gate/lease-v2', phase: 'idle' });
    const creations = [];
    const filesystem = { ...fs,
      mkdirSync: (...args) => { creations.push(args[0]); return fs.mkdirSync(...args); },
      mkdtempSync: (...args) => { creations.push(args[0]); return fs.mkdtempSync(...args); },
    };
    const instrumented = instrumentedApi({ filesystem, spawn: () => ({ status: 0, stdout: '{"status":"held","reason":"fixture-no-mutation"}' }) });
    instrumented.recoverGateLock({ projectRoot: root, expectedSha256: sha(original), reason: 'Check pre-compiler filesystem boundary.' });
    expect(creations, 'creation must happen only after native ancestor handles are held').toEqual([]);
    expect(fs.readFileSync(lockAt(root)).equals(original)).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')('recover_nativeCompilerSetup_holdsEachParentAgainstRealRenameBeforeCreation', () => {
    const root = fixture();
    const original = put(root, { pid: deadPid(), started: new Date().toISOString(), protocol: 'domdhi-gate/lease-v2', phase: 'idle' });
    let injected = false;
    const instrumented = instrumentedApi({ spawn: (command, args, options) => {
      const changed = [...args];
      const index = changed.findIndex(arg => typeof arg === 'string' && arg.includes('$created = $bootstrap::CreateDirectoryW'));
      expect(index).toBeGreaterThanOrEqual(0);
      changed[index] = changed[index].replace('$created = $bootstrap::CreateDirectoryW', `
    $swapParent = [IO.Path]::GetDirectoryName($current)
    $blocked = $false
    try { [IO.Directory]::Move($swapParent, ($swapParent + '-swapped')) } catch { $blocked = $true }
    if (-not $blocked) { throw 'fixture-unpinned-parent' }
    $script:blockedSwaps = 1 + $script:blockedSwaps
    $created = $bootstrap::CreateDirectoryW`).replace("Add-Type -ReferencedAssemblies", `[IO.File]::WriteAllText([IO.Path]::Combine($current, 'pin-swap-proof.txt'), [string]$script:blockedSwaps)
Add-Type -ReferencedAssemblies`).replace("reason = 'native-backend-unavailable';", "reason = 'native-backend-unavailable'; fixtureError = $_.Exception.Message;")
        .replace("throw 'directory-unavailable'", "throw ('directory-unavailable:' + $directory)");
      injected = true;
      return spawnSync(command, changed, options);
    } });
    const result = instrumented.recoverGateLock({ projectRoot: root, expectedSha256: sha(original), reason: 'Exercise held parents at every native creation boundary.' });
    expect(injected).toBe(true);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'recovered' });
    expect(fs.readFileSync(path.resolve(root, result.compilerScratch, 'pin-swap-proof.txt'), 'utf8')).toBe('6');
    expect(fs.readFileSync(path.resolve(root, result.archive)).equals(original)).toBe(true);
    expect(fs.existsSync(`${root}-swapped`)).toBe(false);
  }, 30000);

  it.skipIf(process.platform !== 'win32')('recover_faultImmediatelyAfterRetirement_retainsImmutablePreparedReceiptAndTruthfulOutcome', () => {
    const root = fixture();
    const original = put(root, { pid: deadPid(), started: new Date().toISOString(), protocol: 'domdhi-gate/lease-v2', phase: 'idle' });
    let injected = false;
    const instrumented = instrumentedApi({ spawn: (command, args, options) => {
      const changed = [...args];
      const index = changed.findIndex(arg => typeof arg === 'string' && arg.includes('original.Dispose(); handle.Dispose();'));
      expect(index).toBeGreaterThanOrEqual(0);
      changed[index] = changed[index].replace('original.Dispose(); handle.Dispose();', 'original.Dispose(); handle.Dispose(); if (DateTime.UtcNow.Ticks > 0) throw new IOException("fixture-after-retirement");');
      injected = true;
      return spawnSync(command, changed, options);
    } });
    const result = instrumented.recoverGateLock({ projectRoot: root, expectedSha256: sha(original), reason: 'Injected post-retirement diagnostic failure.' });
    expect(injected).toBe(true);
    expect(fs.existsSync(lockAt(root))).toBe(false);
    expect(result).toMatchObject({ status: 'retired-uncertain', sha256: sha(original) });
    expect(fs.readFileSync(path.resolve(root, result.archive)).equals(original)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.resolve(root, result.receipt), 'utf8'))).toMatchObject({ status: 'prepared', originalSha256: sha(original) });
    const successor = put(root, { pid: process.pid, started: new Date().toISOString() });
    expect(api().recoverGateLock({ projectRoot: root, expectedSha256: sha(original), reason: 'Reconcile old operation; preserve successor.' })).toMatchObject({ status: 'changed' });
    expect(fs.readFileSync(lockAt(root)).equals(successor)).toBe(true);
  }, 30000);

  it.each(['before-retirement', 'partial-completion', 'lost-reply'])('recover_nativeFault_%s_keepsPreparedEvidenceAndReportsMutationTruthfully', mode => {
    if (process.platform !== 'win32') return;
    const root = fixture();
    const original = put(root, { pid: deadPid(), started: new Date().toISOString(), protocol: 'domdhi-gate/lease-v2', phase: 'idle' });
    const instrumented = instrumentedApi({ spawn: (command, args, options) => {
      const changed = [...args];
      const index = changed.findIndex(arg => typeof arg === 'string' && arg.includes('public static class GateLockRecoveryNative'));
      expect(index).toBeGreaterThanOrEqual(0);
      const before = changed[index];
      if (mode === 'before-retirement') changed[index] = before.replace('var disposition = new Disposition', 'if (DateTime.UtcNow.Ticks > 0) throw new IOException("fixture-before-retirement"); var disposition = new Disposition');
      if (mode === 'partial-completion') changed[index] = before.replace('using (var completed = NewEvidence(completion)) WriteFlush(completed, Encode(finished));', 'using (var completed = NewEvidence(completion)) { completed.WriteByte(123); completed.Flush(true); if (DateTime.UtcNow.Ticks > 0) throw new IOException("fixture-partial-completion"); }');
      if (mode === 'lost-reply') changed[index] = before.replace('[Console]::Out.WriteLine([GateLockRecoveryNative]::Run($requestText))', '$discarded = [GateLockRecoveryNative]::Run($requestText)\n[Console]::Out.WriteLine("{interrupted-reply")');
      expect(changed[index]).not.toBe(before);
      return spawnSync(command, changed, options);
    } });
    const result = instrumented.recoverGateLock({ projectRoot: root, expectedSha256: sha(original), reason: `Exercise native ${mode} failure.` });
    expect(result).toMatchObject({ status: mode === 'before-retirement' ? 'refused' : mode === 'lost-reply' ? 'retirement-uncertain' : 'retired-uncertain' });
    expect(fs.existsSync(lockAt(root))).toBe(mode === 'before-retirement');
    if (mode === 'before-retirement') expect(fs.readFileSync(lockAt(root)).equals(original)).toBe(true);
    expect(fs.readFileSync(path.resolve(root, result.archive)).equals(original)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.resolve(root, result.receipt), 'utf8'))).toMatchObject({ status: 'prepared', originalSha256: sha(original) });
    if (mode === 'partial-completion') expect(fs.readFileSync(path.resolve(root, result.completion), 'utf8')).toBe('{');
    if (mode === 'lost-reply') expect(JSON.parse(fs.readFileSync(path.resolve(root, result.completion), 'utf8')).status).toBe('recovered');
  }, 30000);
  it('recover_legacyOwnerExitedButDetachedChildLives_holdsExactUnboundLease', () => {
    const root = fixture();
    const pidFile = path.join(root, 'owned-child.pid');
    const owner = spawnSync(process.execPath, ['-e', `const {spawn}=require('child_process');const fs=require('fs');const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:'ignore',windowsHide:true});fs.writeFileSync(process.argv[1],String(child.pid));child.unref();`, pidFile], { windowsHide: true, timeout: 5000 });
    expect(owner.status).toBe(0);
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    try {
      expect(() => process.kill(childPid, 0)).not.toThrow();
      const original = put(root, { pid: owner.pid, started: new Date().toISOString() });
      const result = api().recoverGateLock({ projectRoot: root, expectedSha256: sha(original), reason: 'Owner exited; inspect actual legacy tree gap.' });
      expect(result).toMatchObject({ status: 'held', reason: 'legacy-tree-unbound' });
      expect(fs.readFileSync(lockAt(root)).equals(original)).toBe(true);
    } finally { try { process.kill(childPid); } catch { /* already gone */ } }
  }, 30000);
  it('inspect_missing_isReadOnlyAndDoesNotCreateState', () => {
    const root = fixture();
    expect(api().inspectGateLock({ projectRoot: root })).toMatchObject({ status: 'missing' });
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('inspect_liveOwner_reportsHeldAndPreservesExactBytes', () => {
    const root = fixture();
    const original = put(root, { pid: process.pid, started: new Date().toISOString() });
    expect(api().inspectGateLock({ projectRoot: root })).toMatchObject({ status: 'held', reason: 'owner-live-or-unknown', sha256: sha(original) });
    expect(fs.readFileSync(lockAt(root)).equals(original)).toBe(true);
    expect(fs.readdirSync(path.dirname(lockAt(root)))).toEqual(['.gate.lock']);
  });

  it.each([
    { treeInProgress: true },
    { treeInProgress: false },
    { terminationUnconfirmed: true },
  ])('recover_unresolvedHazard_%j_neverTreatsApprovalAsTreeProof', hazard => {
    const root = fixture();
    const original = put(root, { pid: deadPid(), started: new Date().toISOString(), ...hazard });
    expect(api().recoverGateLock({ projectRoot: root, expectedSha256: sha(original), reason: 'Owner authorized autonomous stale-lock recovery.' }))
      .toMatchObject({ status: 'held', reason: 'tree-unverified' });
    expect(fs.readFileSync(lockAt(root)).equals(original)).toBe(true);
  });

  it('recover_liveChild_preservesTheLockWithoutAnApprovalQuestion', () => {
    const root = fixture();
    const original = put(root, { pid: deadPid(), childPid: process.pid, started: new Date().toISOString() });
    expect(api().recoverGateLock({ projectRoot: root, expectedSha256: sha(original), reason: 'Check abandoned lease.' }))
      .toMatchObject({ status: 'held', reason: 'child-live-or-unknown' });
    expect(fs.readFileSync(lockAt(root)).equals(original)).toBe(true);
  });

  it('recover_changedDigest_refusesTheNewLease', () => {
    const root = fixture();
    const original = put(root, { pid: deadPid(), started: new Date().toISOString() });
    expect(api().recoverGateLock({ projectRoot: root, expectedSha256: '0'.repeat(64), reason: 'Previously inspected lease.' }))
      .toMatchObject({ status: 'changed' });
    expect(fs.readFileSync(lockAt(root)).equals(original)).toBe(true);
  });

  it('recover_corruptPayload_preservesDiagnosticBytes', () => {
    const root = fixture();
    const original = put(root, Buffer.from('{interrupted write\n'));
    expect(api().recoverGateLock({ projectRoot: root, expectedSha256: sha(original), reason: 'Inspect interrupted state.' }))
      .toMatchObject({ status: 'held', reason: 'invalid-lock' });
    expect(fs.readFileSync(lockAt(root)).equals(original)).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')('recover_verifiedDeadFreshOwner_archivesExactBytesAndReceiptWithoutWaitingOrPrompting', () => {
    const root = fixture();
    // Consume a lease written by the real producer, not a synthetic dead leaf.
    const producer = spawnSync(process.execPath, ['-e', 'const gate=require(process.argv[1]);if(!gate.acquireLock())process.exit(2);', path.resolve('.agents/core/gate.js')], {
      cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, windowsHide: true,
    });
    expect(producer.status).toBe(0);
    const original = fs.readFileSync(lockAt(root));
    const result = api().recoverGateLock({ projectRoot: root, expectedSha256: sha(original), reason: 'Verified abandoned build/test lease.' });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'recovered', sha256: sha(original) });
    expect(fs.existsSync(lockAt(root))).toBe(false);
    const archive = path.resolve(root, result.archive);
    const receiptPath = path.resolve(root, result.receipt);
    expect(path.relative(root, archive).startsWith('..')).toBe(false);
    expect(path.relative(root, receiptPath).startsWith('..')).toBe(false);
    expect(fs.readFileSync(archive).equals(original)).toBe(true);
    expect(JSON.parse(fs.readFileSync(receiptPath, 'utf8'))).toMatchObject({ status: 'prepared', originalSha256: sha(original), reason: 'Verified abandoned build/test lease.' });
    expect(JSON.parse(fs.readFileSync(path.resolve(root, result.completion), 'utf8'))).toMatchObject({ status: 'recovered', originalSha256: sha(original) });
    expect(api().inspectGateLock({ projectRoot: root })).toMatchObject({ status: 'missing' });
  }, 30000);

  it('inspect_symlinkedTelemetry_refusesToFollowOutsideTheWorktree', () => {
    const root = fixture();
    const outside = fixture();
    const bytes = Buffer.from('{"pid":1}');
    fs.writeFileSync(path.join(outside, '.gate.lock'), bytes);
    const telemetry = path.dirname(lockAt(root));
    fs.mkdirSync(path.dirname(telemetry), { recursive: true });
    fs.symlinkSync(outside, telemetry, process.platform === 'win32' ? 'junction' : 'dir');
    expect(api().inspectGateLock({ projectRoot: root })).toMatchObject({ status: 'refused', reason: 'unsafe-path' });
    expect(fs.readFileSync(path.join(outside, '.gate.lock')).equals(bytes)).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')('recover_competingNativeOwners_retireOneExactObjectAndPreserveTheSuccessor', async () => {
    const root = fixture();
    const original = put(root, { pid: deadPid(), started: new Date().toISOString(), protocol: 'domdhi-gate/lease-v2', phase: 'idle' });
    const script = 'const api=require(process.argv[1]);console.log(JSON.stringify(api.recoverGateLock(JSON.parse(process.argv[2]))));';
    const invoke = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script, helper, JSON.stringify({ projectRoot: root, expectedSha256: sha(original), reason: 'Competing fixture recoverers, one held object.' })], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      child.once('error', reject);
      child.once('close', code => {
        try { expect(code, stderr).toBe(0); resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
      });
    });
    const results = await Promise.all([invoke(), invoke()]);
    expect(results.filter(result => result.status === 'recovered')).toHaveLength(1);
    expect(results.every(result => ['recovered', 'held', 'missing'].includes(result.status)), JSON.stringify(results)).toBe(true);
    const recovered = results.find(result => result.status === 'recovered');
    expect(fs.readFileSync(path.resolve(root, recovered.archive)).equals(original)).toBe(true);
    const successor = put(root, { pid: process.pid, started: new Date().toISOString() });
    expect(api().recoverGateLock({ projectRoot: root, expectedSha256: sha(original), reason: 'Old recovery cannot touch successor.' }).status).toBe('changed');
    expect(fs.readFileSync(lockAt(root)).equals(successor)).toBe(true);
  }, 45000);
});
