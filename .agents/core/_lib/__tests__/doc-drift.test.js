// Tests for doc-drift.js — detection of legacy/duplicate planning docs (F2).
//
// Coverage targets:
//   line 97  — catch { return; } inside findMisplacedTodos walk when readdirSync fails
//   lines 154-183 — main() CLI output paths (no-drift, legacy, duplicates, misplacedTodos)
//   line 188 — require.main guard (NOT COVERED: evaluates true only when node is entry)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const DOC_DRIFT_PATH = require.resolve('../../../../.agents/core/_lib/doc-drift');
const { detectDocDrift, stripTemplateMarker, isRealDoc, findMisplacedTodos } = require('../../../../.agents/core/_lib/doc-drift');

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-drift-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function write(rel, content = '# real doc\n') {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
}

describe('detectDocDrift', () => {
    it('cleanRepo_noDrift', () => {
        // Canonical domain-taxonomy paths — no legacy/duplicate drift.
        write('docs/architecture/overview.md');
        write('docs/work/backlog.md');
        const r = detectDocDrift(root);
        expect(r.hasDrift).toBe(false);
        expect(r.legacy).toEqual([]);
        expect(r.duplicates).toEqual([]);
    });

    it('flagsLegacyDoc_andWhetherCanonicalAlsoExists', () => {
        write('docs/_architecture.md');            // legacy short name → architecture/overview.md
        write('docs/architecture/overview.md');    // canonical also present → BOTH
        write('docs/_prd.md');                     // legacy, no canonical
        const r = detectDocDrift(root);
        expect(r.hasDrift).toBe(true);
        const arch = r.legacy.find(l => l.file === 'docs/_architecture.md');
        expect(arch.canonical).toBe('docs/architecture/overview.md');
        expect(arch.canonicalExists).toBe(true);
        const prd = r.legacy.find(l => l.file === 'docs/_prd.md');
        expect(prd.canonicalExists).toBe(false);
    });

    it('flagsPreTaxonomyProjectNamesAsLegacy', () => {
        // The flat `_project-*` layout this migration superseded is now legacy too.
        write('docs/_project-requirements.md');
        const r = detectDocDrift(root);
        const hit = r.legacy.find(l => l.file === 'docs/_project-requirements.md');
        expect(hit).toBeTruthy();
        expect(hit.canonical).toBe('docs/product/requirements.md');
    });

    it('flagsDuplicateBasenameAcrossRootAndCanonical', () => {
        write('docs/_backlog.md');          // root (non-canonical)
        write('docs/work/backlog.md');      // canonical
        const r = detectDocDrift(root);
        expect(r.duplicates.find(d => d.name === '_backlog.md')).toBeTruthy();
    });

    it('ignoresTemplateStubs', () => {
        // An unfilled scaffold stub is not real drift.
        write('docs/_architecture.md', '<!-- @@template -->\n# stub\n');
        const r = detectDocDrift(root);
        expect(r.hasDrift).toBe(false);
    });

    // ── F17: misplaced TODO files outside docs/ root and docs/todo/ ──
    it('flagsMisplacedTodoOutsideCanonicalDirs', () => {
        write('docs/TODO_Project.md');                       // canonical master (docs/ root)
        write('docs/work/todo/TODO_epic01_foo.md');          // canonical per-epic (work/todo/)
        write('docs/modules/TODO_epic00_doc-review.md');     // MISPLACED (stale plan)
        const r = detectDocDrift(root);
        expect(r.hasDrift).toBe(true);
        expect(r.misplacedTodos).toHaveLength(1);
        expect(r.misplacedTodos[0].file).toBe('docs/modules/TODO_epic00_doc-review.md');
    });

    it('doesNotFlagCanonicalTodos', () => {
        write('docs/TODO_Project.md');
        write('docs/work/todo/TODO_epic01_foo.md');
        write('docs/work/todo/TODO_epic02_bar.md');
        const r = detectDocDrift(root);
        expect(r.misplacedTodos).toEqual([]);
        expect(r.hasDrift).toBe(false);
    });

    it('ignoresTodosUnderOutputAndArchive', () => {
        write('docs/.output/.state/work/2026-01-01/task/TODO_scratch.md');  // ephemeral, skipped
        write('docs/.archive/TODO_old.md');                           // archive, skipped
        const r = detectDocDrift(root);
        expect(r.misplacedTodos).toEqual([]);
        expect(r.hasDrift).toBe(false);
    });

    // ── EV7: /evolve parks closed cycles under docs/todo/_archive/ (underscore) ──
    it('ignoresTodosUnder_evolveCycleArchive', () => {
        write('docs/TODO_Project.md');                                            // live master
        write('docs/work/todo/TODO_epic01_foo.md');                               // live per-epic
        write('docs/work/todo/_archive/cycle-1-260606-1214/backlog.md');          // archived backlog
        write('docs/work/todo/_archive/cycle-1-260606-1214/TODO_DomdhiCrypto.md'); // archived master
        write('docs/work/todo/_archive/cycle-1-260606-1214/TODO_epic01_foo.md');   // archived per-epic
        const r = detectDocDrift(root);
        expect(r.misplacedTodos).toEqual([]);   // _archive (underscore) is skipped, not flagged
        expect(r.hasDrift).toBe(false);
    });

    it('flagsAllLegacyNames', () => {
        // Covers all entries in LEGACY_TO_CANONICAL
        write('docs/_requirements.md');
        write('docs/_brief.md');
        write('docs/_design.md');
        write('docs/_context.md');
        const r = detectDocDrift(root);
        expect(r.legacy.map(l => l.file)).toEqual(
            expect.arrayContaining([
                'docs/_requirements.md',
                'docs/_brief.md',
                'docs/_design.md',
                'docs/_context.md',
            ])
        );
    });

    it('flagsDuplicateFeatureIdeas', () => {
        // _feature-ideas.md also has a canonical location in work/todo/
        write('docs/_feature-ideas.md');
        write('docs/work/todo/feature-ideas.md');
        const r = detectDocDrift(root);
        expect(r.duplicates.find(d => d.name === '_feature-ideas.md')).toBeTruthy();
    });
});

