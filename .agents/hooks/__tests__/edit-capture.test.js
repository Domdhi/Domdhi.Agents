// AC→source map (TDD-5.6 / edit-capture):
//   - isCanonicalDoc: pure pattern match on CLAUDE.md, architecture doc, skills SKILL.md
//   - shouldCapture: profile gate (strict only) AND isCanonicalDoc
//   - processEvent: missing filePath → captured:false; empty old+new → captured:false
//   - processEvent: shouldCapture false → captured:false
//   - processEvent: hasTemplateMarker → captured:false
//   - processEvent: canonical doc + strict profile → calls DailyLog.captureNote, returns captured:true

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');
const { processEvent, shouldCapture, isCanonicalDoc } = require('../../../.agents/hooks/edit-capture.cjs');

// ---------------------------------------------------------------------------
// Env save/restore
// ---------------------------------------------------------------------------
const origMemoryProfile = process.env.MEMORY_PROFILE;
const origProjectDir = process.env.CLAUDE_PROJECT_DIR;

let tmp;

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'edit-capture-' });
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
});

afterEach(() => {
    tmp.cleanup();
    // Restore env
    if (origMemoryProfile === undefined) delete process.env.MEMORY_PROFILE;
    else process.env.MEMORY_PROFILE = origMemoryProfile;
});

