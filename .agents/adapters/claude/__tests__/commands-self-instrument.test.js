// Meta-test: every user-typed slash command self-instruments.
//
// User-typed slash commands do NOT fire PostToolUse:Skill in Claude Code 2.x
// (the documented coverage gap in command-usage-logger.cjs), so each command
// markdown must self-log its invocation via telemetry-log.js or it leaves no
// command_invocation row — and fleet command-usage analytics under-count
// human-driven sessions. This was the headline finding of an adopter's
// v4.48.0 feedback run (only /onboard self-instrumented). This test is the
// regression guard: it fails closed if any command (or any newly-added one)
// drops the preamble or logs the wrong name.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const COMMANDS_DIR = path.resolve(__dirname, '..', '..', '..', '..', '.claude', 'commands');

/** Recursively collect every *.md under .claude/commands. */
function listCommandFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listCommandFiles(full));
        else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
    }
    return out;
}

/** Derive the canonical command name from a path: review/feedback.md → review:feedback. */
function commandName(file) {
    const rel = path.relative(COMMANDS_DIR, file).replace(/\.md$/, '');
    return rel.split(path.sep).join(':');
}

const files = listCommandFiles(COMMANDS_DIR);

describe('command self-instrumentation', () => {
    it('finds the command set', () => {
        // Guard against a glob that silently matches nothing.
        expect(files.length).toBeGreaterThan(10);
    });

    it.each(files)('%s calls telemetry-log.js with its canonical name', (file) => {
        const body = fs.readFileSync(file, 'utf8');
        const name = commandName(file);
        // The preamble must invoke the self-instrument tool with THIS command's
        // name. Matching the name (not just the script path) catches copy-paste
        // rollout errors where a command logs a sibling's name.
        const re = new RegExp(
            String.raw`telemetry-log\.js\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`
        );
        expect(body, `${name} is missing its telemetry-log.js self-instrument call`).toMatch(re);
    });
});
