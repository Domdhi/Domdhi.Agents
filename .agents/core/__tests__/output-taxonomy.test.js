import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { OUTPUT_PATHS } = require('../../../.agents/core/constants');
const op = require('../../../.agents/core/_lib/output-paths');

/**
 * Guard test for the .output taxonomy (ADR 0006), part 1: the OUTPUT_PATHS
 * registry's internal invariants. This is the always-on, shipped half of the
 * guard — it fails CI if the single-source registry ever drifts into an illegal
 * shape, so the helper and every prose producer that mirrors a `dir` string have
 * a sound contract to lint against.
 *
 * NOTE: the docs/CLAUDE.md ⇄ .output/CLAUDE.md textual cross-checks (the other
 * half of "part 1") are added in the waves that rewrite those docs to the new
 * layout — asserting them before the docs are migrated would red the gate against
 * a doc that still describes the old flat layout.
 */

const ZONES = new Set(['durable', 'state']);
const SHAPES = new Set(['discrete', 'daylog', 'rununit']);
const BUCKETS = new Set(['month', 'week', 'none']);

const entries = Object.entries(OUTPUT_PATHS);
const leaves = entries.filter(([, v]) => !v.group);
const groups = entries.filter(([, v]) => v.group);

describe('OUTPUT_PATHS registry — invariants', () => {
  it('every entry is either a group or a well-formed leaf', () => {
    for (const [key, v] of entries) {
      expect(typeof v.dir, `${key}.dir`).toBe('string');
      expect(v.dir.length, `${key}.dir non-empty`).toBeGreaterThan(0);
      if (v.group) {
        // groups hold no files — no zone/shape/bucket
        expect(v.zone, `${key} group has no zone`).toBeUndefined();
        expect(v.shape, `${key} group has no shape`).toBeUndefined();
      } else {
        expect(ZONES.has(v.zone), `${key}.zone=${v.zone}`).toBe(true);
        expect(BUCKETS.has(v.bucket), `${key}.bucket=${v.bucket}`).toBe(true);
        // `managed` entries (the memory store) are owned by their own subsystem,
        // not output-paths.js — they carry no shape and are exempt from it.
        if (!v.managed) {
          expect(SHAPES.has(v.shape), `${key}.shape=${v.shape}`).toBe(true);
        } else {
          expect(v.shape, `${key} managed has no shape`).toBeUndefined();
        }
      }
    }
  });

  it('dirs are .output-relative — no leading/trailing slash, no docs/.output prefix', () => {
    for (const [key, v] of entries) {
      expect(v.dir.startsWith('/'), `${key} no leading slash`).toBe(false);
      expect(v.dir.endsWith('/'), `${key} no trailing slash`).toBe(false);
      expect(v.dir.includes('docs/.output'), `${key} no docs/.output prefix`).toBe(false);
    }
  });

  it('grouped sub-compartments nest correctly under an existing group', () => {
    for (const [key, v] of leaves) {
      if (!key.includes('/') || key.startsWith('state/')) continue; // state/* is a flat namespace, not a group
      const parentKey = key.slice(0, key.lastIndexOf('/'));
      const parent = OUTPUT_PATHS[parentKey];
      expect(parent, `parent "${parentKey}" of "${key}" exists`).toBeTruthy();
      expect(parent.group, `parent "${parentKey}" is a group`).toBe(true);
      expect(v.dir.startsWith(parent.dir + '/'), `${key}.dir under ${parent.dir}/`).toBe(true);
    }
  });

  it('every group has at least one sub-compartment', () => {
    for (const [key] of groups) {
      const subs = leaves.filter(([k]) => k.startsWith(key + '/'));
      expect(subs.length, `group "${key}" has sub-compartments`).toBeGreaterThan(0);
    }
  });

  it('state-zone leaves live under .state/ and are flat (bucket:none)', () => {
    for (const [key, v] of leaves) {
      if (v.zone !== 'state') continue;
      expect(v.dir.startsWith('.state/'), `${key}.dir under .state/`).toBe(true);
      expect(v.bucket, `${key} state is flat`).toBe('none');
    }
  });

  it('durable-zone leaves are NOT under .state/ and ARE bucketed', () => {
    for (const [key, v] of leaves) {
      if (v.zone !== 'durable') continue;
      expect(v.dir.startsWith('.state/'), `${key} durable not under .state/`).toBe(false);
      // The `.memory/` source is tracked-durable but machine-managed: a curated
      // store, not a month-bucketed compartment. Exempt it from the bucket rule.
      if (v.managed) continue;
      expect(v.bucket === 'month' || v.bucket === 'week', `${key} durable bucketed`).toBe(true);
    }
  });
});

describe('OUTPUT_PATHS registry — helper resolves every leaf', () => {
  it('each leaf kind composes a path under its own dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'output-taxonomy-test-'));
    try {
      for (const [key, v] of leaves) {
        if (v.managed) continue; // memory store isn't helper-written
        let p;
        if (v.shape === 'daylog') p = op.dayLogPath(key, { cwd: tmp });
        else if (v.shape === 'rununit') p = op.runUnitDir(key, { slug: 'x', cwd: tmp });
        else p = op.outputPath(key, { slug: 'x', cwd: tmp });
        expect(p.startsWith(`docs/.output/${v.dir}/`), `${key} → ${p}`).toBe(true);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
