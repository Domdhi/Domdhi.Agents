// Small, real application checks for command-routing tests. No toolkit imports.
'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const app = require('./application.cjs');

function run(mode, flags = []) {
    fs.appendFileSync('application-checks.jsonl', JSON.stringify({ mode, flags }) + '\n');
    if (mode === 'build') execFileSync(process.execPath, ['--check', 'application.cjs']);
    else if (mode === 'security') assert.equal(fs.readFileSync('application.cjs', 'utf8').includes('eval('), false);
    else if (mode === 'lint') assert.equal(fs.readFileSync('application.cjs', 'utf8').endsWith('\n'), true);
    else if (mode === 'test') {
        assert(flags.includes('--filter=Category!=Integration'), 'integration isolation filter must remain');
        assert(flags.includes('--coverage'), 'application coverage option must remain');
        const cases = [
            { name: 'Core', category: 'Unit', check: () => assert.equal(app.sum(2, 3), 5) },
            { name: 'Presentation', category: 'Unit', check: () => assert.equal(app.label('  fixture  '), 'fixture') },
            { name: 'ExternalIntegration', category: 'Integration', check: () => { throw new Error('integration must be isolated'); } },
        ];
        const selected = cases.filter(c => c.category !== 'Integration');
        for (const test of selected) { test.check(); console.log(`PASS application/${test.name}`); }
        console.log(`Tests: ${selected.length} passed, 0 failed, ${cases.length - selected.length} skipped, ${cases.length} total`);
    } else if (mode === 'integration') {
        assert(flags.includes('--isolated'), 'integration requires explicit isolation');
        assert.equal(app.sum(0, 0), 0);
        console.log('Tests: 1 passed, 0 failed, 0 skipped, 1 total');
    } else if (mode === 'preflight') {
        run('build'); run('test', ['--filter=Category!=Integration', '--coverage']); run('security');
    } else throw new Error(`Unknown application check ${mode}`);
}
run(process.argv[2], process.argv.slice(3));
