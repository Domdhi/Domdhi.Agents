// AC→source map (skill-analytics):
//   - extractSkillsList: normalizes array / inline-bracket-string / plain-string / malformed frontmatter
//   - scanSkills: SKILL.md-gated dirs, references/ + nested subdir refCount, non-.md files ignored
//   - scanAgents: frontmatter skills list + nickname, malformed/missing frontmatter degrades gracefully
//   - buildSkillToAgents: skill -> [agents] fan-out, including shared skills
//   - loadSkillTelemetry / loadCommandTelemetry: JSONL aggregation, malformed lines skipped, gate outcome
//     vocab normalization (success/pass, failure/fail, unknown ignored)
//   - classifySkills: ACTIVE/CONFIGURED/READ_ONLY/ORPHANED tiers + sort (status, then autoLoads desc)
//   - buildReport: markdown shape for summary/agent/skill/reads/orphans/gates/commands/recommendations
//   - main(): --json vs default markdown vs --output file-write, all via one shared `data` shape

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');

// skill-analytics.js captures PROJECT_ROOT (and the --json/--output flags) from
// process.env / process.argv at module-load time. Every test that needs it to
// read a temp fixture must bust the CJS require cache and re-require after
// setting env + argv (same pattern as metrics.test.js / gen-timeline.test.js).
function bustCache() {
    delete require.cache[require.resolve('../skill-analytics')];
    delete require.cache[require.resolve('../_lib/frontmatter')];
    delete require.cache[require.resolve('../_lib/telemetry-paths')];
}

let tmp;
let originalEnv;
let originalArgv;

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'skill-analytics-' });
    originalEnv = process.env.CLAUDE_PROJECT_DIR;
    originalArgv = process.argv.slice();
});

afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalEnv;
    process.argv = originalArgv;
    bustCache();
    tmp.cleanup();
});

/** Fresh-require the module with CLAUDE_PROJECT_DIR pointed at the tmp fixture. */
function loadModule(extraArgv = []) {
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
    process.argv = ['node', 'skill-analytics.js', ...extraArgv];
    bustCache();
    return require('../skill-analytics');
}

function writeJsonl(relPath, rows) {
    tmp.write(relPath, rows.map(r => JSON.stringify(r)).join('\n'));
}

const SKILL_JSONL = 'docs/.output/.state/telemetry/skill-usage.jsonl';
const CMD_JSONL   = 'docs/.output/.state/telemetry/command-usage.jsonl';

// ── extractSkillsList ────────────────────────────────────────────────────────

describe('extractSkillsList', () => {
    it('array_ofStrings_filtersOutFalsyAndNonStringEntries', () => {
        const mod = loadModule();
        expect(mod.extractSkillsList({ skills: ['a', 'b', ''] })).toEqual(['a', 'b']);
        expect(mod.extractSkillsList({ skills: ['a', 42, null, 'b'] })).toEqual(['a', 'b']);
    });

    it('missingOrNullFrontmatter_returnsEmptyArray', () => {
        const mod = loadModule();
        expect(mod.extractSkillsList({})).toEqual([]);
        expect(mod.extractSkillsList(null)).toEqual([]);
        expect(mod.extractSkillsList(undefined)).toEqual([]);
    });

    it('inlineBracketString_parsesCommaSeparatedArray', () => {
        const mod = loadModule();
        expect(mod.extractSkillsList({ skills: '[architecture, project-planning]' }))
            .toEqual(['architecture', 'project-planning']);
    });

    it('plainString_wrapsAsSingleElementArray', () => {
        const mod = loadModule();
        expect(mod.extractSkillsList({ skills: 'solo-skill' })).toEqual(['solo-skill']);
    });

    it('nonArrayNonStringValue_doesNotThrowAndReturnsEmptyArray', () => {
        const mod = loadModule();
        expect(mod.extractSkillsList({ skills: 42 })).toEqual([]);
        expect(mod.extractSkillsList({ skills: { nested: true } })).toEqual([]);
    });
});

// ── scanSkills ───────────────────────────────────────────────────────────────

