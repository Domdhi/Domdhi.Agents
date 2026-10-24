#!/usr/bin/env node

/**
 * migrate-output-layout — the one deterministic, unit-tested codemod that moves
 * docs/.output/ from its flat, multi-era compartment layout into the ADR-0006
 * four-concern-group taxonomy (findings/ · plans · handoffs · evolution/), every
 * artifact month-bucketed at {group}/{kind}/{YYYY-MM}/. Mirrors the proven
 * migrate-docs-domains.js playbook; lives in .claude/core/ so it propagates to
 * adopters on fleet:sync — each runs it on its OWN .output/ on its own schedule.
 *
 * THE KEY DIFFERENCE from migrate-docs-domains: --move cannot use a static file
 * list. The durable compartments hold hundreds of dated files; the mover
 * ENUMERATES each old compartment at runtime and computes the destination
 * {group}/{kind}/{YYYY-MM}/ from each filename's own date. Un-dated artifacts are
 * PARKED (reported, never moved to a guessed month); ad-hoc non-date subdirs under
 * discrete compartments (the investigations/database/958 anti-pattern) are FLAGGED.
 *
 * Two tables, one taxonomy:
 *   COMPARTMENT_MAP — old top-level compartment dir → { kind, shape } (drives --move).
 *                     `kind` is an OUTPUT_PATHS key; the target dir is read from the
 *                     registry (single source — never re-hardcoded here).
 *   REF_REWRITES    — .output/-prefixed path tokens to rewrite (drives --refs/--verify).
 *                     Sorted longest-first at load so a specific token always wins
 *                     over a substring of it. Boundary-anchored so a token only
 *                     matches a real path occurrence, never a fragment of a longer
 *                     identifier. Covers the compartment relocations AND the Wave 1
 *                     `.state/` prose gotcha (code moved to .state/ but prose lagged).
 *
 * TRACKED-WORK CARVE-OUT: the bare `.output/work` token reclassifies to the gitignored
 * `.state/work`. That is correct ONLY when `.output/work/` is genuine ephemeral scratch.
 * Older repos accreted durable, CITED content there (CLAUDE.md / immutable ADRs / TODOs
 * point into it); reclassifying that would de-track it and 404 the citations. So --refs
 * and --verify check `git ls-files .output/work` and, when it is non-empty, DROP the
 * work→.state rule (a loud notice explains why + names the on-taxonomy home, findings/).
 * --migrate-tracked-work forces it. The workshop has 0 tracked there, so this is a no-op
 * for it and auto-protects adopters.
 *
 * Modes:
 *   --move   <outputRoot> [--apply] [--date-undated]      enumerate + git mv (dry-run default)
 *   --refs   [--apply] [--root <dir>] [--migrate-tracked-work] [paths…]   rewrite refs (dry-run default)
 *   --verify [--root <dir>] [--migrate-tracked-work] [paths…]             grep survivors; exit 1 if any
 *
 * --date-undated: instead of parking artifacts with no in-filename date, give each
 * its REAL create-date (the first commit that added it, else fs birthtime) as a
 * {YYMMDD-HHMM} prefix and bucket it normally; persistent ledger/index files
 * (_decisions.md, README.md) land at the compartment root with no month. An item
 * whose create-date can't be resolved stays parked — still never guessed.
 *
 * Safety: dry-run first, idempotent (re-run is a no-op — new paths don't match old
 * tokens; already-bucketed month dirs at their final home are skipped), self-
 * verifying, skip-allowlisted (never touches _archive/, generated .output/, ADRs,
 * CHANGELOG, or the migration codemods whose bodies carry legacy literals as DATA).
 * A line carrying the `migrate:keep` marker passes through verbatim. memories/ is
 * OUT OF SCOPE — its three-tier split is Wave 1b (a different resolver), so this
 * codemod never moves or rewrites a memories/ path.
 *
 * Exit codes: 0 ok · 1 verify found survivors · 2 usage error.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { OUTPUT_PATHS } = require('./constants');
const { stamp } = require('./_lib/run-stamp');

const OUTPUT_ROOT = 'docs/.output';

// ── COMPARTMENT_MAP — drives --move ─────────────────────────────────────────
// Old flat compartment (a top-level dir under docs/.output/) → its registry kind
// + archetype shape. The destination DIR is OUTPUT_PATHS[kind].dir (single source).
//   discrete  files named {YYMMDD-HHMM|YYYY-MM-DD}-slug.ext   → bucket each file
//   daylog    files named {YYYY-MM-DD}.md                     → bucket each file
//   rununit   DIRECTORIES named {stamp}-slug/                 → bucket each dir whole
// memories/ is intentionally ABSENT — Wave 1b owns its source≠index≠disposable split.
const COMPARTMENT_MAP = {
    reviews:           { kind: 'findings/reviews',        shape: 'discrete' },
    investigations:    { kind: 'findings/investigations', shape: 'discrete' },
    research:          { kind: 'findings/research',       shape: 'discrete' },
    plans:             { kind: 'plans',                   shape: 'discrete' },
    handoffs:          { kind: 'handoffs',                shape: 'discrete' },
    triage:            { kind: 'evolution/triage',        shape: 'daylog'  },
    intake:            { kind: 'evolution/intake',        shape: 'daylog'  },
    canary:            { kind: 'evolution/canary',        shape: 'rununit' },
    'skill-evolution': { kind: 'evolution/skills',        shape: 'rununit' },
    'agent-updates':   { kind: 'evolution/agents',        shape: 'daylog'  },
};

// Known legacy LOOSE files at the .output/ root (pre-folder era). Mapped to their
// compartment; un-dated, so they always PARK (reported for manual dating).
const LOOSE_FILES = {
    'agent-updates.md': { kind: 'evolution/agents' },
};

// ── REF_REWRITES — drives --refs / --verify ─────────────────────────────────
// [oldToken, newToken]. Every token is `.output/`-prefixed: the same rule matches
// both `docs/.output/X` and a bare `.output/X` (the leading boundary is the `.`,
// a non-identifier char). Declared unordered; sorted longest-first below so the
// most-specific token wins. NO rule for plans/ or handoffs/ (compartment path
// unchanged — only month-bucketed, which the helper appends at runtime) and NONE
// for memories/ (Wave 1b).
const REF_REWRITES_RAW = [
    // ── compartment relocations into the four concern groups ──
    ['.output/reviews',          '.output/findings/reviews'],
    ['.output/investigations',   '.output/findings/investigations'],
    ['.output/research',         '.output/findings/research'],
    ['.output/triage',           '.output/evolution/triage'],
    ['.output/intake',           '.output/evolution/intake'],
    ['.output/canary',           '.output/evolution/canary'],
    ['.output/skill-evolution',  '.output/evolution/skills'],
    ['.output/agent-updates',    '.output/evolution/agents'],
    // ── Wave 1 .state/ prose gotcha (code already repointed; prose lagged) ──
    ['.output/telemetry',        '.output/.state/telemetry'],
    ['.output/sessions',         '.output/.state/sessions'],
    ['.output/screenshots',      '.output/.state/screenshots'],
    ['.output/work',             '.output/.state/work'],
    ['.output/.commit-msg',      '.output/.state/.commit-msg'],
    ['.output/.pr-body',         '.output/.state/.pr-body'],
    ['.output/freeze-state.json', '.output/.state/freeze-state.json'],
    ['.output/status.html',      '.output/.state/status.html'],
    ['.output/decisions.html',   '.output/.state/decisions.html'],
];

// Longest-first: a longer old-token is a superset match and must win.
const REF_REWRITES = [...REF_REWRITES_RAW].sort((a, b) => b[0].length - a[0].length);

// ── Tracked-work carve-out ───────────────────────────────────────────────────
// The rule that reclassifies the bare `.output/work` path as ephemeral `.state/work`.
// In the current taxonomy `.output/work` is a PRE-split fossil: the only sanctioned
// homes are `docs/work/` (durable plan) and `.output/.state/work/{date}/{task}/`
// (ephemeral scratch). But older repos accreted DURABLE, CITED content under the bare
// tracked `.output/work/` — reclassifying THAT to the gitignored `.state/` would
// de-track it and 404 its citations (CLAUDE.md / immutable ADRs / TODOs). So the rule
// is suppressed whenever the repo actually has tracked files there.
const WORK_REF_RULE_TOKEN = '.output/work';

/**
 * Git-tracked files under `docs/.output/work/` (relative paths), or [] when none / not
 * a git repo. A non-empty result is the signal that this repo carries durable content
 * at the pre-taxonomy `.output/work/` path.
 */
