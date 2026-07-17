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
 *   docs/.output/.state/telemetry/_latest-summary.json         — Combined summary
 *
 * `test` mode also runs a `lint` leg (same condition as test) — a project with
 * no lint script configured (and no explicit config override) skips it
 * gracefully, same contract as the `e2e` leg.
 *
 * Configuration (.claude/gate.config.json):
 *   {
 *     "build": { "command": "npm run build", "timeout": 300000 },
 *     "test":  { "command": "npm test", "timeout": 600000 },
 *     "lint":  { "command": "npm run lint", "timeout": 300000 }
 *   }
 *
 * Auto-detection order (if no config):
 *   1. package.json → npm run build / npm test
 *   2. Cargo.toml → cargo build / cargo test
 *   3. go.mod → go build ./... / go test ./...
 *   4. *.sln or *.slnx → dotnet build / dotnet test
 *   5. pyproject.toml → ruff check + format --check + mypy --strict / pytest
 *   6. Makefile → make build / make test
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

// The exact `started` timestamp THIS process wrote when it acquired the lock.
// releaseLock() compares against it so a process only ever deletes the lock it
// STILL owns — never one another gate re-created after breaking a lock this
// process thought it held. Null until acquired; reset to null on release.
let ownLockStarted = null;

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

// Break a lock we've already decided is abandoned (stale+dead-owner, or corrupt)
// and retry the acquire. TOCTOU guard: two gates can independently observe the
// SAME abandoned lock and both decide to break it. Without a re-check, the second
// unlink lands AFTER the first breaker already installed its own fresh, LIVE lock
// — deleting that live lock lets both gates run concurrently against the same
// tree (the exact race releaseLock's ownership guard closes on the release side,
// reintroduced here on the break side). So immediately before unlinking, re-read
// the file and confirm it is STILL the same lock we inspected (pid+started). If a
// DIFFERENT lock is there now, another gate already broke the abandoned one and
// acquired — fall through to a fresh attempt (which will see the live lock and
// return false) instead of deleting it. `expected` is the inspected lock, or null
// for a corrupt/unparseable one (nothing to match — reclaim only if still corrupt).
function breakLockAndRetry(expected) {
    try {
        const current = fs.readFileSync(LOCK_FILE, 'utf-8');
        if (expected) {
            let now;
            try { now = JSON.parse(current); } catch { return acquireLock(); }
            if (now.pid !== expected.pid || now.started !== expected.started) {
                // Someone else already broke it and installed a different lock.
                return acquireLock();
            }
        } else {
            // Corrupt-lock reclaim: only proceed if the file is STILL unparseable;
            // if it now parses, a valid lock arrived — don't clobber it.
            try { JSON.parse(current); return acquireLock(); } catch { /* still corrupt — reclaim */ }
        }
        fs.unlinkSync(LOCK_FILE);
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
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, started }));
        fs.closeSync(fd);
        ownLockStarted = started;
        return true;
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;

        let lock;
        try {
            lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
        } catch (readErr) {
            // Lock vanished between the EEXIST and our read — another gate released
            // it; just retry the O_EXCL create.
            if (readErr.code === 'ENOENT') return acquireLock();
            // Unreadable/corrupt lock file — no owner info to honor, so treat it as
            // abandoned and reclaim (with the same break-race guard).
            return breakLockAndRetry(null);
        }

        const age = Date.now() - new Date(lock.started).getTime();
        // Break another gate's lock ONLY when it is past the stale ceiling AND its
        // owning process is no longer alive. A legitimately long suite (owner still
        // running) is never broken, no matter how old — that was the race: a run
        // past the old ceiling got its lock stolen, then deleted its successor's
        // lock on exit. The liveness gate closes it; the raised ceiling bounds
        // dead-owner recovery.
        if (age > STALE_LOCK_MS && !isProcessAlive(lock.pid)) {
            console.log(`[GATE] Stale lock detected (${Math.round(age / 60000)}m old, PID ${lock.pid} not running). Breaking it.`);
            return breakLockAndRetry(lock);
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
        if (lock.pid === process.pid && lock.started === ownLockStarted) {
            fs.unlinkSync(LOCK_FILE);
        }
    } catch { /* no lock file, unreadable, or never acquired — nothing to release */ }
    ownLockStarted = null;
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
        return {
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

    const slnx = files.find(f => f.endsWith('.slnx'));
    const sln = files.find(f => f.endsWith('.sln'));
    const solution = slnx || sln;
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
        // A checkout path containing a shell metachar (e.g. `/home/dom/my repo;id/`)
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
        for (const subCmd of cmd.legs) {
            const sub = runCommand(subCmd, cwd, timeoutMs);
            output += sub.output;
            stderr += sub.stderr;
            exitCode = sub.exitCode;
            if (exitCode !== 0) break;
        }
        return { exitCode, output, stderr };
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
    };
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
    const tests = { passed: 0, failed: 0, skipped: 0, total: 0, failures: [] };
    const lines = output.split('\n');

    for (const rawLine of lines) {
        // Strip ANSI colour codes — Vitest 2.x embeds them in summary lines
        const line = stripAnsi(rawLine);

        // Vitest/Jest v1 style: Tests: 5 passed, 1 failed, 2 skipped, 8 total
        const vitestV1Match = line.match(/Tests:\s*(?:(\d+)\s*passed)?[,\s]*(?:(\d+)\s*failed)?[,\s]*(?:(\d+)\s*skipped)?[,\s]*(\d+)\s*total/i);
        if (vitestV1Match) {
            tests.passed = parseInt(vitestV1Match[1] || 0);
            tests.failed = parseInt(vitestV1Match[2] || 0);
            tests.skipped = parseInt(vitestV1Match[3] || 0);
            tests.total = parseInt(vitestV1Match[4] || 0);
            continue;
        }

        // Vitest 2.x style: "Tests  2 passed (2)" or "Tests  1 failed | 251 passed (252)"
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
            tests.passed = pM ? parseInt(pM[1]) : 0;
            tests.failed = fM ? parseInt(fM[1]) : 0;
            tests.skipped = sM ? parseInt(sM[1]) : 0;
            tests.total = parseInt(totalStr);
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
        const rustMatch = line.match(/test result:\s*\w+\.\s*(\d+)\s*passed;\s*(\d+)\s*failed;\s*(\d+)\s*ignored/);
        if (rustMatch) {
            tests.passed = parseInt(rustMatch[1]);
            tests.failed = parseInt(rustMatch[2]);
            tests.skipped = parseInt(rustMatch[3]);
            tests.total = tests.passed + tests.failed + tests.skipped;
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
            tests.passed = pM ? parseInt(pM[1]) : 0;
            tests.failed = (fM ? parseInt(fM[1]) : 0) + (eM ? parseInt(eM[1]) : 0);
            tests.skipped = sM ? parseInt(sM[1]) : 0;
            tests.total = tests.passed + tests.failed + tests.skipped;
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
            tests.passed = pM ? parseInt(pM[1]) : 0;
            tests.failed = (fM ? parseInt(fM[1]) : 0) + (eM ? parseInt(eM[1]) : 0);
            tests.skipped = sM ? parseInt(sM[1]) : 0;
            tests.total = tests.passed + tests.failed + tests.skipped;
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
            tests.total = tests.passed + tests.failed + tests.skipped;
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

    tests.succeeded = exitCode === 0 && tests.failed === 0;
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
        console.log(`[GATE] E2E... (${e2e.command})`);
        let e2eLog = `E2E gate started at ${new Date().toISOString()}\nStack: ${config.stack || 'configured'}\n${'='.repeat(60)}\n--- E2E ---\n`;
        const e2eResult = runCommand(e2e.command, PROJECT_ROOT, e2e.timeout);
        e2eLog += e2eResult.output + '\n' + e2eResult.stderr + '\n';
        const parsed = parseTestOutput(e2eResult.output + '\n' + e2eResult.stderr, e2eResult.exitCode);
        // Same false-green teeth as the unit leg: a runner that exits 0 having
        // collected 0 e2e tests is a FAIL, not a silent pass (C11/F1).
        const zeroCollected = isZeroCollected(e2e.command, e2eResult.exitCode, parsed.total);
        const succeeded = testPassed({ succeeded: parsed.succeeded, total: parsed.total, exitCode: e2eResult.exitCode }, e2e.command);
        fs.writeFileSync(
            path.join(GATE_DIR, '_latest-e2e.json'),
            JSON.stringify({ ...parsed, exitCode: e2eResult.exitCode, command: e2e.command, timestamp: new Date().toISOString(), zeroCollected, succeeded }, null, 2),
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

        const buildResult = runCommand(legRunnable(config.build), PROJECT_ROOT, config.build.timeout);
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
            const testCmd = config.test.argv
                ? describeLeg(config.test)
                : (changedOnly ? `${config.test.command} -- --changed --passWithNoTests` : config.test.command);
            console.log(`[GATE] Testing... (${testCmd})`);
            fullLog += '\n--- Tests ---\n';

            const testRunnable = config.test.argv ? { argv: config.test.argv } : testCmd;
            const testResult = runCommand(testRunnable, PROJECT_ROOT, config.test.timeout);
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

            const testStatus = test.succeeded ? 'PASSED' : (test.zeroCollected ? 'FAILED (0 tests collected)' : 'FAILED');
            console.log(`[GATE] Tests: ${testStatus} (${test.passed} passed, ${test.failed} failed, ${test.skipped} skipped)`);
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
            console.log(`[GATE] Linting... (${lintConfig.command})`);
            fullLog += '\n--- Lint ---\n';

            const lintResult = runCommand(lintConfig.command, PROJECT_ROOT, lintConfig.timeout);
            const lintCombined = lintResult.output + '\n' + lintResult.stderr;
            fullLog += lintCombined + '\n';

            lint = parseBuildOutput(lintCombined, lintResult.exitCode);
            lint.exitCode = lintResult.exitCode;
            lint.command = lintConfig.command;
            lint.timestamp = new Date().toISOString();

            fs.writeFileSync(path.join(GATE_DIR, '_latest-lint.json'), JSON.stringify(lint, null, 2));

            const lintStatus = lint.succeeded ? 'PASSED' : 'FAILED';
            console.log(`[GATE] Lint: ${lintStatus} (${lint.errors.length} errors, ${lint.warnings.length} warnings)`);
        }
    }

    // ── Summary ─────────────────────────────────────────────────────

    const overall = build.succeeded && (!runTests || (test && test.succeeded)) && (!lint || lint.succeeded);

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

module.exports = { loadConfig, parseBuildOutput, parseTestOutput, isZeroCollected, testPassed, runCommand, describeLeg, legRunnable, acquireLock, releaseLock, isProcessAlive, STALE_LOCK_MS };
