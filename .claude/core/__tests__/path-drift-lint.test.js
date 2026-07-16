// AC→source: path-drift-lint.js — the mechanical form of the
// migrate-all-readers-of-a-shared-path-in-one-wave workflow memory. Three rules:
// LEGACY_TOKEN (ERROR, pre-taxonomy .output tokens incl. the Amendment-2
// memories/ store), FLAT_HANDOFF (ERROR, file literals/globs directly under
// handoffs/ with no {YYYY-MM} segment), UNKNOWN_COMPARTMENT (WARN, literal
// segments absent from constants.js OUTPUT_PATHS). Every false-positive
// narrowing (trailing-dot strip, keep markers, test-tree/codemod skips, legacy
// suppression in R3) carries a still-catches test so the narrowing can't have
// silently introduced a false negative.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const {
  checkFlatHandoff,
  checkCompartments,
  knownTopSegments,
  groupChildren,
  legacyTopSegments,
  runLint,
  formatReport,
} = require('../path-drift-lint');
const { createTmpDir } = require('./_helpers/tmp-dir');

describe('checkFlatHandoff', () => {
  it('flags a stamped placeholder file directly under handoffs/', () => {
    const hits = checkFlatHandoff('written to `docs/.output/handoffs/{stamp}-{caller}-{branch}.md`');
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('handoffs/{stamp}');
  });

  it('flags a flat reader glob (the /end prune footgun, F2/F3)', () => {
    expect(checkFlatHandoff('ls -1t docs/.output/handoffs/*-end-main.md')).toHaveLength(1);
    expect(checkFlatHandoff('rm docs/.output/handoffs/*.md')).toHaveLength(1);
  });

  it('flags a concrete flat stamped filename', () => {
    expect(checkFlatHandoff('read docs/.output/handoffs/260702-1259-end-main.md')).toHaveLength(1);
  });

  it('accepts the month-bucketed canonical form — placeholder, literal month, and glob', () => {
    expect(checkFlatHandoff('docs/.output/handoffs/{YYYY-MM}/{stamp}-{caller}-{branch}.md')).toEqual([]);
    expect(checkFlatHandoff('docs/.output/handoffs/2026-07/260702-1259-end-main.md')).toEqual([]);
    expect(checkFlatHandoff('find docs/.output/handoffs/*/'.concat('*.md'))).toEqual([]);
    expect(checkFlatHandoff('docs/.output/handoffs/**/*.md')).toEqual([]);
  });

  it('ignores bare directory references and prose words after handoffs/', () => {
    expect(checkFlatHandoff('handoffs live under docs/.output/handoffs/ now')).toEqual([]);
    expect(checkFlatHandoff('├── handoffs/  findings/  plans/')).toEqual([]);
    // Template-var segment (resolver code building a path) is not judged.
    expect(checkFlatHandoff('return `${HANDOFF_DIR}/${pick.name}`')).toEqual([]);
  });

  it('does not match mid-identifier (boundary check)', () => {
    expect(checkFlatHandoff('myhandoffs/260702-1259-end-main.md')).toEqual([]);
  });

  it('reports every occurrence on a line with 1-based columns', () => {
    const line = 'handoffs/{stamp}-a-b.md and handoffs/{stamp}-c-d.md';
    const hits = checkFlatHandoff(line);
    expect(hits).toHaveLength(2);
    expect(hits[0].col).toBe(1);
    expect(hits[1].col).toBe(line.indexOf('handoffs/', 10) + 1);
  });
});

describe('checkCompartments', () => {
  it('warns on an unknown first segment under .output/', () => {
    const hits = checkCompartments('write to docs/.output/bugs/2026-07-01.md');
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toBe('.output/bugs');
  });

  it('warns on an unknown child of a grouping compartment (findings/evolution)', () => {
    expect(checkCompartments('see docs/.output/findings/audits/x.md')[0].token)
      .toBe('.output/findings/audits');
    expect(checkCompartments('append docs/.output/evolution/agents.md')[0].token)
      .toBe('.output/evolution/agents.md');
  });

  it('accepts every registered compartment and grouped child', () => {
    const lines = [
      'docs/.output/handoffs/2026-07/x.md',
      'docs/.output/findings/reviews/260702-1259-sweep.md',
      'docs/.output/findings/investigations/x.md',
      'docs/.output/findings/research/x.md',
      'docs/.output/plans/x.md',
      'docs/.output/evolution/intake/2026-07-02.md',
      'docs/.output/evolution/triage/_decisions.md',
      'docs/.output/evolution/canary/x/',
      'docs/.output/evolution/skills/latest/',
      'docs/.output/evolution/agents/2026-07-02.md',
      'docs/.output/.memory/patterns/slug.json',
      'docs/.output/.state/telemetry/x.jsonl',
    ];
    for (const line of lines) expect(checkCompartments(line), line).toEqual([]);
  });

  it('never judges placeholder/glob segments — only literals', () => {
    expect(checkCompartments('docs/.output/{kind}/x.md')).toEqual([]);
    expect(checkCompartments('docs/.output/*/2026-07/')).toEqual([]);
    expect(checkCompartments('docs/.output/${compartment}/file.md')).toEqual([]);
  });

  it('strips sentence punctuation: a trailing dot is not a segment', () => {
    // "the ONLY door into docs/.output/." — the output-paths.js header.
    expect(checkCompartments('the ONLY door into docs/.output/.')).toEqual([]);
    expect(checkCompartments('lives under docs/.output/plans/.')).toEqual([]);
  });

  it('STILL CATCHES an unknown segment that merely ends a sentence (narrowing guard)', () => {
    const hits = checkCompartments('everything moved to docs/.output/junkdrawer.');
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toBe('.output/junkdrawer'); // dot stripped from the report too
  });

  it('leaves legacy first segments to the LEGACY_TOKEN rule (no double report)', () => {
    expect(checkCompartments('old docs/.output/reviews/x.md')).toEqual([]);
    expect(checkCompartments('old docs/.output/memories/patterns/x.json')).toEqual([]);
  });

  it('accepts a month bucket directly under a grouping compartment', () => {
    expect(checkCompartments('docs/.output/findings/2026-06/')).toEqual([]);
  });
});

