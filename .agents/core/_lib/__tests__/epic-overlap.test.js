// AC→source map (Dispatch port-back 2026-06-02 / epic-overlap):
//   extractEpicFiles(backlogPath) → Map<epicKey, Set<filePath>>
//     - epic heading: ### Epic <id>: <name>
//     - files come from `* **Files:**` blocks; path is first backtick-delimited token
//   findOverlaps(map) → [{epicA, epicB, sharedFiles}] — each pair once, epicA<epicB, files sorted
//   read failure → throw with path in message
//
// Coverage targets: line 129 (extractEpicPhases throw), lines 214-275 (main() body),
//   line 281 (require.main guard — NOT COVERED: only evaluates true when node is the entry).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const EPIC_OVERLAP_PATH = require.resolve('../../../../.agents/core/_lib/epic-overlap');
const { extractEpicFiles, extractEpicPhases, findOverlaps } = require('../../../../.agents/core/_lib/epic-overlap');

let dir;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-overlap-'));
});
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function writeBacklog(body) {
    const p = path.join(dir, 'backlog.md');
    fs.writeFileSync(p, body);
    return p;
}

const BACKLOG = `# Backlog

### Epic 1: Authentication

#### Story 1.1: Login
* **Files:**
  * \`src/auth/login.ts\` — new
  * \`src/shared/db.ts\` — modified

### Epic 2: Billing

#### Story 2.1: Checkout
* **Files:**
  * \`src/billing/checkout.ts\` — new
  * \`src/shared/db.ts\` — modified

### Epic 3: Docs

#### Story 3.1: README
* **Files:**
  * \`README.md\` — modified
`;

describe('extractEpicFiles', () => {
    it('maps each epic heading to the set of files its stories claim', () => {
        const map = extractEpicFiles(writeBacklog(BACKLOG));
        expect([...map.keys()]).toEqual([
            'Epic 1: Authentication',
            'Epic 2: Billing',
            'Epic 3: Docs',
        ]);
        expect([...map.get('Epic 1: Authentication')]).toEqual(['src/auth/login.ts', 'src/shared/db.ts']);
        expect([...map.get('Epic 3: Docs')]).toEqual(['README.md']);
    });

    it('keeps only the path inside the first backticks, dropping the description', () => {
        const map = extractEpicFiles(writeBacklog(BACKLOG));
        expect(map.get('Epic 2: Billing').has('src/billing/checkout.ts')).toBe(true);
    });

    it('throws with the path when the file cannot be read', () => {
        expect(() => extractEpicFiles(path.join(dir, 'nope.md'))).toThrow(/nope\.md/);
    });

    it('blank lines between file bullets are tolerated — do not end the files block', () => {
        const body = `### Epic A: Foo\n#### Story\n* **Files:**\n  * \`a.ts\`\n\n  * \`b.ts\`\n`;
        const map = extractEpicFiles(writeBacklog(body));
        const files = [...map.get('Epic A: Foo')];
        expect(files).toContain('a.ts');
        expect(files).toContain('b.ts');
    });

    it('non-file-entry non-blank line inside files block ends the block', () => {
        const body = `### Epic A: Foo\n#### Story\n* **Files:**\n  * \`a.ts\`\nsome prose\n  * \`b.ts\`\n`;
        const map = extractEpicFiles(writeBacklog(body));
        // 'b.ts' comes after prose that ends the block, so it should NOT be captured
        expect(map.get('Epic A: Foo').has('a.ts')).toBe(true);
        expect(map.get('Epic A: Foo').has('b.ts')).toBe(false);
    });
});

describe('findOverlaps', () => {
    it('reports each sharing pair once with sorted shared files, epicA<epicB', () => {
        const map = extractEpicFiles(writeBacklog(BACKLOG));
        const overlaps = findOverlaps(map);
        expect(overlaps).toEqual([
            { epicA: 'Epic 1: Authentication', epicB: 'Epic 2: Billing', sharedFiles: ['src/shared/db.ts'] },
        ]);
    });

    it('returns an empty array when no epics share files', () => {
        const map = new Map([
            ['Epic 1: A', new Set(['a.ts'])],
            ['Epic 2: B', new Set(['b.ts'])],
        ]);
        expect(findOverlaps(map)).toEqual([]);
    });

    it('multiple epics sharing the same file — each unique pair reported once', () => {
        const map = new Map([
            ['Epic 1: A', new Set(['shared.ts', 'only-a.ts'])],
            ['Epic 2: B', new Set(['shared.ts'])],
            ['Epic 3: C', new Set(['shared.ts', 'only-c.ts'])],
        ]);
        const overlaps = findOverlaps(map);
        // pairs: (1,2), (1,3), (2,3)
        expect(overlaps).toHaveLength(3);
        const keys = overlaps.map(o => `${o.epicA}|${o.epicB}`);
        expect(keys).toContain('Epic 1: A|Epic 2: B');
        expect(keys).toContain('Epic 1: A|Epic 3: C');
        expect(keys).toContain('Epic 2: B|Epic 3: C');
    });
});

