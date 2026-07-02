// AC→source map (memory-ingester):
//   - constructor: outputDir defaults from CLAUDE_PROJECT_DIR when not passed explicitly
//   - extractDate: frontmatter `date:` field (YYYY-MM-DD) > filename `daily_recap_YYYY_MM_DD` > null
//   - extractTitle: `# ... // Title` > plain `# Title` > 'unknown'
//   - extractCommits: backtick hashes + bare-paren hashes, deduped, sliced to 7 chars
//   - extractObjectives: numbered sub-headings > bold bullets > plain bullets (length-filtered), capped at 10
//   - extractDecisions: one row per non-boilerplate `## ` section, markdown-stripped rationale,
//     truncated at 200 chars, pipes escaped, capped at 10
//   - convertRecap: assembles the full daily-log entry, with "(no commits detected)"/"None" fallbacks
//   - findRecapFiles: recursive, case-insensitive `daily_recap*.md`, sorted
//   - ingest(): dry-run writes nothing; already-ingested entries are skipped; a bad file doesn't
//     block other files; filesystem errors are caught per-file, not thrown
//   - status(): reports found/ingested/pending counts + date range without ingesting

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const MemoryIngester = require('../memory-ingester');
const { createTmpDir } = require('./_helpers/tmp-dir');

let tmp;
let originalEnv;
let logSpy;

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'memory-ingester-' });
    originalEnv = process.env.CLAUDE_PROJECT_DIR;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalEnv;
    logSpy.mockRestore();
    tmp.cleanup();
});

function makeIngester(outDirRel = 'out') {
    return new MemoryIngester(tmp.mkdir(outDirRel));
}

// ── constructor ──────────────────────────────────────────────────────────────

describe('constructor', () => {
    it('explicitOutputDir_isUsedVerbatim', () => {
        const outDir = path.join(tmp.root, 'custom-out');
        const ingester = new MemoryIngester(outDir);
        expect(ingester.outputDir).toBe(outDir);
    });

    it('noOutputDir_derivesFromClaudeProjectDirEnvVar', () => {
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        const ingester = new MemoryIngester();
        expect(ingester.outputDir).toBe(path.join(tmp.root, 'docs', '.output', '.state', 'memory-daily'));
    });
});

// ── extractDate ──────────────────────────────────────────────────────────────

describe('extractDate', () => {
    it('validFrontmatterDate_isUsed', () => {
        const ingester = makeIngester();
        const content = '---\ndate: 2026-06-15\nvalue_created: "$5,000"\n---\n\n# Report\n';
        expect(ingester.extractDate(content, '/x/daily_recap_ignored.md')).toBe('2026-06-15');
    });

    it('noFrontmatterDate_fallsBackToFilenamePattern', () => {
        const ingester = makeIngester();
        const content = '# Some other report\n\nNo frontmatter here.\n';
        expect(ingester.extractDate(content, '/x/daily_recap_2026_03_09.md')).toBe('2026-03-09');
    });

    it('malformedFrontmatterDate_fallsBackToFilenamePattern', () => {
        const ingester = makeIngester();
        const content = '---\ndate: not-a-date\n---\n\nBody\n';
        expect(ingester.extractDate(content, '/x/daily_recap_2026_03_09.md')).toBe('2026-03-09');
    });

    it('neitherFrontmatterNorFilenameMatches_returnsNull', () => {
        const ingester = makeIngester();
        const content = '# No Objectives Report\n\n## Some Section\nNothing about tomorrow here.\n';
        expect(ingester.extractDate(content, '/x/daily_recap.md')).toBeNull();
    });
});

// ── extractTitle ─────────────────────────────────────────────────────────────

describe('extractTitle', () => {
    it('slashSlashPattern_extractsTrailingTitle', () => {
        const ingester = makeIngester();
        const body = '# 🏁 Daily Sitrep // Ship the memory ingester\n\n## Mission Summary\n';
        expect(ingester.extractTitle(body)).toBe('Ship the memory ingester');
    });

    it('plainHeading_isUsedWhenNoSlashSlash', () => {
        const ingester = makeIngester();
        expect(ingester.extractTitle('# Some other report\n\nBody\n')).toBe('Some other report');
    });

    it('noHeadingAtAll_returnsUnknown', () => {
        const ingester = makeIngester();
        expect(ingester.extractTitle('Just a paragraph, no heading.\n')).toBe('unknown');
    });
});

// ── extractCommits ───────────────────────────────────────────────────────────

