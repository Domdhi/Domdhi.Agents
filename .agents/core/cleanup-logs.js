#!/usr/bin/env node

/**
 * Log Cleanup Script
 * Deletes build/test logs older than N days (default 30) — both dated log
 * folders (YYYY-MM-DD_*) and gate.js's flat gate-{ISO}.log files.
 *
 * Usage:
 *   node cleanup-logs.js           # Delete >30 days old
 *   node cleanup-logs.js --days 7  # Delete >7 days old
 */

const fs = require('fs').promises;
const path = require('path');
const { getTelemetryDir } = require('./_lib/telemetry-paths');

const DEFAULT_DAYS = 30;

async function cleanupLogs(maxAgeDays = DEFAULT_DAYS) {
    const projectRoot = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
    const logDirs = [
        path.join(getTelemetryDir(projectRoot), 'logs')
    ];

    const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    let deletedCount = 0;
    let freedBytes = 0;

    console.log(`Cleaning logs older than ${maxAgeDays} days (before ${cutoffDate.toISOString().split('T')[0]})\n`);

    for (const logsDir of logDirs) {
        console.log(`Scanning: ${logsDir}`);

        const entries = await fs.readdir(logsDir, { withFileTypes: true }).catch(() => []);

        if (entries.length === 0) {
            console.log(`   (empty or not found)\n`);
            continue;
        }

        for (const entry of entries) {
            // Never touch _latest-* symlinks/folders
            if (entry.name.startsWith('_latest-')) continue;

            // Build local midnight (Y, M-1, D) to match the cutoff's local basis.
            // Parsing the "YYYY-MM-DD" string instead yields UTC midnight, which in
            // negative-UTC zones shifts the destructive fs.rm boundary by up to a day.
            if (entry.isDirectory()) {
                // Dated log folders: YYYY-MM-DD_HHMMSS_*
                const match = entry.name.match(/^(\d{4})-(\d{2})-(\d{2})_/);
                if (!match) continue;

                const folderDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
                if (folderDate < cutoffDate) {
                    const folderPath = path.join(logsDir, entry.name);
                    const size = await getFolderSize(folderPath);
                    freedBytes += size;

                    await fs.rm(folderPath, { recursive: true, force: true });
                    deletedCount++;
                    console.log(`   Deleted: ${entry.name} (${formatBytes(size)})`);
                }
                continue;
            }

            // Flat gate log files. gate.js is the only producer under this dir and
            // it writes gate-{ISO}.log with `:`/`.` replaced by `-`, e.g.
            // gate-2026-06-10T02-42-10-940Z.log. The date is embedded in the name;
            // parse it (same local-midnight basis as the dated folders above).
            const fileMatch = entry.name.match(/^gate-(\d{4})-(\d{2})-(\d{2})T/);
            if (!fileMatch) continue;

            const fileDate = new Date(Number(fileMatch[1]), Number(fileMatch[2]) - 1, Number(fileMatch[3]));
            if (fileDate < cutoffDate) {
                const filePath = path.join(logsDir, entry.name);
                const size = await fs.stat(filePath).then(s => s.size).catch(() => 0);
                freedBytes += size;

                await fs.rm(filePath, { force: true });
                deletedCount++;
                console.log(`   Deleted: ${entry.name} (${formatBytes(size)})`);
            }
        }
        console.log('');
    }

    console.log('-'.repeat(50));
    console.log(`Summary: Deleted ${deletedCount} entries, freed ${formatBytes(freedBytes)}`);
}

async function getFolderSize(dir) {
    let size = 0;
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                size += await getFolderSize(fullPath);
            } else {
                const stat = await fs.stat(fullPath);
                size += stat.size;
            }
        }
    } catch {
        // Ignore errors (permission issues, etc.)
    }
    return size;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// CLI: node cleanup-logs.js [--days N]
if (require.main === module) {
    const daysIndex = process.argv.indexOf('--days');
    const days = daysIndex !== -1
        ? parseInt(process.argv[daysIndex + 1], 10)
        : DEFAULT_DAYS;

    if (isNaN(days) || days < 1) {
        console.error('Error: --days must be a positive integer');
        process.exit(1);
    }

    cleanupLogs(days).catch(err => {
        console.error('Error:', err.message);
        process.exit(1);
    });
}

module.exports = { cleanupLogs, getFolderSize, formatBytes };
