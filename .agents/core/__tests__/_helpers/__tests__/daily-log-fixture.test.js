// AC→source map (TDD-3.3 / daily-log-fixture):
//   - Fixture sections MUST be omitted when field is empty/absent
//   - extractKeywords returns a Set; length>2 filter; no ranking
//   - ingested branch name explicitly skipped by extractKeywords

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const fs = require('node:fs');
const { createDailyLog, buildEntry } = require('../daily-log-fixture');
const { createTmpDir } = require('../tmp-dir');
const MemoryCompiler = require('../../../../../.agents/core/memory-compiler');

// Note: path from `_helpers/__tests__/foo.test.js`:
//   tmp-dir helper lives at `_helpers/` → `../tmp-dir`
//   daily-log-fixture lives at `_helpers/` → `../daily-log-fixture`
//   memory-compiler.js lives at `.claude/core/` → `../../../memory-compiler`

describe('daily-log-fixture', () => {
  const created = [];

  afterEach(() => {
    for (const tmp of created) {
      tmp.cleanup();
    }
    created.length = 0;
  });

  it('createDailyLog_emptyEntries_createsFileWithNoChunks', () => {
    // Arrange
    const tmp = createTmpDir();
    created.push(tmp);
    const compiler = new MemoryCompiler();
    // Override dirs to use tmp
    const origEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
    const tmpCompiler = new MemoryCompiler();
    if (origEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origEnv;

    // Act
    const writtenPath = createDailyLog(tmp, '2026-04-15', []);

    // Assert
    expect(fs.existsSync(writtenPath)).toBe(true);
    const content = fs.readFileSync(writtenPath, 'utf8');
    const entries = tmpCompiler.parseDailyFile(content, '2026-04-15');
    expect(entries).toEqual([]);
  });

  it('createDailyLog_singleMinimalEntry_parsesToOneEntry', () => {
    // Arrange
    const tmp = createTmpDir();
    created.push(tmp);
    const origEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
    const compiler = new MemoryCompiler();
    if (origEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origEnv;

    // Act
    const writtenPath = createDailyLog(tmp, '2026-04-15', [
      { time: '10:00', trigger: 'Pre-Compaction' }
    ]);
    const content = fs.readFileSync(writtenPath, 'utf8');
    const entries = compiler.parseDailyFile(content, '2026-04-15');

    // Assert
    expect(entries).toHaveLength(1);
    expect(entries[0].time).toBe('10:00');
    expect(entries[0].date).toBe('2026-04-15');
  });

  it('createDailyLog_fullEntry_extractsAllKeywords', () => {
    // Arrange
    const tmp = createTmpDir();
    created.push(tmp);
    const origEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
    const compiler = new MemoryCompiler();
    if (origEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origEnv;

    // Act
    const writtenPath = createDailyLog(tmp, '2026-04-15', [
      {
        time: '10:00',
        trigger: 'Pre-Compaction',
        branch: 'feat-oauth-login',
        commits: [{ hash: 'abc1234', message: 'feat: oauth middleware' }],
        inProgress: ['OAuth Integration'],
        decisions: ['Use JWT'],
      }
    ]);
    const content = fs.readFileSync(writtenPath, 'utf8');
    const entries = compiler.parseDailyFile(content, '2026-04-15');

    // Assert
    expect(entries).toHaveLength(1);
    const keywords = compiler.extractKeywords(entries[0]);
    expect(keywords instanceof Set).toBe(true);
    // Branch tokens: feat, oauth, login
    expect(keywords.has('feat')).toBe(true);
    expect(keywords.has('oauth')).toBe(true);
    expect(keywords.has('login')).toBe(true);
    // Commit subject words (after type-prefix strip): oauth, middleware
    expect(keywords.has('middleware')).toBe(true);
    // In-progress: oauth, integration
    expect(keywords.has('integration')).toBe(true);
    // Decision: jwt (> 2 chars)
    expect(keywords.has('jwt')).toBe(true);
    // All tokens must have length > 2
    for (const token of keywords) {
      expect(token.length).toBeGreaterThan(2);
    }
  });

  it('createDailyLog_multipleEntries_allParsed', () => {
    // Arrange
    const tmp = createTmpDir();
    created.push(tmp);
    const origEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
    const compiler = new MemoryCompiler();
    if (origEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origEnv;

    // Act
    const writtenPath = createDailyLog(tmp, '2026-04-15', [
      { time: '09:00', trigger: 'Pre-Compaction' },
      { time: '10:00', trigger: 'Stop' },
      { time: '11:00', trigger: 'PostBash' },
    ]);
    const content = fs.readFileSync(writtenPath, 'utf8');
    const entries = compiler.parseDailyFile(content, '2026-04-15');

    // Assert
    expect(entries).toHaveLength(3);
    expect(entries[0].time).toBe('09:00');
    expect(entries[1].time).toBe('10:00');
    expect(entries[2].time).toBe('11:00');
  });

  it('createDailyLog_returnsWrittenPath', () => {
    // Arrange
    const tmp = createTmpDir();
    created.push(tmp);

    // Act
    const result = createDailyLog(tmp, '2026-04-15', [
      { time: '08:00', trigger: 'Pre-Compaction' }
    ]);

    // Assert: result is absolute path and file exists
    expect(typeof result).toBe('string');
    expect(require('node:path').isAbsolute(result)).toBe(true);
    expect(fs.existsSync(result)).toBe(true);
  });
});
