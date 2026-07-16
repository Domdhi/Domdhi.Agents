import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// NOTE: These tests assert the intake LOGIC against synthetic fixtures only.
// They do NOT read the live .claude/skills tree or docs/.output directories.

let m;
let tmpDir;

beforeAll(() => {
    m = require('../skill-evolution');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-eval-'));
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── tokenize ─────────────────────────────────────────────────────────────────

describe('tokenize', () => {
    it('lowercases input', () => {
        const tokens = m.tokenize('UPPERCASE');
        expect(tokens.has('uppercase')).toBe(true);
    });

    it('drops STOPWORDS', () => {
        // "the" is a stopword
        const tokens = m.tokenize('the quick brown fox');
        expect(tokens.has('the')).toBe(false);
    });

    it('drops tokens shorter than 4 characters', () => {
        // "fox" is 3 chars — too short; "quick" is 5 chars — kept
        const tokens = m.tokenize('fox quick');
        expect(tokens.has('fox')).toBe(false);
        expect(tokens.has('quick')).toBe(true);
    });

    it('splits on non-alphanumeric characters', () => {
        // "gate.js" → "gate" + "js" (but "js" < 4 chars → dropped; "gate" kept)
        const tokens = m.tokenize('gate.js spawnSync stderr');
        expect(tokens.has('gate')).toBe(true);
        expect(tokens.has('spawnsync')).toBe(true);
        expect(tokens.has('stderr')).toBe(true);
    });

    it('does not contain "the" (stopword)', () => {
        const tokens = m.tokenize('The gate.js spawnSync stderr');
        expect(tokens.has('the')).toBe(false);
    });

    it('returns a Set (no duplicates)', () => {
        const tokens = m.tokenize('skill skill skill');
        expect(tokens instanceof Set).toBe(true);
        expect(tokens.size).toBe(1); // 'skill' deduped
    });

    it('handles empty string without error', () => {
        const tokens = m.tokenize('');
        expect(tokens instanceof Set).toBe(true);
        expect(tokens.size).toBe(0);
    });

    it('handles null/undefined without error', () => {
        const t1 = m.tokenize(null);
        const t2 = m.tokenize(undefined);
        expect(t1 instanceof Set).toBe(true);
        expect(t2 instanceof Set).toBe(true);
    });

    it('strips markdown-style characters (backtick, asterisk, brackets)', () => {
        // "`code`" → "code"; "[link](url)" → "link" + "url"
        const tokens = m.tokenize('`code` **bold** [link](href)');
        expect(tokens.has('code')).toBe(true);
        expect(tokens.has('bold')).toBe(true);
        expect(tokens.has('link')).toBe(true);
        expect(tokens.has('href')).toBe(true);
    });
});

// ── sharedCount ───────────────────────────────────────────────────────────────

describe('sharedCount', () => {
    it('returns 0 for disjoint sets', () => {
        const a = new Set(['alpha', 'bravo']);
        const b = new Set(['charlie', 'delta']);
        expect(m.sharedCount(a, b)).toBe(0);
    });

    it('returns 1 for one shared token', () => {
        const a = new Set(['alpha', 'shared']);
        const b = new Set(['beta', 'shared']);
        expect(m.sharedCount(a, b)).toBe(1);
    });

    it('returns correct count for multiple shared tokens', () => {
        const a = new Set(['alpha', 'bravo', 'charlie']);
        const b = new Set(['bravo', 'charlie', 'delta']);
        expect(m.sharedCount(a, b)).toBe(2);
    });

    it('returns 0 for empty sets', () => {
        expect(m.sharedCount(new Set(), new Set(['alpha']))).toBe(0);
        expect(m.sharedCount(new Set(['alpha']), new Set())).toBe(0);
    });
});

// ── scoreOverlap + attributeSignal (with buildSkillIndex) ─────────────────────

describe('scoreOverlap + attributeSignal', () => {
    let skillsRoot;
    let skillIndex;

    beforeAll(() => {
        // Build two synthetic skills with distinct domain tokens
        skillsRoot = path.join(tmpDir, 'skills-overlap');

        // skill-alpha: description mentions "postgres" and "database"
        const alphaDir = path.join(skillsRoot, 'postgres-guide');
        fs.mkdirSync(alphaDir, { recursive: true });
        fs.writeFileSync(
            path.join(alphaDir, 'SKILL.md'),
            [
                '---',
                'name: postgres-guide',
                'description: "Use WHEN working with postgres database migrations. Triggers: migration, schema."',
                'user-invocable: false',
                '---',
                '',
                '# Postgres Guide',
                'Content about postgres migrations and schema changes.',
            ].join('\n'),
        );

        // skill-beta: description mentions "playwright" and "testing"
        const betaDir = path.join(skillsRoot, 'playwright-testing');
        fs.mkdirSync(betaDir, { recursive: true });
        fs.writeFileSync(
            path.join(betaDir, 'SKILL.md'),
            [
                '---',
                'name: playwright-testing',
                'description: "Use WHEN running browser automation tests with playwright. Triggers: browser, automation."',
                'user-invocable: false',
                '---',
                '',
                '# Playwright Testing',
                'Content about browser automation and end-to-end testing.',
            ].join('\n'),
        );

        skillIndex = m.buildSkillIndex(skillsRoot);
    });

    it('buildSkillIndex returns one entry per skill dir with SKILL.md', () => {
        expect(skillIndex).toHaveLength(2);
        const dirs = skillIndex.map((s) => s.dir).sort();
        expect(dirs).toEqual(['playwright-testing', 'postgres-guide']);
    });

    it('buildSkillIndex entries have nameTokens and descTokens as Sets', () => {
        for (const entry of skillIndex) {
            expect(entry.nameTokens instanceof Set).toBe(true);
            expect(entry.descTokens instanceof Set).toBe(true);
        }
    });

    it('scoreOverlap returns higher score for matching skill', () => {
        const tokens = m.tokenize('postgres migration schema');
        const postgresEntry = skillIndex.find((s) => s.dir === 'postgres-guide');
        const playwrightEntry = skillIndex.find((s) => s.dir === 'playwright-testing');
        const scoreP = m.scoreOverlap(tokens, postgresEntry);
        const scorePl = m.scoreOverlap(tokens, playwrightEntry);
        expect(scoreP).toBeGreaterThan(scorePl);
    });

    it('attributeSignal returns the right skill for a postgres signal', () => {
        const tokens = m.tokenize('postgres migration database schema');
        const result = m.attributeSignal(tokens, skillIndex);
        expect(result).not.toBeNull();
        expect(result.skill).toBe('postgres-guide');
        expect(result.score).toBeGreaterThanOrEqual(2);
    });

    it('attributeSignal returns the right skill for a playwright signal', () => {
        const tokens = m.tokenize('playwright browser automation testing');
        const result = m.attributeSignal(tokens, skillIndex);
        expect(result).not.toBeNull();
        expect(result.skill).toBe('playwright-testing');
    });

    it('attributeSignal returns null for a below-threshold signal', () => {
        // "abcd" is an unknown token that matches nothing
        const tokens = new Set(['abcd', 'zzzz', 'xxxx']);
        const result = m.attributeSignal(tokens, skillIndex);
        expect(result).toBeNull();
    });

    it('attributeSignal returns null for empty skill index', () => {
        const tokens = m.tokenize('postgres migration');
        const result = m.attributeSignal(tokens, []);
        expect(result).toBeNull();
    });

    it('buildSkillIndex returns empty array for non-existent root', () => {
        const index = m.buildSkillIndex(path.join(tmpDir, 'does-not-exist'));
        expect(index).toEqual([]);
    });

    it('buildSkillIndex skips dirs without SKILL.md', () => {
        const noSkillDir = path.join(skillsRoot, 'no-skill-here');
        fs.mkdirSync(noSkillDir, { recursive: true });
        // No SKILL.md written — should be skipped
        const index = m.buildSkillIndex(skillsRoot);
        const dirs = index.map((s) => s.dir);
        expect(dirs).not.toContain('no-skill-here');
    });

    it('buildSkillIndex counts a symlinked skill dir (bespoke-skill shape)', () => {
        // Adopter bespoke skills are frequently symlinks into ../.agents/skills/ —
        // Dirent.isDirectory() is false for symlinks (same class as skill-conformance.js).
        const linkTarget = path.join(tmpDir, 'agents-skills', 'linked-skill');
        fs.mkdirSync(linkTarget, { recursive: true });
        fs.writeFileSync(
            path.join(linkTarget, 'SKILL.md'),
            ['---', 'name: linked-skill', 'description: "Use WHEN linked."', '---', '', '# Linked'].join('\n'),
        );
        fs.symlinkSync(linkTarget, path.join(skillsRoot, 'linked-skill'), 'dir');
        fs.symlinkSync(path.join(tmpDir, 'nonexistent'), path.join(skillsRoot, 'broken-link'), 'dir');

        const index = m.buildSkillIndex(skillsRoot);
        const dirs = index.map((s) => s.dir);
        expect(dirs).toContain('linked-skill');   // the fix: symlinked dir counts
        expect(dirs).not.toContain('broken-link'); // broken symlink guarded out
    });
});

// ── classifyPolarity + signal-stopword attribution (caught vs slipped) ────────

describe('classifyPolarity', () => {
    it('classifies a slip / escape as slipped', () => {
        expect(m.classifyPolarity('The bug slipped through review.')).toBe('slipped');
        expect(m.classifyPolarity('The agent failed to apply the gate.')).toBe('slipped');
        expect(m.classifyPolarity('A regression went undetected.')).toBe('slipped');
    });

    it('classifies a safeguard firing as caught', () => {
        expect(m.classifyPolarity('The defect was caught by the reviewer.')).toBe('caught');
        expect(m.classifyPolarity('Correctly flagged the missing escaping.')).toBe('caught');
    });

    it('returns neutral when no cue is present', () => {
        expect(m.classifyPolarity('Updated the wording of a heading.')).toBe('neutral');
    });

    it('a slip wins when both cues appear (the slip is the actionable gap)', () => {
        expect(m.classifyPolarity('The reviewer caught a bug the dev agent should have caught.')).toBe('slipped');
    });
});

describe('tokenize with signal-stopwords', () => {
    it('strips signal-vocabulary tokens so a signal does not bind on "agent" alone', () => {
        const t = m.tokenize('the agent dispatch produced wrong output', m.SIGNAL_STOPWORDS);
        expect(t.has('agent')).toBe(false);
        expect(t.has('dispatch')).toBe(false);
        expect(t.has('output')).toBe(false);
        // genuine domain token survives
        expect(t.has('wrong')).toBe(true);
    });

    it('without the extra set, signal tokens are kept (default behavior unchanged)', () => {
        const t = m.tokenize('the agent dispatch');
        expect(t.has('agent')).toBe(true);
        expect(t.has('dispatch')).toBe(true);
    });
});

describe('intake routing: caught review-domain signal → dispatchGaps, not IMPROVE', () => {
    let projectDir;

    beforeAll(() => {
        projectDir = path.join(tmpDir, 'dispatch-gap-project');
        // A real review-domain skill (code-review) so REVIEW_DOMAIN_SKILLS matches.
        const skillDir = path.join(projectDir, '.claude', 'skills', 'code-review');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
            path.join(skillDir, 'SKILL.md'),
            [
                '---',
                'name: code-review',
                'description: "Use WHEN reviewing code changes for correctness and architecture compliance. Triggers: review, correctness, severity."',
                '---',
                '',
                '# Code Review',
                'Content about reviewing code changes for correctness.',
            ].join('\n'),
        );

        const auDir = path.join(projectDir, 'docs', '.output', 'evolution', 'agents');
        fs.mkdirSync(auDir, { recursive: true });
        // A reviewer-CAUGHT defect: the review skill worked → dispatch gap, not skill gap.
        fs.writeFileSync(
            path.join(auDir, '2026-06-06.md'),
            [
                '## Reviewer caught a correctness defect',
                'The code review correctly caught a correctness bug in the changes; ' +
                'severity was assessed correctly. The defect was authored upstream.',
            ].join('\n'),
        );
    });

    it('routes the caught review-domain signal to dispatchGaps and out of improve', () => {
        const result = m.intake({ projectDir });
        expect(result.dispatchGaps.length).toBe(1);
        expect(result.dispatchGaps[0].skill).toBe('code-review');
        // It must NOT also seed an IMPROVE candidate for code-review.
        expect(result.improve.find((i) => i.skill === 'code-review')).toBeUndefined();
    });

    it('intake still exposes the dispatchGaps array on a plain (empty) project', () => {
        const emptyDir = path.join(tmpDir, 'empty-project-dg');
        fs.mkdirSync(emptyDir, { recursive: true });
        const result = m.intake({ projectDir: emptyDir });
        expect(result.dispatchGaps).toEqual([]);
    });
});

// ── clusterMemories ───────────────────────────────────────────────────────────

describe('clusterMemories', () => {
    it('groups two memories sharing ≥ minShared tokens into one cluster', () => {
        const memories = [
            { id: 'a', tokens: new Set(['skill', 'exec', 'bash', 'gate']) },
            { id: 'b', tokens: new Set(['skill', 'exec', 'docker', 'run']) },
            { id: 'c', tokens: new Set(['zebra', 'piano', 'cloud', 'lamp']) },
        ];
        const clusters = m.clusterMemories(memories, { minShared: 2, minSize: 2 });
        // a and b share 'skill' + 'exec' (2 tokens) → should cluster together
        // c is unrelated (0 shared with a or b) → dropped by minSize
        expect(clusters).toHaveLength(1);
        expect(clusters[0]).toHaveLength(2);
    });

    it('drops clusters smaller than minSize', () => {
        const memories = [
            { id: 'a', tokens: new Set(['alpha', 'bravo', 'charlie']) },
            { id: 'b', tokens: new Set(['delta', 'echo', 'foxtrot']) },
        ];
        // No shared tokens → each forms its own cluster of size 1 → all dropped by minSize=2
        const clusters = m.clusterMemories(memories, { minShared: 2, minSize: 2 });
        expect(clusters).toHaveLength(0);
    });

    it('returns empty for empty memories', () => {
        const clusters = m.clusterMemories([], { minShared: 2, minSize: 2 });
        expect(clusters).toEqual([]);
    });

    it('uses default minShared and minSize constants when not specified', () => {
        // CLUSTER_MIN_SHARED=2, CLUSTER_MIN_SIZE=2 from the module
        const memories = [
            { id: 'x', tokens: new Set(['skill', 'exec']) },
            { id: 'y', tokens: new Set(['skill', 'exec']) },
        ];
        const clusters = m.clusterMemories(memories);
        expect(clusters).toHaveLength(1);
    });

    it('handles a large cluster correctly (greedy single-link)', () => {
        // a→b share tokens, b→c share tokens, so all three join one cluster
        const memories = [
            { id: 'a', tokens: new Set(['alpha', 'bravo', 'charlie', 'delta']) },
            { id: 'b', tokens: new Set(['alpha', 'bravo', 'echo', 'foxtrot']) },
            { id: 'c', tokens: new Set(['echo', 'foxtrot', 'golf', 'hotel']) },
        ];
        const clusters = m.clusterMemories(memories, { minShared: 2, minSize: 2 });
        // a and b share 'alpha'+'bravo'; b and c share 'echo'+'foxtrot'
        // greedy: a forms cluster, b joins (shares with a), c joins (shares with b in same cluster)
        expect(clusters).toHaveLength(1);
        expect(clusters[0]).toHaveLength(3);
    });
});

// ── collectAgentUpdates ───────────────────────────────────────────────────────

describe('collectAgentUpdates', () => {
    let auDir;

    beforeAll(() => {
        auDir = path.join(tmpDir, 'agent-updates-test');
        fs.mkdirSync(auDir, { recursive: true });

        // A day-rotated file with two ## sections
        fs.writeFileSync(
            path.join(auDir, '2026-06-05.md'),
            [
                '## First Misalignment',
                'Some agent failed to follow the skill guide.',
                '',
                '## Second Misalignment',
                'Another agent produced wrong output format.',
            ].join('\n'),
        );

        // A README that should be ignored (not matching YYYY-MM-DD.md pattern)
        fs.writeFileSync(path.join(auDir, 'README.md'), '# README — do not collect this\n');

        // An archive file that also should not match
        fs.writeFileSync(path.join(auDir, 'archive.md'), '# Archive\n## Old Entry\nOld stuff.\n');
    });

    it('returns 2 entries from the day-rotated file', () => {
        const updates = m.collectAgentUpdates(auDir);
        expect(updates).toHaveLength(2);
    });

    it('does not include README.md (non-date filename)', () => {
        const updates = m.collectAgentUpdates(auDir);
        const sources = updates.map((u) => u.source);
        expect(sources).not.toContain('README.md');
        expect(sources).not.toContain('archive.md');
    });

    it('each entry has date, context (first-line text), and text fields', () => {
        const updates = m.collectAgentUpdates(auDir);
        for (const u of updates) {
            expect(u).toHaveProperty('date');
            expect(u).toHaveProperty('context');
            expect(u).toHaveProperty('text');
            expect(u.date).toBe('2026-06-05');
        }
    });

    it('context contains the heading text without the ## prefix', () => {
        const updates = m.collectAgentUpdates(auDir);
        const contexts = updates.map((u) => u.context);
        expect(contexts).toContain('First Misalignment');
        expect(contexts).toContain('Second Misalignment');
    });

    it('returns empty array for non-existent dir', () => {
        const updates = m.collectAgentUpdates(path.join(tmpDir, 'does-not-exist'));
        expect(updates).toEqual([]);
    });

    it('reads day-files bucketed under a {YYYY-MM}/ month dir (homed layout)', () => {
        // The ADR-0006 migration month-buckets day-files; the reader must descend one
        // level into {YYYY-MM}/ or it silently returns 0 (the 2026-06-21 false-0 bug).
        const root = path.join(tmpDir, 'au-month-nested');
        const monthDir = path.join(root, '2026-06');
        fs.mkdirSync(monthDir, { recursive: true });
        fs.writeFileSync(path.join(monthDir, '2026-06-13.md'), '## Nested Signal\nbucketed under month dir.\n');
        fs.writeFileSync(path.join(root, '2026-06-20.md'), '## Flat Signal\nflat day-file.\n');  // mixed layout
        const updates = m.collectAgentUpdates(root);
        const contexts = updates.map((u) => u.context);
        expect(contexts).toContain('Nested Signal');   // would be missing without month-descent
        expect(contexts).toContain('Flat Signal');     // flat still read
        expect(updates).toHaveLength(2);
    });
});

// ── collectMemories ────────────────────────────────────────────────────────────

describe('collectMemories', () => {
    let memRoot;

    beforeAll(() => {
        memRoot = path.join(tmpDir, 'memories-test');

        // workflows/x.json
        const workflowsDir = path.join(memRoot, 'workflows');
        fs.mkdirSync(workflowsDir, { recursive: true });
        fs.writeFileSync(
            path.join(workflowsDir, 'x.json'),
            JSON.stringify({
                id: 'workflow-x',
                content: {
                    description: 'How to run the gate.js check pipeline safely.',
                    evidence: 'Discovered during wave-3 implementation in story TDD-2.1.',
                    confidence: 0.8,
                },
                usage_count: 3,
                importance: 4,
            }),
        );

        // patterns/y.json
        const patternsDir = path.join(memRoot, 'patterns');
        fs.mkdirSync(patternsDir, { recursive: true });
        fs.writeFileSync(
            path.join(patternsDir, 'y.json'),
            JSON.stringify({
                id: 'pattern-y',
                content: {
                    description: 'Synthetic fixture pattern for vitest tests avoids live tree.',
                    evidence: 'Validated across skill-conformance, skill-eval, skill-evolution tests.',
                    confidence: 0.9,
                },
                usage_count: 7,
                importance: 5,
            }),
        );
    });

    it('returns 2 entries from workflows/ and patterns/', () => {
        const memories = m.collectMemories(memRoot);
        expect(memories).toHaveLength(2);
    });

    it('each entry has id, category, description, evidence, confidence, usage_count, importance, tokens', () => {
        const memories = m.collectMemories(memRoot);
        for (const mem of memories) {
            expect(mem).toHaveProperty('id');
            expect(mem).toHaveProperty('category');
            expect(mem).toHaveProperty('description');
            expect(mem).toHaveProperty('evidence');
            expect(mem).toHaveProperty('confidence');
            expect(mem).toHaveProperty('usage_count');
            expect(mem).toHaveProperty('importance');
            expect(mem).toHaveProperty('tokens');
            expect(mem.tokens instanceof Set).toBe(true);
        }
    });

    it('tokens Set is non-empty (populated from description + evidence)', () => {
        const memories = m.collectMemories(memRoot);
        for (const mem of memories) {
            expect(mem.tokens.size).toBeGreaterThan(0);
        }
    });

    it('reads the correct categories only when specified', () => {
        const memories = m.collectMemories(memRoot, ['workflows']);
        expect(memories).toHaveLength(1);
        expect(memories[0].category).toBe('workflows');
    });

    it('returns empty array when memRoot does not exist', () => {
        const memories = m.collectMemories(path.join(tmpDir, 'does-not-exist'));
        expect(memories).toEqual([]);
    });

    it('skips malformed JSON files without throwing', () => {
        const badDir = path.join(memRoot, 'constraints');
        fs.mkdirSync(badDir, { recursive: true });
        fs.writeFileSync(path.join(badDir, 'bad.json'), 'NOT VALID JSON {{{');
        // Should not throw; the bad file is skipped
        const memories = m.collectMemories(memRoot, ['constraints']);
        expect(memories).toEqual([]);
    });
});

// ── check (conformance gate) ──────────────────────────────────────────────────

describe('check', () => {
    let checkDir;

    beforeAll(() => {
        checkDir = path.join(tmpDir, 'check-test');
        fs.mkdirSync(checkDir, { recursive: true });
    });

    it('returns {ok:true} for a conforming candidate', () => {
        const candidateFile = path.join(checkDir, 'good-skill.md');
        fs.writeFileSync(
            candidateFile,
            [
                '---',
                'name: good-skill',
                'description: "Use WHEN implementing the happy path. Triggers: happy, path."',
                'user-invocable: false',
                '---',
                '',
                '# Good Skill',
                'This skill does useful things.',
                ...Array(50).fill('Line of content.'), // well under 500 lines
            ].join('\n'),
        );
        const result = m.check('good-skill', candidateFile);
        expect(result.ok).toBe(true);
        expect(result.findings.filter((f) => f.severity === 'ERROR')).toHaveLength(0);
    });

    it('returns {ok:false} with NAME_MISMATCH ERROR when name/dir mismatch', () => {
        const candidateFile = path.join(checkDir, 'mismatched.md');
        fs.writeFileSync(
            candidateFile,
            [
                '---',
                'name: wrong-name',
                'description: "Use WHEN something. Triggers: something."',
                'user-invocable: false',
                '---',
                '',
                '# Content',
            ].join('\n'),
        );
        const result = m.check('correct-name', candidateFile);
        expect(result.ok).toBe(false);
        const nameFinding = result.findings.find((f) => f.code === 'NAME_MISMATCH');
        expect(nameFinding).toBeDefined();
        expect(nameFinding.severity).toBe('ERROR');
    });

    it('returns {ok:false} with error when candidate file does not exist', () => {
        const result = m.check('any-skill', path.join(checkDir, 'nonexistent.md'));
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/not found/i);
    });

    it('returns DESC_TOO_LONG ERROR for a description over 1024 chars', () => {
        const longDesc = 'x'.repeat(1100);
        const candidateFile = path.join(checkDir, 'long-desc.md');
        fs.writeFileSync(
            candidateFile,
            [
                '---',
                `name: long-desc`,
                `description: "${longDesc}"`,
                '---',
                '',
                '# Content',
            ].join('\n'),
        );
        const result = m.check('long-desc', candidateFile);
        expect(result.ok).toBe(false);
        const descFinding = result.findings.find((f) => f.code === 'DESC_TOO_LONG');
        expect(descFinding).toBeDefined();
        expect(descFinding.severity).toBe('ERROR');
    });
});