afterAll(() => {
    if (origProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origProjectDir;
});

// ---------------------------------------------------------------------------
// isCanonicalDoc — pure pattern tests (no profile check)
// ---------------------------------------------------------------------------

describe('isCanonicalDoc', () => {
    it('isCanonicalDoc_claudeMd_returnsTrue', () => {
        expect(isCanonicalDoc('/some/project/CLAUDE.md')).toBe(true);
    });

    it('isCanonicalDoc_rootCLAUDE_returnsTrue', () => {
        expect(isCanonicalDoc('CLAUDE.md')).toBe(true);
    });

    it('isCanonicalDoc_architectureDoc_returnsTrue', () => {
        expect(isCanonicalDoc('/project/docs/architecture/overview.md')).toBe(true);
    });

    it('isCanonicalDoc_skillFile_returnsTrue', () => {
        expect(isCanonicalDoc('/project/.claude/skills/my-skill/SKILL.md')).toBe(true);
    });

    it('isCanonicalDoc_randomFile_returnsFalse', () => {
        expect(isCanonicalDoc('/project/src/app.js')).toBe(false);
    });

    it('isCanonicalDoc_randomMd_returnsFalse', () => {
        expect(isCanonicalDoc('/project/README.md')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// shouldCapture — profile × canonical path matrix
// ---------------------------------------------------------------------------

describe('shouldCapture', () => {
    it('shouldCapture_profileMinimal_returnsFalse', () => {
        process.env.MEMORY_PROFILE = 'minimal';
        expect(shouldCapture('/project/CLAUDE.md')).toBe(false);
    });

    it('shouldCapture_profileStandard_returnsFalse', () => {
        process.env.MEMORY_PROFILE = 'standard';
        expect(shouldCapture('/project/CLAUDE.md')).toBe(false);
    });

    it('shouldCapture_profileStrict_canonicalPath_returnsTrue', () => {
        process.env.MEMORY_PROFILE = 'strict';
        expect(shouldCapture('/project/CLAUDE.md')).toBe(true);
    });

    it('shouldCapture_profileStrict_nonCanonicalPath_returnsFalse', () => {
        process.env.MEMORY_PROFILE = 'strict';
        expect(shouldCapture('/project/src/utils.js')).toBe(false);
    });

    it('shouldCapture_profileStrict_skillFile_returnsTrue', () => {
        process.env.MEMORY_PROFILE = 'strict';
        expect(shouldCapture('/project/.claude/skills/code-reviewer/SKILL.md')).toBe(true);
    });

    it('shouldCapture_profileStrict_architectureDoc_returnsTrue', () => {
        process.env.MEMORY_PROFILE = 'strict';
        expect(shouldCapture('/project/docs/architecture/overview.md')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// processEvent — early-exit paths
// ---------------------------------------------------------------------------

describe('processEvent_earlyExits', () => {
    it('processEvent_missingFilePath_returnsCapturedFalse', () => {
        process.env.MEMORY_PROFILE = 'strict';
        const result = processEvent({ tool_input: { old_string: 'old', new_string: 'new' } });
        expect(result).toEqual({ captured: false });
    });

    it('processEvent_bothStringsEmpty_returnsCapturedFalse', () => {
        process.env.MEMORY_PROFILE = 'strict';
        const result = processEvent({
            tool_input: { file_path: '/project/CLAUDE.md', old_string: '', new_string: '' }
        });
        expect(result).toEqual({ captured: false });
    });

    it('processEvent_nonCanonicalPath_returnsCapturedFalse', () => {
        process.env.MEMORY_PROFILE = 'strict';
        const result = processEvent({
            tool_input: { file_path: '/project/src/utils.js', old_string: 'old', new_string: 'new' }
        });
        expect(result).toEqual({ captured: false });
    });

    it('processEvent_profileNotStrict_returnsCapturedFalse', () => {
        process.env.MEMORY_PROFILE = 'standard';
        const result = processEvent({
            tool_input: { file_path: '/project/CLAUDE.md', old_string: 'old', new_string: 'new' }
        });
        expect(result).toEqual({ captured: false });
    });

    it('processEvent_templateMarker_returnsCapturedFalse', () => {
        process.env.MEMORY_PROFILE = 'strict';
        // Write a canonical doc with a template marker as the first line
        const claudeMdPath = tmp.write('CLAUDE.md', '<!-- @@template -->\n# Template Content\n');
        const result = processEvent({
            tool_input: { file_path: claudeMdPath, old_string: 'old', new_string: 'new' }
        });
        expect(result).toEqual({ captured: false });
    });
});

// ---------------------------------------------------------------------------
// processEvent — capture path with DailyLog mock
// ---------------------------------------------------------------------------

describe('processEvent_capture', () => {
    it('processEvent_strictProfile_canonicalDoc_capturesEdit', () => {
        const captureNoteMock = vi.fn();
        // Inject DailyLog mock via require.cache
        const dailyLogPath = require.resolve('../../../.agents/core/daily-log');
        require.cache[dailyLogPath] = {
            id: dailyLogPath,
            filename: dailyLogPath,
            exports: class DailyLog {
                constructor() {}
                captureNote(...args) { captureNoteMock(...args); }
            },
            loaded: true,
            children: [],
            paths: []
        };

        try {
            process.env.MEMORY_PROFILE = 'strict';
            const claudeMdPath = tmp.write('CLAUDE.md', '# Real CLAUDE.md\n');
            const result = processEvent({
                tool_input: {
                    file_path: claudeMdPath,
                    old_string: 'old content',
                    new_string: 'new content here'
                }
            });
            expect(result).toEqual({ captured: true });
            expect(captureNoteMock).toHaveBeenCalledOnce();
            // The note should reference the file
            const [noteArg] = captureNoteMock.mock.calls[0];
            expect(noteArg).toContain('CLAUDE.md');
        } finally {
            delete require.cache[dailyLogPath];
        }
    });

    it('processEvent_strictProfile_dailyLogThrows_returnsCapturedFalse', () => {
        // DailyLog that throws — processEvent should handle gracefully
        const dailyLogPath = require.resolve('../../../.agents/core/daily-log');
        require.cache[dailyLogPath] = {
            id: dailyLogPath,
            filename: dailyLogPath,
            exports: class DailyLog {
                constructor() {}
                captureNote() { throw new Error('DailyLog unavailable'); }
            },
            loaded: true,
            children: [],
            paths: []
        };

        try {
            process.env.MEMORY_PROFILE = 'strict';
            const claudeMdPath = tmp.write('CLAUDE.md', '# Real CLAUDE.md\n');
            // Should not throw — DailyLog failure is silenced
            const result = processEvent({
                tool_input: {
                    file_path: claudeMdPath,
                    old_string: 'old',
                    new_string: 'new'
                }
            });
            // Silenced DailyLog error → still captured:false since captureNote threw
            expect(result.captured).toBe(false);
        } finally {
            delete require.cache[dailyLogPath];
        }
    });
});

// ---------------------------------------------------------------------------
// module.exports shape
// ---------------------------------------------------------------------------

describe('moduleExports', () => {
    it('exports_hasProcessEvent', () => {
        expect(typeof processEvent).toBe('function');
    });

    it('exports_hasShouldCapture', () => {
        expect(typeof shouldCapture).toBe('function');
    });

    it('exports_hasIsCanonicalDoc', () => {
        expect(typeof isCanonicalDoc).toBe('function');
    });
});
