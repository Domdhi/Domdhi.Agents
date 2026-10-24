#!/usr/bin/env node

/**
 * Memory Extractor — Brownfield-only model-driven daily-log → memory extraction
 *
 * Reads daily logs from docs/.output/.state/memory-daily/{YYYY-MM-DD}.md and runs each
 * unprocessed entry through the model (single-pass extraction, Mem0 v2.0.0-aligned)
 * for structured learning candidates. Output goes to docs/.output/.state/memory-extracted/{date}/
 * for adopter review.
 *
 * **Brownfield-only.** Per `docs/.output/findings/reviews/2026-04-20-adr-memory-unification.md`,
 * this CLI is NOT wired into in-process command flows. The in-process path uses
 * Main-Agent-authored memories at session-handoff time. The extractor exists for
 * adopters onboarding Domdhi.Agents with legacy daily logs they want to backfill
 * structured memories from.
 *
 * Single-pass output schema (R-C, 2026-05-11) matches the canonical memory content
 * shape used by `memory-manager-cli.js create` and the inbox pattern:
 *
 *   { category: 'patterns'|'constraints'|'decisions'|'workflows',
 *     suggested_id: 'kebab-case-slug',
 *     content: { description, evidence?, confidence } }
 *
 * Adopters can then either (a) review and copy fields into manual
 * `memory-manager-cli.js create` calls, or (b) move the JSON entries into
 * `docs/.output/.state/memory-inbox/` and run `inbox-promote` per draft for a unified
 * curation flow.
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { parseDailyFile: parseDailyFileLib } = require('./_lib/daily-log-parser');
const {
    checkClaudeCli,
    invokeModel,
    parseModelResult,
    tryParseInnerJson,
} = require('./_lib/model-runner');
const { resolveProjectRoot } = require('./_lib/project-root');
const { memoryPaths } = require('./_lib/memory-paths');
const { redactSecretsForWrite } = require('./secret-safe-write');

const MAX_ENTRIES_PER_RUN = 10;

class MemoryExtractor {
    constructor() {
        // Worktree-safe resolution (M5): the gitignored .state/ daily+extracted dirs
        // anchor to the MAIN worktree via memoryPaths(); projectRoot (model cwd /
        // git history) uses resolveProjectRoot() — matching memory-manager.js.
        const fallbackDir = path.resolve(__dirname, '..', '..');
        this.projectRoot = resolveProjectRoot(fallbackDir);
        const paths = memoryPaths(fallbackDir);
        this.dailyDir = paths.dailyDir;
        this.extractedDir = paths.extractedDir;
    }

    /**
     * Check if the claude CLI is available in PATH.
     * Thin adapter over _lib/model-runner.
     */
    checkClaudeCli() {
        return checkClaudeCli();
    }

    /**
     * Split a daily log file into individual compaction entries.
     * Thin adapter over _lib/daily-log-parser.js — preserves instance-method API.
     * Returns array of { date, time, heading, rawText }.
     */
    parseDailyFile(content, date) {
        return parseDailyFileLib(content, date);
    }

    /**
     * Check if an entry heading contains the [extracted] marker.
     */
    isProcessed(heading) {
        return heading.includes('[extracted]');
    }

    /**
     * Mark an entry as processed by appending [extracted] to its heading line.
     * Reads the file, marks the first still-UNMARKED occurrence of the heading, writes back.
     *
     * A plain `content.replace(heading, ...)` matches the first LITERAL occurrence
     * in the whole file. Daily-log headings are minute-granularity ("## HH:MM —
     * post-commit"), so two commits in the same minute produce byte-identical
     * headings; once the first is marked to "…post-commit [extracted]", that marked
     * line still CONTAINS the bare heading as a prefix, so the literal replace keeps
     * re-marking entry A and never touches entry B — B is reprocessed forever (M3).
     * Anchoring the match to a COMPLETE line (^…$) skips the already-marked prefix
     * and marks the first genuinely-unmarked heading. Re-reading fresh each call
     * also sidesteps the offset-shift a precomputed index would suffer once an
     * earlier " [extracted]" is inserted.
     */
    async markProcessed(filePath, originalHeading) {
        const content = await fsPromises.readFile(filePath, 'utf-8');
        const markedHeading = `${originalHeading} [extracted]`;
        const escaped = originalHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const lineRe = new RegExp('^' + escaped + '$', 'm');
        const updated = content.replace(lineRe, () => markedHeading);
        await fsPromises.writeFile(filePath, updated, 'utf-8');
    }

    /**
     * Invoke the model via claude -p to extract structured learnings from an entry.
     * Single-pass extraction (Mem0 v2.0.0-aligned shape, R-C 2026-05-11):
     * one LLM call per entry, ADD-only output, schema matches the canonical
     * memory content shape used by `memory-manager-cli.js create` and the
     * inbox pattern (`docs/.output/.state/memory-inbox/*.json`).
     *
     * Returns array of {category, suggested_id, content: {description, evidence?, confidence}}.
     * Returns [] on failure (graceful degradation); records failure separately so
     * extract() leaves the entry eligible for retry instead of treating it as empty.
     */
    invokeModel(entryText) {
        this._lastInvocationFailed = false;
        // Single concrete few-shot example beats stronger "JSON only" instructions.
        // The example is what the model actually pattern-matches against; the system-style
        // intro establishes the no-prose contract.
        const prompt = [
            'You are a strict JSON extractor. Read the daily log entry below and extract durable, reusable learnings.',
            'Output requirements:',
            '  - VALID JSON ARRAY ONLY — no prose before, no prose after, no markdown fences.',
            '  - If no extractable durable learning, output an empty array: []',
            '  - Never output conversational hedging like "It looks like..." — output starts with "[".',
            '',
            'Each learning must have this shape:',
            '  {',
            '    "category": "patterns" | "constraints" | "decisions" | "workflows",',
            '    "suggested_id": "kebab-case-slug",',
            '    "content": {',
            '      "description": "One paragraph: what + why, no code.",',
            '      "evidence": "Concrete anchor — story id, commit hash, file path, or one-line scenario.",',
            '      "confidence": 0.5 to 0.9 (extracted memories are not retro-validated; never start at 1.0)',
            '    }',
            '  }',
            '',
            'Use the canonical plural categories (patterns/constraints/decisions/workflows), not singular.',
            'The `evidence` field is encouraged but optional — omit if no clear anchor exists.',
            'Skip pure project-state (epic progress, story counts, branch status) — those are not durable.',
            '',
            '--- WORKED EXAMPLE ---',
            'INPUT:',
            '## 14:32 — fix: rename publish.js to tools/publish.js [extracted]',
            '',
            '`6f3e2a1` — Doc files referenced .claude/core/publish.js, but the script moved to tools/ during',
            'the publish-workflow refactor. Two-repo workflow: this private workshop publishes to a public',
            'storefront via tools/publish.js. Stale references caused publish:public to fail with module not',
            'found. Updated 5 doc files; tests still green.',
            '',
            'EXPECTED OUTPUT:',
            '[',
            '  {',
            '    "category": "constraints",',
            '    "suggested_id": "publish-script-lives-in-tools",',
            '    "content": {',
            '      "description": "The two-repo publish workflow uses tools/publish.js (NOT .claude/core/publish.js). The script was moved to tools/ during the publish-workflow refactor. Doc references and any inter-script imports must use the tools/ path.",',
            '      "evidence": "commit 6f3e2a1 — 5 doc files needed updating after the move; publish:public failed with module not found until references were corrected.",',
            '      "confidence": 0.8',
            '    }',
            '  }',
            ']',
            '--- END EXAMPLE ---',
            '',
            'Now extract learnings from this entry. Output the JSON array only.',
            '',
            '--- ENTRY START ---',
            entryText,
            '--- ENTRY END ---'
        ].join('\n');

        // Per-entry extraction uses a shorter timeout than full curation.
        const raw = invokeModel(prompt, {
            cwd: this.projectRoot,
            timeout: 30000,
            // Extractor's original inline logger emitted to stderr with "Warning:" prefix
            // before the message. The shared runner prefixes with logTag — use 'extractor'
            // to keep telemetry grep-able, and accept the slight message-format shift.
            logTag: null, // handled by the outer try/catch at call site below
        });

        if (raw === null) {
            process.stderr.write('  Warning: model invocation failed — subprocess returned null\n');
            this._lastInvocationFailed = true;
            return [];
        }

        // Native backends return normalized envelopes; retain historical raw
        // arrays and learnings/results wrappers for existing integrations.
        let parsed = null;
        try {
            parsed = parseModelResult(raw) ?? tryParseInnerJson(raw);
        } catch {
            // A malformed envelope must remain retryable like malformed JSON.
        }
        if (parsed === null) {
            process.stderr.write('  Warning: JSON parse failed for entry\n');
            this._lastInvocationFailed = true;
            return [];
        }

        // Single-pass schema validator — matches the canonical memory content shape
        // shared with memory-manager-cli.js create and the inbox pattern.
        const VALID_CATEGORIES = ['patterns', 'constraints', 'decisions', 'workflows'];
        const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

        const isValid = (item) => {
            if (!item || typeof item !== 'object') return false;
            if (!VALID_CATEGORIES.includes(item.category)) return false;
            if (typeof item.suggested_id !== 'string' || !SLUG_RE.test(item.suggested_id)) return false;
            if (!item.content || typeof item.content !== 'object') return false;
            if (typeof item.content.description !== 'string' || item.content.description.length === 0) return false;
            if (typeof item.content.confidence !== 'number') return false;
            if (item.content.confidence < 0.5 || item.content.confidence > 0.9) return false;
            // evidence is optional — if present, must be a non-empty string
            if (item.content.evidence !== undefined &&
                (typeof item.content.evidence !== 'string' || item.content.evidence.length === 0)) {
                return false;
            }
            return true;
        };

        // Accept a raw array or a wrapper object — model might return either despite instructions
        let array = null;
        if (Array.isArray(parsed)) array = parsed;
        else if (parsed && Array.isArray(parsed.learnings)) array = parsed.learnings;
        else if (parsed && Array.isArray(parsed.results)) array = parsed.results;

        if (!array) {
            this._lastInvocationFailed = true;
            process.stderr.write('  Warning: no learning collection in model response\n');
            return [];
        }
        const learnings = array.filter(isValid);
        if (array.length > 0 && learnings.length === 0) {
            this._lastInvocationFailed = true;
            process.stderr.write('  Warning: no valid learning candidates in model response\n');
        }
        return learnings;
    }

    /**
     * Write extracted learnings to docs/.output/.state/memory-extracted/{date}/{timestamp}.json
     */
    async writeExtractedLearnings(date, learnings, timestamp) {
        const dateDir = path.join(this.extractedDir, date);
        fs.mkdirSync(dateDir, { recursive: true });

        const filename = `${timestamp}.json`;
        const filePath = path.join(dateDir, filename);

        const payload = {
            extractedAt: new Date().toISOString(),
            sourceDate: date,
            count: learnings.length,
            learnings
        };

        // The `learnings` are model-derived free text — route the serialized
        // output through the secret-scanner before this RAW write (which bypasses
        // both the PreToolUse hook and, for gitignored .state/, commit.js's scan).
        // Redact-and-warn, never throw (class-consistency with the curator write).
        const json = redactSecretsForWrite(JSON.stringify(payload, null, 2), filePath);
        await fsPromises.writeFile(filePath, json, 'utf-8');
        return filePath;
    }

    /**
     * Main extract command.
     * Iterates daily files, finds unprocessed entries, processes up to MAX_ENTRIES_PER_RUN.
     * In --dry-run mode: lists what would be processed without invoking the model or writing files.
     * Returns { processed, skipped, failed }.
     */
    async extract(options = {}) {
        const { dryRun = false } = options;

        if (dryRun) {
            console.log('Dry run mode — no files will be written, no model invocations.\n');
        }

        // Read all daily log files
        let dailyFiles = [];
        try {
            const files = await fsPromises.readdir(this.dailyDir);
            dailyFiles = files
                .filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
                .sort();
        } catch {
            console.log('No daily log directory found at', this.dailyDir);
            return { processed: 0, skipped: 0, failed: 0 };
        }

        if (dailyFiles.length === 0) {
            console.log('No daily log files found.');
            return { processed: 0, skipped: 0, failed: 0 };
        }

        // Collect all unprocessed entries across all files
        const unprocessed = [];

        for (const file of dailyFiles) {
            const date = file.replace('.md', '');
            const filePath = path.join(this.dailyDir, file);

            let content;
            try {
                content = await fsPromises.readFile(filePath, 'utf-8');
            } catch {
                process.stderr.write(`  Warning: could not read ${file}, skipping.\n`);
                continue;
            }

            const entries = this.parseDailyFile(content, date);
            for (const entry of entries) {
                if (!this.isProcessed(entry.heading)) {
                    unprocessed.push({ ...entry, filePath });
                }
            }
        }

        if (unprocessed.length === 0) {
            console.log('All entries already extracted. Nothing to do.');
            return { processed: 0, skipped: 0, failed: 0 };
        }

        // Apply rate limit
        const toProcess = unprocessed.slice(0, MAX_ENTRIES_PER_RUN);
        const skippedByLimit = unprocessed.length - toProcess.length;

        if (dryRun) {
            console.log(`Found ${unprocessed.length} unprocessed entry/entries.`);
            if (skippedByLimit > 0) {
                console.log(`Rate limit: would process ${toProcess.length}, defer ${skippedByLimit} to next run.\n`);
            }
            console.log('Would process:');
            for (const entry of toProcess) {
                console.log(`  [${entry.date} ${entry.time}] ${entry.heading}`);
            }
            return { processed: 0, skipped: unprocessed.length, failed: 0 };
        }

        // Process entries
        let processed = 0;
        let failed = 0;
        const now = new Date();
        const timestamp = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
        const todayDate = now.toISOString().slice(0, 10);

        const allLearnings = [];

        console.log(`Processing ${toProcess.length} entry/entries (${skippedByLimit} deferred by rate limit)...\n`);

        for (const entry of toProcess) {
            process.stdout.write(`  Extracting [${entry.date} ${entry.time}]... `);

            this._lastInvocationFailed = false;
            const learnings = this.invokeModel(entry.rawText);

            if (this._lastInvocationFailed || learnings === null || learnings === undefined) {
                console.log('FAILED (model response unavailable or invalid)');
                failed++;
                continue;
            }

            if (learnings.length === 0) {
                console.log('done (0 learnings extracted)');
                // Still mark as processed so we don't retry endlessly on entries with no learnings
                try {
                    await this.markProcessed(entry.filePath, entry.heading);
                } catch (err) {
                    process.stderr.write(`  Warning: could not mark entry as processed — ${err.message}\n`);
                }
                processed++;
                continue;
            }

            // Attach source metadata to each learning
            for (const learning of learnings) {
                allLearnings.push({
                    ...learning,
                    sourceDate: entry.date,
                    sourceTime: entry.time
                });
            }

            // Mark the entry as processed
            try {
                await this.markProcessed(entry.filePath, entry.heading);
                console.log(`done (${learnings.length} learning(s))`);
                processed++;
            } catch (err) {
                process.stderr.write(`  Warning: could not mark entry as processed — ${err.message}\n`);
                // Still count as processed since the model call succeeded
                processed++;
            }
        }

        // Write all learnings from this run to a single JSON file
        if (allLearnings.length > 0) {
            try {
                const outPath = await this.writeExtractedLearnings(todayDate, allLearnings, timestamp);
                console.log(`\nExtracted ${allLearnings.length} learning(s) → ${outPath}`);
            } catch (err) {
                process.stderr.write(`  Warning: could not write extracted learnings file — ${err.message}\n`);
                failed++;
            }
        } else {
            console.log('\nNo learnings extracted this run.');
        }

        if (skippedByLimit > 0) {
            console.log(`\nNote: ${skippedByLimit} entry/entries deferred (rate limit: ${MAX_ENTRIES_PER_RUN}/run). Run again to continue.`);
        }

        return { processed, skipped: skippedByLimit, failed };
    }

    /**
     * Status command.
     * Shows count of unprocessed entries, count of extracted entries, last extraction date.
     */
    async status() {
        console.log('Memory Extractor — status\n');

        // Count total and unprocessed entries across all daily files
        let totalEntries = 0;
        let unprocessedEntries = 0;
        let dailyFileCount = 0;

        try {
            const files = await fsPromises.readdir(this.dailyDir);
            const mdFiles = files.filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
            dailyFileCount = mdFiles.length;

            for (const file of mdFiles) {
                const date = file.replace('.md', '');
                try {
                    const content = await fsPromises.readFile(path.join(this.dailyDir, file), 'utf-8');
                    const entries = this.parseDailyFile(content, date);
                    totalEntries += entries.length;
                    for (const entry of entries) {
                        if (!this.isProcessed(entry.heading)) {
                            unprocessedEntries++;
                        }
                    }
                } catch {
                    // skip unreadable files
                }
            }
        } catch {
            // daily dir may not exist yet
        }

        const extractedEntries = totalEntries - unprocessedEntries;

        // Find last extraction date from extracted dir
        let lastExtractionDate = 'never';
        let totalExtractedLearnings = 0;

        try {
            const dateDirs = await fsPromises.readdir(this.extractedDir);
            const sortedDirs = dateDirs
                .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
                .sort();

            if (sortedDirs.length > 0) {
                lastExtractionDate = sortedDirs[sortedDirs.length - 1];
            }

            // Count total extracted learnings across all files
            for (const dateDir of sortedDirs) {
                const dateDirPath = path.join(this.extractedDir, dateDir);
                try {
                    const jsonFiles = await fsPromises.readdir(dateDirPath);
                    for (const jsonFile of jsonFiles.filter(f => f.endsWith('.json'))) {
                        try {
                            const content = await fsPromises.readFile(path.join(dateDirPath, jsonFile), 'utf-8');
                            const data = JSON.parse(content);
                            if (data && typeof data.count === 'number') {
                                totalExtractedLearnings += data.count;
                            }
                        } catch {
                            // skip unreadable JSON
                        }
                    }
                } catch {
                    // skip unreadable date dir
                }
            }
        } catch {
            // extracted dir may not exist yet
        }

        console.log(`Daily log files    : ${dailyFileCount}`);
        console.log(`Total entries      : ${totalEntries}`);
        console.log(`Extracted entries  : ${extractedEntries}`);
        console.log(`Unprocessed entries: ${unprocessedEntries}`);
        console.log(`Extracted learnings: ${totalExtractedLearnings}`);
        console.log(`Last extraction    : ${lastExtractionDate}`);
        console.log(`Daily dir          : ${this.dailyDir}`);
        console.log(`Extracted dir      : ${this.extractedDir}`);
    }
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

