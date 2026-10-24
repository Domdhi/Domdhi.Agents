/**
 * concept-fixture — writes concept article markdown files consumable by
 * MemoryCompiler.parseFrontmatter() and readable by MemoryBenchmark.readIndexMd().
 * CommonJS (not ESM) — loaded via createRequire() bridge in test files.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * createConcept(tmpDirHelper, category, slug, opts)
 *
 * opts:
 *   title        {string}   — concept title (required)
 *   confidence   {number}   — 0.0–1.0 (required)
 *   sources      {string[]} — source date strings like '2026-01-01' (required)
 *   usage_count  {number}   — convenience input; written as scalar field (optional)
 *   content      {string}   — body text after frontmatter (optional, defaults to '')
 *
 * Writes to: {tmpDirHelper.root}/docs/.output/.state/memory-concepts/{category}/{slug}.md
 * Returns the absolute path written.
 *
 * Frontmatter matches memory-compiler.parseFrontmatter() expectations:
 *   - List fields (sources, tags, aliases, cssclasses) use `key:\n  - item` format.
 *   - Scalar fields use `key: value` format.
 *   - parseFrontmatter returns scalars as strings — callers must assert '0.7' not 0.7.
 */
function createConcept(tmpDirHelper, category, slug, opts) {
  const {
    title,
    confidence,
    sources = [],
    usage_count,
    content = '',
  } = opts;

  const now = new Date().toISOString();
  const today = now.slice(0, 10); // YYYY-MM-DD

  const sourceCount = sources.length;
  const sortedSources = [...sources].sort();

  // Build YAML frontmatter matching parseFrontmatter()'s list/scalar parser.
  // List fields: sources, tags, aliases, cssclasses — each needs `key:\n` (no value)
  // then `  - item` lines. Scalar fields: `key: value` on one line.
  const sourcesYaml = sortedSources.map(s => `  - ${s}`).join('\n');
  const tagsYaml = `  - ${category}`;
  const aliasesYaml = `  - ${title}`;

  const frontmatterLines = [
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
    `created: ${today}`,
    `updated: ${today}`,
    `confidence: ${confidence}`,
    `source_count: ${sourceCount}`,
    `entry_count: 1`,
  ];

  // Include usage_count as an extra scalar field if provided, alongside source_count.
  if (usage_count !== undefined) {
    frontmatterLines.push(`usage_count: ${usage_count}`);
  }

  frontmatterLines.push('---');

  const frontmatter = frontmatterLines.join('\n');

  const body = content
    ? `\n## Summary\n\n${content}\n`
    : '\n## Summary\n\n_No content provided._\n';

  const fileContent = frontmatter + '\n' + body;

  const relPath = path.join(
    'docs', '.output', '.state', 'memory-concepts', category, `${slug}.md`
  );

  return tmpDirHelper.write(relPath, fileContent);
}

/**
 * createConceptIndex(tmpDirHelper)
 *
 * Scans concept files already written inside tmpDirHelper and writes
 * docs/.output/.state/memory-concepts/index.md.
 *
 * The index is non-empty and lists every concept by category/slug/title.
 * Format mirrors memory-compiler.generateIndex() (plain markdown, not Dataview)
 * so that MemoryBenchmark.readIndexMd() returns a truthy string.
 *
 * Returns the absolute path written.
 */
function createConceptIndex(tmpDirHelper) {
  const conceptsBase = path.join(
    tmpDirHelper.root, 'docs', '.output', '.state', 'memory-concepts'
  );

  // Collect written concept files by scanning category subdirectories.
  const concepts = [];

  if (fs.existsSync(conceptsBase)) {
    const entries = fs.readdirSync(conceptsBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const category = entry.name;
      const catDir = path.join(conceptsBase, category);
      const files = fs.readdirSync(catDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const slug = file.replace(/\.md$/, '');
        const filePath = path.join(catDir, file);
        const raw = fs.readFileSync(filePath, 'utf8');

        // Extract title from frontmatter (simple inline parse — avoids circular
        // dependency on MemoryCompiler inside the fixture itself).
        let title = slug;
        const titleMatch = raw.match(/^title:\s*(.+)$/m);
        if (titleMatch) title = titleMatch[1].trim();

        concepts.push({ category, slug, title });
      }
    }
  }

  // Build index content in a format readable by readIndexMd() (non-empty string).
  const now = new Date().toISOString();
  const lines = [
    '# Memory Concepts Index',
    '',
    `Last compiled: ${now.slice(0, 10)}`,
    '',
  ];

  // Group by category.
  const byCategory = {};
  for (const c of concepts) {
    if (!byCategory[c.category]) byCategory[c.category] = [];
    byCategory[c.category].push(c);
  }

  for (const [category, items] of Object.entries(byCategory).sort()) {
    lines.push(`## ${category}`);
    lines.push('');
    for (const item of items.sort((a, b) => a.slug.localeCompare(b.slug))) {
      lines.push(`- [[${item.slug}]] — ${item.title}`);
    }
    lines.push('');
  }

  if (concepts.length === 0) {
    lines.push('_No concepts compiled yet._');
    lines.push('');
  }

  const content = lines.join('\n');
  const relPath = path.join('docs', '.output', '.state', 'memory-concepts', 'index.md');
  return tmpDirHelper.write(relPath, content);
}

module.exports = { createConcept, createConceptIndex };