function trackedWorkFiles(projectRoot) {
    try {
        // `:/`-magic pathspec anchors to the working-tree ROOT, so the query is correct even
        // when projectRoot is a subdir of the git toplevel (a CWD-relative `--` pathspec would
        // silently return [] there, re-enabling the de-tracking this carve-out exists to prevent).
        const out = execFileSync('git', ['ls-files', '-z', '--', `:/${OUTPUT_ROOT}/work`], {
            cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
        });
        return out.split('\0').filter(Boolean);
    } catch {
        return [];
    }
}

/**
 * The REF_REWRITES to actually apply for this repo. When `.output/work/` holds tracked
 * files (and `force` is off), the work→.state/work rule is dropped — the "tracked-work
 * carve-out" — so those citations keep resolving in place. `--verify` MUST use the same
 * effective set, else it flags the intentionally-kept literals as survivors.
 * @returns {{ rules, suppressedWork: boolean, trackedCount: number }}
 */
function effectiveRefRewrites(projectRoot, { force = false } = {}) {
    if (force) return { rules: REF_REWRITES, suppressedWork: false, trackedCount: 0 };
    const tracked = trackedWorkFiles(projectRoot);
    if (tracked.length === 0) return { rules: REF_REWRITES, suppressedWork: false, trackedCount: 0 };
    const rules = REF_REWRITES.filter(([oldTok]) => oldTok !== WORK_REF_RULE_TOKEN);
    return { rules, suppressedWork: true, trackedCount: tracked.length };
}

