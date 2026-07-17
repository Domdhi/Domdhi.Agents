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

  // Wave 7 NIT: a --title value starting with `-` could be misread as a flag by
  // gh/az's own CLI arg parser (no shell exposure — this is an argv array — but
  // the target CLI's parser is a separate concern from shell injection).
  it.skipIf(!gitAvailable())('rejects a --title starting with "-"', () => {
    const repo = setupRepo(tmp, 'https://github.com/acme/widget.git');
    execFileSync('git', ['checkout', '-b', 'feat/dash'], { cwd: repo.repoPath, stdio: 'pipe' });
    const { status, stdout } = runPr(repo.repoPath, ['create', '--title', '-fix: thing', '--dry-run']);
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/--title must not start with/);
  });
});

describe('pull-request.js azurePrId', () => {
  it('returns --id as a string without calling az', () => {
    expect(pr.azurePrId({ id: 259 }, 'feat/x')).toBe('259');
  });
});

// ─── winQuote (F54 — cmd.exe-correct quoting) ────────────────────────────────
//
// cmd.exe does NOT treat `\"` as an escaped quote — it treats `\` as a literal
// backslash and `"` as an unescaped quote-terminator. The old winQuote escaped
// embedded quotes as `\"`, so a hostile title/branch like `x" & calc & "y`
// closed the quoted region early and let ` & calc & ` execute as a live cmd.exe
// command. The fix doubles an embedded `"` (`""`), which cmd.exe DOES honor as
// a literal quote, keeping the whole argument — metacharacters included —
// inside one quoted region.
describe('pull-request.js winQuote (F54)', () => {
  it('doubles an embedded double-quote instead of backslash-escaping it', () => {
    const out = pr.winQuote('x" & y');
    expect(out).not.toContain('\\"');
    expect(out).toContain('""');
  });

  it('wraps the whole quoted value in double quotes (metacharacters stay inside)', () => {
    const out = pr.winQuote('x" & calc & "y');
    expect(out.startsWith('"')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
    // The `&` must appear only WITHIN the quoted body, i.e. never immediately
    // after a quote that terminates the string. Concretely: stripping the
    // outer quotes and un-doubling `""`, the interior must round-trip exactly.
    const inner = out.slice(1, -1);
    expect(inner.replace(/""/g, '"')).toBe('x" & calc & "y');
  });

  it('leaves a plain arg with no metacharacters unquoted', () => {
    expect(pr.winQuote('simple-branch-name')).toBe('simple-branch-name');
  });

  it('quotes an arg containing only whitespace-safe metacharacters (&, space)', () => {
    const out = pr.winQuote('feat: add thing & more');
    expect(out.startsWith('"')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
    expect(out).not.toContain('\\"');
  });

  // ── m3: trailing-backslash hardening ────────────────────────────────────
  // The downstream argv parser consumes backslashes immediately preceding a
  // `"` in pairs — an ODD count right before the closing quote we add reads as
  // an escaped literal `"`, not a terminator, so the quoted region never
  // closes. Doubling the trailing run keeps the count even.
  it('doubles a single trailing backslash so the closing quote is not escaped', () => {
    // Input ends in one backslash; needs whitespace to enter the quoting path.
    const out = pr.winQuote('a b\\');
    expect(out).toBe('"a b\\\\"'); // "a b\\" (2 backslashes) + closing quote
    // The character immediately before the final `"` must be part of an EVEN
    // run of backslashes (so the parser reads the last `"` as a terminator).
    const beforeClosingQuote = out.slice(0, -1);
    const trailingRun = beforeClosingQuote.match(/\\+$/)?.[0] ?? '';
    expect(trailingRun.length % 2).toBe(0);
  });

  it('doubles a double trailing backslash (4 backslashes before the closing quote)', () => {
    const out = pr.winQuote('a b\\\\'); // input ends in TWO backslashes
    expect(out).toBe('"a b\\\\\\\\"'); // doubled to 4, then closing quote
    const beforeClosingQuote = out.slice(0, -1);
    const trailingRun = beforeClosingQuote.match(/\\+$/)?.[0] ?? '';
    expect(trailingRun.length % 2).toBe(0);
  });

  it('does not alter an embedded (non-trailing) backslash', () => {
    const out = pr.winQuote('a\\b c'); // backslash in the middle, space forces quoting
    expect(out).toBe('"a\\b c"');
  });
});