describe('extractCommits', () => {
    it('backtickAndBareParenHashes_areDedupedAndSlicedToSevenChars', () => {
        const ingester = makeIngester();
        const body = 'Patched the race condition (a1b2c3d) and cleaned up `e4f5a6bcccc` for good measure.';
        expect(ingester.extractCommits(body)).toEqual([
            'e4f5a6b (ingested from recap)',
            'a1b2c3d (ingested from recap)',
        ]);
    });

    it('noHashesPresent_returnsEmptyArray', () => {
        const ingester = makeIngester();
        expect(ingester.extractCommits('Nothing hashy about this sentence.')).toEqual([]);
    });

    it('duplicateHash_isCountedOnce', () => {
        const ingester = makeIngester();
        const body = 'Fixed in `abc1234` and again referenced as `abc1234` later.';
        expect(ingester.extractCommits(body)).toEqual(['abc1234 (ingested from recap)']);
    });
});

// ── extractObjectives ────────────────────────────────────────────────────────

describe('extractObjectives', () => {
    it('numberedSubHeadings_areExtractedInOrder', () => {
        const ingester = makeIngester();
        const body = [
            '## 🔮 Objectives for Tomorrow',
            '',
            '### 1. Write unit tests',
            'Cover the parsing logic.',
            '',
            '### 2. Wire up CI',
            'Add a workflow.',
            '',
        ].join('\n');
        expect(ingester.extractObjectives(body)).toEqual(['Write unit tests', 'Wire up CI']);
    });

    it('boldBullets_usedWhenNoNumberedHeadings', () => {
        const ingester = makeIngester();
        const body = [
            '## Objectives for Tomorrow',
            "- **Investigate flaky test** — it's timing dependent",
            '- **Clean up logs**',
            '',
        ].join('\n');
        expect(ingester.extractObjectives(body)).toEqual(['Investigate flaky test', 'Clean up logs']);
    });

    it('plainBullets_usedAsLastResort_filteredByLength', () => {
        const ingester = makeIngester();
        const body = [
            '## Objectives for Tomorrow',
            '- Refactor the parser module for clarity',
            '- x',
            '- Ship the release notes to the changelog page today',
            '',
        ].join('\n');
        expect(ingester.extractObjectives(body)).toEqual([
            'Refactor the parser module for clarity',
            'Ship the release notes to the changelog page today',
        ]);
    });

    it('noObjectivesSection_returnsEmptyArray', () => {
        const ingester = makeIngester();
        const body = '## Some Section\nNothing about tomorrow here.\n';
        expect(ingester.extractObjectives(body)).toEqual([]);
    });

    // Regression (memory-ingester.js extractObjectives): the section
    // terminator lookahead once read `(?=\n##\s|\n---|\n$)` — JS `$` without
    // /m only matches absolute end-of-input, so a final section in a file
    // with NO trailing newline failed the whole match and every objective was
    // silently dropped. The lookahead now admits bare end-of-input (`\s*$`).
    it('objectivesSectionAtEndOfFileWithoutTrailingNewline_isExtracted', () => {
        const ingester = makeIngester();
        const body = ['## Objectives for Tomorrow', '- Ship the release notes'].join('\n'); // no trailing newline
        expect(ingester.extractObjectives(body)).toEqual(['Ship the release notes']);
    });

    it('moreThanTenItems_isCappedAtTen', () => {
        const ingester = makeIngester();
        const headings = Array.from({ length: 12 }, (_, i) => `### ${i + 1}. Item ${i + 1}\nDetail.`).join('\n');
        const body = `## Objectives for Tomorrow\n${headings}\n`;
        expect(ingester.extractObjectives(body)).toHaveLength(10);
    });
});

// ── extractDecisions ─────────────────────────────────────────────────────────

describe('extractDecisions', () => {
    it('extractsHeadingAndFirstParagraph_stripsMarkdownAndSkipsBoilerplate', () => {
        const ingester = makeIngester();
        const body = [
            '## Mission Summary',
            'Shipped a chunk of the pipeline.',
            '',
            '## 🔧 Architecture Decision',
            "We chose to use JSONL for telemetry because it's `append-only` and simple to parse.",
            '',
            '## 🛡️ Security Review',
            'Rotated the **API key** after the audit.',
            '',
            '## 🔮 Objectives for Tomorrow',
            '- Do a thing',
            '',
            '## Value Estimation',
            'Some boilerplate math nobody reads.',
        ].join('\n');

        const decisions = ingester.extractDecisions(body);

        expect(decisions).toEqual([
            { decision: 'Architecture Decision', rationale: "We chose to use JSONL for telemetry because it's append-only and simple to parse." },
            { decision: 'Security Review', rationale: 'Rotated the API key after the audit.' },
        ]);
    });

    it('longRationale_isTruncatedAt200CharsWithEllipsis', () => {
        const ingester = makeIngester();
        const longLine = 'x'.repeat(250);
        const body = `## Some Decision\n${longLine}\n`;
        const [d] = ingester.extractDecisions(body);
        expect(d.rationale).toHaveLength(200);
        expect(d.rationale.endsWith('...')).toBe(true);
    });

    it('pipeCharacters_areEscapedForMarkdownTable', () => {
        const ingester = makeIngester();
        const body = '## Decision | With Pipe\nRationale with a | pipe in it too.\n';
        const [d] = ingester.extractDecisions(body);
        expect(d.decision).toBe('Decision \\| With Pipe');
        expect(d.rationale).toBe('Rationale with a \\| pipe in it too.');
    });

    it('moreThanTenSections_isCappedAtTen', () => {
        const ingester = makeIngester();
        const body = Array.from({ length: 12 }, (_, i) => `## Decision ${i}\nRationale ${i}.`).join('\n\n');
        expect(ingester.extractDecisions(body)).toHaveLength(10);
    });

    it('noSectionsAtAll_returnsEmptyArray', () => {
        const ingester = makeIngester();
        expect(ingester.extractDecisions('Just a paragraph, no headings.')).toEqual([]);
    });
});

