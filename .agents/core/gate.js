#!/usr/bin/env node

/**
 * Gate — Build and optionally test, parse results, write structured output.
 *
 * Project-agnostic: reads build/test commands from .claude/gate.config.json
 * or falls back to auto-detection based on project files.
 *
 * Usage:
 *   node .claude/core/gate.js                    # Build only
 *   node .claude/core/gate.js build              # Build only (explicit)
 *   node .claude/core/gate.js test               # Build + test
 *
 * Output:
 *   docs/.output/.state/telemetry/logs/gate-{timestamp}.log    — Full output
 *   docs/.output/.state/telemetry/_latest-build.json           — Parsed build results
 *   docs/.output/.state/telemetry/_latest-test.json            — Parsed test results (if --test)
 *   docs/.output/.state/telemetry/_latest-lint.json            — Parsed lint results (if --test)
 *   docs/.output/.state/telemetry/_latest-e2e.json             — Parsed e2e results (e2e mode)
 *   docs/.output/.state/telemetry/_latest-visual.json          — Parsed visual results (if configured)
 *   docs/.output/.state/telemetry/_latest-summary.json         — Combined summary
 *
 * `test` mode also runs a `lint` leg (same condition as test) — a project with
 * no lint script configured (and no explicit config override) skips it
 * gracefully, same contract as the `e2e` leg.
 *
 * `test` mode (the full gate, not `--no-build`) also runs an opt-in `visual` leg when
 * `visual` is configured: local only (skipped when CI is set) and never on the fast
 * tiers. A runner that exits 0 having collected no snapshots fails it.
 *
 * Configuration (.claude/gate.config.json):
 *   {
 *     "build":  { "command": "npm run build", "timeout": 300000 },
 *     "test":   { "command": "npm test", "timeout": 600000 },
 *     "lint":   { "command": "npm run lint", "timeout": 300000 },
 *     "visual": { "command": "npm run check:visual", "timeout": 300000 }
 *   }
 *
 * Auto-detection order (if no config):
 *   1. package.json → npm run build / npm test
 *   2. Cargo.toml → cargo build / cargo test
 *   3. go.mod → go build ./... / go test ./...
 *   4. *.sln or *.slnx → dotnet build / dotnet test
 *   5. pyproject.toml → ruff check + format --check + mypy --strict / pytest
 *   6. Makefile → make build / make test
 *
 * Test-leg time limit: 600000 ms (10 minutes) unless the stack's detected leg or
 * `test.timeout` in .claude/gate.config.json says otherwise. The environment
 * variable GATE_TEST_TIMEOUT_MS (whole milliseconds, 1000 to 86400000) overrides
 * both for one run — raise it on a loaded machine without editing the config. The
 * run prints the effective limit and where it came from, and a leg killed by the
 * limit is reported as TIMED OUT, not as a bare failure.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getTelemetryDir } = require('./_lib/telemetry-paths');
const { writeSummary } = require('./_lib/gate-summary');

const PROJECT_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
const GATE_DIR = getTelemetryDir(PROJECT_ROOT);
const LOG_DIR = path.join(getTelemetryDir(PROJECT_ROOT), 'logs');
const LOCK_FILE = path.join(GATE_DIR, '.gate.lock');
const CONFIG_FILE = path.join(PROJECT_ROOT, '.claude', 'gate.config.json');

// A gate lock is only broken as "stale" when it is BOTH older than this AND its
// owning process is no longer alive. Set well above realistic suite runtimes:
// this repo's own `npm test` runs in tens of seconds, but a large adopter suite
// or a slow CI box can legitimately run many minutes. The old 10-minute ceiling
// was SHORTER than some real suites — a 20-minute run got its lock stolen
// mid-flight, then deleted its successor's lock on exit, letting a third gate
// run concurrently against the same tree (the exact race the lock prevents).
// 30 minutes leaves generous headroom; the liveness gate below means a
// still-running owner is never broken regardless of age, so this ceiling only
// bounds recovery from a truly-crashed gate.
const STALE_LOCK_MS = 1800000; // 30 minutes

// The test leg's limit: the stacks' detected default, an explicit `test.timeout` in
// the gate config, or this environment variable for a single run (highest wins).
// Bounded so that a value typed in seconds (600) cannot silently kill every run
// after 0.6 s, and so that a typo cannot disable the limit.
const DEFAULT_TEST_TIMEOUT_MS = 600000;
const TEST_TIMEOUT_ENV = 'GATE_TEST_TIMEOUT_MS';
const MIN_TEST_TIMEOUT_MS = 1000;
const MAX_TEST_TIMEOUT_MS = 86400000; // 24 hours

// The exact `started` timestamp THIS process wrote when it acquired the lock.
// releaseLock() compares against it so a process only ever deletes the lock it
// STILL owns — never one another gate re-created after breaking a lock this
// process thought it held. Null until acquired; reset to null on release.
let ownLockStarted = null;
let ownTreeUnconfirmed = false;
const OWNED_LEASE_PROTOCOL = 'domdhi-gate/lease-v2';
const POSIX_LOCK_PROTOCOL = 'domdhi-gate/uncontained-posix-v1';

// ── Args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const skipBuild = args.includes('--no-build');
const changedOnly = args.includes('--changed');
// e2e mode: a focused behavior/contract gate that runs the project's separate
// E2E/integration suite. The build+unit gate (`gate.js test`) runs only the
// unit subset, so a wave that changes a CONTRACT an E2E suite covers — without
// touching that suite — passes green and the regression only surfaces in manual
// testing (the R1 class of failure). `/run-todo` runs this on contract changes.
const runE2e = args.includes('--e2e') || args.includes('e2e');
// --no-build implies --test (build-skip without testing is meaningless)
const runTests = !runE2e && (skipBuild || args.includes('--test') || args.includes('test'));

// ── Lock ────────────────────────────────────────────────────────────

/**
 * Best-effort liveness probe for a lock's owning PID. Used ONLY to avoid
 * breaking the lock of a process that is genuinely still running (a slow-but-
 * valid suite). Deliberately conservative:
 *   - alive  (kill(pid,0) succeeds, or EPERM = exists but not ours) → true
 *   - dead   (ESRCH)                                                → false
 *   - unknown (non-integer pid, unsupported platform, other error) → false
 * Returning false on "unknown" means the caller falls back to the age threshold
 * alone — identical to the pre-liveness behavior, just gated behind the raised
 * ceiling. `process.kill(pid, 0)` sends no signal; it only tests existence, and
 * is supported on POSIX and Windows in Node.
 */
function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

// Recovery requires positive evidence of exit; a denied or malformed probe is
// uncertainty. Keep isProcessAlive's public compatibility contract separate.
function isProcessDefinitelyAbsent(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
}

function lockOwnerExited(lock) {
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return false;
    if (lock.protocol !== OWNED_LEASE_PROTOCOL || lock.phase !== 'idle') return false;
    if (Object.prototype.hasOwnProperty.call(lock, 'treeInProgress') || lock.terminationUnconfirmed === true) return false;
    if (!isProcessDefinitelyAbsent(lock.pid)) return false;
    return !Object.prototype.hasOwnProperty.call(lock, 'childPid') || isProcessDefinitelyAbsent(lock.childPid);
}

// The uncontained POSIX protocol has no owned process tree to verify, so its
// evidence of abandonment is the same positive proof of exit: an idle lock whose
// owner (and any recorded child) is definitely gone. The Windows lease protocol
// is recovered only through build-lock-recovery's archived evidence path.
function posixLockOwnerExited(lock) {
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return false;
    if (lock.protocol !== POSIX_LOCK_PROTOCOL || lock.phase !== 'idle') return false;
    if (Object.prototype.hasOwnProperty.call(lock, 'treeInProgress') || lock.terminationUnconfirmed === true) return false;
    if (!isProcessDefinitelyAbsent(lock.pid)) return false;
    return !Object.prototype.hasOwnProperty.call(lock, 'childPid') || isProcessDefinitelyAbsent(lock.childPid);
}

// Outside Windows there is no lease helper that can recover a lock, so the gate must
// retire an abandoned lock itself or a killed run wedges every later run. Returns the
// kind of abandonment only on positive evidence, evaluated against the bytes it is given:
//   'posix'      an idle uncontained-posix-v1 lock, past the stale ceiling, owner and child gone
//   'legacy'     a pre-protocol {pid, started} lock with the same proof of exit
//   'unreadable' an empty or unparseable lock file whose last write is past the stale ceiling
//                (a crash between create and write); a fresh one may be a gate still writing it
// Anything else (live owner, live child, fresh age, running tree, another protocol) is held.
function abandonedPosixLock(lockText) {
    if (process.platform === 'win32') return null;
    const has = (lock, key) => Object.prototype.hasOwnProperty.call(lock, key);
    let lock;
    try { lock = JSON.parse(lockText); } catch { lock = undefined; }
    if (lock === undefined || lock === null || typeof lock !== 'object' || Array.isArray(lock)) {
        let modified;
        try { modified = fs.statSync(LOCK_FILE).mtimeMs; } catch { return null; }
        return Date.now() - modified > STALE_LOCK_MS ? 'unreadable' : null;
    }
    const stale = Date.now() - Date.parse(lock.started) > STALE_LOCK_MS;
    if (lock.protocol === POSIX_LOCK_PROTOCOL) return stale && posixLockOwnerExited(lock) ? 'posix' : null;
    if (has(lock, 'protocol') || has(lock, 'phase') || has(lock, 'treeInProgress') || lock.terminationUnconfirmed === true) return null;
    if (!stale || !isProcessDefinitelyAbsent(lock.pid)) return null;
    return !has(lock, 'childPid') || isProcessDefinitelyAbsent(lock.childPid) ? 'legacy' : null;
}

