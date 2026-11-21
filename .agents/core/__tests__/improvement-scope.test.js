// SF-4.3 — improvement scope and the protected set (deep tier: it decides what an unattended
// loop may edit). Written first (TDD); `.agents/core/_lib/improvement-scope.js` does not exist yet.
//
// PINNED CONTRACT (the implementer must match these names; nothing here is a second list of
// protected paths: the SF-1.8 tier is READ from the rules yaml, never re-declared)
//
//   Module: .agents/core/_lib/improvement-scope.js  (zero-dependency CommonJS, `require.main`-guarded CLI)
//
//   Exports
//     EDITABLE_GLOBS            non-empty array of glob strings (the editable list; may carry a `{target}` slot)
//     PROTECTED_ADDITIONS       non-empty array of glob strings: what SF-4.3 adds to the SF-1.8 tier
//                               (tests, judge code, eval tasks, holdout, grader prompts and scripts, the
//                               project rules override, ...)
//     loadProtectedSet({root?, rulesPath?}) -> {tier: string[], additions: string[], globs: string[]}
//                               tier = `subagentReadOnlyPaths` read from the yaml via guardrail-rules.js loadRules;
//                               additions = PROTECTED_ADDITIONS; globs = their union (no duplicates).
//                               Throws when the rules cannot be loaded (missing/unparseable/malformed tier,
//                               a parsed file with the tier key absent or empty): no hard-coded fallback.
//     classify(path, {root?, target?, rulesPath?}) -> {class, path, reason, matched?}
//                               class: 'editable' | 'protected' | 'outside'. NEVER throws.
//                               reason: 'editable' | 'protected' | 'outside-scope' | 'outside-repo' | 'symlink'
//                                       | 'invalid-path' | 'classify-error'
//                               `path` is the normalized repo-relative forward-slash path ('outside-repo':
//                               the normalized input). 'protected' carries `matched` (the glob).
//                               Fail closed: invalid-path, classify-error, symlink and an unloadable rules
//                               file all give class 'protected'. A path matched by both lists is protected.
//     assertDiffInScope(files, {target, root?, rulesPath?})
//                            -> {ok: boolean, violations: [{path, input, class, reason, matched?}], error?: string}
//                               NEVER throws. `files` is an array of path strings or git-shaped entries
//                               `{status, path, from?}` (a rename/copy is judged at BOTH ends). ok is true only
//                               when every path is editable for `target`. Malformed input (non-array, bad
//                               entry, bad target) -> ok:false with an `error` string. Out-of-scope paths are
//                               listed in `violations` in input order, each naming its path.
//     diffFromGit(base, {root?}) -> [{status, path, from?, untracked?}]
//                               `git diff --name-status -z <base>` (committed + staged + unstaged work since
//                               base) plus untracked files (status 'A', untracked: true). Status is the first
//                               letter only. THROWS on git failure or a base that starts with '-'.
//     checkDiffInScope({base, target, root?, rulesPath?}) -> same shape as assertDiffInScope; NEVER throws;
//                               a git failure is ok:false with `error`. Also reports files that git IGNORES
//                               but that classify as protected (an ignore rule must not hide a write).
//   CLI (exit 0 in scope, 1 refused, 2 invalid input / unusable rules / git failure; JSON on stdout)
//     node improvement-scope.js check --base <ref> --target <skill> [--root <dir>] [--rules <path>]
//     node improvement-scope.js classify <path> [--target <skill>] [--root <dir>] [--rules <path>]
//
// AC -> test names
//   AC1 (classify, assertDiffInScope, two lists, both-matched = protected):
//       "exports_*", "classify_editableAllowedSet_*", "classify_bothListsMatch_*", "assertDiffInScope_*"
//   AC2 (protected includes ...): "classify_protectedFamilies_*"
//   AC3 (yaml gains only grader/holdout/eval paths; judge code and tests stay diff-scope-only):
//       "yamlStatic_*"
//   AC4 (meta-test over the yaml): "metaCoverage_*"
//   AC5 (adversarial, fail closed): "failClosed_*", "paths_*", "symlink_*", "cli_*"
//   Seam (single list = SF-1.8 tier read from the yaml; Bash writes via git diff): "protectedSet_*", "git_*"
//
// NOT COVERED: the AC4 meta-test cannot be shown to go red on a synthetic uncovered path without a second
// exported coverage function the AC does not name; it is a live-yaml check ("metaCoverage_*") whose red-green is
// the yaml edit (the yaml-assigned rows are red until the grader/holdout/eval-task entries land).
// NOT COVERED: platform-dependent symlink tests are skipped (it.skipIf) where the OS refuses symlink creation.
// NOT COVERED: a workflow wiring pin. The SF-4.3 AC names no workflow string; the apply helper's call into
// `assertDiffInScope` is SF-4.9's AC and is pinned there.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const MODULE_PATH = path.join(REPO_ROOT, '.agents', 'core', '_lib', 'improvement-scope.js');
const REAL_YAML = path.join(REPO_ROOT, '.agents', 'config', 'guardrail-rules.yaml');
const { loadRules, checkPathAccess } = require('../_lib/guardrail-rules');

// Lazy so a missing module fails each test individually for the right reason.
const S = new Proxy({}, { get: (_t, key) => require(MODULE_PATH)[key] });

// ─── fixtures ────────────────────────────────────────────────────────────────

const MIN_TIER = [
    'gate.config.json',
    '.agents/core/gate.js',
    '.agents/hooks/',
    '.agents/config/guardrail-rules.yaml',
];

function tierYaml(entries) {
    return `subagentReadOnlyPaths:\n${entries.map((e) => `  - ${e}`).join('\n')}\n`;
}

function git(root, ...args) {
    return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    }).trim();
}

function put(root, rel, content = 'x\n') {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
}

let roots = [];
function tmpRoot(prefix = 'imp-scope-') {
    const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    roots.push(r);
    return r;
}
afterEach(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    roots = [];
});

/** A non-git temp project with a rules yaml at the authored location. */
function plainProject(tier = MIN_TIER) {
    const root = tmpRoot();
    put(root, '.agents/config/guardrail-rules.yaml', tierYaml(tier));
    return root;
}

/** A committed temp git repo; returns {root, base}. */
function gitProject(tier = MIN_TIER) {
    const root = tmpRoot('imp-scope-git-');
    git(root, 'init', '-q', '-b', 'main');
    put(root, '.agents/config/guardrail-rules.yaml', tierYaml(tier));
    put(root, '.agents/core/gate.js', 'gate v1\n');
    put(root, '.agents/core/skill-eval.js', 'judge v1\n');
    put(root, '.agents/core/__tests__/a.test.js', 'test v1\n');
    put(root, '.agents/hooks/h.cjs', 'hook v1\n');
    put(root, '.agents/skills/alpha/SKILL.md', 'alpha body\n');
    put(root, '.agents/skills/alpha/references/workflow.md', 'alpha ref\n');
    put(root, '.agents/skills/beta/SKILL.md', 'beta body\n');
    put(root, 'docs/notes.md', 'notes\n');
    put(root, '.gitignore', 'node_modules/\ndocs/.output/.state/\n.agents/hooks/generated-*.cjs\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    return { root, base: git(root, 'rev-parse', 'HEAD') };
}

const canSymlink = (() => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-scope-symprobe-'));
    try {
        fs.writeFileSync(path.join(r, 'a'), 'x');
        fs.symlinkSync(path.join(r, 'a'), path.join(r, 'b'));
        return true;
    } catch {
        return false;
    } finally {
        fs.rmSync(r, { recursive: true, force: true });
    }
})();

const opts = (extra = {}) => ({ root: REPO_ROOT, target: 'alpha', ...extra });

// ─── AC1: exports and the two lists ──────────────────────────────────────────

