#!/usr/bin/env node
/**
 * adr-lint.js — ADR registry consistency linter.
 *
 * ADRs are immutable decision records; the disorder that accumulates is NOT
 * conflicting decisions but stale bookkeeping — a record says it supersedes an
 * older one while that older one's Status still reads "Accepted", a file filed
 * outside the canonical decisions/ dir, a duplicate number, or a record with no
 * Status field at all. This linter catches those so the ADR corpus cannot
 * silently rot.
 *
 * Convention (this toolkit's docs/ Domain Taxonomy — ADR 0005):
 *   - ADRs live in docs/architecture/decisions/ as NNNN-title.md (zero-padded,
 *     chronological; migrate-docs-domains.js assigns the numbers).
 *   - The header is a table: `| **Status** | Accepted |`, plus optional
 *     `| **Supersedes** | … |` / `| **Superseded by** | … |` rows.
 *
 * Checks (per docs/architecture/decisions/NNNN-*.md):
 *   - NO_STATUS        : no Status field (table or legacy bullet)            -> ERROR
 *   - DUP_NUMBER       : two records share the same NNNN prefix             -> ERROR
 *   - SUPERSEDE_STALE  : record A's Supersedes row names an existing record
 *                        B, but B's Status does not say superseded          -> WARN
 *   - BAD_FILENAME     : a file in decisions/ not matching NNNN-*.md         -> WARN
 *   - HEADER_FORMAT    : Status uses the "- **Status:**" bullet form instead
 *                        of the canonical "| **Status** |" table row        -> WARN
 *   - ORPHAN_ADR       : an ADR-shaped file lives outside decisions/         -> WARN
 *
 * Exit code: 0 when clean or WARN-only; non-zero ONLY when an ERROR exists, so
 * /review:check-sync (and any CI gate) can hard-fail on real drift while
 * tolerating soft advisories.
 *
 * Usage:
 *   node .claude/core/adr-lint.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ADR_FILE_RE = /^(\d{3,4})-.+\.md$/;        // canonical: NNNN-title.md
const ADR_HEADING_RE = /^#\s*ADR\b/im;           // an "# ADR: …" first heading (content signal)

/**
 * Is a file outside decisions/ genuinely an ADR (vs. a NNNN/HHMM-prefixed
 * research note)? Explicit `ADR-NNN*.md` filenames count outright; a bare
 * `NNNN-title.md` only counts if its body actually carries an `# ADR` heading —
 * otherwise timestamped scratch files (`1030-research.md`) false-positive.
 */