// Break a lock we've already decided is abandoned (stale + positive proof of exit)
// and retry the acquire. TOCTOU guard: two gates can independently observe the
// SAME abandoned lock and both decide to break it. Without a re-check, the second
// unlink lands AFTER the first breaker already installed its own fresh, LIVE lock
// — deleting that live lock lets both gates run concurrently against the same
// tree (the exact race releaseLock's ownership guard closes on the release side,
// reintroduced here on the break side). So immediately before unlinking, re-read
// the file and confirm it is STILL the same lock we inspected (complete text).
// If a DIFFERENT lock is there now, another gate already broke the abandoned one
// and acquired — return false (the caller holds) instead of deleting it. The
// liveness and age proof is re-evaluated on the re-read bytes: the same PID/start
// can acquire a new child or tree hazard. A path unlink after a read still leaves a
// small window; the re-read narrows it, as releaseLock's ownership guard does.
function breakLockAndRetry(expectedText) {
    try {
        const current = fs.readFileSync(LOCK_FILE, 'utf-8');
        if (current !== expectedText) return false;
        const abandoned = abandonedPosixLock(current);
        if (abandoned) {
            // Ambiguous lock bytes (no protocol, or no owner data at all) are kept as evidence
            // beside the lock before it is retired; if they cannot be kept, the lock is held.
            if (abandoned !== 'posix') {
                try { fs.writeFileSync(`${LOCK_FILE}.abandoned-${Date.now()}`, current, { flag: 'wx' }); } catch { return false; }
            }
            fs.unlinkSync(LOCK_FILE);
            return acquireLock();
        }
        let now;
        try { now = JSON.parse(current); } catch { return false; }
        if (!lockOwnerExited(now)) return false;
        // Autonomous recovery has the same evidence contract as the explicit
        // helper: archive the exact held object before retiring it. Never use a
        // path unlink after this inspection; another lease may replace it.
        const recovery = require('./build-lock-recovery').recoverGateLock({
            projectRoot: PROJECT_ROOT,
            expectedSha256: require('crypto').createHash('sha256').update(current).digest('hex'),
            reason: 'Automatic recovery of an expired, verified idle gate lease.',
        });
        if (!['recovered', 'missing'].includes(recovery.status)) return false;
    } catch (err) {
        // Vanished between our re-read and unlink (or before the re-read) — another
        // gate broke it first. Not an error; just retry the acquire.
        if (err.code !== 'ENOENT') throw err;
    }
    return acquireLock();
}

function acquireLock() {
    fs.mkdirSync(GATE_DIR, { recursive: true });
    try {
        const started = new Date().toISOString();
        const fd = fs.openSync(LOCK_FILE, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        const protocol = process.platform === 'win32' ? OWNED_LEASE_PROTOCOL : POSIX_LOCK_PROTOCOL;
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, started, protocol, phase: 'idle' }));
        fs.closeSync(fd);
        ownLockStarted = started;
        ownTreeUnconfirmed = false;
        return true;
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;

        let lockText;
        try {
            lockText = fs.readFileSync(LOCK_FILE, 'utf-8');
        } catch (readErr) {
            // Lock vanished between the EEXIST and our read — another gate released
            // it; just retry the O_EXCL create.
            if (readErr.code === 'ENOENT') return acquireLock();
            return false;
        }
        const abandoned = abandonedPosixLock(lockText);
        if (abandoned) {
            console.log(`[GATE] Abandoned ${abandoned} lock detected (older than ${Math.round(STALE_LOCK_MS / 60000)}m, no live owner). Removing it${abandoned === 'posix' ? '' : ' after keeping its bytes beside it'}.`);
            return breakLockAndRetry(lockText);
        }
        let lock;
        try { lock = JSON.parse(lockText); } catch {
            // Missing ownership data is not evidence of exit. Preserve exact
            // diagnostic bytes rather than silently stealing an ambiguous lease.
            return false;
        }

        if (!lockOwnerExited(lock)) return false;
        const age = Date.now() - new Date(lock.started).getTime();
        // Break another gate's lock ONLY when it is past the stale ceiling AND its
        // owning process is no longer alive. A legitimately long suite (owner still
        // running) is never broken, no matter how old — that was the race: a run
        // past the old ceiling got its lock stolen, then deleted its successor's
        // lock on exit. The liveness gate closes it; the raised ceiling bounds
        // dead-owner recovery.
        if (age > STALE_LOCK_MS) {
            console.log(`[GATE] Stale idle lock detected (${Math.round(age / 60000)}m old, PID ${lock.pid} not running). Recovering with preserved evidence.`);
            return breakLockAndRetry(lockText);
        }
        return false;
    }
}

function releaseLock() {
    // Only delete the lock if it is STILL the one THIS process wrote. If another
    // gate broke a lock this process thought it held (or a PID got reused) and
    // installed its own, lock.pid/lock.started won't match ours — deleting it
    // would strip a live gate of its lock and let a third gate run concurrently
    // (the exact race this guard closes). Leave it for its real owner to release.
    try {
        const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
        const releasableProtocol = process.platform === 'win32' ? OWNED_LEASE_PROTOCOL : POSIX_LOCK_PROTOCOL;
        if (lock.pid === process.pid && lock.started === ownLockStarted &&
            lock.protocol === releasableProtocol && lock.phase === 'idle' &&
            !Object.prototype.hasOwnProperty.call(lock, 'treeInProgress') && lock.terminationUnconfirmed !== true && !ownTreeUnconfirmed) {
            fs.unlinkSync(LOCK_FILE);
        }
    } catch { /* no lock file, unreadable, or never acquired — nothing to release */ }
    ownLockStarted = null;
}

/** Mutate only the current process's lease; admission is persisted before spawn. */
function setOwnedLeasePhase(phase, processTree) {
    if (ownLockStarted === null) return;
    const fd = fs.openSync(LOCK_FILE, 'r+');
    try {
        const lock = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (lock.pid !== process.pid || lock.started !== ownLockStarted || lock.protocol !== OWNED_LEASE_PROTOCOL) {
            throw new Error('Gate lease ownership changed before stage admission/completion');
        }
        if (phase === 'running' && (lock.phase !== 'idle' ||
            Object.prototype.hasOwnProperty.call(lock, 'treeInProgress') || lock.terminationUnconfirmed === true)) {
            throw new Error('Gate lease has outstanding process-tree ownership; stage admission refused');
        }
        lock.phase = phase;
        if (phase === 'idle') {
            delete lock.treeInProgress;
            delete lock.terminationUnconfirmed;
            delete lock.processTree;
        } else {
            lock.treeInProgress = true;
            if (phase === 'unconfirmed') lock.terminationUnconfirmed = true;
            if (processTree) lock.processTree = processTree;
        }
        const bytes = Buffer.from(JSON.stringify(lock));
        fs.writeSync(fd, bytes, 0, bytes.length, 0);
        fs.ftruncateSync(fd, bytes.length);
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
}

// ── Config / Auto-Detection ─────────────────────────────────────────

function loadConfig() {
    // Always compute auto-detection, even when an explicit config exists. An
    // explicit gate.config.json wins per-key, but any key it OMITS falls back to
    // auto-detection rather than staying undefined. This matters most for `e2e`
    // (added by R1): a pre-R1 explicit config has no e2e key, and the old early
    // return left config.e2e === undefined → the e2e leg silently SKIPped →
    // false-PASS, the exact false-green class R1 exists to kill. The same merge
    // also hardens build/test for a partial explicit config.
    const detected = autoDetectConfig();
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const explicit = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            return { ...detected, ...explicit };
        } catch (err) {
            console.log(`[GATE] Warning: could not parse ${CONFIG_FILE}: ${err.message}`);
        }
    }
    return detected;
}

