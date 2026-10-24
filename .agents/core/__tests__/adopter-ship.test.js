// Adopter-ship regression guard.
//
// Context: template-updater.js EXCLUDES __tests__/ and _helpers/ from propagation
// to adopter projects. A shipped script that hard-depends at runtime on a file
// under __tests__/ therefore breaks in every adopter project. memory-eval.js hit
// exactly this: its query fixture lives under __tests__/_fixtures/, so adopters
// received the script without the fixture and the harness died on a missing-file
// FATAL (fixed in 86e38a9 with an inlined DEFAULT_QUERIES fallback).
//
// This guard locks that fix in and fails loudly if a future change reintroduces a
// __tests__/-only runtime dependency in memory-eval.js's fixture loading.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { loadFixture, DEFAULT_QUERIES, FIXTURE_PATH } = require('../../../.agents/core/memory-eval');

describe('adopter-ship: memory-eval runs without the __tests__/ fixture', () => {
  it('falls back to inlined DEFAULT_QUERIES when the fixture is absent', () => {
    const absent = path.join('/nonexistent-adopter-path', 'memory-eval-queries.json');
    expect(fs.existsSync(absent)).toBe(false);
    const queries = loadFixture(absent);
    // Must be the inlined fallback, not a throw / process.exit.
    expect(queries).toBe(DEFAULT_QUERIES);
  });

  it('DEFAULT_QUERIES is a non-empty, well-formed query set', () => {
    expect(Array.isArray(DEFAULT_QUERIES)).toBe(true);
    expect(DEFAULT_QUERIES.length).toBeGreaterThan(0);
    for (const q of DEFAULT_QUERIES) {
      expect(typeof q.query).toBe('string');
      expect(q.query.length).toBeGreaterThan(0);
      expect(Array.isArray(q.expected)).toBe(true);
      expect(q.expected.length).toBeGreaterThan(0);
    }
  });

  it('the workshop fixture path lives under __tests__/ (the propagation-excluded dir)', () => {
    // Documents WHY the fallback is required: the canonical fixture is in a
    // directory that adopters never receive. If this assertion ever fails, the
    // fixture moved — re-evaluate whether the fallback is still needed.
    expect(FIXTURE_PATH.split(path.sep)).toContain('__tests__');
  });

  it('the workshop fixture (when present) is also well-formed', () => {
    // In this repo the fixture exists; loadFixture() with the default path must
    // parse it to an array. (Adopters skip this implicitly — different path.)
    if (!fs.existsSync(FIXTURE_PATH)) return; // adopter checkout: nothing to assert
    const data = loadFixture();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });
});