/** The notice printed when the carve-out fires — states WHY and the on-taxonomy home. */
function trackedWorkNotice(count) {
    return [
        ``,
        `  ⚠ TRACKED-WORK CARVE-OUT — ${count} git-tracked file(s) under ${OUTPUT_ROOT}/work/.`,
        `    The ${OUTPUT_ROOT}/work → ${OUTPUT_ROOT}/.state/work reclassification is SKIPPED here so`,
        `    those references keep resolving in place (moving them would de-track the files and`,
        `    404 citations in CLAUDE.md / immutable ADRs / TODOs). These look like durable`,
        `    FINDINGS misfiled under work/ — the on-taxonomy home is ${OUTPUT_ROOT}/findings/ —`,
        `    but they are kept tracked in place to honor the immutable ADR citations. New`,
        `    ephemeral scratch still belongs in ${OUTPUT_ROOT}/.state/work/{date}/{task}/.`,
        `    Pass --migrate-tracked-work to force the reclassification anyway.`,
        ``,
    ].join('\n');
}

// ── Skip-allowlist ──────────────────────────────────────────────────────────
// Paths that intentionally retain legacy tokens (history, generated output) or
// whose legacy literals are load-bearing DATA and must not be blind-rewritten.
const SKIP_PATH_RES = [
    /(^|\/)node_modules(\/|$)/,
    /(^|\/)\.git(\/|$)/,
    /(^|\/)_archive(\/|$)/,
    /(^|\/)\.archive(\/|$)/,
    /(^|\/)worktrees(\/|$)/,           // linked git worktrees — a separate checkout, not ours
    /(^|\/)\.output(\/|$)/,            // generated reports/memories (incl. the ADR + this plan)
    /(^|\/)architecture\/decisions(\/|$)/,   // ADRs are immutable as-of-date history
    /(^|\/)CHANGELOG\.md$/,            // historical release notes
    // The migration codemods carry old compartment tokens as DATA (COMPARTMENT_MAP
    // keys / REF_REWRITES / fixtures) — rewriting their bodies would corrupt them.
    /(^|\/)migrate-output-layout\.js$/,
    /(^|\/)migrate-output-layout\.test\.js$/,
    /(^|\/)migrate-docs-domains\.js$/,
    /(^|\/)migrate-docs-domains\.test\.js$/,
];

// Default fileset roots walked when --refs/--verify get no explicit paths.
const TEMPLATE_FILESET = ['.claude', 'tools', 'docs/reference'];
const TEMPLATE_FILES = ['CLAUDE.md', 'docs/CLAUDE.md', 'README.md'];

const TEXT_EXT = new Set(['.md', '.js', '.cjs', '.mjs', '.json', '.yaml', '.yml', '.html', '.txt']);
const LINE_KEEP_MARKER = 'migrate:keep';

// A path token only matches when the char immediately before is NOT an identifier
// char (so `.output/work` matches in `docs/.output/work` but the bare-token rules
// never fire mid-identifier) and — for tokens that don't self-terminate with `/` —
// the char immediately after is likewise not an identifier char (so `.output/work`
// won't clobber inside `.output/workspace`).
const IDENT_RE = /[A-Za-z0-9_-]/;

// ── date parsing (the heart of runtime bucketing) ───────────────────────────
/**
 * The YYYY-MM month bucket for a compartment entry, parsed from its filename.
 * Handles BOTH naming eras, anchored at the prefix OR embedded after a slug, and
 * returns null for un-dated names (never guessed):
 *   YYMMDD-HHMM-slug[.ext] | YYMMDD-HHMM-slug/   → 20YY-MM   (current stamp prefix)
 *   YYYY-MM-DD[-slug][.ext] | YYYY-MM-DD/         → YYYY-MM   (legacy + day-logs + day-dirs)
 *   feedback-YYMMDD-HHMM.ext | council-YYMMDD…    → 20YY-MM   (embedded stamp — feedback-{stamp})
 * The embedded forms are guarded by a non-digit boundary on both sides so a longer
 * digit run can't yield a spurious match; epic-keyed retros (retro-tdd-3.md,
 * retro-platform-…-2026.md) carry no full date pattern and correctly stay null.
 */