function autoDetectConfig() {
    // Auto-detect from project files
    const files = fs.readdirSync(PROJECT_ROOT);
    const solution = files.find(f => f.endsWith('.slnx')) || files.find(f => f.endsWith('.sln'));

    if (files.includes('package.json')) {
        let pkg;
        try {
            pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
        } catch (err) {
            console.log(`[GATE] Warning: could not parse package.json: ${err.message}`);
            pkg = {};
        }
        const scripts = pkg.scripts || {};
        // F4: only reach for `tsc --noEmit` when the project is actually TypeScript.
        // A plain-JS project with no build script must NOT fail the gate on an
        // inapplicable tsc — fall back to a no-op build instead.
        const isTypeScript = files.includes('tsconfig.json') ||
            !!(pkg.devDependencies && pkg.devDependencies.typescript) ||
            !!(pkg.dependencies && pkg.dependencies.typescript);
        let buildCommand;
        if (scripts.build) buildCommand = 'npm run build';
        else if (isTypeScript) buildCommand = 'npx tsc --noEmit';
        else buildCommand = 'echo "No build step (plain JS — no build script)"';
        // E2E/integration suites live behind their own script, NOT `npm test`.
        // First matching name wins; absent ⇒ a graceful no-op (missing:true) so
        // projects without an E2E suite never fail the e2e gate.
        const e2eScript = ['test:e2e', 'e2e', 'test:integration', 'integration', 'e2e:ci']
            .find(n => scripts[n]);
        // Browser-tool dependencies alone must not shadow an actual application
        // solution with successful echo no-ops. Explicit policy still wins.
        const dependencyOnlyPackage = solution && !Object.keys(scripts).length && !isTypeScript;
        if (!dependencyOnlyPackage) return {
            build: { command: buildCommand, timeout: 300000 },
            test: { command: scripts.test ? 'npm test' : 'echo "No test script"', timeout: 600000 },
            // A `lint` leg, same graceful-missing contract as e2e above — absent ⇒
            // missing:true so a project with no lint script never fails the lint gate.
            lint: scripts.lint
                ? { command: 'npm run lint', timeout: 300000 }
                : { command: 'echo "No lint script"', timeout: 60000, missing: true },
            e2e: e2eScript
                ? { command: `npm run ${e2eScript}`, timeout: 1200000 }
                : { command: 'echo "No e2e script"', timeout: 60000, missing: true },
            stack: 'node'
        };
    }

    if (files.includes('Cargo.toml')) {
        return {
            build: { command: 'cargo build', timeout: 300000 },
            test: { command: 'cargo test', timeout: 600000 },
            stack: 'rust'
        };
    }

    if (files.includes('go.mod')) {
        return {
            build: { command: 'go build ./...', timeout: 300000 },
            test: { command: 'go test ./...', timeout: 600000 },
            stack: 'go'
        };
    }

    if (solution) {
        // F31: `solution` comes from fs.readdirSync() — an untrusted filename (a
        // crafted `x"; touch /tmp/pwned #.sln` would achieve RCE the moment this
        // ran through a shell:true string). Use argv-mode (`{ argv: [...] }`) so
        // runCommand executes with shell:false and the filename is delivered as a
        // single, non-reinterpreted argv element — never concatenated into a
        // shell string.
        return {
            build: { argv: ['dotnet', 'build', solution, '--configuration', 'Release', '--verbosity', 'minimal'], timeout: 300000 },
            test: { argv: ['dotnet', 'test', solution, '--configuration', 'Release', '--verbosity', 'minimal', '--no-build'], timeout: 600000 },
            stack: 'dotnet'
        };
    }

    if (files.includes('pyproject.toml')) {
        // Prefer .venv/bin/ tools when present (project-local venv pattern).
        const venvBin = path.join(PROJECT_ROOT, '.venv', 'bin');
        const hasVenv = fs.existsSync(path.join(venvBin, 'ruff'));
        // LOW (F31-analog): PROJECT_ROOT (and therefore venvBin) was previously
        // interpolated into a shell:true command STRING (`${prefix}ruff check …`).
        // A checkout path containing a shell metachar (e.g. `/home/<name>/my repo;id/`)
        // would execute the `;id` segment. argv-mode (shell:false) delivers each
        // binary path as a single, non-reinterpreted argv element instead.
        const ruffBin = hasVenv ? path.join(venvBin, 'ruff') : 'ruff';
        const mypyBin = hasVenv ? path.join(venvBin, 'mypy') : 'mypy';
        const pytestBin = hasVenv ? path.join(venvBin, 'pytest') : 'pytest';
        // C1 (F4-analog): only run `mypy --strict` when the project actually uses
        // mypy. Hard-requiring it on a ruff+pytest project (the common case) makes
        // the gate unreachable on a healthy repo — the Python twin of running
        // `tsc --noEmit` on a plain-JS project. Detect via the venv binary or a
        // mypy mention in pyproject.toml ([tool.mypy], a dep group, etc.).
        const hasMypyBin = fs.existsSync(path.join(venvBin, 'mypy'));
        let declaresMypy = false;
        try {
            declaresMypy = /\bmypy\b/.test(fs.readFileSync(path.join(PROJECT_ROOT, 'pyproject.toml'), 'utf-8'));
        } catch { /* unreadable — treat as undeclared */ }
        // Multi-leg (`{ legs: [...] }`): the Python build chains ruff check + ruff
        // format --check (+ optional mypy) via shell `&&` when it was a single
        // string. Argv-mode can't chain in one spawnSync call, so `legs` is a
        // sequence of argv-mode sub-legs run in order, stopping at the first
        // failure — the same short-circuit ORDERING as `&&` (timeout is per-leg;
        // see runCommand's legs branch). `runCommand` and
        // `describeLeg` both understand this shape (see below).
        const buildLegs = [
            { argv: [ruffBin, 'check', 'src', 'tests'] },
            { argv: [ruffBin, 'format', '--check', 'src', 'tests'] },
        ];
        if (hasMypyBin || declaresMypy) buildLegs.push({ argv: [mypyBin, '--strict', 'src'] });
        return {
            build: { legs: buildLegs, timeout: 300000 },
            test: { argv: [pytestBin], timeout: 1200000 },
            stack: 'python'
        };
    }

    if (files.includes('Makefile')) {
        return {
            build: { command: 'make build', timeout: 300000 },
            test: { command: 'make test', timeout: 600000 },
            stack: 'make'
        };
    }

    return {
        build: { command: 'echo "No build command detected"', timeout: 60000 },
        test: { command: 'echo "No test command detected"', timeout: 60000 },
        stack: 'unknown'
    };
}

// ── Helpers ─────────────────────────────────────────────────────────

