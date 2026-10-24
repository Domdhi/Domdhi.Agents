---
description: Execute a manual/E2E testing checklist with parallel agents, screenshots, and TODO updates — plus canary mode (--baseline / --compare) for post-deploy golden-signal monitoring
argument-hint: [testing TODO file] [--baseline | --compare {baseline.json}] [--tolerance N]
---

<!-- Generated from .agents/skills/run-tests/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# /run-tests — Manual Testing Executor

Execute structured manual/E2E testing checklists against a running app. Main Agent owns the TaskList, triages results, and makes every judgment call. Playwright agents handle browser interactions. Main Agent handles non-browser checks directly — no delegation overhead for code/schema verification.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js run-tests
```

## Model Rule

**All browser-facing agents (playwright or chrome MCP) MUST use `model: "sonnet"`.** Do not dispatch the `fast` tier until its bounded evaluation passes. The recorded 2026-06-02 Haiku 4.5 trial fabricated results, claiming an element existed or an interaction succeeded without reading the accessibility tree. Browser agents must verify element existence, text content, disabled states, aria attributes, and interaction flows. Visual/design QA (spacing, alignment, color, responsive) is a separate human pass.

## Browser Tool Selection

Two browser tools are available. Use the RIGHT one for the job:

| Tool | Agent Type | When to Use |
|------|-----------|-------------|
| `playwright-cli` | `playwright` agent | Headless automation, screenshots, form fills, navigation. Best for spec file generation and repeatable tests. No user session — cannot test logged-in routes. |
| `mcp__claude-in-chrome__*` | `claude` agent | Live Chrome interaction in the user's real session (same auth, same cookies). Requires Chrome running. |

**Chrome MCP agents MUST be `subagent_type: "claude"` — NEVER `general-purpose`.** The `general-purpose` type has only Read/Write/Edit/Bash/Grep/Glob: no `mcp__claude-in-chrome__*` tools AND no ToolSearch to load them, so every browser checkpoint blocks (field-verified 2026-07-16 on an adopter: an entire 4-agent browser wave failed on exactly this). Only the `claude` catch-all type carries the MCP tools.

**Default to `claude` with chrome MCP** when Chrome is available (check with `mcp__claude-in-chrome__tabs_context_mcp`). Fall back to `playwright` agent when Chrome is not available or for headless-only environments. If a specific browser must be targeted (multiple Chromes connected), the MAIN agent calls `select_browser` once before dispatching — the selection carries to subagents; agents must NOT call `select_browser`/`list_connected_browsers` themselves.

When dispatching `claude` agents for browser testing, include this in the prompt:
```
BROWSER TOOLS: Use the mcp__claude-in-chrome__* tools for browser interaction.
If they are not directly callable, load them via ToolSearch in ONE call:
"select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__read_console_messages"
The browser is already selected — do NOT call select_browser or list_connected_browsers.
Start with tabs_context_mcp, then tabs_create_mcp to create YOUR OWN tab.
Use ONLY that tabId — other agents share this browser; never touch other tabs.
Use navigate to go to pages, read_page to inspect content, computer for clicks,
read_console_messages (onlyErrors: true, clear: true) after each page load.
```

Parallel is safe: up to 4 concurrent `claude` agents sharing one Chrome, each in its own tab, verified with no interference.

## Standing post-deploy gate

A full-app browser pass is a **load-bearing gate layer, not optional QA**: it is the only layer that catches render-only defects — hydration mismatches, server-session state errors, runtime-interpolated Tailwind classes the JIT never generated (in a project that uses Tailwind), blank-`<Outlet/>` routes — all of which pass typecheck/lint/build/unit-tests cleanly. (Evidence: a 2026-07-16 full-app pass on an adopter, 76/81 checkpoints, found 3 real bugs invisible to every static gate.) After any deploy that touches multiple modules (a remediation run, a sweep's fix batch, a route-config change), run at least the affected modules' checkpoints before declaring the deploy verified.

## Repeated runs via `/loop`

`/run-tests` is one-shot — it executes the checklist once and reports. For repeated execution (post-deploy verification, mid-day regression polling, pre-merge canary), wrap it with the built-in `/loop` primitive instead of re-implementing scheduling here:

```
/loop 10m /run-tests docs/modules/{feature}/TODO_testing.md
```

`/loop` is session-scoped (lives until the session ends or 7 days — Claude Code 2.1.x) and fires the inner command on the chosen interval. Pick the cadence to match what you're watching for:

| Cadence | Use case |
|---------|----------|
| `5m`–`15m` | Active deploy window — catch regressions immediately after each push |
| `30m`–`1h` | Mid-day polling on a busy branch — smoke checklist re-run |
| `2h`–`6h` | Background canary — broader checklist, low-frequency assurance |

Each iteration writes a fresh, run-stamped tracked report (`docs/.output/findings/reviews/{YYMMDD-HHMM}-test-{task}.md`, Step 11), so history accumulates; its screenshots under `docs/.output/.state/screenshots/{date}/{Task}/` are ignored scratch that later loops overwrite. **Don't build a standalone `/canary` command or a `/run-tests --watch` flag** — the *scheduling* half of a canary is just a `/loop` wrapper, and re-implementing scheduling primitives we already have is duplication. The same applies to any future scheduled-command idea (cleanup, listen, monitor): start by trying `/loop /<command>` first.

What `/loop` does **not** give you is the *stateful* half of a canary — capturing a known-good baseline, diffing live samples against it, and tolerating transient blips. That lives in **Canary Mode** below (`--baseline` / `--compare`), driven by `/loop` for the polling:

```
/run-tests --baseline                              # once, pre-deploy: snapshot golden signals
/loop 60s /run-tests --compare baseline-{slug}.json   # post-deploy: /loop polls, --compare diffs + tolerates transients
```

This is the deliberate split: `/loop` owns *when to sample*, Canary Mode owns *what changed vs. baseline and whether it's real*. Neither re-implements the other.

## Persistent Test Output

**Agents SHOULD produce permanent, rerunnable test artifacts — not throwaway reports.**

When the project has an E2E test framework (Playwright, Cypress, etc.):
- Agents write spec files to the project's test directory (e.g., `test/__test__/`, `e2e/`, `tests/`)
- Specs follow the project's existing patterns (auth/unauth separation, setup files, fixtures)
- Main Agent runs the test suite after spec generation to verify they pass
- Spec files are committed to source control

When no test framework exists:
- Agents still write structured verification scripts or checklists
- Screenshots go to `docs/.output/.state/screenshots/{date}/{task}/` (ignored scratch); the run's report goes to the tracked path in Step 11

The goal: every test run leaves behind artifacts that can be re-executed without Claude.

## Variables

ARGS: $ARGUMENTS

- `TODO_FILE` — path to a testing checklist (the default mode; see Phase 0).
- `--baseline` — **Canary Mode (capture).** Visit the target page(s), record golden signals as the known-good baseline, exit. No checklist required.
- `--compare {baseline.json}` — **Canary Mode (verify).** Visit the same page(s), diff golden signals vs the baseline, apply transient tolerance, emit a verdict. No checklist required.
- `--tolerance N` — consecutive breaches required before a regression escalates to `REGRESSED` (default **2**, matching gstack's 2-consecutive-check rule). Only meaningful with `--compare`.

If `--baseline` or `--compare` is present, run **Canary Mode** (below) instead of the checklist phases. The two are mutually exclusive. A `TODO_FILE` may still be supplied alongside `--compare` to scope which pages to sample (its target URL + page list); without one, sample the app root or the URLs given.

---

## Canary Mode (`--baseline` / `--compare`)

Post-deploy soak monitoring, **without a standalone command**. The scheduling half is `/loop`'s job (see "Repeated runs via `/loop`" above); this mode owns the stateful half — baseline capture, golden-signal delta, and transient tolerance. Inspiration: gstack `/canary` (`docs/research/competitive/_gstack-deep-dive.md` :339); framing: Google SRE four golden signals (alert thresholds derived from baseline, not absolutes).

### The four golden signals (per page)

Synthetic browser probing observes three of the four SRE golden signals; traffic/saturation aren't visible from a synthetic probe and are out of scope.

| Signal | What's captured | SRE signal | Severity if breached vs baseline |
|--------|-----------------|------------|----------------------------------|
| **Availability** | page loads (HTTP 2xx, no nav error) | errors/availability | **CRITICAL** — page-load failure |
| **Errors** | console errors + failed network requests (the *set*) | errors | **HIGH** — a *new* error not in baseline |
| **Latency** | page load time (ms) | latency | **MEDIUM** — `latency_ms > 2× baseline` |
| **Integrity** | in-page links resolve (the broken-link *set*) | errors | **LOW** — a *new* broken link |

Severity tiers are the gstack monitors verbatim. "Breach" is always *relative to baseline* — a console error that was already present at baseline is not a regression.

### `--baseline` (capture, run once pre-deploy)

1. Resolve the target page(s): the `TODO_FILE` target URL + its listed pages, or the URLs passed as args, or the app root. Pre-flight each with `curl` (HARD STOP if the app isn't running — same rule as Phase 0 Step 3).
2. Dispatch a **standard** browser agent (chrome MCP preferred, playwright fallback — same selection rule as the checklist mode) to visit each page and record the four signals. Take one baseline screenshot per page into `docs/.output/evolution/canary/baseline/`.
3. Write `docs/.output/evolution/canary/baseline-{slug}.json` (slug = project or feature name; **stable filename, not date-rotated**, so `--compare` can find it across days):
   ```json
   {
     "captured": "{YYYY-MM-DD HH:MM}",
     "pages": {
       "{url}": { "availability": true, "errors": [...], "latency_ms": 840, "links_broken": [] }
     }
   }
   ```
4. **Reset the streak file** `docs/.output/evolution/canary/{YYYY-MM-DD}/_streak.json` to `{}` — a fresh baseline starts a fresh tolerance count.
5. Report the baseline path + per-page signal table. Do not commit unless asked (baselines are environment-specific; usually gitignored operational state).

### `--compare {baseline.json}` (verify, run on every poll)

This is what `/loop` fires each interval. It samples **once** and persists state — **it does NOT loop internally** (looping is `/loop`'s job; smuggling a `while`/poll here is the exact duplication this design avoids).

1. Read the baseline + the current streak file (`docs/.output/evolution/canary/{date}/_streak.json`, default `{}`).
2. Dispatch the browser agent (standard) to re-sample the same pages — same signals.
3. **Diff vs baseline.** For each page+signal, decide breached/clear:
   - availability false → CRITICAL breach
   - any error in current ∖ baseline (set difference) → HIGH breach
   - `latency_ms > 2 × baseline.latency_ms` → MEDIUM breach
   - any broken link in current ∖ baseline → LOW breach
4. **Update streaks.** For each signal: breached → `streak[sig] += 1`; clear → `streak[sig] = 0`. Write the streak file back.
5. **Verdict** (`--tolerance N`, default 2):
   - **HEALTHY** — no breaches this sample.
   - **TRANSIENT** — breaches present, but every breached signal's streak `< N` (could be a blip; keep watching). Don't alarm.
   - **REGRESSED** — at least one breached signal's streak `≥ N` (persisted across N consecutive samples → real). Surface loudly; recommend rollback / `/investigate`.
6. Write a run record `docs/.output/evolution/canary/{date}/canary-{HH:MM}.md` — the verdict + a table (page · signal · baseline · current · breach? · streak · severity), and on REGRESSED the offending signal(s) and a one-line recommended action.
7. Report the verdict line. Under `/loop`, only a REGRESSED verdict warrants interrupting the user; HEALTHY/TRANSIENT runs just append their record.

### Why this honors the "no standalone /canary" rule

`/loop /run-tests --compare …` is the whole canary: `/loop` schedules, `--compare` does baseline-delta + 2-check tolerance. No new command, no re-implemented scheduler — the two existing primitives compose into exactly gstack's behavior. (Decision: 2026-06-05; see `docs/.output/plans/2026-06-05-do-canary-via-runtests.md`.)

---

## Phase 0: Pre-Flight

### Step 1: Locate the Testing Checklist

```
IF TODO_FILE provided → read that file
ELSE → search:
  1. docs/modules/**/TODO*Test*.md or docs/work/todo/**/TODO*Test*.md
  2. docs/modules/**/*testing*.md or docs/work/todo/**/*testing*.md