// ── gradeDoc — placeholder/quality gate on planning docs (T.1) ───────────────
// Contract: gradeDoc(absPath) → { pass: boolean, failures: string[] }
//   - stub/unreadable (fails isRealDoc) → { pass:false, failures:[...] }
//   - placeholder tokens (TBD, TODO, `{{`, bare `{…}` outside fenced code) → fail
//   - each `#### FR-N:` block needs ≥1 Given/When/Then acceptance-criteria line
//   - all-Must MoSCoW (every FR `Must Have`, ≥2 FRs) → fail
//   - `## Success Criteria` table needs ≥1 non-placeholder data row

describe('gradeDoc (T.1)', () => {
    const { gradeDoc } = require('../../../../.agents/core/_lib/doc-drift');

    // A complete, filled requirements doc: no braces/TBD, two FRs with mixed
    // MoSCoW priorities each carrying a Given/When/Then, a filled Success table.
    const VALID_REQ = [
        '# Product Requirements Document: Acme',
        '',
        '## Functional Requirements',
        '',
        '### Module: Auth',
        '',
        '#### FR-1: User login',
        '- **Priority**: Must Have',
        '- **Description**: The system authenticates registered users.',
        '- **Acceptance Criteria**:',
        '  - Given a registered user, When they submit valid credentials, Then they are authenticated.',
        '',
        '#### FR-2: Password reset',
        '- **Priority**: Should Have',
        '- **Description**: Users can reset a forgotten password.',
        '- **Acceptance Criteria**:',
        '  - Given a user with an account, When they request a reset, Then a reset email is sent.',
        '',
        '## Success Criteria',
        '',
        '| Criteria | Target | Measurement |',
        '|----------|--------|-------------|',
        '| Login success rate | 99% | server access logs |',
        '',
    ].join('\n');

    it('passes a complete, filled requirements doc', () => {
        write('docs/_project-requirements.md', VALID_REQ);
        const r = gradeDoc(path.join(root, 'docs', '_project-requirements.md'));
        expect(r.pass).toBe(true);
        expect(r.failures).toEqual([]);
    });

    it('fails a template stub (isRealDoc guard) with pass:false', () => {
        write('docs/_project-requirements.md', '<!-- @@template -->\n# PRD: {Project Name}\n');
        const r = gradeDoc(path.join(root, 'docs', '_project-requirements.md'));
        expect(r.pass).toBe(false);
        expect(r.failures.length).toBeGreaterThan(0);
    });

    it('fails on a bare {…} placeholder left in the doc', () => {
        write('docs/req.md', VALID_REQ.replace('Acme', '{Project Name}'));
        const r = gradeDoc(path.join(root, 'docs', 'req.md'));
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toMatch(/placeholder/i);
    });

    it('fails on a literal TBD marker', () => {
        write('docs/req.md', VALID_REQ.replace('99%', 'TBD'));
        const r = gradeDoc(path.join(root, 'docs', 'req.md'));
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toMatch(/placeholder|TBD/i);
    });

    it('fails on a {{…}} mustache placeholder', () => {
        write('docs/req.md', VALID_REQ + '\nNotes: {{fill_me}}\n');
        const r = gradeDoc(path.join(root, 'docs', 'req.md'));
        expect(r.pass).toBe(false);
    });

    it('does NOT flag braces inside a fenced code block', () => {
        const withCode = VALID_REQ + '\n```json\n{ "example": "payload" }\n```\n';
        write('docs/req.md', withCode);
        const r = gradeDoc(path.join(root, 'docs', 'req.md'));
        expect(r.pass).toBe(true);
    });

    it('fails when an FR block has no Given/When/Then acceptance criteria', () => {
        // Strip FR-2's AC line, leaving the heading + priority only.
        const noAc = VALID_REQ.replace(
            '  - Given a user with an account, When they request a reset, Then a reset email is sent.\n',
            ''
        );
        write('docs/req.md', noAc);
        const r = gradeDoc(path.join(root, 'docs', 'req.md'));
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toMatch(/FR-2|acceptance criteria/i);
    });

    it('accepts multi-line Gherkin acceptance criteria (F1 regression)', () => {
        // Given/When/Then split across separate lines must still count as AC.
        const multiline = VALID_REQ.replace(
            '  - Given a registered user, When they submit valid credentials, Then they are authenticated.',
            ['  - Given a registered user',
             '  - When they submit valid credentials',
             '  - Then they are authenticated'].join('\n')
        );
        write('docs/req.md', multiline);
        const r = gradeDoc(path.join(root, 'docs', 'req.md'));
        expect(r.pass).toBe(true);
    });

    it('does NOT flag braces inside a tilde-fenced code block (F2 regression)', () => {
        const withTilde = VALID_REQ + '\n~~~json\n{ "example": "payload" }\n~~~\n';
        write('docs/req.md', withTilde);
        const r = gradeDoc(path.join(root, 'docs', 'req.md'));
        expect(r.pass).toBe(true);
    });

    it('fails when every FR is Must Have (no prioritization)', () => {
        const allMust = VALID_REQ.replace('Should Have', 'Must Have');
        write('docs/req.md', allMust);
        const r = gradeDoc(path.join(root, 'docs', 'req.md'));
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toMatch(/must|moscow|priorit/i);
    });

    it('fails all-Must even when priorities carry annotations (Must Have (MVP))', () => {
        // Guard against the `^must have$` anchor evading on a trailing annotation —
        // the all-Must gate must still fire when every FR is `Must Have (MVP)`.
        const annotatedAllMust = VALID_REQ
            .replace('- **Priority**: Must Have', '- **Priority**: Must Have (MVP)')
            .replace('- **Priority**: Should Have', '- **Priority**: Must Have (phase 2)');
        write('docs/req.md', annotatedAllMust);
        const r = gradeDoc(path.join(root, 'docs', 'req.md'));
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toMatch(/must|moscow|priorit/i);
    });

    it('fails when the Success Criteria table has no filled data row', () => {
        const noSuccess = VALID_REQ.replace(
            '| Login success rate | 99% | server access logs |',
            '| {what} | {target} | {how measured} |'
        );
        write('docs/req.md', noSuccess);
        const r = gradeDoc(path.join(root, 'docs', 'req.md'));
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toMatch(/success criteria/i);
    });

    it('grades a Success Criteria section nested at H3, not just H2 (sweep residual)', () => {
        const h3 = VALID_REQ.replace('## Success Criteria', '### Success Criteria');
        write('docs/req.md', h3);
        const r = gradeDoc(path.join(root, 'docs', 'req.md'));
        expect(r.pass).toBe(true);
        expect(r.failures.join(' ')).not.toMatch(/success criteria/i);
    });

    it('closes an FR block on a 5-level (#####) heading — GWT in a subsection is not the FR AC (sweep residual)', () => {
        // FR-3 has no AC of its own; a ##### Examples subsection below it carries a
        // Given/When/Then line. The H5 heading must close the FR block so that line
        // does NOT count as FR-3's acceptance criteria.
        const withSub = VALID_REQ.replace(
            '## Success Criteria',
            [
                '#### FR-3: Reporting',
                '- **Priority**: Could Have',
                '- **Description**: Users can export reports.',
                '##### Examples',
                '- Given a user, When they click export, Then a CSV downloads.',
                '',
                '## Success Criteria',
            ].join('\n')
        );
        write('docs/req.md', withSub);
        const r = gradeDoc(path.join(root, 'docs', 'req.md'));
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toMatch(/FR-3|acceptance criteria/i);
    });

    it('does NOT flag a numeric regex quantifier {3} in prose (sweep residual)', () => {
        write('docs/req.md', VALID_REQ + '\nThe retry policy allows {3} attempts before failing.\n');
        const r = gradeDoc(path.join(root, 'docs', 'req.md'));
        expect(r.pass).toBe(true);
    });

    it('does NOT flag braces inside an inline-code span (sweep residual)', () => {
        write('docs/req.md', VALID_REQ + '\nUse the `{n}` notation to denote a count.\n');
        const r = gradeDoc(path.join(root, 'docs', 'req.md'));
        expect(r.pass).toBe(true);
    });
});

