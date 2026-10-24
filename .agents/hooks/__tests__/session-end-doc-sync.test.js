// AC→source map (session-end-doc-sync, T.10):
//   - runDocSync: opt-out env CLAUDE_NO_DOC_SYNC=1 → no-op before any drift work
//   - runDocSync: drift detected → non-blocking notice on stderr
//   - runDocSync: no drift → silent, no notice (the common production path)
//   - runDocSync: detectDocDrift throws → status 'error', no notice (non-blocking under failure)
//   - main: always process.exit(0), even when drift is present (never blocks close)
//
// Direct-require (not subprocess) so the hook body counts toward v8 coverage.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');
// Same resolved module object the hook reads detectDocDrift off of — spy here to
// drive the error/catch branch.
const docDriftModule = require('../../../.agents/core/_lib/doc-drift');

// ---------------------------------------------------------------------------
// Env save/restore
// ---------------------------------------------------------------------------
const origProjectDir = process.env.CLAUDE_PROJECT_DIR;
const origNoDocSync = process.env.CLAUDE_NO_DOC_SYNC;

const { runDocSync, main } = require('../../../.agents/hooks/session-end-doc-sync.cjs');

let tmp;

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'session-end-doc-sync-' });
    // Anchor telemetry writes (hook-events.jsonl) into the sandbox, not the repo.
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
    delete process.env.CLAUDE_NO_DOC_SYNC;
});

afterEach(() => {
    tmp.cleanup();
    if (origProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origProjectDir;
    if (origNoDocSync === undefined) delete process.env.CLAUDE_NO_DOC_SYNC;
    else process.env.CLAUDE_NO_DOC_SYNC = origNoDocSync;
});

// A legacy-named planning doc (real content, not a template stub) → drift.
function seedDrift() {
    tmp.write('docs/_architecture.md', '# Architecture\n\nReal content, not a scaffold stub.\n');
}

// ---------------------------------------------------------------------------
// Branch (a): drift detected → notice emitted
// ---------------------------------------------------------------------------
describe('runDocSync — drift detected', () => {
    it('emits a non-blocking notice on stderr and reports drift', () => {
        seedDrift();
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        const result = runDocSync(tmp.root);

        expect(result.status).toBe('drift');
        expect(result.hasDrift).toBe(true);
        expect(result.noticeEmitted).toBe(true);
        expect(spy).toHaveBeenCalled();
        const written = spy.mock.calls.map(c => c[0]).join('');
        expect(written).toContain('Doc-sync notice (non-blocking)');
        expect(written).toContain('docs/_architecture.md');

        spy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// Branch (b): no drift → exit 0 silently, no notice (common production path)
// ---------------------------------------------------------------------------
describe('runDocSync — no drift', () => {
    it('writes nothing to stderr and reports clean', () => {
        tmp.write('docs/architecture/overview.md', '# Architecture\n\nCanonical, no drift.\n');
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        const result = runDocSync(tmp.root);

        expect(result.status).toBe('clean');
        expect(result.hasDrift).toBe(false);
        expect(result.noticeEmitted).toBe(false);
        expect(spy).not.toHaveBeenCalled();

        spy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// Branch (c): opt-out env set → no-op before any drift work
// ---------------------------------------------------------------------------
describe('runDocSync — opt-out', () => {
    it('no-ops when CLAUDE_NO_DOC_SYNC=1 even if drift would be present', () => {
        process.env.CLAUDE_NO_DOC_SYNC = '1';
        seedDrift(); // drift exists, but opt-out must short-circuit before detecting it
        const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        const result = runDocSync(tmp.root);

        expect(result.status).toBe('opted-out');
        expect(result.hasDrift).toBe(false);
        expect(result.noticeEmitted).toBe(false);
        expect(spy).not.toHaveBeenCalled();

        spy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// Branch (e): detectDocDrift throws → caught, status 'error', no notice, no throw
// (the load-bearing non-blocking guarantee under failure)
// ---------------------------------------------------------------------------
describe('runDocSync — drift detection throws', () => {
    it('swallows the error, returns status error, and emits no notice', () => {
        const driftSpy = vi.spyOn(docDriftModule, 'detectDocDrift').mockImplementation(() => {
            throw new Error('boom');
        });
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        let result;
        expect(() => { result = runDocSync(tmp.root); }).not.toThrow();

        expect(result.status).toBe('error');
        expect(result.hasDrift).toBe(false);
        expect(result.noticeEmitted).toBe(false);
        expect(stderrSpy).not.toHaveBeenCalled();

        driftSpy.mockRestore();
        stderrSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// Branch (d): exit code is always 0 regardless (never blocks session close)
// ---------------------------------------------------------------------------
describe('main — always exits 0', () => {
    it('process.exit(0) even when drift is present', async () => {
        seedDrift(); // drift present — the hook must STILL exit 0 (never block close)
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        // readHookInput resolves '' immediately when stdin is a TTY — avoids a hang.
        const origTTY = process.stdin.isTTY;
        process.stdin.isTTY = true;

        await main();

        expect(exitSpy).toHaveBeenCalledWith(0);
        // Full round-trip: drift present → notice emitted → still exits 0.
        expect(stderrSpy).toHaveBeenCalled();
        expect(stderrSpy.mock.calls.map(c => c[0]).join('')).toContain('Doc-sync notice');

        process.stdin.isTTY = origTTY;
        exitSpy.mockRestore();
        stderrSpy.mockRestore();
    });
});
