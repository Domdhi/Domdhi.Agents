// AC→source map (TDD-4.2 / memory-extractor):
//   - isProcessed(heading): 1-arg, checks heading.includes('[extracted]') — no processed-dates JSON file
//   - markProcessed(filePath, originalHeading): reads file, replaces heading with "${heading} [extracted]", writes back
//   - invokeModel() returns [] on failure (not null) — graceful-skip returns []
//   - Mock strategy: source uses `const { execSync } = require('child_process')` (destructured).
//     vi.spyOn + vi.mock (ESM) cannot intercept a destructured CJS ref after load.
//     Solution: replace child_process.execSync with a controllable wrapper BEFORE requiring
//     memory-extractor.js, so the destructure captures our wrapper. Each test sets a delegate fn.
//   - Output path: extractedDir/{date}/{timestamp}.json with payload {extractedAt, sourceDate, count, learnings}
//   - module.exports = MemoryExtractor (default class export)
//   - parseDailyFile(content, date): 2-arg, splits on ^## \d{2}:\d{2} — regex, returns [{date, time, heading, rawText}]

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// CJS-level mock setup for execSync
// Must happen BEFORE requiring memory-extractor so the module's destructured
// `const { execSync } = require('child_process')` captures our wrapper.
// ---------------------------------------------------------------------------
const childProcess = require('child_process');
const _originalExecSync = childProcess.execSync;
let _execSyncImpl = _originalExecSync; // delegate — tests override this

// Install wrapper — source's destructure at module load captures this function object.
// Our wrapper calls _execSyncImpl, which each test controls.
childProcess.execSync = function mockedExecSync(cmd, opts) {
  return _execSyncImpl(cmd, opts);
};

// NOW load memory-extractor — its `const { execSync }` captures `mockedExecSync` above.
const MemoryExtractor = require('../memory-extractor');

// Restore child_process.execSync to the wrapper (it already is, but make intent clear)
// Individual tests set _execSyncImpl to control behavior; afterEach restores to a safe default.

const { createTmpDir } = require('./_helpers/tmp-dir');
const { createDailyLog } = require('./_helpers/daily-log-fixture');
const { makeMockExecSync } = require('./_helpers/claude-mock');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setExecSyncImpl(fn) {
  _execSyncImpl = fn;
}

function resetExecSyncImpl() {
  // Default: restore the original so unexpected calls go to the real execSync
  // (safe for other test files that run after this one in the same process)
  _execSyncImpl = _originalExecSync;
}

let tmp;
let originalEnv;

beforeEach(() => {
  resetExecSyncImpl();
  tmp = createTmpDir();
  originalEnv = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = tmp.root;
});