IF multiple found → ask user which one
IF none found → ask user
```

### Step 2: Parse the Checklist

Extract:
- **Total checkpoints** by status: `[ ]` pending, `[x]` passed, `[!]` blocked/failed, `[S]` skipped
- **Categories** with dependency ordering (which categories gate others)
- **Target URL** and auth method
- **Known blockers** from previous runs

Identify:
- Categories already `[x]` → skip
- Categories `[!]` from prior run → re-test if user wants
- Categories `[ ]` pending → execute

### Step 3: Pre-flight checks

```bash
# Verify app is running
curl -s -o /dev/null -w "%{http_code}" {TARGET_URL}
```

- App not running → **HARD STOP**. Report that the app needs to be started. Do not test against nothing. Do not proceed to any other step. Do not dispatch any agents.
- App running but returning errors → warn, continue if user confirms

Create screenshot directories upfront:
```bash
mkdir -p docs/.output/.state/screenshots/{YYYY-MM-DD}/{Task}/cat-{NN}/
```

### Step 4: Build the TaskList (spine)

Create TaskCreate items for the pipeline:

```
TaskCreate: "Pre-flight checks" → mark completed (already done)
TaskCreate: "Discover test selectors"
TaskCreate: "Non-browser checks (Main Agent direct)" (blockedBy: selectors)

