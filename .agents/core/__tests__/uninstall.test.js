import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let tmp, target, source, ledger;
const api = () => {
  const real = require('../uninstall');
  return {
    planUninstall: t => real.planUninstall(t, { source }),
    runUninstall: opts => real.runUninstall({ ...opts, source }),
  };
};
function put(rel, body = 'managed\n', recorded = true) {
  tmp.write(`target/${rel}`, body);
  if (recorded) { ledger[rel] = hash(body); tmp.write(`source/${rel}`, body); }
  return path.join(target, rel);
}
function save() { tmp.write('target/.agents/render-state.json', JSON.stringify(ledger)); }
function snapshot(root = target) {
  const entries = {};
  function walk(dir, base = '') {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base + ent.name;
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) entries[rel] = `link:${fs.readlinkSync(abs)}`;
      else if (ent.isDirectory()) { entries[rel + '/'] = 'directory'; walk(abs, rel + '/'); }
      else entries[rel] = hash(fs.readFileSync(abs));
    }
  }
  walk(root);
  return entries;
}
function cli(args, runtime = 'codex') {
  return spawnSync(process.execPath, [path.join(repo, `.${runtime}/core/uninstall.js`), ...args],
    { encoding: 'utf8', windowsHide: true });
}
beforeEach(() => {
  tmp = createTmpDir({ prefix: 'uninstall-test-' });
  target = tmp.mkdir('target');
  source = tmp.mkdir('source');
  tmp.write('source/.agents/core/source.js', 'trusted toolkit fixture\n');
  ledger = {};
});
afterEach(() => { vi.restoreAllMocks(); tmp.cleanup(); });