function ensureDirs() {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function runCommand(cmd, cwd, timeoutMs) {
    if (ownTreeUnconfirmed) {
        return { exitCode: 1, output: '', stderr: 'Gate process-tree ownership is unconfirmed; no further stage was launched.', timedOut: false, treeConfirmed: false, error: { code: 'ETREEUNCONFIRMED' } };
    }
    // Multi-leg (`{ legs: [...] }`, LOW-python-argv fix): a sequence of sub-legs
    // (each itself a runnable string or `{ argv }`) executed in order, stopping
    // at the first non-zero exit — the `&&` SHORT-CIRCUIT semantics a single
    // spawnSync call can't express in argv-mode. Output/stderr are concatenated
    // in run order so the existing line-based parsers see one combined stream,
    // and the reported exitCode is whichever leg stopped the chain (0 only if
    // every leg passed).
    //
    // TIMEOUT is PER-LEG, not an aggregate budget: `timeoutMs` is passed to each
    // sub-leg unchanged, so an N-leg chain can run up to N×timeoutMs wall-clock
    // where the old single `&&` shell string shared one budget. This is
    // deliberate (each leg — ruff / format / mypy — deserves the full window;
    // splitting it would spuriously time out a slow-but-valid mypy pass) and
    // benign (a slow build is a slow build, not a false gate result). Only the
    // short-circuit ORDERING matches `&&`, not the timeout accounting.
    if (cmd && typeof cmd === 'object' && Array.isArray(cmd.legs)) {
        let output = '';
        let stderr = '';
        let exitCode = 0;
        let timedOut = false;
        let lastResult;
        for (const subCmd of cmd.legs) {
            const sub = runCommand(subCmd, cwd, timeoutMs);
            lastResult = sub;
            output += sub.output;
            stderr += sub.stderr;
            exitCode = sub.exitCode;
            timedOut = sub.timedOut;
            if (exitCode !== 0 || ownTreeUnconfirmed) break;
        }
        return { ...lastResult, exitCode, output, stderr, timedOut };
    }

    // Use spawnSync (not execSync) so stderr is captured on SUCCESS too.
    // execSync returns only stdout on exit 0 — and many test runners print
    // their pass/fail summary to STDERR (jest's "Tests: N passed, N total",
    // for one). Discarding stderr on a green run made the parser see 0 tests,
    // which — with the false-green teeth (testPassed/isZeroCollected) — turns a
    // passing suite into a FAILED gate. This is the root cause of F1/F24/F31:
    // the parser was never actually reading jest's summary. spawnSync populates
    // both streams regardless of exit status.
    //
    // `cmd` is either a shell command STRING (default — used for the node/cargo/
    // go/make stacks whose commands never carry untrusted values) or an
    // argv-mode object `{ argv: [bin, ...args] }` (F31/LOW-python — used where a
    // command element, e.g. a solution filename discovered from disk or a
    // PROJECT_ROOT-derived binary path, must never be interpolated into a shell
    // string). Argv mode runs with shell:false; each element is delivered to the
    // child process verbatim, never reparsed.
    const isArgvMode = cmd && typeof cmd === 'object' && Array.isArray(cmd.argv);
    if (process.platform === 'win32') {
        let result;
        try {
            setOwnedLeasePhase('running');
            const command = isArgvMode ? cmd.argv[0] : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
            const argv = isArgvMode ? cmd.argv.slice(1) : ['/d', '/s', '/c', `"${cmd}"`];
            result = require('./_lib/owned-process-tree').runOwnedCommandSync(command, argv, {
                cwd, timeoutMs, maxBytes: 64 * 1024 * 1024, ownerPid: process.pid,
                windowsVerbatimArguments: !isArgvMode,
            });
            if (result.treeConfirmed === true && result.error?.code !== 'ETREEUNCONFIRMED') {
                setOwnedLeasePhase('idle');
            } else {
                ownTreeUnconfirmed = true;
                setOwnedLeasePhase('unconfirmed', result.processTree);
            }
        } catch (error) {
            ownTreeUnconfirmed = true;
            try { setOwnedLeasePhase('unconfirmed'); } catch { /* retain existing lease bytes */ }
            result = { status: null, stdout: '', stderr: error.message, error: { code: 'ETREEUNCONFIRMED' }, treeConfirmed: false, timedOut: false };
        }
        return {
            exitCode: ownTreeUnconfirmed || result.error || result.status === null || result.status === undefined ? 1 : result.status,
            output: result.stdout || '', stderr: result.stderr || '', timedOut: result.timedOut === true,
            treeConfirmed: result.treeConfirmed === true, error: result.error || null, processTree: result.processTree || null,
        };
    }
    const result = isArgvMode
        ? spawnSync(cmd.argv[0], cmd.argv.slice(1), {
            cwd,
            encoding: 'utf-8',
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 64 * 1024 * 1024, // 64MB — verbose suites can exceed the 1MB default
        })
        : spawnSync(cmd, {
            cwd,
            encoding: 'utf-8',
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 64 * 1024 * 1024, // 64MB — verbose suites can exceed the 1MB default
        });
    // Timeout / spawn failure: result.error set, status null.
    const exitCode = result.status === null || result.status === undefined
        ? 1
        : result.status;
    return {
        exitCode,
        output: result.stdout || '',
        stderr: result.stderr || '',
        // spawnSync kills the child at the limit and sets error.code ETIMEDOUT; callers
        // report the limit instead of presenting a killed run as an ordinary failure.
        timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    };
}

/**
 * The effective limit of the test leg and where it came from.
 *
 * @param {{timeout?: number}} testLeg - the merged config's test leg
 * @param {boolean} configured - the gate config file itself sets `test.timeout`
 * @param {Record<string, string|undefined>} [env]
 * @returns {{timeoutMs: number, source: string, warning?: string}}
 */
function resolveTestTimeout(testLeg, configured, env = process.env) {
    const raw = env[TEST_TIMEOUT_ENV];
    let warning;
    if (raw !== undefined && raw !== '') {
        const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
        if (Number.isSafeInteger(value) && value >= MIN_TEST_TIMEOUT_MS && value <= MAX_TEST_TIMEOUT_MS) {
            return { timeoutMs: value, source: `environment ${TEST_TIMEOUT_ENV}` };
        }
        warning = `${TEST_TIMEOUT_ENV}=${JSON.stringify(raw)} is not whole milliseconds between ` +
            `${MIN_TEST_TIMEOUT_MS} and ${MAX_TEST_TIMEOUT_MS}; ignoring it`;
    }
    const configuredLimit = testLeg && Number.isSafeInteger(testLeg.timeout) && testLeg.timeout > 0 ? testLeg.timeout : null;
    if (configuredLimit === null && testLeg && testLeg.timeout !== undefined && warning === undefined) {
        warning = `test.timeout ${JSON.stringify(testLeg.timeout)} is not a positive whole number of milliseconds; using the default`;
    }
    if (configuredLimit !== null) {
        return { timeoutMs: configuredLimit, source: configured ? '.claude/gate.config.json test.timeout' : 'detected stack default', warning };
    }
    return { timeoutMs: DEFAULT_TEST_TIMEOUT_MS, source: 'default', warning };
}

/** True when the gate config file itself (not auto-detection) sets a test timeout. */
function configFileSetsTestTimeout() {
    try {
        const explicit = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        return Boolean(explicit && explicit.test && Number.isSafeInteger(explicit.test.timeout));
    } catch {
        return false;
    }
}

// A lint, e2e or visual leg whose explicit config omits `timeout` would otherwise run with
// no limit at all, and a hung leg holds the gate lock. Same default as the lint leg's
// auto-detected form.
const DEFAULT_LEG_TIMEOUT_MS = 300000;

function legTimeout(leg) {
    return Number.isSafeInteger(leg && leg.timeout) && leg.timeout > 0 ? leg.timeout : DEFAULT_LEG_TIMEOUT_MS;
}

/** Duration for a TIMED OUT message: seconds below a minute, minutes above. */
function formatTimeout(ms) {
    return ms < 60000 ? `${+(ms / 1000).toFixed(1)} s` : `${+(ms / 60000).toFixed(2)} min`;
}

/** CI is set by the provider; treat the usual "off" spellings as unset. */
function runningInCi() {
    const value = (process.env.CI || '').trim().toLowerCase();
    return value !== '' && value !== '0' && value !== 'false';
}

/**
 * Human-readable display string for a build/test/lint leg config: shell-mode
 * ({ command }), argv-mode ({ argv }), or multi-leg ({ legs: [...] }, joined
 * with ' && ' to read like the shell chain it replaces). Display-only — never
 * fed back into a shell.
 */
function describeLeg(leg) {
    if (!leg) return '';
    if (Array.isArray(leg.legs)) return leg.legs.map(describeLeg).join(' && ');
    if (leg.command) return leg.command;
    if (Array.isArray(leg.argv)) return leg.argv.join(' ');
    return '';
}

/**
 * The runnable form of a leg config for runCommand(): multi-leg configs pass
 * through as { legs: [...runnable] } (each sub-leg recursively normalized),
 * argv-mode legs pass through as { argv }, shell-mode legs pass through as the
 * command string.
 */
function legRunnable(leg) {
    if (Array.isArray(leg.legs)) return { legs: leg.legs.map(legRunnable) };
    return Array.isArray(leg.argv) ? { argv: leg.argv } : leg.command;
}

// ── Generic Output Parser ───────────────────────────────────────────

/** Remove ANSI escape codes so regexes work on raw terminal output. */
function stripAnsi(str) {
    // Covers SGR (\x1b[...m) and all CSI sequences (\x1b[...letter)
    return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function parseBuildOutput(output, exitCode) {
    const errors = [];
    const warnings = [];
    const lines = output.split('\n');
    // ESLint's default "stylish" formatter (a bare `eslint .` with no `-f` flag) prints the file
    // path on its own unindented line, then one indented `line:col  error|warning  message  rule`
    // line per finding — unlike every pattern below, the filename never repeats on the finding's
    // own line. Track the most recent unindented path-looking line so indented findings attribute
    // to it.
    let pendingStylishFile = '';

    for (const rawLine of lines) {
        const line = stripAnsi(rawLine);

        const trimmed = line.trim();
        if (!/^\s/.test(line) && /^[./A-Za-z].*\.[a-zA-Z]+$/.test(trimmed) && !/^\d+:\d+/.test(trimmed)) {
            pendingStylishFile = trimmed;
        }
        const stylishMatch = line.match(/^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}([\w@][\w./-]*))?$/);
        if (stylishMatch && pendingStylishFile) {
            const bucket = stylishMatch[3] === 'error' ? errors : warnings;
            bucket.push({
                file: pendingStylishFile,
                line: parseInt(stylishMatch[1]) || 0,
                column: parseInt(stylishMatch[2]) || 0,
                code: stylishMatch[5]?.trim() || '',
                message: stylishMatch[4]?.trim() || '',
            });
            continue;
        }

        // Common error patterns across stacks
        // TypeScript: src/file.ts(10,5): error TS2345: ...
        // ESLint: /path/file.ts:10:5: error ...
        // Generic: file:line:col: error ...
        // mypy: src/file.py:42: error: Cannot assign ...  [assignment]
        // ruff:  src/file.py:10:5: F401 `os` imported but unused
        const errorPatterns = [
            /(.+?)\((\d+),(\d+)\):\s*error\s+(\w+\d+):\s*(.+)/,          // TS/C# style
            /(.+?):(\d+):(\d+):\s*error\s*(.+)/,                           // ESLint/generic style
            /(.+\.py):(\d+):\s*error:\s*(.+)/,                             // mypy style (no column)
            /(.+\.py):(\d+):(\d+):\s*([A-Z]+\d+)\s+(.+)/,                  // ruff style
            /^error(?:\[(\w+)\])?:\s*(.+)/,                                 // Rust/generic prefix
        ];

        for (const pattern of errorPatterns) {
            const match = line.match(pattern);
            if (match) {
                errors.push({
                    file: match[1]?.trim() || '',
                    line: parseInt(match[2]) || 0,
                    column: parseInt(match[3]) || 0,
                    code: match[4]?.trim() || '',
                    message: match[5]?.trim() || match[2]?.trim() || ''
                });
                break;
            }
        }

        // Warning patterns
        const warnPatterns = [
            /(.+?)\((\d+),(\d+)\):\s*warning\s+(\w+\d+):\s*(.+)/,
            /(.+?):(\d+):(\d+):\s*warning\s*(.+)/,
            /^warning(?:\[(\w+)\])?:\s*(.+)/,
        ];

        for (const pattern of warnPatterns) {
            const match = line.match(pattern);
            if (match) {
                warnings.push({
                    file: match[1]?.trim() || '',
                    line: parseInt(match[2]) || 0,
                    column: parseInt(match[3]) || 0,
                    code: match[4]?.trim() || '',
                    message: match[5]?.trim() || match[2]?.trim() || ''
                });
                break;
            }
        }
    }

    // C2: a non-zero exit with ZERO parsed errors is a SILENT failure — the
    // parser didn't recognize this tool's output. Common on Python: `ruff format
    // --check` prints "Would reformat: …" / "N files would be reformatted" (no
    // file:line:error shape), and a missing tool yields "mypy: command not
    // found". Surface a synthetic error capturing the reason so the gate never
    // reports "0 errors" on a genuine failure (and the caller sees WHY).
    if (exitCode !== 0 && errors.length === 0) {
        const clean = lines.map(stripAnsi);
        const reformat = clean.find(l => /would reformat/i.test(l) || /\d+\s+files?\s+would be reformatted/i.test(l));
        const notFound = clean.find(l => /(?:command not found|: not found|No such file)/i.test(l));
        const lastMeaningful = [...clean].reverse().find(l => l.trim());
        const reason = (reformat || notFound || lastMeaningful || `build command exited ${exitCode}`).trim();
        errors.push({ file: '', line: 0, column: 0, code: '', message: reason });
    }

    return { succeeded: exitCode === 0, errors, warnings };
}

