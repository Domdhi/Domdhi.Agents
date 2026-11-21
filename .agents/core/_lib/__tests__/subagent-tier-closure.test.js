// SF-1.8 review findings C1 / J-1 — the subagent tier must cover the whole require() closure of the
// hooks that enforce it and of the judges that grade a subagent's work. A subagent that can write
// `_lib/hook-input.js` or `_lib/yaml-parser.js` switches the wall off from the inside (verified in the
// review: one Write there made every later Write to `gate.js` pass), and a subagent that can write
// `_lib/gate-summary.js` or `_lib/telemetry-paths.js` changes what the judge reads or reports.
//
// This test walks the static relative require() graph from the protected entry points and fails when any
// reachable file is not matched (by `globMatchesPath`) by the shipped yaml tier AND the built-in default
// list. It is the authoritative list: when someone extracts a helper that a hook or a judge loads, this
// test goes red until the helper is added to the tier (and to the built-in list).
//
// Known limit (stated, not hidden): the walk follows literal `require('./x')` calls only. A computed
// require argument or a spawned `node .../x.js` child is not followed; the test fails on any computed
// require in the closure so one cannot appear silently, and spawned entry points are covered because
// each is itself a seed or lives under a covered directory.

import { describe, it, expect } from 'vitest';
import module_, { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { loadRules, globMatchesPath, BUILTIN_SUBAGENT_READ_ONLY_PATHS } = require('../guardrail-rules');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SHIPPED_YAML = path.join(ROOT, '.agents', 'config', 'guardrail-rules.yaml');
const SETTINGS = path.join(ROOT, '.agents', 'adapters', 'claude', 'settings.json');

// The judges: what decides pass or fail for a subagent's work.
const JUDGES = [
    '.agents/core/gate.js',
    '.agents/core/ship-check.js',
    '.agents/core/ac-verify.js',
    '.agents/core/commit.js',
    '.agents/core/todo-completion.js',
    '.agents/core/story-checkpoint.js',
    '.agents/core/plan-check.js',
];

// Every hook script registered for ANY event in the authored Claude settings (PreToolUse, PostToolUse,
// UserPromptSubmit, SessionStart, SessionEnd, Stop, PreCompact, WorktreeCreate, ...) and in the Codex
// adapter's hook registration, plus the Codex adapter that runs the same hook sources. A hook that is not a
// PreToolUse blocker still runs as the main thread: UserPromptSubmit and SessionStart stdout reaches the
// Main Agent's context, so a subagent that edits a library those hooks load injects instructions into it.
// Derived from the registration so a new hook of any event is seeded automatically.
const CODEX_HOOKS_CONFIG = path.join(ROOT, '.agents', 'adapters', 'codex', 'hooks-config.json');

function claudeHookScripts(settings) {
    const scripts = new Set();
    for (const groups of Object.values(settings.hooks || {})) {
        for (const group of groups || []) {
            for (const hook of group.hooks || []) {
                const match = /\.claude\/hooks\/([A-Za-z0-9_.-]+\.cjs)/.exec(hook.command || '');
                if (match) scripts.add(`.agents/hooks/${match[1]}`);
            }
        }
    }
    return scripts;
}

// The Codex launcher command selects the shared hook with `process.argv[2]='<name>.cjs'`.
function codexHookScripts(config) {
    const scripts = new Set();
    for (const groups of Object.values(config.hooks || {})) {
        for (const group of groups || []) {
            for (const hook of group.hooks || []) {
                for (const key of ['command', 'commandWindows']) {
                    const match = /process\.argv\[2\]='([A-Za-z0-9_.-]+\.cjs)'/.exec(hook[key] || '');
                    if (match) scripts.add(`.agents/hooks/${match[1]}`);
                }
            }
        }
    }
    return scripts;
}

function registeredHooks() {
    const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    const codex = JSON.parse(fs.readFileSync(CODEX_HOOKS_CONFIG, 'utf8'));
    return [...new Set([...claudeHookScripts(settings), ...codexHookScripts(codex)])].sort();
}

const HOOK_SEEDS = [...registeredHooks(), '.agents/adapters/codex/hooks.js'];

const REQUIRE_LITERAL = /require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;
const REQUIRE_COMPUTED = /require\(\s*[^'"\s)]/;
// `require(require.resolve('<bare package>', { paths }))` (sqlite-backend's better-sqlite3 adoption) loads a
// third-party package, not repo code: it resolves into node_modules/ or `.claude/core/node_modules`, and both
// are on the tier. It is the one computed shape the walk accepts; any other computed require still fails.
const REQUIRE_BARE_RESOLVE = /require\(\s*require\.resolve\(\s*(['"])(?![./])[^'"]+\1/g;

function resolveModule(fromFile, spec) {
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.json`, path.join(base, 'index.js')]) {
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch { /* try the next spelling */ }
    }
    return null;
}

/** Walk the static require graph from `seeds` (repo-relative). Returns { files, computed, unresolved }. */
function walkRequireGraph(seeds, root) {
    const files = new Set();
    const computed = [];
    const unresolved = [];
    const queue = seeds.map((seed) => path.resolve(root, seed));
    while (queue.length) {
        const file = queue.pop();
        if (files.has(file)) continue;
        let source;
        try {
            source = fs.readFileSync(file, 'utf8');
        } catch {
            unresolved.push(path.relative(root, file));
            continue;
        }
        files.add(file);
        if (file.endsWith('.json')) continue;
        // Comments carry usage examples (`require('../core/_lib/x')`) that are not loads.
        source = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
        if (REQUIRE_COMPUTED.test(source.replace(REQUIRE_BARE_RESOLVE, ''))) computed.push(path.relative(root, file));
        for (const match of source.matchAll(REQUIRE_LITERAL)) {
            const resolved = resolveModule(file, match[2]);
            if (resolved) queue.push(resolved);
            else unresolved.push(`${path.relative(root, file)} -> ${match[2]}`);
        }
    }
    return { files: [...files].map((f) => path.relative(root, f).split(path.sep).join('/')).sort(), computed, unresolved };
}

/** The closure members a tier list does not match. */
function uncovered(files, tier, root) {
    return files.filter((rel) => !tier.some((glob) => globMatchesPath(glob, path.join(root, rel))));
}

const SEEDS = [...JUDGES, ...HOOK_SEEDS];
const closure = walkRequireGraph(SEEDS, ROOT);

describe('SF-1.8 review C1/J-1 — the tier covers the require() closure of the hooks and the judges', () => {
    it('seeds_includeEveryJudgeAndEveryHookOfEveryEventAndTheCodexAdapter', () => {
        // The four blocking PreToolUse hooks, the Main-Agent-context hooks (UserPromptSubmit, SessionStart),
        // and the PostToolUse / Stop / SessionEnd / PreCompact / SubagentStop / Worktree hooks are all seeds.
        for (const hook of [
            'commit-guard', 'guardrail', 'path-guardrail', 'secret-scanner',
            'memory-recall', 'session-start-prime', 'memory-capture', 'memory-session-capture',
            'edit-capture', 'pre-compaction-archive', 'session-end-doc-sync', 'skill-usage-logger',
            'command-usage-logger', 'post-read-scrubber', 'damage-control', 'organize', 'worktree',
        ]) expect(HOOK_SEEDS, hook).toContain(`.agents/hooks/${hook}.cjs`);
        expect(HOOK_SEEDS).toContain('.agents/adapters/codex/hooks.js');
        for (const seed of SEEDS) expect(closure.files, seed).toContain(seed);
    });

    it('seeds_matchEveryHookEventInTheAuthoredSettingsAndTheCodexConfig', () => {
        // Independent of the helper under test: collect every `.cjs` hook name by a plain text scan of both files.
        const names = new Set();
        for (const file of [SETTINGS, CODEX_HOOKS_CONFIG]) {
            for (const m of fs.readFileSync(file, 'utf8').matchAll(/([a-z][a-z-]*)\.cjs/g)) names.add(`.agents/hooks/${m[1]}.cjs`);
        }
        expect(names.size).toBeGreaterThan(15);
        for (const name of names) expect(HOOK_SEEDS, name).toContain(name);
        // Every event name in the settings is a registered event, so a new event cannot be skipped.
        const events = Object.keys(JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).hooks);
        expect(events).toEqual(expect.arrayContaining(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart']));
    });

    it('seedDerivation_readsEveryEventNotOnlyPreToolUse', () => {
        // Violating control: a hook registered only under UserPromptSubmit (Claude) or only in the Codex config is seeded.
        const claude = claudeHookScripts({ hooks: { UserPromptSubmit: [{ hooks: [{ command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/only-prompt.cjs"' }] }] } });
        expect([...claude]).toEqual(['.agents/hooks/only-prompt.cjs']);
        const codex = codexHookScripts({ hooks: { SessionStart: [{ hooks: [{ commandWindows: "node -e \"process.argv[2]='only-codex.cjs';\"" }] }] } });
        expect([...codex]).toEqual(['.agents/hooks/only-codex.cjs']);
    });

    it('shippedYamlTier_walls_node_modules_theTestRunnerPackage', () => {
        // Security M3: a subagent that patches node_modules/vitest forges a green gate; no subagent has a legitimate Edit there.
        expect(loadRules(SHIPPED_YAML).subagentReadOnlyPaths).toContain('node_modules/');
        expect([...BUILTIN_SUBAGENT_READ_ONLY_PATHS]).toContain('node_modules/');
    });

    it('tier_wallsEveryConfigNameVitestLoads_soTheRunnersRefusalAndTheWallAgree', () => {
        // Security m3: vitest 5 loads these extensions; every spelling a subagent could write is walled.
        const names = [];
        for (const base of ['vitest.config', 'vite.config']) {
            for (const ext of ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs']) names.push(`${base}.${ext}`);
        }
        for (const tier of [loadRules(SHIPPED_YAML).subagentReadOnlyPaths, [...BUILTIN_SUBAGENT_READ_ONLY_PATHS]]) {
            expect(uncovered(names, tier, ROOT)).toEqual([]);
        }
    });

    it('computedRequireCheck_acceptsOnlyABarePackageResolve', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-closure-'));
        try {
            fs.writeFileSync(path.join(dir, 'ok.js'), "module.exports = require(require.resolve('some-pkg', { paths: [__dirname] }));\n");
            fs.writeFileSync(path.join(dir, 'bad.js'), "module.exports = require(require.resolve('./local', { paths: [__dirname] }));\n");
            expect(walkRequireGraph(['ok.js'], dir).computed).toEqual([]);
            expect(walkRequireGraph(['bad.js'], dir).computed).toEqual(['bad.js']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('walker_reachesTheLibrariesTheReviewNamed', () => {
        for (const rel of [
            '.agents/core/_lib/hook-input.js',
            '.agents/core/_lib/yaml-parser.js',
            '.agents/core/_lib/command-blocker.js',
            '.agents/core/_lib/hook-telemetry.js',
            '.agents/core/_lib/gate-summary.js',
            '.agents/core/_lib/telemetry-paths.js',
            '.agents/core/_lib/fs-safe.js',
            '.agents/core/_lib/project-root.js',
            '.agents/core/_lib/shell-command-split.js',
        ]) expect(closure.files, rel).toContain(rel);
    });

    it('walker_resolvesEveryLiteralRequireAndMeetsNoComputedOne', () => {
        // A computed require would hide a module from the walk; an unresolved literal means the walker is wrong.
        expect(closure.unresolved).toEqual([]);
        expect(closure.computed).toEqual([]);
    });

    it('shippedYamlTier_matchesEveryFileInTheClosure', () => {
        const tier = loadRules(SHIPPED_YAML).subagentReadOnlyPaths;
        expect(uncovered(closure.files, tier, ROOT)).toEqual([]);
    });

    it('builtInDefaults_matchEveryFileInTheClosure', () => {
        expect(uncovered(closure.files, [...BUILTIN_SUBAGENT_READ_ONLY_PATHS], ROOT)).toEqual([]);
    });

    it('generatedWrappers_ofEveryCoreOrHookFileInTheClosure_areCoveredToo', () => {
        const tier = [...BUILTIN_SUBAGENT_READ_ONLY_PATHS];
        const wrappers = [];
        for (const rel of closure.files) {
            const m = /^\.agents\/(core|hooks)\/(.+)$/.exec(rel);
            if (!m) continue;
            wrappers.push(`.claude/${m[1]}/${m[2]}`, `.codex/${m[1]}/${m[2]}`);
        }
        expect(wrappers.length).toBeGreaterThan(20);
        expect(uncovered(wrappers, tier, ROOT)).toEqual([]);
    });

    it('violatingControl_anEntryPointThatRequiresAnUnlistedModule_isReported', () => {
        // Arrange: a temp tree whose entry requires `lib/unlisted.js`, and a tier that lists only the entry.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-closure-'));
        try {
            fs.mkdirSync(path.join(dir, 'lib'));
            fs.writeFileSync(path.join(dir, 'entry.js'), "const u = require('./lib/unlisted');\nmodule.exports = u;\n");
            fs.writeFileSync(path.join(dir, 'lib', 'unlisted.js'), 'module.exports = 1;\n');

            // Act
            const graph = walkRequireGraph(['entry.js'], dir);

            // Assert: the unlisted module is found by the walk and flagged by the coverage check
            expect(graph.files).toEqual(['entry.js', 'lib/unlisted.js']);
            expect(uncovered(graph.files, ['entry.js'], dir)).toEqual(['lib/unlisted.js']);
            expect(uncovered(graph.files, ['entry.js', 'lib/unlisted.js'], dir)).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('bareRequires_inTheHookClosure_areOnlyTheGuardedNpmDriver_soStatusJsGlobIsNotHookReachable', () => {
        // L1H, security review M6 step 3: a bare require (a package, not repo code) walks up into the project's writable
        // node_modules/, which is code execution in an unsandboxed hook. The only one a hook may reach is better-sqlite3 in
        // sqlite-backend.js, which MEMORY_SQLITE_NPM=off gates. status.js's `require('glob')` is a CLI-only optional
        // dependency: no hook or hook-required module requires status.js, so it is absent from the closure.
        // Known limit (as for the whole walk): a spawned `node <file>` child is not followed.
        const bare = [];
        for (const rel of closure.files) {
            if (!/\.c?js$/.test(rel)) continue;
            const source = fs.readFileSync(path.join(ROOT, rel), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
            for (const match of source.matchAll(/require(?:\.resolve)?\(\s*(['"])([^'"./][^'"]*)\1/g)) {
                const spec = match[2];
                if (spec.startsWith('node:') || module_.builtinModules.includes(spec)) continue;
                bare.push(`${rel} -> ${spec}`);
            }
        }
        // sqlite-backend.js names the package twice (the plain require and the legacy require.resolve lookup).
        expect([...new Set(bare)].sort()).toEqual(['.agents/core/_lib/sqlite-backend.js -> better-sqlite3']);
        expect(closure.files).not.toContain('.agents/core/status.js');
    });

    it('bareRequireScan_reportsAPackageRequire_andIgnoresBuiltinsAndComments', () => {
        // Violating control for the scan above: a planted package require is reported, a builtin and a comment are not.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-closure-'));
        try {
            fs.writeFileSync(path.join(dir, 'entry.js'), "const fs = require('fs');\nconst s = require('node:sqlite');\n// require('commented-out')\nconst g = require('glob');\n");
            const seen = [];
            const source = fs.readFileSync(path.join(dir, 'entry.js'), 'utf8').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
            for (const match of source.matchAll(/require(?:\.resolve)?\(\s*(['"])([^'"./][^'"]*)\1/g)) {
                if (!match[2].startsWith('node:') && !module_.builtinModules.includes(match[2])) seen.push(match[2]);
            }
            expect(seen).toEqual(['glob']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('violatingControl_aComputedRequireInTheClosure_isReportedNotFollowedSilently', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-closure-'));
        try {
            fs.writeFileSync(path.join(dir, 'entry.js'), "const name = './x';\nmodule.exports = require(name);\n");

            const graph = walkRequireGraph(['entry.js'], dir);

            expect(graph.computed).toEqual(['entry.js']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
