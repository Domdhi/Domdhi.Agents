import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// ── module load ──────────────────────────────────────────────────────────────

describe('council', () => {
    let council;

    beforeAll(() => {
        council = require('../council');
    });

    it('loads without side effects and exports all public symbols', () => {
        expect(council).toBeDefined();
        expect(typeof council.normalizeTitle).toBe('function');
        expect(typeof council.findingKey).toBe('function');
        expect(typeof council.severityRank).toBe('function');
        expect(typeof council.maxSeverity).toBe('function');
        expect(typeof council.dedupeFindings).toBe('function');
        expect(typeof council.anonymize).toBe('function');
        expect(typeof council.consensusSeverity).toBe('function');
        expect(typeof council.tallyVotes).toBe('function');
        expect(typeof council.classify).toBe('function');
        expect(typeof council.aggregateCouncil).toBe('function');
        expect(typeof council.renderCouncilMd).toBe('function');
        expect(typeof council.LENSES).toBe('object');
        expect(typeof council.SEVERITY_ORDER).toBe('object');
        expect(Array.isArray(council.SEVERITY_NAME)).toBe(true);
    });

    // ── normalizeTitle ───────────────────────────────────────────────────────

    describe('normalizeTitle', () => {
        it('lowercases, strips punctuation, collapses whitespace', () => {
            expect(council.normalizeTitle('SQL  injection!!')).toBe('sql injection');
        });

        it('strips trailing and leading punctuation / whitespace', () => {
            expect(council.normalizeTitle('  Hello, World!  ')).toBe('hello world');
        });

        it('strips non-alphanumeric characters', () => {
            expect(council.normalizeTitle('N+1 query (#critical)')).toBe('n 1 query critical');
        });

        it('collapses multiple internal spaces into one', () => {
            expect(council.normalizeTitle('a   b   c')).toBe('a b c');
        });

        it('returns empty string for empty or falsy input', () => {
            expect(council.normalizeTitle('')).toBe('');
            expect(council.normalizeTitle(null)).toBe('');
            expect(council.normalizeTitle(undefined)).toBe('');
        });

        it('handles already-normalized input unchanged', () => {
            expect(council.normalizeTitle('sql injection')).toBe('sql injection');
        });

        it('strips underscores and hyphens (non-alphanumeric)', () => {
            expect(council.normalizeTitle('unused-variable_name')).toBe('unused variable name');
        });
    });

    // ── findingKey ───────────────────────────────────────────────────────────

    describe('findingKey', () => {
        it('same file + line + title (normalized) → identical key', () => {
            const a = { file: 'src/foo.js', line: 42, title: 'SQL injection!!' };
            const b = { file: 'src/foo.js', line: 42, title: 'SQL injection' };
            expect(council.findingKey(a)).toBe(council.findingKey(b));
        });

        it('differing punctuation / case in title still collides', () => {
            const a = { file: 'auth.js', line: 10, title: 'XSS Vulnerability!!' };
            const b = { file: 'auth.js', line: 10, title: 'xss vulnerability' };
            expect(council.findingKey(a)).toBe(council.findingKey(b));
        });

        it('different line number → different key', () => {
            const a = { file: 'auth.js', line: 10, title: 'XSS' };
            const b = { file: 'auth.js', line: 99, title: 'XSS' };
            expect(council.findingKey(a)).not.toBe(council.findingKey(b));
        });

        it('different file → different key', () => {
            const a = { file: 'auth.js', line: 10, title: 'XSS' };
            const b = { file: 'db.js', line: 10, title: 'XSS' };
            expect(council.findingKey(a)).not.toBe(council.findingKey(b));
        });

        it('missing line uses empty string (not undefined)', () => {
            const a = { file: 'foo.js', title: 'bug' };
            const b = { file: 'foo.js', line: undefined, title: 'bug' };
            expect(council.findingKey(a)).toBe(council.findingKey(b));
        });
    });

    // ── severityRank ─────────────────────────────────────────────────────────

    describe('severityRank', () => {
        it('CRITICAL > MAJOR > MINOR > NIT', () => {
            expect(council.severityRank('CRITICAL')).toBeGreaterThan(council.severityRank('MAJOR'));
            expect(council.severityRank('MAJOR')).toBeGreaterThan(council.severityRank('MINOR'));
            expect(council.severityRank('MINOR')).toBeGreaterThan(council.severityRank('NIT'));
        });

        it('returns exact numeric values', () => {
            expect(council.severityRank('CRITICAL')).toBe(3);
            expect(council.severityRank('MAJOR')).toBe(2);
            expect(council.severityRank('MINOR')).toBe(1);
            expect(council.severityRank('NIT')).toBe(0);
        });

        it('case-insensitive', () => {
            expect(council.severityRank('critical')).toBe(3);
            expect(council.severityRank('Major')).toBe(2);
        });

        it('unknown severity → 0 (treated as NIT)', () => {
            expect(council.severityRank('UNKNOWN')).toBe(0);
            expect(council.severityRank(null)).toBe(0);
            expect(council.severityRank(undefined)).toBe(0);
        });
    });

    // ── maxSeverity ──────────────────────────────────────────────────────────

    describe('maxSeverity', () => {
        it('returns the higher severity string', () => {
            expect(council.maxSeverity('CRITICAL', 'MAJOR')).toBe('CRITICAL');
            expect(council.maxSeverity('MINOR', 'CRITICAL')).toBe('CRITICAL');
            expect(council.maxSeverity('NIT', 'MAJOR')).toBe('MAJOR');
            expect(council.maxSeverity('MINOR', 'NIT')).toBe('MINOR');
        });

        it('returns a when equal', () => {
            // severityRank(a) >= severityRank(b) → a wins on equality
            expect(council.maxSeverity('MAJOR', 'MAJOR')).toBe('MAJOR');
            expect(council.maxSeverity('CRITICAL', 'CRITICAL')).toBe('CRITICAL');
        });

        it('returns severity strings, not rank numbers', () => {
            const result = council.maxSeverity('CRITICAL', 'MINOR');
            expect(typeof result).toBe('string');
            expect(result).toBe('CRITICAL');
        });
    });

    // ── dedupeFindings ───────────────────────────────────────────────────────

    describe('dedupeFindings', () => {
        it('two findings with same file+line and titles differing only by punctuation/case → one finding', () => {
            const findings = [
                { file: 'auth.js', line: 10, title: 'SQL Injection!!', severity: 'MAJOR', lens: 'security' },
                { file: 'auth.js', line: 10, title: 'sql injection', severity: 'CRITICAL', lens: 'correctness' },
            ];
            const result = council.dedupeFindings(findings);
            expect(result).toHaveLength(1);
        });

        it('merged finding has raisedBy with both lenses sorted', () => {
            const findings = [
                { file: 'auth.js', line: 10, title: 'SQL Injection', severity: 'MAJOR', lens: 'security' },
                { file: 'auth.js', line: 10, title: 'SQL Injection', severity: 'CRITICAL', lens: 'correctness' },
            ];
            const [f] = council.dedupeFindings(findings);
            expect(f.raisedBy).toEqual(['correctness', 'security']);
        });

        it('merged finding severity escalated to max of the two', () => {
            const findings = [
                { file: 'auth.js', line: 10, title: 'SQL Injection', severity: 'MAJOR', lens: 'security' },
                { file: 'auth.js', line: 10, title: 'SQL Injection', severity: 'CRITICAL', lens: 'correctness' },
            ];
            const [f] = council.dedupeFindings(findings);
            expect(f.severity).toBe('CRITICAL');
        });

        it('ids are assigned in deterministic sort order (file → line → title)', () => {
            const findings = [
                { file: 'z.js', line: 1, title: 'Bug Z', severity: 'MINOR', lens: 'correctness' },
                { file: 'a.js', line: 1, title: 'Bug A', severity: 'MINOR', lens: 'correctness' },
                { file: 'a.js', line: 2, title: 'Bug A2', severity: 'MINOR', lens: 'correctness' },
            ];
            const result = council.dedupeFindings(findings);
            expect(result[0].id).toBe('F0');
            expect(result[0].file).toBe('a.js');
            expect(result[0].line).toBe(1);
            expect(result[1].id).toBe('F1');
            expect(result[1].file).toBe('a.js');
            expect(result[1].line).toBe(2);
            expect(result[2].id).toBe('F2');
            expect(result[2].file).toBe('z.js');
        });

        it('ids start at F0 with stable numbering', () => {
            const findings = [
                { file: 'foo.js', line: 1, title: 'Bug', severity: 'MINOR', lens: 'correctness' },
            ];
            const [f] = council.dedupeFindings(findings);
            expect(f.id).toBe('F0');
        });

        it('raisedBy is deduped — same lens added twice produces only one entry', () => {
            const findings = [
                { file: 'a.js', line: 1, title: 'Bug', severity: 'MINOR', lens: 'security' },
                { file: 'a.js', line: 1, title: 'Bug', severity: 'MINOR', lens: 'security' },
            ];
            const [f] = council.dedupeFindings(findings);
            expect(f.raisedBy).toEqual(['security']);
        });

        it('raisedBy is sorted alphabetically', () => {
            const findings = [
                { file: 'a.js', line: 1, title: 'T', severity: 'MINOR', lens: 'security' },
                { file: 'a.js', line: 1, title: 'T', severity: 'MINOR', lens: 'architecture' },
                { file: 'a.js', line: 1, title: 'T', severity: 'MINOR', lens: 'correctness' },
            ];
            const [f] = council.dedupeFindings(findings);
            expect(f.raisedBy).toEqual(['architecture', 'correctness', 'security']);
        });

        it('handles empty array', () => {
            expect(council.dedupeFindings([])).toEqual([]);
        });

        it('handles null/undefined gracefully', () => {
            expect(council.dedupeFindings(null)).toEqual([]);
            expect(council.dedupeFindings(undefined)).toEqual([]);
        });

        it('two findings with different lines remain separate', () => {
            const findings = [
                { file: 'a.js', line: 1, title: 'Bug', severity: 'MINOR', lens: 'security' },
                { file: 'a.js', line: 2, title: 'Bug', severity: 'MINOR', lens: 'correctness' },
            ];
            expect(council.dedupeFindings(findings)).toHaveLength(2);
        });
    });

    // ── anonymize ────────────────────────────────────────────────────────────

    describe('anonymize', () => {
        it('maps sorted lens keys to Reviewer A, B, … in sorted order', () => {
            const result = council.anonymize(['security', 'correctness', 'architecture']);
            // sorted: architecture, correctness, security
            expect(result['architecture']).toBe('Reviewer A');
            expect(result['correctness']).toBe('Reviewer B');
            expect(result['security']).toBe('Reviewer C');
        });

        it('deduplicates input', () => {
            const result = council.anonymize(['security', 'security', 'correctness']);
            const keys = Object.keys(result);
            expect(keys).toHaveLength(2);
            expect(result['correctness']).toBe('Reviewer A');
            expect(result['security']).toBe('Reviewer B');
        });

        it('single lens → Reviewer A', () => {
            const result = council.anonymize(['performance']);
            expect(result['performance']).toBe('Reviewer A');
        });

        it('empty array → empty map', () => {
            const result = council.anonymize([]);
            expect(result).toEqual({});
        });
    });

    // ── consensusSeverity ────────────────────────────────────────────────────

    describe('consensusSeverity', () => {
        it('original MAJOR + votes [CRITICAL, MINOR] → median is MAJOR', () => {
            // ranks: [2 (MAJOR), 3 (CRITICAL), 1 (MINOR)] → sorted [1, 2, 3]
            // mid index = Math.floor((3-1)/2) = 1 → rank 2 → MAJOR
            const votes = [
                { finding_id: 'F0', voter: 'performance', verdict: 'confirm', severity_vote: 'CRITICAL' },
                { finding_id: 'F0', voter: 'architecture', verdict: 'confirm', severity_vote: 'MINOR' },
            ];
            expect(council.consensusSeverity('MAJOR', votes)).toBe('MAJOR');
        });

        it('no votes → returns original severity', () => {
            expect(council.consensusSeverity('CRITICAL', [])).toBe('CRITICAL');
            expect(council.consensusSeverity('MINOR', [])).toBe('MINOR');
        });

        it('single vote upgrades when higher', () => {
            // ranks: [1 (MINOR), 3 (CRITICAL)] → sorted [1, 3]
            // mid = Math.floor((2-1)/2) = 0 → rank 1 → MINOR (lower quantile wins on small N)
            const votes = [{ severity_vote: 'CRITICAL' }];
            expect(council.consensusSeverity('MINOR', votes)).toBe('MINOR');
        });

        it('two equal votes keep the severity', () => {
            const votes = [
                { severity_vote: 'MAJOR' },
                { severity_vote: 'MAJOR' },
            ];
            // ranks: [2, 2, 2] → sorted [2, 2, 2] → mid=1 → rank 2 → MAJOR
            expect(council.consensusSeverity('MAJOR', votes)).toBe('MAJOR');
        });

        it('votes without severity_vote are ignored', () => {
            const votes = [
                { finding_id: 'F0', voter: 'correctness', verdict: 'confirm' },
            ];
            expect(council.consensusSeverity('MINOR', votes)).toBe('MINOR');
        });

        it('odd number of votes: CRITICAL + [MAJOR, MAJOR] → MAJOR', () => {
            // ranks: [3, 2, 2] → sorted [2, 2, 3] → mid=1 → rank 2 → MAJOR
            const votes = [
                { severity_vote: 'MAJOR' },
                { severity_vote: 'MAJOR' },
            ];
            expect(council.consensusSeverity('CRITICAL', votes)).toBe('MAJOR');
        });
    });

    // ── tallyVotes ───────────────────────────────────────────────────────────

    describe('tallyVotes', () => {
        it('independentRaises is at least 1 even if raisedBy is empty', () => {
            const finding = { id: 'F0', raisedBy: [] };
            const tally = council.tallyVotes(finding, []);
            expect(tally.independentRaises).toBe(1);
            expect(tally.confirms).toBe(1);
        });

        it('raisedBy with 2 lenses → independentRaises=2 → confirms=2 with no cross votes', () => {
            const finding = { id: 'F0', raisedBy: ['security', 'correctness'] };
            const tally = council.tallyVotes(finding, []);
            expect(tally.independentRaises).toBe(2);
            expect(tally.confirms).toBe(2);
            expect(tally.crossConfirms).toBe(0);
        });

        it('a cross confirm from a non-raiser lens increments crossConfirms and confirms', () => {
            const finding = { id: 'F0', raisedBy: ['security', 'correctness'] };
            const votes = [
                { finding_id: 'F0', voter: 'performance', verdict: 'confirm' },
            ];
            const tally = council.tallyVotes(finding, votes);
            expect(tally.crossConfirms).toBe(1);
            expect(tally.confirms).toBe(3); // 2 raises + 1 cross
        });

        it('a refute increments refutes', () => {
            const finding = { id: 'F0', raisedBy: ['security'] };
            const votes = [
                { finding_id: 'F0', voter: 'performance', verdict: 'refute' },
            ];
            const tally = council.tallyVotes(finding, votes);
            expect(tally.refutes).toBe(1);
        });

        it('a vote from a lens already in raisedBy is ignored (does not add a confirm)', () => {
            const finding = { id: 'F0', raisedBy: ['security', 'correctness'] };
            const votes = [
                { finding_id: 'F0', voter: 'security', verdict: 'confirm' },
            ];
            const tally = council.tallyVotes(finding, votes);
            // security is already a raiser; self-confirm is ignored
            expect(tally.crossConfirms).toBe(0);
            expect(tally.confirms).toBe(2); // still just the 2 independent raises
        });

        it('unsure votes increment unsure counter', () => {
            const finding = { id: 'F0', raisedBy: ['security'] };
            const votes = [
                { finding_id: 'F0', voter: 'performance', verdict: 'unsure' },
            ];
            const tally = council.tallyVotes(finding, votes);
            expect(tally.unsure).toBe(1);
            expect(tally.crossConfirms).toBe(0);
            expect(tally.refutes).toBe(0);
        });

        it('votes for other finding ids are ignored', () => {
            const finding = { id: 'F0', raisedBy: ['security'] };
            const votes = [
                { finding_id: 'F1', voter: 'performance', verdict: 'confirm' },
            ];
            const tally = council.tallyVotes(finding, votes);
            expect(tally.crossConfirms).toBe(0);
            expect(tally.confirms).toBe(1); // only the independent raise
        });

        it('handles null/undefined votes gracefully', () => {
            const finding = { id: 'F0', raisedBy: ['security'] };
            expect(() => council.tallyVotes(finding, null)).not.toThrow();
            const tally = council.tallyVotes(finding, null);
            expect(tally.confirms).toBe(1);
        });
    });

    // ── classify ─────────────────────────────────────────────────────────────

    describe('classify', () => {
        it('≥2 confirms and confirms > refutes → confirmed', () => {
            const finding = { severity: 'MINOR' };
            const tally = { confirms: 2, refutes: 0 };
            expect(council.classify(finding, tally)).toBe('confirmed');
        });

        it('≥2 confirms and confirms > refutes (with some refutes, low severity) → confirmed', () => {
            const finding = { severity: 'MINOR' };
            const tally = { confirms: 3, refutes: 1 };
            expect(council.classify(finding, tally)).toBe('confirmed');
        });

        it('non-high (NIT/MINOR) finding with refutes > confirms → refuted', () => {
            const finding = { severity: 'MINOR' };
            const tally = { confirms: 1, refutes: 2 };
            expect(council.classify(finding, tally)).toBe('refuted');
        });

        it('NIT finding with refutes > confirms → refuted', () => {
            const finding = { severity: 'NIT' };
            const tally = { confirms: 1, refutes: 2 };
            expect(council.classify(finding, tally)).toBe('refuted');
        });

        it('CRITICAL finding with refutes > confirms → contested (NEVER refuted)', () => {
            const finding = { severity: 'CRITICAL' };
            const tally = { confirms: 1, refutes: 3 };
            expect(council.classify(finding, tally)).toBe('contested');
        });

        // M8: only a CRITICAL is immune from outright 'refuted' (per the docstring).
        // A MAJOR with more refutes than confirms IS refuted — the old code used
        // `isHigh = >= MAJOR` for the immunity branch, wrongly shielding MAJOR too.
        it('MAJOR finding with refutes > confirms → refuted (only CRITICAL is immune)', () => {
            const finding = { severity: 'MAJOR' };
            const tally = { confirms: 1, refutes: 2 };
            expect(council.classify(finding, tally)).toBe('refuted');
        });

        it('MAJOR refuted by ALL votes → refuted', () => {
            const finding = { severity: 'MAJOR' };
            const tally = { confirms: 1, refutes: 4 }; // independentRaises floors confirms at 1
            expect(council.classify(finding, tally)).toBe('refuted');
        });

        it('single-lens finding with 0 votes → unconfirmed', () => {
            const finding = { severity: 'MINOR' };
            const tally = { confirms: 1, refutes: 0 };
            expect(council.classify(finding, tally)).toBe('unconfirmed');
        });

        it('CRITICAL with ≥2 confirms and 0 refutes → confirmed', () => {
            const finding = { severity: 'CRITICAL' };
            const tally = { confirms: 2, refutes: 0 };
            expect(council.classify(finding, tally)).toBe('confirmed');
        });

        it('MAJOR with ≥2 confirms and some refutes → contested', () => {
            // confirms > refutes but isHigh + refutes > 0 → contested
            const finding = { severity: 'MAJOR' };
            const tally = { confirms: 3, refutes: 1 };
            expect(council.classify(finding, tally)).toBe('contested');
        });

        it('refutes > 0 but confirms also > refutes for MINOR → confirmed (MINOR not high)', () => {
            // confirms=3 > refutes=1, MINOR is not high, so: confirmed
            const finding = { severity: 'MINOR' };
            const tally = { confirms: 3, refutes: 1 };
            expect(council.classify(finding, tally)).toBe('confirmed');
        });

        it('single-lens with one refute → contested (refutes not > confirms, but refutes > 0)', () => {
            // confirms=1, refutes=1 → refutes not > confirms → skip first branch
            // confirms < 2 → skip second branch
            // refutes > 0 → contested
            const finding = { severity: 'MINOR' };
            const tally = { confirms: 1, refutes: 1 };
            expect(council.classify(finding, tally)).toBe('contested');
        });
    });

    // ── aggregateCouncil ─────────────────────────────────────────────────────

    describe('aggregateCouncil', () => {
        function makeDeduped(overrides = {}) {
            return {
                id: 'F0',
                file: 'a.js',
                line: 1,
                title: 'Test bug',
                severity: 'MINOR',
                raisedBy: ['correctness'],
                detail: '',
                ...overrides,
            };
        }

        it('returns the required shape', () => {
            const findings = [makeDeduped()];
            const result = council.aggregateCouncil(findings, []);
            expect(result).toHaveProperty('anonymization');
            expect(result).toHaveProperty('n_reviewers');
            expect(result).toHaveProperty('stats');
            expect(result).toHaveProperty('findings');
            expect(result.stats).toHaveProperty('deduped');
            expect(result.stats).toHaveProperty('confirmed');
            expect(result.stats).toHaveProperty('contested');
            expect(result.stats).toHaveProperty('unconfirmed');
            expect(result.stats).toHaveProperty('refuted');
        });

        it('stats counts are internally consistent (sum of statuses === deduped)', () => {
            const findings = [
                makeDeduped({ id: 'F0', raisedBy: ['correctness', 'security'], severity: 'MINOR' }),
                makeDeduped({ id: 'F1', file: 'b.js', raisedBy: ['correctness'], severity: 'CRITICAL' }),
                makeDeduped({ id: 'F2', file: 'c.js', raisedBy: ['correctness'], severity: 'NIT' }),
            ];
            const votes = [
                { finding_id: 'F2', voter: 'security', verdict: 'refute' },
                { finding_id: 'F2', voter: 'performance', verdict: 'refute' },
            ];
            const result = council.aggregateCouncil(findings, votes);
            const { confirmed, contested, unconfirmed, refuted, deduped } = result.stats;
            expect(confirmed + contested + unconfirmed + refuted).toBe(deduped);
        });

        it('confirmed finding comes first in sorted output', () => {
            const findings = [
                makeDeduped({ id: 'F0', file: 'b.js', raisedBy: ['correctness'], severity: 'MINOR' }),
                makeDeduped({ id: 'F1', file: 'a.js', raisedBy: ['correctness', 'security'], severity: 'MINOR' }),
            ];
            const votes = [
                { finding_id: 'F1', voter: 'performance', verdict: 'confirm' },
            ];
            const result = council.aggregateCouncil(findings, votes);
            expect(result.findings[0].status).toBe('confirmed');
        });

        it('unconfirmed finding with 1 independent raise and no votes', () => {
            const findings = [makeDeduped({ id: 'F0', raisedBy: ['correctness'], severity: 'MINOR' })];
            const result = council.aggregateCouncil(findings, []);
            expect(result.findings[0].status).toBe('unconfirmed');
            expect(result.stats.unconfirmed).toBe(1);
            expect(result.stats.confirmed).toBe(0);
        });

        it('CRITICAL with refutes > confirms → contested in stats', () => {
            const findings = [makeDeduped({ id: 'F0', raisedBy: ['correctness'], severity: 'CRITICAL' })];
            const votes = [
                { finding_id: 'F0', voter: 'security', verdict: 'refute' },
                { finding_id: 'F0', voter: 'performance', verdict: 'refute' },
            ];
            const result = council.aggregateCouncil(findings, votes);
            expect(result.findings[0].status).toBe('contested');
            expect(result.stats.contested).toBe(1);
            expect(result.stats.refuted).toBe(0);
        });

        it('handles empty findings array', () => {
            const result = council.aggregateCouncil([], []);
            expect(result.stats.deduped).toBe(0);
            expect(result.findings).toHaveLength(0);
        });

        it('n_reviewers reflects the number of distinct lenses in raisedBy', () => {
            const findings = [
                makeDeduped({ id: 'F0', raisedBy: ['correctness', 'security'] }),
            ];
            const result = council.aggregateCouncil(findings, []);
            expect(result.n_reviewers).toBe(2);
        });
    });

    // ── renderCouncilMd ──────────────────────────────────────────────────────

    describe('renderCouncilMd', () => {
        function makeResult(overrides = {}) {
            return {
                n_reviewers: 2,
                stats: { deduped: 1, confirmed: 1, contested: 0, unconfirmed: 0, refuted: 0 },
                findings: [
                    {
                        id: 'F0',
                        file: 'auth.js',
                        line: 10,
                        title: 'SQL Injection',
                        severity: 'CRITICAL',
                        raisedBy: ['correctness', 'security'],
                        confirms: 2,
                        refutes: 0,
                        consensusSeverity: 'CRITICAL',
                        status: 'confirmed',
                    },
                ],
                ...overrides,
            };
        }

        it('contains "Council Review" heading', () => {
            const md = council.renderCouncilMd(makeResult());
            expect(md).toContain('Council Review');
        });

        it('contains a table header row', () => {
            const md = council.renderCouncilMd(makeResult());
            expect(md).toContain('| Status |');
            expect(md).toContain('| Severity |');
            expect(md).toContain('| Finding |');
        });

        it('renders a finding row with file:line when line is present', () => {
            const md = council.renderCouncilMd(makeResult());
            expect(md).toContain('auth.js:10');
        });

        it('renders a finding row with file only when line is absent', () => {
            const result = makeResult();
            result.findings[0].line = null;
            const md = council.renderCouncilMd(result);
            expect(md).toContain('auth.js');
            expect(md).not.toContain('auth.js:');
        });

        it('does NOT include a "Refuted" section when there are no refuted findings', () => {
            const md = council.renderCouncilMd(makeResult());
            expect(md).not.toContain('Refuted');
        });

        it('includes a "Refuted" section ONLY when there is at least one refuted finding', () => {
            const result = makeResult({
                stats: { deduped: 2, confirmed: 1, contested: 0, unconfirmed: 0, refuted: 1 },
                findings: [
                    {
                        id: 'F0',
                        file: 'auth.js',
                        line: 10,
                        title: 'SQL Injection',
                        severity: 'CRITICAL',
                        raisedBy: ['correctness'],
                        confirms: 2,
                        refutes: 0,
                        consensusSeverity: 'CRITICAL',
                        status: 'confirmed',
                    },
                    {
                        id: 'F1',
                        file: 'a.js',
                        line: 5,
                        title: 'Unused var',
                        severity: 'NIT',
                        raisedBy: ['correctness'],
                        confirms: 1,
                        refutes: 3,
                        consensusSeverity: 'NIT',
                        status: 'refuted',
                    },
                ],
            });
            const md = council.renderCouncilMd(result);
            expect(md).toContain('Refuted');
            expect(md).toContain('Unused var');
        });

        it('returns a string', () => {
            expect(typeof council.renderCouncilMd(makeResult())).toBe('string');
        });

        it('ends with a newline', () => {
            const md = council.renderCouncilMd(makeResult());
            expect(md.endsWith('\n')).toBe(true);
        });
    });

    // ── CLI / disk round-trip ─────────────────────────────────────────────────

    describe('disk round-trip (dedupe → aggregate → council.json + council.md)', () => {
        let tmpDir;

        beforeAll(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-'));
        });

        afterAll(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('writing findings.json, deduping, then aggregating produces council.json and council.md', () => {
            const findings = [
                { file: 'auth.js', line: 10, title: 'SQL Injection!!', severity: 'CRITICAL', lens: 'security', detail: 'unescaped input' },
                { file: 'auth.js', line: 10, title: 'sql injection', severity: 'MAJOR', lens: 'correctness', detail: '' },
                { file: 'perf.js', line: 42, title: 'N+1 query', severity: 'MAJOR', lens: 'performance', detail: 'loop query' },
            ];

            // Write findings.json
            const findingsPath = path.join(tmpDir, 'findings.json');
            fs.writeFileSync(findingsPath, JSON.stringify(findings, null, 2));

            // Dedupe via exported function (exercises the same logic as CLI `dedupe` subcommand)
            const deduped = council.dedupeFindings(findings);
            const dedupedPath = path.join(tmpDir, 'deduped.json');
            fs.writeFileSync(dedupedPath, JSON.stringify(deduped, null, 2));

            // Aggregate via exported function (exercises same logic as CLI `aggregate` subcommand)
            const votes = [
                { finding_id: deduped[0].id, voter: 'architecture', verdict: 'confirm', severity_vote: 'CRITICAL' },
            ];
            const votesPath = path.join(tmpDir, 'votes.json');
            fs.writeFileSync(votesPath, JSON.stringify(votes, null, 2));

            const result = council.aggregateCouncil(deduped, votes);
            fs.writeFileSync(path.join(tmpDir, 'council.json'), JSON.stringify(result, null, 2));
            fs.writeFileSync(path.join(tmpDir, 'council.md'), council.renderCouncilMd(result));

            // Assert council.json shape
            const councilJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'council.json'), 'utf8'));
            expect(councilJson).toHaveProperty('stats');
            expect(councilJson).toHaveProperty('findings');
            expect(councilJson.stats.deduped).toBe(2); // SQL Injection merged → 2 total
            expect(councilJson.findings[0]).toHaveProperty('id');
            expect(councilJson.findings[0]).toHaveProperty('status');

            // Assert council.md shape
            const councilMd = fs.readFileSync(path.join(tmpDir, 'council.md'), 'utf8');
            expect(councilMd).toContain('Council Review');
            expect(councilMd).toContain('| Status |');
        });

        it('merged SQL Injection finding has both lenses in raisedBy and severity CRITICAL', () => {
            const findings = [
                { file: 'auth.js', line: 10, title: 'SQL Injection!!', severity: 'CRITICAL', lens: 'security' },
                { file: 'auth.js', line: 10, title: 'sql injection', severity: 'MAJOR', lens: 'correctness' },
            ];
            const deduped = council.dedupeFindings(findings);
            expect(deduped).toHaveLength(1);
            expect(deduped[0].severity).toBe('CRITICAL');
            expect(deduped[0].raisedBy).toEqual(['correctness', 'security']);
        });

        it('stats sum of statuses equals deduped in aggregated result from disk', () => {
            const councilJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'council.json'), 'utf8'));
            const { confirmed, contested, unconfirmed, refuted, deduped } = councilJson.stats;
            expect(confirmed + contested + unconfirmed + refuted).toBe(deduped);
        });
    });

    // ── LENSES constant ──────────────────────────────────────────────────────

    describe('LENSES', () => {
        it('has 4 lenses with key and focus fields', () => {
            expect(council.LENSES).toHaveLength(4);
            for (const lens of council.LENSES) {
                expect(lens).toHaveProperty('key');
                expect(lens).toHaveProperty('focus');
                expect(typeof lens.key).toBe('string');
                expect(typeof lens.focus).toBe('string');
            }
        });

        it('contains the four expected lens keys', () => {
            const keys = council.LENSES.map((l) => l.key);
            expect(keys).toContain('correctness');
            expect(keys).toContain('security');
            expect(keys).toContain('architecture');
            expect(keys).toContain('performance');
        });
    });
});
