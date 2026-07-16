// CR-1.1 integration coverage — proves the real merge/copy WRITE SITES are routed
// through the symlink-safe primitive, not just that fs-safe exists in isolation.
// The vulnerability is fleet:sync / scaffold overwriting a symlink's target at a
// well-known template path; these tests exercise that exact path end-to-end:
//   - mergeSkillFile  (skill-merger, safeWrite) — symlinked dest not followed
//   - mergeAgentFile  (agent-merger, safeWrite) — symlinked dest not followed
//   - copyWithZoneEnforcement 'template' (zone-copy, safeCopy) — same guard
//   - walkDir traverses a symlinked skill DIR so its SKILL.md is seen by a sync
//
// C2 remediation (2026-07-15): the leaf-only guard did NOT close arbitrary overwrite —
// a symlinked ANCESTOR dir (adopter .claude/skills -> /external) still escaped. These
// tests prove the containRoot ancestor guard refuses that, wired through the real
// merge/copy sites (mergeSkillFile/mergeAgentFile/copyWithZoneEnforcement).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);

const { safeWrite, safeCopy } = require('../fs-safe');
const { mergeSkillFile } = require('../skill-merger');
const { mergeAgentFile } = require('../agent-merger');
const { copyWithZoneEnforcement } = require('../zone-copy');
const { walkDir } = require('../file-walker');

// Symlink-capability probe (Windows without Developer Mode can't symlink).
const canSymlink = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'symlink-int-probe-'));
  try {
    fs.writeFileSync(path.join(d, 't'), 'x');
    fs.symlinkSync(path.join(d, 't'), path.join(d, 'l'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
})();

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'symlink-safe-int-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!canSymlink)('symlink-safe write sites (CR-1.1)', () => {
  it('mergeSkillFile does not follow a symlinked destination (fresh-install path)', () => {
    const src = path.join(root, 'SKILL.src.md');
    const victim = path.join(root, 'victim.md');
    const dst = path.join(root, 'SKILL.md'); // pre-placed as a symlink → victim
    fs.writeFileSync(src, '# Template skill\n');
    fs.writeFileSync(victim, 'VICTIM-CONTENT');
    fs.symlinkSync(victim, dst);

    // dst "exists" (symlink resolves), so this hits the merge path, not fresh-install.
    mergeSkillFile(src, dst);

    expect(fs.readFileSync(victim, 'utf8')).toBe('VICTIM-CONTENT');
    expect(fs.lstatSync(dst).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(dst, 'utf8')).toContain('Template skill');
  });

  it('mergeSkillFile fresh-install branch does not write through a dangling symlink', () => {
    // A DANGLING symlink (target absent) makes fs.existsSync(dst) false → the
    // fresh-install branch fires. Without the safeWrite guard, writeFileSync on a
    // dangling link would CREATE the file at the link's target (arbitrary-path write).
    const src = path.join(root, 'SKILL.src.md');
    const wouldBeTarget = path.join(root, 'attacker-target.md');
    const dst = path.join(root, 'FRESH.md');
    fs.writeFileSync(src, '# Fresh skill\n');
    fs.symlinkSync(wouldBeTarget, dst); // target does not exist → dangling
    expect(fs.existsSync(wouldBeTarget)).toBe(false);

    mergeSkillFile(src, dst);

    // The link's target was NOT created; the real file landed at dst instead.
    expect(fs.existsSync(wouldBeTarget)).toBe(false);
    expect(fs.lstatSync(dst).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(dst, 'utf8')).toContain('Fresh skill');
  });

  it('mergeAgentFile does not follow a symlinked destination', () => {
    const src = path.join(root, 'agent.src.md');
    const victim = path.join(root, 'victim.md');
    const dst = path.join(root, 'agent.md');
    fs.writeFileSync(src, '---\nname: x\n---\n\n# Agent\n\n## Skills\n\n- a\n');
    fs.writeFileSync(victim, 'VICTIM-CONTENT');
    fs.symlinkSync(victim, dst);

    mergeAgentFile(src, dst);

    expect(fs.readFileSync(victim, 'utf8')).toBe('VICTIM-CONTENT');
    expect(fs.lstatSync(dst).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(dst, 'utf8')).toContain('name: x');
  });

  it('copyWithZoneEnforcement (template) does not follow a symlinked destination', () => {
    const src = path.join(root, 'src.txt');
    const victim = path.join(root, 'victim.txt');
    const dst = path.join(root, 'dst.txt');
    fs.writeFileSync(src, 'TEMPLATE-BYTES');
    fs.writeFileSync(victim, 'VICTIM-CONTENT');
    fs.symlinkSync(victim, dst);

    const res = copyWithZoneEnforcement(src, dst, 'template');

    expect(res.action).toBe('copy');
    expect(fs.readFileSync(victim, 'utf8')).toBe('VICTIM-CONTENT');
    expect(fs.lstatSync(dst).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(dst, 'utf8')).toBe('TEMPLATE-BYTES');
  });

  it('walkDir sees a symlinked skill DIR so its files sync (the stripped-bespoke-skill bug)', () => {
    const bespoke = path.join(root, 'bespoke-skill');
    fs.mkdirSync(bespoke);
    fs.writeFileSync(path.join(bespoke, 'SKILL.md'), 'bespoke');
    const skills = path.join(root, 'skills');
    fs.mkdirSync(skills);
    fs.symlinkSync(bespoke, path.join(skills, 'my-skill'), 'dir');

    const found = [...walkDir(skills, [])];

    expect(found.some(p => p.endsWith(path.join('my-skill', 'SKILL.md')))).toBe(true);
  });
});

