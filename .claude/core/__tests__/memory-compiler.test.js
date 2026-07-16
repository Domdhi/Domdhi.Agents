// AC→source map (TDD-3.3 / memory-compiler):
//   - extractKeywords returns a Set, no ranking/stopwords; length>2 filter
//   - getConceptId has no collision suffix — pure slugifier
//   - detectCategory signals (first-match-wins):
//     rejected-approaches: rejected, didn't work, failed approach, tried but, reverted, ...
//     decisions: decision, rationale, chose, choosing, decided, choose
//     patterns: pattern, approach, strategy, convention, practice
//     constraints: constraint, limitation, cannot, blocked, blocker, must not, restriction
//     default: workflows
//   - generateCrossReferences uses windowed similarity: 0.15 <= sim < 0.3

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

const MemoryCompiler = require('../memory-compiler');
const CONSTANTS = require('../constants');
const { createTmpDir } = require('./_helpers/tmp-dir');
const { createDailyLog } = require('./_helpers/daily-log-fixture');

let tmp;
let originalEnv;

beforeEach(() => {
  tmp = createTmpDir();
  originalEnv = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = tmp.root;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = originalEnv;
  tmp.cleanup();
});

describe('memory-compiler', () => {
  // ---------------------------------------------------------------------------
  // parseDailyFile
  // ---------------------------------------------------------------------------
  describe('parseDailyFile', () => {
    it('parseDailyFile_empty_returnsEmptyArray', () => {
      // Arrange
      const compiler = new MemoryCompiler();

      // Act
      const result = compiler.parseDailyFile('', '2026-04-15');

      // Assert
      expect(result).toEqual([]);
    });

    it('parseDailyFile_singleEntry_returnsOneItem', () => {
      // Arrange
      const compiler = new MemoryCompiler();
      const content = '## 10:00 — Stop\n\nbody text here';

      // Act
      const result = compiler.parseDailyFile(content, '2026-04-15');

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].time).toBe('10:00');
      expect(result[0].date).toBe('2026-04-15');
    });

    it('parseDailyFile_multiEntry_returnsN', () => {
      // Arrange
      const compiler = new MemoryCompiler();
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

      // Act
      const result = compiler.parseDailyFile(content, '2026-04-15');

      // Assert
      expect(result).toHaveLength(3);
      expect(result[0].time).toBe('09:00');
      expect(result[1].time).toBe('10:00');
      expect(result[2].time).toBe('11:00');
    });

    it('parseDailyFile_crlfLineEndings_matchesLf', () => {
      // Arrange
      const compiler = new MemoryCompiler();
      const lfContent = '## 09:00 — Pre-Compaction\n\nbody one\n## 10:00 — Stop\n\nbody two';
      const crlfContent = lfContent.replace(/\n/g, '\r\n');

      // Act
      const lfResult = compiler.parseDailyFile(lfContent, '2026-04-15');
      const crlfResult = compiler.parseDailyFile(crlfContent, '2026-04-15');

      // Assert: same entry count and same time values
      expect(crlfResult).toHaveLength(lfResult.length);
      for (let i = 0; i < lfResult.length; i++) {
        expect(crlfResult[i].time).toBe(lfResult[i].time);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // parseFrontmatter
  // ---------------------------------------------------------------------------
  describe('parseFrontmatter', () => {
    it('parseFrontmatter_validYaml_returnsObject', () => {
      // Arrange
      const compiler = new MemoryCompiler();
      const content = [
        '---',
        'title: Foo',
        'category: patterns',
        'sources:',
        '  - 2026-04-01',
        '  - 2026-04-02',
        '---',
        'body text',
      ].join('\n');

      // Act
      const result = compiler.parseFrontmatter(content);

      // Assert
      expect(result).not.toBeNull();
      expect(result.title).toBe('Foo');
      expect(result.category).toBe('patterns');
      expect(result.sources).toEqual(['2026-04-01', '2026-04-02']);
    });

    it('parseFrontmatter_missingDelimiter_returnsNull', () => {
      // Arrange
      const compiler = new MemoryCompiler();

      // Act
      const result = compiler.parseFrontmatter('no frontmatter here');

      // Assert
      expect(result).toBeNull();
    });

    it('parseFrontmatter_emptyString_returnsNull', () => {
      // Arrange
      const compiler = new MemoryCompiler();

      // Act
      const result = compiler.parseFrontmatter('');

      // Assert
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // extractKeywords
  // ---------------------------------------------------------------------------
  describe('extractKeywords', () => {
    it('extractKeywords_branchSection_includesBranchTokens', () => {
      // Arrange
      const compiler = new MemoryCompiler();
      const entry = {
        rawText: '## 10:00 — Stop\n\n**Branch:** feat-oauth-integration\n',
      };

      // Act
      const result = compiler.extractKeywords(entry);

      // Assert
      expect(result instanceof Set).toBe(true);
      expect(result.has('feat')).toBe(true);
      expect(result.has('oauth')).toBe(true);
      expect(result.has('integration')).toBe(true);
      // length > 2 filter: no tokens shorter than 3 chars
      for (const token of result) {
        expect(token.length).toBeGreaterThan(2);
      }
    });

    it('extractKeywords_commitSubjects_extractsWords', () => {
      // Arrange
      const compiler = new MemoryCompiler();
      const entry = {
        rawText: [
          '## 10:00 — Stop',
          '',
          '### Recent Commits',
          '```',
          'abc1234 feat: add oauth middleware',
          '```',
          '',
        ].join('\n'),
      };

      // Act
      const result = compiler.extractKeywords(entry);

      // Assert: meaningful words extracted, hash and type prefix stripped
      expect(result.has('add')).toBe(true);
      expect(result.has('oauth')).toBe(true);
      expect(result.has('middleware')).toBe(true);
      // Hash should not appear as keyword
      expect(result.has('abc1234')).toBe(false);
    });

    it('extractKeywords_returnsSet_allTokensLongerThan2', () => {
      // Arrange
      const compiler = new MemoryCompiler();
      const entry = {
        rawText: [
          '## 10:00 — Stop',
          '',
          '**Branch:** feat-ab-longword',
          '',
          '### Recent Commits',
          '```',
          'abc1234 feat: add integration middleware',
          '```',
          '',
          '### In-Progress Work',
          '- [>] Authentication Service',
          '',
          '### Key Decisions',
          '| Decision | Rationale | Outcome |',
          '| --- | --- | --- |',
          '| Use JWT tokens | security | done |',
          '',
        ].join('\n'),
      };

      // Act
      const result = compiler.extractKeywords(entry);

      // Assert
      expect(result instanceof Set).toBe(true);
      for (const token of result) {
        expect(token.length).toBeGreaterThan(2);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // getConceptId
  // ---------------------------------------------------------------------------
  describe('getConceptId', () => {
    it('getConceptId_normalTitle_returnsSlug', () => {
      // Arrange
      const compiler = new MemoryCompiler();

      // Act
      const result = compiler.getConceptId('JWT Token Strategy');

      // Assert
      expect(result).toBe('jwt-token-strategy');
    });

    it('getConceptId_specialChars_stripped', () => {
      // Arrange
      const compiler = new MemoryCompiler();
      // `/` gets stripped leaving "AuthSession" adjacent, `&` stripped, `(`, `)`, `!` stripped
      // After lowercase: "auth/session & tokens (v2)!" → "authsession  tokens v2"
      // → trim → collapse spaces → "authsession-tokens-v2"

      // Act
      const result = compiler.getConceptId('Auth/Session & Tokens (v2)!');

      // Assert
      expect(result).toBe('authsession-tokens-v2');
    });

    it('getConceptId_longTitle_truncatedAt80', () => {
      // Arrange
      const compiler = new MemoryCompiler();
      const longTitle = 'a'.repeat(100);

      // Act
      const result = compiler.getConceptId(longTitle);

      // Assert
      expect(result.length).toBeLessThanOrEqual(80);
    });
  });

  // ---------------------------------------------------------------------------
  // detectCategory
  // ---------------------------------------------------------------------------
  describe('detectCategory', () => {
    it('detectCategory_rejectedSignal_returnsRejectedApproaches', () => {
      // Arrange
      const compiler = new MemoryCompiler();
      const entries = [{ rawText: "tried but this approach didn't work" }];

      // Act
      const result = compiler.detectCategory(entries);

      // Assert
      expect(result).toBe('rejected-approaches');
    });

    it('detectCategory_decisionSignal_returnsDecisions', () => {
      // Arrange
      const compiler = new MemoryCompiler();
      const entries = [{ rawText: 'chose JWT over sessions for the auth flow' }];

      // Act
      const result = compiler.detectCategory(entries);

      // Assert
      expect(result).toBe('decisions');
    });

    it('detectCategory_patternSignal_returnsPatterns', () => {
      // Arrange
      const compiler = new MemoryCompiler();
      const entries = [{ rawText: 'standard approach for auth token handling' }];

      // Act
      const result = compiler.detectCategory(entries);

      // Assert
      expect(result).toBe('patterns');
    });

    it('detectCategory_constraintSignal_returnsConstraints', () => {
      // Arrange
      const compiler = new MemoryCompiler();
      const entries = [{ rawText: 'must not use localStorage for token storage' }];

      // Act
      const result = compiler.detectCategory(entries);

      // Assert
      expect(result).toBe('constraints');
    });

    it('detectCategory_noSignals_defaultsToWorkflows', () => {
      // Arrange
      const compiler = new MemoryCompiler();
      const entries = [{ rawText: 'generic work log entry for the session' }];

      // Act
      const result = compiler.detectCategory(entries);

      // Assert
      expect(result).toBe('workflows');
    });
  });

  // ---------------------------------------------------------------------------
  // generateTitle
  // ---------------------------------------------------------------------------
  describe('generateTitle', () => {
    it('generateTitle_withKeywords_returnsNonEmptyTitleCase', () => {
      // Arrange
      const compiler = new MemoryCompiler();
      // Both entries share 'oauth', 'jwt', 'token'; single entries also have 'middleware'/'flow'
      const entries = [
        { keywords: new Set(['oauth', 'jwt', 'token', 'middleware']) },
        { keywords: new Set(['oauth', 'jwt', 'token', 'flow']) },
      ];

      // Act
      const result = compiler.generateTitle(entries);

      // Assert: non-empty, starts with capital, under 80 chars
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThan(80);
      expect(result[0]).toBe(result[0].toUpperCase());
    });

    it('generateTitle_emptyGroup_returnsUnnamedConcept', () => {
      // Arrange
      const compiler = new MemoryCompiler();
      const entries = [
        { keywords: new Set() },
        { keywords: new Set() },
      ];

      // Act
      const result = compiler.generateTitle(entries);

      // Assert
      expect(result).toBe('Unnamed Concept');
    });
  });

  // ---------------------------------------------------------------------------
  // compile (integration)
  // ---------------------------------------------------------------------------
  describe('compile', () => {
    it('compile_threeDailyFiles_writesConceptFiles', async () => {
      // Arrange: mute console.log for this test only
      const origLog = console.log;
      console.log = () => {};

      try {
        const compiler = new MemoryCompiler();

        // Write 3 daily log files with overlapping oauth/token content to force clustering
        createDailyLog(tmp, '2026-04-13', [
          {
            time: '09:00',
            trigger: 'Pre-Compaction',
            branch: 'feat-oauth',
            commits: [
              { hash: 'aaa0001', message: 'feat: add oauth token middleware' },
            ],
            inProgress: ['OAuth Token Integration'],
          }
        ]);
        createDailyLog(tmp, '2026-04-14', [
          {
            time: '10:00',
            trigger: 'Pre-Compaction',
            branch: 'feat-oauth',
            commits: [
              { hash: 'bbb0002', message: 'feat: oauth token refresh flow' },
            ],
            inProgress: ['OAuth Token Integration'],
          }
        ]);
        createDailyLog(tmp, '2026-04-15', [
          {
            time: '11:00',
            trigger: 'Pre-Compaction',
            branch: 'feat-oauth',
            commits: [
              { hash: 'ccc0003', message: 'feat: finalize oauth token handling' },
            ],
            inProgress: ['OAuth Token Integration'],
          }
        ]);

        // Act
        await compiler.compile();

        // Assert: at least one concept file written under any category
        const conceptsBase = path.join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');
        let foundConceptFile = null;
        const categories = Object.values(CONSTANTS.MEMORY_CATEGORIES);
        for (const cat of categories) {
          const catDir = path.join(conceptsBase, cat);
          if (fs.existsSync(catDir)) {
            const files = fs.readdirSync(catDir).filter(f => f.endsWith('.md'));
            if (files.length > 0) {
              foundConceptFile = path.join(catDir, files[0]);
              break;
            }
          }
        }
        expect(foundConceptFile).not.toBeNull();

        // Assert: concept file starts with frontmatter
        const conceptContent = fs.readFileSync(foundConceptFile, 'utf8');
        expect(conceptContent.startsWith('---\n')).toBe(true);
        expect(conceptContent).toContain('title:');
        expect(conceptContent).toContain('category:');
        expect(conceptContent).toContain('sources:');

        // Assert: index.md exists with expected heading
        const indexPath = path.join(conceptsBase, 'index.md');
        expect(fs.existsSync(indexPath)).toBe(true);
        const indexContent = fs.readFileSync(indexPath, 'utf8');
        expect(indexContent).toContain('# Memory Concepts Index');

        // Assert: cross-references.json exists and is valid JSON
        const crossRefPath = path.join(conceptsBase, 'cross-references.json');
        expect(fs.existsSync(crossRefPath)).toBe(true);
        const crossRefContent = fs.readFileSync(crossRefPath, 'utf8');
        expect(() => JSON.parse(crossRefContent)).not.toThrow();
      } finally {
        console.log = origLog;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // generateCrossReferences
  // ---------------------------------------------------------------------------
  describe('generateCrossReferences', () => {
    it('generateCrossReferences_windowedSimilarity_recordsPair', async () => {
      // Arrange
      // Engineer two concepts with Jaccard similarity in [0.15, 0.3).
      // Source tokenizes: title + summary text (len>2, alphanum only).
      // The `>` in summary lines strips to empty and is filtered out.
      //
      // File A: title "Alpha Token Pipeline"  → tokens: {alpha, token, pipeline}
      //         summary "> oauth token pipeline refresh strategy"
      //                                        → tokens: {oauth, token(dup), pipeline(dup), refresh, strategy}
      //         Combined unique: {alpha, token, pipeline, oauth, refresh, strategy} = 6
      //
      // File B: title "Beta Middleware Flow"   → tokens: {beta, middleware, flow}
      //         summary "> oauth middleware flow authorization refresh"
      //                                        → tokens: {oauth, middleware(dup), flow(dup), authorization, refresh}
      //         Combined unique: {beta, middleware, flow, oauth, authorization, refresh} = 6
      //
      // Intersection: {oauth, refresh} = 2
      // Union: {alpha,token,pipeline,oauth,refresh,strategy,beta,middleware,flow,authorization} = 10
      // Jaccard: 2/10 = 0.2  ✓ falls in [0.15, 0.3)

      const compiler = new MemoryCompiler();

      const conceptsBase = path.join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');
      const patternsDir = path.join(conceptsBase, 'patterns');
      fs.mkdirSync(patternsDir, { recursive: true });

      const fileABody = [
        '---',
        'title: Alpha Token Pipeline',
        'category: patterns',
        '---',
        '',
        '## Summary',
        '',
        '> oauth token pipeline refresh strategy',
        '',
        '## Evidence',
        '',
        '_empty_',
      ].join('\n');

      const fileBBody = [
        '---',
        'title: Beta Middleware Flow',
        'category: patterns',
        '---',
        '',
        '## Summary',
        '',
        '> oauth middleware flow authorization refresh',
        '',
        '## Evidence',
        '',
        '_empty_',
      ].join('\n');

      fs.writeFileSync(path.join(patternsDir, 'concept-alpha.md'), fileABody, 'utf8');
      fs.writeFileSync(path.join(patternsDir, 'concept-beta.md'), fileBBody, 'utf8');

      // Act (no conceptScan arg → the lib walks the tree itself; the old
      // zero-parameter signature ignored a stray [] here, the new F4 signature
      // would treat it as a real — empty — shared scan)
      const pairCount = await compiler.generateCrossReferences();

      // Assert: cross-references.json written
      const crossRefPath = path.join(conceptsBase, 'cross-references.json');
      expect(fs.existsSync(crossRefPath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(crossRefPath, 'utf8'));

      expect(parsed).toHaveProperty('concept-alpha');
      expect(parsed).toHaveProperty('concept-beta');
      expect(parsed['concept-alpha'].related).toContain('concept-beta');
      expect(parsed['concept-beta'].related).toContain('concept-alpha');
      expect(pairCount).toBe(1);
    });

    it('generateCrossReferences_noConcepts_writesEmptyObject', async () => {
      // Arrange
      const compiler = new MemoryCompiler();
      // Create concepts dir but no concept files
      const conceptsBase = path.join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');
      fs.mkdirSync(conceptsBase, { recursive: true });

      // Act
      await compiler.generateCrossReferences([]);

      // Assert
      const crossRefPath = path.join(conceptsBase, 'cross-references.json');
      expect(fs.existsSync(crossRefPath)).toBe(true);
      const content = fs.readFileSync(crossRefPath, 'utf8');
      expect(JSON.parse(content)).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // injectRelatedConcepts
  // ---------------------------------------------------------------------------
  describe('injectRelatedConcepts', () => {
    it('injectRelatedConcepts_withCrossRefs_insertsSection', async () => {
      // Arrange
      const compiler = new MemoryCompiler();

      const conceptsBase = path.join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');
      const patternsDir = path.join(conceptsBase, 'patterns');
      fs.mkdirSync(patternsDir, { recursive: true });

      const alphaBody = [
        '---',
        'title: Alpha Concept',
        'category: patterns',
        '---',
        '',
        '## Summary',
        '',
        '> summary text',
        '',
        '## Evidence',
        '',
        '_empty_',
      ].join('\n');

      const betaBody = [
        '---',
        'title: Beta Concept',
        'category: patterns',
        '---',
        '',
        '## Summary',
        '',
        '> summary text',
        '',
        '## Evidence',
        '',
        '_empty_',
      ].join('\n');

      fs.writeFileSync(path.join(patternsDir, 'alpha.md'), alphaBody, 'utf8');
      fs.writeFileSync(path.join(patternsDir, 'beta.md'), betaBody, 'utf8');

      // Pre-write cross-references.json mapping each slug to the other
      const crossRefContent = JSON.stringify({
        alpha: { related: ['beta'], category: 'patterns' },
        beta: { related: ['alpha'], category: 'patterns' },
      }, null, 2);
      fs.writeFileSync(path.join(conceptsBase, 'cross-references.json'), crossRefContent, 'utf8');

      // Act
      await compiler.injectRelatedConcepts([]);

      // Assert: alpha.md now contains Related Concepts section with wiki-link to beta
      const updatedAlpha = fs.readFileSync(path.join(patternsDir, 'alpha.md'), 'utf8');
      expect(updatedAlpha).toContain('## Related Concepts');
      expect(updatedAlpha).toContain('[[beta|Beta Concept]]');
    });
  });

  // ---------------------------------------------------------------------------
  // F4/F5 (council-260715-2244): shared per-compile concepts scan + bounded
  // pairwise Jaccard
  // ---------------------------------------------------------------------------
  describe('shared conceptScan (F4) + bounded pairwise Jaccard (F5)', () => {
    const { generateCrossReferences, MAX_PAIR_COMPARISONS } = require('../_lib/cross-references');
    const { generateIndex, injectRelatedConcepts } = require('../_lib/concept-index');
    const { scanConceptFiles } = require('../_lib/concept-reader');

    const mkScanEntry = (slug, category, title, summary) => ({
      slug,
      filename: `${slug}.md`,
      category,
      content: `---\ntitle: ${title}\ncategory: ${category}\n---\n\n## Summary\n\n${summary}\n\n## Evidence\n\n_empty_`,
      fm: { title, category },
    });

    it('generateCrossReferences consumes a provided conceptScan WITHOUT touching the tree (single-pass proof)', async () => {
      // conceptsDir points at a real (writable) dir, but the scan entries do
      // NOT exist on disk — pairs can only come from the provided scan.
      const conceptsBase = path.join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');
      fs.mkdirSync(conceptsBase, { recursive: true });
      const conceptScan = [
        mkScanEntry('scan-alpha', 'patterns', 'Alpha Token Pipeline', 'oauth token pipeline refresh strategy'),
        mkScanEntry('scan-beta', 'patterns', 'Beta Middleware Flow', 'oauth middleware flow authorization refresh'),
      ];

      const pairCount = await generateCrossReferences({
        conceptsDir: conceptsBase,
        categories: ['patterns'],
        crossRefThreshold: 0.15,
        similarityThreshold: 0.3,
        conceptScan,
      });

      expect(pairCount).toBe(1); // Jaccard 0.2 — from the scan, not the (empty) disk tree
      const parsed = JSON.parse(fs.readFileSync(path.join(conceptsBase, 'cross-references.json'), 'utf8'));
      expect(parsed['scan-alpha'].related).toContain('scan-beta');
    });

    it('keyword-disjoint concepts produce zero pairs (F5 pre-filter is exact — Jaccard 0 can never cross a positive threshold)', async () => {
      const conceptsBase = path.join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');
      fs.mkdirSync(conceptsBase, { recursive: true });
      const conceptScan = [
        mkScanEntry('one', 'patterns', 'Apples Oranges', 'fruit basket citrus'),
        mkScanEntry('two', 'patterns', 'Sockets Threads', 'network kernel epoll'),
      ];
      const pairCount = await generateCrossReferences({
        conceptsDir: conceptsBase,
        categories: ['patterns'],
        crossRefThreshold: 0.15,
        similarityThreshold: 0.3,
        conceptScan,
      });
      expect(pairCount).toBe(0);
      expect(MAX_PAIR_COMPARISONS).toBeGreaterThan(0); // the hard bound exists and is exported
    });

    it('generateIndex merges on-disk concepts from the provided conceptScan (no re-walk)', async () => {
      const conceptsBase = path.join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');
      fs.mkdirSync(conceptsBase, { recursive: true });
      const conceptScan = [
        mkScanEntry('only-in-scan', 'patterns', 'Only In Scan', 'this article exists only in the shared scan'),
      ];

      await generateIndex([], {
        conceptsDir: conceptsBase,
        categories: ['patterns'],
        formatDateOnly: (iso) => String(iso).slice(0, 10),
        conceptScan,
      });

      const index = fs.readFileSync(path.join(conceptsBase, 'index.md'), 'utf8');
      expect(index).toContain('[[only-in-scan|Only In Scan]]'); // provable single source: the file is not on disk
    });

    it('injectRelatedConcepts builds its lookup from the provided conceptScan (scan title wins over a disk re-read)', async () => {
      const conceptsBase = path.join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');
      const patternsDir = path.join(conceptsBase, 'patterns');
      fs.mkdirSync(patternsDir, { recursive: true });
      // Real article files (injection writes into them)…
      fs.writeFileSync(path.join(patternsDir, 'inj-a.md'), '---\ntitle: Disk Title A\ncategory: patterns\n---\n\n## Summary\n\nx\n\n## Evidence\n\n_empty_', 'utf8');
      fs.writeFileSync(path.join(patternsDir, 'inj-b.md'), '---\ntitle: Disk Title B\ncategory: patterns\n---\n\n## Summary\n\ny\n\n## Evidence\n\n_empty_', 'utf8');
      fs.writeFileSync(path.join(conceptsBase, 'cross-references.json'), JSON.stringify({
        'inj-a': { related: ['inj-b'], category: 'patterns' },
        'inj-b': { related: ['inj-a'], category: 'patterns' },
      }), 'utf8');
      // …but the scan carries a DIFFERENT title for inj-b. If the function
      // re-walked the disk, the injected link would say "Disk Title B".
      const conceptScan = [
        { slug: 'inj-a', filename: 'inj-a.md', category: 'patterns', content: '', fm: { title: 'Disk Title A' } },
        { slug: 'inj-b', filename: 'inj-b.md', category: 'patterns', content: '', fm: { title: 'Scan Title B' } },
      ];

      await injectRelatedConcepts([], { conceptsDir: conceptsBase, categories: ['patterns'], conceptScan });

      const updatedA = fs.readFileSync(path.join(patternsDir, 'inj-a.md'), 'utf8');
      expect(updatedA).toContain('[[inj-b|Scan Title B]]');
    });

    it('concept-article Evidence section is bounded — oldest blocks rotate out past the cap (F3)', async () => {
      const { writeConceptArticle } = require('../_lib/concept-article');
      const conceptsBase = path.join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');
      fs.mkdirSync(path.join(conceptsBase, 'patterns'), { recursive: true });

      const deps = {
        conceptsDir: conceptsBase,
        detectCategory: () => 'patterns',
        generateTitle: () => 'Rotation Probe',
        getConceptId: () => 'rotation-probe',
        generateSummary: () => 'rotation probe summary',
        addDailyBacklinks: (t) => t,
        formatDateOnly: (iso) => String(iso).slice(0, 10),
      };
      const entry = (day, hhmm) => ({
        date: `2026-06-${String(day).padStart(2, '0')}`, time: hhmm,
        rawText: `evidence for day ${day}`, keywords: new Set(['rotation', 'probe']),
      });

      // 30 merges of one block each — well past the 20-block cap.
      for (let d = 1; d <= 30; d++) {
        await writeConceptArticle([entry(d, '10:00')], deps);
      }

      const article = fs.readFileSync(path.join(conceptsBase, 'patterns', 'rotation-probe.md'), 'utf8');
      const blockCount = (article.match(/^### \d{4}-\d{2}-\d{2} /gm) || []).length;
      expect(blockCount).toBeLessThanOrEqual(20);
      expect(article).toContain('evidence for day 30');      // newest kept
      expect(article).not.toContain('evidence for day 1\n'); // oldest rotated out
      expect(article).toMatch(/_\d+ older evidence block\(s\) rotated out/); // and the loss is visible
    });

    it('scanConceptFiles returns {slug, filename, category, content, fm} per parsable article', async () => {
      const conceptsBase = path.join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');
      const patternsDir = path.join(conceptsBase, 'patterns');
      fs.mkdirSync(patternsDir, { recursive: true });
      fs.writeFileSync(path.join(patternsDir, 'real.md'), '---\ntitle: Real Article\ncategory: patterns\n---\n\n## Summary\n\nz', 'utf8');
      fs.writeFileSync(path.join(patternsDir, 'no-frontmatter.md'), 'plain text, not a concept', 'utf8');

      const scan = await scanConceptFiles({ conceptsDir: conceptsBase, categories: ['patterns', 'absent-category'] });

      expect(scan).toHaveLength(1);
      expect(scan[0]).toMatchObject({ slug: 'real', filename: 'real.md', category: 'patterns' });
      expect(scan[0].fm.title).toBe('Real Article');
    });
  });
});
