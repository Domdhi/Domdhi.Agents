// Final-core review M2 and M3 (code review) and security m2 for the Bash guard (`guardrail.cjs`).
//
//   M2      `tokenizeArgs` turned an empty quoted argument (`""`, `''`) into `undefined`; the first string
//           method called on it threw, so every subagent command containing one (`grep -c "" f`, `echo "" > f`,
//           `sed -i '' f`) was blocked by the fail-closed catch with no cause, and `find . -name "" -delete`
//           crashed for the main thread too. The empty string is now a token, and the call sites check the type.
//   M3      The subagent write wall resolved every relative target against the project root, so `cd .agents/hooks
//           && sed -i s/a/b/ guardrail.cjs` or `cd .agents/core && echo x > gate.js` passed. Relative targets now
//           resolve against the payload `cwd` and every `cd`/`pushd` earlier in the command; a `cd` into an
//           existing directory outside the project is not a project path (the reviewer's false-positive row).
//   m2      `git restore --source/-s/--worktree`, `git checkout <ref> -- <file>`, `git rm`, `git mv`, `patch`,
//           `git apply`, `git am`, `tar -C` and `unzip -d` wrote the tier without being seen. The patch forms are
//           refused unless the patch file is readable and none of its target files is in the tier.
//
// Every in-process case runs the real `processEvent` against the AUTHORED `.agents/config/guardrail-rules.yaml`
// copied into a scratch project. NOT COVERED: a `cd` to a directory built from a variable (`cd "$DIR"`), `cd -`,
// a script file that changes directory, and `git -C "$VAR"` are not followed (the module's documented limits).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');

const HOOK_DIR = path.resolve(__dirname, '..');
const AGENTS_DIR = path.resolve(HOOK_DIR, '..');
const AUTHORED_RULES = path.join(AGENTS_DIR, 'config', 'guardrail-rules.yaml');

const slash = (p) => p.replace(/\\/g, '/');

