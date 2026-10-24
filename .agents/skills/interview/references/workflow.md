# Interview

Ask the user interactive questions to gather information before taking action. Use `AskUserQuestion` tool for structured multi-choice questions, not open-ended text prompts.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js interview
```

## When to Use

- Before building a new feature, command, or component
- When requirements are vague and need clarification
- When there are multiple valid approaches and the user should choose
- When designing a new file structure, naming convention, or workflow
- Anytime you'd otherwise guess at what the user wants

## How It Works

1. **Read the topic** from the argument (e.g., `/interview rate tracker export options`)
2. **Think about what you need to know** to take action on that topic
3. **Ask 1-4 questions per round** using `AskUserQuestion` with concrete options
4. **Summarize answers** after each round
5. **Ask follow-up rounds** if needed (max 3 rounds)
6. **Output a decision summary** when done — what was decided and why, then **persist it to a file** (Step 6b) so it survives compaction

## Rules

- **Max 4 questions per round, max 3 rounds** — don't interrogate
- **Every question must have concrete options** with descriptions — no open-ended "what do you think?"
- **Use previews** when comparing visual layouts, code patterns, or file structures
- **Use multiSelect** when choices aren't mutually exclusive
- **Short headers** (max 12 chars) — they render as chips
- **Lead with a recommendation** — put your suggested option first with "(Recommended)"
- **Stop when you have enough** — don't ask questions you can answer from CLAUDE.md or the codebase
- **Stay in problem-space when gathering project requirements** — interview for the *user, use case, goals, and constraints*, not the tech stack. Don't recommend or lock tools, libraries, hosts, or services the user didn't ask for; the architecture phase owns HOW. Capture **constraints** ("$0/month", "no build step", "must decouple from X") faithfully; treat any tool **pick** the user volunteers — or one carried in from a hand-written brief — as a *stated preference for the architecture phase to weigh*, recorded as such, not as a settled decision. (See `project-planning` skill Cross-Cutting Rule 4 for the constraint-vs-pick line.)
- **End with a summary** — "Here's what we decided: ..." so it's clear what to do next

## Example Flow

```
User: /interview notification system design

Round 1: [4 questions about delivery, persistence, real-time vs batch, UI placement]
Round 2: [2 follow-ups based on answers about grouping and priority]
Summary: "Decided: SignalR push for real-time, toast + badge count, grouped by entity,
         stored in app.Notifications with 30-day retention. Ready to build."
