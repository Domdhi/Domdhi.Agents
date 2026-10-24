/**
 * Concept Article — write or update a single concept article markdown file.
 *
 * Extracted from memory-compiler.js:413-570 (writeConceptArticle). 158-line
 * method became an injectable function taking `{group, deps}`. The compiler's
 * instance methods (detectCategory, generateTitle, generateSummary, etc.)
 * remain on the compiler — the shared lib receives what it needs as closures.
 *
 * Idempotent: re-running merges new evidence blocks into existing files by
 * date+time heading, preserving prior entries.
 */

const fs = require('fs').promises;
const path = require('path');
const { parseFrontmatter } = require('./frontmatter');

const DEFAULT_CONFIDENCE = 0.6;
// F3: retention cap for a concept's '## Evidence' blocks (newest kept).
const MAX_EVIDENCE_BLOCKS = 20;

/**
 * Write or update a concept article for a group of entries.
 *
 * @param {Array<{date, time, rawText, keywords: Set<string>}>} group
 *        Entries that will share this concept article.
 * @param {object} deps
 * @param {string}   deps.conceptsDir         Root output directory (absolute path)
 * @param {(group) => string} deps.detectCategory
 * @param {(group) => string} deps.generateTitle
 * @param {(title: string) => string} deps.getConceptId          Slugifier
 * @param {(group, category) => string} deps.generateSummary
 * @param {(text: string) => string} deps.addDailyBacklinks
 * @param {(iso: string) => string} deps.formatDateOnly
 * @returns {Promise<{title, category, filename, slug, description, confidence}|null>}
 */
