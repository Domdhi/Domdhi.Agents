/**
 * package-skill.js — Package a skill folder into a distributable archive.
 *
 * Usage:
 *   node .claude/skills/skill-creator/scripts/package-skill.js <skill-dir> [--out <path>]
 *
 * Prefers `zip` (produces <name>.skill) if available on PATH;
 * falls back to `tar -czf` (produces <name>.skill.tgz) otherwise.
 * Prints the resulting artifact path on success.
 *
 * Zero npm dependencies — shells out via child_process.execFileSync only.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync } = require('child_process');
const { parseArgs, ensureDir } = require('./utils.js');

/**
 * Check whether a CLI tool is available on PATH.
 * @param {string} tool
 * @returns {boolean}
 */
function isOnPath(tool) {
    try {
        // `command -v` is POSIX; works on Linux/macOS/WSL.
        execSync(`command -v ${tool}`, { stdio: 'ignore', shell: true });
        return true;
    } catch {
        return false;
    }
}

/**
 * Package a skill directory into an archive.
 * Exported so other scripts can call this programmatically.
 *
 * @param {string} skillDir   absolute path to the skill directory
 * @param {string|null} outPath  explicit output path (without extension); null → same dir as skillDir
 * @returns {string}  path to the created archive
 */
function packageSkill(skillDir, outPath = null) {
    if (!fs.existsSync(skillDir)) {
        throw new Error(`skill directory not found: ${skillDir}`);
    }

    const skillName = path.basename(skillDir);
    const destDir = outPath ? path.dirname(outPath) : path.dirname(skillDir);
    const baseName = outPath ? path.basename(outPath) : skillName;

    ensureDir(destDir);

    const useZip = isOnPath('zip');

    if (useZip) {
        const archiveName = `${baseName}.skill`;
        const archivePath = path.join(destDir, archiveName);

        // zip needs a relative source; use a temp copy in destDir if skillDir is
        // inside destDir already (ok), otherwise stage to a temp dir.
        let workDir = path.dirname(skillDir);
        let sourceArg = skillName;

        // If skillDir is not under destDir we stage to a tempDir to keep paths clean.
        let tempDir = null;
        if (!skillDir.startsWith(destDir + path.sep) && skillDir !== destDir) {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-skill-'));
            const staged = path.join(tempDir, skillName);
            copyDirSync(skillDir, staged);
            workDir = tempDir;
            sourceArg = skillName;
        }

        try {
            execFileSync('zip', ['-r', archivePath, sourceArg], {
                cwd: workDir,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } finally {
            if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
        }

        return archivePath;
    }

    // Fallback: tar
    if (isOnPath('tar')) {
        const archiveName = `${baseName}.skill.tgz`;
        const archivePath = path.join(destDir, archiveName);
        const parentDir = path.dirname(skillDir);

        execFileSync(
            'tar',
            ['-czf', archivePath, '-C', parentDir, skillName],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );

        return archivePath;
    }

    throw new Error('Neither `zip` nor `tar` found on PATH — cannot package skill.');
}

/**
 * Recursively copy a directory (no symlink special-casing).
 * @param {string} src
 * @param {string} dest
 */
function copyDirSync(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirSync(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function main(argv) {
    const args = parseArgs(argv);
    const skillDirInput = args._[0];
    if (!skillDirInput) {
        console.error('Usage: node package-skill.js <skill-dir> [--out <path>]');
        process.exit(2);
    }

    const skillDir = path.isAbsolute(skillDirInput)
        ? skillDirInput
        : path.resolve(process.cwd(), skillDirInput);

    const outPath = args.out
        ? (path.isAbsolute(args.out) ? args.out : path.resolve(process.cwd(), args.out))
        : null;

    let artifactPath;
    try {
        artifactPath = packageSkill(skillDir, outPath);
    } catch (err) {
        console.error(`[PACKAGE-SKILL] ${err.message}`);
        process.exit(1);
    }

    console.log(`[PACKAGE-SKILL] Created: ${artifactPath}`);
    process.exit(0);
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = { packageSkill, copyDirSync, isOnPath, main };
