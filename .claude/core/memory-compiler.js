#!/usr/bin/env node

/**
 * Memory Compiler - Consolidates daily log files into concept articles
 *
 * Reads daily logs from docs/.output/.state/memory-daily/{YYYY-MM-DD}.md
 * Writes concept articles to docs/.output/.state/memory-concepts/{category}/{slug}.md
 * Generates docs/.output/.state/memory-concepts/index.md
 *
 * Idempotent: re-running updates existing concepts, does not duplicate.
 * Daily logs are never deleted — they are the audit trail.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const CONSTANTS = require('./constants');
const { jaccardFromSets } = require('./_lib/jaccard');
const { parseFrontmatter: parseFm } = require('./_lib/frontmatter');
const {
    parseDailyFile: parseDailyFileLib,
    extractKeywords: extractKeywordsLib,
} = require('./_lib/daily-log-parser');
const { writeConceptArticle: writeConceptArticleLib } = require('./_lib/concept-article');
const {
    generateIndex: generateIndexLib,
    injectRelatedConcepts: injectRelatedConceptsLib,
} = require('./_lib/concept-index');
const { generateCrossReferences: generateCrossReferencesLib } = require('./_lib/cross-references');
const { scanConceptFiles } = require('./_lib/concept-reader');
const { memoryPaths } = require('./_lib/memory-paths');

const CATEGORIES = Object.values(CONSTANTS.MEMORY_CATEGORIES);

// Jaccard similarity threshold for grouping entries under a concept
const SIMILARITY_THRESHOLD = 0.3;

// Jaccard similarity threshold for cross-reference (below merge threshold)
const CROSS_REF_THRESHOLD = 0.15;

// Default confidence for compiled concepts
const DEFAULT_CONFIDENCE = 0.6;

// Category detection signals (checked against lowercased entry text)
// ORDER MATTERS: first match wins in getCategoryForEntry. rejected-approaches is
// checked first so its stronger signals ("didn't work", "reverted") don't get
// swallowed by the looser "pattern" / "approach" keywords.
const CATEGORY_SIGNALS = {
    'rejected-approaches': ['rejected', "didn't work", 'did not work', 'failed approach', 'tried but', 'reverted', 'backed out', "doesn't solve", 'does not solve', 'abandoned', 'gave up on'],
    decisions:   ['decision', 'rationale', 'chose', 'choosing', 'decided', 'choose'],
    patterns:    ['pattern', 'approach', 'strategy', 'convention', 'practice'],
    constraints: ['constraint', 'limitation', 'cannot', 'blocked', 'blocker', 'must not', 'restriction']
    // workflows: default when no other signals match
};

class MemoryCompiler {
    constructor() {
        // Worktree-safe resolution (M5): gitignored .state/ dirs anchor to the MAIN
        // worktree via memoryPaths() — the old per-__dirname fallback wrote compiled
        // concept articles into a linked worktree's own .state/ that vanishes with it.
        const paths = memoryPaths(path.resolve(__dirname, '..', '..'));
        this.dailyDir    = paths.dailyDir;
        this.conceptsDir = paths.conceptsDir;
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Main compilation pipeline.
     * Reads all daily logs, groups entries into concept articles, writes output.
     */
    async compile() {
        console.log('Memory Compiler — starting compile...\n');

        // 1. Read all daily log files
        const dailyFiles = await this.readDailyFiles();
        if (dailyFiles.length === 0) {
            console.log('No daily log files found in', this.dailyDir);
            return;
        }
        console.log(`Found ${dailyFiles.length} daily log file(s).`);

        // 2. Parse each file into entries
        const allEntries = [];
        for (const { date, content } of dailyFiles) {
            const entries = this.parseDailyFile(content, date);
            allEntries.push(...entries);
        }
        console.log(`Parsed ${allEntries.length} log entry/entries.`);

        if (allEntries.length === 0) {
            console.log('No parseable entries found. Nothing to compile.');
            return;
        }

        // 3. Extract keywords from each entry
        for (const entry of allEntries) {
            entry.keywords = this.extractKeywords(entry);
        }

        // 4. Group entries by topic similarity
        const groups = this.groupEntries(allEntries);
        console.log(`Formed ${groups.length} concept group(s).`);

        // 5. Ensure concept category dirs exist
        fsSync.mkdirSync(this.conceptsDir, { recursive: true });
        for (const cat of CATEGORIES) {
            fsSync.mkdirSync(path.join(this.conceptsDir, cat), { recursive: true });
        }

        // 6. Write or update concept articles
        const writtenConcepts = [];
        for (const group of groups) {
            const concept = await this.writeConceptArticle(group);
            if (concept) writtenConcepts.push(concept);
        }

        // 7-9 share ONE concepts-tree scan (F4): read after step 6 so freshly
        // written articles are included, then thread the parsed list through
        // index generation, cross-references, and Related-Concepts injection —
        // previously each step independently re-walked and re-parsed the tree.
        const conceptScan = await scanConceptFiles({ conceptsDir: this.conceptsDir, categories: CATEGORIES });

        // 7. Generate index
        await this.generateIndex(writtenConcepts, conceptScan);

        // 8. Generate cross-references
        const crossRefCount = await this.generateCrossReferences(conceptScan);
        console.log(`Cross-references: ${crossRefCount} pair(s) found.`);

        // 9. Inject Related Concepts sections with [[wiki-links]] (Obsidian compat)
        await this.injectRelatedConcepts(writtenConcepts, conceptScan);

        console.log(`\nDone. ${writtenConcepts.length} concept article(s) written.`);
        console.log(`Index: ${path.join(this.conceptsDir, 'index.md')}`);
    }

    /**
     * Print statistics about daily logs and compiled concepts.
     */
    async status() {
        console.log('Memory Compiler — status\n');

        // Daily log count
        let dailyCount = 0;
        try {
            const files = await fs.readdir(this.dailyDir);
            dailyCount = files.filter(f => f.endsWith('.md')).length;
        } catch {
            // dir may not exist yet
        }

        // Concept count (across all category subdirs)
        let conceptCount = 0;
        let lastCompile = null;
        for (const cat of CATEGORIES) {
            const catDir = path.join(this.conceptsDir, cat);
            try {
                const files = await fs.readdir(catDir);
                conceptCount += files.filter(f => f.endsWith('.md')).length;
            } catch {
                // category dir may not exist yet
            }
        }

        // Last compile date from index.md
        const indexPath = path.join(this.conceptsDir, 'index.md');
        try {
            const indexContent = await fs.readFile(indexPath, 'utf-8');
            const match = indexContent.match(/Last compiled: (.+)/);
            if (match) lastCompile = match[1].trim();
        } catch {
            // index may not exist
        }

        console.log(`Daily log files : ${dailyCount}`);
        console.log(`Concept articles: ${conceptCount}`);
        console.log(`Last compile    : ${lastCompile || 'never'}`);
        console.log(`Daily dir       : ${this.dailyDir}`);
        console.log(`Concepts dir    : ${this.conceptsDir}`);
    }

    /**
     * Slugify a title to a safe filename (without extension).
     * e.g. "JWT Token Strategy" → "jwt-token-strategy"
     */
    getConceptId(title) {
        return title
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .slice(0, 80);
    }

    /**
     * Convert ISO timestamp to YYYY-MM-DD for Dataview compatibility.
     * Passes through already-short dates unchanged.
     */
    formatDateOnly(isoOrDate) {
        if (!isoOrDate) return new Date().toISOString().slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(isoOrDate)) return isoOrDate;
        return isoOrDate.slice(0, 10);
    }

    /**
     * Add [[wiki-links]] to daily log date headings in evidence text.
     * Transforms: ### 2026-01-13 00:00 → ### 2026-01-13 00:00 — [[2026-01-13]]
     * Idempotent: only matches headings without existing backlinks.
     */
    addDailyBacklinks(evidenceText) {
        return evidenceText.replace(
            /^### (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/gm,
            '### $1 $2 — [[$1]]'
        );
    }

    // -------------------------------------------------------------------------
    // File I/O helpers
    // -------------------------------------------------------------------------

    /**
     * Read all .md files from dailyDir, return array of { date, content }.
     * Gracefully returns [] if dir does not exist.
     */
    async readDailyFiles() {
        try {
            const files = await fs.readdir(this.dailyDir);
            const mdFiles = files
                .filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
                .sort(); // chronological order

            const results = [];
            for (const file of mdFiles) {
                const date = file.replace('.md', '');
                try {
                    const content = await fs.readFile(path.join(this.dailyDir, file), 'utf-8');
                    results.push({ date, content });
                } catch {
                    console.warn(`Warning: could not read ${file}, skipping.`);
                }
            }
            return results;
        } catch {
            return [];
        }
    }

    // -------------------------------------------------------------------------
    // Parsing
    // -------------------------------------------------------------------------

    /**
     * Split a daily log file into individual compaction entries.
     * Thin adapter over _lib/daily-log-parser.js — preserves instance-method API.
     * Returns shape {date, time, heading, rawText}; callers using only
     * {date, time, rawText} can ignore the extra `heading` field.
     */
    parseDailyFile(content, date) {
        return parseDailyFileLib(content, date);
    }

    // -------------------------------------------------------------------------
    // Keyword extraction
    // -------------------------------------------------------------------------

    /**
     * Extract meaningful keywords from an entry.
     * Pulls: branch name, commit subjects (first 4 words), story names, decision topics.
     * Returns a Set of lowercased keyword tokens.
     */
    extractKeywords(entry) {
        return extractKeywordsLib(entry);
    }

    // -------------------------------------------------------------------------
    // Grouping
    // -------------------------------------------------------------------------

    /**
     * Group entries by topic similarity using Jaccard index.
     * Two entries are grouped if their keyword overlap ≥ SIMILARITY_THRESHOLD.
     * Uses union-find (greedy single-link clustering) for transitivity.
     * Returns array of groups, each group = array of entries.
     */
    groupEntries(entries) {
        // Union-find parent array
        const parent = entries.map((_, i) => i);

        function find(i) {
            if (parent[i] !== i) parent[i] = find(parent[i]);
            return parent[i];
        }

        function union(i, j) {
            parent[find(i)] = find(j);
        }

        // Compare all pairs
        for (let i = 0; i < entries.length; i++) {
            for (let j = i + 1; j < entries.length; j++) {
                const sim = jaccardFromSets(entries[i].keywords, entries[j].keywords);
                if (sim >= SIMILARITY_THRESHOLD) {
                    union(i, j);
                }
            }
        }

        // Collect groups
        const groupMap = new Map();
        for (let i = 0; i < entries.length; i++) {
            const root = find(i);
            if (!groupMap.has(root)) groupMap.set(root, []);
            groupMap.get(root).push(entries[i]);
        }

        return Array.from(groupMap.values());
    }

    // -------------------------------------------------------------------------
    // Category detection
    // -------------------------------------------------------------------------

    /**
     * Determine the category for a group of entries based on content signals.
     */
    detectCategory(entries) {
        const combined = entries.map(e => e.rawText).join('\n').toLowerCase();

        for (const [category, signals] of Object.entries(CATEGORY_SIGNALS)) {
            for (const signal of signals) {
                if (combined.includes(signal)) return category;
            }
        }

        return 'workflows'; // default
    }

    // -------------------------------------------------------------------------
    // Title generation
    // -------------------------------------------------------------------------

    /**
     * Generate a descriptive title from the most common keywords in the group.
     * Takes the top 3 most-frequent keywords and formats them as a title.
     */
    generateTitle(entries) {
        const freq = new Map();
        for (const entry of entries) {
            for (const kw of entry.keywords) {
                freq.set(kw, (freq.get(kw) || 0) + 1);
            }
        }

        // Sort by frequency descending, take top 3
        const topKeywords = Array.from(freq.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([kw]) => kw);

        if (topKeywords.length === 0) return 'Unnamed Concept';

        // Capitalize each word
        return topKeywords.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    // -------------------------------------------------------------------------
    // Summary generation
    // -------------------------------------------------------------------------

    /**
     * Generate a 1-2 sentence summary from the group.
     * Pulls branch name and key decision or in-progress item as anchors.
     */
    generateSummary(entries, category) {
        const branches = new Set();
        const storyNames = [];
        const decisionTexts = [];

        for (const entry of entries) {
            const branchMatch = entry.rawText.match(/\*\*Branch:\*\*\s*(.+)/);
            if (branchMatch) branches.add(branchMatch[1].trim());

            const inProgressSection = entry.rawText.match(/### In-Progress Work\s*([\s\S]*?)(?=\n###|\n##|$)/);
            if (inProgressSection) {
                const lines = inProgressSection[1].split('\n').filter(l => l.includes('[>]'));
                for (const line of lines) {
                    const m = line.match(/\[>\]\s*(.+?)(?:\s*\(|$)/);
                    if (m) storyNames.push(m[1].trim());
                }
            }

            const decisionsSection = entry.rawText.match(/### Key Decisions\s*([\s\S]*?)(?=\n##|$)/);
            if (decisionsSection) {
                const rows = decisionsSection[1].split('\n')
                    .filter(r => r.startsWith('|') && !r.includes('---') && !r.match(/Decision.*Rationale/i));
                for (const row of rows) {
                    const cells = row.split('|').map(c => c.trim()).filter(c => c);
                    if (cells[0]) decisionTexts.push(cells[0]);
                }
            }
        }

        const branchList = Array.from(branches).slice(0, 2).join(', ');
        let sentence1 = `Activity observed across ${entries.length} compaction snapshot(s)`;
        if (branchList) sentence1 += ` on branch(es): ${branchList}`;
        sentence1 += '.';

        let sentence2 = '';
        if (category === 'decisions' && decisionTexts.length > 0) {
            sentence2 = `Key decisions recorded: ${decisionTexts.slice(0, 2).join('; ')}.`;
        } else if (storyNames.length > 0) {
            sentence2 = `In-progress work included: ${storyNames.slice(0, 2).join('; ')}.`;
        }

        return sentence2 ? `${sentence1} ${sentence2}` : sentence1;
    }

    // -------------------------------------------------------------------------
    // Concept article writing
    // -------------------------------------------------------------------------

    /**
     * Write or update a concept article for a group of entries.
     * Thin wrapper over _lib/concept-article.js — injects compiler's own
     * detection/generation methods as closures.
     */
    async writeConceptArticle(group) {
        return writeConceptArticleLib(group, {
            conceptsDir: this.conceptsDir,
            detectCategory:    (g) => this.detectCategory(g),
            generateTitle:     (g) => this.generateTitle(g),
            getConceptId:      (t) => this.getConceptId(t),
            generateSummary:   (g, c) => this.generateSummary(g, c),
            addDailyBacklinks: (t) => this.addDailyBacklinks(t),
            formatDateOnly:    (iso) => this.formatDateOnly(iso),
        });
    }

    // -------------------------------------------------------------------------
    // Obsidian: Related Concepts injection
    // -------------------------------------------------------------------------

    /**
     * Inject Related Concepts sections — thin wrapper over _lib/concept-index.
     */
    async injectRelatedConcepts(writtenConcepts, conceptScan) {
        return injectRelatedConceptsLib(writtenConcepts, {
            conceptsDir: this.conceptsDir,
            categories: CATEGORIES,
            conceptScan,
        });
    }

    // -------------------------------------------------------------------------
    // Frontmatter parsing
    // -------------------------------------------------------------------------

    /**
     * Parse YAML frontmatter from a markdown file.
     * Thin adapter over _lib/frontmatter.js — preserves instance-method API for tests.
     */
    parseFrontmatter(content) {
        return parseFm(content);
    }

    // -------------------------------------------------------------------------
    // Index generation
    // -------------------------------------------------------------------------

    /**
     * Generate the MOC index — thin wrapper over _lib/concept-index.
     */
    async generateIndex(concepts, conceptScan) {
        return generateIndexLib(concepts, {
            conceptsDir: this.conceptsDir,
            categories: CATEGORIES,
            formatDateOnly: (iso) => this.formatDateOnly(iso),
            conceptScan,
        });
    }

    // -------------------------------------------------------------------------
    // Cross-reference generation
    // -------------------------------------------------------------------------

    /**
     * Generate cross-references — thin wrapper over _lib/cross-references.
     */
    async generateCrossReferences(conceptScan) {
        return generateCrossReferencesLib({
            conceptsDir: this.conceptsDir,
            categories: CATEGORIES,
            crossRefThreshold: CROSS_REF_THRESHOLD,
            similarityThreshold: SIMILARITY_THRESHOLD,
            conceptScan,
        });
    }
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

async function main() {
    const compiler = new MemoryCompiler();
    const [,, command] = process.argv;

    switch (command) {
        case 'compile':
            await compiler.compile();
            break;
        case 'status':
            await compiler.status();
            break;
        default:
            console.log('Usage:\n  node memory-compiler.js compile\n  node memory-compiler.js status');
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error:', err.message);
        process.exit(1);
    });
}

module.exports = MemoryCompiler;
