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

// ══════════════════════════════════════════════════════════════════════════════
// SF-4.4 — `skill-eval.js verdict`: a code-enforced accept rule (deep tier)
// ══════════════════════════════════════════════════════════════════════════════
//
// PINNED CONTRACT (the implementer follows this; the tests below enforce it)
//
// CLI grammar (the AC's names verbatim):
//   node skill-eval.js verdict <iterationDir> [--holdout <dir>] [--min-replicates 2]
//   - <iterationDir> and --holdout <dir> are iteration directories holding the
//     benchmark.json that `aggregate` writes. `verdict` READS benchmark.json and
//     writes nothing (it never re-aggregates, never touches the directory).
//   - --min-replicates defaults to 2; it must be a positive integer.
//   - stdout is exactly one JSON object (exit 0, 3 and 4); human text goes to stderr.
//
// Exit codes (reusing the existing table):
//   0 accept · 4 reject · 3 data-quality (benchmark.warnings non-empty, holdout
//   warnings non-empty, or a benchmark.json that parses but is structurally
//   unusable) · 1 could not run (iterationDir / benchmark.json missing or
//   unparseable, --holdout dir or its benchmark.json missing or unparseable) ·
//   2 bad usage (no <iterationDir>, unknown subcommand, --min-replicates not a
//   positive integer, --holdout given without a value).
//
// Result JSON (also returned by the exported computeVerdict / verdictIteration):
//   { verdict: 'accept'|'reject'|'data-quality',
//     exitCode: 0|4|3,
//     reasons: string[],        // [] on accept; ['data-quality'] on exit 3; otherwise
//                               // EVERY failed rule, in this order, from:
//                               // 'insufficient-replicates' · 'negative-eval-delta' ·
//                               // 'no-improvement' · 'holdout-regression' · 'prose-growth'
//     warnings: string[],       // copy of benchmark.warnings (+ holdout warnings)
//     minReplicates: number,
//     baselineConfig: string,   // 'old_skill' | 'without_skill'
//     delta: number,            // benchmark.summary.delta.pass_rate
//     holdoutDelta: number|null,// holdout benchmark summary.delta.pass_rate; null without a holdout
//     fragile: boolean,         // exactly ONE discriminating assertion across all evals AND it is high_variance
//     totals: { tokens: {with_skill, baseline}, duration_ms: {with_skill, baseline} },
//                               // sums over every run of every eval (absent timing counts as 0)
//     failureTraces: [{eval_name, assertion, evidence[]}],
//                               // extractFailureTraces(benchmark) on a reject; [] on accept
//     proseGrowth: null | { beforeWords, afterWords, growth, bound } }
//
// Accept rule (all must hold; a failed rule adds its reason, none short-circuits):
//   no warnings · every eval has >= minReplicates runs in BOTH arms ·
//   no per-eval delta.pass_rate < 0 · headline delta > 0 ·
//   holdoutDelta >= 0 when a holdout is given · not prose-growth.
//   ROUNDING NOISE: the benchmark rounds every mean to 4 dp, so a true-zero delta
//   whose means sit on a .00005 boundary (e.g. 0.03125) can be written as
//   +/-0.0001. A delta with |x| <= 0.0001 is therefore ZERO for every rule above
//   (an exact-zero holdout must not reject; a noise +0.0001 headline must not
//   accept). Any |x| >= 0.001 is a real, signed delta.
//   `fragile` never changes the decision. Token and duration totals never change it.
//
// Prose growth: tools/skill-prose-metrics.cjs `measure(text).words`, before = the
//   snapshot body, after = the candidate body. growth = afterWords/beforeWords - 1.
//   reject ('prose-growth') iff growth > PROSE_GROWTH_BOUND (exported, 0 < bound < 1)
//   AND delta <= growth ("without a larger delta"). proseGrowth is null when the
//   tool file is absent, or when either body is not supplied. Inputs: opts
//   { proseMetricsPath, baselineBody, candidateBody } on computeVerdict; the CLI
//   reads <iterationDir>/../skill-snapshot/SKILL.md and ../candidate/SKILL.md
//   (the review-evolve-skills workspace layout) when both exist.
//
// Exports: computeVerdict(benchmark, { minReplicates = 2, holdout = null (a
//   benchmark object), proseMetricsPath, baselineBody, candidateBody }) -> result;
//   verdictIteration(iterationDir, { minReplicates, holdoutDir }) -> result;
//   PROSE_GROWTH_BOUND. computeVerdict is FAIL-CLOSED: null / non-object / a
//   benchmark without evals[] or summary.delta returns verdict 'data-quality'
//   (exit 3); it never throws and never accepts malformed input.
//
// NOT COVERED: the AC "a one-time dogfood against the three live benchmark
//   directories is recorded in Key Findings" is a manual doc record, not a test
//   (these tests deliberately never read the live evolution tree).

const { spawnSync: svSpawn } = require('node:child_process');
const svHere = path.dirname(require('node:url').fileURLToPath(import.meta.url));
const SV_SCRIPT = path.resolve(svHere, '..', 'skill-eval.js');
const SV_WORKFLOW = path.resolve(svHere, '..', '..', 'skills', 'review-evolve-skills', 'references', 'workflow.md');
const SV_PROSE_TOOL = path.resolve(svHere, '..', '..', '..', 'tools', 'skill-prose-metrics.cjs');
const SV_BASE = 'old_skill';

// ── Fixture model: an eval = { id, name, texts[], withRuns[], baseRuns[] }; a run = { pass:boolean[], tokens?, duration?, evidence:{idx:text} }

