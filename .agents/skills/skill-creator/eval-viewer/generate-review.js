/**
 * generate-review.js — Generate a standalone static HTML review of one eval iteration.
 *
 * Usage:
 *   node .claude/skills/skill-creator/eval-viewer/generate-review.js \
 *     <iterationDir> --skill-name <name> \
 *     [--benchmark <benchmark.json>] \
 *     [--previous <prevIterationDir>] \
 *     --static <out.html>
 *
 * Because this repo runs headless (WSL, no display), defaults to writing a
 * STANDALONE static HTML file. No server is started.
 *
 * The HTML uses only inline CSS/JS (no CDN, no external assets).
 *
 * Sections:
 *   Benchmark — summary table (with_skill vs baseline) + per-eval rows,
 *               highlighting non-discriminating assertions and high-variance ones.
 *   Outputs   — one block per eval: prompt, grading results per expectation,
 *               file lists (with_skill vs baseline), optional previous-iteration
 *               output list (collapsed).
 *   Feedback  — <textarea> per eval + "Download feedback.json" button.
 *
 * Exports: renderReviewHtml({ benchmark, evals, previous }) for unit use.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// skill-eval is used for loadIteration (to read eval records) and type alignment.
const { loadIteration } = require('../../../core/skill-eval.js');
const { parseArgs, readJsonSafe, ensureDir } = require('../scripts/utils.js');

// ── HTML helpers ──────────────────────────────────────────────────────────────

function esc(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function pct(x) {
    if (x === null || x === undefined) return '—';
    return `${Math.round(x * 1000) / 10}%`;
}

function signedPts(x) {
    if (x === null || x === undefined) return '—';
    const v = Math.round(x * 1000) / 10;
    return `${v >= 0 ? '+' : ''}${v} pts`;
}

function fmtNum(x) {
    if (typeof x !== 'number' || Number.isNaN(x)) return '—';
    return Math.round(x).toLocaleString('en-US');
}

// ── Disk loaders ──────────────────────────────────────────────────────────────

/**
 * Read structured eval data for rendering from an iteration directory.
 * Returns an array of eval objects with prompt, grading, and file lists.
 * @param {string} iterationDir
 * @returns {Array<object>}
 */
function loadEvalsForReview(iterationDir) {
    const evals = [];
    if (!fs.existsSync(iterationDir)) return evals;

    const evalDirs = fs
        .readdirSync(iterationDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^eval-/.test(d.name))
        .map((d) => d.name)
        .sort();

    for (const evalName of evalDirs) {
        const evalDir = path.join(iterationDir, evalName);
        const meta = readJsonSafe(path.join(evalDir, 'eval_metadata.json')) || {};
        const evalId = meta.eval_id || evalName.replace(/^eval-/, '');

        // Grading: try with_skill/grading.json (single run) or run-N/grading.json (multi-run).
        const withSkillDir = path.join(evalDir, 'with_skill');
        const withGrading = readGradingFromConfigDir(withSkillDir);

        // Baseline: without_skill or old_skill.
        let baselineDir = null;
        let baselineConfig = null;
        for (const bd of ['without_skill', 'old_skill']) {
            const candidate = path.join(evalDir, bd);
            if (fs.existsSync(candidate)) {
                baselineDir = candidate;
                baselineConfig = bd;
                break;
            }
        }
        const baselineGrading = baselineDir ? readGradingFromConfigDir(baselineDir) : null;

        // Output file lists.
        const withOutputs = listOutputFiles(path.join(withSkillDir, 'outputs'));
        const baselineOutputs = baselineDir
            ? listOutputFiles(path.join(baselineDir, 'outputs'))
            : [];

        evals.push({
            evalName,
            evalId,
            prompt: meta.prompt || '',
            evalDisplayName: meta.eval_name || evalName,
            withGrading,
            baselineGrading,
            baselineConfig,
            withOutputFiles: withOutputs,
            baselineOutputFiles: baselineOutputs,
        });
    }
    return evals;
}

