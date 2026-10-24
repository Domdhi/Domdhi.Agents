/**
 * Agent Merger — section-aware merge logic for agent .md files.
 *
 * An agent file has four zones:
 *   frontmatter  — YAML between opening and closing ---
 *   soulZone     — from first `# ` heading to `## Skills` heading (exclusive)
 *   skillsZone   — from `## Skills` heading to `## Project Context` or end
 *   projectCtx   — from `## Project Context` to end, or '' if absent
 *
 * Merge strategy (when dest exists):
 *   - frontmatter: take src, but preserve nickname: and aliases: from dest; also
 *                  preserve a tuned description: when the agent is personalized or
 *                  specialized (those are written by /review:* commands, not the template)
 *   - soulZone:    preserve if dest is personalized (has nickname:); else take src
 *   - retired:     a dest soul zone or description whose normalized hash is listed
 *                  for that role in .agents/adapters/retired-role-content.json is a
 *                  pristine prior-release canonical version, not a customization —
 *                  take src for it (every canonical role ships nickname:)
 *   - skillsZone:  always from src (template-owned)
 *   - projectCtx:  preserve if dest has it; otherwise omit
 *
 * Never calls process.cwd(). All paths are explicit srcPath / dstPath arguments.
 *
 * @module agent-merger
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeWrite } = require('./fs-safe');

// ── Retired canonical content ─────────────────────────────────────────────────

const RETIRED_ROLE_CONTENT_PATH = path.join(__dirname, '..', '..', 'adapters', 'retired-role-content.json');

/**
 * SHA-256 of a soul zone or description block after normalization: CRLF→LF,
 * generated-notice lines removed, outer whitespace trimmed. Used both to build
 * the retired list and to recognize a pristine prior-release dest.
 *
 * @param {string} text
 * @returns {string} 64-char hex digest
 */
