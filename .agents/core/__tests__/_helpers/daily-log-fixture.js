/**
 * daily-log-fixture — writes daily log markdown files consumable by
 * MemoryCompiler.parseDailyFile() and MemoryCompiler.extractKeywords().
 * CommonJS (not ESM) — loaded via createRequire() bridge in test files.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Build a single entry's markdown chunk.
 * Sections are OMITTED when the corresponding field is absent or empty.
 *
 * Required: time (HH:MM), trigger (label after em-dash)
 * Optional: branch, commits [{hash, message}], inProgress [string], decisions [string]
 */
function buildEntry(entry) {
  const lines = [];
  lines.push(`## ${entry.time} — ${entry.trigger}`);
  lines.push('');

  if (entry.branch) {
    lines.push(`**Branch:** ${entry.branch}`);
    lines.push('');
  }

  if (Array.isArray(entry.commits) && entry.commits.length > 0) {
    lines.push('### Recent Commits');
    lines.push('```');
    for (const c of entry.commits) {
      lines.push(`${c.hash} ${c.message}`);
    }
    lines.push('```');
    lines.push('');
  }

  if (Array.isArray(entry.inProgress) && entry.inProgress.length > 0) {
    lines.push('### In-Progress Work');
    for (const item of entry.inProgress) {
      lines.push(`- [>] ${item}`);
    }
    lines.push('');
  }

  if (Array.isArray(entry.decisions) && entry.decisions.length > 0) {
    lines.push('### Key Decisions');
    lines.push('| Decision | Rationale | Outcome |');
    lines.push('| --- | --- | --- |');
    for (const d of entry.decisions) {
      lines.push(`| ${d} | rationale | outcome |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * createDailyLog(tmpDirHelper, date, entries)
 *
 * Writes `{tmpDirHelper.root}/docs/.output/.state/memory-daily/{date}.md`.
 * Returns the absolute path written.
 */
function createDailyLog(tmpDirHelper, date, entries = []) {
  const body = entries.map(buildEntry).join('\n');
  const relPath = `docs/.output/.state/memory-daily/${date}.md`;
  return tmpDirHelper.write(relPath, body);
}

module.exports = { createDailyLog, buildEntry };
