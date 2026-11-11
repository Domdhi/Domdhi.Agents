/**
 * Memory Lint — 9-check health audit over a pre-assembled list of memories.
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

const POSITIVE_SIGNALS = ['always', 'must', 'should', 'require', 'use', 'do'];
const NEGATIVE_SIGNALS = ["don't", 'never', 'avoid', 'skip', 'stop', 'remove'];

const DEDUCTIONS = { error: 3, warning: 2, info: 1 };

const CORRECTION_MARKER = /\b(?:CORRECTED|CORRECTION|OBSOLETE|REFUTED|RETRACTED|SUPERSEDED|NO LONGER (?:TRUE|VALID|ACCURATE))\b/;
const CORRECTION_KEY = /^(?:correction|corrections|historical_\w+)$/;
const CORRECTION_PHRASE = /\b(?:(?:the )?(?:earlier|previous|original|above) (?:claim|version|guidance|rule|advice) (?:was|is) (?:wrong|incorrect)|this (?:memory|rule) (?:was|is) wrong)\b/i;

// Words an id carries that say nothing about its subject.
const ID_STOPWORDS = new Set(['with', 'when', 'that', 'this', 'from', 'into', 'than', 'then', 'only', 'must', 'never', 'always',
    'should', 'does', 'dont', 'without', 'before', 'after', 'over', 'under', 'every', 'each', 'their', 'there', 'about', 'uses']);

/**
 * Words of a memory id that the content never mentions. Matching is by a 4-letter stem so
 * "caching" finds "cache" and "tests" finds "testing". Ids with fewer than three meaningful
 * words are skipped (too little to judge), and drift needs at least two thirds of them missing
 * (a body that paraphrases its id still shares about half its words).
 *
 * @param {string} id
 * @param {string} lowerText  the memory content, lower-cased
 * @returns {{terms:number, missing:string[]}|null}
 */
function idDrift(id, lowerText) {
    const terms = [...new Set(String(id || '').toLowerCase().split(/[^a-z0-9]+/)
        .filter(w => w.length >= 4 && !ID_STOPWORDS.has(w) && !/^\d+$/.test(w)))];
    if (terms.length < 3) return null;
    const missing = terms.filter(w => !lowerText.includes(w.slice(0, 4)));
    return missing.length * 3 >= terms.length * 2 ? { terms: terms.length, missing } : null;
}

/**
 * Run the 9 lint checks and return a structured health report.
 *
 * @param {Array<{category: string, summary: object, full: object}>} allMemories
 *        Pre-assembled memory list. `full` must have id, updated, usage_count,
 *        content, metadata.confidence, category.
 * @param {object} opts
 * @param {(memory: object) => number} opts.calculateDecayedConfidence
 *        Returns decayed confidence in [0, 1]. Typically a closure over
 *        MemoryManager.calculateDecayedConfidence to preserve per-instance cache.
 * @param {string[]} opts.categories  Categories the store defines (reported as categories_checked)
 * @param {string[]} [opts.retiredIds]  Ids of retired (invalid_at) memories. They are
 *        history, not nonexistent ids: a reference to one is not a broken ref. They
 *        join no other check and are not in allMemories or the total.
 * @returns {{ score: number, checks: object, total_memories: number, categories_checked: number }}
 */