// ── intake ────────────────────────────────────────────────────────────────────

describe('intake', () => {
    let projectDir;

    beforeAll(() => {
        projectDir = path.join(tmpDir, 'intake-test-project');

        // .claude/skills/<one skill>/SKILL.md
        const skillDir = path.join(projectDir, '.claude', 'skills', 'test-skill');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
            path.join(skillDir, 'SKILL.md'),
            [
                '---',
                'name: test-skill',
                'description: "Use WHEN debugging gate pipeline failures. Triggers: gate, pipeline, debug."',
                'user-invocable: false',
                '---',
                '',
                '# Test Skill',
                'Content about gate debugging and pipeline failures.',
            ].join('\n'),
        );

        // docs/.output/evolution/agents/2026-06-05.md with one section
        const auDir = path.join(projectDir, 'docs', '.output', 'evolution', 'agents');
        fs.mkdirSync(auDir, { recursive: true });
        fs.writeFileSync(
            path.join(auDir, '2026-06-05.md'),
            [
                '## Gate Pipeline Debug Failure',
                'The agent failed to follow the gate debugging workflow.',
                'The pipeline gate process was not correctly applied during the task.',
            ].join('\n'),
        );

        // docs/.output/.memory/workflows/wf1.json
        const workflowsDir = path.join(projectDir, 'docs', '.output', '.memory', 'workflows');
        fs.mkdirSync(workflowsDir, { recursive: true });
        fs.writeFileSync(
            path.join(workflowsDir, 'wf1.json'),
            JSON.stringify({
                id: 'wf1',
                content: {
                    description: 'Vitest fixture pattern ensures test isolation from live tree.',
                    evidence: 'Used in skill-conformance and skill-eval tests.',
                    confidence: 0.7,
                },
                usage_count: 2,
                importance: 3,
            }),
        );

        // docs/.output/.memory/patterns/pt1.json
        const patternsDir = path.join(projectDir, 'docs', '.output', '.memory', 'patterns');
        fs.mkdirSync(patternsDir, { recursive: true });
        fs.writeFileSync(
            path.join(patternsDir, 'pt1.json'),
            JSON.stringify({
                id: 'pt1',
                content: {
                    description: 'Vitest fixture pattern ensures test isolation from live tree.',
                    evidence: 'Confirmed in multiple test rewrites across skill modules.',
                    confidence: 0.8,
                },
                usage_count: 5,
                importance: 4,
            }),
        );
    });

    it('returns an object with signals, improve, create, unattributed keys', () => {
        const result = m.intake({ projectDir });
        expect(result).toHaveProperty('signals');
        expect(result).toHaveProperty('improve');
        expect(result).toHaveProperty('create');
        expect(result).toHaveProperty('unattributed');
    });

    it('signals.agentUpdates counts the collected sections', () => {
        const result = m.intake({ projectDir });
        // One section in the agent-updates file
        expect(result.signals.agentUpdates).toBe(1);
    });

    it('signals.memories counts the collected memory files', () => {
        const result = m.intake({ projectDir });
        // Two memory files (wf1 + pt1)
        expect(result.signals.memories).toBe(2);
    });

    it('improve is an array', () => {
        const result = m.intake({ projectDir });
        expect(Array.isArray(result.improve)).toBe(true);
    });

    it('create is an array', () => {
        const result = m.intake({ projectDir });
        expect(Array.isArray(result.create)).toBe(true);
    });

    it('unattributed is an array', () => {
        const result = m.intake({ projectDir });
        expect(Array.isArray(result.unattributed)).toBe(true);
    });

    it('total signals are sane (agentUpdates + memories >= 0)', () => {
        const result = m.intake({ projectDir });
        expect(result.signals.agentUpdates).toBeGreaterThanOrEqual(0);
        expect(result.signals.memories).toBeGreaterThanOrEqual(0);
        expect(result.signals.clusters).toBeGreaterThanOrEqual(0);
    });

    it('improve entries each have skill and evidence keys', () => {
        const result = m.intake({ projectDir });
        for (const entry of result.improve) {
            expect(entry).toHaveProperty('skill');
            expect(entry).toHaveProperty('evidence');
            expect(Array.isArray(entry.evidence)).toBe(true);
        }
    });

    it('create entries each have proposedName, memberIds, size, keywords', () => {
        const result = m.intake({ projectDir });
        for (const entry of result.create) {
            expect(entry).toHaveProperty('proposedName');
            expect(entry).toHaveProperty('memberIds');
            expect(entry).toHaveProperty('size');
            expect(entry).toHaveProperty('keywords');
        }
    });

    it('works without crashing when dirs are absent (empty project)', () => {
        const emptyDir = path.join(tmpDir, 'empty-project');
        fs.mkdirSync(emptyDir, { recursive: true });
        const result = m.intake({ projectDir: emptyDir });
        expect(result.signals.agentUpdates).toBe(0);
        expect(result.signals.memories).toBe(0);
        expect(result.improve).toEqual([]);
        expect(result.create).toEqual([]);
        expect(result.unattributed).toEqual([]);
    });
});

