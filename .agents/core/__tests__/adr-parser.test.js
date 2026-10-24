// AC→source: _lib/adr-parser.js — ADR parsing primitives extracted from the
// adr-lint.js CLI (F6, council-260715-2244) so _lib consumers (decision-graph.js)
// never import upward from a top-level core/ CLI. The parsing behavior itself is
// exercised in depth by adr-lint.test.js through the CLI's re-exports; this file
// guards the LAYERING: the re-export is identity (not a drifting copy), the two
// consumers share one module, and no _lib file requires upward again.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const adrParser = require('../../../.agents/core/_lib/adr-parser');
const adrLint = require('../../../.agents/core/adr-lint');

describe('adr-lint re-exports the _lib/adr-parser primitives by identity', () => {
  it.each(['readStatus', 'supersedesRefs', 'saysSuperseded', 'looksLikeAdr'])(
    '%s is the same function object, not a copy',
    (name) => {
      expect(adrLint[name]).toBe(adrParser[name]);
    }
  );

  it('ADR_FILE_RE is the same RegExp object', () => {
    expect(adrLint.ADR_FILE_RE).toBe(adrParser.ADR_FILE_RE);
  });
});

describe('parsing primitives (smoke — depth lives in adr-lint.test.js)', () => {
  it('readStatus reads the canonical table row', () => {
    expect(adrParser.readStatus('| **Status** | Accepted |')).toEqual({ value: 'Accepted', form: 'table' });
  });
  it('supersedesRefs extracts ADR numbers', () => {
    expect(adrParser.supersedesRefs('| **Supersedes** | ADR-3, 0007 |').sort()).toEqual([3, 7]);
  });
  it('ADR_FILE_RE matches NNNN-title.md only', () => {
    expect(adrParser.ADR_FILE_RE.test('0007-docs-taxonomy.md')).toBe(true);
    expect(adrParser.ADR_FILE_RE.test('notes.md')).toBe(false);
  });
});

// F6's rule: core/*.js CLIs consume _lib/ helpers, never the reverse. A _lib
// module requiring a path outside _lib/ (other than ../constants) makes the
// target CLI un-reasonable-about as a leaf. One pre-existing exception is
// documented below — it predates this guard and is a materially larger
// restructure (memory-metrics.js consumes the whole MemoryManager class);
// anything NEW fails this test.
describe('layering — _lib modules do not import upward from core/ CLIs', () => {
  const libDir = path.resolve(__dirname, '../../../.agents/core', '_lib');
  const ALLOWED_UPWARD = new Set(['../constants']);
  const KNOWN_EXCEPTIONS = new Set([
    'memory-metrics.js', // requires ../memory-manager — pre-existing, tracked, do not add more
  ]);

  // A require() mentioned in a comment (e.g. adr-parser.js documenting the very
  // import F6 removed) is prose, not a dependency — scan CODE only. Same
  // false-positive class as the skill-merger fence-aware sentinel matching.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  it('no _lib file requires a non-allowlisted upward path', () => {
    const violations = [];
    for (const name of fs.readdirSync(libDir).filter((n) => n.endsWith('.js'))) {
      if (KNOWN_EXCEPTIONS.has(name)) continue;
      const src = stripComments(fs.readFileSync(path.join(libDir, name), 'utf8'));
      for (const m of src.matchAll(/require\(\s*['"](\.\.\/[^'"]+)['"]\s*\)/g)) {
        // The runtime dispatcher imports adapter libraries, never a core CLI.
        const runtimeLibrary = name === 'model-runner.js' && [
          '../../adapters/claude/core/_lib/model-runner',
          '../../adapters/codex/core/_lib/model-runner',
        ].includes(m[1]);
        if (!ALLOWED_UPWARD.has(m[1]) && !runtimeLibrary) violations.push(`${name} → ${m[1]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('decision-graph.js specifically no longer requires ../adr-lint (F6)', () => {
    const src = stripComments(fs.readFileSync(path.join(libDir, 'decision-graph.js'), 'utf8'));
    expect(src).not.toMatch(/require\(\s*['"]\.\.\/adr-lint['"]\s*\)/);
    expect(src).toMatch(/require\(\s*['"]\.\/adr-parser['"]\s*\)/);
  });

  it('decision-graph.js uses the canonical _lib/frontmatter parser (F7)', () => {
    const src = stripComments(fs.readFileSync(path.join(libDir, 'decision-graph.js'), 'utf8'));
    expect(src).toMatch(/require\(\s*['"]\.\/frontmatter['"]\s*\)/);
    expect(src).not.toMatch(/function parseFrontmatter\s*\(/);
  });
});
