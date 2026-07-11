// Tests for pull-request.js — the host-detecting PR helper.
//
// Strategy:
//   - Pure unit tests for parseRemoteUrl / parseArgs / buildCreatePlan (no I/O).
//   - Integration tests spawn the real script against an isolated git repo with a
//     fake `origin`, exercising create --dry-run (asserts the command SEQUENCE and
//     that nothing is pushed) and the pre-flight refusal on the default branch.
//     No network: dry-run prints commands without running them; the refusal aborts
//     before any fetch/push.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { createGitRepo, gitAvailable } = require('./_helpers/git-fixture');
const pr = require('../pull-request');

const PR_JS = path.resolve(__dirname, '../pull-request.js');

// ─── parseRemoteUrl ──────────────────────────────────────────────────────────
describe('pull-request.js parseRemoteUrl', () => {
  it('parses GitHub https URLs', () => {
    expect(pr.parseRemoteUrl('https://github.com/Domdhi/Domdhi.Agents.git'))
      .toEqual({ host: 'github', org: 'Domdhi', project: null, repo: 'Domdhi.Agents' });
  });

  it('parses GitHub ssh URLs', () => {
    expect(pr.parseRemoteUrl('git@github.com:acme/widget.git'))
      .toEqual({ host: 'github', org: 'acme', project: null, repo: 'widget' });
  });

  it('parses Azure DevOps (dev.azure.com) URLs', () => {
    expect(pr.parseRemoteUrl('https://NMMFA@dev.azure.com/NMMFA/Mfa.Hub/_git/Mfa.Hub'))
      .toEqual({ host: 'azure', org: 'NMMFA', project: 'Mfa.Hub', repo: 'Mfa.Hub' });
  });

  it('parses legacy *.visualstudio.com URLs', () => {
    expect(pr.parseRemoteUrl('https://nmmfa.visualstudio.com/Proj/_git/Repo'))
      .toEqual({ host: 'azure', org: 'nmmfa', project: 'Proj', repo: 'Repo' });
  });

  it('throws on an unrecognized host', () => {
    expect(() => pr.parseRemoteUrl('https://gitlab.com/acme/widget.git')).toThrow(/unrecognized git host/);
  });

  it('throws on an empty/missing URL', () => {
    expect(() => pr.parseRemoteUrl('')).toThrow(/no origin remote/);
    expect(() => pr.parseRemoteUrl(null)).toThrow(/no origin remote/);
  });

  it('tolerates a trailing slash on the origin URL (n2)', () => {
    // Some clones/config emit a trailing slash; the $-anchored host regexes would
    // otherwise fall through to the unrecognized-host throw.
    expect(pr.parseRemoteUrl('https://github.com/Domdhi/Domdhi.Agents/'))
      .toEqual({ host: 'github', org: 'Domdhi', project: null, repo: 'Domdhi.Agents' });
    expect(pr.parseRemoteUrl('https://github.com/Domdhi/Domdhi.Agents.git/'))
      .toEqual({ host: 'github', org: 'Domdhi', project: null, repo: 'Domdhi.Agents' });
    expect(pr.parseRemoteUrl('https://NMMFA@dev.azure.com/NMMFA/Mfa.Hub/_git/Mfa.Hub/'))
      .toEqual({ host: 'azure', org: 'NMMFA', project: 'Mfa.Hub', repo: 'Mfa.Hub' });
  });
});

// ─── parseArgs ───────────────────────────────────────────────────────────────
describe('pull-request.js parseArgs', () => {
  it('extracts the subcommand and flags', () => {
    const r = pr.parseArgs(['create', '--title', 'feat: x', '--draft', '--dry-run']);
    expect(r.sub).toBe('create');
    expect(r.title).toBe('feat: x');
    expect(r.draft).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.force).toBe(false);
  });

  it('defaults the body file and parses --id as a number', () => {
    const r = pr.parseArgs(['status', '--id', '259']);
    expect(r.sub).toBe('status');
    expect(r.id).toBe(259);
    expect(r.bodyFile).toBe(path.join('docs', '.output', '.state', '.pr-body'));
  });

  it('honors --body-file override and -n alias for dry-run', () => {
    const r = pr.parseArgs(['create', '--body-file', '/tmp/b.md', '-n']);
    expect(r.bodyFile).toBe('/tmp/b.md');
    expect(r.dryRun).toBe(true);
  });
});

