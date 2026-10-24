/**
 * Tests for .claude/core/_lib/html-escape.js
 *
 * Exercises: esc() — the single shared HTML-escaping primitive consumed by
 * decision-html.js, timeline-format.js, and status-html.js.
 *
 * CR-2.3 / F13: esc() escaped & < > " but not the apostrophe. Not exploitable
 * today (all current consumers use double-quoted attrs/text), but this is the
 * ONE shared escaping primitive — a future single-quoted-attr consumer would
 * reintroduce a hole. Hardening it here closes that gap for every consumer.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { esc } = require('../../../.agents/core/_lib/html-escape');

describe('html-escape', () => {
    describe('esc', () => {
        it('escapes & < > " into HTML entities', () => {
            expect(esc('<b>&"</b>')).toBe('&lt;b&gt;&amp;&quot;&lt;/b&gt;');
        });

        it('escapes the apostrophe into &#39; (F13)', () => {
            expect(esc("it's")).toBe('it&#39;s');
        });

        it('escapes a mix of all five special characters together', () => {
            expect(esc(`<img src='x' onerror="alert(1)">&`)).toBe(
                '&lt;img src=&#39;x&#39; onerror=&quot;alert(1)&quot;&gt;&amp;'
            );
        });

        it('leaves ordinary text unchanged', () => {
            expect(esc('hello world')).toBe('hello world');
        });

        it('coerces non-strings via String()', () => {
            expect(esc(42)).toBe('42');
        });
    });
});
