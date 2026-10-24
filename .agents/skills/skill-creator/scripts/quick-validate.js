/**
 * quick-validate.js — Validate a single skill against the Agent Skills spec.
 *
 * Usage:
 *   node .claude/skills/skill-creator/scripts/quick-validate.js <skill-dir-or-name>
 *
 * Accepts:
 *   - Full path to a skill directory (e.g. /path/to/.claude/skills/my-skill)
 *   - Bare skill name resolved under .claude/skills/<name>/ relative to projectRoot()
 *
 * Prints each finding as:  SEVERITY  message
 * Prints a final PASS or FAIL line.
 * Exit code: non-zero only when at least one ERROR finding exists (matches
 * skill-conformance.js exit semantics — WARN-only is exit 0).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
    evaluateSkill,
    countLines,
    parseField,
    extractFrontmatter,
} = require('../../../core/skill-conformance.js');
const { parseArgs, projectRoot } = require('./utils.js');

/**
 * Resolve a skill directory from a bare name or an explicit path.
 * Returns the absolute path to the skill directory, or null if not resolvable.
 * @param {string} input
 * @returns {string|null}
 */
function resolveSkillDir(input) {
    // Explicit path — prefer as-is if it contains a SKILL.md.
    const asAbsolute = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
    if (fs.existsSync(path.join(asAbsolute, 'SKILL.md'))) {
        return asAbsolute;
    }

    // Bare name — try under projectRoot/.claude/skills/<name>
    const underSkills = path.join(projectRoot(), '.claude', 'skills', input);
    if (fs.existsSync(path.join(underSkills, 'SKILL.md'))) {
        return underSkills;
    }

    return null;
}

/**
 * Validate one skill directory. Returns { findings, hasErrors }.
 * Can be called programmatically.
 * @param {string} skillDirInput  bare name or full path
 * @returns {{ findings: object[], hasErrors: boolean }}
 */
function validate(skillDirInput) {
    const skillDir = resolveSkillDir(skillDirInput);
    if (!skillDir) {
        const finding = {
            severity: 'ERROR',
            code: 'SKILL_NOT_FOUND',
            skill: skillDirInput,
            message: `${skillDirInput}: SKILL.md not found (tried as path and as name under .claude/skills/)`,
        };
        return { findings: [finding], hasErrors: true };
    }

    const skillPath = path.join(skillDir, 'SKILL.md');
    const content = fs.readFileSync(skillPath, 'utf8');
    const frontmatter = extractFrontmatter(content);
    const dir = path.basename(skillDir);

    const findings = evaluateSkill({
        dir,
        name: parseField(frontmatter, 'name'),
        description: parseField(frontmatter, 'description'),
        lineCount: countLines(content),
    });

    const hasErrors = findings.some((f) => f.severity === 'ERROR');
    return { findings, hasErrors };
}

function main(argv) {
    const args = parseArgs(argv);
    const input = args._[0];
    if (!input) {
        console.error('Usage: node quick-validate.js <skill-dir-or-name>');
        process.exit(2);
    }

    const { findings, hasErrors } = validate(input);

    if (findings.length === 0) {
        console.log('PASS  (no findings)');
        process.exit(0);
    }

    for (const f of findings) {
        console.log(`${f.severity}  ${f.message}`);
    }

    const errors = findings.filter((f) => f.severity === 'ERROR').length;
    const warns = findings.filter((f) => f.severity === 'WARN').length;
    const verdict = hasErrors ? 'FAIL' : 'PASS';
    console.log(`\n${verdict}  (${errors} error(s), ${warns} warning(s))`);

    process.exit(hasErrors ? 1 : 0);
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = { validate, resolveSkillDir, main };