afterEach(() => {
  resetExecSyncImpl();
  if (originalEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = originalEnv;
  tmp.cleanup();
});

afterAll(() => {
  // Restore the original execSync on child_process so other test files
  // that run after this one in the same process are not affected.
  childProcess.execSync = _originalExecSync;
});

// ---------------------------------------------------------------------------
// parseDailyFile
// ---------------------------------------------------------------------------

describe('parseDailyFile', () => {
  it('parseDailyFile_empty_returnsEmptyArray', () => {
    const extractor = new MemoryExtractor();
    const result = extractor.parseDailyFile('', '2026-04-19');
    expect(result).toEqual([]);
  });

  it('parseDailyFile_singleEntry_returnsOneItemWithCorrectShape', () => {
    const extractor = new MemoryExtractor();
    const content = '## 10:00 — Stop\n\nbody text here';

    const result = extractor.parseDailyFile(content, '2026-04-19');

    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-04-19');
    expect(result[0].time).toBe('10:00');
    expect(result[0].heading).toBe('## 10:00 — Stop');
    expect(result[0].rawText).toContain('body text here');
  });

  it('parseDailyFile_multipleEntries_returnsAllItems', () => {
    const extractor = new MemoryExtractor();
    const content = [
      '## 09:00 — Pre-Compaction',
      '',
      'body one',
      '## 10:00 — Stop',
      '',
      'body two',
      '## 11:00 — PostBash',
      '',
      'body three',
    ].join('\n');

    const result = extractor.parseDailyFile(content, '2026-04-19');

    expect(result).toHaveLength(3);
    expect(result[0].time).toBe('09:00');
    expect(result[1].time).toBe('10:00');
    expect(result[2].time).toBe('11:00');
  });

  it('parseDailyFile_entryWithoutHeading_isSkipped', () => {
    const extractor = new MemoryExtractor();
    const content = 'just some text without a proper heading\nmore text here';

    const result = extractor.parseDailyFile(content, '2026-04-19');

    expect(result).toEqual([]);
  });

  it('parseDailyFile_parityWithCompiler_sameShapeReturned', () => {
    // Parity check: shape matches what memory-compiler.parseDailyFile returns
    // Both return [{date, time, heading, rawText}]
    const extractor = new MemoryExtractor();
    const content = '## 14:30 — Pre-Compaction\n\n**Branch:** main\n\nsome context';

    const result = extractor.parseDailyFile(content, '2026-04-19');

    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry).toHaveProperty('date');
    expect(entry).toHaveProperty('time');
    expect(entry).toHaveProperty('heading');
    expect(entry).toHaveProperty('rawText');
    expect(entry.time).toBe('14:30');
    expect(entry.heading).toBe('## 14:30 — Pre-Compaction');
  });

  it('parseDailyFile_entryRawTextContainsFullChunk', () => {
    const extractor = new MemoryExtractor();
    const content = '## 09:00 — Stop\n\n### Key Decisions\n| foo | bar | baz |';

    const result = extractor.parseDailyFile(content, '2026-04-19');

    expect(result).toHaveLength(1);
    expect(result[0].rawText).toContain('Key Decisions');
    expect(result[0].rawText).toContain('foo');
  });

  it('parseDailyFile_usingFixture_returnsEntriesMatchingFixtureEntries', () => {
    const extractor = new MemoryExtractor();
    createDailyLog(tmp, '2026-04-19', [
      { time: '09:00', trigger: 'Pre-Compaction', branch: 'main' },
      { time: '12:00', trigger: 'Stop', inProgress: ['implementing feature X'] },
    ]);

    const dailyPath = path.join(
      tmp.root,
      'docs', '.output', '.state', 'memory-daily', '2026-04-19.md'
    );
    const content = fs.readFileSync(dailyPath, 'utf-8');
    const result = extractor.parseDailyFile(content, '2026-04-19');

    expect(result).toHaveLength(2);
    expect(result[0].time).toBe('09:00');
    expect(result[1].time).toBe('12:00');
    expect(result[0].date).toBe('2026-04-19');
  });
});

// ---------------------------------------------------------------------------
// isProcessed / markProcessed — round-trip
// ---------------------------------------------------------------------------

describe('isProcessed', () => {
  it('isProcessed_plainHeading_returnsFalse', () => {
    const extractor = new MemoryExtractor();
    expect(extractor.isProcessed('## 10:00 — Stop')).toBe(false);
  });

  it('isProcessed_headingWithExtractedMarker_returnsTrue', () => {
    const extractor = new MemoryExtractor();
    expect(extractor.isProcessed('## 10:00 — Stop [extracted]')).toBe(true);
  });

  it('isProcessed_emptyString_returnsFalse', () => {
    const extractor = new MemoryExtractor();
    expect(extractor.isProcessed('')).toBe(false);
  });
});

