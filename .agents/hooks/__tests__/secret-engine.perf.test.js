// Latency of the real hooks (spawned as processes, the way Claude Code runs them) with the secret
// engine in place. Opt in with SECRET_ENGINE_PERF=1; it reports numbers and never fails the build.
//
//   SECRET_ENGINE_PERF=1 SECRET_ENGINE_PERF_RUNS=60 npx vitest run .agents/hooks/__tests__/secret-engine.perf.test.js
//
// Baseline: the retired regex hooks, measured on the same WSL2 Linux x64 machine (Node 24, 100 runs
// per case, 2026-11-07), p50 / p95 in ms for a clean 49 KB input:
//   Write hook  26.6 / 31      output scrubber  29.9 / 34
// Acceptance budgets (Linux): the clean 49 KB Write hook adds at most 60 ms at p95; the scrubber
// on clean Bash output adds at most 50 ms at p95. Windows and macOS are measured by hand.

import { describe, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const enabled = process.env.SECRET_ENGINE_PERF === '1';
const RUNS = Number(process.env.SECRET_ENGINE_PERF_RUNS) || 30;
const BASELINE_P95 = { write49: 31, scrub49: 34 };
const BUDGET = { write49: 60, scrub49: 50 };

const j = (...p) => p.join('');
const STRIPE = j('sk_', 'live_', 'aB3xK9mP2qR7tY1wZ5nC8vD4');
const GITHUB = j('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');

function codeLike(bytes) {
    const lines = [];
    let size = 0;
    for (let i = 0; size < bytes; i++) {
        const line = `export function handler${i}(request, context) { const value${i} = compute(${i}, "label-${i}"); return { id: ${i}, name: "item ${i}", ok: true }; }\n`;
        lines.push(line);
        size += line.length;
    }
    return lines.join('');
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

function time(hook, payload, project) {
    const file = path.join(__dirname, '..', hook);
    const input = JSON.stringify(payload);
    const samples = [];
    for (let i = 0; i < RUNS + 3; i++) {
        const t = process.hrtime.bigint();
        spawnSync(process.execPath, [file], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: project } });
        const ms = Number(process.hrtime.bigint() - t) / 1e6;
        if (i >= 3) samples.push(ms);
    }
    return { p50: pct(samples, 0.5), p95: pct(samples, 0.95) };
}

describe.skipIf(!enabled)('secret engine latency (SECRET_ENGINE_PERF=1)', () => {
    it('reports p50/p95 for the Write hook and the output scrubber', () => {
        const project = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-engine-perf-'));
        const rows = [];
        try {
            for (const bytes of [2048, 49152]) {
                const label = bytes === 2048 ? '2KB' : '49KB';
                const clean = codeLike(bytes);
                const dirty = `${clean}const a = "${STRIPE}";\nconst b = "${GITHUB}";\n`;
                const write = content => ({ tool_name: 'Write', tool_input: { file_path: 'src/big.js', content } });
                const bash = stdout => ({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout } });
                rows.push(['write hook, clean ' + label, time('secret-scanner.cjs', write(clean), project)]);
                rows.push(['write hook, 2 findings ' + label, time('secret-scanner.cjs', write(dirty), project)]);
                rows.push(['scrubber, clean ' + label, time('post-read-scrubber.cjs', bash(clean), project)]);
                rows.push(['scrubber, 2 findings ' + label, time('post-read-scrubber.cjs', bash(dirty), project)]);
            }
        } finally {
            fs.rmSync(project, { recursive: true, force: true });
        }
        const lines = rows.map(([name, r]) => `  ${name.padEnd(28)} p50 ${r.p50.toFixed(1).padStart(6)} ms   p95 ${r.p95.toFixed(1).padStart(6)} ms`);
        const w = rows.find(([n]) => n === 'write hook, clean 49KB')[1];
        const s = rows.find(([n]) => n === 'scrubber, clean 49KB')[1];
        const verdict = (name, r, base, budget) => {
            const added = r.p95 - base;
            return `  ${name}: adds ${added.toFixed(1)} ms at p95 over the ${base} ms baseline (budget ${budget} ms) -> ${added <= budget ? 'within budget' : 'OVER BUDGET'}`;
        };
        console.log([`\nsecret engine latency, ${RUNS} runs per case on ${os.platform()}/${os.arch()}:`, ...lines, verdict('write hook 49KB clean', w, BASELINE_P95.write49, BUDGET.write49), verdict('scrubber 49KB clean', s, BASELINE_P95.scrub49, BUDGET.scrub49), ''].join('\n'));
    }, 600000);
});
