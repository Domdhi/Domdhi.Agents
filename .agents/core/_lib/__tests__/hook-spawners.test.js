// AC→source map (P1.5 / hook-spawners):
//   Exports: spawnDailyLogCapture(projectRoot, trigger, { spawn? })
//   spawn option is a test seam — production callers omit it.
//   Must: spawn 'node', path to daily-log.js, 'capture', '--trigger', trigger
//   Must: { stdio: 'ignore', cwd: projectRoot, windowsHide: true }, then child.unref()

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const path = require('node:path');
const { spawnDailyLogCapture } = require('../../../../.agents/core/_lib/hook-spawners');

let unrefStub;
let spawnStub;

beforeEach(() => {
    unrefStub = vi.fn();
    spawnStub = vi.fn(() => ({ unref: unrefStub }));
});

describe('spawnDailyLogCapture', () => {
    it('spawns node with the daily-log.js capture arguments', () => {
        spawnDailyLogCapture('/tmp/project', 'auto-stop', { spawn: spawnStub });
        expect(spawnStub).toHaveBeenCalledTimes(1);
        const [cmd, args] = spawnStub.mock.calls[0];
        expect(cmd).toBe('node');
        expect(args).toEqual([
            path.join('/tmp/project', '.claude', 'core', 'daily-log.js'),
            'capture',
            '--trigger',
            'auto-stop',
        ]);
    });

    it('passes windowsHide + stdio ignore + cwd projectRoot', () => {
        spawnDailyLogCapture('/tmp/project', 'compact', { spawn: spawnStub });
        const [, , options] = spawnStub.mock.calls[0];
        expect(options.stdio).toBe('ignore');
        expect(options.cwd).toBe('/tmp/project');
        expect(options.windowsHide).toBe(true);
    });

    it('calls child.unref() so the parent can exit', () => {
        spawnDailyLogCapture('/tmp/project', 'manual', { spawn: spawnStub });
        expect(unrefStub).toHaveBeenCalledTimes(1);
    });

    it('passes the trigger string through verbatim', () => {
        spawnDailyLogCapture('/tmp/project', 'custom-trigger', { spawn: spawnStub });
        const [, args] = spawnStub.mock.calls[0];
        expect(args[args.length - 1]).toBe('custom-trigger');
    });
});
