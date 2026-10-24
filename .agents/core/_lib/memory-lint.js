/**
 * Memory Lint — 7-check health audit over a pre-assembled list of memories.
 *
 * Extracted from memory-manager.js:740-911 (lintMemories). Pure function of its
 * inputs — no `this.*` coupling in the body. Caller is responsible for:
 *   1. Assembling `allMemories` as `[{category, summary, full}]`
 *   2. Passing a `calculateDecayedConfidence(memory)` closure that wraps the
 *      manager's own implementation (with its per-instance resolver)
 *
 * Checks produce `{ count, severity, findings: [...] }` per category; overall
 * health score starts at 70 and deducts {error:3, warning:2, info:1} per finding.
 */

const { jaccardFromSets, tokenizeText } = require('./jaccard');

// Single source of truth — no local duplicate of the cap value or the near-limit
// fraction (constants.js is zero-dep, so this stays portable). Callers may still
// override the cap via opts.maxPerCategory.
const { MEMORY_FILTERS } = require('../constants');
const DEFAULT_MAX_PER_CATEGORY = MEMORY_FILTERS.MEMORY_MAX_PER_CATEGORY;
const NEAR_LIMIT_PCT = MEMORY_FILTERS.MEMORY_NEAR_LIMIT_PCT;

const POSITIVE_SIGNALS = ['always', 'must', 'should', 'require', 'use', 'do'];
const NEGATIVE_SIGNALS = ["don't", 'never', 'avoid', 'skip', 'stop', 'remove'];

const DEDUCTIONS = { error: 3, warning: 2, info: 1 };

/**
 * Run the 7 lint checks and return a structured health report.
 *
 * @param {Array<{category: string, summary: object, full: object}>} allMemories
 *        Pre-assembled memory list. `full` must have id, updated, usage_count,
 *        content, metadata.confidence, category.
 * @param {object} opts
 * @param {(memory: object) => number} opts.calculateDecayedConfidence
 *        Returns decayed confidence in [0, 1]. Typically a closure over
 *        MemoryManager.calculateDecayedConfidence to preserve per-instance cache.
 * @param {string[]} opts.categories  Iteration order for category_balance check
 * @param {number}   [opts.maxPerCategory]  Category cap for category_balance
 *                                          check (default: 50 — matches MemoryManager)
 * @param {string[]} [opts.retiredIds]  Ids of retired (invalid_at) memories. They are
 *        history, not nonexistent ids: a reference to one is not a broken ref. They
 *        join no other check and are not in allMemories or the total.
 * @returns {{ score: number, checks: object, total_memories: number, categories_checked: number }}
 */
