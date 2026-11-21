// AC->source: SF-1.10 (docs/TODO_software-factory.md), the action-authority matrix and its drift guard.
//
// The matrix lives in ONE place: the "## Action authority" section of `.agents/startup-reference.md`.
// `review-cadence.md` firm line 3 and `startup.md`'s trigger table only point at it. This file is the
// checker: it parses the table and fails when a cell names something that does not exist, so the four
// documents that carry the policy cannot drift apart silently (precedent: path-drift-lint.js, adr-lint.js,
// but those are standalone modules with their own CLI; the AC asks for one Vitest file reading the section,
// so the parser, `checkAuthorityTable`, deliberately stays inside this test file and is exercised against
// fixtures below, never only against the live tree).
//
// PINNED FORMAT (the prose author writes to this; the tests do not move):
//   Heading   exactly `## Action authority` (the section ends at the next `## ` heading).
//   Table     the first table in the section whose header starts with `action`; header cells, in order and
//             case-insensitive: action | tier | undo cost | approver | enforcement point.
//   Tier      `T0`..`T3`. A legend line for each tier in the section: `T0` free, `T1` cheap undo, `T2` outward,
//             `T3` irreversible (label and tier on one line).
//   Pipes     a literal `|` inside a cell is written `\|`.
//   Enforcement-point cell: every checkable reference is a backticked token, one of
//     `<repo path>`                    a file that exists, e.g. `.agents/core/commit.js` (no `..`, no absolute)
//     `permissions.deny`               settings.json carries a non-empty permissions.deny list
//     `deny:<rule>`                    that exact rule is in the permissions.deny list of
//                                      `.agents/adapters/claude/settings.json`
//     `guardrail:<section>:<needle>`   <section> is a list in `.agents/config/guardrail-rules.yaml`
//                                      (block_patterns | nudge_patterns | confirm_patterns | zeroAccessPaths |
//                                      readOnlyPaths | subagentReadOnlyPaths) and <needle> is a literal substring
//                                      of one of its entries. The guardrail file has no rule ids; the pattern
//                                      text is the id.
//   Any other backticked token is an error. A cell with no token is an error, except a T0 row whose cell is
//   `none` (a free action has nothing to enforce). Plain words around the tokens are free text.
//   Seeded rows are found by the action cell (markdown stripped): `edit...` and `test...`/`run tests` start the
//   cell; `commit...`/`git commit...` start the cell; the plain push row starts `git push` or `push` or
//   `plain git push` and does not say force; `change ... CI`, `change ... permission...`.
//
// AC map:
//   AC1 section + columns + tiers + seeded rows ... parseSection_*, legend_*, seededRow_*, commitRow_*
//   AC2 enforcement cells exist; plain push row ... checkAuthorityTable_* (fixtures), liveTable_*, plainPushRow_*
//   AC3 subagent write tier probe record ......... subagentWriteTierRow_*, forcePushRow_recordsDenyProbe
//   AC4 pointers, no restatement ................. reviewCadenceFirmLine3_*, startupTriggerTable_*, matrix_*
//   AC5 drift test fails on bad path/pattern ..... checkAuthorityTable_* (fixtures)
//   AC6 forbidden phrase ......................... forbiddenPhrase_*

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseYaml } = require('../_lib/yaml-parser');
const { createTmpDir } = require('./_helpers/tmp-dir');

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

const HEADING = '## Action authority';
const COLUMNS = ['action', 'tier', 'undo cost', 'approver', 'enforcement point'];
const GUARDRAIL_SECTIONS = [
  'block_patterns',
  'nudge_patterns',
  'confirm_patterns',
  'zeroAccessPaths',
  'readOnlyPaths',
  'subagentReadOnlyPaths',
];
const GUARDRAIL_REL = '.agents/config/guardrail-rules.yaml';
const SETTINGS_REL = '.agents/adapters/claude/settings.json';
const REFERENCE_REL = '.agents/startup-reference.md';
const CADENCE_REL = '.agents/skills/code-review/references/review-cadence.md';
const STARTUP_REL = '.agents/startup.md';

// ---------------------------------------------------------------------------
// Parser / checker (kept in this file; see header)
// ---------------------------------------------------------------------------

const stripMd = (s) => s.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();