describe('registry-derived ground truth', () => {
  it('knownTopSegments mirrors constants.js OUTPUT_PATHS first segments', () => {
    const known = knownTopSegments();
    for (const seg of ['handoffs', 'findings', 'plans', 'evolution', '.memory', '.state']) {
      expect(known.has(seg), seg).toBe(true);
    }
  });

  it('groupChildren derives findings/evolution children from the registry', () => {
    const g = groupChildren();
    expect([...g.findings].sort()).toEqual(['bug-triage', 'investigations', 'research', 'reviews']);
    expect([...g.evolution].sort()).toEqual(['agents', 'canary', 'intake', 'skills', 'triage']);
  });

  it('legacyTopSegments covers both the taxonomy table and the Amendment-2 store', () => {
    const legacy = legacyTopSegments();
    for (const seg of ['reviews', 'triage', 'work', 'telemetry', 'memories']) {
      expect(legacy.has(seg), seg).toBe(true);
    }
  });
});

describe('runLint (integration over a fixture tree)', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'path-drift-lint-test-' }); });
  afterEach(() => { tmp.cleanup(); });

  function lint() { return runLint(tmp.root, {}); }

  it('reports all three rules with file:line:col and severities', () => {
    tmp.write('.claude/commands/foo.md', [
      'reads docs/.output/reviews/latest.md',                    // LEGACY_TOKEN
      'writes docs/.output/handoffs/{stamp}-end-main.md',        // FLAT_HANDOFF
      'and docs/.output/mystery/x.md',                           // UNKNOWN_COMPARTMENT
    ].join('\n'));
    const { findings } = lint();
    const byRule = Object.fromEntries(findings.map((f) => [f.rule, f]));
    expect(byRule.LEGACY_TOKEN).toMatchObject({ severity: 'ERROR', line: 1, file: path.join('.claude', 'commands', 'foo.md') });
    expect(byRule.LEGACY_TOKEN.hint).toContain('.output/findings/reviews');
    expect(byRule.FLAT_HANDOFF).toMatchObject({ severity: 'ERROR', line: 2 });
    expect(byRule.UNKNOWN_COMPARTMENT).toMatchObject({ severity: 'WARN', line: 3 });
  });

  it('flags the Amendment-2 memories/ store as LEGACY_TOKEN with the split-store hint', () => {
    tmp.write('.claude/core/foo.js', "const p = 'docs/.output/memories/patterns';");
    const { findings } = lint();
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('LEGACY_TOKEN');
    expect(findings[0].hint).toContain('.memory');
  });

  it('honors keep markers (migrate:keep and path-lint:keep) per line', () => {
    tmp.write('.claude/commands/foo.md', [
      'legacy flat docs/.output/handoffs/{stamp}-end-main.md example (path-lint:keep)',
      'old docs/.output/reviews/x.md example — migrate:keep',
    ].join('\n'));
    expect(lint().findings).toEqual([]);
  });

  it('STILL CATCHES the same tokens on non-marked lines of a file that has marked ones', () => {
    tmp.write('.claude/commands/foo.md', [
      'legacy docs/.output/handoffs/{stamp}-end-main.md example (path-lint:keep)',
      'real drift docs/.output/handoffs/{stamp}-end-main.md',
    ].join('\n'));
    const { findings } = lint();
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });

  it('skips test trees, the memories codemod, and version.json (fixture files)', () => {
    tmp.write('.claude/core/__tests__/fixture.test.js', "write('docs/.output/handoffs/260101-1200-end-main.md')");
    tmp.write('.claude/core/migrate-memory-store-paths.js', "const OLD = 'docs/.output/memories';");
    tmp.write('.claude/version.json', '{"changelog":"moved docs/.output/work to .state"}');
    expect(lint().findings).toEqual([]);
  });

  it('STILL CATCHES drift in a non-test sibling of a skipped tree', () => {
    tmp.write('.claude/core/__tests__/fixture.test.js', "write('docs/.output/handoffs/260101-1200-end-main.md')");
    tmp.write('.claude/core/reader.js', "glob('docs/.output/handoffs/*-end-main.md')");
    const { findings } = lint();
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(path.join('.claude', 'core', 'reader.js'));
  });

  it('scans docs/engineering (beyond the migrator default fileset) and CLAUDE.md', () => {
    tmp.write('docs/engineering/playbook.md', 'artifacts in docs/.output/reviews/x.md');
    tmp.write('CLAUDE.md', 'handoffs → docs/.output/handoffs/{stamp}-end-main.md');
    const { findings } = lint();
    expect(findings.map((f) => f.rule).sort()).toEqual(['FLAT_HANDOFF', 'LEGACY_TOKEN']);
  });

  it('guards the living plan (backlog.md) but NOT the historical rest of docs/work/', () => {
    tmp.write('docs/work/backlog.md', 'see docs/.output/reviews/260614-1831-x.md');
    tmp.write('docs/work/timeline.md', 'moved docs/.output/reviews/ that week');
    tmp.write('docs/work/scratch/2026-04-18/t/notes.md', 'old docs/.output/memories/patterns');
    tmp.write('docs/work/todo/TODO_old.md', 'wrote docs/.output/triage/2026-06-14.md');
    const { findings } = lint();
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(path.join('docs', 'work', 'backlog.md'));
  });

  it('explicit paths narrow the fileset', () => {
    tmp.write('.claude/commands/dirty.md', 'docs/.output/reviews/x.md');
    tmp.write('.claude/skills/clean/SKILL.md', 'docs/.output/findings/reviews/x.md');
    const { findings } = runLint(tmp.root, { paths: ['.claude/skills'] });
    expect(findings).toEqual([]);
  });

  it('is clean on a tree with only canonical paths', () => {
    tmp.write('.claude/commands/foo.md', [
      'docs/.output/handoffs/{YYYY-MM}/{stamp}-{caller}-{branch}.md',
      'docs/.output/findings/reviews/260702-1259-sweep.md',
      'docs/.output/.state/work/2026-07-02/task/',
    ].join('\n'));
    const r = lint();
    expect(r.findings).toEqual([]);
    expect(r.scanned).toBeGreaterThan(0);
  });
});

