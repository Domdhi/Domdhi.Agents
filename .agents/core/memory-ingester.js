#!/usr/bin/env node

/**
 * Memory Ingester — Converts legacy daily recap files into daily log format
 *
 * Reads recap files from external projects (e.g., a legacy downstream) and converts
 * them into the daily log format consumed by memory-extractor.js (manual Haiku pipeline).
 *
 * Source format: docs/.archive/recaps/.archive/{YYYY-MM}/daily_recap_{YYYY_MM_DD}.md
 *   - YAML frontmatter (value_created, traditional_hours, velocity_multiplier, date)
 *   - Narrative markdown with ## sections, inline commit hashes, technical details
 *   - ## Objectives for Tomorrow section
 *
 * Target format: docs/.output/.state/memory-daily/{YYYY-MM-DD}.md
 *   - ## HH:MM — ingested entries with Branch, Recent Commits, In-Progress Work, Key Decisions
 *
 * Pipeline: memory-ingester.js (this tool) → docs/.output/.state/memory-daily/YYYY-MM-DD.md → memory-extractor.js (manual Haiku pipeline, brownfield only) → memory-manager.js create
 */

const fs = require('fs');
const path = require('path');
const { memoryPaths } = require('./_lib/memory-paths');

class MemoryIngester {
    constructor(outputDir) {
        // Worktree-safe resolution (M5): the gitignored daily-log dir anchors to the
        // MAIN worktree via memoryPaths() — the old per-__dirname fallback wrote logs
        // into a linked worktree's own .state/ that is lost on worktree removal.
        this.outputDir = outputDir || memoryPaths(path.resolve(__dirname, '..', '..')).dailyDir;
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Ingest all recap files from a source directory.
     *
     * @param {string} sourceDir - Path to recap archive directory
     * @param {object} options - { dryRun: boolean }
     * @returns {{ processed: number, created: number, skipped: number, errors: string[] }}
     */
    ingest(sourceDir, options = {}) {
        const { dryRun = false } = options;

        const recapFiles = this.findRecapFiles(sourceDir);
        if (recapFiles.length === 0) {
            console.log(`No recap files found in ${sourceDir}`);
            return { processed: 0, created: 0, skipped: 0, errors: [] };
        }

        console.log(`Found ${recapFiles.length} recap file(s) in ${sourceDir}`);
        if (dryRun) console.log('(dry run — no files will be written)\n');

        const stats = { processed: 0, created: 0, skipped: 0, errors: [] };

        for (const filePath of recapFiles) {
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                const date = this.extractDate(content, filePath);
                if (!date) {
                    const msg = `Could not extract date from ${path.basename(filePath)}`;
                    stats.errors.push(msg);
                    console.log(`  SKIP: ${msg}`);
                    continue;
                }

                // Check for existing entry with this date and trigger
                const targetPath = path.join(this.outputDir, `${date}.md`);
                if (fs.existsSync(targetPath)) {
                    const existing = fs.readFileSync(targetPath, 'utf8');
                    if (existing.includes('— ingested')) {
                        stats.skipped++;
                        if (dryRun) console.log(`  SKIP: ${date} — already ingested`);
                        continue;
                    }
                }

                const entry = this.convertRecap(content, date);
                stats.processed++;

                if (dryRun) {
                    console.log(`  WOULD WRITE: ${date}.md (${entry.length} chars)`);
                    // Show preview of first 3 lines
                    const preview = entry.split('\n').slice(0, 3).join('\n');
                    console.log(`    ${preview}`);
                    console.log('');
                } else {
                    fs.mkdirSync(this.outputDir, { recursive: true });
                    fs.appendFileSync(targetPath, entry, 'utf8');
                    stats.created++;
                    console.log(`  WROTE: ${date}.md`);
                }
            } catch (err) {
                const msg = `Error processing ${path.basename(filePath)}: ${err.message}`;
                stats.errors.push(msg);
                console.log(`  ERROR: ${msg}`);
            }
        }

        console.log(`\nSummary: ${stats.processed} processed, ${stats.created} created, ${stats.skipped} skipped, ${stats.errors.length} errors`);
        return stats;
    }

    /**
     * Show status of a source directory without ingesting.
     *
     * @param {string} sourceDir - Path to recap archive directory
     */
    status(sourceDir) {
        const recapFiles = this.findRecapFiles(sourceDir);
        console.log(`Source: ${sourceDir}`);
        console.log(`Output: ${this.outputDir}`);
        console.log(`Recap files found: ${recapFiles.length}`);

        if (recapFiles.length === 0) return;

        // Count already-ingested
        let ingested = 0;
        let pending = 0;
        for (const filePath of recapFiles) {
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                const date = this.extractDate(content, filePath);
                if (!date) continue;

                const targetPath = path.join(this.outputDir, `${date}.md`);
                if (fs.existsSync(targetPath)) {
                    const existing = fs.readFileSync(targetPath, 'utf8');
                    if (existing.includes('— ingested')) {
                        ingested++;
                        continue;
                    }
                }
                pending++;
            } catch {
                // skip
            }
        }

