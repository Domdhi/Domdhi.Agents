'use strict';
// Select at each operation, allowing one process to serve either runtime.
function backend() {
    const runtime = process.env.AGENTS_RUNTIME || process.env.AGENT_RUNTIME || (process.env.CODEX_PROJECT_DIR ? 'codex' : 'claude');
    if (runtime === 'claude') return require('../../adapters/claude/core/_lib/model-runner');
    if (runtime === 'codex') return require('../../adapters/codex/core/_lib/model-runner');
    throw new Error('A supported runtime is required for model operations.');
}
// Preserve the established import-time backend loading contract for consumers.
backend();
const policy = require('./model-policy');
module.exports = {
    checkCli: (...args) => (backend().checkCli || backend().checkClaudeCli)(...args),
    checkClaudeCli: (...args) => (backend().checkCli || backend().checkClaudeCli)(...args),
    checkCodexCli: (...args) => (backend().checkCli || backend().checkClaudeCli)(...args),
    invokeModel: (...args) => backend().invokeModel(...args),
    buildInvokeArgs: (...args) => backend().buildInvokeArgs(...args),
    parseExecEvents: (...args) => backend().parseExecEvents(...args),
    parseModelResult: policy.parseModelResult,
    tryParseInnerJson: policy.tryParseInnerJson,
    extractTokenCounts: policy.extractTokenCounts,
    get DEFAULT_MODEL() { return backend().DEFAULT_MODEL; },
    get DEFAULT_TIMEOUT_MS() { return backend().DEFAULT_TIMEOUT_MS; },
};
