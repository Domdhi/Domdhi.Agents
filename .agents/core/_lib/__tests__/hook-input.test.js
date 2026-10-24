// AC→source map (P1.1 / hook-input):
//   Exports: readHookInput(opts?), parseHookPayload(jsonText)
//   Preserve per-caller stdin timeout semantics (1000ms default; null disables).

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The module-under-test is resolved lazily per test so env mutations take effect.
function loadModule() {
    delete require.cache[require.resolve('../../../../.agents/core/_lib/hook-input')];
    return require('../../../../.agents/core/_lib/hook-input');
}

function makeStdin(chunks, { emitError = false, emitEnd = true } = {}) {
    const readable = new Readable({ read() {} });
    // Drive via events on process.nextTick to give the reader time to subscribe.
    process.nextTick(() => {
        for (const c of chunks) readable.emit('data', c);
        if (emitError) readable.emit('error', new Error('stdin exploded'));
        if (emitEnd) readable.emit('end');
    });
    return readable;
}

function withStdin(stream, fn) {
    const orig = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { configurable: true, get: () => stream });
    return Promise.resolve(fn()).finally(() => {
        if (orig) Object.defineProperty(process, 'stdin', orig);
    });
}

// -----------------------------------------------------------------------------
// readHookInput — stdin semantics
// -----------------------------------------------------------------------------

describe('readHookInput', () => {
    it('resolves empty string when stdin is a TTY', async () => {
        const { readHookInput } = loadModule();
        const fakeTty = new Readable({ read() {} });
        fakeTty.isTTY = true;
        await withStdin(fakeTty, async () => {
            const result = await readHookInput();
            expect(result).toBe('');
        });
    });

    it('concatenates a single data chunk', async () => {
        const { readHookInput } = loadModule();
        const stream = makeStdin(['hello']);
        await withStdin(stream, async () => {
            const result = await readHookInput();
            expect(result).toBe('hello');
        });
    });

    it('concatenates multi-chunk stdin into one string', async () => {
        const { readHookInput } = loadModule();
        const stream = makeStdin(['{"a":', '1', '}']);
        await withStdin(stream, async () => {
            const result = await readHookInput();
            expect(result).toBe('{"a":1}');
        });
    });

    it('resolves empty string when stdin error event fires with no data', async () => {
        const { readHookInput } = loadModule();
        const stream = makeStdin([], { emitError: true, emitEnd: false });
        await withStdin(stream, async () => {
            const result = await readHookInput();
            expect(result).toBe('');
        });
    });

    it('resolves accumulated data on 1000ms timeout (default)', async () => {
        const { readHookInput } = loadModule();
        // Stream that never emits 'end' — only data.
        const stream = new Readable({ read() {} });
        process.nextTick(() => stream.emit('data', 'partial'));
        const start = Date.now();
        await withStdin(stream, async () => {
            const result = await readHookInput();
            const elapsed = Date.now() - start;
            expect(result).toBe('partial');
            expect(elapsed).toBeGreaterThanOrEqual(900);
            expect(elapsed).toBeLessThan(1500);
        });
    }, 2000);

    it('honors custom timeoutMs (500ms for memory-capture parity)', async () => {
        const { readHookInput } = loadModule();
        const stream = new Readable({ read() {} });
        process.nextTick(() => stream.emit('data', 'x'));
        const start = Date.now();
        await withStdin(stream, async () => {
            const result = await readHookInput({ timeoutMs: 500 });
            const elapsed = Date.now() - start;
            expect(result).toBe('x');
            expect(elapsed).toBeGreaterThanOrEqual(400);
            expect(elapsed).toBeLessThan(900);
        });
    }, 2000);

    it('disables timeout when timeoutMs is null', async () => {
        const { readHookInput } = loadModule();
        const stream = makeStdin(['done']);
        await withStdin(stream, async () => {
            const result = await readHookInput({ timeoutMs: null });
            expect(result).toBe('done');
        });
    });

    it('resolves accumulated data on 5000ms ceiling (blocking-hook parity: guardrail, path-guardrail, commit-guard, damage-control)', async () => {
        const { readHookInput } = loadModule();
        // Stream that never emits 'end' — only data. Proves the 5000ms ceiling
        // resolves with partial data rather than hanging past it. Fake timers
        // avoid a real 5s wait.
        const stream = new Readable({ read() {} });
        vi.useFakeTimers();
        try {
            await withStdin(stream, async () => {
                const promise = readHookInput({ timeoutMs: 5000 });
                stream.emit('data', 'partial');
                await vi.advanceTimersByTimeAsync(5000);
                const result = await promise;
                expect(result).toBe('partial');
            });
        } finally {
            vi.useRealTimers();
        }
    });

    // -------------------------------------------------------------------------
    // failClosedOnTimeout — the security-gate variant (finding 2). Abnormal
    // paths (error/timeout) REJECT; the clean-end path still resolves normally.
    // -------------------------------------------------------------------------

    it('failClosedOnTimeout: REJECTS on timeout instead of resolving with partial data', async () => {
        const { readHookInput } = loadModule();
        const stream = new Readable({ read() {} });
        vi.useFakeTimers();
        try {
            await withStdin(stream, async () => {
                const promise = readHookInput({ timeoutMs: 5000, failClosedOnTimeout: true });
                // Attach the rejection assertion BEFORE advancing the timer so the
                // catch handler is registered when the timeout fires — otherwise
                // the reject briefly reads as an unhandled rejection.
                const assertion = expect(promise).rejects.toThrow(/did not complete within 5000ms/);
                stream.emit('data', 'partial');
                await vi.advanceTimersByTimeAsync(5000);
                await assertion;
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('failClosedOnTimeout: REJECTS on a stream error instead of resolving empty', async () => {
        const { readHookInput } = loadModule();
        const stream = makeStdin([], { emitError: true, emitEnd: false });
        await withStdin(stream, async () => {
            await expect(readHookInput({ failClosedOnTimeout: true })).rejects.toThrow('stdin exploded');
        });
    });

    it('failClosedOnTimeout: still RESOLVES normally on a clean end (valid data)', async () => {
        const { readHookInput } = loadModule();
        const stream = makeStdin(['{"a":1}']);
        await withStdin(stream, async () => {
            const result = await readHookInput({ failClosedOnTimeout: true });
            expect(result).toBe('{"a":1}');
        });
    });

    it('failClosedOnTimeout: legitimate EMPTY stdin (clean end, no data) resolves "" — not a failure', async () => {
        const { readHookInput } = loadModule();
        const stream = makeStdin([]); // emits 'end' with no data
        await withStdin(stream, async () => {
            const result = await readHookInput({ failClosedOnTimeout: true });
            expect(result).toBe('');
        });
    });
});

// -----------------------------------------------------------------------------
// parseHookPayload
// -----------------------------------------------------------------------------

describe('parseHookPayload', () => {
    it('returns parsed object for valid JSON', () => {
        const { parseHookPayload } = loadModule();
        expect(parseHookPayload('{"x":1}')).toEqual({ x: 1 });
    });

    it('returns null on invalid JSON', () => {
        const { parseHookPayload } = loadModule();
        expect(parseHookPayload('{not json')).toBeNull();
    });

    it('returns null on empty string', () => {
        const { parseHookPayload } = loadModule();
        expect(parseHookPayload('')).toBeNull();
    });
});
