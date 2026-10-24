#!/usr/bin/env node

/**
 * skill-analytics.js — Skill & Agent Usage Report
 *
 * Two data layers:
 *   Configured  — scanned from .claude/agents/*.md and .claude/skills/ (always available)
 *   Observed    — read from docs/.output/.state/telemetry/skill-usage.jsonl (grows over time)
 *
 * Useful immediately after setup (configured layer) and increasingly useful as
 * telemetry accumulates (observed layer).
 *
 * Usage:
 *   node .claude/core/skill-analytics.js              # markdown to stdout
 *   node .claude/core/skill-analytics.js --output     # write to docs/.output/.state/telemetry/_skill-analytics.md
 *   node .claude/core/skill-analytics.js --json       # raw JSON to stdout
 *
 * Coverage tiers (shown in report):
 *   ACTIVE    — skill is in agent frontmatter AND has been explicitly read
 *   CONFIGURED — in agent frontmatter but never explicitly read (possible dead weight)
 *   ORPHANED  — not in any agent frontmatter AND never read (prime deletion candidate)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { parseFrontmatter } = require('./_lib/frontmatter');
const { getJsonlPath, getTelemetryDir } = require('./_lib/telemetry-paths');

const PROJECT_ROOT  = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
const SKILLS_DIR    = path.join(PROJECT_ROOT, '.claude', 'skills');
const AGENTS_DIR    = path.join(PROJECT_ROOT, '.claude', 'agents');
const USAGE_JSONL   = getJsonlPath(PROJECT_ROOT, 'skill-usage.jsonl');
const COMMAND_JSONL = getJsonlPath(PROJECT_ROOT, 'command-usage.jsonl');
const OUTPUT_FILE   = path.join(getTelemetryDir(PROJECT_ROOT), '_skill-analytics.md');

const WRITE_OUTPUT = process.argv.includes('--output');
const JSON_OUTPUT  = process.argv.includes('--json');

// ── Helpers ──────────────────────────────────────────────────────────────────

function readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    try {
        return fs.readFileSync(filePath, 'utf8')
            .split('\n')
            .filter(l => l.trim())
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean);
    } catch {
        return [];
    }
}

function readDir(dir) {
    try { return fs.readdirSync(dir); } catch { return []; }
}

/**
 * parseFrontmatter handles multi-line `skills:\n  - x` lists but not inline
 * `skills: [a, b]` arrays. Handle both.
 */
function extractSkillsList(fm) {
    const raw = fm?.skills;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.filter(s => typeof s === 'string' && s);
    if (typeof raw === 'string') {
        if (raw.startsWith('[') && raw.endsWith(']')) {
            return raw.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
        }
        return raw ? [raw] : [];
    }
    return [];
}

// ── Layer 1: Configured (filesystem) ─────────────────────────────────────────

function scanSkills() {
    const skills = {};
    for (const entry of readDir(SKILLS_DIR)) {
        const skillDir = path.join(SKILLS_DIR, entry);
        const skillMd  = path.join(skillDir, 'SKILL.md');
        if (!fs.existsSync(skillMd)) continue;

        const refsDir  = path.join(skillDir, 'references');
        const refFiles = fs.existsSync(refsDir)
            ? readDir(refsDir).filter(f => f.endsWith('.md'))
            : [];

        // Also scan sub-subdirectories (e.g. references/orm/, references/realtime/)
        const subDirs = fs.existsSync(refsDir)
            ? readDir(refsDir).filter(f => {
                try { return fs.statSync(path.join(refsDir, f)).isDirectory(); } catch { return false; }
              })
            : [];
        for (const sub of subDirs) {
            const subFiles = readDir(path.join(refsDir, sub)).filter(f => f.endsWith('.md'));
            refFiles.push(...subFiles.map(f => `${sub}/${f}`));
        }

        skills[entry] = {
            name: entry,
            refCount: refFiles.length,
            refFiles,
        };
    }
    return skills;
}