describe('scanSkills', () => {
    it('scansSkillMdGatedDirs_computesRefCountIncludingNestedReferenceSubdirs', () => {
        tmp.write('.claude/skills/architecture/SKILL.md', '# Architecture');
        tmp.write('.claude/skills/architecture/references/adr-template.md', '# ADR');
        tmp.write('.claude/skills/architecture/references/patterns/microservices.md', '# micro');
        tmp.write('.claude/skills/project-planning/SKILL.md', '# Planning'); // no references dir at all

        const mod = loadModule();
        const skills = mod.scanSkills();

        expect(Object.keys(skills).sort()).toEqual(['architecture', 'project-planning']);
        expect(skills.architecture.refCount).toBe(2);
        expect(skills.architecture.refFiles).toContain('adr-template.md');
        expect(skills.architecture.refFiles).toContain('patterns/microservices.md');
        expect(skills['project-planning'].refCount).toBe(0);
        expect(skills['project-planning'].refFiles).toEqual([]);
    });

    it('skipsDirsWithoutSkillMd', () => {
        tmp.write('.claude/skills/not-a-skill/README.md', '# not a skill');
        const mod = loadModule();
        expect(mod.scanSkills()).toEqual({});
    });

    it('ignoresNonMarkdownReferenceFiles', () => {
        tmp.write('.claude/skills/architecture/SKILL.md', '# Architecture');
        tmp.write('.claude/skills/architecture/references/notes.txt', 'not markdown');
        const mod = loadModule();
        expect(mod.scanSkills().architecture.refCount).toBe(0);
    });

    it('missingSkillsDir_returnsEmptyObjectWithoutThrowing', () => {
        const mod = loadModule();
        expect(mod.scanSkills()).toEqual({});
    });
});

// ── scanAgents ───────────────────────────────────────────────────────────────

describe('scanAgents', () => {
    it('parsesFrontmatterSkillsListAndNickname', () => {
        tmp.write('.claude/agents/architect.md', [
            '---',
            'name: architect',
            'nickname: Archie',
            'skills:',
            '  - architecture',
            '  - project-planning',
            '---',
            '',
            'Body text.',
            '',
        ].join('\n'));

        const mod = loadModule();
        const agents = mod.scanAgents();

        expect(agents.architect).toEqual({
            name: 'architect',
            nickname: 'Archie',
            skills: ['architecture', 'project-planning'],
        });
    });

    it('agentFileWithoutFrontmatter_registersWithEmptySkillsAndNullNickname', () => {
        tmp.write('.claude/agents/blank-agent.md', '# Just a heading\n\nNo frontmatter here.\n');
        const mod = loadModule();
        expect(mod.scanAgents()['blank-agent']).toEqual({ name: 'blank-agent', nickname: null, skills: [] });
    });

    it('ignoresNonMarkdownFilesInAgentsDir', () => {
        tmp.write('.claude/agents/architect.md', '---\nname: architect\n---\n');
        tmp.write('.claude/agents/notes.txt', 'not an agent');
        const mod = loadModule();
        expect(Object.keys(mod.scanAgents())).toEqual(['architect']);
    });

    it('missingAgentsDir_returnsEmptyObjectWithoutThrowing', () => {
        const mod = loadModule();
        expect(mod.scanAgents()).toEqual({});
    });
});

// ── buildSkillToAgents ───────────────────────────────────────────────────────

describe('buildSkillToAgents', () => {
    it('mapsEachSkillToTheAgentsThatLoadIt_includingSharedSkills', () => {
        const mod = loadModule();
        const agents = {
            architect: { name: 'architect', skills: ['architecture', 'shared'] },
            ux: { name: 'ux', skills: ['ux-design', 'shared'] },
        };
        expect(mod.buildSkillToAgents(agents)).toEqual({
            architecture: ['architect'],
            shared: ['architect', 'ux'],
            'ux-design': ['ux'],
        });
    });

    it('emptyAgents_returnsEmptyMap', () => {
        const mod = loadModule();
        expect(mod.buildSkillToAgents({})).toEqual({});
    });
});

// ── loadSkillTelemetry ───────────────────────────────────────────────────────

