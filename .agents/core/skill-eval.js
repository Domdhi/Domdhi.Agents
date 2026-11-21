/**
 * Skill eval harness — deterministic aggregation + rendering.
 *
 * The quantitative half of the `skill-creator` skill's eval loop, ported from
 * Anthropic's skill-creator (anthropics/skills) to zero-dependency Node so it
 * stays drop-in with the rest of `.claude/core/`. The LLM half (running the
 * with_skill / baseline subagents and grading their outputs) lives in the
 * skill + the /review:evolve-skills command; this script only does the math:
 * it reads an iteration directory of graded runs and produces benchmark.json +
 * benchmark.md (mean ± stddev per config, with the delta the viewer shows).
 *
 * Differential model (the core idea): every eval runs in two configurations —
 * `with_skill` (the treatment) and a baseline (`without_skill` for a NEW skill,
 * `old_skill` for an IMPROVED one). The skill is justified when with_skill
 * beats baseline on pass-rate. This replaces skill-authoring's old "failing
 * test FIRST" rule with "evidence-of-gap first, differential eval after".
 *
 * Directory contract (created at runtime under docs/.output/evolution/skills/):
 *   <iteration>/
 *     eval-<id>-<name>/
 *       eval_metadata.json          { eval_id, eval_name, prompt, assertions:[{text,passed,evidence}] }
 *       with_skill/   grading.json  { expectations:[{text,passed,evidence}] }  (+ timing.json)
 *                     run-<k>/grading.json ...                                  (multi-run variant)
 *       without_skill/ | old_skill/  (same shape — the baseline)
 *     benchmark.json / benchmark.md  (THIS script writes these)
 *
 * timing.json: { total_tokens, duration_ms, total_duration_seconds? }
 *
 * Usage:
 *   node .claude/core/skill-eval.js aggregate <iterationDir> --skill-name <name> [--date YYYY-MM-DD]
 *   node .claude/core/skill-eval.js verdict <iterationDir> [--holdout <dir>] [--min-replicates 2]
 *
 * `verdict` requires the benchmark.json that `aggregate` wrote, recomputes the benchmark from
 * the raw grading files and decides accept / reject in code (see computeVerdict): exit 0
 * accept · 4 reject · 3 data-quality (including a stored benchmark.json that disagrees with
 * the raw gradings) · 1 could not run · 2 bad usage (unknown flag, extra argument); stdout is
 * one JSON object. Flags take `--key value` or `--key=value`. It writes nothing. The JSON
 * carries `lowPower` (true = propose, never auto-apply).
 *
 * Exit codes (aggregate): 0 = clean · 1 = could not run (dir missing) · 2 = bad usage ·
 *   3 = aggregated, but with data-quality warnings (a grading.json was present
 *       but unparseable, or an eval lost its baseline, or zero records loaded) —
 *       the benchmark is written, but its delta may be built on incomplete data.
 *
 * Mirrors the CJS + `require.main === module` shape of skill-conformance.js.
 */

const fs = require('fs');
const path = require('path');

const TREATMENT = 'with_skill';
const BASELINE_DIRS = ['without_skill', 'old_skill']; // first one present wins
const DISCRIMINATING_DELTA = 0.25; // |with − baseline| ≥ this ⇒ the assertion measures skill value
const HIGH_VARIANCE_STD = 0.25;    // pass-rate stddev across runs above this ⇒ flag as flaky

// ── Pure statistics (unit-tested without fs) ────────────────────────────────

