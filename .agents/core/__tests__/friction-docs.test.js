import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Prose pins for the authoring guidance changed by the adopter-friction fixes: the module brief file name (F), the
// ac-verify `list` check and the double `--` for a nested-npm script (B, G), and the hotspot and wave-column rules (C).
const read = rel => fs.readFileSync(path.resolve(rel), 'utf8');
const todoFlow = read('.agents/skills/todo/references/workflow.md');
const moduleFlow = read('.agents/skills/create-module/references/workflow.md');

describe('create-module step 4a: the brief file name', () => {
    const step = moduleFlow.slice(moduleFlow.indexOf('**4a. Create module brief**'), moduleFlow.indexOf('**4b.'));

    it('moduleBrief_fileNameIsAlwaysBriefMd', () => {
        expect(step).toContain('`docs/modules/{module}/brief.md`');
        expect(step).toMatch(/always `brief\.md`/);
        expect(step).toMatch(/no underscore prefix/);
    });

    it('moduleBrief_existingBriefsAreAContentPatternNeverAFileNamePattern', () => {
        expect(step).not.toMatch(/Follow the pattern established in existing/);
        expect(step).toMatch(/content and section layout only, never for the file name/);
    });
});

describe('/todo authoring: binding checks', () => {
    const rule22 = todoFlow.split('\n').find(line => line.startsWith('22. '));
    const mechanical = todoFlow.slice(todoFlow.indexOf('**Mechanical plan checks'), todoFlow.indexOf('These checks prove the plan'));

    it('rule22_pointsAtTheNonExecutingListVerb', () => {
        expect(rule22).toContain('node .claude/core/ac-verify.js list --todo "{TODO_PATH}"');
        expect(rule22).toMatch(/without running anything/);
    });

    it('mechanicalChecks_includeTheBindingPolicyListCheck', () => {
        expect(mechanical).toMatch(/Binding policy — `node \.claude\/core\/ac-verify\.js list --todo "\{TODO_PATH\}"` exits 0/);
    });

    it('rule22_showsTheDoubleDashFormForANestedNpmScript', () => {
        expect(rule22).toContain('verify: npm run test -- app/x.test.ts -- -t "name"');
        expect(rule22).toMatch(/swallows a filter placed after one `--`/);
        expect(rule22).toMatch(/refuses the single-`--` form for a nested-npm script/);
    });
});

describe('/todo template: hotspot section and wave column', () => {
    it('sharedHotspotTemplateLine_usesABacktickedPathThePlanCheckParserReads', () => {
        const line = todoFlow.split('\n').find(l => l.startsWith('- **`{file}`** — touched by stories'));
        expect(line).toBeTruthy();
        expect(line).toMatch(/warning plus an isolation group \(never an error, even under `--strict`\)/);
    });

    it('waveColumnRule_explainsDeclaredVersusDerivedOverlap', () => {
        const rule5 = todoFlow.split('\n').find(line => line.startsWith('5. **Story Index with wave column**'));
        expect(rule5).toMatch(/error in `plan-check\.js --strict` \(`WAVE_COLLISION`\) unless that file is listed under Shared Hotspot Files/);
        expect(rule5).toMatch(/Leave the cell `—`/);
    });
});
