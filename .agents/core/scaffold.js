#!/usr/bin/env node

/**
 * Project Scaffold
 *
 * Seeds the project's docs/ directory from two sources: skill-owned document
 * templates (SKILL_TEMPLATE_MANIFEST → each producing skill's assets/) and the
 * residual no-owner templates in .claude/templates/ (the CLAUDE.md docs-guide +
 * root/ configs). Creates the docs/ structure if it doesn't exist. Skips files
 * that already exist (safe to re-run).
 *
 * Usage: node .claude/core/scaffold.js [--force] [--set key=value ...]
 *   --force          Overwrite existing files (default: skip)
 *   --set key=value  Pre-substitute a known template placeholder. Repeatable.
 *                    See KNOWN_SCAFFOLD_VARS below for allowed keys.
 *                    Example: --set project_name=Foo --set repo_url=https://github.com/x/y
 *                    Substitution applies only to NEWLY copied files; pre-existing
 *                    targets are skipped per the standard scaffold semantics.
 *
 * Output structure (domain taxonomy — ADR docs/ Domain Taxonomy):
 *   docs/
 *   ├── CLAUDE.md                  (navigation contract)
 *   ├── product/                   (brief, requirements, context, brainstorm, research)
 *   ├── architecture/              (overview.md, decisions/)
 *   ├── design/                    (spec.md, wireframes.md, theme.{light,dark}.md, mock.html)
 *   ├── engineering/               (conventions.md, …)
 *   ├── operations/                (deploy.md, …)
 *   ├── work/                      (backlog.md, todo/)
 *   ├── reference/                 (onboarding.md, …)
 *   ├── modules/                   (per-feature docs — mirrors codebase)
 *   └── .output/                   (generated reports)
 *   .playwright/
 *   └── cli.config.json
 */

const fs = require('fs');
const path = require('path');
const CONSTANTS = require('./constants');
const { safeWrite, safeCopy } = require('./_lib/fs-safe');

const DEFAULT_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR ||
    path.resolve(__dirname, '..', '..');

// ── templates/root/ rename + merge map ──────────────────────────────────────
//
// Files inside .claude/templates/root/ are intended to land at the project
// root. Some target names (notably `.gitignore`) cannot be stored at the
// template path under the same name — git would interpret a file literally
// named `.gitignore` AT the template path as an active gitignore for the
// directory containing it, which then ignores sibling templates like
// .playwright/. We store such files under a safe name in templates/root/
// and rename them at scaffold time.
//
// `merge: true` enables managed-block merging — instead of skip-if-exists
// (the default), the template is appended into a fenced block at the end
// of any existing target file, and updated in place on subsequent runs.
// This preserves adopter-custom gitignore rules across re-scaffolds.

const TEMPLATE_RENAMES = {
    gitignore: { dest: '.gitignore', merge: true },
};

// ── skill-owned document templates → docs/ manifest ─────────────────────────
//
// Each producing skill owns the one canonical template for the artifact it
// produces, stored in that skill's assets/. scaffold.js seeds docs/ from these
// assets via this manifest instead of mirroring a global .claude/templates/
// copy. `from` is project-root-relative; `to` is docs/-relative.
//
// Graceful degradation: runScaffold skips any entry whose `from` asset does
// not yet exist (if (!fs.existsSync(srcAbs)) continue), so the manifest can be
// declared in full while the per-skill migrations land incrementally — until
// each asset exists, the residual .claude/templates/ copy still serves the
// artifact via the scaffoldDir call above. Templates with no owning skill
// (CLAUDE.md docs-guide, root/ configs) stay in .claude/templates/.

const SKILL_TEMPLATE_MANIFEST = [
    { from: '.claude/skills/ux-design/assets/spec.md', to: 'design/spec.md' },
    { from: '.claude/skills/ux-design/assets/wireframes.md', to: 'design/wireframes.md' },
    { from: '.claude/skills/ux-design/assets/theme.light.md', to: 'design/theme.light.md' },
    { from: '.claude/skills/ux-design/assets/theme.dark.md', to: 'design/theme.dark.md' },
    { from: '.claude/skills/ux-design/assets/mock.html', to: 'design/mock.html' },
    { from: '.claude/skills/architecture/assets/overview.md', to: 'architecture/overview.md' },
    { from: '.claude/skills/project-planning/assets/context.md', to: 'product/context.md' },
    { from: '.claude/skills/project-planning/assets/brief.md', to: 'product/brief.md' },
    { from: '.claude/skills/project-planning/assets/requirements.md', to: 'product/requirements.md' },
    { from: '.claude/skills/project-planning/assets/feature-ideas.md', to: 'work/todo/feature-ideas.md' },
    { from: '.claude/skills/project-planning/assets/backlog.md', to: 'work/backlog.md' },
];