function mean(xs) {
    if (!xs || xs.length === 0) return 0;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population standard deviation. n<2 ⇒ 0 (a single run has no spread). */
function stddev(xs) {
    if (!xs || xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function summarizeMetric(values) {
    const xs = (values || []).filter((v) => typeof v === 'number' && !Number.isNaN(v));
    return {
        mean: round(mean(xs)),
        std: round(stddev(xs)),
        min: xs.length ? Math.min(...xs) : 0,
        max: xs.length ? Math.max(...xs) : 0,
        n: xs.length,
    };
}

function round(x, dp = 4) {
    const f = 10 ** dp;
    return Math.round(x * f) / f;
}

/** Fraction of expectations that passed for a single run. */
function passRateOfRun(expectations) {
    if (!expectations || expectations.length === 0) return 0;
    const passed = expectations.filter((e) => e && e.passed === true).length;
    return passed / expectations.length;
}

/** Percentage change baseline→treatment; null when baseline is 0 (undefined). */
function pctChange(treatment, baseline) {
    if (!baseline) return null;
    return round(((treatment - baseline) / baseline) * 100, 2);
}

// ── Aggregation ─────────────────────────────────────────────────────────────

/**
 * Aggregate the N runs of one configuration of one eval.
 * runs: [{ expectations:[{text,passed}], total_tokens, duration_ms }]
 * Returns pass_rate/tokens/duration_ms summaries + per-assertion mean pass-rate.
 */
function aggregateConfigRuns(runs) {
    const list = runs || [];
    const passRates = list.map((r) => passRateOfRun(r.expectations));
    const tokens = list.map((r) => r.total_tokens).filter((v) => typeof v === 'number');
    const durations = list.map((r) => r.duration_ms).filter((v) => typeof v === 'number');

    // Per-assertion pass-rate across runs, keyed by assertion text (stable label).
    const perAssertion = {};
    // Parallel structure: evidence strings from runs where the assertion FAILED
    // (the GEPA-style failure trace — diagnostic of WHY, not just the scalar rate).
    const perAssertionEvidence = {};
    for (const r of list) {
        for (const e of r.expectations || []) {
            if (!e || typeof e.text !== 'string') continue;
            (perAssertion[e.text] ||= []).push(e.passed === true ? 1 : 0);
            perAssertionEvidence[e.text] ||= [];
            if (e.passed !== true && typeof e.evidence === 'string' && e.evidence) {
                perAssertionEvidence[e.text].push(e.evidence);
            }
        }
    }
    const assertionRates = {};
    for (const [text, hits] of Object.entries(perAssertion)) {
        assertionRates[text] = {
            rate: round(mean(hits)),
            std: round(stddev(hits)),
            n: hits.length,
            evidence_on_fail: perAssertionEvidence[text] || [],
        };
    }

    return {
        runs: list.length,
        pass_rate: summarizeMetric(passRates),
        tokens: summarizeMetric(tokens),
        duration_ms: summarizeMetric(durations),
        assertions: assertionRates,
    };
}

function computeDelta(withAgg, baseAgg) {
    if (!withAgg || !baseAgg) return null;
    return {
        pass_rate: round(withAgg.pass_rate.mean - baseAgg.pass_rate.mean),
        tokens_pct: pctChange(withAgg.tokens.mean, baseAgg.tokens.mean),
        duration_pct: pctChange(withAgg.duration_ms.mean, baseAgg.duration_ms.mean),
    };
}

/**
 * Aggregate one eval across its configurations.
 * evalRecord: { eval_id, eval_name, prompt, baselineConfig, configs: { with_skill:[runs], <baseline>:[runs] } }
 */
function aggregateEval(evalRecord) {
    const results = {};
    for (const [config, runs] of Object.entries(evalRecord.configs || {})) {
        results[config] = aggregateConfigRuns(runs);
    }
    const withAgg = results[TREATMENT];
    const baseConfig = evalRecord.baselineConfig;
    const baseAgg = baseConfig ? results[baseConfig] : null;
    const delta = computeDelta(withAgg, baseAgg);

    // Per-assertion view: discriminating (skill moves it) vs flat, plus flakiness.
    const assertionTexts = withAgg ? Object.keys(withAgg.assertions) : [];
    const assertions = assertionTexts.map((text) => {
        const w = withAgg.assertions[text] || { rate: 0, std: 0 };
        const b = baseAgg && baseAgg.assertions[text] ? baseAgg.assertions[text] : { rate: 0, std: 0 };
        return {
            text,
            with_skill: w.rate,
            baseline: baseAgg ? b.rate : null,
            discriminating: baseAgg ? Math.abs(w.rate - b.rate) >= DISCRIMINATING_DELTA : null,
            high_variance: Math.max(w.std, b.std) >= HIGH_VARIANCE_STD,
            evidence_on_fail: (withAgg.assertions[text] || {}).evidence_on_fail || [],
        };
    });

    return {
        eval_id: evalRecord.eval_id,
        eval_name: evalRecord.eval_name,
        prompt: evalRecord.prompt,
        baseline_config: baseConfig || null,
        results,
        delta,
        assertions,
    };
}

/**
 * Build the full benchmark object from a list of eval records.
 * opts: { skillName, iteration, date }
 */
function aggregateBenchmark(evalRecords, opts = {}) {
    const evals = (evalRecords || []).map(aggregateEval);
    const baselineConfig =
        evalRecords.find((e) => e.baselineConfig)?.baselineConfig || BASELINE_DIRS[0];

    const summary = summarizeAcrossEvals(evals, baselineConfig);

    return {
        skill_name: opts.skillName || (evalRecords[0] && evalRecords[0].skill_name) || 'unknown',
        iteration: opts.iteration || null,
        generated: opts.date || null,
        configs: [TREATMENT, baselineConfig],
        evals,
        summary,
    };
}

/** Mean-of-eval-means per config, plus the headline delta. */
function summarizeAcrossEvals(evals, baselineConfig) {
    const collect = (config, picker) =>
        evals.map((e) => e.results[config] && picker(e.results[config])).filter((v) => typeof v === 'number');

    const perConfig = (config) => ({
        pass_rate: summarizeMetric(collect(config, (r) => r.pass_rate.mean)),
        tokens: summarizeMetric(collect(config, (r) => r.tokens.mean)),
        duration_ms: summarizeMetric(collect(config, (r) => r.duration_ms.mean)),
    });

    const withS = perConfig(TREATMENT);
    const baseS = perConfig(baselineConfig);
    return {
        [TREATMENT]: withS,
        [baselineConfig]: baseS,
        delta: {
            pass_rate: round(withS.pass_rate.mean - baseS.pass_rate.mean),
            tokens_pct: pctChange(withS.tokens.mean, baseS.tokens.mean),
            duration_pct: pctChange(withS.duration_ms.mean, baseS.duration_ms.mean),
        },
        n_evals: evals.length,
    };
}

// ── Rendering ───────────────────────────────────────────────────────────────

function pct(x) {
    return x === null || x === undefined ? '—' : `${round(x * 100, 1)}%`;
}
function signedPct(x) {
    if (x === null || x === undefined) return '—';
    const v = round(x * 100, 1);
    return `${v >= 0 ? '+' : ''}${v} pts`;
}

function renderBenchmarkMd(b) {
    const base = b.configs[1];
    const L = [];
    L.push(`# Skill Eval Benchmark — ${b.skill_name}`);
    L.push('');
    L.push(`**Iteration:** ${b.iteration || '—'}  ·  **Generated:** ${b.generated || '—'}  ·  **Evals:** ${b.summary.n_evals}`);
    L.push('');
    const warns = b.warnings || [];
    if (warns.length) {
        L.push('> ⚠ **DATA-QUALITY WARNINGS — the numbers below may be built on incomplete data. Resolve these before trusting the delta:**');
        for (const w of warns) L.push(`> - ${w}`);
        L.push('');
    }
    L.push('## Summary');
    L.push('');
    L.push('| Metric | with_skill | ' + base + ' | Δ |');
    L.push('|--------|-----------:|-----------:|---:|');
    const s = b.summary;
    L.push(`| Pass rate | ${pct(s[TREATMENT].pass_rate.mean)} | ${pct(s[base].pass_rate.mean)} | ${signedPct(s.delta.pass_rate)} |`);
    L.push(`| Tokens (mean) | ${fmtNum(s[TREATMENT].tokens.mean)} | ${fmtNum(s[base].tokens.mean)} | ${s.delta.tokens_pct === null ? '—' : s.delta.tokens_pct + '%'} |`);
    L.push(`| Duration ms (mean) | ${fmtNum(s[TREATMENT].duration_ms.mean)} | ${fmtNum(s[base].duration_ms.mean)} | ${s.delta.duration_pct === null ? '—' : s.delta.duration_pct + '%'} |`);
    L.push('');
    const verdict =
        s.delta.pass_rate > 0 ? '✅ skill improves pass-rate'
        : s.delta.pass_rate < 0 ? '❌ skill REGRESSES pass-rate'
        : '➖ no pass-rate difference';
    L.push(`**Verdict:** ${verdict} (Δ ${signedPct(s.delta.pass_rate)}).`);
    L.push('');
    L.push('## Per-eval');
    L.push('');
    for (const e of b.evals) {
        const w = e.results[TREATMENT];
        const bl = e.results[e.baseline_config];
        L.push(`### eval-${e.eval_id} — ${e.eval_name}`);
        L.push(`> ${truncate(e.prompt, 160)}`);
        L.push('');
        L.push('| Config | Pass rate | Tokens | Duration ms | Runs |');
        L.push('|--------|----------:|-------:|------------:|-----:|');
        if (w) L.push(`| with_skill | ${pct(w.pass_rate.mean)} ±${pct(w.pass_rate.std)} | ${fmtNum(w.tokens.mean)} | ${fmtNum(w.duration_ms.mean)} | ${w.runs} |`);
        if (bl) L.push(`| ${e.baseline_config} | ${pct(bl.pass_rate.mean)} ±${pct(bl.pass_rate.std)} | ${fmtNum(bl.tokens.mean)} | ${fmtNum(bl.duration_ms.mean)} | ${bl.runs} |`);
        L.push('');
        const flags = [];
        const nonDisc = e.assertions.filter((a) => a.discriminating === false).map((a) => a.text);
        const flaky = e.assertions.filter((a) => a.high_variance).map((a) => a.text);
        if (nonDisc.length) flags.push(`⚠ non-discriminating (pass regardless of skill): ${nonDisc.map((t) => `\`${t}\``).join(', ')}`);
        if (flaky.length) flags.push(`⚠ high variance (flaky): ${flaky.map((t) => `\`${t}\``).join(', ')}`);
        for (const f of flags) L.push(`- ${f}`);
        if (flags.length) L.push('');
    }
    return L.join('\n') + '\n';
}

function fmtNum(x) {
    if (typeof x !== 'number' || Number.isNaN(x)) return '—';
    return Math.round(x).toLocaleString('en-US');
}
function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ── Disk loading ────────────────────────────────────────────────────────────

function readJsonSafe(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * A run = its grading.json merged with its timing.json.
 *
 * Distinguishes a genuinely-ABSENT grading.json (returns null silently — e.g. a
 * config dir that holds run-N subdirs rather than a top-level run) from one that
 * is PRESENT but unparseable (pushes a warning, then returns null). The latter
 * is a malformed grader output, and treating it as "no data" is the bug that bit
 * two downstream projects: a corrupt baseline grading.json was silently dropped,
 * so `aggregate` reported a confident pass-rate delta built on a missing config.
 * Warnings collected here bubble up to `main`, which prints them and exits 3.
 */
function loadRun(runDir, warnings = []) {
    const gradingPath = path.join(runDir, 'grading.json');
    if (!fs.existsSync(gradingPath)) return null; // genuinely absent — normal, not a warning
    const grading = readJsonSafe(gradingPath);
    if (!grading) {
        warnings.push(`grading.json exists but failed to parse — excluded from aggregation: ${gradingPath}`);
        return null;
    }
    const timingPath = path.join(runDir, 'timing.json');
    let timing = {};
    if (fs.existsSync(timingPath)) {
        timing = readJsonSafe(timingPath);
        if (!timing) {
            warnings.push(`timing.json exists but failed to parse — tokens/duration dropped for this run: ${timingPath}`);
            timing = {};
        }
    }
    return {
        expectations: grading.expectations || [],
        total_tokens: timing.total_tokens,
        duration_ms: timing.duration_ms,
    };
}

/** A config dir holds either a single run (grading.json) or run-N subdirs. */
function loadConfigRuns(configDir, warnings = []) {
    if (!fs.existsSync(configDir)) return null;
    const single = loadRun(configDir, warnings);
    if (single) return [single];
    const runs = fs
        .readdirSync(configDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^run-/.test(d.name))
        .map((d) => loadRun(path.join(configDir, d.name), warnings))
        .filter(Boolean);
    return runs.length ? runs : null;
}

/** Read every eval-* dir under an iteration into eval records for aggregation. */
function loadIteration(iterationDir, warnings = []) {
    const records = [];
    if (!fs.existsSync(iterationDir)) return records;
    const evalDirs = fs
        .readdirSync(iterationDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^eval-/.test(d.name))
        .map((d) => d.name)
        .sort();

    for (const name of evalDirs) {
        const dir = path.join(iterationDir, name);
        const meta = readJsonSafe(path.join(dir, 'eval_metadata.json')) || {};
        const configs = {};
        const withRuns = loadConfigRuns(path.join(dir, TREATMENT), warnings);
        if (withRuns) configs[TREATMENT] = withRuns;
        let baselineConfig = null;
        for (const bd of BASELINE_DIRS) {
            const runs = loadConfigRuns(path.join(dir, bd), warnings);
            if (runs) {
                configs[bd] = runs;
                baselineConfig = bd;
                break;
            }
        }
        records.push({
            eval_id: meta.eval_id ?? name.replace(/^eval-/, ''),
            eval_name: meta.eval_name || name,
            prompt: meta.prompt || '',
            baselineConfig,
            configs,
        });
    }
    return records;
}

// ── Main ────────────────────────────────────────────────────────────────────

function aggregateIteration(iterationDir, opts = {}) {
    const warnings = [];
    const records = loadIteration(iterationDir, warnings);
    if (records.length === 0) {
        warnings.push(
            `no eval records loaded from ${iterationDir} — the benchmark is empty (all-zero, Δ +0). ` +
            `Expected eval-*/ subdirs, each with a ${TREATMENT}/ run and a baseline (${BASELINE_DIRS.join('|')}/), ` +
            `every run holding a parseable grading.json.`,
        );
    }
    // A delta is only meaningful when an eval has BOTH the treatment and its
    // baseline. A half-present eval (the crypto failure: baseline silently
    // dropped) contributes nothing to the summary — say so, don't hide it.
    for (const r of records) {
        const hasTreatment = !!r.configs[TREATMENT];
        const hasBaseline = !!(r.baselineConfig && r.configs[r.baselineConfig]);
        if (hasTreatment && !hasBaseline) {
            warnings.push(`eval-${r.eval_id}: has ${TREATMENT} but NO baseline run — its delta is omitted from the summary.`);
        } else if (!hasTreatment && hasBaseline) {
            warnings.push(`eval-${r.eval_id}: has a baseline but NO ${TREATMENT} run — its delta is omitted from the summary.`);
        } else if (!hasTreatment && !hasBaseline) {
            // N5: neither config loaded — the record is counted in n_evals but
            // contributes zero data. The pair-mismatch checks above miss it.
            warnings.push(`eval-${r.eval_id}: has NEITHER ${TREATMENT} nor a baseline run — it contributes no data yet is counted in n_evals.`);
        }
    }
    // M9: the summary aggregates ONE iteration-wide baseline config (the first
    // eval that names one). An eval whose baseline is the OTHER dir is dropped
    // from the headline delta while still counted in n_evals — flag the mixed
    // baselines so the delta isn't silently built on a subset.
    const chosenBaseline = records.find((r) => r.baselineConfig)?.baselineConfig || BASELINE_DIRS[0];
    for (const r of records) {
        if (r.baselineConfig && r.baselineConfig !== chosenBaseline) {
            warnings.push(`eval-${r.eval_id}: baseline "${r.baselineConfig}" differs from the iteration's aggregated baseline "${chosenBaseline}" — this eval is excluded from the headline delta (mixed baselines in one iteration).`);
        }
    }
    const iteration = opts.iteration || path.basename(iterationDir);
    const benchmark = aggregateBenchmark(records, { ...opts, iteration });
    benchmark.warnings = warnings;
    return benchmark;
}

// ── Verdict: the code-enforced accept rule ──────────────────────────────────

// A body may grow at most this fraction (afterWords / beforeWords - 1) unless the
// pass-rate delta is larger than the growth itself. Surgical IMPROVE edits are
// small; a rewrite must earn its size with a bigger measured win.
const PROSE_GROWTH_BOUND = 0.25;
// The benchmark rounds every mean to 4 dp, so a true-zero delta can be written
// as +/-0.0001. |x| <= this is ZERO for every verdict rule; any |x| >= 0.001 is real.
const DELTA_ZERO_EPSILON = 0.0001;
const DEFAULT_MIN_REPLICATES = 2;
// Low-power floors (Key Findings 15 and 17): the earlier +14.6 and +62.5 point wins rested on
// 1-2 evals x 2 runs per arm, and at ~30 tasks the 95% interval on an arm difference is still
// +/-16 to 23 points. A verdict under ANY floor is an `accept` the evolve workflow may propose
// but never auto-apply. The flag informs; it never changes the exit code.
const LOW_POWER_MIN_EVALS = 2;
const LOW_POWER_MIN_RUNS_PER_ARM = 3;
const LOW_POWER_MIN_DISCORDANT = 6;
// A stored benchmark whose headline or per-eval delta differs from the one recomputed from the
// raw grading files by more than this is stale or hand-edited (the stored values are 4-dp rounded).
const RECOMPUTE_TOLERANCE = 0.0001;
const EXIT_ACCEPT = 0;
const EXIT_DATA_QUALITY = 3;
const EXIT_REJECT = 4;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const deltaSign = (x) => (Math.abs(x) <= DELTA_ZERO_EPSILON + 1e-9 ? 0 : x > 0 ? 1 : -1);

/** Default location of the workshop-only prose metrics tool (absent in adopters). */
function defaultProseMetricsPath() {
    return path.resolve(__dirname, '..', '..', 'tools', 'skill-prose-metrics.cjs');
}

/**
 * Measure body growth with tools/skill-prose-metrics.cjs. Returns
 * { beforeWords, afterWords, growth, bound } or null when the tool is absent,
 * a body was not supplied, or the baseline body has no words (growth undefined).
 */
function measureProseGrowth({ proseMetricsPath, baselineBody, candidateBody }) {
    if (typeof baselineBody !== 'string' || typeof candidateBody !== 'string') return null;
    const toolPath = proseMetricsPath || defaultProseMetricsPath();
    if (!fs.existsSync(toolPath)) return null;
    let tool;
    try {
        tool = require(toolPath);
    } catch {
        return null;
    }
    if (!tool || typeof tool.measure !== 'function') return null;
    const beforeWords = tool.measure(baselineBody).words;
    const afterWords = tool.measure(candidateBody).words;
    if (!isNum(beforeWords) || !isNum(afterWords) || beforeWords <= 0) return null;
    return { beforeWords, afterWords, growth: round(afterWords / beforeWords - 1), bound: PROSE_GROWTH_BOUND };
}

/** True when a parsed benchmark carries what the rules read (evals[] and a numeric headline delta). */
function isUsableBenchmark(b) {
    return !!b && typeof b === 'object' && Array.isArray(b.evals) &&
        !!b.summary && !!b.summary.delta && isNum(b.summary.delta.pass_rate);
}

function sumArm(benchmark, baselineConfig, arm, metric) {
    let total = 0;
    for (const ev of benchmark.evals) {
        const agg = ev && ev.results && ev.results[arm === 'with_skill' ? TREATMENT : baselineConfig];
        const s = agg && agg[metric];
        if (s && isNum(s.mean) && isNum(s.n)) total += s.mean * s.n; // mean x n = the sum over runs that carry timing
    }
    return Math.round(total);
}

function dataQualityResult(warnings, minReplicates, extra = {}) {
    return {
        verdict: 'data-quality',
        exitCode: EXIT_DATA_QUALITY,
        reasons: ['data-quality'],
        warnings,
        minReplicates,
        baselineConfig: BASELINE_DIRS[0],
        delta: null,
        holdoutDelta: null,
        fragile: false,
        // Not judged, so there is no power to report (null, not false: `lowPower === true` is the only gate).
        lowPower: null,
        lowPowerReasons: [],
        nEvals: null,
        minRunsPerArm: null,
        discordantAssertions: null,
        totals: { tokens: { with_skill: 0, baseline: 0 }, duration_ms: { with_skill: 0, baseline: 0 } },
        failureTraces: [],
        proseGrowth: null,
        ...extra,
    };
}

/**
 * How much evidence stands behind a judged benchmark: eval count, the thinnest arm's run
 * count across evals, and the number of assertions on which the arms differ at all.
 * `lowPower` is true under ANY floor; `lowPowerReasons` names each one.
 */
function computePower(benchmark, baselineConfig) {
    const evals = benchmark.evals.filter((ev) => ev && typeof ev === 'object');
    let minRunsPerArm = Infinity;
    let discordantAssertions = 0;
    for (const ev of evals) {
        const withRuns = ev.results && ev.results[TREATMENT] && isNum(ev.results[TREATMENT].runs) ? ev.results[TREATMENT].runs : 0;
        const baseRuns = ev.results && ev.results[baselineConfig] && isNum(ev.results[baselineConfig].runs) ? ev.results[baselineConfig].runs : 0;
        minRunsPerArm = Math.min(minRunsPerArm, withRuns, baseRuns);
        for (const a of ev.assertions || []) {
            if (a && isNum(a.with_skill) && isNum(a.baseline) && Math.abs(a.with_skill - a.baseline) > 1e-9) discordantAssertions++;
        }
    }
    if (!Number.isFinite(minRunsPerArm)) minRunsPerArm = 0;
    const nEvals = evals.length;
    const lowPowerReasons = [];
    if (nEvals < LOW_POWER_MIN_EVALS) lowPowerReasons.push(`evals<${LOW_POWER_MIN_EVALS}`);
    if (minRunsPerArm < LOW_POWER_MIN_RUNS_PER_ARM) lowPowerReasons.push(`runs-per-arm<${LOW_POWER_MIN_RUNS_PER_ARM}`);
    if (discordantAssertions < LOW_POWER_MIN_DISCORDANT) lowPowerReasons.push(`discordant-assertions<${LOW_POWER_MIN_DISCORDANT}`);
    return { lowPower: lowPowerReasons.length > 0, lowPowerReasons, nEvals, minRunsPerArm, discordantAssertions };
}

/**
 * Decide accept / reject / data-quality for one aggregated benchmark.
 *
 * Accept needs ALL of: no warnings · every eval has >= minReplicates runs in both
 * arms · no per-eval delta below zero · a headline delta above zero · a holdout
 * delta at or above zero when a holdout benchmark is given · no prose-growth.
 * A failed rule adds its reason; none short-circuits. `fragile` (exactly one
 * discriminating assertion across all evals, and it is high-variance) and the
 * token/duration totals are reported but never change the decision.
 *
 * Fail-closed: a null / malformed benchmark, or any warning, is data-quality (exit 3).
 * Never throws on a bad benchmark and never accepts one.
 *
 * opts: { minReplicates = 2, holdout = null (a benchmark object),
 *         proseMetricsPath, baselineBody, candidateBody }
 */
function computeVerdict(benchmark, opts = {}) {
    const o = opts || {};
    const minReplicates = o.minReplicates === undefined ? DEFAULT_MIN_REPLICATES : o.minReplicates;
    if (!Number.isSafeInteger(minReplicates) || minReplicates < 1) {
        return dataQualityResult([`invalid minReplicates: ${String(minReplicates)} (must be a positive integer)`], DEFAULT_MIN_REPLICATES);
    }
    const holdout = o.holdout === undefined ? null : o.holdout;
    const benchWarnings = benchmark && Array.isArray(benchmark.warnings) ? benchmark.warnings.slice() : [];

    if (!isUsableBenchmark(benchmark)) {
        return dataQualityResult(
            [...benchWarnings, 'benchmark is missing evals[] or summary.delta.pass_rate — it cannot be judged'],
            minReplicates,
        );
    }
    const baselineConfig = (Array.isArray(benchmark.configs) && typeof benchmark.configs[1] === 'string' && benchmark.configs[1]) || BASELINE_DIRS[0];
    const delta = benchmark.summary.delta.pass_rate;
    if (benchmark.evals.length === 0) {
        // No eval means no evidence: a positive headline on an empty evals[] is a hand-edited file, never a win.
        return dataQualityResult([...benchWarnings, 'benchmark has no evals — there is nothing to judge'], minReplicates, { baselineConfig, delta });
    }

    if (holdout !== null && (!isUsableBenchmark(holdout) || holdout.evals.length === 0)) {
        const hw = holdout && Array.isArray(holdout.warnings) ? holdout.warnings : [];
        return dataQualityResult(
            [...benchWarnings, ...hw, 'holdout benchmark is missing evals[] (or has none) or summary.delta.pass_rate — it cannot be judged'],
            minReplicates,
            { baselineConfig, delta },
        );
    }
    const holdoutWarnings = holdout && Array.isArray(holdout.warnings) ? holdout.warnings.slice() : [];
    const warnings = [...benchWarnings, ...holdoutWarnings];
    const holdoutDelta = holdout ? holdout.summary.delta.pass_rate : null;

    // Per-eval view: replicate counts, delta sign, and a structural check of each eval.
    let replicatesOk = true;
    let noNegativeEval = true;
    let malformedEval = false;
    for (const ev of benchmark.evals) {
        if (!ev || typeof ev !== 'object') { malformedEval = true; continue; }
        const withRuns = ev.results && ev.results[TREATMENT] ? ev.results[TREATMENT].runs : 0;
        const baseRuns = ev.results && ev.results[baselineConfig] ? ev.results[baselineConfig].runs : 0;
        if (!(withRuns >= minReplicates) || !(baseRuns >= minReplicates)) replicatesOk = false;
        const d = ev.delta && ev.delta.pass_rate;
        if (isNum(d)) {
            if (deltaSign(d) < 0) noNegativeEval = false;
        } else if (withRuns > 0 && baseRuns > 0) {
            malformedEval = true; // both arms ran yet no delta was computed: not a benchmark this harness wrote
        }
    }
    if (malformedEval) warnings.push('an eval entry is malformed (not an object, or has runs in both arms but no delta) — it cannot be judged');

    const totals = {
        tokens: { with_skill: sumArm(benchmark, baselineConfig, 'with_skill', 'tokens'), baseline: sumArm(benchmark, baselineConfig, 'baseline', 'tokens') },
        duration_ms: { with_skill: sumArm(benchmark, baselineConfig, 'with_skill', 'duration_ms'), baseline: sumArm(benchmark, baselineConfig, 'baseline', 'duration_ms') },
    };
    const discriminating = [];
    for (const ev of benchmark.evals) {
        for (const a of (ev && ev.assertions) || []) if (a && a.discriminating === true) discriminating.push(a);
    }
    const fragile = discriminating.length === 1 && discriminating[0].high_variance === true;

    if (warnings.length > 0 || malformedEval) {
        return dataQualityResult(warnings, minReplicates, { baselineConfig, delta, holdoutDelta, totals, fragile });
    }

    const proseGrowth = measureProseGrowth(o);
    const reasons = [];
    if (!replicatesOk) reasons.push('insufficient-replicates');
    if (!noNegativeEval) reasons.push('negative-eval-delta');
    if (deltaSign(delta) <= 0) reasons.push('no-improvement');
    if (holdout && deltaSign(holdoutDelta) < 0) reasons.push('holdout-regression');
    if (proseGrowth && proseGrowth.growth > PROSE_GROWTH_BOUND && delta <= proseGrowth.growth) reasons.push('prose-growth');

    const accept = reasons.length === 0;
    return {
        verdict: accept ? 'accept' : 'reject',
        exitCode: accept ? EXIT_ACCEPT : EXIT_REJECT,
        reasons,
        warnings,
        minReplicates,
        baselineConfig,
        delta,
        holdoutDelta,
        fragile,
        ...computePower(benchmark, baselineConfig),
        totals,
        // Lazy require: skill-evolution requires this module (parseArgs) from its own main.
        failureTraces: accept ? [] : require('./skill-evolution').extractFailureTraces(benchmark),
        proseGrowth,
    };
}

/** Read `<dir>/benchmark.json`; throws an Error naming the problem when it cannot be read. */
function readBenchmarkFile(dir, label) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new Error(`${label} dir not found: ${dir}`);
    }
    const file = path.join(dir, 'benchmark.json');
    if (!fs.existsSync(file)) throw new Error(`${label} benchmark.json not found: ${file} (run \`aggregate\` first)`);
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        throw new Error(`${label} benchmark.json is unparseable: ${file} (${err.message})`);
    }
}