function looksLikeAdr(name, fullPath, readFile) {
  if (/^ADR-\d+.*\.md$/i.test(name)) return true;
  if (/^\d{3,4}-.+\.md$/.test(name)) {
    try {
      // Only the FIRST heading counts — a real ADR leads with "# ADR: …".
      // A research note that merely quotes the ADR template deeper down does not.
      const firstHeading = (readFile(fullPath).match(/^#\s+.+$/m) || [''])[0];
      return ADR_HEADING_RE.test(firstHeading);
    } catch { return false; }
  }
  return false;
}

/** Extract the Status value from either the table row or the legacy bullet form. */
function readStatus(text) {
  const table = text.match(/^\|\s*\*\*Status\*\*\s*\|\s*(.+?)\s*\|/mi);
  if (table) return { value: table[1], form: 'table' };
  const bullet = text.match(/^-\s*\*\*Status:?\*\*\s*(.+)$/mi);
  if (bullet) return { value: bullet[1], form: 'bullet' };
  return { value: null, form: null };
}

/** Numbers referenced by a `| **Supersedes** | … |` row (NNNN or ADR-NNN forms). */
function supersedesRefs(text) {
  const row = text.match(/^\|\s*\*\*Supersedes\*\*\s*\|\s*(.+?)\s*\|/mi);
  if (!row) return [];
  const nums = new Set();
  // `ADR-N` (1–4 digits, prefix disambiguates) or a bare zero-padded `NNNN`.
  for (const m of row[1].matchAll(/ADR[- ]?(\d{1,4})|\b(\d{3,4})\b/gi)) nums.add(parseInt(m[1] ?? m[2], 10));
  return [...nums];
}

const saysSuperseded = (status) => /supersed/i.test(status || '');

/**
 * Pure linter. `adrs` = [{ num, name, text }] for files in the canonical dir;
 * `badNames` = names in the dir that don't match NNNN-*.md; `orphans` = repo-
 * relative paths of ADR-shaped files found outside the dir. Returns
 * { errors, warns }, each [{ file, code, msg }].
 */
function lint(adrs, badNames = [], orphans = []) {
  const errors = [];
  const warns = [];
  const err = (file, code, msg) => errors.push({ file, code, msg });
  const warn = (file, code, msg) => warns.push({ file, code, msg });

  const byNum = new Map();
  for (const a of adrs) {
    if (!byNum.has(a.num)) byNum.set(a.num, []);
    byNum.get(a.num).push(a);
  }
  for (const [num, group] of byNum) {
    if (group.length > 1) {
      err(group.map((g) => g.name).join(' / '), 'DUP_NUMBER', `ADR number ${num} used by ${group.length} files.`);
    }
  }

  for (const a of adrs) {
    const { value: status, form } = readStatus(a.text);
    if (!status) {
      err(a.name, 'NO_STATUS', 'No Status field found (expected "| **Status** |" table row).');
      continue;
    }
    if (form === 'bullet') {
      warn(a.name, 'HEADER_FORMAT', 'Status uses bullet form; canonical convention is the "| **Status** |" table row.');
    }
    for (const target of supersedesRefs(a.text)) {
      if (target === a.num) continue;
      const group = byNum.get(target);
      if (!group) continue; // supersedes prose or an absent record — not checkable
      for (const t of group) {
        if (!saysSuperseded(readStatus(t.text).value)) {
          warn(a.name, 'SUPERSEDE_STALE',
            `declares it supersedes ${t.name}, but that record's Status ("${(readStatus(t.text).value || '').slice(0, 40)}") does not say superseded.`);
        }
      }
    }
  }

  for (const n of badNames) warn(n, 'BAD_FILENAME', 'File in decisions/ does not match the NNNN-title.md convention.');
  for (const p of orphans) warn(p, 'ORPHAN_ADR', 'ADR-shaped file outside docs/architecture/decisions/ — relocate it.');

  return { errors, warns };
}

// ── fs gathering (impure) ───────────────────────────────────────────────────────
function gather(repoRoot) {
  const adrDir = path.join(repoRoot, 'docs', 'architecture', 'decisions');
  const adrs = [];
  const badNames = [];
  if (fs.existsSync(adrDir)) {
    for (const f of fs.readdirSync(adrDir).sort()) {
      if (!f.endsWith('.md')) continue;
      const m = f.match(ADR_FILE_RE);
      if (!m) { if (f !== 'CLAUDE.md' && f !== 'README.md') badNames.push(f); continue; }
      adrs.push({ num: parseInt(m[1], 10), name: f, text: fs.readFileSync(path.join(adrDir, f), 'utf8') });
    }
  }
  // ADR-shaped files anywhere else under docs/ (skip generated + canonical dir).
  const orphans = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.output' || e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (p !== adrDir) walk(p); }
      else if (looksLikeAdr(e.name, p, (fp) => fs.readFileSync(fp, 'utf8'))) {
        orphans.push(path.relative(repoRoot, p).replace(/\\/g, '/'));
      }
    }
  };
  const docsDir = path.join(repoRoot, 'docs');
  if (fs.existsSync(docsDir)) walk(docsDir);

  return { adrs, badNames, orphans };
}

function main() {
  const repoRoot = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
  const { adrs, badNames, orphans } = gather(repoRoot);
  const { errors, warns } = lint(adrs, badNames, orphans);

  const line = (x) => `  [${x.code}] ${x.file}: ${x.msg}`;
  if (warns.length) {
    console.log(`\nADR lint — ${warns.length} warning(s):`);
    warns.forEach((w) => console.log(line(w)));
  }
  if (errors.length) {
    console.log(`\nADR lint — ${errors.length} ERROR(s):`);
    errors.forEach((e) => console.log(line(e)));
    console.log(`\nFAIL: ADR corpus has ${errors.length} error(s).\n`);
    process.exit(1);
  }
  console.log(`\nOK: ADR lint clean — ${adrs.length} ADRs checked${warns.length ? ` (${warns.length} warning(s))` : ''}.\n`);
}

module.exports = { readStatus, supersedesRefs, saysSuperseded, lint, gather, looksLikeAdr, ADR_FILE_RE, main };

if (require.main === module) main();