function splitRow(line) {
  const cells = line.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
  if (cells.length && cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function sectionLines(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === HEADING);
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

function findMatrix(lines) {
  const errors = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim().startsWith('|')) {
      i++;
      continue;
    }
    const block = [];
    while (i < lines.length && lines[i].trim().startsWith('|')) block.push(lines[i++].trim());
    const header = splitRow(block[0]).map((c) => stripMd(c).toLowerCase());
    if (header[0] !== 'action') continue;
    if (JSON.stringify(header) !== JSON.stringify(COLUMNS)) {
      errors.push(`columns must be exactly ${COLUMNS.join(' | ')}; found ${header.join(' | ')}`);
      return { rows: [], errors };
    }
    if (!block[1] || !/^\|?\s*:?-{2,}/.test(block[1])) {
      errors.push('table header is not followed by a separator line');
      return { rows: [], errors };
    }
    return { rows: block.slice(2).map(splitRow), errors };
  }
  errors.push('no table whose header starts with "action" in the section');
  return { rows: [], errors };
}

function loadRules(root) {
  try {
    return { rules: parseYaml(fs.readFileSync(path.join(root, GUARDRAIL_REL), 'utf8')) };
  } catch (err) {
    return { error: `cannot load ${GUARDRAIL_REL}: ${err.message}` };
  }
}

function loadDeny(root) {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(root, SETTINGS_REL), 'utf8'));
    const deny = settings && settings.permissions && settings.permissions.deny;
    if (!Array.isArray(deny)) return { error: `${SETTINGS_REL} has no permissions.deny list` };
    return { deny };
  } catch (err) {
    return { error: `cannot load ${SETTINGS_REL}: ${err.message}` };
  }
}

function checkToken(token, ctx) {
  if (token.startsWith('guardrail:')) {
    const [, section, ...rest] = token.split(':');
    const needle = rest.join(':');
    if (!GUARDRAIL_SECTIONS.includes(section)) return `unknown guardrail section "${section}" in \`${token}\``;
    if (!needle) return `\`${token}\` names no pattern needle`;
    const loaded = ctx.rules();
    if (loaded.error) return loaded.error;
    const entries = loaded.rules[section];
    if (!Array.isArray(entries)) return `${GUARDRAIL_REL} has no list "${section}"`;
    if (!entries.some((e) => String(e).includes(needle))) {
      return `no ${section} entry in ${GUARDRAIL_REL} contains "${needle}"`;
    }
    return null;
  }
  if (token === 'permissions.deny') {
    const loaded = ctx.deny();
    if (loaded.error) return loaded.error;
    return loaded.deny.length > 0 ? null : `permissions.deny in ${SETTINGS_REL} is empty`;
  }
  if (token.startsWith('deny:')) {
    const rule = token.slice('deny:'.length);
    const loaded = ctx.deny();
    if (loaded.error) return loaded.error;
    return loaded.deny.includes(rule) ? null : `deny rule "${rule}" is not in ${SETTINGS_REL}`;
  }
  if (/^[\w@.\-/]+$/.test(token) && (token.includes('/') || /\.\w+$/.test(token))) {
    if (path.isAbsolute(token) || token.split('/').includes('..')) return `path \`${token}\` must be repo-relative`;
    return fs.existsSync(path.join(ctx.root, token)) ? null : `path \`${token}\` does not exist`;
  }
  return `unclassified token \`${token}\` (a path, permissions.deny, deny:<rule> or guardrail:<section>:<needle>)`;
}

/**
 * Parse the "Action authority" section of `text` and validate every row against the tree at `root`.
 * @returns {{rows: object[], errors: string[]}}
 */
