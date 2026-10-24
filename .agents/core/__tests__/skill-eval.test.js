import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// NOTE: These tests assert the harness LOGIC against synthetic fixtures only.
// They do NOT read the live docs/.output/evolution/skills tree.

let m;
let tmpDir;

beforeAll(() => {
    m = require('../../../.agents/core/skill-eval');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-eval-'));
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Pure statistics ──────────────────────────────────────────────────────────

describe('mean', () => {
    it('returns 0 for empty array', () => {
        expect(m.mean([])).toBe(0);
    });

    it('returns 0 for null/undefined', () => {
        expect(m.mean(null)).toBe(0);
        expect(m.mean(undefined)).toBe(0);
    });

    it('returns the single value for a one-element array', () => {
        expect(m.mean([7])).toBe(7);
    });

    it('computes the correct mean for multiple values', () => {
        expect(m.mean([1, 2, 3, 4])).toBe(2.5);
        expect(m.mean([0, 0, 0])).toBe(0);
        expect(m.mean([10, 20])).toBe(15);
    });
});

describe('stddev', () => {
    it('returns 0 for empty array', () => {
        expect(m.stddev([])).toBe(0);
    });

    it('returns 0 for null/undefined', () => {
        expect(m.stddev(null)).toBe(0);
        expect(m.stddev(undefined)).toBe(0);
    });

    it('returns 0 for a single-element array (no spread)', () => {
        expect(m.stddev([5])).toBe(0);
    });

    it('computes population stddev for [1,2,3,4] ≈ 1.1180', () => {
        const result = m.stddev([1, 2, 3, 4]);
        expect(result).toBeCloseTo(1.1180, 3);
    });

    it('returns 0 for all-equal values', () => {
        expect(m.stddev([3, 3, 3])).toBe(0);
    });
});

describe('summarizeMetric', () => {
    it('handles empty array — all zeros, n=0', () => {
        const r = m.summarizeMetric([]);
        expect(r).toEqual({ mean: 0, std: 0, min: 0, max: 0, n: 0 });
    });

    it('handles null / undefined input', () => {
        const r = m.summarizeMetric(null);
        expect(r).toEqual({ mean: 0, std: 0, min: 0, max: 0, n: 0 });
    });

    it('filters out non-numbers (NaN, strings, nulls)', () => {
        const r = m.summarizeMetric([1, null, 'foo', NaN, 3]);
        expect(r.n).toBe(2);
        expect(r.mean).toBe(2);
        expect(r.min).toBe(1);
        expect(r.max).toBe(3);
    });

    it('returns correct {mean,std,min,max,n} for a valid array', () => {
        const r = m.summarizeMetric([10, 20, 30]);
        expect(r.n).toBe(3);
        expect(r.mean).toBe(20);
        expect(r.min).toBe(10);
        expect(r.max).toBe(30);
        // population stddev of [10,20,30] = sqrt(200/3) ≈ 8.1650
        expect(r.std).toBeCloseTo(8.165, 2);
    });

    it('returns a single-element summary with std=0', () => {
        const r = m.summarizeMetric([42]);
        expect(r).toEqual({ mean: 42, std: 0, min: 42, max: 42, n: 1 });
    });
});

// ── passRateOfRun ─────────────────────────────────────────────────────────────

describe('passRateOfRun', () => {
    it('returns 0 for empty array', () => {
        expect(m.passRateOfRun([])).toBe(0);
    });

    it('returns 0 for null/undefined', () => {
        expect(m.passRateOfRun(null)).toBe(0);
        expect(m.passRateOfRun(undefined)).toBe(0);
    });

    it('returns correct fraction — 2 of 3 passed ≈ 0.667', () => {
        const result = m.passRateOfRun([{ passed: true }, { passed: false }, { passed: true }]);
        expect(result).toBeCloseTo(0.667, 2);
    });

    it('returns 1 when all pass', () => {
        expect(m.passRateOfRun([{ passed: true }, { passed: true }])).toBe(1);
    });

    it('returns 0 when all fail', () => {
        expect(m.passRateOfRun([{ passed: false }, { passed: false }])).toBe(0);
    });

    it('treats non-true values as failed', () => {
        // null, undefined, "yes" are not === true
        const result = m.passRateOfRun([{ passed: null }, { passed: undefined }, { passed: true }]);
        expect(result).toBeCloseTo(1 / 3, 4);
    });
});

// ── pctChange ─────────────────────────────────────────────────────────────────

describe('pctChange', () => {
    it('pctChange(110, 100) === 10', () => {
        expect(m.pctChange(110, 100)).toBe(10);
    });

    it('returns null when baseline is 0', () => {
        expect(m.pctChange(50, 0)).toBeNull();
    });

    it('returns null when baseline is null/undefined', () => {
        expect(m.pctChange(50, null)).toBeNull();
        expect(m.pctChange(50, undefined)).toBeNull();
    });

    it('handles decrease correctly', () => {
        expect(m.pctChange(90, 100)).toBe(-10);
    });

    it('returns 0 when treatment equals baseline', () => {
        expect(m.pctChange(100, 100)).toBe(0);
    });
});

// ── aggregateConfigRuns ───────────────────────────────────────────────────────

describe('aggregateConfigRuns', () => {
    it('returns zero summaries for empty runs', () => {
        const r = m.aggregateConfigRuns([]);
        expect(r.runs).toBe(0);
        expect(r.pass_rate).toMatchObject({ mean: 0, n: 0 });
        expect(r.assertions).toEqual({});
    });

    it('returns zero summaries for null/undefined', () => {
        const r = m.aggregateConfigRuns(null);
        expect(r.runs).toBe(0);
    });

    it('computes pass_rate mean and std across 2 runs', () => {
        const runs = [
            {
                expectations: [{ text: 'asserts X', passed: true }, { text: 'asserts Y', passed: true }],
                total_tokens: 100,
                duration_ms: 500,
            },
            {
                expectations: [{ text: 'asserts X', passed: true }, { text: 'asserts Y', passed: false }],
                total_tokens: 200,
                duration_ms: 600,
            },
        ];
        const r = m.aggregateConfigRuns(runs);
        expect(r.runs).toBe(2);
        // Run 1 pass rate = 1.0, Run 2 pass rate = 0.5 → mean = 0.75
        expect(r.pass_rate.mean).toBeCloseTo(0.75, 4);
        // Population stddev of [1.0, 0.5] = 0.25
        expect(r.pass_rate.std).toBeCloseTo(0.25, 4);
        // tokens mean = 150
        expect(r.tokens.mean).toBe(150);
        // duration mean = 550
        expect(r.duration_ms.mean).toBe(550);
    });

    it('per-assertion rate=0.5 and std>0 when an assertion flips between runs', () => {
        const runs = [
            {
                expectations: [{ text: 'flip-me', passed: true }],
                total_tokens: 100,
                duration_ms: 500,
            },
            {
                expectations: [{ text: 'flip-me', passed: false }],
                total_tokens: 100,
                duration_ms: 500,
            },
        ];
        const r = m.aggregateConfigRuns(runs);
        const flipAssertion = r.assertions['flip-me'];
        expect(flipAssertion).toBeDefined();
        expect(flipAssertion.rate).toBeCloseTo(0.5, 4);
        expect(flipAssertion.std).toBeGreaterThan(0);
        expect(flipAssertion.n).toBe(2);
    });

    it('per-assertion rate=1 and std=0 when assertion always passes', () => {
        const runs = [
            { expectations: [{ text: 'always-pass', passed: true }], total_tokens: 100, duration_ms: 100 },
            { expectations: [{ text: 'always-pass', passed: true }], total_tokens: 100, duration_ms: 100 },
        ];
        const r = m.aggregateConfigRuns(runs);
        const a = r.assertions['always-pass'];
        expect(a.rate).toBe(1);
        expect(a.std).toBe(0);
    });

    it('skips expectations with missing or non-string text', () => {
        const runs = [
            {
                expectations: [
                    { text: null, passed: true },
                    { text: 'valid', passed: true },
                    null,
                ],
                total_tokens: 100,
                duration_ms: 100,
            },
        ];
        const r = m.aggregateConfigRuns(runs);
        expect(Object.keys(r.assertions)).toEqual(['valid']);
    });
});

// ── computeDelta ─────────────────────────────────────────────────────────────

describe('computeDelta', () => {
    it('returns null when either arg is missing', () => {
        expect(m.computeDelta(null, null)).toBeNull();
        expect(m.computeDelta(undefined, null)).toBeNull();
        expect(m.computeDelta({ pass_rate: { mean: 0.8 }, tokens: { mean: 100 }, duration_ms: { mean: 500 } }, null)).toBeNull();
    });

    it('returns {pass_rate, tokens_pct, duration_pct}', () => {
        const withAgg = {
            pass_rate: { mean: 0.8 },
            tokens: { mean: 110 },
            duration_ms: { mean: 220 },
        };
        const baseAgg = {
            pass_rate: { mean: 0.5 },
            tokens: { mean: 100 },
            duration_ms: { mean: 200 },
        };
        const d = m.computeDelta(withAgg, baseAgg);
        expect(d.pass_rate).toBeCloseTo(0.3, 4);
        expect(d.tokens_pct).toBe(10);    // (110-100)/100 * 100 = 10%
        expect(d.duration_pct).toBe(10);  // (220-200)/200 * 100 = 10%
    });

    it('tokens_pct is null when baseline tokens mean is 0', () => {
        const withAgg = { pass_rate: { mean: 1 }, tokens: { mean: 50 }, duration_ms: { mean: 0 } };
        const baseAgg = { pass_rate: { mean: 0.5 }, tokens: { mean: 0 }, duration_ms: { mean: 0 } };
        const d = m.computeDelta(withAgg, baseAgg);
        expect(d.tokens_pct).toBeNull();
    });
});

// ── aggregateEval ─────────────────────────────────────────────────────────────

describe('aggregateEval', () => {
    function makeRun(passedArray, tokens = 100, duration = 500) {
        return {
            expectations: passedArray.map((passed, i) => ({
                text: `assertion-${i}`,
                passed,
                evidence: '',
            })),
            total_tokens: tokens,
            duration_ms: duration,
        };
    }

    it('delta.pass_rate is positive when with_skill beats baseline', () => {
        const evalRecord = {
            eval_id: 'e1',
            eval_name: 'test-eval',
            prompt: 'Do the thing.',
            baselineConfig: 'without_skill',
            configs: {
                with_skill: [makeRun([true, true, true])],       // pass rate 1.0
                without_skill: [makeRun([false, false, true])],  // pass rate 0.333
            },
        };
        const result = m.aggregateEval(evalRecord);
        expect(result.delta.pass_rate).toBeGreaterThan(0);
    });

    it('delta.pass_rate is negative when with_skill regresses', () => {
        const evalRecord = {
            eval_id: 'e2',
            eval_name: 'regress-eval',
            prompt: 'Do the other thing.',
            baselineConfig: 'without_skill',
            configs: {
                with_skill: [makeRun([false, false])],
                without_skill: [makeRun([true, true])],
            },
        };
        const result = m.aggregateEval(evalRecord);
        expect(result.delta.pass_rate).toBeLessThan(0);
    });

    it('assertion discriminating=true when |with - baseline| >= DISCRIMINATING_DELTA (0.25)', () => {
        // assertion-0: with_skill always passes (rate=1.0), without_skill always fails (rate=0.0) → delta=1.0 ≥ 0.25
        // assertion-1: with_skill always passes (rate=1.0), without_skill always passes (rate=1.0) → delta=0 < 0.25
        const withRun = {
            expectations: [
                { text: 'assertion-0', passed: true },
                { text: 'assertion-1', passed: true },
            ],
            total_tokens: 100,
            duration_ms: 500,
        };
        const baseRun = {
            expectations: [
                { text: 'assertion-0', passed: false },
                { text: 'assertion-1', passed: true },
            ],
            total_tokens: 100,
            duration_ms: 500,
        };
        const evalRecord = {
            eval_id: 'e3',
            eval_name: 'disc-eval',
            prompt: 'Test discriminating.',
            baselineConfig: 'without_skill',
            configs: {
                with_skill: [withRun],
                without_skill: [baseRun],
            },
        };
        const result = m.aggregateEval(evalRecord);
        const a0 = result.assertions.find((a) => a.text === 'assertion-0');
        const a1 = result.assertions.find((a) => a.text === 'assertion-1');
        expect(a0.discriminating).toBe(true);
        expect(a1.discriminating).toBe(false);
    });

    it('sets baseline_config correctly and results keys match', () => {
        const evalRecord = {
            eval_id: 'e4',
            eval_name: 'keys-eval',
            prompt: 'Checking keys.',
            baselineConfig: 'without_skill',
            configs: {
                with_skill: [makeRun([true])],
                without_skill: [makeRun([true])],
            },
        };
        const result = m.aggregateEval(evalRecord);
        expect(result.baseline_config).toBe('without_skill');
        expect(result.results).toHaveProperty('with_skill');
        expect(result.results).toHaveProperty('without_skill');
    });
});

// ── evidence_on_fail trace-mining (T.11 / GEPA) ──────────────────────────────
// aggregateConfigRuns must stop discarding the `evidence` of FAILED expectations:
// each assertion entry gains `evidence_on_fail: string[]` (non-empty evidence
// strings from runs where that assertion failed). aggregateEval threads it onto
// its per-assertion view so the benchmark carries diagnostic traces, not just a
// scalar pass-rate.

describe('evidence_on_fail (T.11 trace-mining)', () => {
    it('aggregateConfigRuns collects evidence from failed expectations per assertion', () => {
        const runs = [
            { expectations: [
                { text: 'A', passed: false, evidence: 'missing the seeding step' },
                { text: 'B', passed: true, evidence: 'ok' },
            ] },
            { expectations: [
                { text: 'A', passed: false, evidence: 'still no seeding' },
                { text: 'B', passed: true, evidence: 'ok' },
            ] },
        ];
        const agg = m.aggregateConfigRuns(runs);
        expect(agg.assertions['A'].evidence_on_fail).toEqual([
            'missing the seeding step',
            'still no seeding',
        ]);
    });

    it('does not collect evidence from passing expectations', () => {
        const runs = [
            { expectations: [{ text: 'B', passed: true, evidence: 'ok' }] },
        ];
        const agg = m.aggregateConfigRuns(runs);
        expect(agg.assertions['B'].evidence_on_fail).toEqual([]);
    });

    it('ignores empty-string evidence on failures', () => {
        const runs = [
            { expectations: [{ text: 'A', passed: false, evidence: '' }] },
        ];
        const agg = m.aggregateConfigRuns(runs);
        expect(agg.assertions['A'].evidence_on_fail).toEqual([]);
    });

    it('aggregateEval threads evidence_on_fail onto the per-assertion view', () => {
        const evalRecord = {
            eval_id: 'e-trace',
            eval_name: 'trace-eval',
            prompt: 'Test trace mining.',
            baselineConfig: 'without_skill',
            configs: {
                with_skill: [
                    { text: undefined, expectations: [
                        { text: 'seeds the DB', passed: false, evidence: 'no INSERT observed' },
                    ], total_tokens: 100, duration_ms: 500 },
                ],
                without_skill: [
                    { expectations: [
                        { text: 'seeds the DB', passed: false, evidence: 'baseline also failed' },
                    ], total_tokens: 100, duration_ms: 500 },
                ],
            },
        };
        const result = m.aggregateEval(evalRecord);
        const a = result.assertions.find((x) => x.text === 'seeds the DB');
        expect(a.evidence_on_fail).toEqual(['no INSERT observed']);
    });
});

// ── aggregateBenchmark ────────────────────────────────────────────────────────

describe('aggregateBenchmark', () => {
    function makeEvalRecord(evalId, withPassed, basePassed) {
        return {
            eval_id: evalId,
            eval_name: `eval-${evalId}`,
            prompt: `Prompt for ${evalId}`,
            baselineConfig: 'without_skill',
            configs: {
                with_skill: [
                    {
                        expectations: withPassed.map((p, i) => ({ text: `a-${i}`, passed: p })),
                        total_tokens: 100,
                        duration_ms: 500,
                    },
                ],
                without_skill: [
                    {
                        expectations: basePassed.map((p, i) => ({ text: `a-${i}`, passed: p })),
                        total_tokens: 100,
                        duration_ms: 500,
                    },
                ],
            },
        };
    }

    it('summary.n_evals === 2 for two eval records', () => {
        const records = [
            makeEvalRecord('e1', [true, true], [false, false]),
            makeEvalRecord('e2', [true, false], [false, false]),
        ];
        const b = m.aggregateBenchmark(records, { skillName: 'test-skill' });
        expect(b.summary.n_evals).toBe(2);
    });

    it('configs array contains with_skill and without_skill', () => {
        const records = [makeEvalRecord('e1', [true], [false])];
        const b = m.aggregateBenchmark(records, { skillName: 'my-skill' });
        expect(b.configs).toContain('with_skill');
        expect(b.configs).toContain('without_skill');
    });

    it('summary.delta.pass_rate has correct sign when with_skill beats baseline', () => {
        // with: 1.0 avg, without: 0.0 avg → delta > 0
        const records = [
            makeEvalRecord('e1', [true, true], [false, false]),
            makeEvalRecord('e2', [true, true], [false, false]),
        ];
        const b = m.aggregateBenchmark(records, { skillName: 'winning-skill' });
        expect(b.summary.delta.pass_rate).toBeGreaterThan(0);
    });

    it('summary.delta.pass_rate is negative when skill regresses', () => {
        const records = [
            makeEvalRecord('e1', [false, false], [true, true]),
        ];
        const b = m.aggregateBenchmark(records, { skillName: 'regressing-skill' });
        expect(b.summary.delta.pass_rate).toBeLessThan(0);
    });

    it('skill_name from opts overrides the record default', () => {
        const records = [makeEvalRecord('e1', [true], [false])];
        const b = m.aggregateBenchmark(records, { skillName: 'override-name' });
        expect(b.skill_name).toBe('override-name');
    });
});

// ── renderBenchmarkMd ─────────────────────────────────────────────────────────

describe('renderBenchmarkMd', () => {
    function buildBenchmark() {
        const records = [
            {
                eval_id: 'r1',
                eval_name: 'render-eval',
                prompt: 'Test rendering.',
                baselineConfig: 'without_skill',
                configs: {
                    with_skill: [
                        {
                            expectations: [{ text: 'renders correctly', passed: true }],
                            total_tokens: 200,
                            duration_ms: 800,
                        },
                    ],
                    without_skill: [
                        {
                            expectations: [{ text: 'renders correctly', passed: false }],
                            total_tokens: 150,
                            duration_ms: 600,
                        },
                    ],
                },
            },
        ];
        return m.aggregateBenchmark(records, { skillName: 'render-test-skill', iteration: 'it-01', date: '2026-06-06' });
    }

    it('contains the skill name', () => {
        const md = m.renderBenchmarkMd(buildBenchmark());
        expect(md).toContain('render-test-skill');
    });

    it('contains a Verdict line', () => {
        const md = m.renderBenchmarkMd(buildBenchmark());
        expect(md).toMatch(/\*\*Verdict:\*\*/);
    });

    it('contains a per-eval heading with eval name', () => {
        const md = m.renderBenchmarkMd(buildBenchmark());
        expect(md).toContain('render-eval');
    });

    it('returns a non-empty string ending with newline', () => {
        const md = m.renderBenchmarkMd(buildBenchmark());
        expect(typeof md).toBe('string');
        expect(md.length).toBeGreaterThan(0);
        expect(md.endsWith('\n')).toBe(true);
    });

    it('includes "with_skill" and the baseline config label', () => {
        const md = m.renderBenchmarkMd(buildBenchmark());
        expect(md).toContain('with_skill');
        expect(md).toContain('without_skill');
    });
});

// ── loadIteration + aggregateIteration (disk) ─────────────────────────────────

describe('loadIteration + aggregateIteration', () => {
    let iterDir;

    function writeGrading(dir, expectations) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'grading.json'), JSON.stringify({ expectations }));
    }

    function writeTiming(dir, tokens, duration) {
        fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify({ total_tokens: tokens, duration_ms: duration }));
    }

    beforeAll(() => {
        iterDir = path.join(tmpDir, 'iteration-1');
        const evalDir = path.join(iterDir, 'eval-0-foo');

        // Write eval_metadata.json
        fs.mkdirSync(evalDir, { recursive: true });
        fs.writeFileSync(
            path.join(evalDir, 'eval_metadata.json'),
            JSON.stringify({ eval_id: '0', eval_name: 'foo-eval', prompt: 'Test prompt.' }),
        );

        // with_skill (single run)
        const withDir = path.join(evalDir, 'with_skill');
        writeGrading(withDir, [
            { text: 'assertion-A', passed: true, evidence: 'good' },
            { text: 'assertion-B', passed: true, evidence: 'good' },
        ]);
        writeTiming(withDir, 300, 900);

        // without_skill (single run)
        const baseDir = path.join(evalDir, 'without_skill');
        writeGrading(baseDir, [
            { text: 'assertion-A', passed: false, evidence: 'bad' },
            { text: 'assertion-B', passed: false, evidence: 'bad' },
        ]);
        writeTiming(baseDir, 200, 700);
    });

    it('loadIteration returns one record with both configs', () => {
        const records = m.loadIteration(iterDir);
        expect(records).toHaveLength(1);
        const rec = records[0];
        expect(rec.eval_id).toBe('0');
        expect(rec.eval_name).toBe('foo-eval');
        expect(rec.baselineConfig).toBe('without_skill');
        expect(rec.configs).toHaveProperty('with_skill');
        expect(rec.configs).toHaveProperty('without_skill');
    });

    it('loadIteration sets baselineConfig to without_skill', () => {
        const [rec] = m.loadIteration(iterDir);
        expect(rec.baselineConfig).toBe('without_skill');
    });

    it('loadRun reads expectations from grading.json and tokens/duration from timing.json', () => {
        const withDir = path.join(iterDir, 'eval-0-foo', 'with_skill');
        const run = m.loadRun(withDir);
        expect(run).not.toBeNull();
        expect(run.expectations).toHaveLength(2);
        expect(run.total_tokens).toBe(300);
        expect(run.duration_ms).toBe(900);
    });

    it('aggregateIteration produces a benchmark with positive delta (with_skill beats baseline)', () => {
        const benchmark = m.aggregateIteration(iterDir, { skillName: 'foo-skill' });
        // with_skill pass rate = 1.0, without_skill pass rate = 0.0 → delta > 0
        expect(benchmark.summary.delta.pass_rate).toBeGreaterThan(0);
        expect(benchmark.skill_name).toBe('foo-skill');
    });

    it('returns empty records for a non-existent iteration dir', () => {
        const records = m.loadIteration(path.join(tmpDir, 'does-not-exist'));
        expect(records).toEqual([]);
    });

    it('multi-run variant: config dir with run-1/ and run-2/ subdirs → runs===2', () => {
        const multiIterDir = path.join(tmpDir, 'iteration-multi');
        const multiEvalDir = path.join(multiIterDir, 'eval-1-multi');
        fs.mkdirSync(multiEvalDir, { recursive: true });
        fs.writeFileSync(
            path.join(multiEvalDir, 'eval_metadata.json'),
            JSON.stringify({ eval_id: '1', eval_name: 'multi-eval', prompt: 'Multi-run test.' }),
        );

        // with_skill using run-1/ and run-2/ subdirs (no top-level grading.json)
        const withMultiDir = path.join(multiEvalDir, 'with_skill');
        const run1Dir = path.join(withMultiDir, 'run-1');
        const run2Dir = path.join(withMultiDir, 'run-2');
        writeGrading(run1Dir, [{ text: 'x', passed: true }]);
        writeTiming(run1Dir, 100, 400);
        writeGrading(run2Dir, [{ text: 'x', passed: false }]);
        writeTiming(run2Dir, 100, 400);

        // without_skill (single run for baseline)
        const baseMultiDir = path.join(multiEvalDir, 'without_skill');
        writeGrading(baseMultiDir, [{ text: 'x', passed: false }]);
        writeTiming(baseMultiDir, 80, 300);

        const records = m.loadIteration(multiIterDir);
        expect(records).toHaveLength(1);
        const rec = records[0];
        // The with_skill config should show 2 runs
        expect(rec.configs['with_skill']).toHaveLength(2);
    });
});

