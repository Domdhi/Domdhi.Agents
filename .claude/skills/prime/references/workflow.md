# Prime

Cold-start a new session. Use root instructions and memory already visible in this session; do not assume startup injection ran. This command fills in the task-relevant gaps: what happened recently, what's next, and whether anything is broken.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill`; without this self-log, fleet analytics under-count human-driven runs. Run it before anything else (best-effort; continue if it fails):

```bash
node .claude/core/telemetry-log.js prime
```

## Variables

TASK_DESCRIPTION: CONTEXT

- `CONTEXT` (optional): File(s) or folder(s) to read instead of the default workflow. Use when you need to deep-dive a specific area.

## Workflow

- If `CONTEXT` is provided:
  - Read each file or folder specified and summarize what you found
  - Done; skip the rest

- Else run the **cold-start sequence**:

### Step 1: Read the handoff + git reality (parallel)

Handoffs are per-session/per-branch files under `docs/.output/handoffs/`. Resolve both the branch-preferred pick and the global newest (the resolver prefers the current branch, so a fresher session that ended on another branch, such as a just-merged feature or a parallel worktree, is only visible via `--any`):
```
HANDOFF=$(node .claude/core/handoff-path.js latest)         # newest for THIS branch (falls back to newest overall if branch has none)
NEWEST=$(node .claude/core/handoff-path.js latest --any)    # newest across ALL branches
```
Then read alongside git reality:
```
Read $HANDOFF        # the resolved handoff (skip if empty — none yet)
Read $NEWEST         # only if different from $HANDOFF — a more recent session ended on another branch; treat it as the freshest context and $HANDOFF as this branch's thread
git log --oneline -20
git status --short
```
The handoff has decisions, intent, blockers and next actions from the previous session. Git is the source of truth; do not trust the handoff over git.

