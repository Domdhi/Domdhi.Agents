#!/usr/bin/env node

/**
 * output-paths.js — the ONLY door into docs/.output/.
 *
 * WHY THIS EXISTS
 * ---------------
 * ADR 0006 (".output Taxonomy"). The generated zone used to be ~520 hardcoded
 * path literals scattered across core/, hooks/, and command/skill/agent prose —
 * with three coexisting naming eras and a flat layout that hit 972 files in one
 * compartment on a real adopter. This helper generalizes the handoff-path.js
 * resolver to EVERY compartment, so *code* obtains an `.output` path one way:
 * call this. Agents stop choosing paths and therefore cannot drift.
 *
 * The compartment registry is `OUTPUT_PATHS` in constants.js (the single source).
 * Each compartment has a zone (durable|state), a shape, and a bucket:
 *
 *   discrete  {kind}/{YYYY-MM}/{YYMMDD-HHMM}-{slug}.{ext}   →  outputPath()
 *   daylog    {kind}/{YYYY-MM}/{YYYY-MM-DD}.md              →  dayLogPath()
 *   rununit   {kind}/{YYYY-MM}/{YYMMDD-HHMM}-{slug}/        →  runUnitDir()
 *
 * The YYYY-MM month folder bounds a compartment's size (glob stays ~70, not 972)
 * and gives a clean archival edge (`rm -r {kind}/2026-04/`); the filename STAMP is
 * the real index (agents sort + grep by it). State-zone compartments are flat
 * (bucket 'none') and live under docs/.output/.state/ (one gitignore line).
 *
 * OPEN taxonomy: an unknown `kind` still resolves (durable/discrete/month default)
 * so a specialized adopter that grows `bugs/` or `emails/` is never blocked.
 *
 * All functions return REPO-RELATIVE path strings (e.g.
 * `docs/.output/findings/reviews/2026-06/260621-1306-code-review.md`), matching
 * handoff-path.js. `ensureDir()` is the only one that touches the filesystem.
 *
 * USAGE (CLI)
 *   node output-paths.js path <kind> <slug> [ext]   # discrete file path (+mkdir)
 *   node output-paths.js daylog <kind>              # day-append log path (+mkdir)
 *   node output-paths.js rununit <kind> <slug>      # run-unit dir path (+mkdir)
 *   node output-paths.js latest <kind> [substr]     # newest discrete file, or empty
 *   node output-paths.js kinds                      # list registry compartments
 */

const fs = require('fs');
const path = require('path');
const { OUTPUT_PATHS } = require('../constants');
const {
    cachedStamp, cachedMonthBucket, cachedDayKey, monthBucket,
} = require('./run-stamp');

const OUTPUT_ROOT = 'docs/.output';

/**
 * Resolve a compartment entry. Grouping compartments (`group:true`) hold no files
 * and throw. Unknown kinds resolve synthetically (open taxonomy).
 */
function entry(kind) {
    const e = OUTPUT_PATHS[kind];
    if (!e) {
        // Open taxonomy — treat the kind itself as the dir, default durable/discrete/month.
        // F16: an unregistered `kind` is caller-controlled and, unlike `slug`, was never
        // sanitized — '../../../../etc' or an absolute path rode straight into
        // compartmentDir()'s path.join()+mkdirSync(recursive) and escaped OUTPUT_ROOT.
        // sanitizeKindPath() closes that BEFORE the dir is ever used. Registered kinds
        // (the `e` branch below) are a fixed, hardcoded whitelist in constants.js and
        // never need this — their `dir` (incl. legitimately nested ones) passes through.
        return { dir: sanitizeKindPath(kind), zone: 'durable', shape: 'discrete', bucket: 'month', _synthetic: true };
    }
    if (e.group) {
        throw new Error(`"${kind}" is a grouping compartment — use a sub-compartment (e.g. "${kind}/...").`);
    }
    return e;
}

/** Slugify a free-text slug into a filename-safe, lowercase token. */
function slugify(raw) {
    return String(raw || '')
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || 'untitled';
}

/**
 * F16: sanitize a caller-supplied `kind` before it becomes a directory segment
 * for an UNREGISTERED (open-taxonomy) compartment. Splits on both `/` and `\`,
 * drops empty / `.` / `..` segments (kills path traversal AND an absolute-path
 * leader, since a leading separator just yields an empty segment that's
 * dropped), then slugify()s each surviving segment (kills anything outside the
 * filename-safe charset — slugify alone is not enough here since it allows
 * `.`, so a literal '..' segment would otherwise survive untouched).
 *
 * F16 follow-up: slugify() strips characters outside its charset, which can
 * RESURRECT a traversal segment that the pre-slugify filter already passed —
 * e.g. `"..%"` isn't literally `..` before slugify, but slugify drops the `%`
 * and yields `".."` after. So segments must be re-checked for all-dots (and
 * emptiness) AFTER slugify too, not just before.
 */
function sanitizeKindPath(kind) {
    const segments = String(kind == null ? '' : kind)
        .split(/[\\/]+/)
        .map((seg) => seg.trim())
        .filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
        .map((seg) => slugify(seg))
        .filter((seg) => seg !== '' && !/^\.+$/.test(seg));
    return segments.length ? segments.join('/') : 'untitled';
}

