/**
 * Cross-References — compute pairwise Jaccard similarity between concept
 * articles and write `cross-references.json`.
 *
 * Extracted from memory-compiler.js:generateCrossReferences (~80 LOC). Pairs
 * with similarity in the window [crossRefThreshold, similarityThreshold) are
 * recorded as "related" — pairs at or above similarityThreshold are assumed
 * to already be grouped into the same concept article.
 */

const fs = require('fs').promises;
const path = require('path');
const { scanConceptFiles } = require('./concept-reader');
const { jaccardFromSets } = require('./jaccard');

// F5: hard ceiling on pairwise Jaccard comparisons per run. The candidate
// pre-filter below already prunes keyword-disjoint pairs exactly; this cap is
// the backstop for a pathological store where nearly every concept shares a
// token with every other (worst case is still O(n²) candidates). ~250k
// comparisons ≈ a fully-dense 700-concept store — far beyond current scale —
// and past it the run degrades LOUDLY (stderr warning, deterministic prefix
// processed) instead of hanging the compile.
const MAX_PAIR_COMPARISONS = 250_000;

/**
 * Scan all concept articles, compute cross-references, write JSON.
 *
 * @param {object} opts
 * @param {string}   opts.conceptsDir
 * @param {string[]} opts.categories
 * @param {number}   opts.crossRefThreshold    Inclusive lower bound (e.g. 0.15)
 * @param {number}   opts.similarityThreshold  Exclusive upper bound (e.g. 0.3)
 * @param {Array}    [opts.conceptScan]        Shared per-run tree scan (F4); omitted → local walk.
 * @returns {Promise<number>} The count of unique cross-reference pairs discovered.
 */
async function generateCrossReferences({ conceptsDir, categories, crossRefThreshold, similarityThreshold, conceptScan }) {
    // F4: one tree read per compile — consume the shared scan when provided.
    const scan = conceptScan || await scanConceptFiles({ conceptsDir, categories });

    const allConcepts = []; // { slug, category, keywords }
    for (const { slug, category, content, fm } of scan) {
        const title = fm.title || slug;

        const summaryMatch = content.match(/## Summary\s*\n+([\s\S]*?)(?=\n##|$)/);
        const summaryText = summaryMatch ? summaryMatch[1].trim() : '';

        // Simple keyword tokenizer: title + summary, split on whitespace,
        // lowercase, filter words > 2 chars
        const rawText = `${title} ${summaryText}`;
        const keywords = new Set(
            rawText
                .toLowerCase()
                .split(/\s+/)
                .map(w => w.replace(/[^a-z0-9]/g, ''))
                .filter(w => w.length > 2)
        );

        allConcepts.push({ slug, category, keywords });
    }

    // Build bidirectional cross-reference map: { slug: { related: [...], category } }
    const crossRefMap = {};
    for (const concept of allConcepts) {
        crossRefMap[concept.slug] = { related: [], category: concept.category };
    }

    // F5: exact candidate pre-filter via an inverted keyword index. Jaccard of
    // keyword-DISJOINT sets is 0, which can never reach a positive
    // crossRefThreshold — so only pairs co-occurring in at least one token
    // bucket need comparing. This replaces the unconditional O(n²) double loop
    // with O(sum of bucket-pair counts), which stays near-linear while the
    // store's vocabulary is diverse, with zero behavior change.
    //
    // Exactness holds ONLY for a positive threshold. This module is exported
    // and reusable, so a caller passing 0 (or negative) — where the old loop
    // recorded even disjoint pairs (sim 0 >= 0) — must NOT silently lose them:
    // fall back to enumerating every pair instead of the pre-filter.
    const candidatePairs = new Set(); // i * n + j (i < j; deterministic keys)
    const n = allConcepts.length;
    if (!(crossRefThreshold > 0)) {
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) candidatePairs.add(i * n + j);
        }
    } else {
        const buckets = new Map(); // keyword → [conceptIndex...]
        allConcepts.forEach((c, idx) => {
            for (const k of c.keywords) {
                let b = buckets.get(k);
                if (!b) buckets.set(k, b = []);
                b.push(idx);
            }
        });
        for (const idxs of buckets.values()) {
            for (let a = 0; a < idxs.length; a++) {
                for (let b = a + 1; b < idxs.length; b++) {
                    candidatePairs.add(idxs[a] * n + idxs[b]);
                }
            }
        }
    }

    let pairCount = 0;
    let compared = 0;
    let truncated = false;
    // Sorted for a deterministic processing order (Set insertion order depends
    // on bucket iteration; the cap must always truncate the same suffix).
    for (const key of Array.from(candidatePairs).sort((x, y) => x - y)) {
        if (compared >= MAX_PAIR_COMPARISONS) { truncated = true; break; }
        compared++;
        const i = Math.floor(key / n);
        const j = key % n;
        const sim = jaccardFromSets(allConcepts[i].keywords, allConcepts[j].keywords);
        if (sim >= crossRefThreshold && sim < similarityThreshold) {
            const slugA = allConcepts[i].slug;
            const slugB = allConcepts[j].slug;
            crossRefMap[slugA].related.push(slugB);
            crossRefMap[slugB].related.push(slugA);
            pairCount++;
        }
    }
    if (truncated) {
        process.stderr.write(`[cross-references] WARN: candidate pairs exceeded the ${MAX_PAIR_COMPARISONS} comparison cap — cross-references truncated (store too dense; consider raising crossRefThreshold).\n`);
    }

    // Preserve prior behavior: empty object when no concepts exist
    const outputMap = allConcepts.length === 0 ? {} : crossRefMap;
    const crossRefPath = path.join(conceptsDir, 'cross-references.json');
    await fs.writeFile(crossRefPath, JSON.stringify(outputMap, null, 2), 'utf-8');

    return pairCount;
}

module.exports = { generateCrossReferences, MAX_PAIR_COMPARISONS };
