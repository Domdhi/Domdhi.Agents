/**
 * Decision Graph — data loader for the decision-viz pipeline.
 *
 * Extracted from decision-viz.js:112-334 (parseConcepts, parseCrossRefs,
 * parseGitLog, parseADRs, parseDailyLogs, parseMemoryRecords, collectData,
 * plus the helper functions safeReadDir, safeReadFile, warn). Frontmatter
 * parsing is the canonical _lib/frontmatter.js (F7 — the old local copy had
 * already drifted from it).
 *
 * Concern separated: all file I/O and subprocess calls for decision data are
 * here; rendering is in decision-html.js. The orchestrator (decision-viz.js)
 * calls loadDecisionData() then passes the result to renderDecisionHtml().
 *
 * DI seam: loadDecisionData accepts optional { execSync } for git calls.
 * Use the injection param in tests instead of vi.mock('child_process') —
 * vi.mock hoisting breaks across the createRequire(import.meta.url) boundary.
 * See project memory: patterns/di-test-seam-over-vi-mock-esm-cjs-boundary.
 *
 * Path anchoring: all I/O anchors to the passed `projectRoot`, never
 * process.cwd(). See project memory: patterns/anchor-paths-to-project-root-not-cwd.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
// _lib siblings only — the old `require('../adr-lint')` inverted the layering
// (a _lib helper importing a top-level core/ CLI, F6). adr-lint.js consumes
// the same _lib/adr-parser primitives, so the two parsers still can't diverge.
const { readStatus, ADR_FILE_RE } = require('./adr-parser');
const { parseFrontmatter } = require('./frontmatter');

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * @param {string} msg
 */
function warn(msg) {
  process.stderr.write(`[decision-graph] WARN: ${msg}\n`);
}

/**
 * @param {string} dir
 * @returns {fs.Dirent[]}
 */
function safeReadDir(dir) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    warn(`Cannot read directory: ${dir}`);
    return [];
  }
}

/**
 * @param {string} filePath
 * @returns {string|null}
 */
function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    warn(`Cannot read file: ${filePath}`);
    return null;
  }
}

// ── Parser 1: Concept articles ────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {string} args.conceptsDir  Absolute path to memories/concepts/
 * @param {string[]} args.categories Category slugs to scan
 * @returns {object[]}
 */
function parseConcepts({ conceptsDir, categories }) {
  const concepts = [];

  for (const category of categories) {
    const catDir = path.join(conceptsDir, category);
    const entries = safeReadDir(catDir);

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const filePath = path.join(catDir, entry.name);
      const content = safeReadFile(filePath);
      if (!content) continue;

      const fm = parseFrontmatter(content);
      if (!fm) continue;

      const slug = entry.name.replace(/\.md$/, '');

      // Extract summary from ## Summary section
      // \Z is not a valid JS regex anchor; use $ for end-of-string.
      const summaryMatch = content.match(/## Summary\r?\n\r?\n([\s\S]*?)(?=\r?\n## |\r?\n---|$)/);
      const summary = summaryMatch
        ? summaryMatch[1].trim().split('\n')[0].slice(0, 200)
        : '';

      concepts.push({
        slug,
        title: fm.title || slug,
        category: fm.category || category,
        confidence: parseFloat(fm.confidence) || 0.6,
        created: fm.created || null,
        updated: fm.updated || null,
        sources: fm.sources || [],
        tags: fm.tags || [],
        summary,
      });
    }
  }

  return concepts;
}

// ── Parser 2: Cross-references ────────────────────────────────────────────────

/**
 * @param {string} conceptsDir  Absolute path to memories/concepts/
 * @returns {object}
 */
function parseCrossRefs({ conceptsDir }) {
  const crossRefPath = path.join(conceptsDir, 'cross-references.json');
  // A missing cross-references.json is the normal pre-compilation state (no
  // concepts compiled yet), not an error — don't emit a "Cannot read file"
  // warning for it (F22). Only genuine read failures on an existing file warn.
  if (!fs.existsSync(crossRefPath)) return {};
  const content = safeReadFile(crossRefPath);
  if (!content) return {};

  try {
    return JSON.parse(content);
  } catch {
    warn('Invalid JSON in cross-references.json');
    return {};
  }
}

