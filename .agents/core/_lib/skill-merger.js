/**
 * Skill Merger — section-aware merge for template-owned skill files.
 *
 * Skill files (skills/<name>/SKILL.md and its references) are Template zone — they
 * overwrite on `template-updater update`. But a project sometimes needs to append
 * its own stack-specific guidance to a template skill: the generic skill body must
 * stay fresh (so template improvements still land) while the project's additions
 * survive every sync. This is the skill analog of the agent Soul Zone / Project
 * Context merge (agent-merger.js) — without it, every fleet sync silently clobbers
 * project additions to a template skill, the way the hardcoded
 * `skills/brand-guidelines/**` project-zone exception was a one-off patch for
 * exactly this problem.
 *
 * Two conventions, both opt-in sentinel lines a project writes into its own copy:
 *
 * 1. Whole-tail marker — `<!-- @@project-additions -->`. Everything from that line
 *    to EOF is adopter-owned and preserved under `--merge`; everything above is
 *    template-owned and refreshed from source. Use when the addition is a new
 *    section appended at the end of the file.
 *
 * 2. Anchored inline fence — a `<!-- @@project-additions:start -->` /
 *    `<!-- @@project-additions:end -->` pair, anchored to the nearest preceding
 *    Markdown heading. Use when the addition is a bullet or paragraph inserted
 *    INSIDE an existing template-owned section (an escalation rule, a test
 *    pattern) — a whole-tail marker can't protect that shape, because it can only
 *    ever draw one line in the sand. On merge, each fenced block is re-inserted at
 *    the end of its anchor heading's section in the refreshed template. If the
 *    anchor heading no longer exists (renamed/removed upstream), the block is
 *    recovered under a synthesized heading at EOF instead of being silently
 *    dropped, and the merge result reports it as an orphan so a human re-homes it.
 *
 * Both sentinel forms are matched only OUTSIDE fenced (``` / ~~~) code blocks — a
 * doc that shows the literal marker text as a usage EXAMPLE inside a code fence
 * (skill-authoring/SKILL.md does exactly this) must not itself be mistaken for a
 * file carrying real project additions. A naive substring search doesn't know the
 * difference; every scan here is line-based and fence-aware.
 *
 * Commands that add project-specific content to a template skill (/review:specialize,
 * /sweep, /review:evolve-skills) MUST use one of these two forms — never edit
 * template-owned prose in place.
 *
 * Mirrors agent-merger.js: only runs under --merge; never calls process.cwd();
 * all paths are explicit srcPath / dstPath arguments.
 *
 * @module skill-merger
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { safeWrite } = require('./fs-safe');

/** The sentinel that opens the adopter-owned tail of a template skill file. */
const PROJECT_ADDITIONS_MARKER = '<!-- @@project-additions -->';
/** Sentinel pair for an anchored inline block (preserved and re-anchored on merge). */
const FENCE_START = '<!-- @@project-additions:start -->';
const FENCE_END = '<!-- @@project-additions:end -->';
/** Heading synthesized at EOF to hold blocks whose anchor heading no longer exists. */
const ORPHAN_HEADING = '## Project-Specific Additions (recovered — verify placement)';

/**
 * Split `text` into lines and a parallel array marking which lines fall INSIDE a
 * fenced code block (``` or ~~~, either length-3+ fence, matched loosely — good
 * enough for this repo's Markdown, not a full CommonMark parser).
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

/**
 * Mark every line from an inline fence start through its end (inclusive), matched
 * outside documentation code fences — the same pairing extractFencedBlocks uses.
 *
 * @param {string[]} lines
 * @param {boolean[]} inFence
 * @returns {boolean[]}
 */
function blockLineMask(lines, inFence) {
    const inBlock = new Array(lines.length).fill(false);
    for (let i = 0; i < lines.length; i++) {
        if (inFence[i] || lines[i].trim() !== FENCE_START) continue;
        let end = lines.length - 1; // unterminated — take the rest, as extractFencedBlocks does
        for (let j = i + 1; j < lines.length; j++) {
            if (!inFence[j] && lines[j].trim() === FENCE_END) { end = j; break; }
        }
        for (let k = i; k <= end; k++) inBlock[k] = true;
        i = end;
    }
    return inBlock;
}

/**
 * True if the text carries a project-additions tail marker OR an inline fence pair,
 * matched outside any documentation code fence.
 * @param {string} text
 * @returns {boolean}
 */
function hasProjectAdditions(text) {
    const { lines, inFence } = scanFenceState(text);
    for (let i = 0; i < lines.length; i++) {
        if (inFence[i]) continue;
        const t = lines[i].trim();
        if (t === PROJECT_ADDITIONS_MARKER || t === FENCE_START) return true;
    }
    return false;
}

