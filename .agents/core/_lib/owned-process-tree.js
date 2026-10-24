'use strict';

// Owned-process-tree runner for gate stages and native CLI wrappers.
// The trusted bootstrap and every configured descendant run in the Windows
// supervisor's non-breakaway, kill-on-close Job Object before CLI code runs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

function writeRecord(file, record) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

function validStageResult(result, nonce) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.nonce !== nonce) return false;
  if (!Object.hasOwn(result, 'code') || !Object.hasOwn(result, 'signal')) return false;
  if (Object.keys(result).some(key => !['nonce', 'code', 'signal', 'spawnError'].includes(key))) return false;
  const exitCode = Number.isInteger(result.code) && result.code >= -2147483648 && result.code <= 4294967295;
  const signal = typeof result.signal === 'string' && /^SIG[A-Z0-9]+$/.test(result.signal);
  const spawnError = typeof result.spawnError === 'string' && /^E[A-Z0-9_]{1,31}$/.test(result.spawnError);
  if (Object.hasOwn(result, 'spawnError')) return spawnError && result.code === null && result.signal === null;
  return (exitCode && result.signal === null) || (result.code === null && signal);
}

/** Trusted entry point, resumed only after the supervisor assigns its job. */
function bootstrap(requestFile) {
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  let settled = false;
  const finish = (code, signal, error) => {
    if (settled) return;
    settled = true;
    const result = { nonce: request.nonce, code, signal };
    if (error && typeof error.code === 'string' && /^E[A-Z0-9_]{1,31}$/.test(error.code)) result.spawnError = error.code;
    writeRecord(path.join(path.dirname(requestFile), 'stage-result.json'), result);
    process.exit(Number.isInteger(code) ? code : 1);
  };
  try {
    // PowerShell can extend PSModulePath; compiler TEMP/TMP are private.
    // Restore the original key set and these three controlled values;
    // credentials stay inherited in memory, never serialized in the request.
    const inheritedKeys = new Map(Object.keys(process.env).map(key => [key.toUpperCase(), key]));
    const nativeEnv = {};
    for (const key of request.environmentKeys) {
      const inherited = inheritedKeys.get(key.toUpperCase());
      if (inherited !== undefined) nativeEnv[key] = process.env[inherited];
    }
    for (const entry of request.environmentRestorations) nativeEnv[entry.key] = entry.value;
    const child = spawn(request.command, request.args, {
      cwd: request.cwd, env: nativeEnv, stdio: 'inherit', shell: false, windowsHide: true,
      windowsVerbatimArguments: request.windowsVerbatimArguments === true,
    });
    child.once('error', error => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal));
  } catch (error) { finish(null, null, error); }
}

function runOwnedNativeCli(command, args, { cwd, env, input, timeoutMs = 600000, maxBytes = 64 * 1024 * 1024, ownerPid = process.pid, windowsVerbatimArguments = false, evidenceRoot = os.tmpdir() } = {}) {
  return new Promise(resolve => {
    let directory; let child; let timer; let cleanupTimer;
    let finished = false; let timedOut = false; let error = null; let cancelled = false;
    let size = 0; let errSize = 0;
    const out = []; const err = [];
    const nonce = randomUUID();
    const ownershipError = () => Object.assign(new Error(`Windows process-tree completion is unconfirmed; evidence retained at ${directory}`), { code: 'ETREEUNCONFIRMED' });
    const onOwnerExit = () => { if (child && !finished) child.kill(); };
    const finish = (status, signal, terminal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(cleanupTimer);
      process.removeListener('exit', onOwnerExit);
      let proof = null; let result = null; let stageAbsent = false;
      if (terminal) {
        try { proof = JSON.parse(fs.readFileSync(path.join(directory, 'tree-proof.json'), 'utf8')); } catch { /* fail closed below */ }
        try { result = JSON.parse(fs.readFileSync(path.join(directory, 'stage-result.json'), 'utf8')); }
        catch (failure) { stageAbsent = failure.code === 'ENOENT'; /* cancellation can stop the bootstrap before its result */ }
      }
      const confirmed = Boolean(terminal && proof && proof.nonce === nonce && proof.treeConfirmed === true);
      const stageValidated = validStageResult(result, nonce);
      // A missing result is expected only when our own cancellation stopped the
      // bootstrap. A present but invalid result is always infrastructure failure.
      const expectedCancellation = cancelled && stageAbsent;
      if (confirmed && stageValidated) {
        status = result.code;
        signal = result.signal;
        if (result.spawnError) {
          error = error || Object.assign(new Error(`spawn ${command} ${result.spawnError}`), { code: result.spawnError });
        }
      } else if (!confirmed || !expectedCancellation) {
        error = ownershipError();
      }
      // Never let the existing timeout classifier claim a stopped tree without
      // a nonce-matched kernel-accounting receipt from the terminal supervisor.
      const acceptedTimeout = timedOut && confirmed && error?.code !== 'ETREEUNCONFIRMED';
      const discardEvidence = confirmed && (stageValidated || expectedCancellation) && error?.code !== 'ETREEUNCONFIRMED';
      const response = {
        status, signal: acceptedTimeout ? null : signal,
        stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
        error: acceptedTimeout ? null : error, timedOut: acceptedTimeout, treeConfirmed: Boolean(confirmed),
        processTree: { nonce, treeConfirmed: confirmed, stageValidated, supervisorClosed: Boolean(terminal), evidenceDirectory: discardEvidence ? null : directory || null },
      };
      if (discardEvidence) {
        // Remove only this invocation's freshly created private directory.
        try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* verified evidence may remain */ }
      }
      resolve(response);
    };
    const cancel = () => {
      if (cancelled || finished) return;
      cancelled = true;
      clearTimeout(timer);
      try { writeRecord(path.join(directory, 'terminate.json'), { nonce }); }
      catch { error = ownershipError(); }
      cleanupTimer = setTimeout(() => {
        // This captured handle closes the job if control/proof publication has
        // failed. Killing it is cleanup, never a full-tree success assertion.
        child.kill();
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        finish(null, null, false);
      }, 4500);
    };
    try {
      directory = fs.mkdtempSync(path.join(evidenceRoot, 'native-cli-owned-'));
      const requestFile = path.join(directory, 'request.json');
      const nativeEnv = env || process.env;
      const controlledKeys = /^(?:PSMODULEPATH|TEMP|TMP)$/i;
      fs.writeFileSync(requestFile, JSON.stringify({
        nonce, command, args, cwd: cwd || process.cwd(), node: process.execPath, windowsVerbatimArguments,
        runner: __filename, ownerPid,
        environmentKeys: Object.keys(nativeEnv),
        environmentRestorations: Object.keys(nativeEnv).filter(key => controlledKeys.test(key)).map(key => ({ key, value: nativeEnv[key] })),
      }), { mode: 0o600, flag: 'wx' });
      const systemRoot = (env || process.env).SystemRoot || process.env.SystemRoot;
      if (!systemRoot) throw Object.assign(new Error('Windows system root is unavailable'), { code: 'ENOTSUP' });
      // Set compiler scratch before PowerShell/.NET initialize their temporary
      // path caches. The bootstrap restores the CLI's actual TEMP/TMP values.
      const supervisorEnv = Object.fromEntries(Object.entries(nativeEnv).filter(([key]) => !/^(?:TEMP|TMP)$/i.test(key)));
      supervisorEnv.TEMP = directory; supervisorEnv.TMP = directory;
      child = spawn(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'windows-process-job.ps1'), '-RequestFile', requestFile,
      ], { cwd, env: supervisorEnv, windowsHide: true, shell: false, detached: false });
      process.once('exit', onOwnerExit);
      timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
      child.stdout.on('data', data => {
        size += data.length;
        if (size > maxBytes) {
          error = error || Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ENOBUFS' });
          cancel(); return;
        }
        out.push(data);
      });
      child.stderr.on('data', data => {
        if (errSize < maxBytes) {
          const kept = data.subarray(0, maxBytes - errSize);
          err.push(kept); errSize += kept.length;
        }
      });
      child.stdin.on('error', () => { /* CLI may exit before reading input */ });
      child.once('error', failure => {
        error = error || failure;
        if (child.pid === undefined) finish(null, null, false);
        else cancel();
      });
      child.once('close', (status, signal) => finish(status, signal, true));
      child.stdin.end(input);
    } catch (failure) {
      error = failure;
      if (child && child.pid !== undefined) cancel();
      else finish(null, null, false);
    }
  });
}

