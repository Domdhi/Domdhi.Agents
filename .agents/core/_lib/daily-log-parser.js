/**
 * Daily Log Parser — splits daily-log markdown into entries and extracts keywords.
 *
 * Unifies three previously-divergent users:
 *   - memory-compiler.js:240  parseDailyFile (returned {date, time, rawText})
 *   - memory-compiler.js:267  extractKeywords
 *   - memory-extractor.js:44  parseDailyFile (returned {date, time, heading, rawText})
 *   - memory-benchmark.js:94  instantiated MemoryCompiler just for parseDailyFile + extractKeywords
 *
 * Unified entry shape includes `heading` (superset of both). Compiler's callers
 * ignore the extra field; extractor's callers depend on it. Benchmark used
 * compiler's shape — it now picks up `heading` for free.
 *
 * Extraction benefit: benchmark and extractor no longer need to import
 * MemoryCompiler just to parse a daily log. Direct import of this module
 * breaks the previous smell where a 1100-line class was loaded for two methods.
 */

/**
 * Split a daily log file into individual compaction entries.
 * Each entry starts at `## HH:MM — <heading-text>`.
 *
 * @param {string} content  File content
 * @param {string} date     ISO date string (YYYY-MM-DD) of the source file
 * @returns {Array<{date: string, time: string, heading: string, rawText: string}>}
 */
function parseDailyFile(content, date) {
    const entries = [];
    // Split on compaction headings — keep the heading as part of each chunk
    const chunks = String(content).split(/(?=^## \d{2}:\d{2} — )/m).filter(s => s.trim());

    for (const chunk of chunks) {
        const headingMatch = chunk.match(/^(## \d{2}:\d{2} — [^\n]*)/);
        if (!headingMatch) continue;
        const timeMatch = chunk.match(/^## (\d{2}:\d{2}) — /);
        if (!timeMatch) continue;
        entries.push({
            date,
            time: timeMatch[1],
            heading: headingMatch[1],
            rawText: chunk.trim(),
        });
    }

    return entries;
}

/**
 * Extract meaningful keywords from a parsed entry's rawText.
 * Pulls: branch name, source title, commit subjects (first 4 words per commit),
 * in-progress story names, and key-decision table cells.
 *
 * @param {{rawText: string}} entry
 * @returns {Set<string>} lowercased keyword tokens, length > 2 chars
 */
function extractKeywords(entry) {
    const keywords = new Set();
    const text = entry.rawText || '';

    // Branch name (skip generic "ingested" branch)
    const branchMatch = text.match(/\*\*Branch:\*\*\s*(.+)/);
    if (branchMatch) {
        const branchValue = branchMatch[1].trim();
        if (branchValue !== 'ingested') {
            const branchTokens = branchValue.split(/[-_/]/);
            for (const t of branchTokens) {
                const clean = t.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (clean.length > 2) keywords.add(clean);
            }
        }
    }

    // Source title (from ingested recaps)
    const sourceMatch = text.match(/\*\*Source:\*\*\s*(.+)/);
    if (sourceMatch) {
        const words = sourceMatch[1].trim().toLowerCase().split(/[\s+&,—–-]+/);
        for (const w of words) {
            const clean = w.replace(/[^a-z0-9]/g, '');
            if (clean.length > 2) keywords.add(clean);
        }
    }

    // Commit subjects — first 4 meaningful words per subject, skip hash + type prefix
    const commitSection = text.match(/### Recent Commits\s*```([\s\S]*?)```/);
    if (commitSection) {
        const lines = commitSection[1].trim().split('\n').filter(l => l.trim());
        for (const line of lines) {
            const subject = line.replace(/^[a-f0-9]+\s+/, '');
            const words = subject.toLowerCase().split(/\s+/);
            const meaningful = words
                .map(w => w.replace(/^[a-z]+:\s*/, '').replace(/[^a-z0-9]/g, ''))
                .filter(w => w.length > 2)
                .slice(0, 4);
            for (const w of meaningful) keywords.add(w);
        }
    }

    // In-progress story names
    const inProgressSection = text.match(/### In-Progress Work\s*([\s\S]*?)(?=\n###|\n##|$)/);
    if (inProgressSection) {
        const lines = inProgressSection[1].split('\n').filter(l => l.includes('[>]') || l.includes('[!]'));
        for (const line of lines) {
            const storyMatch = line.match(/(?:\[>\]|\[!\])\s*(.+?)(?:\s*\(|$)/);
            if (storyMatch) {
                const words = storyMatch[1].toLowerCase().split(/\s+/);
                for (const w of words) {
                    const clean = w.replace(/[^a-z0-9]/g, '');
                    if (clean.length > 2) keywords.add(clean);
                }
            }
        }
    }

    // Key decisions table — extract all cell text
    const decisionsSection = text.match(/### Key Decisions\s*([\s\S]*?)(?=\n##|$)/);
    if (decisionsSection) {
        const rows = decisionsSection[1].split('\n')
            .filter(r => r.startsWith('|') && !r.includes('---') && !r.match(/Decision.*Rationale.*Outcome/i));
        for (const row of rows) {
            const cells = row.split('|').map(c => c.trim()).filter(c => c);
            for (const cell of cells) {
                const words = cell.toLowerCase().split(/\s+/);
                for (const w of words) {
                    const clean = w.replace(/[^a-z0-9]/g, '');
                    if (clean.length > 2) keywords.add(clean);
                }
            }
        }
    }

    return keywords;
}

module.exports = { parseDailyFile, extractKeywords };