function readBodyIfPresent(file) {
    try {
        return fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null;
    } catch {
        return null;
    }
}

/**
 * Compare a stored benchmark.json with the benchmark recomputed from the raw grading files.
 * Returns the human-readable disagreements (empty when they agree): the headline delta, the
 * eval count, each eval's delta and per-arm run counts, and the warning list. The stored file
 * is a cache of `aggregate`; the raw gradings are the evidence.
 */
function benchmarkDisagreements(stored, fresh, label) {
    const out = [];
    const near = (a, b) => isNum(a) && isNum(b) && Math.abs(a - b) <= RECOMPUTE_TOLERANCE + 1e-9;
    const sd = stored.summary.delta.pass_rate;
    const fd = fresh.summary.delta.pass_rate;
    if (!near(sd, fd)) out.push(`${label} headline delta is ${sd} but the raw gradings give ${fd}`);
    if (stored.evals.length !== fresh.evals.length) {
        out.push(`${label} lists ${stored.evals.length} eval(s) but the raw gradings hold ${fresh.evals.length}`);
    } else {
        const baseline = (b) => (Array.isArray(b.configs) && typeof b.configs[1] === 'string' && b.configs[1]) || BASELINE_DIRS[0];
        const sb = baseline(stored);
        const fb = baseline(fresh);
        if (sb !== fb) out.push(`${label} baseline is ${sb} but the raw gradings use ${fb}`);
        const runsOf = (ev, cfg) => (ev && ev.results && ev.results[cfg] ? ev.results[cfg].runs : 0);
        fresh.evals.forEach((fev, i) => {
            const sev = stored.evals[i];
            const name = (fev && fev.eval_name) || `#${i + 1}`;
            const sdel = sev && sev.delta ? sev.delta.pass_rate : null;
            const fdel = fev && fev.delta ? fev.delta.pass_rate : null;
            if (!near(sdel, fdel) && !(sdel === null && fdel === null)) out.push(`${label} eval ${name} delta is ${sdel} but the raw gradings give ${fdel}`);
            if (runsOf(sev, TREATMENT) !== runsOf(fev, TREATMENT) || runsOf(sev, sb) !== runsOf(fev, fb)) {
                out.push(`${label} eval ${name} run counts differ from the raw gradings`);
            }
        });
    }
    const sw = Array.isArray(stored.warnings) ? stored.warnings : [];
    const fw = Array.isArray(fresh.warnings) ? fresh.warnings : [];
    if (JSON.stringify(sw) !== JSON.stringify(fw)) out.push(`${label} warning list differs from a fresh aggregation`);
    return out;
}