describe('formatReport', () => {
  it('prints clean summary with scanned count', () => {
    expect(formatReport({ findings: [], scanned: 12 })).toContain('clean — 12 files scanned');
  });

  it('prints counts and one line per finding', () => {
    const report = formatReport({
      findings: [
        { file: 'a.md', line: 1, col: 2, rule: 'LEGACY_TOKEN', severity: 'ERROR', token: '.output/reviews', hint: '→ x' },
        { file: 'b.md', line: 3, col: 4, rule: 'UNKNOWN_COMPARTMENT', severity: 'WARN', token: '.output/foo', hint: 'y' },
      ],
      scanned: 5,
    });
    expect(report).toContain('1 error(s), 1 warning(s) across 5 files');
    expect(report).toContain('a.md:1:2 LEGACY_TOKEN');
    expect(report).toContain('b.md:3:4 UNKNOWN_COMPARTMENT');
  });
});

// ── CLI subprocess smoke tests (exit-code contract) ─────────────────────────
describe('path-drift-lint.js CLI', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'path-drift-lint-cli-' }); });
  afterEach(() => { tmp.cleanup(); });

  const script = path.resolve(__dirname, '../path-drift-lint.js');

  function run(args) {
    const { spawnSync } = require('node:child_process');
    return spawnSync('node', [script, ...args], { encoding: 'utf8' });
  }

  it('exits 0 and reports clean on a drift-free tree', () => {
    tmp.write('.claude/commands/foo.md', 'docs/.output/findings/reviews/x.md');
    const r = run(['--root', tmp.root]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('clean');
  });

  it('exits 1 on an ERROR, 0 on WARN-only', () => {
    tmp.write('.claude/commands/foo.md', 'docs/.output/reviews/x.md');
    expect(run(['--root', tmp.root]).status).toBe(1);

    const tmp2 = createTmpDir({ prefix: 'path-drift-lint-cli2-' });
    tmp2.write('.claude/commands/foo.md', 'docs/.output/mystery/x.md');
    const r = run(['--root', tmp2.root]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('UNKNOWN_COMPARTMENT');
    tmp2.cleanup();
  });

  it('exits 2 on an unknown flag', () => {
    expect(run(['--bogus']).status).toBe(2);
  });
});