describe('exports', () => {
    it('exports_contract_namesAndGlobLists', () => {
        // Arrange / Act
        const names = ['classify', 'assertDiffInScope', 'loadProtectedSet', 'diffFromGit', 'checkDiffInScope'];

        // Assert
        for (const n of names) expect(typeof S[n], n).toBe('function');
        for (const list of [S.EDITABLE_GLOBS, S.PROTECTED_ADDITIONS]) {
            expect(Array.isArray(list)).toBe(true);
            expect(list.length).toBeGreaterThan(0);
            for (const g of list) expect(typeof g === 'string' && g.length > 0).toBe(true);
        }
    });

    it('exports_requireOfModule_doesNotRunCliOrExit', () => {
        // Arrange / Act: a child that only requires it must exit 0 with no output
        const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(MODULE_PATH)})`], { encoding: 'utf8' });

        // Assert
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
    });
});

describe('classify_editableAllowedSet', () => {
    it.each([
        '.agents/skills/alpha/SKILL.md',
        '.agents/skills/alpha/references/workflow.md',
        '.agents/skills/alpha/references/sub/deeper/more.md',
        './.agents/skills/alpha/references/workflow.md',
        '.agents/skills/alpha/references/../SKILL.md',
        '.agents\\skills\\alpha\\SKILL.md',
        'references-guide-not-a-dir/../.agents/skills/alpha/SKILL.md',
    ])('classify_skillBodyOrReference_%s_isEditable', (p) => {
        // Act
        const r = S.classify(p, opts());

        // Assert
        expect(r.class).toBe('editable');
        expect(r.reason).toBe('editable');
    });

    it('classify_eachEditablePathIsEditableForAnySkillWhenNoTargetGiven', () => {
        // Act
        const a = S.classify('.agents/skills/alpha/SKILL.md', { root: REPO_ROOT });
        const b = S.classify('.agents/skills/beta/references/x.md', { root: REPO_ROOT });

        // Assert
        expect(a.class).toBe('editable');
        expect(b.class).toBe('editable');
    });

    it.each([
        ['.agents/skills/beta/SKILL.md', 'another skill'],
        ['.agents/skills/alpha-evil/SKILL.md', 'prefix of the target name'],
        ['.agents/skills/alpha/../beta/SKILL.md', 'traversal into another skill'],
        ['docs/TODO_software-factory.md', 'a planning doc'],
        ['package.json', 'repo root file'],
        ['.agents/core/todo-completion-extra.js', 'core code that is not in any list'],
        ['.claude/skills/alpha/SKILL.md', 'generated projection (canonical source is .agents/)'],
    ])('classify_notInTargetSkill_%s_isOutsideScope (%s)', (p) => {
        // Act
        const r = S.classify(p, opts());

        // Assert
        expect(r.class).toBe('outside');
        expect(r.reason).toBe('outside-scope');
    });

    it.each([
        ['.agents/skills/alpha/references/evals-guide.md'],
        ['.agents/skills/alpha/references/holdout-notes.md'],
        ['.agents/skills/alpha/references/tests.md'],
    ])('classify_nameMerelyContainsProtectedWord_%s_staysEditable', (p) => {
        // Act: segment-boundary matching, so evals-guide.md is not an evals/ directory
        const r = S.classify(p, opts());

        // Assert
        expect(r.class).toBe('editable');
    });
});

describe('classify_bothListsMatch', () => {
    it.each([
        '.agents/skills/alpha/references/__tests__/x.md',
        '.agents/skills/alpha/references/evals/notes.md',
        '.agents/skills/alpha/evals/evals.json',
        '.agents/skills/alpha/references/holdout/set.md',
    ])('classify_editableAndProtectedGlob_%s_isProtected', (p) => {
        // Act
        const r = S.classify(p, opts());

        // Assert
        expect(r.class).toBe('protected');
        expect(r.reason).toBe('protected');
        expect(typeof r.matched).toBe('string');
    });

    it('classify_yamlTierEntryInsideTheSkill_isProtectedDespiteBeingEditableByShape', () => {
        // Arrange: the yaml tier locks one reference file of the target skill
        const root = plainProject([...MIN_TIER, '.agents/skills/alpha/references/locked.md']);

        // Act
        const locked = S.classify('.agents/skills/alpha/references/locked.md', { root, target: 'alpha' });
        const free = S.classify('.agents/skills/alpha/references/free.md', { root, target: 'alpha' });

        // Assert
        expect(locked.class).toBe('protected');
        expect(locked.matched).toBe('.agents/skills/alpha/references/locked.md');
        expect(free.class).toBe('editable');
    });
});

// ─── AC2: protected families ─────────────────────────────────────────────────

describe('classify_protectedFamilies', () => {
    const families = [
        // gate and receipt files
        ['gate', '.agents/core/gate.js'],
        ['gate', '.agents/core/_lib/gate-receipt.js'],
        ['gate', '.agents/core/ship-check.js'],
        ['gate', 'gate.config.json'],
        // hook sources, authored and generated
        ['hooks', '.agents/hooks/path-guardrail.cjs'],
        ['hooks', '.claude/hooks/path-guardrail.cjs'],
        ['hooks', '.codex/hooks/guardrail.cjs'],
        // guardrail rules, authored, rendered and the project override
        ['rules', '.agents/config/guardrail-rules.yaml'],
        ['rules', '.claude/guardrail-rules.yaml'],
        ['rules', '.claude/guardrail-rules.project.yaml'],
        // settings, authored and generated
        ['settings', '.agents/adapters/claude/settings.json'],
        ['settings', '.claude/settings.json'],
        // tests anywhere
        ['tests', '.agents/core/__tests__/improvement-scope.test.js'],
        ['tests', '.agents/hooks/__tests__/path-guardrail.test.js'],
        ['tests', '.agents/core/_lib/__tests__/gate-receipt.test.js'],
        ['tests', 'tools/__tests__/harness-eval.test.js'],
        ['tests', '.agents/skills/alpha/__tests__/anything.js'],
        // judge code
        ['judge', '.agents/core/skill-eval.js'],
        ['judge', '.agents/core/skill-evolution.js'],
        ['judge', '.agents/core/skill-conformance.js'],
        ['judge', '.agents/core/_lib/improvement-scope.js'],
        ['judge', 'tools/harness-eval.js'],
        ['judge', 'tools/fast-tier-eval.cjs'],
        ['judge', '.claude/core/skill-eval.js'],
        // eval tasks and holdout
        ['eval-tasks', '.agents/skills/run-todo/evals/evals.json'],
        ['eval-tasks', '.agents/skills/alpha/evals/files/case.txt'],
        ['eval-tasks', 'tools/harness-eval-tasks/fix-failing-sum/task.json'],
        ['holdout', 'docs/.output/evolution/skills/2026-11-18/alpha-workspace/holdout/evals.json'],
        ['holdout', 'tools/harness-eval-tasks/holdout/case-1/task.json'],
        // grader prompts and scripts under skill-creator
        ['grader', '.agents/skills/skill-creator/agents/grader.md'],
        ['grader', '.agents/skills/skill-creator/agents/comparator.md'],
        ['grader', '.agents/skills/skill-creator/agents/analyzer.md'],
        ['grader', '.agents/skills/skill-creator/scripts/aggregate-benchmark.js'],
        ['grader', '.agents/skills/skill-creator/scripts/utils.js'],
    ];

    it.each(families)('classify_%s_%s_isProtectedWithMatchedGlob', (_family, p) => {
        // Act
        const r = S.classify(p, opts());

        // Assert
        expect(r.class).toBe('protected');
        expect(r.reason).toBe('protected');
        expect(r.path).toBe(p);
        expect(typeof r.matched).toBe('string');
        expect(r.matched.length).toBeGreaterThan(0);
    });

    it.each([
        ['.AGENTS/CORE/GATE.JS'],
        ['.agents/Hooks/Path-Guardrail.cjs'],
        ['.Agents/Skills/alpha/__TESTS__/x.js'],
        ['.agents/skills/alpha/EVALS/evals.json'],
        ['.agents/core/Skill-Eval.JS'],
    ])('classify_caseVariantOfProtectedPath_%s_isProtected', (p) => {
        // Act
        const r = S.classify(p, opts());

        // Assert
        expect(r.class).toBe('protected');
    });
});

// ─── seam: one list, the SF-1.8 tier read from the yaml ───────────────────────

describe('protectedSet', () => {
    it('protectedSet_realYaml_isTierUnionAdditionsWithNoDuplicates', () => {
        // Arrange
        const tier = loadRules(REAL_YAML).subagentReadOnlyPaths;

        // Act
        const set = S.loadProtectedSet({ root: REPO_ROOT });

        // Assert
        expect(tier.length).toBeGreaterThan(0);
        expect(set.tier).toEqual(tier);
        expect(set.additions).toEqual(S.PROTECTED_ADDITIONS);
        expect([...set.globs].sort()).toEqual([...new Set([...tier, ...S.PROTECTED_ADDITIONS])].sort());
        expect(set.globs.length).toBe(new Set(set.globs).size);
    });

    it('protectedSet_everyEntryOfTheRealYamlTier_classifiesProtected', () => {
        // Arrange: derive one path from each SF-1.8 entry (no second hard-coded list)
        const tier = loadRules(REAL_YAML).subagentReadOnlyPaths;

        // Act / Assert
        for (const entry of tier) {
            const p = entry.endsWith('/') ? `${entry}some-file.js` : entry;
            const r = S.classify(p, { root: REPO_ROOT, target: 'alpha' });
            expect(r.class, `${entry} -> ${p}`).toBe('protected');
        }
    });

    it('protectedSet_addingAnEntryToTheYamlTier_changesTheSet_andTheVerdict', () => {
        // Arrange: same path judged against two tiers differing in one entry
        const file = '.agents/skills/alpha/references/secret.md';
        const without = plainProject(MIN_TIER);
        const withEntry = plainProject([...MIN_TIER, file]);

        // Act
        const a = S.classify(file, { root: without, target: 'alpha' });
        const b = S.classify(file, { root: withEntry, target: 'alpha' });

        // Assert
        expect(a.class).toBe('editable');
        expect(b.class).toBe('protected');
        expect(S.loadProtectedSet({ root: without }).globs).not.toContain(file);
        expect(S.loadProtectedSet({ root: withEntry }).globs).toContain(file);
    });

    it('protectedSet_removingATierEntry_makesItsPathStopBeingProtectedByTheTier', () => {
        // Arrange: `gate.config.json` is only protected through the yaml tier here, and the
        // additions do not name it; drop it from the yaml and the verdict must follow the yaml
        const present = plainProject(['gate.config.json']);
        const absent = plainProject(['.agents/hooks/']);

        // Act
        const a = S.classify('gate.config.json', { root: present, target: 'alpha' });
        const b = S.classify('gate.config.json', { root: absent, target: 'alpha' });

        // Assert
        expect(a.class).toBe('protected');
        expect(a.matched).toBe('gate.config.json');
        expect(b.class).not.toBe('protected');
    });

    it('protectedSet_rulesPathOption_winsOverTheDefaultLocation', () => {
        // Arrange: default location has no lock; an explicit rules file does
        const root = plainProject(MIN_TIER);
        const custom = put(root, 'elsewhere/rules.yaml', tierYaml([...MIN_TIER, '.agents/skills/alpha/references/x.md']));

        // Act
        const r = S.classify('.agents/skills/alpha/references/x.md', { root, target: 'alpha', rulesPath: custom });

        // Assert
        expect(r.class).toBe('protected');
    });

    it('protectedSet_noAuthoredYaml_fallsBackToTheRenderedCopyUnderDotClaude', () => {
        // Arrange: an adopter layout has only .claude/guardrail-rules.yaml
        const root = tmpRoot();
        put(root, '.claude/guardrail-rules.yaml', tierYaml([...MIN_TIER, 'locked-by-rendered-copy.txt']));

        // Act
        const r = S.classify('locked-by-rendered-copy.txt', { root, target: 'alpha' });

        // Assert
        expect(r.class).toBe('protected');
    });
});

// ─── AC3: yaml static additions only for grader / holdout / eval paths ───────

describe('yamlStatic', () => {
    const rules = () => loadRules(REAL_YAML);
    const subagentBlocked = (rel) =>
        checkPathAccess(path.join(REPO_ROOT, rel), 'write', rules(), { agentId: 'agent-1' }).allowed === false;
    const mainThreadAllowed = (rel) => checkPathAccess(path.join(REPO_ROOT, rel), 'write', rules()).allowed === true;

    it.each([
        '.agents/skills/skill-creator/agents/grader.md',
        '.agents/skills/skill-creator/agents/comparator.md',
        '.agents/skills/skill-creator/agents/analyzer.md',
        '.agents/skills/skill-creator/scripts/aggregate-benchmark.js',
        '.agents/skills/run-todo/evals/evals.json',
        'tools/harness-eval-tasks/fix-failing-sum/task.json',
        'docs/.output/evolution/skills/2026-11-18/alpha-workspace/holdout/evals.json',
    ])('yamlStatic_graderHoldoutOrEvalTaskPath_%s_blockedByTheYamlForASubagent', (rel) => {
        // Assert: the yaml gains these (nobody legitimately edits them)
        expect(subagentBlocked(rel)).toBe(true);
    });

    it.each([
        '.agents/core/skill-eval.js',
        '.agents/core/skill-evolution.js',
        '.agents/core/skill-conformance.js',
        '.agents/core/_lib/improvement-scope.js',
        'tools/harness-eval.js',
        'tools/fast-tier-eval.cjs',
        '.agents/core/__tests__/improvement-scope.test.js',
        '.agents/core/_lib/__tests__/gate-receipt.test.js',
    ])('yamlStatic_judgeCodeOrTest_%s_isNotInAStaticTier_diffScopeCoversIt', (rel) => {
        // Assert: SF-4.5/4.6/4.9/4.10 edit judge code and the Main Agent edits tests every wave, so a static
        // tier (subagent or main thread) would deadlock them; the diff-scope check is the mechanism
        expect(subagentBlocked(rel)).toBe(false);
        expect(mainThreadAllowed(rel)).toBe(true);
    });
});

// ─── AC4: meta-test over the yaml ────────────────────────────────────────────

describe('metaCoverage', () => {
    // Static protected families by their intended mechanism. 'yaml' rows must be blocked by the
    // yaml for a subagent AND be protected in the diff-scope check; 'diff' rows only the latter.
    const rows = [
        ['yaml', '.agents/skills/skill-creator/agents/grader.md'],
        ['yaml', '.agents/skills/skill-creator/scripts/utils.js'],
        ['yaml', '.agents/skills/council/evals/evals.json'],
        ['yaml', 'tools/harness-eval-tasks/implement-slugify/task.json'],
        ['yaml', 'docs/.output/evolution/skills/2026-11-18/x-workspace/holdout/evals.json'],
        ['diff', '.agents/core/skill-eval.js'],
        ['diff', 'tools/harness-eval.js'],
        ['diff', '.agents/core/__tests__/gate.test.js'],
        ['diff', '.agents/core/_lib/__tests__/gate-receipt.test.js'],
    ];

    it.each(rows)('metaCoverage_%s_%s_coveredByYamlOrDiffScope_neverNeither', (mechanism, rel) => {
        // Arrange
        const rules = loadRules(REAL_YAML);
        const blockedByYaml =
            checkPathAccess(path.join(REPO_ROOT, rel), 'write', rules, { agentId: 'agent-1' }).allowed === false;

        // Act
        const diffScope = S.classify(rel, { root: REPO_ROOT, target: 'alpha' }).class === 'protected';

        // Assert: covered by at least one, and by the one the AC assigns
        expect(blockedByYaml || diffScope).toBe(true);
        expect(diffScope).toBe(true);
        expect(blockedByYaml).toBe(mechanism === 'yaml');
    });

    it('metaCoverage_realYamlStillCarriesTheSf18TierAndParsesAsRules', () => {
        // Arrange
        const rules = loadRules(REAL_YAML);

        // Assert: the loader's parsed flag, so the meta-test cannot pass over an unparsed (empty) rules file
        expect(rules.rulesParsed).toBe(true);
        expect(rules.subagentReadOnlyPaths).toContain('.agents/core/gate.js');
        expect(rules.subagentReadOnlyPaths).toContain('.agents/hooks/');
    });
});

// ─── assertDiffInScope ───────────────────────────────────────────────────────

describe('assertDiffInScope', () => {
    it('assertDiffInScope_skillBodyAndReferenceOnly_passes', () => {
        // Act
        const r = S.assertDiffInScope(
            ['.agents/skills/alpha/SKILL.md', '.agents/skills/alpha/references/workflow.md'],
            opts(),
        );

        // Assert
        expect(r.ok).toBe(true);
        expect(r.violations).toEqual([]);
        expect(r.error).toBeUndefined();
    });

    it('assertDiffInScope_emptyDiff_passesWithNoViolations', () => {
        // Act
        const r = S.assertDiffInScope([], opts());

        // Assert
        expect(r).toMatchObject({ ok: true, violations: [] });
    });

    it('assertDiffInScope_oneProtectedAmongInScope_isRefusedAndNamesOnlyThatPath', () => {
        // Act
        const r = S.assertDiffInScope(
            ['.agents/skills/alpha/SKILL.md', '.agents/core/gate.js', '.agents/skills/alpha/references/a.md'],
            opts(),
        );

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations).toHaveLength(1);
        expect(r.violations[0]).toMatchObject({ path: '.agents/core/gate.js', input: '.agents/core/gate.js', class: 'protected', reason: 'protected' });
        expect(typeof r.violations[0].matched).toBe('string');
    });

    it.each([
        ['gate', '.agents/core/gate.js'],
        ['hook', '.agents/hooks/path-guardrail.cjs'],
        ['rules', '.agents/config/guardrail-rules.yaml'],
        ['settings', '.claude/settings.json'],
        ['test', '.agents/core/__tests__/gate.test.js'],
        ['judge', '.agents/core/skill-eval.js'],
        ['eval task', '.agents/skills/run-todo/evals/evals.json'],
        ['holdout', 'docs/.output/evolution/skills/d/w/holdout/evals.json'],
        ['grader prompt', '.agents/skills/skill-creator/agents/grader.md'],
    ])('assertDiffInScope_diffTouchingA%s_isRefusedWithThePathNamed', (_what, p) => {
        // Act
        const r = S.assertDiffInScope([{ status: 'M', path: p }, '.agents/skills/alpha/SKILL.md'], opts());

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations.map((v) => v.path)).toEqual([p]);
    });

    it('assertDiffInScope_severalViolations_allListedInInputOrder', () => {
        // Act
        const r = S.assertDiffInScope(
            ['.agents/hooks/a.cjs', '.agents/skills/alpha/SKILL.md', 'docs/x.md', '.agents/core/skill-evolution.js'],
            opts(),
        );

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations.map((v) => [v.path, v.reason])).toEqual([
            ['.agents/hooks/a.cjs', 'protected'],
            ['docs/x.md', 'outside-scope'],
            ['.agents/core/skill-evolution.js', 'protected'],
        ]);
    });

    it('assertDiffInScope_otherSkillsFile_isRefusedAsOutsideScope', () => {
        // Act
        const r = S.assertDiffInScope(['.agents/skills/beta/SKILL.md'], opts());

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations).toEqual([
            expect.objectContaining({ path: '.agents/skills/beta/SKILL.md', class: 'outside', reason: 'outside-scope' }),
        ]);
    });

    it.each([
        ['new file', { status: 'A', path: '.agents/skills/alpha/references/new.md' }],
        ['modified', { status: 'M', path: '.agents/skills/alpha/SKILL.md' }],
        ['delete of an editable reference', { status: 'D', path: '.agents/skills/alpha/references/old.md' }],
        ['rename within the editable set', { status: 'R', from: '.agents/skills/alpha/references/a.md', path: '.agents/skills/alpha/references/b.md' }],
    ])('assertDiffInScope_gitShapedEntry_%s_inScopePasses', (_n, entry) => {
        // Act
        const r = S.assertDiffInScope([entry], opts());

        // Assert
        expect(r).toMatchObject({ ok: true, violations: [] });
    });

    it('assertDiffInScope_deleteOfAProtectedFile_isRefusedNamingIt', () => {
        // Act
        const r = S.assertDiffInScope([{ status: 'D', path: '.agents/core/gate.js' }], opts());

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations.map((v) => v.path)).toEqual(['.agents/core/gate.js']);
    });

    it('assertDiffInScope_renameOutOfAProtectedPath_isRefusedAtTheSourceEnd', () => {
        // Act: gate.js "moved" into a reference file is a deletion of the gate
        const r = S.assertDiffInScope(
            [{ status: 'R', from: '.agents/core/gate.js', path: '.agents/skills/alpha/references/gate-copy.md' }],
            opts(),
        );

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations.map((v) => v.path)).toEqual(['.agents/core/gate.js']);
    });

    it('assertDiffInScope_renameIntoAProtectedPath_isRefusedAtTheDestinationEnd', () => {
        // Act
        const r = S.assertDiffInScope(
            [{ status: 'R', from: '.agents/skills/alpha/references/a.md', path: '.agents/hooks/a.cjs' }],
            opts(),
        );

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations.map((v) => v.path)).toEqual(['.agents/hooks/a.cjs']);
    });

    it('assertDiffInScope_copyEntryWithProtectedSource_isRefused', () => {
        // Act
        const r = S.assertDiffInScope(
            [{ status: 'C', from: '.agents/core/skill-eval.js', path: '.agents/skills/alpha/references/e.md' }],
            opts(),
        );

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations.map((v) => v.path)).toEqual(['.agents/core/skill-eval.js']);
    });

    it('assertDiffInScope_pathWithSpacesAndUnicodeInAProtectedDir_isRefusedWithExactPath', () => {
        // Act
        const r = S.assertDiffInScope(['.agents/hooks/my hook é.cjs'], opts());

        // Assert
        expect(r.violations.map((v) => v.path)).toEqual(['.agents/hooks/my hook é.cjs']);
    });
});

// ─── paths: traversal, absolute, outside the repo ────────────────────────────

describe('paths', () => {
    it('paths_dotDotTraversalIntoProtected_isJudgedOnTheNormalizedPath', () => {
        // Act
        const r = S.assertDiffInScope(['.agents/skills/alpha/references/../../../core/gate.js'], opts());

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations).toHaveLength(1);
        expect(r.violations[0].path).toBe('.agents/core/gate.js');
        expect(r.violations[0].input).toBe('.agents/skills/alpha/references/../../../core/gate.js');
        expect(r.violations[0].reason).toBe('protected');
    });

    it.each([
        '../outside.txt',
        '../../etc/passwd',
        '.agents/skills/alpha/../../../../outside.txt',
        '/etc/passwd',
    ])('paths_resolvingOutsideTheRepo_%s_isRefusedAsOutsideRepo', (p) => {
        // Act
        const r = S.classify(p, opts());
        const d = S.assertDiffInScope([p], opts());

        // Assert
        expect(r.class).toBe('outside');
        expect(r.reason).toBe('outside-repo');
        expect(d.ok).toBe(false);
        expect(d.violations[0].reason).toBe('outside-repo');
    });

    it('paths_absolutePathInsideTheRoot_isJudgedLikeItsRelativeForm', () => {
        // Arrange
        const abs = (rel) => path.join(REPO_ROOT, rel);

        // Act
        const prot = S.classify(abs('.agents/core/gate.js'), opts());
        const ok = S.classify(abs('.agents/skills/alpha/SKILL.md'), opts());

        // Assert
        expect(prot.class).toBe('protected');
        expect(prot.path).toBe('.agents/core/gate.js');
        expect(ok.class).toBe('editable');
        expect(ok.path).toBe('.agents/skills/alpha/SKILL.md');
    });

    it('paths_backslashSeparatedProtectedPath_isProtected', () => {
        // Act
        const r = S.classify('.agents\\core\\gate.js', opts());

        // Assert
        expect(r.class).toBe('protected');
        expect(r.path).toBe('.agents/core/gate.js');
    });
});

// ─── symlinks ────────────────────────────────────────────────────────────────

describe('symlink', () => {
    it.skipIf(!canSymlink)('symlink_fileLinkInsideTheEditableDir_isRefused', () => {
        // Arrange: a reference "file" that is a link to the gate
        const root = plainProject();
        put(root, '.agents/core/gate.js', 'gate\n');
        fs.mkdirSync(path.join(root, '.agents/skills/alpha/references'), { recursive: true });
        fs.symlinkSync(path.join(root, '.agents/core/gate.js'), path.join(root, '.agents/skills/alpha/references/link.md'));

        // Act
        const r = S.assertDiffInScope(['.agents/skills/alpha/references/link.md'], { root, target: 'alpha' });

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations).toEqual([
            expect.objectContaining({ path: '.agents/skills/alpha/references/link.md', reason: 'symlink', class: 'protected' }),
        ]);
    });

    it.skipIf(!canSymlink)('symlink_directoryLinkAsAnAncestor_writesThroughItAreRefused', () => {
        // Arrange: references/ is a link to the hooks dir, so references/h.cjs is really a hook
        const root = plainProject();
        put(root, '.agents/hooks/h.cjs', 'hook\n');
        fs.mkdirSync(path.join(root, '.agents/skills/alpha'), { recursive: true });
        fs.symlinkSync(path.join(root, '.agents/hooks'), path.join(root, '.agents/skills/alpha/references'));

        // Act
        const r = S.classify('.agents/skills/alpha/references/h.cjs', { root, target: 'alpha' });

        // Assert
        expect(r.class).toBe('protected');
        expect(r.reason).toBe('symlink');
    });

    it.skipIf(!canSymlink)('symlink_danglingLinkInEditableDir_isRefused', () => {
        // Arrange
        const root = plainProject();
        fs.mkdirSync(path.join(root, '.agents/skills/alpha'), { recursive: true });
        fs.symlinkSync('/nonexistent/target', path.join(root, '.agents/skills/alpha/SKILL.md'));

        // Act
        const r = S.classify('.agents/skills/alpha/SKILL.md', { root, target: 'alpha' });

        // Assert
        expect(r.class).toBe('protected');
        expect(r.reason).toBe('symlink');
    });

    it('symlink_plainFilesInEditableDir_areNotMistakenForLinks', () => {
        // Arrange
        const root = plainProject();
        put(root, '.agents/skills/alpha/SKILL.md', 'body\n');

        // Act
        const r = S.classify('.agents/skills/alpha/SKILL.md', { root, target: 'alpha' });

        // Assert
        expect(r.class).toBe('editable');
    });
});

// ─── fail closed ─────────────────────────────────────────────────────────────

describe('failClosed', () => {
    it.each([
        ['undefined', undefined],
        ['null', null],
        ['object', { path: 1 }],
        ['string', '.agents/skills/alpha/SKILL.md'],
        ['number', 7],
    ])('failClosed_filesNotAnArray_%s_isRefusedWithAnError', (_n, files) => {
        // Act
        const r = S.assertDiffInScope(files, opts());

        // Assert
        expect(r.ok).toBe(false);
        expect(typeof r.error).toBe('string');
        expect(r.error.length).toBeGreaterThan(0);
    });

    it.each([
        ['empty string', ''],
        ['whitespace only', '   '],
        ['NUL byte', '.agents/skills/alpha/SKILL.md\0.js'],
        ['number', 42],
        ['null', null],
        ['entry without a path', { status: 'M' }],
        ['rename without a usable from', { status: 'R', from: 5, path: '.agents/skills/alpha/SKILL.md' }],
        ['empty array', []],
    ])('failClosed_malformedEntry_%s_neverPassesTheWholeDiff', (_n, bad) => {
        // Act
        const r = S.assertDiffInScope(['.agents/skills/alpha/SKILL.md', bad], opts());

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations.length > 0 || typeof r.error === 'string').toBe(true);
    });

    it.each([
        ['undefined', undefined],
        ['empty', ''],
        ['glob star widening to every skill', '*'],
        ['glob pattern', 'alpha*'],
        ['traversal', '../core'],
        ['nested', 'alpha/references'],
        ['backslash', 'alpha\\x'],
        ['dot', '.'],
        ['non-string', 7],
    ])('failClosed_badTarget_%s_isRefusedWithAnError', (_n, target) => {
        // Act
        const r = S.assertDiffInScope(['.agents/skills/alpha/SKILL.md'], { root: REPO_ROOT, target });

        // Assert
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/target/i);
    });

    it('failClosed_exceptionInsideClassify_viaThrowingEntry_refusesAndDoesNotThrow', () => {
        // Arrange: an entry whose `path` getter throws mid-classification
        const evil = { status: 'M', get path() { throw new Error('boom'); } };

        // Act
        const r = S.assertDiffInScope(['.agents/skills/alpha/SKILL.md', evil], opts());

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations.length > 0 || typeof r.error === 'string').toBe(true);
    });

    it('failClosed_classifyWithAThrowingToString_returnsProtectedClassifyError', () => {
        // Arrange
        const evil = { toString() { throw new Error('boom'); } };

        // Act
        const r = S.classify(evil, opts());

        // Assert
        expect(r.class).toBe('protected');
        expect(r.reason).toBe('classify-error');
    });

    it.each([
        ['empty string', ''],
        ['NUL byte', 'a\0b'],
        ['undefined', undefined],
        ['number', 3],
    ])('failClosed_classifyInvalidPath_%s_isProtectedInvalidPath', (_n, p) => {
        // Act
        const r = S.classify(p, opts());

        // Assert
        expect(r.class).toBe('protected');
        expect(r.reason).toBe('invalid-path');
    });

    it('failClosed_malformedRulesYaml_everyPathIsRefusedAndLoadThrows', () => {
        // Arrange: unparseable rules; no fallback list may silently allow anything
        const root = tmpRoot();
        put(root, '.agents/config/guardrail-rules.yaml', ': this is not a rules file\n  - [unclosed\n');

        // Act
        const cls = S.classify('.agents/skills/alpha/SKILL.md', { root, target: 'alpha' });
        const diff = S.assertDiffInScope(['.agents/skills/alpha/SKILL.md'], { root, target: 'alpha' });

        // Assert
        expect(cls.class).toBe('protected');
        expect(diff.ok).toBe(false);
        expect(typeof diff.error).toBe('string');
        expect(() => S.loadProtectedSet({ root })).toThrow();
    });

    it('failClosed_missingRulesFile_isRefusedNotTreatedAsNoRules', () => {
        // Arrange
        const root = tmpRoot();

        // Act
        const diff = S.assertDiffInScope(['.agents/skills/alpha/SKILL.md'], { root, target: 'alpha' });

        // Assert
        expect(diff.ok).toBe(false);
        expect(typeof diff.error).toBe('string');
        expect(() => S.loadProtectedSet({ root })).toThrow();
    });

    it.each([
        ['tier key absent', 'zeroAccessPaths:\n  - .env\n'],
        ['tier present but empty', 'subagentReadOnlyPaths: []\n'],
        ['tier with a non-string item', 'subagentReadOnlyPaths:\n  - gate.config.json\n  - { nested: map }\n'],
        ['tier is a scalar', 'subagentReadOnlyPaths: gate.config.json\n'],
    ])('failClosed_malformedList_%s_isRefused', (_n, yaml) => {
        // Arrange
        const root = tmpRoot();
        put(root, '.agents/config/guardrail-rules.yaml', yaml);

        // Act
        const diff = S.assertDiffInScope(['.agents/skills/alpha/SKILL.md'], { root, target: 'alpha' });

        // Assert
        expect(diff.ok).toBe(false);
        expect(typeof diff.error).toBe('string');
        expect(() => S.loadProtectedSet({ root })).toThrow();
    });
});

// ─── git: Bash writes caught after the fact ──────────────────────────────────

describe('git', () => {
    const check = (root, base, extra = {}) => S.checkDiffInScope({ root, base, target: 'alpha', ...extra });

    it('git_noChanges_passesWithNoViolations', () => {
        // Arrange
        const { root, base } = gitProject();

        // Act
        const r = check(root, base);

        // Assert
        expect(r).toMatchObject({ ok: true, violations: [] });
    });

    it('git_inScopeEditsAndNewReference_passes', () => {
        // Arrange
        const { root, base } = gitProject();
        put(root, '.agents/skills/alpha/SKILL.md', 'alpha body v2\n');
        put(root, '.agents/skills/alpha/references/new-bullet.md', 'new\n');

        // Act
        const r = check(root, base);

        // Assert
        expect(r).toMatchObject({ ok: true, violations: [] });
    });

    it('git_uncommittedBashWriteToAHook_isCaught', () => {
        // Arrange: the write a Bash `echo >> hook` would leave behind (never staged)
        const { root, base } = gitProject();
        fs.appendFileSync(path.join(root, '.agents/hooks/h.cjs'), 'process.exit(0)\n');
        put(root, '.agents/skills/alpha/SKILL.md', 'ok edit\n');

        // Act
        const r = check(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations.map((v) => v.path)).toEqual(['.agents/hooks/h.cjs']);
    });

    it('git_stagedChangeToTheGate_isCaught', () => {
        // Arrange
        const { root, base } = gitProject();
        put(root, '.agents/core/gate.js', 'gate v2\n');
        git(root, 'add', '.agents/core/gate.js');

        // Act
        const r = check(root, base);

        // Assert
        expect(r.violations.map((v) => v.path)).toEqual(['.agents/core/gate.js']);
    });

    it('git_changeCommittedAfterBase_isCaught', () => {
        // Arrange
        const { root, base } = gitProject();
        put(root, '.agents/core/skill-eval.js', 'judge v2\n');
        git(root, 'commit', '-q', '-am', 'weaken the judge');

        // Act
        const r = check(root, base);

        // Assert
        expect(r.violations.map((v) => v.path)).toEqual(['.agents/core/skill-eval.js']);
    });

    it('git_untrackedNewFileInAProtectedDir_isCaught', () => {
        // Arrange: a brand-new test file git has never seen
        const { root, base } = gitProject();
        put(root, '.agents/core/__tests__/evil.test.js', 'it("x",()=>{})\n');

        // Act
        const r = check(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations.map((v) => v.path)).toEqual(['.agents/core/__tests__/evil.test.js']);
    });

    it('git_untrackedFileOutsideAnyScope_isCaughtAsOutsideScope', () => {
        // Arrange
        const { root, base } = gitProject();
        put(root, 'scratch.sh', 'echo hi\n');

        // Act
        const r = check(root, base);

        // Assert
        expect(r.violations).toEqual([expect.objectContaining({ path: 'scratch.sh', reason: 'outside-scope' })]);
    });

    it('git_deletedProtectedFile_isCaught', () => {
        // Arrange
        const { root, base } = gitProject();
        fs.rmSync(path.join(root, '.agents/core/gate.js'));

        // Act
        const r = check(root, base);

        // Assert
        expect(r.violations.map((v) => v.path)).toEqual(['.agents/core/gate.js']);
    });

    it('git_gateMovedIntoAReferenceFile_isCaughtWhetherGitCallsItRenameOrDeletePlusAdd', () => {
        // Arrange
        const { root, base } = gitProject();
        git(root, 'mv', '.agents/core/gate.js', '.agents/skills/alpha/references/gate-copy.md');

        // Act
        const r = check(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations.map((v) => v.path)).toContain('.agents/core/gate.js');
    });

    it('git_ignoredFileWrittenInAProtectedDir_isCaughtDespiteTheIgnoreRule', () => {
        // Arrange: .gitignore ignores .agents/hooks/generated-*.cjs, so plain diff/untracked output hides it
        const { root, base } = gitProject();
        put(root, '.agents/hooks/generated-evil.cjs', 'process.exit(0)\n');
        expect(git(root, 'status', '--porcelain', '--', '.agents/hooks')).toBe('');

        // Act
        const r = check(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations.map((v) => v.path)).toEqual(['.agents/hooks/generated-evil.cjs']);
    });

    it('git_ignoredFilesOutsideTheProtectedSet_doNotCauseViolations', () => {
        // Arrange: node_modules and .state are ignored build/telemetry output, not edits
        const { root, base } = gitProject();
        put(root, 'node_modules/pkg/index.js', 'x\n');
        put(root, 'docs/.output/.state/telemetry/t.json', '{}\n');
        put(root, '.agents/skills/alpha/SKILL.md', 'edit\n');

        // Act
        const r = check(root, base);

        // Assert
        expect(r).toMatchObject({ ok: true, violations: [] });
    });

    it('git_pathsWithSpacesAndUnicode_areReportedExactly', () => {
        // Arrange: -z parsing, not quoted output
        const { root, base } = gitProject();
        put(root, '.agents/hooks/my hook é.cjs', 'x\n');

        // Act
        const r = check(root, base);

        // Assert
        expect(r.violations.map((v) => v.path)).toEqual(['.agents/hooks/my hook é.cjs']);
    });

    it('git_diffFromGit_returnsNameStatusEntriesAndUntrackedAsAdded', () => {
        // Arrange
        const { root, base } = gitProject();
        put(root, '.agents/skills/alpha/SKILL.md', 'edit\n');
        fs.rmSync(path.join(root, 'docs/notes.md'));
        put(root, 'brand-new.txt', 'n\n');

        // Act
        const entries = S.diffFromGit(base, { root });
        const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));

        // Assert
        expect(entries).toHaveLength(3);
        expect(byPath['.agents/skills/alpha/SKILL.md'].status).toBe('M');
        expect(byPath['docs/notes.md'].status).toBe('D');
        expect(byPath['brand-new.txt']).toMatchObject({ status: 'A', untracked: true });
    });

    it('git_unknownBase_failsClosedWithAnErrorAndNoViolationsClaimedAsPass', () => {
        // Arrange
        const { root } = gitProject();

        // Act
        const r = check(root, 'does-not-exist-ref');

        // Assert
        expect(r.ok).toBe(false);
        expect(typeof r.error).toBe('string');
        expect(() => S.diffFromGit('does-not-exist-ref', { root })).toThrow();
    });

    it('git_notAGitRepo_failsClosed', () => {
        // Arrange
        const root = plainProject();

        // Act
        const r = check(root, 'HEAD');

        // Assert
        expect(r.ok).toBe(false);
        expect(typeof r.error).toBe('string');
    });

    it.each([
        ['option-looking base', '--output=INJECTED'],
        ['empty base', ''],
        ['non-string base', 5],
    ])('git_%s_isRefusedWithoutRunningGitWithIt', (_n, base) => {
        // Arrange
        const { root } = gitProject();

        // Act
        const r = check(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(typeof r.error).toBe('string');
        expect(fs.existsSync(path.join(root, 'INJECTED'))).toBe(false);
        expect(() => S.diffFromGit(base, { root })).toThrow();
    });

    it('git_badTarget_failsClosedEvenWhenTheDiffIsEmpty', () => {
        // Arrange
        const { root, base } = gitProject();

        // Act
        const r = S.checkDiffInScope({ root, base, target: '*' });

        // Assert
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/target/i);
    });

    it('git_unusableRules_failsClosedEvenWhenTheDiffIsEmpty', () => {
        // Arrange
        const { root, base } = gitProject();
        put(root, '.agents/config/guardrail-rules.yaml', ': broken\n  - [\n');
        git(root, 'commit', '-q', '-am', 'break rules');
        const newBase = git(root, 'rev-parse', 'HEAD');

        // Act
        const r = check(root, newBase);

        // Assert
        expect(base).not.toBe(newBase);
        expect(r.ok).toBe(false);
        expect(typeof r.error).toBe('string');
    });
});

// ─── wave 8 security review: the diff must not be blindable (C2, M8, M9, M10, m6) ─────

function commitAll(root, message = 'more') {
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', message);
    return git(root, 'rev-parse', 'HEAD');
}

const checkAt = (root, base, extra = {}) => S.checkDiffInScope({ root, base, target: 'alpha', ...extra });
const pathsFor = (r, reason) => r.violations.filter((v) => v.reason === reason).map((v) => v.path);

describe('C2_symbolicBase', () => {
    it.each([
        ['HEAD'],
        ['main'],
        ['HEAD~0'],
        ['abc1234'],
        ['A'.repeat(40)],
    ])('C2_base_%s_isRefusedAsNotAFullLowercaseHexCommitId', (symbolic) => {
        // Arrange
        const { root } = gitProject();

        // Act
        const r = checkAt(root, symbolic);

        // Assert
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/commit id/);
        expect(() => S.diffFromGit(symbolic, { root })).toThrow(/commit id/);
    });

    it('C2_runCommitsOntoTheBranchNamedAsBase_isRefusedWhereTheBranchNameWouldShowAnEmptyDiff', () => {
        // Arrange: the weakened judge is committed to `main`; `--base main` would diff main against itself
        const { root, base } = gitProject();
        put(root, '.agents/core/skill-eval.js', 'judge weakened\n');
        commitAll(root, 'weaken');

        // Act
        const symbolic = checkAt(root, 'main');
        const recorded = checkAt(root, base);

        // Assert
        expect(symbolic.ok).toBe(false);
        expect(typeof symbolic.error).toBe('string');
        expect(recorded.violations.map((v) => v.path)).toEqual(['.agents/core/skill-eval.js']);
    });

    it('C2_wellFormedIdThatIsNoObject_throwsFromGit', () => {
        // Arrange
        const { root } = gitProject();

        // Act / Assert
        expect(() => S.diffFromGit('0'.repeat(40), { root })).toThrow();
        expect(checkAt(root, '0'.repeat(40)).ok).toBe(false);
    });

    it('C2_treeIdIsNotACommit', () => {
        // Arrange
        const { root } = gitProject();
        const tree = git(root, 'rev-parse', 'HEAD^{tree}');

        // Act / Assert
        expect(tree).toMatch(/^[0-9a-f]{40}$/);
        expect(() => S.diffFromGit(tree, { root })).toThrow();
        expect(checkAt(root, tree).ok).toBe(false);
    });
});

describe('C2_indexFlags', () => {
    it.each([
        ['assume-unchanged', '--assume-unchanged', 'h'],
        ['skip-worktree', '--skip-worktree', 'S'],
    ])('C2_%s_onWeakenedJudge_isRefusedAndTheEditIsStillNamed', (_name, flag, tag) => {
        // Arrange: git diff cannot see the edit once the flag is set
        const { root, base } = gitProject();
        git(root, 'update-index', flag, '.agents/core/skill-eval.js');
        put(root, '.agents/core/skill-eval.js', 'judge weakened\n');
        expect(git(root, 'diff', '--name-only', base)).toBe('');

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations.filter((v) => v.reason === 'index-flag')).toEqual([
            expect.objectContaining({ path: '.agents/core/skill-eval.js', class: 'protected', tag }),
        ]);
        expect(pathsFor(r, 'protected')).toEqual(['.agents/core/skill-eval.js']);
    });

    it('C2_assumeUnchangedOnAnEvalFile_isRefusedWhenTheEvalWasMadeEasier', () => {
        // Arrange: an eval file under the target skill, protected by the yaml tier
        const { root } = gitProject([...MIN_TIER, 'evals/']);
        put(root, '.agents/skills/alpha/evals/evals.json', '{"hard":true}\n');
        const base = commitAll(root, 'eval');
        git(root, 'update-index', '--assume-unchanged', '.agents/skills/alpha/evals/evals.json');
        put(root, '.agents/skills/alpha/evals/evals.json', '{"hard":false}\n');

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(pathsFor(r, 'protected')).toEqual(['.agents/skills/alpha/evals/evals.json']);
    });

    it.each([
        ['skip-worktree', '--skip-worktree'],
        ['assume-unchanged', '--assume-unchanged'],
    ])('C2_%s_onAnUntouchedEditableFile_isStillRefused', (_name, flag) => {
        // Arrange: any non-H tag is tamper, whatever the file
        const { root, base } = gitProject();
        git(root, 'update-index', flag, '.agents/skills/alpha/SKILL.md');

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(pathsFor(r, 'index-flag')).toEqual(['.agents/skills/alpha/SKILL.md']);
    });

    it('C2_cleanIndex_hasNoIndexFlagViolation', () => {
        // Arrange
        const { root, base } = gitProject();

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(pathsFor(r, 'index-flag')).toEqual([]);
    });
});

describe('C2_replaceRefs', () => {
    it('C2_replaceRefAimedAtTheBase_isRefusedAndTheRealDiffStillShowsTheWeakenedJudge', () => {
        // Arrange: commit the weakened judge, then make the base commit "be" that commit
        const { root, base } = gitProject();
        put(root, '.agents/core/skill-eval.js', 'judge weakened\n');
        const evil = commitAll(root, 'weaken');
        git(root, 'replace', base, evil);

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(pathsFor(r, 'replace-ref')).toEqual([`refs/replace/${base}`]);
        expect(pathsFor(r, 'protected')).toEqual(['.agents/core/skill-eval.js']);
    });
});

describe('C2_filtersAndBytesOnDisk', () => {
    // A clean filter makes `git diff` hash the base content for a tampered file.
    function filteredJudge() {
        const { root, base } = gitProject();
        git(root, 'config', 'filter.hide.clean', 'cat >/dev/null; echo "judge v1"');
        fs.appendFileSync(path.join(root, '.git', 'info', 'attributes'), '.agents/core/skill-eval.js filter=hide\n');
        put(root, '.agents/core/skill-eval.js', 'judge weakened\n');
        return { root, base };
    }

    it.skipIf(process.platform === 'win32')('C2_cleanFilterHidingAWeakenedJudge_isRefusedByConfigAndByTheBytesOnDisk', () => {
        // Arrange
        const { root, base } = filteredJudge();
        expect(git(root, 'diff', '--name-only', base)).toBe('');

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(pathsFor(r, 'git-config')).toEqual(['.git/config:filter.hide.clean', '.git/config:info/attributes']);
        expect(pathsFor(r, 'protected')).toEqual(['.agents/core/skill-eval.js']);
    });

    it.skipIf(process.platform === 'win32')('C2_filterAlreadyInTheBaseline_isToleratedButTheWeakenedBytesStillRefuse', () => {
        // Arrange: LFS-style repos carry filters legitimately; the baseline records them at run start
        const { root, base } = gitProject();
        git(root, 'config', 'filter.hide.clean', 'cat >/dev/null; echo "judge v1"');
        fs.appendFileSync(path.join(root, '.git', 'info', 'attributes'), '.agents/core/skill-eval.js filter=hide\n');
        const snap = S.snapshot({ root, base });
        put(root, '.agents/core/skill-eval.js', 'judge weakened\n');

        // Act
        const r = checkAt(root, base, { baseline: snap.baseline });

        // Assert
        expect(pathsFor(r, 'git-config')).toEqual([]);
        expect(pathsFor(r, 'protected')).toEqual(['.agents/core/skill-eval.js']);
    });

    it('C2_hooksPathAndAttributesFileConfig_areRefused', () => {
        // Arrange
        const { root, base } = gitProject();
        git(root, 'config', 'core.hooksPath', '/tmp/evil-hooks');
        git(root, 'config', 'core.attributesFile', '/tmp/evil-attributes');

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(pathsFor(r, 'git-config').sort()).toEqual(['.git/config:core.attributesfile', '.git/config:core.hookspath']);
    });

    it('C2_noRiskyConfig_hasNoConfigViolation', () => {
        // Arrange
        const { root, base } = gitProject();

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(pathsFor(r, 'git-config')).toEqual([]);
    });

    it('C2_tamperedProtectedFileWithItsStatRefreshedToLookClean_isStillCaughtByTheBytes', () => {
        // Arrange: a protected file edited, then committed in the index only (git add) so every git view agrees
        // with the working tree; the base blob differs, so the edit is committed-after-base (a diff entry, not a byte one)
        const { root, base } = gitProject();
        put(root, '.agents/hooks/h.cjs', 'hook weakened\n');
        git(root, 'add', '.agents/hooks/h.cjs');

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(pathsFor(r, 'protected')).toEqual(['.agents/hooks/h.cjs']);
    });

    it('C2_lineEndingConversionAlone_isNotAnEdit', () => {
        // Arrange: `text eol=crlf` makes a clean checkout CRLF on disk while the blob is LF
        const { root } = gitProject();
        put(root, '.gitattributes', 'docs/notes.md text eol=crlf\n');
        const base = commitAll(root, 'attrs');
        fs.rmSync(path.join(root, 'docs/notes.md'));
        git(root, 'checkout', '--', 'docs/notes.md');
        expect(fs.readFileSync(path.join(root, 'docs/notes.md'), 'utf8')).toBe('notes\r\n');

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(r).toMatchObject({ ok: true, violations: [] });
    });

    it('C2_realEditToANonEditableTrackedFile_isNotMistakenForLineEndings', () => {
        // Arrange
        const { root, base } = gitProject();
        put(root, 'docs/notes.md', 'notes changed\r\n');

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(pathsFor(r, 'outside-scope')).toEqual(['docs/notes.md']);
    });
});

describe('M8_ignoredExcludedAndNestedRepos', () => {
    const lockOf = (packages) => JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' }, ...packages } });

    it('M8_patchedNodeModulesPackageVersion_isRefusedAsDrift', () => {
        // Arrange
        const { root } = gitProject();
        put(root, 'package-lock.json', lockOf({
            'node_modules/foo': { version: '1.0.0' },
            'node_modules/skipped-optional': { version: '2.0.0', optional: true },
        }));
        const base = commitAll(root, 'lock');
        put(root, 'node_modules/foo/package.json', JSON.stringify({ name: 'foo', version: '1.0.0' }));
        const clean = checkAt(root, base);
        put(root, 'node_modules/foo/package.json', JSON.stringify({ name: 'foo', version: '1.0.1-patched' }));

        // Act
        const drifted = checkAt(root, base);

        // Assert
        expect(clean).toMatchObject({ ok: true, violations: [] });
        expect(drifted.ok).toBe(false);
        expect(drifted.violations).toEqual([
            expect.objectContaining({ path: 'node_modules/foo', reason: 'node-modules-drift', locked: '1.0.0', installed: '1.0.1-patched' }),
        ]);
    });

    it('M8_unreadableLockfile_failsClosedAsUnverifiable', () => {
        // Arrange
        const { root } = gitProject();
        put(root, 'package-lock.json', '{ not json');
        const base = commitAll(root, 'bad lock');
        put(root, 'node_modules/foo/package.json', '{}\n');

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(pathsFor(r, 'node-modules-unverifiable')).toEqual(['package-lock.json']);
    });

    it('M8_noNodeModulesOrNoLock_isNotACheckFailure', () => {
        // Arrange
        const { root, base } = gitProject();

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(r).toMatchObject({ ok: true, violations: [] });
    });

    it('M8_newProtectedFileHiddenByGitInfoExclude_isStillReported', () => {
        // Arrange
        const { root, base } = gitProject();
        fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), 'planted-judge-helper.cjs\n');
        put(root, '.agents/hooks/planted-judge-helper.cjs', 'process.exit(0)\n');
        expect(git(root, 'status', '--porcelain', '--', '.agents/hooks')).toBe('');

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(pathsFor(r, 'protected')).toEqual(['.agents/hooks/planted-judge-helper.cjs']);
    });

    it('M8_coreExcludesFileInTheGlobalConfig_doesNotHideAPlantedFile', () => {
        // Arrange: a repo-local core.excludesFile is the run's to write as well
        const { root, base } = gitProject();
        put(root, '.git/my-excludes', 'planted2.cjs\n');
        git(root, 'config', 'core.excludesFile', path.join(root, '.git/my-excludes'));
        put(root, '.agents/hooks/planted2.cjs', 'x\n');

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(pathsFor(r, 'protected')).toEqual(['.agents/hooks/planted2.cjs']);
    });

    it('M8_nestedRepoUnderTheEditableSkill_isRefused', () => {
        // Arrange: git reports only `vendor/`, which is editable by shape; its test files are never listed
        const { root, base } = gitProject();
        git(root, 'init', '-q', path.join(root, '.agents/skills/alpha/vendor'));
        put(root, '.agents/skills/alpha/vendor/__tests__/x.test.js', 'it("x",()=>{})\n');
        put(root, '.agents/skills/alpha/vendor/evals/evals.json', '{}\n');

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(pathsFor(r, 'nested-repo')).toEqual(['.agents/skills/alpha/vendor/']);
    });

    it('M8_gitlinkAddedToTheIndex_isRefused', () => {
        // Arrange
        const { root, base } = gitProject();
        git(root, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},.agents/skills/alpha/sub`);

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(pathsFor(r, 'nested-repo')).toEqual(['.agents/skills/alpha/sub']);
    });

    it('M8_gitlinkAlreadyInTheBase_isNotAViolation', () => {
        // Arrange: a project that really uses a submodule
        const { root } = gitProject();
        git(root, 'update-index', '--add', '--cacheinfo', `160000,${'b'.repeat(40)},third-party/lib`);
        git(root, 'commit', '-q', '-m', 'submodule');
        const base = git(root, 'rev-parse', 'HEAD');

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(pathsFor(r, 'nested-repo')).toEqual([]);
    });

    it('M8_plantedIgnoreFileThatHidesItselfAndAProtectedFile_isRefused', () => {
        // Arrange: a `*` .gitignore ignores itself and everything beside it
        const { root, base } = gitProject();
        put(root, '.agents/hooks/.gitignore', '*\n');
        put(root, '.agents/hooks/hidden-hook.cjs', 'x\n');

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(pathsFor(r, 'planted-ignore-file')).toEqual(['.agents/hooks/.gitignore']);
        expect(pathsFor(r, 'protected').sort()).toEqual(['.agents/hooks/.gitignore', '.agents/hooks/hidden-hook.cjs']);
    });
});

