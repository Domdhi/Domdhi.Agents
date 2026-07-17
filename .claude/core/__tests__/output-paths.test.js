import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const op = require('../_lib/output-paths');
const rs = require('../_lib/run-stamp');

let tmp;
beforeEach(() => {
  rs._resetCache();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'output-paths-test-'));
});
afterEach(() => {
  rs._resetCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const MONTH = /\d{4}-\d{2}/;
const STAMP = /\d{6}-\d{4}/;

describe('output-paths — discrete shape', () => {
  it('composes {kind}/{YYYY-MM}/{stamp}-{slug}.{ext}', () => {
    const p = op.outputPath('findings/reviews', { slug: 'code review', cwd: tmp });
    expect(p).toMatch(
      new RegExp(`^docs/\\.output/findings/reviews/${MONTH.source}/${STAMP.source}-code-review\\.md$`)
    );
  });

  it('honors a custom ext and strips a leading dot', () => {
    const p = op.outputPath('findings/reviews', { slug: 'x', ext: '.json', cwd: tmp });
    expect(p.endsWith('-x.json')).toBe(true);
  });

  it('mkdirs the month folder', () => {
    const p = op.outputPath('plans', { slug: 'do-thing', cwd: tmp });
    const dir = path.dirname(path.join(tmp, p));
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('slugifies free text (lowercase, dash-collapsed)', () => {
    const p = op.outputPath('plans', { slug: 'My  Cool   Plan!!', cwd: tmp });
    expect(p.endsWith('-my-cool-plan.md')).toBe(true);
  });
});

describe('output-paths — daylog shape', () => {
  it('composes {kind}/{YYYY-MM}/{YYYY-MM-DD}.md', () => {
    const p = op.dayLogPath('evolution/intake', { cwd: tmp });
    expect(p).toMatch(
      /^docs\/\.output\/evolution\/intake\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}\.md$/
    );
  });
});

describe('output-paths — run-unit shape', () => {
  it('composes {kind}/{YYYY-MM}/{stamp}-{slug}/ and mkdirs it', () => {
    const d = op.runUnitDir('evolution/canary', { slug: 'nightly', cwd: tmp });
    expect(d).toMatch(
      new RegExp(`^docs/\\.output/evolution/canary/${MONTH.source}/${STAMP.source}-nightly$`)
    );
    expect(fs.existsSync(path.join(tmp, d))).toBe(true);
  });
});

describe('output-paths — month bucketing & caching', () => {
  it('reuses one stamp across calls in a run (stamp cached)', () => {
    const a = op.outputPath('plans', { slug: 'a', cwd: tmp });
    const b = op.outputPath('plans', { slug: 'b', cwd: tmp });
    const sa = a.match(STAMP)[0];
    const sb = b.match(STAMP)[0];
    expect(sa).toBe(sb);
  });

  it('the discrete filename stamp and the month folder agree', () => {
    const p = op.outputPath('plans', { slug: 'x', cwd: tmp });
    const month = p.match(new RegExp(`plans/(${MONTH.source})/`))[1]; // YYYY-MM
    const stampYYMMDD = p.match(STAMP)[0].slice(0, 6);                 // YYMMDD
    expect(month.slice(2).replace('-', '')).toBe(stampYYMMDD.slice(0, 4)); // YY+MM
  });
});

describe('output-paths — state zone (flat, no bucket)', () => {
  it('writes under .state/ with no month folder', () => {
    const dir = op.compartmentDir('state/telemetry');
    expect(dir).toBe('docs/.output/.state/telemetry');
  });
});

describe('output-paths — open taxonomy & guards', () => {
  it('an unknown kind still resolves (durable/discrete/month default)', () => {
    const p = op.outputPath('bugs', { slug: 'crash', cwd: tmp });
    expect(p).toMatch(
      new RegExp(`^docs/\\.output/bugs/${MONTH.source}/${STAMP.source}-crash\\.md$`)
    );
  });

  it('a grouping compartment throws (must use a sub-compartment)', () => {
    expect(() => op.outputPath('findings', { slug: 'x', cwd: tmp })).toThrow(/grouping compartment/);
    expect(() => op.outputPath('evolution', { slug: 'x', cwd: tmp })).toThrow(/grouping compartment/);
  });
});

describe('output-paths — open-taxonomy path-traversal guard (F16)', () => {
  // An unregistered `kind` used to be joined verbatim into
  // path.join(OUTPUT_ROOT, e.dir) + mkdirSync(recursive) — '../', an embedded
  // '../../', or an absolute leader escaped docs/.output entirely. Verify each
  // shape is neutralized and the resulting path/dir stays confined.

  function assertConfined(p) {
    expect(p.startsWith('docs/.output/')).toBe(true);
    expect(p).not.toMatch(/(^|\/)\.\.(\/|$)/); // no literal '..' path segment
    const abs = path.resolve(tmp, p);
    expect(abs.startsWith(path.join(tmp, 'docs', '.output') + path.sep)).toBe(true);
  }

  it('strips a parent-dir-traversal kind (../../etc/x)', () => {
    const p = op.outputPath('../../etc/x', { slug: 'evil', cwd: tmp });
    assertConfined(p);
  });

  it('strips an embedded traversal kind (a/../../b)', () => {
    const p = op.outputPath('a/../../b', { slug: 'evil', cwd: tmp });
    assertConfined(p);
  });

  it('strips an absolute-path kind (/etc/passwd)', () => {
    const p = op.outputPath('/etc/passwd', { slug: 'evil', cwd: tmp });
    assertConfined(p);
  });

  it('a normal unregistered kind still resolves unchanged (no false rejection)', () => {
    const p = op.outputPath('bugs', { slug: 'crash', cwd: tmp });
    expect(p).toMatch(
      new RegExp(`^docs/\\.output/bugs/${MONTH.source}/${STAMP.source}-crash\\.md$`)
    );
  });

  it('a normal nested unregistered kind still resolves unchanged (no false rejection)', () => {
    const p = op.outputPath('bugs/tracker', { slug: 'crash', cwd: tmp });
    expect(p).toMatch(
      new RegExp(`^docs/\\.output/bugs/tracker/${MONTH.source}/${STAMP.source}-crash\\.md$`)
    );
  });
});

describe('output-paths — sanitizeKindPath post-slugify re-validation (F16 follow-up)', () => {
  // slugify() strips chars outside its charset, which can RESURRECT a
  // traversal segment the pre-slugify filter already passed — e.g. "..%"
  // isn't literally ".." until AFTER slugify drops the "%". Verify the
  // post-slugify guard catches every such shape and nothing escapes the root.

  function assertConfined(p) {
    expect(p.startsWith('docs/.output/')).toBe(true);
    expect(p).not.toMatch(/(^|\/)\.\.(\/|$)/); // no literal '..' path segment
    const abs = path.resolve(tmp, p);
    expect(abs.startsWith(path.join(tmp, 'docs', '.output') + path.sep)).toBe(true);
  }

  it('a single "..%" segment reduces to ".." post-slugify and is dropped entirely (falls back to untitled)', () => {
    const p = op.outputPath('..%', { slug: 'evil', cwd: tmp });
    assertConfined(p);
    expect(p).toMatch(
      new RegExp(`^docs/\\.output/untitled/${MONTH.source}/${STAMP.source}-evil\\.md$`)
    );
  });

  it('a single "..!" segment also reduces to ".." post-slugify and is dropped (falls back to untitled)', () => {
    const p = op.outputPath('..!', { slug: 'evil', cwd: tmp });
    assertConfined(p);
    expect(p).toMatch(
      new RegExp(`^docs/\\.output/untitled/${MONTH.source}/${STAMP.source}-evil\\.md$`)
    );
  });

  it('".%2e" slugifies to a benign, non-traversal segment and is kept as-is', () => {
    const p = op.outputPath('.%2e', { slug: 'evil', cwd: tmp });
    assertConfined(p);
    expect(p).toMatch(
      new RegExp(`^docs/\\.output/\\.-2e/${MONTH.source}/${STAMP.source}-evil\\.md$`)
    );
  });

  it('an embedded "..%" segment ("a/..%/b") is dropped, leaving the benign segments joined ("a/b")', () => {
    const p = op.outputPath('a/..%/b', { slug: 'evil', cwd: tmp });
    assertConfined(p);
    expect(p).toMatch(
      new RegExp(`^docs/\\.output/a/b/${MONTH.source}/${STAMP.source}-evil\\.md$`)
    );
  });

  it('repeated "..%" segments ("..%/..%/..%/..%/pwned") all drop, leaving only the trailing benign segment', () => {
    const p = op.outputPath('..%/..%/..%/..%/pwned', { slug: 'evil', cwd: tmp });
    assertConfined(p);
    expect(p).toMatch(
      new RegExp(`^docs/\\.output/pwned/${MONTH.source}/${STAMP.source}-evil\\.md$`)
    );
  });

  it('the original F16 literal-".." fixtures still resolve unchanged (no regression)', () => {
    const p1 = op.outputPath('../x', { slug: 'evil', cwd: tmp });
    assertConfined(p1);
    expect(p1).toMatch(new RegExp(`^docs/\\.output/x/${MONTH.source}/${STAMP.source}-evil\\.md$`));

    const p2 = op.outputPath('..\\..\\y', { slug: 'evil', cwd: tmp });
    assertConfined(p2);
    expect(p2).toMatch(new RegExp(`^docs/\\.output/y/${MONTH.source}/${STAMP.source}-evil\\.md$`));

    const p3 = op.outputPath('/etc/passwd', { slug: 'evil', cwd: tmp });
    assertConfined(p3);
    expect(p3).toMatch(new RegExp(`^docs/\\.output/etc/passwd/${MONTH.source}/${STAMP.source}-evil\\.md$`));
  });

  it('benign unregistered kinds are unaffected by the post-slugify filter', () => {
    const p1 = op.outputPath('reviews', { slug: 'x', cwd: tmp });
    expect(p1).toMatch(new RegExp(`^docs/\\.output/reviews/${MONTH.source}/${STAMP.source}-x\\.md$`));

    const p2 = op.outputPath('a/b/c', { slug: 'x', cwd: tmp });
    expect(p2).toMatch(new RegExp(`^docs/\\.output/a/b/c/${MONTH.source}/${STAMP.source}-x\\.md$`));
  });
});

describe('output-paths — latest()', () => {
  function seed(rel, names) {
    const dir = path.join(tmp, rel);
    fs.mkdirSync(dir, { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(dir, n), 'x');
  }

  it('returns null when the compartment is absent', () => {
    expect(op.latest('findings/reviews', null, { cwd: tmp })).toBeNull();
  });

  it('picks the newest across month folders', () => {
    seed('docs/.output/findings/reviews/2026-05', ['260501-0900-old.md']);
    seed('docs/.output/findings/reviews/2026-06', [
      '260601-0900-mid.md',
      '260621-1306-new.md', // newest overall
    ]);
    expect(op.latest('findings/reviews', null, { cwd: tmp })).toBe(
      'docs/.output/findings/reviews/2026-06/260621-1306-new.md'
    );
  });

  it('newest month wins even when an older month has a later HHMM', () => {
    seed('docs/.output/findings/reviews/2026-05', ['260531-2359-late-in-may.md']);
    seed('docs/.output/findings/reviews/2026-06', ['260601-0001-early-in-june.md']);
    expect(op.latest('findings/reviews', null, { cwd: tmp })).toBe(
      'docs/.output/findings/reviews/2026-06/260601-0001-early-in-june.md'
    );
  });

  it('filters by slug substring', () => {
    seed('docs/.output/plans/2026-06', [
      '260601-0900-do-alpha.md',
      '260602-0900-do-beta.md',
    ]);
    expect(op.latest('plans', 'alpha', { cwd: tmp })).toBe(
      'docs/.output/plans/2026-06/260601-0900-do-alpha.md'
    );
  });

  it('ignores non-stamped files', () => {
    seed('docs/.output/plans/2026-06', ['README.md', '260601-0900-real.md']);
    expect(op.latest('plans', null, { cwd: tmp })).toBe(
      'docs/.output/plans/2026-06/260601-0900-real.md'
    );
  });
});