// ── --set <key>=<value> non-interactive template substitution ───────────────
//
// R10 (2026-05-10): adopters running scaffold in CI / scripted setups can
// pre-fill well-known template placeholders without editing files manually.
//
// The allowlist is HARDCODED — adopters cannot extend it via flags or config.
// This mirrors the safety pattern used by publish.js DEFAULT_EXCLUDES: user
// config can pick values for keys we've vetted, but cannot introduce new keys.
// Prevents `--set arbitrary_field=anything` injection scenarios.
//
// Each entry maps one CLI key to one or more template placeholder forms (the
// templates use Title Case With Spaces in some places and snake_case in
// others). The validate function returns true on success, or a string error
// message on failure. parseSetArgs surfaces the message in the thrown Error.

const KNOWN_SCAFFOLD_VARS = [
    {
        key: 'project_name',
        placeholders: ['{Project Name}', '{project_name}'],
        validate: (v) => (v.length > 0 && v.length < 200) || 'project_name must be 1-199 chars',
    },
    {
        key: 'repo_url',
        placeholders: ['{repo URL}', '{repo_url}'],
        validate: (v) => /^https?:\/\/[^\s]+$/.test(v) || 'repo_url must be an http(s) URL',
    },
    {
        key: 'phase',
        placeholders: ['{current phase}', '{phase}'],
        validate: (v) => (v.length > 0 && v.length < 100) || 'phase must be 1-99 chars',
    },
    {
        key: 'date',
        placeholders: ['{YYYY-MM-DD}'],
        validate: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) || 'date must be YYYY-MM-DD',
    },
];

function _allowedKeysList() {
    return KNOWN_SCAFFOLD_VARS.map(v => v.key).join(', ');
}

function _findVar(key) {
    return KNOWN_SCAFFOLD_VARS.find(v => v.key === key) || null;
}

/**
 * Parse `--set key=value` (and `--set=key=value`) flags out of an argv array.
 * Returns a `{key: value}` object. Throws if any key is not in the allowlist
 * or any value fails its key's validate function.
 *
 * Tolerates two forms:
 *   --set key=value         (space-separated, current convention)
 *   --set=key=value         (equals form, some users prefer)
 *
 * Other flags in argv are ignored — only --set pairs are extracted.
 *
 * @param {string[]} argv - Argument array (typically process.argv.slice(2))
 * @returns {Object<string, string>} key→value map of parsed substitutions
 */
function parseSetArgs(argv) {
    const result = {};
    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i];
        let kv;

        if (tok === '--set') {
            const next = argv[i + 1];
            if (next === undefined) {
                throw new Error('--set requires a key=value argument');
            }
            kv = next;
            i++; // consume the value token
        } else if (tok && tok.startsWith('--set=')) {
            kv = tok.slice('--set='.length);
        } else {
            continue;
        }

        const eqIdx = kv.indexOf('=');
        if (eqIdx <= 0) {
            throw new Error(`--set value must be of form key=value, got: ${kv}`);
        }
        const key = kv.slice(0, eqIdx);
        const value = kv.slice(eqIdx + 1);

        const varDef = _findVar(key);
        if (!varDef) {
            throw new Error(
                `--set: unknown key "${key}". Allowed keys: ${_allowedKeysList()}.`
            );
        }
        const valid = varDef.validate(value);
        if (valid !== true) {
            const msg = typeof valid === 'string' ? valid : `invalid value for ${key}`;
            throw new Error(`--set ${key}: ${msg}`);
        }

        result[key] = value;
    }
    return result;
}