describe('M2_baselineOfIgnoredProtectedFiles', () => {
    const STATE = '.agents/hooks/generated-state.cjs';

    it('M2_snapshotRecordsTheIgnoredProtectedFileAsSha256', () => {
        // Arrange
        const { root, base } = gitProject();
        put(root, STATE, 'state v1\n');

        // Act
        const snap = S.snapshot({ root, base });

        // Assert
        expect(snap.ok).toBe(true);
        expect(snap.baseline).toEqual({
            version: 1,
            base,
            ignoredProtected: { [STATE]: expect.stringMatching(/^[0-9a-f]{64}$/) },
            config: [],
            nestedRepos: [],
            ignoreFiles: {},
        });
    });

    it('M2_preExistingIgnoredProtectedFile_isAViolationWithoutABaselineAndFineWithOne', () => {
        // Arrange
        const { root, base } = gitProject();
        put(root, STATE, 'state v1\n');
        const snap = S.snapshot({ root, base });

        // Act
        const without = checkAt(root, base);
        const withBaseline = checkAt(root, base, { baseline: snap.baseline });

        // Assert
        expect(pathsFor(without, 'protected')).toEqual([STATE]);
        expect(withBaseline).toMatchObject({ ok: true, violations: [] });
    });

    it('M2_changedIgnoredProtectedFile_isRefusedAgainstTheBaseline', () => {
        // Arrange
        const { root, base } = gitProject();
        put(root, STATE, 'state v1\n');
        const snap = S.snapshot({ root, base });
        put(root, STATE, 'state forged\n');

        // Act
        const r = checkAt(root, base, { baseline: snap.baseline });

        // Assert
        expect(r.ok).toBe(false);
        expect(pathsFor(r, 'protected')).toEqual([STATE]);
    });

    it('M2_newIgnoredProtectedFile_isRefusedAgainstTheBaseline', () => {
        // Arrange
        const { root, base } = gitProject();
        const snap = S.snapshot({ root, base });
        put(root, '.agents/hooks/generated-new.cjs', 'x\n');

        // Act
        const r = checkAt(root, base, { baseline: snap.baseline });

        // Assert
        expect(pathsFor(r, 'protected')).toEqual(['.agents/hooks/generated-new.cjs']);
    });

    it('M2_deletedIgnoredProtectedFile_isRefusedAgainstTheBaseline', () => {
        // Arrange: a deleted gate receipt or ledger is as much a write as a forged one
        const { root, base } = gitProject();
        put(root, STATE, 'state v1\n');
        const snap = S.snapshot({ root, base });
        fs.rmSync(path.join(root, STATE));

        // Act
        const r = checkAt(root, base, { baseline: snap.baseline });

        // Assert
        expect(pathsFor(r, 'protected')).toEqual([STATE]);
    });

    it('M2_ignoredFilesOutsideTheProtectedSet_areNotInTheBaseline', () => {
        // Arrange
        const { root, base } = gitProject();
        put(root, 'node_modules/pkg/index.js', 'x\n');
        put(root, 'docs/.output/.state/telemetry/t.json', '{}\n');

        // Act
        const snap = S.snapshot({ root, base });

        // Assert
        expect(snap.baseline.ignoredProtected).toEqual({});
    });

    it('M2_preExistingIgnoredNestedRepo_isToleratedWithABaselineAndANewOneIsNot', () => {
        // Arrange: a workshop keeps scratch repos under its ignored state directory
        const { root, base } = gitProject();
        git(root, 'init', '-q', path.join(root, 'docs/.output/.state/work/old/repo'));
        const snap = S.snapshot({ root, base });
        git(root, 'init', '-q', path.join(root, 'docs/.output/.state/work/new/repo'));

        // Act
        const without = checkAt(root, base);
        const withBaseline = checkAt(root, base, { baseline: snap.baseline });

        // Assert
        expect(snap.baseline.nestedRepos).toEqual(['docs/.output/.state/work/old/repo/']);
        expect(pathsFor(without, 'nested-repo').sort()).toEqual(['docs/.output/.state/work/new/repo/', 'docs/.output/.state/work/old/repo/']);
        expect(pathsFor(withBaseline, 'nested-repo')).toEqual(['docs/.output/.state/work/new/repo/']);
    });

    it('M2_preExistingIgnoreFile_isToleratedUntilItsBytesChange', () => {
        // Arrange
        const { root, base } = gitProject();
        const ignoreFile = 'docs/.output/.state/work/old/.gitignore';
        put(root, ignoreFile, 'dist/\n');
        const snap = S.snapshot({ root, base });
        const same = checkAt(root, base, { baseline: snap.baseline });
        put(root, ignoreFile, '*\n');

        // Act
        const changed = checkAt(root, base, { baseline: snap.baseline });

        // Assert
        expect(snap.baseline.ignoreFiles).toEqual({ [ignoreFile]: expect.stringMatching(/^[0-9a-f]{64}$/) });
        expect(same).toMatchObject({ ok: true, violations: [] });
        expect(pathsFor(changed, 'planted-ignore-file')).toEqual([ignoreFile]);
    });

    it('M2_baselineTakenAtAnotherBase_isRefused', () => {
        // Arrange
        const { root, base } = gitProject();
        const snap = S.snapshot({ root, base });
        put(root, 'docs/notes.md', 'notes v2\n');
        const newBase = commitAll(root, 'next');

        // Act
        const r = checkAt(root, newBase, { baseline: snap.baseline });

        // Assert
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/baseline/);
    });

    it.each([
        ['unreadable file', null],
        ['wrong version', { version: 2 }],
        ['hash not a string', { ignoredProtected: { a: 5 } }],
        ['config not a list', { config: 'x' }],
        ['nestedRepos not a list', { nestedRepos: 'x' }],
        ['ignoreFiles hash not a string', { ignoreFiles: { a: 1 } }],
    ])('M2_malformedBaseline_%s_isRefused', (_name, bad) => {
        // Arrange
        const { root, base } = gitProject();

        // Act
        const valid = { version: 1, base, ignoredProtected: {}, config: [], nestedRepos: [], ignoreFiles: {} };
        const r = checkAt(root, base, { baseline: bad === null ? '/nonexistent/baseline.json' : { ...valid, ...bad } });

        // Assert
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/baseline/);
    });

    it('M2_snapshotWithASymbolicBase_isRefused', () => {
        // Arrange
        const { root } = gitProject();

        // Act
        const r = S.snapshot({ root, base: 'HEAD' });

        // Assert
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/commit id/);
    });

    describe('cli', () => {
        const run = (args) => {
            const r = spawnSync(process.execPath, [MODULE_PATH, ...args], { encoding: 'utf8' });
            let json = null;
            try { json = JSON.parse(r.stdout); } catch { /* leave null */ }
            return { status: r.status, json, stderr: r.stderr };
        };

        it('M2_cliSnapshotOutThenCheckBaseline_passesOnTheUnchangedIgnoredFile', () => {
            // Arrange
            const { root, base } = gitProject();
            put(root, STATE, 'state v1\n');
            const out = path.join(tmpRoot('imp-scope-baseline-'), 'baseline.json');

            // Act
            const snap = run(['snapshot', '--base', base, '--root', root, '--out', out]);
            const plain = run(['check', '--base', base, '--target', 'alpha', '--root', root]);
            const based = run(['check', '--base', base, '--target', 'alpha', '--root', root, '--baseline', out]);
            fs.writeFileSync(path.join(root, STATE), 'forged\n');
            const forged = run(['check', '--base', base, '--target', 'alpha', '--root', root, '--baseline', out]);

            // Assert
            expect(snap.status).toBe(0);
            expect(snap.json).toEqual({ ok: true, out, ignoredProtected: 1 });
            expect(JSON.parse(fs.readFileSync(out, 'utf8')).base).toBe(base);
            expect(plain.status).toBe(1);
            expect(based.status).toBe(0);
            expect(forged.status).toBe(1);
        });

        it('M2_cliSnapshotWithoutOut_printsTheBaseline', () => {
            // Arrange
            const { root, base } = gitProject();

            // Act
            const r = run(['snapshot', '--base', base, '--root', root]);

            // Assert
            expect(r.status).toBe(0);
            expect(r.json.baseline).toMatchObject({ version: 1, base, ignoredProtected: {}, config: [] });
        });

        it.each([
            ['missing --base', (root) => ['snapshot', '--root', root]],
            ['symbolic base', (root) => ['snapshot', '--base', 'HEAD', '--root', root]],
            ['--target is not a snapshot flag', (root, base) => ['snapshot', '--base', base, '--root', root, '--target', 'alpha']],
            ['unreadable baseline for check', (root, base) => ['check', '--base', base, '--target', 'alpha', '--root', root, '--baseline', '/nonexistent/b.json']],
            ['--out is not a check flag', (root, base) => ['check', '--base', base, '--target', 'alpha', '--root', root, '--out', 'x']],
        ])('M2_cli_%s_exits2', (_name, argv) => {
            // Arrange
            const { root, base } = gitProject();

            // Act
            const r = run(argv(root, base));

            // Assert
            expect(r.status).toBe(2);
        });
    });
});

