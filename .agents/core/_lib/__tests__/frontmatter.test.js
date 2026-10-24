// AC→source map (Task #14 / frontmatter):
//   Single export: parseFrontmatter(content, {listFields, returnBody})
//   Preserves 4 divergent semantics under a unified API:
//     - Flat object return (default) — matches compiler, curator, promoter usage
//     - {frontmatter, body} return via returnBody:true — matches manager._parseFrontmatter
//     - List fields (sources/tags/aliases/cssclasses) parsed into arrays
//     - CRLF normalized to LF
//     - Hyphenated keys supported

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { parseFrontmatter } = require('../../../../.agents/core/_lib/frontmatter');

// ─── Flat-object mode (default) ──────────────────────────────────────────────

describe('parseFrontmatter (default flat mode)', () => {

  it('parseFrontmatter_validScalarsOnly_returnsFlatObject', () => {
    const md = ['---', 'title: Foo', 'category: patterns', '---', 'body'].join('\n');
    const result = parseFrontmatter(md);
    expect(result).toEqual({ title: 'Foo', category: 'patterns' });
  });

  it('parseFrontmatter_missingDelimiter_returnsNull', () => {
    expect(parseFrontmatter('no frontmatter here')).toBeNull();
  });

  it('parseFrontmatter_emptyString_returnsNull', () => {
    expect(parseFrontmatter('')).toBeNull();
  });

  it('parseFrontmatter_listFields_parsedAsArrays', () => {
    const md = [
      '---',
      'title: X',
      'sources:',
      '  - 2026-04-01',
      '  - 2026-04-02',
      'tags:',
      '  - alpha',
      '  - beta',
      '---',
      'body',
    ].join('\n');
    const result = parseFrontmatter(md);
    expect(result.title).toBe('X');
    expect(result.sources).toEqual(['2026-04-01', '2026-04-02']);
    expect(result.tags).toEqual(['alpha', 'beta']);
  });

  it('parseFrontmatter_emptyListField_omittedFromResult', () => {
    // `sources:` header with no items → should NOT add `sources: []` to result
    // (preserves compiler.parseFrontmatter behavior — "if list is empty, skip it")
    const md = ['---', 'title: X', 'sources:', '---', 'body'].join('\n');
    const result = parseFrontmatter(md);
    expect(result.title).toBe('X');
    expect(result).not.toHaveProperty('sources');
  });

  it('parseFrontmatter_hyphenatedKey_recognized', () => {
    // manager._parseFrontmatter supports hyphenated keys via `[\w-]+`
    const md = ['---', 'date-range: 2026-04-01 to 2026-04-22', '---'].join('\n');
    const result = parseFrontmatter(md);
    expect(result['date-range']).toBe('2026-04-01 to 2026-04-22');
  });

  it('parseFrontmatter_crlfLineEndings_normalized', () => {
    const md = '---\r\ntitle: Foo\r\n---\r\nbody';
    const result = parseFrontmatter(md);
    expect(result.title).toBe('Foo');
  });

  it('parseFrontmatter_customListFields_onlyListedTreatedAsLists', () => {
    // Opt into a NARROWER list-field set — curator/promoter style (only sources)
    const md = [
      '---',
      'sources:',
      '  - s1',
      'tags:',
      '  - t1',
      '---',
    ].join('\n');
    const result = parseFrontmatter(md, { listFields: ['sources'] });
    expect(result.sources).toEqual(['s1']);
    // `tags:` no longer recognized as a list header — it just becomes an empty string value
    expect(result.tags).toBe('');
  });

  it('parseFrontmatter_valueWithColonsAndSpaces_trimmed', () => {
    const md = ['---', 'title:   Spaced Value  ', '---'].join('\n');
    const result = parseFrontmatter(md);
    expect(result.title).toBe('Spaced Value');
  });

  // Regression (sec-m1): __proto__/constructor/prototype keys must never be
  // assigned — mirrors the UNSAFE_KEYS guard already present in yaml-parser.js.
  it('parseFrontmatter_protoKeyScalar_isSkippedAndPrototypeNotPolluted', () => {
    const md = ['---', '__proto__: polluted', 'title: Safe', '---', 'body'].join('\n');
    const result = parseFrontmatter(md);
    expect(({}).polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
    expect(result).not.toHaveProperty('__proto__', 'polluted');
    expect(result.title).toBe('Safe');
  });

  it('parseFrontmatter_constructorAndPrototypeKeys_areSkipped', () => {
    const md = ['---', 'constructor: bad', 'prototype: bad', 'title: Safe', '---'].join('\n');
    const result = parseFrontmatter(md);
    expect(result.title).toBe('Safe');
    expect(Object.keys(result)).toEqual(['title']);
  });

  it('parseFrontmatter_protoKeyAsListHeader_isSkippedAndPrototypeNotPolluted', () => {
    const md = [
      '---',
      '__proto__:',
      '  - polluted',
      'tags:',
      '  - real',
      '---',
    ].join('\n');
    const result = parseFrontmatter(md, { listFields: ['__proto__', 'tags'] });
    expect(({}).polluted).toBeUndefined();
    expect(result).not.toHaveProperty('__proto__');
    expect(result.tags).toEqual(['real']);
  });

});

// ─── Body-returning mode ─────────────────────────────────────────────────────

describe('parseFrontmatter (returnBody mode)', () => {

  it('parseFrontmatter_returnBody_returnsFrontmatterAndBody', () => {
    const md = [
      '---',
      'title: Foo',
      'type: pattern',
      '---',
      'first line of body',
      'second line',
    ].join('\n');
    const result = parseFrontmatter(md, { returnBody: true });
    expect(result.frontmatter).toEqual({ title: 'Foo', type: 'pattern' });
    expect(result.body).toContain('first line of body');
    expect(result.body).toContain('second line');
  });

  it('parseFrontmatter_returnBody_missingDelimiter_returnsNull', () => {
    expect(parseFrontmatter('no frontmatter', { returnBody: true })).toBeNull();
  });

  it('parseFrontmatter_returnBody_emptyFrontmatterBlock_returnsNull', () => {
    // Manager's original _parseFrontmatter returned null when frontmatter was empty.
    // This disambiguates "present-but-empty" from "missing" for the ingest path.
    const md = '---\n\n---\nbody text';
    expect(parseFrontmatter(md, { returnBody: true })).toBeNull();
  });

  it('parseFrontmatter_returnBody_crlf_normalized', () => {
    const md = '---\r\nname: Foo\r\n---\r\nBody\r\nline2';
    const result = parseFrontmatter(md, { returnBody: true });
    expect(result.frontmatter.name).toBe('Foo');
    expect(result.body).toContain('Body');
  });

});
