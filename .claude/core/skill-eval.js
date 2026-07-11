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
 *
 * Exit codes: 0 = clean · 1 = could not run (dir missing) · 2 = bad usage ·
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

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
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

function main(argv) {
    const args = parseArgs(argv);
    const cmd = args._[0];
    if (cmd !== 'aggregate') {
        console.error('Usage: node .claude/core/skill-eval.js aggregate <iterationDir> --skill-name <name> [--date YYYY-MM-DD]');
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
    parseArgs,
    main,
};