describe('uninstall AC1: digest and ownership inventory', () => {
  it('lists only unchanged template files as removable and never writes during preview', () => {
    put('.agents/core/a.js');
    put('.codex/core/a.js');
    put('.claude/hooks/a.cjs');
    put('.agents/core/edited.js');
    tmp.write('target/.agents/core/edited.js', 'adopter edit');
    put('.agents/core/custom.js', 'custom', false);
    save();
    const before = snapshot();

    const plan = api().planUninstall(target);

    expect(plan.removable.map(x => x.path)).toEqual(['.agents/core/a.js', '.claude/hooks/a.cjs', '.codex/core/a.js']);
    expect(plan.kept).toEqual(expect.arrayContaining([
      { path: '.agents/core/edited.js', reason: 'edited' },
      { path: '.agents/core/custom.js', reason: 'unrecorded' },
      { path: '.agents/render-state.json', reason: 'project-owned' },
    ]));
    expect(api().runUninstall({ target }).dryRun).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it.each(['AGENTS.md', 'CLAUDE.md', '.gitignore', 'docs/product/brief.md',
    '.agents/intake/identity.json', '.agents/learning-intake/identity.json', '.agents/gate.config.json',
    '.agents/config/distribution-policy.json', '.agents/config/custom.local.json',
    '.agents/roles/dev.md', '.claude/agents/dev.md', '.codex/agents/dev.toml',
    '.claude/settings.json', '.claude/settings.local.json', '.claude/update-config.json',
    '.claude/shared-agents.json', '.codex/shared-agents.json', '.codex/config.toml',
    '.codex/hooks.json', '.claude/guardrail-rules.project.yaml',
    '.agents/skills/brand-guidelines/SKILL.md', '.claude/skills/brand-guidelines/SKILL.md'])
  ('keeps project or mixed ownership despite matching ledger: %s', rel => {
    put(rel); save();
    const plan = api().planUninstall(target);
    expect(plan.removable).toEqual([]);
    expect(plan.kept).toContainEqual({ path: rel, reason: 'project-owned' });
  });

  it('keeps matching merged project additions and unrecorded custom skills', () => {
    put('.claude/skills/example/SKILL.md', '# Skill\n<!-- @@project-additions -->\nMy notes\n');
    put('.agents/skills/custom/SKILL.md', 'own skill', false);
    save();
    const plan = api().planUninstall(target);
    expect(plan.removable).toEqual([]);
    expect(plan.kept).toContainEqual({ path: '.claude/skills/example/SKILL.md', reason: 'project-additions' });
    expect(plan.kept).toContainEqual({ path: '.agents/skills/custom/SKILL.md', reason: 'unrecorded' });
  });

  it('matches normalized native text, raw canonical bytes and binary without changing the ledger', () => {
    tmp.write('source/.agents/core/wrapped.js', 'module.exports = 42;\n');
    require('../_lib/shared-agents').renderSharedAgents(source);
    const wrapper = tmp.read('source/.codex/core/wrapped.js');
    put('.codex/core/wrapped.js', wrapper.replace(/\n/g, '\r\n'), false);
    ledger['.codex/core/wrapped.js'] = hash(wrapper);
    put('.agents/core/text.js', 'raw\r\n');
    put('.claude/templates/image.bin', Buffer.from([0xff, 0x0d, 0x0a, 0x00]));
    save();
    expect(api().planUninstall(target).removable).toHaveLength(3);
  });

  it('keeps an adopter helper even after a normal render records its digest', () => {
    put('.agents/core/example.js');
    put('.agents/hooks/project.cjs', 'project-authored\n', false);
    save();
    require('../_lib/shared-agents').renderSharedAgents(target);
    const plan = api().planUninstall(target);
    expect(plan.removable.map(x => x.path)).toEqual(['.agents/core/example.js']);
    expect(plan.kept).toContainEqual({ path: '.agents/hooks/project.cjs', reason: 'not-shipped' });
    expect(plan.kept).toContainEqual({ path: '.codex/hooks/project.cjs', reason: 'not-shipped' });
  });

  it('keeps re-recorded custom bytes at a shipped helper path', () => {
    // The path is unrecorded when the adopter's bytes arrive, so a render records those bytes
    // in the ledger. The recorded digest then matches the target, but not the shipped source.
    tmp.write('source/.agents/core/example.js', 'managed\n');
    tmp.write('target/.agents/core/example.js', 'adopter rewrite\n');
    save();
    require('../_lib/shared-agents').renderSharedAgents(target);
    expect(api().planUninstall(target).removable).toEqual([]);
    expect(api().planUninstall(target).kept).toContainEqual({ path: '.agents/core/example.js', reason: 'different-source' });
  });

  it('keeps a locally edited shipped helper after a render', () => {
    // Domdhi keeps a local edit detectable after a render: the ledger is not re-recorded over it.
    put('.agents/core/example.js');
    tmp.write('target/.agents/core/example.js', 'adopter rewrite\n');
    save();
    require('../_lib/shared-agents').renderSharedAgents(target);
    expect(api().planUninstall(target).removable).toEqual([]);
    expect(api().planUninstall(target).kept).toContainEqual({ path: '.agents/core/example.js', reason: 'edited' });
  });

  it('does not match changed invalid UTF-8 binary via replacement characters', () => {
    put('.claude/templates/example.bin', Buffer.from([0xef, 0xbf, 0xbd, 0, 10]));
    tmp.write('target/.claude/templates/example.bin', Buffer.from([0xff, 0, 10]));
    save();
    const plan = api().planUninstall(target);
    expect(plan.removable).toEqual([]);
    expect(plan.kept).toContainEqual({ path: '.claude/templates/example.bin', reason: 'edited' });
  });

  it('keeps a changed valid UTF-8 binary asset with CRLF differences', () => {
    put('.claude/templates/example.bin', Buffer.from([0, 10]));
    tmp.write('target/.claude/templates/example.bin', Buffer.from([0, 13, 10]));
    save();
    expect(api().planUninstall(target).kept).toContainEqual({ path: '.claude/templates/example.bin', reason: 'edited' });
  });

  it('keeps raw printable template text whose CRLF changes after approval', () => {
    put('.claude/templates/example.txt', 'raw text\n'); save();
    const plan = api().planUninstall(target);
    tmp.write('target/.claude/templates/example.txt', 'raw text\r\n');
    const before = snapshot();
    expect(api().runUninstall({ target, dryRun: false, approvedPlan: plan })).toMatchObject({ ok: false, removed: [] });
    expect(snapshot()).toEqual(before);
    expect(api().planUninstall(target).kept).toContainEqual({ path: '.claude/templates/example.txt', reason: 'edited' });
  });

  it.each([
    [[0xef, 0xbf, 0xbd, 0, 10], [0xff, 0, 10]],
    [[0, 10], [0, 13, 10]],
  ])('refuses post-approval binary modification %# without deleting any candidate', (original, changed) => {
    put('.agents/core/a.js');
    put('.claude/templates/example.bin', Buffer.from(original)); save();
    const plan = api().planUninstall(target);
    tmp.write('target/.claude/templates/example.bin', Buffer.from(changed));
    const before = snapshot();
    expect(api().runUninstall({ target, dryRun: false, approvedPlan: plan })).toMatchObject({ ok: false, removed: [] });
    expect(snapshot()).toEqual(before);
  });

  it('does not treat marker examples in source or fenced Markdown as personal additions', () => {
    put('.agents/core/example.js', "const marker = '@@project-additions';\n");
    put('.claude/skills/example/SKILL.md', '# Example\n```md\n<!-- @@project-additions -->\n```\n');
    save();
    expect(api().planUninstall(target).removable).toHaveLength(2);
  });

  it('classifies an actual installer-generated ledger and preserves adopter instructions', () => {
    const source = tmp.mkdir('source');
    tmp.mkdir('source/.claude');
    tmp.write('source/.agents/core/example.js', 'module.exports = 42;\n');
    tmp.write('source/.agents/config/version.json', '{"version":"0.9"}');
    require('../_lib/shared-agents').renderSharedAgents(source);
    put('AGENTS.md', 'My project instructions', false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const installed = require('../install').runInstall({ source, target });
    log.mockRestore(); warn.mockRestore();
    expect(installed.ok).toBe(true);
    const plan = api().planUninstall(target);
    expect(plan.removable.map(x => x.path)).toContain('.agents/core/example.js');
    expect(plan.removable.map(x => x.path)).toContain('.codex/core/example.js');
    const before = snapshot();
    const live = api().runUninstall({ target, dryRun: false, approvedPlan: plan });
    expect(live.ok).toBe(true);
    expect(live.removed).toEqual(plan.removable.map(x => x.path));
    const expected = { ...before };
    for (const rel of live.removed) delete expected[rel];
    expect(snapshot()).toEqual(expected);
    expect(tmp.read('target/AGENTS.md')).toBe('My project instructions');
  });
});

describe('uninstall AC2: exact approval and write-free refusals', () => {
  it('requires a reviewed plan for live removal', () => {
    put('.agents/core/a.js'); save();
    const before = snapshot();
    expect(api().runUninstall({ target, dryRun: false })).toMatchObject({ ok: false, removed: [] });
    expect(snapshot()).toEqual(before);
  });

  it('refuses a source within the target and binds source contents to approval', () => {
    put('.agents/core/a.js'); save();
    expect(require('../uninstall').runUninstall({ target, source: target }).ok).toBe(false);
    const plan = api().planUninstall(target);
    tmp.write('source/.agents/core/a.js', 'changed source');
    const before = snapshot();
    expect(api().runUninstall({ target, dryRun: false, approvedPlan: plan })).toMatchObject({ ok: false, removed: [] });
    expect(snapshot()).toEqual(before);
  });

  it.each(['edit', 'new candidate', 'ledger', 'wrong target', 'tampered approval'])
  ('refuses a changed review (%s) before deleting anything', change => {
    put('.agents/core/a.js'); put('.agents/core/b.js'); save();
    const plan = api().planUninstall(target);
    if (change === 'edit') tmp.write('target/.agents/core/b.js', 'changed');
    if (change === 'new candidate') { put('.agents/core/c.js'); save(); }
    if (change === 'ledger') tmp.write('target/.agents/render-state.json', JSON.stringify(ledger, null, 2));
    if (change === 'wrong target') plan.target = tmp.root;
    if (change === 'tampered approval') plan.removable = [];
    const before = snapshot();

    expect(api().runUninstall({ target, dryRun: false, approvedPlan: plan })).toMatchObject({ ok: false, removed: [] });
    expect(snapshot()).toEqual(before);
  });

  it.each(['../escape', '/absolute', 'C:/outside', '.agents/../victim', '.agents\\core\\a.js',
    '.agents/core/a.js:stream', '.agents/core/trailing.', '.agents/core/CON', '.agents/core/a\u0000b'])
  ('refuses unsafe ledger key %s without writes', rel => {
    put('.agents/core/a.js'); ledger[rel] = hash('x'); save();
    const before = snapshot();
    expect(api().runUninstall({ target })).toMatchObject({ ok: false, removed: [] });
    expect(snapshot()).toEqual(before);
  });

  it.each(['null', '[]', '{".agents/core/a.js":false}', '{".agents/core/a.js":"bad"}', '{broken'])
  ('refuses malformed ledger %s', raw => {
    put('.agents/core/a.js'); tmp.write('target/.agents/render-state.json', raw);
    const before = snapshot();
    expect(api().runUninstall({ target })).toMatchObject({ ok: false, removed: [] });
    expect(snapshot()).toEqual(before);
  });

  it('refuses missing ledger and thrown read errors without writes', () => {
    expect(api().runUninstall({ target }).ok).toBe(false);
    put('.agents/core/a.js'); save();
    const before = snapshot();
    const realOpen = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      if (String(file).endsWith('a.js')) throw new Error('read failed');
      return realOpen(file, ...args);
    });
    expect(api().runUninstall({ target })).toMatchObject({ ok: false, removed: [] });
    spy.mockRestore();
    expect(snapshot()).toEqual(before);
  });
});

describe('uninstall AC3: apply, repeat and filesystem boundaries', () => {
  it('removes exactly previewed files, retains directories/ledger/edits, and repeats as a no-op', () => {
    put('.agents/core/a.js'); put('.codex/core/a.js');
    put('.claude/settings.json'); put('.agents/core/edited.js');
    tmp.write('target/.agents/core/edited.js', 'keep edit');
    put('.agents/core/own.js', 'keep custom', false); save();
    const plan = api().planUninstall(target);
    const before = snapshot();

    const live = api().runUninstall({ target, dryRun: false, approvedPlan: plan });

    expect(live.ok).toBe(true);
    expect(live.removed).toEqual(plan.removable.map(x => x.path));
    const expected = { ...before };
    for (const rel of live.removed) delete expected[rel];
    expect(snapshot()).toEqual(expected);
    expect(api().runUninstall({ target, dryRun: false, approvedPlan: plan })).toMatchObject({ ok: true, removed: [] });
    expect(api().planUninstall(target).removable).toEqual([]);
    expect(snapshot()).toEqual(expected);
  });

  it('keeps hardlinked files even when their digest matches', () => {
    const file = put('.agents/core/a.js');
    fs.linkSync(file, path.join(tmp.root, 'hardlink')); save();
    expect(api().planUninstall(target).kept).toContainEqual({ path: '.agents/core/a.js', reason: 'hardlink' });
  });

  it('reports an absent recorded file and a directory instead of deleting either', () => {
    ledger['.agents/core/missing.js'] = hash('x');
    ledger['.agents/core/directory'] = hash('x'); tmp.mkdir('target/.agents/core/directory'); save();
    const plan = api().planUninstall(target);
    expect(plan.kept).toContainEqual({ path: '.agents/core/missing.js', reason: 'missing' });
    expect(plan.kept).toContainEqual({ path: '.agents/core/directory', reason: 'not-file' });
    expect(plan.removable).toEqual([]);
  });

  it('keeps linked leaves and directories and refuses a linked target or ledger', ctx => {
    put('.agents/core/a.js'); save();
    const outside = tmp.mkdir('outside'); tmp.write('outside/victim.js', 'victim');
    try {
      fs.symlinkSync(outside, path.join(target, '.codex'), 'junction');
      fs.symlinkSync(path.join(outside, 'victim.js'), path.join(target, '.agents/core/link.js'));
    } catch (err) { if (['EPERM', 'EACCES'].includes(err.code)) return ctx.skip(); throw err; }
    ledger['.codex/victim.js'] = hash('victim');
    ledger['.agents/core/link.js'] = hash('victim'); save();
    const plan = api().planUninstall(target);
    expect(plan.kept).toContainEqual({ path: '.codex/victim.js', reason: 'symlink' });
    expect(plan.kept).toContainEqual({ path: '.agents/core/link.js', reason: 'symlink' });
    const live = api().runUninstall({ target, dryRun: false, approvedPlan: plan });
    expect(live.removed).toEqual(['.agents/core/a.js']);
    expect(tmp.read('outside/victim.js')).toBe('victim');
    const linkedTarget = path.join(tmp.root, 'linked-target');
    fs.symlinkSync(target, linkedTarget, 'junction');
    expect(api().runUninstall({ target: linkedTarget }).ok).toBe(false);
    fs.unlinkSync(path.join(target, '.agents/render-state.json'));
    fs.symlinkSync(path.join(outside, 'victim.js'), path.join(target, '.agents/render-state.json'));
    expect(api().runUninstall({ target }).ok).toBe(false);
  });

  it('refuses linked trusted-source files and links introduced after approval', ctx => {
    const file = put('.agents/core/a.js'); save();
    const plan = api().planUninstall(target);
    const external = tmp.write('outside.js', 'managed\n');
    fs.unlinkSync(file);
    try { fs.symlinkSync(external, file); }
    catch (err) { if (['EPERM', 'EACCES'].includes(err.code)) return ctx.skip(); throw err; }
    const before = snapshot();
    expect(api().runUninstall({ target, dryRun: false, approvedPlan: plan })).toMatchObject({ ok: false, removed: [] });
    expect(snapshot()).toEqual(before);
    const sourceFile = path.join(source, '.agents/core/a.js');
    fs.unlinkSync(sourceFile); fs.symlinkSync(external, sourceFile);
    expect(api().runUninstall({ target }).ok).toBe(false);
    expect(tmp.read('outside.js')).toBe('managed\n');
  });

  it('reports operational delete failure honestly and returns non-success', () => {
    put('.agents/core/a.js'); save();
    const plan = api().planUninstall(target);
    vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw new Error('delete failed'); });
    expect(api().runUninstall({ target, dryRun: false, approvedPlan: plan })).toMatchObject({ ok: false, removed: [] });
  });
});