function monthFromName(name) {
    // YYMMDD-HHMM (prefix or embedded after a non-digit boundary).
    let m = name.match(/(?:^|[^\d])(\d{2})(\d{2})\d{2}-\d{4}(?!\d)/);
    if (m) return `20${m[1]}-${m[2]}`;
    // YYYY-MM-DD (prefix or embedded).
    m = name.match(/(?:^|[^\d])(\d{4})-(\d{2})-\d{2}(?!\d)/);
    if (m) return `${m[1]}-${m[2]}`;
    return null;
}

function isPathSkipped(relPath) {
    const norm = relPath.replace(/\\/g, '/');
    return SKIP_PATH_RES.some((re) => re.test(norm));
}

/** The registry dir for a compartment kind (single source). Throws if unknown. */
function targetDirFor(kind) {
    const e = OUTPUT_PATHS[kind];
    if (!e || !e.dir) throw new Error(`migrate-output-layout: no OUTPUT_PATHS entry for kind "${kind}"`);
    return e.dir;
}

// ── --move planning (pure: reads dirs, mutates nothing) ─────────────────────
/**
 * Enumerate every old compartment under `outputRootAbs` and plan its relocation.
 * @returns {{ moves: Array<{from,to,fromAbs,toAbs,isDir}>,
 *             parked: Array<{from,reason}>,
 *             skipped: Array<{from,reason}> }}
 *   `from`/`to` are POSIX paths relative to outputRootAbs (for display/tests).
 */
function planMoves(outputRootAbs) {
    const moves = [];
    const parked = [];
    const skipped = [];
    const rel = (abs) => path.relative(outputRootAbs, abs).replace(/\\/g, '/');
    // Parked records carry kind/name/fromAbs/isDir so datedHoming() can compute a
    // real destination (git/fs create-date → month bucket) when --date-undated is set.
    const park = (fromAbs, reason, kind, isDir) =>
        parked.push({ from: rel(fromAbs), reason, kind, name: path.basename(fromAbs), fromAbs, isDir });

    for (const [oldDir, { kind }] of Object.entries(COMPARTMENT_MAP)) {   // `shape` is documentary; dir/file routing is date-driven
        const srcDir = path.join(outputRootAbs, oldDir);
        let st;
        try { st = fs.statSync(srcDir); } catch { continue; }
        if (!st.isDirectory()) continue;
        const targetDir = targetDirFor(kind);

        for (const name of fs.readdirSync(srcDir)) {
            const fromAbs = path.join(srcDir, name);

            // An already-bucketed month dir. At its final home (handoffs/, plans/)
            // this is a no-op; for a compartment moving to a new parent it relocates
            // as a unit. Path equality decides — keeps the codemod idempotent.
            if (/^\d{4}-\d{2}$/.test(name)) {
                const toAbs = path.join(outputRootAbs, targetDir, name);
                if (path.resolve(fromAbs) === path.resolve(toAbs)) {
                    skipped.push({ from: rel(fromAbs), reason: 'already-bucketed' });
                } else {
                    moves.push({ from: rel(fromAbs), to: rel(toAbs), fromAbs, toAbs, isDir: true });
                }
                continue;
            }

            let est;
            try { est = fs.statSync(fromAbs); } catch { continue; }

            if (est.isDirectory()) {
                // Directory handling is DATE-driven, not shape-driven: a dated dir is
                // moved whole into its month bucket — whether it's a sanctioned run-unit
                // (council-{stamp}/, skill-evolution/{stamp}/) or a legacy dated day-folder
                // (research/2026-02-16/, plans/2026-04-12/ that organize.cjs once created).
                // Only a NON-date subdir is the investigations/database/958 anti-pattern —
                // flagged, never moved.
                const month = monthFromName(name);
                if (month) {
                    const toAbs = path.join(outputRootAbs, targetDir, month, name);
                    moves.push({ from: rel(fromAbs), to: rel(toAbs), fromAbs, toAbs, isDir: true });
                } else {
                    park(fromAbs, 'adhoc-subdir-forbidden', kind, true);
                }
                continue;
            }

            // A file.
            const month = monthFromName(name);
            if (!month) { park(fromAbs, 'undated-file', kind, false); continue; }
            const toAbs = path.join(outputRootAbs, targetDir, month, name);
            moves.push({ from: rel(fromAbs), to: rel(toAbs), fromAbs, toAbs, isDir: false });
        }
    }

    // Known legacy loose files at the .output/ root (un-dated → park).
    for (const [name, { kind }] of Object.entries(LOOSE_FILES)) {
        const fromAbs = path.join(outputRootAbs, name);
        let st;
        try { st = fs.statSync(fromAbs); } catch { continue; }
        if (!st.isFile()) continue;
        const month = monthFromName(name);
        if (!month) { park(fromAbs, 'legacy-loose-undated', kind, false); continue; }
        const toAbs = path.join(outputRootAbs, targetDirFor(kind), month, name);
        moves.push({ from: rel(fromAbs), to: rel(toAbs), fromAbs, toAbs, isDir: false });
    }

    return { moves, parked, skipped };
}

