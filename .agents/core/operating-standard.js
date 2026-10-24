/**
 * Operating-standard conformance checker.
 *
 * Scans every .claude/agents/<name>.md and asserts the project's operating
 * standard ("resolve it or don't report it" — the mission at the top of
 * CLAUDE.md) is *enforced* through the agent tier, not just declared.
 *
 * The standard translates by role (see verification-before-completion/SKILL.md):
 *
 *   - ACTING roles      (write code/docs): MUST load `verification-before-completion`
 *                        in frontmatter AND carry an `## Operating Standard` section.
 *   - REPORT-ONLY roles (read-only / write-scoped-to-reviews — detected by
 *                        `disallowedTools: Edit`): MUST carry an `## Operating
 *                        Standard` section (the report-only translation). They do
 *                        NOT load the skill — that would imply they write fixes.
 *   - EXEMPT            (`shadow`): the documented Shadow exception — its prose
 *                        persona is its convention, so it carries the doctrine in
 *                        its own idiom with no standard heading. No findings.
 *
 * Findings are ERROR-severity (a dropped pointer is a silent doctrine regression,
 * the exact failure mode this check exists to prevent). Exit code: 0 when clean,
 * non-zero when any ERROR exists.
 *
 * Usage:
 *   node .claude/core/operating-standard.js
 *
 * Called by /review:check-templates (Step 2c). Can also run standalone.
 * Mirrors the CJS + `require.main === module` shape of skill-conformance.js.
 */

const fs = require('fs');
const path = require('path');

// The workshop's default anchor skill. An adopter that consolidated/renamed it
// (e.g. an adopter folded it into `dev-process`) declares its own name via
// `.claude/update-config.json` → "operatingStandardSkill". The checker reads
// that so it never demands a skill the adopter deliberately doesn't ship.
const STANDARD_SKILL = 'verification-before-completion';
const SECTION_RE = /^##\s+Operating Standard\s*$/m;

/**
 * Resolve the anchor skill name for a project: its update-config.json
 * `operatingStandardSkill`, else the workshop default. Pure-ish (single fs read,
 * tolerant of a missing/maformed config).
 */
function resolveAnchorSkill(projectDir, fallback = STANDARD_SKILL) {
    try {
        const cfgPath = path.join(projectDir, '.claude', 'update-config.json');
        if (!fs.existsSync(cfgPath)) return fallback;
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const name = cfg && typeof cfg.operatingStandardSkill === 'string' ? cfg.operatingStandardSkill.trim() : '';
        return name || fallback;
    } catch {
        return fallback; // malformed config → never crash the audit, fall back
    }
}

// Agents exempt from the section requirement by documented convention.
// `shadow` omits the standard section headings — its prose persona IS its
// convention (.agents/startup-reference.md: agent-shape exception; /review:check-templates treats it as
// conforming). The doctrine is woven into its prose instead.
const EXEMPT = ['shadow'];

// ── Pure helpers (unit-tested against synthetic input, never the live tree) ──

/** Return the frontmatter block (between the first two `---` fences), or ''. */
function extractFrontmatter(content) {
    // Split on CRLF or LF so a Windows checkout (lone \r per line) still matches
    // the `--- ` fence exactly — same guard as skill-conformance.js.
    const lines = content.split(/\r?\n/);
    if (lines[0] !== '---') return '';
    for (let i = 1; i < lines.length; i++) {
        if (lines[i] === '---') return lines.slice(1, i).join('\n');
    }
    return ''; // unterminated frontmatter
}

/** Parse a single scalar frontmatter field (e.g. `name: foo`). */
function parseScalar(frontmatter, field) {
    const m = frontmatter.match(new RegExp(`^${field}:\\s*(.*)$`, 'm'));
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

/** Parse a comma-separated frontmatter list field (e.g. `disallowedTools: Edit`). */
function parseCsvField(frontmatter, field) {
    const val = parseScalar(frontmatter, field);
    if (!val) return [];
    return val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/** Parse the `skills:` YAML block list from frontmatter. */
function parseSkills(frontmatter) {
    const lines = frontmatter.split('\n');
    const skills = [];
    let inList = false;
    for (const line of lines) {
        if (/^skills:\s*$/.test(line)) {
            inList = true;
            continue;
        }
        if (inList) {
            const m = line.match(/^\s*-\s*(\S+)\s*$/);
            if (m) skills.push(m[1]);
            else break; // first non-list line ends the block
        }
    }
    return skills;
}

/** Classify an agent's role from its name + disallowed tools. */
function classifyRole({ name, disallowedTools }) {
    if (EXEMPT.includes(name)) return 'exempt';
    if ((disallowedTools || []).includes('Edit')) return 'report-only';
    return 'acting';
}

/**
 * Evaluate one agent's parsed facts into a list of findings.
 * Pure — takes values, not file paths, so it is testable without fs.
 */
function evaluateAgent({ name, disallowedTools, skills, hasSection, anchorSkill = STANDARD_SKILL }) {
    const findings = [];
    const role = classifyRole({ name, disallowedTools });

    if (role === 'exempt') return findings;

    if (!hasSection) {
        findings.push({
            severity: 'ERROR',
            code: 'MISSING_SECTION',
            agent: name,
            message: `${name} (${role}): missing "## Operating Standard" section`,
        });
    }

    if (role === 'acting' && !(skills || []).includes(anchorSkill)) {
        findings.push({
            severity: 'ERROR',
            code: 'MISSING_SKILL',
            agent: name,
            message: `${name} (acting): frontmatter skills must load "${anchorSkill}"`,
        });
    }

    return findings;
}

// ── Disk scan ────────────────────────────────────────────────────────────────

function scanAll(agentsRoot, anchorSkill = STANDARD_SKILL) {
    const findings = [];
    if (!fs.existsSync(agentsRoot)) return findings;

    const files = fs
        .readdirSync(agentsRoot)
        .filter((f) => f.endsWith('.md'))
        .sort();

    for (const file of files) {
        const content = fs.readFileSync(path.join(agentsRoot, file), 'utf8');
        const fm = extractFrontmatter(content);
        const name = parseScalar(fm, 'name') || file.replace(/\.md$/, '');
        findings.push(
            ...evaluateAgent({
                name,
                disallowedTools: parseCsvField(fm, 'disallowedTools'),
                skills: parseSkills(fm),
                hasSection: SECTION_RE.test(content),
                anchorSkill,
            }),
        );
    }

    return findings;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
    const agentsRoot = path.join(projectDir, '.claude', 'agents');
    const anchorSkill = resolveAnchorSkill(projectDir);

    const findings = scanAll(agentsRoot, anchorSkill);

    if (findings.length === 0) {
        console.log(`[OPERATING-STANDARD] All agents enforce the operating standard (anchor skill: "${anchorSkill}"; acting load it + carry the section; report-only carry the section; shadow exempt).`);
        process.exit(0);
    }

    console.log(`[OPERATING-STANDARD] anchor skill: "${anchorSkill}"`);

    for (const f of findings) {
        console.log(`${f.severity} ${f.message}`);
    }
    console.log(`\n[OPERATING-STANDARD] ${findings.length} error(s).`);
    process.exit(1);
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
    STANDARD_SKILL,
    EXEMPT,
    resolveAnchorSkill,
    extractFrontmatter,
    parseScalar,
    parseCsvField,
    parseSkills,
    classifyRole,
    evaluateAgent,
    scanAll,
    main,
};