// ── convertRecap ─────────────────────────────────────────────────────────────

describe('convertRecap', () => {
    it('assemblesFullEntry_withCommitsObjectivesAndDecisions', () => {
        const ingester = makeIngester();
        const content = [
            '---',
            'date: 2026-06-15',
            '---',
            '',
            '# 🏁 Daily Sitrep // Ship the memory ingester',
            '',
            '## 🔧 Architecture Decision',
            'We chose JSONL because it is simple (abc1234).',
            '',
            '## 🔮 Objectives for Tomorrow',
            '### 1. Write unit tests',
            'Cover the parsing logic.',
            '',
        ].join('\n');

        const entry = ingester.convertRecap(content, '2026-06-15');

        expect(entry).toContain('## 00:00 — ingested');
        expect(entry).toContain('**Branch:** ingested');
        expect(entry).toContain('**Source:** Ship the memory ingester');
        expect(entry).toContain('abc1234 (ingested from recap)');
        expect(entry).toContain('  - [>] Write unit tests');
        expect(entry).toContain('| Architecture Decision | We chose JSONL because it is simple (abc1234). | ingested |');
    });

    it('noCommitsObjectivesOrDecisions_rendersFallbackText', () => {
        const ingester = makeIngester();
        const content = '# Plain Report\n\n## Mission Summary\nNothing decision-worthy here.\n';
        const entry = ingester.convertRecap(content, '2026-01-01');

        expect(entry).toContain('(no commits detected)');
        expect(entry).toContain('  None'); // both in-progress and decisions fall back to "None"
    });
});

// ── findRecapFiles ───────────────────────────────────────────────────────────

describe('findRecapFiles', () => {
    it('recursivelyFindsCaseInsensitiveDailyRecapFiles_sorted_ignoringOthers', () => {
        tmp.write('recaps/2026-06/daily_recap_2026_06_15.md', '# a');
        tmp.write('recaps/2026-06/DAILY_RECAP_2026_06_01.MD', '# b');
        tmp.write('recaps/2026-06/notes.md', 'not a recap');
        tmp.write('recaps/2026-06/readme.txt', 'not markdown');
        tmp.write('recaps/nested/deep/daily_recap_2026_07_01.md', '# c');

        const ingester = makeIngester();
        const found = ingester.findRecapFiles(path.join(tmp.root, 'recaps'));

        expect(found).toHaveLength(3);
        expect(found).toEqual([...found].sort());
        expect(found.every(f => /daily_recap/i.test(path.basename(f)))).toBe(true);
    });

    it('missingSourceDir_returnsEmptyArrayWithoutThrowing', () => {
        const ingester = makeIngester();
        expect(ingester.findRecapFiles(path.join(tmp.root, 'does-not-exist'))).toEqual([]);
    });
});

// ── ingest() ─────────────────────────────────────────────────────────────────

