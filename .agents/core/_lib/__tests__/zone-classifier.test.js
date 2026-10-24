// AC→source map (P2.2 / zone-classifier):
//   Exports: globToRegex(pattern), matchesAnyGlob(relPath, globs), classifyClaudeFile(relPath)
//   globToRegex — verbatim port from template-updater.js:40 (Windows \ normalization MUST be preserved)
//   classifyClaudeFile returns: 'template' | 'project' | 'project-exception' | 'mixed' | 'unknown'
//   Zone data (PROJECT_FILES, PROJECT_EXCEPTIONS, TEMPLATE_GLOBS, MIXED_GLOBS) lives in this module

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { globToRegex, matchesAnyGlob, classifyClaudeFile } = require('../../../../.agents/core/_lib/zone-classifier');

// ─────────────────────────────────────────────────────────────────────────────
// globToRegex
// ─────────────────────────────────────────────────────────────────────────────

describe('globToRegex', () => {
    describe('*.md (single-star — no slashes)', () => {
        it('matches a flat file', () => {
            const re = globToRegex('*.md');
            expect(re.test('foo.md')).toBe(true);
        });

        it('rejects a nested path', () => {
            const re = globToRegex('*.md');
            expect(re.test('foo/bar.md')).toBe(false);
        });

        it('rejects non-md extension', () => {
            const re = globToRegex('*.md');
            expect(re.test('foo.js')).toBe(false);
        });
    });

    describe('**/*.md (double-star — any depth)', () => {
        it('matches a flat file', () => {
            const re = globToRegex('**/*.md');
            expect(re.test('foo.md')).toBe(true);
        });

        it('matches a nested file', () => {
            const re = globToRegex('**/*.md');
            expect(re.test('foo/bar.md')).toBe(true);
        });

        it('matches a deeply nested file', () => {
            const re = globToRegex('**/*.md');
            expect(re.test('a/b/c/file.md')).toBe(true);
        });

        it('rejects non-md extension', () => {
            const re = globToRegex('**/*.md');
            expect(re.test('foo/bar.js')).toBe(false);
        });
    });

    describe('agents/*.md (directory prefix + single-star)', () => {
        it('matches a direct child', () => {
            const re = globToRegex('agents/*.md');
            expect(re.test('agents/forge.md')).toBe(true);
        });

        it('rejects a nested child', () => {
            const re = globToRegex('agents/*.md');
            expect(re.test('agents/subdir/forge.md')).toBe(false);
        });

        it('rejects a wrong directory', () => {
            const re = globToRegex('agents/*.md');
            expect(re.test('commands/forge.md')).toBe(false);
        });
    });

    describe('commands/**/*.md (double-star mid-pattern)', () => {
        it('matches a direct child', () => {
            const re = globToRegex('commands/**/*.md');
            expect(re.test('commands/build.md')).toBe(true);
        });

        it('matches a nested child', () => {
            const re = globToRegex('commands/**/*.md');
            expect(re.test('commands/review/code-review.md')).toBe(true);
        });

        it('rejects a different prefix', () => {
            const re = globToRegex('commands/**/*.md');
            expect(re.test('skills/code-reviewer/SKILL.md')).toBe(false);
        });
    });

    describe('Windows backslash normalization (load-bearing)', () => {
        it('normalizes backslashes in pattern before matching', () => {
            // Pattern with backslash should still work
            const re = globToRegex('agents\\*.md');
            expect(re.test('agents/forge.md')).toBe(true);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// matchesAnyGlob
// ─────────────────────────────────────────────────────────────────────────────

describe('matchesAnyGlob', () => {
    it('returns true when the path matches at least one glob', () => {
        expect(matchesAnyGlob('agents/forge.md', ['agents/*.md', 'skills/**/*'])).toBe(true);
    });

    it('returns false when the path matches no glob', () => {
        expect(matchesAnyGlob('settings.json', ['agents/*.md', 'commands/**/*.md'])).toBe(false);
    });

    it('returns false for an empty globs array', () => {
        expect(matchesAnyGlob('agents/forge.md', [])).toBe(false);
    });

    it('normalizes backslashes in relPath before matching', () => {
        expect(matchesAnyGlob('agents\\forge.md', ['agents/*.md'])).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyClaudeFile
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyClaudeFile', () => {
    // Template zone
    it('classifies commands/*.md as template', () => {
        expect(classifyClaudeFile('commands/do.md')).toBe('template');
    });

    it('classifies commands/**/*.md as template', () => {
        expect(classifyClaudeFile('commands/review/code-review.md')).toBe('template');
    });

    it('classifies core/*.js as template', () => {
        expect(classifyClaudeFile('core/gate.js')).toBe('template');
    });

    it('classifies hooks/*.cjs as template', () => {
        expect(classifyClaudeFile('hooks/secret-scanner.cjs')).toBe('template');
    });

    // Regression (Dispatch port-back 2026-06-02): single-star core/*.js and
    // hooks/*.cjs silently skipped subdirectories, so core/_lib/ never synced
    // to downstreams after the library split. Globs widened to **.
    it('classifies core/_lib/*.js as template (was skipped under single-star)', () => {
        expect(classifyClaudeFile('core/_lib/model-runner.js')).toBe('template');
    });

    it('classifies a nested core/_lib file as template', () => {
        expect(classifyClaudeFile('core/_lib/zone-classifier.js')).toBe('template');
    });

    it('classifies skills/**/* as template', () => {
        expect(classifyClaudeFile('skills/qa-engineer/SKILL.md')).toBe('template');
    });

    it('classifies skills-optional/**/* as template', () => {
        expect(classifyClaudeFile('skills-optional/minimalist-ui/SKILL.md')).toBe('template');
    });

    it('classifies version.json as template', () => {
        expect(classifyClaudeFile('version.json')).toBe('template');
    });

    it('classifies guardrail-rules.yaml as template', () => {
        expect(classifyClaudeFile('guardrail-rules.yaml')).toBe('template');
    });

    // Project zone
    it('classifies settings.json as project', () => {
        expect(classifyClaudeFile('settings.json')).toBe('project');
    });

    it('classifies settings.local.json as project', () => {
        expect(classifyClaudeFile('settings.local.json')).toBe('project');
    });

    // Project exception zone (subset of template globs but preserved)
    it('classifies the ghostwriting voice fingerprint as project-exception', () => {
        expect(classifyClaudeFile('skills/ghostwriting/references/_voice/fingerprint.md')).toBe('project-exception');
        expect(classifyClaudeFile('skills/ghostwriting/references/_voice/samples/a.md')).toBe('project-exception');
    });

    it('keeps the ghostwriting skill itself in the template zone', () => {
        expect(classifyClaudeFile('skills/ghostwriting/SKILL.md')).toBe('template');
    });

    it('classifies skills/brand-guidelines/SKILL.md as project-exception', () => {
        expect(classifyClaudeFile('skills/brand-guidelines/SKILL.md')).toBe('project-exception');
    });

    it('classifies skills/brand-guidelines/palette.md as project-exception', () => {
        expect(classifyClaudeFile('skills/brand-guidelines/palette.md')).toBe('project-exception');
    });

    it('classifies deeply nested brand-guidelines file as project-exception', () => {
        expect(classifyClaudeFile('skills/brand-guidelines/examples/logo-v1.png')).toBe('project-exception');
    });

    // Mixed zone
    it('classifies agents/*.md as mixed', () => {
        expect(classifyClaudeFile('agents/general-purpose.md')).toBe('mixed');
    });

    it('classifies agents/forge.md as mixed', () => {
        expect(classifyClaudeFile('agents/forge.md')).toBe('mixed');
    });

    // Unknown zone
    it('classifies an unmapped file as unknown', () => {
        expect(classifyClaudeFile('some-random-file.txt')).toBe('unknown');
    });

    // Windows backslash path normalization
    it('normalizes backslash paths on Windows', () => {
        expect(classifyClaudeFile('agents\\general-purpose.md')).toBe('mixed');
    });

    // Non-brand-guidelines skills subdir — must NOT be project-exception
    it('classifies non-brand-guidelines skills as template', () => {
        expect(classifyClaudeFile('skills/skill-authoring/anthropic-best-practices.md')).toBe('template');
    });

    it('classifies skills with nested references/ as template', () => {
        expect(classifyClaudeFile('skills/playwright-cli/references/tracing.md')).toBe('template');
    });

    // Regression (CR-2.4 F20): agents-optional/** was in NO bucket → classified
    // 'unknown' and was silently skipped by template-updater sync. install.js and
    // tools/publish.js already treat skills-optional/** and agents-optional/** as
    // parallel concepts (both excluded from scaffold/publish); zone-classifier must
    // classify them identically so they propagate the same way on sync.
    it('classifies agents-optional/**/* the same as skills-optional/**/* (F20)', () => {
        const skillsOptionalZone = classifyClaudeFile('skills-optional/minimalist-ui/SKILL.md');
        const agentsOptionalZone = classifyClaudeFile('agents-optional/foo.md');
        expect(agentsOptionalZone).toBe(skillsOptionalZone);
        expect(agentsOptionalZone).toBe('template');
    });

    it('classifies a nested agents-optional file as template (F20)', () => {
        expect(classifyClaudeFile('agents-optional/experimental/bar.md')).toBe('template');
    });

    // Regression (CR-2.4 F21): core/**/*.js was extension-restricted, unlike the
    // extension-agnostic skills/**/* and templates/**/*. Non-.js core files
    // (core/statusline.sh, core/package.json) classified 'unknown' and were
    // silently skipped by template-updater sync — they never reached onboarded
    // adopters. Widened to core/**/* (extension-agnostic).
    it('classifies core/statusline.sh as template (F21)', () => {
        expect(classifyClaudeFile('core/statusline.sh')).toBe('template');
    });

    it('classifies core/package.json as template (F21)', () => {
        expect(classifyClaudeFile('core/package.json')).toBe('template');
    });

    it('still classifies core/*.js and nested core/_lib/*.js as template (no regression)', () => {
        expect(classifyClaudeFile('core/gate.js')).toBe('template');
        expect(classifyClaudeFile('core/_lib/zone-classifier.js')).toBe('template');
    });
});