// ── dated homing (--date-undated): give parked artifacts a REAL create-date ──
// Ledger/index files that are persistent (not a dated artifact) stay at the
// compartment root with NO month bucket.
const LEDGER_KEEP = new Set(['_decisions.md', 'README.md']);

/**
 * The create-date stamp (YYMMDD-HHMM) of a path: the first commit that ADDED it,
 * else the filesystem birthtime. Returns null when neither is available (then the
 * item stays parked — still never guessed). gitCwd is the tracked root to query.
 */
function createStamp(fromAbs, gitCwd) {
    if (gitCwd) {
        try {
            const out = execFileSync(
                'git',
                ['log', '--reverse', '--format=%ad', '--date=format:%y%m%d-%H%M', '--', fromAbs],
                { cwd: gitCwd, windowsHide: true },
            ).toString().trim();
            const first = out.split('\n')[0].trim();
            if (/^\d{6}-\d{4}$/.test(first)) return first;
        } catch { /* fall through to fs birthtime */ }
    }
    try {
        const bt = fs.statSync(fromAbs).birthtime;
        if (bt && !Number.isNaN(bt.getTime())) return stamp(bt);
    } catch { /* no birthtime */ }
    return null;
}

/**
 * F52: one batched first-add map for the whole repo, replacing a full
 * `git log --reverse` spawn PER parked artifact under --date-undated. One
 * oldest-first `--diff-filter=A --name-only` pass records each path's first
 * add stamp; lookups are O(1) per file. Returns null when git is unavailable
 * (callers fall back to the per-file query / fs birthtime).
 * @returns {{ repoRoot: string, map: Map<string, string> } | null}
 */
function buildCreateStampMap(gitCwd) {
    if (!gitCwd) return null;
    try {
        const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: gitCwd, windowsHide: true })
            .toString().trim();
        const out = execFileSync(
            'git',
            ['log', '--reverse', '--diff-filter=A', '--name-only', '--format=@%ad', '--date=format:%y%m%d-%H%M'],
            { cwd: gitCwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true },
        ).toString();
        const map = new Map();
        let cur = null;
        for (const line of out.split('\n')) {
            // Sentinel by SHAPE, not prefix — repo paths legitimately start
            // with '@' (`@scope/pkg/x.js`), and a bare startsWith('@') would
            // swallow such a file line as a "header", clobbering `cur` and
            // dropping every path after it in that commit (W6-M1, live repro).
            // A `--date=format:%y%m%d-%H%M` header always matches this shape;
            // an @-path never does.
            if (/^@\d{6}-\d{4}$/.test(line)) { cur = line.slice(1); continue; }
            const t = line.trim();
            // first sighting wins — the log is oldest-first, so this is the first add
            if (t && cur && !map.has(t)) map.set(t, cur);
        }
        // Canonicalize: git emits the LONG-name root while Node-fs callers can hold
        // the 8.3 short-name alias (Windows profile with a dotted username sets
        // %TEMP% to 8.3 short-name paths) — path.relative on the mixed pair mangles
        // every key and each stamp lookup silently misses (memory:
        // windows-short-name-tempdir-breaks-git-path-equality).
        return { repoRoot: canonicalAbs(repoRoot), map };
    } catch {
        return null;
    }
}

/** Long-name canonical form of an absolute path; falls back to the input when it doesn't resolve. */
function canonicalAbs(p) {
    try { return fs.realpathSync.native(p); } catch { return p; }
}

/**
 * Resolve a parked item's stamp from the batched map: exact path for files;
 * for a DIRECTORY (git records file paths only) the earliest add under its
 * prefix — the same commit the old per-path `git log -- <dir>` found first.
 * Returns null on a miss (item untracked) — caller falls to fs birthtime.
 */
function stampFromMap(stampHistory, fromAbs) {
    const key = path.relative(stampHistory.repoRoot, canonicalAbs(fromAbs)).replace(/\\/g, '/');
    const direct = stampHistory.map.get(key);
    if (direct) return direct;
    const prefix = key + '/';
    let earliest = null; // YYMMDD-HHMM sorts lexically = chronologically
    for (const [k, v] of stampHistory.map) {
        if (k.startsWith(prefix) && (earliest === null || v < earliest)) earliest = v;
    }
    return earliest;
}