function parseTestOutput(output, exitCode) {
    // `deadProjects` / `errorCount` exist because a MONOREPO run emits one summary block PER
    // package, and two independent defects used to hide a dead project inside a green verdict:
    //   1. the summary branches below ASSIGNED (`=`) instead of accumulating, so the LAST package's
    //      summary silently overwrote every earlier one (last-line-wins). EVERY runner branch now
    //      accumulates — the first fix reached only vitest+dotnet, leaving rust (one `test result:`
    //      per crate) and both pytest branches (one summary per package) still last-line-wins;
    //   2. a project that crashes before collecting anything prints `Tests  no tests` — which has
    //      no parenthesised total, so the envelope regex never matched it and it contributed
    //      nothing at all. The aggregate `isZeroCollected` guard could not see it either, because
    //      the OTHER packages' counts kept the total non-zero.
    // Measured impact: a monorepo package whose test worker crashed at boot stayed hidden for
    // 8 days while this function reported PASSED, because vitest exits 0 after the crash and
    // another package's summary landed last.
    const tests = { passed: 0, failed: 0, skipped: 0, total: 0, failures: [], deadProjects: 0, errorCount: 0 };
    const lines = output.split('\n');

    for (const rawLine of lines) {
        // Strip ANSI color codes — Vitest (introduced in 2.x, still in 5) embeds them in summary lines
        const line = stripAnsi(rawLine);

        // Vitest/Jest v1 style: Tests: 5 passed, 1 failed, 2 skipped, 8 total
        const vitestV1Match = line.match(/Tests:\s*(?:(\d+)\s*passed)?[,\s]*(?:(\d+)\s*failed)?[,\s]*(?:(\d+)\s*skipped)?[,\s]*(\d+)\s*total/i);
        if (vitestV1Match) {
            // ACCUMULATE, never assign — one summary block per monorepo package (see the header
            // note). For a single-project run `+=` from zero is identical to the old `=`.
            tests.passed += parseInt(vitestV1Match[1] || 0);
            tests.failed += parseInt(vitestV1Match[2] || 0);
            tests.skipped += parseInt(vitestV1Match[3] || 0);
            tests.total += parseInt(vitestV1Match[4] || 0);
            continue;
        }

        // Vitest: a project that collected NOTHING prints "Tests  no tests" — note there is no
        // parenthesised total, so the v2 envelope regex below cannot match it and it would
        // otherwise contribute silently nothing. This is the shape a crashed/segfaulted project
        // leaves behind, and it must FAIL the gate rather than vanish.
        if (/Tests\s{2,}no tests\b/i.test(line)) {
            tests.deadProjects += 1;
            continue;
        }

        // Vitest: "Errors  1 error" — unhandled errors reported OUTSIDE the pass/fail counts
        // (pool crashes, worker exits, unhandled rejections). A run carrying these is not green
        // no matter what the per-test tallies say.
        // NOT anchored with ^ — `pnpm -r` prefixes every line with "<pkg> test: ", so an anchored
        // pattern silently never matches in the exact monorepo case this exists to catch. The
        // two-or-more-space gap before the count is what keeps it from matching prose.
        const vitestErrors = line.match(/(?:^|\s)Errors\s{2,}(\d+)\s+errors?\b/i);
        if (vitestErrors) {
            tests.errorCount += parseInt(vitestErrors[1]);
            continue;
        }

        // Vitest summary format (introduced in 2.x, still emitted by Vitest 5): "Tests  2 passed (2)" or "Tests  1 failed | 251 passed (252)"
        // No colon, no "total" word — total is in parens at the end. Order of
        // passed/failed/skipped varies (failures come first when present).
        // Strategy: match the outer envelope, then scan body for each keyword.
        const vitestV2Envelope = line.match(/Tests\s{2,}(.+)\s*\((\d+)\)/i);
        if (vitestV2Envelope) {
            const body = vitestV2Envelope[1];
            const totalStr = vitestV2Envelope[2];
            const pM = body.match(/(\d+)\s*passed/i);
            const fM = body.match(/(\d+)\s*failed/i);
            const sM = body.match(/(\d+)\s*skipped/i);
            // ACCUMULATE — see the header note. This line was the actual last-line-wins bug: with
            // `=`, `pnpm -r test` reported only whichever package printed its summary last.
            tests.passed += pM ? parseInt(pM[1]) : 0;
            tests.failed += fM ? parseInt(fM[1]) : 0;
            tests.skipped += sM ? parseInt(sM[1]) : 0;
            tests.total += parseInt(totalStr);
            continue;
        }

        // dotnet test: Passed! - Failed: 0, Passed: 10, Skipped: 0, Total: 10
        const dotnetMatch = line.match(/(?:Passed!|Failed!)\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/);
        if (dotnetMatch) {
            tests.failed += parseInt(dotnetMatch[1]);
            tests.passed += parseInt(dotnetMatch[2]);
            tests.skipped += parseInt(dotnetMatch[3]);
            tests.total += parseInt(dotnetMatch[4]);
            continue;
        }

        // Go: ok/FAIL package lines + test count
        const goMatch = line.match(/^(?:ok|FAIL)\s+\S+\s+[\d.]+s/);
        if (goMatch) {
            // Go doesn't give granular counts in the summary line
            continue;
        }

        // Rust: test result: ok. N passed; N failed; N ignored
        // ACCUMULATE — `cargo test --workspace` prints one `test result:` line PER CRATE
        // (plus one per doc-test run), so assigning made the LAST crate's numbers the whole
        // verdict. A trailing crate with no tests drove `total` to 0 → false RED via
        // isZeroCollected; a trailing green crate hid an earlier crate's failures.
        const rustMatch = line.match(/test result:\s*\w+\.\s*(\d+)\s*passed;\s*(\d+)\s*failed;\s*(\d+)\s*ignored/);
        if (rustMatch) {
            const p = parseInt(rustMatch[1]);
            const f = parseInt(rustMatch[2]);
            const s = parseInt(rustMatch[3]);
            tests.passed += p;
            tests.failed += f;
            tests.skipped += s;
            tests.total += p + f + s;
            continue;
        }

        // pytest summary: "===== 5 passed, 1 failed, 2 skipped in 1.23s =====".
        // Counters may appear in any order; "warnings" / "errors" / "deselected"
        // segments are ignored. Match the envelope, then scan the body for keywords.
        const pytestMatch = line.match(/={2,}\s+(.+?)\s+in\s+[\d.]+s\s*={2,}/);
        if (pytestMatch && /\b(passed|failed|skipped|error|errors)\b/.test(pytestMatch[1])) {
            const body = pytestMatch[1];
            const pM = body.match(/(\d+)\s+passed/);
            const fM = body.match(/(\d+)\s+failed/);
            const sM = body.match(/(\d+)\s+skipped/);
            const eM = body.match(/(\d+)\s+errors?/);
            // ACCUMULATE — a multi-package pytest run (tox, a monorepo `pytest a/ b/`,
            // `pnpm -r`-style fan-out) prints one summary per package; assigning kept only
            // the last, so an earlier package's failures vanished and a trailing
            // zero-test package zeroed `total` into a false RED.
            const p = pM ? parseInt(pM[1]) : 0;
            const f = (fM ? parseInt(fM[1]) : 0) + (eM ? parseInt(eM[1]) : 0);
            const s = sM ? parseInt(sM[1]) : 0;
            tests.passed += p;
            tests.failed += f;
            tests.skipped += s;
            tests.total += p + f + s;
            continue;
        }

        // C11: pytest QUIET summary (the default under `addopts = "-q"`):
        // "32 passed in 0.47s" or "1 failed, 31 passed in 0.50s" — NO "====="
        // envelope, so the branch above misses it and a real suite parses as 0
        // tests (the F1 false-green on Python). Require the line to START with a
        // count+outcome and END with "in <N>s" so arbitrary prose can't match.
        const pytestQuietMatch = line.match(
            /^\s*((?:\d+\s+(?:passed|failed|skipped|errors?|deselected|xfailed|xpassed|warnings?)\b[,\s]*)+)\s+in\s+[\d.]+s\b/
        );
        if (pytestQuietMatch && /\b(passed|failed|skipped|error|errors)\b/.test(pytestQuietMatch[1])) {
            const body = pytestQuietMatch[1];
            const pM = body.match(/(\d+)\s+passed/);
            const fM = body.match(/(\d+)\s+failed/);
            const sM = body.match(/(\d+)\s+skipped/);
            const eM = body.match(/(\d+)\s+errors?/);
            // ACCUMULATE — same multi-package reason as the verbose branch above.
            const p = pM ? parseInt(pM[1]) : 0;
            const f = (fM ? parseInt(fM[1]) : 0) + (eM ? parseInt(eM[1]) : 0);
            const s = sM ? parseInt(sM[1]) : 0;
            tests.passed += p;
            tests.failed += f;
            tests.skipped += s;
            tests.total += p + f + s;
            continue;
        }

        // Playwright summary: each outcome prints on its OWN line, e.g.
        //   "  15 passed (14.4s)"  /  "  1 failed"  /  "  2 flaky"  /  "  3 skipped"
        // No "Tests:"/"total" keyword and the duration rides in PARENS (not
        // "in <N>s"), so none of the branches above match and a green suite would
        // parse as 0 tests → isZeroCollected false-REDs it. Accumulate across the
        // lines (flaky = eventually-passed → counts toward passed). Anchored so a
        // numbered failure-detail line ("1) e2e/foo.spec.js …") can't match.
        const playwrightMatch = line.match(
            /^\s*(\d+)\s+(passed|failed|flaky|skipped|interrupted|did not run)\b(?:\s*\([^)]*\))?\s*$/i
        );
        if (playwrightMatch) {
            const n = parseInt(playwrightMatch[1]);
            const kind = playwrightMatch[2].toLowerCase();
            if (kind === 'passed' || kind === 'flaky') tests.passed += n;
            else if (kind === 'failed' || kind === 'interrupted') tests.failed += n;
            else tests.skipped += n; // skipped / did not run
            // `+= n`, not a re-derivation from the running component totals: re-deriving
            // would CLOBBER a total already accumulated from another runner's summary
            // (dotnet/vitest report an explicit total that need not equal p+f+s — vitest
            // counts `todo` tests in its parenthesised figure, for instance).
            tests.total += n;
            continue;
        }

        // pytest individual failure: "FAILED tests/test_foo.py::test_bar - AssertionError: ..."
        const pytestFailMatch = line.match(/^FAILED\s+(\S+)(?:\s+-\s+(.+))?$/);
        if (pytestFailMatch) {
            tests.failures.push({ name: pytestFailMatch[1] });
            continue;
        }

        // Individual failure lines
        const failMatch = line.match(/^\s*(?:FAIL|Failed|✗|✘|×)\s+(.+?)(?:\s+\[|$)/);
        if (failMatch) {
            tests.failures.push({ name: failMatch[1].trim() });
        }
    }

    // A dead project or a reported error is a FAILURE even when the runner exits 0 and every
    // collected test passed — that combination is precisely the false-green this guards.
    tests.succeeded =
        exitCode === 0 && tests.failed === 0 && tests.deadProjects === 0 && tests.errorCount === 0;
    return tests;
}

