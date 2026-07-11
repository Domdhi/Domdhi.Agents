// AC→source map (TDD-3.4 / template-updater):
//   - classifyClaudeFile returns: 'template' | 'project' | 'project-exception' | 'mixed' | 'unknown'
//   - parseAgentSections returns: { frontmatter, soulZone, skillsZone, projectCtx }
//   - mergeAgentFile: personalized dest preserves soulZone; skills always from src
//   - walkDir skips ALWAYS_SKIP_DIRS = ['__tests__', '_helpers', 'node_modules']
//   - --dry-run via runUpdate(path, { dryRun: true }) — walks + classifies, no writes
//   - globToRegex: *.md matches flat, **/*.md matches nested

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const updater = require('../template-updater');
const { createTmpDir } = require('./_helpers/tmp-dir');

const {
  globToRegex,
  classifyClaudeFile,
  parseAgentSections,
  mergeAgentFile,
  walkDir,
  runUpdate,
  loadExcludedSkills,
  listSkillDirs,
} = updater;

const nodeFs = require('node:fs');

let tmp;

beforeEach(() => {
  tmp = createTmpDir();
});

afterEach(() => {
  tmp.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// globToRegex
// ─────────────────────────────────────────────────────────────────────────────

describe('globToRegex', () => {
  describe('*.md (single-star — no slashes)', () => {
    it('globToRegex_singleStar_matchesFlatFile', () => {
      const re = globToRegex('*.md');
      expect(re.test('foo.md')).toBe(true);
    });

    it('globToRegex_singleStar_rejectsNestedPath', () => {
      const re = globToRegex('*.md');
      expect(re.test('foo/bar.md')).toBe(false);
    });

    it('globToRegex_singleStar_rejectsNonMdExtension', () => {
      const re = globToRegex('*.md');
      expect(re.test('foo.js')).toBe(false);
    });
  });

  describe('**/*.md (double-star — matches any depth)', () => {
    it('globToRegex_doubleStar_matchesFlatFile', () => {
      const re = globToRegex('**/*.md');
      expect(re.test('foo.md')).toBe(true);
    });

    it('globToRegex_doubleStar_matchesNestedFile', () => {
      const re = globToRegex('**/*.md');
      expect(re.test('foo/bar.md')).toBe(true);
    });

    it('globToRegex_doubleStar_matchesDeeplyNestedFile', () => {
      const re = globToRegex('**/*.md');
      expect(re.test('a/b/c/file.md')).toBe(true);
    });

    it('globToRegex_doubleStar_rejectsNonMdExtension', () => {
      const re = globToRegex('**/*.md');
      expect(re.test('foo/bar.js')).toBe(false);
    });
  });

  describe('.claude/agents/*.md (directory prefix + single-star)', () => {
    it('globToRegex_dirPrefix_matchesCorrectNesting', () => {
      const re = globToRegex('agents/*.md');
      expect(re.test('agents/forge.md')).toBe(true);
    });

    it('globToRegex_dirPrefix_rejectsTooDeep', () => {
      const re = globToRegex('agents/*.md');
      expect(re.test('agents/subdir/forge.md')).toBe(false);
    });

    it('globToRegex_dirPrefix_rejectsWrongDir', () => {
      const re = globToRegex('agents/*.md');
      expect(re.test('commands/forge.md')).toBe(false);
    });
  });

  describe('commands/**/*.md (double-star mid-pattern)', () => {
    it('globToRegex_midDoubleStar_matchesDirectChild', () => {
      const re = globToRegex('commands/**/*.md');
      expect(re.test('commands/build.md')).toBe(true);
    });

    it('globToRegex_midDoubleStar_matchesNestedChild', () => {
      const re = globToRegex('commands/**/*.md');
      expect(re.test('commands/review/code-review.md')).toBe(true);
    });

    it('globToRegex_midDoubleStar_rejectsDifferentPrefix', () => {
      const re = globToRegex('commands/**/*.md');
      expect(re.test('skills/code-reviewer/SKILL.md')).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyClaudeFile
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyClaudeFile', () => {
  it('classifyClaudeFile_commandsMd_isTemplate', () => {
    expect(classifyClaudeFile('commands/do.md')).toBe('template');
  });

  it('classifyClaudeFile_commandsNestedMd_isTemplate', () => {
    expect(classifyClaudeFile('commands/review/code-review.md')).toBe('template');
  });

  it('classifyClaudeFile_coreJs_isTemplate', () => {
    expect(classifyClaudeFile('core/gate.js')).toBe('template');
  });

  it('classifyClaudeFile_hooksCjs_isTemplate', () => {
    expect(classifyClaudeFile('hooks/secret-scanner.cjs')).toBe('template');
  });

  it('classifyClaudeFile_skillsSKILL_isTemplate', () => {
    expect(classifyClaudeFile('skills/qa-engineer/SKILL.md')).toBe('template');
  });

  it('classifyClaudeFile_skillsOptional_isTemplate', () => {
    expect(classifyClaudeFile('skills-optional/minimalist-ui/SKILL.md')).toBe('template');
  });

  it('classifyClaudeFile_versionJson_isTemplate', () => {
    expect(classifyClaudeFile('version.json')).toBe('template');
  });

  it('classifyClaudeFile_guardrailYaml_isTemplate', () => {
    expect(classifyClaudeFile('guardrail-rules.yaml')).toBe('template');
  });

  it('classifyClaudeFile_settingsJson_isProject', () => {
    expect(classifyClaudeFile('settings.json')).toBe('project');
  });

  it('classifyClaudeFile_settingsLocalJson_isProject', () => {
    expect(classifyClaudeFile('settings.local.json')).toBe('project');
  });

  it('classifyClaudeFile_brandGuidelines_isProjectException', () => {
    expect(classifyClaudeFile('skills/brand-guidelines/SKILL.md')).toBe('project-exception');
  });

  it('classifyClaudeFile_brandGuidelinesSubdoc_isProjectException', () => {
    expect(classifyClaudeFile('skills/brand-guidelines/palette.md')).toBe('project-exception');
  });

  it('classifyClaudeFile_brandGuidelinesNestedSubdoc_isProjectException', () => {
    expect(classifyClaudeFile('skills/brand-guidelines/examples/logo-v1.png')).toBe('project-exception');
  });

  it('classifyClaudeFile_skillsReferencesMd_isTemplate', () => {
    expect(classifyClaudeFile('skills/skill-authoring/anthropic-best-practices.md')).toBe('template');
  });

  it('classifyClaudeFile_skillsReferencesSubdir_isTemplate', () => {
    expect(classifyClaudeFile('skills/playwright-cli/references/tracing.md')).toBe('template');
  });

  it('classifyClaudeFile_skillsReferenceTs_isTemplate', () => {
    expect(classifyClaudeFile('skills/systematic-debugging/references/condition-based-waiting-example.ts')).toBe('template');
  });

  it('classifyClaudeFile_skillsScriptsShellScript_isTemplate', () => {
    expect(classifyClaudeFile('skills/systematic-debugging/scripts/find-polluter.sh')).toBe('template');
  });

  it('classifyClaudeFile_agentMd_isMixed', () => {
    expect(classifyClaudeFile('agents/general-purpose.md')).toBe('mixed');
  });

  it('classifyClaudeFile_agentMdForge_isMixed', () => {
    expect(classifyClaudeFile('agents/forge.md')).toBe('mixed');
  });

  it('classifyClaudeFile_unknownFile_isUnknown', () => {
    expect(classifyClaudeFile('some-random-file.txt')).toBe('unknown');
  });

  it('classifyClaudeFile_backslashPath_normalizes', () => {
    // Windows paths with backslashes must still classify correctly
    expect(classifyClaudeFile('agents\\general-purpose.md')).toBe('mixed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAgentSections
// ─────────────────────────────────────────────────────────────────────────────

// Minimal fixture: full agent with all zones
const FIXTURE_PERSONALIZED = `---
name: general-purpose
nickname: Forge
model: sonnet
---

# Forge — General Purpose Developer

I am the one who builds.

## Skills

No default skills.

## Project Context

This project uses React and TypeScript.
`;

// Generic agent — no nickname
const FIXTURE_GENERIC = `---
name: code-reviewer
model: sonnet
---

# Code Reviewer

I review code thoroughly.

## Skills

code-reviewer, code-review-playbook
`;

// Agent without Project Context
const FIXTURE_NO_PROJECT_CTX = `---
name: doc-writer
model: haiku
---

# Doc Writer

I document things.

## Skills

documentation
`;

// Agent with no frontmatter
const FIXTURE_NO_FRONTMATTER = `# Bare Agent

Just some content without a frontmatter block.

## Skills

some-skill
`;

describe('parseAgentSections', () => {
  it('parseAgentSections_personalized_extractsFrontmatter', () => {
    const result = parseAgentSections(FIXTURE_PERSONALIZED);
    expect(result.frontmatter).toContain('name: general-purpose');
    expect(result.frontmatter).toContain('nickname: Forge');
    // No --- delimiters
    expect(result.frontmatter).not.toContain('---');
  });

  it('parseAgentSections_personalized_extractsSoulZone', () => {
    const result = parseAgentSections(FIXTURE_PERSONALIZED);
    expect(result.soulZone).toContain('# Forge — General Purpose Developer');
    expect(result.soulZone).toContain('I am the one who builds');
    // Soul zone does NOT include ## Skills heading
    expect(result.soulZone).not.toContain('## Skills');
  });

  it('parseAgentSections_personalized_extractsSkillsZone', () => {
    const result = parseAgentSections(FIXTURE_PERSONALIZED);
    expect(result.skillsZone).toContain('## Skills');
    expect(result.skillsZone).toContain('No default skills');
    // Skills zone does NOT bleed into projectCtx
    expect(result.skillsZone).not.toContain('## Project Context');
  });

  it('parseAgentSections_personalized_extractsProjectCtx', () => {
    const result = parseAgentSections(FIXTURE_PERSONALIZED);
    expect(result.projectCtx).toContain('## Project Context');
    expect(result.projectCtx).toContain('React and TypeScript');
  });

  it('parseAgentSections_generic_hasEmptyNickname', () => {
    const result = parseAgentSections(FIXTURE_GENERIC);
    expect(result.frontmatter).not.toContain('nickname');
  });

  it('parseAgentSections_noProjectCtx_returnsEmptyString', () => {
    const result = parseAgentSections(FIXTURE_NO_PROJECT_CTX);
    expect(result.projectCtx).toBe('');
  });

  it('parseAgentSections_noFrontmatter_entireBodyIsSoulZone', () => {
    const result = parseAgentSections(FIXTURE_NO_FRONTMATTER);
    expect(result.frontmatter).toBe('');
    expect(result.soulZone).toContain('# Bare Agent');
    expect(result.soulZone).toContain('Just some content');
  });

  it('parseAgentSections_noFrontmatter_skillsZoneStillParsed', () => {
    const result = parseAgentSections(FIXTURE_NO_FRONTMATTER);
    expect(result.skillsZone).toContain('## Skills');
    expect(result.skillsZone).toContain('some-skill');
  });

  it('parseAgentSections_crlfNormalized', () => {
    // CRLF line endings should not break parsing
    const crlf = FIXTURE_PERSONALIZED.replace(/\n/g, '\r\n');
    const result = parseAgentSections(crlf);
    expect(result.frontmatter).toContain('nickname: Forge');
    expect(result.skillsZone).toContain('## Skills');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeAgentFile
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentFile', () => {
  it('mergeAgentFile_destMissing_copiesFile', () => {
    // Arrange
    const srcPath = tmp.write('src/agents/forge.md', FIXTURE_PERSONALIZED);
    const destPath = path.join(tmp.root, 'dest/agents/forge.md');
    // destPath does NOT exist

    // Act
    const result = mergeAgentFile(srcPath, destPath);

    // Assert — result.detail is the human-readable merge label (new API: { changed, detail })
    expect(result.detail).toContain('copied');
    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.readFileSync(destPath, 'utf8')).toContain('# Forge — General Purpose Developer');
  });

  it('mergeAgentFile_personalized_preservesSoulZone', () => {
    // Arrange: src has updated soul content; dest has personalized (nickname) soul
    const srcContent = `---
name: general-purpose
model: sonnet
---

# Forge — General Purpose Developer (UPDATED VERSION)

New soul content from template.

## Skills

updated-skill-list
`;

    const destContent = `---
name: general-purpose
nickname: Forge
model: sonnet
---

# Forge — My Custom Soul Zone

Custom description written by Dom.

## Skills

old-skill-list

## Project Context

This is my project context.
`;

    const srcPath = tmp.write('src/agents/general-purpose.md', srcContent);
    const destPath = tmp.write('dest/agents/general-purpose.md', destContent);

    // Act
    const result = mergeAgentFile(srcPath, destPath);

    // Assert
    const merged = fs.readFileSync(destPath, 'utf8');

    // Soul zone preserved from dest (personalized)
    expect(merged).toContain('Custom description written by Dom');
    expect(merged).not.toContain('UPDATED VERSION');

    // Skills zone from src
    expect(merged).toContain('updated-skill-list');
    expect(merged).not.toContain('old-skill-list');

    // Project context preserved from dest
    expect(merged).toContain('## Project Context');
    expect(merged).toContain('This is my project context');

    // nickname preserved in frontmatter
    expect(merged).toContain('nickname: Forge');

    expect(result.detail).toContain('merged');
  });

  it('mergeAgentFile_preservesBlankLineAfterFrontmatter', () => {
    // Regression — earlier bug: parseAgentSections stripped the leading blank line
    // after the closing `---`, and reassembly used a single `\n` between the
    // closing `---` and soul zone, producing `---\n# Heading` (no blank line).
    // Standard markdown convention is `---\n\n# Heading`.
    const srcContent = `---
name: architect
model: inherit
---

# Mason — System Architect

Body content here.

## Skills

- architecture
`;
    const srcPath = tmp.write('src/agents/architect.md', srcContent);
    const destPath = tmp.write('dest/agents/architect.md', srcContent);

    // Act
    mergeAgentFile(srcPath, destPath);

    // Assert — merged file MUST have a blank line between `---` and the next heading
    const merged = fs.readFileSync(destPath, 'utf8');
    expect(merged).toContain('---\n\n# Mason — System Architect');
    expect(merged).not.toContain('---\n# Mason — System Architect');
  });

  it('mergeAgentFile_notPersonalized_overwritesSoulZone', () => {
    // Arrange: dest has no nickname — generic install
    const srcContent = `---
name: code-reviewer
model: sonnet
---

# Code Reviewer (NEW TEMPLATE)

Updated reviewer soul.

## Skills

code-reviewer-v2
`;

    const destContent = `---
name: code-reviewer
model: sonnet
---

# Code Reviewer (OLD)

Old reviewer soul.

## Skills

code-reviewer-v1
`;

    const srcPath = tmp.write('src/agents/code-reviewer.md', srcContent);
    const destPath = tmp.write('dest/agents/code-reviewer.md', destContent);

    // Act
    mergeAgentFile(srcPath, destPath);

    // Assert
    const merged = fs.readFileSync(destPath, 'utf8');

    // Soul zone overwritten (not personalized)
    expect(merged).toContain('NEW TEMPLATE');
    expect(merged).not.toContain('OLD');

    // Skills from src
    expect(merged).toContain('code-reviewer-v2');
  });

  it('mergeAgentFile_preservesFrontmatterNicknameAndAliases', () => {
    const srcContent = `---
name: doc-writer
model: haiku
---

# Doc Writer

Write docs.

## Skills

documentation
`;

    const destContent = `---
name: doc-writer
nickname: Penny
aliases: [penny, doc]
model: haiku
---

# Penny — Doc Writer

Custom doc writer.

## Skills

old-docs
`;

    const srcPath = tmp.write('src/agents/doc-writer.md', srcContent);
    const destPath = tmp.write('dest/agents/doc-writer.md', destContent);

    mergeAgentFile(srcPath, destPath);

    const merged = fs.readFileSync(destPath, 'utf8');
    expect(merged).toContain('nickname: Penny');
    expect(merged).toContain('aliases: [penny, doc]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// walkDir
// ─────────────────────────────────────────────────────────────────────────────

describe('walkDir', () => {
  it('walkDir_flatDir_returnsAllFiles', () => {
    tmp.write('flat/a.md', 'a');
    tmp.write('flat/b.js', 'b');
    tmp.write('flat/c.cjs', 'c');

    const results = walkDir(path.join(tmp.root, 'flat'));
    const names = results.map(f => path.basename(f)).sort();
    expect(names).toEqual(['a.md', 'b.js', 'c.cjs']);
  });

  it('walkDir_nested_returnsFilesRecursively', () => {
    tmp.write('tree/a.md', 'a');
    tmp.write('tree/sub/b.md', 'b');
    tmp.write('tree/sub/deep/c.md', 'c');

    const results = walkDir(path.join(tmp.root, 'tree'));
    expect(results).toHaveLength(3);
  });

  it('walkDir_skipsTestsDir', () => {
    tmp.write('proj/__tests__/foo.test.js', 'test');
    tmp.write('proj/real.js', 'real');

    const results = walkDir(path.join(tmp.root, 'proj'));
    const names = results.map(f => path.basename(f));
    expect(names).toContain('real.js');
    expect(names).not.toContain('foo.test.js');
  });

  it('walkDir_skipsHelpersDir', () => {
    tmp.write('proj/_helpers/helper.js', 'helper');
    tmp.write('proj/main.js', 'main');

    const results = walkDir(path.join(tmp.root, 'proj'));
    const names = results.map(f => path.basename(f));
    expect(names).toContain('main.js');
    expect(names).not.toContain('helper.js');
  });

  it('walkDir_skipsNodeModules', () => {
    tmp.write('proj/node_modules/dep/index.js', 'dep');
    tmp.write('proj/src/index.js', 'src');

    const results = walkDir(path.join(tmp.root, 'proj'));
    // Assert explicit paths — count-based checks can pass if node_modules leaks a same-named file
    expect(results).toContain(path.join(tmp.root, 'proj', 'src', 'index.js'));
    expect(results).not.toContain(path.join(tmp.root, 'proj', 'node_modules', 'dep', 'index.js'));
  });

  it('walkDir_allSkippedDirsTogether_noneLeakThrough', () => {
    tmp.write('proj/__tests__/test.js', 't');
    tmp.write('proj/_helpers/util.js', 'u');
    tmp.write('proj/node_modules/pkg/index.js', 'n');
    tmp.write('proj/legit/real.js', 'r');

    const results = walkDir(path.join(tmp.root, 'proj'));
    // Assert by explicit path membership — order-independent and leak-sensitive
    expect(results).toContain(path.join(tmp.root, 'proj', 'legit', 'real.js'));
    expect(results).not.toContain(path.join(tmp.root, 'proj', '__tests__', 'test.js'));
    expect(results).not.toContain(path.join(tmp.root, 'proj', '_helpers', 'util.js'));
    expect(results).not.toContain(path.join(tmp.root, 'proj', 'node_modules', 'pkg', 'index.js'));
    expect(results).toHaveLength(1);
  });

  it('walkDir_nonexistentDir_returnsEmptyArray', () => {
    const results = walkDir(path.join(tmp.root, 'does-not-exist'));
    expect(results).toEqual([]);
  });

  it('walkDir_returnsAbsolutePaths', () => {
    tmp.write('proj/file.md', 'content');
    const results = walkDir(path.join(tmp.root, 'proj'));
    expect(results[0]).toBe(path.join(tmp.root, 'proj', 'file.md'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// --dry-run (runUpdate with { dryRun: true })
// ─────────────────────────────────────────────────────────────────────────────

describe('runUpdate dry-run', () => {
  /**
   * Build a minimal fake source .claude/ + target .claude/ in tmp.
   * The source must look like PROJECT_ROOT — template-updater reads from
   * process.env.CLAUDE_PROJECT_DIR (or __dirname/../..).
   * We redirect CLAUDE_PROJECT_DIR to our tmp source dir.
   */
  let originalProjectDir;

  beforeEach(() => {
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    if (originalProjectDir === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    }
  });

  it('dryRun_writesNoFiles', () => {
    // Arrange: create a minimal source layout
    const srcRoot = tmp.mkdir('src');
    // A template-zone file
    tmp.write('src/.claude/core/gate.js', '// gate stub');
    // A project-zone file
    tmp.write('src/.claude/settings.json', '{}');

    // Create the target with an existing .claude/ dir
    const targetRoot = tmp.mkdir('target');
    tmp.mkdir('target/.claude');

    // Point CLAUDE_PROJECT_DIR at our fake source root
    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');

    // Spy on console.log to verify dry-run output (optional)
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Act
    runUpdate(path.join(tmp.root, 'target'), { dryRun: true });

    // Assert: target .claude/core/gate.js was NOT written
    const destGate = path.join(tmp.root, 'target', '.claude', 'core', 'gate.js');
    expect(fs.existsSync(destGate)).toBe(false);

    spy.mockRestore();
  });

  it('dryRun_logsWouldCopyMessage', () => {
    // Arrange
    const srcRoot = tmp.mkdir('src');
    tmp.write('src/.claude/core/gate.js', '// gate stub');

    const targetRoot = tmp.mkdir('target');
    tmp.mkdir('target/.claude');

    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');

    const logged = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
    });

    // Act
    runUpdate(path.join(tmp.root, 'target'), { dryRun: true });

    spy.mockRestore();

    // Assert: at least one log line mentions COPY or DRY RUN
    const hasDryRunHeader = logged.some(l => l.includes('DRY RUN'));
    expect(hasDryRunHeader).toBe(true);
  });

  it('dryRun_doesNotWriteSkippedDirs', () => {
    // Arrange: source has files in __tests__ that walkDir would skip
    const srcRoot = tmp.mkdir('src');
    tmp.write('src/.claude/__tests__/foo.test.js', 'test');
    tmp.write('src/.claude/core/real.js', '// real');

    tmp.mkdir('target');
    tmp.mkdir('target/.claude');

    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    runUpdate(path.join(tmp.root, 'target'), { dryRun: true });

    spy.mockRestore();

    // Neither the test file nor the real file should be written in dry-run
    expect(fs.existsSync(path.join(tmp.root, 'target', '.claude', '__tests__', 'foo.test.js'))).toBe(false);
    expect(fs.existsSync(path.join(tmp.root, 'target', '.claude', 'core', 'real.js'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-project skill exclusion (update-config.json → skillExclude)
// ─────────────────────────────────────────────────────────────────────────────

describe('loadExcludedSkills', () => {
  it('returns empty set when update-config.json is absent', () => {
    const claudeDir = tmp.mkdir('t1/.claude');
    expect(loadExcludedSkills(claudeDir).size).toBe(0);
  });

  it('reads the skillExclude array', () => {
    tmp.mkdir('t2/.claude');
    tmp.write('t2/.claude/update-config.json', JSON.stringify({ skillExclude: ['tailwind-css-patterns', 'redesign-existing-projects'] }));
    const set = loadExcludedSkills(path.join(tmp.root, 't2', '.claude'));
    expect(set.has('tailwind-css-patterns')).toBe(true);
    expect(set.has('redesign-existing-projects')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('returns empty set (no throw) on malformed JSON', () => {
    tmp.mkdir('t3/.claude');
    tmp.write('t3/.claude/update-config.json', '{ not valid json');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const set = loadExcludedSkills(path.join(tmp.root, 't3', '.claude'));
    spy.mockRestore();
    expect(set.size).toBe(0);
  });

  it('returns empty set when skillExclude is missing or not an array', () => {
    tmp.mkdir('t4/.claude');
    tmp.write('t4/.claude/update-config.json', JSON.stringify({ skillExclude: 'tailwind' }));
    expect(loadExcludedSkills(path.join(tmp.root, 't4', '.claude')).size).toBe(0);
  });
});

describe('runUpdate — skill exclusion', () => {
  let originalProjectDir;
  beforeEach(() => { originalProjectDir = process.env.CLAUDE_PROJECT_DIR; });
  afterEach(() => {
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  });

  it('skips an excluded skill but copies others', () => {
    // Source ships two skills
    tmp.write('src/.claude/skills/tailwind-css-patterns/SKILL.md', '# tailwind');
    tmp.write('src/.claude/skills/architecture/SKILL.md', '# architecture');
    // Target opts out of tailwind
    tmp.mkdir('target/.claude');
    tmp.write('target/.claude/update-config.json', JSON.stringify({ skillExclude: ['tailwind-css-patterns'] }));

    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runUpdate(path.join(tmp.root, 'target'), {});
    spy.mockRestore();

    const twPath = path.join(tmp.root, 'target', '.claude', 'skills', 'tailwind-css-patterns', 'SKILL.md');
    const awPath = path.join(tmp.root, 'target', '.claude', 'skills', 'architecture', 'SKILL.md');
    expect(fs.existsSync(twPath)).toBe(false);   // excluded — not copied
    expect(fs.existsSync(awPath)).toBe(true);    // not excluded — copied
  });

  it('copies all skills when no update-config.json exists', () => {
    tmp.write('src/.claude/skills/tailwind-css-patterns/SKILL.md', '# tailwind');
    tmp.mkdir('target/.claude');

    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runUpdate(path.join(tmp.root, 'target'), {});
    spy.mockRestore();

    const twPath = path.join(tmp.root, 'target', '.claude', 'skills', 'tailwind-css-patterns', 'SKILL.md');
    expect(fs.existsSync(twPath)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE.md → .claude/README.md redirect (template documentation, not project doc)
// ─────────────────────────────────────────────────────────────────────────────

describe('runUpdate — CLAUDE.md handling', () => {
  let originalProjectDir;

  beforeEach(() => { originalProjectDir = process.env.CLAUDE_PROJECT_DIR; });
  afterEach(() => {
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  });

  it('runUpdate_writesSourceClaudeMdToTargetClaudeReadme', () => {
    // Arrange — source has CLAUDE.md (template documentation)
    tmp.mkdir('src/.claude');
    tmp.write('src/CLAUDE.md', '# Template Documentation\n\nDescribes the template.');

    tmp.mkdir('target');
    tmp.mkdir('target/.claude');

    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Act
    runUpdate(path.join(tmp.root, 'target'), {});
    spy.mockRestore();

    // Assert — written to .claude/README.md, not root CLAUDE.md
    const readmePath = path.join(tmp.root, 'target', '.claude', 'README.md');
    expect(fs.existsSync(readmePath)).toBe(true);
    expect(fs.readFileSync(readmePath, 'utf8')).toContain('# Template Documentation');
  });

  it('runUpdate_doesNotTouchTargetRootClaudeMd', () => {
    // Arrange — target already has its own root CLAUDE.md (project-specific)
    tmp.mkdir('src/.claude');
    tmp.write('src/CLAUDE.md', '# Template Documentation');

    tmp.mkdir('target/.claude');
    const projectClaudeMd = '# My Project\n\nProject-specific instructions.';
    tmp.write('target/CLAUDE.md', projectClaudeMd);

    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Act
    runUpdate(path.join(tmp.root, 'target'), {});
    spy.mockRestore();

    // Assert — target's root CLAUDE.md is untouched
    const targetRootClaude = fs.readFileSync(path.join(tmp.root, 'target', 'CLAUDE.md'), 'utf8');
    expect(targetRootClaude).toBe(projectClaudeMd);
  });

  it('runUpdate_doesNotEmitMergeMessageForClaudeMd', () => {
    // Arrange — make sure --merge does NOT trigger any CLAUDE.md merge log
    tmp.mkdir('src/.claude');
    tmp.write('src/CLAUDE.md', '# Template');

    tmp.mkdir('target/.claude');
    tmp.write('target/CLAUDE.md', '# Project');

    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');

    const logged = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
    });

    // Act — even with --merge, root CLAUDE.md should not appear in any merge line
    runUpdate(path.join(tmp.root, 'target'), { merge: true });
    spy.mockRestore();

    // Assert — no log line mentions merging CLAUDE.md (the bare root file)
    const claudeMdMerges = logged.filter(l => /MERGE\s+CLAUDE\.md/.test(l));
    expect(claudeMdMerges).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Active root .gitignore — managed-block merge from templates/root/gitignore
// (template-updater previously synced only the inert template copy, so v4.63's
// "untrack docs/.output/.state/" rule never reached existing adopters.)
// ─────────────────────────────────────────────────────────────────────────────

describe('runUpdate — root .gitignore managed block', () => {
  const START = '# === Domdhi.Agents managed block — do not edit between markers ===';
  const END   = '# === End Domdhi.Agents managed block ===';
  let originalProjectDir;

  beforeEach(() => { originalProjectDir = process.env.CLAUDE_PROJECT_DIR; });
  afterEach(() => {
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  });

  const run = (opts) => {
    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runUpdate(path.join(tmp.root, 'target'), opts || {});
    spy.mockRestore();
  };
  const gi = () => path.join(tmp.root, 'target', '.gitignore');

  it('appends a managed block when the target .gitignore has none', () => {
    tmp.write('src/.claude/templates/root/gitignore', 'docs/.output/.state/\n');
    tmp.mkdir('target/.claude');
    tmp.write('target/.gitignore', 'node_modules/\nmy-custom-rule/\n');

    run({});

    const out = fs.readFileSync(gi(), 'utf8');
    expect(out).toContain('my-custom-rule/');          // adopter's own rules preserved
    expect(out).toContain(START);
    expect(out).toContain('docs/.output/.state/');   // new rule propagated
    expect(out).toContain(END);
  });

  it('replaces an existing managed block in place (idempotent refresh)', () => {
    tmp.write('src/.claude/templates/root/gitignore', 'docs/.output/.state/\nnew-rule/\n');
    tmp.mkdir('target/.claude');
    tmp.write(
      'target/.gitignore',
      `keep-me/\n${START}\nold-stale-rule/\n${END}\nalso-keep/\n`,
    );

    run({});

    const out = fs.readFileSync(gi(), 'utf8');
    expect(out).toContain('keep-me/');         // content before the block preserved
    expect(out).toContain('also-keep/');       // content after the block preserved
    expect(out).not.toContain('old-stale-rule/'); // stale block content replaced
    expect(out).toContain('new-rule/');        // refreshed with source content
    // exactly one managed block
    expect(out.split(START)).toHaveLength(2);
  });

  it('creates .gitignore when the target has none', () => {
    tmp.write('src/.claude/templates/root/gitignore', 'docs/.output/.state/\n');
    tmp.mkdir('target/.claude');

    run({});

    expect(fs.existsSync(gi())).toBe(true);
    expect(fs.readFileSync(gi(), 'utf8')).toContain('docs/.output/.state/');
  });

  it('does NOT write the .gitignore under --dry-run', () => {
    tmp.write('src/.claude/templates/root/gitignore', 'docs/.output/.state/\n');
    tmp.mkdir('target/.claude');
    tmp.write('target/.gitignore', 'node_modules/\n');

    run({ dryRun: true });

    // unchanged on disk — no managed block written
    expect(fs.readFileSync(gi(), 'utf8')).toBe('node_modules/\n');
  });

  it('is a no-op when the source ships no gitignore template', () => {
    // no src/.claude/templates/root/gitignore
    tmp.mkdir('src/.claude');
    tmp.mkdir('target/.claude');
    tmp.write('target/.gitignore', 'node_modules/\n');

    run({});

    expect(fs.readFileSync(gi(), 'utf8')).toBe('node_modules/\n'); // untouched
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Skill project-additions merge (template-zone escape hatch under --merge)
// ─────────────────────────────────────────────────────────────────────────────

describe('runUpdate skill --merge preserves project additions', () => {
  let originalProjectDir;
  beforeEach(() => { originalProjectDir = process.env.CLAUDE_PROJECT_DIR; });
  afterEach(() => {
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  });

  const MARKER = '<!-- @@project-additions -->';
  const SRC_SKILL = `---\nname: tailwind-css-patterns\n---\n\n# Tailwind\n\nTemplate body v2.\n`;

  function arrange() {
    tmp.mkdir('src/.claude');
    tmp.mkdir('target/.claude');
    tmp.write('src/.claude/skills/tailwind-css-patterns/SKILL.md', SRC_SKILL);
    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');
  }

  it('preserves the project-additions tail and refreshes the head under --merge', () => {
    arrange();
    const destRel = 'target/.claude/skills/tailwind-css-patterns/SKILL.md';
    tmp.write(destRel,
      `---\nname: tailwind-css-patterns\n---\n\n# Tailwind\n\nTemplate body v1.\n\n${MARKER}\n\n## Project Additions\n\nuses obsidian-void palette.\n`);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runUpdate(path.join(tmp.root, 'target'), { merge: true });
    spy.mockRestore();

    const out = fs.readFileSync(path.join(tmp.root, destRel), 'utf8');
    expect(out).toContain('Template body v2.');      // head refreshed
    expect(out).not.toContain('Template body v1.');
    expect(out).toContain('obsidian-void palette.');  // tail preserved
    expect(out.split(MARKER).length - 1).toBe(1);     // exactly one marker
  });

  it('overwrites a markerless skill (no project additions to keep)', () => {
    arrange();
    const destRel = 'target/.claude/skills/tailwind-css-patterns/SKILL.md';
    tmp.write(destRel, `---\nname: tailwind-css-patterns\n---\n\n# Tailwind\n\nTemplate body v1.\n`);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runUpdate(path.join(tmp.root, 'target'), { merge: true });
    spy.mockRestore();

    expect(fs.readFileSync(path.join(tmp.root, destRel), 'utf8')).toBe(SRC_SKILL);
  });

  it('without --merge, a skill with a tail is still overwritten (escape hatch is opt-in)', () => {
    arrange();
    const destRel = 'target/.claude/skills/tailwind-css-patterns/SKILL.md';
    tmp.write(destRel,
      `---\nname: tailwind-css-patterns\n---\n\n# Tailwind\n\nold.\n\n${MARKER}\n\nproject stuff.\n`);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runUpdate(path.join(tmp.root, 'target'), {}); // no merge
    spy.mockRestore();

    const out = fs.readFileSync(path.join(tmp.root, destRel), 'utf8');
    expect(out).toBe(SRC_SKILL);          // clobbered
    expect(out).not.toContain('project stuff.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listSkillDirs — counts symlinked skill dirs (the bespoke-skill-preservation fix)
// ─────────────────────────────────────────────────────────────────────────────

describe('listSkillDirs', () => {
  it('listSkillDirs_countsSymlinkedSkillDir', () => {
    // A real skill dir, a SYMLINKED skill dir (the shape adopters use for bespoke
    // skills into ../.agents/skills/), a loose file, and a broken symlink.
    tmp.write('skills/real-skill/SKILL.md', 'x');
    const linkTarget = tmp.mkdir('agents-skills/linked-skill');
    nodeFs.symlinkSync(linkTarget, path.join(tmp.root, 'skills/linked-skill'), 'dir');
    tmp.write('skills/loose-file.md', 'x');
    nodeFs.symlinkSync(path.join(tmp.root, 'nonexistent'), path.join(tmp.root, 'skills/broken-link'), 'dir');

    const result = listSkillDirs(path.join(tmp.root, 'skills'));
    expect(result.has('real-skill')).toBe(true);
    expect(result.has('linked-skill')).toBe(true);   // the fix: symlinked dir counts
    expect(result.has('loose-file.md')).toBe(false); // a file is not a skill dir
    expect(result.has('broken-link')).toBe(false);   // broken symlink guarded out
  });

  it('listSkillDirs_missingDir_returnsEmptySet', () => {
    const result = listSkillDirs(path.join(tmp.root, 'does-not-exist'));
    expect(result.size).toBe(0);
  });
});
