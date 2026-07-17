// Supplementary adversarial coverage for CR-1.2 code-review follow-up (M3/M4) —
// two further guardrail bypasses of the non-escalatable zeroAccessPaths block,
// each confirmed with a repro. This file ADDS coverage; it never weakens
// guardrail.test.js or guardrail.bypass.test.js.
//
//   M3 — backslash-newline continuation: `rm -rf \`⏎`.env` splits on the `\n`,
//        orphaning `.env` so it is never extracted → only the escalatable
//        `rm -rf` nudge fires instead of the hard zeroAccessPaths block. Fixed
//        by the line-continuation collapse in the shared splitter.
//   M4 — UNQUOTED heredoc command substitution: an unquoted `<<EOF` body is
//        expanded by bash, so `$(rm -rf .env)` in it executes; the heredoc
//        blanking used to collapse it to `-m ""` before the delete was seen.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { processEvent } = require('../guardrail.cjs');
const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');

// `.env` is a zeroAccessPaths (non-escalatable) target; `rm -rf` is a nudge.
const RULES = `
block_patterns: []
nudge_patterns:
  - "rm -rf"
zeroAccessPaths:
  - ".env"
`;

describe('guardrail evasions — continuation & unquoted-heredoc bypasses (M3/M4)', () => {
  let tmp;
  let originalDir;

  beforeEach(() => {
    tmp = createTmpDir();
    originalDir = process.env.CLAUDE_PROJECT_DIR;
    tmp.write('.claude/guardrail-rules.yaml', RULES);
    tmp.write('.env', 'SECRET=1');
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
  });

  afterEach(() => {
    if (originalDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalDir;
    tmp.cleanup();
  });

  const hardBlocked = (cmd) => {
    const r = processEvent({ tool_input: { command: cmd } });
    return !!(r && r.block && r.telemetry && r.telemetry.tier === 'zeroAccessPaths');
  };
  const blocked = (cmd) => {
    const r = processEvent({ tool_input: { command: cmd } });
    return !!(r && r.block);
  };

  it('baseline: bare `rm -rf .env` is a non-escalatable hard block', () => {
    expect(hardBlocked('rm -rf .env')).toBe(true);
  });

  it('M3: `rm -rf \\`⏎`.env` is ALSO a hard block (continuation collapsed)', () => {
    expect(hardBlocked('rm -rf \\\n.env')).toBe(true);
    expect(hardBlocked('rm -rf \\\r\n.env')).toBe(true);
  });

  it('M3: continuation-split delete chained after a benign command still hard-blocks', () => {
    expect(hardBlocked('echo hi && rm -rf \\\n.env')).toBe(true);
  });

  it('M4: UNQUOTED heredoc `$(cat <<EOF … $(rm -rf .env) … EOF)` is blocked', () => {
    const cmd = 'git commit -m "$(cat <<EOF\n$(rm -rf .env)\nEOF\n)"';
    expect(blocked(cmd)).toBe(true);
  });

  it('M4: a QUOTED heredoc `<<\'EOF\'` benign body is still blanked (no false positive)', () => {
    // Quoted delimiter → inert body → safe to blank → the message text
    // "rm -rf .env" is not a real delete, so this must NOT block.
    const cmd = 'git commit -m "$(cat <<\'EOF\'\nfix: prevent rm -rf .env accidents\nEOF\n)"';
    const r = processEvent({ tool_input: { command: cmd } });
    expect(r).toBeNull();
  });

  it('legit inline message mentioning a protected path is not blocked (F61 preserved)', () => {
    const r = processEvent({ tool_input: { command: 'git commit -m "fix: guard rm -rf .env"' } });
    expect(r).toBeNull();
  });
});

// ── Finding 1: wrapper / path-prefix / bare-assignment head normalization ──────
// Before the fix, extractDeletePaths + extractAltDeleteTargets tested the RAW
// segment head, so a wrapper (`sudo`, `env FOO=1`, bare `FOO=bar`), a niceness
// wrapper, or a path-qualified binary (`/bin/rm`, `/usr/bin/truncate`) hid the
// real verb: `rm -rf .env` variants downgraded the non-escalatable
// zeroAccessPaths block to an escalatable nudge, and `sudo truncate`/`sudo shred`
// fully ALLOWED. Each cell of wrapper × verb × protected-target must now be a
// non-escalatable HARD block.
const MATRIX_RULES = `
block_patterns: []
nudge_patterns:
  - "rm -rf"
zeroAccessPaths:
  - ".env"
  - ".git"
`;

describe('guardrail finding-1 — wrapper/path/bare-env × verb × protected-target hard-blocks', () => {
  let tmp;
  let originalDir;

  beforeEach(() => {
    tmp = createTmpDir();
    originalDir = process.env.CLAUDE_PROJECT_DIR;
    tmp.write('.claude/guardrail-rules.yaml', MATRIX_RULES);
    tmp.write('.env', 'SECRET=1');
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
  });

  afterEach(() => {
    if (originalDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalDir;
    tmp.cleanup();
  });

  const hardBlocked = (cmd) => {
    const r = processEvent({ tool_input: { command: cmd } });
    return !!(r && r.block && r.telemetry && r.telemetry.tier === 'zeroAccessPaths');
  };

  // wrapper prefixes (the whole evasion class) × delete verbs × protected targets
  const wrappers = ['sudo ', 'env FOO=1 ', 'nice -n10 ', 'nohup ', 'time ', 'FOO=bar ', '/bin/', '/usr/bin/'];
  const verbs = ['rm -rf ', 'truncate -s0 ', 'shred '];
  const targets = ['.env', '.git'];

  for (const w of wrappers) {
    for (const v of verbs) {
      for (const t of targets) {
        const cmd = w + v + t;
        it(`hard-blocks: ${cmd}`, () => {
          expect(hardBlocked(cmd)).toBe(true);
        });
      }
    }
  }

  // The bare env-assignment variant of finding 1 shares the splitter fix.
  it('bare `FOO=bar rm -rf .env` is a non-escalatable hard block (shared splitter fix)', () => {
    expect(hardBlocked('FOO=bar rm -rf .env')).toBe(true);
    // ...and even carrying the escalation marker (path-tier wins over the nudge).
    expect(hardBlocked('FOO=bar rm -rf .env  # guardrail:confirm')).toBe(true);
  });

  // Must NOT over-block: the same wrapped verbs on a non-protected target are
  // NOT elevated to a zeroAccessPaths hard block (rm -rf still nudges via YAML;
  // truncate/shred/find on unprotected paths pass).
  it('does not over-block wrapped verbs on non-protected targets', () => {
    const notHard = (cmd) => {
      const r = processEvent({ tool_input: { command: cmd } });
      return !(r && r.telemetry && r.telemetry.tier === 'zeroAccessPaths');
    };
    expect(notHard('sudo truncate -s0 build/out.txt')).toBe(true);
    expect(notHard('env FOO=1 shred build/scratch')).toBe(true);
    expect(notHard('/bin/rm -rf ./src')).toBe(true); // nudge (YAML), not zeroAccess block
    expect(notHard('FOO=bar rm -rf build/')).toBe(true);
  });

  // ── MAJOR-2 (Wave-1 review): env/nice/timeout/stdbuf OWN FLAGS decorating a
  //    destructive verb must NOT bypass the zeroAccess `.env` hard block. The
  //    §3 batch happy-path used `env FOO=1`; these flag-decorated forms slipped
  //    past until stripWrapperPrefix learned each wrapper's option grammar. ──
  const flagDecorated = [
    'env -i rm .env', 'env - rm .env', 'env -u PATH rm .env',
    'env --ignore-environment rm .env', 'env -C /home/dom rm .env',
    'env --unset=PATH rm .env', 'env -i truncate -s0 .env',
    'nice --adjustment=10 rm .env', 'nice --adjustment 10 rm -rf .env',
    'timeout 5 rm .env', 'timeout -k 10 5 rm .env', 'timeout --signal=9 5 shred .env',
    'stdbuf -oL rm .env', 'stdbuf -o L rm -rf .env',
  ];
  for (const cmd of flagDecorated) {
    it(`hard-blocks flag-decorated: ${cmd}`, () => {
      expect(hardBlocked(cmd)).toBe(true);
    });
  }
});

describe('guardrail Wave-1 review — force-push ReDoS bound & sibling-rule closure', () => {
  let tmp;
  let originalDir;

  // Real block-tier rules copied from the live guardrail-rules.yaml so this
  // exercises the shipped regexes (force-push, +refspec, dd, del, git reset/clean).
  const REAL_RULES = `
block_patterns:
  - /git\\b(?:\\s+\\S+)*?\\s+push\\b[^;&|\\n]*(?:--force(?!-with-lease)\\b|\\s-\\w*f\\b)/
  - /git\\b(?:\\s+\\S+)*?\\s+push\\b[^;&|\\n]*\\s\\+[A-Za-z_/][^\\s:]*(?::[^\\s:]+)?(?:\\s|$)/
  - /\\bdd\\b[^;&|\\n]*\\bif=\\/dev\\/(?:zero|u?random)\\b/
nudge_patterns:
  - /\\bdel\\b[^;&|\\n]*(?:\\/s\\b[^;&|\\n]*\\/q\\b|\\/q\\b[^;&|\\n]*\\/s\\b)/
  - /git\\b[^;&|\\n]*\\breset\\b[^;&|\\n]*--hard\\b/
  - /git\\b[^;&|\\n]*\\bclean\\b[^;&|\\n]*(?:\\s-\\w*f\\w*\\b|--force\\b)/
`;

  beforeEach(() => {
    tmp = createTmpDir();
    originalDir = process.env.CLAUDE_PROJECT_DIR;
    tmp.write('.claude/guardrail-rules.yaml', REAL_RULES);
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
  });

  afterEach(() => {
    if (originalDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalDir;
    tmp.cleanup();
  });

  const blocked = (cmd) => {
    const r = processEvent({ tool_input: { command: cmd } });
    return !!(r && r.block);
  };

  // MAJOR-1: the force-push regex must not catastrophically backtrack. The old
  // nested-optional form hit ~483ms at 36 all-dash tokens; this runs on EVERY
  // Bash command, so a linear bound is a hard requirement.
  it('force-push regex is ReDoS-bounded on many all-dash tokens (no push)', () => {
    const cmd = 'git ' + Array.from({ length: 60 }, (_, i) => '-' + String.fromCharCode(97 + (i % 26))).join(' ') + ' status';
    const t0 = process.hrtime.bigint();
    processEvent({ tool_input: { command: cmd } });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms).toBeLessThan(50);
  });

  it('force-push variants still block; --force-with-lease still passes to confirm', () => {
    for (const c of ['git push --force', 'git push -f', 'git push --quiet --force',
                     'git -c k=v push --force', 'git push origin +main', 'git push origin +HEAD:main',
                     'git -c k=v push origin +main', 'git -c k=v push origin +HEAD:main']) {
      expect(blocked(c)).toBe(true);
    }
    // --force-with-lease is not a hard block (falls through to its confirm rule / passes here).
    const lease = processEvent({ tool_input: { command: 'git push --force-with-lease' } });
    expect(!!(lease && lease.block && !/confirm/i.test(lease.feedback || ''))).toBe(false);
    const leaseGlobal = processEvent({ tool_input: { command: 'git -c k=v push --force-with-lease' } });
    expect(!!(leaseGlobal && leaseGlobal.block && !/confirm/i.test(leaseGlobal.feedback || ''))).toBe(false);
  });

  // MINOR-4: the bounded `.*` must not mis-attribute a chained command's flag or
  // a trailing note's `+N` to the push.
  it('does not over-block a benign push with a chained --force or a trailing +N note', () => {
    expect(blocked('git push origin main && rm --force /tmp/x')).toBe(false);
    expect(blocked('git push origin main   deploy +1')).toBe(false);
    expect(blocked('git push origin main')).toBe(false);
  });

  // MINOR-3: sibling rules now tolerate reordering / intervening tokens.
  it('sibling destructive rules fire with intervening/reordered tokens', () => {
    expect(blocked('dd bs=1M if=/dev/zero of=/dev/sda')).toBe(true);
    expect(blocked('dd if=/dev/urandom of=/dev/sda')).toBe(true);
    expect(blocked('git -c x reset --hard')).toBe(true);
    expect(blocked('git reset -q --hard')).toBe(true);
    expect(blocked('git clean -q -fd')).toBe(true);
    expect(blocked('del /q /s C:/tmp')).toBe(true);
  });

  it('does not over-block the safe siblings (soft reset, dry-run clean, unstage)', () => {
    expect(blocked('git reset --soft HEAD~1')).toBe(false);
    expect(blocked('git clean -n')).toBe(false);
    expect(blocked('git reset -- file.txt')).toBe(false);
  });
});
