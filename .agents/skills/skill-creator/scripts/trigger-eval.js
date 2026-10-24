/**
 * trigger-eval.js — Score description trigger-eval results.
 *
 * Usage:
 *   node .claude/skills/skill-creator/scripts/trigger-eval.js score <results.json>
 *
 * Input results.json shape:
 * {
 *   "eval_set": [ { "query": "...", "should_trigger": true } ],
 *   "runs": [
 *     { "query": "...", "triggered": [true, true, false] }
 *   ]
 * }
 * `triggered` is the per-run boolean of whether the skill triggered.
 *
 * Output (JSON to stdout):
 * {
 *   "overall_accuracy": 0.87,
 *   "true_positive_rate": 0.90,
 *   "true_negative_rate": 0.83,
 *   "per_query": [
 *     { "query": "...", "should_trigger": true, "trigger_rate": 0.9 }
 *   ]
 * }
 *
 * This is deterministic scoring only. The LLM proposes new descriptions; this
 * script just measures whether they cause the skill to trigger correctly.
 *
 * Export: scoreTriggerEval(evalSet, runs) for unit-testing.
 */

'use strict';

const fs = require('fs');
const { parseArgs, readJsonSafe } = require('./utils.js');

/**
 * Score a trigger-eval run.
 *
 * @param {Array<{query: string, should_trigger: boolean}>} evalSet
 *   Ground truth — one entry per query.
 * @param {Array<{query: string, triggered: boolean[]}>} runs
 *   Observed results — one entry per query, with a boolean per run.
 * @returns {{
 *   overall_accuracy: number,
 *   true_positive_rate: number,
 *   true_negative_rate: number,
 *   per_query: Array<{query: string, should_trigger: boolean, trigger_rate: number}>
 * }}
 */
function scoreTriggerEval(evalSet, runs) {
    if (!Array.isArray(evalSet) || evalSet.length === 0) {
        return {
            overall_accuracy: 0,
            true_positive_rate: 0,
            true_negative_rate: 0,
            per_query: [],
        };
    }

    // Build a lookup from query → should_trigger ground truth.
    const gtMap = new Map();
    for (const item of evalSet) {
        gtMap.set(item.query, item.should_trigger);
    }

    // Build a lookup from query → mean trigger rate across runs.
    const runMap = new Map();
    for (const run of runs || []) {
        const triggered = Array.isArray(run.triggered) ? run.triggered : [];
        const rate = triggered.length === 0
            ? 0
            : triggered.filter(Boolean).length / triggered.length;
        runMap.set(run.query, rate);
    }

    // Per-query results (follow evalSet order for stability).
    const perQuery = evalSet.map((item) => ({
        query: item.query,
        should_trigger: item.should_trigger,
        trigger_rate: runMap.has(item.query) ? round4(runMap.get(item.query)) : 0,
    }));

    // Aggregate: treat a query as "triggered" if trigger_rate >= 0.5 (majority vote).
    let correct = 0;
    let tpCount = 0;
    let tpTotal = 0;
    let tnCount = 0;
    let tnTotal = 0;

    for (const q of perQuery) {
        const predicted = q.trigger_rate >= 0.5;
        if (predicted === q.should_trigger) correct++;

        if (q.should_trigger) {
            tpTotal++;
            if (predicted) tpCount++;
        } else {
            tnTotal++;
            if (!predicted) tnCount++;
        }
    }

    const overall_accuracy = round4(correct / perQuery.length);
    const true_positive_rate = tpTotal > 0 ? round4(tpCount / tpTotal) : 0;
    const true_negative_rate = tnTotal > 0 ? round4(tnCount / tnTotal) : 0;

    return {
        overall_accuracy,
        true_positive_rate,
        true_negative_rate,
        per_query: perQuery,
    };
}

function round4(x) {
    return Math.round(x * 10000) / 10000;
}

function main(argv) {
    const args = parseArgs(argv);
    const cmd = args._[0];
    const resultsFile = args._[1];

    if (cmd !== 'score' || !resultsFile) {
        console.error('Usage: node trigger-eval.js score <results.json>');
        process.exit(2);
    }

    if (!fs.existsSync(resultsFile)) {
        console.error(`[TRIGGER-EVAL] results file not found: ${resultsFile}`);
        process.exit(1);
    }

    const data = readJsonSafe(resultsFile);
    if (!data) {
        console.error(`[TRIGGER-EVAL] failed to parse JSON: ${resultsFile}`);
        process.exit(1);
    }

    const scores = scoreTriggerEval(data.eval_set || [], data.runs || []);
    console.log(JSON.stringify(scores, null, 2));
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

module.exports = { scoreTriggerEval, main };
