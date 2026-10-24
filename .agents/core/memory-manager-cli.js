#!/usr/bin/env node

/**
 * Memory Manager CLI — subcommand dispatcher, extracted from memory-manager.js
 * as part of Task #11. Keeps the module pure (class export only); this file
 * carries the CLI surface.
 *
 * Existing callers that ran `node .claude/core/memory-manager.js <cmd>` still
 * work — memory-manager.js forwards to this file when invoked directly.
 *
 * Usage:
 *   node .claude/core/memory-manager-cli.js <command> [args]
 */

const MemoryManager = require('./memory-manager');
const { MEMORY_DECAY } = require('./constants');

/**
 * The create/update CLI takes the content object FLAT, e.g.
 * '{"description":"…","importance":3}'. A frequent mistake is wrapping it in a
 * redundant { "content": {…} } envelope — the STORED memory shape and the agent
 * inbox draft shape both nest under a `content` key, so it's an easy slip.
 * Unchecked, createMemory stores it as content.content (and updateMemory merges
 * a `content` key INTO content), so the memory's description lives one level too
 * deep, reads as empty, and injects as "(no summary)" at SessionStart. Detect the
 * envelope — a lone `content` object with none of the real content fields present
 * at the top level — and unwrap one level with a warning.
 */
function unwrapContentEnvelope(obj) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)
        && obj.content && typeof obj.content === 'object' && !Array.isArray(obj.content)
        && obj.description === undefined && obj.pattern === undefined && obj.evidence === undefined) {
        console.warn('⚠️  content JSON was wrapped in a redundant { "content": … } envelope — unwrapping one level. Pass the content object directly, e.g. \'{"description":"…","importance":3}\'.');
        return obj.content;
    }
    return obj;
}