/**
 * Read all grading.json files from a config dir (single-run or multi-run).
 * Returns array of { run, expectations } or null if nothing found.
 */
function readGradingFromConfigDir(configDir) {
    if (!fs.existsSync(configDir)) return null;

    // Single-run case.
    const single = readJsonSafe(path.join(configDir, 'grading.json'));
    if (single) return [{ run: 'run-1', expectations: single.expectations || [] }];

    // Multi-run case.
    const runs = [];
    const runDirs = fs
        .readdirSync(configDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^run-/.test(d.name))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const rd of runDirs) {
        const g = readJsonSafe(path.join(configDir, rd.name, 'grading.json'));
        if (g) runs.push({ run: rd.name, expectations: g.expectations || [] });
    }
    return runs.length ? runs : null;
}

/**
 * List output files in a directory (one level, sorted).
 */
function listOutputFiles(outputsDir) {
    if (!fs.existsSync(outputsDir)) return [];
    return fs
        .readdirSync(outputsDir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort();
}

/**
 * Load eval data from a previous iteration for comparison.
 * Returns a map from evalName → { outputFiles }.
 */
function loadPreviousEvals(prevIterDir) {
    const map = new Map();
    if (!prevIterDir || !fs.existsSync(prevIterDir)) return map;
    const evalDirs = fs
        .readdirSync(prevIterDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^eval-/.test(d.name))
        .map((d) => d.name)
        .sort();
    for (const evalName of evalDirs) {
        const withDir = path.join(prevIterDir, evalName, 'with_skill', 'outputs');
        map.set(evalName, { outputFiles: listOutputFiles(withDir) });
    }
    return map;
}

// ── HTML rendering ────────────────────────────────────────────────────────────

/**
 * Render the full standalone HTML.
 *
 * @param {object} opts
 * @param {object|null} opts.benchmark   parsed benchmark.json content
 * @param {Array<object>} opts.evals     from loadEvalsForReview()
 * @param {Map<string,object>} opts.previous  from loadPreviousEvals()
 * @param {string} opts.skillName
 * @returns {string}  complete HTML document
 */
function renderReviewHtml({ benchmark, evals, previous, skillName }) {
    const title = `Skill Eval Review — ${esc(skillName)}`;
    const prev = previous || new Map();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; font-size: 14px; color: #1a1a1a; background: #f5f5f5; padding: 24px; }
  h1 { font-size: 1.5rem; margin-bottom: 8px; }
  h2 { font-size: 1.15rem; margin: 32px 0 10px; border-bottom: 2px solid #ddd; padding-bottom: 4px; }
  h3 { font-size: 1rem; margin: 20px 0 8px; color: #333; }
  .meta { color: #666; font-size: 0.85rem; margin-bottom: 24px; }
  section { background: #fff; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { background: #f0f0f0; text-align: left; padding: 6px 10px; font-weight: 600; }
  td { padding: 6px 10px; border-top: 1px solid #eee; vertical-align: top; }
  tr:hover td { background: #fafafa; }
  .delta-pos { color: #1a7f3f; font-weight: 600; }
  .delta-neg { color: #c0392b; font-weight: 600; }
  .delta-zero { color: #666; }
  .badge { display: inline-block; border-radius: 4px; padding: 1px 6px; font-size: 0.75rem; font-weight: 600; }
  .badge-pass { background: #d4edda; color: #155724; }
  .badge-fail { background: #f8d7da; color: #721c24; }
  .badge-nd { background: #fff3cd; color: #856404; }
  .badge-hv { background: #cce5ff; color: #004085; }
  .eval-block { border: 1px solid #e0e0e0; border-radius: 6px; margin-bottom: 16px; }
  .eval-header { background: #f8f8f8; border-radius: 6px 6px 0 0; padding: 10px 14px; font-weight: 600; cursor: pointer; user-select: none; }
  .eval-header:hover { background: #efefef; }
  .eval-body { padding: 14px; }
  .prompt-box { background: #f9f9f9; border-left: 3px solid #999; padding: 8px 12px; font-style: italic; color: #444; margin-bottom: 12px; white-space: pre-wrap; font-size: 0.85rem; }
  .file-list { font-size: 0.8rem; color: #555; }
  .file-list li { list-style: none; padding: 1px 0; }
  details summary { cursor: pointer; color: #555; font-size: 0.85rem; margin-bottom: 4px; }
  textarea { width: 100%; min-height: 80px; font-family: inherit; font-size: 0.85rem; border: 1px solid #ccc; border-radius: 4px; padding: 8px; resize: vertical; margin-top: 6px; }
  .dl-btn { margin-top: 20px; display: inline-block; background: #0070f3; color: #fff; border: none; border-radius: 5px; padding: 8px 18px; font-size: 0.9rem; cursor: pointer; }
  .dl-btn:hover { background: #005cc5; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .col-label { font-size: 0.75rem; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px; }
  @media (max-width: 640px) { .two-col { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<h1>${title}</h1>
<p class="meta">Generated: ${new Date().toISOString()}</p>

${renderBenchmarkSection(benchmark, evals)}

${renderOutputsSection(evals, prev)}

${renderFeedbackSection(evals)}

<script>
// ── Feedback download ───────────────────────────────────────────────────────
document.getElementById('download-feedback').addEventListener('click', function() {
  const reviews = [];
  document.querySelectorAll('[data-eval-id]').forEach(function(el) {
    const evalId = el.dataset.evalId;
    const feedback = el.querySelector('textarea').value.trim();
    if (feedback) {
      reviews.push({
        run_id: 'eval-' + evalId + '-with_skill',
        feedback: feedback,
        timestamp: new Date().toISOString()
      });
    }
  });
  const blob = new Blob([JSON.stringify({ reviews: reviews, status: 'complete' }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'feedback.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(a.href); }, 60000);
});

// ── Toggle eval blocks ──────────────────────────────────────────────────────
document.querySelectorAll('.eval-header').forEach(function(header) {
  header.addEventListener('click', function() {
    const body = header.nextElementSibling;
    if (body && body.classList.contains('eval-body')) {
      body.style.display = body.style.display === 'none' ? '' : 'none';
      header.setAttribute('aria-expanded', body.style.display !== 'none');
    }
  });
});
</script>
</body>
</html>`;
}

function renderBenchmarkSection(benchmark, evals) {
    if (!benchmark) {
        return `<section><h2>Benchmark</h2><p>No benchmark.json found — run aggregate-benchmark.js first.</p></section>`;
    }

    const base = benchmark.configs && benchmark.configs[1] ? benchmark.configs[1] : 'baseline';
    const s = benchmark.summary || {};
    const withS = s['with_skill'] || {};
    const baseS = s[base] || {};
    const delta = s.delta || {};

    function deltaClass(v) {
        if (v === null || v === undefined) return 'delta-zero';
        return v > 0 ? 'delta-pos' : v < 0 ? 'delta-neg' : 'delta-zero';
    }

    let summaryTable = `
<table>
  <thead><tr><th>Metric</th><th>with_skill</th><th>${esc(base)}</th><th>Δ</th></tr></thead>
  <tbody>
    <tr>
      <td>Pass rate</td>
      <td>${pct(withS.pass_rate && withS.pass_rate.mean)}</td>
      <td>${pct(baseS.pass_rate && baseS.pass_rate.mean)}</td>
      <td class="${deltaClass(delta.pass_rate)}">${signedPts(delta.pass_rate)}</td>
    </tr>
    <tr>
      <td>Tokens (mean)</td>
      <td>${fmtNum(withS.tokens && withS.tokens.mean)}</td>
      <td>${fmtNum(baseS.tokens && baseS.tokens.mean)}</td>
      <td class="${deltaClass(delta.tokens_pct)}">${delta.tokens_pct === null || delta.tokens_pct === undefined ? '—' : delta.tokens_pct + '%'}</td>
    </tr>
    <tr>
      <td>Duration ms (mean)</td>
      <td>${fmtNum(withS.duration_ms && withS.duration_ms.mean)}</td>
      <td>${fmtNum(baseS.duration_ms && baseS.duration_ms.mean)}</td>
      <td class="${deltaClass(delta.duration_pct)}">${delta.duration_pct === null || delta.duration_pct === undefined ? '—' : delta.duration_pct + '%'}</td>
    </tr>
  </tbody>
</table>`;

    // Per-eval rows.
    let perEvalTable = '';
    if (benchmark.evals && benchmark.evals.length > 0) {
        const rows = benchmark.evals.map((e) => {
            const w = e.results && e.results['with_skill'];
            const bl = e.results && e.baseline_config && e.results[e.baseline_config];
            const d = e.delta || {};
            const ndCount = (e.assertions || []).filter((a) => a.discriminating === false).length;
            const hvCount = (e.assertions || []).filter((a) => a.high_variance).length;
            const badges = [
                ndCount ? `<span class="badge badge-nd">${ndCount} non-discriminating</span>` : '',
                hvCount ? `<span class="badge badge-hv">${hvCount} high-variance</span>` : '',
            ].filter(Boolean).join(' ');
            return `<tr>
  <td>${esc(e.eval_name || e.eval_id)}</td>
  <td>${pct(w && w.pass_rate && w.pass_rate.mean)} ±${pct(w && w.pass_rate && w.pass_rate.std)}</td>
  <td>${pct(bl && bl.pass_rate && bl.pass_rate.mean)} ±${pct(bl && bl.pass_rate && bl.pass_rate.std)}</td>
  <td class="${deltaClass(d.pass_rate)}">${signedPts(d.pass_rate)}</td>
  <td>${badges || '—'}</td>
</tr>`;
        }).join('\n');

        perEvalTable = `
<h3>Per-eval</h3>
<table>
  <thead><tr><th>Eval</th><th>with_skill</th><th>${esc(base)}</th><th>Δ</th><th>Flags</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
    }

    return `<section>
<h2>Benchmark</h2>
<h3>Summary</h3>
${summaryTable}
${perEvalTable}
</section>`;
}

function renderOutputsSection(evals, previous) {
    if (!evals || evals.length === 0) {
        return `<section><h2>Outputs</h2><p>No eval directories found.</p></section>`;
    }

    const blocks = evals.map((e) => {
        const prev = previous.get(e.evalName);
        const prevFiles = prev ? prev.outputFiles : [];

        const withGradingHtml = renderGradingRuns(e.withGrading, 'with_skill');
        const baselineGradingHtml = e.baselineGrading
            ? renderGradingRuns(e.baselineGrading, e.baselineConfig || 'baseline')
            : '<p style="color:#999;font-size:.8rem;">No baseline grading found.</p>';

        const withFileHtml = renderFileList(e.withOutputFiles, 'with_skill outputs');
        const baselineFileHtml = renderFileList(e.baselineOutputFiles, `${esc(e.baselineConfig || 'baseline')} outputs`);
        const prevFileHtml = prevFiles.length
            ? `<details><summary>Previous iteration outputs (${prevFiles.length} files)</summary>${renderFileList(prevFiles, 'previous')}</details>`
            : '';

        return `<div class="eval-block">
  <div class="eval-header" aria-expanded="true">eval-${esc(e.evalId)} — ${esc(e.evalDisplayName)}</div>
  <div class="eval-body">
    <div class="prompt-box">${esc(e.prompt)}</div>
    <div class="two-col">
      <div>
        <div class="col-label">with_skill grading</div>
        ${withGradingHtml}
      </div>
      <div>
        <div class="col-label">${esc(e.baselineConfig || 'baseline')} grading</div>
        ${baselineGradingHtml}
      </div>
    </div>
    <div class="two-col" style="margin-top:12px">
      <div>${withFileHtml}</div>
      <div>${baselineFileHtml}</div>
    </div>
    ${prevFileHtml}
  </div>
</div>`;
    }).join('\n');

    return `<section><h2>Outputs</h2>${blocks}</section>`;
}

function renderGradingRuns(gradingRuns, label) {
    if (!gradingRuns || gradingRuns.length === 0) {
        return '<p style="color:#999;font-size:.8rem;">No grading data.</p>';
    }
    return gradingRuns.map((g) => {
        const rows = (g.expectations || []).map((exp) => {
            const badge = exp.passed
                ? '<span class="badge badge-pass">PASS</span>'
                : '<span class="badge badge-fail">FAIL</span>';
            const evidence = exp.evidence
                ? `<div style="color:#666;font-size:.75rem;margin-top:2px">${esc(String(exp.evidence).slice(0, 200))}</div>`
                : '';
            return `<tr><td>${badge}</td><td>${esc(exp.text || '')}${evidence}</td></tr>`;
        }).join('');
        const header = gradingRuns.length > 1 ? `<div class="col-label" style="margin-bottom:4px">${esc(g.run)}</div>` : '';
        return `${header}<table><tbody>${rows || '<tr><td colspan="2" style="color:#999">No expectations</td></tr>'}</tbody></table>`;
    }).join('<hr style="margin:8px 0;border:none;border-top:1px solid #eee">');
}

function renderFileList(files, label) {
    if (!files || files.length === 0) {
        return `<p style="color:#999;font-size:.8rem">No ${esc(label)} files.</p>`;
    }
    const items = files.map((f) => `<li>📄 ${esc(f)}</li>`).join('');
    return `<div class="col-label">${esc(label)}</div><ul class="file-list">${items}</ul>`;
}

function renderFeedbackSection(evals) {
    if (!evals || evals.length === 0) {
        return `<section><h2>Feedback</h2><p>No evals.</p></section>`;
    }
    const textareas = evals.map((e) => `<div data-eval-id="${esc(e.evalId)}" style="margin-bottom:16px">
  <strong>eval-${esc(e.evalId)} — ${esc(e.evalDisplayName)}</strong>
  <textarea placeholder="Add feedback for this eval run…" aria-label="Feedback for eval-${esc(e.evalId)}"></textarea>
</div>`).join('\n');

    return `<section>
<h2>Feedback</h2>
<p style="color:#666;font-size:.85rem;margin-bottom:12px">Write per-eval feedback below, then click Download to save as feedback.json.</p>
${textareas}
<button class="dl-btn" id="download-feedback">Download feedback.json</button>
</section>`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function main(argv) {
    const args = parseArgs(argv);
    const iterationDir = args._[0];
    if (!iterationDir) {
        console.error(
            'Usage: node generate-review.js <iterationDir> --skill-name <name> [--benchmark <path>] [--previous <dir>] --static <out.html>',
        );
        process.exit(2);
    }

    const skillName = args['skill-name'] || 'unknown';
    const benchmarkPath = args.benchmark || path.join(iterationDir, 'benchmark.json');
    const previousDir = args.previous || null;
    const outHtml = args.static || path.join(iterationDir, 'review.html');

    const benchmark = readJsonSafe(benchmarkPath);
    const evals = loadEvalsForReview(iterationDir);
    const previous = loadPreviousEvals(previousDir);

    const html = renderReviewHtml({ benchmark, evals, previous, skillName });
    ensureDir(path.dirname(outHtml));
    fs.writeFileSync(outHtml, html, 'utf8');
    console.log(`[GENERATE-REVIEW] Written: ${outHtml}`);
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
    renderReviewHtml,
    loadEvalsForReview,
    loadPreviousEvals,
    renderBenchmarkSection,
    renderOutputsSection,
    renderFeedbackSection,
    main,
};