// ── gradeDoc CLI `grade` subcommand (T.1) ────────────────────────────────────
describe('gradeDoc CLI — grade subcommand (T.1)', () => {
    let originalArgv;
    let stdoutCapture;

    beforeEach(() => {
        originalArgv = process.argv.slice();
        stdoutCapture = [];
        vi.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`process.exit(${code ?? 'undefined'})`);
        });
        vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
            stdoutCapture.push(String(s));
            return true;
        });
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        process.argv = originalArgv;
        vi.restoreAllMocks();
        delete require.cache[DOC_DRIFT_PATH];
    });

    function freshMain() {
        delete require.cache[DOC_DRIFT_PATH];
        return require('../../../../.agents/core/_lib/doc-drift').main;
    }

    it('exits non-zero when grading a stub', () => {
        write('docs/req.md', '<!-- @@template -->\n# PRD: {Project Name}\n');
        process.argv = ['node', 'doc-drift.js', 'grade', path.join(root, 'docs', 'req.md')];
        expect(() => freshMain()()).toThrow(/process\.exit\([^0]/);
    });

    it('exits 0 when grading a complete doc', () => {
        write('docs/req.md', [
            '# PRD: Acme',
            '## Functional Requirements',
            '#### FR-1: Login',
            '- **Priority**: Must Have',
            '- **Acceptance Criteria**:',
            '  - Given a user, When they log in, Then they are authenticated.',
            '#### FR-2: Reset',
            '- **Priority**: Should Have',
            '- **Acceptance Criteria**:',
            '  - Given a user, When they reset, Then an email is sent.',
            '## Success Criteria',
            '| Criteria | Target | Measurement |',
            '|---|---|---|',
            '| Uptime | 99.9% | logs |',
            '',
        ].join('\n'));
        process.argv = ['node', 'doc-drift.js', 'grade', path.join(root, 'docs', 'req.md')];
        expect(() => freshMain()()).toThrow('process.exit(0)');
    });
});

