// AC→source: adr-lint.js — ADR registry consistency linter for the
// docs/architecture/decisions/NNNN-*.md convention. Covers the pure lint core:
// status parsing, supersedes-ref extraction, and each verdict (NO_STATUS,
// DUP_NUMBER, SUPERSEDE_STALE, BAD_FILENAME, ORPHAN_ADR), plus the impure
// fs-gathering (`gather`) and CLI wiring (`main`) layers.
//
// `main()`'s repoRoot now honors CLAUDE_PROJECT_DIR (falls back to the
// __dirname-relative repo root when unset) — a minimal source addition made
// so the CLI entry point is testable against an isolated fixture instead of
// the real repo's docs/, matching the convention already used by
// memory-health-check.js / memory-manager.js. See adr-lint.js's `main`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const { readStatus, supersedesRefs, saysSuperseded, lint, gather, looksLikeAdr, main } = require('../../../.agents/core/adr-lint');
const { createTmpDir } = require('./_helpers/tmp-dir');

const adr = (num, status, extra = '') =>
  `# ADR: thing ${num}\n\n| Field | Value |\n|-------|-------|\n| **Status** | ${status} |\n${extra}\n## Context\n...\n`;

describe('readStatus', () => {
  it('reads the canonical table row', () => {
    expect(readStatus(adr(1, 'Accepted')).value).toBe('Accepted');
    expect(readStatus(adr(1, 'Accepted')).form).toBe('table');
  });
  it('reads the legacy bullet form', () => {
    expect(readStatus('- **Status:** Proposed\n').form).toBe('bullet');
  });
  it('returns null when no Status field', () => {
    expect(readStatus('# ADR: nope\n\nbody\n').value).toBe(null);
  });
});

describe('supersedesRefs', () => {
  it('extracts ADR numbers from a Supersedes row (NNNN and ADR-NNN forms)', () => {
    expect(supersedesRefs('| **Supersedes** | 0003 and ADR-7 |')).toEqual([3, 7]);
  });
  it('returns [] for prose supersession (no numbers)', () => {
    expect(supersedesRefs('| **Supersedes** | the flat docs layout |')).toEqual([]);
  });
  it('returns [] when there is no Supersedes row', () => {
    expect(supersedesRefs(adr(1, 'Accepted'))).toEqual([]);
  });
});

describe('saysSuperseded', () => {
  it('matches superseded status text', () => {
    expect(saysSuperseded('Superseded by 0009')).toBe(true);
    expect(saysSuperseded('Accepted')).toBe(false);
    expect(saysSuperseded(null)).toBe(false);
  });
});