async function main() {
    const extractor = new MemoryExtractor();
    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
        case 'extract': {
            const dryRun = args.includes('--dry-run');
            if (!dryRun && !extractor.checkClaudeCli()) {
                console.error('Memory model unavailable — extraction requires a supported tool-free backend.');
                process.exit(1);
            }
            const result = await extractor.extract({ dryRun });
            if (!dryRun) {
                process.stderr.write(`Estimated cost: ~$0.02-0.05 per entry, ${result.processed} entries processed\n`);
            }
            break;
        }
        case 'status':
            await extractor.status();
            break;
        default:
            console.log([
                'Memory Extractor — brownfield-only daily-log → memory extraction',
                '',
                'Usage:',
                '  node memory-extractor.js extract [--dry-run]',
                '  node memory-extractor.js status',
                '',
                'Output schema (single-pass, Mem0 v2.0.0-aligned):',
                '  { category, suggested_id, content: { description, evidence?, confidence } }',
                '',
                'Brownfield-only — not wired into in-process command flows (see ADR',
                'docs/.output/findings/reviews/2026-04-20-adr-memory-unification.md). Adopters review',
                'the extracted/ output and create memories manually via memory-manager-cli.js,',
                'or move entries to _inbox/ and use inbox-promote.',
            ].join('\n'));
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error:', err.message);
        process.exit(1);
    });
}

module.exports = MemoryExtractor;