describe('M9_rulesComeFromTheBaseCommit', () => {
    it('M9_runThatEmptiesTheTierInTheWorkingTree_isStillJudgedByTheBaseTier', () => {
        // Arrange: the run drops `.agents/hooks/` from the rules file, then edits a hook
        const { root, base } = gitProject();
        put(root, '.agents/config/guardrail-rules.yaml', tierYaml(['gate.config.json']));
        fs.appendFileSync(path.join(root, '.agents/hooks/h.cjs'), 'process.exit(0)\n');

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(pathsFor(r, 'protected').sort()).toEqual(['.agents/config/guardrail-rules.yaml', '.agents/hooks/h.cjs']);
    });

    it('M9_loadProtectedSetWithBaseCommit_readsTheCommittedTierNotTheWorkingTreeOne', () => {
        // Arrange
        const { root, base } = gitProject();
        put(root, '.agents/config/guardrail-rules.yaml', tierYaml([...MIN_TIER, 'working-tree-only.txt']));

        // Act
        const fromBase = S.loadProtectedSet({ root, baseCommit: base });
        const fromTree = S.loadProtectedSet({ root });

        // Assert
        expect(fromBase.tier).toEqual(MIN_TIER);
        expect(fromTree.tier).toEqual([...MIN_TIER, 'working-tree-only.txt']);
    });

    it('M9_projectOverrideBesideTheRulesIsReadFromTheBaseToo', () => {
        // Arrange: the project override adds a tier entry at the base commit
        const { root } = gitProject();
        put(root, '.agents/config/guardrail-rules.project.yaml', 'subagentReadOnlyPaths:\n  - docs/notes.md\n');
        const base = commitAll(root, 'override');

        // Act
        const set = S.loadProtectedSet({ root, baseCommit: base });

        // Assert
        expect(set.tier).toEqual([...MIN_TIER, 'docs/notes.md']);
    });

    it('M9_baseThatCarriesOnlyTheRenderedCopy_isUsed', () => {
        // Arrange
        const root = tmpRoot('imp-scope-git-');
        git(root, 'init', '-q', '-b', 'main');
        put(root, '.claude/guardrail-rules.yaml', tierYaml([...MIN_TIER, 'locked-by-rendered-copy.txt']));
        const base = commitAll(root, 'rendered only');

        // Act
        const set = S.loadProtectedSet({ root, baseCommit: base });

        // Assert
        expect(set.tier).toContain('locked-by-rendered-copy.txt');
    });

    it('M9_baseWithoutAnyRulesFile_failsClosed', () => {
        // Arrange
        const root = tmpRoot('imp-scope-git-');
        git(root, 'init', '-q', '-b', 'main');
        put(root, 'README.md', 'x\n');
        const base = commitAll(root, 'no rules');
        put(root, '.agents/config/guardrail-rules.yaml', tierYaml(MIN_TIER));

        // Act
        const r = checkAt(root, base);

        // Assert
        expect(r.ok).toBe(false);
        expect(typeof r.error).toBe('string');
        expect(() => S.loadProtectedSet({ root, baseCommit: base })).toThrow();
    });

    it('M9_explicitRulesPath_stillWinsOverTheBase', () => {
        // Arrange: the caller vouches for an explicit rules file
        const { root, base } = gitProject();
        const custom = put(root, 'elsewhere/rules.yaml', tierYaml([...MIN_TIER, '.agents/skills/alpha/references/x.md']));
        put(root, '.agents/skills/alpha/references/x.md', 'edit\n');

        // Act
        const r = checkAt(root, base, { rulesPath: custom });

        // Assert
        expect(r.violations.map((v) => v.path).sort()).toEqual(['.agents/skills/alpha/references/x.md', 'elsewhere/rules.yaml']);
    });
});