// ── extractFailureTraces (T.11 / GEPA trace-mining) ──────────────────────────
// Pulls per-assertion failure evidence out of a benchmark so the evolve-skills
// proposer can diagnose from the trace, not just the scalar pass-rate.
// Contract: extractFailureTraces(benchmark) → [{ eval_name, assertion, evidence: string[] }]
// only for assertions whose evidence_on_fail is non-empty.

describe('extractFailureTraces (T.11)', () => {
    it('returns one trace per assertion that has failure evidence', () => {
        const benchmark = {
            skill_name: 'demo',
            evals: [
                {
                    eval_name: 'eval-A',
                    assertions: [
                        { text: 'seeds the DB', evidence_on_fail: ['no INSERT observed', 'still none'] },
                        { text: 'returns 200', evidence_on_fail: [] },
                    ],
                },
                {
                    eval_name: 'eval-B',
                    assertions: [
                        { text: 'handles empty input', evidence_on_fail: ['threw on []'] },
                    ],
                },
            ],
        };
        const traces = m.extractFailureTraces(benchmark);
        expect(traces).toEqual([
            { eval_name: 'eval-A', assertion: 'seeds the DB', evidence: ['no INSERT observed', 'still none'] },
            { eval_name: 'eval-B', assertion: 'handles empty input', evidence: ['threw on []'] },
        ]);
    });

    it('returns an empty array when no assertion has failure evidence', () => {
        const benchmark = {
            evals: [{ eval_name: 'clean', assertions: [{ text: 'x', evidence_on_fail: [] }] }],
        };
        expect(m.extractFailureTraces(benchmark)).toEqual([]);
    });

    it('tolerates a benchmark with no evals / missing fields', () => {
        expect(m.extractFailureTraces({})).toEqual([]);
        expect(m.extractFailureTraces({ evals: [] })).toEqual([]);
        expect(m.extractFailureTraces({ evals: [{ eval_name: 'e' }] })).toEqual([]);
    });
});