// ── isRealDoc ────────────────────────────────────────────────────────────────

describe('isRealDoc', () => {
    it('returns true for a file with real content', () => {
        write('docs/real.md', '# Real content\n');
        expect(isRealDoc(path.join(root, 'docs', 'real.md'))).toBe(true);
    });

    it('returns false for a non-existent file (catch branch, line 64)', () => {
        // Covers the catch branch in isRealDoc at line 64: file not readable → returns false
        expect(isRealDoc(path.join(root, 'docs', 'no-such-file.md'))).toBe(false);
    });

    it('returns false for a template stub (starts with marker)', () => {
        write('docs/stub.md', '<!-- @@template -->\n# stub\n');
        expect(isRealDoc(path.join(root, 'docs', 'stub.md'))).toBe(false);
    });
});

// ── findMisplacedTodos — line 97: readdirSync failure branch ─────────────────

describe('findMisplacedTodos', () => {
    it('returns empty array when docs dir does not exist — covers line 97 catch branch', () => {
        // docsDir does not exist → readdirSync throws → catch { return; } → misplaced stays []
        const nonExistentDocs = path.join(root, 'docs-nonexistent');
        const result = findMisplacedTodos(nonExistentDocs);
        expect(result).toEqual([]);
    });

    it('finds TODO files nested in non-canonical dirs', () => {
        write('docs/subdir/nested/TODO_stale.md');
        const result = findMisplacedTodos(path.join(root, 'docs'));
        expect(result.some(m => m.file.includes('TODO_stale.md'))).toBe(true);
    });

    it('skips design dir (in TODO_SKIP_DIRS)', () => {
        write('docs/design/TODO_design-notes.md');
        const result = findMisplacedTodos(path.join(root, 'docs'));
        expect(result).toHaveLength(0);
    });

    it('skips node_modules dir (in TODO_SKIP_DIRS)', () => {
        write('docs/node_modules/TODO_internal.md');
        const result = findMisplacedTodos(path.join(root, 'docs'));
        expect(result).toHaveLength(0);
    });
});