describe('M10_skillCreatorIsNeverATarget', () => {
    it.each([
        '.agents/skills/skill-creator/SKILL.md',
        '.agents/skills/skill-creator/eval-viewer/generate-review.js',
        '.agents/skills/skill-creator/references/schemas.md',
        '.agents/skills/skill-creator/assets/eval_review.html',
        '.agents/skills/skill-creator/agents/grader.md',
        '.claude/skills/skill-creator/SKILL.md',
        '.codex/skills/skill-creator/references/schemas.md',
    ])('M10_%s_isProtectedEvenWhenAskedForAsTheTarget', (p) => {
        // Act
        const asTarget = S.classify(p, { root: REPO_ROOT, target: 'skill-creator' });
        const asOther = S.classify(p, { root: REPO_ROOT, target: 'alpha' });

        // Assert
        expect(asTarget.class).toBe('protected');
        expect(asOther.class).toBe('protected');
        expect(asOther.reason).toBe('protected');
    });

    it.each([['skill-creator'], ['Skill-Creator'], ['SKILL-CREATOR']])('M10_target_%s_isRefusedByEveryEntryPoint', (target) => {
        // Arrange
        const { root, base } = gitProject();

        // Act
        const asserted = S.assertDiffInScope(['.agents/skills/skill-creator/SKILL.md'], { root, target });
        const checked = S.checkDiffInScope({ root, base, target });

        // Assert
        for (const r of [asserted, checked]) {
            expect(r.ok).toBe(false);
            expect(r.error).toMatch(/own driver/);
        }
    });

    it('M10_cliClassifyAndCheckWithTheReservedTarget_exit2', () => {
        // Arrange
        const { root, base } = gitProject();
        const run = (args) => spawnSync(process.execPath, [MODULE_PATH, ...args], { encoding: 'utf8' }).status;

        // Act / Assert
        expect(run(['classify', '.agents/skills/skill-creator/SKILL.md', '--target', 'skill-creator', '--root', root])).toBe(2);
        expect(run(['check', '--base', base, '--target', 'skill-creator', '--root', root])).toBe(2);
    });

    it('M10_aSkillWhoseNameMerelyStartsWithSkillCreator_isNotReserved', () => {
        // Act
        const r = S.classify('.agents/skills/skill-creator-lite/SKILL.md', { root: REPO_ROOT, target: 'skill-creator-lite' });

        // Assert
        expect(r.class).toBe('editable');
    });
});