describe('ingest', () => {
    function recapContent(date, title = 'Report') {
        return `---\ndate: ${date}\n---\n\n# ${title}\n\n## Some Section\nDetail.\n`;
    }

    it('noRecapFiles_returnsZeroedStats', () => {
        const sourceDir = tmp.mkdir('empty-source');
        const ingester = makeIngester();
        const stats = ingester.ingest(sourceDir);
        expect(stats).toEqual({ processed: 0, created: 0, skipped: 0, errors: [] });
    });

    it('dryRun_processesButWritesNothingToDisk', () => {
        tmp.write('source/daily_recap_2026_06_15.md', recapContent('2026-06-15'));
        const outDir = tmp.mkdir('out-dry');
        const ingester = new MemoryIngester(outDir);

        const stats = ingester.ingest(path.join(tmp.root, 'source'), { dryRun: true });

        expect(stats.processed).toBe(1);
        expect(stats.created).toBe(0);
        expect(fs.existsSync(path.join(outDir, '2026-06-15.md'))).toBe(false);
    });

    it('realRun_writesTargetFileContainingIngestedMarker', () => {
        tmp.write('source/daily_recap_2026_06_15.md', recapContent('2026-06-15'));
        const outDir = tmp.mkdir('out-real');
        const ingester = new MemoryIngester(outDir);

        const stats = ingester.ingest(path.join(tmp.root, 'source'));

        expect(stats).toEqual({ processed: 1, created: 1, skipped: 0, errors: [] });
        const written = fs.readFileSync(path.join(outDir, '2026-06-15.md'), 'utf8');
        expect(written).toContain('— ingested');
    });

    it('alreadyIngestedDate_isSkippedAndLeftUnchanged', () => {
        tmp.write('source/daily_recap_2026_06_15.md', recapContent('2026-06-15'));
        const outDir = tmp.mkdir('out-skip');
        const ingester = new MemoryIngester(outDir);
        const sourceDir = path.join(tmp.root, 'source');

        ingester.ingest(sourceDir); // first pass creates it
        const targetPath = path.join(outDir, '2026-06-15.md');
        const contentAfterFirstRun = fs.readFileSync(targetPath, 'utf8');

        const stats = ingester.ingest(sourceDir); // second pass should skip, not duplicate

        expect(stats).toEqual({ processed: 0, created: 0, skipped: 1, errors: [] });
        expect(fs.readFileSync(targetPath, 'utf8')).toBe(contentAfterFirstRun);
    });

    it('malformedRecapWithNoExtractableDate_isReportedAsErrorButDoesNotBlockOtherFiles', () => {
        tmp.write('source/daily_recap.md', '# No date anywhere\n\nJust prose.\n'); // no frontmatter, no filename date
        tmp.write('source/daily_recap_2026_06_15.md', recapContent('2026-06-15'));
        const outDir = tmp.mkdir('out-partial');
        const ingester = new MemoryIngester(outDir);

        const stats = ingester.ingest(path.join(tmp.root, 'source'));

        expect(stats.errors).toHaveLength(1);
        expect(stats.errors[0]).toContain('daily_recap.md');
        expect(stats.processed).toBe(1); // the good file still gets processed
        expect(stats.created).toBe(1);
        expect(fs.existsSync(path.join(outDir, '2026-06-15.md'))).toBe(true);
    });

    it('filesystemErrorDuringWrite_isCaughtPerFileAndDoesNotThrow', () => {
        tmp.write('source/daily_recap_2026_06_15.md', recapContent('2026-06-15'));
        // outputDir points at a path that already exists as a plain FILE, so
        // fs.mkdirSync(outputDir, {recursive:true}) inside ingest() throws
        // ENOTDIR — this exercises the per-file catch block, not a crash.
        const conflictFile = tmp.write('conflict-output', 'not a directory');
        const ingester = new MemoryIngester(conflictFile);

        let stats;
        expect(() => { stats = ingester.ingest(path.join(tmp.root, 'source')); }).not.toThrow();

        expect(stats.errors).toHaveLength(1);
        expect(stats.errors[0]).toContain('Error processing');
        expect(stats.created).toBe(0);
    });
});

// ── status() ─────────────────────────────────────────────────────────────────

describe('status', () => {
    function captureLog() {
        const lines = [];
        logSpy.mockImplementation((...args) => lines.push(args.join(' ')));
        return lines;
    }

    it('emptySourceDir_reportsZeroFoundAndStopsEarly', () => {
        const lines = captureLog();
        const sourceDir = tmp.mkdir('empty-status-source');
        const ingester = makeIngester();

        ingester.status(sourceDir);

        const out = lines.join('\n');
        expect(out).toContain('Recap files found: 0');
        expect(out).not.toContain('Already ingested');
    });

    it('mixOfIngestedAndPending_reportsCorrectCountsAndDateRange', () => {
        tmp.write('source/daily_recap_2026_06_01.md', '---\ndate: 2026-06-01\n---\n\n# Report One\n');
        tmp.write('source/daily_recap_2026_06_02.md', '---\ndate: 2026-06-02\n---\n\n# Report Two\n');
        const outDir = tmp.mkdir('out-status');
        const ingester = new MemoryIngester(outDir);
        const sourceDir = path.join(tmp.root, 'source');

        ingester.ingest(sourceDir); // ingest both first

        // Add a third, not-yet-ingested recap file.
        tmp.write('source/daily_recap_2026_06_03.md', '---\ndate: 2026-06-03\n---\n\n# Report Three\n');

        const lines = captureLog();
        ingester.status(sourceDir);
        const out = lines.join('\n');

        expect(out).toContain('Recap files found: 3');
        expect(out).toContain('Already ingested: 2');
        expect(out).toContain('Pending: 1');
        expect(out).toContain('Date range: 2026-06-01 to 2026-06-03');
    });
});
