/**
 * doc-drift — detect legacy / duplicate planning docs that the canonical
 * domain-taxonomy naming has superseded (F2).
 *
 * Brownfield repos (and repos that predate a naming change) accumulate planning
 * docs under OLD names — `_architecture.md`, `_prd.md`, a root `_backlog.md`
 * beside `todo/_backlog.md`, two `_feature-ideas.md`. The create-chain only ever
 * touches its canonical paths, so these legacy/duplicate files are invisible to
 * it and silently drift (two PRDs, two backlogs). This module makes them visible
 * so `/onboard` can reconcile them and `/review:check-sync` can flag them.
 *
 * Exports:
 *   detectDocDrift(projectRoot) → { legacy: [...], duplicates: [...], hasDrift }
 *
 * CLI:
 *   node doc-drift.js [projectRoot]
 *   Exit 0 — no drift
 *   Exit 1 — drift found (report on stdout)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Legacy doc name → canonical domain path it was superseded by (ADR docs/ Domain
// Taxonomy). Two generations of legacy names map to the domain layout: the
// brownfield short names (`_architecture.md`) AND the pre-taxonomy flat
// `_project-*` names this migration superseded.
const LEGACY_TO_CANONICAL = {
    // brownfield short names
    '_architecture.md': 'architecture/overview.md',
    '_prd.md': 'product/requirements.md',
    '_requirements.md': 'product/requirements.md',
    '_brief.md': 'product/brief.md',
    '_design.md': 'design/spec.md',
    '_context.md': 'product/context.md',
    // pre-taxonomy flat `_project-*` layout → domain paths
    '_project-architecture.md': 'architecture/overview.md',
    '_project-requirements.md': 'product/requirements.md',
    '_project-brief.md': 'product/brief.md',
    '_project-design.md': 'design/spec.md',
    '_project-context.md': 'product/context.md',
    '_project-timeline.md': 'work/timeline.md',
};

// Basenames that have ONE canonical home; if the same name also exists at the
// docs/ root (the non-canonical spot), that's a duplicate. [name, canonicalRel].
const CANONICAL_LOCATIONS = [
    ['_backlog.md', 'work/backlog.md'],
    ['backlog.md', 'work/backlog.md'],
    ['_feature-ideas.md', 'work/todo/feature-ideas.md'],
    ['feature-ideas.md', 'work/todo/feature-ideas.md'],
];

const TEMPLATE_MARKER = '<!-- @@template -->';

// TODO files have exactly two canonical homes (relative to docs/):
//   • the master index  → docs/ root            (TODO_{Project}.md)
//   • per-epic / backlog → docs/work/todo/      (TODO_epic*.md, TODO*.md)
// A TODO file anywhere else under docs/** (e.g. a stale docs/work/TODO_epic00.md
// left by an older plan) is invisible to the create-chain and to /status, which
// only glob the canonical paths — so it silently orphans (F17). These dirs are
// skipped entirely when walking for misplaced TODOs.
//   • `_archive` (underscore) is where /evolve parks a closed cycle's TODO_epic*.md
//     via git mv (docs/work/todo/_archive/cycle-N-{stamp}/). Those are intentionally
//     retired, history-preserving copies — not misplaced live TODOs (EV7). `.archive`
//     (dot) is kept too for any legacy hand-rolled archive dir.
const TODO_SKIP_DIRS = new Set(['.output', '.archive', '_archive', 'node_modules', '.git', 'design', 'scratch']);
const TODO_CANONICAL_DIRS = new Set(['', 'work/todo']); // relative to docs/ (ADR domain taxonomy)
// Subfolders UNDER the canonical todo root are also canonical — an adopter that
// groups its checklists (work/todo/{group}/TODO_*.md) is organizing, not misplacing.
// (Harvested from an adopter's page-folder layout, 2026-07-16; their `modules/` resting
// place was NOT adopted — it's project taxonomy, not the shared convention.)
const TODO_CANONICAL_PREFIXES = ['work/todo/'];
const isCanonicalTodoDir = (relDir) =>
    TODO_CANONICAL_DIRS.has(relDir) || TODO_CANONICAL_PREFIXES.some((p) => relDir.startsWith(p));

/** True if a file exists and is NOT just an unfilled scaffold stub. */
function isRealDoc(absPath) {
    try {
        const content = fs.readFileSync(absPath, 'utf8');
        return !content.startsWith(TEMPLATE_MARKER);
    } catch {
        return false;
    }
}

