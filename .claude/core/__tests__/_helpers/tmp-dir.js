/**
 * Shared tmp-dir helper for test suites.
 * CommonJS (not ESM) — loaded via createRequire() bridge in test files.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Creates a temporary directory and returns a helper object for working inside it.
 *
 * @param {{ prefix?: string }} [options]
 * @returns {{ root: string, write: Function, mkdir: Function, read: Function, cleanup: Function }}
 */
function createTmpDir({ prefix = 'domdhi-test-' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  return {
    root,
    // `path` is an alias for `root` — some suites (fs-safe.test.js) refer to the
    // tmp base as `tmp.path`. Additive, kept in sync with `root`.
    path: root,

    /**
     * Write content to a relative path inside root, creating parent dirs as needed.
     * @param {string} relPath
     * @param {string} content
     * @returns {string} absolute path written
     */
    write(relPath, content) {
      const full = path.join(root, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      return full;
    },

    /**
     * Create a directory (and any parents) inside root.
     * @param {string} relPath
     * @returns {string} absolute path created
     */
    mkdir(relPath) {
      const full = path.join(root, relPath);
      fs.mkdirSync(full, { recursive: true });
      return full;
    },

    /**
     * Read a file inside root as UTF-8 text.
     * @param {string} relPath
     * @returns {string}
     */
    read(relPath) {
      return fs.readFileSync(path.join(root, relPath), 'utf8');
    },

    /**
     * Remove the entire tmp directory tree.
     *
     * Windows-resilient: a test may leave a background subprocess holding a handle
     * inside root when cleanup runs — e.g. session-start-prime's fire-and-forget
     * FTS-index rebuild (`child.unref()`), which opens the db under root. POSIX
     * unlinks an open file fine; Windows throws EPERM/EBUSY. The assertions have
     * already completed by afterEach, so a lingering lock is not a test failure:
     * retry (Node's documented remedy for this) and, if a handle is still stubborn,
     * swallow only the lock codes (the OS reaps the temp dir) — never mask a real error.
     */
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (err) {
        if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'ENOTEMPTY') throw err;
      }
    },
  };
}

/**
 * Async wrapper: creates a tmp dir, passes it to fn, cleans up in finally.
 *
 * @param {(tmp: ReturnType<typeof createTmpDir>) => Promise<any>} fn
 * @returns {Promise<any>}
 */
async function withTmpDir(fn) {
  const tmp = createTmpDir();
  try {
    return await fn(tmp);
  } finally {
    tmp.cleanup();
  }
}

module.exports = { createTmpDir, withTmpDir };