function svRun(bits, extra = {}) {
    return { pass: [...bits].map((c) => c === '1'), tokens: extra.tokens, duration: extra.duration, evidence: extra.evidence || {} };
}
function svEval(id, name, withBits, baseBits, extra = {}) {
    const mk = (b, i) => svRun(b, typeof extra === 'function' ? extra(b, i) : extra);
    const withRuns = withBits.map(mk);
    const baseRuns = baseBits.map(mk);
    const n = withRuns[0].pass.length;
    return { id, name, texts: Array.from({ length: n }, (_, i) => `${name}-a${i + 1}`), withRuns, baseRuns };
}
function svToRecords(evals) {
    const toRun = (e) => (r) => ({
        expectations: r.pass.map((p, i) => ({ text: e.texts[i], passed: p, evidence: p ? undefined : r.evidence[i] })),
        total_tokens: r.tokens,
        duration_ms: r.duration,
    });
    return evals.map((e) => ({
        eval_id: e.id,
        eval_name: e.name,
        prompt: `prompt ${e.name}`,
        baselineConfig: SV_BASE,
        configs: { with_skill: e.withRuns.map(toRun(e)), [SV_BASE]: e.baseRuns.map(toRun(e)) },
    }));
}
function svBench(evals) {
    return { ...m.aggregateBenchmark(svToRecords(evals), { skillName: 'fixture' }), warnings: [] };
}
function svWriteIteration(dir, evals) {
    fs.mkdirSync(dir, { recursive: true });
    for (const e of evals) {
        const ed = path.join(dir, `eval-${e.id}-${e.name}`);
        fs.mkdirSync(ed, { recursive: true });
        fs.writeFileSync(path.join(ed, 'eval_metadata.json'), JSON.stringify({ eval_id: e.id, eval_name: e.name, prompt: `prompt ${e.name}` }));
        for (const [cfg, runs] of [['with_skill', e.withRuns], [SV_BASE, e.baseRuns]]) {
            runs.forEach((r, k) => {
                const rd = path.join(ed, cfg, `run-${k + 1}`);
                fs.mkdirSync(rd, { recursive: true });
                fs.writeFileSync(path.join(rd, 'grading.json'), JSON.stringify({
                    expectations: r.pass.map((p, i) => ({ text: e.texts[i], passed: p, evidence: p ? undefined : r.evidence[i] })),
                }));
                if (typeof r.tokens === 'number' || typeof r.duration === 'number') {
                    fs.writeFileSync(path.join(rd, 'timing.json'), JSON.stringify({ total_tokens: r.tokens, duration_ms: r.duration }));
                }
            });
        }
    }
}
/** Disk iteration dir + the benchmark.json `aggregate` would write. */
function svIter(name, evals, { benchmark = true } = {}) {
    const root = fs.mkdtempSync(path.join(tmpDir, 'sv-'));
    const dir = path.join(root, name);
    svWriteIteration(dir, evals);
    if (benchmark) fs.writeFileSync(path.join(dir, 'benchmark.json'), JSON.stringify(m.aggregateIteration(dir, { skillName: 'fixture' }), null, 2));
    return dir;
}
function svCli(args) {
    const r = svSpawn(process.execPath, [SV_SCRIPT, 'verdict', ...args], { encoding: 'utf8', windowsHide: true });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const svDecide = (evals, opts = {}) => m.computeVerdict(svBench(evals), opts);

// Shapes of the three real benchmarks (docs/.output/evolution/skills, read once by the author; never read at test time)
const svCodeReview = () => [svEval(1, 'masked-fixture-refactor', ['1111', '1101'], ['1101', '1101'])]; // 1 eval, 4 assertions, 2 runs; the one discriminating assertion is mixed in with_skill
const svSystematicDebugging = () => [svEval(1, 'enumerate-defect-surface', ['11111', '11111'], ['11111', '11111'])]; // delta 0
const svTodoReplay = () => [svEval(1, 'bowflex-epics-1-2', ['0010110011'], ['0010010001'])]; // Runs: 1, delta +0.2

// Two evals, 2 runs per arm: deltas +0.5 and 0, headline +0.25, two discriminating assertions (not fragile)
const svOk = () => [
    svEval(1, 'evA', ['1111', '1111'], ['1100', '1100']),
    svEval(2, 'evB', ['1100', '1100'], ['1100', '1100']),
];

describe('SF-4.4 verdict — the accept rule, one red-green pair per rule', () => {
    it('computeVerdict_cleanTwoReplicatePositiveDelta_acceptsWithExit0AndNoReasons', () => {
        const r = svDecide(svOk());

        expect(r.verdict).toBe('accept');
        expect(r.exitCode).toBe(0);
        expect(r.reasons).toEqual([]);
        expect(r.delta).toBeCloseTo(0.25, 4);
        expect(r.holdoutDelta).toBeNull();
        expect(r.minReplicates).toBe(2);
        expect(r.baselineConfig).toBe('old_skill');
    });

    it('computeVerdict_aBaselineArmWithOneRun_rejectsInsufficientReplicatesOnly', () => {
        const evals = svOk();
        evals[1].baseRuns = evals[1].baseRuns.slice(0, 1); // pass-rate unchanged, so only replicates can fail

        const r = svDecide(evals);

        expect(r.verdict).toBe('reject');
        expect(r.exitCode).toBe(4);
        expect(r.reasons).toEqual(['insufficient-replicates']);
    });

    it('computeVerdict_aWithSkillArmWithOneRun_rejectsInsufficientReplicatesOnly', () => {
        const evals = svOk();
        evals[0].withRuns = evals[0].withRuns.slice(0, 1);

        expect(svDecide(evals).reasons).toEqual(['insufficient-replicates']);
    });

    it('computeVerdict_sameFixtureWithMinReplicates1_acceptsSoTheReplicateRuleIsTheOnlyBlocker', () => {
        const evals = svOk();
        evals[0].withRuns = evals[0].withRuns.slice(0, 1);

        const r = svDecide(evals, { minReplicates: 1 });

        expect(r.verdict).toBe('accept');
        expect(r.minReplicates).toBe(1);
    });

    it('computeVerdict_exactlyMinReplicatesPerConfig_acceptsAtTheBoundary', () => {
        expect(svDecide(svOk(), { minReplicates: 2 }).verdict).toBe('accept');
        expect(svDecide(svOk(), { minReplicates: 3 }).reasons).toEqual(['insufficient-replicates']);
    });

    it('computeVerdict_oneEvalNegativeWhileHeadlinePositive_rejectsNegativeEvalDeltaOnly', () => {
        const evals = svOk();
        evals[1] = svEval(2, 'evB', ['1000', '1000'], ['1100', '1100']); // eval delta -0.25; headline (0.5 - 0.25)/2 = +0.125

        const r = svDecide(evals);

        expect(r.delta).toBeGreaterThan(0);
        expect(r.verdict).toBe('reject');
        expect(r.reasons).toEqual(['negative-eval-delta']);
    });

    it('computeVerdict_aPerEvalDeltaOfExactlyZeroAlongsideAWin_isNotNegativeAndAccepts', () => {
        // svOk's evB has delta exactly 0; it must not trip the negative rule
        const r = svDecide(svOk());

        expect(r.reasons).not.toContain('negative-eval-delta');
        expect(r.verdict).toBe('accept');
    });

    it('computeVerdict_systematicDebuggingShapeDelta0_rejectsNoImprovement', () => {
        const r = svDecide(svSystematicDebugging());

        expect(r.delta).toBe(0);
        expect(r.verdict).toBe('reject');
        expect(r.exitCode).toBe(4);
        expect(r.reasons).toEqual(['no-improvement']);
    });

    it('computeVerdict_negativeHeadlineAndNegativeEval_listsEveryFailedRuleInPinnedOrder', () => {
        const evals = [svEval(1, 'evA', ['1000', '1000'], ['1100', '1100'])];

        const r = svDecide(evals);

        expect(r.reasons).toEqual(['negative-eval-delta', 'no-improvement']);
    });

    it('computeVerdict_oneRunAndNegativeDelta_listsReplicatesBeforeDelta', () => {
        const evals = [svEval(1, 'evA', ['1000'], ['1100'])];

        expect(svDecide(evals).reasons).toEqual(['insufficient-replicates', 'negative-eval-delta', 'no-improvement']);
    });

    it('computeVerdict_todoReplayShapeRunsOne_rejectsForInsufficientReplicatesDespitePositiveDelta', () => {
        const r = svDecide(svTodoReplay());

        expect(r.delta).toBeCloseTo(0.2, 4);
        expect(r.verdict).toBe('reject');
        expect(r.reasons).toEqual(['insufficient-replicates']);
        expect(svDecide(svTodoReplay(), { minReplicates: 1 }).verdict).toBe('accept');
    });

    it('computeVerdict_codeReviewShape_acceptsWithFragileTrue', () => {
        const r = svDecide(svCodeReview());

        expect(r.verdict).toBe('accept');
        expect(r.exitCode).toBe(0);
        expect(r.delta).toBeCloseTo(0.125, 4);
        expect(r.fragile).toBe(true);
    });
});

describe('SF-4.4 verdict — holdout', () => {
    const holdoutOf = (withBits, baseBits) => svBench([svEval(9, 'hold', withBits, baseBits)]);

    it('computeVerdict_holdoutDeltaNegative_rejectsHoldoutRegressionOnly', () => {
        const r = m.computeVerdict(svBench(svOk()), { holdout: holdoutOf(['1000', '1000'], ['1100', '1100']) });

        expect(r.verdict).toBe('reject');
        expect(r.reasons).toEqual(['holdout-regression']);
        expect(r.holdoutDelta).toBeCloseTo(-0.25, 4);
    });

    it('computeVerdict_holdoutDeltaExactlyZero_acceptsAtTheBoundary', () => {
        const r = m.computeVerdict(svBench(svOk()), { holdout: holdoutOf(['1100', '1100'], ['1100', '1100']) });

        expect(r.verdict).toBe('accept');
        expect(r.holdoutDelta).toBe(0);
    });

    it('computeVerdict_holdoutDeltaPositive_acceptsAndEchoesTheHoldoutDelta', () => {
        const r = m.computeVerdict(svBench(svOk()), { holdout: holdoutOf(['1111', '1111'], ['1100', '1100']) });

        expect(r.verdict).toBe('accept');
        expect(r.holdoutDelta).toBeCloseTo(0.5, 4);
    });

    it('computeVerdict_noHoldoutGiven_ignoresHoldoutAndReportsNull', () => {
        expect(svDecide(svOk()).holdoutDelta).toBeNull();
    });

    it('computeVerdict_holdoutWithWarnings_isDataQualityNotAccept', () => {
        const holdout = { ...holdoutOf(['1111', '1111'], ['1100', '1100']), warnings: ['holdout grading.json failed to parse'] };

        const r = m.computeVerdict(svBench(svOk()), { holdout });

        expect(r.verdict).toBe('data-quality');
        expect(r.exitCode).toBe(3);
        expect(r.warnings).toContain('holdout grading.json failed to parse');
    });

    it('computeVerdict_holdoutRegressionAlongsideANegativeMainEval_listsBothInPinnedOrder', () => {
        const evals = svOk();
        evals[1] = svEval(2, 'evB', ['1000', '1000'], ['1100', '1100']);

        const r = m.computeVerdict(svBench(evals), { holdout: holdoutOf(['0000', '0000'], ['1111', '1111']) });

        expect(r.reasons).toEqual(['negative-eval-delta', 'holdout-regression']);
    });
});

describe('SF-4.4 verdict — 4-dp rounding noise around zero (found by the generated oracle)', () => {
    const withDelta = (evals, patch) => { const b = svBench(evals); patch(b); return b; };

    it('computeVerdict_holdoutDeltaMinus0point0001RoundingNoise_isZeroAndAccepts', () => {
        const holdout = withDelta([svEval(9, 'hold', ['1100', '1100'], ['1100', '1100'])], (b) => { b.summary.delta.pass_rate = -0.0001; });

        const r = m.computeVerdict(svBench(svOk()), { holdout });

        expect(r.verdict).toBe('accept');
    });

    it('computeVerdict_holdoutDeltaMinus0point001_isARealRegression', () => {
        const holdout = withDelta([svEval(9, 'hold', ['1100', '1100'], ['1100', '1100'])], (b) => { b.summary.delta.pass_rate = -0.001; });

        expect(m.computeVerdict(svBench(svOk()), { holdout }).reasons).toEqual(['holdout-regression']);
    });

    it('computeVerdict_headlineDeltaPlus0point0001RoundingNoise_isZeroAndRejectsNoImprovement', () => {
        const bench = withDelta(svSystematicDebugging(), (b) => { b.summary.delta.pass_rate = 0.0001; });

        const r = m.computeVerdict(bench);

        expect(r.verdict).toBe('reject');
        expect(r.reasons).toEqual(['no-improvement']);
    });

    it('computeVerdict_headlineDeltaPlus0point001_isARealImprovement', () => {
        const bench = withDelta(svSystematicDebugging(), (b) => { b.summary.delta.pass_rate = 0.001; });

        expect(m.computeVerdict(bench).verdict).toBe('accept');
    });

    it('computeVerdict_perEvalDeltaMinus0point0001RoundingNoise_isNotNegative', () => {
        const bench = withDelta(svOk(), (b) => { b.evals[1].delta.pass_rate = -0.0001; });

        expect(m.computeVerdict(bench).verdict).toBe('accept');
    });

    it('computeVerdict_perEvalDeltaMinus0point001_isNegative', () => {
        const bench = withDelta(svOk(), (b) => { b.evals[1].delta.pass_rate = -0.001; });

        expect(m.computeVerdict(bench).reasons).toEqual(['negative-eval-delta']);
    });
});

describe('SF-4.4 verdict — fragile flag', () => {
    it('computeVerdict_oneDiscriminatingAssertionNotHighVariance_isNotFragile', () => {
        // a4: with [1,1] vs base [0,0] discriminating, zero variance
        const r = svDecide([svEval(1, 'e', ['1111', '1111'], ['1110', '1110'])]);

        expect(r.verdict).toBe('accept');
        expect(r.fragile).toBe(false);
    });

    it('computeVerdict_oneDiscriminatingAssertionWithVarianceOnTheBaselineArm_isFragile', () => {
        // a4: with [1,1]=1.0 vs base [1,0]=0.5 -> discriminating; the baseline arm's std 0.5 makes it high_variance
        const r = svDecide([svEval(1, 'e', ['1111', '1111'], ['1111', '1110'])]);

        expect(r.verdict).toBe('accept');
        expect(r.fragile).toBe(true);
    });

    it('computeVerdict_twoDiscriminatingAssertionsOneOfThemHighVariance_isNotFragile', () => {
        // a3 mixed in with_skill (disc + high variance), a4 solid (disc): the only-discriminating clause fails
        const r = svDecide([svEval(1, 'e', ['1111', '1101'], ['1100', '1100'])]);

        expect(r.fragile).toBe(false);
    });

    it('computeVerdict_zeroDiscriminatingAssertions_isNotFragile', () => {
        expect(svDecide(svSystematicDebugging()).fragile).toBe(false);
    });

    it('computeVerdict_singleDiscriminatingAssertionAcrossTwoEvalsCountsOnceInTotal', () => {
        // evA contributes the only discriminating assertion (mixed); evB contributes none
        const evals = [
            svEval(1, 'evA', ['1111', '1101'], ['1101', '1101']),
            svEval(2, 'evB', ['1100', '1100'], ['1100', '1100']),
        ];

        expect(svDecide(evals).fragile).toBe(true);
    });

    it('computeVerdict_fragileFixtureThatRejectsForReplicates_stillReportsFragileTrueAndKeepsTheReject', () => {
        // exactly one discriminating, mixed assertion (a3); min 3 > 2 runs forces the reject
        const evals = [svEval(1, 'e', ['1110', '1100'], ['1100', '1100'])];

        const r = svDecide(evals, { minReplicates: 3 });

        expect(r.verdict).toBe('reject');
        expect(r.reasons).toEqual(['insufficient-replicates']);
        expect(r.fragile).toBe(true);
    });

    it('computeVerdict_fragileNeverChangesTheDecision_sameFixtureAcceptsWithAndWithoutVariance', () => {
        const solid = svDecide([svEval(1, 'e', ['1111', '1111'], ['1110', '1110'])]);
        const fragile = svDecide([svEval(1, 'e', ['1111', '1111'], ['1111', '1110'])]);

        expect([solid.verdict, fragile.verdict]).toEqual(['accept', 'accept']);
        expect([solid.fragile, fragile.fragile]).toEqual([false, true]);
    });
});

describe('SF-4.4 verdict — totals and failure traces', () => {
    it('computeVerdict_runsWithTiming_reportsExactTokenAndDurationTotalsPerArm', () => {
        // timing is assigned by run index within an arm: evA runs 0,1 -> 1000,2000 tokens; evB runs 0,1 -> 3000,4000
        const evals = [
            svEval(1, 'evA', ['1111', '1111'], ['1100', '1100'], (b, i) => ({ tokens: 1000 + i * 1000, duration: 10000 + i * 5000 })),
            svEval(2, 'evB', ['1100', '1100'], ['1100', '1100'], (b, i) => ({ tokens: 3000 + i * 1000, duration: 20000 + i * 5000 })),
        ];

        const r = svDecide(evals);

        expect(r.totals).toEqual({
            tokens: { with_skill: 1000 + 2000 + 3000 + 4000, baseline: 1000 + 2000 + 3000 + 4000 },
            duration_ms: { with_skill: 10000 + 15000 + 20000 + 25000, baseline: 10000 + 15000 + 20000 + 25000 },
        });
    });

    it('computeVerdict_armsWithDifferentTimings_totalsStayPerArm', () => {
        const e = svEval(1, 'e', ['1111', '1111'], ['1100', '1100']);
        e.withRuns[0].tokens = 100; e.withRuns[1].tokens = 300;
        e.baseRuns[0].tokens = 10; e.baseRuns[1].tokens = 30;
        e.withRuns[0].duration = 1000; e.withRuns[1].duration = 3000;
        e.baseRuns[0].duration = 500; e.baseRuns[1].duration = 1500;

        const r = svDecide([e]);

        expect(r.totals.tokens).toEqual({ with_skill: 400, baseline: 40 });
        expect(r.totals.duration_ms).toEqual({ with_skill: 4000, baseline: 2000 });
    });

    it('computeVerdict_runsWithoutTiming_totalsAreZeroNotNullOrNaN', () => {
        const r = svDecide(svOk());

        expect(r.totals).toEqual({
            tokens: { with_skill: 0, baseline: 0 },
            duration_ms: { with_skill: 0, baseline: 0 },
        });
    });

    it('computeVerdict_rejectWithFailureEvidence_includesExtractFailureTracesOutput', () => {
        const e = svEval(2, 'evB', ['1000', '1000'], ['1100', '1100']);
        e.withRuns[0].evidence = { 1: 'no INSERT observed' };
        e.withRuns[1].evidence = { 1: 'still no INSERT' };
        const evals = [svEval(1, 'evA', ['1111', '1111'], ['1100', '1100']), e];

        const r = svDecide(evals);

        expect(r.verdict).toBe('reject');
        expect(r.failureTraces).toEqual([
            { eval_name: 'evB', assertion: 'evB-a2', evidence: ['no INSERT observed', 'still no INSERT'] },
        ]);
    });

    it('computeVerdict_acceptEvenWhenAnAssertionFailedWithEvidence_failureTracesIsEmpty', () => {
        const e = svEval(1, 'evA', ['1110', '1110'], ['1100', '1100']);
        e.withRuns[0].evidence = { 3: 'missed the fourth rule' };
        e.withRuns[1].evidence = { 3: 'missed the fourth rule again' };

        const r = svDecide([e]);

        expect(r.verdict).toBe('accept');
        expect(r.failureTraces).toEqual([]);
    });

    it('computeVerdict_rejectWithoutAnyEvidence_failureTracesIsAnEmptyArray', () => {
        expect(svDecide(svSystematicDebugging()).failureTraces).toEqual([]);
    });
});

describe('SF-4.4 verdict — prose growth (optional measure)', () => {
    const words = (n) => Array.from({ length: n }, () => 'word').join(' ');
    // delta +1.0 (the ceiling) so a "larger delta" than the growth is reachable
    const bigWin = () => [svEval(1, 'e', ['1111', '1111'], ['0000', '0000'])];

    it('proseMetricsTool_isPresentInTheWorkshop_precondition', () => {
        expect(fs.existsSync(SV_PROSE_TOOL)).toBe(true);
        expect(m.PROSE_GROWTH_BOUND).toBeGreaterThan(0);
        expect(m.PROSE_GROWTH_BOUND).toBeLessThan(1);
    });

    it('computeVerdict_toolAbsent_proseGrowthIsNullAndTheDecisionIsUnaffected', () => {
        const r = svDecide(svOk(), {
            proseMetricsPath: path.join(tmpDir, 'no-such-skill-prose-metrics.cjs'),
            baselineBody: words(100),
            candidateBody: words(900), // would be a prose-growth reject if the tool existed
        });

        expect(r.proseGrowth).toBeNull();
        expect(r.verdict).toBe('accept');
    });

    it('computeVerdict_toolPresentButNoBodiesSupplied_proseGrowthIsNull', () => {
        expect(svDecide(svOk(), { proseMetricsPath: SV_PROSE_TOOL }).proseGrowth).toBeNull();
        expect(svDecide(svOk(), { proseMetricsPath: SV_PROSE_TOOL, baselineBody: words(100) }).proseGrowth).toBeNull();
    });

    it('computeVerdict_bodyGrowsPastTheBoundWithoutALargerDelta_rejectsProseGrowthOnly', () => {
        const r = svDecide(svOk(), { proseMetricsPath: SV_PROSE_TOOL, baselineBody: words(100), candidateBody: words(300) }); // growth 2.0 > delta 0.25

        expect(r.verdict).toBe('reject');
        expect(r.reasons).toEqual(['prose-growth']);
        expect(r.proseGrowth).toEqual({ beforeWords: 100, afterWords: 300, growth: 2, bound: m.PROSE_GROWTH_BOUND });
    });

    it('computeVerdict_bodyGrowsPastTheBoundButDeltaIsLarger_accepts', () => {
        const bound = m.PROSE_GROWTH_BOUND;
        const after = Math.ceil(1000 * (1 + bound + (1 - bound) / 2)); // growth strictly between the bound and the +1.0 delta
        const r = svDecide(bigWin(), { proseMetricsPath: SV_PROSE_TOOL, baselineBody: words(1000), candidateBody: words(after) });

        expect(r.proseGrowth.growth).toBeGreaterThan(bound);
        expect(r.proseGrowth.growth).toBeLessThan(r.delta);
        expect(r.verdict).toBe('accept');
    });

    it('computeVerdict_bodyGrowthWithinTheBound_acceptsAndStillReportsTheMeasure', () => {
        const r = svDecide(svOk(), { proseMetricsPath: SV_PROSE_TOOL, baselineBody: words(1000), candidateBody: words(1000) });

        expect(r.verdict).toBe('accept');
        expect(r.proseGrowth).toEqual({ beforeWords: 1000, afterWords: 1000, growth: 0, bound: m.PROSE_GROWTH_BOUND });
    });

    it('computeVerdict_bodyShrinks_acceptsWithNegativeGrowth', () => {
        const r = svDecide(svOk(), { proseMetricsPath: SV_PROSE_TOOL, baselineBody: words(200), candidateBody: words(100) });

        expect(r.verdict).toBe('accept');
        expect(r.proseGrowth.growth).toBe(-0.5);
    });

    it('computeVerdict_defaultToolPathWithBodies_resolvesTheWorkshopToolAndMeasures', () => {
        const r = svDecide(svOk(), { baselineBody: words(100), candidateBody: words(100) });

        expect(r.proseGrowth).toEqual({ beforeWords: 100, afterWords: 100, growth: 0, bound: m.PROSE_GROWTH_BOUND });
    });
});

describe('SF-4.4 verdict — fail-closed on bad input', () => {
    it('computeVerdict_benchmarkWithWarnings_isDataQualityExit3EvenWhenDeltaIsNegative', () => {
        const bench = svBench([svEval(1, 'e', ['1000', '1000'], ['1100', '1100'])]);
        bench.warnings = ['grading.json exists but failed to parse — excluded from aggregation: x'];

        const r = m.computeVerdict(bench);

        expect(r.verdict).toBe('data-quality');
        expect(r.exitCode).toBe(3);
        expect(r.reasons).toEqual(['data-quality']);
        expect(r.warnings).toEqual(bench.warnings);
    });

    it('computeVerdict_benchmarkWithWarningsAndAWinningDelta_neverAccepts', () => {
        const bench = svBench(svOk());
        bench.warnings = ['eval-1: has with_skill but NO baseline run'];

        expect(m.computeVerdict(bench).verdict).toBe('data-quality');
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['a string', 'benchmark'],
        ['an empty object', {}],
        ['evals not an array', { evals: 'x', summary: { delta: { pass_rate: 1 } } }],
        ['no summary.delta', { evals: [], summary: {} }],
    ])('computeVerdict_%s_returnsDataQualityWithoutThrowing', (_label, input) => {
        let r = null;
        let threw = null;
        try { r = m.computeVerdict(input); } catch (e) { threw = e; }

        expect(threw).toBeNull();
        expect(r.verdict).toBe('data-quality');
        expect(r.exitCode).toBe(3);
    });

    it('computeVerdict_emptyEvalsNoWarningsAndAPositiveHeadline_isDataQualityNeverAccept', () => {
        // m4: the old fixture had headline 0 and rejected through no-improvement, so it could not catch an empty-evals accept
        const bench = { evals: [], summary: { delta: { pass_rate: 0.5 } }, warnings: [] };

        const r = m.computeVerdict(bench);

        expect(r.verdict).toBe('data-quality');
        expect(r.exitCode).toBe(3);
    });

    it('computeVerdict_emptyEvalsFromAggregateOfNothing_isDataQuality', () => {
        const bench = { ...m.aggregateBenchmark([], { skillName: 'x' }), warnings: [] };

        expect(m.computeVerdict(bench).verdict).toBe('data-quality');
    });
});

// ── Independent oracle: the decision recomputed from RAW arm results ─────────
// Written separately from the implementation: it never touches aggregateBenchmark,
// the benchmark object, or any exported helper; only the raw {pass[]} runs.

function refMean(xs) { let s = 0; for (const x of xs) s += x; return xs.length ? s / xs.length : 0; }
function refRate(run) { let p = 0; for (const b of run.pass) if (b) p++; return p / run.pass.length; }
function refEvalDelta(e) { return refMean(e.withRuns.map(refRate)) - refMean(e.baseRuns.map(refRate)); }
function refHeadline(evals) { return refMean(evals.map(refEvalDelta)); }
function refSign(x) { return Math.abs(x) < 1e-9 ? 0 : x > 0 ? 1 : -1; }
function refStd(xs) { const mu = refMean(xs); return xs.length < 2 ? 0 : Math.sqrt(refMean(xs.map((x) => (x - mu) * (x - mu)))); }
function refFragile(evals) {
    const disc = [];
    for (const e of evals) {
        for (let i = 0; i < e.texts.length; i++) {
            const w = e.withRuns.map((r) => (r.pass[i] ? 1 : 0));
            const b = e.baseRuns.map((r) => (r.pass[i] ? 1 : 0));
            if (Math.abs(refMean(w) - refMean(b)) >= 0.25) disc.push(Math.max(refStd(w), refStd(b)) >= 0.25);
        }
    }
    return disc.length === 1 && disc[0] === true;
}
function refSum(evals, arm, field) {
    let s = 0;
    for (const e of evals) for (const r of e[arm]) if (typeof r[field] === 'number') s += r[field];
    return s;
}
function refDecision(spec) {
    const replicatesOk = spec.evals.every((e) => e.withRuns.length >= spec.min && e.baseRuns.length >= spec.min);
    const noNegativeEval = spec.evals.every((e) => refSign(refEvalDelta(e)) >= 0);
    const improves = refSign(refHeadline(spec.evals)) > 0;
    const holdoutOk = !spec.holdout || refSign(refHeadline(spec.holdout)) >= 0;
    return { accept: replicatesOk && noNegativeEval && improves && holdoutOk, replicatesOk, noNegativeEval, improves, holdoutOk };
}

function svRand(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function svGenEvals(rand, prefix, nEvals, reps, pWith, pBase) {
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const bits = (p) => Array.from({ length: 4 }, () => (rand() < p ? '1' : '0')).join('');
    const timing = () => ({ tokens: 100 + Math.floor(rand() * 4900), duration: 1000 + Math.floor(rand() * 89000) });
    return Array.from({ length: nEvals }, (_, i) => {
        const nW = pick(reps), nB = pick(reps);
        const e = svEval(`${prefix}${i + 1}`, `${prefix}e${i + 1}`, Array.from({ length: nW }, () => bits(pWith)), Array.from({ length: nB }, () => bits(pBase)));
        for (const r of [...e.withRuns, ...e.baseRuns]) Object.assign(r, timing());
        return e;
    });
}
function svGenCases(count, seed) {
    const rand = svRand(seed);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const reps = [2, 2, 2, 2, 2, 2, 3, 3, 1];
    return Array.from({ length: count }, () => ({
        evals: svGenEvals(rand, 'm', pick([1, 1, 2, 4]), reps, 0.8, 0.45),
        min: pick([1, 2, 2, 2, 3]),
        holdout: rand() < 0.5 ? svGenEvals(rand, 'h', pick([1, 2]), [2, 3], 0.6, 0.5) : null,
    }));
}
const svClone = (x) => JSON.parse(JSON.stringify(x));
const svSpecDecide = (c, over = {}) => {
    const s = { ...c, ...over };
    return m.computeVerdict(svBench(s.evals), { minReplicates: s.min, holdout: s.holdout ? svBench(s.holdout) : null });
};
/** Every (set, evalIdx, arm, runIdx, assertIdx) bit position of a case. */
function svPositions(c) {
    const out = [];
    for (const set of ['evals', 'holdout']) {
        (c[set] || []).forEach((e, ei) => {
            for (const arm of ['withRuns', 'baseRuns']) e[arm].forEach((r, ri) => r.pass.forEach((_, ai) => out.push({ set, ei, arm, ri, ai })));
        });
    }
    return out;
}
const svBit = (c, p) => c[p.set][p.ei][p.arm][p.ri].pass[p.ai];
const svFlipped = (c, p) => { const d = svClone(c); d[p.set][p.ei][p.arm][p.ri].pass[p.ai] = !svBit(c, p); return d; };
const SV_CASES = svGenCases(400, 0x5f4d4);

/** Flip every bit of the given arm whose current value is `from`; return {flips, bad} where bad = cases whose accept-ness changed to `badIsAccept`. */
function svFlipSweep(cases, arm, from, badIsAccept) {
    let flips = 0;
    const bad = [];
    for (const c of cases) {
        for (const p of svPositions(c)) {
            if (p.arm !== arm || svBit(c, p) !== from) continue;
            flips++;
            if ((svSpecDecide(svFlipped(c, p)).verdict === 'accept') === badIsAccept) bad.push(p);
        }
    }
    return { flips, bad };
}

describe('SF-4.4 verdict — independent oracle (raw arm results -> decision)', () => {
    it('generatedCases_exerciseBothOutcomesAndEveryRule_soThePropertiesAreNotVacuous', () => {
        const dec = SV_CASES.map((c) => ({ c, o: refDecision(c) }));

        expect(dec.filter((d) => d.o.accept).length).toBeGreaterThan(40);
        expect(dec.filter((d) => !d.o.accept).length).toBeGreaterThan(40);
        expect(dec.filter((d) => !d.o.replicatesOk).length).toBeGreaterThan(10);
        expect(dec.filter((d) => !d.o.noNegativeEval).length).toBeGreaterThan(10);
        expect(dec.filter((d) => !d.o.improves).length).toBeGreaterThan(10);
        expect(dec.filter((d) => d.c.holdout && d.o.accept).length).toBeGreaterThan(10);
        expect(dec.filter((d) => d.c.holdout && !d.o.holdoutOk).length).toBeGreaterThan(5);
    });

    it('computeVerdict_agreesWithTheReferenceDecisionOnEveryGeneratedCase', () => {
        const wrong = SV_CASES.map((c, i) => ({ i, want: refDecision(c).accept, got: svSpecDecide(c) }))
            .filter((x) => (x.got.verdict === 'accept') !== x.want)
            .map((x) => ({ i: x.i, want: x.want, got: x.got.verdict }));

        expect(wrong).toEqual([]);
    });

    it('computeVerdict_exitCodeMatchesVerdictAndReasonsAreEmptyExactlyOnAccept', () => {
        for (const c of SV_CASES) {
            const r = svSpecDecide(c);
            const want = refDecision(c);
            expect(r.exitCode).toBe(want.accept ? 0 : 4);
            expect(r.reasons.length === 0).toBe(want.accept);
        }
    });

    it('computeVerdict_reasonsMatchTheReferenceRuleBreakdownOnEveryGeneratedCase', () => {
        for (const c of SV_CASES) {
            const o = refDecision(c);
            const want = [];
            if (!o.replicatesOk) want.push('insufficient-replicates');
            if (!o.noNegativeEval) want.push('negative-eval-delta');
            if (!o.improves) want.push('no-improvement');
            if (!o.holdoutOk) want.push('holdout-regression');

            expect(svSpecDecide(c).reasons).toEqual(want);
        }
    });

    it('computeVerdict_deltaFragileAndTotalsMatchTheReferenceOnEveryGeneratedCase', () => {
        for (const c of SV_CASES) {
            const r = svSpecDecide(c);

            expect(r.delta).toBeCloseTo(refHeadline(c.evals), 3);
            if (c.holdout) expect(r.holdoutDelta).toBeCloseTo(refHeadline(c.holdout), 3);
            else expect(r.holdoutDelta).toBeNull();
            expect(r.fragile).toBe(refFragile(c.evals));
            // benchmark means are rounded to 4 dp, so totals (mean x n) are exact to well under 1 unit
            expect(Math.abs(r.totals.tokens.with_skill - refSum(c.evals, 'withRuns', 'tokens'))).toBeLessThan(1);
            expect(Math.abs(r.totals.tokens.baseline - refSum(c.evals, 'baseRuns', 'tokens'))).toBeLessThan(1);
            expect(Math.abs(r.totals.duration_ms.with_skill - refSum(c.evals, 'withRuns', 'duration'))).toBeLessThan(1);
            expect(Math.abs(r.totals.duration_ms.baseline - refSum(c.evals, 'baseRuns', 'duration'))).toBeLessThan(1);
        }
    });

    it('verdictIteration_diskPipelineMatchesTheReferenceOnAGeneratedSample', () => {
        const sample = SV_CASES.filter((_, i) => i % 20 === 0); // 20 cases, both outcomes
        for (const c of sample) {
            const dir = svIter('main', c.evals);
            const holdoutDir = c.holdout ? svIter('hold', c.holdout) : undefined;

            const r = m.verdictIteration(dir, { minReplicates: c.min, holdoutDir });

            expect(r.verdict === 'accept').toBe(refDecision(c).accept);
        }
    });
});

describe('SF-4.4 verdict — properties', () => {
    const accepted = () => SV_CASES.filter((c) => refDecision(c).accept);
    const rejected = () => SV_CASES.filter((c) => !refDecision(c).accept);

    it('acceptStaysAcceptWhenAnyWithSkillFailureBecomesAPass_moreWinsNeverReject', () => {
        const { flips, bad } = svFlipSweep(accepted(), 'withRuns', false, false);

        expect(flips).toBeGreaterThan(100);
        expect(bad).toEqual([]);
    });

    it('acceptStaysAcceptWhenAnyBaselinePassBecomesAFailure_aWorseBaselineNeverRejects', () => {
        const { flips, bad } = svFlipSweep(accepted(), 'baseRuns', true, false);

        expect(flips).toBeGreaterThan(100);
        expect(bad).toEqual([]);
    });

    it('rejectStaysRejectWhenAWithSkillPassBecomesAFailure_aWorseCandidateNeverAccepts', () => {
        const { flips, bad } = svFlipSweep(rejected(), 'withRuns', true, true);

        expect(flips).toBeGreaterThan(100);
        expect(bad).toEqual([]);
    });

    it('rejectStaysRejectWhenABaselineFailureBecomesAPass_aBetterBaselineNeverAccepts', () => {
        const { flips, bad } = svFlipSweep(rejected(), 'baseRuns', false, true);

        expect(flips).toBeGreaterThan(100);
        expect(bad).toEqual([]);
    });

    it('lowerMinReplicatesNeverTurnsAcceptIntoReject_andHigherNeverTurnsRejectIntoAccept', () => {
        for (const c of SV_CASES) {
            for (const min of [2, 3]) {
                const strict = svSpecDecide(c, { min }).verdict === 'accept';
                const lax = svSpecDecide(c, { min: min - 1 }).verdict === 'accept';
                if (strict) expect(lax).toBe(true);
                if (!lax) expect(strict).toBe(false);
            }
        }
    });

    it('evalOrderDoesNotChangeTheVerdictDeltaOrFragile', () => {
        for (const c of SV_CASES) {
            const a = svSpecDecide(c);
            const b = svSpecDecide({ ...c, evals: [...c.evals].reverse() });

            expect(b.verdict).toBe(a.verdict);
            expect(b.exitCode).toBe(a.exitCode);
            expect(b.fragile).toBe(a.fragile);
            expect(b.delta).toBeCloseTo(a.delta, 4);
        }
    });

    it('tokensAndDurationsNeverInfluenceTheDecision', () => {
        for (const c of SV_CASES.slice(0, 120)) {
            const heavy = svClone(c);
            for (const r of heavy.evals.flatMap((e) => [...e.withRuns, ...e.baseRuns])) { r.tokens += 1e6; r.duration *= 100; }

            expect(svSpecDecide(heavy).verdict).toBe(svSpecDecide(c).verdict);
        }
    });

    it('theDecisionIsDeterministic_theSameBenchmarkTwiceGivesTheIdenticalResult', () => {
        for (const c of SV_CASES.slice(0, 60)) {
            expect(svSpecDecide(c)).toEqual(svSpecDecide(c));
        }
    });

    it('computeVerdict_doesNotMutateTheBenchmarkOrHoldoutItIsGiven', () => {
        const bench = svBench(svOk());
        const hold = svBench(svOk());
        const before = JSON.stringify([bench, hold]);

        m.computeVerdict(bench, { holdout: hold });

        expect(JSON.stringify([bench, hold])).toBe(before);
    });
});

describe('SF-4.4 verdict CLI — exit table and JSON', () => {
    it('cli_codeReviewShapeOnDisk_exits0WithAcceptFragileAndJsonOnStdout', () => {
        const r = svCli([svIter('iteration-1', svCodeReview())]);

        expect(r.status).toBe(0);
        expect(r.json.verdict).toBe('accept');
        expect(r.json.exitCode).toBe(0);
        expect(r.json.fragile).toBe(true);
        expect(r.json.delta).toBeCloseTo(0.125, 4);
    });

    it('cli_systematicDebuggingShapeOnDisk_exits4WithNoImprovement', () => {
        const r = svCli([svIter('iteration-1', svSystematicDebugging())]);

        expect(r.status).toBe(4);
        expect(r.json.verdict).toBe('reject');
        expect(r.json.reasons).toEqual(['no-improvement']);
    });

    it('cli_todoReplayShapeOnDisk_exits4ForInsufficientReplicates', () => {
        const dir = svIter('iteration-1', svTodoReplay());

        const r = svCli([dir]);

        expect(r.status).toBe(4);
        expect(r.json.reasons).toEqual(['insufficient-replicates']);
        expect(svCli([dir, '--min-replicates', '1']).status).toBe(0);
    });

    it('cli_minReplicatesDefaultsTo2AndIsEchoed_andAnExplicit3RejectsTwoRunArms', () => {
        const dir = svIter('iteration-1', svOk());

        expect(svCli([dir]).json.minReplicates).toBe(2);
        expect(svCli([dir, '--min-replicates', '3']).status).toBe(4);
        expect(svCli([dir, '--min-replicates', '3']).json.reasons).toEqual(['insufficient-replicates']);
    });

    it('cli_benchmarkWithPresentButMalformedBaselineGrading_exits3DataQuality', () => {
        const dir = svIter('iteration-1', svOk(), { benchmark: false });
        fs.writeFileSync(path.join(dir, 'eval-1-evA', SV_BASE, 'run-1', 'grading.json'), '{not json');
        fs.writeFileSync(path.join(dir, 'benchmark.json'), JSON.stringify(m.aggregateIteration(dir, { skillName: 'fixture' })));

        const r = svCli([dir]);

        expect(r.status).toBe(3);
        expect(r.json.verdict).toBe('data-quality');
        expect(r.json.warnings.length).toBeGreaterThan(0);
    });

    it('cli_benchmarkJsonThatParsesButIsNotABenchmark_exits3NotAccept', () => {
        const dir = svIter('iteration-1', svOk(), { benchmark: false });
        fs.writeFileSync(path.join(dir, 'benchmark.json'), '{}');

        expect(svCli([dir]).status).toBe(3);
    });

    it('cli_missingBenchmarkJson_exits1', () => {
        const dir = svIter('iteration-1', svOk(), { benchmark: false });

        const r = svCli([dir]);

        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/benchmark\.json/);
    });

    it('cli_unparseableBenchmarkJson_exits1', () => {
        const dir = svIter('iteration-1', svOk(), { benchmark: false });
        fs.writeFileSync(path.join(dir, 'benchmark.json'), '{"evals": [');

        expect(svCli([dir]).status).toBe(1);
    });

    it('cli_iterationDirMissing_exits1', () => {
        expect(svCli([path.join(tmpDir, 'sv-does-not-exist')]).status).toBe(1);
    });

    it('cli_noIterationDir_exits2AndUsageNamesVerdict', () => {
        const r = svCli([]);

        expect(r.status).toBe(2);
        expect(r.stderr).toContain('verdict');
    });

    it('cli_unknownSubcommand_exits2AndUsageNamesVerdict', () => {
        const r = svSpawn(process.execPath, [SV_SCRIPT, 'bogus'], { encoding: 'utf8', windowsHide: true });

        expect(r.status).toBe(2);
        expect(r.stderr).toContain('verdict');
    });

    it.each([
        ['NonNumeric', 'abc'],
        ['Zero', '0'],
        ['Negative', '-1'],
        ['Fractional', '1.5'],
        ['Empty', ''],
    ])('cli_minReplicates%s_exits2', (_label, value) => {
        const dir = svIter('iteration-1', svOk());

        const r = svCli([dir, '--min-replicates', value]);

        expect(r.status).toBe(2);
        expect(r.stderr).toContain('--min-replicates'); // the usage error names the flag (a missing subcommand would not)
    });

    it('cli_minReplicatesFlagWithoutAValue_exits2', () => {
        const dir = svIter('iteration-1', svOk());

        const r = svCli([dir, '--min-replicates']);

        expect(r.status).toBe(2);
        expect(r.stderr).toContain('--min-replicates');
    });

    it('cli_holdoutFlagWithoutAValue_exits2', () => {
        const dir = svIter('iteration-1', svOk());

        const r = svCli([dir, '--holdout']);

        expect(r.status).toBe(2);
        expect(r.stderr).toContain('--holdout');
    });

    it('cli_holdoutDirMissing_exits1', () => {
        const dir = svIter('iteration-1', svOk());

        expect(svCli([dir, '--holdout', path.join(tmpDir, 'sv-no-holdout')]).status).toBe(1);
    });

    it('cli_holdoutDirWithoutBenchmarkJson_exits1', () => {
        const dir = svIter('iteration-1', svOk());
        const hold = svIter('holdout', [svEval(9, 'hold', ['1111', '1111'], ['1100', '1100'])], { benchmark: false });

        expect(svCli([dir, '--holdout', hold]).status).toBe(1);
    });

    it('cli_holdoutBenchmarkUnparseable_exits1', () => {
        const dir = svIter('iteration-1', svOk());
        const hold = svIter('holdout', [svEval(9, 'hold', ['1111', '1111'], ['1100', '1100'])], { benchmark: false });
        fs.writeFileSync(path.join(hold, 'benchmark.json'), 'nope');

        expect(svCli([dir, '--holdout', hold]).status).toBe(1);
    });

    it('cli_holdoutRegression_exits4AndReportsHoldoutDelta', () => {
        const dir = svIter('iteration-1', svOk());
        const hold = svIter('holdout', [svEval(9, 'hold', ['1000', '1000'], ['1100', '1100'])]);

        const r = svCli([dir, '--holdout', hold]);

        expect(r.status).toBe(4);
        expect(r.json.reasons).toEqual(['holdout-regression']);
        expect(r.json.holdoutDelta).toBeCloseTo(-0.25, 4);
    });

    it('cli_holdoutAtZero_exits0', () => {
        const dir = svIter('iteration-1', svOk());
        const hold = svIter('holdout', [svEval(9, 'hold', ['1100', '1100'], ['1100', '1100'])]);

        expect(svCli([dir, '--holdout', hold]).status).toBe(0);
    });

    it('cli_rejectWithEvidence_printsFailureTracesInTheJson', () => {
        const e = svEval(2, 'evB', ['1000', '1000'], ['1100', '1100']);
        e.withRuns[0].evidence = { 1: 'no INSERT observed' };
        const dir = svIter('iteration-1', [svEval(1, 'evA', ['1111', '1111'], ['1100', '1100']), e]);

        const r = svCli([dir]);

        expect(r.status).toBe(4);
        expect(r.json.failureTraces).toEqual([{ eval_name: 'evB', assertion: 'evB-a2', evidence: ['no INSERT observed'] }]);
    });

    it('cli_totalsAreInTheJson', () => {
        const e = svEval(1, 'e', ['1111', '1111'], ['1100', '1100']);
        e.withRuns[0].tokens = 100; e.withRuns[1].tokens = 300; e.baseRuns[0].tokens = 10; e.baseRuns[1].tokens = 30;
        e.withRuns[0].duration = 1000; e.withRuns[1].duration = 3000; e.baseRuns[0].duration = 500; e.baseRuns[1].duration = 1500;

        const r = svCli([svIter('iteration-1', [e])]);

        expect(r.json.totals).toEqual({ tokens: { with_skill: 400, baseline: 40 }, duration_ms: { with_skill: 4000, baseline: 2000 } });
    });

    it('cli_verdictIsReadOnly_theIterationDirIsByteIdenticalAfterwards', () => {
        const dir = svIter('iteration-1', svOk());
        const snapshot = () => fs.readdirSync(dir, { recursive: true }).sort().map((f) => {
            const p = path.join(dir, String(f));
            return `${f}:${fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : 'dir'}`;
        });
        const before = snapshot();

        const r = svCli([dir]);

        expect(r.status).toBe(0); // the verdict really ran (a missing subcommand would also leave the dir untouched)
        expect(snapshot()).toEqual(before);
    });

    it('cli_workspaceSnapshotAndCandidateBodies_driveProseGrowthReject', () => {
        const ws = fs.mkdtempSync(path.join(tmpDir, 'sv-ws-'));
        const dir = path.join(ws, 'iteration-1');
        svWriteIteration(dir, svOk());
        fs.writeFileSync(path.join(dir, 'benchmark.json'), JSON.stringify(m.aggregateIteration(dir, { skillName: 'fixture' })));
        fs.mkdirSync(path.join(ws, 'skill-snapshot'));
        fs.mkdirSync(path.join(ws, 'candidate'));
        fs.writeFileSync(path.join(ws, 'skill-snapshot', 'SKILL.md'), Array.from({ length: 100 }, () => 'word').join(' '));
        fs.writeFileSync(path.join(ws, 'candidate', 'SKILL.md'), Array.from({ length: 300 }, () => 'word').join(' '));

        const r = svCli([dir]);

        expect(r.status).toBe(4);
        expect(r.json.reasons).toEqual(['prose-growth']);
        expect(r.json.proseGrowth).toMatchObject({ beforeWords: 100, afterWords: 300, growth: 2 });
    });

    it('cli_noWorkspaceBodies_proseGrowthIsNull', () => {
        expect(svCli([svIter('iteration-1', svOk())]).json.proseGrowth).toBeNull();
    });

    it('cli_exitCodeMatchesTheReferenceOnADiskSampleOfGeneratedCases', () => {
        const sample = SV_CASES.filter((_, i) => i % 40 === 0); // 10 cases
        for (const c of sample) {
            const dir = svIter('main', c.evals);
            const args = [dir, '--min-replicates', String(c.min)];
            if (c.holdout) args.push('--holdout', svIter('hold', c.holdout));

            expect(svCli(args).status).toBe(refDecision(c).accept ? 0 : 4);
        }
    });
});

describe('M1 verdict CLI — --key=value and unknown-flag handling', () => {
    const regressingHoldout = () => svIter('holdout', [svEval(9, 'hold', ['1000', '1000'], ['1100', '1100'])]);

    it('parseArgs_keyEqualsValue_isParsedLikeKeySpaceValue', () => {
        const a = m.parseArgs(['verdict', 'dir', '--holdout=/some/path', '--min-replicates=5', '--skill-name=my-skill']);

        expect(a._).toEqual(['verdict', 'dir']);
        expect(a.holdout).toBe('/some/path');
        expect(a['min-replicates']).toBe('5');
        expect(a['skill-name']).toBe('my-skill');
    });

    it('parseArgs_valueContainingEqualsAndAnEmptyValue_splitOnTheFirstEqualsOnly', () => {
        const a = m.parseArgs(['--a=b=c', '--empty=']);

        expect(a.a).toBe('b=c');
        expect(a.empty).toBe('');
    });

    it('cli_holdoutEqualsForm_appliesTheHoldoutAndRejectsTheRegression', () => {
        const dir = svIter('iteration-1', svOk());

        const r = svCli([dir, `--holdout=${regressingHoldout()}`]);

        expect(r.status).toBe(4);
        expect(r.json.reasons).toEqual(['holdout-regression']);
    });

    it('cli_minReplicatesEqualsForm_isEnforcedNotIgnored', () => {
        const dir = svIter('iteration-1', svOk()); // 2 runs per arm

        const r = svCli([dir, '--min-replicates=5']);

        expect(r.status).toBe(4);
        expect(r.json.reasons).toEqual(['insufficient-replicates']);
        expect(r.json.minReplicates).toBe(5);
    });

    it('cli_minReplicatesEqualsBadValue_exits2', () => {
        const dir = svIter('iteration-1', svOk());

        expect(svCli([dir, '--min-replicates=abc']).status).toBe(2);
        expect(svCli([dir, '--min-replicates=']).status).toBe(2);
    });

    it('cli_holdoutEqualsEmpty_exits2NotSilentlyUnheld', () => {
        const r = svCli([svIter('iteration-1', svOk()), '--holdout=']);

        expect(r.status).toBe(2);
        expect(r.stderr).toContain('--holdout');
    });

    it('cli_misspelledHoldoutFlag_exits2AndNamesIt', () => {
        const dir = svIter('iteration-1', svOk());

        const r = svCli([dir, '--holdout-dir', regressingHoldout()]);

        expect(r.status).toBe(2);
        expect(r.stderr).toContain('--holdout-dir');
        expect(r.stdout).toBe('');
    });

    it('cli_unknownEqualsFlag_exits2', () => {
        const r = svCli([svIter('iteration-1', svOk()), '--min-replicate=5']);

        expect(r.status).toBe(2);
        expect(r.stderr).toContain('--min-replicate');
    });

    it('cli_aSecondPositional_exits2', () => {
        const dir = svIter('iteration-1', svOk());

        const r = svCli([dir, 'extra']);

        expect(r.status).toBe(2);
        expect(r.stderr).toContain('extra');
    });

    it('cli_validFlagsStillAcceptedAlongsideTheStrictCheck', () => {
        const dir = svIter('iteration-1', svOk());

        expect(svCli([dir, '--min-replicates', '2', '--holdout', svIter('holdout', [svEval(9, 'hold', ['1100', '1100'], ['1100', '1100'])])]).status).toBe(0);
    });
});

describe('M2 verdict recomputes from the raw gradings', () => {
    const failEveryWithSkillRun = (dir) => {
        for (const f of fs.readdirSync(dir, { recursive: true })) {
            const p = path.join(dir, String(f));
            if (/eval-[^/\\]+[/\\]with_skill[/\\]run-\d+[/\\]grading\.json$/.test(p)) {
                const g = JSON.parse(fs.readFileSync(p, 'utf8'));
                g.expectations = g.expectations.map((e) => ({ ...e, passed: false }));
                fs.writeFileSync(p, JSON.stringify(g));
            }
        }
    };

    it('cli_gradingsFlippedToFailAfterAggregate_exits3NeverAccept', () => {
        const dir = svIter('iteration-1', svOk());
        expect(svCli([dir]).status).toBe(0); // the honest file accepts, so the flip below is the only variable
        failEveryWithSkillRun(dir);

        const r = svCli([dir]);

        expect(r.status).toBe(3);
        expect(r.json.verdict).toBe('data-quality');
        expect(r.json.warnings.join('\n')).toMatch(/stale or edited benchmark\.json/);
        expect(r.stderr).toContain('aggregate');
    });

    it('verdictIteration_staleBenchmark_isDataQualityNotAccept', () => {
        const dir = svIter('iteration-1', svOk());
        failEveryWithSkillRun(dir);

        expect(m.verdictIteration(dir).verdict).toBe('data-quality');
    });

    it('cli_headlineEditedToAWinOverEvalsThatShowNone_exits3', () => {
        const dir = svIter('iteration-1', svSystematicDebugging()); // true delta 0
        const f = path.join(dir, 'benchmark.json');
        const b = JSON.parse(fs.readFileSync(f, 'utf8'));
        b.summary.delta.pass_rate = 0.5;
        fs.writeFileSync(f, JSON.stringify(b));

        const r = svCli([dir]);

        expect(r.status).toBe(3);
        expect(r.json.warnings.join('\n')).toContain('headline delta');
    });

    it('cli_aPerEvalDeltaEditedInTheStoredFile_exits3', () => {
        const dir = svIter('iteration-1', svOk());
        const f = path.join(dir, 'benchmark.json');
        const b = JSON.parse(fs.readFileSync(f, 'utf8'));
        b.evals[1].delta.pass_rate = 0.4; // headline untouched
        fs.writeFileSync(f, JSON.stringify(b));

        const r = svCli([dir]);

        expect(r.status).toBe(3);
        expect(r.json.warnings.join('\n')).toContain('evB');
    });

    it('cli_aRunDirectoryAddedAfterAggregate_exits3', () => {
        const dir = svIter('iteration-1', svOk());
        const extra = path.join(dir, 'eval-1-evA', 'with_skill', 'run-3');
        fs.mkdirSync(extra, { recursive: true });
        fs.writeFileSync(path.join(extra, 'grading.json'), JSON.stringify({ expectations: [{ text: 'evA-a1', passed: false }] }));

        expect(svCli([dir]).status).toBe(3);
    });

    it('cli_aStaleHoldoutBenchmark_exits3', () => {
        const dir = svIter('iteration-1', svOk());
        const hold = svIter('holdout', [svEval(9, 'hold', ['1100', '1100'], ['1100', '1100'])]);
        failEveryWithSkillRun(hold);

        const r = svCli([dir, '--holdout', hold]);

        expect(r.status).toBe(3);
        expect(r.json.warnings.join('\n')).toMatch(/holdout/);
    });

    it('cli_aFreshBenchmarkAfterReAggregate_acceptsAgain', () => {
        const dir = svIter('iteration-1', svOk());
        const f = path.join(dir, 'benchmark.json');

        fs.writeFileSync(f, JSON.stringify(m.aggregateIteration(dir, { skillName: 'fixture' }), null, 2));

        expect(svCli([dir]).status).toBe(0);
    });

    it('cli_benchmarkJsonStillRequired_missingFileExits1EvenWithRawGradingsPresent', () => {
        const dir = svIter('iteration-1', svOk(), { benchmark: false });

        expect(svCli([dir]).status).toBe(1);
    });

    it('cli_emptyEvalsInTheStoredFileOverRawGradings_neverAccepts', () => {
        const dir = svIter('iteration-1', svOk());
        const f = path.join(dir, 'benchmark.json');
        fs.writeFileSync(f, JSON.stringify({ evals: [], summary: { delta: { pass_rate: 0.5 } }, warnings: [] }));

        expect(svCli([dir]).status).toBe(3);
    });
});

describe('m3 verdict low-power signal', () => {
    // 3 evals x 3 runs per arm, 4 assertions each, 2 discordant per eval = 6 discordant: clears every floor
    const strong = () => [
        svEval(1, 'sA', ['1111', '1111', '1111'], ['1100', '1100', '1100']),
        svEval(2, 'sB', ['1111', '1111', '1111'], ['1100', '1100', '1100']),
        svEval(3, 'sC', ['1111', '1111', '1111'], ['1100', '1100', '1100']),
    ];

    it('computeVerdict_threeEvalsThreeRunsSixDiscordant_isNotLowPower', () => {
        const r = svDecide(strong());

        expect(r.verdict).toBe('accept');
        expect(r.lowPower).toBe(false);
        expect(r.lowPowerReasons).toEqual([]);
        expect(r.nEvals).toBe(3);
        expect(r.minRunsPerArm).toBe(3);
        expect(r.discordantAssertions).toBe(6);
    });

    it('computeVerdict_cisoNistShapeOneEvalTwoRuns_acceptsButIsLowPowerForEveryReason', () => {
        // the live 2026-06-25 ciso-nist iteration-3 case: accepted at a large delta on 1 eval x 2 runs per arm
        const r = svDecide([svEval(1, 'ciso', ['1111', '1111'], ['1000', '1000'])]);

        expect(r.verdict).toBe('accept');
        expect(r.exitCode).toBe(0);
        expect(r.lowPower).toBe(true);
        expect(r.lowPowerReasons).toEqual(['evals<2', 'runs-per-arm<3', 'discordant-assertions<6']);
        expect(r.nEvals).toBe(1);
        expect(r.minRunsPerArm).toBe(2);
        expect(r.discordantAssertions).toBe(3);
    });

    it('computeVerdict_oneEvalAloneTripsTheEvalFloor', () => {
        const r = svDecide(strong().slice(0, 1)); // 1 eval, 3 runs per arm, 2 discordant

        expect(r.lowPowerReasons).toContain('evals<2');
        expect(r.lowPower).toBe(true);
    });

    it('computeVerdict_twoRunsPerArmAloneTripsTheRunFloor', () => {
        const evals = strong().map((e) => ({ ...e, withRuns: e.withRuns.slice(0, 2), baseRuns: e.baseRuns.slice(0, 2) }));

        const r = svDecide(evals);

        expect(r.lowPowerReasons).toEqual(['runs-per-arm<3']);
        expect(r.minRunsPerArm).toBe(2);
    });

    it('computeVerdict_theThinnestArmAcrossEvalsSetsMinRunsPerArm', () => {
        const evals = strong();
        evals[1].baseRuns = evals[1].baseRuns.slice(0, 2);

        expect(svDecide(evals).minRunsPerArm).toBe(2);
    });

    it('computeVerdict_fiveDiscordantAssertionsAloneTripsTheFlipFloor_sixDoesNot', () => {
        const five = strong();
        five[2] = svEval(3, 'sC', ['1101', '1101', '1101'], ['1100', '1100', '1100']); // 1 discordant, not 2

        expect(svDecide(five).discordantAssertions).toBe(5);
        expect(svDecide(five).lowPowerReasons).toEqual(['discordant-assertions<6']);
        expect(svDecide(strong()).lowPowerReasons).toEqual([]);
    });

    it('computeVerdict_lowPowerNeverChangesTheDecisionOrExitCode', () => {
        const low = svDecide(svOk());

        expect(low.lowPower).toBe(true);
        expect(low.verdict).toBe('accept');
        expect(low.exitCode).toBe(0);
    });

    it('computeVerdict_aRejectAlsoCarriesThePowerFields', () => {
        const r = svDecide(svSystematicDebugging());

        expect(r.verdict).toBe('reject');
        expect(r.lowPower).toBe(true);
        expect(r.nEvals).toBe(1);
    });

    it('computeVerdict_dataQuality_reportsNullPowerNotFalse', () => {
        const r = m.computeVerdict(null);

        expect(r.lowPower).toBeNull();
        expect(r.nEvals).toBeNull();
        expect(r.lowPowerReasons).toEqual([]);
    });

    it('cli_lowPowerAccept_printsTheFlagInJsonAndAWarningOnStderr', () => {
        const r = svCli([svIter('iteration-1', [svEval(1, 'ciso', ['1111', '1111'], ['1000', '1000'])])]);

        expect(r.status).toBe(0);
        expect(r.json.lowPower).toBe(true);
        expect(r.stderr).toMatch(/LOW POWER/);
        expect(r.stderr).toMatch(/never auto-apply/);
    });

    it('cli_strongAccept_hasNoLowPowerLine', () => {
        const r = svCli([svIter('iteration-1', strong())]);

        expect(r.status).toBe(0);
        expect(r.json.lowPower).toBe(false);
        expect(r.stderr).not.toMatch(/LOW POWER/);
    });
});

describe('SF-4.4 verdict — evolve workflow wiring (review-evolve-skills Steps 5 and 6)', () => {
    const wf = () => fs.readFileSync(SV_WORKFLOW, 'utf8');
    const section = (text, from, to) => {
        const a = text.indexOf(from);
        const b = to ? text.indexOf(to, a + from.length) : text.length;
        return a === -1 ? '' : text.slice(a, b === -1 ? text.length : b);
    };
    const step5 = () => section(wf(), '### Step 5', '### Step 6');
    const step6 = () => section(wf(), '### Step 6', '### Step 7');

    it('step5_callsSkillEvalVerdictOnTheIterationDirInsteadOfReadingBenchmarkJson', () => {
        expect(step5()).toMatch(/node \.claude\/core\/skill-eval\.js verdict <workspace>\/iteration-1/);
    });

    it('step5_documentsTheHoldoutAndMinReplicatesFlags', () => {
        expect(step5()).toContain('--holdout');
        expect(step5()).toContain('--min-replicates');
    });

    it('step5_documentsTheThreeVerdictExitCodes', () => {
        const s = step5();

        expect(s).toContain('exit 0');
        expect(s).toContain('exit 3');
        expect(s).toContain('exit 4');
    });

    it('step5_namesTheFragileFlagAndTheFailureTracesOutput', () => {
        expect(step5()).toContain('fragile');
        expect(step5()).toContain('failureTraces');
    });

    it('step5_noLongerTellsTheReaderToReadBenchmarkJsonAndDecide', () => {
        expect(step5()).not.toMatch(/^Read `benchmark\.json`\./m);
        expect(step5()).not.toContain('only legitimate if **`summary.delta.pass_rate > 0`**');
    });

    it('m2_noOldAcceptRuleSurvivesAnywhereInTheWholeWorkflow', () => {
        const all = wf();

        expect(all).not.toMatch(/non-positive[^\n]*blocks/i);
        expect(all).not.toMatch(/delta\.pass_rate\W+is not positive/i);
        expect(all).not.toContain('not positive');
    });

    it('m2_applyAndWhatNotToDoStateTheVerdictRule', () => {
        const all = wf();
        const apply = all.split('\n').find((l) => l.startsWith('- `--apply <skill-name>`')) || '';
        const dont = all.split('\n').find((l) => l.startsWith('- Do NOT apply a skill change')) || '';

        expect(apply).toContain('verdict');
        expect(apply).toContain('exit 0');
        expect(dont).toContain('verdict');
        expect(dont).toContain('exit 0');
    });

    it('m2_step6RecordsTheVerdictReasonsFragileLowPowerAndDelta', () => {
        const s = step6();

        for (const word of ['verdict', 'reasons', 'fragile', 'lowPower', 'delta']) expect(s).toContain(word);
    });

    it('m3_step5NamesLowPowerAndTreatsItAsProposeNeverAutoApply', () => {
        const s = step5();

        expect(s).toContain('lowPower');
        expect(s).toMatch(/propose, never auto-apply|never auto-appl/i);
        expect(step6()).toMatch(/lowPower/);
    });

    it('step6_gatesApplyOnTheVerdictAcceptExit0', () => {
        const s = step6();

        expect(s).toMatch(/verdict/);
        expect(s).toContain('exit 0');
        expect(s).not.toContain('For each candidate with a positive, warning-free differential');
    });

    it('workflow_stepsExistSoTheSectionSlicingIsNotVacuous', () => {
        expect(step5().length).toBeGreaterThan(200);
        expect(step6().length).toBeGreaterThan(200);
    });
});
