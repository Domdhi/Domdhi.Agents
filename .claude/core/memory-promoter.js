#!/usr/bin/env node

/**
 * Memory Promoter - Scans concept articles for promotion candidates
 *
 * Reads compiled concept articles from docs/.output/.state/memory-concepts/{category}/
 * Ranks by composite score: decayed_confidence * (1 + usage_boost) * (1 + cross_ref_density)
 * Surfaces candidates for human-gated promotion into templates, skills, and agents.
 *
 * CLI:
 *   node memory-promoter.js scan [--top N]    — list promotion candidates
 *   node memory-promoter.js mark <slug> <target> — mark a concept as promoted
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const CONSTANTS = require('./constants');
const { calculateDecayedConfidence, createActiveDaysResolver } = require('./_lib/memory-decay');
const { parseFrontmatter: parseFm } = require('./_lib/frontmatter');
const { readConcepts } = require('./_lib/concept-reader');
const { resolveProjectRoot } = require('./_lib/project-root');
const { memoryPaths } = require('./_lib/memory-paths');

const CATEGORIES = Object.values(CONSTANTS.MEMORY_CATEGORIES);

// Target suggestions by category
const TARGET_SUGGESTIONS = {
    decisions: 'CLAUDE.md',
    patterns: 'relevant SKILL.md',
    constraints: 'architecture/overview.md template',
    workflows: 'agent frontmatter',
    'rejected-approaches': 'docs/.output/findings/investigations/ or CLAUDE.md dead-ends section'
};

class MemoryPromoter {
    constructor() {
        // Worktree-safe resolution (M5), mirroring memory-manager.js's constructor:
        // the tracked .memory/ source follows the CURRENT worktree while the
        // gitignored .state/ half is anchored to the MAIN worktree — memoryPaths()
        // splits both correctly. The git-history root (active-days) uses the main
        // worktree. The naive per-__dirname fallback reintroduced the git-worktree
        // memory-loss bug _lib/project-root.js documents fixing.
        const fallbackDir = path.resolve(__dirname, '..', '..');
        const projectRoot = resolveProjectRoot(fallbackDir);
        const paths = memoryPaths(fallbackDir);
        // Split store (ADR 0006 Am. 2): JSON categories under .memory/; derived
        // concept articles under .state/memory-concepts.
        this.memoriesDir = paths.jsonRoot;
        this.conceptsDir = paths.conceptsDir;
        this._activeDaysResolver = createActiveDaysResolver({ projectRoot });
    }

    /**
     * Scan all concept articles and return ranked promotion candidates.
     */
    async scan(options = {}) {
        const top = options.top || 10;

        const compiledConcepts = await this.loadConcepts();
        const handCurated = await this.loadHandCreatedMemories();
        const concepts = [...compiledConcepts, ...handCurated];
        if (concepts.length === 0) {
            console.log('No concept articles found. Run `node memory-extractor.js extract` (manual Haiku) or create memories via `memory-manager.js create`.');
            return [];
        }

        const crossRefs = await this.loadCrossReferences();
        const totalConcepts = concepts.length;

        const candidates = [];
        for (const concept of concepts) {
            if (!this.isEligible(concept)) continue;

            const score = this.calculatePromotionScore(concept, crossRefs, totalConcepts);
            const crossRefCount = (crossRefs[concept.slug]?.related || []).length;

            candidates.push({
                slug: concept.slug,
                title: concept.title,
                category: concept.category,
                promotionScore: Math.round(score * 1000) / 1000,
                decayedConfidence: Math.round(concept.decayedConfidence * 1000) / 1000,
                sourceCount: concept.sources.length,
                crossRefCount,
                suggestedTarget: TARGET_SUGGESTIONS[concept.category] || 'CLAUDE.md'
            });
        }

        // Sort by promotion score descending
        candidates.sort((a, b) => b.promotionScore - a.promotionScore);

        const result = candidates.slice(0, top);

        if (result.length === 0) {
            console.log('No concepts meet promotion criteria.');
            console.log('Eligibility: decayed confidence >= 0.5, not already promoted.');
            console.log('  Compiled concepts also need sources >= 2 daily log dates (single-snapshot noise filter).');
            console.log('  Hand-created memories (memory-manager.js create) bypass the sources check.');
            console.log('\nRun /review:memory-health to check pipeline status.');
            return [];
        }

        console.log(`Found ${candidates.length} eligible candidate(s). Showing top ${result.length}:\n`);
        console.log('| Rank | Title | Category | Score | Confidence | Sources | Cross-Refs | Suggested Target |');
        console.log('|------|-------|----------|-------|------------|---------|------------|-----------------|');
        for (let i = 0; i < result.length; i++) {
            const c = result[i];
            console.log(`| ${i + 1} | ${c.title} | ${c.category} | ${c.promotionScore} | ${c.decayedConfidence} | ${c.sourceCount} | ${c.crossRefCount} | ${c.suggestedTarget} |`);
        }

        return result;
    }

    /**
     * Mark a concept as promoted.
     *
     * Searches both the compiled markdown path (`concepts/{cat}/{slug}.md`) and the
     * hand-created JSON path (`{cat}/{slug}.json`). Markdown wins when both exist.
     *
     * Markdown path: inserts `promoted_to` and `promoted_at` into the YAML frontmatter.
     * JSON path: shallow-merges those fields into `metadata`.
     */
    async mark(slug, target) {
        const today = new Date().toISOString().slice(0, 10);

        // Try compiled markdown path first (preserves prior precedence — same slug
        // shouldn't live in both, but if it does, markdown wins).
        let filePath = null;
        let category = null;
        for (const cat of CATEGORIES) {
            const candidate = path.join(this.conceptsDir, cat, `${slug}.md`);
            try {
                await fs.access(candidate);
                filePath = candidate;
                category = cat;
                break;
            } catch {
                // not in this category
            }
        }

        if (filePath) {
            const content = await fs.readFile(filePath, 'utf-8');
            const frontmatterMatch = content.match(/^(---\n[\s\S]*?\n)(---)/);
            if (!frontmatterMatch) {
                console.error(`No frontmatter found in ${filePath}`);
                process.exit(1);
            }

            if (content.includes('promoted_to:')) {
                console.error(`Concept "${slug}" is already promoted. Current frontmatter contains promoted_to.`);
                process.exit(1);
            }

            const newFrontmatter = frontmatterMatch[1] +
                `promoted_to: ${target}\n` +
                `promoted_at: ${today}\n` +
                frontmatterMatch[2];

            const newContent = content.replace(frontmatterMatch[0], newFrontmatter);
            await fs.writeFile(filePath, newContent, 'utf-8');

            console.log(`Marked ${category}/${slug}.md as promoted.`);
            console.log(`  promoted_to: ${target}`);
            console.log(`  promoted_at: ${today}`);
            return;
        }

        // Fall back to hand-created JSON path
        let jsonPath = null;
        let jsonCategory = null;
        for (const cat of CATEGORIES) {
            const candidate = path.join(this.memoriesDir, cat, `${slug}.json`);
            try {
                await fs.access(candidate);
                jsonPath = candidate;
                jsonCategory = cat;
                break;
            } catch {
                // not in this category
            }
        }

        if (jsonPath) {
            const raw = await fs.readFile(jsonPath, 'utf-8');
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch {
                console.error(`Malformed JSON in ${jsonPath}`);
                process.exit(1);
            }

            if (parsed.metadata?.promoted_to) {
                console.error(`Concept "${slug}" is already promoted. metadata.promoted_to is set.`);
                process.exit(1);
            }

            parsed.metadata = { ...(parsed.metadata || {}), promoted_to: target, promoted_at: today };
            await fs.writeFile(jsonPath, JSON.stringify(parsed, null, 2), 'utf-8');

            console.log(`Marked ${jsonCategory}/${slug}.json as promoted.`);
            console.log(`  promoted_to: ${target}`);
            console.log(`  promoted_at: ${today}`);
            return;
        }

        // Neither path found
        const mdPaths = CATEGORIES.map(c => `concepts/${c}/${slug}.md`).join(', ');
        const jsonPaths = CATEGORIES.map(c => `${c}/${slug}.json`).join(', ');
        console.error(`Concept "${slug}" not found in any category.`);
        console.error(`Searched: ${mdPaths}, ${jsonPaths}`);
        process.exit(1);
    }

    /**
     * Calculate promotion score for a concept.
     * Formula: decayed_confidence * (1 + usage_boost) * (1 + cross_ref_density)
     */
    calculatePromotionScore(concept, crossRefs, totalConcepts) {
        const usageBoost = Math.min((concept.usageCount || 0) * 0.1, 1.0);
        const relatedCount = (crossRefs[concept.slug]?.related || []).length;
        const crossRefDensity = totalConcepts > 0 ? relatedCount / totalConcepts : 0;
        return concept.decayedConfidence * (1 + usageBoost) * (1 + crossRefDensity);
    }

    /**
     * Check if a concept is eligible for promotion.
     * Requirements: decayed confidence >= 0.5, not already promoted, AND
     *   - hand-curated: any sources count (the human curated it intentionally), OR
     *   - compiled:     sources >= 2 (filters single-snapshot noise from the daily-log compiler)
     */
    isEligible(concept) {
        if (concept.decayedConfidence < 0.5) return false;
        if (concept.promotedTo) return false;
        if (concept.handCurated) return true;
        if (concept.sources.length < 2) return false;
        return true;
    }

    /**
     * Load all concept articles from disk.
     * Thin adapter over _lib/concept-reader.js; strips the `content` field
     * that the shared reader includes but promoter doesn't need.
     */
    async loadConcepts() {
        const concepts = await readConcepts({
            conceptsDir: this.conceptsDir,
            categories: CATEGORIES,
            activeDaysResolver: this._activeDaysResolver,
        });
        // eslint-disable-next-line no-unused-vars
        return concepts.map(({ content, ...rest }) => rest);
    }

    /**
     * Load hand-created JSON memories from `docs/.output/.memory/{category}/*.json`.
     *
     * These are written by `node memory-manager.js create <category> <slug> '{...}'`
     * and represent intentional human curation — they bypass the sources>=2 filter
     * that exists to suppress single-snapshot noise from the daily-log compiler.
     *
     * Mapped to the same concept shape as loadConcepts() with `handCurated: true`
     * so downstream code (isEligible, scan ranking) can treat both uniformly.
     */
    async loadHandCreatedMemories() {
        const concepts = [];

        for (const category of CATEGORIES) {
            const catDir = path.join(this.memoriesDir, category);
            let files;
            try {
                files = await fs.readdir(catDir);
            } catch {
                continue; // category dir may not exist
            }

            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                try {
                    const filePath = path.join(catDir, file);
                    const raw = await fs.readFile(filePath, 'utf-8');
                    const memory = JSON.parse(raw);

                    const slug = file.replace('.json', '');
                    const confidence = parseFloat(memory.content?.confidence ?? memory.metadata?.confidence) || 0.6;
                    const updated = memory.updated || new Date().toISOString();
                    const usageCount = parseInt(memory.usage_count) || 0;

                    const decayed = calculateDecayedConfidence({
                        confidence,
                        category,
                        usageCount,
                        updated,
                        activeDays: this._activeDaysResolver.getActiveDaysSince(updated),
                    });

                    const title = slug
                        .split('-')
                        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                        .join(' ');

                    concepts.push({
                        slug,
                        title,
                        category,
                        confidence,
                        decayedConfidence: decayed,
                        sources: [],
                        usageCount,
                        promotedTo: memory.metadata?.promoted_to || null,
                        updated,
                        handCurated: true
                    });
                } catch {
                    // skip unreadable / malformed JSON files
                }
            }
        }

        return concepts;
    }

    /**
     * Load cross-references.json. Returns empty object if file doesn't exist.
     */
    async loadCrossReferences() {
        const crossRefPath = path.join(this.conceptsDir, 'cross-references.json');
        try {
            const content = await fs.readFile(crossRefPath, 'utf-8');
            return JSON.parse(content);
        } catch {
            return {};
        }
    }

    /**
     * Parse YAML frontmatter from a markdown file.
     * Thin adapter over _lib/frontmatter.js.
     */
    parseFrontmatter(content) {
        return parseFm(content);
    }
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

