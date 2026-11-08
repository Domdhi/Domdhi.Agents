// Vitest globalSetup: say, once and clearly, when the secret engine is not installed.
// The secret-engine suites run the real binary (there is no stub), so without it they fail; the
// tests that need it each fail with their own message, and this line explains the whole batch.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default function warnWhenSecretEngineIsMissing() {
    const bin = require('../../../core/_lib/secret-engine-bin');
    const status = bin.engineStatus({ fresh: true });
    if (!status.available) {
        console.warn(`\n[secret-engine] ${status.message}\n  The secret-engine suites (and anything that commits through commit.js) need it. ${bin.installHint()}\n`);
    }
}