/** Preserve the gate's synchronous API without blocking the async supervisor. */
function runOwnedCommandSync(command, args, options = {}) {
  const maxBytes = options.maxBytes || 64 * 1024 * 1024;
  // The caller knows this evidence root even if the bridge dies before it can
  // return the supervisor's invocation directory. Only empty roots are removed.
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-command-bridge-'));
  // JSON is control data on this private pipe; command output is nested inside
  // it, never interpreted as a control record. No request/credentials on disk.
  let bridge;
  try { bridge = spawnSync(process.execPath, [__filename, '--sync-bridge'], {
    cwd: options.cwd, env: options.env || process.env, windowsHide: true,
    encoding: 'utf8', shell: false,
    input: JSON.stringify({ command, args, options: { ...options, env: undefined, ownerPid: options.ownerPid || process.pid, evidenceRoot } }),
    maxBuffer: maxBytes * 12 + 65536,
    // The supervisor has its own stage deadline and cleanup bound. An outer
    // timeout would kill its bridge before it could preserve the tree receipt.
  }); } catch (error) { bridge = { error }; }
  if (!bridge.error && bridge.status === 0) {
    try {
      const result = JSON.parse(bridge.stdout);
      if (result && typeof result === 'object' && typeof result.treeConfirmed === 'boolean' && typeof result.stdout === 'string' && typeof result.stderr === 'string') {
        if (result.error) result.error = Object.assign(new Error(result.error.message), result.error);
        try { fs.rmdirSync(evidenceRoot); } catch { /* retained supervisor evidence */ }
        return result;
      }
    } catch { /* a broken bridge cannot establish completion */ }
  }
  return {
    status: null, signal: null, stdout: '', stderr: bridge.stderr || '', timedOut: false, treeConfirmed: false,
    error: Object.assign(new Error(`Owned command bridge did not return a valid completion receipt; evidence retained at ${evidenceRoot}`), { code: 'ETREEUNCONFIRMED', causeCode: bridge.error?.code || null }),
    processTree: { treeConfirmed: false, supervisorClosed: false, evidenceDirectory: evidenceRoot },
  };
}

async function syncBridge() {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const result = await runOwnedNativeCli(request.command, request.args, request.options);
  if (result.error) result.error = { message: result.error.message, code: result.error.code || null };
  process.stdout.write(JSON.stringify(result));
}

module.exports = { runOwnedNativeCli, runOwnedCommandSync };
if (require.main === module) {
  if (process.argv[2] === '--sync-bridge') {
    syncBridge().catch(error => { process.stderr.write(`Owned command bridge failed: ${error.code || error.name}\n`); process.exitCode = 1; });
  } else bootstrap(process.argv[2]);
}