function lintMemories(allMemories, { calculateDecayedConfidence, categories, retiredIds = [] }) {
    const findings = {
        broken_refs:      { count: 0, severity: 'error',   findings: [] },
        orphaned:         { count: 0, severity: 'warning', findings: [] },
        contradictions:   { count: 0, severity: 'warning', findings: [] },
        stale:            { count: 0, severity: 'warning', findings: [] },
        duplicates:       { count: 0, severity: 'warning', findings: [] },
        decay_validation: { count: 0, severity: 'info',    findings: [] },
        corrected_in_place: { count: 0, severity: 'warning', findings: [] },
        id_drift:         { count: 0, severity: 'info',    findings: [] },
        schema_drift:     { count: 0, severity: 'info',    findings: [] },
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
        const proseText = `${full.content?.description || full.content?.summary || ''} ${full.content?.evidence || ''}`;
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
        // (d) content.see_also[]: slug strings or { category, id } objects. The largest
        // measured store had 143 see_also links to ids that existed nowhere.
        const seeAlso = full.content?.see_also ?? full.see_also;
        if (Array.isArray(seeAlso)) {
            for (const ref of seeAlso) {
                const id = typeof ref === 'string' ? ref : ref?.id;
                if (typeof id === 'string') flagRef(category, full, id, 'see_also[]');
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

    // Check 7 — Corrected in place. A memory found wrong gets its body edited ("CORRECTED: ...")
    // instead of a new memory plus `supersede`, so the stale claim stays live in recall and the
    // id keeps naming it. Seen at scale: 35 of 1,401 live memories in the largest store, against
    // 16 ever superseded. Upper-case markers only: lower-case "obsolete" is ordinary content.
    for (const { category, full } of allMemories) {
        const text = JSON.stringify(full.content ?? {});
        const match = CORRECTION_MARKER.exec(text) || CORRECTION_PHRASE.exec(text);
        // The same habit in structured form: the old claim kept in a side field
        // (correction, historical_description) or a description that opens "CURRENT:".
        const sideKey = Object.keys(full.content ?? {}).find(k => CORRECTION_KEY.test(k));
        const currentPrefix = /^\s*CURRENT:/.test(String(full.content?.description ?? ''));
        const marker = match ? match[0] : (sideKey ? `${sideKey} field` : (currentPrefix ? 'CURRENT: prefix' : null));
        if (marker) {
            findings.corrected_in_place.findings.push({
                memory: `${category}/${full.id}`,
                marker,
                detail: `Body carries a correction (${marker}): supersede it with a corrected memory (memory-manager.js supersede) when the id no longer fits, otherwise rewrite it whole and drop the old claim`,
            });
        }
    }
    findings.corrected_in_place.count = findings.corrected_in_place.findings.length;

    // Check 8 — Id drift. The id is what startup and recall show first; when most of its words
    // no longer appear anywhere in the content, the body was rewritten under an id that now
    // states something else (or the opposite).
    for (const m of allMemories) {
        const { category, full } = m;
        const drift = idDrift(full.id, lintText.get(m).text);
        if (drift) {
            findings.id_drift.findings.push({
                memory: `${category}/${full.id}`,
                missing_terms: drift.missing,
                detail: `${drift.missing.length} of ${drift.terms} id words (${drift.missing.join(', ')}) appear nowhere in the content: rename or supersede so the id matches the body`,
            });
        }
    }
    findings.id_drift.count = findings.id_drift.findings.length;

    // Check 9 — Schema drift: a memory with no description shows only its id in startup and
    // recall, and an importance off the 1-5 scale skews ranking. A missing importance is not
    // flagged: it falls back to the default.
    for (const { category, full } of allMemories) {
        const problems = [];
        // Startup and recall fall back to content.summary, so either field counts.
        const text = [full.content?.description, full.content?.summary].find(v => typeof v === 'string' && v.trim());
        if (!text) problems.push('empty description');
        const importance = full.importance ?? full.content?.importance;
        if (importance !== undefined && importance !== null && !(Number.isInteger(importance) && importance >= 1 && importance <= 5)) {
            problems.push(`importance ${JSON.stringify(importance)} is off the 1-5 scale`);
        }
        if (problems.length) {
            findings.schema_drift.findings.push({ memory: `${category}/${full.id}`, problems, detail: problems.join('; ') });
        }
    }
    findings.schema_drift.count = findings.schema_drift.findings.length;

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

module.exports = { lintMemories, idDrift, DEDUCTIONS };