describe('m6_oneProtectedList', () => {
    const norm = (entry) => entry.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

    it('m6_noAdditionRepeatsATierEntry_exactlyOrAsASuffix', () => {
        // Arrange
        const tier = loadRules(REAL_YAML).subagentReadOnlyPaths.map(norm);

        // Act: an addition overlaps when a tier entry equals it or ends with `/{addition}` (the old duplicate shape)
        const overlaps = S.PROTECTED_ADDITIONS.filter((add) => {
            const a = norm(add);
            return tier.some((t) => t === a || t.endsWith(`/${a}`));
        });

        // Assert
        expect(overlaps).toEqual([]);
    });

    it('m6_additionsHaveNoDuplicatesAmongThemselves', () => {
        // Assert
        expect(new Set(S.PROTECTED_ADDITIONS.map(norm)).size).toBe(S.PROTECTED_ADDITIONS.length);
    });

    it.each([
        ['evals/', '.agents/skills/alpha/evals/evals.json'],
        ['holdout/', 'docs/.output/evolution/skills/d/w/holdout/evals.json'],
        ['tools/harness-eval-tasks/', 'tools/harness-eval-tasks/x/task.json'],
    ])('m6_%s_isStillProtectedThroughTheYamlTierAlone', (_entry, p) => {
        // Act
        const r = S.classify(p, { root: REPO_ROOT, target: 'alpha' });

        // Assert
        expect(r.class).toBe('protected');
    });

    it('m6_projectOverrideLiftingATierEntry_leavesNoSecondCopyInForce', () => {
        // Arrange: a project lifts `evals/` from the tier with `except:`
        const { root } = gitProject([...MIN_TIER, 'evals/']);
        put(root, '.agents/config/guardrail-rules.project.yaml', 'except:\n  subagentReadOnlyPaths:\n    - evals/\n');
        const base = commitAll(root, 'override');

        // Act
        const set = S.loadProtectedSet({ root, baseCommit: base });
        const r = S.classify('.agents/skills/alpha/evals/evals.json', { root, target: 'alpha' });

        // Assert
        expect(set.globs).not.toContain('evals/');
        expect(r.class).toBe('editable');
    });

    it.each([
        '.agents/skills/alpha/references/foo.test.md',
        '.agents/skills/alpha/scripts/check.spec.js',
        'tools/harness.test.cjs',
    ])('m6_testOrSpecSuffix_%s_isProtectedAnywhere', (p) => {
        // Act
        const r = S.classify(p, { root: REPO_ROOT, target: 'alpha' });

        // Assert
        expect(r.class).toBe('protected');
    });
});

