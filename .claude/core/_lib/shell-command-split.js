'use strict';
/**
 * shell-command-split — one correct shell command-boundary splitter shared by
 * both guard hooks (commit-guard.cjs, guardrail.cjs).
 *
 * WHY THIS EXISTS (CR-1.2 — F58/F59/F61/F62): the two guards each grew their own
 * ad-hoc "where does a new command start?" logic and each missed a different set
 * of shell boundaries — a guard-bypass class that recurred three times. This
 * module is the single source of truth for two questions:
 *
 *   1. splitCommandSegments(command) — where does one command end and the next
 *      begin? (metacharacters AND shell keyword statement-starts)
 *   2. stripWrapperPrefix(segment)   — after a segment starts, what is the REAL
 *      command head once leading wrappers (sudo/env/time/nice/…) are peeled off?
 *
 * Together they let a guard recognize `git commit` / `rm -rf .env` as a command
 * head no matter how it is chained, nested, keyword-wrapped, or prefixed.
 *
 * Both functions are PURE and must NEVER throw on odd input — a guard that calls
 * them fails CLOSED (blocks), so an exception here would flip that to fail-open.
 * Non-string input is handled explicitly.
 */

// ─── Command-boundary separators ──────────────────────────────────────────────
//
// A single RegExp used with String.prototype.split. Two rules govern its shape:
//
//   • Two-char operators are listed BEFORE their single-char prefixes so the
//     longer form wins at a shared position: `&&` before `&`, `||` before `|`,
//     and `$(` before a bare `(`. JS alternation is ordered per match position,
//     so listing order === precedence.
//
//   • Shell KEYWORD statement-starts (`then do else elif { }`) split too, but
//     only at a WORD/token boundary — `then` in `if …; then rm …` starts a new
//     command, while `then` inside `runthendoit` does not. `\b…\b` gives the
//     keyword boundary; the brace keywords use whitespace lookaround so an
//     embedded `-I{}` (an xargs placeholder) is never split.
//
// No capturing groups: String.split drops the matched delimiters, which is what
// we want (the separator/keyword is never part of a command head).
const SEGMENT_SPLIT = new RegExp(
    [
        '&&', '\\|\\|',          // two-char operators (before their single-char forms)
        '\\$\\(',                // command-substitution opener (before a bare `(`)
        ';', '\\|', '&', '\\n', '`', '\\(', '\\)', // single-char metacharacters
        '\\b(?:then|do|else|elif)\\b',             // shell keyword statement-starts
        '(?<=^|\\s)\\{(?=\\s)',                     // `{ … ; }` group opener (whitespace-delimited)
        '(?<=\\s)\\}(?=\\s|;|$)',                   // `{ … ; }` group closer (whitespace-delimited)
    ].join('|'),
    'g'
);

/**
 * Collapse bash line-continuations (`\` IMMEDIATELY before a newline) BEFORE
 * splitting. Bash joins such a continuation by removing the backslash+newline
 * and concatenating the two physical lines into one logical command — so
 * `git commit \`⏎`-m "secret"` is a SINGLE `git commit -m "secret"`. Without
 * this collapse, the `\n` split would tear the continuation into two segments
 * (`git commit \` reads as a bare editor commit; `-m "secret"` is orphaned),
 * letting an inline commit skip commit.js's secret scan (M1) and a
 * `rm -rf \`⏎`.env` downgrade its zeroAccessPaths hard block to a nudge (M3).
 *
 * The backslash must be immediately before the newline (optionally a `\r` for
 * CRLF); a backslash followed by whitespace-then-newline is NOT a bash
 * continuation and is left alone. Guarded for non-string input; never throws.
 *
 * @param {string} command
 * @returns {string}
 */
function collapseLineContinuations(command) {
    if (typeof command !== 'string') return command;
    return command.replace(/\\\r?\n/g, '');
}

