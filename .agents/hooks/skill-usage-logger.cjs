#!/usr/bin/env node

/**
 * Skill Usage Logger Hook
 *
 * Dual-trigger telemetry for the skill system. Registered on two PostToolUse
 * events and handles each differently:
 *
 * ── Trigger 1: PostToolUse:Agent / PostToolUse:Task ───────────────────────
 * Registered on both event names because the subagent-dispatch tool fires as
 * 'Task' on current Claude Code builds and as 'Agent' on older ones.
 * When a subagent is dispatched, resolves the agent definition file from
 * `subagent_type`, parses its `skills:` frontmatter list, and emits an
 * `agent_dispatch` event. This captures the expected auto-loaded skill set
 * for every subagent invocation.
 *
 * NOTE: Frontmatter skills are injected by the Claude Code runtime into the
 * agent's system prompt — no Read event fires for that injection. This event
 * is an INFERRED record ("these skills were configured to load") not a
 * directly observed one ("the agent read this file").
 *
 * ── Trigger 2: PostToolUse:Read ───────────────────────────────────────────
 * When a .claude/skills/** file is explicitly read (an agent following its
 * body's "read this reference at task start" instruction), emits a
 * `skill_read` event recording the skill name and specific file.
 *
 * This captures on-demand loads — SKILL.md reads and references/*.md deep-dives
 * that agents perform based on task context.
 *
 * ── Output ────────────────────────────────────────────────────────────────
 * docs/.output/.state/telemetry/skill-usage.jsonl
 *
 * ── Event shapes ──────────────────────────────────────────────────────────
 * @typedef {Object} AgentDispatchEvent
 * @property {string}   timestamp   ISO 8601
 * @property {'agent_dispatch'} type
 * @property {string}   agent       subagent_type (e.g. "general-purpose")
 * @property {string[]} skills      Skills from agent frontmatter skills: list
 * @property {string|null} description  Agent dispatch description param (if any)
 * @property {string}   [run_id]    SF-3.3: the session's run id; present only when the run pointer is usable
 * @property {number|null} [wave]   SF-3.3: the pointer's wave (null just after a run starts); present with run_id
 *
 * RUN ID ON ROWS (SF-3.3): `agent_dispatch` rows carry `run_id` and `wave` when this session's run
 * pointer (`current-run-{session}.json`, written by run-record.js) is usable; otherwise the two keys
 * are absent and the row is unchanged. The pointer is read under `pointerRoot()` (the main worktree,
 * where run-record.js writes it) by `_lib/run-pointer.js`, which never throws and never blocks. `skill_read` rows are never stamped.
 * The session is `CLAUDE_CODE_SESSION_ID` first, else the hook payload's `session_id`.
 *
 * @typedef {Object} SkillReadEvent
 * @property {string}   timestamp   ISO 8601
 * @property {'skill_read'} type
 * @property {string}   skill       Skill directory name (e.g. "example-skill")
 * @property {string}   file        Path within skill dir (e.g. "SKILL.md" or "references/guide.md")
 *
 * ── Exit codes ────────────────────────────────────────────────────────────
 * Always 0 — PostToolUse hooks cannot block.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { appendJsonl }      = require('../core/_lib/jsonl-writer');
const { readHookInput }    = require('../core/_lib/hook-input');
const { getJsonlPath }     = require('../core/_lib/telemetry-paths');
const { parseFrontmatter } = require('../core/_lib/frontmatter');
const { resolveProjectRoot } = require('../core/_lib/project-root');
const { readRunPointer, pointerRoot } = require('../core/_lib/run-pointer');

const MAX_LINES  = 2000;
const TAIL_KEEP  = 1000;
const JSONL_NAME = 'skill-usage.jsonl';

// List fields we need when parsing agent frontmatter
const AGENT_LIST_FIELDS = ['skills', 'tags', 'aliases', 'sources', 'cssclasses'];

// Match any file under .claude/skills/<skill-name>/
// Captures: [1]=skill-name, [2]=relative path within the skill dir (e.g. "SKILL.md" or "references/guide.md")
const SKILL_PATH_RE = /[/\\]\.claude[/\\]skills[/\\]([^/\\]+)[/\\](.+\.md)$/;

function getProjectRoot() {
    // F72-class sibling (CR-3.1 sweep): skill-usage telemetry is a gitignored
    // `.state/` file shared across linked worktrees — anchor to the git-common-dir
    // via resolveProjectRoot (still reads CLAUDE_PROJECT_DIR at call time) rather
    // than the naive __dirname fallback that loses events into a worktree-local path.
    return resolveProjectRoot(path.resolve(__dirname, '..', '..'));
}

/**
 * Attempt to parse a file path as a skill file reference.
 * Returns null if the path is not under .claude/skills/.
 */
