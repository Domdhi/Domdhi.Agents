#!/usr/bin/env node

/**
 * Memory System Health Check
 * Validates memory system configuration and performance using constants
 */

const fs = require('fs').promises;
const path = require('path');
const CONSTANTS = require('./constants');
const MemoryManager = require('./memory-manager');

// Inbox drafts are transient by design (sub-agents drop, the Main Agent promotes
// or discards at /end). A pile-up this deep means the promotion loop is stalled,
// not merely busy.
const INBOX_BACKLOG_WARN = 10;

class MemoryHealthChecker {
    constructor() {
        this.manager = new MemoryManager();
        this.results = {
            passed: [],
            warnings: [],
            errors: []
        };
    }

    /**
     * Freshness of the derived FTS5 index vs the tracked JSON source. Same
     * staleness criterion as session-start-prime.cjs's maybeRebuildIndex():
     * newest .memory JSON mtime vs the db mtime (absent → 0). WARN, never ERROR
     * — the SessionStart hook self-heals, so staleness only degrades search to
     * the JSON-scan fallback in the meantime. MUST run before any db-opening
     * check (MemoryManager.initDb is lazy): a later check creating/writing the
     * db would freshen the very mtime this check reads.
     *
     * (Replaces the vestigial checkMemoryDirectories() — MemoryManager's
     * constructor self-heals the category dirs, so that check could never fail
     * in the real CLI flow.)
     */
    async checkIndexFreshness() {
        console.log('🗂️  Checking search-index freshness...');

        let newestJson = 0;
        for (const category of Object.values(CONSTANTS.MEMORY_CATEGORIES)) {
            const dir = path.join(this.manager.memoriesDir, category);
            let files;
            try { files = await fs.readdir(dir); } catch { continue; }
            for (const f of files) {
                if (!f.endsWith('.json')) continue;
                try {
                    const { mtimeMs } = await fs.stat(path.join(dir, f));
                    if (mtimeMs > newestJson) newestJson = mtimeMs;
                } catch { /* raced deletion — skip */ }
            }
        }
        if (newestJson === 0) {
            this.results.passed.push('✅ Index freshness: store empty — nothing to index');
            return;
        }

        let dbMtime = 0;
        try { dbMtime = (await fs.stat(this.manager.dbPath)).mtimeMs; } catch { dbMtime = 0; }

        if (dbMtime === 0) {
            this.results.warnings.push(
                '⚠️  FTS5 index absent — search falls back to a JSON linear scan until the next ' +
                'SessionStart self-heal (or run: node .claude/core/memory-manager-cli.js rebuild-index)'
            );
        } else if (dbMtime < newestJson) {
            this.results.warnings.push(
                '⚠️  FTS5 index STALE — curated JSON is newer than the index (typical after a git pull); ' +
                'rebuilds on next SessionStart, or run: node .claude/core/memory-manager-cli.js rebuild-index'
            );
        } else {
            this.results.passed.push('✅ FTS5 index fresh (newer than every curated JSON file)');
        }
    }

    /**
     * Inbox backlog: sub-agent draft memories awaiting Main-Agent promotion.
     * A persistent pile-up means /end's inbox-promote/discard loop is stalled.
     */
    async checkInboxBacklog() {
        console.log('📥 Checking memory-inbox backlog...');
        let drafts = [];
        try {
            drafts = (await fs.readdir(this.manager.inboxDir)).filter((f) => f.endsWith('.json'));
        } catch { /* absent dir → empty inbox */ }

        if (drafts.length === 0) {
            this.results.passed.push('✅ Memory inbox empty — no drafts awaiting promotion');
        } else if (drafts.length < INBOX_BACKLOG_WARN) {
            this.results.passed.push(
                `✅ Memory inbox: ${drafts.length} draft(s) pending (drained at /end via inbox-promote)`
            );
        } else {
            this.results.warnings.push(
                `⚠️  Memory inbox backlog: ${drafts.length} drafts (≥${INBOX_BACKLOG_WARN}) — the promotion ` +
                'loop may be stalled; run memory-manager.js inbox-list, then promote or discard'
            );
        }
    }