describe('guardrail.cjs — empty arguments, working directory and patch/restore/extract forms', () => {
    let tmp;
    let outside;
    let originalDir;
    let guard;
    const SUBAGENT = { agent_id: 'agent-3', agent_type: 'implementer' };

    beforeEach(() => {
        tmp = createTmpDir({ prefix: 'guardrail-cd-' });
        outside = createTmpDir({ prefix: 'guardrail-outside-' });
        originalDir = process.env.CLAUDE_PROJECT_DIR;
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        tmp.write('.claude/guardrail-rules.yaml', fs.readFileSync(AUTHORED_RULES, 'utf8'));
        // The directories the real project has: a `cd` into an existing directory resolves exactly.
        for (const dir of ['.agents/hooks', '.agents/core', '.claude/hooks', 'src', 'docs', '.git']) tmp.mkdir(dir);
        guard = require('../guardrail.cjs');
    });

    afterEach(() => {
        if (originalDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = originalDir;
        tmp.cleanup();
        outside.cleanup();
    });

    const run = (command, extra = {}) => guard.processEvent({ tool_name: 'Bash', tool_input: { command }, ...extra });
    const tierOf = (result) => (result && result.telemetry ? result.telemetry.tier : undefined);
    const expectTierBlock = (command, extra = SUBAGENT) => {
        const result = run(command, extra);
        expect(result, command).toMatchObject({ block: true });
        expect(tierOf(result), command).toBe('subagentReadOnlyPaths');
    };

    // ─── M2: an empty quoted argument is an empty token, not undefined ───────────

    describe('M2: empty quoted arguments', () => {
        it.each([
            ['grep -c "" file', ['grep', '-c', '', 'file']],
            ["sed -i '' s/a/b/ f", ['sed', '-i', '', 's/a/b/', 'f']],
            ['echo "" > out.txt', ['echo', '', '>', 'out.txt']],
            ['cat ""', ['cat', '']],
            ['a "" "" b', ['a', '', '', 'b']],
            ['plain "two words" \'single q\' bare', ['plain', 'two words', 'single q', 'bare']],
            ['', []],
        ])('tokenizeArgs_%s_keepsEveryEmptyQuotedArgumentAsAString', (input, expected) => {
            expect(guard.tokenizeArgs(input)).toEqual(expected);
            for (const token of guard.tokenizeArgs(input)) expect(typeof token).toBe('string');
        });

        const BENIGN = [
            'grep -c "" file',
            'echo "" > out.txt',
            'cat ""',
            'git commit -F m -m ""',
            'rm ""',
            "sed -i '' s/a/b/ src/app.js",
            'printf "" >> src/log.txt',
        ];

        it.each(BENIGN)('processEvent_subagent_%s_doesNotCrashAndPasses', (command) => {
            expect(() => run(command, SUBAGENT)).not.toThrow();
            expect(run(command, SUBAGENT)).toBeNull();
        });

        it.each(BENIGN)('processEvent_mainThread_%s_doesNotCrashAndPasses', (command) => {
            expect(() => run(command)).not.toThrow();
            expect(run(command)).toBeNull();
        });

        it.each([
            ['find . -name "" -delete'],
            ['find . -empty -name "" -exec rm {} +'],
        ])('processEvent_%s_reachesTheFindNudgeForBothPayloadKinds_insteadOfCrashing', (command) => {
            for (const extra of [{}, SUBAGENT]) {
                const result = run(command, extra);
                expect(result, command).toMatchObject({ block: true });
                expect(result.telemetry.decision, command).toBe('nudge');
            }
        });

        it('processEvent_subagent_anEmptyArgumentDoesNotHideAProtectedTarget', () => {
            expectTierBlock("sed -i '' s/a/b/ .agents/core/gate.js");
            expectTierBlock('echo "" > .agents/core/gate.js');
            expectTierBlock('cp "" .agents/core/gate.js');
        });

        it('extractWriteTargets_andTheDeleteExtractors_acceptEmptyArgumentsWithoutThrowing', () => {
            expect(guard.extractWriteTargets("sed -i '' s/a/b/ f")).toEqual(['s/a/b/', 'f']);
            expect(guard.extractWriteTargets('tee "" f')).toEqual(['f']);
            expect(guard.extractDeletePaths('rm "" f')).toEqual(['f']);
            expect(guard.extractAltDeleteTargets('find . -name "" -delete')).toEqual(['.']);
            expect(guard.extractAltDeleteTargets('truncate -s 0 "" f')).toEqual(['0', 'f']);
        });
    });

    // ─── M3: relative targets follow the working directory ───────────────────────

    describe('M3: cd, pushd and the payload cwd', () => {
        it.each([
            ['sed -i s/a/b/ .agents/hooks/guardrail.cjs'],
            ['cd .agents/hooks && sed -i s/a/b/ guardrail.cjs'],
            ['cd .agents/hooks && rm guardrail.cjs'],
            ['cd .agents/core && cp /tmp/x gate.js'],
            ['pushd .agents/core; echo hi > gate.js'],
            ['cd .agents/core && echo x > gate.js'],
            ['cd .agents && sed -i s/a/b/ core/gate.js'],
            ['cd .agents; cd core; echo x > gate.js'],
            ['cd ./.agents/core && echo x > gate.js'],
            ['cd "./.agents/core" && echo x > gate.js'],
            ["cd '.agents/core' && tee gate.js < /tmp/e"],
            ['cd -P .agents/core && echo x > gate.js'],
            ['cd -- .agents/core && echo x > gate.js'],
            ['cd .agents/core && mv /tmp/e gate.js'],
            ['cd .agents/core && dd if=/tmp/e of=gate.js'],
            ['cd .agents/core && ln -sf /tmp/e gate.js'],
            ['cd .claude/hooks && sed -i s/a/b/ guardrail.cjs'],
            ['cd .agents/hooks && cd .. && cd core && rm gate.js'],
            ['pushd .agents/core && popd && echo x > gate.js'],
            ['cd src && cd ../.agents/core && echo x > gate.js'],
            // The directory does not exist: the cd may fail or a mkdir earlier in the command may create it.
            ['cd nope && cp /tmp/e .agents/core/gate.js'],
        ])('processEvent_subagent_%s_isBlockedBySubagentReadOnlyPaths', (command) => {
            expectTierBlock(command);
        });

        it('processEvent_subagent_cdThroughASymlinkIntoTheProject_isStillTheProject', () => {
            if (process.platform === 'win32') return; // symlink creation needs a privilege there
            const link = path.join(outside.root, 'link-to-core');
            fs.symlinkSync(path.join(tmp.root, '.agents', 'core'), link);

            expectTierBlock(`cd ${slash(link)} && echo x > gate.js`);
        });

        it('processEvent_subagent_thePayloadCwdIsTheStartingDirectoryForRelativeTargets', () => {
            const cwd = path.join(tmp.root, '.agents', 'core');

            expectTierBlock('sed -i s/a/b/ gate.js', { ...SUBAGENT, cwd });
            expectTierBlock('echo x > gate.js', { ...SUBAGENT, cwd });
            expectTierBlock('rm gate.js', { ...SUBAGENT, cwd });
            // A relative path still resolves against the project root as well (the old behaviour is kept).
            expectTierBlock('rm .agents/core/gate.js', { ...SUBAGENT, cwd: path.join(tmp.root, 'src') });
        });

        it.each([
            ['cd .agents/core && ls'],
            ['cd .agents/core && cat gate.js'],
            ['cd .agents/core && git diff gate.js'],
            ['cd .agents/core && sed -n 1,5p gate.js'],
            ['cd .agents/core && cp gate.js /tmp/gate.copy'],
            ['cd .agents/core && grep -r hook .'],
            ['cd src && echo x > a.js'],
            ['cd src && sed -i s/a/b/ app.js'],
            ['cd docs && rm notes.md'],
            ['cd .agents/core && cd ../../src && echo x > a.js'],
            ['pushd src && echo x > a.js && popd'],
            ['cd && ls'],
            ['cd - && ls'],
        ])('processEvent_subagent_%s_isNotOverBlocked', (command) => {
            expect(run(command, SUBAGENT)).toBeNull();
        });

        it.each([
            ['cp /tmp/x .agents/hooks/y.cjs'],
            ['sed -i s/a/b/ .agents/core/gate.js'],
            ['echo x > .claude/settings.json'],
            ['rm .agents/core/gate.js'],
        ])('processEvent_subagent_cdIntoAnExistingDirectoryOutsideTheProject_%s_isNotAProjectPath', (tail) => {
            // The reviewer's false-positive row: the target is under the scratch repo, not under this project.
            expect(run(`cd ${slash(outside.root)} && ${tail}`, SUBAGENT)).toBeNull();
        });

        it('processEvent_subagent_theCommandBeforeTheCdIsStillCheckedAgainstTheProject', () => {
            expectTierBlock(`cp /tmp/e .agents/core/gate.js && cd ${slash(outside.root)}`);
        });

        it('processEvent_subagent_anAbsoluteTargetIsCheckedWhateverTheDirectory', () => {
            expectTierBlock(`cd ${slash(outside.root)} && cp /tmp/e ${slash(path.join(tmp.root, '.agents', 'core', 'gate.js'))}`);
        });

        it('processEvent_mainThread_cdAndWritesToTheSameFiles_areNotBlockedByTheSubagentTier', () => {
            expect(run('cd .agents/core && echo x > gate.js')).toBeNull();
            expect(run('cd .agents/hooks && sed -i s/a/b/ guardrail.cjs')).toBeNull();
            expect(run('pushd .agents/core; echo hi > gate.js')).toBeNull();
        });

        it('processEvent_mainThread_deleteAfterACd_usesTheSameResolutionAsTheOlderCheck', () => {
            // The sibling resolveAbsPath use in the delete-path check: `.git` is a zero-access entry, so a
            // relative delete inside it blocks for every caller.
            const result = run('cd .git && rm config');

            expect(result).toMatchObject({ block: true });
            expect(tierOf(result)).toBe('zeroAccessPaths');
            expect(run('cd docs && rm -f .env')).toMatchObject({ block: true });
            expect(tierOf(run('pushd .git; truncate -s 0 HEAD'))).toBe('zeroAccessPaths');
            expect(tierOf(run('cd .git && echo x > config'))).toBe('zeroAccessPaths');
        });

        it('processEvent_mainThread_aCdIntoAnExistingDirectoryOutsideTheProject_doesNotBlockItsOwnGitDir', () => {
            expect(run(`cd ${slash(outside.root)} && rm .git/HEAD`)).toBeNull();
        });

        it('processEvent_mainThread_theFrozenPathCheckAlsoFollowsTheCd', () => {
            // checkFreezeState is fed the resolved path: no frozen paths exist here, so a relative delete passes.
            expect(run('cd src && rm a.js')).toBeNull();
        });

        it.each([
            ['cd .agents/core', { kind: 'cd', target: '.agents/core' }],
            ['cd', { kind: 'cd', target: undefined }],
            ['pushd ./x', { kind: 'cd', target: './x' }],
            ['pushd -n x', null],
            ['cd -P "a b"', { kind: 'cd', target: 'a b' }],
            ['cd -- -weird', { kind: 'cd', target: '-weird' }],
            ['cd -', { kind: 'cd', target: '-' }],
            ['popd', { kind: 'popd' }],
            ['Set-Location -Path .agents/core', { kind: 'cd', target: '.agents/core' }],
            ['sudo cd x', { kind: 'cd', target: 'x' }],
            ['echo cd x', null],
            ['cdrom x', null],
            ['', null],
        ])('parseDirChange_%s', (segment, expected) => {
            expect(guard.parseDirChange(segment)).toEqual(expected);
        });

        it('planCommand_aCommandWithoutADirectoryChange_isOneStepOverTheWholeText', () => {
            const base = [tmp.root];

            const plan = guard.planCommand('echo a > f && rm g', base);

            expect(plan.changed).toBe(false);
            expect(plan.steps).toEqual([{ text: 'echo a > f && rm g', dirs: base }]);
        });

        it('planCommand_afterACd_laterSegmentsRunUnderTheNewDirectory_earlierOnesDoNot', () => {
            const core = fs.realpathSync(path.join(tmp.root, '.agents', 'core'));

            const plan = guard.planCommand('echo a > f && cd .agents/core && echo b > g', [tmp.root]);

            expect(plan.changed).toBe(true);
            expect(plan.steps.map((s) => s.text.trim())).toEqual(['echo a > f', 'cd .agents/core', 'echo b > g']);
            expect(plan.steps[0].dirs).toEqual([tmp.root]);
            expect(plan.steps[2].dirs).toEqual([core]);
            expect(plan.allDirs).toContain(core);
            expect(plan.allDirs).toContain(tmp.root);
        });
    });

    // ─── security m2: restore, checkout, rm, mv ──────────────────────────────────

    describe('git restore, checkout, rm and mv write the working tree', () => {
        it.each([
            ['git restore --source=HEAD~5 .agents/core/ship-check.js'],
            ['git restore -s HEAD~5 .agents/core/ship-check.js'],
            ['git restore --source HEAD~5 --worktree .agents/core/ship-check.js'],
            ['git restore --worktree .agents/core/gate.js'],
            ['git restore -W .agents/core/gate.js'],
            ['git restore --staged --worktree .agents/core/gate.js'],
            ['git restore .agents/core/gate.js'],
            ['git restore .agents'],
            ['git -C .agents/core restore gate.js'],
            ['cd .agents/core && git restore gate.js'],
            ['git checkout HEAD~3 -- .agents/core/gate.js'],
            ['git checkout -- .agents/core/gate.js'],
            ['git checkout HEAD .agents/core/gate.js'],
            ['git checkout HEAD -- .agents/hooks/'],
            ['git -C .agents/core checkout HEAD -- gate.js'],
            ['git rm .agents/core/gate.js'],
            ['git rm -f .claude/settings.local.json'],
            ['git mv src/a.js .agents/core/gate.js'],
            ['git mv .agents/core/gate.js /tmp/gate.bak'],
        ])('processEvent_subagent_%s_isBlockedBySubagentReadOnlyPaths', (command) => {
            expectTierBlock(command);
        });

        it.each([
            ['git restore --staged .agents/core/gate.js'],
            ['git restore -S .agents/core/gate.js'],
            ['git restore src/a.js'],
            ['git restore --source=HEAD~1 src/a.js'],
            ['git checkout main'],
            ['git checkout -b feature/x'],
            ['git checkout HEAD -- src/a.js'],
            ['git rm --cached .agents/core/gate.js'],
            ['git rm src/old.js'],
            ['git mv src/a.js src/b.js'],
            ['git status'],
            ['git diff HEAD~3 -- .agents/core/gate.js'],
            ['git log -p -- .agents/core/gate.js'],
            ['git show HEAD~1:.agents/core/gate.js'],
        ])('processEvent_subagent_%s_isNotOverBlocked', (command) => {
            expect(run(command, SUBAGENT)).toBeNull();
        });

        it('processEvent_mainThread_restoreOfTheSameFiles_isNotBlockedByTheSubagentTier', () => {
            expect(run('git restore --source=HEAD~5 .agents/core/ship-check.js')).toBeNull();
            expect(run('git restore .agents/core/gate.js')).toBeNull();
            expect(run('git rm .agents/core/gate.js')).toBeNull();
        });

        it('extractWriteTargets_gitForms', () => {
            expect(guard.extractWriteTargets('git restore -s HEAD~1 a b')).toEqual(['a', 'b']);
            expect(guard.extractWriteTargets('git restore --staged a')).toEqual([]);
            expect(guard.extractWriteTargets('git checkout HEAD~2 -- a b')).toEqual(['a', 'b']);
            expect(guard.extractWriteTargets('git -C d restore a')).toEqual(['a', 'd/a']);
            expect(guard.extractWriteTargets('git rm --cached a')).toEqual([]);
            expect(guard.extractWriteTargets('git rm -r a b')).toEqual(['a', 'b']);
            expect(guard.extractWriteTargets('git mv a b')).toEqual(['a', 'b', 'b/a']);
            expect(guard.extractWriteTargets('git log -p')).toEqual([]);
        });
    });

    describe('a directory that holds protected entries', () => {
        it.each([
            ['git restore .'],
            ['git checkout -- .'],
            ['tar -xf x.tar -C .'],
            ['unzip x.zip -d .'],
            ['git restore docs'],
        ])('processEvent_subagent_%s_isBlockedBecauseTheProjectRootAndDocsHoldProtectedFiles', (command) => {
            // The files an archive member or a restored pathspec touches are not named, so a directory that
            // holds any protected entry is refused (zero-access entries such as .git count too).
            expect(run(command, SUBAGENT), command).toMatchObject({ block: true });
        });

        it('processEvent_mainThread_theSameDirectoryFormsAreNotBlockedByTheSubagentTier', () => {
            expect(run('tar -xf x.tar -C .')).toBeNull();
            expect(run('unzip x.zip -d .')).toBeNull();
            expect(run('git restore .')).toBeNull();
        });
    });

    // ─── security m2: patch, git apply, git am ───────────────────────────────────

    describe('patch, git apply and git am', () => {
        const GATE_DIFF = [
            'diff --git a/.agents/core/gate.js b/.agents/core/gate.js',
            '--- a/.agents/core/gate.js',
            '+++ b/.agents/core/gate.js',
            '@@ -1 +1 @@',
            '-a',
            '+b',
            '',
        ].join('\n');
        const SRC_DIFF = [
            'diff --git a/src/app.js b/src/app.js',
            '--- a/src/app.js',
            '+++ b/src/app.js',
            '@@ -1 +1 @@',
            '-a',
            '+b',
            '',
        ].join('\n');
        const MBOX = ['From 1234 Mon Sep 17 00:00:00 2001', 'Subject: [PATCH] x', '', '---', GATE_DIFF].join('\n');

        beforeEach(() => {
            tmp.write('evil.diff', GATE_DIFF);
            tmp.write('fine.diff', SRC_DIFF);
            tmp.write('evil.mbox', MBOX);
            tmp.write('sub/evil.diff', GATE_DIFF);
        });

        it.each([
            ['git apply evil.diff'],
            ['git apply --check --apply evil.diff'],
            ['git apply -p1 evil.diff'],
            ['git apply --index evil.diff'],
            ['git -C . apply evil.diff'],
            ['git am evil.mbox'],
            ['git am --3way evil.mbox'],
            ['patch -p1 < evil.diff'],
            ['patch -p1 <evil.diff'],
            ['patch -p1 -i evil.diff'],
            ['patch -p1 --input=evil.diff'],
            ['patch .agents/core/gate.js fine.diff'],
            ['patch .agents/core/gate.js < fine.diff'],
            ['cd sub && patch -p1 < evil.diff'],
            ['cd sub && git apply evil.diff'],
            ['cat evil.diff | git apply'],
            ['cat evil.diff | patch -p1'],
            ["patch -p1 <<'EOF'\nx\nEOF"],
            ['git apply -'],
            ['git apply'],
            ['git apply missing.diff'],
            ['patch -p1 < missing.diff'],
            ['git am'],
        ])('processEvent_subagent_%s_isRefused', (command) => {
            expectTierBlock(command);
        });

        it('processEvent_subagent_theRefusalNamesTheVerbAndWhoAppliesPatches', () => {
            const result = run('git apply -', SUBAGENT);

            expect(result.feedback).toContain('git apply');
            expect(result.feedback).toContain('Main Agent applies');
        });

        it.each([
            ['git apply fine.diff'],
            ['git apply -p1 fine.diff'],
            ['patch -p1 < fine.diff'],
            ['patch src/app.js fine.diff'],
            ['git apply --check evil.diff'],
            ['git apply --stat evil.diff'],
            ['git apply --numstat evil.diff'],
            ['git apply --summary evil.diff'],
            ['patch --dry-run -p1 < evil.diff'],
            ['cd src && patch -p1 < ../fine.diff'],
        ])('processEvent_subagent_%s_isNotOverBlocked', (command) => {
            expect(run(command, SUBAGENT)).toBeNull();
        });

        it('processEvent_subagent_aPatchWithOneProtectedFileAmongSeveralIsRefused', () => {
            tmp.write('mixed.diff', SRC_DIFF + GATE_DIFF);

            expectTierBlock('git apply mixed.diff');
        });

        it('processEvent_subagent_aPatchWithAMultiRenameToTheTierIsRefused', () => {
            tmp.write('rename.diff', ['diff --git a/src/x.js b/.agents/hooks/x.cjs', 'similarity index 100%', 'rename from src/x.js', 'rename to .agents/hooks/x.cjs', ''].join('\n'));

            expectTierBlock('git apply rename.diff');
        });

        it('processEvent_mainThread_appliesPatchesFreely', () => {
            expect(run('git apply evil.diff')).toBeNull();
            expect(run('patch -p1 < evil.diff')).toBeNull();
            expect(run('git am evil.mbox')).toBeNull();
            expect(run('cat evil.diff | git apply')).toBeNull();
        });

        it.each([
            ['git apply a.diff b.diff', [{ verb: 'git apply', files: ['a.diff', 'b.diff'], stdin: false, readOnly: false }]],
            ['git apply --check a.diff', [{ verb: 'git apply', files: ['a.diff'], stdin: false, readOnly: true }]],
            ['git apply --check --apply a.diff', [{ verb: 'git apply', files: ['a.diff'], stdin: false, readOnly: false }]],
            ['git apply', [{ verb: 'git apply', files: [], stdin: true, readOnly: false }]],
            ['git am m.mbox', [{ verb: 'git am', files: ['m.mbox'], stdin: false, readOnly: false }]],
            ['patch -p1 < p.diff', [{ verb: 'patch', files: ['p.diff'], stdin: false, readOnly: false }]],
            ['patch -i p.diff', [{ verb: 'patch', files: ['p.diff'], stdin: false, readOnly: false }]],
            ['patch --dry-run < p.diff', [{ verb: 'patch', files: ['p.diff'], stdin: false, readOnly: true }]],
            ['patch', [{ verb: 'patch', files: [], stdin: true, readOnly: false }]],
            ['ls && git status', []],
        ])('extractPatchApplications_%s', (command, expected) => {
            expect(guard.extractPatchApplications(command)).toEqual(expected);
        });

        it('extractPatchApplications_nonStringOrEmpty_yieldsNothing', () => {
            expect(guard.extractPatchApplications(undefined)).toEqual([]);
            expect(guard.extractPatchApplications('')).toEqual([]);
        });
    });

    // ─── security m2: tar -C and unzip -d ────────────────────────────────────────

    describe('tar -C and unzip -d destinations', () => {
        it.each([
            ['tar -xf x.tar -C .agents/core'],
            ['tar -xzf x.tgz --directory=.claude/hooks'],
            ['tar -xzf x.tgz --directory .claude/hooks'],
            ['tar xf x.tar -C .agents/hooks'],
            ['tar --extract -f x.tar -C .agents/core'],
            ['tar -xf x.tar -C.agents/core'],
            ['tar -xf x.tar -C .agents'],
            ['unzip -o x.zip -d .claude/hooks'],
            ['unzip x.zip -d .agents/core'],
            ['unzip x.zip -d.agents/core'],
            ['cd .agents && tar -xf /tmp/x.tar -C core'],
            ['cd .agents/core && unzip /tmp/x.zip -d .'],
            ['sudo tar -xf x.tar -C .agents/core'],
        ])('processEvent_subagent_%s_isBlockedBySubagentReadOnlyPaths', (command) => {
            expectTierBlock(command);
        });

        it.each([
            ['tar -xf x.tar -C src'],
            ['tar -xf x.tar -C /tmp/scratch-extract'],
            ['tar -xf x.tar'],
            ['tar -czf out.tgz -C .agents/core .'],
            ['tar -tf x.tar'],
            ['unzip x.zip -d build/out'],
            ['unzip -l x.zip'],
            ['unzip x.zip'],
            ['unzip x.zip -d /tmp/scratch-extract'],
        ])('processEvent_subagent_%s_isNotOverBlocked', (command) => {
            expect(run(command, SUBAGENT)).toBeNull();
        });

        it('processEvent_subagent_extractingIntoAnExistingDirectoryOutsideTheProject_isNotAProjectPath', () => {
            expect(run(`cd ${slash(outside.root)} && tar -xf /tmp/x.tar -C .`, SUBAGENT)).toBeNull();
        });

        it('processEvent_mainThread_extractionIntoTheSameDirectories_isNotBlockedByTheSubagentTier', () => {
            expect(run('tar -xf x.tar -C .agents/core')).toBeNull();
            expect(run('unzip -o x.zip -d .claude/hooks')).toBeNull();
        });

        it.each([
            ['tar -xf x.tar -C d', ['d']],
            ['tar xzf x.tgz --directory d', ['d']],
            ['tar -xf x.tar --directory=d', ['d']],
            ['tar -xf x.tar -Cd', ['d']],
            ['tar -cf x.tar -C d .', []],
            ['tar -tf x.tar', []],
            ['unzip x.zip -d d', ['d']],
            ['unzip x.zip -dd', ['d']],
            ['unzip x.zip', []],
            ['git restore -s HEAD d/', ['d/']],
            ['git -C r checkout -- d', ['d', 'r/d']],
            ['ls -la', []],
        ])('extractDirectoryWrites_%s', (command, expected) => {
            expect(guard.extractDirectoryWrites(command)).toEqual(expected);
        });

        it('extractDirectoryWrites_nonStringOrEmpty_yieldsNothing', () => {
            expect(guard.extractDirectoryWrites(null)).toEqual([]);
            expect(guard.extractDirectoryWrites('')).toEqual([]);
        });
    });

    // ─── the guard still fails closed ────────────────────────────────────────────

    describe('fail closed', () => {
        it('processEvent_aMissingRulesFile_subagentStillGetsTheBuiltInTierForTheNewForms', () => {
            fs.rmSync(path.join(tmp.root, '.claude', 'guardrail-rules.yaml'));

            expectTierBlock('cd .agents/core && echo x > gate.js');
            expectTierBlock('git restore --source=HEAD~5 .agents/core/ship-check.js');
            expectTierBlock('tar -xf x.tar -C .agents/core');
            expect(run('cd src && echo x > a.js', SUBAGENT)).toBeNull();
        });

        it('processEvent_aProjectOverrideThatLiftsAnEntry_isHonoredForTheNewForms', () => {
            tmp.write('.claude/guardrail-rules.project.yaml', 'except:\n  subagentReadOnlyPaths:\n    - .agents/core/gate.js\n');

            expect(run('cd .agents/core && echo x > gate.js', SUBAGENT)).toBeNull();
            expect(run('git restore .agents/core/gate.js', SUBAGENT)).toBeNull();
            expectTierBlock('cd .agents/core && echo x > commit.js');
        });

        it('processEvent_oddInput_neverThrows', () => {
            for (const command of ['cd', 'cd ""', "cd ''", 'pushd', 'popd', 'popd && popd', 'cd $UNSET && echo x > y', 'cd `pwd` && echo x > y', 'git', 'git -C', 'git -C ""', 'git restore', 'git checkout', 'git apply ""', 'patch ""', 'tar -xf', 'tar -C', 'unzip -d', 'unzip -d ""', 'cd ~ && echo x > y', 'cd ~/nope-dir && rm y']) {
                expect(() => run(command, SUBAGENT), command).not.toThrow();
                expect(() => run(command), command).not.toThrow();
            }
        });
    });
});
