/**
 * Frontmatter skill-resolution checker.
 *
 * A subagent's `.claude/agents/<name>.md` frontmatter `skills:` list triggers
 * EAGER full-body injection at startup — native Claude Code behavior (docs:
 * sub-agents.md → "Preload skills into subagents": *"The full skill content is
 * injected, not just the description"*). The body enters context through the
 * runtime, firing NO Read tool event, so two failure modes are completely
 * SILENT — nothing in telemetry or a test run reveals them:
 *
 *   1. BROKEN_SKILL_REF — a listed skill whose `.claude/skills/<name>/SKILL.md`
 *      does not exist. Preload logs only a debug warning; the agent runs with
 *      that knowledge MISSING and behaves as if it was loaded.
 *   2. UNPRELOADABLE — a listed skill whose SKILL.md sets
 *      `disable-model-invocation: true`. Preload draws from the same set the
 *      model can invoke, so a disabled skill is SILENTLY skipped from the
 *      subagent's context (docs: sub-agents.md — "You cannot preload skills that
 *      set disable-model-invocation: true").
 *
 * Either way, "configured to load" silently means "loaded nothing." `check-templates`
 * already *instructs* a reviewer to eyeball broken skill refs (Step: BROKEN SKILL
 * REF), but that is instruction-level — it relies on the agent looking. This
 * checker makes both failure modes tool-detectable (the F8 primitive: real check,
 * not a prompt).
 *
 * Findings are ERROR-severity — silent knowledge loss is exactly what this exists
 * to prevent. Exit code: 0 when clean, non-zero when any ERROR exists.
 *
 * Usage:
 *   node .claude/core/skill-resolution.js
 *
 * Called by /review:check-templates (Step 2d). Can also run standalone.
 * Mirrors the CJS + `require.main === module` shape of skill-conformance.js.
 */

const fs = require('fs');
const path = require('path');

// Reuse the sibling checkers' battle-tested, CRLF-tolerant frontmatter parsers
// rather than minting a third copy: operating-standard owns AGENT-side parsing
// (`parseSkills` reads the `skills:` YAML block), skill-conformance owns the
// single-line field reader used for the skill's own frontmatter.
const { extractFrontmatter: extractAgentFm, parseSkills } = require('./operating-standard');
const { extractFrontmatter: extractSkillFm, parseField } = require('./skill-conformance');

// ── Pure helpers (unit-tested against synthetic input, never the live tree) ──

/** True when a skill's frontmatter opts out of model invocation (→ not preloadable). */
function isModelInvocationDisabled(frontmatter) {
    const val = parseField(frontmatter, 'disable-model-invocation');
    return typeof val === 'string' && val.trim().toLowerCase() === 'true';
}

/**
 * Evaluate one agent's declared skill refs against the skill index.
 * Pure — takes a skillIndex map, not file paths, so it is testable without fs.
 *
 * @param {Object}   args
 * @param {string}   args.agent       agent name (for messages)
 * @param {string[]} args.skills      frontmatter `skills:` list
 * @param {Object}   args.skillIndex  { [skillName]: { exists: boolean, disabled: boolean } }
 * @returns {Array<{severity,code,agent,skill,message}>}
 */
function evaluateAgentSkillRefs({ agent, skills, skillIndex }) {
    const findings = [];
    for (const skill of skills || []) {
        const entry = skillIndex[skill];
        if (!entry || !entry.exists) {
            findings.push({
                severity: 'ERROR',
                code: 'BROKEN_SKILL_REF',
                agent,
                skill,
                message: `${agent}: frontmatter skill "${skill}" has no .claude/skills/${skill}/SKILL.md — preload silently loads nothing`,
            });
            continue;
        }
        if (entry.disabled) {
            findings.push({
                severity: 'ERROR',
                code: 'UNPRELOADABLE',
                agent,
                skill,
                message: `${agent}: frontmatter skill "${skill}" sets disable-model-invocation: true — cannot be preloaded, silently skipped`,
            });
        }
    }
    return findings;
}

// ── Disk scan ────────────────────────────────────────────────────────────────

/** Build { [skillName]: { exists, disabled } } from the skills tree. */
function buildSkillIndex(skillsRoot) {
    const index = {};
    if (!fs.existsSync(skillsRoot)) return index;

    // statSync fallback (not Dirent.isDirectory alone) so symlinked skill dirs count too —
    // adopter bespoke skills are frequently symlinks into a shared ../.agents/skills/,
    // and Dirent.isDirectory() returns false for symlinks (same class as skill-conformance.js).
    const dirs = fs
        .readdirSync(skillsRoot, { withFileTypes: true })
        .filter((d) => {
            if (d.isDirectory()) return true;
            if (!d.isSymbolicLink()) return false;
            try { return fs.statSync(path.join(skillsRoot, d.name)).isDirectory(); }
            catch { return false; }
        })
        .map((d) => d.name);

    for (const dir of dirs) {
        const skillPath = path.join(skillsRoot, dir, 'SKILL.md');
        if (!fs.existsSync(skillPath)) {
            index[dir] = { exists: false, disabled: false };
            continue;
        }
        const fm = extractSkillFm(fs.readFileSync(skillPath, 'utf8'));
        index[dir] = { exists: true, disabled: isModelInvocationDisabled(fm) };
    }
    return index;
}

function scanAll(agentsRoot, skillsRoot) {
    const findings = [];
    if (!fs.existsSync(agentsRoot)) return findings;

    const skillIndex = buildSkillIndex(skillsRoot);

    const files = fs
        .readdirSync(agentsRoot)
        .filter((f) => f.endsWith('.md'))
        .sort();

    for (const file of files) {
        const content = fs.readFileSync(path.join(agentsRoot, file), 'utf8');
        const fm = extractAgentFm(content);
        const name = parseField(fm, 'name') || file.replace(/\.md$/, '');
        findings.push(
            ...evaluateAgentSkillRefs({
                agent: name,
                skills: parseSkills(fm),
                skillIndex,
            }),
        );
    }

    return findings;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
    const agentsRoot = path.join(projectDir, '.claude', 'agents');
    const skillsRoot = path.join(projectDir, '.claude', 'skills');

    const findings = scanAll(agentsRoot, skillsRoot);

    if (findings.length === 0) {
        console.log('[SKILL-RESOLUTION] All agent frontmatter skills resolve to a real, preloadable skill (dir + SKILL.md present, not disable-model-invocation).');
        process.exit(0);
    }

    for (const f of findings) {
        console.log(`${f.severity} ${f.message}`);
    }
    console.log(`\n[SKILL-RESOLUTION] ${findings.length} error(s) — these agents preload nothing for the named skill.`);
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
    isModelInvocationDisabled,
    evaluateAgentSkillRefs,
    buildSkillIndex,
    scanAll,
    main,
};