describe('T1_metaCoverageEnumeratesTheYaml', () => {
    it('T1_everyTierEntryIsBlockedForASubagentAndProtectedByTheDiffScope', () => {
        // Arrange: derive one path from every entry of the live yaml, no hand-kept list
        const rules = loadRules(REAL_YAML);
        const neither = [];

        // Act
        for (const entry of rules.subagentReadOnlyPaths) {
            const rel = entry.endsWith('/') ? `${entry}some-file.js` : entry;
            const blocked = checkPathAccess(path.join(REPO_ROOT, rel), 'write', rules, { agentId: 'agent-1' }).allowed === false;
            const diffScope = S.classify(rel, { root: REPO_ROOT, target: 'alpha' }).class === 'protected';
            if (!blocked || !diffScope) neither.push(`${entry} (blocked=${blocked}, diffScope=${diffScope})`);
        }

        // Assert
        expect(neither).toEqual([]);
    });
});

// ─── CLI ─────────────────────────────────────────────────────────────────────

describe('cli', () => {
    const run = (args) => {
        const r = spawnSync(process.execPath, [MODULE_PATH, ...args], { encoding: 'utf8' });
        let json = null;
        try { json = JSON.parse(r.stdout); } catch { /* leave null */ }
        return { status: r.status, json, stderr: r.stderr };
    };

    it('cli_checkInScopeDiff_exits0', () => {
        // Arrange
        const { root, base } = gitProject();
        put(root, '.agents/skills/alpha/SKILL.md', 'edit\n');

        // Act
        const r = run(['check', '--base', base, '--target', 'alpha', '--root', root]);

        // Assert
        expect(r.status).toBe(0);
        expect(r.json).toMatchObject({ ok: true, violations: [] });
    });

    it('cli_checkProtectedWrite_exits1AndNamesThePath', () => {
        // Arrange
        const { root, base } = gitProject();
        fs.appendFileSync(path.join(root, '.agents/hooks/h.cjs'), 'x\n');

        // Act
        const r = run(['check', '--base', base, '--target', 'alpha', '--root', root]);

        // Assert
        expect(r.status).toBe(1);
        expect(r.json.ok).toBe(false);
        expect(r.json.violations.map((v) => v.path)).toEqual(['.agents/hooks/h.cjs']);
    });

    it.each([
        ['missing --base', (root) => ['check', '--target', 'alpha', '--root', root]],
        ['missing --target', (root, base) => ['check', '--base', base, '--root', root]],
        ['bad target', (root, base) => ['check', '--base', base, '--target', '../core', '--root', root]],
        ['unknown base', (root) => ['check', '--base', 'no-such-ref', '--target', 'alpha', '--root', root]],
        ['unknown verb', (root, base) => ['frobnicate', '--base', base, '--root', root]],
        ['no verb', () => []],
    ])('cli_%s_exits2', (_n, argv) => {
        // Arrange
        const { root, base } = gitProject();

        // Act
        const r = run(argv(root, base));

        // Assert
        expect(r.status).toBe(2);
    });

    it('cli_checkWithMalformedRules_exits2', () => {
        // Arrange: the rules are read from the BASE commit (M9), so the malformed file is the committed one
        const { root } = gitProject();
        fs.writeFileSync(path.join(root, '.agents/config/guardrail-rules.yaml'), ': broken\n  - [\n');
        git(root, 'commit', '-q', '-am', 'break rules');
        const brokenBase = git(root, 'rev-parse', 'HEAD');

        // Act
        const r = run(['check', '--base', brokenBase, '--target', 'alpha', '--root', root]);

        // Assert
        expect(r.status).toBe(2);
    });

    it('cli_checkWithRulesBrokenOnlyInTheWorkingTree_exits1BecauseTheBaseRulesStandAndTheEditIsAViolation', () => {
        // Arrange: M9 — the run broke the rules file after the base; the base's rules judge it
        const { root, base } = gitProject();
        fs.writeFileSync(path.join(root, '.agents/config/guardrail-rules.yaml'), ': broken\n  - [\n');

        // Act
        const r = run(['check', '--base', base, '--target', 'alpha', '--root', root]);

        // Assert
        expect(r.status).toBe(1);
        expect(r.json.violations.map((v) => v.path)).toEqual(['.agents/config/guardrail-rules.yaml']);
    });

    it('cli_classifyEditableExits0_protectedExits1_outsideExits1', () => {
        // Arrange
        const root = plainProject();
        const base = ['--target', 'alpha', '--root', root];

        // Act
        const ok = run(['classify', '.agents/skills/alpha/SKILL.md', ...base]);
        const prot = run(['classify', '.agents/core/gate.js', ...base]);
        const out = run(['classify', 'docs/x.md', ...base]);

        // Assert
        expect(ok.status).toBe(0);
        expect(ok.json.class).toBe('editable');
        expect(prot.status).toBe(1);
        expect(prot.json).toMatchObject({ class: 'protected', path: '.agents/core/gate.js' });
        expect(out.status).toBe(1);
        expect(out.json.class).toBe('outside');
    });

    it('cli_classifyTraversalToProtected_exits1', () => {
        // Arrange
        const root = plainProject();

        // Act
        const r = run(['classify', '.agents/skills/alpha/../../core/gate.js', '--target', 'alpha', '--root', root]);

        // Assert
        expect(r.status).toBe(1);
        expect(r.json.class).toBe('protected');
    });

    it('cli_classifyWithoutAPath_exits2', () => {
        // Act
        const r = run(['classify']);

        // Assert
        expect(r.status).toBe(2);
    });
});

