// AC→source map (TDD-3.7 / concept-fixture):
//   - createConcept writes parseable frontmatter (round-trips through parseFrontmatter)
//   - createConceptIndex writes non-empty index.md containing every created concept
//   - parseFrontmatter returns scalars as strings ('0.7' not 0.7)
//   - Cross-platform safe: path.join used throughout

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Note: path from `_helpers/__tests__/foo.test.js`:
//   concept-fixture lives at `_helpers/` → `../concept-fixture`
//   tmp-dir helper lives at `_helpers/` → `../tmp-dir`
//   memory-compiler.js lives at `.claude/core/` → `../../../memory-compiler`
const { createConcept, createConceptIndex } = require('../concept-fixture');
const { createTmpDir } = require('../tmp-dir');
const MemoryCompiler = require('../../../../../.agents/core/memory-compiler');

let tmp;
beforeEach(() => {
  tmp = createTmpDir();
});
afterEach(() => {
  tmp.cleanup();
});

describe('concept-fixture', () => {
  describe('createConcept', () => {
    it('createConcept_writesParseableFrontmatter', () => {
      const out = createConcept(tmp, 'patterns', 'my-slug', {
        title: 'My Pattern',
        confidence: 0.7,
        sources: ['2026-01-01', '2026-01-02'],
        content: 'body here',
      });

      expect(fs.existsSync(out)).toBe(true);

      const raw = fs.readFileSync(out, 'utf8');
      const fm = new MemoryCompiler().parseFrontmatter(raw);

      expect(fm).not.toBeNull();
      expect(fm.title).toBe('My Pattern');
      expect(fm.category).toBe('patterns');
      // parseFrontmatter returns sources as an array (list field)
      expect(fm.sources).toEqual(['2026-01-01', '2026-01-02']);
      // parseFrontmatter returns scalar values as strings
      expect(fm.confidence).toBe('0.7');
    });

    it('createConcept_returnsAbsolutePath', () => {
      const out = createConcept(tmp, 'decisions', 'some-decision', {
        title: 'Some Decision',
        confidence: 0.8,
        sources: ['2026-03-01'],
        content: '',
      });

      expect(typeof out).toBe('string');
      expect(path.isAbsolute(out)).toBe(true);
      expect(fs.existsSync(out)).toBe(true);
    });

    it('createConcept_writesCorrectFilePath', () => {
      const out = createConcept(tmp, 'constraints', 'test-constraint', {
        title: 'Test Constraint',
        confidence: 0.6,
        sources: ['2026-02-15'],
        content: 'some constraint',
      });

      const expectedPath = path.join(
        tmp.root, 'docs', '.output', '.state', 'memory-concepts',
        'constraints', 'test-constraint.md'
      );
      expect(out).toBe(expectedPath);
    });

    it('createConcept_frontmatterContainsRequiredScalarFields', () => {
      createConcept(tmp, 'patterns', 'required-fields', {
        title: 'Required Fields Test',
        confidence: 0.75,
        sources: ['2026-04-01', '2026-04-10'],
        content: '',
      });

      const filePath = path.join(
        tmp.root, 'docs', '.output', '.state', 'memory-concepts',
        'patterns', 'required-fields.md'
      );
      const raw = fs.readFileSync(filePath, 'utf8');
      const fm = new MemoryCompiler().parseFrontmatter(raw);

      expect(fm).not.toBeNull();
      // Scalars
      expect(fm.title).toBe('Required Fields Test');
      expect(fm.category).toBe('patterns');
      expect(fm.confidence).toBe('0.75');
      expect(fm.source_count).toBe('2');
      expect(fm.entry_count).toBe('1');
      // created and updated must be present
      expect(typeof fm.created).toBe('string');
      expect(fm.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof fm.updated).toBe('string');
    });

    it('createConcept_frontmatterListFieldsRoundTrip', () => {
      createConcept(tmp, 'workflows', 'list-fields-slug', {
        title: 'List Fields Concept',
        confidence: 0.9,
        sources: ['2026-01-05', '2026-01-06', '2026-01-07'],
        content: '',
      });

      const filePath = path.join(
        tmp.root, 'docs', '.output', '.state', 'memory-concepts',
        'workflows', 'list-fields-slug.md'
      );
      const raw = fs.readFileSync(filePath, 'utf8');
      const fm = new MemoryCompiler().parseFrontmatter(raw);

      // sources is a list field — parseFrontmatter returns an array
      expect(Array.isArray(fm.sources)).toBe(true);
      expect(fm.sources).toEqual(['2026-01-05', '2026-01-06', '2026-01-07']);

      // tags is a list field
      expect(Array.isArray(fm.tags)).toBe(true);
      expect(fm.tags).toContain('workflows');

      // aliases is a list field
      expect(Array.isArray(fm.aliases)).toBe(true);
      expect(fm.aliases).toContain('List Fields Concept');

      // cssclasses is a list field
      expect(Array.isArray(fm.cssclasses)).toBe(true);
      expect(fm.cssclasses).toContain('concept-workflows');
    });

    it('createConcept_withUsageCount_includesExtraScalarField', () => {
      const out = createConcept(tmp, 'patterns', 'usage-count-slug', {
        title: 'Usage Count Concept',
        confidence: 0.6,
        sources: ['2026-04-15'],
        usage_count: 42,
        content: '',
      });

      const raw = fs.readFileSync(out, 'utf8');
      const fm = new MemoryCompiler().parseFrontmatter(raw);

      expect(fm).not.toBeNull();
      // usage_count is present as a scalar string
      expect(fm.usage_count).toBe('42');
      // source_count is also present (derived from sources.length)
      expect(fm.source_count).toBe('1');
    });

    it('createConcept_withoutUsageCount_omitsField', () => {
      const out = createConcept(tmp, 'patterns', 'no-usage-count', {
        title: 'No Usage Count',
        confidence: 0.5,
        sources: ['2026-04-01'],
        content: '',
      });

      const raw = fs.readFileSync(out, 'utf8');
      const fm = new MemoryCompiler().parseFrontmatter(raw);

      expect(fm).not.toBeNull();
      expect(fm.usage_count).toBeUndefined();
    });

    it('createConcept_sourcesAreSortedInOutput', () => {
      const out = createConcept(tmp, 'decisions', 'sorted-sources', {
        title: 'Sorted Sources',
        confidence: 0.7,
        sources: ['2026-03-10', '2026-01-01', '2026-02-15'],
        content: '',
      });

      const raw = fs.readFileSync(out, 'utf8');
      const fm = new MemoryCompiler().parseFrontmatter(raw);

      expect(fm.sources).toEqual(['2026-01-01', '2026-02-15', '2026-03-10']);
    });

    it('createConcept_contentAppearsInBody', () => {
      const out = createConcept(tmp, 'patterns', 'body-content', {
        title: 'Body Content Test',
        confidence: 0.7,
        sources: ['2026-04-01'],
        content: 'This is the body content for testing.',
      });

      const raw = fs.readFileSync(out, 'utf8');
      expect(raw).toContain('This is the body content for testing.');
    });
  });

  describe('createConceptIndex', () => {
    it('createConceptIndex_writesNonEmptyIndexFile', () => {
      createConcept(tmp, 'patterns', 'a', {
        title: 'A',
        confidence: 0.8,
        sources: ['2026-01-01'],
        content: '',
      });
      createConcept(tmp, 'decisions', 'b', {
        title: 'B',
        confidence: 0.8,
        sources: ['2026-01-01'],
        content: '',
      });

      createConceptIndex(tmp);

      const indexPath = path.join(
        tmp.root, 'docs', '.output', '.state', 'memory-concepts', 'index.md'
      );
      expect(fs.existsSync(indexPath)).toBe(true);
      const content = fs.readFileSync(indexPath, 'utf8');
      expect(content.trim().length).toBeGreaterThan(0);
      // Both titles appear
      expect(content).toMatch(/A/);
      expect(content).toMatch(/B/);
    });

    it('createConceptIndex_indexContainsAllConceptSlugs', () => {
      createConcept(tmp, 'patterns', 'pattern-alpha', {
        title: 'Pattern Alpha',
        confidence: 0.9,
        sources: ['2026-01-01'],
        content: '',
      });
      createConcept(tmp, 'patterns', 'pattern-beta', {
        title: 'Pattern Beta',
        confidence: 0.7,
        sources: ['2026-01-02'],
        content: '',
      });
      createConcept(tmp, 'constraints', 'constraint-one', {
        title: 'Constraint One',
        confidence: 0.6,
        sources: ['2026-01-03'],
        content: '',
      });

      createConceptIndex(tmp);

      const indexPath = path.join(
        tmp.root, 'docs', '.output', '.state', 'memory-concepts', 'index.md'
      );
      const content = fs.readFileSync(indexPath, 'utf8');

      expect(content).toContain('pattern-alpha');
      expect(content).toContain('pattern-beta');
      expect(content).toContain('constraint-one');
      expect(content).toContain('Pattern Alpha');
      expect(content).toContain('Pattern Beta');
      expect(content).toContain('Constraint One');
    });

    it('createConceptIndex_returnsAbsolutePath', () => {
      createConcept(tmp, 'patterns', 'any-slug', {
        title: 'Any',
        confidence: 0.5,
        sources: ['2026-01-01'],
        content: '',
      });

      const out = createConceptIndex(tmp);

      expect(typeof out).toBe('string');
      expect(path.isAbsolute(out)).toBe(true);
      expect(fs.existsSync(out)).toBe(true);
    });

    it('createConceptIndex_writesCorrectPath', () => {
      createConceptIndex(tmp);

      const expectedPath = path.join(
        tmp.root, 'docs', '.output', '.state', 'memory-concepts', 'index.md'
      );
      expect(fs.existsSync(expectedPath)).toBe(true);
    });

    it('createConceptIndex_emptyConcepts_writesNonEmptyFile', () => {
      // Even with no concepts, the index should be a non-empty file
      // (header + last compiled date).
      createConceptIndex(tmp);

      const indexPath = path.join(
        tmp.root, 'docs', '.output', '.state', 'memory-concepts', 'index.md'
      );
      const content = fs.readFileSync(indexPath, 'utf8');
      expect(content.trim().length).toBeGreaterThan(0);
      expect(content).toContain('Memory Concepts Index');
    });
  });
});
