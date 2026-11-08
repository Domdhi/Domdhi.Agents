'use strict';

/**
 * The version of the contract between the managed git hook shims (git-hooks.js) and the scanner they run
 * (hooks/secret-scanner.cjs): the CLI modes `--git-precommit`, `--commit-msg`, `--pre-push`, `--hook-bypass`
 * and `--hook-protocol`, and their exit codes.
 *
 * The scanner prints `domdhi-agents-hook-protocol <N>` for `--hook-protocol`. A shim written for protocol P
 * refuses a scanner that prints less (or nothing: a checkout whose toolkit predates the managed hooks has a
 * scanner that does not know the flag and would read the shim's call as a Claude Write/Edit event and exit 0,
 * i.e. scan nothing). Bump this when a shim starts relying on behavior an older scanner lacks.
 */
const GIT_HOOK_PROTOCOL = 2;
const PROTOCOL_LINE_PREFIX = 'domdhi-agents-hook-protocol ';

module.exports = { GIT_HOOK_PROTOCOL, PROTOCOL_LINE_PREFIX };
