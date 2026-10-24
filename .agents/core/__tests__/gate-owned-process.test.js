import { it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const gatePath = path.resolve('.agents/core/gate.js');
const backend = path.resolve('.agents/core/_lib/owned-process-tree.js');
const roots = [];
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned gate ')); roots.push(root); return root; }
const lockAt = root => path.join(root, 'docs/.output/.state/telemetry/.gate.lock');
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function driver(root, code) {
  const result = spawnSync(process.execPath, ['-e', `const gate=require(process.argv[1]);${code}`, gatePath], {
    cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBe(0);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

it('gateLease_abandonedBeforeAnyLaunch_hasKnownIdleProducerProtocol', () => {
  const root = fixture();
  driver(root, 'if(!gate.acquireLock())process.exit(2); console.log(JSON.stringify({acquired:true}));');
  const lock = JSON.parse(fs.readFileSync(lockAt(root), 'utf8'));
  // The producer writes the Windows owned lease there and the uncontained POSIX protocol elsewhere;
  // only the Windows lease is recoverable through the evidence-archiving helper.
  const windows = process.platform === 'win32';
  expect(lock).toMatchObject({ protocol: windows ? 'domdhi-gate/lease-v2' : 'domdhi-gate/uncontained-posix-v1', phase: 'idle' });
  expect(require(path.resolve('.agents/core/build-lock-recovery.js')).inspectGateLock({ projectRoot: root }))
    .toMatchObject(windows ? { status: 'recoverable' } : { status: 'held', reason: 'legacy-tree-unbound' });
});

it.skipIf(process.platform !== 'win32')('gateLease_launchAdmission_marksBeforeStageCodeAndClearsOnlyAfterConfirmedTree', () => {
  const root = fixture(); const observed = path.join(root, 'observed.json');
  const child = `require('fs').copyFileSync(process.argv[1],process.argv[2]);`;
  const argv = [process.execPath, '-e', child, lockAt(root), observed];
  const result = driver(root, `if(!gate.acquireLock())process.exit(2); const result=gate.runCommand({argv:${JSON.stringify(argv)}},process.cwd(),20000); console.log(JSON.stringify(result));`);
  expect(result).toMatchObject({ exitCode: 0, treeConfirmed: true });
  expect(JSON.parse(fs.readFileSync(observed, 'utf8'))).toMatchObject({ protocol: 'domdhi-gate/lease-v2', phase: 'running', treeInProgress: true });
  expect(result).toMatchObject({ exitCode: 0, treeConfirmed: true });
  const lock = JSON.parse(fs.readFileSync(lockAt(root), 'utf8'));
  expect(lock.phase).toBe('idle');
  expect(lock).not.toHaveProperty('treeInProgress');
});

it.skipIf(process.platform !== 'win32')('ownedGate_timeoutStopsDetachedDescendantBeforeReportingConfirmedCompletion', () => {
  const root = fixture(); const marker = path.join(root, 'escaped.txt'); const admitted = path.join(root, 'admitted.txt');
  expect(fs.existsSync(backend), 'shared gate/CLI owned-process backend is missing').toBe(true);
  const command = `const{spawn}=require('child_process');const child=spawn(process.execPath,['-e',"require('fs').writeFileSync(process.argv[2],'admitted');setTimeout(()=>require('fs').writeFileSync(process.argv[1],'escaped'),18000)",process.argv[1],process.argv[2]],{detached:true,stdio:'ignore',windowsHide:true});child.unref();setTimeout(()=>{},60000);`;
  const result = require(backend).runOwnedCommandSync(process.execPath, ['-e', command, marker, admitted], { cwd: root, timeoutMs: 15000, maxBytes: 65536 });
  expect(result).toMatchObject({ timedOut: true, treeConfirmed: true });
  expect(fs.readFileSync(admitted, 'utf8'), 'detached stage must actually execute before cancellation').toBe('admitted');
  // A separate waiting process keeps this test's event loop free of fake timers.
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},18500)'], { windowsHide: true });
  expect(fs.existsSync(marker)).toBe(false);
}, 45000);

it.skipIf(process.platform !== 'win32')('gateLease_existingHazard_doesNotAdmitAnotherStageOrClearItsWarning', () => {
  const root = fixture(); const marker = path.join(root, 'must-not-run.txt');
  const argv = [process.execPath, '-e', "require('fs').writeFileSync(process.argv[1],'ran')", marker];
  const result = driver(root, `if(!gate.acquireLock())process.exit(2);const fs=require('fs');const file=${JSON.stringify(lockAt(root))};const lock=JSON.parse(fs.readFileSync(file));lock.phase='unconfirmed';lock.terminationUnconfirmed=true;fs.writeFileSync(file,JSON.stringify(lock));console.log(JSON.stringify(gate.runCommand({argv:${JSON.stringify(argv)}},process.cwd(),5000)));`);
  expect(result.exitCode).toBe(1);
  expect(fs.existsSync(marker)).toBe(false);
  expect(JSON.parse(fs.readFileSync(lockAt(root), 'utf8')).terminationUnconfirmed).toBe(true);
});

it.skipIf(process.platform !== 'win32')('gateLease_nonIdleWithoutMarkers_releasePreservesUnknownPhase', () => {
  const root = fixture();
  driver(root, `if(!gate.acquireLock())process.exit(2);const fs=require('fs');const file=${JSON.stringify(lockAt(root))};const lock=JSON.parse(fs.readFileSync(file));lock.phase='unconfirmed';fs.writeFileSync(file,JSON.stringify(lock));gate.releaseLock();console.log('{}');`);
  expect(JSON.parse(fs.readFileSync(lockAt(root), 'utf8')).phase).toBe('unconfirmed');
});

it.skipIf(process.platform !== 'win32')('gateLease_automaticStaleRecovery_preservesExactArchiveBeforeNewAcquire', () => {
  const root = fixture();
  driver(root, 'if(!gate.acquireLock())process.exit(2);console.log("{}");');
  const lock = JSON.parse(fs.readFileSync(lockAt(root), 'utf8'));
  lock.started = new Date(Date.now() - 2000000).toISOString();
  const bytes = Buffer.from(JSON.stringify(lock)); fs.writeFileSync(lockAt(root), bytes);
  const result = driver(root, 'console.log(JSON.stringify({acquired:gate.acquireLock()}));');
  expect(result.acquired).toBe(true);
  const work = path.join(root, 'docs/.output/.state/work');
  expect(fs.existsSync(work), 'automatic clearing must preserve exact bytes and evidence').toBe(true);
  const archives = fs.readdirSync(work).filter(name => name.startsWith('gate-lock-recovery-'))
    .map(name => path.join(work, name, 'original.gate.lock')).filter(file => fs.existsSync(file));
  expect(archives).toHaveLength(1);
  expect(fs.readFileSync(archives[0]).equals(bytes)).toBe(true);
});

it.skipIf(process.platform !== 'win32')('gateCommand_confirmedTreeWithExecutionError_cannotReturnSuccessLookingExit', () => {
  const root = fixture(); const module = { exports: {} }; const localRequire = createRequire(gatePath);
  const runtime = Object.create(process); runtime.env = { ...process.env, CLAUDE_PROJECT_DIR: root };
  vm.runInNewContext(fs.readFileSync(gatePath, 'utf8'), {
    module, exports: module.exports, __filename: gatePath, __dirname: path.dirname(gatePath), process: runtime, console, Buffer,
    require: id => id === './_lib/owned-process-tree' ? { runOwnedCommandSync: () => ({ status: 0, stdout: '0 errors', stderr: '', timedOut: false, treeConfirmed: true, error: { code: 'ENOBUFS' } }) } : localRequire(id),
  });
  expect(module.exports.acquireLock()).toBe(true);
  const result = module.exports.runCommand({ argv: ['fixture.exe'] }, root, 5000);
  expect(result.exitCode).toBe(1);
  expect(result.error.code).toBe('ENOBUFS');
  expect(JSON.parse(fs.readFileSync(lockAt(root), 'utf8')).phase).toBe('idle');
});
