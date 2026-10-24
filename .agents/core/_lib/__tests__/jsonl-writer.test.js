// AC→source map (Task #4 / jsonl-writer):
//   Single export: appendJsonl(path, entry, {maxLines, tailKeep, onError})
//   Semantics: append one JSON.stringify'd line, rotate tail when over maxLines.
//   Must be silent on I/O failure (telemetry MUST NOT break calling flow).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const fs = require('node:fs');
const path = require('node:path');
const { appendJsonl } = require('../../../../.agents/core/_lib/jsonl-writer');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');

let tmp;
beforeEach(() => { tmp = createTmpDir({ prefix: 'jsonl-writer-' }); });
afterEach(() => { tmp.cleanup(); vi.restoreAllMocks(); });

describe('appendJsonl', () => {

  it('appendJsonl_singleEntry_createsFileWithOneLine', () => {
    const jsonlPath = path.join(tmp.root, 'out.jsonl');
    appendJsonl(jsonlPath, { type: 'test', n: 1 });
    const content = fs.readFileSync(jsonlPath, 'utf8');
    expect(content).toBe('{"type":"test","n":1}\n');
  });

  it('appendJsonl_createsParentDirectoriesIfMissing', () => {
    const jsonlPath = path.join(tmp.root, 'nested', 'deep', 'out.jsonl');
    appendJsonl(jsonlPath, { x: 1 });
    expect(fs.existsSync(jsonlPath)).toBe(true);
  });

  it('appendJsonl_multipleCalls_accumulateLines', () => {
    const jsonlPath = path.join(tmp.root, 'out.jsonl');
    appendJsonl(jsonlPath, { n: 1 });
    appendJsonl(jsonlPath, { n: 2 });
    appendJsonl(jsonlPath, { n: 3 });
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toEqual({ n: 1 });
    expect(JSON.parse(lines[2])).toEqual({ n: 3 });
  });

  it('appendJsonl_exceedsMaxLines_rotatesToTailKeep', () => {
    const jsonlPath = path.join(tmp.root, 'out.jsonl');
    // Fill to maxLines + 1 → rotation fires on the final append
    for (let i = 0; i < 11; i++) {
      appendJsonl(jsonlPath, { n: i }, { maxLines: 10, tailKeep: 5 });
    }
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(5);
    // After rotation, only the last 5 survive: n=6..10
    expect(JSON.parse(lines[0])).toEqual({ n: 6 });
    expect(JSON.parse(lines[4])).toEqual({ n: 10 });
  });

  it('appendJsonl_underMaxLines_noRotation', () => {
    const jsonlPath = path.join(tmp.root, 'out.jsonl');
    for (let i = 0; i < 5; i++) {
      appendJsonl(jsonlPath, { n: i }, { maxLines: 10, tailKeep: 5 });
    }
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(5);
  });

  it('appendJsonl_writeFailure_silentNoThrow', () => {
    // Trigger a reliable write failure by pointing at a path that's already a directory.
    // fs.appendFileSync(<dir>) throws EISDIR on every platform.
    const dirAsPath = tmp.mkdir('as-directory');
    expect(() => appendJsonl(dirAsPath, { x: 1 })).not.toThrow();
  });

  it('appendJsonl_onErrorCallback_invokedOnFailure', () => {
    const dirAsPath = tmp.mkdir('as-directory-2');
    let caught = null;
    appendJsonl(dirAsPath, { x: 1 }, { onError: (msg) => { caught = msg; } });
    expect(typeof caught).toBe('string');
    expect(caught.length).toBeGreaterThan(0);
  });

  it('appendJsonl_onErrorThrows_swallowsToPreventCascadingFailure', () => {
    const dirAsPath = tmp.mkdir('as-directory-3');
    const brokenLogger = () => { throw new Error('logger broke'); };
    // Even if onError itself throws, appendJsonl must not propagate
    expect(() =>
      appendJsonl(dirAsPath, { x: 1 }, { onError: brokenLogger })
    ).not.toThrow();
  });

  describe('rotation atomicity (write-temp + rename)', () => {

    it('appendJsonl_rotation_usesWriteTempThenAtomicRename', () => {
      // Proves the SHAPE actually implemented: writeFileSync targets a temp path
      // (never the live jsonlPath) and renameSync swaps it into place — not a
      // direct writeFileSync onto jsonlPath (which would have a truncation window).
      //
      // Note: Node's fs.appendFileSync is itself implemented as a pass-through call
      // to fs.writeFileSync internally (with an options object carrying flag: 'a'),
      // so spying on writeFileSync also captures every ordinary append call, not
      // just the rotation's direct write. Distinguish rotation's own direct call —
      // `fs.writeFileSync(tmpPath, trimmed, 'utf8')`, a bare 'utf8' 3rd arg — from
      // appendFileSync's internal passthrough, which always passes an options object.
      const jsonlPath = path.join(tmp.root, 'out.jsonl');
      const writeSpy = vi.spyOn(fs, 'writeFileSync');
      const renameSpy = vi.spyOn(fs, 'renameSync');

      for (let i = 0; i < 11; i++) {
        appendJsonl(jsonlPath, { n: i }, { maxLines: 10, tailKeep: 5 });
      }

      const directWrites = writeSpy.mock.calls.filter(([, , opts]) => typeof opts === 'string');

      // Rotation's direct writeFileSync call must never target jsonlPath itself.
      expect(directWrites.filter(([p]) => p === jsonlPath)).toHaveLength(0);

      // It must write to exactly one sibling temp path derived from jsonlPath...
      const tempWrites = directWrites.filter(
        ([p]) => typeof p === 'string' && p.startsWith(`${jsonlPath}.tmp-`)
      );
      expect(tempWrites).toHaveLength(1);
      const tmpPathUsed = tempWrites[0][0];

      // ...and renameSync must swap that exact temp path onto jsonlPath.
      expect(renameSpy).toHaveBeenCalledWith(tmpPathUsed, jsonlPath);

      // No stray temp file left behind after a successful rotation.
      expect(fs.existsSync(tmpPathUsed)).toBe(false);
      expect(fs.existsSync(jsonlPath)).toBe(true);
    });

    it('appendJsonl_rotation_neverExposesTruncatedFileToConcurrentReader', () => {
      // fs sync calls don't yield mid-call, so two appendJsonl invocations can't
      // literally interleave in a single-threaded test. Instead, assert the
      // mechanism guarantee directly: hook renameSync (the swap point) and read
      // the file from that vantage point — it must already be the FULL rotated
      // content, never a truncated/zero-length intermediate (which the old
      // direct-writeFileSync implementation could expose to a concurrent reader).
      const jsonlPath = path.join(tmp.root, 'out.jsonl');
      let observedAtRenameTime = null;
      const realRenameSync = fs.renameSync.bind(fs);

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        // Immediately before the swap, jsonlPath still holds PRE-rotation content
        // (never truncated) — the old file is untouched until rename lands.
        observedAtRenameTime = fs.readFileSync(jsonlPath, 'utf8');
        return realRenameSync(from, to);
      });

      for (let i = 0; i < 11; i++) {
        appendJsonl(jsonlPath, { n: i }, { maxLines: 10, tailKeep: 5 });
      }

      renameSpy.mockRestore();

      // At the moment of rename, the live file was still fully intact (11 lines,
      // pre-rotation) — never zero-length or partially written.
      const preRotationLines = observedAtRenameTime.trim().split('\n');
      expect(preRotationLines).toHaveLength(11);

      // After rename completes, the final file is the correctly tail-sampled result.
      const finalLines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
      expect(finalLines).toHaveLength(5);
      expect(JSON.parse(finalLines[0])).toEqual({ n: 6 });
      expect(JSON.parse(finalLines[4])).toEqual({ n: 10 });
    });

    it('appendJsonl_renameFails_cleansUpTempFileInsteadOfLeakingIt', () => {
      // Wave 5 review NIT: a renameSync failure (Windows EPERM/EBUSY; practically
      // never on Linux/WSL) must not leave the .tmp-* file behind forever.
      const jsonlPath = path.join(tmp.root, 'out.jsonl');
      let tmpPathSeen = null;

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from) => {
        tmpPathSeen = from;
        throw new Error('simulated EPERM');
      });

      // appendJsonl swallows errors silently (its documented contract) — must
      // not throw even though the rename inside it does.
      expect(() => {
        for (let i = 0; i < 11; i++) {
          appendJsonl(jsonlPath, { n: i }, { maxLines: 10, tailKeep: 5 });
        }
      }).not.toThrow();

      renameSpy.mockRestore();

      expect(tmpPathSeen).toMatch(new RegExp(`^${jsonlPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp-`));
      expect(fs.existsSync(tmpPathSeen)).toBe(false);
    });

  });

});
