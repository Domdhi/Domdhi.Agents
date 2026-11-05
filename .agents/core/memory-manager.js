#!/usr/bin/env node

/**
 * Memory Manager - Dual-storage: JSON files (source of truth) + SQLite FTS5 (search index)
 *
 * Split store (ADR 0006 Amendment 2 — see _lib/memory-paths.js):
 *   JSON source at docs/.output/.memory/{category}/{id}.json — TRACKED, human-readable
 *   SQLite index at docs/.output/.state/memory-index/memories.db — gitignored, rebuilt from JSON
 *
 * SQLite is optional — gracefully falls back to JSON scan if unavailable.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const CONSTANTS = require('./constants');
const {
    calculateDecayedConfidence: calcDecay,
    createActiveDaysResolver,
} = require('./_lib/memory-decay');
const { parseFrontmatter: parseFm } = require('./_lib/frontmatter');
const { resolveProjectRoot } = require('./_lib/project-root');
const { memoryPaths } = require('./_lib/memory-paths');
const { lintMemories: lintMemoriesLib } = require('./_lib/memory-lint');
const {
    ingestAgentMemory: ingestAgentMemoryLib,
    typeToCategory: ingestTypeToCategory,
    idFromFilename: ingestIdFromFilename,
    findMarkdownFiles: ingestFindMarkdownFiles,
} = require('./_lib/memory-ingest');
const { appendJsonl } = require('./_lib/jsonl-writer');
// Rebuild-status location and the shared index busy timeout.
const { rebuildStatusPath, INDEX_BUSY_TIMEOUT_MS } = require('./_lib/memory-index-divergence');

// Memory guard constants
// Cap source is constants.js; env override (MEMORY_MAX_PER_CATEGORY) applied here
// with the SAME expression as memory-guard.cjs so the two sites can never diverge.
const MAX_MEMORIES_PER_CATEGORY = parseInt(process.env.MEMORY_MAX_PER_CATEGORY, 10) || CONSTANTS.MEMORY_FILTERS.MEMORY_MAX_PER_CATEGORY;
const PRUNE_THRESHOLD_PERCENT = CONSTANTS.MEMORY_FILTERS.MEMORY_NEAR_LIMIT_PCT;
const PRUNE_MIN_AGE_DAYS = 30;
const PRUNE_MIN_CONFIDENCE = 0.3;
// Dead-weight flagger (ME-1.1): min active-work-days since `created` for a
// never-recalled memory to surface. Env override at the call site only —
// constants.js stays static (per static-constants-env-override-at-callsite).
const EXPOSURE_MIN_ACTIVE_DAYS = parseInt(process.env.MEMORY_EXPOSURE_MIN_DAYS, 10) || CONSTANTS.MEMORY_FILTERS.EXPOSURE_MIN_ACTIVE_DAYS;
// Write-time importance default (ME-2.1). Env override at the call site only.
const IMPORTANCE_DEFAULT = parseInt(process.env.MEMORY_IMPORTANCE_DEFAULT, 10) || CONSTANTS.MEMORY_FILTERS.IMPORTANCE_DEFAULT;
const IMPORTANCE_MIN = 1;
const IMPORTANCE_MAX = 5;
// Relevance scoring weights — single source for both search paths (FTS query
// mapper + JSON-fallback calculateRelevance). Never re-hardcode these.
const SCORING = CONSTANTS.MEMORY_SCORING;

// Coerce any author-supplied importance to an integer clamped to [1,5];
// non-numeric / missing → IMPORTANCE_DEFAULT.
function clampImportance(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return IMPORTANCE_DEFAULT;
    return Math.max(IMPORTANCE_MIN, Math.min(IMPORTANCE_MAX, n));
}

// MEM-11: collect every human-readable string VALUE from a content object,
// recursively (nested objects + arrays), joined by spaces. This is what gets
// FTS-indexed instead of raw JSON.stringify(content) — stringifying the whole
// object made JSON field NAMES (`description`, `confidence`, `evidence`, …)
// themselves searchable terms, so a query for "confidence" spuriously matched
// every memory that merely HAS a confidence field. Value-only extraction
// survives content shapes evolving (no hardcoded field list). Non-string
// scalars (numbers/booleans/null) are skipped — they aren't search terms.
// No depth/cycle guard: `value` always originates from JSON.parse of a store
// file or an in-process JSON-derived object — author-controlled, never
// adversarial external input, and JSON.parse cannot produce a cycle. If this
// function is ever fed anything else, that assumption needs revisiting.
function collectContentText(value) {
    const out = [];
    const walk = (v) => {
        if (typeof v === 'string') { out.push(v); return; }
        if (Array.isArray(v)) { for (const item of v) walk(item); return; }
        if (v && typeof v === 'object') { for (const key of Object.keys(v)) walk(v[key]); }
    };
    walk(value);
    return out.join(' ');
}

// F42: charset guard for any caller-supplied `id` that becomes a `.json`
// filename segment (createMemory/readMemory/updateMemory/deleteMemory all join
// it straight into `path.join(this.memoriesDir, category, filename + '.json')`).
// idToFilename() only ever swaps '_' -> '-', so the existing memory-id
// convention is already confined to lowercase alnum + '_'/'-' (leading
// underscore included — memory-health-check.js's fixed probe id is
// '_health_check_probe') — matching that convention as a whitelist means '..',
// '/', '\\', and an absolute-path leader can never reach the join, closing the
// read/write/delete escape. Applied BEFORE any path is built.
const SAFE_ID_RE = /^[a-z0-9_][a-z0-9_-]*$/;

function isSafeMemoryId(value) {
    return typeof value === 'string' && SAFE_ID_RE.test(value);
}

/**
 * Convert a freeform search string into an FTS5 query.
 *
 * FTS5's default match mode is AND, which makes multi-word ad-hoc queries like
 * "publish tooling refactor" return [] unless one memory contains every term.
 * Callers (commands, agents) write multi-word topic queries expecting OR-style
 * fuzzy match, so split-and-OR-join is the right default. Power users can still
 * force phrase/AND/NEAR by writing FTS5 syntax explicitly.
 *
 * Pass-through cases (caller knows what they want):
 *   - Contains FTS5 operators (OR, AND, NOT, NEAR — incl. the NEAR/N distance form)
 *   - Contains quote/colon/caret/star/paren — explicit FTS5 syntax
 *
 * Otherwise: tokenize on non-word chars, drop tokens shorter than 2, OR-join.
 *
 * HYPHENS are token SEPARATORS here, not intra-token chars. FTS5 treats a bare
 * `-` as a query operator, so passing a kebab term like "walk-forward" straight
 * to MATCH throws ("no such column: forward") — the FTS path then errors out to
 * the weak full-string JSON substring scan, and a multi-word query silently
 * returns []. The indexed content is tokenized on hyphens too (porter/unicode61
 * splits them), so "walk-forward" → "walk OR forward" both parses cleanly AND
 * matches the index. `_` stays intra-token (FTS5 keeps it; barewords like
 * PATH_REMAPS must survive).
 *
 * Degenerate inputs (0-1 usable tokens) return a hyphen-free string so a lone
 * "x-ray"/"a-b" can never reach MATCH with an operator-hyphen intact.
 */