// ── F6: phase-aware overlap ────────────────────────────────────────────────
describe('extractEpicPhases', () => {
    it('mapsEachEpicToItsPhaseHeading', () => {
        const p = path.join(dir, 'b.md');
        fs.writeFileSync(p, [
            '## Phase 0: Foundation',
            '### Epic 0: Tooling',
            '## Phase 1: Core',
            '### Epic 1: Engine',
            '### Epic 2: Persistence',
        ].join('\n'));
        const phases = extractEpicPhases(p);
        expect(phases.get('Epic 0: Tooling')).toBe('Phase 0: Foundation');
        expect(phases.get('Epic 1: Engine')).toBe('Phase 1: Core');
        expect(phases.get('Epic 2: Persistence')).toBe('Phase 1: Core');
    });

    it('epicBeforeAnyPhase_mapsToNull', () => {
        const p = path.join(dir, 'c.md');
        fs.writeFileSync(p, '### Epic 9: Loose\n');
        expect(extractEpicPhases(p).get('Epic 9: Loose')).toBe(null);
    });

    it('throws with path when file cannot be read — covers line 129', () => {
        // Covers the catch branch at line 129 in extractEpicPhases
        expect(() => extractEpicPhases(path.join(dir, 'does-not-exist.md'))).toThrow(/does-not-exist\.md/);
    });
});

describe('findOverlaps — phase awareness (F6)', () => {
    const map = new Map([
        ['Epic 1: A', new Set(['shared.ts'])],
        ['Epic 2: B', new Set(['shared.ts'])],
    ]);

    it('crossPhaseOverlap_taggedSamePhaseFalse', () => {
        const phases = new Map([['Epic 1: A', 'Phase 0: X'], ['Epic 2: B', 'Phase 1: Y']]);
        const [o] = findOverlaps(map, phases);
        expect(o.sharedFiles).toEqual(['shared.ts']);
        expect(o.samePhase).toBe(false); // different phases → cannot collide in a wave
    });

    it('samePhaseOverlap_taggedSamePhaseTrue', () => {
        const phases = new Map([['Epic 1: A', 'Phase 0: X'], ['Epic 2: B', 'Phase 0: X']]);
        expect(findOverlaps(map, phases)[0].samePhase).toBe(true);
    });

    it('unknownPhase_conservativelyGates_samePhaseTrue', () => {
        const phases = new Map([['Epic 1: A', 'Phase 0: X']]); // Epic 2 phase unknown
        expect(findOverlaps(map, phases)[0].samePhase).toBe(true);
    });

    it('bothPhasesNull_treatedAsSamePhase_gated', () => {
        // Both epics have null phase (before any ## Phase heading) → conservative: samePhase true
        const phases = new Map([['Epic 1: A', null], ['Epic 2: B', null]]);
        expect(findOverlaps(map, phases)[0].samePhase).toBe(true);
    });

    it('withoutPhaseMap_omitsSamePhaseField_backwardCompatible', () => {
        const [o] = findOverlaps(map);
        expect(o).not.toHaveProperty('samePhase');
    });
});

// ── main() — in-process coverage of lines 214-275 ────────────────────────────
// main() is exported from epic-overlap.js (behavior-preserving addition).
// We mock process.exit to throw instead of killing vitest, capture stdout/stderr,
// and set process.argv[2] to the desired backlog path.