/**
 * F1 false-green guard. A real test runner that exits 0 but yields ZERO parsed
 * tests is suspicious — it collected nothing, printed a summary the parser
 * missed, or wrote to an unexpected stream. Reporting a clean "PASSED (0 passed)"
 * would mask a project whose tests silently stopped running. Returns true when
 * the gate should flag this (without hard-failing): a real runner (not the
 * `echo` no-test fallback) exited 0 with 0 total, and the command did not opt
 * into no-match passing (`--passWithNoTests`, used by `--changed` waves).
 *
 * @param {string} testCmd   The test command that ran
 * @param {number} exitCode  Its exit code
 * @param {number} total     Tests parsed from its output
 * @returns {boolean}
 */
function isZeroCollected(testCmd, exitCode, total) {
    const ranRealRunner = !/^\s*echo\b/.test(testCmd || '');
    const noMatchAllowed = /--passWithNoTests/.test(testCmd || '');
    return ranRealRunner && exitCode === 0 && total === 0 && !noMatchAllowed;
}

/**
 * C11/F1 TEETH. The final gate verdict for the test leg. A parsed "pass" is
 * overridden to FAIL when the runner collected ZERO tests — `isZeroCollected`
 * only *detected* that case (and the gate merely warned), which let a 32-test
 * pytest suite report PASSED(0) on the quiet summary. Treating 0-collected as a
 * hard fail closes the false-green: a wave whose tests silently stopped running
 * is now RED. The echo no-test fallback and `--passWithNoTests --changed` waves
 * are exempt (isZeroCollected already returns false for them).
 *
 * @param {{succeeded:boolean,total:number,exitCode:number}} test parsed result
 * @param {string} testCmd the test command that ran
 * @returns {boolean}
 */