/**
 * Plan a real home for each parked artifact:
 *   - LEDGER_KEEP file → {targetDir}/{name}            (root, no month, no date)
 *   - otherwise        → {targetDir}/{YYYY-MM}/{stamp}-{name}   (dated + bucketed)
 * An item whose create-date can't be resolved stays parked (never guessed).
 * `stampFn(fromAbs)` is injectable for tests; defaults to git/fs create-date.
 * @returns {{ homed: Array<{from,to,fromAbs,toAbs,isDir}>, stillParked: Array<{from,reason}> }}
 */
function datedHoming(parked, outputRootAbs, { stampFn } = {}) {
    const homed = [];
    const stillParked = [];
    const rel = (abs) => path.relative(outputRootAbs, abs).replace(/\\/g, '/');
    for (const p of parked) {
        const targetDir = targetDirFor(p.kind);
        if (!p.isDir && LEDGER_KEEP.has(p.name)) {
            const toAbs = path.join(outputRootAbs, targetDir, p.name);
            homed.push({ from: p.from, to: rel(toAbs), fromAbs: p.fromAbs, toAbs, isDir: false });
            continue;
        }
        const s = stampFn ? stampFn(p.fromAbs) : null;
        if (!s) { stillParked.push({ from: p.from, reason: `${p.reason} (no create-date)` }); continue; }
        const month = monthFromName(s);                    // s is YYMMDD-HHMM → 20YY-MM
        const toAbs = path.join(outputRootAbs, targetDir, month, `${s}-${p.name}`);
        homed.push({ from: p.from, to: rel(toAbs), fromAbs: p.fromAbs, toAbs, isDir: !!p.isDir });
    }
    return { homed, stillParked };
}

function isGitTracked(dir) {
    try {
        execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: 'ignore', windowsHide: true });
        return true;
    } catch { return false; }
}

function doMove(fromAbs, toAbs, gitCwd) {
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    if (gitCwd) {
        // git mv FROM INSIDE the repo (history-preserving). Fall back to a plain
        // rename only if git refuses (e.g. the path isn't tracked).
        try { execFileSync('git', ['mv', fromAbs, toAbs], { cwd: gitCwd, stdio: 'ignore', windowsHide: true }); return; }
        catch { /* fall through */ }
    }
    fs.renameSync(fromAbs, toAbs);
}

/**
 * Plan + (when apply) execute the compartment relocation.
 * With `dateUndated`, parked artifacts are additionally homed by their git/fs
 * create-date (LEDGER_KEEP files to the compartment root) — see datedHoming().
 * @returns {{ moves, parked, skipped, homed? }} — `homed` present iff dateUndated.
 */
function runMove(outputRoot, { apply = false, dateUndated = false } = {}) {
    const absOut = path.resolve(outputRoot);
    const gitCwd = isGitTracked(absOut) ? absOut : null;
    const plan = planMoves(absOut);
    if (dateUndated) {
        // F52: ONE history pass for all parked items; per-item lookup, with the
        // fs-birthtime fallback (createStamp with no gitCwd) for untracked
        // items. If the batched query itself failed, degrade to the original
        // per-file git query.
        const stampHistory = buildCreateStampMap(gitCwd);
        const { homed, stillParked } = datedHoming(plan.parked, absOut, {
            stampFn: (fromAbs) => stampHistory
                ? (stampFromMap(stampHistory, fromAbs) || createStamp(fromAbs, null))
                : createStamp(fromAbs, gitCwd),
        });
        plan.homed = homed;
        plan.parked = stillParked;
        if (apply) for (const m of homed) doMove(m.fromAbs, m.toAbs, gitCwd);
    }
    if (apply) for (const m of plan.moves) doMove(m.fromAbs, m.toAbs, gitCwd);
    return plan;
}

// ── reference rewriting (mirrors migrate-docs-domains) ──────────────────────
/** True if `oldTok` matches `line` at `i` with valid path boundaries. */
function matchesAt(line, i, oldTok) {
    if (!line.startsWith(oldTok, i)) return false;
    const before = i === 0 ? '' : line[i - 1];
    const afterPos = i + oldTok.length;
    const after = afterPos >= line.length ? '' : line[afterPos];
    const leadingOk = before === '' || !IDENT_RE.test(before);
    const trailingOk = oldTok.endsWith('/') || after === '' || !IDENT_RE.test(after);
    return leadingOk && trailingOk;
}