/**
 * Load `<dir>/benchmark.json` and re-derive the benchmark from the raw gradings
 * (`aggregateIteration`, pure). Returns { benchmark, mismatch } where `benchmark` is what
 * the verdict decides on: the recomputed object when the stored file is usable and agrees,
 * otherwise the stored object (an unusable file is data-quality in computeVerdict anyway).
 * `mismatch` lists the disagreements; non-empty means the stored file is stale or edited.
 */
function loadJudgedBenchmark(dir, label) {
    const stored = readBenchmarkFile(dir, label);
    if (!isUsableBenchmark(stored)) return { benchmark: stored, mismatch: [] };
    const fresh = aggregateIteration(dir, { skillName: stored.skill_name, date: stored.generated, iteration: stored.iteration });
    return { benchmark: fresh, mismatch: benchmarkDisagreements(stored, fresh, label) };
}

/**
 * Verdict for an iteration directory (never writes). The stored `benchmark.json` must exist
 * (exit 1 otherwise) but is NOT trusted: the decision is made on the benchmark recomputed
 * from the raw grading files, and any disagreement between the two is data-quality (exit 3)
 * so a grading edited after `aggregate` can never ride a stale headline into an accept.
 * When the eval workspace layout is present - `<workspace>/skill-snapshot/SKILL.md` and
 * `<workspace>/candidate/SKILL.md` beside `<workspace>/iteration-N` - the two bodies
 * feed the prose-growth measure. Throws (-> CLI exit 1) when a benchmark.json cannot be read.
 *
 * opts: { minReplicates, holdoutDir, proseMetricsPath }
 */