// ─── final core review: m2 (executable files), security m5 (judge-chain skills), n3 (baseline location) ───

describe('m2_aCandidateNeverAddsExecutableFiles', () => {
    it.each([
        ['.agents/skills/alpha/scripts/run.js', 'scripts/'],
        ['.agents/skills/alpha/scripts/helper.md', 'scripts/'],
        ['.agents/skills/alpha/scripts/deep/nested/data.json', 'scripts/'],
        ['.agents/skills/alpha/references/tool.py', '*.py'],
        ['.agents/skills/alpha/references/example.ts', '*.ts'],
        ['.agents/skills/alpha/references/run.SH', '*.sh'],
        ['.agents/skills/alpha/references/setup.ps1', '*.ps1'],
        ['.agents/skills/alpha/check.cjs', '*.cjs'],
        ['.agents/skills/alpha/references/x.bat', '*.bat'],
    ])('m2_%s_isProtectedByTheExecutableRule', (p, matched) => {
        // Act
        const r = S.classify(p, opts());

        // Assert
        expect(r).toMatchObject({ class: 'protected', reason: 'protected', matched });
    });

    it.each([
        '.agents/skills/alpha/SKILL.md',
        '.agents/skills/alpha/references/guide.md',
        '.agents/skills/alpha/assets/mock.html',
        '.agents/skills/alpha/references/conventions.dot',
        '.agents/skills/alpha/references/data.json',
        '.agents/skills/alpha/references/descriptor.yaml',
        '.agents/skills/alpha/references/scripts-guide.md',
    ])('m2_%s_staysEditable', (p) => {
        // Act
        const r = S.classify(p, opts());

        // Assert
        expect(r).toMatchObject({ class: 'editable', reason: 'editable' });
    });

    it('m2_aScriptsDirectoryAddedByADiff_isAViolationAndAProseEditIsNot', () => {
        // Act
        const refused = S.assertDiffInScope(['.agents/skills/alpha/SKILL.md', '.agents/skills/alpha/scripts/run.sh'], { root: REPO_ROOT, target: 'alpha' });
        const allowed = S.assertDiffInScope(['.agents/skills/alpha/SKILL.md', '.agents/skills/alpha/references/new.md'], { root: REPO_ROOT, target: 'alpha' });

        // Assert
        expect(refused.ok).toBe(false);
        expect(refused.violations.map((v) => v.path)).toEqual(['.agents/skills/alpha/scripts/run.sh']);
        expect(allowed).toMatchObject({ ok: true, violations: [] });
    });

    it('m2_aGitDiffThatAddsAScript_isRefusedByTheCheck', () => {
        // Arrange
        const { root, base } = gitProject();
        put(root, '.agents/skills/alpha/scripts/payload.js', 'process.exit(0);\n');
        put(root, '.agents/skills/alpha/SKILL.md', 'alpha body, edited\n');

        // Act
        const r = S.checkDiffInScope({ root, base, target: 'alpha' });

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations).toEqual([expect.objectContaining({ path: '.agents/skills/alpha/scripts/payload.js', reason: 'protected' })]);
    });
});

describe('m5_theSkillsThatDefineTheJudgeAreNeverATarget', () => {
    const JUDGE_SKILLS = ['verification-before-completion', 'code-review', 'run-todo', 'do'];

    it('m5_reservedTargets_namesTheJudgeChainSkillsAndSkillCreator', () => {
        // Assert
        for (const name of ['skill-creator', ...JUDGE_SKILLS]) expect(S.RESERVED_TARGETS).toContain(name);
    });

    it.each(JUDGE_SKILLS.map((name) => [name]))('m5_%s_classifiesProtectedWithTheTargetReasonOnItsOwnSkillMd', (name) => {
        // Act
        const r = S.classify(`.agents/skills/${name}/SKILL.md`, { root: REPO_ROOT, target: name });

        // Assert
        expect(r.class).toBe('protected');
        expect(r.error).toMatch(/judge chain/);
    });

    it.each(JUDGE_SKILLS.map((name) => [name]))('m5_%s_isRefusedByEveryEntryPoint_caseInsensitively', (name) => {
        // Arrange
        const { root, base } = gitProject();
        const upper = name.toUpperCase();

        // Act
        const asserted = S.assertDiffInScope([`.agents/skills/${name}/SKILL.md`], { root, target: upper });
        const checked = S.checkDiffInScope({ root, base, target: upper });
        const cli = spawnSync(process.execPath, [MODULE_PATH, 'check', '--base', base, '--target', name, '--root', root], { encoding: 'utf8' });

        // Assert
        for (const r of [asserted, checked]) {
            expect(r.ok).toBe(false);
            expect(r.error).toMatch(/judge chain/);
        }
        expect(cli.status).toBe(2);
    });

    it.each([['documentation'], ['do-not-touch'], ['run-todo-lite'], ['code-reviewer'], ['verification']])('m5_aSkillMerelySharingAPrefix_%s_isNotReserved', (name) => {
        // Act
        const r = S.classify(`.agents/skills/${name}/SKILL.md`, { root: REPO_ROOT, target: name });

        // Assert
        expect(r).toMatchObject({ class: 'editable', reason: 'editable' });
    });

    it('m5_theJudgeSkillsFilesAreOutsideScopeForAnotherTarget', () => {
        // Act: an apply for `alpha` that also edits the ship-token prose must be refused
        const r = S.assertDiffInScope(['.agents/skills/alpha/SKILL.md', '.agents/skills/verification-before-completion/SKILL.md'], { root: REPO_ROOT, target: 'alpha' });

        // Assert
        expect(r.ok).toBe(false);
        expect(r.violations.map((v) => v.path)).toEqual(['.agents/skills/verification-before-completion/SKILL.md']);
    });
});

describe('sf46_theRegressionEvaluatorAndItsHoldoutAreProtected', () => {
    it.each([
        ['tools/skill-regress.js'],
        ['tools/skill-holdout/code-review/evals.json'],
        ['tools/skill-holdout/alpha/fixtures/x/file.js'],
        ['tools/skill-holdout/'],
    ])('sf46_%s_isProtected', (p) => {
        // Act
        const r = S.classify(p, { root: REPO_ROOT, target: 'alpha' });

        // Assert
        expect(r.class).toBe('protected');
        expect(r.reason).toBe('protected');
    });

    it('sf46_theEvaluatorIsAnAdditionAndTheHoldoutComesFromTheTier', () => {
        // tools/skill-holdout/ joined the subagent tier (wave L1 review M10), and an addition must not repeat a
        // tier entry (m6_noAdditionRepeatsATierEntry); the sf46_*_isProtected cases above prove it stays protected.
        expect(S.PROTECTED_ADDITIONS).toContain('tools/skill-regress.js');
        expect(S.PROTECTED_ADDITIONS).not.toContain('tools/skill-holdout/');
    });

    it('sf46_aSkillNamedLikeTheHoldoutDirectoryIsNotCaught', () => {
        // Act
        const r = S.classify('.agents/skills/alpha/references/skill-holdout-notes.md', { root: REPO_ROOT, target: 'alpha' });

        // Assert
        expect(r.class).toBe('editable');
    });
});

describe('n3_theBaselineLivesOutsideTheJudgedTree', () => {
    const cli = (args) => {
        const r = spawnSync(process.execPath, [MODULE_PATH, ...args], { encoding: 'utf8' });
        let json = null;
        try { json = JSON.parse(r.stdout); } catch { /* asserted by the caller */ }
        return { status: r.status, json };
    };

    it('n3_snapshotOutUnderRoot_exits2AndWritesNothing', () => {
        // Arrange
        const { root, base } = gitProject();
        const out = path.join(root, 'baseline.json');

        // Act
        const r = cli(['snapshot', '--base', base, '--root', root, '--out', out]);

        // Assert
        expect(r.status).toBe(2);
        expect(r.json.error).toMatch(/inside the judged tree/);
        expect(fs.existsSync(out)).toBe(false);
    });

    it('n3_snapshotOutUnderANotYetExistingSubdirectoryOfRoot_exits2', () => {
        // Arrange
        const { root, base } = gitProject();

        // Act
        const r = cli(['snapshot', '--base', base, '--root', root, '--out', path.join(root, 'new', 'deeper', 'baseline.json')]);

        // Assert
        expect(r.status).toBe(2);
        expect(fs.existsSync(path.join(root, 'new'))).toBe(false);
    });

    it.skipIf(!canSymlink)('n3_snapshotOutThroughASymlinkIntoRoot_exits2', () => {
        // Arrange: /tmp/link -> root, so the lexical path is outside the root and the real path is inside it
        const { root, base } = gitProject();
        const holder = tmpRoot('imp-scope-link-');
        fs.symlinkSync(root, path.join(holder, 'link'));

        // Act
        const r = cli(['snapshot', '--base', base, '--root', root, '--out', path.join(holder, 'link', 'baseline.json')]);

        // Assert
        expect(r.status).toBe(2);
        expect(fs.existsSync(path.join(root, 'baseline.json'))).toBe(false);
    });

    it('n3_snapshotOutOutsideRoot_isWrittenAndCheckAcceptsItAsTheBaseline', () => {
        // Arrange
        const { root, base } = gitProject();
        const out = path.join(tmpRoot('imp-scope-out-'), 'baseline.json');

        // Act
        const snap = cli(['snapshot', '--base', base, '--root', root, '--out', out]);
        const check = cli(['check', '--base', base, '--target', 'alpha', '--root', root, '--baseline', out]);

        // Assert
        expect(snap.status).toBe(0);
        expect(fs.existsSync(out)).toBe(true);
        expect(check.status).toBe(0);
    });

    it('n3_checkBaselineUnderRoot_exits2EvenWhenTheFileIsAValidBaseline', () => {
        // Arrange: a valid baseline, then placed inside the judged tree
        const { root, base } = gitProject();
        const outside = path.join(tmpRoot('imp-scope-out-'), 'baseline.json');
        expect(cli(['snapshot', '--base', base, '--root', root, '--out', outside]).status).toBe(0);
        const inside = path.join(root, 'docs', 'baseline.json');
        fs.copyFileSync(outside, inside);

        // Act
        const r = cli(['check', '--base', base, '--target', 'alpha', '--root', root, '--baseline', inside]);

        // Assert
        expect(r.status).toBe(2);
        expect(r.json.error).toMatch(/inside the judged tree/);
    });

    it('n3_aSiblingDirectoryWhoseNameStartsWithTheRootName_isNotUnderRoot', () => {
        // Arrange
        const { root, base } = gitProject();
        const sibling = `${root}-sibling`;
        roots.push(sibling);
        fs.mkdirSync(sibling);

        // Act
        const r = cli(['snapshot', '--base', base, '--root', root, '--out', path.join(sibling, 'baseline.json')]);

        // Assert
        expect(r.status).toBe(0);
    });
});