/**
 * Rewrite all REF_REWRITES occurrences in one line via a SINGLE left-to-right
 * scan. At each position the longest matching token wins; on a match we emit the
 * replacement and jump past the matched SOURCE, never re-examining emitted output
 * — so an inserted segment can't be re-matched by a shorter rule. Collision-safe
 * and inherently idempotent. Keep-marked lines pass through verbatim.
 */
function rewriteLine(line, rules = REF_REWRITES) {
    if (line.includes(LINE_KEEP_MARKER)) return { text: line, changed: false };
    let out = '';
    let i = 0;
    let changed = false;
    while (i < line.length) {
        let matched = null;
        for (const [oldTok, newTok] of rules) {   // longest-first
            if (matchesAt(line, i, oldTok)) { matched = [oldTok, newTok]; break; }
        }
        if (matched) {
            out += matched[1];
            i += matched[0].length;
            changed = true;
        } else {
            out += line[i];
            i++;
        }
    }
    return { text: out, changed };
}

/** Find legacy-token survivors in a line (for --verify). Returns [{token, col}]. */
function findSurvivors(line, rules = REF_REWRITES) {
    if (line.includes(LINE_KEEP_MARKER)) return [];
    const hits = [];
    let i = 0;
    while (i < line.length) {
        let matched = null;
        for (const [oldTok] of rules) {
            if (matchesAt(line, i, oldTok)) { matched = oldTok; break; }
        }
        if (matched) { hits.push({ token: matched, col: i + 1 }); i += matched.length; }
        else { i++; }
    }
    return hits;
}

/** Recursively collect text-file paths under a root, honoring the skip-allowlist. */
function collectFiles(absRoot, projectRoot, acc) {
    let stat;
    try { stat = fs.statSync(absRoot); } catch { return acc; }
    const rel = path.relative(projectRoot, absRoot);
    if (rel && isPathSkipped(rel)) return acc;
    if (stat.isDirectory()) {
        // Never descend into a nested git checkout (linked worktree / submodule /
        // nested clone) — a `.git` entry marks a foreign tree we must not rewrite.
        if (rel && fs.existsSync(path.join(absRoot, '.git'))) return acc;
        for (const entry of fs.readdirSync(absRoot)) {
            collectFiles(path.join(absRoot, entry), projectRoot, acc);
        }
    } else if (stat.isFile()) {
        if (TEXT_EXT.has(path.extname(absRoot))) acc.push(absRoot);
    }
    return acc;
}

function resolveFileset(projectRoot, explicitPaths) {
    if (explicitPaths && explicitPaths.length) {
        const acc = [];
        for (const p of explicitPaths) collectFiles(path.resolve(projectRoot, p), projectRoot, acc);
        return acc;
    }
    const acc = [];
    for (const r of TEMPLATE_FILESET) collectFiles(path.join(projectRoot, r), projectRoot, acc);
    for (const f of TEMPLATE_FILES) {
        const abs = path.join(projectRoot, f);
        if (fs.existsSync(abs)) collectFiles(abs, projectRoot, acc);
    }
    return acc;
}

/** @returns {{ changedFiles: Array<{file, hunks}>, scanned: number }} */
function runRefs(projectRoot, { apply = false, paths = null, rules = REF_REWRITES } = {}) {
    const files = resolveFileset(projectRoot, paths);
    const changedFiles = [];
    for (const abs of files) {
        const rel = path.relative(projectRoot, abs);
        if (isPathSkipped(rel)) continue;
        let content;
        try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        const lines = content.split('\n');
        const hunks = [];
        let fileChanged = false;
        const outLines = lines.map((line, i) => {
            const { text, changed } = rewriteLine(line, rules);
            if (changed) {
                fileChanged = true;
                hunks.push({ line: i + 1, before: line, after: text });
            }
            return text;
        });
        if (fileChanged) {
            changedFiles.push({ file: rel, hunks });
            if (apply) fs.writeFileSync(abs, outLines.join('\n'));
        }
    }
    return { changedFiles, scanned: files.length };
}

/** @returns {{ violations: Array<{file, line, token, col}>, scanned: number }} */
function runVerify(projectRoot, { paths = null, rules = REF_REWRITES } = {}) {
    const files = resolveFileset(projectRoot, paths);
    const violations = [];
    for (const abs of files) {
        const rel = path.relative(projectRoot, abs);
        if (isPathSkipped(rel)) continue;
        let content;
        try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        content.split('\n').forEach((line, i) => {
            for (const h of findSurvivors(line, rules)) {
                violations.push({ file: rel, line: i + 1, token: h.token, col: h.col });
            }
        });
    }
    return { violations, scanned: files.length };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function getRoot(argv) {
    const i = argv.indexOf('--root');
    if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
    return process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
}

function positional(argv) {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--root') { i++; continue; }
        if (a === '--move') { i++; continue; }   // its value is the outputRoot, not a path arg
        if (a.startsWith('--')) continue;
        out.push(a);
    }
    return out;
}