    async checkBackend() {
        console.log('🔎 Checking memory search backend...');
        const report = await this.manager.generateReport();
        const storage = report.storage || {};
        const { sqliteBackend, sqliteSupportsFts5 } = storage;

        if (sqliteSupportsFts5) {
            this.results.passed.push(
                `✅ FTS5 search active (backend: ${sqliteBackend})`
            );
        } else {
            // Genuine degradation only — on Node 24+ the built-in node:sqlite
            // ships FTS5 and this branch never fires. Warn, don't fail.
            this.results.warnings.push(
                `⚠️  FTS5 search unavailable (backend: ${sqliteBackend || 'json-only'}) — ` +
                `memory search is falling back to a slower JSON linear scan. ` +
                `To enable FTS5: run on Node 24+ (built-in node:sqlite ships FTS5, ` +
                `zero deps) or 'npm install' for the optional better-sqlite3 fallback.`
            );
        }
    }

    async checkMemoryPerformance() {
        console.log('⚡ Checking memory performance...');

        // Test memory creation speed.
        // Fixed key (not a timestamped id) + delete-after so the diagnostic never
        // pollutes the curated store. The old `health_check_${Date.now()}` left a
        // new junk memory on EVERY run, inflating the store unboundedly.
        const startCreate = Date.now();
        const testId = '_health_check_probe';
        // The probe writes into the git-TRACKED store (ADR 0006 Am. 2). Guard the
        // whole create→search→delete window in try/finally so an exception in the
        // intervening search (previously unwrapped, M6) can't leave the probe file
        // behind in a tracked category dir where a later commit could sweep it up.
        try {
            await this.manager.createMemory(CONSTANTS.MEMORY_CATEGORIES.PATTERNS, testId, {
                test: true,
                timestamp: new Date().toISOString()
            });
            const createTime = Date.now() - startCreate;

            if (createTime < CONSTANTS.PERFORMANCE.CACHE_HIT_MS * 10) { // Should be very fast
                this.results.passed.push(`✅ Memory creation: ${createTime}ms (excellent)`);
            } else if (createTime < CONSTANTS.PERFORMANCE.CACHE_HIT_MS * 100) {
                this.results.warnings.push(`⚠️  Memory creation: ${createTime}ms (acceptable)`);
            } else {
                this.results.errors.push(`❌ Memory creation: ${createTime}ms (too slow)`);
            }

            // Test memory search speed
            const startSearch = Date.now();
            await this.manager.searchMemories('test');
            const searchTime = Date.now() - startSearch;

            if (searchTime < CONSTANTS.PERFORMANCE.SIMPLE_QUERY_MS) {
                this.results.passed.push(`✅ Memory search: ${searchTime}ms (within target)`);
            } else {
                this.results.warnings.push(`⚠️  Memory search: ${searchTime}ms (exceeds ${CONSTANTS.PERFORMANCE.SIMPLE_QUERY_MS}ms target)`);
            }
        } finally {
            // Clean up the probe — diagnostics must not accumulate in the curated store.
            try {
                await this.manager.deleteMemory(CONSTANTS.MEMORY_CATEGORIES.PATTERNS, testId);
            } catch { /* non-fatal — fixed key means next run overwrites anyway */ }
        }
    }

    async checkMemoryQuality() {
        console.log('📊 Checking memory quality metrics...');

        const report = await this.manager.generateReport();

        for (const [category, data] of Object.entries(report.categories)) {
            if (data.count === 0) {
                this.results.warnings.push(`⚠️  Category '${category}' is empty`);
                continue;
            }

            // Check average confidence
            if (data.avg_confidence >= CONSTANTS.MEMORY_FILTERS.HIGH_CONFIDENCE_THRESHOLD) {
                this.results.passed.push(
                    `✅ ${category}: High confidence (${data.avg_confidence.toFixed(2)})`
                );
            } else if (data.avg_confidence > 0.5) {
                this.results.warnings.push(
                    `⚠️  ${category}: Medium confidence (${data.avg_confidence.toFixed(2)})`
                );
            } else {
                this.results.errors.push(
                    `❌ ${category}: Low confidence (${data.avg_confidence.toFixed(2)})`
                );
            }

            // Check usage patterns
            if (data.total_usage >= CONSTANTS.MEMORY_FILTERS.HIGH_USAGE_THRESHOLD) {
                this.results.passed.push(
                    `✅ ${category}: Well-used (${data.total_usage} total uses)`
                );
            }
        }
    }