describe('loadSkillTelemetry', () => {
    it('aggregatesDispatchesAndReads_skippingMalformedAndBlankLines', () => {
        const jsonl = [
            JSON.stringify({ type: 'agent_dispatch', agent: 'architect', skills: ['architecture', 'project-planning'] }),
            JSON.stringify({ type: 'agent_dispatch', agent: 'architect', skills: ['architecture'] }),
            JSON.stringify({ type: 'skill_read', skill: 'architecture', file: 'references/adr-template.md' }),
            JSON.stringify({ type: 'skill_read', skill: 'architecture', file: 'references/adr-template.md' }),
            'not valid json',
            '',
            JSON.stringify({ type: 'other_event' }),
        ].join('\n');
        tmp.write(SKILL_JSONL, jsonl);

        const mod = loadModule();
        const t = mod.loadSkillTelemetry();

        // 5 well-formed JSON rows parsed (malformed line + blank line dropped);
        // the unrecognized `other_event` type still counts toward the raw total.
        expect(t.events).toBe(5);
        expect(t.agentDispatches.architect).toBe(2);
        expect(t.skillAutoLoads.architecture).toBe(2);
        expect(t.skillAutoLoads['project-planning']).toBe(1);
        expect(t.skillReadTotals.architecture).toBe(2);
        expect(t.skillReadsByFile['architecture::references/adr-template.md']).toBe(2);
    });

    it('missingFile_returnsZeroedShapeWithoutThrowing', () => {
        const mod = loadModule();
        expect(mod.loadSkillTelemetry()).toEqual({
            events: 0, agentDispatches: {}, skillAutoLoads: {}, skillReadsByFile: {}, skillReadTotals: {},
        });
    });

    it('dispatchEventMissingAgentField_fallsBackToUnknown', () => {
        writeJsonl(SKILL_JSONL, [{ type: 'agent_dispatch', skills: ['x'] }]);
        const mod = loadModule();
        expect(mod.loadSkillTelemetry().agentDispatches.unknown).toBe(1);
    });
});

// ── loadCommandTelemetry ─────────────────────────────────────────────────────

describe('loadCommandTelemetry', () => {
    it('countsInvocationsAndGateOutcomes_normalizingLegacyVocabAndIgnoringUnknown', () => {
        writeJsonl(CMD_JSONL, [
            { type: 'command_invocation', command: 'do' },
            { type: 'command_invocation', command: 'do' },
            { type: 'command_invocation', command: 'todo' },
            { type: 'gate_run', command: 'gate:test', outcome: 'success' },
            { type: 'gate_run', command: 'gate:test', outcome: 'pass' },     // legacy pass
            { type: 'gate_run', command: 'gate:test', outcome: 'failure' },
            { type: 'gate_run', command: 'gate:test', outcome: 'fail' },     // legacy fail
            { type: 'gate_run', command: 'gate:test', outcome: 'unknown' },  // no signal — ignored
        ]);

        const mod = loadModule();
        const c = mod.loadCommandTelemetry();

        expect(c.totalEvents).toBe(8);
        expect(c.commandFreq.do).toBe(2);
        expect(c.commandFreq.todo).toBe(1);
        expect(c.gateStats['gate:test']).toEqual({ pass: 2, fail: 2 });
    });

    it('missingFile_returnsZeroedShapeWithoutThrowing', () => {
        const mod = loadModule();
        expect(mod.loadCommandTelemetry()).toEqual({ totalEvents: 0, commandFreq: {}, gateStats: {} });
    });

    it('gateEventMissingCommandField_fallsBackToUnknown', () => {
        writeJsonl(CMD_JSONL, [{ type: 'gate_run', outcome: 'success' }]);
        const mod = loadModule();
        expect(mod.loadCommandTelemetry().gateStats.unknown).toEqual({ pass: 1, fail: 0 });
    });
});

// ── classifySkills ───────────────────────────────────────────────────────────