function checkAuthorityTable(text, { root }) {
  const errors = [];
  const lines = sectionLines(text);
  if (!lines) return { rows: [], errors: [`heading "${HEADING}" not found`] };
  const found = findMatrix(lines);
  errors.push(...found.errors);

  let rulesCache;
  let denyCache;
  const ctx = {
    root,
    rules: () => (rulesCache = rulesCache || loadRules(root)),
    deny: () => (denyCache = denyCache || loadDeny(root)),
  };

  const rows = [];
  for (const cells of found.rows) {
    const label = cells[0] ? stripMd(cells[0]) : '(blank action)';
    if (cells.length !== COLUMNS.length) {
      errors.push(`row "${label}": has ${cells.length} cells, expected ${COLUMNS.length}`);
      continue;
    }
    const [action, tier, undoCost, approver, enforcement] = cells;
    const row = {
      action: stripMd(action),
      tier: stripMd(tier),
      undoCost: stripMd(undoCost),
      approver: stripMd(approver),
      enforcement,
      enforcementText: stripMd(enforcement),
      tokens: [...enforcement.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
    };
    rows.push(row);
    if (!row.action) errors.push('row with an empty action cell');
    if (!/^T[0-3]$/.test(row.tier)) errors.push(`row "${label}": tier "${row.tier}" is not T0..T3`);
    if (!row.undoCost) errors.push(`row "${label}": undo cost is empty`);
    if (!row.approver) errors.push(`row "${label}": approver is empty`);
    if (row.tokens.length === 0) {
      const freeAndNone = row.tier === 'T0' && /^none\b/i.test(row.enforcementText);
      if (!freeAndNone) errors.push(`row "${label}": enforcement point names nothing checkable`);
    }
    for (const token of row.tokens) {
      const problem = checkToken(token, ctx);
      if (problem) errors.push(`row "${label}": ${problem}`);
    }
  }
  return { rows, errors };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HEADER = '| Action | Tier | Undo cost | Approver | Enforcement point |\n|---|---|---|---|---|';
const fixture = (...rows) => `# Ref\n\n${HEADING}\n\nlegend\n\n${HEADER}\n${rows.join('\n')}\n\n## Next section\n`;
const row = (action, tier, enforcement, undo = 'revert', approver = 'owner') =>
  `| ${action} | ${tier} | ${undo} | ${approver} | ${enforcement} |`;

const GOOD_ROW = row('commit', 'T1', '`.agents/core/commit.js`, `guardrail:confirm_patterns:npm publish`');

// ---------------------------------------------------------------------------
// The checker against fixtures (adversarial: it must report bad cells)
// ---------------------------------------------------------------------------

describe('checkAuthorityTable (fixtures)', () => {
  it('checkAuthorityTable_everyTokenClassResolves_reportsNoErrors', () => {
    const text = fixture(
      GOOD_ROW,
      row('force push', 'T3', '`permissions.deny`, `deny:Bash(git push -f*)`'),
      row('edit', 'T0', 'none'),
    );

    const result = checkAuthorityTable(text, { root: ROOT });

    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => r.tier)).toEqual(['T1', 'T3', 'T0']);
  });

  it('checkAuthorityTable_nonexistentPath_reportsRowAndPath', () => {
    const text = fixture(row('push', 'T2', '`.agents/hooks/ask-before-push.cjs`'));

    const { errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toEqual(['row "push": path `.agents/hooks/ask-before-push.cjs` does not exist']);
  });

  it('checkAuthorityTable_bareFileNameWithoutDirectory_reportsMissingPath', () => {
    const text = fixture(row('commit', 'T1', '`commit.js`'));

    const { errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toEqual(['row "commit": path `commit.js` does not exist']);
  });

  it.each([['../outside.js'], ['/etc/hosts']])('checkAuthorityTable_escapingPath_%s_isRejected', (p) => {
    const text = fixture(row('commit', 'T1', `\`${p}\``));

    const { errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toEqual([`row "commit": path \`${p}\` must be repo-relative`]);
  });

  it('checkAuthorityTable_guardrailNeedleAbsentFromSection_reportsIt', () => {
    const text = fixture(row('publish', 'T2', '`guardrail:confirm_patterns:npm-publish-typo`'));

    const { errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toEqual([
      `row "publish": no confirm_patterns entry in ${GUARDRAIL_REL} contains "npm-publish-typo"`,
    ]);
  });

  it('checkAuthorityTable_needleExistsOnlyInADifferentSection_reportsIt', () => {
    // `npm publish` is a confirm pattern, not a block pattern: citing the wrong tier of rule is drift.
    const text = fixture(row('publish', 'T2', '`guardrail:block_patterns:npm publish`'));

    const { errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toEqual([`row "publish": no block_patterns entry in ${GUARDRAIL_REL} contains "npm publish"`]);
  });

  it('checkAuthorityTable_unknownGuardrailSection_reportsIt', () => {
    const text = fixture(row('publish', 'T2', '`guardrail:confirm_rules:npm publish`'));

    const { errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toEqual(['row "publish": unknown guardrail section "confirm_rules" in `guardrail:confirm_rules:npm publish`']);
  });

  it('checkAuthorityTable_guardrailTokenWithoutNeedle_reportsIt', () => {
    const text = fixture(row('publish', 'T2', '`guardrail:confirm_patterns`'));

    const { errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toEqual(['row "publish": `guardrail:confirm_patterns` names no pattern needle']);
  });

  it('checkAuthorityTable_escapedPipeInNeedle_isUnescapedAndMatched', () => {
    // The real reset rule carries a `|` inside a character class; the cell writes it as `\|`.
    const text = fixture(row('reset --hard', 'T3', '`guardrail:nudge_patterns:\\breset\\b[^;&\\|\\n]*--hard\\b`'));

    const { errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toEqual([]);
  });

  it('checkAuthorityTable_denyRuleAbsentFromSettings_reportsIt', () => {
    const text = fixture(row('force push', 'T3', '`deny:Bash(git push --nuke*)`'));

    const { errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toEqual([`row "force push": deny rule "Bash(git push --nuke*)" is not in ${SETTINGS_REL}`]);
  });

  it('checkAuthorityTable_unclassifiedToken_reportsIt', () => {
    const text = fixture(row('push', 'T2', '`the owner session policy`'));

    const { errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^row "push": unclassified token `the owner session policy`/);
  });

  it('checkAuthorityTable_enforcementCellWithNoToken_reportsNothingCheckable', () => {
    const text = fixture(row('deploy', 'T2', 'the owner decides'));

    const { errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toEqual(['row "deploy": enforcement point names nothing checkable']);
  });

  it('checkAuthorityTable_noneIsAcceptedForT0OnlyNotForT1', () => {
    const text = fixture(row('edit', 'T0', 'none'), row('commit', 'T1', 'none'));

    const { errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toEqual(['row "commit": enforcement point names nothing checkable']);
  });

  it('checkAuthorityTable_permissionsDenyWhenSettingsHasNoDenyList_reportsIt', () => {
    const tmp = createTmpDir({ prefix: 'action-authority-' });
    try {
      tmp.write(SETTINGS_REL, JSON.stringify({ permissions: { allow: [] } }));
      const text = fixture(row('push', 'T2', '`permissions.deny`'));

      const { errors } = checkAuthorityTable(text, { root: tmp.root });

      expect(errors).toEqual([`row "push": ${SETTINGS_REL} has no permissions.deny list`]);
    } finally {
      tmp.cleanup();
    }
  });

  it('checkAuthorityTable_permissionsDenyWhenListIsEmpty_reportsIt', () => {
    const tmp = createTmpDir({ prefix: 'action-authority-' });
    try {
      tmp.write(SETTINGS_REL, JSON.stringify({ permissions: { deny: [] } }));
      const text = fixture(row('push', 'T2', '`permissions.deny`'));

      const { errors } = checkAuthorityTable(text, { root: tmp.root });

      expect(errors).toEqual([`row "push": permissions.deny in ${SETTINGS_REL} is empty`]);
    } finally {
      tmp.cleanup();
    }
  });

  it('checkAuthorityTable_rootWithoutGuardrailFileOrSettings_failsClosedPerToken', () => {
    const tmp = createTmpDir({ prefix: 'action-authority-' });
    try {
      const text = fixture(
        row('publish', 'T2', '`guardrail:confirm_patterns:npm publish`'),
        row('push', 'T2', '`deny:Bash(git push -f*)`'),
      );

      const { errors } = checkAuthorityTable(text, { root: tmp.root });

      expect(errors).toHaveLength(2);
      expect(errors[0]).toMatch(/^row "publish": cannot load \.agents\/config\/guardrail-rules\.yaml/);
      expect(errors[1]).toMatch(/^row "push": cannot load \.agents\/adapters\/claude\/settings\.json/);
    } finally {
      tmp.cleanup();
    }
  });

  it('checkAuthorityTable_missingHeading_reportsIt', () => {
    const { rows, errors } = checkAuthorityTable(`# Ref\n\n## Something else\n\n${HEADER}\n${GOOD_ROW}\n`, { root: ROOT });

    expect(rows).toEqual([]);
    expect(errors).toEqual([`heading "${HEADING}" not found`]);
  });

  it('checkAuthorityTable_wrongOrRenamedColumns_reportsIt', () => {
    const text = `${HEADING}\n\n| Action | Tier | Cost | Approver | Enforcement point |\n|---|---|---|---|---|\n${GOOD_ROW}\n`;

    const { errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toEqual([
      'columns must be exactly action | tier | undo cost | approver | enforcement point; found action | tier | cost | approver | enforcement point',
    ]);
  });

  it('checkAuthorityTable_headingWithoutAMatrixTable_reportsIt', () => {
    const { errors } = checkAuthorityTable(`${HEADING}\n\nJust prose.\n`, { root: ROOT });

    expect(errors).toEqual(['no table whose header starts with "action" in the section']);
  });

  it.each([['T4'], ['T'], ['free'], ['t1x']])('checkAuthorityTable_tier_%s_isRejected', (tier) => {
    const { errors } = checkAuthorityTable(fixture(row('commit', tier, '`.agents/core/commit.js`')), { root: ROOT });

    expect(errors).toEqual([`row "commit": tier "${tier}" is not T0..T3`]);
  });

  it('checkAuthorityTable_emptyApproverOrUndoCost_reportsEach', () => {
    const text = fixture(row('commit', 'T1', '`.agents/core/commit.js`', ' ', ' '));

    const { errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toEqual(['row "commit": undo cost is empty', 'row "commit": approver is empty']);
  });

  it('checkAuthorityTable_rowWithWrongCellCount_reportsIt', () => {
    const text = fixture('| commit | T1 | `.agents/core/commit.js` |');

    const { errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toEqual(['row "commit": has 3 cells, expected 5']);
  });

  it('checkAuthorityTable_tableAfterTheSectionEnds_isNotJudged', () => {
    const text = `${fixture(GOOD_ROW)}\n${HEADER}\n${row('ghost', 'T2', '`no/such/file.js`')}\n`;

    const { rows, errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it('checkAuthorityTable_multipleBadCells_reportsEveryOne', () => {
    const text = fixture(
      row('a', 'T2', '`no/such.js`'),
      row('b', 'T2', '`guardrail:block_patterns:zzz-no-such-rule`'),
      row('c', 'T9', '`.agents/core/commit.js`'),
    );

    const { errors } = checkAuthorityTable(text, { root: ROOT });

    expect(errors).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The live documents
// ---------------------------------------------------------------------------

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const reference = () => read(REFERENCE_REL);
const live = () => checkAuthorityTable(reference(), { root: ROOT });
const matching = (rows, re, exclude) =>
  rows.filter((r) => re.test(r.action) && !(exclude && exclude.test(r.action)));

describe('startup-reference.md Action authority section', () => {
  it('parseSection_liveReference_hasHeadingAndPinnedColumns', () => {
    const lines = sectionLines(reference());

    expect(lines, `"${HEADING}" heading missing from ${REFERENCE_REL}`).not.toBeNull();
    const matrix = findMatrix(lines);
    expect(matrix.errors).toEqual([]);
    expect(matrix.rows.length).toBeGreaterThan(0);
  });

  it('parseSection_liveReference_headingAppearsExactlyOnce', () => {
    const count = reference().split(/\r?\n/).filter((l) => l.trim() === HEADING).length;

    expect(count).toBe(1);
  });

  it.each([
    ['T0', 'free'],
    ['T1', 'cheap undo'],
    ['T2', 'outward'],
    ['T3', 'irreversible'],
  ])('legend_%s_isDefinedAs_%s', (tier, label) => {
    const lines = sectionLines(reference()) || [];

    const defined = lines.some((l) => !l.trim().startsWith('|') && new RegExp(`\\b${tier}\\b.*${label}`, 'i').test(l));

    expect(defined, `no legend line pairing ${tier} with "${label}" in the section`).toBe(true);
  });

  it('liveTable_everyRowIsWellFormedAndEveryEnforcementTokenResolves', () => {
    const { rows, errors } = live();

    expect(rows.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  const T0_EDIT = /^edit/i;
  const T0_TEST = /^(?:run )?tests?\b/i;
  const PUSH_PLAIN = /^(?:plain )?(?:git )?push\b/i;
  const NOT_FORCE = /force|mirror/i;
  const SEEDED = [
    ['edit', T0_EDIT, null, 'T0'],
    ['test', T0_TEST, null, 'T0'],
    ['commit', /^(?:git )?commit\b/i, null, 'T1'],
    ['push', PUSH_PLAIN, NOT_FORCE, 'T2'],
    ['pull request', /pull request|\bPR\b/i, null, 'T2'],
    ['publish', /publish/i, null, 'T2'],
    ['deploy', /deploy/i, null, 'T2'],
    ['fleet sync', /fleet sync/i, null, 'T2'],
    ['change CI', /^change\b.*\bCI\b/i, null, 'T2'],
    ['change permissions', /^change\b.*permission/i, null, 'T2'],
    ['force-push', /force[- ]push/i, null, 'T3'],
    ['data delete', /\bdata\b.*\bdelet|\bdelet\w*\b.*\bdata\b/i, null, 'T3'],
    ['git clean', /git clean/i, null, 'T3'],
    ['reset --hard', /reset\s+--hard/i, null, 'T3'],
    ['credential rotate or expose', /credential/i, null, 'T3'],
  ];

  it.each(SEEDED)('seededRow_%s_isClassifiedAsTheResearchTier', (name, re, exclude, tier) => {
    const { rows } = live();

    const found = matching(rows, re, exclude);

    expect(found.length, `no seeded row for "${name}"`).toBeGreaterThan(0);
    expect(found.map((r) => `${r.action}=${r.tier}`)).toEqual(found.map((r) => `${r.action}=${tier}`));
  });

  it('commitRow_goesThroughCommitJsWithTheShipCheck', () => {
    const { rows } = live();

    const commit = matching(rows, /^(?:git )?commit\b/i)[0];

    expect(commit, 'no commit row').toBeDefined();
    expect(commit.tokens).toContain('.agents/core/commit.js');
    expect(`${commit.action} ${commit.enforcementText}`).toMatch(/ship[- ]check/i);
  });

  it.each([
    ['git clean', /git clean/i],
    ['reset --hard', /reset\s+--hard/i],
    ['publish', /publish/i],
  ])('guardrailBackedRow_%s_citesAGuardrailRule', (name, re) => {
    const { rows } = live();

    const found = matching(rows, re);

    expect(found.length, `no ${name} row`).toBeGreaterThan(0);
    for (const r of found) {
      expect(r.tokens.some((t) => t.startsWith('guardrail:')), `row "${r.action}" cites no guardrail rule`).toBe(true);
    }
  });

  it('plainPushRow_namesPermissionsDenyAndTheSessionPolicyOrLocationUnknown', () => {
    const { rows } = live();

    const push = matching(rows, PUSH_PLAIN, NOT_FORCE);

    expect(push.length, 'no plain git push row').toBeGreaterThan(0);
    for (const r of push) {
      expect(r.tokens, `row "${r.action}"`).toContain('permissions.deny');
      expect(r.enforcementText, `row "${r.action}"`).toMatch(/session policy|location unknown/i);
    }
  });

  it('plainPushRow_doesNotCiteAnAskOnPushHookThatIsNotInTheRepo', () => {
    // .claude/push-guardrail.json references an ask-on-push hook that this repo does not carry.
    const { rows } = live();

    const push = matching(rows, PUSH_PLAIN, NOT_FORCE);

    expect(push.length).toBeGreaterThan(0);
    for (const r of push) {
      for (const t of r.tokens.filter((x) => x.includes('/'))) {
        expect(fs.existsSync(path.join(ROOT, t)), `row "${r.action}" cites ${t}`).toBe(true);
      }
    }
  });

  const dateOf = (s) => [...s.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((m) => m[1]);
  const versionsOf = (s) => [...s.matchAll(/\b(\d+)\.(\d+)\.(\d+)\b/g)].map((m) => [+m[1], +m[2], +m[3]]);
  const atLeast = (v, min) => {
    for (let i = 0; i < 3; i++) {
      if (v[i] !== min[i]) return v[i] > min[i];
    }
    return true;
  };

  it('subagentWriteTierRow_recordsLastProbeDateAndClaudeCodeVersion', () => {
    // Key Finding 26: probed 2026-11-18 on Claude Code 2.1.319. A later re-probe updates the row, so the
    // test accepts a later date and version and rejects a missing or older record.
    const { rows } = live();

    const tier = matching(rows, /subagent/i).find((r) => r.tokens.some((t) => /path-guardrail\.cjs$/.test(t)));

    expect(tier, 'no subagent write tier row citing .agents/hooks/path-guardrail.cjs').toBeDefined();
    const text = `${tier.action} ${tier.undoCost} ${tier.approver} ${tier.enforcement}`;
    expect(dateOf(text).some((d) => d >= '2026-11-18'), `no probe date >= 2026-11-18 in: ${text}`).toBe(true);
    expect(versionsOf(text).some((v) => atLeast(v, [2, 1, 319])), `no Claude Code version >= 2.1.319 in: ${text}`).toBe(true);
  });

  it('subagentWriteTierRow_saysToReprobeAfterAClaudeCodeUpgrade', () => {
    const { rows } = live();

    const tier = matching(rows, /subagent/i).find((r) => r.tokens.some((t) => /path-guardrail\.cjs$/.test(t)));

    expect(tier, 'no subagent write tier row citing .agents/hooks/path-guardrail.cjs').toBeDefined();
    expect(tier.enforcementText).toMatch(/re-?probe/i);
    expect(tier.enforcementText).toMatch(/upgrade/i);
  });

  it('forcePushRow_citesPermissionsDenyAndRecordsTheDenySetProbe', () => {
    // Key Finding 25: deny set probed 2026-11-18 on Claude Code 2.1.319; "re-probe after every upgrade
    // (SF-1.10 matrix row)".
    const { rows } = live();

    const force = matching(rows, /force[- ]push/i);

    expect(force.length, 'no force-push row').toBeGreaterThan(0);
    for (const r of force) {
      expect(r.tokens, `row "${r.action}"`).toContain('permissions.deny');
    }
    const text = force.map((r) => `${r.action} ${r.undoCost} ${r.approver} ${r.enforcement}`).join(' ');
    expect(dateOf(text).some((d) => d >= '2026-11-18'), 'force-push row has no probe date >= 2026-11-18').toBe(true);
    expect(versionsOf(text).some((v) => atLeast(v, [2, 1, 319])), 'force-push row has no version >= 2.1.319').toBe(true);
    expect(text).toMatch(/re-?probe/i);
  });
});

// ---------------------------------------------------------------------------
// Pointers: one sentence, one row, nothing restated
// ---------------------------------------------------------------------------

describe('pointers to the matrix', () => {
  const ORIGINAL_LINE3 = "No push, deploy, publish or fleet sync without the owner's explicit go.";
  const firmLines = () => {
    const lines = read(CADENCE_REL).split(/\r?\n/);
    const start = lines.findIndex((l) => l.trim() === '## Firm lines');
    const out = [];
    for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
      if (/^\d+\. /.test(lines[i])) out.push(lines[i]);
    }
    return out;
  };
  const sentences = (s) => s.split(/(?<=[.!?])\s+/).filter(Boolean);

  it('reviewCadenceFirmLine3_keepsItsOriginalSentenceAndStaysThreeLines', () => {
    const lines = firmLines();

    expect(lines).toHaveLength(3);
    expect(lines[2].startsWith(`3. ${ORIGINAL_LINE3}`)).toBe(true);
  });

  it('reviewCadenceFirmLine3_gainsExactlyOnePointerSentence', () => {
    const line3 = firmLines()[2].replace(/^3\. /, '');

    expect(sentences(line3)).toHaveLength(2);
  });

  it('reviewCadenceFirmLine3_pointerNamesTheReferenceFileAndSection', () => {
    const pointer = sentences(firmLines()[2].replace(/^3\. /, ''))[1] || '';

    expect(pointer).toMatch(/startup-reference\.md/);
    expect(pointer).toMatch(/Action authority/);
  });

  it('reviewCadenceFirmLine3_doesNotRestateTheMatrix', () => {
    const line3 = firmLines()[2];

    expect(line3).not.toMatch(/\bT[0-3]\b/);
    expect(line3).not.toContain('|');
    expect(line3).not.toMatch(/undo cost|enforcement point/i);
  });

  const triggerRows = () =>
    read(STARTUP_REL)
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith('|'))
      .map(splitRow);

  it('startupTriggerTable_hasExactlyOneRowPointingAtActionAuthority', () => {
    const rows = triggerRows().filter((cells) => (cells[1] || '').includes('Action authority'));

    expect(rows).toHaveLength(1);
  });

  it('startupTriggerTable_actionAuthorityRowHasATriggerAndOnlyTwoCells', () => {
    const row = triggerRows().find((cells) => (cells[1] || '').includes('Action authority'));

    expect(row, 'no trigger row naming Action authority').toBeDefined();
    expect(row).toHaveLength(2);
    expect(row[0].length).toBeGreaterThan(0);
  });

  it('startupTriggerTable_actionAuthorityRowDoesNotRestateTheMatrix', () => {
    const row = triggerRows().find((cells) => (cells[1] || '').includes('Action authority'));

    expect(row, 'no trigger row naming Action authority').toBeDefined();
    expect(row.join(' ')).not.toMatch(/\bT[0-3]\b|undo cost|enforcement point/i);
  });

  it.each([
    [CADENCE_REL],
    [STARTUP_REL],
  ])('matrix_%s_doesNotCarryTheTableColumns', (rel) => {
    const text = read(rel);

    expect(text).not.toMatch(/undo cost/i);
    expect(text).not.toMatch(/enforcement point/i);
  });

  it('matrix_columnHeaderAppearsInExactlyOneToolkitDocument_theReference', () => {
    const holders = [REFERENCE_REL, CADENCE_REL, STARTUP_REL].filter((rel) =>
      /\|\s*Action\s*\|\s*Tier\s*\|\s*Undo cost\s*\|/i.test(read(rel)),
    );

    expect(holders).toEqual([REFERENCE_REL]);
  });
});

// ---------------------------------------------------------------------------
// Forbidden phrase
// ---------------------------------------------------------------------------

describe('forbidden phrase', () => {
  // Built from parts so this file does not contain it.
  const PHRASE = ['every', 'commit', 'path'].join(' ');

  it.each([[REFERENCE_REL], [CADENCE_REL], [STARTUP_REL], ['.agents/core/__tests__/action-authority.test.js']])(
    'forbiddenPhrase_%s_doesNotContainIt',
    (rel) => {
      expect(read(rel).toLowerCase().includes(PHRASE)).toBe(false);
    },
  );

  it('forbiddenPhrase_detectorFlagsASeededOccurrence', () => {
    // Guards the check itself: the case-insensitive includes() must see the phrase when present.
    const seeded = `Covers ${PHRASE.toUpperCase()} in the repo.`;

    expect(seeded.toLowerCase().includes(PHRASE)).toBe(true);
  });
});

// Wave 8 review M3: a cited guardrail token must be a LIVE rule. matchesPattern accepts only the bare
// `/expr/` form, so any `/`-prefixed list entry that does not end in `/` (e.g. a trailing `/i`) silently never
// matches. Lint the whole rule file, and probe the T3 data-delete row with real commands.
describe('wave 8 review M3: guardrail patterns cited by the matrix are live', () => {
  const yamlText = () => fs.readFileSync(path.resolve(__dirname, '../../config/guardrail-rules.yaml'), 'utf8');

  it('no regex-form pattern entry carries trailing flags (a trailing comment is stripped by the parser)', () => {
    const bad = yamlText().split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /^\s+-\s+\//.test(line))
      .filter(({ line }) => !/\/\s*$/.test(line.replace(/^\s+-\s+/, '').replace(/\s{2,}#\s.*$/, '').replace(/\s+#\s[^/]*$/, '')));
    expect(bad.map((b) => `${b.n}: ${b.line.trim()}`)).toEqual([]);
  });

  it.each([
    ['DROP TABLE users', true],
    ['TRUNCATE users', true],
    ['psql -c "DROP TABLE users"', true],
    ['psql -c "TRUNCATE TABLE users"', true],
    ['grep "DROP TABLE" notes.md', false],
    ['truncate -s 0 build/output.txt', false],
  ])('the real guardrail hook on %j blocks=%s', (command, blocked) => {
    const hook = path.resolve(__dirname, '../../hooks/guardrail.cjs');
    const res = require('node:child_process').spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: path.resolve(__dirname, '../../..') },
    });
    expect(res.status === 2, `${command}: exit ${res.status}`).toBe(blocked);
  });
});
