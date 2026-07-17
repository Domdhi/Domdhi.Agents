// AC→source map (TDD-3.6 / scaffold):
//   - scaffoldDir(srcDir, destDir, excludes, results, force) — pure helper, no side effects
//   - Template marker: <!-- @@template --> preserved verbatim as first line after copy
//   - Skip-existing: existing file untouched when force=false; results.skipped captures it
//   - Force overwrite: existing file replaced when force=true; results.created captures it
//   - Root config copy: root template files land at destDir (project root equiv)
//   - Cross-platform: path.join used everywhere; no hardcoded forward-slash separators in logic

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

const {
    scaffoldDir,
    runScaffold,
    parseSetArgs,
    applySubstitutions,
    KNOWN_SCAFFOLD_VARS,
    SKILL_TEMPLATE_MANIFEST,
    applyManagedBlock,
} = require('../scaffold');
const { createTmpDir } = require('./_helpers/tmp-dir');

// Symlink-capability probe — Windows checkouts without Developer Mode cannot
// create symlinks; skip rather than fail there (mirrors fs-safe.test.js).
const canSymlink = (() => {
    const probeDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'symlink-probe-'));
    try {
        fs.writeFileSync(path.join(probeDir, 't.txt'), 'x');
        fs.symlinkSync(path.join(probeDir, 't.txt'), path.join(probeDir, 'l.txt'));
        return true;
    } catch {
        return false;
    } finally {
        fs.rmSync(probeDir, { recursive: true, force: true });
    }
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal results accumulator that scaffoldDir expects. */
function makeResults() {
    return { created: [], skipped: [], directories: [] };
}

let tmp;

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'scaffold-test-' });
});

afterEach(() => {
    tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Fresh directory — templates copied with marker preserved
// ---------------------------------------------------------------------------

describe('scaffoldDir — fresh destination', () => {
    it('freshDir_copiesFileToDestination', () => {
        // Arrange
        tmp.write('src/hello.md', 'Hello world');
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, [], results, false);

        // Assert
        const destFile = path.join(dest, 'hello.md');
        expect(fs.existsSync(destFile)).toBe(true);
        expect(fs.readFileSync(destFile, 'utf8')).toBe('Hello world');
    });

    it('freshDir_createsDestinationDirectory', () => {
        // Arrange — dest does not exist yet
        tmp.write('src/a.md', 'content');
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'newdir');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, [], results, false);

        // Assert
        expect(fs.existsSync(dest)).toBe(true);
        expect(results.directories.length).toBeGreaterThan(0);
    });

    it('freshDir_recordsCreatedFile', () => {
        // Arrange
        tmp.write('src/file.md', 'data');
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, [], results, false);

        // Assert
        expect(results.created.length).toBe(1);
        expect(results.skipped.length).toBe(0);
    });

    it('freshDir_recursiveSubdir_copiesNestedFiles', () => {
        // Arrange
        tmp.write('src/sub/nested.md', '# Nested');
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, [], results, false);

        // Assert
        const destNested = path.join(dest, 'sub', 'nested.md');
        expect(fs.existsSync(destNested)).toBe(true);
        expect(fs.readFileSync(destNested, 'utf8')).toBe('# Nested');
    });

    it('freshDir_multipleFiles_allCopied', () => {
        // Arrange
        tmp.write('src/a.md', 'A');
        tmp.write('src/b.md', 'B');
        tmp.write('src/c.md', 'C');
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, [], results, false);

        // Assert
        expect(results.created.length).toBe(3);
        expect(fs.existsSync(path.join(dest, 'a.md'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'b.md'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'c.md'))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Template marker preservation
// ---------------------------------------------------------------------------

describe('scaffoldDir — template marker preservation', () => {
    it('templateMarker_firstLinePreservedAfterCopy', () => {
        // Arrange: source file starts with the template marker
        const marker = '<!-- @@template -->';
        tmp.write('src/doc.md', `${marker}\n# Doc Title\n\nContent here.\n`);
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, [], results, false);

        // Assert: first line of copied file is the exact marker
        const copied = fs.readFileSync(path.join(dest, 'doc.md'), 'utf8');
        const firstLine = copied.split('\n')[0];
        expect(firstLine).toBe(marker);
    });

    it('templateMarker_fullContentUnchangedAfterCopy', () => {
        // Arrange
        const content = '<!-- @@template -->\n# Title\n\nBody content.\n';
        tmp.write('src/template.md', content);
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, [], results, false);

        // Assert: content is byte-for-byte identical
        const copied = fs.readFileSync(path.join(dest, 'template.md'), 'utf8');
        expect(copied).toBe(content);
    });

    it('templateMarker_fileWithoutMarker_copiedNormally', () => {
        // Arrange: file that does NOT start with the marker
        tmp.write('src/regular.md', '# Regular File\n\nNo marker here.\n');
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, [], results, false);

        // Assert: file copied, first line is NOT the template marker
        const copied = fs.readFileSync(path.join(dest, 'regular.md'), 'utf8');
        expect(copied.startsWith('<!-- @@template -->')).toBe(false);
        expect(copied).toContain('# Regular File');
    });
});

