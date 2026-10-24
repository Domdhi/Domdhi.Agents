// AC→source: migrate-docs-domains.js — the docs domain-taxonomy codemod (ADR 2026-06-20).
// Covers: boundary anchoring, substring-collision (longest-first), skip-allowlist,
// idempotency, keep-marker, --refs dry-run/apply, --verify exit semantics, --move
// (incl. git-mv history preservation + ADR-corpus chronological renumbering).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const mig = require('../../../.agents/core/migrate-docs-domains');

function mkTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-docs-'));
}
function write(root, rel, content) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
}

describe('rewriteLine — boundary anchoring & collisions', () => {
    it('rewrites a docs-prefixed canonical doc path', () => {
        expect(mig.rewriteLine('see docs/_project-architecture.md for ADRs').text)
            .toBe('see docs/architecture/overview.md for ADRs');
    });

    it('handles the _project-design ⊂ _project-design.md substring collision (longest-first)', () => {
        const r = mig.rewriteLine('edit _project-design.md or the _project-design doc');
        expect(r.text).toBe('edit design/spec.md or the design/spec doc');
        // never double-applies into design/spec.md.md or design/specspec
        expect(r.text).not.toContain('.md.md');
        expect(r.text).not.toContain('specspec');
    });

    it('respects the leading boundary — a longer identifier is not clobbered', () => {
        // `my_project-brief.md` is a different identifier; before-char is alnum.
        expect(mig.rewriteLine('my_project-brief.md').changed).toBe(false);
    });

    it('respects the trailing boundary on bare tokens', () => {
        // `_project-designs` must not match bare `_project-design`.
        expect(mig.rewriteLine('the _project-designs list').changed).toBe(false);
    });

    it('promotes todo/_backlog.md to work/backlog.md (not work/todo/_backlog.md)', () => {
        expect(mig.rewriteLine('docs/todo/_backlog.md').text).toBe('docs/work/backlog.md');
    });

    it('routes other todo/ files under work/todo/ (dropping the _ prefix)', () => {
        expect(mig.rewriteLine('docs/todo/TODO_epic01.md').text).toBe('docs/work/todo/TODO_epic01.md');
        expect(mig.rewriteLine('docs/todo/_feature-ideas.md').text).toBe('docs/work/todo/feature-ideas.md');
    });

    it('maps ideation seeds into product/', () => {
        expect(mig.rewriteLine('gate needs docs/_brainstorm.md or docs/_research.md').text)
            .toBe('gate needs docs/product/brainstorm.md or docs/product/research.md');
    });

    it('renames skill assets to flat domain names — full path AND relative refs', () => {
        // the asset path must NOT become assets/<domain>/<file>.md (a bogus subdir)
        expect(mig.rewriteLine(".claude/skills/ux-design/assets/_project-design.md").text)
            .toBe('.claude/skills/ux-design/assets/spec.md');
        expect(mig.rewriteLine(".claude/skills/architecture/assets/_project-architecture.md").text)
            .toBe('.claude/skills/architecture/assets/overview.md');
        // relative refs inside a SKILL.md (the form the generic rule used to mangle)
        expect(mig.rewriteLine('lives in `assets/_project-architecture.md`').text)
            .toBe('lives in `assets/overview.md`');
        expect(mig.rewriteLine('seeds from `../assets/_project-brief.md`').text)
            .toBe('seeds from `../assets/brief.md`');
    });

    it('rewrites a scaffold manifest entry consistently (asset from + docs to)', () => {
        const line = "    { from: '.claude/skills/ux-design/assets/_project-design.md', to: '_project-design.md' },";
        expect(mig.rewriteLine(line).text)
            .toBe("    { from: '.claude/skills/ux-design/assets/spec.md', to: 'design/spec.md' },");
    });

    it('drops the _ from bare basenames cited as shorthand (backlog/feature-ideas/design)', () => {
        // bare → bare (no dir prefix added) so a ref inside an existing dir context
        // doesn't double the directory (e.g. `docs/design/ (_wireframes.md)`).
        expect(mig.rewriteLine('refresh from the current `_backlog.md`').text)
            .toBe('refresh from the current `backlog.md`');
        expect(mig.rewriteLine('drain `_feature-ideas.md` into the backlog').text)
            .toBe('drain `feature-ideas.md` into the backlog');
        expect(mig.rewriteLine('docs/design/ (`_wireframes.md`, `_mock-layout.html`)').text)
            .toBe('docs/design/ (`wireframes.md`, `mock.html`)');
        expect(mig.rewriteLine('`_design.light.md` and `_design.dark.md`').text)
            .toBe('`theme.light.md` and `theme.dark.md`');
        // module brief drops its underscore too (modules/{name}/_brief.md → brief.md)
        expect(mig.rewriteLine('docs/modules/{module}/_brief.md').text)
            .toBe('docs/modules/{module}/brief.md');
        // …but never inside the longer _project-brief.md (hyphen-brief, not underscore-brief)
        expect(mig.rewriteLine('docs/_project-brief.md').text).toBe('docs/product/brief.md');
    });

    it('bare basename rules never double-rewrite a directory-prefixed path (longest-first)', () => {
        // the prefixed rules must still win where a prefix is present
        expect(mig.rewriteLine('docs/todo/_backlog.md').text).toBe('docs/work/backlog.md');
        expect(mig.rewriteLine('assets/_backlog.md').text).toBe('assets/backlog.md');
        expect(mig.rewriteLine('design/_wireframes.md').text).toBe('design/wireframes.md');
        // and bare rewrites are idempotent
        expect(mig.rewriteLine('backlog.md').changed).toBe(false);
        expect(mig.rewriteLine('wireframes.md').changed).toBe(false);
    });

    it('leaves task working files in the generated zone (no work/scratch move)', () => {
        // docs/.output/work/ stays put — task working files are not relocated.
        expect(mig.rewriteLine('docs/.output/work/2026-06-20/task/').changed).toBe(false);
    });

    it('renames app/ → modules/ only when docs-prefixed', () => {
        expect(mig.rewriteLine('docs/app/auth/_brief.md').text).toBe('docs/modules/auth/brief.md');
        // a bare `app/` in unrelated prose is left alone (residue, not auto-rewritten)
        expect(mig.rewriteLine('the app/ folder in source').changed).toBe(false);
    });

    it('migrates no-slash dir refs (scaffold extraDirs) without clobbering longer words', () => {
        expect(mig.rewriteLine("'docs/app'").text).toBe("'docs/modules'");
        expect(mig.rewriteLine("'docs/.output/work'").changed).toBe(false);  // stays put
        expect(mig.rewriteLine("'docs/todo'").text).toBe("'docs/work/todo'");
        // must NOT touch a longer identifier that merely starts with the token
        expect(mig.rewriteLine('docs/application/main.js').changed).toBe(false);
    });

    it('is idempotent — re-running over rewritten text is a no-op', () => {
        const once = mig.rewriteLine('docs/_project-requirements.md → docs/todo/_backlog.md').text;
        const twice = mig.rewriteLine(once).text;
        expect(twice).toBe(once);
        expect(mig.rewriteLine(once).changed).toBe(false);
    });

    it('skips a line carrying the migrate:keep marker', () => {
        const line = 'legacy: docs/_project-architecture.md  <!-- migrate:keep -->';
        expect(mig.rewriteLine(line).changed).toBe(false);
    });
});

