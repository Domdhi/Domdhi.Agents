# Review cadence

One approach to reviewing planned work, shared by `/todo` (plans it), `/run-todo` (runs it across waves) and `/do` (runs it for one task). This file is the single statement; the workflows point here instead of restating it.

## Purpose

A review exists to catch problems that cost more later than now: wrong behaviour, a contract that later work will build on, a hole in money, data or access. In real runs, reviews of code paid for themselves: most found a real problem, including the only data-loss bug. What cost time was the fix rounds that followed, and most of those traced back to seams the plan never pinned down. So review where the code is, batch it so seams are visible, fix what matters before building on it, and let polish wait for a review that is happening anyway.

## Cadence

- **Per wave, grouped by seam.** One review of the wave's diff after its stories land, so stories that share a file, field or contract are seen together. That is where cross-story bugs show up.
- **Mid-epic: look back and forward.** At the wave the plan names (the TODO chooses it, roughly where half the work is done), review across the waves rather than re-reading each wave's diff: where waves meet, drift from the plan, accumulated debt. Main Agent fixes what earlier waves deferred. Then Main Agent looks forward: does the remaining plan still fit what was built? Rewrite the remaining stories if it does not, and carry review notes into the AC of the stories they affect.
- **Final, when the run completes.** Review the finished work against its acceptance criteria and close every item still deferred. With a ship gate, the final review runs once when the core slice completes and once at the very end, the second covering only the later slice's diff.
- **A closer look where a mistake costs money, data or access**: payments and money math, data that could be lost, corrupted or exposed, and who can see or change what. Review those in the wave they land. Money and access also get `security-auditor` (firm line 2); data-loss and exposure surfaces get a `code-reviewer` briefed on them by name.

The cadence unit is the run: "epic" in this file means the TODO being run, however many epics it holds. The reviewer gets the diff and the acceptance criteria; Main Agent checks the deferred list against the result, so the reviewer stays independent of earlier verdicts.

What deserves a real review is the kind of surface, not the story's size or label: code, guards and scripts, persisted shapes and input validation, offline and data-loss paths, displayed numbers, global or print styling, and the first use of a contract. Prose and seed data need a read, not a review.

A single task (`/do`) is the same idea scaled down: one review at the end, a closer look for money, data or access, the same firm lines and the same short log. With no later review to defer to, it fixes every finding in that one pass.

## Judgment, not a table

Decide what a finding needs by asking what leaving it would cost.

- Don't start the next wave with a real problem unfixed: a bug, a contract later waves will consume, a failing or false-green test, a security or data issue.
- Polish can wait for the mid-epic or final review: naming, small refactors, wording. Deferred is not dropped; those reviews fix it, so every finding is fixed by the end of the run. The one finding never written is a coverage-only `TEST-GAP` on a `standard` scope (the `code-review` skill states that rule).
- A review that finds nothing real needs no fix round.
- Fix each finding once and prove the fix with a test or command; don't send fixes back for re-review. A fix that grows past about half an hour or spans several layers is a design change: treat it as a small story with its tests written first. If it needs a real decision, ask the owner once.
- When a real problem appears where the plan expected none, say so in the log; that is how the next plan's risk calls get better.

## Firm lines

1. Build and tests pass before a wave (or task) is done.
2. A change to money, authentication or access gets a `security-auditor` review in the wave it lands. **Access** means who can see or change what: permissions and row-level rules, credentials and secrets, untrusted input that reaches storage, auth or an external call, the shared request pipeline (middleware, route guards, cache headers), and release flags that gate who gets a feature. This is the one definition; workflows point here.
3. No push, deploy, publish or fleet sync without the owner's explicit go. Who approves each action and where it is enforced is in `.agents/startup-reference.md`, section Action authority.

## The decision log

The model makes these calls, so it writes them down. After each wave's review, and after the mid-epic and final reviews, add an entry to the plan's wave log:

```markdown
**Review — {Wave N | mid-epic | final}**
- Reviewed: {scope, and by whom: code-reviewer / security-auditor / Main Agent read}
- Fixed now: {finding → fix, and the test or command that proves it}
- Deferred: {finding → mid-epic | final | named follow-up, and why it can wait}
- Skipped or light: {what got no review or a light read, and why}
- Risk call: {a real problem where the plan expected none, or the reverse}
```

A planned review that did not happen is logged with its reason, never left silent. The deferred items are also kept in the plan's Resume Point so a resumed session finds them. The mid-epic review picks up what earlier waves deferred; the final review closes them all. Nothing leaves the run unfixed except for the `code-review` skill's three reasons: the finding is wrong, it is out of scope with a named follow-up, or it is a coverage-only `TEST-GAP`.