async function main() {
    const promoter = new MemoryPromoter();
    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
        case 'scan': {
            const topIdx = args.indexOf('--top');
            const top = topIdx !== -1 ? parseInt(args[topIdx + 1]) || 10 : 10;
            await promoter.scan({ top });
            break;
        }
        case 'mark': {
            const slug = args[1];
            const target = args.slice(2).join(' ');
            if (!slug || !target) {
                console.error('Usage: node memory-promoter.js mark <slug> <target>');
                console.error('Example: node memory-promoter.js mark error-handling-strategies skills/qa-engineer/SKILL.md');
                process.exit(1);
            }
            await promoter.mark(slug, target);
            break;
        }
        default:
            console.log(`Memory Promoter — scan and promote high-confidence concepts

Usage:
  node memory-promoter.js scan [--top N]       List promotion candidates (default: top 10)
  node memory-promoter.js mark <slug> <target> Mark a concept as promoted to a target file

Eligibility criteria:
  - Decayed confidence >= 0.5
  - Not already promoted
  - Compiled concepts: sources >= 2 daily log dates (filters single-snapshot noise)
  - Hand-created memories: any sources (intentional human curation bypasses the filter)

Score formula:
  decayed_confidence * (1 + usage_boost) * (1 + cross_ref_density)

Target suggestions by category:
  decisions   → CLAUDE.md
  patterns    → relevant SKILL.md
  constraints → architecture/overview.md template
  workflows   → agent frontmatter`);
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error:', err.message);
        process.exit(1);
    });
}

module.exports = MemoryPromoter;
