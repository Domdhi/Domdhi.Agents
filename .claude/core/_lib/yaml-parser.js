/**
 * YAML Parser — minimal subset parser for guardrail-rules.yaml syntax.
 *
 * Extracted verbatim from .claude/hooks/guardrail.cjs (lines 45–132) as part
 * of the P2.3 guardrail split. The implementation is intentionally not
 * improved — any changes to the parser must go through a separate story.
 *
 * SUPPORTED YAML SUBSET
 * ─────────────────────
 * - Top-level keys (no indent, ends with colon)
 * - Indented list items (  - value)
 * - Nested keys under a top-level mapping (  key:)
 * - Nested list items under a sub-key
 * - Inline # comments outside of quoted strings
 * - Double-quoted and single-quoted scalar values
 * - Unquoted scalar values
 * - Blank lines (skipped)
 * - Empty flow sequences and mappings: `key: []` and `key: {}`
 *   parse to an empty array. Added 2026-04-25 after a P2.5 latent bug where
 *   `dangerousPatterns: []` parsed to the literal string "[]" and cascaded
 *   the entire ruleset through Zod validation to emptyRules(), silently
 *   disabling all four-tier path checks. Non-empty flow forms still mis-parse.
 *
 * NOT SUPPORTED (will silently mis-parse or ignore)
 * ─────────────────────────────────────────────────
 * - YAML anchors and aliases (&foo, *foo)
 * - Non-empty flow sequences ([a, b, c])  — only the empty form `[]` is recognized
 * - Non-empty flow mappings ({key: value}) — only the empty form `{}` is recognized
 * - Multi-line scalar strings (> folded, | literal)
 * - Timestamps and dates
 * - Null expressed as ~ (tilde)
 * - True/false booleans (returned as the raw string "true"/"false")
 * - Numeric types (returned as raw strings)
 * - More than one level of nesting (top-level → sub-key → list items only)
 */

'use strict';

/**
 * Keys that must never be assigned from parsed input — assigning a nested value
 * under `__proto__` (or `constructor` / `prototype`) pollutes Object.prototype
 * for the whole process. parseYaml is only pointed at the trusted
 * guardrail-rules.yaml today, but this is cheap defense-in-depth so a future
 * caller pointed at an adopter-supplied rules file cannot be poisoned (sec-m1).
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parse a minimal YAML text into a plain JS object.
 *
 * Supports the subset documented in the module header. Anything outside
 * that subset will be silently ignored or mis-parsed.
 *
 * @param {string} text - Raw YAML string content
 * @returns {object} Parsed result as a plain JS object
 */
function parseYaml(text) {
    const lines = text.split('\n');
    const result = {};
    let currentTopKey = null;
    let currentSubKey = null;

    for (let raw of lines) {
        // Strip inline comments (but not inside quotes)
        const line = stripComment(raw);
        if (!line.trim()) continue;

        const indent = line.search(/\S/);

        // Top-level key (no indent, ends with colon)
        if (indent === 0 && line.includes(':')) {
            const colonIdx = line.indexOf(':');
            const key = line.slice(0, colonIdx).trim();
            const value = line.slice(colonIdx + 1).trim();
            if (UNSAFE_KEYS.has(key)) {
                // Refuse to assign a prototype-polluting key. Close any open
                // parent so subsequent indented items are ignored, not
                // reattached to the previous key. (sec-m1)
                currentTopKey = null;
                currentSubKey = null;
                continue;
            }
            if (value === '[]' || value === '{}') {
                // Empty flow sequence / mapping — treat as empty array.
                // The key is closed; subsequent indented items belong to a
                // different parent. See module header §SUPPORTED.
                result[key] = [];
                currentTopKey = null;
                currentSubKey = null;
            } else if (value) {
                result[key] = parseScalar(value);
                currentTopKey = null;
                currentSubKey = null;
            } else {
                currentTopKey = key;
                currentSubKey = null;
                if (!result[key]) result[key] = {};
            }
            continue;
        }

        // Indented list item under a top-level key
        if (indent > 0 && line.trim().startsWith('- ') && currentTopKey) {
            const value = line.trim().slice(2).trim();
            if (currentSubKey) {
                // List under a sub-key (e.g. zero_access list items)
                if (!Array.isArray(result[currentTopKey][currentSubKey])) {
                    result[currentTopKey][currentSubKey] = [];
                }
                result[currentTopKey][currentSubKey].push(parseScalar(value));
            } else {
                // List directly under top-level key
                if (!Array.isArray(result[currentTopKey])) {
                    result[currentTopKey] = [];
                }
                result[currentTopKey].push(parseScalar(value));
            }
            continue;
        }

        // Indented sub-key under a top-level mapping
        if (indent > 0 && line.includes(':') && currentTopKey) {
            const colonIdx = line.indexOf(':');
            const key = line.slice(0, colonIdx).trim();
            const value = line.slice(colonIdx + 1).trim();
            if (UNSAFE_KEYS.has(key)) {
                // Refuse a prototype-polluting nested key. (sec-m1)
                currentSubKey = null;
                continue;
            }
            if (value === '[]' || value === '{}') {
                // Empty flow form under a sub-key — close the sub-key so
                // subsequent `- item` lines don't accidentally fall back to
                // appending at the top-level key (currentSubKey === null).
                result[currentTopKey][key] = [];
                currentSubKey = null;
            } else if (value) {
                currentSubKey = key;
                result[currentTopKey][key] = parseScalar(value);
            } else {
                currentSubKey = key;
                result[currentTopKey][key] = [];
            }
        }
    }

    return result;
}

/**
 * Strip an inline comment from a YAML line, preserving # characters that
 * appear inside single or double quotes.
 *
 * Walks the line character-by-character to track quote state rather than
 * using a regex, which cannot handle nested/escaped quote edge cases.
 *
 * @param {string} line - A single raw line from the YAML file
 * @returns {string} The line with everything from the first unquoted # onward removed
 */
function stripComment(line) {
    // Walk character-by-character to avoid stripping # inside quotes
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (ch === '#' && !inSingle && !inDouble) {
            return line.slice(0, i);
        }
    }
    return line;
}

/**
 * Parse a YAML scalar value, stripping surrounding quotes if present.
 *
 * Only handles simple quoted strings (single or double quotes matching at
 * both ends). All other values are returned as-is (raw string).
 *
 * @param {string} value - A raw scalar value from a YAML line
 * @returns {string} The unquoted string value
 */
function parseScalar(value) {
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}

module.exports = { parseYaml, stripComment, parseScalar };