describe('classifySkills', () => {
    it('classifiesIntoFourTiers_andSortsActiveFirstThenByAutoLoadsDesc', () => {
        const mod = loadModule();
        const skills = {
            'active-low':  { refCount: 1 },
            'active-high': { refCount: 2 },
            'configured':  { refCount: 0 },
            'read-only':   { refCount: 3 },
            'orphaned':    { refCount: 0 },
        };
        const skillToAgents = {
            'active-low':  ['architect'],
            'active-high': ['architect'],
            'configured':  ['architect', 'ux'],
        };
        const skillAutoLoads  = { 'active-low': 5, 'active-high': 10, configured: 2 };
        const skillReadTotals = { 'active-low': 3, 'active-high': 1, 'read-only': 7 };

        const classified = mod.classifySkills(skills, skillToAgents, skillAutoLoads, skillReadTotals);

        expect(classified.map(s => s.name)).toEqual(['active-high', 'active-low', 'configured', 'read-only', 'orphaned']);
        expect(classified.map(s => s.status)).toEqual(['ACTIVE', 'ACTIVE', 'CONFIGURED', 'READ_ONLY', 'ORPHANED']);

        const configured = classified.find(s => s.name === 'configured');
        expect(configured.agentCount).toBe(2);
        expect(configured.agents).toEqual(['architect', 'ux']);

        const orphaned = classified.find(s => s.name === 'orphaned');
        expect(orphaned.agentCount).toBe(0);
        expect(orphaned.agents).toEqual([]);
    });

    it('emptySkills_returnsEmptyArray', () => {
        const mod = loadModule();
        expect(mod.classifySkills({}, {}, {}, {})).toEqual([]);
    });
});

// ── pct / topN / statusIcon ──────────────────────────────────────────────────

describe('pct', () => {
    it('roundsToNearestWholePercent', () => {
        const mod = loadModule();
        expect(mod.pct(3, 4)).toBe('75%');
        expect(mod.pct(1, 3)).toBe('33%');
    });

    it('zeroTotal_returnsNotApplicable', () => {
        const mod = loadModule();
        expect(mod.pct(0, 0)).toBe('n/a');
    });
});

describe('topN', () => {
    it('sortsDescendingByValueAndCapsAtN', () => {
        const mod = loadModule();
        expect(mod.topN({ a: 5, b: 10, c: 1 }, 2)).toEqual([['b', 10], ['a', 5]]);
    });

    it('emptyObject_returnsEmptyArray', () => {
        const mod = loadModule();
        expect(mod.topN({}, 5)).toEqual([]);
    });
});

describe('statusIcon', () => {
    it('mapsAllFourKnownStatusesToDistinctIcons', () => {
        const mod = loadModule();
        const icons = mod.STATUS && Object.keys(mod.STATUS).map(s => mod.statusIcon(s));
        expect(new Set(icons).size).toBe(4); // four distinct icons, one per tier
        expect(mod.statusIcon('ACTIVE')).not.toBe('?');
    });

    it('unknownStatus_returnsQuestionMark', () => {
        const mod = loadModule();
        expect(mod.statusIcon('SOMETHING_ELSE')).toBe('?');
    });
});

// ── buildReport ──────────────────────────────────────────────────────────────