async function writeConceptArticle(group, deps) {
    const {
        conceptsDir,
        detectCategory,
        generateTitle,
        getConceptId,
        generateSummary,
        addDailyBacklinks,
        formatDateOnly,
    } = deps;

    try {
        const category = detectCategory(group);
        const title = generateTitle(group);
        const slug = getConceptId(title);
        const filename = `${slug}.md`;
        const filePath = path.join(conceptsDir, category, filename);

        const newSources = Array.from(new Set(group.map(e => e.date))).sort();
        const now = new Date().toISOString();

        // Check for existing concept (idempotency)
        let existingFrontmatter = null;
        let existingSources = [];
        let createdDate = now;
        let existingContent = null;

        try {
            existingContent = await fs.readFile(filePath, 'utf-8');
            existingFrontmatter = parseFrontmatter(existingContent);
            if (existingFrontmatter) {
                existingSources = existingFrontmatter.sources || [];
                createdDate = existingFrontmatter.created || now;
            }
        } catch { /* file doesn't exist yet — fresh write */ }

        const mergedSources = Array.from(new Set([...existingSources, ...newSources])).sort();
        const summary = generateSummary(group, category);

        // Build evidence blocks
        const evidenceBlocks = group.map(entry =>
            `### ${entry.date} ${entry.time}\n\n${entry.rawText}`
        );

        // Preserve prior evidence when updating
        let priorEvidence = '';
        if (existingFrontmatter && existingContent) {
            const evidenceMatch = existingContent.match(/## Evidence\s*\n([\s\S]*)$/);
            if (evidenceMatch) priorEvidence = evidenceMatch[1].trim();
        }

        // Dedup by date+time heading when merging
        const existingEvidenceHeadings = new Set();
        if (priorEvidence) {
            const headingMatches = priorEvidence.matchAll(/^### (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/gm);
            for (const m of headingMatches) existingEvidenceHeadings.add(m[1]);
        }

        const newEvidenceBlocks = evidenceBlocks.filter(block => {
            const headingMatch = block.match(/^### (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
            if (!headingMatch) return true;
            return !existingEvidenceHeadings.has(headingMatch[1]);
        });

        // F3: bound the Evidence section — every merge used to keep 100% of
        // prior history plus the new blocks, so file size and the read-rewrite
        // cost of every future update grew monotonically for the project's
        // life (the unbounded-accumulation class jsonl-writer tail-rotates
        // for). Keep the newest MAX_EVIDENCE_BLOCKS; a regenerated one-line
        // note carries the cumulative rotated-out count (and is filtered back
        // out of prior blocks so it never compounds).
        const ROTATION_NOTE_RE = /^_(\d+) older evidence block\(s\) rotated out/;
        let priorRotated = 0;
        const priorBlocks = priorEvidence
            ? priorEvidence.split(/\n\n---\n\n/).filter((b) => {
                const t = b.trim();
                if (!t) return false;
                const m = t.match(ROTATION_NOTE_RE);
                if (m) { priorRotated = parseInt(m[1], 10) || 0; return false; }
                return true;
            })
            : [];
        const combinedBlocks = [...priorBlocks, ...newEvidenceBlocks];
        const rotatedOut = priorRotated + Math.max(0, combinedBlocks.length - MAX_EVIDENCE_BLOCKS);
        const keptBlocks = combinedBlocks.slice(-MAX_EVIDENCE_BLOCKS);
        const allEvidence = [
            ...(rotatedOut > 0 ? [`_${rotatedOut} older evidence block(s) rotated out (newest ${MAX_EVIDENCE_BLOCKS} kept)._`] : []),
            ...keptBlocks,
        ].join('\n\n---\n\n');

        // Tag + alias derivation from keyword frequency
        const keywordFreq = new Map();
        for (const entry of group) {
            for (const kw of entry.keywords) {
                keywordFreq.set(kw, (keywordFreq.get(kw) || 0) + 1);
            }
        }
        const topKeywords = Array.from(keywordFreq.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([kw]) => kw);
        const tags = [category, ...topKeywords.filter(k => k !== category)];

        const aliasKeywords = topKeywords.slice(0, 3);
        const aliases = [];
        if (aliasKeywords.length >= 2) {
            aliases.push(aliasKeywords.slice().reverse().map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
        }
        if (aliasKeywords.length >= 3) {
            aliases.push([aliasKeywords[0], aliasKeywords[2]].map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
        }

        // Obsidian/Dataview metadata
        const sourceCount = mergedSources.length;
        const entryCount = existingEvidenceHeadings.size + newEvidenceBlocks.length;
        const dateRange = mergedSources.length === 1
            ? mergedSources[0]
            : `${mergedSources[0]} to ${mergedSources[mergedSources.length - 1]}`;

        // YAML frontmatter
        const sourcesYaml = mergedSources.map(s => `  - ${s}`).join('\n');
        const tagsYaml = tags.map(t => `  - ${t}`).join('\n');
        const aliasesYaml = aliases.length > 0
            ? aliases.map(a => `  - ${a}`).join('\n')
            : '  - ' + title;
        const frontmatter = [
            '---',
            `title: ${title}`,
            `category: ${category}`,
            `cssclasses:`,
            `  - concept-${category}`,
            `tags:`,
            tagsYaml,
            `aliases:`,
            aliasesYaml,
            `sources:`,
            sourcesYaml,
            `created: ${formatDateOnly(createdDate)}`,
            `updated: ${formatDateOnly(now)}`,
            `confidence: ${DEFAULT_CONFIDENCE}`,
            `source_count: ${sourceCount}`,
            `entry_count: ${entryCount}`,
            `date_range: "${dateRange}"`,
            '---',
        ].join('\n');

        const evidenceWithBacklinks = addDailyBacklinks(allEvidence || '_No evidence blocks._');

        const articleContent = [
            frontmatter,
            '',
            '## Summary',
            '',
            `> [!abstract] Summary`,
            `> ${summary}`,
            '',
            '## Evidence',
            '',
            evidenceWithBacklinks,
        ].join('\n');

        await fs.writeFile(filePath, articleContent, 'utf-8');

        const action = existingFrontmatter ? 'Updated' : 'Created';
        console.log(`  ${action}: ${category}/${filename}`);

        return {
            title,
            category,
            filename,
            slug,
            description: summary.slice(0, 120),
            confidence: DEFAULT_CONFIDENCE,
        };
    } catch (err) {
        console.error(`  Error writing concept for group: ${err.message}`);
        return null;
    }
}

module.exports = { writeConceptArticle, DEFAULT_CONFIDENCE };