/**
 * Apply the substitutions returned by parseSetArgs to a file's text content.
 *
 * Iterates KNOWN_SCAFFOLD_VARS in declaration order; for each var with a
 * value in `substitutions`, runs `String.prototype.replaceAll` against each
 * declared placeholder form. Empty `substitutions` is a no-op.
 *
 * Pure function — no fs reads, no fs writes. Safe for unit testing.
 *
 * @param {string} content - File text to substitute into
 * @param {Object<string, string>} substitutions - Output of parseSetArgs
 * @returns {string} Content with substitutions applied
 */
function applySubstitutions(content, substitutions) {
    if (!content || !substitutions || Object.keys(substitutions).length === 0) {
        return content;
    }
    let result = content;
    for (const varDef of KNOWN_SCAFFOLD_VARS) {
        const value = substitutions[varDef.key];
        if (value === undefined) continue;
        for (const placeholder of varDef.placeholders) {
            result = result.split(placeholder).join(value);
        }
    }
    return result;
}

const MANAGED_START = '# === Domdhi.Agents managed block — do not edit between markers ===';
const MANAGED_END = '# === End Domdhi.Agents managed block ===';
const STARTUP_START = '# === Domdhi.Agents managed block — do not edit between markers ===';
const STARTUP_END = '# === End Domdhi.Agents managed block ===';

/** Locate complete startup blocks outside Markdown examples before any write. */
function startupBlockRanges(text, targetPath) {
    const ranges = [];
    let pending = null;
    let fence = null;
    let offset = 0;
    for (const line of text.split('\n')) {
        // Match the existing merger scanners' backtick/tilde fence handling;
        // their scanFenceState helpers are private, so keep this scan local.
        const token = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
            if (token && token[1][0] === fence[0] && token[1].length >= fence.length && !token[2].trim()) fence = null;
        } else if (token) {
            fence = token[1];
        } else {
            const start = /^# === ([A-Za-z0-9_-]+)\.Agents managed block — do not edit between markers ===$/.exec(line);
            const end = /^# === End ([A-Za-z0-9_-]+)\.Agents managed block ===$/.exec(line);
            if (start) {
                if (pending) throw new Error(`Corrupt managed block in ${targetPath}: nested start marker.`);
                pending = { start: offset, brand: start[1] };
            } else if (end) {
                if (!pending || pending.brand !== end[1]) throw new Error(`Corrupt managed block in ${targetPath}: unmatched end marker.`);
                ranges.push({ start: pending.start, end: offset + line.length });
                pending = null;
            }
        }
        offset += line.length + 1;
    }
    if (pending) throw new Error(`Corrupt managed block in ${targetPath}: start marker found but no valid end marker.`);
    if (fence) throw new Error(`Corrupt managed block in ${targetPath}: unclosed Markdown fence prevents safe startup block placement.`);
    return ranges;
}

/**
 * Apply a managed-block merge to a target file.
 *
 * Behavior:
 *   - target missing                       → write `${markers}\n${content}\n${end}\n`
 *   - target exists, no markers            → append a new managed block at end
 *   - target exists, markers found         → replace the block content in place
 *   - target exists, markers, no change    → no-op
 *
 * With `{ dryRun: true }` the action is computed and returned WITHOUT touching
 * the filesystem — used by template-updater's --dry-run to preview the merge.
 *
 * With `{ containRoot }` the write refuses a symlinked ancestor directory between
 * the target file and that root (fleet:sync / scaffold trust boundary).
 *
 * With `{ startup: true }`, normalize CRLF to LF and migrate all real Domdhi or
 * legacy startup blocks into one Domdhi block, retaining surrounding prose exactly.
 * Generic managed blocks (including .gitignore) retain their legacy behavior.
 *
 * @param {string} targetPath
 * @param {string} templateContent — raw contents of the template source file
 * @param {{ dryRun?: boolean, containRoot?: string, startup?: boolean }} [opts]
 * @returns {'created' | 'appended' | 'replaced' | 'unchanged'}
 */
