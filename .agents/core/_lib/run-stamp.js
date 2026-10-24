#!/usr/bin/env node

/**
 * run-stamp.js — the universal {YYMMDD-HHMM} run stamp.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Run-Stamp Convention (.agents/startup-reference.md) says every fresh-each-run output file is
 * prefixed with `YYMMDD-HHMM`, computed ONCE per command run and reused verbatim
 * so same-day re-runs never clobber and one run's artifacts sort together.
 *
 * `handoff-path.js` and `output-paths.js` both need that exact stamp; this is the
 * single implementation they share (extracted from handoff-path.js so the format
 * can never drift between the two). The cached variant (`cachedStamp()`) holds one
 * value for the lifetime of the process — the "compute once per run" rule made
 * mechanical: every call site in a single `node` invocation gets the same string
 * without threading it through arguments.
 */

/** YYMMDD-HHMM run stamp for a given date (defaults to now). */
function stamp(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    const yy = p(date.getFullYear() % 100);
    return `${yy}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

/** YYYY-MM month-bucket folder for a given date (defaults to now). */
function monthBucket(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}`;
}

/** YYYY-MM-DD day key for a given date (defaults to now) — day-append logs. */
function dayKey(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

// Process-lifetime cache: the "compute the stamp once per command run" rule made
// mechanical. We cache the Date INSTANT (not the string) so the stamp, the month
// bucket, and the day key are all derived from one moment — a discrete file's
// YYYY-MM/ folder can never disagree with its YYMMDD-HHMM filename, even across a
// month boundary mid-run. First call fixes the instant; every later call reuses it.
let _cachedDate = null;
function cachedDate() {
    if (_cachedDate === null) _cachedDate = new Date();
    return _cachedDate;
}
function cachedStamp() { return stamp(cachedDate()); }
function cachedMonthBucket() { return monthBucket(cachedDate()); }
function cachedDayKey() { return dayKey(cachedDate()); }

/** Test-only: reset the process cache so unit tests can re-stamp deterministically. */
function _resetCache() {
    _cachedDate = null;
}

module.exports = {
    stamp, monthBucket, dayKey,
    cachedDate, cachedStamp, cachedMonthBucket, cachedDayKey,
    _resetCache,
};

// ---- CLI ----
if (require.main === module) {
    process.stdout.write(stamp() + '\n');
}
