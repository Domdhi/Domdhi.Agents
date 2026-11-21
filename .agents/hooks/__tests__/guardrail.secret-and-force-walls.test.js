// AC→source map (SF-1.9 security review — the guardrail half of the access wall):
//   - J-2: Bash/PowerShell reads and copies of the six Owner Decision 4 secret-file names are a HARD block
//          (not escalatable); the template names (.env.example/.sample/.template), .env.test and .envrc stay free
//   - J-3: `git push --mirror` (and every unambiguous abbreviation git accepts) is a hard block
//   - J-4: config- and alias-injected force pushes are a hard block; their harmless twins pass
//   - M-1: `--force-with-lease` stays the user-confirm tier here (Codex has no deny set; Claude Code hard-denies it
//          through permissions.deny, which claude-permissions.test.js pins)
//   - M-2: zeroAccessPaths lists all six names, so `rm` and redirect writes of each are blocked by the PATH tier
//          even with every block_pattern removed
//
// Every case runs the real `guardrail.cjs` `processEvent` against the AUTHORED `.agents/config/guardrail-rules.yaml`
// copied into a scratch project, so this suite does not depend on the rendered `.claude/guardrail-rules.yaml`.
// The hook reads only `tool_input.command`, so a PowerShell tool call is the same decision as a Bash one; the
// PowerShell spellings below (`Get-Content`, `gc`, `Copy-Item`) are there to pin that those verbs are caught by name.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { processEvent } = require('../../../.agents/hooks/guardrail.cjs');
const { loadRules, checkPathAccess } = require('../../core/_lib/guardrail-rules');
const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');

const AUTHORED_RULES = path.resolve(__dirname, '..', '..', 'config', 'guardrail-rules.yaml');

