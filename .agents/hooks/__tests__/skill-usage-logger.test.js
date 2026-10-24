// Tests for skill-usage-logger.cjs — dual-trigger skill telemetry (PostToolUse
// Read + Agent). Logger never blocks; we test the pure parse/resolve helpers and
// processEvent routing (without asserting file writes).

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { processEvent, parseSkillPath, resolveAgentSkills } = require('../../../.agents/hooks/skill-usage-logger.cjs');

describe('parseSkillPath', () => {
  it('extracts skill + file from a .claude/skills path', () => {
    expect(parseSkillPath('/repo/.claude/skills/dev-process/SKILL.md')).toEqual({
      skill: 'dev-process',
      file: 'SKILL.md',
    });
  });

  it('extracts nested references files', () => {
    expect(parseSkillPath('/repo/.claude/skills/example-skill/references/guide.md')).toEqual({
      skill: 'example-skill',
      file: 'references/guide.md',
    });
  });

  it('normalizes Windows separators', () => {
    expect(parseSkillPath('C:\\repo\\.claude\\skills\\code-review\\SKILL.md')).toEqual({
      skill: 'code-review',
      file: 'SKILL.md',
    });
  });

  it('returns null for non-skill paths and bad input', () => {
    expect(parseSkillPath('/repo/.claude/agents/architect.md')).toBeNull();
    expect(parseSkillPath('/repo/src/index.js')).toBeNull();
    expect(parseSkillPath(null)).toBeNull();
    expect(parseSkillPath(42)).toBeNull();
  });
});

describe('resolveAgentSkills', () => {
  it('reads the skills: frontmatter list from a real agent file', () => {
    // general-purpose ships a non-empty skills: list in this repo.
    const skills = resolveAgentSkills('general-purpose', process.cwd());
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThan(0);
  });

  it('returns [] for unknown agents and bad input', () => {
    expect(resolveAgentSkills('no-such-agent', process.cwd())).toEqual([]);
    expect(resolveAgentSkills(null, process.cwd())).toEqual([]);
    expect(resolveAgentSkills('', process.cwd())).toEqual([]);
  });
});

describe('processEvent — subagent dispatch (the S-PI.4 producer)', () => {
  let sandbox;
  let prevProjectDir;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-usage-'));
    // Seed a minimal agent definition so resolveAgentSkills finds a skills: list.
    const agentsDir = path.join(sandbox, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'general-purpose.md'),
      '---\nname: general-purpose\nskills:\n  - full-output-enforcement\n  - systematic-debugging\n---\n\nBody.\n',
    );
    prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = sandbox;
  });

  afterEach(() => {
    if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function readRows() {
    const jsonl = path.join(sandbox, 'docs', '.output', '.state', 'telemetry', 'skill-usage.jsonl');
    if (!fs.existsSync(jsonl)) return [];
    return fs.readFileSync(jsonl, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it('emits an agent_dispatch event for a Task-named tool payload', () => {
    const event = processEvent({
      tool_name: 'Task',
      tool_input: { subagent_type: 'general-purpose', description: 'x' },
    });
    expect(event).not.toBeNull();
    expect(event.type).toBe('agent_dispatch');
    expect(event.agent).toBe('general-purpose');
    expect(event.description).toBe('x');
    expect(Array.isArray(event.skills)).toBe(true);
    expect(event.skills.length).toBeGreaterThan(0);
  });

  it('appends the agent_dispatch row to skill-usage.jsonl on a Task dispatch', () => {
    processEvent({
      tool_name: 'Task',
      tool_input: { subagent_type: 'general-purpose', description: 'do work' },
    });
    const rows = readRows();
    const dispatches = rows.filter((r) => r.type === 'agent_dispatch');
    expect(dispatches.length).toBe(1);
    expect(dispatches[0].agent).toBe('general-purpose');
    // feedback-digest readSkillUsage() keys on exactly these fields.
    expect(dispatches[0]).toHaveProperty('timestamp');
    expect(dispatches[0]).toHaveProperty('skills');
  });

  it('still emits for the legacy Agent tool name', () => {
    const event = processEvent({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'general-purpose' },
    });
    expect(event).not.toBeNull();
    expect(event.type).toBe('agent_dispatch');
    expect(event.agent).toBe('general-purpose');
  });
});
