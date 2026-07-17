/**
 * Frontmatter — YAML frontmatter parser unified across the memory-* codebase.
 *
 * Replaces 4 divergent implementations:
 *   - memory-compiler.js:757  (flat object, full list-field support)
 *   - memory-curator.js:115   (flat object, only `sources` as list)
 *   - memory-promoter.js:370  (flat object, only `sources` as list — identical to curator)
 *   - memory-manager.js:659   (returns {frontmatter, body}; flat only; CRLF-aware; hyphenated keys)
 *
 * Unified behavior (superset of all 4):
 *   - CRLF normalized to LF
 *   - Hyphenated keys supported (e.g. `date-range`)
 *   - List fields parsed into arrays (configurable; defaults cover all callers)
 *   - `returnBody: true` opt-in yields {frontmatter, body}; default returns flat object
 *   - Returns null when no frontmatter delimiter found, OR when returnBody mode finds
 *     an empty frontmatter block (matches manager's original behavior)
 */

const DEFAULT_LIST_FIELDS = ['sources', 'tags', 'aliases', 'cssclasses'];

/**
 * Keys refused during parsing as defense-in-depth against prototype pollution.
 * In THIS parser every assigned value is a plain string onto a plain object
 * literal, so `result.__proto__ = "someString"` is a spec no-op and
 * `constructor`/`prototype` land as ordinary own properties, not prototype-chain
 * mutations — there's no live exploit via this file's flat string-value shape.
 * The guard mirrors _lib/yaml-parser.js (sec-m1), which builds nested objects
 * and IS genuinely at risk, kept here for consistency and cheap insurance
 * against a future change to this parser's value shape.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parse YAML frontmatter from a markdown string.
 *
 * @param {string} content              Markdown text beginning with `---\n...\n---`
 * @param {object} [opts]
 * @param {string[]} [opts.listFields]  Fields to treat as list-of-strings (default: sources, tags, aliases, cssclasses)
 * @param {boolean} [opts.returnBody]   If true, return `{frontmatter, body}`; else return flat object (default: false)
 * @returns {object|null} Frontmatter object, or `{frontmatter, body}`, or null if missing/empty
 */
function parseFrontmatter(content, { listFields = DEFAULT_LIST_FIELDS, returnBody = false } = {}) {
    const normalized = String(content).replace(/\r\n/g, '\n');

    // returnBody mode needs the trailing body capture; flat mode doesn't.
    const re = returnBody
        ? /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/
        : /^---\n([\s\S]*?)\n---/;
    const match = normalized.match(re);
    if (!match) return null;

    const raw = match[1];
    const body = returnBody ? (match[2] || '') : null;

    const result = {};
    const listSet = new Set(listFields);
    let currentList = null;
    const lists = {};

    for (const line of raw.split('\n')) {
        // List field start: `fieldname:` with no value on same line
        const listStart = line.match(/^([\w-]+):$/);
        if (listStart && listSet.has(listStart[1])) {
            if (UNSAFE_KEYS.has(listStart[1])) {
                // Currently unreachable: listSet only ever contains
                // DEFAULT_LIST_FIELDS (sources/tags/aliases/cssclasses) or a
                // caller-supplied listFields override, neither of which any
                // current caller sets to an unsafe key. Kept as defense-in-depth
                // in case listFields is ever extended to a caller-controlled key.
                currentList = null;
                continue;
            }
            currentList = listStart[1];
            lists[currentList] = [];
            continue;
        }

        // Within a list: `  - item` lines
        if (currentList && line.startsWith('  - ')) {
            lists[currentList].push(line.replace('  - ', '').trim());
            continue;
        }

        // Exit list mode on any other line shape
        if (currentList && !line.startsWith('  - ')) {
            currentList = null;
        }

        const kv = line.match(/^([\w-]+):\s*(.*)$/);
        if (kv && UNSAFE_KEYS.has(kv[1])) continue; // Refuse a prototype-polluting key. (sec-m1)
        if (kv) result[kv[1]] = kv[2].trim();
    }

    for (const [key, values] of Object.entries(lists)) {
        if (values.length > 0) result[key] = values;
    }

    if (returnBody) {
        // Manager's original returned null for an empty frontmatter block.
        // Preserve that semantics — callers rely on it for "missing frontmatter" detection.
        if (Object.keys(result).length === 0) return null;
        return { frontmatter: result, body };
    }

    return result;
}

module.exports = { parseFrontmatter };