// ---------------------------------------------------------------------------
// Skip-existing (force=false)
// ---------------------------------------------------------------------------

describe('scaffoldDir — skip existing files (force=false)', () => {
    it('skipExisting_existingFile_notOverwritten', () => {
        // Arrange: pre-write dest file with different content
        tmp.write('src/foo.md', 'new content from template');
        tmp.write('dest/foo.md', 'original content');
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, [], results, false);

        // Assert: dest file unchanged
        const destContent = fs.readFileSync(path.join(dest, 'foo.md'), 'utf8');
        expect(destContent).toBe('original content');
    });

    it('skipExisting_existingFile_recordedInSkipped', () => {
        // Arrange
        tmp.write('src/foo.md', 'template content');
        tmp.write('dest/foo.md', 'existing content');
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, [], results, false);

        // Assert
        expect(results.skipped.length).toBe(1);
        expect(results.created.length).toBe(0);
    });

    it('skipExisting_mixedNewAndExisting_correctlyCategorized', () => {
        // Arrange: one new file, one existing
        tmp.write('src/new.md', 'new');
        tmp.write('src/existing.md', 'template version');
        tmp.write('dest/existing.md', 'original');
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, [], results, false);

        // Assert
        expect(results.created.length).toBe(1);
        expect(results.skipped.length).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Force overwrite (force=true)
// ---------------------------------------------------------------------------

describe('scaffoldDir — force overwrite (force=true)', () => {
    it('force_existingFile_overwrittenWithTemplateContent', () => {
        // Arrange
        tmp.write('src/foo.md', 'new template content');
        tmp.write('dest/foo.md', 'old content');
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, [], results, true);

        // Assert: dest now has template content
        const destContent = fs.readFileSync(path.join(dest, 'foo.md'), 'utf8');
        expect(destContent).toBe('new template content');
    });

    it('force_existingFile_recordedInCreatedNotSkipped', () => {
        // Arrange
        tmp.write('src/foo.md', 'template');
        tmp.write('dest/foo.md', 'old');
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, [], results, true);

        // Assert
        expect(results.created.length).toBe(1);
        expect(results.skipped.length).toBe(0);
    });

    it('force_false_existingNotOverwritten', () => {
        // Arrange
        tmp.write('src/bar.md', 'template');
        tmp.write('dest/bar.md', 'keep me');
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act — force=false (the default skip behavior)
        scaffoldDir(src, dest, [], results, false);

        // Assert
        const destContent = fs.readFileSync(path.join(dest, 'bar.md'), 'utf8');
        expect(destContent).toBe('keep me');
    });
});

// ---------------------------------------------------------------------------
// Excludes
// ---------------------------------------------------------------------------