--- Wave 1 (browser) ---
TaskCreate: "Wave 1: Cat {N} — {Name}" (blockedBy: non-browser)
TaskCreate: "Wave 1: Cat {M} — {Name}" (blockedBy: non-browser)
TaskCreate: "Wave 1: Triage results + update TODO" (blockedBy: wave 1 cats)

--- Wave 2 ---
TaskCreate: "Wave 2: Cat {P} — {Name}" (blockedBy: wave 1 triage)
...

--- Post ---
TaskCreate: "Cleanup + final report" (blockedBy: last wave)
```

---

## Phase 1: Preparation

### Step 5: Discover Test Selectors

`TaskUpdate: "Discover test selectors" → in_progress`

Before dispatching browser agents, verify actual test selectors exist in the codebase:

**Use `general-purpose` (NOT `Explore`) — Explore is read-only and cannot write the selector map to disk for reuse across browser agents.** (`general-purpose` is correct HERE because selector discovery is grep/write work, not browser work — the claude-type rule in Browser Tool Selection applies only to agents that drive Chrome.)

```
Agent(
  subagent_type: "general-purpose",
  prompt: "Search the source tree for all data-testid attributes related to {feature}. Write the exact selector map organized by component to docs/.output/.state/work/{date}/{slug}/{time}-selectors.md, then return a concise summary.",
  description: "Find test selectors for {feature}"
)
```

This prevents agents from searching for selectors that don't exist. Save the selector map for inclusion in agent prompts.

`TaskUpdate: "Discover test selectors" → completed`

### Step 6: Non-Browser Checks (Main Agent Direct)

`TaskUpdate: "Non-browser checks" → in_progress`

Main Agent handles these directly — no delegation overhead:
- **Schema verification** — read migration/schema files, confirm structure
- **Seed data checks** — query or read seed files
- **Code inspection** — grep for expected patterns, imports, registrations
- **Config verification** — read config files, confirm values

Mark these categories `[x]` in the TODO file immediately after verification.

**Runtime and verification.** This workflow tests the running application; it never runs the Domdhi.Agents toolkit suite, and any persistent spec it writes joins the application's own test command. In Codex, run each `.claude/core/` command in this workflow as `.codex/core/` with the same arguments, per `.agents/adapters/codex/execution.md`, and use the browser tools the Codex runtime provides. Discovery alone (an installed skill, a listed command or a loaded file) never proves this workflow ran: report results only from checkpoint evidence (screenshots, console reads, spec runs) and the Step 13 commit hash.

`TaskUpdate: "Non-browser checks" → completed`

---

## Phase 2: Browser Testing (Wave Execution)

### For each wave:

#### Step 7: Classify and dispatch agents

`TaskUpdate: "Wave {N}: Cat {X}" → in_progress` (for each category)

**Agent selection per checkpoint type:**

| Interaction Type | Who | Model | Rationale |
|-----------------|-----|-------|-----------|
| Code/file/schema verification | Main Agent (already done in Step 6) | — | No browser needed |
| Page load + screenshot | `claude` agent (chrome MCP) | standard | Navigate, screenshot, read text — chrome MCP preferred |
| Button click + form fill | `claude` agent (chrome MCP) | standard | Standard interaction via live Chrome |
| Complex UI + code inspection | `claude` agent (chrome MCP) | standard | Combine browser MCP and grep/read |
| Headless / CI environment | `playwright` agent | standard | Primary for headless/CI environments |

**Prefer `claude` with chrome MCP over `playwright` agent.** The chrome MCP tools interact with the user's actual browser — same session, same auth state, same cookies. `playwright` is the fallback for headless environments. NEVER `general-purpose` for browser work — it has no MCP tools and no ToolSearch (see Browser Tool Selection).

**Dispatch up to 4 parallel agents per wave.**

Each agent prompt MUST include:

```
CATEGORY: {N} — {Name}
TARGET: {URL}
AUTH: {method — e.g., "already logged in", "use test credentials X/Y"}