        console.log(`Already ingested: ${ingested}`);
        console.log(`Pending: ${pending}`);

        // Date range
        const dates = recapFiles
            .map(f => {
                try {
                    const content = fs.readFileSync(f, 'utf8');
                    return this.extractDate(content, f);
                } catch { return null; }
            })
            .filter(Boolean)
            .sort();

        if (dates.length > 0) {
            console.log(`Date range: ${dates[0]} to ${dates[dates.length - 1]}`);
        }
    }

    // -------------------------------------------------------------------------
    // File discovery
    // -------------------------------------------------------------------------

    /**
     * Recursively find all daily_recap_*.md files in sourceDir.
     */
    findRecapFiles(sourceDir) {
        const results = [];

        function walk(dir) {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath);
                } else if (entry.isFile() && /^daily_recap.*\.md$/i.test(entry.name)) {
                    results.push(fullPath);
                }
            }
        }

        walk(sourceDir);
        return results.sort();
    }

    // -------------------------------------------------------------------------
    // Date extraction
    // -------------------------------------------------------------------------

    /**
     * Extract date from recap content or filename.
     * Tries: YAML frontmatter `date:` field, then filename pattern.
     * Returns YYYY-MM-DD string or null.
     */
    extractDate(content, filePath) {
        // Try YAML frontmatter date field
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
            const dateMatch = fmMatch[1].match(/^date:\s*(.+)$/m);
            if (dateMatch) {
                const d = dateMatch[1].trim();
                // Handle YYYY-MM-DD format
                if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
            }
        }

        // Try filename: daily_recap_YYYY_MM_DD.md
        const fnMatch = path.basename(filePath).match(/daily_recap_(\d{4})_(\d{2})_(\d{2})/);
        if (fnMatch) {
            return `${fnMatch[1]}-${fnMatch[2]}-${fnMatch[3]}`;
        }

        return null;
    }

    // -------------------------------------------------------------------------
    // Conversion
    // -------------------------------------------------------------------------

    /**
     * Convert a recap file's content into a daily log entry string.
     */
    convertRecap(content, date) {
        // Strip frontmatter
        const body = content.replace(/^---\n[\s\S]*?\n---\n*/, '');

        const commits = this.extractCommits(body);
        const inProgress = this.extractObjectives(body);
        const decisions = this.extractDecisions(body);
        const title = this.extractTitle(body);

        const commitsBlock = commits.length > 0
            ? commits.join('\n')
            : '(no commits detected)';

        const inProgressBlock = inProgress.length > 0
            ? inProgress.map(item => `  - [>] ${item}`).join('\n')
            : '  None';

        const decisionsBlock = decisions.length > 0
            ? '| Decision | Rationale | Outcome |\n|----------|-----------|---------|' +
              '\n' + decisions.map(d => `| ${d.decision} | ${d.rationale} | ingested |`).join('\n')
            : '  None';

        return `## 00:00 — ingested

**Branch:** ingested
**Source:** ${title}

### Recent Commits
\`\`\`
${commitsBlock}
\`\`\`

### In-Progress Work
${inProgressBlock}

### Key Decisions
${decisionsBlock}

`;
    }

    /**
     * Extract the sitrep title from the first heading.
     */
    extractTitle(body) {
        const match = body.match(/^#\s+.*?\/\/\s*(.+)$/m);
        if (match) return match[1].trim();

        const h1Match = body.match(/^#\s+(.+)$/m);
        if (h1Match) return h1Match[1].trim();

        return 'unknown';
    }

    /**
     * Extract commit hashes from body text.
     * Looks for patterns like (`abc1234`), (`abc1234`, `def5678`), and inline 7+ char hex.
     */
    extractCommits(body) {
        const commits = new Set();

        // Match commit hashes in backticks: (`abc1234`)
        const backtickMatches = body.matchAll(/`([a-f0-9]{7,40})`/g);
        for (const m of backtickMatches) {
            commits.add(m[1].slice(0, 7));
        }

        // Match commit hashes in parentheses without backticks: (abc1234)
        const parenMatches = body.matchAll(/\(([a-f0-9]{7,40})\)/g);
        for (const m of parenMatches) {
            commits.add(m[1].slice(0, 7));
        }

        // Deduplicate and format as "hash (from recap)"
        return Array.from(commits).map(h => `${h} (ingested from recap)`);
    }

    /**
     * Extract objectives/tomorrow items as in-progress work.
     */
    extractObjectives(body) {
        // Find "Objectives for Tomorrow" or similar section. The terminator
        // must include bare end-of-input: JS `$` (no /m) only matches absolute
        // end, so a `\n$` lookahead silently dropped the whole section whenever
        // it was last in a file with no trailing newline.
        const objectivesMatch = body.match(
            /##\s+(?:🔮\s+)?Objectives for Tomorrow\s*\n([\s\S]*?)(?=\n##\s|\n---|\s*$)/i
        );
        if (!objectivesMatch) return [];

        const section = objectivesMatch[1];
        const items = [];

        // Extract numbered items (### N. Title) or bullet points
        const headings = section.matchAll(/###\s+\d+\.\s+(.+)/g);
        for (const m of headings) {
            items.push(m[1].trim());
        }

        // If no sub-headings, try bullet points
        if (items.length === 0) {
            const bullets = section.matchAll(/^\s*[-*]\s+\*\*(.+?)\*\*/gm);
            for (const m of bullets) {
                items.push(m[1].trim());
            }
        }

        // Fallback: plain bullets
        if (items.length === 0) {
            const plainBullets = section.matchAll(/^\s*[-*]\s+(.+)/gm);
            for (const m of plainBullets) {
                const text = m[1].trim();
                if (text.length > 10 && text.length < 200) {
                    items.push(text);
                }
            }
        }

        return items.slice(0, 10); // cap at 10
    }

    /**
     * Extract key decisions from section headings and their first paragraph.
     * Each ## section (excluding standard boilerplate) becomes a decision row.
     */
    extractDecisions(body) {
        const decisions = [];
        const skipSections = [
            'mission summary', 'mission accomplished', 'objectives for tomorrow',
            'value estimation', 'value created', 'daily sitrep'
        ];

        // Split on ## headings
        const sections = body.split(/(?=^## )/m).filter(s => s.trim());

        for (const section of sections) {
            const headingMatch = section.match(/^##\s+(?:🏁\s+|🔮\s+|🛡️\s+|🔧\s+)?(.+)/);
            if (!headingMatch) continue;

            const heading = headingMatch[1].trim()
                .replace(/[🏁🔮🛡️🔧]/g, '').trim();
            const headingLower = heading.toLowerCase();

            // Skip boilerplate sections
            if (skipSections.some(s => headingLower.includes(s))) continue;

            // Get first meaningful paragraph after heading
            const lines = section.split('\n').slice(1);
            let rationale = '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|') || trimmed === '---') continue;
                // Strip markdown formatting
                rationale = trimmed
                    .replace(/\*\*(.+?)\*\*/g, '$1')
                    .replace(/\*(.+?)\*/g, '$1')
                    .replace(/`(.+?)`/g, '$1');
                break;
            }

            if (rationale.length > 200) {
                rationale = rationale.slice(0, 197) + '...';
            }

            // Escape pipes for markdown table
            const safeDecision = heading.replace(/\|/g, '\\|');
            const safeRationale = rationale.replace(/\|/g, '\\|');

            if (safeDecision && safeRationale) {
                decisions.push({ decision: safeDecision, rationale: safeRationale });
            }
        }

        return decisions.slice(0, 10); // cap at 10
    }
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

function printUsage() {
    console.log(`Memory Ingester — Convert legacy daily recaps to daily log format

Usage:
  node memory-ingester.js ingest <source-dir> [--dry-run] [--output-dir <dir>]
  node memory-ingester.js status <source-dir> [--output-dir <dir>]

Options:
  --dry-run       Show what would be written without writing files
  --output-dir    Override output directory (default: docs/.output/.state/memory-daily/)

Source format:  daily_recap_YYYY_MM_DD.md (narrative recaps with YAML frontmatter)
Target format:  YYYY-MM-DD.md (daily log entries for memory-extractor.js, manual Haiku pipeline)
Pipeline:       memory-ingester.js (this tool) → docs/.output/.state/memory-daily/YYYY-MM-DD.md → memory-extractor.js (manual Haiku pipeline, brownfield only) → memory-manager.js create`);
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command || command === '--help' || command === '-h') {
        printUsage();
        process.exit(0);
    }

    // Parse flags
    const dryRun = args.includes('--dry-run');
    const outputDirIdx = args.indexOf('--output-dir');
    const outputDir = outputDirIdx !== -1 ? args[outputDirIdx + 1] : undefined;

    // Find source dir (first non-flag argument after command)
    const sourceDir = args.find((a, i) => i > 0 && !a.startsWith('--') && (outputDirIdx === -1 || i !== outputDirIdx + 1));

    if (!sourceDir) {
        console.error('Error: <source-dir> is required');
        printUsage();
        process.exit(1);
    }

    if (!fs.existsSync(sourceDir)) {
        console.error(`Error: source directory not found: ${sourceDir}`);
        process.exit(1);
    }

    const ingester = new MemoryIngester(outputDir);

    switch (command) {
        case 'ingest':
            ingester.ingest(sourceDir, { dryRun });
            break;
        case 'status':
            ingester.status(sourceDir);
            break;
        default:
            console.error(`Unknown command: ${command}`);
            printUsage();
            process.exit(1);
    }
}

module.exports = MemoryIngester;
