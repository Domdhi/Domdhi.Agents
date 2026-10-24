#!/usr/bin/env node

/**
 * Memory Benchmark — weekly recall hit-rate measurement.
 *
 * Picks random daily-log entries >7 days old, asks Haiku which concept slug
 * should surface for each, then runs MemoryManager.searchMemories() and
 * checks whether Haiku's expected slug appears in the top 5 results.
 *
 * Results append as JSONL to docs/.output/.state/telemetry/memory-benchmark.jsonl
 * with tail-sample rotation (copied from command-usage-logger.cjs).
 *
 * CLI:
 *   node memory-benchmark.js benchmark [--dry-run]   Run benchmark, write JSONL
 *   node memory-benchmark.js report                  Aggregate + print hit-rate
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const MemoryManager = require('./memory-manager');
const {
    parseDailyFile,
    extractKeywords,
} = require('./_lib/daily-log-parser');
const {
    checkClaudeCli,
    invokeModel,
    parseModelResult,
    extractTokenCounts,
} = require('./_lib/model-runner');
const { appendJsonl } = require('./_lib/jsonl-writer');
const { redactSecretsForWrite } = require('./secret-safe-write');
const { getTelemetryDir, getJsonlPath } = require('./_lib/telemetry-paths');
const { resolveProjectRoot } = require('./_lib/project-root');
const { memoryPaths } = require('./_lib/memory-paths');

const MAX_ENTRIES_PER_RUN = 10;
const MIN_AGE_DAYS = 7;
const MAX_JSONL_LINES = 1000;
const TAIL_KEEP_LINES = 500;
const TOP_K = 5;
const REPORT_WINDOW_DAYS = 30;
const MAX_KEYWORDS_FOR_QUERY = 5;
const MAX_INDEX_CHARS = 20000;
const MAX_ENTRY_CHARS = 8000;

const HAIKU_INPUT_PRICE = 0.0000008;
const HAIKU_OUTPUT_PRICE = 0.000004;

class MemoryBenchmark {
    constructor() {
        // Worktree-safe resolution (M5): all benchmark paths (daily logs, concepts,
        // telemetry) are gitignored .state/ — anchor to the MAIN worktree via
        // resolveProjectRoot()/memoryPaths() so a run inside a linked worktree
        // reads/writes the shared store, not a soon-deleted worktree-local one.
        const fallbackDir = path.resolve(__dirname, '..', '..');
        this.projectRoot = resolveProjectRoot(fallbackDir);
        const paths = memoryPaths(fallbackDir);
        this.dailyDir = paths.dailyDir;
        this.conceptsDir = paths.conceptsDir;
        this.indexPath = path.join(this.conceptsDir, 'index.md');
        this.telemetryDir = getTelemetryDir(this.projectRoot);
        this.jsonlPath = getJsonlPath(this.projectRoot, 'memory-benchmark.jsonl');
    }

    // -------------------------------------------------------------------------
    // Guards (thin adapter over _lib/model-runner)
    // -------------------------------------------------------------------------

    checkClaudeCli() {
        return checkClaudeCli();
    }

    readIndexMd() {
        if (!fsSync.existsSync(this.indexPath)) return null;
        const content = fsSync.readFileSync(this.indexPath, 'utf-8');
        if (!content.trim()) return null;
        return content;
    }

    // -------------------------------------------------------------------------
    // Daily-log entry sampling
    // -------------------------------------------------------------------------

    /**
     * List all daily-log .md files in chronological order, filter to entries
     * whose file date is older than MIN_AGE_DAYS.
     */
    listEligibleFiles() {
        if (!fsSync.existsSync(this.dailyDir)) return [];
        const cutoff = new Date();
        cutoff.setUTCDate(cutoff.getUTCDate() - MIN_AGE_DAYS);
        const cutoffISO = cutoff.toISOString().slice(0, 10);

        const files = fsSync.readdirSync(this.dailyDir)
            .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
            .filter(f => f.replace('.md', '') < cutoffISO)
            .sort();
        return files;
    }

    /**
     * Parse every eligible daily-log file and return a flat array of entries.
     * Uses the shared _lib/daily-log-parser — no MemoryCompiler instantiation required.
     */
    collectEntries() {
        const files = this.listEligibleFiles();
        const entries = [];
        for (const file of files) {
            const date = file.replace('.md', '');
            let content;
            try {
                content = fsSync.readFileSync(path.join(this.dailyDir, file), 'utf-8');
            } catch {
                continue;
            }
            const parsed = parseDailyFile(content, date);
            for (const e of parsed) {
                entries.push(e);
            }
        }
        return entries;
    }

    /**
     * Fisher-Yates shuffle then slice. Returns up to MAX_ENTRIES_PER_RUN entries.
     */
    sampleEntries(entries) {
        const arr = entries.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr.slice(0, MAX_ENTRIES_PER_RUN);
    }

    /**
     * Extract the entry heading (first `## HH:MM — <heading>` line).
     */
    entryHeading(entry) {
        const m = entry.rawText.match(/^## (\d{2}:\d{2}) — (.+)/);
        return m ? `${m[1]} — ${m[2].trim()}` : `${entry.time || ''}`.trim();
    }

    // -------------------------------------------------------------------------
    // Haiku prompt construction + invocation (mirrors memory-curator.js)
    // -------------------------------------------------------------------------

    buildPrompt(indexContent, entry) {
        const truncatedIndex = indexContent.length > MAX_INDEX_CHARS
            ? indexContent.slice(0, MAX_INDEX_CHARS) + '\n[... truncated ...]'
            : indexContent;
        const truncatedEntry = entry.rawText.length > MAX_ENTRY_CHARS
            ? entry.rawText.slice(0, MAX_ENTRY_CHARS) + '\n[... truncated ...]'
            : entry.rawText;

        return `You are a memory-retrieval benchmark judge. Given a daily-log entry and a list of available memory concept slugs, pick the ONE concept slug that a retrieval system SHOULD surface for a developer working on this entry's topic.

Coverage-first: report a best-effort match. Only respond with null when no concept in the index is topically relevant.

<concept_index>
${truncatedIndex}
</concept_index>

<daily_log_entry>
${truncatedEntry}
</daily_log_entry>

Output JSON only. No markdown code fences. No prose. Exact shape:

{"expected_slug": "<slug-from-index>" | null, "rationale": "<1 short sentence>"}

Rules:
- expected_slug MUST be an exact slug string that appears in <concept_index>, or null.
- Do NOT invent slugs.
- If multiple concepts match, pick the most specific/topical.
- If no concept matches, return null (not an empty string).`;
    }

    invokeModel(prompt) {
        return invokeModel(prompt, {
            cwd: this.projectRoot,
            timeout: 90000,
            logTag: 'memory-benchmark',
        });
    }

    parseModelResult(raw) {
        // Benchmark originally had an expected_slug-specific fallback for the edge
        // case where Haiku returned the payload directly instead of an envelope.
        // Preserve by chaining: try shared envelope parser, then fall back to
        // treating the whole string as the payload.
        const primary = parseModelResult(raw);
        if (primary) return primary;
        try {
            const envelope = JSON.parse(raw);
            if (envelope && envelope.expected_slug !== undefined) return envelope;
        } catch { /* ignore */ }
        return null;
    }

    tryParseInnerJson(text) {
        return require('./_lib/model-runner').tryParseInnerJson(text);
    }

    extractTokenCounts(raw) {
        return extractTokenCounts(raw);
    }

    // -------------------------------------------------------------------------
    // Retrieval + scoring
    // -------------------------------------------------------------------------

    /**
     * Build a keyword query string from an entry.
     * Uses the shared _lib/daily-log-parser — no MemoryCompiler instantiation.
     */
    keywordQuery(entry) {
        const keywords = extractKeywords(entry);
        const arr = Array.from(keywords).slice(0, MAX_KEYWORDS_FOR_QUERY);
        return arr.join(' ');
    }

    /**
     * Return the 1-based rank (1..TOP_K) of expectedSlug within results[0..TOP_K-1],
     * or null if not present. Match is case-insensitive on result.id.
     */
    findRank(results, expectedSlug) {
        if (!expectedSlug || !Array.isArray(results)) return null;
        const needle = expectedSlug.toLowerCase();
        const top = results.slice(0, TOP_K);
        for (let i = 0; i < top.length; i++) {
            const id = String(top[i].id || '').toLowerCase();
            if (id === needle) return i + 1;
        }
        return null;
    }

    // -------------------------------------------------------------------------
    // JSONL append + tail-rotation (thin adapter over _lib/jsonl-writer)
    // -------------------------------------------------------------------------

    appendJsonl(record) {
        appendJsonl(this.jsonlPath, record, {
            maxLines: MAX_JSONL_LINES,
            tailKeep: TAIL_KEEP_LINES,
            onError: (msg) => process.stderr.write(`[memory-benchmark] JSONL write failed: ${msg}\n`),
        });
    }

    // -------------------------------------------------------------------------
    // Main flow
    // -------------------------------------------------------------------------

    async benchmark({ dryRun = false } = {}) {
        if (!this.checkClaudeCli()) {
            process.stderr.write('[memory-benchmark] memory model unavailable — skipping\n');
            return null;
        }

        const indexContent = this.readIndexMd();
        if (!indexContent) {
            process.stderr.write('[memory-benchmark] concepts/index.md missing or empty — nothing to benchmark against\n');
            return null;
        }

        const allEntries = this.collectEntries();
        if (allEntries.length === 0) {
            process.stderr.write(`[memory-benchmark] No daily-log entries older than ${MIN_AGE_DAYS} days\n`);
            return null;
        }

        const sampled = this.sampleEntries(allEntries);
        process.stderr.write(`[memory-benchmark] sampled ${sampled.length} of ${allEntries.length} eligible entries\n`);

        const memoryManager = new MemoryManager();
        const records = [];
        let totalInput = 0;
        let totalOutput = 0;

        for (const entry of sampled) {
            const prompt = this.buildPrompt(indexContent, entry);
            const raw = this.invokeModel(prompt);
            if (!raw) continue;

            const parsed = this.parseModelResult(raw);
            const expectedSlug = (parsed && typeof parsed.expected_slug === 'string' && parsed.expected_slug.trim())
                ? parsed.expected_slug.trim()
                : null;

            const { input, output } = this.extractTokenCounts(raw);
            totalInput += input;
            totalOutput += output;

            // Retrieval phase (AC#4): run searchMemories with extracted keywords.
            // F11: recordRecall:false — this is a benchmark measuring retrieval
            // quality, not a genuine recall; it must not inflate usage_count or
            // pollute memory-injection.jsonl hit-rate/prune analytics.
            const query = this.keywordQuery(entry);
            let results = [];
            if (query) {
                try {
                    results = await memoryManager.searchMemories(query, { recordRecall: false }) || [];
                } catch (e) {
                    process.stderr.write(`[memory-benchmark] searchMemories failed for "${query}": ${e.message}\n`);
                    results = [];
                }
            }

            const top5Ids = results.slice(0, TOP_K).map(r => r.id).filter(Boolean);
            const rank = this.findRank(results, expectedSlug);
            const hit = rank !== null;

            const record = {
                timestamp: new Date().toISOString(),
                type: 'memory_benchmark',
                daily_log_date: entry.date,
                entry_heading: this.entryHeading(entry),
                // expected_concept is the model-returned slug — redact before it
                // lands in the persisted jsonl (class-consistency with the curator/
                // extractor writes; findRank above already used the raw slug, so
                // benchmark accuracy is unaffected).
                expected_concept: expectedSlug ? redactSecretsForWrite(expectedSlug, this.jsonlPath, null) : expectedSlug,
                retrieved_top5: top5Ids,
                retrieval_rank: rank,
                hit
            };
            records.push(record);

            if (!dryRun) {
                this.appendJsonl(record);
            }
        }

        const cost = (totalInput * HAIKU_INPUT_PRICE) + (totalOutput * HAIKU_OUTPUT_PRICE);
        const hits = records.filter(r => r.hit).length;
        const hitRate = records.length > 0 ? (hits / records.length) : 0;

        process.stderr.write(
            `[memory-benchmark] ran=${records.length} hits=${hits} hit_rate=${(hitRate * 100).toFixed(1)}% ` +
            `input_tokens=${totalInput} output_tokens=${totalOutput} cost_usd=${cost.toFixed(4)}\n`
        );

        if (dryRun) {
            process.stdout.write(JSON.stringify(records, null, 2) + '\n');
        }

        return { records, hits, hitRate, cost };
    }

    // -------------------------------------------------------------------------
    // Report
    // -------------------------------------------------------------------------

    async report() {
        if (!fsSync.existsSync(this.jsonlPath)) {
            console.log('No benchmark runs yet.');
            console.log(`Expected JSONL: ${this.jsonlPath}`);
            return;
        }

        const raw = fsSync.readFileSync(this.jsonlPath, 'utf-8');
        const lines = raw.split('\n').filter(l => l.trim());
        const all = [];
        for (const line of lines) {
            try {
                const r = JSON.parse(line);
                if (r.type === 'memory_benchmark') all.push(r);
            } catch {}
        }

        if (all.length === 0) {
            console.log('No benchmark records in JSONL.');
            return;
        }

        // Filter to last 30 days
        const cutoff = new Date();
        cutoff.setUTCDate(cutoff.getUTCDate() - REPORT_WINDOW_DAYS);
        const cutoffISO = cutoff.toISOString();
        const recent = all.filter(r => typeof r.timestamp === 'string' && r.timestamp >= cutoffISO);

        const total = recent.length;
        const hits = recent.filter(r => r.hit).length;
        const hitRate = total > 0 ? (hits / total) * 100 : 0;

        const ranks = recent.filter(r => typeof r.retrieval_rank === 'number').map(r => r.retrieval_rank);
        const meanRank = ranks.length > 0 ? (ranks.reduce((a, b) => a + b, 0) / ranks.length) : null;

        // Top missed concepts (expected but not hit)
        const missCounts = {};
        for (const r of recent) {
            if (!r.hit && r.expected_concept) {
                missCounts[r.expected_concept] = (missCounts[r.expected_concept] || 0) + 1;
            }
        }
        const topMissed = Object.entries(missCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);

        // Status label per design review Addendum A
        const label = hitRate >= 70 ? 'Green (healthy)'
            : hitRate >= 50 ? 'Yellow (MVP floor)'
            : 'Red (below floor)';

        console.log(`Memory Benchmark — last ${REPORT_WINDOW_DAYS} days`);
        console.log(`-------------------------------------------`);
        console.log(`All-time runs  : ${all.length}`);
        console.log(`Recent runs    : ${total}`);
        console.log(`Hits           : ${hits}`);
        console.log(`Hit rate       : ${hitRate.toFixed(1)}%  [${label}]`);
        console.log(`Mean rank      : ${meanRank !== null ? meanRank.toFixed(2) : 'n/a'}`);
        console.log(`JSONL          : ${this.jsonlPath}`);

        if (topMissed.length > 0) {
            console.log(`\nTop missed concepts:`);
            for (const [slug, count] of topMissed) {
                console.log(`  ${count}× ${slug}`);
            }
        } else {
            console.log(`\nNo missed concepts in window.`);
        }
    }
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

async function main() {
    const bench = new MemoryBenchmark();
    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
        case 'benchmark': {
            const dryRun = args.includes('--dry-run');
            await bench.benchmark({ dryRun });
            break;
        }
        case 'report':
            await bench.report();
            break;
        default:
            console.log(`Memory Benchmark — measure retrieval hit-rate against concept index

Usage:
  node memory-benchmark.js benchmark [--dry-run]  Pick ${MAX_ENTRIES_PER_RUN} random entries >${MIN_AGE_DAYS}d old,
                                                  ask Haiku for expected concept, check retrieval top-${TOP_K}
  node memory-benchmark.js report                 Aggregate last ${REPORT_WINDOW_DAYS} days of runs

Cost control:
  MAX_ENTRIES_PER_RUN = ${MAX_ENTRIES_PER_RUN} (one Haiku call per entry, capped)

Output:
  docs/.output/.state/telemetry/memory-benchmark.jsonl  (rotates at ${MAX_JSONL_LINES} lines → ${TAIL_KEEP_LINES} tail)
`);
            process.exit(command ? 1 : 0);
    }
}

if (require.main === module) {
    main().catch(e => {
        process.stderr.write(`[memory-benchmark] error: ${e.message}\n`);
        process.exit(1);
    });
}

module.exports = MemoryBenchmark;
module.exports.MemoryBenchmark = MemoryBenchmark;