function applyManagedBlock(targetPath, templateContent, opts) {
    const dryRun = !!(opts && opts.dryRun);
    const containRoot = opts && opts.containRoot;
    const startup = !!(opts && opts.startup);
    const trimmed = (startup ? templateContent.replace(/\r\n/g, '\n') : templateContent).replace(/\s+$/u, '');
    const block = `${startup ? STARTUP_START : MANAGED_START}\n${trimmed}\n${startup ? STARTUP_END : MANAGED_END}`;

    if (!fs.existsSync(targetPath)) {
        if (!dryRun) {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            safeWrite(targetPath, block + '\n', undefined, containRoot);
        }
        return 'created';
    }

    const original = fs.readFileSync(targetPath, 'utf8');
    const existing = startup ? original.replace(/\r\n/g, '\n') : original;
    if (startup) {
        const ranges = startupBlockRanges(existing, targetPath);
        if (ranges.length) {
            let newContent = '';
            let cursor = 0;
            for (const [index, range] of ranges.entries()) {
                newContent += existing.slice(cursor, range.start) + (index === 0 ? block : '');
                cursor = range.end;
            }
            newContent += existing.slice(cursor);
            if (newContent === original) return 'unchanged';
            if (!dryRun) safeWrite(targetPath, newContent, undefined, containRoot);
            return 'replaced';
        }
    }
    const startIdx = startup ? -1 : existing.indexOf(MANAGED_START);
    const endIdx = startup ? -1 : existing.indexOf(MANAGED_END);

    if (startIdx === -1) {
        const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
        const gap = existing.length === 0 ? '' : (existing.endsWith('\n\n') ? '' : '\n');
        if (!dryRun) safeWrite(targetPath, existing + sep + gap + block + '\n', undefined, containRoot);
        return 'appended';
    }

    if (endIdx === -1 || endIdx < startIdx) {
        throw new Error(
            `Corrupt managed block in ${targetPath}: start marker found but no valid end marker.`
        );
    }

    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + MANAGED_END.length);
    const newContent = before + block + after;

    if (newContent === existing) return 'unchanged';
    if (!dryRun) safeWrite(targetPath, newContent, undefined, containRoot);
    return 'replaced';
}

/**
 * Recursively copy a source directory to a destination, skipping excludes.
 *
 * When `substitutions` is non-empty, file contents are read as utf8 and
 * passed through `applySubstitutions` before write. Otherwise the legacy
 * `copyFileSync` path is used (preserves binary safety + speed).
 *
 * @param {string} srcDir     - Absolute path to source directory
 * @param {string} destDir    - Absolute path to destination directory
 * @param {string[]} [excludes] - Entry names to skip at the top level
 * @param {{ created: string[], skipped: string[], directories: string[] }} results - Accumulator
 * @param {boolean} [force]   - Overwrite existing files when true
 * @param {string} [projectDir] - Project root used to compute relative paths in results
 * @param {Object<string, string>} [substitutions] - --set key=value map; when non-empty,
 *   triggers content-aware copy with placeholder substitution
 * @param {string} [containRoot] - symlinked-ancestor guard root for writes. Anchored to
 *   the TOP-LEVEL destDir of the scaffold (NOT reportRoot, which is only a
 *   relative-path base for reporting and need not be an ancestor of destDir), and
 *   threaded UNCHANGED through recursion so every write in the tree is bounded by
 *   the scaffold destination it belongs to.
 */
function scaffoldDir(srcDir, destDir, excludes, results, force, projectDir, substitutions, containRoot) {
    const reportRoot = projectDir || DEFAULT_PROJECT_DIR;
    const subs = substitutions || {};
    const hasSubs = Object.keys(subs).length > 0;
    // First call anchors containment to this destDir; recursion inherits it verbatim.
    const root = containRoot || destDir;

    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
        results.directories.push(path.relative(reportRoot, destDir));
    }

    const entries = fs.readdirSync(srcDir, { withFileTypes: true });

    for (const entry of entries) {
        if (excludes && excludes.includes(entry.name)) continue;

        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);

        if (entry.isDirectory()) {
            // Recursive call: no top-level excludes, pass results + force + subs + root through
            scaffoldDir(srcPath, destPath, [], results, force, reportRoot, subs, root);
        } else {
            if (fs.existsSync(destPath) && !force) {
                results.skipped.push(path.relative(reportRoot, destPath));
            } else if (hasSubs) {
                // Content-aware copy: read template, apply substitutions, write.
                const content = fs.readFileSync(srcPath, 'utf8');
                safeWrite(destPath, applySubstitutions(content, subs), undefined, root);
                results.created.push(path.relative(reportRoot, destPath));
            } else {
                safeCopy(srcPath, destPath, root);
                results.created.push(path.relative(reportRoot, destPath));
            }
        }
    }
}