function verdictIteration(iterationDir, opts = {}) {
    const o = opts || {};
    const main = loadJudgedBenchmark(iterationDir, 'iteration');
    const hold = o.holdoutDir ? loadJudgedBenchmark(o.holdoutDir, 'holdout') : null;
    const workspace = path.dirname(path.resolve(iterationDir));
    const baselineBody = readBodyIfPresent(path.join(workspace, 'skill-snapshot', 'SKILL.md'));
    // `candidate/` is the documented name; earlier workspaces on disk used `skill-candidate/`.
    const candidateBody =
        readBodyIfPresent(path.join(workspace, 'candidate', 'SKILL.md')) ??
        readBodyIfPresent(path.join(workspace, 'skill-candidate', 'SKILL.md'));
    const verdictOpts = { holdout: hold ? hold.benchmark : null, baselineBody, candidateBody };
    if (o.minReplicates !== undefined) verdictOpts.minReplicates = o.minReplicates;
    if (o.proseMetricsPath) verdictOpts.proseMetricsPath = o.proseMetricsPath;
    const mismatch = [...main.mismatch, ...(hold ? hold.mismatch : [])];
    if (mismatch.length > 0) {
        const minReplicates = o.minReplicates === undefined ? DEFAULT_MIN_REPLICATES : o.minReplicates;
        const b = main.benchmark;
        return dataQualityResult(
            mismatch.map((d) => `stale or edited benchmark.json: ${d} (re-run \`aggregate\`, then \`verdict\`)`),
            minReplicates,
            { delta: isUsableBenchmark(b) ? b.summary.delta.pass_rate : null },
        );
    }
    return computeVerdict(main.benchmark, verdictOpts);
}

