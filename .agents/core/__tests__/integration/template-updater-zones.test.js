/**
 * Integration test: template-updater zone-merge semantics
 *
 * Creates two isolated tmp-dir trees (source + target) and invokes
 * template-updater.js via subprocess, asserting that:
 *   - template-zone files get overwritten
 *   - project-zone files (settings.json) are never touched
 *   - orphan files in target stay untouched
 *   - new files in source are copied into target
 *   - dry-run makes no changes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('../_helpers/tmp-dir');

const __filename = fileURLToPath(import.meta.url);
// Resolve from integration/ → __tests__/ → core/ → template-updater.js
const UPDATER_PATH = path.resolve(path.dirname(__filename), '..', '..', 'template-updater.js');

/**
 * Invoke template-updater.js as a subprocess.
 *
 * CLAUDE_PROJECT_DIR points at sourceRoot so the updater reads the source .claude/.
 * targetRoot is passed as the positional <target> argument.
 * Any extra args (e.g. '--dry-run') are appended after 'update'.
 */
function runUpdater(sourceRoot, targetRoot, ...extraArgs) {
    const real = fs.realpathSync.native(targetRoot);
    const env = { ...process.env, CLAUDE_PROJECT_DIR: sourceRoot };
    for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
    const args = [UPDATER_PATH, 'update', real, ...extraArgs];
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    try {
        stdout = execFileSync('node', args, {
            encoding: 'utf8',
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (err) {
        exitCode = err.status ?? 1;
        stdout = err.stdout?.toString() ?? '';
        stderr = err.stderr?.toString() ?? '';
    }
    return { exitCode, stdout, stderr };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

let sourceTmp, targetTmp;

beforeEach(() => {
    sourceTmp = createTmpDir({ prefix: 'updater-src-' });
    targetTmp = createTmpDir({ prefix: 'updater-tgt-' });

    // ── Source tree (pointed at by CLAUDE_PROJECT_DIR) ──────────────────────
    //
    // Files must live under {root}/.claude/ for the updater to find them.
    // All three files are in template zones (core/*.js, version.json,
    // commands/**/*.md) so they will be overwritten or copied.

    // Template zone: core/*.js — will overwrite target's copy
    sourceTmp.write('.claude/core/gate.js', 'NEW SOURCE GATE CONTENT\n');

    // Template zone: version.json — copied last as sync-complete marker
    sourceTmp.write('.claude/version.json', '{"version":"2.0.0"}\n');

    // Template zone: commands/**/*.md — does NOT exist in target → new file
    sourceTmp.write('.claude/commands/new-cmd.md', '# new command\n');

    // Project zone (PROJECT_FILES): present in source so the updater encounters
    // it during the walk and logs SKIP. The source copy is intentionally
    // different from the target copy — if the updater overwrites, the test fails.
    sourceTmp.write('.claude/settings.json', '{"source":"template-default"}\n');

    // ── Target tree (receives the update) ───────────────────────────────────
    //
    // Must have .claude/ to pass the prereq check at template-updater.js:470.

    // Template zone: will be overwritten by source's version
    targetTmp.write('.claude/core/gate.js', 'OLD TARGET GATE CONTENT\n');

    // Project zone (PROJECT_FILES): settings.json — must never be touched
    targetTmp.write('.claude/settings.json', '{"mine":"keep this"}\n');

    // Orphan: exists in target but NOT in source — updater must leave it alone
    // (walkDir only walks source, so orphans are never considered)
    targetTmp.write('.claude/extra-file.txt', 'orphan — not in source\n');
});

afterEach(() => {
    sourceTmp.cleanup();
    targetTmp.cleanup();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('template-updater zone-merge integration', () => {

    it('dryRun_doesNotModifyTarget', () => {
        // Snapshot target state before dry run
        const gateBefore = targetTmp.read('.claude/core/gate.js');
        const settingsBefore = targetTmp.read('.claude/settings.json');
        const extraBefore = targetTmp.read('.claude/extra-file.txt');

        const result = runUpdater(sourceTmp.root, targetTmp.root, '--dry-run');

        // Dry run must succeed (exit 0)
        expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

        // Target files must be unchanged after dry run
        expect(targetTmp.read('.claude/core/gate.js')).toBe(gateBefore);
        expect(targetTmp.read('.claude/settings.json')).toBe(settingsBefore);
        expect(targetTmp.read('.claude/extra-file.txt')).toBe(extraBefore);

        // Dry run stdout must list COPY actions (it still logs what it would do)
        expect(result.stdout).toMatch(/COPY/);

        // Dry run summary must mention "Dry run complete"
        expect(result.stdout).toMatch(/Dry run complete/);
    });

    it('realRun_overwritesTemplateZoneFiles', () => {
        const result = runUpdater(sourceTmp.root, targetTmp.root);

        expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

        // core/gate.js is in template zone (core/*.js) — must be overwritten
        expect(targetTmp.read('.claude/core/gate.js')).toBe('NEW SOURCE GATE CONTENT\n');

        // version.json is in template zone — copied last as sync marker
        expect(targetTmp.read('.claude/version.json')).toBe('{"version":"2.0.0"}\n');
    });

    it('realRun_noMerge_preservesProjectZoneFiles', () => {
        // Merging is the default (NA7.14); --no-merge is the opt-out that leaves settings.json alone.
        const result = runUpdater(sourceTmp.root, targetTmp.root, '--no-merge');

        expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

        // settings.json is in PROJECT_FILES — without the merge the updater must never write to it
        // even though a different version exists in the source tree.
        expect(targetTmp.read('.claude/settings.json')).toBe('{"mine":"keep this"}\n');

        // The updater logs a SKIP line when it encounters a project-zone file
        expect(result.stdout).toMatch(/SKIP.*settings\.json.*project zone/);
    });

    it('realRun_defaultMerge_keepsTheProjectOwnedSettingsKeys', () => {
        const result = runUpdater(sourceTmp.root, targetTmp.root);

        expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

        // The default section-aware merge keeps every project-owned key it does not own.
        expect(JSON.parse(targetTmp.read('.claude/settings.json'))).toMatchObject({ mine: 'keep this' });
        expect(result.stdout).not.toMatch(/SKIP.*settings\.json.*project zone/);
    });

    it('realRun_leavesOrphansUntouched', () => {
        const result = runUpdater(sourceTmp.root, targetTmp.root);

        expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

        // extra-file.txt is not in source — updater only walks source, so this
        // file is never considered and must remain exactly as it was
        expect(targetTmp.read('.claude/extra-file.txt')).toBe('orphan — not in source\n');
    });

    it('realRun_copiesNewFilesFromSource', () => {
        const result = runUpdater(sourceTmp.root, targetTmp.root);

        expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

        // commands/new-cmd.md exists only in source — must be copied into target
        const copiedPath = path.join(targetTmp.root, '.claude', 'commands', 'new-cmd.md');
        expect(fs.existsSync(copiedPath), 'new-cmd.md should have been copied').toBe(true);
        expect(fs.readFileSync(copiedPath, 'utf8')).toBe('# new command\n');
    });
});