describe.skipIf(!canSymlink)('C2: symlinked-ANCESTOR guard (containRoot)', () => {
  // Reviewer repro: tree/skills -> /external (symlinked parent dir); a write to
  // tree/skills/victim.md leaf (not itself a symlink) escaped and clobbered
  // /external/victim.md. The leaf guard alone did NOT stop this.
  function ancestorEscapeFixture() {
    const external = path.join(root, 'external');
    fs.mkdirSync(external);
    const victim = path.join(external, 'victim.md');
    fs.writeFileSync(victim, 'ORIGINAL-VICTIM');
    const tree = path.join(root, 'tree');
    fs.mkdirSync(tree);
    fs.symlinkSync(external, path.join(tree, 'skills'), 'dir'); // symlinked PARENT
    const dst = path.join(tree, 'skills', 'victim.md');         // leaf is a normal name
    return { external, victim, tree, dst };
  }

  it('safeWrite REFUSES a write through a symlinked ancestor; external target untouched', () => {
    const { victim, tree, dst } = ancestorEscapeFixture();

    expect(() => safeWrite(dst, 'CLOBBERED-VIA-PARENT-SYMLINK', undefined, tree))
      .toThrow(/symlinked ancestor/i);
    expect(fs.readFileSync(victim, 'utf8')).toBe('ORIGINAL-VICTIM');
  });

  it('safeCopy REFUSES a copy through a symlinked ancestor; external target untouched', () => {
    const { victim, tree, dst } = ancestorEscapeFixture();
    const src = path.join(root, 'src.txt');
    fs.writeFileSync(src, 'TEMPLATE-BYTES');

    expect(() => safeCopy(src, dst, tree)).toThrow(/symlinked ancestor/i);
    expect(fs.readFileSync(victim, 'utf8')).toBe('ORIGINAL-VICTIM');
  });

  it('without containRoot the ancestor guard is off (backward compatible) — leaf still guarded', () => {
    // A plain (no-containRoot) safeWrite to a NON-symlinked path just writes.
    const dst = path.join(root, 'plain.txt');
    const res = safeWrite(dst, 'hello');
    expect(fs.readFileSync(dst, 'utf8')).toBe('hello');
    expect(res.symlinkReplaced).toBe(false);
  });

  it('mergeSkillFile with containRoot refuses a symlinked-ancestor destination', () => {
    const { victim, tree, dst } = ancestorEscapeFixture();
    const src = path.join(root, 'SKILL.src.md');
    fs.writeFileSync(src, '# skill\n');

    // dst resolves (through the symlink) to an existing file → merge path; the
    // ancestor guard fires inside safeWrite before any bytes are written.
    expect(() => mergeSkillFile(src, dst, tree)).toThrow(/symlinked ancestor/i);
    expect(fs.readFileSync(victim, 'utf8')).toBe('ORIGINAL-VICTIM');
  });

  it('mergeAgentFile with containRoot refuses a symlinked-ancestor destination', () => {
    const { victim, tree, dst } = ancestorEscapeFixture();
    const src = path.join(root, 'agent.src.md');
    fs.writeFileSync(src, '---\nname: x\n---\n\n# Agent\n\n## Skills\n\n- a\n');

    expect(() => mergeAgentFile(src, dst, { containRoot: tree })).toThrow(/symlinked ancestor/i);
    expect(fs.readFileSync(victim, 'utf8')).toBe('ORIGINAL-VICTIM');
  });

  it('copyWithZoneEnforcement (template) with containRoot refuses a symlinked-ancestor destination', () => {
    const { victim, tree, dst } = ancestorEscapeFixture();
    const src = path.join(root, 'src.txt');
    fs.writeFileSync(src, 'TEMPLATE-BYTES');

    expect(() => copyWithZoneEnforcement(src, dst, 'template', { containRoot: tree }))
      .toThrow(/symlinked ancestor/i);
    expect(fs.readFileSync(victim, 'utf8')).toBe('ORIGINAL-VICTIM');
  });

  it('a legitimate deep write WITHIN containRoot still succeeds (no false positive)', () => {
    const proj = path.join(root, 'proj');
    const deep = path.join(proj, '.claude', 'skills', 'x');
    fs.mkdirSync(deep, { recursive: true });
    const dst = path.join(deep, 'SKILL.md');
    const res = safeWrite(dst, 'body', undefined, proj);
    expect(fs.readFileSync(dst, 'utf8')).toBe('body');
    expect(res.symlinkReplaced).toBe(false);
  });
});