// ── loud-failure on missing / malformed / empty data (regression: two-project
//    silent-degradation bug — aggregate reported a confident delta on dropped data)
describe('loud failure on bad eval data', () => {
    function writeGrading(dir, expectations) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'grading.json'), JSON.stringify({ expectations }));
    }
    function writeTiming(dir, tokens, duration) {
        fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify({ total_tokens: tokens, duration_ms: duration }));
    }

    it('loadRun: genuinely-absent grading.json returns null WITHOUT a warning', () => {
        const dir = path.join(tmpDir, 'absent-grading');
        fs.mkdirSync(dir, { recursive: true });
        const warnings = [];
        expect(m.loadRun(dir, warnings)).toBeNull();
        expect(warnings).toEqual([]);
    });

    it('loadRun: present-but-malformed grading.json returns null AND pushes a warning', () => {
        const dir = path.join(tmpDir, 'malformed-grading');
        fs.mkdirSync(dir, { recursive: true });
        // The crypto failure mode: an unescaped quote mid-string in evidence.
        fs.writeFileSync(path.join(dir, 'grading.json'), '{"expectations":[{"text":"x","passed":true,"evidence":"framed as DRY only"}]'); // truncated / invalid
        const warnings = [];
        expect(m.loadRun(dir, warnings)).toBeNull();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/failed to parse/i);
        expect(warnings[0]).toContain('grading.json');
    });

    it('loadRun: malformed timing.json keeps the run but warns and drops tokens/duration', () => {
        const dir = path.join(tmpDir, 'malformed-timing');
        writeGrading(dir, [{ text: 'x', passed: true }]);
        fs.writeFileSync(path.join(dir, 'timing.json'), 'NOT JSON {{{');
        const warnings = [];
        const run = m.loadRun(dir, warnings);
        expect(run).not.toBeNull();
        expect(run.total_tokens).toBeUndefined();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/timing\.json/);
    });

    it('aggregateIteration: zero loaded records → benchmark.warnings flags an empty load', () => {
        const emptyIter = path.join(tmpDir, 'empty-iteration');
        fs.mkdirSync(emptyIter, { recursive: true });
        const b = m.aggregateIteration(emptyIter, { skillName: 'nada' });
        expect(b.summary.n_evals).toBe(0);
        expect(b.warnings.some((w) => /no eval records loaded/i.test(w))).toBe(true);
    });

    it('aggregateIteration: a malformed baseline grading.json warns AND flags the eval as baseline-less', () => {
        const iter = path.join(tmpDir, 'dropped-baseline-iteration');
        const evalDir = path.join(iter, 'eval-0-foo');
        fs.mkdirSync(evalDir, { recursive: true });
        fs.writeFileSync(path.join(evalDir, 'eval_metadata.json'), JSON.stringify({ eval_id: '0', eval_name: 'foo' }));
        // with_skill is fine...
        const withDir = path.join(evalDir, 'with_skill');
        writeGrading(withDir, [{ text: 'a', passed: true }]);
        writeTiming(withDir, 100, 400);
        // ...but the baseline grading.json is corrupt (present, unparseable).
        const baseDir = path.join(evalDir, 'without_skill');
        fs.mkdirSync(baseDir, { recursive: true });
        fs.writeFileSync(path.join(baseDir, 'grading.json'), '{ broken json with a stray " quote }');

        const b = m.aggregateIteration(iter, { skillName: 'foo-skill' });
        // The corrupt baseline must NOT be silently treated as absent.
        expect(b.warnings.some((w) => /failed to parse/i.test(w))).toBe(true);
        expect(b.warnings.some((w) => /NO baseline run/i.test(w))).toBe(true);
    });

    it('renderBenchmarkMd: surfaces a data-quality warnings block when warnings exist', () => {
        const emptyIter = path.join(tmpDir, 'empty-iteration-2');
        fs.mkdirSync(emptyIter, { recursive: true });
        const b = m.aggregateIteration(emptyIter, { skillName: 'nada', iteration: 'it-1', date: '2026-06-06' });
        const md = m.renderBenchmarkMd(b);
        expect(md).toMatch(/DATA-QUALITY WARNINGS/);
    });

    it('renderBenchmarkMd: no warnings block for a clean benchmark (warnings undefined)', () => {
        const records = [
            {
                eval_id: 'e1',
                eval_name: 'clean',
                prompt: 'p',
                baselineConfig: 'without_skill',
                configs: {
                    with_skill: [{ expectations: [{ text: 'a', passed: true }], total_tokens: 1, duration_ms: 1 }],
                    without_skill: [{ expectations: [{ text: 'a', passed: false }], total_tokens: 1, duration_ms: 1 }],
                },
            },
        ];
        const b = m.aggregateBenchmark(records, { skillName: 'clean-skill' }); // no .warnings field
        const md = m.renderBenchmarkMd(b);
        expect(md).not.toMatch(/DATA-QUALITY WARNINGS/);
    });
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
    it('parses positional args and flags', () => {
        const args = m.parseArgs(['aggregate', '/some/dir', '--skill-name', 'my-skill', '--date', '2026-06-06']);
        expect(args._).toEqual(['aggregate', '/some/dir']);
        expect(args['skill-name']).toBe('my-skill');
        expect(args['date']).toBe('2026-06-06');
    });

    it('treats a flag with no following value as true', () => {
        const args = m.parseArgs(['--json']);
        expect(args.json).toBe(true);
    });

    it('handles empty argv', () => {
        const args = m.parseArgs([]);
        expect(args._).toEqual([]);
    });
});
