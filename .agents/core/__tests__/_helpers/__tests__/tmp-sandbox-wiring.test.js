import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..', '..');

// These two tests fail if the vitest config stops registering the sandbox setup file: without it every
// test file is back to leaking into the real temp dir.
describe('tmp-sandbox vitest wiring', () => {
  it('config_setupFiles_registersTheTmpSandboxSetupFile', () => {
    // Arrange
    const config = fs.readFileSync(path.join(repoRoot, 'vitest.config.mjs'), 'utf8');
    const match = /setupFiles:\s*\[\s*'(\.\/[^']+)'\s*\]/.exec(config);

    // Assert: registered, and the registered file exists
    expect(match, 'the vitest config must list the tmp-sandbox setup file under test.setupFiles').not.toBeNull();
    expect(path.basename(match[1])).toBe('vitest-tmp-sandbox.setup.mjs');
    expect(fs.existsSync(path.join(repoRoot, match[1]))).toBe(true);
  });

  // Skipped when the suite is deliberately run with DOMDHI_TEST_TMP_SANDBOX=off (the way a leaking test is found).
  it.skipIf(/^(off|0|false)$/i.test(process.env.DOMDHI_TEST_TMP_SANDBOX || ''))('setupFile_activeInThisWorker_keepsOsTmpdirInsideAPrivateSandbox', () => {
    // Assert: the setup file ran before this file's tests, so scratch space is already sandboxed
    expect(path.basename(os.tmpdir())).toMatch(/^domdhi-tmpbox-/);
  });
});