describe('buildReport', () => {
    function baseData(overrides = {}) {
        return {
            skills: {},
            agents: {},
            skillToAgents: {},
            classifiedSkills: [],
            telemetry: { events: 0, agentDispatches: {}, skillAutoLoads: {}, skillReadsByFile: {}, skillReadTotals: {} },
            commands: { totalEvents: 0, commandFreq: {}, gateStats: {} },
            generatedAt: '2026-07-02 12:00 UTC',
            ...overrides,
        };
    }

    it('rendersSummaryAgentAndSkillTables_withMixedStatuses', () => {
        const mod = loadModule();
        const data = baseData({
            skills: { architecture: { refCount: 2 }, 'project-planning': { refCount: 0 }, 'orphan-skill': { refCount: 1 } },
            agents: { architect: { name: 'architect', nickname: 'Archie', skills: ['architecture', 'project-planning'] } },
            classifiedSkills: [
                { name: 'architecture', agentCount: 1, agents: ['architect'], autoLoads: 5, reads: 3, refCount: 2, status: 'ACTIVE' },
                { name: 'project-planning', agentCount: 1, agents: ['architect'], autoLoads: 2, reads: 0, refCount: 0, status: 'CONFIGURED' },
                { name: 'orphan-skill', agentCount: 0, agents: [], autoLoads: 0, reads: 0, refCount: 1, status: 'ORPHANED' },
            ],
            telemetry: {
                events: 15,
                agentDispatches: { architect: 7 },
                skillAutoLoads: { architecture: 5, 'project-planning': 2 },
                skillReadsByFile: { 'architecture::references/adr-template.md': 3 },
                skillReadTotals: { architecture: 3 },
            },
            commands: {
                totalEvents: 7,
                commandFreq: { do: 5, todo: 2 },
                gateStats: { 'gate:test': { pass: 3, fail: 1 } },
            },
        });

        const report = mod.buildReport(data);

        expect(report).toContain('| Skills on disk | 3 |');
        expect(report).toContain('| Agents configured | 1 |');
        expect(report).toContain('| Active skills (auto-loaded + read) | 1 |');
        expect(report).toContain('| Configured-only (auto-loaded, never read) | 1 |');
        expect(report).toContain('| Orphaned skills (not in any agent) | 1 |');
        expect(report).toContain('| Observed telemetry events | 15 |');
        expect(report).not.toContain('(low — hook is recent)');

        expect(report).toContain('| `architect` | Archie | architecture, project-planning | 7 |');

        expect(report).toContain(`${mod.statusIcon('ACTIVE')} ACTIVE | \`architecture\``);
        expect(report).toContain(`${mod.statusIcon('CONFIGURED')} CONFIGURED | \`project-planning\``);
        expect(report).toContain(`${mod.statusIcon('ORPHANED')} ORPHANED | \`orphan-skill\``);

        expect(report).toContain('| `architecture` | `references/adr-template.md` | 3 |');
        expect(report).toContain('- `orphan-skill` (1 reference files)');

        expect(report).toContain('| `gate:test` | 4 | 3 | 1 | 75% |');
        expect(report).toContain('| `do` | 5 |');
        expect(report).toContain('| `todo` | 2 |');

        expect(report).toContain('**1 orphaned skills**');
        expect(report).toContain('**1 configured-but-never-read skills**');
        expect(report).toContain('Most dispatched agent is `architect`');
    });

    it('rendersFallbackText_whenNoReadsOrphansGatesOrCommands', () => {
        const mod = loadModule();
        const data = baseData({ telemetry: { events: 3, agentDispatches: {}, skillAutoLoads: {}, skillReadsByFile: {}, skillReadTotals: {} } });

        const report = mod.buildReport(data);

        expect(report).toContain('| Observed telemetry events | 3 ⚠️ (low — hook is recent) |');
        expect(report).toContain('_No skill reads observed yet — telemetry just started. Run some tasks and re-run this script._');
        expect(report).toContain('✅ No orphaned skills — every skill is loaded by at least one agent.');
        expect(report).toContain('_No gate runs recorded._');
        expect(report).toContain('_No command invocations recorded._');
        expect(report).toContain('**Low telemetry** (3 events)');
    });

    it('rendersNothingObviousToFlag_whenTelemetryIsGoodAndNoIssuesFound', () => {
        const mod = loadModule();
        const data = baseData({ telemetry: { events: 20, agentDispatches: {}, skillAutoLoads: {}, skillReadsByFile: {}, skillReadTotals: {} } });
        const report = mod.buildReport(data);
        expect(report).toContain('✅ Nothing obvious to flag.');
    });

    it('agentWithNoSkillsAndLowTelemetry_rendersNoneAndLowDataSuffix', () => {
        const mod = loadModule();
        const data = baseData({ agents: { blank: { name: 'blank', nickname: null, skills: [] } } });
        const report = mod.buildReport(data);
        expect(report).toContain('| `blank` | — | _(none)_ | 0 (low data) |');
    });
});

// ── main() CLI integration ───────────────────────────────────────────────────