**Fallbacks, in order:**
1. `$HANDOFF` empty (no handoff file in the working tree) → check for handoffs committed on unmerged branches (a worktree session's handoff lives only on its branch until merged): `git log --all --oneline -5 -- docs/.output/handoffs/`. If a commit exists there, list its handoff file(s) with `git show --name-only --format= <hash> -- docs/.output/handoffs/` and read the newest via `git show <hash>:<path>`; do not check the branch out.
2. Still nothing → scan `docs/work/backlog.md` instead.

### Step 2: Read Key Files + forward-looking memory (one parallel batch)

Both reads depend only on the handoff (Step 1), so run them in one parallel batch.

**Key Files** — the handoff's `## Key Files` section is a candidate short list for resuming work. Read only paths needed for the current task or first still-relevant Next Action:
- Extract paths from bullets under `## Key Files` (ignore line-range annotations like `:47-89`; read the whole file)
- Check each path against the current task; skip unrelated paths and note the reason. A handoff from another task is context, not an instruction to load its files.
- Skip anything that isn't a readable file (directories, globs, missing files) and note it
- If the handoff has no `## Key Files` section, skip the file reads
- Also read the task-relevant file `## Next Actions` names as the first to touch (one or two, not every mention)

Load the content needed to act on step one; listing a path does not count as reading it.

**Forward-looking memory** — when configured and active, `session-start-prime.cjs` injects up to 8 memories by default (configurable; on Claude with per-prompt recall on, only the importance >= 4 core, the rest arriving per prompt), ranked by importance-adjusted decayed confidence × recency; aged usage only breaks ties. Treat injection as observed only if a `<project_memory>` block is actually visible in this session. Add recall that bears on the current task:
1. Extract 2-4 concrete noun phrases from the current task or still-relevant handoff `## Next Actions` (file names, feature names, technical concepts — skip filler like "decide", "verify").
2. `node .claude/core/memory-manager.js search "<phrases joined>"`
3. Select at most 3 directly relevant, non-stale hits using the returned relevance and `decayed_confidence`. Search is distinct from startup ranking: SQLite returns FTS rank order and reports relevance from text rank, confidence, usage and importance; JSON fallback sorts relevance from text matches, recency, confidence, usage and importance. Do not describe `decayed_confidence * relevance` as the engine's search order.
4. Dedupe against observed memory: skip hits whose `id` is already visible in this session's `<project_memory>` block or was already read. If no block is visible, do not assume any top-8 was loaded.
5. For each remaining hit directly relevant to the current task or first still-relevant Next Action, `cat docs/.output/.memory/{category}/{id}.json` and surface the rule.

Skip the memory search if neither the current task nor a still-relevant Next Action supplies a useful query. If there are no additional relevant hits with `decayed_confidence >= 0.3`, render the **Loaded** memory line as `(no additional task-relevant memories loaded)`. Report startup memory as observed or `(startup memory injection not observed)`; a configured hook alone is not evidence it ran.

### Step 3: Verify & synthesize

Compare the handoff against git reality:
- Handoff says "next: implement X" but `git log` shows X was already committed → flag as stale and ignore that action
- Handoff missing or completely stale → scan `docs/work/backlog.md` for pending work
- A Key File's current contents contradict the handoff's description → trust the file, flag the drift

## Report

Provide a substantive summary (**30-60 lines**) with enough context to start working immediately. Use this template: every section is required and every label verbatim, even when a section is empty.

Ordered **bottom-up**: the most actionable content sits at the bottom, closest to the input box where the eye lands first; provenance (recent work, loaded files/memories) sits at the top, read last or skipped.

```markdown
## Cold-start summary

**Recent work** (last 3-5 commits):
- `{hash}` {subject} — {one-line why-it-matters}
- `{hash}` {subject} — {one-line why-it-matters}

**Loaded** (what this summary was built from — files + memory)
- ✓ `{path}` — Key File from handoff
- ✗ skipped `{path}` — {reason: missing, directory, glob, etc.}
- 🧠 `{category}/{id}` (rel {N.N}, conf {N.NN}) — {one-line takeaway}

**State**
- Branch: `{branch}`, working tree {clean | N modified files}
- Build: {last gate status + count, or "unknown"}
- {anything notable about deployed/remote state}

**Decisions & context**
- {decision from handoff with the reasoning, not just the conclusion}
- {next decision with reasoning}

**⚠ Handoff drift** (only if detected — omit the section if handoff matches git)
- {what the handoff says vs what git shows, with commit hashes}

**Next actions**
1. {action with enough detail to start immediately — file paths, what to search for, approach to try first}
2. {next action}

**Blockers** (only if still relevant — omit the section if none)
- {blocker, with what was already tried}

▶ **Start here:** {the single most important next step in one line — the literal last line of the report}
```

### Section rules

- **Order is fixed (bottom-up):** Recent work, Loaded, State, Decisions, (drift if any), Next actions, (blockers if any), ▶ Start here. Least actionable sits at the top, most actionable at the bottom.
- **▶ Start here is the literal last line.** One line, the single highest-value next step, followed by nothing.
- **Route genuinely-new work through `/route`.** When the highest-value next step is a new feature or a scope-unclear request (not resuming an in-flight story, not a known bugfix), render `▶ Start here:` as `/route {description}` so scale-aware pipeline depth gets chosen instead of defaulting to `/todo`. This is the only place the front-door router is surfaced in the daily loop. When resuming work in flight, the handoff's concrete next action is the right Start-here.
- **Loaded is always present** and merges files + memory. If the handoff had no Key Files, write `(no Key Files in handoff)`; note unrelated files as skipped. Distinguish startup memory actually observed from additional memories read; if search was skipped or dry, write `(no additional task-relevant memories loaded)`. Do not list assumed injection as loaded.
- **Only Handoff drift and Blockers may be omitted**, and only when there is genuinely nothing to report.

## What not to do
- Do not re-read root instructions or overview/context content already visible in this session; read missing instructions or task-relevant context only when needed
- Do not load full planning docs unless the handoff is stale/missing
- Keep the report between 20 and 60 lines: shorter is too sparse to cold-start from, longer is a novel
