// Vitest setupFile: give every test file its own temp sandbox and remove it when the file finishes.
// See tmp-sandbox.js for what that covers and how to turn it off.
import { afterAll, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { enterTmpSandbox, leaveTmpSandbox } = require('./tmp-sandbox');

// Enter in beforeAll, which vitest runs only for a file that has a test to run, exactly when afterAll runs.
// Entering at import time would leave an empty sandbox behind for a file whose tests are all skipped, because
// vitest runs no hooks for it. A test file's own module-scope temp work therefore stays outside the sandbox
// and must clean up after itself (memory-capture.test.js does).
beforeAll(() => { enterTmpSandbox(); });
afterAll(() => { leaveTmpSandbox(); });