describe('findSurvivors — verify detection', () => {
    it('flags a surviving legacy token', () => {
        const hits = mig.findSurvivors('still points to docs/_project-brief.md here');
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.some((h) => h.token === '_project-brief.md')).toBe(true);
    });
    it('returns nothing for a fully-migrated line', () => {
        expect(mig.findSurvivors('docs/product/brief.md is canonical')).toEqual([]);
    });
    it('ignores keep-marked lines', () => {
        expect(mig.findSurvivors('docs/_project-brief.md  migrate:keep')).toEqual([]);
    });
});

describe('isPathSkipped — allowlist', () => {
    it('skips archive, generated output, changelog, and load-bearing-literal files', () => {
        expect(mig.isPathSkipped('docs/todo/_archive/cycle-1/TODO_x.md')).toBe(true);
        expect(mig.isPathSkipped('docs/.output/reviews/2026-06-20-adr-x.md')).toBe(true);
        expect(mig.isPathSkipped('docs/architecture/decisions/0002-skill-owned-templates.md')).toBe(true);
        expect(mig.isPathSkipped('docs/.output/work/2026-06-03/task/notes.md')).toBe(true);
        expect(mig.isPathSkipped('CHANGELOG.md')).toBe(true);
        expect(mig.isPathSkipped('.claude/core/_lib/doc-drift.js')).toBe(true);
        expect(mig.isPathSkipped('.claude/core/migrate-docs-domains.js')).toBe(true);
        expect(mig.isPathSkipped('node_modules/x/index.js')).toBe(true);
    });
    it('does NOT skip ordinary template files', () => {
        expect(mig.isPathSkipped('.claude/commands/create/project-architecture.md')).toBe(false);
        expect(mig.isPathSkipped('docs/reference/system-map.md')).toBe(false);
    });
});

