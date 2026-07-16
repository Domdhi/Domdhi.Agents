// AC→source map (P2.2 / agent-merger):
//   Exports: parseAgentSections(content), mergeFrontmatter(src, dst), mergeAgentFile(srcPath, dstPath, opts)
//   parseAgentSections — returns { frontmatter, soulZone, skillsZone, projectCtx }
//   mergeFrontmatter — src wins, but preserves nickname: and aliases: from dst
//   mergeAgentFile — if dst missing: copy; if personalized: preserve soulZone + projectCtx; skills always from src
//   mergeAgentFile returns { changed: boolean, diff?: string }

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');
const { parseAgentSections, mergeFrontmatter, mergeAgentFile, extractFieldBlock, stripExcludedSkills } = require('../agent-merger');

let tmp;

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'agent-merger-test-' });
});

afterEach(() => {
    tmp.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

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

const FIXTURE_GENERIC = `---
name: code-reviewer
model: sonnet
---

# Code Reviewer

I review code thoroughly.

## Skills

code-reviewer, code-review-playbook
`;

const FIXTURE_NO_PROJECT_CTX = `---
name: doc-writer
model: haiku
---

# Doc Writer

I document things.

## Skills

documentation
`;

const FIXTURE_NO_FRONTMATTER = `# Bare Agent

Just some content without a frontmatter block.

## Skills

some-skill
`;

// Shadow-shaped: intentionally omits ## Skills (shadow.md's convention — its prose
// persona is its own convention, not the ## Skills preload block) but still carries
// an adopter-added ## Project Context (F4).
const FIXTURE_SHADOW_WITH_PROJECT_CTX = `---
name: shadow
model: sonnet
---

# Shadow — Voice-Matched Ghostwriter

I write in your voice.

## Project Context

This project's blog targets a technical, skeptical audience.
`;

// ─────────────────────────────────────────────────────────────────────────────
// parseAgentSections
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAgentSections', () => {
    it('extracts frontmatter (without --- delimiters)', () => {
        const result = parseAgentSections(FIXTURE_PERSONALIZED);
        expect(result.frontmatter).toContain('name: general-purpose');
        expect(result.frontmatter).toContain('nickname: Forge');
        expect(result.frontmatter).not.toContain('---');
    });

    it('extracts soulZone (heading + body, excludes ## Skills)', () => {
        const result = parseAgentSections(FIXTURE_PERSONALIZED);
        expect(result.soulZone).toContain('# Forge — General Purpose Developer');
        expect(result.soulZone).toContain('I am the one who builds');
        expect(result.soulZone).not.toContain('## Skills');
    });

    it('extracts skillsZone (## Skills heading + body, excludes ## Project Context)', () => {
        const result = parseAgentSections(FIXTURE_PERSONALIZED);
        expect(result.skillsZone).toContain('## Skills');
        expect(result.skillsZone).toContain('No default skills');
        expect(result.skillsZone).not.toContain('## Project Context');
    });

    it('extracts projectCtx (## Project Context to end)', () => {
        const result = parseAgentSections(FIXTURE_PERSONALIZED);
        expect(result.projectCtx).toContain('## Project Context');
        expect(result.projectCtx).toContain('React and TypeScript');
    });

    it('returns empty projectCtx when section absent', () => {
        const result = parseAgentSections(FIXTURE_NO_PROJECT_CTX);
        expect(result.projectCtx).toBe('');
    });

    it('returns empty frontmatter when no --- block present', () => {
        const result = parseAgentSections(FIXTURE_NO_FRONTMATTER);
        expect(result.frontmatter).toBe('');
    });

    it('treats entire non-frontmatter body as soulZone when no --- present', () => {
        const result = parseAgentSections(FIXTURE_NO_FRONTMATTER);
        expect(result.soulZone).toContain('# Bare Agent');
        expect(result.soulZone).toContain('Just some content');
    });

    it('still parses skillsZone when there is no frontmatter', () => {
        const result = parseAgentSections(FIXTURE_NO_FRONTMATTER);
        expect(result.skillsZone).toContain('## Skills');
        expect(result.skillsZone).toContain('some-skill');
    });

    it('detects ## Project Context even when ## Skills is absent (shadow-shaped agent, F4)', () => {
        const result = parseAgentSections(FIXTURE_SHADOW_WITH_PROJECT_CTX);
        expect(result.skillsZone).toBe('');
        expect(result.projectCtx).toContain('## Project Context');
        expect(result.projectCtx).toContain('technical, skeptical audience');
        // Must NOT be folded into soulZone.
        expect(result.soulZone).not.toContain('## Project Context');
        expect(result.soulZone).not.toContain('technical, skeptical audience');
        expect(result.soulZone).toContain('I write in your voice');
    });

    it('normalizes CRLF line endings', () => {
        const crlf = FIXTURE_PERSONALIZED.replace(/\n/g, '\r\n');
        const result = parseAgentSections(crlf);
        expect(result.frontmatter).toContain('nickname: Forge');
        expect(result.skillsZone).toContain('## Skills');
    });

    it('has a blank line between --- and soul zone heading (regression)', () => {
        // Standard markdown: `---\n\n# Heading`, not `---\n# Heading`
        const result = parseAgentSections(FIXTURE_GENERIC);
        // soulZone starts with the two newlines so reassembly gives `---\n\n# Heading`
        expect(result.soulZone.startsWith('\n\n# Code Reviewer')).toBe(true);
    });

    // Regression (CR-2.4 F0): a `## Skills` / `## Project Context` heading that
    // appears INSIDE a fenced code block in the soul zone (a doc example) must NOT
    // be treated as a real section boundary. skill-merger.js already solved this
    // identical hazard with scanFenceState() — parseAgentSections must be equally
    // fence-aware, or a soul-zone code fence showing "## Skills" as example text
    // truncates the merge (soulZone ends early; the real ## Skills body is lost).
    const FIXTURE_FENCED_HEADING_IN_SOUL = `---
name: general-purpose
nickname: Forge
model: sonnet
---

# Forge — General Purpose Developer

I read before I write. Here's an example of a section heading in another agent:

\`\`\`markdown
## Skills

This is just example text inside a fence, not a real section boundary.
\`\`\`

That was just an example, not a real heading.

## Skills

- systematic-debugging
- verification-before-completion

## Project Context

This project uses Node.js.
`;

    it('does not treat a ## Skills heading inside a fenced code block as a section boundary', () => {
        const result = parseAgentSections(FIXTURE_FENCED_HEADING_IN_SOUL);
        // The fenced example text must stay part of the soul zone...
        expect(result.soulZone).toContain('This is just example text inside a fence');
        expect(result.soulZone).toContain('That was just an example, not a real heading.');
        // ...and the REAL ## Skills section (outside the fence) must still be found.
        expect(result.skillsZone).toContain('systematic-debugging');
        expect(result.skillsZone).toContain('verification-before-completion');
        expect(result.skillsZone).not.toContain('example text inside a fence');
    });

    it('still finds the real ## Project Context section after a fenced heading in the soul zone', () => {
        const result = parseAgentSections(FIXTURE_FENCED_HEADING_IN_SOUL);
        expect(result.projectCtx).toContain('## Project Context');
        expect(result.projectCtx).toContain('This project uses Node.js.');
    });

    it('does not truncate the merge when src has a fenced ## Skills example in the soul zone', () => {
        // End-to-end: mergeAgentFile must still pick up the real skillsZone from src
        // even when the soul zone contains a fenced-code-block example heading.
        // (Project Context is preserve-from-dest-only by design — see the merge
        // strategy doc at the top of agent-merger.js — so it is asserted separately
        // below via a dest that already carries one, not pulled from src.)
        const destContent = `---
name: general-purpose
model: sonnet
---

# General Purpose Developer

Old soul.

## Skills

old-skill-list

## Project Context

This project uses Python.
`;
        const tmp = createTmpDir({ prefix: 'agent-merger-fence-test-' });
        try {
            const srcPath = tmp.write('src/agents/general-purpose.md', FIXTURE_FENCED_HEADING_IN_SOUL);
            const destPath = tmp.write('dest/agents/general-purpose.md', destContent);
            mergeAgentFile(srcPath, destPath);
            const merged = fs.readFileSync(destPath, 'utf8');
            // The real ## Skills body (from src, past the fenced example) survives.
            expect(merged).toContain('systematic-debugging');
            expect(merged).toContain('verification-before-completion');
            expect(merged).not.toContain('old-skill-list');
            // dest's own Project Context is preserved unaffected by the fence fix.
            expect(merged).toContain('This project uses Python.');
        } finally {
            tmp.cleanup();
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeFrontmatter
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeFrontmatter', () => {
    it('uses src lines as the base', () => {
        const src = 'name: general-purpose\nmodel: sonnet';
        const dst = 'name: general-purpose\nmodel: haiku';
        const result = mergeFrontmatter(src, dst);
        // model comes from src
        expect(result).toContain('model: sonnet');
        expect(result).not.toContain('model: haiku');
    });

    it('preserves nickname from dst when present', () => {
        const src = 'name: general-purpose\nmodel: sonnet';
        const dst = 'name: general-purpose\nnickname: Forge\nmodel: sonnet';
        const result = mergeFrontmatter(src, dst);
        expect(result).toContain('nickname: Forge');
    });

    it('preserves aliases from dst when present', () => {
        const src = 'name: doc-writer\nmodel: haiku';
        const dst = 'name: doc-writer\nnickname: Penny\naliases: [penny, doc]\nmodel: haiku';
        const result = mergeFrontmatter(src, dst);
        expect(result).toContain('aliases: [penny, doc]');
    });

    it('inserts nickname from dst after name line when src had no nickname line', () => {
        const src = 'name: general-purpose\nmodel: sonnet';
        const dst = 'name: general-purpose\nnickname: Forge\nmodel: sonnet';
        const result = mergeFrontmatter(src, dst);
        const lines = result.split('\n');
        const nameIdx = lines.findIndex(l => /^name\s*:/.test(l));
        const nickIdx = lines.findIndex(l => /^nickname\s*:/.test(l));
        expect(nickIdx).toBe(nameIdx + 1);
    });

    it('does not add nickname when dst has none', () => {
        const src = 'name: general-purpose\nmodel: sonnet';
        const dst = 'name: general-purpose\nmodel: sonnet';
        const result = mergeFrontmatter(src, dst);
        expect(result).not.toContain('nickname');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeAgentFile
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentFile', () => {
    it('copies the file when destPath does not exist', () => {
        const srcPath = tmp.write('src/agents/forge.md', FIXTURE_PERSONALIZED);
        const destPath = path.join(tmp.root, 'dest/agents/forge.md');

        const result = mergeAgentFile(srcPath, destPath);

        expect(result.changed).toBe(true);
        expect(fs.existsSync(destPath)).toBe(true);
        expect(fs.readFileSync(destPath, 'utf8')).toContain('# Forge — General Purpose Developer');
    });

    it('preserves soulZone and projectCtx when dest is personalized', () => {
        const srcContent = `---
name: general-purpose
model: sonnet
---

# Forge — Updated Template Soul

New soul from template.

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

        const result = mergeAgentFile(srcPath, destPath);

        const merged = fs.readFileSync(destPath, 'utf8');
        // Soul preserved from dest
        expect(merged).toContain('Custom description written by Dom');
        expect(merged).not.toContain('New soul from template');
        // Skills from src
        expect(merged).toContain('updated-skill-list');
        expect(merged).not.toContain('old-skill-list');
        // Project context preserved
        expect(merged).toContain('## Project Context');
        expect(merged).toContain('This is my project context');
        // nickname preserved
        expect(merged).toContain('nickname: Forge');
        expect(result.changed).toBe(true);
    });

    it('preserves an adopter-added Project Context on a shadow-shaped agent merged with a non-personalized source (F4)', () => {
        // Template source: shadow-shaped (no ## Skills), NOT personalized, no Project
        // Context of its own — an ordinary template sync.
        const srcContent = `---
name: shadow
model: sonnet
---

# Shadow — Voice-Matched Ghostwriter (template refresh)

Updated persona prose from the template.
`;
        const srcPath = tmp.write('src/agents/shadow.md', srcContent);
        const destPath = tmp.write('dest/agents/shadow.md', FIXTURE_SHADOW_WITH_PROJECT_CTX);

        const result = mergeAgentFile(srcPath, destPath);

        const merged = fs.readFileSync(destPath, 'utf8');
        // Template refreshes the soul zone (dest was not personalized).
        expect(merged).toContain('Updated persona prose from the template');
        // The adopter's Project Context survives — not folded into soulZone and lost.
        expect(merged).toContain('## Project Context');
        expect(merged).toContain('technical, skeptical audience');
        expect(result.detail).toContain('preserved Project Context');
    });

    it('overwrites soulZone when dest is not personalized', () => {
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

        mergeAgentFile(srcPath, destPath);

        const merged = fs.readFileSync(destPath, 'utf8');
        expect(merged).toContain('NEW TEMPLATE');
        expect(merged).not.toContain('OLD');
        expect(merged).toContain('code-reviewer-v2');
    });

    it('produces a blank line between --- and soul zone heading after merge (regression)', () => {
        const content = `---
name: architect
model: inherit
---

# Mason — System Architect

Body content here.

## Skills

- architecture
`;
        const srcPath = tmp.write('src/agents/architect.md', content);
        const destPath = tmp.write('dest/agents/architect.md', content);

        mergeAgentFile(srcPath, destPath);

        const merged = fs.readFileSync(destPath, 'utf8');
        expect(merged).toContain('---\n\n# Mason — System Architect');
        expect(merged).not.toContain('---\n# Mason — System Architect');
    });

    it('returns changed=false when content is identical', () => {
        const srcPath = tmp.write('src/agents/identical.md', FIXTURE_GENERIC);
        const destPath = tmp.write('dest/agents/identical.md', FIXTURE_GENERIC);

        const result = mergeAgentFile(srcPath, destPath);

        // unchanged file — changed must be false
        expect(result.changed).toBe(false);
    });

    it('preserves nickname and aliases in frontmatter during merge', () => {
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
// extractFieldBlock
// ─────────────────────────────────────────────────────────────────────────────

describe('extractFieldBlock', () => {
    it('returns the single line range for an inline field', () => {
        const lines = ['name: a', 'description: hello world', 'tools: Read'];
        expect(extractFieldBlock(lines, 'description')).toEqual({ start: 1, end: 2 });
    });

    it('captures indented continuation lines of a folded scalar', () => {
        const lines = ['description: >', '  line one', '  line two', 'tools: Read'];
        expect(extractFieldBlock(lines, 'description')).toEqual({ start: 0, end: 3 });
    });

    it('returns null when the field is absent', () => {
        expect(extractFieldBlock(['name: a', 'model: sonnet'], 'description')).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeFrontmatter — description preservation (opt-in)
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeFrontmatter description preservation', () => {
    it('takes src description by default (no opts)', () => {
        const src = 'name: a\ndescription: Generic template text.\nmodel: sonnet';
        const dst = 'name: a\ndescription: Tuned project text.\nmodel: sonnet';
        const result = mergeFrontmatter(src, dst);
        expect(result).toContain('Generic template text.');
        expect(result).not.toContain('Tuned project text.');
    });

    it('preserves dst description when preserveDescription is set', () => {
        const src = 'name: a\ndescription: Generic template text.\nmodel: sonnet';
        const dst = 'name: a\ndescription: Tuned project text.\nmodel: sonnet';
        const result = mergeFrontmatter(src, dst, { preserveDescription: true });
        expect(result).toContain('Tuned project text.');
        expect(result).not.toContain('Generic template text.');
    });

    it('preserves a folded multi-line dst description block', () => {
        const src = 'name: a\ndescription: Short.\ntools: Read';
        const dst = 'name: a\ndescription: >\n  Tuned line one.\n  Tuned line two.\ntools: Read';
        const result = mergeFrontmatter(src, dst, { preserveDescription: true });
        expect(result).toContain('Tuned line one.');
        expect(result).toContain('Tuned line two.');
        expect(result).not.toMatch(/description: Short\./);
    });

    it('inserts dst description when src has none', () => {
        const src = 'name: a\nmodel: sonnet';
        const dst = 'name: a\ndescription: Tuned project text.\nmodel: sonnet';
        const result = mergeFrontmatter(src, dst, { preserveDescription: true });
        expect(result).toContain('description: Tuned project text.');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeAgentFile — description preservation by zone
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentFile description preservation', () => {
    const srcWithGenericDesc = `---
name: architect
description: Generic template description.
model: inherit
---

# Architect

Template soul.

## Skills

architecture
`;

    it('preserves the tuned description when dest is personalized (has nickname)', () => {
        const dst = `---
name: architect
nickname: Mason
description: "Use when making architectural decisions: ADRs, tech stack."
model: inherit
---

# Mason — System Architect

Custom soul.

## Skills

old-skills
`;
        const srcPath = tmp.write('src/agents/architect.md', srcWithGenericDesc);
        const destPath = tmp.write('dest/agents/architect.md', dst);
        mergeAgentFile(srcPath, destPath);
        const merged = fs.readFileSync(destPath, 'utf8');
        expect(merged).toContain('Use when making architectural decisions');
        expect(merged).not.toContain('Generic template description.');
    });

    it('preserves the tuned description when dest is specialized (Project Context, no nickname)', () => {
        const dst = `---
name: architect
description: "Use when documenting ADRs for this project."
model: inherit
---

# Architect

Template soul.

## Skills

architecture

## Project Context

This project uses .NET 10.
`;
        const srcPath = tmp.write('src/agents/architect-spec.md', srcWithGenericDesc);
        const destPath = tmp.write('dest/agents/architect-spec.md', dst);
        mergeAgentFile(srcPath, destPath);
        const merged = fs.readFileSync(destPath, 'utf8');
        expect(merged).toContain('Use when documenting ADRs for this project.');
        expect(merged).not.toContain('Generic template description.');
    });

    it('takes the src description for a thin agent (no nickname, no Project Context)', () => {
        const dst = `---
name: architect
description: Stale old description.
model: inherit
---

# Architect

Template soul.

## Skills

architecture
`;
        const srcPath = tmp.write('src/agents/architect-thin.md', srcWithGenericDesc);
        const destPath = tmp.write('dest/agents/architect-thin.md', dst);
        mergeAgentFile(srcPath, destPath);
        const merged = fs.readFileSync(destPath, 'utf8');
        expect(merged).toContain('Generic template description.');
        expect(merged).not.toContain('Stale old description.');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeAgentFile — skills-union (preserve /review:specialize skills on merge)
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentFile skills-union', () => {
    const SRC = `---
name: architect
model: inherit
skills:
  - architecture
---

# Architect

## Skills

architecture
`;
    // Project agent: template base skill + a bespoke specialization + a consolidation orphan.
    const DEST = `---
name: architect
skills:
  - architecture
  - cloudflare
  - old-orphan
---

# Architect

## Skills

architecture
`;

    function run(canonical, target) {
        const srcPath = tmp.write('src/agents/architect.md', SRC);
        const destPath = tmp.write('dest/agents/architect.md', DEST);
        mergeAgentFile(srcPath, destPath, {
            canonicalSkills: new Set(canonical),
            targetSkills: new Set(target),
        });
        return fs.readFileSync(destPath, 'utf8');
    }

    it('preserves a bespoke (non-canonical) skill whose dir exists in the target', () => {
        // cloudflare: not canonical, dir present in target → kept
        const merged = run(['architecture'], ['architecture', 'cloudflare', 'old-orphan']);
        expect(merged).toMatch(/- cloudflare/);
        expect(merged).toMatch(/- architecture/);
    });

    it('drops a non-canonical skill whose dir no longer exists in the target (consolidation orphan)', () => {
        // old-orphan: not canonical AND not a target dir → not re-added
        const merged = run(['architecture'], ['architecture', 'cloudflare']);
        expect(merged).not.toMatch(/- old-orphan/);
        expect(merged).toMatch(/- cloudflare/);
    });

    it('does not union when skill sets are not provided (legacy behavior: skills from src)', () => {
        const srcPath = tmp.write('src/agents/architect.md', SRC);
        const destPath = tmp.write('dest/agents/architect.md', DEST);
        mergeAgentFile(srcPath, destPath);
        const merged = fs.readFileSync(destPath, 'utf8');
        expect(merged).not.toMatch(/- cloudflare/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeAgentFile skills-union — edge cases (sweep P1 MAJOR + MINOR fixes)
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentFile skills-union edge cases', () => {
    it('synthesizes a skills: block when src has none, preserving bespoke skills', () => {
        const src = `---
name: architect
model: inherit
---

# Architect

## Skills

architecture
`;
        const dest = `---
name: architect
skills:
  - cloudflare
---

# Architect
`;
        const srcPath = tmp.write('src/agents/architect.md', src);
        const destPath = tmp.write('dest/agents/architect.md', dest);
        mergeAgentFile(srcPath, destPath, {
            canonicalSkills: new Set(['architecture']),
            targetSkills: new Set(['cloudflare']),
        });
        const merged = fs.readFileSync(destPath, 'utf8');
        // bespoke skill survives even though the template carried no skills: list
        expect(merged).toMatch(/^skills:/m);
        expect(merged).toMatch(/- cloudflare/);
    });

    it('matches existing list indentation when appending bespoke skills', () => {
        // src list items are flush (zero-indent); appended item must match.
        const src = `---
name: architect
skills:
- architecture
---

# Architect
`;
        const dest = `---
name: architect
skills:
- architecture
- cloudflare
---

# Architect
`;
        const srcPath = tmp.write('src/agents/architect.md', src);
        const destPath = tmp.write('dest/agents/architect.md', dest);
        mergeAgentFile(srcPath, destPath, {
            canonicalSkills: new Set(['architecture']),
            targetSkills: new Set(['cloudflare']),
        });
        const merged = fs.readFileSync(destPath, 'utf8');
        // no mixed indentation — cloudflare added flush like the rest
        expect(merged).toMatch(/\n- cloudflare/);
        expect(merged).not.toMatch(/\n {2}- cloudflare/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// stripExcludedSkills + skillExclude-aware merge (the skillExclude-adopter fix)
// ─────────────────────────────────────────────────────────────────────────────

describe('stripExcludedSkills', () => {
    it('returns content unchanged when the exclude set is empty/absent', () => {
        const c = '---\nname: x\nskills:\n  - a\n  - b\n---\n# X\n';
        expect(stripExcludedSkills(c, new Set())).toBe(c);
        expect(stripExcludedSkills(c, undefined)).toBe(c);
    });

    it('drops excluded items from the frontmatter skills list, keeps the rest', () => {
        const c = '---\nname: ux\nskills:\n  - ux-design\n  - tailwind-css-patterns\n  - brand-guidelines\n---\n# UX\n';
        const out = stripExcludedSkills(c, new Set(['tailwind-css-patterns']));
        expect(out).toContain('- ux-design');
        expect(out).toContain('- brand-guidelines');
        expect(out).not.toContain('tailwind-css-patterns');
    });

    it('removes the whole skills block when every item is excluded', () => {
        const c = '---\nname: y\nskills:\n  - tailwind-css-patterns\n  - design-taste-frontend\nmemory: project\n---\n# Y\n';
        const out = stripExcludedSkills(c, new Set(['tailwind-css-patterns', 'design-taste-frontend']));
        expect(out).not.toContain('skills:');
        expect(out).not.toContain('tailwind-css-patterns');
        expect(out).toContain('name: y');
        expect(out).toContain('memory: project');
    });

    it('strips ## Skills body lines that point at an excluded skill dir', () => {
        const c = [
            '---', 'name: ux', 'skills:', '  - ux-design', '  - tailwind-css-patterns', '---', '',
            '# UX', '', '## Skills', 'Read these files:',
            '- `.claude/skills/ux-design/SKILL.md` — design system',
            '- `.claude/skills/tailwind-css-patterns/SKILL.md` — utility CSS',
            '',
        ].join('\n');
        const out = stripExcludedSkills(c, new Set(['tailwind-css-patterns']));
        expect(out).toContain('.claude/skills/ux-design/SKILL.md');
        expect(out).not.toContain('tailwind-css-patterns');
    });

    it('preserves CRLF line endings', () => {
        const c = '---\r\nname: x\r\nskills:\r\n  - a\r\n  - drop-me\r\n---\r\n# X\r\n';
        const out = stripExcludedSkills(c, new Set(['drop-me']));
        expect(out).toContain('\r\n');
        expect(out).not.toContain('drop-me');
        expect(out).toContain('- a');
    });
});

describe('mergeAgentFile — skillExclude-aware (regression: clobbered curated agent skills)', () => {
    it('does NOT re-introduce an excluded skill into the merged frontmatter', () => {
        // Template agent references tailwind; the adopter excluded it. The merge
        // must not write a ref to a skill the project does not ship.
        const srcPath = tmp.write('src/ux-designer.md', '---\nname: ux-designer\nskills:\n  - ux-design\n  - tailwind-css-patterns\n  - brand-guidelines\n---\n\n# UX Designer\n\nGeneric.\n\n## Skills\n\n- `.claude/skills/tailwind-css-patterns/SKILL.md` — utility CSS\n');
        // Adopter's curated agent (no tailwind — it was excluded)
        const destPath = tmp.write('dest/ux-designer.md', '---\nname: ux-designer\nskills:\n  - ux-design\n  - brand-guidelines\n---\n\n# UX Designer\n\nCurated.\n\n## Skills\n\nux-design, brand-guidelines\n');

        mergeAgentFile(srcPath, destPath, {
            canonicalSkills: new Set(['ux-design', 'tailwind-css-patterns', 'brand-guidelines']),
            targetSkills: new Set(['ux-design', 'brand-guidelines']),
            excludedSkills: new Set(['tailwind-css-patterns']),
        });

        const merged = fs.readFileSync(destPath, 'utf8');
        expect(merged).not.toContain('tailwind-css-patterns');
        expect(merged).toContain('- ux-design');
        expect(merged).toContain('- brand-guidelines');
    });

    it('strips excluded skills on a fresh install (dest does not exist)', () => {
        const srcPath = tmp.write('src/general-purpose.md', '---\nname: general-purpose\nskills:\n  - dev-process\n  - verification-before-completion\n---\n\n# GP\n');
        const destPath = path.join(tmp.root, 'dest/general-purpose.md');
        mergeAgentFile(srcPath, destPath, { excludedSkills: new Set(['verification-before-completion']) });
        const out = fs.readFileSync(destPath, 'utf8');
        expect(out).not.toContain('verification-before-completion');
        expect(out).toContain('- dev-process');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Line-ending preservation (m3: CRLF churn)
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentFile CRLF preservation', () => {
    it('does not rewrite a CRLF dest to LF when the merged content is unchanged', () => {
        const srcPath = tmp.write('src/agents/code-reviewer.md', FIXTURE_GENERIC);

        // 1. Merge into an LF dest to capture the canonical merge output (so an LF
        //    dest carrying it is a genuine no-op — isolates EOL as the only variable).
        const lfDestPath = tmp.write('dest-lf/agents/code-reviewer.md', FIXTURE_GENERIC);
        mergeAgentFile(srcPath, lfDestPath);
        const canonical = fs.readFileSync(lfDestPath, 'utf8');

        // Re-merging the canonical LF dest must report no change.
        expect(mergeAgentFile(srcPath, lfDestPath).changed).toBe(false);

        // 2. Same canonical content, but with CRLF line endings (a Windows checkout).
        const crlfDestPath = tmp.write('dest-crlf/agents/code-reviewer.md', canonical.replace(/\n/g, '\r\n'));
        const result = mergeAgentFile(srcPath, crlfDestPath);

        // The only difference is the line endings → no semantic change, no rewrite.
        expect(result.changed).toBe(false);
        const after = fs.readFileSync(crlfDestPath, 'utf8');
        expect(after.includes('\r\n')).toBe(true);   // still CRLF — not churned to LF
        expect(after).toBe(canonical.replace(/\n/g, '\r\n'));
    });
});
