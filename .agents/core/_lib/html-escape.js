/**
 * HTML Escape — shared escaping for HTML rendering.
 *
 * Extracted into its own module (P2.4 code review M-2) because three modules
 * — decision-html.js, timeline-format.js, status-html.js — each shipped
 * independent copies. Three divergence points for an XSS-adjacent helper is
 * a latent risk: a future fix to one copy that misses the others opens a
 * hole in timeline `content` or status HTML dashboards.
 *
 * Consumers:
 *   _lib/decision-html.js   — rendered vis.js HTML
 *   _lib/timeline-format.js — timeline node `content` fields
 *   _lib/status-html.js     — status dashboard HTML
 */

'use strict';

/**
 * HTML-escape a string for safe injection into HTML attributes and text.
 * Escapes &, <, >, " (double-quotes), and ' (single-quotes → &#39;).
 *
 * Apostrophe escaping was added for CR-2.3 / F13: none of today's consumers
 * use single-quoted attributes, but this is the ONE shared escaping
 * primitive for decision-html.js, timeline-format.js, and status-html.js — a
 * future single-quoted-attr consumer must not silently reopen an XSS hole.
 *
 * @param {string} str
 * @returns {string}
 */
function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

module.exports = { esc };