// ── status (CLI) ─────────────────────────────────────────────────────────────
// Spawn-level: the status reader must list every layout the intake writer can
// produce — flat {YYYY-MM-DD}/, month-nested {YYYY-MM}/{YYYY-MM-DD}/, AND the
// no-date default latest/ — ordered by run date newest-first regardless of
// where a run lives. A reader that filters to date-shaped names only silently
// dropped latest/; sorting relative paths listed nested runs above newer flat
// ones ('-' < '/').

describe('status CLI', () => {
    function runStatus(projectRoot) {
        const { execFileSync } = require('node:child_process');
        const script = path.resolve(__dirname, '..', 'skill-evolution.js');
        return execFileSync('node', [script, 'status'], {
            env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
            stdio: 'pipe',
        }).toString();
    }

    function mkRun(root, rel) {
        const dir = path.join(root, 'docs', '.output', 'evolution', 'skills', rel);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'intake.md'), '# intake\n');
    }

    it('status_mixedLayouts_listsLatestAndSortsByRunDate', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-evo-status-'));
        try {
            mkRun(root, 'latest');
            mkRun(root, path.join('2026-06', '2026-06-13')); // month-nested, OLDER
            mkRun(root, '2026-06-20');                       // flat, NEWER
            const out = runStatus(root);
            const lines = out.trim().split('\n');
            expect(lines).toEqual([
                '- latest/intake.md',
                '- 2026-06-20/intake.md',
                '- 2026-06/2026-06-13/intake.md',
            ]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('status_sameDateFlatAndNested_listedOnce', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-evo-status-'));
        try {
            mkRun(root, '2026-06-13');
            mkRun(root, path.join('2026-06', '2026-06-13'));
            const out = runStatus(root);
            const hits = out.trim().split('\n').filter((l) => l.includes('2026-06-13'));
            expect(hits).toHaveLength(1);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
