/**
 * adr-parser.js — reusable ADR file/status parsing primitives.
 *
 * Extracted from adr-lint.js (F6): decision-graph.js (a _lib module) used to
 * `require('../adr-lint')` — a _lib helper importing upward from a top-level
 * core/ CLI inverts the dependency direction (core CLIs consume _lib, never
 * the reverse). Both adr-lint.js and decision-graph.js consume this module
 * now; adr-lint.js re-exports these names so its existing consumers/tests
 * keep working.
 *
 * Convention (this toolkit's docs/ Domain Taxonomy — ADR 0005):
 *   - ADRs live in docs/architecture/decisions/ as NNNN-title.md (zero-padded,
 *     chronological; migrate-docs-domains.js assigns the numbers).
 *   - The header is a table: `| **Status** | Accepted |`, plus optional
 *     `| **Supersedes** | … |` / `| **Superseded by** | … |` rows.
 */

'use strict';

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

module.exports = { ADR_FILE_RE, ADR_HEADING_RE, looksLikeAdr, readStatus, supersedesRefs, saysSuperseded };