function testPassed(test, testCmd) {
    if (isZeroCollected(testCmd, test.exitCode, test.total)) return false;
    return test.succeeded;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
    const startedAt = Date.now();
    ensureDirs();

    if (!acquireLock()) {
        console.error('[GATE] Another gate is already running. Wait for it to finish.');
        process.exit(3);
    }

    process.on('exit', releaseLock);
    process.on('SIGINT', () => { releaseLock(); process.exit(130); });
    process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

    const config = loadConfig();
    console.log(`[GATE] Detected stack: ${config.stack || 'configured'}`);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(LOG_DIR, `gate-${timestamp}.log`);

    // ── E2E mode: focused behavior/contract gate (run after build+test pass) ──
    if (runE2e) {
        const e2e = config.e2e || { command: 'echo "No e2e gate configured"', timeout: 60000, missing: true };
        if (e2e.missing) {
            console.log(`[GATE] E2E: SKIPPED (no e2e/integration script detected for stack ${config.stack || 'configured'})`);
            writeSummary(PROJECT_ROOT, {
                timestamp: new Date().toISOString(), mode: 'E2E', stack: config.stack || 'configured',
                overall: true, durationMs: Date.now() - startedAt, e2e: { succeeded: true, skipped: true },
            });
            console.log('[GATE] Overall: PASSED');
            process.exit(0);
        }
        // describeLeg/legRunnable, like the build leg: an argv-mode or multi-leg e2e config has
        // no `.command`, and passing undefined crashed the leg instead of running it.
        const e2eDisplay = describeLeg(e2e);
        console.log(`[GATE] E2E... (${e2eDisplay})`);
        let e2eLog = `E2E gate started at ${new Date().toISOString()}\nStack: ${config.stack || 'configured'}\n${'='.repeat(60)}\n--- E2E ---\n`;
        const e2eResult = runCommand(legRunnable(e2e), PROJECT_ROOT, legTimeout(e2e));
        e2eLog += e2eResult.output + '\n' + e2eResult.stderr + '\n';
        const parsed = parseTestOutput(e2eResult.output + '\n' + e2eResult.stderr, e2eResult.exitCode);
        // Same false-green teeth as the unit leg: a runner that exits 0 having
        // collected 0 e2e tests is a FAIL, not a silent pass (C11/F1).
        const zeroCollected = isZeroCollected(e2eDisplay, e2eResult.exitCode, parsed.total);
        const succeeded = testPassed({ succeeded: parsed.succeeded, total: parsed.total, exitCode: e2eResult.exitCode }, e2eDisplay);
        fs.writeFileSync(
            path.join(GATE_DIR, '_latest-e2e.json'),
            JSON.stringify({ ...parsed, exitCode: e2eResult.exitCode, command: e2eDisplay, timestamp: new Date().toISOString(), zeroCollected, succeeded }, null, 2),
        );
        const e2eStatus = succeeded ? 'PASSED' : (zeroCollected ? 'FAILED (0 tests collected)' : 'FAILED');
        console.log(`[GATE] E2E: ${e2eStatus} (${parsed.passed} passed, ${parsed.failed} failed, ${parsed.skipped} skipped)`);
        e2eLog += `\n${'='.repeat(60)}\nE2E gate completed at ${new Date().toISOString()}\nOverall: ${succeeded ? 'PASSED' : 'FAILED'}\n`;
        fs.writeFileSync(logPath, e2eLog);
        writeSummary(PROJECT_ROOT, {
            timestamp: new Date().toISOString(), mode: 'E2E', stack: config.stack || 'configured',
            overall: succeeded, durationMs: Date.now() - startedAt,
            e2e: { succeeded, passed: parsed.passed, failed: parsed.failed, skipped: parsed.skipped, total: parsed.total, zeroCollected },
        });
        console.log(`[GATE] Log: ${logPath}`);
        console.log(`[GATE] Overall: ${succeeded ? 'PASSED' : 'FAILED'}`);
        process.exit(succeeded ? 0 : 1);
    }

    const mode = skipBuild
        ? (changedOnly ? 'TEST (changed only)' : 'TEST ONLY')
        : (runTests ? 'BUILD + TEST' : 'BUILD');
    let fullLog = `${mode} gate started at ${new Date().toISOString()}\nStack: ${config.stack || 'configured'}\n${'='.repeat(60)}\n`;

    // ── Step 1: Build ───────────────────────────────────────────────

    let build;
    if (skipBuild) {
        console.log('[GATE] Build: SKIPPED (--no-build)');
        fullLog += '\n--- Build SKIPPED (--no-build) ---\n';
        build = {
            succeeded: true,
            errors: [],
            warnings: [],
            exitCode: 0,
            command: '(skipped)',
            timestamp: new Date().toISOString(),
            skipped: true,
        };
        fs.writeFileSync(
            path.join(GATE_DIR, '_latest-build.json'),
            JSON.stringify(build, null, 2)
        );
    } else {
        const buildDisplay = describeLeg(config.build);
        console.log(`[GATE] Building... (${buildDisplay})`);
        fullLog += '\n--- Build ---\n';

        const buildResult = runCommand(legRunnable(config.build), PROJECT_ROOT, legTimeout(config.build));
        const buildCombined = buildResult.output + '\n' + buildResult.stderr;
        fullLog += buildCombined + '\n';

        build = parseBuildOutput(buildCombined, buildResult.exitCode);
        build.exitCode = buildResult.exitCode;
        build.command = buildDisplay;
        build.timestamp = new Date().toISOString();

        fs.writeFileSync(
            path.join(GATE_DIR, '_latest-build.json'),
            JSON.stringify(build, null, 2)
        );

        const buildStatus = build.succeeded ? 'PASSED' : 'FAILED';
        console.log(`[GATE] Build: ${buildStatus} (${build.errors.length} errors, ${build.warnings.length} warnings)`);
    }

    // ── Step 2: Test (if requested and build passed) ────────────────

    let test = null;
    if (runTests) {
        if (!build.succeeded) {
            console.log('[GATE] Skipping tests — build failed');
            fullLog += '\n--- Tests SKIPPED (build failed) ---\n';
        } else {
            // Inject --changed via `npm test -- --changed` (extra args after `--` pass through to vitest).
            // --passWithNoTests prevents false-failure when --changed matches zero files (e.g., docs-only wave).
            // Argv-mode legs (e.g. dotnet, F31) don't support this string-append
            // transform — it's vitest-specific — so they run as-is.
            const legMode = Boolean(config.test.argv) || Array.isArray(config.test.legs);
            const testCmd = legMode
                ? describeLeg(config.test)
                : (changedOnly ? `${config.test.command} -- --changed --passWithNoTests` : config.test.command);
            console.log(`[GATE] Testing... (${testCmd})`);
            const limit = resolveTestTimeout(config.test, configFileSetsTestTimeout());
            if (limit.warning) {
                console.log(`[GATE] Warning: ${limit.warning}`);
                fullLog += `\n[GATE] Warning: ${limit.warning}\n`;
            }
            const limitLine = `[GATE] Test time limit: ${limit.timeoutMs} ms (${limit.source})`;
            console.log(limitLine);
            fullLog += `\n--- Tests ---\n${limitLine}\n`;

            const testRunnable = legMode ? legRunnable(config.test) : testCmd;
            const testResult = runCommand(testRunnable, PROJECT_ROOT, limit.timeoutMs);
            const testCombined = testResult.output + '\n' + testResult.stderr;
            fullLog += testCombined + '\n';

            test = parseTestOutput(testCombined, testResult.exitCode);
            test.exitCode = testResult.exitCode;
            test.command = testCmd;
            test.timestamp = new Date().toISOString();

            // F1: false-green guard — see isZeroCollected().
            test.zeroCollected = isZeroCollected(testCmd, testResult.exitCode, test.total);
            // C11/F1 teeth: 0-collected is a FAIL, not a warn. Override the parsed
            // verdict so `overall` (build && test.succeeded) goes RED.
            test.succeeded = testPassed({ succeeded: test.succeeded, total: test.total, exitCode: testResult.exitCode }, testCmd);

            fs.writeFileSync(
                path.join(GATE_DIR, '_latest-test.json'),
                JSON.stringify(test, null, 2)
            );

            if (test.zeroCollected) {
                const warn = '[GATE] Tests: FAILED — runner exited 0 but 0 tests were parsed ' +
                    '(false-green: no tests collected, or the summary format is unrecognized). ' +
                    'This fails the gate by design (C11/F1). Verify the runner actually ran tests.';
                console.log(warn);
                fullLog += `\n${warn}\n`;
            }

            if (test.deadProjects > 0 || test.errorCount > 0) {
                const bits = [];
                if (test.deadProjects > 0) {
                    bits.push(`${test.deadProjects} project(s) collected NO tests ("Tests  no tests")`);
                }
                if (test.errorCount > 0) {
                    bits.push(`${test.errorCount} unhandled error(s) reported outside the pass/fail counts`);
                }
                const warn = `[GATE] Tests: FAILED — ${bits.join('; ')}. ` +
                    'The runner may still have exited 0 (vitest does this after a pool/worker crash) ' +
                    'and the other packages\' tallies can look healthy — that combination is the ' +
                    'false-green this check exists for. Find the crashed project in the log above.';
                console.log(warn);
                fullLog += `\n${warn}\n`;
            }

            const testStatus = test.succeeded
                ? 'PASSED'
                : (test.zeroCollected
                    ? 'FAILED (0 tests collected)'
                    : (test.deadProjects > 0 || test.errorCount > 0
                        ? 'FAILED (a project collected no tests / reported errors)'
                        : 'FAILED'));
            console.log(`[GATE] Tests: ${testStatus} (${test.passed} passed, ${test.failed} failed, ${test.skipped} skipped)`);
            if (testResult.timedOut) {
                const killed = `[GATE] Tests: TIMED OUT — the run was killed at ${limit.timeoutMs} ms (${limit.source}). ` +
                    `That is the limit, not a test failure: re-run on a quieter machine or raise it with ${TEST_TIMEOUT_ENV}=<ms> ` +
                    'or test.timeout in .claude/gate.config.json.';
                console.log(killed);
                fullLog += `\n${killed}\n`;
                test.timedOut = true;
                test.timeoutMs = limit.timeoutMs;
                test.timeoutMessage = `TIMED OUT after ${formatTimeout(limit.timeoutMs)}`;
                fs.writeFileSync(path.join(GATE_DIR, '_latest-test.json'), JSON.stringify(test, null, 2));
            }
        }
    }

    // ── Step 3: Lint (folded into the same invocation as Test) ──────
    //
    // Root cause this closes: a lint failure had no gate leg to fail against — it
    // only surfaced later via a dedicated code-review pass (or CI, post-push), by
    // which point the broken commit already existed. Runs under the exact same
    // condition as Test (`runTests`) so every existing `/do`/`/run-todo` Step 7
    // call site (`gate.js test`) picks this up with zero command-template edits.
    // Parsed via parseBuildOutput (ESLint/tsc-shaped file:line:col output), not
    // parseTestOutput — lint has no pass/fail COUNT summary the way a test run
    // does. Same graceful-missing contract as the e2e leg: a project with no lint
    // script configured (and no explicit gate.config.json override) never fails.

    let lint = null;
    if (runTests) {
        const lintConfig = config.lint || { command: 'echo "No lint gate configured"', timeout: 60000, missing: true };
        if (!build.succeeded) {
            console.log('[GATE] Skipping lint — build failed');
            fullLog += '\n--- Lint SKIPPED (build failed) ---\n';
        } else if (lintConfig.missing) {
            console.log(`[GATE] Lint: SKIPPED (no lint script detected for stack ${config.stack || 'configured'})`);
            fullLog += '\n--- Lint SKIPPED (no lint script detected) ---\n';
            lint = {
                succeeded: true, errors: [], warnings: [], skipped: true,
                command: lintConfig.command, timestamp: new Date().toISOString(),
            };
            fs.writeFileSync(path.join(GATE_DIR, '_latest-lint.json'), JSON.stringify(lint, null, 2));
        } else {
            // describeLeg/legRunnable, like the build leg: an argv-mode or multi-leg lint config
            // has no `.command`, and passing undefined crashed the whole gate.
            const lintDisplay = describeLeg(lintConfig);
            console.log(`[GATE] Linting... (${lintDisplay})`);
            fullLog += '\n--- Lint ---\n';

            const lintResult = runCommand(legRunnable(lintConfig), PROJECT_ROOT, legTimeout(lintConfig));
            const lintCombined = lintResult.output + '\n' + lintResult.stderr;
            fullLog += lintCombined + '\n';

            lint = parseBuildOutput(lintCombined, lintResult.exitCode);
            lint.exitCode = lintResult.exitCode;
            lint.command = lintDisplay;
            lint.timestamp = new Date().toISOString();

            fs.writeFileSync(path.join(GATE_DIR, '_latest-lint.json'), JSON.stringify(lint, null, 2));

            const lintStatus = lint.succeeded ? 'PASSED' : 'FAILED';
            console.log(`[GATE] Lint: ${lintStatus} (${lint.errors.length} errors, ${lint.warnings.length} warnings)`);
        }
    }

    // ── Step 4: Visual regression (full-gate tier only, never in CI) ──
    //
    // Root cause this closes: a visual-regression script nobody runs rots. Its
    // baselines drift silently through intentional redesigns until most cases fail on
    // a clean tree, and "green" only ever meant "someone remembered to type it".
    //
    // TWO deliberate conditions, both load-bearing:
    //
    //   1. `!skipBuild` - this runs on the full gate only, never on the fast tiers
    //      (`--skip-build`). The leg boots a preview server and a browser, and paying
    //      that on every mid-wave gate would wreck the inner loop the tiering protects.
    //
    //   2. `!process.env.CI` - deliberately LOCAL-ONLY. Wiring the leg into the gate
    //      would otherwise put a browser back into CI runs that deliberately exclude
    //      one. Snapshot baselines are also generated on the developer's machine, and
    //      font rendering differs enough between hosts that a CI runner can fail every
    //      case on hinting alone.
    //
    // Opt-in via a `visual` key in .claude/gate.config.json ({ "command": "...",
    // "timeout": ms }, or argv/legs like the other legs). Same graceful-missing
    // contract as the lint and e2e legs: a project with no `visual` key never fails.

    let visual = null;
    if (runTests && !skipBuild) {
        const visualConfig = config.visual || { command: 'echo "No visual gate configured"', timeout: 300000, missing: true };
        if (!build.succeeded) {
            console.log('[GATE] Skipping visual — build failed');
            fullLog += '\n--- Visual SKIPPED (build failed) ---\n';
        } else if (visualConfig.missing) {
            console.log('[GATE] Visual: SKIPPED (no visual gate configured)');
            fullLog += '\n--- Visual SKIPPED (not configured) ---\n';
        } else if (runningInCi()) {
            console.log('[GATE] Visual: SKIPPED (CI — visual regression is local-only by design)');
            fullLog += '\n--- Visual SKIPPED (CI) ---\n';
            visual = {
                succeeded: true, passed: 0, failed: 0, skipped: 0, total: 0,
                skippedLeg: true, reason: 'ci',
                command: describeLeg(visualConfig), timestamp: new Date().toISOString(),
            };
            fs.writeFileSync(path.join(GATE_DIR, '_latest-visual.json'), JSON.stringify(visual, null, 2));
        } else {
            // describeLeg/legRunnable, like the lint leg: an argv-mode or multi-leg config
            // has no `.command`.
            const visualDisplay = describeLeg(visualConfig);
            console.log(`[GATE] Visual... (${visualDisplay})`);
            fullLog += '\n--- Visual ---\n';

            const visualResult = runCommand(legRunnable(visualConfig), PROJECT_ROOT, legTimeout(visualConfig));
            const visualCombined = visualResult.output + '\n' + visualResult.stderr;
            fullLog += visualCombined + '\n';

            visual = parseTestOutput(visualCombined, visualResult.exitCode);
            visual.exitCode = visualResult.exitCode;
            visual.command = visualDisplay;
            visual.timestamp = new Date().toISOString();
            if (visualResult.timedOut) {
                visual.timedOut = true;
                visual.timeoutMs = legTimeout(visualConfig);
                visual.timeoutMessage = `TIMED OUT after ${formatTimeout(visual.timeoutMs)}`;
            }

            // Same false-green teeth as the unit and e2e legs: a runner that
            // exits 0 having collected 0 snapshots is a FAIL. Without this, a
            // renamed/moved visual directory reads as a clean pass forever.
            visual.zeroCollected = isZeroCollected(visualDisplay, visualResult.exitCode, visual.total);
            visual.succeeded = testPassed(
                { succeeded: visual.succeeded, total: visual.total, exitCode: visualResult.exitCode },
                visualDisplay,
            );

            fs.writeFileSync(path.join(GATE_DIR, '_latest-visual.json'), JSON.stringify(visual, null, 2));

            const visualStatus = visual.succeeded
                ? 'PASSED'
                : (visual.timedOut ? `FAILED (${visual.timeoutMessage})` : (visual.zeroCollected ? 'FAILED (0 snapshots collected)' : 'FAILED'));
            console.log(`[GATE] Visual: ${visualStatus} (${visual.passed} passed, ${visual.failed} failed)`);
            if (!visual.succeeded) {
                const hint = '[GATE] Visual diffs: inspect the runner\'s diff images before regenerating ' +
                    'baselines; regenerate only when the visual change is intentional.';
                console.log(hint);
                fullLog += `\n${hint}\n`;
            }
        }
    }

    // ── Summary ─────────────────────────────────────────────────────

    const overall = build.succeeded && (!runTests || (test && test.succeeded)) && (!lint || lint.succeeded) && (!visual || visual.succeeded);

    const summary = {
        timestamp: new Date().toISOString(),
        mode,
        stack: config.stack || 'configured',
        overall,
        // Wall-clock duration of the whole gate run. Read by command-usage-logger
        // to populate gate_run telemetry's duration_ms (the PostToolUse:Bash hook
        // has no timing of its own — see that hook's gate_run branch).
        durationMs: Date.now() - startedAt,
        build: {
            succeeded: build.succeeded,
            errorCount: build.errors.length,
            warningCount: build.warnings.length
        }
    };

    if (test) {
        summary.test = {
            succeeded: test.succeeded,
            passed: test.passed,
            failed: test.failed,
            skipped: test.skipped,
            total: test.total,
            zeroCollected: !!test.zeroCollected,
            timedOut: !!test.timedOut,
            ...(test.timedOut ? { timeoutMs: test.timeoutMs, timeoutMessage: test.timeoutMessage } : {}),
            failureNames: test.failures.map(f => f.name)
        };
    }

    if (lint) {
        summary.lint = {
            succeeded: lint.succeeded,
            errorCount: lint.errors.length,
            warningCount: lint.warnings.length,
            skipped: !!lint.skipped
        };
    }

    if (visual) {
        summary.visual = {
            succeeded: visual.succeeded,
            passed: visual.passed,
            failed: visual.failed,
            total: visual.total,
            zeroCollected: !!visual.zeroCollected,
            skipped: !!visual.skippedLeg,
            timedOut: !!visual.timedOut,
            ...(visual.timedOut ? { timeoutMs: visual.timeoutMs, timeoutMessage: visual.timeoutMessage } : {}),
            failureNames: (visual.failures || []).map(f => f.name)
        };
    }

    writeSummary(PROJECT_ROOT, summary);

    fullLog += `\n${'='.repeat(60)}\n${mode} gate completed at ${new Date().toISOString()}\n`;
    fullLog += `Overall: ${overall ? 'PASSED' : 'FAILED'}\n`;
    fs.writeFileSync(logPath, fullLog);

    console.log(`[GATE] Log: ${logPath}`);
    console.log(`[GATE] Overall: ${overall ? 'PASSED' : 'FAILED'}`);

    process.exit(overall ? 0 : 1);
}

if (require.main === module) {
    main().catch(err => {
        console.error('[GATE] Fatal error:', err.message);
        process.exit(2);
    });
}

module.exports = { legTimeout, formatTimeout, DEFAULT_LEG_TIMEOUT_MS, loadConfig, parseBuildOutput, parseTestOutput, isZeroCollected, testPassed, runCommand, describeLeg, legRunnable, resolveTestTimeout, acquireLock, releaseLock, isProcessAlive, STALE_LOCK_MS, DEFAULT_TEST_TIMEOUT_MS, TEST_TIMEOUT_ENV };