describe('guardrail walls behind permissions.deny (SF-1.9 review J-2, J-3, J-4, M-1, M-2)', () => {
    let tmp;
    let originalDir;

    const useRules = (yamlText) => tmp.write('.claude/guardrail-rules.yaml', yamlText);

    beforeEach(() => {
        tmp = createTmpDir();
        originalDir = process.env.CLAUDE_PROJECT_DIR;
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        useRules(fs.readFileSync(AUTHORED_RULES, 'utf8'));
    });

    afterEach(() => {
        if (originalDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = originalDir;
        tmp.cleanup();
    });

    /** 'pass' | 'confirm' | 'nudge' | 'block' (a hard block); nudge is told apart by its feedback text. */
    const decision = (command) => {
        const r = processEvent({ tool_input: { command } });
        if (r === null) return 'pass';
        if (r.confirm) return 'confirm';
        if (r.block) return r.telemetry && r.telemetry.decision === 'nudge' ? 'nudge' : 'block';
        return '?';
    };

    describe('J-2: shell reads and copies of the six secret-file names', () => {
        it.each([
            ['cat .env'],
            ['head -n 50 .env'],
            ['tail -f .env'],
            ['less .env.local'],
            ['grep -r KEY .env.production'],
            ['base64 .env'],
            ['cp .env /tmp/x'],
            ['cat ./config/.env'],
            ['cat apps/web/.env.local'],
            ['cat .env.staging'],
            ['cat .env.development'],
            ['cat .env.test.local'],
            ['cat apps/api/.env.dev.local'],
            ['sed -i s/a/b/ .env'],
            ['ln -s .env notes.txt'],
            ['source .env'],
            ['cat < .env'],
            ['echo $(<.env)'],
            ['cat "$PWD/.env"'],
            ['cat ~/.env'],
            ['cat /srv/someone/other-project/.env.production'],
            ['cat .env*'],
            ['cat .env.*'],
            ['cat .ENV'],
            ['cat .env | head'],
            ['true && cat .env'],
            ['echo x > .env.staging'],
            ["node -e \"console.log(require('fs').readFileSync('.env', 'utf8'))\""],
            ['python3 -c "print(open(\'.env\').read())"'],
            ['Get-Content .env'],
            ['gc .env.production'],
            ['Get-Content -Path ./sub/.env.local -Raw'],
            ['Copy-Item .env C:\\temp\\x'],
        ])('blocks_%s', (command) => {
            expect(decision(command)).toBe('block');
        });

        it.each([
            ['cat .env  # guardrail:confirm'],
            ['cat .env.production  # guardrail:confirm'],
        ])('isNotEscalatableWithTheConfirmMarker_%s', (command) => {
            expect(decision(command)).toBe('block');
        });

        it.each([
            ['cat .env.example'],
            ['cat .env.sample'],
            ['cat .env.template'],
            ['cat .env.test'],
            ['cat apps/web/.env.example'],
            ['git add .env.example'],
            ['cat .envrc'],
            ['cat .env.example.bak'],
            ['cat .env.md'],
            ['cat src/env.ts'],
            ['cat environment.md'],
            ['cat .environment'],
            ['cat my.env'],
            ['node --env-file-if-exists=missing.txt a.js'],
            ['git status'],
            ['ls'],
        ])('leavesTheTemplateAndNearMissNamesFree_%s', (command) => {
            expect(decision(command)).toBe('pass');
        });

        it('aCommitMessageMentioningTheNameIsStrippedBeforeEvaluation_andPasses', () => {
            expect(decision('git commit -m "keep .env out of the repo"')).toBe('pass');
        });
    });

    describe('J-3: git push --mirror', () => {
        it.each([
            ['git push --mirror'],
            ['git push --mirror origin'],
            ['git push origin --mirror'],
            ['git push --quiet --mirror'],
            ['git -C . push --mirror'],
            ['git -c k=v push --mirror'],
            ['git push --m'],
            ['git push --mi origin'],
            ['git push --mir'],
            ['git push --mirr origin'],
            ['git push --mirro origin'],
            ['git push --MIRROR origin'],
        ])('blocks_%s', (command) => {
            expect(decision(command)).toBe('block');
        });

        it.each([
            ['git push --no-mirror origin'],
            ['git push origin main-mirror'],
            ['git push origin mirror'],
            ['git push --mirrors-are-fun-branch'],
            ['git push origin feature'],
            ['git push --tags'],
            ['git push -u origin refactor-fast'],
            ['git push --dry-run origin main'],
            ['echo mirror'],
        ])('doesNotBlockOrdinary_%s', (command) => {
            expect(decision(command)).toBe('pass');
        });
    });

    describe('J-4: config- and alias-injected force pushes', () => {
        it.each([
            ["git -c alias.x='push -f' x origin main"],
            ['git -c alias.x="push --force" x'],
            ['git -c alias.x=push x --force'],
            ['git -c remote.origin.push=+refs/heads/main:refs/heads/main push -q origin'],
            ['git -c remote.origin.mirror=true push -q origin'],
            ["git config alias.p 'push -f'"],
            ['git config --global alias.p "push --force"'],
            ["git config alias.p '!git push'"],
            ['git config remote.origin.push +refs/heads/main:refs/heads/main'],
            ['git config --add remote.origin.push "+refs/heads/*:refs/heads/*"'],
            ['git config remote.origin.mirror true'],
            ['git --config-env=alias.x=SOME_VAR x'],
            ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0="push -f" git x'],
            ['export GIT_CONFIG_COUNT=1'],
            ['env GIT_CONFIG_KEY_0=remote.origin.mirror git push'],
            ['GIT_CONFIG_PARAMETERS="\'alias.x=push -f\'" git x'],
            ['$env:GIT_CONFIG_COUNT = 1'],
        ])('blocks_%s', (command) => {
            expect(decision(command)).toBe('block');
        });

        it.each([
            ['git config alias.st status'],
            ['git config --global alias.co checkout'],
            ['git config remote.origin.push refs/heads/main:refs/heads/main'],
            ['git config remote.origin.url git@example.test:o/r.git'],
            ['git config remote.origin.pushurl git@example.test:o/r.git'],
            ['git config user.name someone'],
            ['git -c core.editor=vim commit'],
            ['git -c color.ui=always log --oneline'],
            ['git push'],
            ['git push origin main'],
        ])('passesTheHarmlessTwin_%s', (command) => {
            expect(decision(command)).toBe('pass');
        });
    });

    describe('M-1: the --force-with-lease confirm tier', () => {
        it.each([
            ['git push --force-with-lease origin x'],
            ['git push origin x --force-with-lease'],
            ['git -C . push --force-with-lease origin x'],
            ['git -c k=v push --force-with-lease origin x'],
        ])('staysAUserConfirmWhereNoDenySetExists_%s', (command) => {
            // Claude Code hard-denies these through permissions.deny before this confirm can run; Codex has no
            // deny set, so this tier is its only layer. The yaml comment records the decision.
            expect(decision(command)).toBe('confirm');
        });

        it('theYamlRecordsTheHardDenyDecisionNextToTheConfirmRule', () => {
            const text = fs.readFileSync(AUTHORED_RULES, 'utf8');
            expect(text).toMatch(/DECISION \(SF-1\.9[^)]*\): in Claude Code a lease push is a force\s+# form and is HARD-DENIED by `permissions\.deny`/);
            expect(text).not.toMatch(/reachable now the block rule excludes it/);
        });
    });

    describe('M-2: zeroAccessPaths lists all six Owner Decision 4 names', () => {
        const NAMES = ['.env', '.env.local', '.env.production', '.env.development', '.env.staging', '.env.test.local', 'config/.env.ci.local'];
        const TEMPLATES = ['.env.example', '.env.sample', '.env.template', '.envrc', '.env.test'];

        // Only the path tier: block_patterns removed so the J-2 regex cannot be what blocks.
        const zeroAccessOnlyRules = () => {
            const paths = loadRules(AUTHORED_RULES).zeroAccessPaths;
            return ['block_patterns: []', 'nudge_patterns:', '  - "rm -rf"', 'zeroAccessPaths:', ...paths.map(p => `  - "${p}"`), ''].join('\n');
        };

        it('theShippedList_holdsTheSixNames', () => {
            const paths = loadRules(AUTHORED_RULES).zeroAccessPaths;
            for (const name of ['.env', '.env.local', '.env.production', '.env.development', '.env.staging', '.env.*.local']) {
                expect(paths, name).toContain(name);
            }
        });

        it.each(NAMES)('checkPathAccess_deniesWriteAndDeleteOf_%s', (name) => {
            const rules = loadRules(AUTHORED_RULES);
            for (const operation of ['write', 'delete', 'read']) {
                const result = checkPathAccess(path.join('/repo', name), operation, rules);
                expect(result.allowed, `${operation} ${name}`).toBe(false);
                expect(result.tier).toBe('zeroAccessPaths');
            }
        });

        it.each(TEMPLATES)('checkPathAccess_allowsWriteOf_%s', (name) => {
            expect(checkPathAccess(path.join('/repo', name), 'write', loadRules(AUTHORED_RULES)).allowed).toBe(true);
        });

        it.each(NAMES)('rmOf_%s_isAPathTierHardBlock_evenWithoutAnyBlockPattern', (name) => {
            useRules(zeroAccessOnlyRules());
            const r = processEvent({ tool_input: { command: `rm ${name}` } });
            expect(r && r.block && r.telemetry.tier, name).toBe('zeroAccessPaths');
        });

        it.each(NAMES)('redirectWriteTo_%s_isAPathTierHardBlock_evenWithoutAnyBlockPattern', (name) => {
            useRules(zeroAccessOnlyRules());
            const r = processEvent({ tool_input: { command: `echo x > ${name}` } });
            expect(r && r.block && r.telemetry.tier, name).toBe('zeroAccessPaths');
        });

        it.each(TEMPLATES)('rmOfTheTemplateName_%s_isNotAPathTierBlock', (name) => {
            useRules(zeroAccessOnlyRules());
            const r = processEvent({ tool_input: { command: `rm ${name}` } });
            expect(r === null || r.telemetry.tier !== 'zeroAccessPaths', name).toBe(true);
        });
    });
});
