// AC→source map (_lib/memory-ingest):
//   ingestAgentMemory(sourcePath, {dryRun, readMemory, createMemory}) walks .md files,
//   parses frontmatter, maps type→category, derives id, and calls the injected
//   createMemory callback per file — a throw from createMemory on ONE file must not
//   abort the rest of the batch (regression for the LOW fix: try/catch around the
//   createMemory call, mirroring the existing read-failure try/catch).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { ingestAgentMemory } = require('../memory-ingest');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');

function agentMemoryMd({ type = 'pattern', description = 'A description', name = 'a-name' } = {}) {
    return [
        '---',
        `type: ${type}`,
        `description: ${description}`,
        `name: ${name}`,
        '---',
        '',
        'Body content.',
        '',
    ].join('\n');
}

describe('ingestAgentMemory', () => {

    it('createMemoryThrowsForOneFile_othersStillProcessedAndThrownOneRecordedAsError', async () => {
        const tmp = createTmpDir({ prefix: 'memory-ingest-' });
        try {
            tmp.write('good-one.md', agentMemoryMd({ name: 'good-one' }));
            tmp.write('bad-one.md', agentMemoryMd({ name: 'bad-one' }));
            tmp.write('good-two.md', agentMemoryMd({ name: 'good-two' }));

            const created = [];
            const report = await ingestAgentMemory(tmp.root, {
                readMemory: async () => null,
                createMemory: async (category, id, content) => {
                    if (id === 'bad-one') throw new Error('boom');
                    created.push(id);
                    return { category, id, content };
                },
            });

            // The throwing file lands in errors, does NOT abort the loop.
            expect(report.errors).toHaveLength(1);
            expect(report.errors[0].file).toContain('bad-one.md');
            expect(report.errors[0].reason).toContain('createMemory threw: boom');

            // Both other files were still ingested.
            expect(created.sort()).toEqual(['good-one', 'good-two']);
            expect(report.ingested).toBe(2);
        } finally {
            tmp.cleanup();
        }
    });

    it('createMemoryReturnsNull_recordsCategoryFullError_andContinuesBatch', async () => {
        const tmp = createTmpDir({ prefix: 'memory-ingest-' });
        try {
            tmp.write('full-cat.md', agentMemoryMd({ name: 'full-cat' }));
            tmp.write('other.md', agentMemoryMd({ name: 'other' }));

            const created = [];
            const report = await ingestAgentMemory(tmp.root, {
                readMemory: async () => null,
                createMemory: async (category, id) => {
                    if (id === 'full-cat') return null;
                    created.push(id);
                    return { category, id };
                },
            });

            expect(report.errors).toEqual([
                { file: expect.stringContaining('full-cat.md'), reason: 'category full (per-category cap reached)' },
            ]);
            expect(created).toEqual(['other']);
            expect(report.ingested).toBe(1);
        } finally {
            tmp.cleanup();
        }
    });

    it('noThrows_allFilesIngested', async () => {
        const tmp = createTmpDir({ prefix: 'memory-ingest-' });
        try {
            tmp.write('one.md', agentMemoryMd({ name: 'one' }));
            tmp.write('two.md', agentMemoryMd({ name: 'two' }));

            const report = await ingestAgentMemory(tmp.root, {
                readMemory: async () => null,
                createMemory: async (category, id, content) => ({ category, id, content }),
            });

            expect(report.ingested).toBe(2);
            expect(report.errors).toEqual([]);
        } finally {
            tmp.cleanup();
        }
    });

});