describe('native uninstall CLI contract', () => {
  it.each(['codex', 'claude'])('supports dry-run then explicit apply through %s wrapper', runtime => {
    put('.agents/core/a.js'); save();
    const preview = cli([target, '--source', source, '--dry-run'], runtime);
    expect(preview.status).toBe(0);
    const plan = JSON.parse(preview.stdout);
    expect(plan.removable.map(x => x.path)).toEqual(['.agents/core/a.js']);
    const review = tmp.write('review.json', JSON.stringify(plan));
    expect(cli([target, '--source', source, '--apply', review], runtime).status).toBe(0);
    expect(fs.existsSync(path.join(target, '.agents/core/a.js'))).toBe(false);
    const repeat = cli([target, '--source', source, '--apply', review], runtime);
    expect(repeat.status).toBe(0);
    expect(JSON.parse(repeat.stdout).removed).toEqual([]);
  });

  it.each([['--force'], ['--apply'], ['--dry-run', '--apply', 'x'], ['one', 'two']])
  ('rejects ambiguous/unknown arguments %j with nonzero exit', args => {
    const result = cli(args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('uninstall:');
  });

  it('exits nonzero for malformed approval and missing ledger', () => {
    const review = tmp.write('review.json', '{bad');
    expect(cli([target, '--apply', review]).status).not.toBe(0);
    expect(cli([target]).status).not.toBe(0);
  });

  it('propagates a thrown deletion failure to nonzero CLI status with exact partial progress', () => {
    put('.agents/core/a.js'); put('.agents/core/b.js'); save();
    const review = tmp.write('review.json', JSON.stringify(api().planUninstall(target)));
    const originalRemove = fs.rmSync;
    const failure = vi.spyOn(fs, 'rmSync').mockImplementation((file, ...args) => {
      if (String(file).endsWith('b.js')) throw new Error('injected deletion failure');
      return originalRemove(file, ...args);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const priorExitCode = process.exitCode;
    try {
      expect(require('../uninstall').main([target, '--source', source, '--apply', review]).ok).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(error.mock.calls.flat().join(' ')).toContain('removed 1 files: [".agents/core/a.js"]');
    } finally { process.exitCode = priorExitCode; failure.mockRestore(); error.mockRestore(); }
    expect(fs.existsSync(path.join(target, '.agents/core/a.js'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.agents/core/b.js'))).toBe(true);
  });
});