```

## Step 6b: Persist the decision summary to a file (before you report)

The closing chat summary (Step 6) is the only downstream-observable record of what the interview decided — and it dies on session end (see Limitations below). Before reporting back, write that summary to a file so the decisions survive compaction and the next session can act on them. This is the "write before you report" rule applied to interview output.

Write the summary with the Write tool to:

```
docs/.output/.state/work/{YYYY-MM-DD}/interview/{topic-slug}.md
```

where `{topic-slug}` is a kebab-case slug of the interview topic (the argument). Include:

- **Topic** and date
- **Decisions** — each decision with its rationale (the same content as the chat summary)
- **Rounds** — per round, the questions asked and the option the user chose (restate them; the `AskUserQuestion` selections are not otherwise observable — see Limitations)
- **Open items** — anything deferred or left for a later phase

If the interview feeds a specific downstream artifact (a PRD, an ADR, a module brief), the answers also belong *in that artifact* — that write-back is owned by the consuming command (e.g. `/create:project-requirements` Step 5b folds clarifications straight into the spec). Step 6b is the universal capture; it does not need to know every downstream type.

This file is the durable record; Step 7 below promotes the *cross-project reusable* subset into the memory store on top of it.

## Step 7: Promote durable decisions to memory (after the closing summary)

The closing summary you wrote in Step 6 is the canonical record of what was decided. Some of those decisions are project-state (UI choice for THIS feature, naming convention for THIS module, build-order for THIS epic). Those die when the project does, and they belong in the project's planning docs, not the structured memory store.

But some decisions are **cross-project reusable** — a workflow rule that should outlive this feature, a constraint that came up here and will recur on the next project, a pattern with general application. Those should land in memory **immediately**, not wait for the next session-handoff regeneration.

### What qualifies

Apply the same test as `session-handoff` skill Step 6 (the canonical rules for memory-worthiness): would this be useful in a future session on **this project** OR on **a new project using this template**? If the answer is "no, this only matters until we ship the feature," skip. If yes, promote.

The four eligible categories:
- `decisions` — architectural or strategic choices with documented rationale
- `patterns` — repeatable techniques with demonstrated value
- `constraints` — platform/tool limits that constrain how something must be done
- `workflows` — process sequencing or operational insights

### When NOT to promote

Default to skip for:
- UI choices specific to this feature (button color, layout option, copy text)
- Naming conventions chosen for one module that don't generalize
- Build sequencing for this epic (those belong in the TODO file)
- Anything you'd rephrase as "for THIS project we decided X" — that's project-state

### How to write

For each qualifying decision, invoke:

```bash
node .claude/core/memory-manager.js create <category> <kebab-slug> '<json-payload>'
```

Confidence calibration for interview-sourced memories: **0.6–0.7**. These are made under interactive pressure with limited surrounding code context — they're not retro-validated or field-tested at write time. The decay model will boost confidence later if the decision proves out across sessions.

For multi-line payloads or anything with embedded quotes (code examples, multi-line alternatives), follow the `session-handoff` skill's `--payload-file` guidance — write the JSON to a temp file and ingest, rather than fighting bash single-quoting.

### Faithful to the summary, not to your interpretation

Write what the closing summary contains, in the user's own framing as far as practical. If the summary says "Decided to use Redis for the rate limiter cache," don't expand that into a paragraph speculating about why Redis won. The summary is the record; the memory is its mirror.

### Inbox as middle ground

When unsure whether a decision qualifies, drop a draft into `docs/.output/.state/memory-inbox/` instead — the same inbox sub-agents use (per the Memory Inbox Protocol in agents.md). Main Agent (you, on next handoff) or the user reviews and promotes/discards. Better to flag and have it discarded than skip and lose the insight.

### Over-promotion is the dominant failure mode

The risk profile here is asymmetric: a missed memory rediscovers itself eventually; a promoted-but-noisy memory dilutes search results forever. Default to skip when in doubt. The qualifier "reusable across projects" is strict for a reason.

## Limitations — Issue #44326

The `Elicitation` hook does **not** fire for `AskUserQuestion` events in current Claude Code (tracked at `anthropics/claude-code#44326`, open as of 2026-05-09). This means the answers users select via the multi-choice UI are NOT visible to:

- `session-handoff` skill (Step 6 memory promotion can't auto-extract decisions from interview rounds)
- `/end` and `/do` handoff regeneration (interview answers don't flow into Decisions & Context unless the main agent restates them)
- Memory-capture telemetry (no event for the curator to observe)

**Why "End with a summary" is load-bearing.** The Rules section above mandates a closing summary. That summary is the *only* downstream-observable record of what was decided. Without it, the interview's outcome lives only in the `AskUserQuestion` UI and dies on session end. Restate the decisions in plain chat after the final round so:

1. The next reasoning step in the same session can act on them.
2. `/end`'s session-handoff can capture them in `## Decisions & Context`.
3. Memory-acquisition can promote durable patterns (Step 6 of the session-handoff skill).

If Issue #44326 closes in a future Claude Code version, the elicitation hook will fire for `AskUserQuestion` and the chat-summary requirement becomes belt-and-suspenders rather than load-bearing — but it's still good practice for the user-facing "what did we just decide" recap.

**Step 7 narrows the gap further at the application layer.** The structured-memory promotion in Step 7 doesn't wait for session-handoff regeneration — durable decisions land in the memory store immediately, indexed and searchable on the next sub-agent dispatch. That mitigates the "interview decisions live only in the UI" failure mode for the subset of decisions worth promoting; the chat-summary remains load-bearing for the rest (project-state decisions that flow through `## Decisions & Context` to the handoff).
