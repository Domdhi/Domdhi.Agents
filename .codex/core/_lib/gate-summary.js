#!/usr/bin/env node
'use strict';
// Generated compatibility entry point from .agents/core/_lib/gate-summary.js.
if (!process.env.AGENTS_RUNTIME && !process.env.AGENT_RUNTIME) process.env.AGENTS_RUNTIME = 'codex';
const entry = require('path').resolve(__dirname, "../../../.agents/core/_lib/gate-summary.js");
if (require.main === module) {
    const result = require('child_process').spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.status === null ? 1 : result.status;
} else module.exports = require(entry);