function lintMemories(allMemories, { calculateDecayedConfidence, categories, maxPerCategory = DEFAULT_MAX_PER_CATEGORY, retiredIds = [] }) {
    const findings = {
        broken_refs:      { count: 0, severity: 'error',   findings: [] },
        orphaned:         { count: 0, severity: 'warning', findings: [] },
        contradictions:   { count: 0, severity: 'warning', findings: [] },
        stale:            { count: 0, severity: 'warning', findings: [] },
        duplicates:       { count: 0, severity: 'warning', findings: [] },
        decay_validation: { count: 0, severity: 'info',    findings: [] },
        category_balance: { count: 0, severity: 'warning', findings: [] },
    };

    const knownIds = new Set([...allMemories.map(m => m.full.id), ...retiredIds]);

    // Check 1 — Broken cross-references
    // Three citation forms are checked against knownIds:
    //   (a) prose prefixes  — "related:/see:/ref: <id>"
    //   (b) wiki-links      — "[[slug]]" (the toolkit's ACTUAL convention, as used
    //       throughout the live curated store) — the
    //       old regex matched none of these, so broken_refs always reported 0 (M2)
    //   (c) a top-level content.references[] array
    // Capture path chars in (a) too so a file-path citation ("ref: docs/.output/…")
    // is swallowed whole and then skipped below — not mis-read as a bare id "docs".
    const refPattern = /(?:related:|see:|ref:)\s*([\w./-]+)/gi;
    // Wiki-links are kebab-case slugs only — never a file path, so they need no
    // path-skip guard (a "[[docs/foo.md]]" would simply not match [\w-]+).
    const wikiPattern = /\[\[([\w-]+)\]\]/g;
    const flagRef = (category, full, rawId, source) => {
        const referencedId = rawId.replace(/[.,;:]+$/, '');
        // Memory ids are kebab-case slugs — a capture with a path separator or an
        // INTERIOR dotted extension ("docs/foo.md") is a file-path citation, not a
        // cross-reference. A trailing period (already stripped) is not.
        if (!referencedId || referencedId.includes('/') || /\.[a-z]/i.test(referencedId)) return;
        // Every real memory id is a multi-segment kebab-case slug (verified: zero
        // single-word ids exist in the store). A bare single word — e.g. "switching"
        // captured from ordinary prose "ref: switching the active record", or an
        // English "ref:"/"see:" (a React ref, a git ref) — is never a genuine
        // citation. Require a hyphen so prose false-positives drop before the
        // knownIds lookup instead of being flagged as broken. (Wiki-links and
        // references[] slugs are already hyphenated, so this never rejects a real one.)
        if (!referencedId.includes('-')) return;
        if (!knownIds.has(referencedId)) {
            findings.broken_refs.findings.push({
                memory: `${category}/${full.id}`,
                referenced_id: referencedId,
                detail: `References ID "${referencedId}" (${source}) which does not exist`,
            });
        }
    };
    for (const { category, full } of allMemories) {
        const contentStr = JSON.stringify(full.content);
        let match;
        while ((match = refPattern.exec(contentStr)) !== null) {
            flagRef(category, full, match[1], 'prose ref');
        }
        // (b) [[wiki-link]] slugs in description/evidence prose.
        const proseText = `${full.content?.description || ''} ${full.content?.evidence || ''}`;
        while ((match = wikiPattern.exec(proseText)) !== null) {
            flagRef(category, full, match[1], 'wiki-link');
        }
        // (c) explicit content.references array of slug ids.
        const refs = full.content?.references;
        if (Array.isArray(refs)) {
            for (const ref of refs) {
                if (typeof ref === 'string') flagRef(category, full, ref, 'references[]');
            }
        }
    }
    findings.broken_refs.count = findings.broken_refs.findings.length;

    // Check 2 — Orphaned concepts
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const { category, full } of allMemories) {
        if ((full.usage_count || 0) === 0 && new Date(full.updated).getTime() < thirtyDaysAgo) {
            findings.orphaned.findings.push({
                memory: `${category}/${full.id}`,
                usage_count: full.usage_count || 0,
                days_since_update: Math.round((Date.now() - new Date(full.updated)) / (1000 * 60 * 60 * 24)),
                detail: 'Zero usage and not updated in 30+ days',
            });
        }
    }
    findings.orphaned.count = findings.orphaned.findings.length;

    // Pre-group by category once for checks 3, 5, 7
    const byCategory = {};
    for (const m of allMemories) {
        if (!byCategory[m.category]) byCategory[m.category] = [];
        byCategory[m.category].push(m);
    }

    // F14: serialize + tokenize each memory's content ONCE, shared by both
    // pairwise checks (3: contradictions, 5: duplicates). The old shape
    // re-stringified textA inside the inner loop and re-tokenized both sides
    // on every jaccardFromText call — ~4900 redundant stringify+tokenize ops
    // at a 50-per-category store for work that is O(n) once precomputed.
    // Also precompute the positive/negative signal flags (text-derived, pair-
    // independent) for check 3.
    const lintText = new Map(); // memory object → { text, tokens, hasPositive, hasNegative }
    for (const m of allMemories) {
        // ?? {} — the precompute now touches EVERY memory (the old inline shape
        // only stringified members of 2+-item categories), so a malformed record
        // must not throw here where it previously slid past.
        const text = JSON.stringify(m.full?.content ?? {}).toLowerCase();
        lintText.set(m, {
            text,
            tokens: tokenizeText(text),
            hasPositive: POSITIVE_SIGNALS.some(s => text.includes(s)),
            hasNegative: NEGATIVE_SIGNALS.some(s => text.includes(s)),
        });
    }

    // Check 3 — Contradictions (same category, high overlap but conflicting signals)
    for (const [category, members] of Object.entries(byCategory)) {
        for (let i = 0; i < members.length; i++) {
            const a = lintText.get(members[i]);
            for (let j = i + 1; j < members.length; j++) {
                const b = lintText.get(members[j]);
                const similarity = jaccardFromSets(a.tokens, b.tokens);
                if (similarity > 0.5 && a.text !== b.text) {
                    const conflict = (a.hasPositive && b.hasNegative) || (a.hasNegative && b.hasPositive);
                    if (conflict) {
                        findings.contradictions.findings.push({
                            memory_a: `${category}/${members[i].full.id}`,
                            memory_b: `${category}/${members[j].full.id}`,
                            overlap: Math.round(similarity * 100),
                            detail: 'High keyword overlap with conflicting positive/negative signals — flag for manual review',
                        });
                    }
                }
            }
        }
    }
    findings.contradictions.count = findings.contradictions.findings.length;

    // Check 4 — Staleness (decayed confidence < 0.3)
    for (const { category, full } of allMemories) {
        const decayed = calculateDecayedConfidence(full);
        if (decayed < 0.3) {
            findings.stale.findings.push({
                memory: `${category}/${full.id}`,
                decayed_confidence: Math.round(decayed * 1000) / 1000,
                detail: 'Decayed confidence below 0.3 threshold',
            });
        }
    }
    findings.stale.count = findings.stale.findings.length;

    // Check 5 — Duplicates (same category, Jaccard > 0.8) — reuses the F14
    // precomputed token sets from lintText; no per-pair stringify/tokenize.
    for (const [category, members] of Object.entries(byCategory)) {
        for (let i = 0; i < members.length; i++) {
            for (let j = i + 1; j < members.length; j++) {
                const similarity = jaccardFromSets(lintText.get(members[i]).tokens, lintText.get(members[j]).tokens);
                if (similarity > 0.8) {
                    findings.duplicates.findings.push({
                        memory_a: `${category}/${members[i].full.id}`,
                        memory_b: `${category}/${members[j].full.id}`,
                        overlap: Math.round(similarity * 100),
                        detail: `Content is ${Math.round(similarity * 100)}% similar — likely duplicate`,
                    });
                }
            }
        }
    }
    findings.duplicates.count = findings.duplicates.findings.length;

    // Check 6 — Decay curve validation (raw confidence >= 0.7 but decayed < 0.3)
    for (const { category, full } of allMemories) {
        const rawConfidence = full.metadata?.confidence ?? 1.0;
        const decayed = calculateDecayedConfidence(full);
        if (rawConfidence >= 0.7 && decayed < 0.3) {
            findings.decay_validation.findings.push({
                memory: `${category}/${full.id}`,
                raw_confidence: rawConfidence,
                decayed_confidence: Math.round(decayed * 1000) / 1000,
                days_since_update: Math.round((Date.now() - new Date(full.updated)) / (1000 * 60 * 60 * 24)),
                detail: 'High raw confidence but heavily decayed — not updated in a long time',
            });
        }
    }
    findings.decay_validation.count = findings.decay_validation.findings.length;

    // Check 7 — Category balance (any category >= 80% of max)
    const balanceThreshold = Math.floor(maxPerCategory * NEAR_LIMIT_PCT);
    for (const category of categories) {
        const count = (byCategory[category] || []).length;
        if (count >= balanceThreshold) {
            findings.category_balance.findings.push({
                category,
                count,
                limit: maxPerCategory,
                threshold: balanceThreshold,
                detail: `${count} memories in "${category}" is >= ${balanceThreshold} (80% of ${maxPerCategory} limit)`,
            });
        }
    }
    findings.category_balance.count = findings.category_balance.findings.length;

    // Health score: start at 70, deduct per finding by severity
    let score = 70;
    for (const check of Object.values(findings)) {
        score -= check.count * DEDUCTIONS[check.severity];
    }
    score = Math.max(0, score);

    return {
        score,
        checks: findings,
        total_memories: allMemories.length,
        categories_checked: categories.length,
    };
}

module.exports = { lintMemories, DEDUCTIONS };
