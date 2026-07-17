// AC→source: fs-safe-lint.js — the mechanical regression-prevention form of the
// fs-safe-hardening-needs-every-callsite-not-just-most memory. Scoped ONLY to the
// confirmed adopter-trust-boundary-crossing fileset (not core/ wide — that would
// false-positive on the many legitimate workshop-local raw fs calls elsewhere).
// Two rules: UNGUARDED_WRITE (raw fs.writeFileSync/copyFileSync/cpSync, no
// fs-safe-lint:local marker) and UNGUARDED_DELETE (raw fs.rmSync/rmdirSync, no
// marker AND no assertNoSymlinkedAncestor() guard within the preceding window).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  TRUST_BOUNDARY_FILES,
  scanText,
  runLint,
  formatReport,
} = require('../fs-safe-lint');
const { createTmpDir } = require('./_helpers/tmp-dir');

describe('scanText', () => {
  it('flags a raw fs.writeFileSync with no marker', () => {
    const hits = scanText("fs.writeFileSync(dstPath, data);\n");
    expect(hits).toHaveLength(1);
    expect(hits[0].rule).toBe('UNGUARDED_WRITE');
    expect(hits[0].severity).toBe('ERROR');
    expect(hits[0].line).toBe(1);
  });

  it('flags a raw fs.copyFileSync and fs.cpSync the same way', () => {
    expect(scanText("fs.copyFileSync(src, dst);\n")).toHaveLength(1);
    expect(scanText("fs.cpSync(src, dst);\n")).toHaveLength(1);
  });

  it('suppresses a write marked fs-safe-lint:local', () => {
    const hits = scanText("fs.writeFileSync(tmpFile, data); // fs-safe-lint:local — os.tmpdir() scratch file\n");
    expect(hits).toEqual([]);
  });

  it('flags a raw fs.rmSync with no nearby guard', () => {
    const hits = scanText("fs.rmSync(tmpDir, { recursive: true, force: true });\n");
    expect(hits).toHaveLength(1);
    expect(hits[0].rule).toBe('UNGUARDED_DELETE');
    expect(hits[0].severity).toBe('ERROR');
  });

  it('suppresses fs.rmdirSync preceded by assertNoSymlinkedAncestor within the guard window', () => {
    const text = [
      'try {',
      '    assertNoSymlinkedAncestor(cur, containRoot);',
      '    if (fs.readdirSync(cur).length > 0) break;',
      '    fs.rmdirSync(cur);',
      '} catch { break; }',
      '',
    ].join('\n');
    expect(scanText(text)).toEqual([]);
  });

  it('does NOT suppress a delete when the guard is too far above (outside the window)', () => {
    const lines = ['assertNoSymlinkedAncestor(cur, containRoot);'];
    for (let i = 0; i < 10; i++) lines.push(`// filler ${i}`);
    lines.push('fs.rmSync(cur, { force: true });');
    const hits = scanText(lines.join('\n'));
    expect(hits).toHaveLength(1);
    expect(hits[0].rule).toBe('UNGUARDED_DELETE');
  });

  it('suppresses a delete marked fs-safe-lint:local', () => {
    expect(scanText("fs.rmSync(tmpDir, { recursive: true, force: true }); // fs-safe-lint:local — os.tmpdir() scratch\n")).toEqual([]);
  });

  it('leaves clean fs-safe-routed code alone', () => {
    const text = [
      "const { safeWrite, safeDelete } = require('./_lib/fs-safe');",
      'safeWrite(dstPath, data, undefined, containRoot);',
      'safeDelete(dstPath, containRoot);',
      '',
    ].join('\n');
    expect(scanText(text)).toEqual([]);
  });

  it('reports 1-indexed line numbers matching the offending line', () => {
    const text = '// comment\n// another\nfs.writeFileSync(a, b);\n';
    const hits = scanText(text);
    expect(hits[0].line).toBe(3);
  });
});

describe('runLint (integration over a fixture tree)', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'fs-safe-lint-test-' }); });
  afterEach(() => { tmp.cleanup(); });

  it('scans ONLY the hardcoded trust-boundary fileset, not core/ wide', () => {
    tmp.write('.claude/core/install.js', "safeWrite(dst, data, undefined, root);\n");
    // A file with an unguarded write OUTSIDE the trust-boundary fileset must be ignored.
    tmp.write('.claude/core/gate.js', "fs.writeFileSync(reportPath, JSON.stringify(x));\n");
    const { findings, scanned } = runLint(tmp.root, {});
    expect(findings).toEqual([]);
    expect(scanned).toBe(1); // only install.js exists among TRUST_BOUNDARY_FILES
  });

  it('flags an unguarded write introduced into a trust-boundary file', () => {
    tmp.write('.claude/core/install.js', "fs.writeFileSync(dst, data);\n");
    const { findings } = runLint(tmp.root, {});
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('.claude/core/install.js');
    expect(findings[0].rule).toBe('UNGUARDED_WRITE');
  });

  it('skips a trust-boundary file that does not exist in this tree', () => {
    const { findings, scanned } = runLint(tmp.root, {});
    expect(findings).toEqual([]);
    expect(scanned).toBe(0);
  });

  it('supports an explicit files override', () => {
    tmp.write('custom/thing.js', "fs.writeFileSync(a, b);\n");
    const { findings, scanned } = runLint(tmp.root, { files: ['custom/thing.js'] });
    expect(scanned).toBe(1);
    expect(findings).toHaveLength(1);
  });
});

describe('formatReport', () => {
  it('reports clean with scanned count', () => {
    expect(formatReport({ findings: [], scanned: 9 })).toContain('clean — 9 files scanned');
  });

  it('reports error count and per-finding lines', () => {
    const report = formatReport({
      findings: [{ file: 'tools/fleet.js', line: 42, rule: 'UNGUARDED_WRITE', severity: 'ERROR', token: 'fs.writeFileSync(x, y);', hint: 'route through safeWrite' }],
      scanned: 9,
    });
    expect(report).toContain('1 error(s)');
    expect(report).toContain('tools/fleet.js:42');
    expect(report).toContain('UNGUARDED_WRITE');
  });
});

describe('TRUST_BOUNDARY_FILES', () => {
  it('is a non-empty list of relative paths, none pointing at fs-safe.js itself', () => {
    expect(TRUST_BOUNDARY_FILES.length).toBeGreaterThan(0);
    expect(TRUST_BOUNDARY_FILES.some((f) => f.endsWith('fs-safe.js'))).toBe(false);
  });
});