/**
 * Grade a planning doc with deterministic (code-only, no-LLM) placeholder and
 * structural checks (T.1). Extends isRealDoc(): a template stub fast-fails first.
 *
 * Checks:
 *   • placeholder tokens — literal `TBD`, `TODO`, mustache `{{…}}`, and bare
 *     `{…}` (single-brace) outside fenced code blocks
 *   • per-FR acceptance criteria — each `#### FR-N:` block needs ≥1 line carrying
 *     all three of Given / When / Then (case-insensitive)
 *   • MoSCoW prioritization — if ≥2 FRs and EVERY one is `Must Have` → fail
 *   • Success Criteria table — the `## Success Criteria` section needs ≥1 data row
 *     whose cells are non-placeholder (not empty, no `{…}`)
 *
 * @param {string} absPath
 * @returns {{ pass: boolean, failures: string[] }}  pass===true ⇒ failures===[]
 */
function gradeDoc(absPath) {
    if (!isRealDoc(absPath)) {
        return { pass: false, failures: ['template stub / unfilled scaffold (fails isRealDoc)'] };
    }

    let content;
    try {
        content = fs.readFileSync(absPath, 'utf8');
    } catch {
        return { pass: false, failures: ['unreadable file'] };
    }

    const failures = [];
    const lines = content.split('\n');

    // ── Placeholder scan — track fenced-code state so braces in code are ignored ──
    let inFence = false;
    let placeholderFound = false;
    for (const line of lines) {
        const fenceToggle = /^\s*(```|~~~)/.test(line);
        if (fenceToggle) { inFence = !inFence; continue; }
        if (inFence) continue;
        // Ignore braces inside inline-code spans (`{n}`, `{1,5}`) — those are code,
        // not unfilled placeholders.
        const bare = line.replace(/`[^`]*`/g, '');
        const braceMatch = bare.match(/\{([^}]*)\}/);
        // A pure numeric regex quantifier ({3}, {1,5}) is not a template placeholder.
        const isQuantifier = braceMatch && /^\d+(\s*,\s*\d*)?$/.test(braceMatch[1].trim());
        if (/\bTBD\b/.test(bare) || /\bTODO\b/.test(bare) || bare.includes('{{') || (braceMatch && !isQuantifier)) {
            placeholderFound = true;
            break;
        }
    }
    if (placeholderFound) {
        failures.push('placeholder token left unfilled (TBD / TODO / {{…}} / bare {…})');
    }

    // ── Per-FR acceptance criteria + MoSCoW collection ──
    // Walk FR blocks: a block runs from a `#### FR-N:` heading until the next
    // `####`/`##`/`#` heading or EOF.
    const frBlocks = [];
    let current = null;
    for (const line of lines) {
        const frMatch = line.match(/^####\s+(FR-\d+)\b/i);
        if (frMatch) {
            current = { id: frMatch[1], lines: [] };
            frBlocks.push(current);
            continue;
        }
        if (/^#{1,6}\s/.test(line)) {
            // Any other heading (H1–H6) closes the current FR block — a deeper
            // subsection's content is not the FR's own acceptance criteria.
            current = null;
            continue;
        }
        if (current) current.lines.push(line);
    }

    // Accept acceptance criteria either all-on-one-line ("Given … When … Then …")
    // or as a multi-line Gherkin block (separate Given / When / Then lines).
    const gwt = (line) => /\bgiven\b/i.test(line) && /\bwhen\b/i.test(line) && /\bthen\b/i.test(line);
    const blockHasAc = (blk) =>
        blk.lines.some(gwt) ||
        (blk.lines.some((l) => /\bgiven\b/i.test(l)) &&
            blk.lines.some((l) => /\bwhen\b/i.test(l)) &&
            blk.lines.some((l) => /\bthen\b/i.test(l)));
    const priorities = [];
    for (const block of frBlocks) {
        const hasAc = blockHasAc(block);
        if (!hasAc) {
            failures.push(`${block.id} is missing a Given/When/Then acceptance criteria line`);
        }
        for (const line of block.lines) {
            const pm = line.match(/\*\*Priority\*\*:\s*(.+?)\s*$/i);
            if (pm) priorities.push(pm[1].trim());
        }
    }

    if (priorities.length >= 2 && priorities.every((p) => /^must have\b/i.test(p))) {
        failures.push('every FR is Must Have — MoSCoW priority gives no real prioritization');
    }

    // ── Success Criteria table — ≥1 non-placeholder data row ──
    // Accept the section at H2 or H3 (it is sometimes nested under a feature heading).
    let scIdx = -1;
    let scDepth = 2;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(#{2,3})\s+Success Criteria\b/i);
        if (m) { scIdx = i; scDepth = m[1].length; break; }
    }
    const scEnd = new RegExp(`^#{1,${scDepth}}\\s`); // a same-or-shallower heading ends the table
    let successOk = false;
    let sawSeparator = false;
    if (scIdx !== -1) {
        for (let i = scIdx + 1; i < lines.length; i++) {
            const line = lines[i];
            if (scEnd.test(line)) break; // next section ends the table search
            if (!/^\s*\|/.test(line)) continue; // not a table row
            const cells = line.split('|').slice(1, -1).map((c) => c.trim());
            if (cells.length === 0) continue;
            // The header separator row (e.g. |---|---|) marks the header/data boundary.
            if (cells.every((c) => /^:?-+:?$/.test(c) || c === '')) { sawSeparator = true; continue; }
            // A data row only counts once the separator has been seen — a well-formed
            // markdown table is always header | separator | data. This stops a header-only
            // (separator-less) table, even one with custom-worded headers, from passing as
            // if it carried data. Rows before the separator are headers, skipped.
            if (!sawSeparator) continue;
            const isPlaceholderRow = cells.some((c) => c === '' || /\{[^}]*\}/.test(c));
            if (!isPlaceholderRow) { successOk = true; break; }
        }
    }
    if (!successOk) {
        failures.push('Success Criteria table has no filled (non-placeholder) data row');
    }

    return { pass: failures.length === 0, failures };
}