    async checkRecentMemories() {
        console.log('📅 Checking recent memory updates...');

        let recentCount = 0;
        let oldCount = 0;

        for (const category of Object.values(CONSTANTS.MEMORY_CATEGORIES)) {
            const memories = await this.manager.listMemories(category);

            for (const memory of memories) {
                const daysSinceUpdate =
                    (Date.now() - new Date(memory.updated)) / CONSTANTS.TIME.MS_PER_DAY;

                if (daysSinceUpdate <= CONSTANTS.MEMORY_FILTERS.RECENT_DAYS) {
                    recentCount++;
                } else if (daysSinceUpdate > CONSTANTS.MEMORY_FILTERS.RECENT_DAYS * 4) {
                    oldCount++;
                }
            }
        }

        if (recentCount > 0) {
            this.results.passed.push(
                `✅ ${recentCount} memories updated in last ${CONSTANTS.MEMORY_FILTERS.RECENT_DAYS} days`
            );
        }

        if (oldCount > 0) {
            this.results.warnings.push(
                `⚠️  ${oldCount} memories haven't been updated in over ${CONSTANTS.MEMORY_FILTERS.RECENT_DAYS * 4} days`
            );
        }
    }

    async runHealthCheck() {
        console.log('\n' + '='.repeat(60));
        console.log('🏥 MEMORY SYSTEM HEALTH CHECK');
        console.log('='.repeat(60) + '\n');

        // Freshness first — it must observe the db BEFORE any check lazily
        // opens/creates it (see checkIndexFreshness).
        await this.checkIndexFreshness();
        await this.checkInboxBacklog();
        await this.checkBackend();
        await this.checkMemoryPerformance();
        await this.checkMemoryQuality();
        await this.checkRecentMemories();

        // Display results
        console.log('\n' + '='.repeat(60));
        console.log('📊 HEALTH CHECK RESULTS');
        console.log('='.repeat(60) + '\n');

        if (this.results.passed.length > 0) {
            console.log('✅ PASSED CHECKS:');
            this.results.passed.forEach(msg => console.log('  ' + msg));
        }

        if (this.results.warnings.length > 0) {
            console.log('\n⚠️  WARNINGS:');
            this.results.warnings.forEach(msg => console.log('  ' + msg));
        }

        if (this.results.errors.length > 0) {
            console.log('\n❌ ERRORS:');
            this.results.errors.forEach(msg => console.log('  ' + msg));
        }

        // Summary
        const total = this.results.passed.length +
                     this.results.warnings.length +
                     this.results.errors.length;

        console.log('\n' + '='.repeat(60));
        console.log(`SUMMARY: ${this.results.passed.length}/${total} checks passed`);

        if (this.results.errors.length === 0) {
            console.log('🎉 Memory system is healthy!');
        } else {
            console.log('⚠️  Memory system needs attention');
        }

        console.log('='.repeat(60) + '\n');

        // Configuration reference
        console.log('📋 CONFIGURATION REFERENCE:');
        console.log(`  Recent threshold: ${CONSTANTS.MEMORY_FILTERS.RECENT_DAYS} days`);
        console.log(`  High confidence: ≥${CONSTANTS.MEMORY_FILTERS.HIGH_CONFIDENCE_THRESHOLD}`);
        console.log(`  High usage: ≥${CONSTANTS.MEMORY_FILTERS.HIGH_USAGE_THRESHOLD} uses`);
        console.log(`  Query target: <${CONSTANTS.PERFORMANCE.SIMPLE_QUERY_MS}ms`);
        console.log(`  Default limit: ${CONSTANTS.MEMORY_FILTERS.DEFAULT_LIMIT} memories`);

        return this.results.errors.length === 0;
    }
}

// Run health check
if (require.main === module) {
    const checker = new MemoryHealthChecker();
    checker.runHealthCheck()
        .then(healthy => process.exit(healthy ? 0 : 1))
        .catch(error => {
            console.error('Health check failed:', error);
            process.exit(1);
        });
}

module.exports = MemoryHealthChecker;