function main() {
    const argv = process.argv.slice(2);
    const apply = argv.includes('--apply');

    if (argv.includes('--move')) {
        let outputRoot = argv[argv.indexOf('--move') + 1];
        if (!outputRoot || outputRoot.startsWith('--')) {
            outputRoot = path.join(getRoot(argv), OUTPUT_ROOT);   // sensible default
        }
        const dateUndated = argv.includes('--date-undated');
        const r = runMove(outputRoot, { apply, dateUndated });
        const verb = apply ? 'MOVED' : 'DRY-RUN (no changes)';
        process.stdout.write(`.output layout migration — ${verb}  (root: ${outputRoot})${dateUndated ? '  [--date-undated]' : ''}\n\n`);
        for (const m of r.moves) process.stdout.write(`  mv  ${m.from}  →  ${m.to}\n`);
        if (r.homed && r.homed.length) {
            process.stdout.write(`\n  dated-homing (create-date → bucket; ledgers → root):\n`);
            for (const m of r.homed) process.stdout.write(`  mv  ${m.from}  →  ${m.to}\n`);
        }
        if (r.skipped.length) {
            process.stdout.write(`\n  skipped (already-bucketed): ${r.skipped.length}\n`);
        }
        if (r.parked.length) {
            process.stdout.write(`\n  ⚠ PARKED — needs manual attention (NOT moved):\n`);
            for (const p of r.parked) process.stdout.write(`    ${p.from}  [${p.reason}]\n`);
        }
        const homedN = r.homed ? r.homed.length : 0;
        process.stdout.write(`\n${r.moves.length} move(s)${homedN ? ` + ${homedN} dated-homed` : ''}${apply ? ' applied' : ' planned'}, ${r.parked.length} parked, ${r.skipped.length} skipped.\n`);
        process.exit(0);
    }

    if (argv.includes('--verify')) {
        const root = getRoot(argv);
        const paths = positional(argv);
        const force = argv.includes('--migrate-tracked-work');
        const { rules, suppressedWork, trackedCount } = effectiveRefRewrites(root, { force });
        const { violations, scanned } = runVerify(root, { paths: paths.length ? paths : null, rules });
        if (suppressedWork) process.stdout.write(trackedWorkNotice(trackedCount));
        if (violations.length === 0) {
            process.stdout.write(`--verify: clean — 0 legacy .output tokens across ${scanned} files.\n`);
            process.exit(0);
        }
        process.stdout.write(`--verify: ${violations.length} surviving legacy token(s):\n\n`);
        for (const v of violations) process.stdout.write(`  ${v.file}:${v.line}:${v.col}  ${v.token}\n`);
        process.exit(1);
    }

    if (argv.includes('--refs')) {
        const root = getRoot(argv);
        const paths = positional(argv);
        const force = argv.includes('--migrate-tracked-work');
        const { rules, suppressedWork, trackedCount } = effectiveRefRewrites(root, { force });
        const { changedFiles, scanned } = runRefs(root, { apply, paths: paths.length ? paths : null, rules });
        const verb = apply ? 'APPLIED' : 'DRY-RUN (no writes)';
        process.stdout.write(`--refs ${verb} — ${changedFiles.length}/${scanned} files would change\n`);
        if (suppressedWork) process.stdout.write(trackedWorkNotice(trackedCount));
        process.stdout.write('\n');
        for (const f of changedFiles) {
            process.stdout.write(`── ${f.file} (${f.hunks.length})\n`);
            for (const h of f.hunks) {
                process.stdout.write(`  ${h.line}- ${h.before.trim()}\n`);
                process.stdout.write(`  ${h.line}+ ${h.after.trim()}\n`);
            }
        }
        process.exit(0);
    }

    process.stderr.write('usage: migrate-output-layout.js [--move <outputRoot> [--date-undated]|--refs|--verify] [--apply] [--root <dir>] [--migrate-tracked-work] [paths…]\n');
    process.exit(2);
}

if (require.main === module) main();

module.exports = {
    OUTPUT_ROOT,
    COMPARTMENT_MAP,
    LOOSE_FILES,
    REF_REWRITES,
    monthFromName,
    targetDirFor,
    planMoves,
    datedHoming,
    createStamp,
    buildCreateStampMap,
    stampFromMap,
    LEDGER_KEEP,
    runMove,
    rewriteLine,
    findSurvivors,
    isPathSkipped,
    runRefs,
    runVerify,
    collectFiles,
    resolveFileset,
    trackedWorkFiles,
    effectiveRefRewrites,
    WORK_REF_RULE_TOKEN,
};
