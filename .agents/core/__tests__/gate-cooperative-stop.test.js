// Cooperative stop and stoppable stages.
//
// Two halves:
//   * the Windows owned-process bridge, driven on any OS with a FAKE supervisor (a node script
//     standing in for powershell.exe) that implements the one protocol point stop depends on:
//     on a nonce-matched terminate.json it writes a nonce-matched tree-proof.json and exits. This
//     proves the bridge watches the stop-request file, cancels, and reports `stopped` only with
//     that proof. It does NOT prove the real Job Object supervisor (Windows only); the report says so.
//   * the POSIX stage runner (runCommandAsync) that lets a stop request end a running stage.

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const tree = require('../../../.agents/core/_lib/owned-process-tree');
const gate = require('../../../.agents/core/gate');
const posix = process.platform !== 'win32';

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(d); return d; };
// Windows environment names are case-insensitive: {...process.env, SystemRoot: x} beside an inherited SYSTEMROOT (Git
// Bash spells it that way) passes both, and the child sees the inherited one. Drop every spelling before overriding.
const envWithSystemRoot = (value) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^systemroot$/i.test(key)));
  env.SystemRoot = value;
  return env;
};

/** A stand-in for System32/WindowsPowerShell/v1.0/powershell.exe under a fake SystemRoot. */
function fakeSystemRoot({ writeProof }) {
  const systemRoot = tmp('fake-systemroot-');
  const dir = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  fs.mkdirSync(dir, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const requestFile = process.argv[process.argv.indexOf('-RequestFile') + 1];
const dir = path.dirname(requestFile);
const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
const timer = setInterval(() => {
  let terminate;
  try { terminate = JSON.parse(fs.readFileSync(path.join(dir, 'terminate.json'), 'utf8')); } catch { return; }
  if (terminate.nonce !== request.nonce) return;
  if (${writeProof}) fs.writeFileSync(path.join(dir, 'tree-proof.json'), JSON.stringify({ nonce: request.nonce, treeConfirmed: true }));
  clearInterval(timer);
  process.exit(0);
}, 40);
`;
  const file = path.join(dir, 'powershell.exe');
  fs.writeFileSync(file, script, { mode: 0o755 });
  return systemRoot;
}

/** Create the stop-request file shortly after the bridge starts, from a separate process. */
function writeStopRequestLater(stopRequestPath, delayMs) {
  spawn(process.execPath, ['-e', `setTimeout(() => require('fs').writeFileSync(process.argv[1], '{}'), ${delayMs})`, stopRequestPath], { stdio: 'ignore', detached: true }).unref();
}

describe('owned-process bridge: cooperative stop (fake supervisor)', () => {
  it.skipIf(!posix)('a stop-request file cancels the stage, and `stopped` is reported only with the nonce-matched tree proof', () => {
    const systemRoot = fakeSystemRoot({ writeProof: true });
    let observed;
    const started = process.hrtime.bigint();
    const result = tree.runOwnedCommandSync(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
      cwd: os.tmpdir(), timeoutMs: 120000, env: envWithSystemRoot(systemRoot),
      onEvidenceRoot: (root, stopRequestPath) => { observed = { root, stopRequestPath }; writeStopRequestLater(stopRequestPath, 700); },
    });
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    expect(observed.stopRequestPath).toBe(path.join(observed.root, 'stop-request.json'));
    expect(result).toMatchObject({ stopped: true, treeConfirmed: true, timedOut: false });
    expect(result.error).toBeNull();
    expect(seconds).toBeLessThan(20);
  }, 40000);

  it.skipIf(!posix)('a stop with no tree proof is never reported as stopped or confirmed', () => {
    const systemRoot = fakeSystemRoot({ writeProof: false });
    const result = tree.runOwnedCommandSync(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {
      cwd: os.tmpdir(), timeoutMs: 120000, env: envWithSystemRoot(systemRoot),
      onEvidenceRoot: (_root, stopRequestPath) => writeStopRequestLater(stopRequestPath, 700),
    });
    expect(result.stopped).toBe(false);
    expect(result.treeConfirmed).toBe(false);
    expect(result.error).toMatchObject({ code: 'ETREEUNCONFIRMED' });
  }, 40000);

  it('without a stop request the callback still learns the evidence root before the stage starts, and a throwing callback is harmless', () => {
    let seen = null;
    const result = tree.runOwnedCommandSync(process.execPath, ['-e', '0'], {
      cwd: os.tmpdir(), timeoutMs: 5000, env: envWithSystemRoot(tmp('no-powershell-')),
      onEvidenceRoot: (root, file) => { seen = { root, file, existed: fs.existsSync(root), requestPresent: fs.existsSync(file) }; throw new Error('callback failure'); },
    });
    expect(seen).toMatchObject({ existed: true, requestPresent: false });
    // No supervisor exists here, so nothing is confirmed — and nothing claims to be.
    expect(result.treeConfirmed).toBe(false);
    expect(result.stopped).toBeFalsy();
  }, 20000);
});

describe('runCommandAsync (the POSIX stage runner)', () => {
  const run = (cmd, timeoutMs = 20000) => gate.runCommandAsync(cmd, os.tmpdir(), timeoutMs);

  it('captures both streams and the exit code for a shell command and an argv command', async () => {
    // A shell stage runs in the platform shell: sh on POSIX, cmd.exe on Windows (where `;` does not separate commands).
    const shell = await run(posix ? 'echo out; echo err 1>&2; exit 3' : 'echo out& echo err 1>&2& exit 3');
    expect(shell).toMatchObject({ exitCode: 3, timedOut: false });
    expect(shell.output).toContain('out');
    expect(shell.stderr).toContain('err');
    const argv = await run({ argv: [process.execPath, '-e', 'console.log("hi"); process.exit(0)'] });
    expect(argv).toMatchObject({ exitCode: 0, output: 'hi\n' });
  });

  it('feeds the stage an empty stdin, like the synchronous runner did', async () => {
    const r = await run({ argv: [process.execPath, '-e', 'process.stdin.on("data",()=>{}).on("end",()=>console.log("eof"))'] });
    expect(r.output).toBe('eof\n');
  });

  it('runs legs in order and stops at the first failure', async () => {
    const r = await run({ legs: [{ argv: [process.execPath, '-e', 'console.log("one")'] }, { argv: [process.execPath, '-e', 'console.log("two"); process.exit(4)'] }, { argv: [process.execPath, '-e', 'console.log("three")'] }] });
    expect(r.exitCode).toBe(4);
    expect(r.output).toBe('one\ntwo\n');
  });

  it.skipIf(!posix)('a timeout is reported as the limit and ends the whole process group, not only the shell', async () => {
    const dir = tmp('stage-timeout-');
    const pidFile = path.join(dir, 'child.pid');
    // The shell starts a grandchild that records its pid and sleeps; killing only the shell would orphan it.
    const grandchild = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 120000)`;
    const r = await run(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(grandchild)} & wait`, 1500);
    expect(r.timedOut).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30000);

  it.skipIf(!posix)('a stage killed by a signal reports the signal', async () => {
    const r = await run({ argv: [process.execPath, '-e', 'process.kill(process.pid, "SIGKILL")'] });
    expect(r.signal).toBe('SIGKILL');
    expect(gate.killSignal(r)).toBe('SIGKILL');
  });

  it('a command that cannot start fails the stage instead of throwing', async () => {
    const r = await run({ argv: ['/definitely/not/a/binary'] });
    expect(r.exitCode).not.toBe(0);
    expect(r.error).toBeTruthy();
  });

  it('is the runner main() uses off Windows, and the owned bridge on Windows', async () => {
    const r = await gate.runStage({ argv: [process.execPath, '-e', 'process.exit(0)'] }, os.tmpdir(), 20000);
    if (posix) expect(r).toMatchObject({ exitCode: 0 });
    else expect(r).toHaveProperty('treeConfirmed');
  });
});