describe('main() — lines 214-275', () => {
    let originalArgv;
    let exitSpy;
    let stdoutCapture;
    let stderrCapture;

    beforeEach(() => {
        originalArgv = process.argv.slice();
        stdoutCapture = [];
        stderrCapture = [];
        exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`process.exit(${code ?? 'undefined'})`);
        });
        vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
            stdoutCapture.push(String(s));
            return true;
        });
        vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
            stderrCapture.push(String(s));
            return true;
        });
    });

    afterEach(() => {
        process.argv = originalArgv;
        vi.restoreAllMocks();
        delete require.cache[EPIC_OVERLAP_PATH];
    });

    function freshMain() {
        delete require.cache[EPIC_OVERLAP_PATH];
        return require('../../../../.agents/core/_lib/epic-overlap').main;
    }

    function stdout() { return stdoutCapture.join(''); }
    function stderr() { return stderrCapture.join(''); }

    it('exits 2 with usage when no backlog path provided', () => {
        process.argv = ['node', 'epic-overlap.js'];
        expect(() => freshMain()()).toThrow('process.exit(2)');
        expect(stderr()).toMatch(/Usage/);
    });

    it('exits 2 when backlog file cannot be read', () => {
        process.argv = ['node', 'epic-overlap.js', path.join(dir, 'nonexistent.md')];
        expect(() => freshMain()()).toThrow('process.exit(2)');
        expect(stderr()).toMatch(/Error/);
    });

    it('exits 0 with no-overlap message when epics have no shared files', () => {
        const body = [
            '### Epic 1: Auth',
            '#### S1',
            '* **Files:**',
            '  * `src/auth.ts`',
            '',
            '### Epic 2: Billing',
            '#### S2',
            '* **Files:**',
            '  * `src/billing.ts`',
        ].join('\n');
        process.argv = ['node', 'epic-overlap.js', writeBacklog(body)];
        expect(() => freshMain()()).toThrow('process.exit(0)');
        expect(stdout()).toMatch(/No epic file overlaps/);
    });

    it('exits 1 and prints gating report when same-phase overlaps exist', () => {
        const body = [
            '## Phase 0: Foundation',
            '### Epic 1: Auth',
            '#### S1',
            '* **Files:**',
            '  * `src/shared/db.ts`',
            '',
            '### Epic 2: Billing',
            '#### S2',
            '* **Files:**',
            '  * `src/shared/db.ts`',
        ].join('\n');
        process.argv = ['node', 'epic-overlap.js', writeBacklog(body)];
        expect(() => freshMain()()).toThrow('process.exit(1)');
        const out = stdout();
        expect(out).toMatch(/SAME-PHASE/);
        expect(out).toMatch(/Epic 1: Auth/);
        expect(out).toMatch(/src\/shared\/db\.ts/);
        expect(out).toMatch(/merge-conflict risk/);
        expect(out).toMatch(/Acknowledged Overlaps/);
    });

    it('exits 0 and prints informational report for cross-phase-only overlaps', () => {
        const body = [
            '## Phase 0: Foundation',
            '### Epic 1: Auth',
            '#### S1',
            '* **Files:**',
            '  * `src/shared/db.ts`',
            '',
            '## Phase 1: Core',
            '### Epic 2: Billing',
            '#### S2',
            '* **Files:**',
            '  * `src/shared/db.ts`',
        ].join('\n');
        process.argv = ['node', 'epic-overlap.js', writeBacklog(body)];
        expect(() => freshMain()()).toThrow('process.exit(0)');
        const out = stdout();
        expect(out).toMatch(/cross-phase/i);
        expect(out).toMatch(/do NOT require acknowledgment/);
    });

    it('prints both gating and cross-phase sections when both are present', () => {
        const body = [
            '## Phase 0: Foundation',
            '### Epic 1: Auth',
            '#### S1',
            '* **Files:**',
            '  * `src/shared/db.ts`',
            '  * `src/shared/util.ts`',
            '',
            '### Epic 2: Billing',
            '#### S2',
            '* **Files:**',
            '  * `src/shared/db.ts`',
            '',
            '## Phase 1: Core',
            '### Epic 3: Reporting',
            '#### S3',
            '* **Files:**',
            '  * `src/shared/util.ts`',
        ].join('\n');
        process.argv = ['node', 'epic-overlap.js', writeBacklog(body)];
        // Epic1+Epic2 in Phase 0 share db.ts → same-phase (gating) → exit 1
        expect(() => freshMain()()).toThrow('process.exit(1)');
        const out = stdout();
        expect(out).toMatch(/SAME-PHASE/);
        expect(out).toMatch(/cross-phase/i);
    });
});
