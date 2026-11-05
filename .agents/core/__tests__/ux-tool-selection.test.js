import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { loadModelAdapter, renderSharedAgents } = require('../_lib/shared-agents');
const { mergeAgentContent, parseAgentSections } = require('../_lib/agent-merger');
const { mergeSkillContent } = require('../_lib/skill-merger');
const { createTmpDir } = require('./_helpers/tmp-dir');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const role = () => read('.agents/roles/ux-designer.md');
const oldSoul = read('.agents/core/__tests__/_helpers/ux-soul-v6.4.md');
const oldRole = (soul = oldSoul) => `---\nname: ux-designer\nnickname: Trixie\ndescription: Project UX designer\nskills:\n  - ux-design\n---\n${soul}\n## Skills\nOld shared rules.\n\n## Project Context\nKeep our native desktop stack.\n`;

describe('UX tool selection runtime and update boundaries', () => {
  it('inherits available tools in the workshop while retaining native permission policy', () => {
    const effective = loadModelAdapter(root, 'claude');
    expect(effective.roles['ux-designer'].tools).toBeUndefined();
    expect(effective.roles['ux-designer'].permissionMode).toBeUndefined();
  });

  it('renders fresh UX roles with inherited tools and preserves a project restriction', () => {
    const tmp = createTmpDir();
    try {
      const put = (rel, content) => {
        const file = path.join(tmp.root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      };
      put('.agents/roles/ux-designer.md', role());
      for (const runtime of ['claude', 'codex']) {
        for (const file of ['shared-agents.json', 'model-tiers.json']) {
          put(`.agents/adapters/${runtime}/${file}`, read(`.agents/adapters/${runtime}/${file}`));
        }
      }
      renderSharedAgents(tmp.root);
      const native = () => fs.readFileSync(path.join(tmp.root, '.claude/agents/ux-designer.md'), 'utf8');
      expect(native()).not.toMatch(/^tools:/m);
      put('.claude/shared-agents.json', JSON.stringify({ roles: { 'ux-designer': { tools: 'Read, Grep', model: 'project-model' } } }));
      renderSharedAgents(tmp.root);
      expect(native()).toContain('tools: "Read, Grep"');
      expect(native()).toContain('model: "project-model"');
      const codex = fs.readFileSync(path.join(tmp.root, '.codex/agents/ux-designer.toml'), 'utf8');
      expect(codex).not.toMatch(/^tools\s*=/m);
      expect(codex).not.toContain("You don't have Bash");
    } finally { tmp.cleanup(); }
  });

  it('refreshes the pristine retired UX persona and retains its Project Context', () => {
    const merged = parseAgentSections(mergeAgentContent(role(), oldRole()).content);
    expect(merged.soulZone).toBe(parseAgentSections(role()).soulZone);
    expect(merged.soulZone).not.toContain('I sketch layout fast with ASCII');
    expect(merged.projectCtx).toContain('Keep our native desktop stack.');
  });

  it('keeps a genuinely customized persona while refreshing shared routing', () => {
    const customized = oldSoul + '\nOur product supports pen input first.\n';
    const merged = parseAgentSections(mergeAgentContent(role(), oldRole(customized)).content);
    expect(merged.soulZone.trim()).toBe(customized.trim());
    expect(merged.skillsZone).toBe(parseAgentSections(role()).skillsZone);
    expect(merged.projectCtx).toContain('Keep our native desktop stack.');
  });

  it('keeps project-owned design skill additions during a shared guidance refresh', () => {
    const additions = '\n<!-- @@project-additions -->\n## Product input\nSupport stylus input and our approved brand palette.\n';
    const old = '---\nname: ux-design\n---\n# UX Design\nOld requirements.\n' + additions;
    const updated = read('.agents/skills/ux-design/SKILL.md');
    const result = mergeSkillContent(updated, old);
    expect(result.content).toContain(additions.trim());
    expect(result.content).not.toContain('Old requirements.');
    expect(result.content).toContain(updated.trim());
  });
});