/**
 * Split text at the whole-tail project-additions marker, ignoring any occurrence
 * inside a documentation code fence.
 *
 * @param {string} text
 * @returns {{ head: string, tail: string|null }} — when no live marker is present,
 *   tail is null and head is the whole text. When present, head is everything
 *   BEFORE the marker's line and tail starts AT the marker line (marker preserved).
 */
function splitAtMarker(text) {
    const { lines, inFence } = scanFenceState(text);
    let markerLine = -1;
    for (let i = 0; i < lines.length; i++) {
        if (inFence[i]) continue;
        if (lines[i].trim() === PROJECT_ADDITIONS_MARKER) { markerLine = i; break; }
    }
    if (markerLine === -1) return { head: lines.join('\n'), tail: null };
    return { head: lines.slice(0, markerLine).join('\n'), tail: lines.slice(markerLine).join('\n') };
}

/**
 * Extract every anchored inline fenced block from `text`, matched outside
 * documentation code fences. Each block is anchored to the nearest preceding
 * Markdown heading line (matched verbatim, `#` markers included, on merge).
 *
 * @param {string} text
 * @returns {Array<{ anchorHeading: string|null, anchorLevel: number, raw: string }>}
 */
function extractFencedBlocks(text) {
    const { lines, inFence } = scanFenceState(text);
    const blocks = [];
    let lastHeading = null; // { text, level }
    let i = 0;
    while (i < lines.length) {
        if (inFence[i]) { i++; continue; }
        const headingMatch = /^(#{1,6})\s+\S/.exec(lines[i]);
        if (headingMatch) {
            lastHeading = { text: lines[i], level: headingMatch[1].length };
            i++;
            continue;
        }
        if (lines[i].trim() === FENCE_START) {
            const startIdx = i;
            let endIdx = -1;
            for (let j = i + 1; j < lines.length; j++) {
                if (!inFence[j] && lines[j].trim() === FENCE_END) { endIdx = j; break; }
            }
            if (endIdx === -1) endIdx = lines.length - 1; // unterminated — take the rest, defensively
            blocks.push({
                anchorHeading: lastHeading ? lastHeading.text : null,
                anchorLevel: lastHeading ? lastHeading.level : 0,
                raw: lines.slice(startIdx, endIdx + 1).join('\n'),
            });
            i = endIdx + 1;
            continue;
        }
        i++;
    }
    return blocks;
}

/**
 * Re-insert extracted fenced blocks into `text` at the end of each block's anchor
 * heading's section (immediately before the next heading of level <= the anchor's
 * level, or EOF if none). Blocks whose anchor heading no longer exists in `text`
 * (renamed/removed upstream) are collected as orphans and appended under a
 * synthesized recovery heading at EOF rather than silently dropped.
 *
 * @param {string} text
 * @param {Array} blocks
 * @param {object} [opts]
 * @param {boolean} [opts.alreadyPresent] — `text` already carries every block in
 *   `blocks` verbatim, in its original position (the mergeSkillContent
 *   heading-collision fallback reused dest's own unrefreshed head, which is exactly
 *   what `blocks` was extracted from) — skip re-insertion entirely rather than
 *   re-scanning. This replaces a per-block content-search idempotency check that
 *   used to live in the loop below: searching `content` for `block.raw` cannot tell
 *   apart "this exact block is already here" from "a DIFFERENT block with
 *   byte-identical text was already inserted a moment ago" — two distinct blocks
 *   under different anchor headings with identical raw text would collide, and the
 *   second block would be silently skipped (dropped) because the search matched the
 *   first block's just-inserted copy. Fresh source can also carry inherited
 *   project blocks. Match those by anchor and raw content, consuming each source
 *   occurrence once; never treat a newly inserted block as a source occurrence.
 * @returns {{ content: string, orphans: Array }}
 */
function reinsertFencedBlocks(text, blocks, opts) {
    opts = opts || {};
    let content = text.replace(/\r\n/g, '\n');
    if (opts.alreadyPresent) {
        return { content: content.endsWith('\n') ? content : content + '\n', orphans: [] };
    }
    const inherited = new Map();
    const identity = block => JSON.stringify([block.anchorHeading, block.raw]);
    for (const block of extractFencedBlocks(content)) {
        const key = identity(block);
        inherited.set(key, (inherited.get(key) || 0) + 1);
    }
    const orphans = [];
    for (const block of blocks) {
        const key = identity(block);
        const remaining = inherited.get(key) || 0;
        if (remaining) {
            inherited.set(key, remaining - 1);
            continue;
        }
        // Fence-aware line scan: BOTH the anchor lookup and the next-heading scan must
        // skip lines inside code fences. A template section whose body is a fenced
        // example containing heading-shaped lines (qa-engineer's ```markdown strategy
        // template starts with `# Test Strategy: {Project Name}`) otherwise terminates
        // the section scan INSIDE the fence, splicing the block into the code example —
        // which also strands its markers where the fence-blind marker scan ignores
        // them, so the block is clobbered on the NEXT sync (observed live, 2026-07-16).
        const { lines, inFence } = scanFenceState(content);
        // Headings inside an existing project-additions block (a template may ship its
        // own) are block content, not section boundaries: ending the section there
        // splices this block INSIDE the other one and nests the markers.
        const inBlock = blockLineMask(lines, inFence);
        let headingIdx = -1;
        if (block.anchorHeading) {
            for (let j = 0; j < lines.length; j++) {
                if (!inFence[j] && !inBlock[j] && lines[j] === block.anchorHeading) { headingIdx = j; break; }
            }
        }
        if (headingIdx === -1) {
            orphans.push(block);
            continue;
        }
        let insertAt = lines.length;
        for (let j = headingIdx + 1; j < lines.length; j++) {
            if (inFence[j] || inBlock[j]) continue;
            const m = /^(#{1,6})\s+\S/.exec(lines[j]);
            if (m && m[1].length <= block.anchorLevel) { insertAt = j; break; }
        }
        while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
        content = [...lines.slice(0, insertAt), '', block.raw, ...lines.slice(insertAt)].join('\n');
    }
    if (orphans.length) {
        if (!content.includes(ORPHAN_HEADING)) {
            content = content.replace(/\s*$/, '\n') +
                `\n${ORPHAN_HEADING}\n\n` +
                'The anchor heading these blocks were attached to no longer exists in the ' +
                'refreshed template — a human should re-home them.\n';
        }
        for (const o of orphans) content += `\n${o.raw}\n`;
    }
    if (!content.endsWith('\n')) content += '\n';
    return { content, orphans };
}

/**
 * Find the start index of `needle` as a contiguous run within `haystack` (both
 * arrays of lines), or -1. O(n*m) — fine at skill-file scale.
 * @param {string[]} haystack
 * @param {string[]} needle
 * @returns {number}
 */
function findLineSubsequence(haystack, needle) {
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}

/**
 * The set of distinct Markdown heading lines (`#` through `######`, verbatim
 * including the `#` markers) in `text`. Used to detect whether a dest tail's
 * content collides with what a refreshed head would (re)introduce.
 * @param {string} text
 * @returns {Set<string>}
 */
function headingLines(text) {
    const heads = new Set();
    // Fence-aware: heading-shaped lines inside code fences are examples, not headings —
    // counting them inflates the rewrite heuristic's collision count (same defect class
    // as the reinsertion scan above).
    const { lines, inFence } = scanFenceState(text);
    for (let i = 0; i < lines.length; i++) {
        if (!inFence[i] && /^#{1,6}\s+\S/.test(lines[i])) heads.add(lines[i]);
    }
    return heads;
}

/**
 * Strip ALL adopter-owned content — the whole-tail marker section (if present) AND
 * every anchored fenced block — leaving only the portion that's comparable to the
 * upstream template. `fleet:diverge`'s blob-identity comparison uses this instead of
 * raw `splitAtMarker(...).head`: a file using ONLY Form 2 (anchored fences, no bare
 * tail marker) would otherwise have its protected local content counted as part of
 * the "head," making it register as a false-positive template edit on every audit.
 *
 * @param {string} text
 * @returns {string}
 */
function stripAdopterOwned(text) {
    const { head } = splitAtMarker(text);
    const blocks = extractFencedBlocks(head);
    if (blocks.length === 0) return head;
    let lines = head.replace(/\r\n/g, '\n').split('\n');
    for (const block of blocks) {
        const blockLines = block.raw.split('\n');
        const idx = findLineSubsequence(lines, blockLines);
        if (idx !== -1) lines.splice(idx, blockLines.length);
    }
    return lines.join('\n');
}

/**
 * Merge skill file content: refresh the template body from source, preserve every
 * form of the dest's project additions (whole-tail marker and/or anchored fences).
 *
 * @param {string} srcText
 * @param {string} dstText
 * @returns {{ content: string, preserved: boolean, orphans: Array, headSuppressed: boolean }}
 *   headSuppressed is true when the head-refresh fallback below fired — i.e. the
 *   template head was NOT refreshed from source this merge.
 */
function mergeSkillContent(srcText, dstText) {
    const dst = splitAtMarker(dstText);
    const fenceScanTarget = dst.tail === null ? dstText : dst.head;
    const dstFenced = extractFencedBlocks(fenceScanTarget);

    let content;
    let preserved = false;
    let headSuppressed = false;
    if (dst.tail === null) {
        content = srcText.replace(/\r\n/g, '\n');
    } else {
        preserved = true;
        const src = splitAtMarker(srcText);
        const headCandidate = (src.tail === null ? srcText : src.head).replace(/\r\n/g, '\n');
        // Refreshing the head from source is unsafe when the dest's tail is a
        // REWRITE of content that also lives in the head candidate, not a genuinely
        // new addition — concatenating the two then duplicates every such section
        // (shipped bug: a fully-rewritten reference doc, marked from the title down,
        // synced against a source with no marker stub of its own produced two
        // "## The Iron Law" sections in the same file). Detect that case by heading
        // collision — but a SINGLE coincidental heading-name match (e.g. both files
        // happen to have an unrelated "## Notes" section) must not freeze the whole
        // head; only a collision covering a SUBSTANTIAL portion of the head's
        // headings (at least 2, or at least half of them for a small file) counts as
        // a genuine rewrite. Below that bar, refresh normally — the rare duplicated
        // heading is a smaller cost than silently stopping every template update.
        const tailHeadings = headingLines(dst.tail);
        const headHeadings = headingLines(headCandidate);
        const collisionCount = [...tailHeadings].filter((h) => headHeadings.has(h)).length;
        const isRewrite = headHeadings.size > 0 &&
            (collisionCount >= 2 || collisionCount / headHeadings.size >= 0.5);
        headSuppressed = isRewrite;
        const head = (isRewrite ? dst.head : headCandidate).replace(/\s*$/, '\n\n');
        content = head + dst.tail;
    }
    if (!content.endsWith('\n')) content += '\n';

    if (dstFenced.length === 0) return { content, preserved, orphans: [], headSuppressed };

    // The tail is already project-owned, not an incoming source occurrence.
    // Reinsert into the refreshed head so a matching tail block cannot consume
    // an inline block or move its insertion past the ownership boundary.
    const refreshed = splitAtMarker(content);
    const { content: withFences, orphans } = reinsertFencedBlocks(refreshed.head, dstFenced, { alreadyPresent: headSuppressed });
    const merged = refreshed.tail === null ? withFences : withFences.replace(/\s*$/, '\n\n') + refreshed.tail;
    return { content: merged, preserved: true, orphans, headSuppressed };
}

/**
 * Merge a skill file from srcPath into dstPath.
 *
 * If dstPath doesn't exist: simple copy (fresh install).
 * If dstPath exists: refresh the template body, preserve any project additions.
 *
 * @param {string} srcPath
 * @param {string} dstPath
 * @param {string} [containRoot]  — destination project root; enables safeWrite's
 *                 symlinked-ancestor guard (fleet:sync trust boundary)
 * @returns {{ changed: boolean, preserved: boolean, detail: string, orphans: Array }}
 */
function mergeSkillFile(srcPath, dstPath, containRoot) {
    const srcContent = fs.readFileSync(srcPath, 'utf8');

    if (!fs.existsSync(dstPath)) {
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        safeWrite(dstPath, srcContent, 'utf8', containRoot);
        return { changed: true, preserved: false, detail: 'copied (fresh install)', orphans: [] };
    }

    const dstContent = fs.readFileSync(dstPath, 'utf8');
    const { content, preserved, orphans, headSuppressed } = mergeSkillContent(srcContent, dstContent);
    const changed = content !== dstContent;
    if (changed) {
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        safeWrite(dstPath, content, 'utf8', containRoot);
    }

    let detail = preserved
        ? (changed ? 'merged (preserved project additions)' : 'unchanged (project additions intact)')
        : (changed ? 'overwritten (no project additions)' : 'unchanged');
    if (headSuppressed) {
        detail += ' — WARNING: head refresh SUPPRESSED (tail heading collision read as a rewrite; template updates were NOT applied to the head this merge)';
    }
    if (orphans.length) {
        detail += ` — WARNING: ${orphans.length} project-addition block(s) orphaned (anchor heading removed upstream, recovered at EOF)`;
    }

    return { changed, preserved, detail, orphans, headSuppressed };
}

module.exports = {
    PROJECT_ADDITIONS_MARKER,
    FENCE_START,
    FENCE_END,
    ORPHAN_HEADING,
    hasProjectAdditions,
    splitAtMarker,
    extractFencedBlocks,
    reinsertFencedBlocks,
    stripAdopterOwned,
    mergeSkillContent,
    mergeSkillFile,
};
