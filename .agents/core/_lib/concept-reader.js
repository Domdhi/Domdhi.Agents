/**
 * Concept Reader — walks the concept-article tree and builds typed concept records.
 *
 * Unifies two nearly-identical implementations:
 *   - memory-promoter.js:loadConcepts  (returns slug, title, category, confidence,
 *     decayedConfidence, sources, usageCount, promotedTo, updated)
 *   - memory-curator.js:loadConcepts   (returns slug, title, category, content,
 *     confidence, decayedConfidence, sources)
 *
 * Shared shape: return the superset (content + usageCount + promotedTo always present).
 * Extra fields are harmless to callers that ignore them.
 *
 * Consumes _lib/frontmatter.js + _lib/memory-decay.js — the refactor this
 * extraction unlocks is the primary reason those came first.
 *
 * F4: also exports the raw tree walk (`scanConceptFiles`) so memory-compiler's
 * compile pipeline reads the concepts tree ONCE per run and threads the parsed
 * list through generateIndex / generateCrossReferences / injectRelatedConcepts,
 * instead of each doing its own readdir+readFile+parseFrontmatter pass (3×
 * I/O + parse cost, growing with the store). readConcepts() builds on the same
 * walk, so there is exactly one implementation of "walk the concepts tree".
 */

const fs = require('fs').promises;
const path = require('path');
const { parseFrontmatter } = require('./frontmatter');
const { calculateDecayedConfidence } = require('./memory-decay');

/**
 * Raw concepts-tree walk (F4): read every concept `.md` under
 * `conceptsDir/{category}/`, parse its frontmatter, and return the flat list of
 * `{ slug, filename, category, content, fm }` records. This is THE single
 * implementation of the walk — readConcepts() and memory-compiler's per-run
 * shared scan both consume it. Unreadable files and absent category dirs are
 * skipped silently (same tolerance every prior inline copy had).
 *
 * @param {object} args
 * @param {string}   args.conceptsDir  Absolute path to concepts root
 * @param {string[]} args.categories   Category subdir names to scan
 * @returns {Promise<Array<{ slug: string, filename: string, category: string, content: string, fm: object }>>}
 */
async function scanConceptFiles({ conceptsDir, categories }) {
    const entries = [];

    for (const category of categories) {
        const catDir = path.join(conceptsDir, category);
        let files;
        try {
            files = await fs.readdir(catDir);
        } catch {
            continue; // category dir may not exist
        }

        for (const file of files) {
            if (!file.endsWith('.md')) continue;
            try {
                const content = await fs.readFile(path.join(catDir, file), 'utf-8');
                const fm = parseFrontmatter(content);
                if (!fm) continue;
                entries.push({ slug: file.replace('.md', ''), filename: file, category, content, fm });
            } catch {
                // skip unreadable files
            }
        }
    }

    return entries;
}

/**
 * Read every concept `.md` file under `conceptsDir/{category}/`, parse each
 * frontmatter, compute decayed confidence, and return a flat array of concepts.
 *
 * @param {object} args
 * @param {string}   args.conceptsDir           Absolute path to concepts root
 * @param {string[]} args.categories            Category subdir names to scan
 * @param {object}   args.activeDaysResolver    From createActiveDaysResolver; must
 *                                              expose `.getActiveDaysSince(iso)`
 * @returns {Promise<Array<{
 *   slug: string, title: string, category: string,
 *   content: string, confidence: number, decayedConfidence: number,
 *   sources: string[], usageCount: number, promotedTo: string|null, updated: string
 * }>>}
 */
async function readConcepts({ conceptsDir, categories, activeDaysResolver }) {
    const concepts = [];

    for (const { slug, category, content, fm } of await scanConceptFiles({ conceptsDir, categories })) {
        const parsedConfidence = parseFloat(fm.confidence);
        const confidence = Number.isFinite(parsedConfidence) ? parsedConfidence : 0.6;
        const updated = fm.updated || new Date().toISOString();
        const sources = fm.sources || [];
        const usageCount = parseInt(fm.usage_count) || 0;

        const decayed = calculateDecayedConfidence({
            confidence,
            category,
            usageCount,
            updated,
            activeDays: activeDaysResolver.getActiveDaysSince(updated),
        });

        concepts.push({
            slug,
            title: fm.title || slug,
            category,
            content,
            confidence,
            decayedConfidence: decayed,
            sources,
            usageCount,
            promotedTo: fm.promoted_to || null,
            updated,
        });
    }

    return concepts;
}

module.exports = { readConcepts, scanConceptFiles };