CHECKLIST:
{Paste exact checklist items with expected outcomes}

TEST SELECTORS:
{Selector map from Step 5 for this category's components}

PROJECT CONSTRAINTS (when verified project instructions or source bind this category):
{Reference paths and the verified project constraints that bind these checkpoints}

SCREENSHOT FOLDER: docs/.output/.state/screenshots/{YYYY-MM-DD}/{Task}/cat-{N}/
Create this directory first with mkdir.

BROWSER TOOLS (chrome MCP — preferred):
Use the mcp__claude-in-chrome__* tools for all browser interaction.
If they are not directly callable, load them via ToolSearch in ONE call:
"select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__read_console_messages,mcp__claude-in-chrome__find,mcp__claude-in-chrome__form_input"
The browser is already selected — do NOT call select_browser or list_connected_browsers.
- mcp__claude-in-chrome__tabs_context_mcp — see current tabs (call first)
- mcp__claude-in-chrome__tabs_create_mcp — create YOUR OWN tab; use ONLY that tabId
  (other agents share this browser — never touch other tabs)
- mcp__claude-in-chrome__navigate — go to pages
- mcp__claude-in-chrome__read_page — inspect content and DOM
- mcp__claude-in-chrome__computer — clicks, typing, interactions
- mcp__claude-in-chrome__read_console_messages — check onlyErrors:true, clear:true after each load
- mcp__claude-in-chrome__find — search for elements
- mcp__claude-in-chrome__form_input — fill form fields

If chrome MCP is not available, fall back to playwright-cli commands.

INSTRUCTIONS:
0. FIRST: Run `curl -s -o /dev/null -w "%{http_code}" {TARGET}/api/health` — if it does NOT return 200, report STATUS: BLOCKED with "dev server not running" and STOP IMMEDIATELY. Do NOT fall back to code review. Do NOT create verification documents. Do NOT proceed.
1. Take a page snapshot BEFORE interacting with any page
2. Use element refs from snapshots — never guess selectors
3. Take a screenshot at EVERY verification point
4. If a checkpoint is BLOCKED (element missing, page error), fast-fail remaining items in this category
5. Verify data state after UI actions — confirm the action persisted
6. NEVER pivot to code review if browser testing fails. Report BLOCKED and stop.

PERSISTENT OUTPUT:
If the project has an E2E test framework (check for playwright.config.*, cypress.config.*, etc.):
- Write a spec file for this category's checkpoints following the project's existing test patterns
- Place unauthenticated specs in the project's unauth test dir, authenticated specs in the auth test dir
- The spec should be permanent, rerunnable, and committable to source control

If no test framework exists:
- Write TEST_REPORT.md in the screenshot folder with results (ignored scratch; the Main Agent carries them into the tracked Step 11 report)

STATUS — Report your completion status as ONE of:
- DONE — all checkpoints passed
- DONE_WITH_CONCERNS — passed but something was flaky or suspicious
- BLOCKED — could not test (explain what's missing or broken)
- NEEDS_CONTEXT — need more information (list specific questions)

OUTPUT:
- Each checkpoint: PASS / FAIL / BLOCKED / SKIP with evidence
- Screenshots referenced by filename
- Spec file path (if written)
- Your STATUS
```

**All agents for one wave go in a single message — `claude` type with chrome MCP:**
```
Agent(subagent_type: "claude", model: "sonnet", prompt: "{cat N prompt with chrome MCP tools}", description: "Test Cat {N}: {Name}")
Agent(subagent_type: "claude", model: "sonnet", prompt: "{cat M prompt with chrome MCP tools}", description: "Test Cat {M}: {Name}")
```

#### Step 8: Triage results and update TODO

`TaskUpdate: "Wave {N}: Triage" → in_progress`

**8a. Read each agent's STATUS:**

| Status | Action |
|--------|--------|
| **DONE** | Mark all checkpoints `[x]` in TODO |
| **DONE_WITH_CONCERNS** | Read concerns. If flaky → mark `[x]` but note in report. If suspicious → re-run that category. Log to `docs/.output/evolution/agents/{YYYY-MM-DD}.md`. |
| **BLOCKED** | Read blocker. Mark affected checkpoints `[!]` with root cause. Assess impact on downstream waves. |
| **NEEDS_CONTEXT** | Answer questions, re-dispatch that agent only. |

**8b. Update TODO checkmarks (batch per wave):**

```
[x]  — checkpoint passed
[!]  — checkpoint blocked or failed (with reason after em dash)
[S]  — checkpoint skipped (not applicable in this environment)
```

**Annotation convention:**
```markdown
- [x] 2.1 — Icon renders in header
- [!] 4.1 — Toast appears — BLOCKED: component overlay intercepts clicks
- [!] 4.11 — Data column shows values — FAIL: BUG — data not persisted
- [S] 7.2 — Unauthorized user gets 403 — SKIP: only admin user available
- [x] 10.3 — Validation works (verified via code review)
```

**8c. Gate check for next wave:**
- If a gate-required category failed → assess whether downstream waves can proceed
- If truly blocked → skip downstream, report at end

`TaskUpdate: "Wave {N}: Triage" → completed`

#### Step 9: Next wave

Move to next wave. Repeat from Step 7.

---

## Phase 3: Post-Execution

### Step 10: Cleanup

Run any cleanup from the checklist:
- Delete test data
- Reset modified configs
- Do NOT stop the dev server unless user asks

Then refresh the master tracker so any TODO status changes from Step 8 propagate to it — best-effort, silently no-ops if the project has no `TODO_{Project}.md` (offline + idempotent, always safe to call):

```bash
node .claude/core/status.js --regen-master
```

### Step 11: Final Report

`TaskUpdate: "Cleanup + final report" → completed`

Write the report to the tracked path `docs/.output/findings/reviews/{YYMMDD-HHMM}-test-{task}.md` (one run stamp per run). Reference screenshots by their paths under `docs/.output/.state/screenshots/{YYYY-MM-DD}/{Task}/`; that folder is ignored scratch, so the report itself must carry every result and finding:

```markdown
## Manual Test Report

**Date:** {YYYY-MM-DD}
**Target:** {TARGET_URL}
**Total Checkpoints:** {N}

### Summary

| Metric | Count |
|--------|-------|
| **Passed** | X |
| **Failed** | X |
| **Blocked** | X |
| **Skipped** | X |

**Pass Rate (testable):** X/Y = Z%

### Results by Category
| Cat | Name | Total | Pass | Fail | Blocked | Skip | Wave | Agent | Status |
| ... |

### Bugs Found
#### BUG-1: {Title}
- **Severity:** High/Medium/Low
- **Description:** ...
- **Root Cause:** ...

### Blocked Checkpoints Root Cause
{Common root cause for blocked items}

### Agent Performance
| Metric | Count |
|--------|-------|
| Total agents dispatched | {n} |
| DONE | {n} |
| DONE_WITH_CONCERNS | {n} |
| BLOCKED | {n} |
| Issues logged to docs/.output/evolution/agents/{YYYY-MM-DD}.md | {n} |

### Recommendations
1. ...
```

### Step 12: Regenerate the session handoff — session-handoff skill

After the Step 11 report is written, refresh the session handoff using the **`session-handoff`** skill (`.claude/skills/session-handoff/SKILL.md`). Resolve this run's path once and reuse it for the `git add` in Step 13:

```bash
HANDOFF=$(node .claude/core/handoff-path.js write run-tests)
```

Read that skill for the template, rules, and `/run-tests`-specific tailoring (Step 4 in the skill).

Why: bugs found during testing and blocked checkpoints are high-value context for the next session. They belong in the handoff's Decisions & Context and Blockers sections so `/prime` surfaces them immediately. The tracked Step 11 report path goes in Key Files.

### Step 13: Commit test artifacts + handoff

Write the commit message to `docs/.output/.state/.commit-msg` (Write tool — no shell escaping):

```
test: {Task} — {PassCount}/{Total} passed, {BlockedCount} blocked

{one-line summary of most severe finding, if any}
```

Then run:

```bash
# Permanent spec files, if any were written
git add {test spec files — test/__test__/**, e2e/**, etc.}
# Tracked test report (Step 11)
git add docs/.output/findings/reviews/{YYMMDD-HHMM}-test-{task}.md
# TODO checkmark updates
git add {TODO_FILE}
# Handoff
git add "$HANDOFF"
node .claude/core/commit.js
```

Screenshots under `docs/.output/.state/` are ignored scratch and are not staged (`git add` refuses them). Stage exactly these files and take no outward action (push, PR, publication) without explicit authorization.

Skip the commit only if the user invoked `/run-tests` as a dry-run with no expectation of persisting findings.

---

## Rules

1. **TaskList is your spine.** Create it in Phase 0. Update at every step. It survives context compression.
2. **All browser agents use standard and the `claude` agent type. No exceptions.** Both playwright and claude (chrome MCP) agents must specify `model: "sonnet"`. Never Haiku — on the recorded evidence (2026-06-02, Haiku 4.5) it fabricated browser results instead of reading the DOM/a11y tree, and the rule stays in force until the bounded `fast`-tier eval passes. Never `general-purpose` for chrome MCP — it has no browser tools and no ToolSearch. Visual/design QA is a separate human pass.
3. **Main Agent does non-browser checks directly.** Schema, seed data, code inspection, config — no delegation needed. Playwright agents handle browser interactions.
4. **Status protocol is mandatory.** Every agent reports DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT.
5. **Don't trust agent reports — verify.** If an agent says DONE but the screenshot shows an error, it's not DONE.
6. **Selector discovery before dispatch.** Agents waste time searching for selectors that don't exist. Step 5 prevents this.
7. **Annotate blocked items with WHY.** `[!] BLOCKED` alone is useless. Always include root cause.
8. **Wave gating is real.** Dependencies between categories exist. Don't launch all at once.
9. **Screenshot at every verification point.** No screenshot = no evidence = no PASS.
10. **Log agent issues to today's day-scoped log `docs/.output/evolution/agents/{YYYY-MM-DD}.md`** (create the file if today's doesn't exist; the `agent-updates/` folder rotates by day). Flaky behavior, wrong selectors, missed checkpoints — all get logged.
11. **Don't stop the dev server.** Unless explicitly asked.
12. **Always regenerate the session handoff at the end (Step 12).** Bugs found and blocked checkpoints are critical next-session context. Use the `session-handoff` skill (path via `handoff-path.js write run-tests`). Skip only for explicit dry-runs.
