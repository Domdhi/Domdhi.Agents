import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const fs = require('node:fs');
const { createTmpDir, withTmpDir } = require('../tmp-dir');

describe('createTmpDir', () => {
  // Track dirs created outside withTmpDir so we can clean up in afterEach.
  const created = [];

  afterEach(() => {
    for (const tmp of created) {
      tmp.cleanup();
    }
    created.length = 0;
  });

  it('factory_default_createsDirectoryWithPrefix', () => {
    // Arrange / Act
    const tmp = createTmpDir();
    created.push(tmp);

    // Assert
    expect(fs.existsSync(tmp.root)).toBe(true);
    expect(require('node:path').basename(tmp.root)).toMatch(/^domdhi-test-/);
  });

  it('write_thenRead_roundTripsContent', () => {
    // Arrange
    const tmp = createTmpDir();
    created.push(tmp);

    // Act
    tmp.write('hello.txt', 'hello');
    const result = tmp.read('hello.txt');

    // Assert
    expect(result).toBe('hello');
  });

  it('write_nestedPath_createsParentDirectories', () => {
    // Arrange
    const tmp = createTmpDir();
    created.push(tmp);

    // Act / Assert (no error thrown means parent dirs were created)
    expect(() => tmp.write('a/b/c.txt', 'nested')).not.toThrow();
    expect(tmp.read('a/b/c.txt')).toBe('nested');
  });

  it('mkdir_nestedPath_createsDirectory', () => {
    // Arrange
    const tmp = createTmpDir();
    created.push(tmp);
    const path = require('node:path');

    // Act
    const created_path = tmp.mkdir('x/y/z');

    // Assert
    expect(fs.existsSync(created_path)).toBe(true);
    expect(fs.statSync(path.join(tmp.root, 'x/y/z')).isDirectory()).toBe(true);
  });

  it('cleanup_afterUse_removesRoot', () => {
    // Arrange
    const tmp = createTmpDir();
    const rootPath = tmp.root;

    // Act
    tmp.cleanup();

    // Assert
    expect(fs.existsSync(rootPath)).toBe(false);
    // Don't push to created[] — already cleaned up
  });
});

describe('withTmpDir', () => {
  it('happyPath_cleansUpOnSuccess', async () => {
    // Arrange
    let capturedRoot;

    // Act
    await withTmpDir((tmp) => {
      capturedRoot = tmp.root;
      expect(fs.existsSync(capturedRoot)).toBe(true);
    });

    // Assert
    expect(fs.existsSync(capturedRoot)).toBe(false);
  });

  it('throwingFn_stillCleansUp', async () => {
    // Arrange
    let capturedRoot;

    // Act
    const act = withTmpDir((tmp) => {
      capturedRoot = tmp.root;
      throw new Error('intentional test error');
    });

    // Assert: error is re-thrown
    await expect(act).rejects.toThrow('intentional test error');
    // Assert: directory was cleaned up despite the throw
    expect(fs.existsSync(capturedRoot)).toBe(false);
  });
});
