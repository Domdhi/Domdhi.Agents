#!/usr/bin/env node
'use strict';
// Generated compatibility entry point from .agents/hooks/commit-guard.cjs.
// Blocking hook: fail closed. Only a clean exit 0 passes; a crash, a spawn error, a signal or a timeout exits 2.
if (!process.env.AGENTS_RUNTIME && !process.env.AGENT_RUNTIME) process.env.AGENTS_RUNTIME = 'codex';
const entry = require('path').resolve(__dirname, "../../.agents/hooks/commit-guard.cjs");
if (require.main === module) {
    const result = require('child_process').spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
    if (result.error || result.signal || result.status === null) {
        process.stderr.write('[commit-guard] BLOCKED (fail-closed): the hook did not finish (' + ((result.error && result.error.code) || result.signal || 'no exit status') + ').\n');
        process.exitCode = 2;
    } else process.exitCode = result.status === 0 ? 0 : 2;
} else module.exports = require(entry);