// ── stripTemplateMarker ──────────────────────────────────────────────────────

describe('stripTemplateMarker', () => {
    let tmpRoot;
    beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strip-marker-')); });
    afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

    function writeTmp(name, content) {
        const p = path.join(tmpRoot, name);
        fs.writeFileSync(p, content);
        return p;
    }

    it('stripTemplateMarker_markerPresent_stripsMarkerAndReturnsTrue', () => {
        const p = writeTmp('doc.md', '<!-- @@template -->\n# Real content\n');
        const result = stripTemplateMarker(p);
        expect(result).toBe(true);
        const after = fs.readFileSync(p, 'utf8');
        expect(after.startsWith('<!-- @@template -->')).toBe(false);
        expect(after).toContain('# Real content');
    });

    it('stripTemplateMarker_markerAbsent_noopReturnsFalse', () => {
        const original = '# Already real content\n';
        const p = writeTmp('doc.md', original);
        const result = stripTemplateMarker(p);
        expect(result).toBe(false);
        const after = fs.readFileSync(p, 'utf8');
        expect(after).toBe(original);
    });

    it('stripTemplateMarker_idempotent_stripTwiceNoChange', () => {
        const p = writeTmp('doc.md', '<!-- @@template -->\n# Content\n');
        stripTemplateMarker(p);
        const afterFirst = fs.readFileSync(p, 'utf8');
        const result = stripTemplateMarker(p);
        expect(result).toBe(false);
        const afterSecond = fs.readFileSync(p, 'utf8');
        expect(afterSecond).toBe(afterFirst);
    });

    it('stripTemplateMarker_afterStrip_isRealDocReturnsTrue', () => {
        const p = writeTmp('doc.md', '<!-- @@template -->\n# Filled backlog\n');
        expect(isRealDoc(p)).toBe(false);  // before strip: it's a stub
        stripTemplateMarker(p);
        expect(isRealDoc(p)).toBe(true);   // after strip: now a real doc
    });

    it('stripTemplateMarker_nonexistentFile_returnsFalse', () => {
        const result = stripTemplateMarker(path.join(tmpRoot, 'no-such-file.md'));
        expect(result).toBe(false);
    });
});

