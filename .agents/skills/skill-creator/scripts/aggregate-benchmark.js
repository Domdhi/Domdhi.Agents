/**
 * aggregate-benchmark.js — Thin CLI wrapper over skill-eval's aggregation.
 *
 * Usage:
 *   node .claude/skills/skill-creator/scripts/aggregate-benchmark.js \
 *     <iterationDir> --skill-name <name> [--date YYYY-MM-DD]
 *
 * Writes benchmark.json + benchmark.md into iterationDir, then prints a
 * one-line summary that includes the pass-rate delta.
 *
 * Delegates ALL math to .claude/core/skill-eval.js — no re-implementation.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const {
    aggregateIteration,
    renderBenchmarkMd,
    round,
} = require('../../../core/skill-eval.js');
const { parseArgs, writeJson } = require('./utils.js');

/**
 * Aggregate an iteration directory and write benchmark.json + benchmark.md.
 * Exported so other scripts can call this programmatically.
 *
 * @param {string} iterationDir  path to the iteration directory
 * @param {{ skillName?: string, date?: string }} opts
 * @returns {{ benchmark: object, jsonPath: string, mdPath: string, deltaPassRate: number }}
 */
function run(iterationDir, opts = {}) {
    if (!fs.existsSync(iterationDir)) {
        throw new Error(`iteration dir not found: ${iterationDir}`);
    }

    const benchmark = aggregateIteration(iterationDir, {
        skillName: opts.skillName || 'unknown',
        date: opts.date || null,
    });

    const jsonPath = path.join(iterationDir, 'benchmark.json');
    const mdPath = path.join(iterationDir, 'benchmark.md');

    writeJson(jsonPath, benchmark);
    fs.writeFileSync(mdPath, renderBenchmarkMd(benchmark), 'utf8');

    const deltaPassRate = benchmark.summary.delta.pass_rate;
    return { benchmark, jsonPath, mdPath, deltaPassRate };
}

function main(argv) {
    const args = parseArgs(argv);
    const iterationDir = args._[0];
    if (!iterationDir) {
        console.error(
            'Usage: node aggregate-benchmark.js <iterationDir> --skill-name <name> [--date YYYY-MM-DD]',
        );
        process.exit(2);
    }

    const skillName = args['skill-name'] || 'unknown';
    const date = args.date || null;

    let result;
    try {
        result = run(iterationDir, { skillName, date });
    } catch (err) {
        console.error(`[AGGREGATE-BENCHMARK] ${err.message}`);
        process.exit(1);
    }

    const { benchmark, jsonPath, deltaPassRate } = result;
    const warns = benchmark.warnings || [];
    for (const w of warns) console.error(`[AGGREGATE-BENCHMARK] WARN: ${w}`);
    const sign = deltaPassRate >= 0 ? '+' : '';
    const deltaPts = `${sign}${round(deltaPassRate * 100, 1)} pts`;
    console.log(
        `[AGGREGATE-BENCHMARK] ${benchmark.skill_name} ${benchmark.iteration}: pass-rate Δ ${deltaPts} → ${jsonPath}`,
    );
    if (warns.length) {
        // Match skill-eval.js: exit 3 when the delta rests on incomplete data.
        console.error(`[AGGREGATE-BENCHMARK] completed with ${warns.length} data-quality warning(s) — inspect benchmark.md before trusting the delta (exit 3).`);
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

module.exports = { run, main };
