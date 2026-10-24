/**
 * JSONL Writer — tail-rotating JSONL append utility.
 *
 * Extracted from two identical implementations:
 *   - .claude/hooks/command-usage-logger.cjs:99-116
 *   - .claude/core/memory-benchmark.js:233-248  (labeled "copied verbatim from command-usage-logger")
 *
 * Behavior:
 *   - Creates parent directories as needed
 *   - Appends `JSON.stringify(entry) + '\n'` to the file
 *   - When line count exceeds `maxLines`, tail-rotates to keep only the last
 *     `tailKeep` lines (monotonic shrinkage — bounds file size)
 *   - Silent on any I/O failure — JSONL writes must never break the calling flow
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_LINES = 1000;
const DEFAULT_TAIL_KEEP = 500;

// Per-path cached line count (T1) so the hot path (every searchMemories + session
// start) doesn't read + split the WHOLE file on every append just to decide on
// rotation. Seeded once per process on cache miss, incremented per append, reset to
// tailKeep after a rotation — so the O(file) read now happens only AT rotation
// (once per maxLines-tailKeep appends), not on every append. An estimate by design:
// two writers in SEPARATE processes each keep their own count, so a file may
// modestly overshoot maxLines before one rotates — still bounded, and telemetry
// rotation is best-effort. Keyed by the (absolute) jsonl path.
const lineCountCache = new Map();

/** Count complete (newline-terminated) lines — appendJsonl always writes '…\n'. */
function countJsonlLines(content) {
    let n = 0;
    for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10 /* \n */) n++;
    }
    return n;
}

/**
 * Append an entry as a JSONL line, rotating tail when over `maxLines`.
 * Graceful: errors are silenced so telemetry/metrics never block the workflow.
 *
 * @param {string} jsonlPath       Absolute path to the JSONL file
 * @param {object} entry           Any JSON-serializable value — appended as one line
 * @param {object} [opts]
 * @param {number} [opts.maxLines] Line-count ceiling before rotation (default: 1000)
 * @param {number} [opts.tailKeep] Lines to keep after rotation (default: 500)
 * @param {(msg: string) => void} [opts.onError] Optional error logger; default swallows
 */
function appendJsonl(jsonlPath, entry, {
    maxLines = DEFAULT_MAX_LINES,
    tailKeep = DEFAULT_TAIL_KEEP,
    onError,
} = {}) {
    try {
        fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
        fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n', 'utf8');

        // Cheap cached line count instead of re-reading the whole file each append.
        let count = lineCountCache.get(jsonlPath);
        if (count === undefined) {
            // Cold start — read once to seed (includes the line just appended).
            try { count = countJsonlLines(fs.readFileSync(jsonlPath, 'utf8')); }
            catch { count = 1; }
        } else {
            count += 1;
        }

        // Tail-sample if over limit. Rotation is the ONLY branch that re-reads the
        // file (it needs the content to keep the tail) — amortized, not per-append.
        if (count > maxLines) {
            const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(l => l.trim());
            if (lines.length > maxLines) {
                const trimmed = lines.slice(-tailKeep).join('\n') + '\n';
                // Write-temp + atomic rename (not a direct writeFileSync onto jsonlPath):
                // a direct write briefly truncates the file, so any concurrent reader OR
                // appender landing in that window could observe/produce a corrupt file
                // (zero-length, or a partial-JSON line spliced with an in-flight append).
                // rename() is atomic on POSIX — the file is always either the pre-rotation
                // content or the fully-written post-rotation content, never a partial mix.
                // This does NOT make rotation fully race-free: a concurrent appendFileSync
                // landing between the readFileSync above and the renameSync below still
                // loses that one line (it's absent from `trimmed`, and the append itself
                // gets overwritten by the rename). Per this file's module docstring, JSONL
                // writes here are already best-effort telemetry — this narrows the failure
                // mode from "reader sees a corrupt/truncated file" to "rare single-line
                // loss under heavy concurrent rotation," never a crash or blocked caller.
                const tmpPath = `${jsonlPath}.tmp-${process.pid}-${Date.now()}`;
                fs.writeFileSync(tmpPath, trimmed, 'utf8');
                try {
                    fs.renameSync(tmpPath, jsonlPath);
                } catch (renameErr) {
                    // Practically Linux/WSL-never (same-filesystem rename doesn't fail
                    // this way), but Windows can EPERM/EBUSY on a rename target that's
                    // open elsewhere. Don't leak the temp file — best-effort cleanup,
                    // then re-throw so the outer catch below still logs/swallows per
                    // this file's normal silent-on-I/O-failure contract.
                    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
                    throw renameErr;
                }
                count = tailKeep;
            } else {
                count = lines.length; // cache drifted high — resync to the truth
            }
        }
        lineCountCache.set(jsonlPath, count);
    } catch (e) {
        if (onError) {
            try { onError(e.message); } catch { /* logger itself failed — swallow */ }
        }
        // Graceful degradation — never block on telemetry failure
    }
}

module.exports = { appendJsonl, DEFAULT_MAX_LINES, DEFAULT_TAIL_KEEP };
