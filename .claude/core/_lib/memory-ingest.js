/**
 * Memory Ingest — convert agent-memory markdown files into structured JSON memories.
 *
 * Extracted from memory-manager.js:554-718. Decoupled from MemoryManager via
 * dependency injection: caller provides `readMemory` (for dedup check) and
 * `createMemory` (for the actual write). The 3 helpers (_parseFrontmatter,
 * _typeToCategory, _idFromFilename, _findMarkdownFiles) become module-scope
 * pure functions since they had no `this.*` state.
 *
 * Caller flow (typical):
 *   const { ingestAgentMemory } = require('./_lib/memory-ingest');
 *   await ingestAgentMemory(sourcePath, {
 *     dryRun: false,
 *     readMemory:   (cat, id) => manager.readMemory(cat, id),
 *     createMemory: (cat, id, content) => manager.createMemory(cat, id, content),
 *   });
 */

const fs = require('fs').promises;
const path = require('path');
const { parseFrontmatter } = require('./frontmatter');

// ---------------------------------------------------------------------------
// Pure helpers (previously static methods on MemoryManager)
// ---------------------------------------------------------------------------

/**
 * Map an auto-memory `type` frontmatter value to a JSON-store category.
 * Returns null for unknown types so the caller can report an error.
 */
function typeToCategory(type) {
    const map = {
        feedback: 'patterns',
        pattern: 'patterns',
        constraint: 'constraints',
        decision: 'decisions',
        workflow: 'workflows',
        'rejected-approach': 'rejected-approaches',
    };
    return map[type] || null;
}

/**
 * Derive a memory id from a markdown filename (or a relative path):
 *   feedback_execsync_spy_destructured.md          → feedback-execsync-spy-destructured
 *   general-purpose/feedback_testing.md            → general-purpose-feedback-testing
 *
 * Path separators become part of the id (M9): all 11 agents recommend the SAME
 * generic filenames (feedback_testing.md, user_role.md, …), so a basename-only id
 * collided two agents' files onto one (category, id) and silently dropped the
 * second. Including the agent (parent) dir namespaces them apart. A bare filename
 * with no separator is unchanged, preserving the prior behavior.
 */
function idFromFilename(filename) {
    return filename
        .replace(/\.md$/i, '')
        .replace(/[\\/]/g, '-')   // path separators → per-agent namespace
        .replace(/_/g, '-');
}

/**
 * Recursively find `.md` files under a path, skipping `MEMORY.md` index files.
 * If `sourcePath` points to a single file, returns just that file (if it qualifies).
 */
async function findMarkdownFiles(sourcePath) {
    const results = [];
    let stat;
    try {
        stat = await fs.stat(sourcePath);
    } catch {
        return results;
    }

    if (stat.isFile()) {
        if (sourcePath.toLowerCase().endsWith('.md') &&
            path.basename(sourcePath).toLowerCase() !== 'memory.md') {
            results.push(sourcePath);
        }
        return results;
    }

    if (!stat.isDirectory()) return results;

    const entries = await fs.readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(sourcePath, entry.name);
        if (entry.isDirectory()) {
            const nested = await findMarkdownFiles(full);
            results.push(...nested);
        } else if (entry.isFile()) {
            if (entry.name.toLowerCase().endsWith('.md') &&
                entry.name.toLowerCase() !== 'memory.md') {
                results.push(full);
            }
        }
    }
    return results;
}

// ---------------------------------------------------------------------------
// Main ingestion flow
// ---------------------------------------------------------------------------

/**
 * Ingest auto-memory markdown files into the structured JSON memory store.
 *
 * @param {string} sourcePath   File or directory to walk
 * @param {object} opts
 * @param {boolean}  [opts.dryRun=false]
 * @param {(cat: string, id: string) => Promise<object|null>} opts.readMemory
 * @param {(cat: string, id: string, content: object) => Promise<object|null>} opts.createMemory
 * @returns {Promise<{ingested: number, skipped: number, errors: Array<{file, reason}>}>}
 */
async function ingestAgentMemory(sourcePath, { dryRun = false, readMemory, createMemory }) {
    const report = { ingested: 0, skipped: 0, errors: [] };

    const files = await findMarkdownFiles(sourcePath);
    if (files.length === 0) return report;

    // Namespace derived ids by their path RELATIVE to the walked root (M9): for a
    // directory source (e.g. .claude/agent-memory/) that yields "{agent}/{file}.md"
    // so two agents' same-named files get distinct ids. For a single-file source,
    // relative-to-its-dir collapses to the basename — the prior behavior.
    let sourceRoot = sourcePath;
    try {
        const st = await fs.stat(sourcePath);
        if (st.isFile()) sourceRoot = path.dirname(sourcePath);
    } catch { /* findMarkdownFiles already returned [] on a bad path */ }

    for (const file of files) {
        let raw;
        try {
            raw = await fs.readFile(file, 'utf8');
        } catch (err) {
            report.errors.push({ file, reason: `read failed: ${err.message}` });
            continue;
        }

        const parsed = parseFrontmatter(raw, { returnBody: true });
        if (!parsed) {
            report.errors.push({ file, reason: 'missing or malformed frontmatter' });
            continue;
        }

        const { frontmatter, body } = parsed;
        const type = (frontmatter.type || '').trim();
        const category = typeToCategory(type);
        if (!category) {
            report.errors.push({ file, reason: `unknown type: "${type}"` });
            continue;
        }

        const id = idFromFilename(path.relative(sourceRoot, file));
        const existing = await readMemory(category, id);
        if (existing) {
            report.skipped++;
            continue;
        }

        if (dryRun) {
            report.ingested++;
            continue;
        }

        const content = {
            description: (frontmatter.description || '').trim(),
            body: body.trim(),
            source: 'agent-memory',
            originalName: (frontmatter.name || '').trim(),
        };

        try {
            const created = await createMemory(category, id, content);
            if (created === null) {
                report.errors.push({ file, reason: 'category full (per-category cap reached)' });
            } else {
                report.ingested++;
            }
        } catch (err) {
            report.errors.push({ file, reason: `createMemory threw: ${err.message}` });
            continue;
        }
    }

    return report;
}

module.exports = {
    ingestAgentMemory,
    // Exported for direct test access and re-use by downstream scripts
    typeToCategory,
    idFromFilename,
    findMarkdownFiles,
};
