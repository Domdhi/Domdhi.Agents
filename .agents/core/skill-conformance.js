/**
 * Skill spec conformance checker.
 *
 * Scans every .claude/skills/<dir>/SKILL.md and flags violations of the
 * Agent Skills open standard (agentskills.io):
 *
 *   - Body budget : SKILL.md > 500 lines           → WARN  (OVER_BUDGET)
 *   - Name match  : frontmatter name != parent dir → ERROR (NAME_MISMATCH)
 *   - Desc length : description > 1024 characters  → ERROR (DESC_TOO_LONG)
 *
 * Exit code: 0 when clean or WARN-only, non-zero ONLY when an ERROR exists.
 * Over-budget bodies are WARN (soft) so they don't fail a build gate — the
 * activation-cost budget is advisory; only hard spec violations (name/desc)
 * are errors.
 *
 * Line count uses whole-file (wc -l) semantics so it agrees with manual
 * `wc -l SKILL.md` checks and the AC example (`tailwind-css-patterns: 877 lines`).
 *
 * Usage:
 *   node .claude/core/skill-conformance.js
 *
 * Called by /review:check-templates (Step 2b). Can also run standalone.
 * Mirrors the CJS + `require.main === module` shape of gen-timeline.js.
 */

const fs = require('fs');
const path = require('path');

const BODY_BUDGET = 500;   // lines — spec activation budget (soft → WARN)
const DESC_MAX = 1024;     // chars — spec description ceiling (hard → ERROR)

// ── Pure helpers (unit-tested against fixtures, never the live tree) ─────────

/** Count lines with `wc -l` semantics: the number of newline characters. A file
 * with no trailing newline counts its last (unterminated) line as wc -l does —
 * i.e. NOT counted — so this agrees with `wc -l` for both cases (the old
 * split/pop form over-counted a no-trailing-newline file by one). */
function countLines(content) {
    return (content.match(/\n/g) || []).length;
}

/** Extract a single-line frontmatter field, stripping surrounding quotes. */
function parseField(frontmatter, field) {
    const re = new RegExp(`^${field}:\\s*(.*)$`, 'm');
    const m = frontmatter.match(re);
    if (!m) return null;
    let val = m[1].trim();
    if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
    ) {
        val = val.slice(1, -1);
    }
    return val;
}

/** Return the frontmatter block (between the first two `---` fences), or ''. */
function extractFrontmatter(content) {
    // Split on CRLF or LF — a Windows checkout (core.autocrlf=true, no .gitattributes
    // override) leaves \r on each line, which would make an exact `=== '---'` fence
    // match fail and silently report every field as null.
    const lines = content.split(/\r?\n/);
    if (lines[0] !== '---') return '';
    for (let i = 1; i < lines.length; i++) {
        if (lines[i] === '---') return lines.slice(0, i + 1).join('\n');
    }
    return content; // unterminated frontmatter — treat whole file as frontmatter
}

function checkBody(lineCount, budget = BODY_BUDGET) {
    return lineCount > budget
        ? { severity: 'WARN', code: 'OVER_BUDGET', value: lineCount }
        : null;
}

function checkName(name, dir) {
    return name !== dir
        ? { severity: 'ERROR', code: 'NAME_MISMATCH', value: name }
        : null;
}

function checkDescription(desc, max = DESC_MAX) {
    const len = (desc || '').length;
    return len > max
        ? { severity: 'ERROR', code: 'DESC_TOO_LONG', value: len }
        : null;
}

/**
 * Evaluate one skill's parsed facts into a list of findings.
 * Pure — takes values, not file paths, so it is testable without fs.
 */
