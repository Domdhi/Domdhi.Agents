import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const hp = require('../../../.agents/core/handoff-path');
const { OUTPUT_PATHS } = require('../../../.agents/core/constants');
const { OUTPUT_ROOT } = require('../../../.agents/core/_lib/output-paths');

let tmp;
function mkHandoffs(names) {
  const dir = path.join(tmp, hp.HANDOFF_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, n), 'x');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('handoff-path', () => {
  it('slugBranch_makesFilenameSafeLowercase', () => {
    expect(hp.slugBranch('feature/Login-Form')).toBe('feature-login-form');
    expect(hp.slugBranch('main')).toBe('main');
    expect(hp.slugBranch('')).toBe('nobranch');
    expect(hp.slugBranch('  spaces here ')).toBe('spaces-here');
  });

  it('HANDOFF_DIR_derivesFromOutputPathsRegistry_notAHardcodedLiteral', () => {
    // F35/CR-3.3: the handoffs base dir must be single-sourced from the OUTPUT_PATHS
    // registry (via output-paths.js OUTPUT_ROOT), so an ADR-0006-style compartment
    // rename touches constants.js only — never this const in lockstep. Proves the
    // registry is the source, not that the current string happens to equal a literal.
    expect(hp.HANDOFF_DIR).toBe(`${OUTPUT_ROOT}/${OUTPUT_PATHS.handoffs.dir}`);
  });

  it('stamp_isYYMMDD_HHMM', () => {
    // 2026-06-07 17:45 → 260607-1745
    const s = hp.stamp(new Date(2026, 5, 7, 17, 45));
    expect(s).toBe('260607-1745');
  });

  it('buildWritePath_composesStampCallerBranch_monthBucketed', () => {
    const p = hp.buildWritePath('end', { runStamp: '260607-1745', branch: 'main' });
    expect(p).toBe('docs/.output/handoffs/2026-06/260607-1745-end-main.md');
  });

  it('monthFromStamp_derivesYYYY_MM', () => {
    expect(hp.monthFromStamp('260607-1745')).toBe('2026-06');
    expect(hp.monthFromStamp('260101-0000')).toBe('2026-01');
    expect(hp.monthFromStamp('garbage')).toBeNull();
  });

  it('buildWritePath_rejectsUnknownCaller', () => {
    expect(() => hp.buildWritePath('bogus', { runStamp: '260607-1745', branch: 'main' })).toThrow(/unknown caller/);
  });

  it('resolveLatest_returnsNull_whenDirAbsent', () => {
    expect(hp.resolveLatest({ cwd: tmp, branch: 'main' })).toBeNull();
  });

  it('resolveLatest_picksNewestForBranch', () => {
    mkHandoffs([
      '260601-0900-end-main.md',
      '260607-1200-do-main.md', // newest for main
      '260607-1800-end-feature-x.md', // newer overall, different branch
    ]);
    expect(hp.resolveLatest({ cwd: tmp, branch: 'main' })).toBe(
      'docs/.output/handoffs/260607-1200-do-main.md'
    );
  });

  it('resolveLatest_fallsBackToNewestOverall_whenBranchHasNone', () => {
    mkHandoffs(['260601-0900-end-main.md', '260607-1800-end-feature-x.md']);
    expect(hp.resolveLatest({ cwd: tmp, branch: 'brand-new' })).toBe(
      'docs/.output/handoffs/260607-1800-end-feature-x.md'
    );
  });

  // /prime's cross-branch recall: back on main after a feature merge, main's
  // own newest handoff is STALE — `any: true` must surface the fresher
  // foreign-branch handoff the default branch-preference deliberately hides.
  it('resolveLatest_any_returnsGlobalNewest_evenWhenBranchHasOwnHandoffs', () => {
    mkHandoffs([
      '260601-0900-end-main.md',
      '260607-1200-do-main.md',          // newest for main (stale)
      '260607-1800-end-feature-x.md',    // global newest, other branch
    ]);
    expect(hp.resolveLatest({ cwd: tmp, branch: 'main', any: true })).toBe(
      'docs/.output/handoffs/260607-1800-end-feature-x.md'
    );
    // default stays branch-preferred — parallel worktrees rely on it
    expect(hp.resolveLatest({ cwd: tmp, branch: 'main' })).toBe(
      'docs/.output/handoffs/260607-1200-do-main.md'
    );
  });

  it('resolveLatest_any_scansMonthFoldersToo', () => {
    mkHandoffs(['260601-0900-end-main.md']); // flat, current branch
    const monthDir = path.join(tmp, hp.HANDOFF_DIR, '2026-06');
    fs.mkdirSync(monthDir, { recursive: true });
    fs.writeFileSync(path.join(monthDir, '260607-1800-end-feature-x.md'), 'x');
    expect(hp.resolveLatest({ cwd: tmp, branch: 'main', any: true })).toBe(
      'docs/.output/handoffs/2026-06/260607-1800-end-feature-x.md'
    );
  });

  it('resolveLatest_disambiguatesRunTodoVsTodo_andHyphenatedBranches', () => {
    mkHandoffs([
      '260607-1000-todo-feature-login.md',
      '260607-1100-run-todo-feature-login.md', // newest for this branch
    ]);
    expect(hp.resolveLatest({ cwd: tmp, branch: 'feature-login' })).toBe(
      'docs/.output/handoffs/260607-1100-run-todo-feature-login.md'
    );
  });

  it('resolveLatest_ignoresNonHandoffFiles', () => {
    mkHandoffs(['260607-1200-do-main.md', 'README.md', 'notes.txt']);
    expect(hp.resolveLatest({ cwd: tmp, branch: 'main' })).toBe(
      'docs/.output/handoffs/260607-1200-do-main.md'
    );
  });

  it('resolveLatest_treatsOffContractFilename_asBranchAgnostic', () => {
    mkHandoffs([
      '260607-1200-do-main.md',                    // conforming, branch=main
      '260624-1500-xdb-zero-hour-grid-fix.md',      // off-contract: no caller, no branch tag
    ]);
    // Current branch has NO conforming handoff of its own — the off-contract
    // file must still be picked (branch-agnostic), not silently dropped.
    expect(hp.resolveLatest({ cwd: tmp, branch: 'some-other-branch' })).toBe(
      'docs/.output/handoffs/260624-1500-xdb-zero-hour-grid-fix.md'
    );
  });

  it('resolveLatest_offContractFile_stillLosesToNewerConformingSameBranchFile', () => {
    mkHandoffs([
      '260601-0900-xdb-zero-hour-grid-fix.md',   // off-contract, older
      '260607-1200-do-main.md',                  // conforming, branch=main, newer
    ]);
    // Both are "mine" (off-contract is branch-agnostic, conforming matches
    // branch) — recency picks the newer one, same sort as any other pair.
    expect(hp.resolveLatest({ cwd: tmp, branch: 'main' })).toBe(
      'docs/.output/handoffs/260607-1200-do-main.md'
    );
  });

  // ── month-bucketing (ADR 0006) ──────────────────────────────────────────────
  function mkMonth(month, names) {
    const dir = path.join(tmp, hp.HANDOFF_DIR, month);
    fs.mkdirSync(dir, { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(dir, n), 'x');
  }

  it('resolveLatest_scansMonthFolders', () => {
    mkMonth('2026-06', ['260607-1200-do-main.md', '260621-1353-end-main.md']);
    expect(hp.resolveLatest({ cwd: tmp, branch: 'main' })).toBe(
      'docs/.output/handoffs/2026-06/260621-1353-end-main.md'
    );
  });

  it('resolveLatest_picksNewestAcrossFlatAndMonth_mixedTree', () => {
    mkHandoffs(['260601-0900-end-main.md']);          // legacy flat
    mkMonth('2026-06', ['260620-1000-end-main.md']);  // newer, foldered
    expect(hp.resolveLatest({ cwd: tmp, branch: 'main' })).toBe(
      'docs/.output/handoffs/2026-06/260620-1000-end-main.md'
    );
  });

  it('resolveLatest_newestMonthWins_evenWhenOlderMonthHasLaterHHMM', () => {
    mkMonth('2026-05', ['260531-2359-end-main.md']);
    mkMonth('2026-06', ['260601-0001-end-main.md']);
    expect(hp.resolveLatest({ cwd: tmp, branch: 'main' })).toBe(
      'docs/.output/handoffs/2026-06/260601-0001-end-main.md'
    );
  });
});