async function main() {
    const manager = new MemoryManager();
    const [, , command, ...args] = process.argv;

    switch (command) {
        case 'create': {
            const [category, id] = args;
            const content = unwrapContentEnvelope(JSON.parse(args[2] || '{}'));
            const overwrite = args.includes('--overwrite');
            const created = await manager.createMemory(category, id, content, { overwrite });
            if (!created) {
                console.error(`❌ Create failed: ${category}/${id} already exists (pass --overwrite to replace) or the category is full`);
                process.exit(1);
            }
            break;
        }
        case 'read': {
            const memory = await manager.readMemory(args[0], args[1]);
            console.log(JSON.stringify(memory, null, 2));
            break;
        }
        case 'list': {
            const memories = await manager.listMemories(args[0]);
            console.log(JSON.stringify(memories, null, 2));
            break;
        }
        case 'delete': {
            const [category, id] = args;
            if (!category || !id) {
                console.error('Error: delete requires <category> <id>');
                process.exit(1);
            }
            const result = await manager.deleteMemory(category, id);
            if (result.deleted) {
                console.log(`🗑️  Deleted: ${category}/${id}`);
            } else {
                console.error(`❌ Delete failed: ${result.error}`);
                process.exit(1);
            }
            break;
        }
        case 'update': {
            const [category, id] = args;
            if (!category || !id || args[2] === undefined) {
                console.error('Error: update requires <category> <id> <content-json>');
                console.error('  content-json is merged into the memory\'s content (e.g. \'{"description":"..."}\')');
                process.exit(1);
            }
            let content;
            try {
                content = unwrapContentEnvelope(JSON.parse(args[2]));
            } catch (e) {
                console.error(`Error: content must be valid JSON — ${e.message}`);
                process.exit(1);
            }
            const updated = await manager.updateMemory(category, id, { content });
            if (!updated) {
                console.error(`❌ Update failed: ${category}/${id} not found`);
                process.exit(1);
            }
            break;
        }
        case 'inbox-list': {
            const entries = await manager.inboxList();
            console.log(JSON.stringify(entries, null, 2));
            break;
        }
        case 'inbox-promote': {
            const [id] = args;
            if (!id) {
                console.error('Error: inbox-promote requires an inbox draft id');
                process.exit(1);
            }
            const opts = {};
            for (let i = 1; i < args.length; i++) {
                if (args[i] === '--category' && args[i + 1]) { opts.categoryOverride = args[++i]; }
                else if (args[i] === '--id' && args[i + 1]) { opts.idOverride = args[++i]; }
            }
            const result = await manager.inboxPromote(id, opts);
            if (result.promoted) {
                console.log(`✅ Promoted: ${result.category}/${result.id}`);
            } else {
                console.error(`❌ Promote failed: ${result.error}`);
                process.exit(1);
            }
            break;
        }
        case 'inbox-discard': {
            const [id] = args;
            if (!id) {
                console.error('Error: inbox-discard requires an inbox draft id');
                process.exit(1);
            }
            const result = await manager.inboxDiscard(id);
            if (result.discarded) {
                console.log(`🗑️  Discarded inbox draft: ${id}`);
            } else {
                console.error(`❌ Discard failed: ${result.error}`);
                process.exit(1);
            }
            break;
        }
        case 'search': {
            // Validate before searchMemories (N2): a missing term otherwise reached
            // searchTerm.toLowerCase() in the JSON-scan fallback and surfaced a bare
            // TypeError instead of a usage hint — match delete/update validation.
            if (!args[0] || typeof args[0] !== 'string') {
                console.error('Error: search requires a query string — e.g. search "publish tooling"');
                process.exit(1);
            }
            const results = await manager.searchMemories(args[0]);
            console.log(JSON.stringify(results, null, 2));
            break;
        }
        case 'report': {
            const report = await manager.generateReport();
            console.log(JSON.stringify(report, null, 2));
            break;
        }
        case 'rebuild-index': {
            // A record the index could not hold is a failed rebuild, not a success.
            const result = await manager.rebuildIndex();
            if (result && result.failed.length > 0) process.exitCode = 1;
            break;
        }
        case 'lint': {
            const result = await manager.lintMemories();
            console.log(JSON.stringify(result, null, 2));
            break;
        }
        case 'decay-report': {
            // Collect all memories across all categories with decayed confidence
            const allEntries = [];
            for (const category of manager.categories) {
                const memories = await manager.listMemories(category);
                for (const m of memories) {
                    allEntries.push({
                        category,
                        id: m.id,
                        confidence: m.confidence,
                        decayed_confidence: m.decayed_confidence,
                        decay_rate: MEMORY_DECAY.RATES[category] || MEMORY_DECAY.DEFAULT_RATE,
                        usage_count: m.usage_count,
                        updated: m.updated,
                    });
                }
            }
            // Sort ascending by decayed_confidence (stalest first)
            allEntries.sort((a, b) => a.decayed_confidence - b.decayed_confidence);
            console.log(JSON.stringify(allEntries, null, 2));
            break;
        }
        case 'ingest': {
            const [sourcePath] = args;
            if (!sourcePath) {
                console.error('Error: ingest requires a source path (file or directory)');
                process.exit(1);
            }
            const dryRun = args.includes('--dry-run');
            const report = await manager.ingestAgentMemory(sourcePath, { dryRun });
            console.log(JSON.stringify(report, null, 2));
            console.log(
                `\nSummary: ${report.ingested} ingested, ${report.skipped} skipped, ${report.errors.length} errors` +
                (dryRun ? ' (DRY RUN — no writes)' : '')
            );
            break;
        }
        case 'boost-from-git': {
            const opts = {};
            for (let i = 0; i < args.length; i++) {
                if (args[i] === '--limit' && args[i + 1]) { opts.limit = parseInt(args[++i], 10); }
                else if (args[i] === '--dry-run') { opts.dryRun = true; }
            }
            const boostReport = await manager.boostFromGitLog(opts);
            console.log('category\tid\tkeywords\tcommits\told→new');
            for (const entry of boostReport.boosted) {
                console.log([
                    entry.category,
                    entry.id,
                    entry.keywords.join(','),
                    entry.commits.join(' | '),
                    `${entry.oldConf.toFixed(3)}→${entry.newConf.toFixed(3)}`,
                ].join('\t'));
            }
            console.log(`\nScanned: ${boostReport.scanned}, Boosted: ${boostReport.boosted.length}, Skipped: ${boostReport.skipped.length}${opts.dryRun ? ' (DRY RUN — no writes)' : ''}`);
            if (boostReport.error) console.error('Error:', boostReport.error);
            break;
        }
        case 'analytics': {
            const a = await manager.generateAnalytics();
            const pct = (n) => `${Math.round(n * 100)}%`;
            const lines = [];
            lines.push('Memory Analytics');
            lines.push('================');
            lines.push('');

            // (a) cap utilization
            lines.push(`Cap utilization (max ${a.cap}/category):`);
            for (const [cat, c] of Object.entries(a.cap_utilization)) {
                const flag = c.near_limit ? '  ⚠ near limit' : '';
                lines.push(`  ${cat.padEnd(20)} ${String(c.count).padStart(3)}/${a.cap}  (${pct(c.pct_full)})${flag}`);
            }
            lines.push('');

            // (b) decay distribution
            lines.push(`Confidence/decay: ${a.decay.total_stale} stale (<0.3), ${a.decay.total_archive_candidates} archive-candidate (<0.1)`);

            // (c) usage distribution
            lines.push(`Usage: ${a.usage.never_used} never-used.`);
            if (a.usage.top_used.length > 0) {
                lines.push('  Top by usage_count:');
                for (const m of a.usage.top_used) {
                    lines.push(`    ${String(m.usage_count).padStart(4)}  ${m.category}/${m.id}`);
                }
            }
            lines.push('');

            // (d) prune list
            lines.push(`Prune candidates (stale AND never-used): ${a.prune.candidates.length}`);
            lines.push(`  Store size: ${a.prune.current_size} → ${a.prune.projected_size_after} after pruning`);
            for (const p of a.prune.candidates.slice(0, 15)) {
                lines.push(`    ${p.category}/${p.id}  (decayed ${p.decayed_confidence.toFixed(3)})`);
            }
            if (a.prune.candidates.length > 15) lines.push(`    …and ${a.prune.candidates.length - 15} more`);
            lines.push('');

            // (d2) dead-weight candidates
            lines.push(`Dead-weight candidates (REVIEW, do not auto-delete): ${a.dead_weight.candidates.length}`);
            lines.push(`  Threshold: ${a.dead_weight.exposure_min_active_days} active-work-days since created, usage_count = 0`);
            const dwSlice = a.dead_weight.candidates.slice(0, 15);
            for (const dw of dwSlice) {
                lines.push(`    ${dw.category}/${dw.id}  (created ${dw.active_days_since_created} active-days ago, decayed ${dw.decayed_confidence.toFixed(3)})`);
            }
            if (a.dead_weight.candidates.length > 15) lines.push(`    …and ${a.dead_weight.candidates.length - 15} more`);
            // per-category count summary
            const dwByCat = {};
            for (const dw of a.dead_weight.candidates) {
                dwByCat[dw.category] = (dwByCat[dw.category] || 0) + 1;
            }
            if (Object.keys(dwByCat).length > 0) {
                const catSummary = Object.entries(dwByCat).map(([c, n]) => `${c}: ${n}`).join(', ');
                lines.push(`  By category: ${catSummary}`);
            }
            lines.push(`  Store size: ${a.dead_weight.current_size} → ${a.dead_weight.projected_size_after}`);
            lines.push(`  Caveat: ${a.dead_weight.caveat}`);
            lines.push('');

            // (e) injection economics
            if (a.injection.has_telemetry) {
                lines.push('Injection economics:');
                lines.push(`  Events logged: ${a.injection.events}; avg injected: ${a.injection.avg_injected_count} (default limit ${a.injection.default_limit})`);
                lines.push(`  Decayed-confidence cliff at cutoff: ${a.injection.cliff == null ? 'n/a' : a.injection.cliff}`);
            } else {
                lines.push('Injection economics: no injection telemetry yet.');
            }
            lines.push('');

            // (f) hit-rate
            if (a.hit_rate.has_telemetry && a.hit_rate.denominator > 0) {
                lines.push(`Hit-rate (LOWER BOUND — implicit reads uncounted):`);
                lines.push(`  ${a.hit_rate.value == null ? 'n/a' : pct(a.hit_rate.value)} (${a.hit_rate.numerator}/${a.hit_rate.denominator} injected ids recalled/updated, over ${a.hit_rate.sample_injections} injection events)`);
            } else {
                lines.push('Hit-rate: no injection telemetry yet.');
            }

            console.log(lines.join('\n'));
            break;
        }
        case 'supersede': {
            const [category, oldId, newId] = args;
            if (!category || !oldId || !newId) {
                console.error('Error: supersede requires <category> <oldId> <newId>');
                process.exit(1);
            }
            const result = await manager.supersede(category, oldId, newId);
            if (result.superseded) {
                console.log(`🗞️  Superseded: ${category}/${oldId} → ${newId} (invalid_at ${result.invalid_at})`);
                // MEM-5: supersede() can succeed on the JSON write (source of truth)
                // while the SQLite FTS index update fails — surface that so an
                // operator doesn't read a flat "success" as fully consistent.
                if (result.indexStale) {
                    console.warn(`⚠️  ${result.warning}`);
                }
            } else {
                console.error(`❌ Supersede failed: ${result.error}`);
                process.exit(1);
            }
            break;
        }
        case 'prune-unused': {
            // Optional positional [category] filter — any non-flag arg that isn't
            // a value for --min-exposure is treated as the category.
            let categoryFilter = null;
            let minExposureOverride = null;
            const commitMode = args.includes('--commit');
            for (let i = 0; i < args.length; i++) {
                if (args[i] === '--min-exposure' && args[i + 1]) {
                    minExposureOverride = parseInt(args[++i], 10);
                } else if (args[i] === '--commit') {
                    // already handled above
                } else if (!args[i].startsWith('--')) {
                    categoryFilter = args[i];
                }
            }

            const analytics = await manager.generateAnalytics();
            let candidates = analytics.dead_weight.candidates;

            if (categoryFilter) {
                candidates = candidates.filter(c => c.category === categoryFilter);
            }
            if (minExposureOverride != null) {
                candidates = candidates.filter(c => c.active_days_since_created >= minExposureOverride);
            }

            if (!commitMode) {
                // DRY RUN — list victims, delete nothing
                console.log(`prune-unused — DRY RUN (${candidates.length} candidate${candidates.length !== 1 ? 's' : ''})`);
                if (categoryFilter) console.log(`  Category filter: ${categoryFilter}`);
                if (minExposureOverride != null) console.log(`  Min-exposure filter: ${minExposureOverride} active-days`);
                console.log(`  Configured threshold: ${analytics.dead_weight.exposure_min_active_days} active-days`);
                console.log('');
                if (candidates.length === 0) {
                    console.log('  No dead-weight candidates match the current filters.');
                } else {
                    for (const c of candidates) {
                        console.log(`  WOULD DELETE  ${c.category}/${c.id}  (${c.active_days_since_created} active-days, decayed ${c.decayed_confidence.toFixed(3)})`);
                    }
                }
                console.log('');
                console.log('Run with --commit to actually delete. NOTE: loosening below the configured');
                console.log('threshold requires the MEMORY_EXPOSURE_MIN_DAYS env var (threshold is');
                console.log('captured at module load); --min-exposure can only tighten.');
            } else {
                // COMMIT — actually delete
                console.log(`prune-unused — COMMITTING (${candidates.length} candidate${candidates.length !== 1 ? 's' : ''})`);
                if (categoryFilter) console.log(`  Category filter: ${categoryFilter}`);
                if (minExposureOverride != null) console.log(`  Min-exposure filter: ${minExposureOverride} active-days`);
                console.log('');
                let deleted = 0;
                let failed = 0;
                for (const c of candidates) {
                    const result = await manager.deleteMemory(c.category, c.id);
                    if (result.deleted) {
                        console.log(`  DELETED  ${c.category}/${c.id}`);
                        deleted++;
                    } else {
                        console.error(`  FAILED   ${c.category}/${c.id}  — ${result.error}`);
                        failed++;
                    }
                }
                console.log('');
                console.log(`Done: ${deleted} deleted, ${failed} failed.`);
                if (failed > 0) process.exit(1);
            }
            break;
        }
        default:
            console.log(`
Memory Manager (JSON + SQLite FTS5)
====================================

Usage:
  node memory-manager-cli.js create <category> <id> <content> [--overwrite]
    Refuses by default when <id> already exists in <category> (no silent
    clobber). Pass --overwrite to intentionally replace it, or use 'update'
    to merge new fields into the existing memory instead.
  node memory-manager-cli.js read <category> <id>
  node memory-manager-cli.js update <category> <id> <content-json>
  node memory-manager-cli.js list <category>
  node memory-manager-cli.js delete <category> <id>
  node memory-manager-cli.js supersede <category> <oldId> <newId>
  node memory-manager-cli.js search <term>
  node memory-manager-cli.js inbox-list
  node memory-manager-cli.js inbox-promote <draft-id> [--category C] [--id new-id]
  node memory-manager-cli.js inbox-discard <draft-id>
  node memory-manager-cli.js report
  node memory-manager-cli.js analytics
    Performance/usage view — cap utilization, decay + usage distribution,
    prune list, dead-weight candidates, injection economics, and injection
    hit-rate (a LOWER bound; implicit reads of an injected memory leave no
    signal). Complements lint (hygiene) and report (inventory).
  node memory-manager-cli.js prune-unused [category] [--min-exposure N] [--commit]
    List (or delete) never-used memories exposed past the dead-weight threshold.
    Default (no flags): DRY RUN — lists victims, deletes nothing.
    --commit: actually delete each candidate via deleteMemory.
    [category]: optional positional arg — filters to that category only.
    --min-exposure N: tightening filter (active-days >= N). Loosening below the
      configured threshold requires the MEMORY_EXPOSURE_MIN_DAYS env var, because
      the threshold constant is captured at module load.
  node memory-manager-cli.js rebuild-index
  node memory-manager-cli.js decay-report
  node memory-manager-cli.js boost-from-git [--limit N] [--dry-run]
  node memory-manager-cli.js lint
  node memory-manager-cli.js ingest <path> [--dry-run]
    Ingest auto-memory .md files (YAML frontmatter + body) into the
    JSON store. Path may be a single file or a directory (walked recursively).
    type → category: feedback/pattern → patterns, constraint → constraints,
    decision → decisions, workflow → workflows, rejected-approach → rejected-approaches.

Inbox (R-A — sub-agent draft memory pattern):
  node memory-manager-cli.js inbox-list
  node memory-manager-cli.js inbox-promote <id> [--category <cat>] [--id <id>]
  node memory-manager-cli.js inbox-discard <id>
    Sub-agents flag draft memories to docs/.output/.state/memory-inbox/ during
    their work. Main Agent reviews on dispatch return: promote keepers,
    discard noise. See docs/.output/plans/2026-05-11-do-r-a-inbox-pattern.md.

Categories: patterns, constraints, decisions, workflows, rejected-approaches
Storage: docs/.output/.memory/ (JSON) + memories.db (SQLite FTS5)
            `);
            // Exit non-zero for an unknown/typo'd subcommand so callers don't read
            // a false success; bare help (no command) exits 0. Matches siblings
            // memory-curator.js:387 / memory-benchmark.js:451.
            process.exit(command ? 1 : 0);
    }
}

if (require.main === module) {
    main().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { main, unwrapContentEnvelope };