function evaluateSkill({ dir, name, description, lineCount, vendored = false }) {
    const findings = [];

    // A VENDORED skill (its directory is a symlink into a shared store such as ../.agents/skills/)
    // is still checked for HARD spec violations below — name/description govern whether it triggers
    // correctly in THIS project, so they matter regardless of who authored it. But the body budget
    // is ADVISORY and, for a vendored skill, unactionable: trimming it would mutate a shared
    // upstream source other projects read, and the edit would be clobbered on the next sync.
    // Reporting it forever trains the reader to ignore the warning, which then masks the budget
    // signal for skills we CAN act on. (Seen in practice: the single largest "over-budget skill"
    // in three consecutive sweep reports was a symlink to a vendored third-party skill and was
    // never ours to consolidate.)
    const body = vendored ? null : checkBody(lineCount);
    if (body) {
        findings.push({
            ...body,
            skill: dir,
            message: `${dir}: ${lineCount} lines (budget ${BODY_BUDGET})`,
        });
    }

    const nameFinding = checkName(name, dir);
    if (nameFinding) {
        findings.push({
            ...nameFinding,
            skill: dir,
            message: `${dir}: name "${name}" does not match directory "${dir}"`,
        });
    }

    const descFinding = checkDescription(description);
    if (descFinding) {
        findings.push({
            ...descFinding,
            skill: dir,
            message: `${dir}: description ${(description || '').length} chars (max ${DESC_MAX})`,
        });
    }

    return findings;
}

// ── Disk scan ────────────────────────────────────────────────────────────────

function scanAll(skillsRoot) {
    const findings = [];
    if (!fs.existsSync(skillsRoot)) return findings;

    const dirs = fs
        .readdirSync(skillsRoot, { withFileTypes: true })
        // statSync (not Dirent.isDirectory) so symlinked skill dirs count too — a skill dir may be
        // a symlink (e.g. into a shared ../.agents/skills/), and Dirent.isDirectory() returns false
        // for a symlink, silently dropping it from every conformance run. Guard statSync against a
        // broken symlink.
        .filter((d) => {
            if (d.isDirectory()) return true;
            if (!d.isSymbolicLink()) return false;
            try {
                return fs.statSync(path.join(skillsRoot, d.name)).isDirectory();
            } catch {
                return false;
            }
        })
        .map((d) => d.name)
        .sort();

    // Resolved separately from the filter above: a skill dir reached via symlink is VENDORED.
    // lstatSync, not statSync — statSync follows the link and would report every skill as a
    // plain directory, which is exactly the distinction we need here.
    const isVendored = (dir) => {
        try {
            return fs.lstatSync(path.join(skillsRoot, dir)).isSymbolicLink();
        } catch {
            return false;
        }
    };

    for (const dir of dirs) {
        const skillPath = path.join(skillsRoot, dir, 'SKILL.md');
        if (!fs.existsSync(skillPath)) continue;
        const content = fs.readFileSync(skillPath, 'utf8');
        const frontmatter = extractFrontmatter(content);
        findings.push(
            ...evaluateSkill({
                dir,
                name: parseField(frontmatter, 'name'),
                description: parseField(frontmatter, 'description'),
                lineCount: countLines(content),
                vendored: isVendored(dir),
            }),
        );
    }

    return findings;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
    const skillsRoot = path.join(projectDir, '.claude', 'skills');

    const findings = scanAll(skillsRoot);
    const errors = findings.filter((f) => f.severity === 'ERROR');
    const warns = findings.filter((f) => f.severity === 'WARN');

    if (findings.length === 0) {
        console.log('[SKILL-CONFORMANCE] All skills conform (≤500 lines, name==dir, description ≤1024 chars).');
        process.exit(0);
    }

    for (const f of findings) {
        console.log(`${f.severity} ${f.message}`);
    }
    console.log(`\n[SKILL-CONFORMANCE] ${errors.length} error(s), ${warns.length} warning(s).`);

    process.exit(errors.length > 0 ? 1 : 0);
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = {
    BODY_BUDGET,
    DESC_MAX,
    countLines,
    parseField,
    extractFrontmatter,
    checkBody,
    checkName,
    checkDescription,
    evaluateSkill,
    scanAll,
    main,
};