/**
 * Strip the template marker from the first line of a file if present.
 * No-ops if already stripped or the file is unreadable. Returns true if modified.
 */
function stripTemplateMarker(absPath) {
    try {
        const content = fs.readFileSync(absPath, 'utf8');
        if (!content.startsWith(TEMPLATE_MARKER)) return false;
        fs.writeFileSync(absPath, content.slice(TEMPLATE_MARKER.length).replace(/^\n/, ''), 'utf8');
        return true;
    } catch {
        return false;
    }
}

/**
 * Walk docs/** for TODO_*.md files that live outside the two canonical homes
 * (docs/ root for the master index, docs/work/todo/ for per-epic/backlog TODOs).
 * Returns relative paths like `docs/work/TODO_epic00.md` (F17).
 *
 * @param {string} docsDir  Absolute path to <projectRoot>/docs
 * @returns {Array<{ file: string, dir: string }>}
 */
function findMisplacedTodos(docsDir) {
    const misplaced = [];
    const walk = (absDir, relDir) => {
        let entries;
        try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
        catch { return; }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (TODO_SKIP_DIRS.has(entry.name)) continue;
                walk(path.join(absDir, entry.name), relDir ? `${relDir}/${entry.name}` : entry.name);
            } else if (entry.isFile() && /^TODO.*\.md$/i.test(entry.name)) {
                if (!isCanonicalTodoDir(relDir)) {
                    misplaced.push({ file: `docs/${relDir ? relDir + '/' : ''}${entry.name}`, dir: `docs/${relDir}` });
                }
            }
        }
    };
    walk(docsDir, '');
    return misplaced;
}