function scanAgents() {
    const agents = {};
    for (const file of readDir(AGENTS_DIR)) {
        if (!file.endsWith('.md')) continue;
        const name = file.replace(/\.md$/, '');
        const content = (() => { try { return fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8'); } catch { return ''; } })();
        const fm = parseFrontmatter(content, { listFields: ['skills', 'aliases', 'tags'] });
        const skills = extractSkillsList(fm);
        const nickname = fm?.nickname || null;
        agents[name] = { name, nickname, skills };
    }
    return agents;
}

/** Map each skill → which agents load it */
function buildSkillToAgents(agents) {
    const map = {};
    for (const [agentName, agent] of Object.entries(agents)) {
        for (const skill of agent.skills) {
            if (!map[skill]) map[skill] = [];
            map[skill].push(agentName);
        }
    }
    return map;
}

// ── Layer 2: Observed (telemetry) ─────────────────────────────────────────────

function loadSkillTelemetry() {
    const events = readJsonl(USAGE_JSONL);

    const agentDispatches  = {};   // agentName -> count
    const skillAutoLoads   = {};   // skillName -> count  (inferred from agent_dispatch)
    const skillReadsByFile = {};   // `${skill}::${file}` -> count
    const skillReadTotals  = {};   // skillName -> count

    for (const evt of events) {
        if (evt.type === 'agent_dispatch') {
            const agent = evt.agent || 'unknown';
            agentDispatches[agent] = (agentDispatches[agent] || 0) + 1;

            for (const skill of (evt.skills || [])) {
                skillAutoLoads[skill] = (skillAutoLoads[skill] || 0) + 1;
            }
        } else if (evt.type === 'skill_read') {
            const key = `${evt.skill}::${evt.file}`;
            skillReadsByFile[key] = (skillReadsByFile[key] || 0) + 1;
            skillReadTotals[evt.skill] = (skillReadTotals[evt.skill] || 0) + 1;
        }
    }

    return { events: events.length, agentDispatches, skillAutoLoads, skillReadsByFile, skillReadTotals };
}

function loadCommandTelemetry() {
    const events = readJsonl(COMMAND_JSONL);
    const commandFreq = {};
    const gateStats   = {};

    for (const evt of events) {
        if (evt.type === 'command_invocation') {
            const cmd = evt.command || 'unknown';
            commandFreq[cmd] = (commandFreq[cmd] || 0) + 1;
        } else if (evt.type === 'gate_run') {
            const gate = evt.command || 'unknown';
            if (!gateStats[gate]) gateStats[gate] = { pass: 0, fail: 0 };
            // Normalize outcome vocab (success/failure + legacy pass/fail);
            // 'unknown' has no signal — ignore (matches status.js).
            if (evt.outcome === 'success' || evt.outcome === 'pass') gateStats[gate].pass++;
            else if (evt.outcome === 'failure' || evt.outcome === 'fail') gateStats[gate].fail++;
        }
    }

    return { totalEvents: events.length, commandFreq, gateStats };
}

// ── Coverage classification ───────────────────────────────────────────────────

const STATUS = {
    ACTIVE:      'ACTIVE',      // in frontmatter + explicitly read
    CONFIGURED:  'CONFIGURED',  // in frontmatter, never read
    READ_ONLY:   'READ_ONLY',   // never in frontmatter, but explicitly read
    ORPHANED:    'ORPHANED',    // not in any frontmatter, never read
};

function classifySkills(skills, skillToAgents, skillAutoLoads, skillReadTotals) {
    return Object.keys(skills).map(name => {
        const agentCount  = (skillToAgents[name] || []).length;
        const autoLoads   = skillAutoLoads[name]  || 0;
        const reads       = skillReadTotals[name] || 0;
        const inFrontmatter = agentCount > 0;

        let status;
        if (inFrontmatter && reads > 0)  status = STATUS.ACTIVE;
        else if (inFrontmatter)           status = STATUS.CONFIGURED;
        else if (reads > 0)               status = STATUS.READ_ONLY;
        else                              status = STATUS.ORPHANED;

        return {
            name,
            agentCount,
            agents: skillToAgents[name] || [],
            autoLoads,
            reads,
            refCount: skills[name].refCount,
            status,
        };
    }).sort((a, b) => {
        // Sort: ACTIVE > CONFIGURED > READ_ONLY > ORPHANED, then by autoLoads desc
        const order = { ACTIVE: 0, CONFIGURED: 1, READ_ONLY: 2, ORPHANED: 3 };
        const diff = order[a.status] - order[b.status];
        return diff !== 0 ? diff : b.autoLoads - a.autoLoads;
    });
}

// ── Markdown report ───────────────────────────────────────────────────────────

function pct(pass, total) {
    if (!total) return 'n/a';
    return `${Math.round(100 * pass / total)}%`;
}

function topN(obj, n) {
    return Object.entries(obj)
        .sort(([, a], [, b]) => b - a)
        .slice(0, n);
}

function statusIcon(s) {
    return { ACTIVE: '✅', CONFIGURED: '⚠️ ', READ_ONLY: '📖', ORPHANED: '💀' }[s] || '?';
}

function buildReport(data) {
    const {
        skills, agents, skillToAgents, classifiedSkills,
        telemetry, commands, generatedAt,
    } = data;

    const totalSkills   = Object.keys(skills).length;
    const totalAgents   = Object.keys(agents).length;
    const orphaned      = classifiedSkills.filter(s => s.status === STATUS.ORPHANED);
    const active        = classifiedSkills.filter(s => s.status === STATUS.ACTIVE);
    const configured    = classifiedSkills.filter(s => s.status === STATUS.CONFIGURED);
    const hasGoodData   = telemetry.events > 10;

    const lines = [];
    const h  = s => lines.push(s);
    const br = ()  => lines.push('');

    h(`# .claude Skill & Agent Analytics`);
    h(`_Generated: ${generatedAt}_`);
    br();

    // ── Summary ────────────────────────────────────────────────────
    h(`## Summary`);
    br();
    h(`| | |`);
    h(`|--|--|`);
    h(`| Skills on disk | ${totalSkills} |`);
    h(`| Agents configured | ${totalAgents} |`);
    h(`| Active skills (auto-loaded + read) | ${active.length} |`);
    h(`| Configured-only (auto-loaded, never read) | ${configured.length} |`);
    h(`| Orphaned skills (not in any agent) | ${orphaned.length} |`);
    h(`| Observed telemetry events | ${telemetry.events}${telemetry.events < 10 ? ' ⚠️ (low — hook is recent)' : ''} |`);
    br();

    // ── Agent configuration map ────────────────────────────────────
    h(`## Agent Configuration`);
    h(`_What each agent is configured to auto-load. Dispatches = observed telemetry count._`);
    br();
    h(`| Agent | Nickname | Skills Auto-Loaded | Dispatches |`);
    h(`|-------|----------|--------------------|-----------|`);
    for (const [name, agent] of Object.entries(agents)) {
        const dispatches = telemetry.agentDispatches[name] || 0;
        const dispStr = hasGoodData ? String(dispatches) : `${dispatches} (low data)`;
        const skillStr = agent.skills.length ? agent.skills.join(', ') : '_(none)_';
        h(`| \`${name}\` | ${agent.nickname || '—'} | ${skillStr} | ${dispStr} |`);
    }
    br();

    // ── Skill coverage table ────────────────────────────────────────
    h(`## Skill Coverage`);
    h(`_✅ ACTIVE = in frontmatter + explicitly read | ⚠️  CONFIGURED = in frontmatter, never read | 💀 ORPHANED = not in any agent_`);
    br();
    h(`| Status | Skill | Agents Loading | Refs | Auto-Loads | Reads |`);
    h(`|--------|-------|---------------|------|-----------|-------|`);
    for (const s of classifiedSkills) {
        const agentList = s.agents.length
            ? s.agents.map(a => `\`${a}\``).join(' ')
            : '—';
        h(`| ${statusIcon(s.status)} ${s.status} | \`${s.name}\` | ${agentList} | ${s.refCount} | ${s.autoLoads} | ${s.reads} |`);
    }
    br();

    // ── Top on-demand reads ────────────────────────────────────────
    h(`## Top On-Demand Reads`);
    h(`_Skill reference files agents are explicitly pulling — strongest signal of actual usage._`);
    br();
    const topReads = topN(telemetry.skillReadsByFile, 20);
    if (topReads.length === 0) {
        h(`_No skill reads observed yet — telemetry just started. Run some tasks and re-run this script._`);
    } else {
        h(`| Skill | File | Reads |`);
        h(`|-------|------|-------|`);
        for (const [key, count] of topReads) {
            const [skill, file] = key.split('::');
            h(`| \`${skill}\` | \`${file}\` | ${count} |`);
        }
    }
    br();

    // ── Orphaned skills ─────────────────────────────────────────────
    h(`## Orphaned Skills`);
    h(`_Not in any agent frontmatter AND never explicitly read. Prime candidates to improve (add to an agent) or delete._`);
    br();
    if (orphaned.length === 0) {
        h(`✅ No orphaned skills — every skill is loaded by at least one agent.`);
    } else {
        for (const s of orphaned) {
            h(`- \`${s.name}\` (${s.refCount} reference files)`);
        }
    }
    br();

    // ── Gate performance ───────────────────────────────────────────
    h(`## Gate Performance`);
    br();
    const gates = Object.entries(commands.gateStats);
    if (gates.length === 0) {
        h(`_No gate runs recorded._`);
    } else {
        h(`| Gate | Runs | Pass | Fail | Rate |`);
        h(`|------|------|------|------|------|`);
        for (const [gate, stats] of gates.sort()) {
            const total = stats.pass + stats.fail;
            h(`| \`${gate}\` | ${total} | ${stats.pass} | ${stats.fail} | ${pct(stats.pass, total)} |`);
        }
    }
    br();

    // ── Command usage ──────────────────────────────────────────────
    h(`## Command Usage`);
    h(`_Note: user-typed slash commands have a known platform gap — only programmatic Skill tool invocations are captured._`);
    br();
    const topCmds = topN(commands.commandFreq, 15);
    if (topCmds.length === 0) {
        h(`_No command invocations recorded._`);
    } else {
        h(`| Command | Invocations |`);
        h(`|---------|------------|`);
        for (const [cmd, count] of topCmds) {
            h(`| \`${cmd}\` | ${count} |`);
        }
    }
    br();

    // ── Recommendations ────────────────────────────────────────────
    h(`## Recommendations`);
    br();
    const recs = [];

    if (orphaned.length > 0) {
        recs.push(`**${orphaned.length} orphaned skills**: Add to an agent's frontmatter or delete — \`${orphaned.map(s => s.name).join('`, `')}\``);
    }

    const configuredOnly = classifiedSkills.filter(s => s.status === STATUS.CONFIGURED);
    if (configuredOnly.length > 0 && hasGoodData) {
        recs.push(`**${configuredOnly.length} configured-but-never-read skills**: Either agents aren't following their body instructions, or the skills are too abstract. Check body instructions for: \`${configuredOnly.map(s => s.name).join('`, `')}\``);
    }

    const topAgent = topN(telemetry.agentDispatches, 1)[0];
    if (topAgent && hasGoodData) {
        recs.push(`**Most dispatched agent is \`${topAgent[0]}\`** (${topAgent[1]} dispatches) — highest leverage for improvement.`);
    }

    if (!hasGoodData) {
        recs.push(`**Low telemetry** (${telemetry.events} events): Run a few tasks with agents active to get meaningful observed data. Configured layer is reliable now.`);
    }

    if (recs.length === 0) {
        h(`✅ Nothing obvious to flag.`);
    } else {
        for (const rec of recs) {
            h(`- ${rec}`);
        }
    }

    return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
    const skills        = scanSkills();
    const agents        = scanAgents();
    const skillToAgents = buildSkillToAgents(agents);
    const telemetry     = loadSkillTelemetry();
    const commands      = loadCommandTelemetry();

    const classifiedSkills = classifySkills(
        skills, skillToAgents,
        telemetry.skillAutoLoads, telemetry.skillReadTotals
    );

    const data = {
        skills, agents, skillToAgents, classifiedSkills,
        telemetry, commands,
        generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    };

    if (JSON_OUTPUT) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
    }

    const report = buildReport(data);

    if (WRITE_OUTPUT) {
        try {
            fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
            fs.writeFileSync(OUTPUT_FILE, report, 'utf8');
            process.stderr.write(`Report written to ${OUTPUT_FILE}\n`);
        } catch (e) {
            process.stderr.write(`Failed to write output: ${e.message}\n`);
        }
    }

    process.stdout.write(report + '\n');
}

if (require.main === module) {
    main();
}

module.exports = {
    extractSkillsList,
    scanSkills,
    scanAgents,
    buildSkillToAgents,
    loadSkillTelemetry,
    loadCommandTelemetry,
    classifySkills,
    buildReport,
    pct,
    topN,
    statusIcon,
    main,
    STATUS,
};