/** `--key value` and `--key=value`; a flag with no value is `true`; everything else is positional. */
function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            if (eq !== -1) {
                out[a.slice(2, eq)] = a.slice(eq + 1);
                continue;
            }
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) {
                out[key] = next;
                i++;
            } else out[key] = true;
        } else out._.push(a);
    }
    return out;
}

const VERDICT_FLAGS = ['holdout', 'min-replicates'];

const USAGE = [
    'Usage: node .claude/core/skill-eval.js aggregate <iterationDir> --skill-name <name> [--date YYYY-MM-DD]',
    '       node .claude/core/skill-eval.js verdict <iterationDir> [--holdout <dir>] [--min-replicates 2]',
].join('\n');

/**
 * `verdict` CLI: exit 0 accept · 4 reject · 3 data-quality · 1 could not run
 * (iteration or holdout dir / benchmark.json missing or unparseable) · 2 bad usage.
 * stdout is exactly one JSON object for exit 0, 3 and 4; human text goes to stderr.
 */
function verdictMain(args) {
    const usageError = (msg) => {
        console.error(`[SKILL-EVAL] ${msg}`);
        console.error(USAGE);
        process.exit(2);
    };
    // An accept judge must not report a stronger guarantee than it checked: a misspelled
    // `--holdout-dir` or an extra positional would silently switch a rule off, so refuse both.
    const unknown = Object.keys(args).filter((k) => k !== '_' && !VERDICT_FLAGS.includes(k));
    if (unknown.length > 0) usageError(`unknown verdict flag(s): ${unknown.map((k) => `--${k}`).join(', ')}`);
    if (args._.length > 2) usageError(`unexpected extra argument(s): ${args._.slice(2).join(' ')}`);
    const iterationDir = args._[1];
    if (!iterationDir) usageError('verdict needs an <iterationDir>');
    let minReplicates = DEFAULT_MIN_REPLICATES;
    if (args['min-replicates'] !== undefined) {
        const v = args['min-replicates'];
        if (typeof v !== 'string' || !/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v))) {
            usageError(`--min-replicates must be a positive integer (got ${v === true ? 'no value' : JSON.stringify(v)})`);
        }
        minReplicates = Number(v);
    }
    let holdoutDir;
    if (args.holdout !== undefined) {
        if (typeof args.holdout !== 'string' || args.holdout === '') usageError('--holdout needs a directory value');
        holdoutDir = args.holdout;
    }
    let result;
    try {
        result = verdictIteration(iterationDir, { minReplicates, holdoutDir });
    } catch (err) {
        console.error(`[SKILL-EVAL] ${err.message}`);
        process.exit(1);
    }
    for (const w of result.warnings) console.error(`[SKILL-EVAL] WARN: ${w}`);
    if (result.lowPower === true) {
        console.error(`[SKILL-EVAL] LOW POWER (${result.lowPowerReasons.join(', ')}): ${result.nEvals} eval(s), ${result.minRunsPerArm} run(s) per arm, ${result.discordantAssertions} discordant assertion(s) - propose, never auto-apply.`);
    }
    const why = result.reasons.length ? ` (${result.reasons.join(', ')})` : '';
    console.error(`[SKILL-EVAL] verdict ${result.verdict}${why}: delta ${signedPct(result.delta)}, exit ${result.exitCode}`);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.exitCode);
}