function retiredContentDigest(text) {
    const normalized = String(text).replace(/\r\n/g, '\n').replace(/^<!-- Generated[^\n]*-->[ \t]*(?:\n|$)/gm, '').trim();
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Load the per-role retired lists: { [roleName]: { soulZone: string[], description: string[] } }.
 * A missing file means no retired content (the merge then behaves as before).
 *
 * @param {string} [file]
 * @returns {Object}
 */
function loadRetiredRoleContent(file = RETIRED_ROLE_CONTENT_PATH) {
    if (!fs.existsSync(file)) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data.roles === 'object' && data.roles ? data.roles : {};
}

/** The description field block (multi-line safe) as text, or '' when absent. */
function descriptionBlock(frontmatter) {
    const lines = frontmatter.split('\n');
    const block = extractFieldBlock(lines, 'description');
    return block ? lines.slice(block.start, block.end).join('\n') : '';
}

// ── Fence Scanner ─────────────────────────────────────────────────────────────

/**
 * Split `text` into lines and a parallel array marking which lines fall INSIDE a
 * fenced code block (``` or ~~~, either length-3+ fence, matched loosely — good
 * enough for this repo's Markdown, not a full CommonMark parser).
 *
 * Ported verbatim from skill-merger.js's scanFenceState — that module already
 * solved the identical "sentinel-inside-a-doc-example-fence" hazard for
 * <!-- @@project-additions --> markers; agent-merger's `## Skills` /
 * `## Project Context` heading matching needs the same fence-awareness (F0).
 * skill-merger.js does not export scanFenceState, so it is ported here rather
 * than imported.
 *
 * @param {string} text
 * @returns {{ lines: string[], inFence: boolean[] }}
 */
function scanFenceState(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const inFence = new Array(lines.length).fill(false);
    let fenceToken = null; // '```' | '~~~' | null
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        const opensOrCloses = /^(`{3,}|~{3,})/.exec(trimmed);
        if (fenceToken) {
            inFence[i] = true;
            if (opensOrCloses && trimmed.startsWith(fenceToken)) fenceToken = null;
            continue;
        }
        if (opensOrCloses) {
            fenceToken = opensOrCloses[1][0].repeat(3); // normalize to the 3-char token
            inFence[i] = true; // the opening fence line itself counts as "in the fence"
        }
    }
    return { lines, inFence };
}

// ── Section Parser ─────────────────────────────────────────────────────────────

/**
 * Parse an agent .md file into its four zones.
 *
 * @param {string} content  — full file content (LF or CRLF)
 * @returns {{ frontmatter: string, soulZone: string, skillsZone: string, projectCtx: string }}
 */
function parseAgentSections(content) {
    // Normalize CRLF to LF so line comparisons work on Windows-edited files
    const { lines, inFence } = scanFenceState(content);

    let frontmatterEnd = -1;  // index of closing ---
    let skillsStart = -1;     // index of ## Skills line
    let projectCtxStart = -1; // index of ## Project Context line

    // Find frontmatter block (must start at line 0)
    if (lines[0] === '---') {
        for (let i = 1; i < lines.length; i++) {
            if (lines[i] === '---') {
                frontmatterEnd = i;
                break;
            }
        }
    }

    // Search for section headings after frontmatter. A heading match INSIDE a
    // fenced code block (a doc example showing "## Skills" as literal text) is
    // not a real section boundary — skip it (F0). `## Project Context` is
    // detected INDEPENDENTLY of `## Skills` — an agent shaped without a Skills
    // section (shadow.md intentionally omits it) can still carry an adopter-added
    // Project Context, and gating its detection on skillsStart being set first
    // used to fold that section into soulZone, where it gets clobbered by src on
    // merge (F4).
    const searchStart = frontmatterEnd >= 0 ? frontmatterEnd + 1 : 0;
    for (let i = searchStart; i < lines.length; i++) {
        if (inFence[i]) continue;
        if (skillsStart === -1 && lines[i].match(/^## Skills\s*$/)) {
            skillsStart = i;
        }
        if (projectCtxStart === -1 && lines[i].match(/^## Project Context\s*$/)) {
            projectCtxStart = i;
        }
        if (skillsStart !== -1 && projectCtxStart !== -1) break;
    }

    // Extract frontmatter (lines between the two --- markers, no delimiters)
    const frontmatter = frontmatterEnd >= 0
        ? lines.slice(1, frontmatterEnd).join('\n')
        : '';

    // Soul zone: from line after closing --- to line before ## Skills, or (when
    // ## Skills is absent — the shadow-shaped case) before ## Project Context, or end.
    const soulStart = frontmatterEnd >= 0 ? frontmatterEnd + 1 : 0;
    const soulEnd = skillsStart >= 0 ? skillsStart : (projectCtxStart >= 0 ? projectCtxStart : lines.length);
    let soulLines = lines.slice(soulStart, soulEnd);
    // Remove leading blank lines
    while (soulLines.length > 0 && soulLines[0].trim() === '') {
        soulLines.shift();
    }
    // Remove trailing blank lines too. Reassembly always writes exactly one blank
    // line before the next section (and one final newline at EOF), so keeping them
    // here made a skill-less legacy role whose soul ended in two blank lines parse
    // one newline shorter after an update; the soul zone is now the same
    // value before and after a merge.
    while (soulLines.length > 0 && soulLines[soulLines.length - 1].trim() === '') {
        soulLines.pop();
    }
    // Reassembly spacing: two leading newlines so the merged file has a blank line
    // between the closing `---` and the soul zone's first line (standard markdown
    // convention; was a one-newline bug that ran headings flush against frontmatter).
    const soulZone = soulLines.length > 0 ? '\n\n' + soulLines.join('\n') : '';

    // Skills zone: from ## Skills to ## Project Context or end
    const skillsEnd = projectCtxStart >= 0 ? projectCtxStart : lines.length;
    const skillsZone = skillsStart >= 0
        ? lines.slice(skillsStart, skillsEnd).join('\n')
        : '';

    // Project Context: from ## Project Context to end
    const projectCtx = projectCtxStart >= 0
        ? lines.slice(projectCtxStart).join('\n')
        : '';

    return { frontmatter, soulZone, skillsZone, projectCtx };
}

// ── Frontmatter Merge ─────────────────────────────────────────────────────────

/**
 * Detect whether an agent file has been personalized.
 * Personalization is indicated by a `nickname:` field in frontmatter.
 *
 * @param {string} frontmatter
 * @returns {boolean}
 */
function isPersonalized(frontmatter) {
    return /^nickname\s*:/m.test(frontmatter);
}

/**
 * Extract the line range [start, end) of a frontmatter field, including any
 * indented continuation lines — so YAML folded/block scalars (`description: >`
 * spanning several indented lines) are captured as a single unit.
 *
 * @param {string[]} lines
 * @param {string} key
 * @returns {{ start: number, end: number }|null}
 */
function extractFieldBlock(lines, key) {
    const re = new RegExp('^' + key + '\\s*:');
    const start = lines.findIndex(l => re.test(l));
    if (start === -1) return null;
    let end = start + 1;
    // Consume indented continuation lines (the folded/block scalar body).
    while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
    return { start, end };
}

/**
 * Extract the YAML list for a `skills:` field, supporting both forms template
 * agent files may use:
 *   block-sequence:  skills:\n  - foo\n  - bar
 *   flow-style:      skills: [foo, bar]   (all on the `skills:` line itself)
 *
 * Flow-style is parsed directly (split-on-comma + trim + strip quotes) rather than
 * via a full YAML parser — this is template-authored frontmatter in a controlled
 * context, not untrusted arbitrary YAML, so that would be overkill. Chosen over
 * documenting block-sequence as the only supported form because every write-back
 * path in this file (stripExcludedSkills, mergeFrontmatter's bespoke-union) already
 * always re-serializes as block-sequence regardless of the source style, so there's
 * no round-trip-format concern to preserve.
 *
 * @param {string[]} lines
 * @returns {{ start: number, end: number, items: string[], flow: boolean }|null}
 */
function extractSkillsList(lines) {
    const start = lines.findIndex(l => /^skills\s*:/.test(l));
    if (start === -1) return null;
    // Trailing inline comment must not defeat the match — without it, a line like
    // `skills: [foo, bar]  # why` falls through to the block-sequence parser below,
    // which finds no `- item` lines and returns `{items: [], flow: false}` (not
    // null, since `start` was found) — stripExcludedSkills then deletes the WHOLE
    // skills line on any exclusion call, silently dropping a real list (Wave 6
    // review finding).
    const flowMatch = lines[start].match(/^skills\s*:\s*\[(.*)\]\s*(#.*)?$/);
    if (flowMatch) {
        const items = flowMatch[1]
            .split(',')
            .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
            .filter(s => s.length > 0);
        return { start, end: start + 1, items, flow: true };
    }
    // The line opens a flow-style list (`skills: [`) but has no matching `]`
    // on the same line — e.g. wrapped across lines as `skills: [foo,` /
    // `  bar]`. Multi-line flow-style is unsupported (out of scope — no live
    // agent file uses it); falling through to the block-sequence scanner below
    // would find no `- item` lines and return a false-empty `{items: [],
    // flow: false}`, which stripExcludedSkills would then trust and delete the
    // whole line outright, corrupting the file. Fail safe instead: return null
    // so callers leave the line untouched.
    if (/^skills\s*:\s*\[/.test(lines[start])) return null;
    let end = start + 1;
    const items = [];
    while (end < lines.length && /^\s*-\s+/.test(lines[end])) {
        items.push(lines[end].replace(/^\s*-\s+/, '').trim());
        end++;
    }
    return { start, end, items, flow: false };
}

/**
 * Remove every reference to an excluded skill from an agent file — both the
 * frontmatter `skills:` list items AND the `## Skills` body bullet lines that
 * point at `.claude/skills/<excluded>/...`.
 *
 * An adopter's `update-config.json` `skillExclude` removes the skill DIR from the
 * target, but the template-owned agent skills list/body still NAMES it. Without
 * this strip, a synced agent references a skill that has no SKILL.md — a silent
 * broken preload (the agent loads NOTHING for that skill; skill-resolution.js
 * flags it BROKEN_SKILL_REF). This is the cure for the skillExclude-adopter
 * regression where template-updater clobbers a curated agent's skills with the
 * template's, re-introducing refs the project deliberately dropped.
 *
 * Operates on full file content; LF/CRLF tolerant (re-emits the original EOL).
 *
 * @param {string} content        — full agent .md content
 * @param {Set<string>} excludedSet — skill names the target excludes
 * @returns {string}              — content with excluded-skill refs removed
 */
function stripExcludedSkills(content, excludedSet) {
    if (!excludedSet || excludedSet.size === 0) return content;
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.replace(/\r\n/g, '\n').split('\n');

    // 1. Frontmatter `skills:` list — drop excluded items; remove the whole block
    //    if nothing remains (an empty `skills:` is pointless and slightly invalid).
    const sk = extractSkillsList(lines);
    if (sk) {
        const kept = sk.items.filter(s => !excludedSet.has(s));
        if (kept.length === 0) {
            lines.splice(sk.start, sk.end - sk.start);
        } else if (kept.length !== sk.items.length) {
            if (sk.flow) {
                // The whole list lives on one line — rewrite that line in place.
                lines.splice(sk.start, sk.end - sk.start, `skills: [${kept.join(', ')}]`);
            } else {
                const indent = (lines[sk.start + 1].match(/^(\s*)-/) || [, '  '])[1];
                lines.splice(sk.start + 1, sk.end - (sk.start + 1), ...kept.map(s => `${indent}- ${s}`));
            }
        }
    }

    // 2. Body bullet lines that point at an excluded skill's path (e.g. the
    //    `## Skills` "Read these files" list). A line naming an excluded skill dir
    //    is a dead pointer once the dir is gone.
    // A line that also points at a skill the project keeps stays: only a line whose every skill path
    // names an excluded skill is a dead pointer.
    const filtered = lines.filter(line => {
        const names = [...line.matchAll(/\.(?:claude|agents)\/skills\/([^/`)\s]+)/g)].map(m => m[1]);
        return !(names.length > 0 && names.every(name => excludedSet.has(name)));
    });

    return filtered.join(eol);
}

/**
 * Merge frontmatter strings: take src lines as the base, but preserve
 * `nickname:` and `aliases:` from dst if they exist. When opts.preserveDescription
 * is set, also preserve dst's `description:` block (multi-line safe) — used when the
 * agent is personalized/specialized so /review:* tuned descriptions survive updates.
 *
 * When opts.canonicalSkills + opts.targetSkills are provided, project-specific skills
 * in dst's `skills:` list are unioned into the result: a dst skill that is NOT shipped
 * by the template (not in canonicalSkills) but DOES exist as a skill dir in the target
 * (in targetSkills) is a specialization added by /review:specialize and must survive —
 * otherwise the template's base skills list silently strips it.
 *
 * @param {string} srcFm  — frontmatter string from src (no --- delimiters)
 * @param {string} dstFm  — frontmatter string from dst (no --- delimiters)
 * @param {object} [opts]
 * @param {boolean} [opts.preserveDescription]  — keep dst's description block
 * @param {Set<string>} [opts.canonicalSkills]  — skills shipped by the template
 * @param {Set<string>} [opts.targetSkills]     — skill dirs present in the target
 * @returns {string}       — merged frontmatter string (no --- delimiters)
 */
function mergeFrontmatter(srcFm, dstFm, opts) {
    opts = opts || {};
    const srcLines = srcFm.split('\n');
    const destLines = dstFm.split('\n');

    // Extract preserved lines from dest
    const nicknameMatch = destLines.find(l => /^nickname\s*:/.test(l));
    const aliasesMatch = destLines.find(l => /^aliases\s*:/.test(l));

    // Build result from src, replacing nickname/aliases lines if dest has them
    const result = srcLines.map(line => {
        if (nicknameMatch && /^nickname\s*:/.test(line)) return nicknameMatch;
        if (aliasesMatch && /^aliases\s*:/.test(line)) return aliasesMatch;
        return line;
    });

    // If src had no nickname line but dest does, insert after `name:` line
    const srcHasNickname = srcLines.some(l => /^nickname\s*:/.test(l));
    if (!srcHasNickname && nicknameMatch) {
        const nameIdx = result.findIndex(l => /^name\s*:/.test(l));
        if (nameIdx >= 0) {
            result.splice(nameIdx + 1, 0, nicknameMatch);
        }
    }

    // If src had no aliases line but dest does, insert after nickname or name
    const srcHasAliases = srcLines.some(l => /^aliases\s*:/.test(l));
    if (!srcHasAliases && aliasesMatch) {
        const afterIdx = result.findIndex(l => /^nickname\s*:/.test(l));
        const insertAfter = afterIdx >= 0 ? afterIdx : result.findIndex(l => /^name\s*:/.test(l));
        if (insertAfter >= 0) {
            result.splice(insertAfter + 1, 0, aliasesMatch);
        }
    }

    // Preserve a tuned description block from dest (multi-line / folded-scalar safe).
    // Descriptions are project specialization (written by /review:specialize and
    // /review:optimize-agents), so without this a template update reverts them to
    // the generic one-liner. Gated by opts.preserveDescription so unmodified agents
    // still pick up template description improvements.
    if (opts.preserveDescription) {
        const destDesc = extractFieldBlock(destLines, 'description');
        if (destDesc) {
            const destBlock = destLines.slice(destDesc.start, destDesc.end);
            const resDesc = extractFieldBlock(result, 'description');
            if (resDesc) {
                result.splice(resDesc.start, resDesc.end - resDesc.start, ...destBlock);
            } else {
                // src had no description — insert after aliases / nickname / name
                let insertAt = result.findIndex(l => /^aliases\s*:/.test(l));
                if (insertAt < 0) insertAt = result.findIndex(l => /^nickname\s*:/.test(l));
                if (insertAt < 0) insertAt = result.findIndex(l => /^name\s*:/.test(l));
                if (insertAt >= 0) result.splice(insertAt + 1, 0, ...destBlock);
            }
        }
    }

    // Union project-specific (bespoke) skills from dst into the result skills list.
    // Bespoke = in dst, not shipped by the template, and still a real skill dir in the
    // target. This is the fix for the merge stripping /review:specialize skills.
    if (opts.canonicalSkills && opts.targetSkills) {
        const destSkills = extractSkillsList(destLines);
        if (destSkills) {
            const resSkills = extractSkillsList(result);
            const existing = resSkills ? resSkills.items : [];
            const bespoke = destSkills.items.filter(s =>
                !opts.canonicalSkills.has(s) &&
                opts.targetSkills.has(s) &&
                !existing.includes(s));
            if (bespoke.length > 0 && resSkills && resSkills.flow) {
                // Flow-style: rewrite the single line with the union — appending
                // block-sequence lines after it would produce invalid YAML (a flow
                // scalar followed by block-sequence items on the same key).
                result.splice(resSkills.start, resSkills.end - resSkills.start,
                    `skills: [${[...resSkills.items, ...bespoke].join(', ')}]`);
            } else if (bespoke.length > 0 && resSkills) {
                // Append into the existing list, matching its item indentation.
                const sample = result[resSkills.start + 1] || '  - ';
                const indent = (sample.match(/^(\s*)-/) || [, '  '])[1];
                result.splice(resSkills.end, 0, ...bespoke.map(s => `${indent}- ${s}`));
            } else if (bespoke.length > 0) {
                // src has no `skills:` block at all — synthesize one so the project's
                // bespoke skills are not lost (the no-template-skills shape of the bug).
                const block = ['skills:', ...bespoke.map(s => `  - ${s}`)];
                const at = result.findIndex(l => /^name\s*:/.test(l));
                if (at >= 0) result.splice(at + 1, 0, ...block);
                else result.push(...block);
            }
        }
    }

    return result.join('\n');
}

// ── File Merge ────────────────────────────────────────────────────────────────

/**
 * Merge an agent .md file from srcPath into dstPath.
 *
 * If dstPath doesn't exist: simple copy (fresh install).
 * If dstPath exists:
 *   - Overwrite frontmatter (preserving nickname/aliases if personalized)
 *   - Overwrite Skills Zone with source
 *   - Preserve Soul Zone if personalized; otherwise take source
 *   - Preserve Project Context if it exists in dest; otherwise omit
 *
 * @param {string} srcPath
 * @param {string} dstPath
 * @param {object} [opts]
 * @param {string} [opts.containRoot] — destination project root; enables safeWrite's
 *                 symlinked-ancestor guard (fleet:sync trust boundary)
 * @returns {{ changed: boolean, diff?: string }}
 */
function mergeAgentFile(srcPath, dstPath, opts) {
    opts = opts || {};

    if (!fs.existsSync(dstPath)) {
        // Fresh install: even a brand-new agent must not carry refs to skills the
        // target excludes — strip them before writing (same silent-broken-preload
        // risk as the merge path).
        const srcContent = stripExcludedSkills(fs.readFileSync(srcPath, 'utf8'), opts.excludedSkills);
        if (!opts.dryRun) {
            fs.mkdirSync(path.dirname(dstPath), { recursive: true });
            safeWrite(dstPath, srcContent, 'utf8', opts.containRoot);
        }
        return { changed: true, content: srcContent, detail: 'copied (fresh install)' };
    }

    const srcContent = fs.readFileSync(srcPath, 'utf8');
    const destContent = fs.readFileSync(dstPath, 'utf8');
    const result = mergeAgentContent(srcContent, destContent, opts);
    if (result.changed && !opts.dryRun) {
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        safeWrite(dstPath, result.content, 'utf8', opts.containRoot);
    }
    return result;
}

/** Same section/fence-aware merge, available for a write-free update preview. */
function mergeAgentContent(srcContent, destContent, opts = {}) {

    const src = parseAgentSections(srcContent);
    const dest = parseAgentSections(destContent);

    const personalized = isPersonalized(dest.frontmatter);
    const hasProjectCtx = dest.projectCtx.length > 0;
    // A soul zone or description that byte-matches (after normalization) a
    // retired canonical version of THIS role is untuned: replace it from src.
    const roleName = (src.frontmatter.match(/^name\s*:\s*(.+)$/m) || [])[1];
    const retiredLists = (opts.retiredRoleContent || loadRetiredRoleContent())[roleName ? roleName.trim().replace(/^["']|["']$/g, '') : ''] || {};
    const destDescription = descriptionBlock(dest.frontmatter);
    const retiredSoul = personalized && dest.soulZone.trim() !== '' && (retiredLists.soulZone || []).includes(retiredContentDigest(dest.soulZone));
    const retiredDescription = destDescription !== '' && (retiredLists.description || []).includes(retiredContentDigest(destDescription));
    // A description is project specialization once the agent has been personalized
    // or specialized (/review:personalize, /review:specialize, /review:optimize-agents
    // all author project-specific descriptions). Preserve it in those cases so the
    // generic template description doesn't clobber routing-tuned text on update.
    const preserveDescription = (personalized || hasProjectCtx) && !retiredDescription;

    // Merge frontmatter (preserves nickname/aliases always; description when tuned;
    // unions project-specific skills when the caller supplies the skill sets).
    const mergedFrontmatter = (preserveDescription || opts.canonicalSkills)
        ? mergeFrontmatter(src.frontmatter, dest.frontmatter, {
            preserveDescription,
            canonicalSkills: opts.canonicalSkills,
            targetSkills: opts.targetSkills,
        })
        : src.frontmatter;

    // Choose soul zone
    const mergedSoulZone = personalized && !retiredSoul ? dest.soulZone : src.soulZone;

    // Skills zone always from source
    const mergedSkillsZone = src.skillsZone;

    // Project context from dest if it exists
    const mergedProjectCtx = hasProjectCtx ? dest.projectCtx : '';

    // Reassemble
    let result = '---\n' + mergedFrontmatter + '\n---';
    result += mergedSoulZone;
    if (mergedSkillsZone) {
        // Ensure blank line before ## Skills if soul zone doesn't end with one
        if (!result.endsWith('\n\n') && !result.endsWith('\n')) result += '\n';
        if (!result.endsWith('\n\n')) result += '\n';
        result += mergedSkillsZone;
    }
    if (mergedProjectCtx) {
        if (!result.endsWith('\n\n') && !result.endsWith('\n')) result += '\n';
        if (!result.endsWith('\n\n')) result += '\n';
        result += mergedProjectCtx;
    }
    // Ensure trailing newline
    if (!result.endsWith('\n')) result += '\n';

    // Final pass: drop any reference to a target-excluded skill that the
    // template-owned frontmatter/skills-zone re-introduced. Runs last so it
    // catches both the src skills list and bespoke unions.
    result = stripExcludedSkills(result, opts.excludedSkills);

    // Preserve the dest file's line endings. parseAgentSections normalizes CRLF→LF
    // and reassembly emits LF, so a CRLF-checkout adopter (Windows / core.autocrlf
    // off) would otherwise be rewritten to LF on EVERY sync — a large content-free
    // diff and a spurious "changed" even when nothing semantic moved. Re-emit with
    // the dest's EOL before the comparison, mirroring stripExcludedSkills.
    if (destContent.includes('\r\n')) result = result.replace(/\r?\n/g, '\r\n');

    const changed = result !== destContent;
    const details = [];
    if (retiredSoul) details.push('replaced retired Soul Zone');
    else if (personalized) details.push('preserved Soul Zone');
    if (retiredDescription) details.push('replaced retired description');
    if (hasProjectCtx) details.push('preserved Project Context');
    if (preserveDescription && /^description\s*:/m.test(dest.frontmatter)) details.push('preserved description');
    const detail = details.length > 0
        ? `merged (${details.join(', ')})`
        : changed ? 'merged (no personalization)' : 'unchanged';

    return { changed, content: result, detail };
}

module.exports = {
    parseAgentSections,
    isPersonalized,
    extractFieldBlock,
    extractSkillsList,
    stripExcludedSkills,
    mergeFrontmatter,
    mergeAgentFile,
    mergeAgentContent,
    retiredContentDigest,
    loadRetiredRoleContent,
};