describe('runRefs — fileset rewrite', () => {
    let root;
    beforeEach(() => { root = mkTmp(); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('dry-run reports changes without writing; apply writes', () => {
        write(root, '.claude/commands/x.md', 'uses docs/_project-architecture.md\n');
        const dry = mig.runRefs(root, { apply: false, paths: ['.claude'] });
        expect(dry.changedFiles.length).toBe(1);
        expect(fs.readFileSync(path.join(root, '.claude/commands/x.md'), 'utf8'))
            .toContain('_project-architecture.md'); // unchanged on disk

        const applied = mig.runRefs(root, { apply: true, paths: ['.claude'] });
        expect(applied.changedFiles.length).toBe(1);
        expect(fs.readFileSync(path.join(root, '.claude/commands/x.md'), 'utf8'))
            .toBe('uses docs/architecture/overview.md\n');
    });

    it('honors the skip-allowlist — archive and doc-drift literals untouched', () => {
        write(root, 'docs/todo/_archive/old.md', 'docs/_project-brief.md\n');
        write(root, '.claude/core/_lib/doc-drift.js', "const x = '_project-brief.md';\n");
        write(root, '.claude/commands/y.md', 'docs/_project-brief.md\n');
        const r = mig.runRefs(root, { apply: true, paths: ['.', 'docs'] });
        const changed = r.changedFiles.map((f) => f.file.replace(/\\/g, '/'));
        expect(changed).toContain('.claude/commands/y.md');
        expect(changed).not.toContain('docs/todo/_archive/old.md');
        expect(changed.some((f) => f.endsWith('doc-drift.js'))).toBe(false);
    });
});

describe('runVerify — exit semantics', () => {
    let root;
    beforeEach(() => { root = mkTmp(); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('finds a planted legacy token', () => {
        write(root, '.claude/commands/z.md', 'still has docs/_project-context.md\n');
        const { violations } = mig.runVerify(root, { paths: ['.claude'] });
        expect(violations.length).toBe(1);
        expect(violations[0].token).toBe('_project-context.md');
    });

    it('is clean after a full apply', () => {
        write(root, '.claude/commands/z.md', 'docs/_project-context.md and docs/todo/_backlog.md\n');
        mig.runRefs(root, { apply: true, paths: ['.claude'] });
        const { violations } = mig.runVerify(root, { paths: ['.claude'] });
        expect(violations).toEqual([]);
    });
});

describe('runMove — file/dir moves & ADR renumbering', () => {
    let root;
    beforeEach(() => { root = mkTmp(); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('plans moves in dry-run without touching disk', () => {
        write(root, '_project-brief.md', 'x');
        write(root, 'todo/_backlog.md', 'x');
        const r = mig.runMove(root, { apply: false });
        const norm = (p) => path.relative(root, p).replace(/\\/g, '/');  // cross-platform (Windows \)
        const pairs = r.moves.map((m) => [norm(m.from), norm(m.to)]);
        expect(pairs).toContainEqual(['_project-brief.md', 'product/brief.md']);
        expect(pairs).toContainEqual(['todo/_backlog.md', 'work/backlog.md']);
        // disk untouched
        expect(fs.existsSync(path.join(root, '_project-brief.md'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'product/brief.md'))).toBe(false);
    });

    it('renumbers the ADR corpus chronologically by date prefix', () => {
        write(root, '.output/reviews/2026-06-13-adr-planning.md', '#');
        write(root, '.output/reviews/2026-04-20-adr-memory.md', '#');
        write(root, '.output/reviews/2026-06-20-adr-taxonomy.md', '#');
        write(root, '.output/reviews/2026-05-01-not-an-adr.md', '#'); // ignored
        const r = mig.runMove(root, { apply: false });
        const adr = r.adr.map((a) => a.to.replace(/\\/g, '/'));
        expect(adr).toEqual([
            'architecture/decisions/0001-memory.md',     // 2026-04-20 (earliest)
            'architecture/decisions/0002-planning.md',   // 2026-06-13
            'architecture/decisions/0003-taxonomy.md',   // 2026-06-20
        ]);
    });

    it('applies real git mv (history-preserving) when docsRoot is tracked', () => {
        // build a tiny git repo
        execFileSync('git', ['init', '-q'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
        write(root, '_project-architecture.md', '# arch\n');
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root });

        mig.runMove(root, { apply: true });
        expect(fs.existsSync(path.join(root, 'architecture/overview.md'))).toBe(true);
        expect(fs.existsSync(path.join(root, '_project-architecture.md'))).toBe(false);
        // git mv stages a RENAME (R) — history-preserving — not a delete+add.
        const status = execFileSync('git', ['status', '--porcelain', '--find-renames'], { cwd: root }).toString();
        expect(status).toMatch(/^R/m);
        expect(status).toContain('_project-architecture.md');
        expect(status).toContain('architecture/overview.md');
    });
});