// ─── buildCreatePlan ─────────────────────────────────────────────────────────
describe('pull-request.js buildCreatePlan', () => {
  it('GitHub: push → create → auto-merge → verify, with squash+delete', () => {
    const plan = pr.buildCreatePlan({
      host: 'github', branch: 'feat/x', base: 'main', title: 'feat: x', bodyFile: 'b.md', draft: false, repo: 'widget',
    });
    expect(plan[0].bin).toBe('git');
    expect(plan[0].args).toEqual(['push', '-u', 'origin', 'feat/x']);
    expect(plan[1].args).toEqual(['pr', 'create', '--base', 'main', '--head', 'feat/x', '--title', 'feat: x', '--body-file', 'b.md']);
    expect(plan[2].args).toEqual(['pr', 'merge', 'feat/x', '--auto', '--squash', '--delete-branch']);
    expect(plan[3].args).toContain('number,state,autoMergeRequest');
  });

  it('GitHub: --draft adds --draft to the create step only', () => {
    const plan = pr.buildCreatePlan({ host: 'github', branch: 'f', base: 'main', title: 't', bodyFile: 'b', draft: true });
    expect(plan[1].args).toContain('--draft');
    expect(plan[2].args).not.toContain('--draft');
  });

  it('Azure: create carries --auto-complete/--squash/--delete-source-branch', () => {
    const plan = pr.buildCreatePlan({
      host: 'azure', branch: 'feat/x', base: 'main', title: 'feat: x', bodyFile: 'b.md', draft: false,
      project: 'Proj', repo: 'Repo',
    });
    expect(plan[0].bin).toBe('git');
    expect(plan[1].bin).toBe('az');
    expect(plan[1].args).toEqual(expect.arrayContaining([
      '--auto-complete', 'true', '--squash', 'true', '--delete-source-branch', 'true',
      '--project', 'Proj', '--repository', 'Repo',
    ]));
    expect(plan[1].args).toContain('@b.md'); // description sourced from the body file
  });
});

// ─── Integration: create --dry-run + pre-flight refusal ──────────────────────
function setupRepo(tmp, remoteUrl) {
  const repo = createGitRepo({ root: tmp.root });
  execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: repo.repoPath, stdio: 'pipe' });
  return repo;
}

function runPr(repoPath, args) {
  try {
    const stdout = execFileSync('node', [PR_JS, ...args], { cwd: repoPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status ?? 1, stdout: (e.stdout || '') + (e.stderr || '') };
  }
}

describe('pull-request.js create (integration, no network)', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir({ prefix: 'pr-test-' }); });
  afterEach(() => tmp.cleanup());

  it.skipIf(!gitAvailable())('GitHub dry-run prints the full gh command sequence and pushes nothing', () => {
    const repo = setupRepo(tmp, 'https://github.com/acme/widget.git');
    execFileSync('git', ['checkout', '-b', 'feat/x'], { cwd: repo.repoPath, stdio: 'pipe' });

    const { status, stdout } = runPr(repo.repoPath, ['create', '--title', 'feat: thing', '--dry-run']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/host: github/);
    expect(stdout).toMatch(/gh pr create --base main --head feat\/x/);
    expect(stdout).toMatch(/gh pr merge feat\/x --auto --squash --delete-branch/);
    expect(stdout).toMatch(/dry-run only — nothing pushed/);
  });

  it.skipIf(!gitAvailable())('Azure dry-run prints az repos pr create with auto-complete', () => {
    const repo = setupRepo(tmp, 'https://NMMFA@dev.azure.com/NMMFA/Mfa.Hub/_git/Mfa.Hub');
    execFileSync('git', ['checkout', '-b', 'feat/y'], { cwd: repo.repoPath, stdio: 'pipe' });

    const { status, stdout } = runPr(repo.repoPath, ['create', '--title', 'feat: y', '--dry-run']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/host: azure/);
    expect(stdout).toMatch(/az repos pr create/);
    expect(stdout).toMatch(/--auto-complete true/);
  });

  it.skipIf(!gitAvailable())('refuses to create a PR from the default branch', () => {
    const repo = setupRepo(tmp, 'https://github.com/acme/widget.git');
    // Still on main (the fixture's default) — no feature branch.
    const { status, stdout } = runPr(repo.repoPath, ['create', '--title', 'feat: nope']);
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/default\/protected branch/);
  });

  it.skipIf(!gitAvailable())('refuses an unrecognized host', () => {
    const repo = setupRepo(tmp, 'https://gitlab.com/acme/widget.git');
    execFileSync('git', ['checkout', '-b', 'feat/z'], { cwd: repo.repoPath, stdio: 'pipe' });
    const { status, stdout } = runPr(repo.repoPath, ['create', '--title', 'feat: z', '--dry-run']);
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/unrecognized git host/);
  });

  it('requires --title for create', () => {
    // No repo needed — but origin must parse; use a throwaway repo with a github remote.
    const repo = createGitRepo({ root: tmp.root });
    if (!repo) return;
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widget.git'], { cwd: repo.repoPath, stdio: 'pipe' });
    execFileSync('git', ['checkout', '-b', 'feat/n'], { cwd: repo.repoPath, stdio: 'pipe' });
    const { status, stdout } = runPr(repo.repoPath, ['create', '--dry-run']);
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/requires --title/);
  });
});