function parseSkillPath(filePath) {
    if (!filePath || typeof filePath !== 'string') return null;
    const m = filePath.replace(/\\/g, '/').match(SKILL_PATH_RE.source
        ? SKILL_PATH_RE
        : new RegExp(SKILL_PATH_RE.source));
    if (!m) return null;
    return { skill: m[1], file: m[2] };
}

/**
 * Parse agent skills from .claude/agents/<agentType>.md frontmatter.
 * Returns [] on any failure — never throws.
 */
function resolveAgentSkills(agentType, projectRoot) {
    if (!agentType || typeof agentType !== 'string') return [];
    const agentFile = path.join(projectRoot, '.claude', 'agents', `${agentType}.md`);
    try {
        const content = fs.readFileSync(agentFile, 'utf8');
        const fm = parseFrontmatter(content, { listFields: AGENT_LIST_FIELDS });
        if (!fm) return [];
        const skills = fm.skills;
        if (!skills) return [];
        if (Array.isArray(skills)) return skills.filter(s => typeof s === 'string');
        if (typeof skills === 'string') return [skills];
        return [];
    } catch {
        return [];
    }
}

// Same session rule as command-usage-logger: env first, else the hook payload's own session_id.
function resolveSessionId(parsedJson) {
    return process.env.CLAUDE_CODE_SESSION_ID || parsedJson?.session_id || null;
}

/**
 * Handle a PostToolUse:Agent event.
 * Infers which skills will auto-load and emits an agent_dispatch record.
 */
function handleAgentDispatch(input, projectRoot) {
    const ti = input?.tool_input || {};
    const agentType = ti.subagent_type || ti.agent_type || null;

    // No subagent_type → not a subagent dispatch (or default general-purpose).
    // Still log it so we can see the gap in telemetry.
    const resolvedType = agentType || 'general-purpose';
    const skills = resolveAgentSkills(resolvedType, projectRoot);

    const event = {
        timestamp: new Date().toISOString(),
        type: 'agent_dispatch',
        agent: resolvedType,
        skills,
        description: ti.description || null,
    };

    return stampRun(event, projectRoot, resolveSessionId(input));
}

/**
 * SF-3.3: stamp run_id and wave from the session pointer. readRunPointer never throws and returns null for
 * anything unusable, leaving the row unchanged; the `pointerRoot()` argument is computed here too, so a
 * failure in either keeps the agent_dispatch row (unstamped) instead of losing it.
 */
function stampRun(event, projectRoot, session) {
    let run = null;
    try {
        run = readRunPointer({ root: pointerRoot(projectRoot), session });
    } catch {
        run = null;
    }
    if (run) {
        event.run_id = run.run_id;
        event.wave = run.wave;
    }
    return event;
}

/**
 * Handle a PostToolUse:Read event.
 * Emits a skill_read record if the file is under .claude/skills/.
 * Returns null for non-skill reads (the common case — don't log noise).
 */
function handleRead(input) {
    const filePath = input?.tool_input?.file_path || input?.tool_input?.path || null;
    const parsed = parseSkillPath(filePath);
    if (!parsed) return null;

    return {
        timestamp: new Date().toISOString(),
        type: 'skill_read',
        skill: parsed.skill,
        file: parsed.file,
    };
}

/**
 * Route the hook payload to the appropriate handler based on tool_name.
 * Returns the event object to log, or null to skip.
 */
function processEvent(parsedJson) {
    if (!parsedJson || typeof parsedJson !== 'object') return null;

    const toolName = parsedJson.tool_name || '';
    const projectRoot = getProjectRoot();

    let event = null;

    // The subagent-dispatch tool fires under different names across Claude Code
    // builds — historically 'Agent', more commonly 'Task' on current runtimes.
    // Recognize both explicitly; the subagent_type fallback covers any other name.
    if (toolName === 'Agent' || toolName === 'Task'
        || parsedJson?.tool_input?.subagent_type !== undefined) {
        event = handleAgentDispatch(parsedJson, projectRoot);
    } else if (toolName === 'Read' || parsedJson?.tool_input?.file_path !== undefined) {
        event = handleRead(parsedJson);
    }

    if (!event) return null;

    const jsonlPath = getJsonlPath(projectRoot, JSONL_NAME);
    appendJsonl(jsonlPath, event, { maxLines: MAX_LINES, tailKeep: TAIL_KEEP });

    return event;
}

async function main() {
    const input = await readHookInput();
    if (!input) { process.exit(0); }

    let data;
    try {
        data = JSON.parse(input);
    } catch {
        process.exit(0);
    }

    processEvent(data);
    process.exit(0);
}

if (require.main === module) {
    const { startHookTiming, emitHookEvent } = require('../core/_lib/hook-telemetry');
    const _hookToken = startHookTiming('skill-usage-logger');
    process.on('exit', () => {
        try { emitHookEvent(_hookToken, 'success'); } catch { /* never fail on telemetry */ }
    });
    main().catch(() => process.exit(0));
}

module.exports = { processEvent, parseSkillPath, resolveAgentSkills, stampRun };