describe('lint', () => {
  it('passes a clean corpus', () => {
    const r = lint([
      { num: 1, name: '0001-a.md', text: adr(1, 'Accepted') },
      { num: 2, name: '0002-b.md', text: adr(2, 'Proposed') },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.warns).toEqual([]);
  });

  it('ERRORs on a missing Status field', () => {
    const r = lint([{ num: 1, name: '0001-a.md', text: '# ADR: a\n\nbody only\n' }]);
    expect(r.errors.some((e) => e.code === 'NO_STATUS')).toBe(true);
  });

  it('ERRORs on duplicate ADR numbers', () => {
    const r = lint([
      { num: 3, name: '0003-a.md', text: adr(3, 'Accepted') },
      { num: 3, name: '0003-b.md', text: adr(3, 'Accepted') },
    ]);
    expect(r.errors.some((e) => e.code === 'DUP_NUMBER')).toBe(true);
  });

  it('WARNs when a superseding record points at a target still marked Accepted', () => {
    const r = lint([
      { num: 9, name: '0009-new.md', text: adr(9, 'Accepted', '| **Supersedes** | 0003 |') },
      { num: 3, name: '0003-old.md', text: adr(3, 'Accepted') }, // should be Superseded
    ]);
    expect(r.warns.some((w) => w.code === 'SUPERSEDE_STALE')).toBe(true);
  });

  it('does NOT warn when the superseded target is correctly marked', () => {
    const r = lint([
      { num: 9, name: '0009-new.md', text: adr(9, 'Accepted', '| **Supersedes** | 0003 |') },
      { num: 3, name: '0003-old.md', text: adr(3, 'Superseded by 0009') },
    ]);
    expect(r.warns.some((w) => w.code === 'SUPERSEDE_STALE')).toBe(false);
  });

  it('WARNs on bad filenames and orphans', () => {
    const r = lint([], ['ADR-5.md'], ['docs/product/ADR-99-stray.md']);
    expect(r.warns.some((w) => w.code === 'BAD_FILENAME')).toBe(true);
    expect(r.warns.some((w) => w.code === 'ORPHAN_ADR')).toBe(true);
  });

  it('WARNs on the legacy bullet Status form (HEADER_FORMAT)', () => {
    const r = lint([
      { num: 1, name: '0001-a.md', text: '# ADR: a\n\n- **Status:** Proposed\n' },
    ]);
    expect(r.warns.some((w) => w.code === 'HEADER_FORMAT')).toBe(true);
  });

  it('does NOT warn HEADER_FORMAT for the canonical table form', () => {
    const r = lint([{ num: 1, name: '0001-a.md', text: adr(1, 'Accepted') }]);
    expect(r.warns.some((w) => w.code === 'HEADER_FORMAT')).toBe(false);
  });

  it('ignores a self-referencing Supersedes row (target === own num)', () => {
    // A record listing its own number in Supersedes must not warn about itself.
    const r = lint([
      { num: 1, name: '0001-a.md', text: adr(1, 'Accepted', '| **Supersedes** | 0001 |') },
    ]);
    expect(r.warns.some((w) => w.code === 'SUPERSEDE_STALE')).toBe(false);
  });

  it('does not check SUPERSEDE_STALE against a target not present in the corpus', () => {
    // Supersedes row names a number with no matching file — not checkable, no warn.
    const r = lint([
      { num: 9, name: '0009-new.md', text: adr(9, 'Accepted', '| **Supersedes** | 0003 |') },
    ]);
    expect(r.warns).toEqual([]);
  });
});

describe('looksLikeAdr', () => {
  const readFile = (contents) => () => contents;

  it('matches explicit ADR-NNN filenames outright (no read needed)', () => {
    expect(looksLikeAdr('ADR-42-thing.md', '/x/ADR-42-thing.md', () => { throw new Error('should not read'); })).toBe(true);
  });

  it('matches a bare NNNN-title.md only when its first heading is "# ADR"', () => {
    expect(looksLikeAdr('0007-thing.md', '/x/0007-thing.md', readFile('# ADR: thing\n\nbody'))).toBe(true);
  });

  it('rejects a bare NNNN-title.md whose first heading is not "# ADR" (research-note false positive)', () => {
    expect(looksLikeAdr('1030-research.md', '/x/1030-research.md', readFile('# Research notes\n\nquotes an ADR template later\n'))).toBe(false);
  });

  it('returns false for unrelated filenames', () => {
    expect(looksLikeAdr('README.md', '/x/README.md', readFile('anything'))).toBe(false);
  });

  it('returns false when the file cannot be read', () => {
    expect(looksLikeAdr('0007-thing.md', '/x/0007-thing.md', () => { throw new Error('ENOENT'); })).toBe(false);
  });
});

// ── gather() — impure fs-gathering, exercised against a real tmp fixture ────
describe('gather', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'adr-lint-test-' }); });
  afterEach(() => { tmp.cleanup(); });

  it('returns empty everything when docs/ does not exist', () => {
    const r = gather(tmp.root);
    expect(r).toEqual({ adrs: [], badNames: [], orphans: [] });
  });

  it('collects canonical NNNN-*.md ADRs in sorted order with parsed num/text', () => {
    tmp.write('docs/architecture/decisions/0002-b.md', adr(2, 'Accepted'));
    tmp.write('docs/architecture/decisions/0001-a.md', adr(1, 'Accepted'));
    const r = gather(tmp.root);
    expect(r.adrs.map((a) => a.name)).toEqual(['0001-a.md', '0002-b.md']);
    expect(r.adrs[0].num).toBe(1);
    expect(r.adrs[0].text).toContain('Accepted');
  });

  it('flags a non-conforming filename in decisions/ as badNames, skipping CLAUDE.md/README.md', () => {
    tmp.write('docs/architecture/decisions/CLAUDE.md', 'guide');
    tmp.write('docs/architecture/decisions/README.md', 'guide');
    tmp.write('docs/architecture/decisions/notes.md', 'stray');
    const r = gather(tmp.root);
    expect(r.badNames).toEqual(['notes.md']);
  });

  it('finds an ADR-shaped file outside decisions/ as an orphan', () => {
    tmp.write('docs/product/ADR-99-stray.md', '# ADR: stray\n\nbody');
    const r = gather(tmp.root);
    expect(r.orphans).toEqual(['docs/product/ADR-99-stray.md']);
  });

  it('does not orphan a timestamped research note that merely quotes an ADR template', () => {
    tmp.write('docs/modules/x/1030-research.md', '# Research\n\nsee an ADR template below\n');
    const r = gather(tmp.root);
    expect(r.orphans).toEqual([]);
  });

  it('skips .output, node_modules, and .git while walking for orphans', () => {
    tmp.write('docs/.output/findings/ADR-1-decoy.md', '# ADR: decoy');
    tmp.write('docs/node_modules/pkg/ADR-2-decoy.md', '# ADR: decoy');
    const r = gather(tmp.root);
    expect(r.orphans).toEqual([]);
  });

  it('does not abort the whole walk when a subdirectory is unreadable — sibling orphans still reported', () => {
    tmp.write('docs/product/ADR-99-good.md', '# ADR: good\n\nbody');
    tmp.write('docs/broken/placeholder.md', 'x');

    const brokenDir = path.join(tmp.root, 'docs', 'broken');
    const realReaddirSync = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation((dir, opts) => {
      if (dir === brokenDir) throw new Error('EACCES: permission denied');
      return realReaddirSync(dir, opts);
    });

    let r;
    try {
      r = gather(tmp.root);
    } finally {
      spy.mockRestore();
    }

    expect(r.orphans).toEqual(['docs/product/ADR-99-good.md']);
  });
});