/**
 * Split a shell command string into command-position segments.
 *
 * Bash line-continuations are collapsed first (see collapseLineContinuations),
 * then the string is split on the classic metacharacters `&& || ; | & \n $( ` (
 * )` AND on the shell keywords `then do else elif { }` when they appear at a
 * word/token boundary. Each returned element is the raw text between two
 * boundaries (callers typically `.trim()` it and hand it to stripWrapperPrefix).
 *
 * @param {string} command
 * @returns {string[]}  command-position segments; `[]` for non-string input.
 */
function splitCommandSegments(command) {
    if (typeof command !== 'string') return [];
    return collapseLineContinuations(command).split(SEGMENT_SPLIT);
}

// ─── Wrapper-prefix stripping ─────────────────────────────────────────────────
//
// Commands are frequently launched through a wrapper that is transparent to what
// actually runs: `sudo git commit`, `env FOO=1 git commit`, `nice -n10 rm -rf …`,
// `xargs -I{} git commit`. A guard that only inspects the FIRST token of a
// segment misses the real command head behind such a wrapper. stripWrapperPrefix
// peels a leading chain of these wrappers off, iteratively, so stacked wrappers
// (`sudo env FOO=1 nice git commit`) reduce to the true head (`git commit`).
//
// Each rule is anchored at the (leading-whitespace-trimmed) start and requires
// trailing whitespace, so it only ever consumes a genuine wrapper token followed
// by more command — never the whole segment, and never a bare command whose name
// merely coincides with a wrapper. Every rule consumes ≥2 chars, so the loop
// always terminates.

// Wrappers that take no options of their own — strip the bare token.
const SIMPLE_WRAPPER = /^(?:sudo|nohup|time|command|exec|doas|builtin)\b\s+/;

/**
 * Strip a leading chain of command wrappers from a segment, returning the real
 * command head. A segment with no wrapper is returned unchanged (aside from
 * leading whitespace, which callers trim anyway).
 *
 * Recognized wrappers:
 *   sudo, nohup, time, command, exec, doas, builtin  — bare token
 *   env  VAR=value…                                  — plus any assignment words
 *   nice [-n N] | [-nN] | [-N]                        — plus an optional niceness
 *   xargs [-flags…]                                   — plus its option flags
 *
 * @param {string} segment
 * @returns {string}  the command head with wrappers removed; input unchanged for
 *                    non-string input.
 */
function stripWrapperPrefix(segment) {
    if (typeof segment !== 'string') return segment;

    let s = segment;
    let changed = true;
    while (changed) {
        changed = false;
        const head = s.replace(/^\s+/, ''); // ignore leading whitespace for matching

        // sudo / nohup / time / command / exec / doas / builtin
        let m = head.match(SIMPLE_WRAPPER);
        if (m) { s = head.slice(m[0].length); changed = true; continue; }

        // env  [VAR=value …]  — consume the `env` token then any assignment words.
        m = head.match(/^env\b\s+/);
        if (m) {
            let rest = head.slice(m[0].length);
            let a;
            while ((a = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/))) {
                rest = rest.slice(a[0].length);
            }
            s = rest; changed = true; continue;
        }

        // nice  [-n N] | [-nN] | [-N]  — consume `nice` then an optional niceness.
        m = head.match(/^nice\b\s+/);
        if (m) {
            let rest = head.slice(m[0].length);
            const n = rest.match(/^-n\s+\d+\s+/) || rest.match(/^-n\d+\s+/) || rest.match(/^-\d+\s+/);
            if (n) rest = rest.slice(n[0].length);
            s = rest; changed = true; continue;
        }

        // xargs  [-flags …]  — consume `xargs` then any leading option flags
        // (`-I{}`, `-n1`, `-0`, …). Flag scanning stops at the first non-flag
        // token, which is the real command head being fed to xargs.
        m = head.match(/^xargs\b\s+/);
        if (m) {
            let rest = head.slice(m[0].length);
            let f;
            while ((f = rest.match(/^-\S*\s+/))) {
                rest = rest.slice(f[0].length);
            }
            s = rest; changed = true; continue;
        }
    }
    return s;
}

module.exports = { splitCommandSegments, stripWrapperPrefix, collapseLineContinuations };