describe('markProcessed', () => {
  it('markProcessed_writesExtractedMarkerToFile', async () => {
    const extractor = new MemoryExtractor();
    const originalHeading = '## 09:00 — Pre-Compaction';
    const content = `${originalHeading}\n\nbody text`;
    const filePath = tmp.write('docs/.output/.state/memory-daily/2026-04-19.md', content);

    await extractor.markProcessed(filePath, originalHeading);

    const updated = fs.readFileSync(filePath, 'utf-8');
    expect(updated).toContain(`${originalHeading} [extracted]`);
  });

  it('markProcessed_isProcessed_roundTrip_returnsTrue', async () => {
    // Round-trip: markProcessed on a file, then read back heading, check isProcessed
    const extractor = new MemoryExtractor();
    const originalHeading = '## 10:30 — Stop';
    const content = `${originalHeading}\n\nsome content`;
    const filePath = tmp.write('docs/.output/.state/memory-daily/2026-04-19.md', content);

    await extractor.markProcessed(filePath, originalHeading);

    const updatedContent = fs.readFileSync(filePath, 'utf-8');
    const updatedHeadingMatch = updatedContent.match(/^(## \d{2}:\d{2} — [^\n]*)/m);
    expect(updatedHeadingMatch).not.toBeNull();
    const updatedHeading = updatedHeadingMatch[1];
    expect(extractor.isProcessed(updatedHeading)).toBe(true);
  });

  it('markProcessed_bodyTextPreserved_afterMark', async () => {
    const extractor = new MemoryExtractor();
    const originalHeading = '## 11:00 — PostBash';
    const content = `${originalHeading}\n\n**Branch:** feature-x\n\nSome important notes.`;
    const filePath = tmp.write('docs/.output/.state/memory-daily/2026-04-19.md', content);

    await extractor.markProcessed(filePath, originalHeading);

    const updated = fs.readFileSync(filePath, 'utf-8');
    // The fixture writes markdown bold: **Branch:** feature-x
    expect(updated).toContain('**Branch:** feature-x');
    expect(updated).toContain('Some important notes.');
  });

  it('markProcessed_duplicateSameMinuteHeadings_marksEachExactlyOnce', async () => {
    // M3: two commits in the same clock minute produce byte-identical headings
    // ("## 10:15 — post-commit"). The old literal replace kept re-marking the FIRST
    // entry (its already-marked line still contains the bare heading as a prefix),
    // so the second entry was never marked → reprocessed forever. Marking the two in
    // sequence, as extract() does, must mark each exactly once and leave none unmarked.
    const extractor = new MemoryExtractor();
    const heading = '## 10:15 — post-commit';
    const content = [
      heading, '', 'body A — first commit this minute', '',
      heading, '', 'body B — second commit this minute', '',
    ].join('\n');
    const filePath = tmp.write('docs/.output/.state/memory-daily/2026-04-19.md', content);

    // Same heading string for both entries — exactly what parseDailyFile yields.
    await extractor.markProcessed(filePath, heading);
    await extractor.markProcessed(filePath, heading);

    const updated = fs.readFileSync(filePath, 'utf-8');
    const markedLines = updated.split('\n').filter(l => l === `${heading} [extracted]`);
    const unmarkedLines = updated.split('\n').filter(l => l === heading);
    expect(markedLines).toHaveLength(2);   // both entries marked
    expect(unmarkedLines).toHaveLength(0); // none left to reprocess
    // No heading accumulated a second tag (the old double-mark bug).
    expect(updated).not.toContain('[extracted] [extracted]');
    // Bodies untouched.
    expect(updated).toContain('body A — first commit this minute');
    expect(updated).toContain('body B — second commit this minute');

    // And parseDailyFile now sees both as processed (extract would skip them).
    const entries = extractor.parseDailyFile(updated, '2026-04-19');
    expect(entries).toHaveLength(2);
    expect(entries.every(e => extractor.isProcessed(e.heading))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// invokeModel — success path (canned raw JSON via wrapper delegate)
// ---------------------------------------------------------------------------

describe('invokeModel', () => {
  // R-C (2026-05-11): schema migrated from {category, title, content, confidence}
  // to {category, suggested_id, content: {description, evidence?, confidence}}.
  // Categories changed from singular (pattern) to canonical plural (patterns).
  // See docs/.output/plans/2026-05-11-do-r-c-single-pass-extraction.md.

  function makeLearning(overrides = {}) {
    return {
      category: 'patterns',
      suggested_id: 'sample-learning',
      content: {
        description: 'A short rationale.',
        evidence: 'sample anchor',
        confidence: 0.7,
      },
      ...overrides,
    };
  }

  it('invokeModel_cannedJsonArray_returnsFilteredLearnings', () => {
    const extractor = new MemoryExtractor();
    const cannedLearnings = [
      makeLearning({ category: 'patterns', suggested_id: 'test-pattern' }),
    ];
    // Raw JSON string — no envelope wrapping (extractor uses --bare flag)
    setExecSyncImpl(makeMockExecSync(JSON.stringify(cannedLearnings)));

    const result = extractor.invokeModel('some entry text');

    expect(result).toEqual(cannedLearnings);
  });

  it('invokeModel_multipleLearnings_returnsAll', () => {
    const extractor = new MemoryExtractor();
    const cannedLearnings = [
      makeLearning({ category: 'patterns', suggested_id: 'first-pattern' }),
      makeLearning({ category: 'decisions', suggested_id: 'key-decision', content: { description: 'We chose approach B.', evidence: 'PR-42', confidence: 0.85 } }),
      makeLearning({ category: 'constraints', suggested_id: 'hard-limit', content: { description: 'Cannot exceed 10.', evidence: 'limit assertion', confidence: 0.8 } }),
    ];
    setExecSyncImpl(makeMockExecSync(JSON.stringify(cannedLearnings)));

    const result = extractor.invokeModel('multi-learning entry');

    expect(result).toHaveLength(3);
    expect(result[0].suggested_id).toBe('first-pattern');
    expect(result[1].suggested_id).toBe('key-decision');
    expect(result[2].suggested_id).toBe('hard-limit');
  });

  it('invokeModel_filtersItemsMissingRequiredFields', () => {
    const extractor = new MemoryExtractor();
    const rawLearnings = [
      makeLearning({ category: 'patterns', suggested_id: 'valid-entry' }),
      // Missing content.description
      { category: 'patterns', suggested_id: 'missing-desc', content: { confidence: 0.7 } },
      // Missing category
      { suggested_id: 'no-category', content: { description: 'text', confidence: 0.5 } },
    ];
    setExecSyncImpl(makeMockExecSync(JSON.stringify(rawLearnings)));

    const result = extractor.invokeModel('entry text');

    expect(result).toHaveLength(1);
    expect(result[0].suggested_id).toBe('valid-entry');
  });

  it('invokeModel_wrappedInLearningsKey_returnsLearningsArray', () => {
    const extractor = new MemoryExtractor();
    const learnings = [
      makeLearning({ category: 'workflows', suggested_id: 'wrapped-workflow', content: { description: 'Use this flow.', evidence: 'session-handoff Step 6a', confidence: 0.75 } }),
    ];
    const wrapped = { learnings };
    setExecSyncImpl(makeMockExecSync(JSON.stringify(wrapped)));

    const result = extractor.invokeModel('entry text');

    expect(result).toEqual(learnings);
  });

  it('invokeModel_wrappedInResultsKey_returnsResultsArray', () => {
    const extractor = new MemoryExtractor();
    const results = [
      makeLearning({ category: 'patterns', suggested_id: 'results-key-pattern', content: { description: 'Via results key.', confidence: 0.6 } }),
    ];
    const wrapped = { results };
    setExecSyncImpl(makeMockExecSync(JSON.stringify(wrapped)));

    const result = extractor.invokeModel('entry text');

    expect(result).toEqual(results);
  });

  it('invokeModel_jsonWithMarkdownFences_parsedSuccessfully', () => {
    const extractor = new MemoryExtractor();
    const learnings = [
      makeLearning({ category: 'patterns', suggested_id: 'fenced-result', content: { description: 'Came through fences.', evidence: 'unit test', confidence: 0.7 } }),
    ];
    // Simulate model returning JSON inside markdown fences (despite --bare)
    const fenced = '```json\n' + JSON.stringify(learnings) + '\n```';
    setExecSyncImpl(makeMockExecSync(fenced));

    const result = extractor.invokeModel('entry text');

    expect(result).toEqual(learnings);
  });

  // R-C new tests: validate the strict schema rules

  it('invokeModel_singularCategoryForm_filtered', () => {
    // Old singular form (pattern, not patterns) is no longer valid — adopters
    // re-running after R-C will see legacy entries filtered.
    const extractor = new MemoryExtractor();
    const learnings = [
      { category: 'pattern', suggested_id: 'old-form', content: { description: 'old shape.', confidence: 0.7 } },
      makeLearning({ category: 'patterns', suggested_id: 'new-form' }),
    ];
    setExecSyncImpl(makeMockExecSync(JSON.stringify(learnings)));

    const result = extractor.invokeModel('entry text');

    expect(result).toHaveLength(1);
    expect(result[0].suggested_id).toBe('new-form');
  });

  it('invokeModel_nonKebabSuggestedId_filtered', () => {
    const extractor = new MemoryExtractor();
    const learnings = [
      { category: 'patterns', suggested_id: 'BadID With Spaces', content: { description: 'bad slug.', confidence: 0.7 } },
      { category: 'patterns', suggested_id: 'has_underscores_too', content: { description: 'also bad.', confidence: 0.7 } },
      makeLearning({ category: 'patterns', suggested_id: 'good-kebab-slug' }),
    ];
    setExecSyncImpl(makeMockExecSync(JSON.stringify(learnings)));

    const result = extractor.invokeModel('entry text');

    expect(result).toHaveLength(1);
    expect(result[0].suggested_id).toBe('good-kebab-slug');
  });

  it('invokeModel_confidenceOutOfRange_filtered', () => {
    const extractor = new MemoryExtractor();
    const learnings = [
      // Below 0.5 — extracted memories should not start that low
      { category: 'patterns', suggested_id: 'too-uncertain', content: { description: 'low conf.', confidence: 0.3 } },
      // Above 0.9 — extracted memories should not start at retro-validated levels
      { category: 'patterns', suggested_id: 'too-confident', content: { description: 'high conf.', confidence: 0.95 } },
      makeLearning({ category: 'patterns', suggested_id: 'in-range', content: { description: 'fine.', confidence: 0.7 } }),
    ];
    setExecSyncImpl(makeMockExecSync(JSON.stringify(learnings)));

    const result = extractor.invokeModel('entry text');

    expect(result).toHaveLength(1);
    expect(result[0].suggested_id).toBe('in-range');
  });

  it('invokeModel_evidenceOptional_acceptedWhenAbsent', () => {
    const extractor = new MemoryExtractor();
    const learnings = [
      { category: 'patterns', suggested_id: 'no-evidence', content: { description: 'evidence missing but valid.', confidence: 0.7 } },
    ];
    setExecSyncImpl(makeMockExecSync(JSON.stringify(learnings)));

    const result = extractor.invokeModel('entry text');

    expect(result).toHaveLength(1);
    expect(result[0].suggested_id).toBe('no-evidence');
  });

  // ---------------------------------------------------------------------------
  // invokeModel — graceful-skip (claude not installed)
  // ---------------------------------------------------------------------------

  it('invokeModel_claudeNotInstalled_returnsEmptyArray', () => {
    // Drift from AC: source returns [] not null — see AC→source drift map item #3
    const extractor = new MemoryExtractor();
    const err = new Error('claude: command not found');
    err.stderr = 'claude: command not found';
    setExecSyncImpl(() => { throw err; });

    const result = extractor.invokeModel('any text');

    expect(result).toEqual([]);
  });

  it('invokeModel_claudeNotInstalled_doesNotThrow', () => {
    const extractor = new MemoryExtractor();
    const err = new Error('claude: command not found');
    err.stderr = 'claude: command not found';
    setExecSyncImpl(() => { throw err; });

    expect(() => extractor.invokeModel('any text')).not.toThrow();
  });

  it('invokeModel_malformedJson_returnsEmptyArray', () => {
    const extractor = new MemoryExtractor();
    setExecSyncImpl(makeMockExecSync('this is not json at all {{broken}}'));

    const result = extractor.invokeModel('entry text');

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// writeExtractedLearnings — format check
// ---------------------------------------------------------------------------

describe('writeExtractedLearnings', () => {
  it('writeExtractedLearnings_writesJsonFile_withCorrectPayloadShape', async () => {
    const extractor = new MemoryExtractor();
    const date = '2026-04-19';
    const timestamp = '2026-04-19T10-00-00';
    const learnings = [
      { category: 'pattern', title: 'A pattern', content: 'Details here.', confidence: 0.8,
        sourceDate: date, sourceTime: '09:00' }
    ];

    const outPath = await extractor.writeExtractedLearnings(date, learnings, timestamp);

    expect(fs.existsSync(outPath)).toBe(true);
    const payload = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(payload).toHaveProperty('extractedAt');
    expect(payload.sourceDate).toBe(date);
    expect(payload.count).toBe(1);
    expect(Array.isArray(payload.learnings)).toBe(true);
    expect(payload.learnings).toHaveLength(1);
    expect(payload.learnings[0].title).toBe('A pattern');
  });

  it('writeExtractedLearnings_outputPath_matchesExpectedStructure', async () => {
    // Drift from AC: output is JSON under extractedDir/{date}/{timestamp}.json
    // NOT markdown under extracted-learnings/{date}.md — see drift map item #4
    const extractor = new MemoryExtractor();
    const date = '2026-04-19';
    const timestamp = '2026-04-19T09-30-00';
    const learnings = [];

    const outPath = await extractor.writeExtractedLearnings(date, learnings, timestamp);

    const expectedDir = path.join(tmp.root, 'docs', '.output', '.state', 'memory-extracted', date);
    const expectedFile = path.join(expectedDir, `${timestamp}.json`);
    expect(outPath).toBe(expectedFile);
    expect(fs.existsSync(expectedDir)).toBe(true);
  });

  it('writeExtractedLearnings_emptyLearnings_writesCountZero', async () => {
    const extractor = new MemoryExtractor();
    const date = '2026-04-19';
    const timestamp = '2026-04-19T11-00-00';

    const outPath = await extractor.writeExtractedLearnings(date, [], timestamp);

    const payload = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    expect(payload.count).toBe(0);
    expect(payload.learnings).toEqual([]);
  });

  it('writeExtractedLearnings_extractedAtIsIsoString', async () => {
    const extractor = new MemoryExtractor();
    const beforeWrite = new Date();
    const outPath = await extractor.writeExtractedLearnings('2026-04-19', [], 'ts-001');
    const afterWrite = new Date();

    const payload = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    const writtenAt = new Date(payload.extractedAt);
    expect(writtenAt.getTime()).toBeGreaterThanOrEqual(beforeWrite.getTime() - 100);
    expect(writtenAt.getTime()).toBeLessThanOrEqual(afterWrite.getTime() + 100);
  });
});

// ---------------------------------------------------------------------------
// extract() — dry-run integration
// ---------------------------------------------------------------------------

describe('extract — dryRun mode', () => {
  it('extract_dryRun_returnsZeroProcessed', async () => {
    const extractor = new MemoryExtractor();
    createDailyLog(tmp, '2026-04-19', [
      { time: '09:00', trigger: 'Pre-Compaction', branch: 'main' },
    ]);

    const result = await extractor.extract({ dryRun: true });

    expect(result.processed).toBe(0);
  });

  it('extract_dryRun_skippedEqualsUnprocessedCount', async () => {
    const extractor = new MemoryExtractor();
    createDailyLog(tmp, '2026-04-19', [
      { time: '09:00', trigger: 'Pre-Compaction', branch: 'main' },
      { time: '12:00', trigger: 'Stop' },
    ]);

    const result = await extractor.extract({ dryRun: true });

    expect(result.skipped).toBe(2);
  });

  it('extract_dryRun_doesNotInvokeModel', async () => {
    const extractor = new MemoryExtractor();
    createDailyLog(tmp, '2026-04-19', [
      { time: '09:00', trigger: 'Pre-Compaction', branch: 'main' },
    ]);

    let execSyncCallCount = 0;
    setExecSyncImpl((cmd) => {
      execSyncCallCount++;
      return '[]';
    });

    await extractor.extract({ dryRun: true });

    // execSync should NOT have been called (no model in dry-run)
    expect(execSyncCallCount).toBe(0);
  });

  it('extract_dryRun_doesNotWriteExtractedFiles', async () => {
    const extractor = new MemoryExtractor();
    createDailyLog(tmp, '2026-04-19', [
      { time: '09:00', trigger: 'Pre-Compaction', branch: 'main' },
    ]);

    await extractor.extract({ dryRun: true });

    const extractedDir = path.join(tmp.root, 'docs', '.output', '.state', 'memory-extracted');
    const extractedExists = fs.existsSync(extractedDir);
    if (extractedExists) {
      const files = fs.readdirSync(extractedDir);
      expect(files).toHaveLength(0);
    } else {
      expect(extractedExists).toBe(false);
    }
  });

  it('extract_dryRun_doesNotModifyDailyLogHeadings', async () => {
    const extractor = new MemoryExtractor();
    createDailyLog(tmp, '2026-04-19', [
      { time: '09:00', trigger: 'Pre-Compaction', branch: 'main' },
    ]);

    const dailyPath = path.join(
      tmp.root,
      'docs', '.output', '.state', 'memory-daily', '2026-04-19.md'
    );
    const contentBefore = fs.readFileSync(dailyPath, 'utf-8');

    await extractor.extract({ dryRun: true });

    const contentAfter = fs.readFileSync(dailyPath, 'utf-8');
    expect(contentAfter).toBe(contentBefore);
  });

  it('extract_dryRun_noDailyDir_returnsZeros', async () => {
    const extractor = new MemoryExtractor();
    // No daily log created — dir does not exist

    const result = await extractor.extract({ dryRun: true });

    expect(result).toEqual({ processed: 0, skipped: 0, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// extract() — non-dry-run integration (mocked model)
// ---------------------------------------------------------------------------

describe('extract — live mode (mocked model)', () => {
  it('extract_liveModeWithMockedModel_processedEqualsOne', async () => {
    const extractor = new MemoryExtractor();
    createDailyLog(tmp, '2026-04-19', [
      { time: '09:00', trigger: 'Pre-Compaction', branch: 'main' }
    ]);

    const cannedLearnings = [
      { category: 'patterns', suggested_id: 'test-pattern', content: { description: 'A short rationale.', evidence: 'integration test', confidence: 0.8 } }
    ];
    setExecSyncImpl(makeMockExecSync(JSON.stringify(cannedLearnings)));

    const result = await extractor.extract({ dryRun: false });

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('extract_liveModeWithMockedModel_marksHeadingExtracted', async () => {
    const extractor = new MemoryExtractor();
    createDailyLog(tmp, '2026-04-19', [
      { time: '09:00', trigger: 'Pre-Compaction', branch: 'main' }
    ]);

    const cannedLearnings = [
      { category: 'patterns', suggested_id: 'test-pattern', content: { description: 'A short rationale.', evidence: 'integration test', confidence: 0.8 } }
    ];
    setExecSyncImpl(makeMockExecSync(JSON.stringify(cannedLearnings)));

    await extractor.extract({ dryRun: false });

    const dailyPath = path.join(
      tmp.root,
      'docs', '.output', '.state', 'memory-daily', '2026-04-19.md'
    );
    const updatedContent = fs.readFileSync(dailyPath, 'utf-8');
    expect(updatedContent).toContain('[extracted]');
  });

  it('extract_liveModeWithMockedModel_writesExtractedJsonFile', async () => {
    const extractor = new MemoryExtractor();
    createDailyLog(tmp, '2026-04-19', [
      { time: '09:00', trigger: 'Pre-Compaction', branch: 'main' }
    ]);

    const cannedLearnings = [
      { category: 'patterns', suggested_id: 'written-pattern', content: { description: 'Verifying file write.', evidence: 'integration test', confidence: 0.85 } }
    ];
    setExecSyncImpl(makeMockExecSync(JSON.stringify(cannedLearnings)));

    await extractor.extract({ dryRun: false });

    const extractedBase = path.join(tmp.root, 'docs', '.output', '.state', 'memory-extracted');
    const dateDirs = fs.readdirSync(extractedBase);
    expect(dateDirs).toHaveLength(1);

    const dateDir = path.join(extractedBase, dateDirs[0]);
    const jsonFiles = fs.readdirSync(dateDir).filter(f => f.endsWith('.json'));
    expect(jsonFiles).toHaveLength(1);

    const payload = JSON.parse(fs.readFileSync(path.join(dateDir, jsonFiles[0]), 'utf-8'));
    expect(payload).toHaveProperty('extractedAt');
    expect(payload).toHaveProperty('sourceDate');
    expect(payload.count).toBe(1);
    expect(Array.isArray(payload.learnings)).toBe(true);
    expect(payload.learnings[0].suggested_id).toBe('written-pattern');
  });

  it('extract_liveModeModelReturnsEmpty_marksProcessedAndCountsIt', async () => {
    // When model returns [] (no learnings), entry is still marked processed
    const extractor = new MemoryExtractor();
    createDailyLog(tmp, '2026-04-19', [
      { time: '09:00', trigger: 'Pre-Compaction' }
    ]);
    setExecSyncImpl(makeMockExecSync(JSON.stringify([])));

    const result = await extractor.extract({ dryRun: false });

    expect(result.processed).toBe(1);
    const dailyPath = path.join(
      tmp.root,
      'docs', '.output', '.state', 'memory-daily', '2026-04-19.md'
    );
    const content = fs.readFileSync(dailyPath, 'utf-8');
    expect(content).toContain('[extracted]');
  });

  it('extract_liveModeAlreadyProcessedEntries_areSkipped', async () => {
    const extractor = new MemoryExtractor();
    // Write a daily log where the heading already has [extracted]
    tmp.write(
      'docs/.output/.state/memory-daily/2026-04-19.md',
      '## 09:00 — Pre-Compaction [extracted]\n\nbody already done'
    );

    let execSyncCalled = false;
    setExecSyncImpl(() => { execSyncCalled = true; return '[]'; });

    const result = await extractor.extract({ dryRun: false });

    // Nothing to process — all entries already extracted
    expect(result.processed).toBe(0);
    expect(execSyncCalled).toBe(false);
  });

  it('extract_liveModeMultipleFiles_processesAllUnextracted', async () => {
    const extractor = new MemoryExtractor();
    createDailyLog(tmp, '2026-04-17', [
      { time: '09:00', trigger: 'Pre-Compaction' }
    ]);
    createDailyLog(tmp, '2026-04-18', [
      { time: '10:00', trigger: 'Stop' }
    ]);

    const cannedLearnings = [
      { category: 'workflow', title: 'Multi-file workflow', content: 'Both files.', confidence: 0.7 }
    ];
    setExecSyncImpl(makeMockExecSync(JSON.stringify(cannedLearnings)));

    const result = await extractor.extract({ dryRun: false });

    expect(result.processed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// checkClaudeCli
// ---------------------------------------------------------------------------

describe('checkClaudeCli', () => {
  it('checkClaudeCli_claudeAvailable_returnsTrue', () => {
    const extractor = new MemoryExtractor();
    setExecSyncImpl(() => '');

    expect(extractor.checkClaudeCli()).toBe(true);
  });

  it('checkClaudeCli_claudeNotFound_returnsFalse', () => {
    const extractor = new MemoryExtractor();
    setExecSyncImpl(() => {
      throw new Error('claude: command not found');
    });

    expect(extractor.checkClaudeCli()).toBe(false);
  });
});