function main(argv) {
    const args = parseArgs(argv);
    const cmd = args._[0];
    if (cmd === 'verdict') return verdictMain(args);
    if (cmd !== 'aggregate') {
        console.error(USAGE);
        process.exit(2);
    }
    const iterationDir = args._[1];
    if (!iterationDir || !fs.existsSync(iterationDir)) {
        console.error(`[SKILL-EVAL] iteration dir not found: ${iterationDir}`);
        process.exit(1);
    }
    const benchmark = aggregateIteration(iterationDir, {
        skillName: args['skill-name'] || 'unknown',
        date: args.date || null,
    });
    const jsonPath = path.join(iterationDir, 'benchmark.json');
    const mdPath = path.join(iterationDir, 'benchmark.md');
    fs.writeFileSync(jsonPath, JSON.stringify(benchmark, null, 2));
    fs.writeFileSync(mdPath, renderBenchmarkMd(benchmark));
    const warns = benchmark.warnings || [];
    for (const w of warns) console.error(`[SKILL-EVAL] WARN: ${w}`);
    const d = benchmark.summary.delta.pass_rate;
    console.log(`[SKILL-EVAL] ${benchmark.skill_name} ${benchmark.iteration}: pass-rate Δ ${signedPct(d)} → ${jsonPath}`);
    if (warns.length) {
        // Exit 3 (distinct from 1 = "couldn't run" / 2 = "bad usage"): the run
        // produced a benchmark, but on incomplete data — the delta may be wrong.
        // A non-zero exit makes the caller (and /review:evolve-skills) stop and look.
        console.error(`[SKILL-EVAL] completed with ${warns.length} data-quality warning(s) — inspect benchmark.md before trusting the delta (exit 3).`);
        process.exit(3);
    }
    process.exit(0);
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = {
    TREATMENT,
    BASELINE_DIRS,
    DISCRIMINATING_DELTA,
    HIGH_VARIANCE_STD,
    mean,
    stddev,
    summarizeMetric,
    round,
    passRateOfRun,
    pctChange,
    aggregateConfigRuns,
    computeDelta,
    aggregateEval,
    aggregateBenchmark,
    summarizeAcrossEvals,
    renderBenchmarkMd,
    loadRun,
    loadConfigRuns,
    loadIteration,
    aggregateIteration,
    PROSE_GROWTH_BOUND,
    LOW_POWER_MIN_EVALS,
    LOW_POWER_MIN_RUNS_PER_ARM,
    LOW_POWER_MIN_DISCORDANT,
    DELTA_ZERO_EPSILON,
    deltaSign,
    computePower,
    computeVerdict,
    verdictIteration,
    parseArgs,
    main,
};