/**
 * Run the scaffold against an arbitrary project directory.
 *
 * @param {string} [projectDir] - Target project root (defaults to CLAUDE_PROJECT_DIR or this repo)
 * @param {{ force?: boolean, silent?: boolean, substitutions?: Object<string,string> }} [opts]
 * @returns {{ created: string[], skipped: string[], directories: string[] }}
 */
function runScaffold(projectDir, opts) {
    const target = projectDir || DEFAULT_PROJECT_DIR;
    const options = opts || {};
    const force = !!options.force;
    const silent = !!options.silent;
    const substitutions = options.substitutions || {};

    const templatesDir = path.join(target, '.claude', 'templates');
    const docsDir = path.join(target, 'docs');

    if (!fs.existsSync(templatesDir)) {
        if (!silent) {
            console.error('ERROR: Templates directory not found at .claude/templates/');
            console.error('Ensure the .claude/ directory was copied correctly.');
        }
        const err = new Error(`Templates directory not found: ${templatesDir}`);
        err.code = 'TEMPLATES_MISSING';
        throw err;
    }

    const results = { created: [], skipped: [], directories: [] };

    // Scaffold docs/ from templates (exclude root/ — those go to project root).
    // containRoot is anchored to `target` (project root, an ANCESTOR of docsDir),
    // not docsDir itself — assertNoSymlinkedAncestor only checks directories
    // STRICTLY BETWEEN dirname(dest) and containRoot, so containRoot===destDir
    // would leave a symlinked docs/ itself unchecked.
    scaffoldDir(templatesDir, docsDir, ['root'], results, force, target, substitutions, target);

    // Seed docs/ from skill-owned templates (SKILL_TEMPLATE_MANIFEST).
    // Graceful degradation: an entry whose source asset doesn't exist yet is
    // silently skipped, so the manifest can be declared in full while per-skill
    // migrations land incrementally. Same skip-if-exists / --force / --set
    // semantics as scaffoldDir above.
    //
    // Precedence: manifest `to` targets are expected to be DISJOINT from the
    // .claude/templates/ docs targets above (today templates ships only
    // CLAUDE.md + root/, no overlap). If a path is ever produced by both passes,
    // a normal run keeps the templates copy (skip-if-exists) while --force lets
    // this manifest pass overwrite it — keep them disjoint to avoid that asymmetry.
    const hasSubs = Object.keys(substitutions).length > 0;
    for (const entry of SKILL_TEMPLATE_MANIFEST) {
        const srcAbs = path.join(target, entry.from);
        if (!fs.existsSync(srcAbs)) continue;

        const dest = path.join(docsDir, entry.to);
        const relDest = path.relative(target, dest);

        if (fs.existsSync(dest) && !force) {
            results.skipped.push(relDest);
            continue;
        }

        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (hasSubs) {
            const content = fs.readFileSync(srcAbs, 'utf8');
            safeWrite(dest, applySubstitutions(content, substitutions), undefined, target);
        } else {
            safeCopy(srcAbs, dest, target);
        }
        results.created.push(relDest);
    }

    // Create additional directories that don't have templates
    const extraDirs = [
        // Domain folders that aren't seeded by a stub/asset (the ADR domain tree)
        'docs/modules',                 // per-feature docs — mirrors codebase (was app/)
        'docs/architecture/decisions',  // ADRs — NNNN-title.md
        'docs/engineering',             // setup.md conventions.md testing.md (no stub asset)
        'docs/operations/runbooks',
        'docs/reference',               // onboarding.md glossary.md links.md (no stub asset)
        'docs/work',
        'docs/work/todo',               // implementation checklists (+ _archive/)
        // Generated/operational zone (ADR 0006). Regenerable state lives under
        // the gitignored .state/ zone; durable compartments are created on demand
        // by output-paths.js, so only the always-present roots are seeded here.
        'docs/.output',
        'docs/.output/.state/work',         // task working files — .state/work/{date}/{task}/
        'docs/.output/.state/telemetry',    // command/gate/hook telemetry (gitignored)
        // Memory store split (ADR 0006 Amendment 2): the curated JSON SOURCE
        // under the TRACKED .memory/ (+ a dir per category), and the rebuilt
        // FTS5 index parent under the gitignored .state/memory-index/.
        'docs/.output/.memory',
        'docs/.output/.state/memory-index',
        ...Object.values(CONSTANTS.MEMORY_CATEGORIES).map((c) => `docs/.output/.memory/${c}`),
    ];
    for (const dir of extraDirs) {
        const fullPath = path.join(target, dir);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
            results.directories.push(dir);
        }
    }

    // Copy root-level config files from .claude/templates/root/.
    // Files in TEMPLATE_RENAMES get renamed at copy time and (if merge:true)
    // are merged into the target via a fenced managed block instead of being
    // skipped when the target already has user content.
    const rootTemplatesDir = path.join(templatesDir, 'root');
    if (fs.existsSync(rootTemplatesDir)) {
        const renameKeys = Object.keys(TEMPLATE_RENAMES);
        // Standard recursive copy first, but skip the renamed entries — those
        // are handled below with merge-aware logic. Substitutions thread through
        // so root-level templates also benefit from --set values.
        scaffoldDir(rootTemplatesDir, target, renameKeys, results, force, target, substitutions);

        for (const [srcName, rule] of Object.entries(TEMPLATE_RENAMES)) {
            const srcPath = path.join(rootTemplatesDir, srcName);
            if (!fs.existsSync(srcPath)) {
                // A declared rename whose source is missing is a template-author
                // misconfiguration — NOT a normal skip. This silently swallowed
                // the `.gitignore` vs `gitignore` naming bug: the dotted file was
                // never matched, so adopters' .gitignore never received the
                // managed block. Surface it loudly and record it so it can't recur.
                const msg = `TEMPLATE_RENAMES declares "${srcName}" but .claude/templates/root/${srcName} is missing — root file "${rule.dest}" was NOT scaffolded (was the asset renamed, e.g. to ".${srcName}"?)`;
                (results.warnings ||= []).push(msg);
                if (!silent) console.warn(`[scaffold] WARNING: ${msg}`);
                continue;
            }

            const destPath = path.join(target, rule.dest);
            const relDest = path.relative(target, destPath);

            if (rule.merge) {
                const content = fs.readFileSync(srcPath, 'utf8');
                const action = applyManagedBlock(destPath, content, { containRoot: target });
                if (action === 'unchanged') results.skipped.push(relDest);
                else results.created.push(`${relDest} (${action})`);
            } else if (fs.existsSync(destPath) && !force) {
                results.skipped.push(relDest);
            } else {
                safeCopy(srcPath, destPath, target);
                results.created.push(relDest);
            }
        }
    }

    if (!silent) {
        console.log('========================================');
        console.log('  Project Scaffold');
        console.log('========================================');

        if (results.directories.length > 0) {
            console.log(`\nDirectories created (${results.directories.length}):`);
            results.directories.forEach(d => console.log(`  + ${d}/`));
        }

        if (results.created.length > 0) {
            console.log(`\nFiles created (${results.created.length}):`);
            results.created.forEach(f => console.log(`  + ${f}`));
        }

        if (results.skipped.length > 0) {
            console.log(`\nFiles skipped — already exist (${results.skipped.length}):`);
            results.skipped.forEach(f => console.log(`  ~ ${f}`));
        }

        if (results.created.length === 0 && results.directories.length === 0) {
            console.log('\nAll files already exist. Nothing to do.');
            console.log('Use --force to overwrite existing files.');
        }

        console.log('\n========================================');
        console.log(`Done. ${results.created.length} created, ${results.skipped.length} skipped.`);
        console.log('========================================');
    }

    return results;
}

/**
 * CLI entry point: scaffold docs/ from templates and configure root files
 * for the default project (CLAUDE_PROJECT_DIR or this repo root).
 */
function main() {
    const argv = process.argv.slice(2);
    const force = argv.includes('--force');

    let substitutions;
    try {
        substitutions = parseSetArgs(argv);
    } catch (err) {
        console.error(`ERROR: ${err.message}`);
        process.exit(1);
    }

    runScaffold(DEFAULT_PROJECT_DIR, { force, substitutions });
}

if (require.main === module) {
    main();
}

module.exports = {
    scaffoldDir,
    runScaffold,
    applyManagedBlock,
    parseSetArgs,
    applySubstitutions,
    KNOWN_SCAFFOLD_VARS,
    TEMPLATE_RENAMES,
    SKILL_TEMPLATE_MANIFEST,
    MANAGED_START,
    MANAGED_END,
};