// ── main() — CLI wiring, run in-process (mocked exit/console) so v8 coverage
// instruments the branch/error/exit paths. CLAUDE_PROJECT_DIR isolates it from
// the real repo's docs/ (see the file-header note on the source change).
describe('main (CLI wiring, in-process)', () => {
  let tmp;
  let originalEnv;

  beforeEach(() => {
    tmp = createTmpDir({ prefix: 'adr-lint-main-test-' });
    originalEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalEnv;
    tmp.cleanup();
  });

  /** Run main() with process.exit/console mocked; exit throws to halt execution like the real call would. */
  function runMain() {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let exitCode;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      exitCode = code;
      throw new Error(`__EXIT_${code}__`);
    });
    try {
      main();
    } catch (e) {
      if (!/^__EXIT_/.test(e.message)) throw e;
    }
    const logs = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    logSpy.mockRestore();
    exitSpy.mockRestore();
    return { exitCode, logs };
  }

  it('exits 0 and reports OK on a clean fixture corpus', () => {
    tmp.write('docs/architecture/decisions/0001-a.md', adr(1, 'Accepted'));
    const { exitCode, logs } = runMain();
    expect(exitCode).toBeUndefined(); // no error path -> never calls process.exit
    expect(logs).toContain('OK: ADR lint clean');
    expect(logs).toContain('1 ADRs checked');
  });

  it('exits 1 and reports the error count when the corpus has an ERROR', () => {
    tmp.write('docs/architecture/decisions/0001-a.md', '# ADR: a\n\nno status field\n');
    const { exitCode, logs } = runMain();
    expect(exitCode).toBe(1);
    expect(logs).toContain('ERROR(s)');
    expect(logs).toContain('FAIL: ADR corpus has 1 error(s)');
  });

  it('reports warnings without exiting when there are only WARNs', () => {
    tmp.write('docs/architecture/decisions/stray-name.md', adr(1, 'Accepted'));
    const { exitCode, logs } = runMain();
    expect(exitCode).toBeUndefined();
    expect(logs).toContain('warning(s)');
    expect(logs).toContain('BAD_FILENAME');
  });
});