// ── Parser 3: Git log ─────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {string}   args.projectRoot  Absolute path to the repo root
 * @param {Date}     args.cutoffDate   Only include commits after this date
 * @param {Function} [args.execSync]   Optional DI seam — defaults to child_process.execSync
 * @returns {object[]}
 */
function parseGitLog({ projectRoot, cutoffDate, execSync = childProcess.execSync }) {
  const commits = [];
  const since = cutoffDate.toISOString().slice(0, 10);

  try {
    const raw = execSync(
      `git log --format="%H|%ad|%s" --date=iso --since="${since}" -500`,
      { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );

    for (const line of raw.split('\n').filter(Boolean)) {
      const parts = line.split('|');
      if (parts.length < 3) continue;
      const hash = parts[0];
      const date = parts[1].trim();
      const message = parts.slice(2).join('|').trim();

      commits.push({ hash, date, message });
    }
  } catch {
    warn('Cannot read git log (not a git repo or no commits)');
  }

  return commits;
}

// ── Parser 4: ADRs from the decisions/ directory ─────────────────────────────

// First prose paragraph of an ADR — preferably from the `## Context` section,
// skipping headings, table rows, list bullets, and the `---` rule.
function extractAdrSummary(content) {
  const ctx = content.match(/^##\s+Context\s*\r?\n([\s\S]*?)(?=\r?\n##\s|\r?\n---|$)/mi);
  const block = ctx ? ctx[1] : content;
  for (const raw of block.split('\n')) {
    const t = raw.trim();
    if (!t || t.startsWith('#') || t.startsWith('|') || t === '---'
      || t.startsWith('- ') || t.startsWith('* ') || /^\d+\.\s/.test(t)) continue;
    return t.slice(0, 200);
  }
  return '';
}

/**
 * Parse one ADR file per record from docs/architecture/decisions/NNNN-*.md — the
 * current convention (ADR 0005). The number comes from the NNNN filename prefix,
 * the Status from the `| **Status** |` table row (reusing adr-lint's readStatus so
 * the two parsers can't diverge), the title from the first `#` heading.
 *
 * Replaces the old parser that only understood inline `### ADR-N:` sections in a
 * single overview.md — that convention is superseded, so on a real repo it
 * returned [] and the dashboard's Decisions track was permanently empty (M7).
 *
 * @param {string} projectRoot  Absolute path to the project root
 * @returns {object[]}
 */
function parseADRs({ projectRoot }) {
  const adrs = [];
  const decisionsDir = path.join(projectRoot, 'docs', 'architecture', 'decisions');
  if (!fs.existsSync(decisionsDir)) return adrs;

  let files;
  try {
    files = fs.readdirSync(decisionsDir).sort();
  } catch {
    warn(`Cannot read directory: ${decisionsDir}`);
    return adrs;
  }

  for (const name of files) {
    const m = name.match(ADR_FILE_RE); // NNNN-title.md
    if (!m) continue;
    const content = safeReadFile(path.join(decisionsDir, name));
    if (!content) continue;

    const number = parseInt(m[1], 10);

    // Title: first heading, stripped of an "ADR:" / "ADR NNNN:" / "NNNN." prefix.
    const headingMatch = content.match(/^#\s+(.+?)\s*$/m);
    let title = headingMatch ? headingMatch[1].trim() : name.replace(/\.md$/, '');
    title = title
      .replace(/^ADR\b[-\s]*\d*\s*[:.–-]?\s*/i, '')
      .replace(/^\d+\s*[.–-]\s*/, '')
      .trim() || name.replace(/\.md$/, '');

    // Status: reuse adr-lint's table/bullet reader; take the first word ("Accepted").
    const statusRaw = readStatus(content).value;
    const status = statusRaw
      ? statusRaw.replace(/\*/g, '').trim().split(/\s+/)[0]
      : 'unknown';

    // Date: `| **Date** | YYYY-MM-DD |` table row, else the first ISO date in the body.
    const dateMatch = content.match(/^\|\s*\*\*Date\*\*\s*\|\s*([\d-]+)/mi)
      || content.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : null;

    adrs.push({ number, title, status, date, summary: extractAdrSummary(content) });
  }

  adrs.sort((a, b) => a.number - b.number);
  return adrs;
}

// ── Parser 5: Daily logs ──────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {string} args.dailyDir     Absolute path to memories/daily/
 * @param {Date}   args.cutoffDate   Exclude logs before this date
 * @returns {object[]}
 */
function parseDailyLogs({ dailyDir, cutoffDate }) {
  const logs = [];
  const entries = safeReadDir(dailyDir);

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    // Extract date from filename
    const dateMatch = entry.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!dateMatch) continue;

    const fileDate = new Date(dateMatch[1]);
    if (fileDate < cutoffDate) continue;

    const filePath = path.join(dailyDir, entry.name);
    const content = safeReadFile(filePath);
    if (!content) continue;

    // Extract entries: ## HH:MM — {trigger}
    // \Z is not a valid JS anchor (it only matches literal 'Z'); use $ for end-of-string.
    const entryRegex = /## (\d{2}:\d{2}) — (.+?)(?:\r?\n)([\s\S]*?)(?=\r?\n## |$)/g;
    let m;

    while ((m = entryRegex.exec(content)) !== null) {
      const time = m[1];
      const trigger = m[2].trim();
      const body = m[3].trim();

      // Extract branch info
      const branchMatch = body.match(/\*?\*?Branch:\*?\*?\s*(.+)/);
      const branch = branchMatch ? branchMatch[1].trim() : null;

      logs.push({
        date: dateMatch[1],
        time,
        trigger,
        branch,
        hasCommits: body.includes('### Recent Commits'),
        hasDecisions: body.includes('### Key Decisions'),
      });
    }
  }

  return logs;
}

// ── Parser 6: Memory JSON records ────────────────────────────────────────────

/**
 * @param {object} args
 * @param {string}   args.memoriesDir  Absolute path to memories/
 * @param {string[]} args.categories   Category slugs to scan
 * @returns {object[]}
 */
function parseMemoryRecords({ memoriesDir, categories }) {
  const records = [];

  for (const category of categories) {
    const catDir = path.join(memoriesDir, category);
    const entries = safeReadDir(catDir);

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = path.join(catDir, entry.name);
      const content = safeReadFile(filePath);
      if (!content) continue;

      try {
        const record = JSON.parse(content);
        records.push({
          id: record.id || entry.name.replace(/\.json$/, ''),
          category: record.category || category,
          confidence: record.metadata?.confidence ?? 1.0,
          created: record.created || null,
          updated: record.updated || null,
          usageCount: record.usage_count || 0,
          description: record.content?.description || record.content?.name || '',
        });
      } catch {
        warn(`Invalid JSON in memory record: ${filePath}`);
      }
    }
  }

  return records;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load all decision data for the visualization pipeline.
 *
 * @param {object} args
 * @param {string}   args.projectRoot   Absolute path to the project root (anchors all I/O)
 * @param {Date}     args.cutoffDate    Only include time-bounded data after this date
 * @param {string[]} args.categories    Memory category slugs (from CONSTANTS.MEMORY_CATEGORIES)
 * @param {Function} [args.execSync]    Optional DI seam for git calls (defaults to child_process.execSync)
 * @returns {{ concepts: object[], crossReferences: object, commits: object[], adrs: object[], memories: object[], dailyLogs: object[] }}
 */
function loadDecisionData({ projectRoot, cutoffDate, categories, execSync }) {
  // Split store (ADR 0006 Am. 2): JSON categories under .memory/; the derived
  // concepts + raw daily logs under .state/memory-*. Keep projectRoot
  // authoritative (callers/tests pass it) rather than the global accessor.
  const memoriesDir = path.join(projectRoot, 'docs', '.output', '.memory');
  const stateRoot = path.join(projectRoot, 'docs', '.output', '.state');
  const conceptsDir = path.join(stateRoot, 'memory-concepts');
  const dailyDir = path.join(stateRoot, 'memory-daily');

  return {
    concepts: parseConcepts({ conceptsDir, categories }),
    crossReferences: parseCrossRefs({ conceptsDir }),
    commits: parseGitLog({ projectRoot, cutoffDate, execSync }),
    adrs: parseADRs({ projectRoot }),
    dailyLogs: parseDailyLogs({ dailyDir, cutoffDate }),
    memories: parseMemoryRecords({ memoriesDir, categories }),
  };
}

module.exports = {
  loadDecisionData,
  // Exported for unit testing of individual parsers:
  parseConcepts,
  parseCrossRefs,
  parseGitLog,
  parseADRs,
  parseDailyLogs,
  parseMemoryRecords,
};