describe('scaffoldDir — excludes', () => {
    it('excludes_entryInExcludeList_notCopied', () => {
        // Arrange
        tmp.write('src/include.md', 'yes');
        tmp.write('src/root/skip.md', 'no');
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, ['root'], results, false);

        // Assert: 'root' subdir was skipped
        expect(fs.existsSync(path.join(dest, 'root'))).toBe(false);
        expect(fs.existsSync(path.join(dest, 'include.md'))).toBe(true);
    });

    it('excludes_emptyArray_copiesEverything', () => {
        // Arrange
        tmp.write('src/a.md', 'A');
        tmp.write('src/b/c.md', 'C');
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, [], results, false);

        // Assert
        expect(fs.existsSync(path.join(dest, 'a.md'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'b', 'c.md'))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Root config copy — .gitignore lands at destDir
// ---------------------------------------------------------------------------

describe('scaffoldDir — root config copy', () => {
    it('rootConfig_gitignore_copiedToProjectRoot', () => {
        // Arrange: mimic .claude/templates/root/ with a .gitignore
        const gitignoreContent = 'node_modules/\n.DS_Store\n';
        tmp.write('rootTemplates/.gitignore', gitignoreContent);

        const rootTemplatesDir = path.join(tmp.root, 'rootTemplates');
        const projectRoot = path.join(tmp.root, 'project');
        fs.mkdirSync(projectRoot, { recursive: true });

        const results = makeResults();

        // Act: scaffold rootTemplates/ → projectRoot/ (same as root template copy in main())
        scaffoldDir(rootTemplatesDir, projectRoot, [], results, false);

        // Assert
        const destGitignore = path.join(projectRoot, '.gitignore');
        expect(fs.existsSync(destGitignore)).toBe(true);
        expect(fs.readFileSync(destGitignore, 'utf8')).toBe(gitignoreContent);
    });

    it('rootConfig_multipleRootFiles_allCopied', () => {
        // Arrange: mimic root templates with multiple files
        tmp.write('rootTemplates/.gitignore', 'node_modules/\n');
        tmp.write('rootTemplates/README.md', '# README');

        const rootTemplatesDir = path.join(tmp.root, 'rootTemplates');
        const projectRoot = path.join(tmp.root, 'project');
        fs.mkdirSync(projectRoot, { recursive: true });

        const results = makeResults();

        // Act
        scaffoldDir(rootTemplatesDir, projectRoot, [], results, false);

        // Assert
        expect(fs.existsSync(path.join(projectRoot, '.gitignore'))).toBe(true);
        expect(fs.existsSync(path.join(projectRoot, 'README.md'))).toBe(true);
        expect(results.created.length).toBe(2);
    });

    it('rootConfig_gitignoreExistingSkippedByDefault', () => {
        // Arrange: project already has a .gitignore
        tmp.write('rootTemplates/.gitignore', 'template version');
        tmp.write('project/.gitignore', 'project version — keep me');

        const rootTemplatesDir = path.join(tmp.root, 'rootTemplates');
        const projectRoot = path.join(tmp.root, 'project');

        const results = makeResults();

        // Act — force=false
        scaffoldDir(rootTemplatesDir, projectRoot, [], results, false);

        // Assert: project .gitignore unchanged
        const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
        expect(content).toBe('project version — keep me');
        expect(results.skipped.length).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Cross-platform: path.join usage — no hardcoded forward-slash separators
// ---------------------------------------------------------------------------

describe('scaffoldDir — cross-platform path correctness', () => {
    it('crossPlatform_resultPathsUseOSSeparator', () => {
        // Arrange
        tmp.write('src/deep/file.md', 'content');
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, [], results, false);

        // Assert: paths in results use path.join (OS-correct separator)
        // They should NOT contain forward-slash on Windows as a path separator
        // within the relative portion (path.relative gives OS separators).
        // The simplest cross-platform check: reconstruct with path.join and compare.
        for (const p of [...results.created, ...results.skipped, ...results.directories]) {
            // Verify the path is reconstructable via path.normalize without change
            expect(p).toBe(path.normalize(p));
        }
    });

    it('crossPlatform_destFileAccessibleViaPathJoin', () => {
        // Arrange
        tmp.write('src/nested/doc.md', '# Doc');
        const src = path.join(tmp.root, 'src');
        const dest = path.join(tmp.root, 'dest');
        const results = makeResults();

        // Act
        scaffoldDir(src, dest, [], results, false);

        // Assert: file is accessible through path.join construction
        const expectedPath = path.join(dest, 'nested', 'doc.md');
        expect(fs.existsSync(expectedPath)).toBe(true);
        expect(fs.readFileSync(expectedPath, 'utf8')).toBe('# Doc');
    });
});

// ---------------------------------------------------------------------------
// Module require-safety: importing scaffold does not execute side effects
// ---------------------------------------------------------------------------

describe('scaffold module — require safety', () => {
    it('requireSafety_importDoesNotThrow', () => {
        // This test verifies that require('../scaffold') does not execute
        // top-level side effects (console.log, process.exit, file writes).
        // If it DID, this test would fail with a console error or exit.
        // The fact that scaffoldDir is already imported at the top of this
        // file without error proves require-safety.
        expect(typeof scaffoldDir).toBe('function');
    });

    it('requireSafety_exportsScaffoldDir', () => {
        // Verify the named export exists and is the function
        const mod = require('../scaffold');
        expect(mod).toHaveProperty('scaffoldDir');
        expect(typeof mod.scaffoldDir).toBe('function');
    });
});

// ─── R10 — --set <key>=<value> non-interactive substitution ──────────────────

describe('parseSetArgs (R10)', () => {

    it('parseSetArgs_singleFlag_returnsOneEntry', () => {
        const result = parseSetArgs(['--set', 'project_name=Foo']);
        expect(result).toEqual({ project_name: 'Foo' });
    });

    it('parseSetArgs_multipleFlags_accumulates', () => {
        const result = parseSetArgs([
            '--set', 'project_name=Foo',
            '--set', 'phase=Discovery',
        ]);
        expect(result).toEqual({ project_name: 'Foo', phase: 'Discovery' });
    });

    it('parseSetArgs_equalsForm_accepted', () => {
        const result = parseSetArgs(['--set=project_name=Foo']);
        expect(result).toEqual({ project_name: 'Foo' });
    });

    it('parseSetArgs_valueWithEquals_handledCorrectly', () => {
        // URL with query string contains additional `=` signs
        const url = 'https://example.com/?key=value&other=thing';
        const result = parseSetArgs(['--set', `repo_url=${url}`]);
        expect(result).toEqual({ repo_url: url });
    });

    it('parseSetArgs_unknownKey_throwsWithAllowlist', () => {
        expect(() => parseSetArgs(['--set', 'arbitrary_key=anything']))
            .toThrow(/arbitrary_key/);
        // Error message should include allowlist
        try {
            parseSetArgs(['--set', 'arbitrary_key=anything']);
        } catch (e) {
            expect(e.message).toMatch(/project_name/);
            expect(e.message).toMatch(/repo_url/);
        }
    });

    it('parseSetArgs_invalidUrl_throwsValidationMessage', () => {
        expect(() => parseSetArgs(['--set', 'repo_url=not-a-url']))
            .toThrow(/repo_url/);
    });

    it('parseSetArgs_invalidDate_throwsValidationMessage', () => {
        expect(() => parseSetArgs(['--set', 'date=tomorrow']))
            .toThrow(/date/);
    });

    it('parseSetArgs_emptyArgv_returnsEmptyObject', () => {
        expect(parseSetArgs([])).toEqual({});
    });

    it('parseSetArgs_noSetFlagMixedWithOthers_returnsEmptyObject', () => {
        // Other flags are ignored — only --set pairs are extracted
        expect(parseSetArgs(['--force', '--verbose'])).toEqual({});
    });

    it('parseSetArgs_setFlagWithoutValue_throws', () => {
        // --set with no following arg, or an arg that doesn't match key=value
        expect(() => parseSetArgs(['--set'])).toThrow();
        expect(() => parseSetArgs(['--set', 'no-equals-here'])).toThrow();
    });

});

describe('applySubstitutions (R10)', () => {

    it('applySubstitutions_singleVar_bothPlaceholdersReplaced', () => {
        const content = 'Project: {Project Name}\nKey: {project_name}';
        const result = applySubstitutions(content, { project_name: 'Foo' });
        expect(result).toBe('Project: Foo\nKey: Foo');
    });

    it('applySubstitutions_repoUrl_bothFormsReplaced', () => {
        const content = 'See {repo URL} or {repo_url} for details.';
        const result = applySubstitutions(content, { repo_url: 'https://example.com' });
        expect(result).toBe('See https://example.com or https://example.com for details.');
    });

    it('applySubstitutions_noSubstitutions_returnsContentUnchanged', () => {
        const content = 'Project: {Project Name}';
        expect(applySubstitutions(content, {})).toBe(content);
    });

    it('applySubstitutions_unknownKey_silentlyIgnored', () => {
        // Defensive: never reachable via parseSetArgs (which validates), but the
        // pure function should no-op rather than throw on stray keys.
        const content = 'unchanged: {Project Name}';
        const result = applySubstitutions(content, { not_in_allowlist: 'x' });
        expect(result).toBe(content);
    });

    it('applySubstitutions_emptyContent_returnsEmpty', () => {
        expect(applySubstitutions('', { project_name: 'Foo' })).toBe('');
    });

});

describe('KNOWN_SCAFFOLD_VARS (R10)', () => {

    it('KNOWN_SCAFFOLD_VARS_exported_andValidShape', () => {
        expect(Array.isArray(KNOWN_SCAFFOLD_VARS)).toBe(true);
        expect(KNOWN_SCAFFOLD_VARS.length).toBeGreaterThan(0);

        for (const entry of KNOWN_SCAFFOLD_VARS) {
            expect(entry).toHaveProperty('key');
            expect(typeof entry.key).toBe('string');
            expect(entry).toHaveProperty('placeholders');
            expect(Array.isArray(entry.placeholders)).toBe(true);
            expect(entry.placeholders.length).toBeGreaterThan(0);
            expect(entry).toHaveProperty('validate');
            expect(typeof entry.validate).toBe('function');
        }
    });

    it('KNOWN_SCAFFOLD_VARS_includesCoreKeys', () => {
        const keys = KNOWN_SCAFFOLD_VARS.map(v => v.key);
        expect(keys).toContain('project_name');
        expect(keys).toContain('repo_url');
        expect(keys).toContain('phase');
        expect(keys).toContain('date');
    });

});

describe('runScaffold with substitutions (R10 end-to-end)', () => {

    function makeMinimalTemplateTree(tmpRoot) {
        // Create a minimal templates/ tree mirroring the real scaffold structure
        // enough that runScaffold can exercise substitution end-to-end.
        const templatesDir = path.join(tmpRoot, '.claude', 'templates');
        fs.mkdirSync(path.join(templatesDir, 'product'), { recursive: true });
        fs.writeFileSync(
            path.join(templatesDir, 'product/context.md'),
            '<!-- @@template -->\n# Project: {Project Name}\nPhase: {current phase}\nDate: {YYYY-MM-DD}\n'
        );
    }

    it('runScaffold_withSubstitutions_filesContainSubstitutedValues', () => {
        // Arrange
        makeMinimalTemplateTree(tmp.root);

        // Act
        runScaffold(tmp.root, {
            substitutions: { project_name: 'Foo', phase: 'Discovery', date: '2026-05-10' },
            silent: true,
        });

        // Assert — scaffolded file has substitutions applied
        const written = fs.readFileSync(
            path.join(tmp.root, 'docs', 'product/context.md'),
            'utf8'
        );
        expect(written).toContain('# Project: Foo');
        expect(written).toContain('Phase: Discovery');
        expect(written).toContain('Date: 2026-05-10');
        expect(written).not.toContain('{Project Name}');
        expect(written).not.toContain('{current phase}');
    });

    it('runScaffold_substitutionsButTargetExists_doesNotModify', () => {
        // Arrange — pre-existing target with custom user content
        makeMinimalTemplateTree(tmp.root);
        fs.mkdirSync(path.join(tmp.root, 'docs', 'product'), { recursive: true });
        const userCustomized = '# My Custom Project\nDo not overwrite this.\n';
        fs.writeFileSync(
            path.join(tmp.root, 'docs', 'product/context.md'),
            userCustomized
        );

        // Act
        runScaffold(tmp.root, {
            substitutions: { project_name: 'Foo' },
            silent: true,
        });

        // Assert — pre-existing file untouched (existing skip semantics preserved)
        const written = fs.readFileSync(
            path.join(tmp.root, 'docs', 'product/context.md'),
            'utf8'
        );
        expect(written).toBe(userCustomized);
        expect(written).not.toContain('Foo');
    });

    it('runScaffold_noSubstitutions_currentBehaviorPreserved', () => {
        // Regression guard — without --set, placeholders remain as-is
        makeMinimalTemplateTree(tmp.root);

        runScaffold(tmp.root, { silent: true });

        const written = fs.readFileSync(
            path.join(tmp.root, 'docs', 'product/context.md'),
            'utf8'
        );
        expect(written).toContain('{Project Name}');
        expect(written).toContain('{current phase}');
        expect(written).toContain('{YYYY-MM-DD}');
    });

});

// ---------------------------------------------------------------------------
// SKILL_TEMPLATE_MANIFEST — scaffold seeds docs/ from skill-owned assets
// (TM-1.1). Additive: exercises the manifest copy loop in runScaffold.
// ---------------------------------------------------------------------------

describe('runScaffold — SKILL_TEMPLATE_MANIFEST (skill-owned templates)', () => {

    const MARKER = '<!-- @@template -->';

    /**
     * Create the minimal `.claude/templates/` dir runScaffold needs to not
     * throw TEMPLATES_MISSING. Holds a single no-owner template so the
     * scaffoldDir pass has something to do but never collides with a manifest
     * target.
     */
    function makeTemplatesDir(tmpRoot) {
        const templatesDir = path.join(tmpRoot, '.claude', 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(
            path.join(templatesDir, 'CLAUDE.md'),
            `${MARKER}\n# Docs guide\n`
        );
    }

    /**
     * Write a synthetic skill asset at the project-root-relative `from` path of
     * a manifest entry, with marker-prefixed content. Returns the content.
     */
    function writeAsset(tmpRoot, fromRel, body) {
        const abs = path.join(tmpRoot, fromRel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const content = `${MARKER}\n${body}\n`;
        fs.writeFileSync(abs, content);
        return content;
    }

    it('manifest assets are copied to their docs/ targets with source content', () => {
        makeTemplatesDir(tmp.root);
        const design = writeAsset(
            tmp.root,
            '.claude/skills/ux-design/assets/spec.md',
            '# Design {Project Name}'
        );
        const arch = writeAsset(
            tmp.root,
            '.claude/skills/architecture/assets/overview.md',
            '# Architecture'
        );
        const backlog = writeAsset(
            tmp.root,
            '.claude/skills/project-planning/assets/backlog.md',
            '# Backlog'
        );

        runScaffold(tmp.root, { silent: true });

        // Manifest targets land in their domain folders (ADR domain taxonomy)
        const designOut = path.join(tmp.root, 'docs', 'design/spec.md');
        const archOut = path.join(tmp.root, 'docs', 'architecture/overview.md');
        const backlogOut = path.join(tmp.root, 'docs', 'work', 'backlog.md');

        expect(fs.existsSync(designOut)).toBe(true);
        expect(fs.existsSync(archOut)).toBe(true);
        expect(fs.existsSync(backlogOut)).toBe(true);
        expect(fs.readFileSync(designOut, 'utf8')).toBe(design);
        expect(fs.readFileSync(archOut, 'utf8')).toBe(arch);
        expect(fs.readFileSync(backlogOut, 'utf8')).toBe(backlog);
    });

    it('scaffolded manifest artifact retains the @@template first line', () => {
        makeTemplatesDir(tmp.root);
        writeAsset(
            tmp.root,
            '.claude/skills/project-planning/assets/context.md',
            '# Context'
        );

        runScaffold(tmp.root, { silent: true });

        const out = path.join(tmp.root, 'docs', 'product/context.md');
        const firstLine = fs.readFileSync(out, 'utf8').split('\n')[0];
        expect(firstLine).toBe(MARKER);
    });

    it('a manifest entry whose source does not exist is silently skipped (graceful degradation)', () => {
        // No skill assets written at all — only the templates dir exists.
        makeTemplatesDir(tmp.root);

        // Should not throw, and no manifest targets should be produced.
        expect(() => runScaffold(tmp.root, { silent: true })).not.toThrow();

        for (const entry of SKILL_TEMPLATE_MANIFEST) {
            const out = path.join(tmp.root, 'docs', entry.to);
            expect(fs.existsSync(out)).toBe(false);
        }
    });

    it('scaffolds the domain-taxonomy folder tree (ADR docs/ Domain Taxonomy)', () => {
        makeTemplatesDir(tmp.root);
        runScaffold(tmp.root, { silent: true });
        // The fixed domain folders an agent can navigate with zero search.
        const domainDirs = [
            'modules',
            'architecture/decisions',
            'engineering',
            'operations/runbooks',
            'reference',
            'work', 'work/todo',
            '.output', '.output/.state/work',
        ];
        for (const d of domainDirs) {
            expect(fs.existsSync(path.join(tmp.root, 'docs', d))).toBe(true);
        }
    });

    it('skip-if-exists: a pre-existing manifest target is not overwritten without force', () => {
        makeTemplatesDir(tmp.root);
        writeAsset(
            tmp.root,
            '.claude/skills/architecture/assets/overview.md',
            '# New from asset'
        );
        const out = path.join(tmp.root, 'docs', 'architecture/overview.md');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const userContent = '# User edited — keep me\n';
        fs.writeFileSync(out, userContent);

        const results = runScaffold(tmp.root, { silent: true });

        expect(fs.readFileSync(out, 'utf8')).toBe(userContent);
        expect(results.skipped).toContain(path.join('docs', 'architecture/overview.md'));
    });

    it('--force overwrites a pre-existing manifest target with the asset content', () => {
        makeTemplatesDir(tmp.root);
        const asset = writeAsset(
            tmp.root,
            '.claude/skills/architecture/assets/overview.md',
            '# New from asset'
        );
        const out = path.join(tmp.root, 'docs', 'architecture/overview.md');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, '# stale\n');

        const results = runScaffold(tmp.root, { force: true, silent: true });

        expect(fs.readFileSync(out, 'utf8')).toBe(asset);
        expect(results.created).toContain(path.join('docs', 'architecture/overview.md'));
    });

    it('manifest substitution applies --set values to copied assets', () => {
        makeTemplatesDir(tmp.root);
        writeAsset(
            tmp.root,
            '.claude/skills/ux-design/assets/spec.md',
            '# Design {Project Name}'
        );

        runScaffold(tmp.root, { substitutions: { project_name: 'Acme' }, silent: true });

        const out = path.join(tmp.root, 'docs', 'design/spec.md');
        const written = fs.readFileSync(out, 'utf8');
        expect(written).toContain('# Design Acme');
        expect(written).not.toContain('{Project Name}');
    });

});

// ---------------------------------------------------------------------------
// Symlinked docs/ ancestor refused (MINOR — scaffold.js:311 containRoot anchor)
//
// scaffoldDir's ancestor guard only inspects directories STRICTLY BETWEEN
// dirname(dest) and containRoot. Before the fix, runScaffold's docs/
// scaffoldDir call passed no containRoot, so it defaulted to destDir (docsDir)
// itself — meaning a symlinked docs/ top-level dir was never lstat-checked
// (it WAS the root, not strictly-between). Anchoring containRoot to `target`
// (the project root, an ancestor of docs/) closes that gap.
// ---------------------------------------------------------------------------

describe.skipIf(!canSymlink)('runScaffold — symlinked docs/ ancestor refused (containRoot anchor)', () => {
    /** Minimal templates/ tree so runScaffold doesn't throw TEMPLATES_MISSING. */
    function makeMinimalTemplatesDir(tmpRoot) {
        const templatesDir = path.join(tmpRoot, '.claude', 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(
            path.join(templatesDir, 'CLAUDE.md'),
            '<!-- @@template -->\n# Docs guide\n'
        );
    }

    it('refuses to scaffold through a symlinked docs/ directory, leaving the external target empty', () => {
        // Arrange: project root's docs/ is a SYMLINK pointing OUTSIDE the project tree.
        makeMinimalTemplatesDir(tmp.root);
        const externalDir = path.join(tmp.root, 'external-outside-project');
        fs.mkdirSync(externalDir, { recursive: true });
        const docsLink = path.join(tmp.root, 'docs');
        fs.symlinkSync(externalDir, docsLink, 'dir');

        // Act / Assert: scaffold refuses rather than writing through the symlink.
        expect(() => runScaffold(tmp.root, { silent: true })).toThrow(/symlinked ancestor/);

        // Assert: the external target the symlink points at received NOTHING.
        expect(fs.readdirSync(externalDir)).toEqual([]);
        // The symlink itself must remain a symlink — refusal happens before any
        // unlink-and-replace step ever runs against it.
        expect(fs.lstatSync(docsLink).isSymbolicLink()).toBe(true);
    });

    it('normal (non-symlink) docs/ scaffold is unaffected by the containRoot anchor', () => {
        // Arrange: ordinary project root, no symlinks anywhere.
        makeMinimalTemplatesDir(tmp.root);

        // Act
        const results = runScaffold(tmp.root, { silent: true });

        // Assert: docs/ scaffolded normally, file created with source content.
        const destFile = path.join(tmp.root, 'docs', 'CLAUDE.md');
        expect(fs.existsSync(destFile)).toBe(true);
        expect(fs.readFileSync(destFile, 'utf8')).toBe('<!-- @@template -->\n# Docs guide\n');
        expect(results.created).toContain(path.join('docs', 'CLAUDE.md'));
    });
});

// ---------------------------------------------------------------------------
// gitignore managed-block merge via runScaffold (TEMPLATE_RENAMES path)
//
// REGRESSION: the shipped asset was once tracked as `.claude/templates/root/
// .gitignore` (dotted) while TEMPLATE_RENAMES reads the no-dot name `gitignore`.
// The merge loop did `if (!fs.existsSync(srcPath)) continue;` and silently
// skipped — so adopters' .gitignore never received the Domdhi managed block.
// The pre-existing tests only exercised scaffoldDir's direct-copy path with a
// dotted source, so they never caught it. These tests drive the real merge.
// ---------------------------------------------------------------------------

const MANAGED_START = '# === Domdhi.Agents managed block — do not edit between markers ===';

describe('runScaffold — gitignore managed-block merge', () => {
    /** Seed a templates tree with a root/gitignore (no-dot, as shipped). */
    function seedGitignoreTemplate(tmpRoot, content) {
        const rootDir = path.join(tmpRoot, '.claude', 'templates', 'root');
        fs.mkdirSync(rootDir, { recursive: true });
        fs.writeFileSync(path.join(rootDir, 'gitignore'), content);
    }

    it('brownfield_existingGitignore_managedBlockAppendedAndOriginalPreserved', () => {
        // Arrange — adopter already has a .gitignore; template adds Domdhi rules
        seedGitignoreTemplate(tmp.root, 'docs/.output/.state/\n.claude/agent-memory/\n');
        const original = '# adopter rules\nnode_modules/\n.env\n';
        fs.writeFileSync(path.join(tmp.root, '.gitignore'), original);

        // Act
        runScaffold(tmp.root, { silent: true });

        // Assert — original preserved AND template merged into a managed block
        const merged = fs.readFileSync(path.join(tmp.root, '.gitignore'), 'utf8');
        expect(merged).toContain('# adopter rules');
        expect(merged).toContain('node_modules/');
        expect(merged).toContain(MANAGED_START);
        expect(merged).toContain('docs/.output/.state/');
        expect(merged).toContain('.claude/agent-memory/');
    });

    it('greenfield_noGitignore_createdWithManagedBlock', () => {
        // Arrange — no pre-existing .gitignore
        seedGitignoreTemplate(tmp.root, 'docs/.output/.state/\n');

        // Act
        runScaffold(tmp.root, { silent: true });

        // Assert — file created carrying the managed block + template content
        const created = fs.readFileSync(path.join(tmp.root, '.gitignore'), 'utf8');
        expect(created).toContain(MANAGED_START);
        expect(created).toContain('docs/.output/.state/');
    });

    it('missingRenameSource_recordsWarning_doesNotThrow', () => {
        // Arrange — a root/ dir exists but the declared `gitignore` source is
        // absent (the exact misconfiguration the dotted-name bug produced).
        const rootDir = path.join(tmp.root, '.claude', 'templates', 'root');
        fs.mkdirSync(rootDir, { recursive: true });
        fs.writeFileSync(path.join(rootDir, 'placeholder.txt'), 'x');

        // Act
        let results;
        expect(() => { results = runScaffold(tmp.root, { silent: true }); }).not.toThrow();

        // Assert — surfaced as a warning rather than silently swallowed
        expect(results.warnings).toBeDefined();
        expect(results.warnings.join('\n')).toMatch(/gitignore/);
    });
});

// ---------------------------------------------------------------------------
// applyManagedBlock — { dryRun } previews the action without touching disk
// (consumed by template-updater's --dry-run gitignore preview).
// ---------------------------------------------------------------------------

describe('applyManagedBlock — dryRun', () => {
    it('returns "created" for a missing target without writing it', () => {
        const target = path.join(tmp.root, '.gitignore');
        const action = applyManagedBlock(target, 'rule/\n', { dryRun: true });
        expect(action).toBe('created');
        expect(fs.existsSync(target)).toBe(false);
    });

    it('returns "appended" without writing when no managed block exists', () => {
        const target = path.join(tmp.root, '.gitignore');
        fs.writeFileSync(target, 'node_modules/\n');
        const action = applyManagedBlock(target, 'rule/\n', { dryRun: true });
        expect(action).toBe('appended');
        expect(fs.readFileSync(target, 'utf8')).toBe('node_modules/\n'); // untouched
    });

    it('returns "replaced" without writing when content differs', () => {
        const target = path.join(tmp.root, '.gitignore');
        const existing = `${MANAGED_START}\nold/\n# === End Domdhi.Agents managed block ===\n`;
        fs.writeFileSync(target, existing);
        const action = applyManagedBlock(target, 'new/\n', { dryRun: true });
        expect(action).toBe('replaced');
        expect(fs.readFileSync(target, 'utf8')).toBe(existing); // untouched
    });

    it('still writes when dryRun is not set (regression guard)', () => {
        const target = path.join(tmp.root, '.gitignore');
        const action = applyManagedBlock(target, 'rule/\n');
        expect(action).toBe('created');
        expect(fs.readFileSync(target, 'utf8')).toContain('rule/');
    });
});

// ---------------------------------------------------------------------------
// Shipped-asset name guard — locks in the no-dot filename so the dotted-name
// regression cannot return. Operates on the REAL repo template, not a tmp tree.
// ---------------------------------------------------------------------------

describe('shipped gitignore template asset', () => {
    it('isNamed_gitignore_notDotGitignore', () => {
        const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
        const rootDir = path.join(repoRoot, '.claude', 'templates', 'root');
        expect(fs.existsSync(path.join(rootDir, 'gitignore'))).toBe(true);
        // A dotted file here would (a) be missed by TEMPLATE_RENAMES and (b) act
        // as an active gitignore for the template dir, hiding sibling templates.
        expect(fs.existsSync(path.join(rootDir, '.gitignore'))).toBe(false);
    });
});