/** The bucket segment (YYYY-MM) for a compartment, or null when bucket:'none'. */
function bucketSeg(e) {
    if (e.bucket === 'month') return cachedMonthBucket();
    return null;
}

/**
 * The directory a compartment writes into THIS run (incl. the month bucket).
 * Repo-relative, no trailing slash. Does not touch the filesystem.
 */
function compartmentDir(kind) {
    const e = entry(kind);
    const parts = [OUTPUT_ROOT, e.dir];
    const seg = bucketSeg(e);
    if (seg) parts.push(seg);
    return parts.join('/');
}

/** Discrete report path: {kind}/{YYYY-MM}/{stamp}-{slug}.{ext}. mkdir's the dir. */
function outputPath(kind, { slug, ext = 'md', cwd = process.cwd() } = {}) {
    const dir = compartmentDir(kind);
    fs.mkdirSync(path.join(cwd, dir), { recursive: true });
    const e = ext.replace(/^\./, '');
    return `${dir}/${cachedStamp()}-${slugify(slug)}.${e}`;
}

/** Day-append log path: {kind}/{YYYY-MM}/{YYYY-MM-DD}.md. mkdir's the dir. */
function dayLogPath(kind, { cwd = process.cwd() } = {}) {
    const dir = compartmentDir(kind);
    fs.mkdirSync(path.join(cwd, dir), { recursive: true });
    return `${dir}/${cachedDayKey()}.md`;
}

/** Run-unit dir path: {kind}/{YYYY-MM}/{stamp}-{slug}/. mkdir's it. */
function runUnitDir(kind, { slug, cwd = process.cwd() } = {}) {
    const dir = compartmentDir(kind);
    const unit = `${dir}/${cachedStamp()}-${slugify(slug)}`;
    fs.mkdirSync(path.join(cwd, unit), { recursive: true });
    return unit;
}

/** mkdir -p a compartment's current write dir; return it. */
function ensureDir(kind, { cwd = process.cwd() } = {}) {
    const dir = compartmentDir(kind);
    fs.mkdirSync(path.join(cwd, dir), { recursive: true });
    return dir;
}

/**
 * Newest discrete/run-unit entry in a compartment, scanning across month folders
 * (newest month first). `filter` (substring) narrows by slug. Returns a
 * repo-relative path, or null when nothing matches. Never throws on a missing dir.
 */
function latest(kind, filter = null, { cwd = process.cwd() } = {}) {
    const e = entry(kind);
    const base = path.join(cwd, OUTPUT_ROOT, e.dir);
    let monthDirs;
    try {
        monthDirs = fs.readdirSync(base, { withFileTypes: true })
            .filter((d) => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
            .map((d) => d.name)
            .sort()
            .reverse(); // newest month first
    } catch {
        return null;
    }
    // Unbucketed (state) compartments keep files at the compartment root.
    if (e.bucket === 'none') monthDirs = [''];

    for (const m of monthDirs) {
        const dir = m ? path.join(base, m) : base;
        let names;
        try {
            names = fs.readdirSync(dir);
        } catch {
            continue;
        }
        const matches = names
            .filter((n) => /^\d{6}-\d{4}-/.test(n))
            .filter((n) => (filter ? n.includes(filter) : true))
            .sort(); // stamp-prefix => chronological
        if (matches.length) {
            const rel = m ? `${OUTPUT_ROOT}/${e.dir}/${m}/${matches[matches.length - 1]}`
                          : `${OUTPUT_ROOT}/${e.dir}/${matches[matches.length - 1]}`;
            return rel;
        }
    }
    return null;
}

module.exports = {
    OUTPUT_ROOT,
    entry,
    slugify,
    compartmentDir,
    outputPath,
    dayLogPath,
    runUnitDir,
    ensureDir,
    latest,
};

// ---- CLI ----
if (require.main === module) {
    const [cmd, kind, a, b] = process.argv.slice(2);
    try {
        if (cmd === 'path') {
            if (!kind || !a) { process.stderr.write('usage: output-paths.js path <kind> <slug> [ext]\n'); process.exit(2); }
            process.stdout.write(outputPath(kind, { slug: a, ext: b || 'md' }) + '\n');
        } else if (cmd === 'daylog') {
            if (!kind) { process.stderr.write('usage: output-paths.js daylog <kind>\n'); process.exit(2); }
            process.stdout.write(dayLogPath(kind) + '\n');
        } else if (cmd === 'rununit') {
            if (!kind || !a) { process.stderr.write('usage: output-paths.js rununit <kind> <slug>\n'); process.exit(2); }
            process.stdout.write(runUnitDir(kind, { slug: a }) + '\n');
        } else if (cmd === 'latest') {
            const p = latest(kind, a || null);
            if (p) process.stdout.write(p + '\n');
            // empty + exit 0 when none
        } else if (cmd === 'kinds') {
            process.stdout.write(Object.keys(OUTPUT_PATHS).join('\n') + '\n');
        } else {
            process.stderr.write('usage: output-paths.js <path|daylog|rununit|latest|kinds> …\n');
            process.exit(2);
        }
    } catch (err) {
        process.stderr.write(`output-paths.js: ${err.message}\n`);
        process.exit(2);
    }
}