// ── main() — in-process coverage of lines 154-183 ────────────────────────────
// main() is exported from doc-drift.js (behavior-preserving addition).
// Mock process.exit to throw, capture stdout/stderr output, set process.argv.

describe('main() — lines 154-183', () => {
    let originalArgv;
    let stdoutCapture;
    let stderrCapture;

    beforeEach(() => {
        originalArgv = process.argv.slice();
        stdoutCapture = [];
        stderrCapture = [];
        vi.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`process.exit(${code ?? 'undefined'})`);
        });
        vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
            stdoutCapture.push(String(s));
            return true;
        });
        vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
            stderrCapture.push(String(s));
            return true;
        });
    });

    afterEach(() => {
        process.argv = originalArgv;
        vi.restoreAllMocks();
        delete require.cache[DOC_DRIFT_PATH];
    });

    function freshMain() {
        delete require.cache[DOC_DRIFT_PATH];
        return require('../../../../.agents/core/_lib/doc-drift').main;
    }

    function stdout() { return stdoutCapture.join(''); }

    it('exits 0 when no drift detected — covers lines 157-159', () => {
        // Empty project root → docs dir does not exist → no drift
        process.argv = ['node', 'doc-drift.js', root];
        expect(() => freshMain()()).toThrow('process.exit(0)');
        expect(stdout()).toMatch(/No legacy\/duplicate planning docs detected/);
    });

    it('exits 1 and reports legacy docs without canonical counterpart — covers lines 162-169', () => {
        write('docs/_prd.md');
        process.argv = ['node', 'doc-drift.js', root];
        expect(() => freshMain()()).toThrow('process.exit(1)');
        const out = stdout();
        expect(out).toMatch(/Legacy-named docs/);
        expect(out).toMatch(/_prd\.md/);
        expect(out).toMatch(/rename\/migrate to canonical/);
    });

    it('exits 1 and prints BOTH-exist message when legacy and canonical coexist — covers line 167', () => {
        write('docs/_architecture.md');
        write('docs/architecture/overview.md');
        process.argv = ['node', 'doc-drift.js', root];
        expect(() => freshMain()()).toThrow('process.exit(1)');
        expect(stdout()).toMatch(/BOTH exist/);
    });

    it('exits 1 and reports duplicate docs — covers lines 171-174', () => {
        write('docs/_backlog.md');
        write('docs/work/backlog.md');
        process.argv = ['node', 'doc-drift.js', root];
        expect(() => freshMain()()).toThrow('process.exit(1)');
        const out = stdout();
        expect(out).toMatch(/Duplicate docs/);
        expect(out).toMatch(/keep canonical, remove the root copy/);
    });

    it('exits 1 and reports misplaced TODO files — covers lines 176-179', () => {
        write('docs/work/TODO_stale.md');
        process.argv = ['node', 'doc-drift.js', root];
        expect(() => freshMain()()).toThrow('process.exit(1)');
        const out = stdout();
        expect(out).toMatch(/Misplaced TODO files/);
        expect(out).toMatch(/TODO_stale\.md/);
        expect(out).toMatch(/move to docs\/work\/todo\//);
    });

    it('exits 1 and prints reconcile guidance — covers line 181', () => {
        write('docs/_brief.md');
        process.argv = ['node', 'doc-drift.js', root];
        expect(() => freshMain()()).toThrow('process.exit(1)');
        expect(stdout()).toMatch(/Reconcile via \/onboard/);
    });

    it('uses CLAUDE_PROJECT_DIR env var when no argv[2] — covers line 154', () => {
        write('docs/_brief.md');
        process.argv = ['node', 'doc-drift.js'];
        const originalEnv = process.env.CLAUDE_PROJECT_DIR;
        process.env.CLAUDE_PROJECT_DIR = root;
        try {
            expect(() => freshMain()()).toThrow('process.exit(1)');
            expect(stdout()).toMatch(/_brief\.md/);
        } finally {
            if (originalEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
            else process.env.CLAUDE_PROJECT_DIR = originalEnv;
        }
    });
});