describe('main()', () => {
    let writeSpy;

    beforeEach(() => {
        writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        writeSpy.mockRestore();
    });

    function seedFixture() {
        tmp.write('.claude/agents/architect.md', [
            '---', 'name: architect', 'nickname: Archie',
            'skills:', '  - architecture', '  - project-planning',
            '---', '', 'Body.', '',
        ].join('\n'));
        tmp.write('.claude/agents/qa-engineer.md', [
            '---', 'name: qa-engineer', 'skills:', '  - qa-engineer', '---', '', 'Body.', '',
        ].join('\n'));

        tmp.write('.claude/skills/architecture/SKILL.md', '# Architecture');
        tmp.write('.claude/skills/architecture/references/adr-template.md', '# ADR');
        tmp.write('.claude/skills/project-planning/SKILL.md', '# Planning');
        tmp.write('.claude/skills/qa-engineer/SKILL.md', '# QA');
        tmp.write('.claude/skills/orphan-skill/SKILL.md', '# Orphan');

        writeJsonl(SKILL_JSONL, [
            { type: 'agent_dispatch', agent: 'architect', skills: ['architecture', 'project-planning'] },
            { type: 'skill_read', skill: 'architecture', file: 'references/adr-template.md' },
            { type: 'skill_read', skill: 'architecture', file: 'references/adr-template.md' },
        ]);
        writeJsonl(CMD_JSONL, [
            { type: 'command_invocation', command: 'do' },
            { type: 'gate_run', command: 'gate:test', outcome: 'success' },
            { type: 'gate_run', command: 'gate:test', outcome: 'failure' },
        ]);
    }

    it('jsonFlag_printsSingleJsonPayload_withExpectedClassificationShape', () => {
        seedFixture();
        const mod = loadModule(['--json']);
        mod.main();

        expect(writeSpy).toHaveBeenCalledTimes(1);
        const data = JSON.parse(writeSpy.mock.calls[0][0]);

        expect(Object.keys(data.skills).sort()).toEqual(['architecture', 'orphan-skill', 'project-planning', 'qa-engineer']);
        expect(Object.keys(data.agents).sort()).toEqual(['architect', 'qa-engineer']);
        expect(data.classifiedSkills.find(s => s.name === 'architecture').status).toBe('ACTIVE');
        expect(data.classifiedSkills.find(s => s.name === 'project-planning').status).toBe('CONFIGURED');
        expect(data.classifiedSkills.find(s => s.name === 'qa-engineer').status).toBe('CONFIGURED');
        expect(data.classifiedSkills.find(s => s.name === 'orphan-skill').status).toBe('ORPHANED');
        expect(data.telemetry.events).toBe(3);
        expect(data.commands.commandFreq.do).toBe(1);
        expect(data.commands.gateStats['gate:test']).toEqual({ pass: 1, fail: 1 });
        expect(typeof data.generatedAt).toBe('string');
    });

    it('defaultInvocation_printsMarkdownReportToStdoutOnly', () => {
        seedFixture();
        const mod = loadModule();
        mod.main();

        expect(writeSpy).toHaveBeenCalledTimes(1);
        const printed = writeSpy.mock.calls[0][0];
        expect(printed).toContain('# .claude Skill & Agent Analytics');
        expect(printed).toContain('`orphan-skill`');

        const outPath = path.join(tmp.root, 'docs/.output/.state/telemetry/_skill-analytics.md');
        expect(fs.existsSync(outPath)).toBe(false); // --output not passed, nothing written to disk
    });

    it('outputFlag_writesReportFileToDiskInAdditionToStdout', () => {
        seedFixture();
        const mod = loadModule(['--output']);
        mod.main();

        const outPath = path.join(tmp.root, 'docs/.output/.state/telemetry/_skill-analytics.md');
        expect(fs.existsSync(outPath)).toBe(true);
        const written = fs.readFileSync(outPath, 'utf8');
        expect(written).toContain('# .claude Skill & Agent Analytics');
        expect(writeSpy).toHaveBeenCalledTimes(1); // stdout still gets the report too
    });

    it('emptyProject_producesReportWithoutThrowing', () => {
        const mod = loadModule();
        expect(() => mod.main()).not.toThrow();
        const printed = writeSpy.mock.calls[0][0];
        expect(printed).toContain('| Skills on disk | 0 |');
        expect(printed).toContain('| Agents configured | 0 |');
    });
});