function buildFtsQuery(searchTerm) {
    if (!searchTerm || typeof searchTerm !== 'string') return searchTerm;
    if (/[":^*()]/.test(searchTerm)) return searchTerm;
    if (/\b(OR|AND|NOT|NEAR)\b/.test(searchTerm)) return searchTerm;
    return tokenizeToOrQuery(searchTerm);
}

/**
 * The tokenize-and-OR-join half of buildFtsQuery, callable directly as a FALLBACK.
 *
 * buildFtsQuery passes a string through UNMODIFIED when it looks like deliberate
 * FTS5 syntax (quotes/paren/operators). But ordinary prose descriptions also carry
 * that punctuation — a full sentence like "…usage_count is a broken instrument
 * (see notes)." trips the paren check, gets passed through raw, and any hyphenated
 * word in it then makes FTS5's MATCH throw ("no such column: …"). detectOverlap
 * sends exactly that shape on every createMemory, so write-time supersession
 * detection silently no-ops (M1). searchMemories has the same failure mode.
 *
 * Callers wrap the raw buildFtsQuery attempt in try/catch and retry with THIS —
 * a strictly tokenized OR-join that can never carry an operator-hyphen to MATCH —
 * before giving up to the JSON-scan fallback.
 */
function tokenizeToOrQuery(searchTerm) {
    if (!searchTerm || typeof searchTerm !== 'string') return searchTerm;
    const tokens = searchTerm.split(/[^a-zA-Z0-9_]+/).filter(t => t.length > 1);
    if (tokens.length === 0) return searchTerm.replace(/-+/g, ' ').trim() || searchTerm;
    if (tokens.length === 1) {
        // N1: a lone survivor after length-filtering can mean the raw query had a
        // single-char leading token ("x-ray" → only "ray" survives), silently
        // dropping data. When 2+ raw tokens existed, keep them all as a hyphen-free
        // (AND) join rather than searching for just the survivor.
        const rawTokens = searchTerm.split(/[^a-zA-Z0-9_]+/).filter(Boolean);
        if (rawTokens.length > 1) return rawTokens.join(' ');
        return tokens[0];
    }
    return tokens.join(' OR ');
}

// SQLite backend resolution — shared with memory-backup.js via
// _lib/sqlite-backend.js (F36), so the backup's corruption gate and this
// store's reader can never disagree about which driver is in play. Resolution
// runs once at require time; the probe/preference doctrine (node:sqlite first
// on Node 24+, capability-probed FTS5, json-only fallback) is documented in
// the shared module.
const { resolveSqliteBackend } = require('./_lib/sqlite-backend');
const {
    DatabaseSync,           // null → JSON-only linear scan over per-category files
    backend: sqliteBackend,
    supportsFts5: sqliteSupportsFts5,
} = resolveSqliteBackend();

class MemoryManager {
    constructor() {
        // Split store (ADR 0006 Amendment 2): the curated JSON source resolves
        // via the CURRENT worktree (jsonRoot, now TRACKED), while the rebuilt db
        // and transient drafts/logs stay anchored to the MAIN worktree under
        // .state/ (gitignored). See _lib/memory-paths.js for the resolver split.
        // CLAUDE_PROJECT_DIR still overrides both. this.projectRoot keeps the
        // anchored root — the active-days resolver reads git history from it.
        const projectRoot = resolveProjectRoot(path.resolve(__dirname, '..', '..'));
        this.projectRoot = projectRoot;
        const paths = memoryPaths(path.resolve(__dirname, '..', '..'));
        this.memoriesDir = paths.jsonRoot;
        this.dbPath = paths.dbPath;
        this.inboxDir = paths.inboxDir;
        this.categories = Object.values(CONSTANTS.MEMORY_CATEGORIES);
        this.db = null;
        this._activeDaysResolver = createActiveDaysResolver({ projectRoot });
        // C5/F16: self-heal the store on construction — independent of SQLite
        // availability. Previously the category dirs were only created lazily
        // inside initDb() (write/search paths), so a brownfield onboard that
        // never wrote a memory left the store unseeded and read-only tools
        // (`report`/`lint`) ran against missing dirs. ensureDirs makes ANY
        // MemoryManager access self-heal the 5 category dirs. The store is
        // local-only/gitignored/regenerable, so creating empty dirs is harmless.
        this.ensureDirs();
    }

    /**
     * Self-heal the on-disk store: create memoriesDir + all 5 category dirs.
     * No SQLite dependency — runs even in JSON-only mode. Idempotent.
     */
    ensureDirs() {
        try {
            fsSync.mkdirSync(this.memoriesDir, { recursive: true });
            for (const category of this.categories) {
                fsSync.mkdirSync(path.join(this.memoriesDir, category), { recursive: true });
            }
            // The db and inbox now live under the split .state/ half, no longer
            // colocated inside memoriesDir — create their parents too so the
            // first write/search/inbox op never races a missing dir.
            fsSync.mkdirSync(path.dirname(this.dbPath), { recursive: true });
            fsSync.mkdirSync(this.inboxDir, { recursive: true });
        } catch { /* best-effort — a read-only FS shouldn't crash construction */ }
    }

    /**
     * Initialize SQLite database (lazy — called on first write or search)
     */
    initDb() {
        if (this.db) return true;
        if (!DatabaseSync) return false;

        try {
            this.ensureDirs();
            this.db = new DatabaseSync(this.dbPath);
            // Wait for another process's write (an overlapping rebuild, a
            // hook's recall bump) instead of failing it with "database is locked".
            this.db.exec(`PRAGMA busy_timeout = ${INDEX_BUSY_TIMEOUT_MS}`);
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY,
                    category TEXT NOT NULL,
                    content TEXT NOT NULL,
                    metadata TEXT,
                    created TEXT NOT NULL,
                    updated TEXT NOT NULL,
                    usage_count INTEGER DEFAULT 0,
                    confidence REAL DEFAULT 1.0,
                    importance INTEGER DEFAULT 3,
                    invalid_at TEXT,
                    superseded_by TEXT
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                    id, category, content, tokenize='porter'
                );
            `);
            // Idempotent additive migrations for databases created before a column
            // existed. ensureColumn is the SINGLE migration seam — every new column
            // (ME-2.1 importance; ME-3.1 invalid_at/superseded_by; …) goes through
            // it. Do NOT author a second idempotency strategy elsewhere.
            this.ensureColumn('memories', 'importance', 'importance INTEGER DEFAULT 3');
            this.ensureColumn('memories', 'invalid_at', 'invalid_at TEXT');
            this.ensureColumn('memories', 'superseded_by', 'superseded_by TEXT');
            return true;
        } catch (e) {
            // Close the handle if `new DatabaseSync()` succeeded but `exec()`
            // threw (e.g. FTS5 not compiled in). Otherwise the file lock leaks
            // and the db file is undeletable until process exit — surfaces on
            // Windows as EPERM on tmp-dir cleanup in tests.
            console.error('SQLite init failed (falling back to JSON-only):', e.message);
            if (this.db) {
                try { this.db.close(); } catch { /* non-fatal */ }
            }
            this.db = null;
            return false;
        }
    }

    /**
     * Idempotent additive column migration. Checks PRAGMA table_info(table) for
     * `column` and runs `ALTER TABLE ... ADD COLUMN ${ddl}` only if absent — never
     * a blind catch-on-duplicate. Safe to call on every initDb; a no-op once the
     * column exists. This is the contract every schema-adding story extends.
     *
     * @param {string} table  - table name (already trusted, internal use only)
     * @param {string} column - the column to ensure exists
     * @param {string} ddl    - the column definition for ADD COLUMN, e.g. 'importance INTEGER DEFAULT 3'
     */
    ensureColumn(table, column, ddl) {
        if (!this.db) return;
        try {
            // SECURITY: `table`/`column`/`ddl` are interpolated into raw SQL below
            // (PRAGMA/ALTER TABLE cannot bind identifiers). They MUST remain
            // caller-supplied HARDCODED CONSTANTS only — never derive any of them
            // from user/agent input, or this becomes a SQL-injection sink. Every
            // current caller passes string literals; keep it that way.
            const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
            if (cols.some((c) => c.name === column)) return; // already present — no-op
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
        } catch (e) {
            // Non-fatal: JSON remains the source of truth and reads default the
            // missing column (e.g. importance ?? 3). A locked/old DB must not crash.
            console.error(`ensureColumn(${table}.${column}) failed (non-fatal):`, e.message);
        }
    }

    /**
     * Read the live `usage_count` for every indexed memory as an `id -> count` Map.
     * usage_count lives ONLY in the gitignored SQLite index now (_recordRecall bumps
     * it there, never the git-tracked `.memory/` JSON — ADR 0006 Am. 2 / F44), so this
     * is the single source of the live value. ONE query per call. When there is no
     * index (SQLite unavailable / JSON-scan fallback) the Map is empty and callers
     * fall back to the JSON baseline unchanged. Pure read — never mutates.
     *
     * @returns {Map<string, number>}
     */
    _indexUsageMap() {
        const map = new Map();
        if (!this.initDb() || !this.db) return map;
        try {
            const rows = this.db.prepare('SELECT id, usage_count FROM memories').all();
            for (const r of rows) map.set(r.id, r.usage_count || 0);
        } catch {
            // Non-fatal — JSON baseline values pass through unchanged.
        }
        return map;
    }

    /**
     * Upsert a memory into SQLite index.
     *
     * usage_count is the live source in the index (F44): _recordRecall increments it
     * here, not in the JSON. An INSERT OR REPLACE from the JSON baseline (~always 0)
     * would wipe accumulated recalls on every update AND every rebuild. To prevent
     * that, the row's usage_count is floored to the max of the JSON value and either
     * (a) `usageFloor` — an explicit prior value from a pre-DELETE snapshot, used by
     * rebuildIndex where the current row is already gone — or, when `usageFloor` is
     * null, (b) the current row's live value read here (the create/update paths).
     *
     * @param {object} memory
     * @param {number|null} [usageFloor=null] - prior usage_count when the row was
     *   snapshotted before deletion (rebuildIndex); null → read the current row.
     */
    indexMemory(memory, usageFloor = null) {
        if (!this.initDb()) return false;
        try {
            // Floor usage_count so accumulated live recalls survive a re-index.
            let floor = usageFloor;
            if (floor === null) {
                try {
                    const row = this.db.prepare('SELECT usage_count FROM memories WHERE id = ?').get(memory.id);
                    floor = row ? (row.usage_count || 0) : 0;
                } catch {
                    floor = 0;
                }
            }
            const usage = Math.max(memory.usage_count || 0, floor);

            // Upsert main table
            const stmt = this.db.prepare(`
                INSERT OR REPLACE INTO memories (id, category, content, metadata, created, updated, usage_count, confidence, importance, invalid_at, superseded_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(
                memory.id, memory.category,
                JSON.stringify(memory.content), JSON.stringify(memory.metadata),
                // ?? null: node:sqlite cannot bind undefined — a hand-authored
                // record missing `updated` used to abort indexing here, leaving
                // that memory silently invisible to FTS search (retro 260716).
                memory.created ?? null, memory.updated ?? memory.created ?? null,
                usage, memory.metadata?.confidence ?? 1.0,
                clampImportance(memory.importance ?? memory.content?.importance),
                memory.invalid_at ?? null, memory.superseded_by ?? null
            );

            // Upsert FTS
            this.db.prepare('DELETE FROM memories_fts WHERE id = ?').run(memory.id);
            const ftsStmt = this.db.prepare(`
                INSERT INTO memories_fts (id, category, content) VALUES (?, ?, ?)
            `);
            // MEM-11: index the human-readable string values only, not raw JSON —
            // otherwise field NAMES leak into the search vocabulary.
            ftsStmt.run(memory.id, memory.category, collectContentText(memory.content));
            return true;
        } catch (e) {
            // Non-fatal — JSON is the source of truth. Report the outcome so
            // rebuildIndex counts only rows it actually wrote.
            console.error('SQLite index error:', e.message);
            this.lastIndexError = e.message;
            return false;
        }
    }

    /**
     * Remove a memory from SQLite index
     */
    deindexMemory(id) {
        if (!this.db) return;
        try {
            this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
            this.db.prepare('DELETE FROM memories_fts WHERE id = ?').run(id);
        } catch {
            // Non-fatal
        }
    }

    static idToFilename(id) {
        return id.replace(/_/g, '-');
    }


    /**
     * Get the count of LIVE memories in a category.
     *
     * MEM-6: counts only live entries — superseded memories (invalid_at set) are
     * dead history, and counting them let the per-category cap in createMemory be
     * blocked by tombstones even when the true live count was well under the cap.
     *
     * Deliberately does NOT delegate to listMemories(): that method also queries
     * the SQLite usage-index and computes decayed_confidence for every record —
     * far more work than a cap check needs, AND its `listMemories` call is a
     * scan the F39 single-pass health-check invariant counts on (createMemory's
     * two getMemoryCount calls would otherwise inject 2 uncounted whole-category
     * re-scans into a health-check run that writes a probe memory). This does
     * its own minimal read — file content only enough to check `invalid_at` —
     * so it stays outside the listMemories call-count contract entirely.
     *
     * The JSON files stay the authority here (NOT the SQLite index): the index is
     * a derived cache that can legitimately lag a file written out-of-band, and
     * undercounting would let a write slip past the per-category cap. What IS
     * skipped is the `JSON.parse` — a file that doesn't contain the literal key
     * `"invalid_at"` anywhere cannot have a top-level `invalid_at`, so it's live
     * by inspection. Only the (rare) files that do contain the substring are
     * parsed, which is what made this scan expensive at ~350 memories per category.
     */
    async getMemoryCount(category) {
        const dir = path.join(this.memoriesDir, category);
        let count = 0;
        try {
            const files = await fs.readdir(dir);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                try {
                    const raw = await fs.readFile(path.join(dir, file), 'utf-8');
                    if (!raw.includes('"invalid_at"')) { count++; continue; }
                    const memory = JSON.parse(raw);
                    if (!memory.invalid_at) count++;
                } catch {
                    // unreadable/malformed store file — skip, matching
                    // pruneStaleMemories' tolerance for the same case
                }
            }
        } catch {
            return 0;
        }
        return count;
    }

    /**
     * Prune stale memories — removes memories older than maxAgeDays
     * with confidence below minConfidence
     */
    async pruneStaleMemories(category, maxAgeDays = PRUNE_MIN_AGE_DAYS, minConfidence = PRUNE_MIN_CONFIDENCE) {
        const dir = path.join(this.memoriesDir, category);
        let pruned = 0;
        try {
            const files = await fs.readdir(dir);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                const filePath = path.join(dir, file);
                try {
                    const raw = await fs.readFile(filePath, 'utf-8');
                    const memory = JSON.parse(raw);
                    const activeDays = this.getActiveDaysSince(memory.updated);
                    const confidence = memory.metadata?.confidence ?? 1.0;
                    if (activeDays > maxAgeDays && confidence < minConfidence) {
                        await fs.unlink(filePath);
                        this.deindexMemory(memory.id);
                        pruned++;
                        console.log(`🗑️  Pruned stale memory: ${category}/${file} (${Math.round(activeDays)} active days, confidence ${confidence})`);
                    }
                } catch {
                    // Skip unreadable files
                }
            }
        } catch {
            // Category dir doesn't exist — nothing to prune
        }
        return pruned;
    }

    /**
     * Create a new memory (JSON + SQLite)
     *
     * F10: read-before-write collision guard. Without it a second createMemory
     * at the same (category, id) silently destroys the prior file — including
     * its accumulated confidence history and any `promoted_to` marker — with
     * detectOverlap then running against the new content after the old memory
     * is already gone. Refuses by default; pass `{ overwrite: true }` when the
     * caller's intent genuinely is a rewrite (e.g. a hand-authored re-seed).
     * Routine *updates* should go through updateMemory(), not a second createMemory.
     *
     * @param {string} category
     * @param {string} id
     * @param {object} content
     * @param {{overwrite?: boolean}} [opts]
     * @returns {Promise<object|null>} the created memory, or null on collision/cap
     */
    async createMemory(category, id, content, opts = {}) {
        const { overwrite = false } = opts;
        if (!this.categories.includes(category)) {
            throw new Error(`Invalid category: ${category}`);
        }
        if (!isSafeMemoryId(id)) {
            throw new Error(`Invalid id: "${id}" — must be lowercase alphanumeric with '-'/'_' only (no path separators)`);
        }

        if (!overwrite) {
            const existing = await this.readMemory(category, id);
            if (existing) {
                console.log(`⛔ Memory guard: ${category}/${id} already exists — refusing to overwrite. Pass {overwrite:true} to replace it, or use updateMemory() to modify it.`);
                return null;
            }
        }

        // Memory explosion guard.
        // The second count is only taken when a prune actually RAN — otherwise the
        // store is provably unchanged since the first scan and the recount was a
        // duplicate whole-category read+parse on every single create (two full
        // scans per write at ~350 files/category). It is NOT derived arithmetically
        // from `pruned`: pruneStaleMemories deletes by age+confidence regardless of
        // `invalid_at`, so its return value can include tombstones that never
        // counted as live, and `count - pruned` would UNDERcount and let a write
        // slip past the cap.
        let currentCount = await this.getMemoryCount(category);
        if (currentCount >= MAX_MEMORIES_PER_CATEGORY * PRUNE_THRESHOLD_PERCENT) {
            const pruned = await this.pruneStaleMemories(category);
            if (pruned > 0) {
                console.log(`⚠️  Memory guard: auto-pruned ${pruned} stale memories from ${category}`);
                currentCount = await this.getMemoryCount(category);
            }
        }
        if (currentCount >= MAX_MEMORIES_PER_CATEGORY) {
            console.log(`⛔ Memory guard: ${category} has ${currentCount} entries (max ${MAX_MEMORIES_PER_CATEGORY}). Skipping write for ${id}. Run prune or increase limit.`);
            return null;
        }

        const TYPE_MAP = {
            patterns: 'pattern',
            constraints: 'constraint',
            decisions: 'decision',
            workflows: 'workflow',
            'rejected-approaches': 'rejected-approach',
        };
        // MEM-10: importance is a TOP-LEVEL field only. Clone the caller's content
        // (never mutate their input) and strip any `importance` key so it can't
        // drift out of sync with the promoted top-level value after a later update.
        const storedContent = { ...content };
        delete storedContent.importance;
        const memory = {
            id,
            type: TYPE_MAP[category] || category.slice(0, -1),
            category,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            usage_count: 0,
            // Write-time importance (1–5) — the retention floor. Read from the
            // author-supplied content.importance, clamped; defaults to 3. Stored
            // top-level (mirrors usage_count) so decay/ranking read it without a
            // content round-trip; also persisted to the importance SQLite column.
            importance: clampImportance(content.importance ?? IMPORTANCE_DEFAULT),
            content: storedContent,
            metadata: {
                sessions: [],
                agents: [],
                confidence: 1.0
            }
        };

        // Write JSON (source of truth)
        const filename = MemoryManager.idToFilename(id);
        const categoryDir = path.join(this.memoriesDir, category);
        await fs.mkdir(categoryDir, { recursive: true });
        const filePath = path.join(categoryDir, `${filename}.json`);
        await fs.writeFile(filePath, JSON.stringify(memory, null, 2));

        // Index in SQLite
        this.indexMemory(memory);

        // Write-time supersession detection (ME-3.2) — cheap LLM-free FTS overlap
        // against existing same-category memories. FLAG ONLY: attaches candidate
        // predecessor ids to the returned object so the Main Agent can confirm a
        // supersede at /end. Never auto-supersedes. Transient (not written to JSON).
        const candidates = this.detectOverlap(category, content, id);
        if (candidates.length > 0) memory.supersedes_candidates = candidates;

        console.log(`✅ Memory created: ${category}/${id}`);
        return memory;
    }

    /**
     * Cheap, LLM-free write-time overlap detection: FTS5-match the new content's
     * terms against EXISTING live same-category memories. Returns likely-superseded
     * predecessor ids (flag only — the caller decides whether to supersede).
     *
     * @param {string} category
     * @param {object} contentObj - the new memory's content
     * @param {string} excludeId  - the new memory's own id (exclude self)
     * @returns {string[]} predecessor ids (empty if none / no FTS / error)
     */
    detectOverlap(category, contentObj, excludeId) {
        if (!this.initDb()) return [];
        const text = (contentObj && contentObj.description) || (contentObj ? JSON.stringify(contentObj) : '');
        const q = buildFtsQuery(text);
        if (!q) return [];
        const sql = `
                SELECT m.id
                FROM memories_fts fts
                JOIN memories m ON fts.id = m.id
                WHERE memories_fts MATCH ?
                  AND m.category = ?
                  AND m.id != ?
                  AND m.invalid_at IS NULL
                ORDER BY rank
                LIMIT 5
            `;
        const run = (query) => this.db.prepare(sql).all(query, category, excludeId).map(r => r.id);
        try {
            return run(q);
        } catch {
            // buildFtsQuery passed the description through raw (punctuation heuristic)
            // and a hyphen in it made MATCH throw — the exact shape that silently
            // no-op'd write-time supersession detection (M1). Retry tokenized before
            // giving up: a real overlap should still be flagged.
            try {
                return run(tokenizeToOrQuery(text));
            } catch {
                // FTS genuinely unavailable (node:sqlite without fts5) — no flag
                return [];
            }
        }
    }

    /**
     * Supersede an old memory with a newer one: stamp invalid_at + superseded_by,
     * deindex from active FTS (so it stops surfacing in current-state search), but
     * keep the JSON + main db row as history (readable via includeSuperseded).
     * Idempotent — a re-run keeps the original invalid_at and returns success.
     * Flag-then-confirm: this is the CONFIRM half (the Main Agent calls it).
     *
     * @param {string} category
     * @param {string} oldId
     * @param {string} newId
     * @returns {Promise<{superseded: boolean, error?: string, invalid_at?: string}>}
     */
    async supersede(category, oldId, newId) {
        if (!this.categories.includes(category)) {
            return { superseded: false, error: `Invalid category: ${category}` };
        }
        // MEM-8 (wave-4 code review): a self-supersede (oldId === newId) would
        // pass every other check below — readMemory finds it, the "successor
        // exists" check finds it (it's the same file) — then stamp its own
        // invalid_at + superseded_by pointing at itself, hiding the memory behind
        // a reference to its own now-invalid record. Refuse before any lookup.
        if (oldId === newId) {
            return { superseded: false, error: 'A memory cannot supersede itself' };
        }
        const memory = await this.readMemory(category, oldId);
        if (!memory) {
            return { superseded: false, error: `Memory not found: ${category}/${oldId}` };
        }
        // MEM-8: the successor must actually exist, else a typo'd/deleted newId
        // creates a dangling superseded_by pointer that hides the old memory behind
        // a reference to nothing. readMemory only searches the SAME category — a
        // cross-category supersede is intentionally unsupported (all real call sites
        // supersede within one category; see memory-eval.js SEED_MEMORIES pairs).
        if (!(await this.readMemory(category, newId))) {
            return { superseded: false, error: `Successor memory not found: ${category}/${newId}` };
        }

        // Idempotent: keep the original invalid_at if already superseded.
        const invalidAt = memory.invalid_at || new Date().toISOString();
        memory.invalid_at = invalidAt;
        memory.superseded_by = newId;

        // Persist to JSON (source of truth)
        const filename = MemoryManager.idToFilename(oldId);
        const filePath = path.join(this.memoriesDir, category, `${filename}.json`);
        await fs.writeFile(filePath, JSON.stringify(memory, null, 2));

        // Deindex from active FTS + stamp the db row (kept for history).
        // MEM-5: track whether the index update actually failed so we don't tell the
        // caller supersession fully succeeded while the memory keeps surfacing in FTS
        // search until the next rebuild-index.
        let indexStale = false;
        if (this.initDb()) {
            try {
                this.db.prepare('DELETE FROM memories_fts WHERE id = ?').run(oldId);
                this.db.prepare('UPDATE memories SET invalid_at = ?, superseded_by = ? WHERE id = ?')
                    .run(invalidAt, newId, oldId);
            } catch (e) {
                console.error('supersede: SQLite update failed (JSON already stamped):', e.message);
                indexStale = true;
            }
        }

        return {
            superseded: true, category, oldId, newId, invalid_at: invalidAt,
            ...(indexStale ? { indexStale: true, warning: 'SQLite index update failed; JSON is stamped but the FTS index may still surface this memory until rebuild-index runs' } : {}),
        };
    }

    /**
     * Read a memory from JSON (source of truth)
     */
    async readMemory(category, id) {
        // F42: category/id are joined straight into a filesystem path below —
        // reject anything outside the known-category whitelist / safe-id charset
        // BEFORE that join, matching readMemory's existing not-found contract
        // (null, with a logged reason) rather than silently no-op'ing.
        if (!this.categories.includes(category) || !isSafeMemoryId(id)) {
            console.error(`❌ readMemory: invalid category/id: ${category}/${id}`);
            return null;
        }
        const hyphenated = MemoryManager.idToFilename(id);
        let filePath = path.join(this.memoriesDir, category, `${hyphenated}.json`);

        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(content);
        } catch (error) {
            if (error.code === 'ENOENT') {
                filePath = path.join(this.memoriesDir, category, `${id}.json`);
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    return JSON.parse(content);
                } catch {
                    return null;
                }
            }
            console.error(`❌ Error reading memory: ${category}/${id}`, error.message);
            return null;
        }
    }

    /**
     * Update a memory (JSON + SQLite)
     */
    async updateMemory(category, id, updates) {
        // F42: readMemory() below already rejects an unsafe category/id and
        // returns null, but validate explicitly up front so the guard is not
        // implicit/incidental — updateMemory also writes a NEW file at the same
        // path afterward, so it must never proceed past an unsafe id.
        if (!this.categories.includes(category) || !isSafeMemoryId(id)) {
            console.error(`❌ updateMemory: invalid category/id: ${category}/${id}`);
            return null;
        }
        const memory = await this.readMemory(category, id);
        if (!memory) return null;

        if (updates.content) {
            memory.content = { ...memory.content, ...updates.content };
        }
        if (updates.metadata) {
            memory.metadata = { ...memory.metadata, ...updates.metadata };
        }
        // MEM-10: importance is a top-level field only. If an update carried a new
        // importance in content (or a legacy record still holds one there), promote
        // it to the top level and strip it from content so top-level importance can
        // never go stale relative to content.importance (readers prefer top-level).
        if (memory.content && memory.content.importance !== undefined) {
            memory.importance = clampImportance(memory.content.importance);
            delete memory.content.importance;
        }

        memory.updated = new Date().toISOString();
        // ME-4.1: updateMemory no longer bumps usage_count. A write (metadata
        // patch, echo-boost, confidence update) is NOT a genuine recall — the
        // honest usage increment moved to searchMemories(). Keeping it here
        // over-credited incidental writes and made usage a one-way ratchet.
        // MP-2.1: explicit access timestamp — lets analytics attribute a hit to an
        // injected memory that was later updated within the same session window.
        memory.last_accessed = memory.updated;

        // Write JSON
        const filename = MemoryManager.idToFilename(id);
        const filePath = path.join(this.memoriesDir, category, `${filename}.json`);
        await fs.writeFile(filePath, JSON.stringify(memory, null, 2));

        // Re-index in SQLite
        this.indexMemory(memory);

        console.log(`✅ Memory updated: ${category}/${id}`);
        return memory;
    }

    /**
     * List all memories in a category.
     *
     * Supersession (ME-3.1): memories with a non-null `invalid_at` are hidden by
     * default — this is the single chokepoint every current-state consumer flows
     * through (analytics, lint, prune, search JSON-fallback). Pass
     * `{ includeSuperseded: true }` to read history (audit, rebuildIndex). Legacy
     * memories with no `invalid_at` field default to live (default-on-read).
     *
     * @param {string} category
     * @param {{ includeSuperseded?: boolean }} [opts]
     */
    // F43: `includeFull: true` attaches the already-parsed record as `.full` on
    // each summary — this method reads every JSON file anyway to build the
    // summary, so callers that need content must NOT re-read per id (that was
    // a systemic second disk read + JSON.parse of the whole store). Off by
    // default so summary-only consumers (generateReport's serialized payload)
    // don't balloon.
    async listMemories(category, opts = {}) {
        const { includeSuperseded = false, includeFull = false } = opts;
        const dir = path.join(this.memoriesDir, category);
        try {
            const files = await fs.readdir(dir);
            const memories = [];

            // Read-back (F44): usage_count lives ONLY in the SQLite index now
            // (_recordRecall bumps it there, not the git-tracked JSON). Merge the live
            // index value back in so every downstream consumer (report total_usage,
            // analytics never_used/top_used/prune/dead-weight, lint) sees real usage
            // instead of the permanently-stale JSON baseline (~always 0). ONE query
            // per listMemories call. No index → empty Map → JSON value passes through.
            const liveUsage = this._indexUsageMap();

            for (const file of files) {
                if (file.endsWith('.json')) {
                    // Read the enumerated file directly instead of round-tripping
                    // its name through readMemory's id validation: idToFilename is
                    // lossy ('_' -> '-'), so a valid leading-underscore id yields a
                    // leading-'-' filename that SAFE_ID_RE rejects — the memory
                    // silently vanishes from report/analytics/lint/prune. A readdir
                    // entry joined to its own directory cannot traverse, so the F42
                    // caller-supplied-id guard does not apply here.
                    let memory = null;
                    try {
                        memory = JSON.parse(await fs.readFile(path.join(dir, file), 'utf-8'));
                    } catch {
                        // unreadable/malformed store file — skip, matching the old
                        // readMemory-null behavior for this loop
                    }
                    if (memory) {
                        // Hide superseded memories from current-state queries unless
                        // explicitly asked for. invalid_at absent/null = live.
                        if (memory.invalid_at && !includeSuperseded) continue;
                        memories.push({
                            // `file` lets rebuildIndex name a record it could not index.
                            ...(includeFull ? { full: memory, file } : {}),
                            id: memory.id,
                            created: memory.created,
                            updated: memory.updated,
                            // max(JSON baseline, live index) — index is the live source,
                            // JSON is the seed; max never shows a value below either.
                            usage_count: Math.max(memory.usage_count || 0, liveUsage.get(memory.id) ?? 0),
                            confidence: memory.metadata?.confidence ?? 1.0,
                            // Backfill-on-read: legacy memories (and any written
                            // before this column) read back at the default of 3.
                            importance: clampImportance(memory.importance ?? memory.content?.importance),
                            // Supersession (ME-3.1) — null/absent = live. Surfaced
                            // so ME-3.2 analytics can count superseded entries.
                            invalid_at: memory.invalid_at ?? null,
                            superseded_by: memory.superseded_by ?? null,
                            // MEM-3: decay must read the SAME live-merged usage_count
                            // this summary reports (usage feeds decay's USAGE_BOOST).
                            // Computing it off the stale-JSON `memory` made the row
                            // internally inconsistent — displayed usage and the decay
                            // that's supposed to reflect it disagreed.
                            decayed_confidence: this.calculateDecayedConfidence({
                                ...memory,
                                usage_count: Math.max(memory.usage_count || 0, liveUsage.get(memory.id) ?? 0),
                            })
                        });
                    }
                }
            }

            return memories;
        } catch {
            return [];
        }
    }

    /**
     * Search memories — uses SQLite FTS5 when available, falls back to JSON scan.
     * Supersession (ME-3.1): superseded memories (invalid_at set) are excluded by
     * default on both paths; pass `{ includeSuperseded: true }` to read history.
     *
     * F11: `recordRecall` defaults to true (the genuine-recall contract, ME-4.1) —
     * every real search bumps usage_count + logs a memory_access event. Diagnostic
     * callers that search only to measure latency/retrieval quality (health-check's
     * performance probe, memory-benchmark, memory-eval's --real pass) must pass
     * `{ recordRecall: false }` so they don't inflate usage_count (feeds decay's
     * USAGE_BOOST) or pollute memory-injection.jsonl (feeds hit_rate/prune analytics).
     *
     * @param {string} searchTerm
     * @param {{ includeSuperseded?: boolean, recordRecall?: boolean }} [opts]
     */
    async searchMemories(searchTerm, opts = {}) {
        const { includeSuperseded = false, recordRecall = true } = opts;
        // Try SQLite FTS5 first
        if (this.initDb()) {
            const sql = `
                    SELECT m.id, m.category, m.content, m.metadata, m.confidence, m.usage_count, m.updated, m.importance,
                           rank
                    FROM memories_fts fts
                    JOIN memories m ON fts.id = m.id
                    WHERE memories_fts MATCH ?
                      ${includeSuperseded ? '' : 'AND m.invalid_at IS NULL'}
                    ORDER BY rank
                    LIMIT 20
                `;
            try {
                let rows;
                try {
                    rows = this.db.prepare(sql).all(buildFtsQuery(searchTerm));
                } catch {
                    // buildFtsQuery may have passed prose through raw (the punctuation
                    // heuristic) and a hyphen in it made MATCH throw (M1). Retry with a
                    // strictly tokenized OR-join before falling to the JSON scan.
                    rows = this.db.prepare(sql).all(tokenizeToOrQuery(searchTerm));
                }
                if (rows.length > 0) {
                    const mapped = rows.map(row => {
                        const importance = clampImportance(row.importance);
                        // Reconstruct enough of the memory shape to compute decay
                        // (importance included so the floor applies on this path too)
                        const mockMemory = {
                            // MEM-1: category drives the per-category decay RATE in
                            // calcDecay (decisions 0.98, constraints 0.97, …). Omitting
                            // it silently fell back to DEFAULT_RATE (0.95), 3x
                            // over-decaying decisions memories and mislabelling them stale.
                            category: row.category,
                            updated: row.updated,
                            usage_count: row.usage_count || 0,
                            importance,
                            metadata: { confidence: row.confidence ?? 1.0 }
                        };
                        return {
                            category: row.category,
                            id: row.id,
                            // ME-2.2 — importance term (+4..+20) mirrors the JSON path
                            relevance: Math.abs(row.rank) * SCORING.FTS_RANK_MULTIPLIER + (row.confidence || 0) * SCORING.CONFIDENCE_MULTIPLIER + (row.usage_count || 0) * SCORING.USAGE_MULTIPLIER + importance * SCORING.IMPORTANCE_MULTIPLIER,
                            confidence: row.confidence ?? 1.0,
                            decayed_confidence: this.calculateDecayedConfidence(mockMemory)
                        };
                    });
                    if (recordRecall) {
                        await this._recordRecall(mapped);
                        this._logMemoryAccess(mapped);
                    }
                    return mapped;
                }
                // MEM-4: a clean zero-result FTS query is authoritative — the index
                // exists and legitimately matched nothing. Return [] directly instead
                // of falling through to the JSON linear scan (which defeats the index
                // and diverges FTS-present vs FTS-absent envs on a genuine no-hit
                // query). Only the catch below — an actual MATCH exception — should
                // fall through to the JSON-scan fallback.
                return [];
            } catch {
                // FTS query failed — fall through to JSON scan
            }
        }

        // Fallback: JSON scan — listMemories already applies the supersession
        // filter, so pass the opt through to keep both paths consistent.
        const results = [];
        for (const category of this.categories) {
            // F43: includeFull reuses the record listMemories already parsed —
            // this JSON-fallback path (SQLite unavailable) used to re-read every
            // file a second time, exactly where doubled I/O hurts most.
            const memories = await this.listMemories(category, { includeSuperseded, includeFull: true });
            for (const memSummary of memories) {
                const memory = memSummary.full;
                const content = JSON.stringify(memory.content).toLowerCase();
                if (content.includes(searchTerm.toLowerCase())) {
                    // MEM-3 sibling (class-closure): `.full` carries the ~always-0
                    // JSON usage_count baseline, but the summary already holds the
                    // live-merged value (max of JSON + SQLite index). Both relevance
                    // (USAGE_MULTIPLIER) and decay (USAGE_BOOST) key off usage_count,
                    // so read the merged value — otherwise an FTS-exception fallback
                    // would score/decay off stale usage while the FTS path (MEM-1)
                    // uses live usage. In a true JSON-only env the merged value equals
                    // the JSON baseline, so this is a no-op there.
                    const merged = { ...memory, usage_count: memSummary.usage_count };
                    results.push({
                        category,
                        id: memory.id,
                        relevance: this.calculateRelevance(merged, searchTerm, content), // F45: reuse the stringify above
                        confidence: memory.metadata?.confidence ?? 1.0,
                        decayed_confidence: this.calculateDecayedConfidence(merged)
                    });
                }
            }
        }
        const sorted = results.sort((a, b) => b.relevance - a.relevance);
        if (recordRecall) {
            await this._recordRecall(sorted);
            this._logMemoryAccess(sorted);
        }
        return sorted;
    }

    /**
     * Record genuine recalls (ME-4.1): bump usage_count by exactly 1 for each
     * recalled memory. usage_count lives ONLY in the gitignored `.state/` index
     * now — never the tracked `.memory/` JSON. (W1B store split / ADR 0006 Am. 2
     * made the JSON a git-tracked synced source; writing this soft ranking
     * tiebreaker there churned 20+ files on every search and produced cross-machine
     * merge conflicts.) The increment is done in-place in SQL so it grows correctly
     * across searches; on an index rebuild it reseeds from the JSON baseline
     * (acceptable — usage is a tiebreaker, never load-bearing). This is the ONLY
     * place usage_count grows; passive injection never calls search, so injection
     * reads still leave no signal (honest lower bound). When there is no index
     * (JSON-scan fallback window), recalls go unrecorded — by design.
     *
     * @param {Array<{id: string}>} results
     */
    async _recordRecall(results) {
        if (!this.db) return; // no index to record into — the JSON source stays clean
        if (!results || results.length === 0) return;
        // MEM-12: one batched UPDATE for all recalled ids instead of N round-trips.
        // Placeholders are literal '?' chars (no interpolation of ids), so the IN
        // clause is injection-safe; every id is bound via variadic run() — the shape
        // both node:sqlite and better-sqlite3 accept.
        const ids = results.map(r => r.id);
        const placeholders = ids.map(() => '?').join(',');
        try {
            this.db.prepare(`UPDATE memories SET usage_count = usage_count + 1 WHERE id IN (${placeholders})`)
                .run(...ids);
        } catch { /* non-fatal: a soft tiebreaker must never break search */ }
    }

    /**
     * MP-2.1: record a recall (search) as a `memory_access` telemetry event — the
     * meaningful "the agent recalled this memory to use it" signal that gives
     * hit-rate analysis its numerator. Best-effort: a telemetry failure must never
     * break search, so the whole write is wrapped and swallowed. Called once from
     * whichever search path returns (SQLite or JSON fallback) — it logs the ids of
     * that path's results; a no-match search logs nothing (no signal, no numerator).
     *
     * @param {Array<{id: string}>} results - the search results about to be returned
     * @returns {void}
     */
    _logMemoryAccess(results) {
        try {
            if (!Array.isArray(results) || results.length === 0) return;
            const ts = new Date().toISOString();
            const jsonlPath = path.join(this.projectRoot, 'docs', '.output', '.state', 'telemetry', 'memory-injection.jsonl');
            appendJsonl(jsonlPath, {
                timestamp: ts,
                type: 'memory_access',
                accessed_ids: results.map(r => r.id),
                session_proxy: ts.slice(0, 16),   // ISO-8601 truncated to the minute — session join key
            });
        } catch {
            // best-effort — never break search
        }
    }

    /**
     * Count active work days (days with git commits) between a date and now.
     * Delegates to the shared resolver; falls back to calendar days when git
     * is unavailable. Per-instance cache — one git log invocation per manager.
     */
    getActiveDaysSince(sinceDate) {
        return this._activeDaysResolver.getActiveDaysSince(sinceDate);
    }

    /**
     * Calculate decayed confidence for a memory — read-time only, not stored.
     * Thin adapter over _lib/memory-decay.js — extracts the memory's shape into
     * the shared function's parameter contract. Formula lives in the shared lib.
     */
    calculateDecayedConfidence(memory) {
        const base = calcDecay({
            confidence: memory.metadata?.confidence ?? 1.0,
            category: memory.category,
            usageCount: memory.usage_count || 0,
            updated: memory.updated,
            activeDays: this._activeDaysResolver.getActiveDaysSince(memory.updated),
        });
        // ME-2.2 importance retention floor — an ADDED factor on top of the
        // active-work-day curve (the curve in _lib stays untouched). Normalized
        // around IMPORTANCE_DEFAULT (3): importance 3 → factor 1.0 (default and
        // legacy memories unchanged), importance ≤2 → factor <1 so a low-value
        // never-recalled memory can cross STALE_THRESHOLD even on an actively
        // committed repo, importance ≥4 → factor >1 to resist decay. Capped at 1.0.
        const importance = clampImportance(memory.importance ?? memory.content?.importance);
        const importanceFactor = importance / IMPORTANCE_DEFAULT;
        return Math.min(1.0, base * importanceFactor);
    }

    /**
     * Boost confidence of memories whose keywords appear in recent commit subjects.
     * Concepts echoed by ongoing work gain confidence, counterbalancing monotonic decay.
     * Idempotent: stores `metadata.lastEchoBoostCommit` so re-running against unchanged
     * git head is a no-op.
     *
     * @param {Object} opts
     * @param {number} [opts.limit=50] - how many recent commits to scan
     * @param {number} [opts.boostAmount] - defaults to MEMORY_DECAY.ECHO_BOOST (0.05)
     * @param {boolean} [opts.dryRun=false] - when true, returns report without writing
     * @returns {Promise<{scanned: number, boosted: Array, skipped: Array}>}
     */
    async boostFromGitLog({ limit = 50, boostAmount, dryRun = false } = {}) {
        const { MEMORY_DECAY } = require('./constants');
        if (boostAmount === undefined) boostAmount = MEMORY_DECAY.ECHO_BOOST;

        // 1. Read commit log — %H (full hash) + %s (subject), most-recent first.
        // Coerce limit to a non-negative int before it reaches the shell (sec-n3):
        // it is interpolated into an execSync string, so a non-numeric caller value
        // must never survive into the command.
        const safeLimit = Math.max(1, Number(limit) | 0);
        let commits = [];
        try {
            const raw = execSync(`git log --format=%H%x09%s -${safeLimit}`, {
                cwd: this.projectRoot,
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            commits = raw.trim().split('\n').filter(Boolean).map(line => {
                const tab = line.indexOf('\t');
                if (tab === -1) return null;
                return { hash: line.slice(0, tab), subject: line.slice(tab + 1).toLowerCase() };
            }).filter(Boolean);
        } catch (e) {
            return { scanned: 0, boosted: [], skipped: [], error: 'git log failed: ' + e.message };
        }

        if (commits.length === 0) {
            return { scanned: 0, boosted: [], skipped: [] };
        }

        const latestHash = commits[0].hash;
        const report = { scanned: 0, boosted: [], skipped: [] };

        const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'but', 'not', 'have', 'has', 'was', 'were', 'will', 'can', 'its', 'their', 'them', 'they', 'you', 'your', 'our', 'one', 'two', 'all', 'any', 'been', 'into', 'than', 'then', 'what', 'when', 'which', 'who', 'how', 'why', 'also', 'just', 'some', 'more', 'very']);

        // 2. Iterate all categories + memories
        for (const category of this.categories) {
            // F43: reuse listMemories' already-parsed records (no second read).
            const summaries = await this.listMemories(category, { includeFull: true });
            for (const summary of summaries) {
                report.scanned++;
                const memory = summary.full;

                const lastBoost = memory.metadata?.lastEchoBoostCommit;

                // 3. Idempotence: if stored marker equals newest hash, no new commits
                if (lastBoost === latestHash) {
                    report.skipped.push({ category, id: memory.id, reason: 'no-new-commits' });
                    continue;
                }

                // 4. Extract keywords from concept content (mirror extractKeywords rules)
                const contentText = JSON.stringify(memory.content || {}).toLowerCase();
                const keywords = new Set();
                for (const token of contentText.split(/\W+/)) {
                    if (token.length > 2 && !STOPWORDS.has(token)) keywords.add(token);
                }

                // 5. Only consider commits newer than the stored marker (inclusive newest; exclusive of marker)
                // commits[] is most-recent first — everything UP TO (but not including) lastBoost is "new"
                let relevantCommits = commits;
                if (lastBoost) {
                    const cutoff = commits.findIndex(c => c.hash === lastBoost);
                    if (cutoff !== -1) relevantCommits = commits.slice(0, cutoff);
                }
                if (relevantCommits.length === 0) {
                    report.skipped.push({ category, id: memory.id, reason: 'no-new-commits' });
                    continue;
                }

                // 6. Match: any keyword in any commit subject (word-boundary, case-insensitive)
                const matchedKeywords = [];
                const matchedCommits = [];
                for (const kw of keywords) {
                    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const re = new RegExp('\\b' + escaped + '\\b', 'i');
                    let matchedAny = false;
                    for (const c of relevantCommits) {
                        if (re.test(c.subject)) {
                            matchedAny = true;
                            if (!matchedCommits.some(m => m.hash === c.hash)) {
                                matchedCommits.push(c);
                            }
                        }
                    }
                    if (matchedAny) matchedKeywords.push(kw);
                }

                if (matchedKeywords.length === 0) {
                    report.skipped.push({ category, id: memory.id, reason: 'no-match' });
                    continue;
                }

                // 7. Boost
                const oldConf = memory.metadata?.confidence ?? 1.0;
                const newConf = Math.min(1.0, oldConf + boostAmount);

                if (!dryRun && newConf > oldConf) {
                    await this.updateMemory(category, memory.id, {
                        metadata: { confidence: newConf, lastEchoBoostCommit: latestHash }
                    });
                } else if (!dryRun && newConf === oldConf) {
                    // Already at cap — still update marker to prevent re-scanning same commits
                    await this.updateMemory(category, memory.id, {
                        metadata: { lastEchoBoostCommit: latestHash }
                    });
                }

                report.boosted.push({
                    category,
                    id: memory.id,
                    keywords: matchedKeywords.slice(0, 5),
                    commits: matchedCommits.slice(0, 3).map(c => c.subject.slice(0, 50)),
                    oldConf,
                    newConf
                });
            }
        }

        return report;
    }

    /**
     * Ingest auto-memory markdown files (`.claude/agent-memory/{agent}/*.md`)
     * into the structured JSON memory store. Parses YAML frontmatter for
     * `name`, `description`, `type`; stores the full markdown body as a
     * `body` field in the created memory's content object.
     *
     * Accepts either a single `.md` file path OR a directory (walked recursively).
     * Skips `MEMORY.md` index files. Skips memories whose id already exists
     * (no overwrite). Dedup is by (category, id).
     *
     * @param {string} sourcePath - file or directory
     * @param {{dryRun?: boolean}} [options]
     * @returns {Promise<{ingested: number, skipped: number, errors: Array<{file: string, reason: string}>}>}
     */
    async ingestAgentMemory(sourcePath, options = {}) {
        return ingestAgentMemoryLib(sourcePath, {
            dryRun: options.dryRun ?? false,
            readMemory:   (cat, id) => this.readMemory(cat, id),
            createMemory: (cat, id, content) => this.createMemory(cat, id, content),
        });
    }

    // Legacy alias — tests or external callers may reach into this private helper
    async _findMarkdownFiles(sourcePath) {
        return ingestFindMarkdownFiles(sourcePath);
    }

    /**
     * Parse YAML frontmatter from a markdown string. Returns
     * `{ frontmatter: {...}, body: string }` or `null` if no frontmatter.
     * Thin adapter over _lib/frontmatter.js with `returnBody: true`.
     */
    static _parseFrontmatter(raw) {
        return parseFm(raw, { returnBody: true });
    }

    // Legacy static aliases — delegate to _lib/memory-ingest for backward compat
    static _typeToCategory(type) {
        return ingestTypeToCategory(type);
    }

    static _idFromFilename(filename) {
        return ingestIdFromFilename(filename);
    }

    /**
     * Calculate relevance score (for JSON fallback search)
     */
    // F45: `contentStr` is optional — the JSON-fallback search path already has
    // the lowercased stringify in hand and passes it in, so the same content
    // isn't serialized twice per match on the (already degraded) no-FTS5 path.
    calculateRelevance(memory, searchTerm, contentStr) {
        let score = 0;
        const content = contentStr || JSON.stringify(memory.content).toLowerCase();
        const term = searchTerm.toLowerCase();

        const matches = (content.match(new RegExp(term, 'g')) || []).length;
        score += matches * SCORING.MATCH_MULTIPLIER;

        const daysSinceUpdate = (Date.now() - new Date(memory.updated)) / (1000 * 60 * 60 * 24);
        if (daysSinceUpdate < SCORING.RECENCY_RECENT_DAYS) score += SCORING.RECENCY_RECENT_POINTS;
        else if (daysSinceUpdate < SCORING.RECENCY_MID_DAYS) score += SCORING.RECENCY_MID_POINTS;

        // MEM-2: guard against a hand-authored memory missing usage_count/metadata
        // — an undefined deref here crashed the whole JSON-scan search (no per-record
        // try/catch). Mirrors the guarded importance access two lines below.
        score += (memory.usage_count || 0) * SCORING.USAGE_MULTIPLIER;
        score += (memory.metadata?.confidence ?? 1.0) * SCORING.CONFIDENCE_MULTIPLIER;
        // ME-2.2 — importance term (1–5 → +4..+20) so a higher-importance memory
        // scores strictly higher than an otherwise-identical lower-importance one.
        score += clampImportance(memory.importance ?? memory.content?.importance) * SCORING.IMPORTANCE_MULTIPLIER;

        return score;
    }

    /**
     * Rebuild SQLite index from JSON files (repair command).
     *
     * Every record is read FIRST (async), then the usage snapshot, wipe and
     * re-index run in ONE synchronous `BEGIN IMMEDIATE` transaction. Readers see the
     * old complete index or the new complete one, never a half-built one; an
     * overlapping rebuild (another process) waits on the write lock (busy_timeout)
     * instead of interleaving its DELETE with this one's inserts; and the usage
     * snapshot is taken under the lock, so live usage_count survives. Only rows
     * actually written are counted; each record the index cannot hold is named and
     * recorded in the ignored rebuild-status.json beside the index, which the
     * SessionStart self-heal and the health check read.
     *
     * @returns {Promise<{indexed: number, failed: Array<{file: string, id: string|null, error: string}>}|undefined>}
     *          undefined when SQLite is unavailable
     */
    async rebuildIndex() {
        if (!this.initDb()) {
            console.log('SQLite not available — nothing to rebuild.');
            return undefined;
        }

        // Repair needs a complete, explicitly diagnosed snapshot. listMemories
        // intentionally skips unreadable records for summary compatibility, so
        // it cannot tell a failed read from an empty category here.
        const records = [];
        const failed = [];
        let incompleteSnapshot = false;
        for (const category of this.categories) {
            const dir = path.join(this.memoriesDir, category);
            let files;
            try { files = await fs.readdir(dir); }
            catch (error) {
                // An absent optional category is empty; other enumeration faults
                // cannot justify deleting any part of the prior index.
                if (error.code === 'ENOENT') continue;
                incompleteSnapshot = true;
                failed.push({ file: `${category}/`, id: null, error: error.message });
                continue;
            }
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                try {
                    const memory = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
                    if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
                        throw new Error('memory JSON must be an object');
                    }
                    // Include retired records so includeSuperseded history survives.
                    records.push({ category, file, memory });
                } catch (error) {
                    failed.push({ file: `${category}/${file}`, id: null, error: error.message });
                }
            }
        }

        let indexed = 0;
        if (incompleteSnapshot) {
            await this._writeRebuildStatus(indexed, failed, true);
            console.error(`rebuild-index: aborted before deleting the prior index; source enumeration failed (${failed.map(f => f.file).join(', ')}).`);
            return { indexed, failed };
        }
        this.db.exec('BEGIN IMMEDIATE');
        try {
            // Snapshot live usage_count BEFORE wiping — the index is the live source
            // (_recordRecall bumps it here, not the JSON baseline of ~always 0). Without
            // this, every rebuild resets accumulated real usage to 0 (F44). Taken under
            // the write lock so a concurrent rebuild cannot have wiped it first.
            const priorUsage = this._indexUsageMap();
            this.db.exec('DELETE FROM memories');
            this.db.exec('DELETE FROM memories_fts');
            for (const { category, file, memory } of records) {
                this.lastIndexError = null;
                const usageFloor = typeof memory.id === 'string' ? (priorUsage.get(memory.id) ?? 0) : 0;
                if (this.indexMemory(memory, usageFloor)) indexed++;
                else failed.push({ file: `${category}/${file}`, id: typeof memory.id === 'string' ? memory.id : null, error: this.lastIndexError || 'not indexed' });
            }
            this.db.exec('COMMIT');
        } catch (e) {
            try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
            throw e;
        }

        await this._writeRebuildStatus(indexed, failed);
        const failedNote = failed.length ? `, ${failed.length} failed (${failed.map(f => f.file).join(', ')})` : '';
        console.log(`${failed.length ? '⚠️' : '✅'} Rebuilt SQLite index: ${indexed} memories indexed${failedNote}.`);
        return { indexed, failed };
    }

    async _writeRebuildStatus(indexed, failed, aborted = false) {
        try {
            await fs.writeFile(rebuildStatusPath(this.dbPath), JSON.stringify({
                completed_at: new Date().toISOString(), indexed, failed,
                ...(aborted ? { aborted: true } : {}),
            }, null, 2) + '\n');
        } catch (error) {
            console.error('rebuild-index: could not write rebuild status:', error.message);
        }
    }

    /**
     * Run all 7 memory lint checks and return a structured health report.
     */
    /**
     * Run all 7 memory lint checks and return a structured health report.
     * Thin wrapper: assembles {category, summary, full} tuples then delegates
     * to _lib/memory-lint.js. Keeps per-instance decay resolver wired in.
     */
    async lintMemories() {
        const allMemories = [];
        // A retired (invalid_at) memory is history, not a nonexistent id —
        // its id stays referenceable, but it joins no other check or the total.
        const retiredIds = [];
        for (const category of this.categories) {
            // F43: includeFull — the lint tuples reuse the single-pass records.
            const summaries = await this.listMemories(category, { includeFull: true, includeSuperseded: true });
            for (const summary of summaries) {
                if (summary.full.invalid_at) retiredIds.push(summary.full.id);
                else allMemories.push({ category, summary, full: summary.full });
            }
        }

        return lintMemoriesLib(allMemories, {
            calculateDecayedConfidence: (memory) => this.calculateDecayedConfidence(memory),
            categories: this.categories,
            maxPerCategory: MAX_MEMORIES_PER_CATEGORY,
            retiredIds,
        });
    }

    async generateReport() {
        const report = {
            timestamp: new Date().toISOString(),
            storage: {
                json: this.memoriesDir,
                sqlite: DatabaseSync ? this.dbPath : 'not available',
                sqliteBackend,
                sqliteSupportsFts5
            },
            categories: {}
        };

        for (const category of this.categories) {
            const memories = await this.listMemories(category);
            const { MEMORY_DECAY } = require('./constants');
            const staleCount = memories.filter(m => m.decayed_confidence < MEMORY_DECAY.STALE_THRESHOLD).length;
            const archiveCandidates = memories.filter(m => m.decayed_confidence < MEMORY_DECAY.ARCHIVE_THRESHOLD).length;
            report.categories[category] = {
                count: memories.length,
                total_usage: memories.reduce((sum, m) => sum + m.usage_count, 0),
                avg_confidence: memories.reduce((sum, m) => sum + m.confidence, 0) / memories.length || 0,
                stale_count: staleCount,
                archive_candidates: archiveCandidates,
                memories: memories
            };
        }

        const allCategoryStats = Object.values(report.categories);
        report.summary = {
            total_memories: allCategoryStats.reduce((sum, c) => sum + c.count, 0),
            most_used_category: Object.entries(report.categories)
                .sort((a, b) => b[1].total_usage - a[1].total_usage)[0]?.[0],
            total_stale: allCategoryStats.reduce((sum, c) => sum + c.stale_count, 0),
            total_archive_candidates: allCategoryStats.reduce((sum, c) => sum + c.archive_candidates, 0)
        };

        return report;
    }

    /**
     * MP-3.1: read the injection/access telemetry stream (memory-injection.jsonl)
     * and split it by event type. Best-effort — a missing or unreadable file
     * yields empty arrays so analytics degrades gracefully rather than throwing.
     *
     * @returns {{ injections: object[], accesses: object[], hasLines: boolean }}
     */
    _readInjectionTelemetry() {
        const logPath = path.join(this.projectRoot, 'docs', '.output', '.state', 'telemetry', 'memory-injection.jsonl');
        try {
            if (!fsSync.existsSync(logPath)) {
                return { injections: [], accesses: [], hasLines: false };
            }
            const lines = fsSync.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim());
            const injections = [];
            const accesses = [];
            for (const line of lines) {
                let ev;
                try { ev = JSON.parse(line); } catch { continue; }
                if (ev.type === 'memory_injection') injections.push(ev);
                else if (ev.type === 'memory_access') accesses.push(ev);
            }
            return { injections, accesses, hasLines: lines.length > 0 };
        } catch {
            return { injections: [], accesses: [], hasLines: false };
        }
    }

    /**
     * MP-3.1: performance/usage analytics — the complement to generateReport()
     * (inventory) and lintMemories() (hygiene). Returns a structured object;
     * formatting lives in the CLI `analytics` case. Sections:
     *   a) cap_utilization  — per-category {count, cap, pct_full, near_limit}
     *   b) decay            — stale / archive-candidate totals
     *   c) usage            — never-used count + top-5 by usage_count
     *   d) prune            — stale AND usage_count===0, projected store size
     *   e) injection        — avg injected_count, default_limit, decayed-conf "cliff"
     *   f) hit_rate         — fraction of injected_ids later recalled/updated.
     *                          LOWER BOUND — implicit reads of an injected memory
     *                          leave no signal, so true usefulness is undercounted.
     *
     * @param {{ recentInjections?: number }} [opts]
     * @returns {Promise<object>}
     */
    async generateAnalytics({ recentInjections = 50 } = {}) {
        const { MEMORY_DECAY } = require('./constants');
        const cap = MAX_MEMORIES_PER_CATEGORY;
        const defaultLimit = CONSTANTS.MEMORY_FILTERS.DEFAULT_LIMIT;

        const capUtilization = {};
        const allUsage = [];        // { category, id, usage_count }
        const allDecayed = [];      // decayed_confidence values (for the cliff)
        const pruneCandidates = []; // stale AND usage_count === 0
        const deadWeightCandidates = []; // never-used AND exposed past EXPOSURE_MIN_ACTIVE_DAYS (decay-independent)
        const idLastAccessed = {};  // id -> last_accessed ISO (for hit-rate)
        let totalMemories = 0;
        let totalNeverUsed = 0;
        let totalStale = 0;
        let totalArchive = 0;
        let totalSuperseded = 0;

        for (const category of this.categories) {
            // One pass: read all (including superseded) so we can both count the
            // superseded entries (ME-3.2) and run the existing active-only stats.
            // F43: includeFull so the last_accessed side-read below is free.
            const withSuperseded = await this.listMemories(category, { includeSuperseded: true, includeFull: true });
            const memories = withSuperseded.filter(m => !m.invalid_at);
            totalSuperseded += withSuperseded.length - memories.length;
            const count = memories.length;
            totalMemories += count;

            const stale = memories.filter(m => m.decayed_confidence < MEMORY_DECAY.STALE_THRESHOLD).length;
            const archive = memories.filter(m => m.decayed_confidence < MEMORY_DECAY.ARCHIVE_THRESHOLD).length;
            const neverUsed = memories.filter(m => (m.usage_count || 0) === 0).length;
            totalStale += stale;
            totalArchive += archive;
            totalNeverUsed += neverUsed;

            const pctFull = cap > 0 ? count / cap : 0;
            capUtilization[category] = {
                count,
                cap,
                pct_full: Number(pctFull.toFixed(3)),
                near_limit: pctFull >= PRUNE_THRESHOLD_PERCENT,
                stale_count: stale,
                archive_candidates: archive,
                never_used: neverUsed,
            };

            for (const m of memories) {
                allUsage.push({ category, id: m.id, usage_count: m.usage_count || 0 });
                allDecayed.push(m.decayed_confidence);
                if (m.decayed_confidence < MEMORY_DECAY.STALE_THRESHOLD && (m.usage_count || 0) === 0) {
                    pruneCandidates.push({ category, id: m.id, decayed_confidence: m.decayed_confidence });
                }
                // Decay-independent dead-weight: never recalled AND exposed to enough
                // active work-days since CREATION (not update) to have earned a recall.
                // Keys off `created` so it catches memories that decay can never reach
                // on an actively-committed project. usage_count is a LOWER BOUND.
                if ((m.usage_count || 0) === 0) {
                    const activeDaysSinceCreated = this.getActiveDaysSince(m.created);
                    if (activeDaysSinceCreated >= EXPOSURE_MIN_ACTIVE_DAYS) {
                        deadWeightCandidates.push({
                            category,
                            id: m.id,
                            active_days_since_created: activeDaysSinceCreated,
                            decayed_confidence: m.decayed_confidence,
                        });
                    }
                }
                // last_accessed lives in the full memory JSON, not the summary —
                // F43: read off the attached record instead of a per-id re-read.
                if (m.full && m.full.last_accessed) idLastAccessed[m.id] = m.full.last_accessed;
            }
        }

        const topUsed = allUsage
            .slice()
            .sort((a, b) => b.usage_count - a.usage_count)
            .slice(0, 5);

        // --- injection economics + hit-rate (read telemetry) ---
        // `hasLines` = the file had any parseable events. The public `has_telemetry`
        // below is stricter (needs >=1 injection event) — a file of only
        // memory_access events shouldn't claim injection telemetry exists.
        const { injections, accesses, hasLines } = this._readInjectionTelemetry();

        // (e) injection economics
        const avgInjected = injections.length > 0
            ? Number((injections.reduce((s, e) => s + (e.injected_count || 0), 0) / injections.length).toFixed(2))
            : null;
        const sortedDecayed = allDecayed.slice().sort((a, b) => b - a);
        const cutoffVal = sortedDecayed.length >= defaultLimit ? sortedDecayed[defaultLimit - 1] : null;
        const nextVal = sortedDecayed.length > defaultLimit ? sortedDecayed[defaultLimit] : null;
        const cliff = (cutoffVal != null && nextVal != null)
            ? Number((cutoffVal - nextVal).toFixed(4))
            : null;

        // (f) hit-rate — LOWER BOUND. An injected id counts as a hit if it later
        // appears in a memory_access event at/after the injection time, OR its
        // memory's last_accessed is at/after the injection time.
        const recent = injections.slice(-recentInjections);
        let numerator = 0;
        let denominator = 0;
        for (const inj of recent) {
            const injTime = new Date(inj.timestamp).getTime();
            const ids = Array.isArray(inj.injected_ids) ? inj.injected_ids : [];
            denominator += ids.length;
            const accessedAtOrAfter = new Set();
            for (const acc of accesses) {
                if (new Date(acc.timestamp).getTime() >= injTime) {
                    for (const id of (acc.accessed_ids || [])) accessedAtOrAfter.add(id);
                }
            }
            for (const id of ids) {
                const viaAccess = accessedAtOrAfter.has(id);
                const la = idLastAccessed[id];
                const viaLastAccessed = la && new Date(la).getTime() >= injTime;
                if (viaAccess || viaLastAccessed) numerator++;
            }
        }
        const hitRateValue = denominator > 0 ? Number((numerator / denominator).toFixed(3)) : null;

        return {
            timestamp: new Date().toISOString(),
            cap,
            cap_utilization: capUtilization,
            decay: { total_stale: totalStale, total_archive_candidates: totalArchive },
            usage: { never_used: totalNeverUsed, top_used: topUsed },
            prune: {
                candidates: pruneCandidates,
                current_size: totalMemories,
                projected_size_after: totalMemories - pruneCandidates.length,
            },
            supersession: {
                active: totalMemories,
                superseded: totalSuperseded,
            },
            dead_weight: {
                candidates: deadWeightCandidates,
                exposure_min_active_days: EXPOSURE_MIN_ACTIVE_DAYS,
                current_size: totalMemories,
                projected_size_after: totalMemories - deadWeightCandidates.length,
                caveat: 'usage_count is a LOWER BOUND — passive session-start injection reads are not counted, so a flagged memory may actually have been recalled. Review before deleting.',
            },
            injection: {
                has_telemetry: hasLines && injections.length > 0,
                events: injections.length,
                avg_injected_count: avgInjected,
                default_limit: defaultLimit,
                cliff,   // decayed-confidence drop at the injection cutoff
            },
            hit_rate: {
                has_telemetry: hasLines && injections.length > 0,
                value: hitRateValue,
                numerator,
                denominator,
                sample_injections: recent.length,
                lower_bound: true,   // implicit reads of an injected memory are uncounted
            },
        };
    }

    // ────────────────────────────────────────────────────────────────────────
    // Inbox pattern (R-A) — sub-agents flag draft memories to _inbox/, Main
    // Agent promotes/discards on dispatch return. Plan:
    // docs/.output/plans/2026-05-11-do-r-a-inbox-pattern.md
    // ────────────────────────────────────────────────────────────────────────

    _inboxDir() {
        // Split store (ADR 0006 Amendment 2): the inbox is transient state, no
        // longer colocated under the tracked JSON source — it lives at
        // .state/memory-inbox/ (resolved once in the constructor).
        return this.inboxDir;
    }

    /**
     * List all draft memories in the inbox.
     * @returns {Promise<Array<{id, file, mtime, content_preview, category, suggested_id, flagged_by, flagged_at}>>}
     */
    async inboxList() {
        const dir = this._inboxDir();
        let files;
        try {
            files = await fs.readdir(dir);
        } catch (e) {
            if (e.code === 'ENOENT') return [];
            throw e;
        }

        const entries = [];
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            const filePath = path.join(dir, file);
            try {
                const stat = await fs.stat(filePath);
                const raw = await fs.readFile(filePath, 'utf-8');
                const draft = JSON.parse(raw);
                const id = file.replace(/\.json$/, '');
                const description = draft.content?.description || '';
                entries.push({
                    id,
                    file: filePath,
                    mtime: stat.mtime.toISOString(),
                    content_preview: description.slice(0, 120),
                    category: draft.category,
                    suggested_id: draft.suggested_id,
                    flagged_by: draft.flagged_by,
                    flagged_at: draft.flagged_at,
                });
            } catch {
                // Skip unreadable / malformed entries — surface in promote step
            }
        }
        // Lex-sort = chronological for {YYYY-MM-DD}-{HHMM}-{slug} naming
        entries.sort((a, b) => a.id.localeCompare(b.id));
        return entries;
    }

    /**
     * Promote an inbox draft to a real memory: read draft, validate category,
     * call createMemory, delete the inbox file. Errors return {promoted:false,error}
     * rather than throw — matches existing pruneStaleMemories return shape.
     *
     * @param {string} id - inbox filename stem (without .json)
     * @param {{categoryOverride?: string, idOverride?: string}} [opts]
     * @returns {Promise<{promoted: true, category, id} | {promoted: false, error}>}
     */
    async inboxPromote(id, opts = {}) {
        // F42 (W2-1): `id` is a raw CLI-supplied inbox filename stem joined
        // straight into path.join below — guard it against `../` traversal
        // exactly like the memory-id entry points, else `inbox-promote
        // ../../../secret` reads (and then unlinks) an arbitrary .json file.
        if (!isSafeMemoryId(id)) {
            return { promoted: false, error: `Invalid inbox id: ${id} (must be lowercase alnum, '_' or '-'; no path separators)` };
        }
        const filePath = path.join(this._inboxDir(), `${id}.json`);
        let raw;
        try {
            raw = await fs.readFile(filePath, 'utf-8');
        } catch (e) {
            if (e.code === 'ENOENT') {
                return { promoted: false, error: `Inbox draft not found: ${id}` };
            }
            return { promoted: false, error: `Failed to read inbox draft: ${e.message}` };
        }

        let draft;
        try {
            draft = JSON.parse(raw);
        } catch (e) {
            return { promoted: false, error: `Inbox draft has malformed JSON: ${e.message}` };
        }

        const category = opts.categoryOverride || draft.category;
        const memoryId = opts.idOverride || draft.suggested_id;

        if (!this.categories.includes(category)) {
            return { promoted: false, error: `Invalid category: ${category}. Allowed: ${this.categories.join(', ')}` };
        }
        if (!memoryId || typeof memoryId !== 'string') {
            return { promoted: false, error: 'Missing or invalid suggested_id (no idOverride supplied)' };
        }
        // F13: memoryId is derived (idOverride/suggested_id) and reaches
        // createMemory below, which THROWS on an unsafe id — violating this
        // method's documented never-throw contract. Guard it here, mirroring
        // deleteMemory/inboxDiscard's own isSafeMemoryId checks.
        if (!isSafeMemoryId(memoryId)) {
            return { promoted: false, error: `Invalid suggested id: "${memoryId}" — must be lowercase alphanumeric with '-'/'_' only (no path separators)` };
        }

        // F10: surface an id collision as its own distinct error instead of
        // letting createMemory's refusal collapse into the generic "category
        // limit reached?" message below — a collision and a full category are
        // different problems with different remedies (idOverride vs. wait/prune).
        const existingAtTarget = await this.readMemory(category, memoryId);
        if (existingAtTarget) {
            return { promoted: false, error: `id collision: ${category}/${memoryId} already exists — retry with a different --id, or delete/update the existing memory first` };
        }

        const created = await this.createMemory(category, memoryId, draft.content || {});
        if (!created) {
            return { promoted: false, error: `createMemory returned null (category limit reached?)` };
        }

        try {
            await fs.unlink(filePath);
        } catch {
            // Memory was created; failure to unlink is non-fatal but worth a warning
            console.error(`⚠ Promoted ${category}/${memoryId} but failed to unlink ${filePath}`);
        }

        return { promoted: true, category, id: memoryId };
    }

    /**
     * Delete a memory: unlink JSON file + remove from SQLite + FTS5.
     * Returns {deleted, error?} matching pruneStaleMemories' internal primitive
     * but exposed as a top-level method (R-B — required for /review:memory-defrag
     * merge operations).
     *
     * @param {string} category
     * @param {string} id
     * @returns {Promise<{deleted: boolean, error?: string}>}
     */
    async deleteMemory(category, id) {
        if (!this.categories.includes(category)) {
            return { deleted: false, error: `Invalid category: ${category}. Allowed: ${this.categories.join(', ')}` };
        }
        if (!isSafeMemoryId(id)) {
            return { deleted: false, error: `Invalid id: "${id}" — must be lowercase alphanumeric with '-'/'_' only (no path separators)` };
        }

        // Locate the JSON file — try both hyphenated and underscore IDs (createMemory
        // converts underscores to hyphens at write time but accepts both at read time)
        const hyphenated = MemoryManager.idToFilename(id);
        const candidates = [
            path.join(this.memoriesDir, category, `${hyphenated}.json`),
            path.join(this.memoriesDir, category, `${id}.json`),
        ];
        let filePath = null;
        for (const candidate of candidates) {
            try {
                await fs.access(candidate);
                filePath = candidate;
                break;
            } catch { /* try next */ }
        }
        if (!filePath) {
            return { deleted: false, error: `Memory not found: ${category}/${id}` };
        }

        try {
            await fs.unlink(filePath);
        } catch (e) {
            return { deleted: false, error: `Failed to unlink ${filePath}: ${e.message}` };
        }

        // Deindex from SQLite (non-fatal if it fails; JSON file is already gone)
        this.deindexMemory(id);

        return { deleted: true };
    }

    /**
     * Discard an inbox draft without promoting it.
     *
     * @param {string} id - inbox filename stem (without .json)
     * @returns {Promise<{discarded: boolean, error?: string}>}
     */
    async inboxDiscard(id) {
        // F42 (W2-1): guard the raw CLI-supplied `id` before it reaches
        // path.join — an unguarded `../`-laden id deletes an arbitrary .json
        // file outside the inbox root.
        if (!isSafeMemoryId(id)) {
            return { discarded: false, error: `Invalid inbox id: ${id} (must be lowercase alnum, '_' or '-'; no path separators)` };
        }
        const filePath = path.join(this._inboxDir(), `${id}.json`);
        try {
            await fs.unlink(filePath);
            return { discarded: true };
        } catch (e) {
            if (e.code === 'ENOENT') {
                return { discarded: false, error: `Inbox draft not found: ${id}` };
            }
            return { discarded: false, error: e.message };
        }
    }
}

module.exports = MemoryManager;
module.exports.buildFtsQuery = buildFtsQuery;

// Direct invocation forwards to the CLI module (Task #11 split).
// Existing callers running `node .claude/core/memory-manager.js <cmd>` still work.
// Export MUST be above this block — the CLI requires ./memory-manager back, and
// circular-require sees {} if module.exports is assigned after the CLI kicks off.
if (require.main === module) {
    require('./memory-manager-cli').main().catch(err => {
        console.error(err.message);
        process.exit(1);
    });
}