/**
 * Detect legacy and duplicate planning docs under `<projectRoot>/docs`.
 *
 * @param {string} projectRoot
 * @returns {{ legacy: Array, duplicates: Array, misplacedTodos: Array, hasDrift: boolean }}
 *   legacy:         { file, canonical, canonicalExists } — a legacy-named real doc
 *   duplicates:     { name, root, canonical } — same basename at root AND canonical path
 *   misplacedTodos: { file, dir } — a TODO_*.md outside docs/ root and docs/work/todo/
 */
function detectDocDrift(projectRoot) {
    const docsDir = path.join(projectRoot, 'docs');
    const legacy = [];
    const duplicates = [];
    const misplacedTodos = findMisplacedTodos(docsDir);

    for (const [legacyName, canonicalName] of Object.entries(LEGACY_TO_CANONICAL)) {
        const legacyPath = path.join(docsDir, legacyName);
        if (isRealDoc(legacyPath)) {
            legacy.push({
                file: `docs/${legacyName}`,
                canonical: `docs/${canonicalName}`,
                canonicalExists: isRealDoc(path.join(docsDir, canonicalName)),
            });
        }
    }

    for (const [name, canonicalRel] of CANONICAL_LOCATIONS) {
        const rootPath = path.join(docsDir, name);
        const canonicalPath = path.join(docsDir, canonicalRel);
        if (isRealDoc(rootPath) && isRealDoc(canonicalPath)) {
            duplicates.push({ name, root: `docs/${name}`, canonical: `docs/${canonicalRel}` });
        }
    }

    return {
        legacy, duplicates, misplacedTodos,
        hasDrift: legacy.length > 0 || duplicates.length > 0 || misplacedTodos.length > 0,
    };
}

function main() {
    // `grade <path>` subcommand — code-graded quality gate on a single doc.
    if (process.argv[2] === 'grade') {
        const docPath = process.argv[3];
        if (!docPath) {
            process.stderr.write('usage: doc-drift.js grade <path>\n');
            process.exit(2);
            return;
        }
        const result = gradeDoc(path.resolve(docPath));
        if (result.pass) {
            process.stdout.write(`PASS — ${docPath}\n`);
        } else {
            process.stdout.write(`FAIL — ${docPath}\n`);
            for (const f of result.failures) process.stdout.write(`  • ${f}\n`);
        }
        process.exit(result.pass ? 0 : 1);
        return;
    }

    const projectRoot = process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const { legacy, duplicates, misplacedTodos, hasDrift } = detectDocDrift(projectRoot);

    if (!hasDrift) {
        process.stdout.write('No legacy/duplicate planning docs detected.\n');
        process.exit(0);
    }

    const lines = ['Document drift detected:', ''];
    if (legacy.length) {
        lines.push('Legacy-named docs (superseded by canonical domain-taxonomy names):');
        for (const l of legacy) {
            lines.push(`  • ${l.file}  →  ${l.canonical}` +
                (l.canonicalExists ? '  (BOTH exist — reconcile & remove the legacy one)' : '  (rename/migrate to canonical)'));
        }
        lines.push('');
    }
    if (duplicates.length) {
        lines.push('Duplicate docs (same name at root AND canonical location):');
        for (const d of duplicates) lines.push(`  • ${d.root}  vs  ${d.canonical}  (keep canonical, remove the root copy)`);
        lines.push('');
    }
    if (misplacedTodos.length) {
        lines.push('Misplaced TODO files (outside docs/ root and docs/work/todo/ — invisible to the create-chain and /status):');
        for (const m of misplacedTodos) lines.push(`  • ${m.file}  (move to docs/work/todo/ or remove if superseded)`);
        lines.push('');
    }
    lines.push('Reconcile via /onboard (archives/removes legacy docs) or clean up manually.');
    process.stdout.write(lines.join('\n') + '\n');
    process.exit(1);
}

module.exports = { detectDocDrift, findMisplacedTodos, isRealDoc, gradeDoc, stripTemplateMarker, LEGACY_TO_CANONICAL, CANONICAL_LOCATIONS, main };

if (require.main === module) main();
