# Code Review Playbook

Routes review depth by change type and directory risk. Use alongside the `code-review` skill: this playbook provides the routing logic, the main skill provides the report template, severity tiers and checklists.

## Intake Triage

Classify every review before starting analysis; the classification picks the checklist.

### Change Type Classification

| Type | Signal | Route |
|------|--------|-------|
| **Config-Only** | Only `.json`, `.yaml`, `.toml`, `.env.example`, `.*rc` files changed | Fast-Lane |
| **Docs-Only** | Only `.md`, `.txt`, `CHANGELOG`, `LICENSE` files changed | Fast-Lane |
| **Dependency Update** | Only lockfiles or package manifests changed | Fast-Lane + Security Spot-Check |
| **Refactor** | No new exports, no new files, no behavior change | Fast-Lane + Architecture Check |
| **Bug Fix** | Touches existing logic, has corresponding test change | Standard Review |
| **New Feature** | New files, new exports, new routes/endpoints | Deep Review |
| **Security-Sensitive** | Touches auth, crypto, permissions, secrets, input validation | Deep Review (mandatory) |
| **Architecture-Impacting** | New patterns, new dependencies, cross-module changes, schema changes | Deep Review (mandatory) |

When multiple types apply, use the deepest route. A refactor that also adds a new export is a "New Feature" review.

---

## Fast-Lane Review

For low-risk changes. Target: 5-10 minutes.

### Fast-Lane Checklist

- [ ] **No secrets or credentials** in the diff
- [ ] **No breaking changes** to public APIs or exports
- [ ] **Consistent formatting** with existing codebase (no mixed conventions)
- [ ] **No unnecessary file additions** (temp files, build artifacts, IDE configs)
- [ ] **Dependency changes are intentional** (lockfile matches manifest, no phantom updates)
- [ ] **Config values are environment-appropriate** (no hardcoded production URLs, no localhost in staging configs)

### Fast-Lane Verdict

If all items pass: **Approved**. If any item fails, escalate that item to Standard Review.

---

## Standard Review

For moderate-risk changes. Covers correctness and testing.

### Standard Checklist

All Fast-Lane items, plus:

- [ ] **Code does what the story/ticket requires** (check acceptance criteria)
- [ ] **Edge cases handled** (null/empty inputs, boundary values, concurrent access)
- [ ] **Error paths return meaningful context** (no swallowed exceptions, no bare `catch {}`)
- [ ] **New code has tests** (unit tests for logic, integration tests for data access)
- [ ] **Tests are meaningful** (not just coverage padding — they assert real behavior)
- [ ] **Coverage claims are verified, not trusted**: a "covered" file can still be fictitiously tested if assertions key off mocked or seeded data that never exercised the real code path. Spot-check that the asserted behavior ran. (See the AC-vs-Test anti-patterns in `two-stage-review.md`.)
- [ ] **No N+1 queries or unbounded collections** in data access paths
- [ ] **Logging is appropriate** (enough to debug, not so much it's noisy)

---

## Deep Review

For high-risk changes. Full analysis including architecture compliance and security.

### Deep Review Checklist

All Standard items, plus:

#### Architecture Compliance
- [ ] **Follows documented architecture patterns** (check `docs/architecture/overview.md`)
- [ ] **Respects module boundaries** (no direct cross-layer calls that bypass contracts)
- [ ] **New patterns are justified** (if introducing a pattern not in the architecture doc, flag for ADR)
- [ ] **Database schema changes have migration** (no raw DDL, migration is reversible)
- [ ] **No circular dependencies introduced** between modules

#### Security (OWASP-Aligned)
- [ ] **Input validation at system boundaries** (user input, API input, file uploads)
- [ ] **Output encoding appropriate** (HTML, SQL, shell — context-specific)
- [ ] **Authentication checks on all protected paths** (no auth bypass via new route)
- [ ] **Authorization is granular** (not just "is logged in" but "has permission for this resource")
- [ ] **Sensitive data not logged or exposed** in error messages
- [ ] **Cryptographic operations use established libraries** (no hand-rolled crypto)
- [ ] **Rate limiting or abuse prevention** on public-facing endpoints

#### Integration Points
- [ ] **API contracts are versioned or backward-compatible**
- [ ] **External service calls have timeout and retry logic**
- [ ] **State mutations are atomic** (no partial updates on failure)
- [ ] **Event/message schemas are documented** (if applicable)

---

## Risk-Based Routing

When a **Risk Map** exists in the `code-reviewer` agent's `## Project Context` section, use it to adjust review depth per file. `/review:specialize` populates it; if it has not been run, use the No Risk Map Fallback below.

### Risk Map Decision Tree

```
For each changed file:
  1. Match file path against risk map patterns
  2. Determine risk tier: HIGH / MEDIUM / LOW
  3. Route to checklist:
     - HIGH  → Deep Review (all sections)
     - MEDIUM → Standard Review
     - LOW   → Fast-Lane Review
```

### Composite Risk Rule

When a single PR contains files across multiple risk tiers:
- The **overall PR verdict** uses the highest risk tier's checklist
- But **per-file findings** note the applicable tier
- This keeps a LOW-risk config change from pulling a HIGH-risk auth change through only a fast-lane review

### No Risk Map Fallback

If no risk map exists (the project has not run `/specialize`), default all files to **MEDIUM** risk (Standard Review).

---

## Severity Classification

Severity tiers, escalation rules and the MAJOR-fix-inline discipline are defined once, in Section 3 of `.claude/skills/code-review/SKILL.md`. Use them as written.

### High-risk defect classes invisible to build/tests/grep (always check explicitly)

These defect classes pass the build and the tests and survive grep-based review; only an explicit checklist item catches them.

- **Revocation/deny primitive fail-open.** A resolver that builds an allow/grant union then subtracts revocations (or denials) must put that subtraction in its own try/catch and return DENIED on error, never fall back to the un-revoked union. Trace the catch's return value; a "fail closed" comment is not proof. Null-guard the comparison used to match revocation records: a naive equality check on a nullable field can silently no-op the revocation and let a denied grant through.
- **A read-path refactor accompanied by a test-fixture change that makes it pass.** When a diff changes WHERE a value is read (field, file, API) and ALSO edits the fixture/assertion guarding that read, treat the fixture change as a masked regression until proven otherwise: demand a corpus or real-data scan showing the new source holds the expected values (code-truth is not data-truth; a vestigial field can read plausibly and be a constant on every real record). Evidence: CR-3.4 (2026-07-16) flipped a confidence read to a vestigial always-1.0 field and updated the fixture to green it; the promoter's ranking gradient collapsed and only a corpus scan surfaced it.
- **Security/enforcement string matching via bare substring instead of normalized + boundary-anchored match.** Any allow/block/recognition decision built on `includes()`, an unanchored regex, or a prefix test is evadeable (whitespace variants, path prefixes, lookalike names) or over-matches (`bin/` matching `cabin/`). Check every enforcement comparison for input normalization first (whitespace, case, path), then a boundary-anchored match (word boundary, exact basename, path-segment equality). One sweep found five defects of this class (memory `security-matching-needs-boundary-not-substring`); commit-guard's `/^git\b/` missing `/usr/bin/git` was a sixth.
- **An allowlist or validation regex anchored with `$`.** In Python, .NET, PCRE, Java and Perl, `$` also matches before a final newline, so `^[a-z0-9-]+$` accepts `"name\n"`; in Ruby `^`/`$` are line anchors and accept any line. Use the end-of-input anchor (`\z` in .NET, Ruby, PCRE and Java; `\Z` in Python, or `re.fullmatch`) for any security or identity check. JavaScript's `$` without the `m` flag is end of input. (From the largest adopter's memory review, 2026-11.)
- **A completeness claim counted in the wrong unit.** A sweep, guard or migration that says "all N covered" is only as complete as the unit it counted. If the defect lives per call site, query or entry point, a count of files proves nothing.
- **A merge/sync operation that silently suppresses part of its intended effect while still reporting success.** A merger, syncer or propagator with a defensive fallback path (collision guard, freshness check, conflict skip) can quietly withhold the update it was invoked to deliver and still return its normal success status. Trace every fallback branch to its return value: if the operation did less than asked, the caller must be able to tell (distinct status, visible WARN), or the suppression compounds on every later run. Example: `skill-merger.js`'s heading-collision guard froze the template head on a benign collision while reporting "merged (preserved project additions)" (finding F2, `260716-0823-code-review.md`).
- **Cross-object field-swap fix proposed without a type/taxonomy check.** When a finding recommends reading a computed value from a DIFFERENT object than the one currently used (e.g. "use `otherEntity.Category` instead of `thisEntity.Category`"), verify both objects' property types and value domains match before recommending it: two identically-named fields on sibling entities can be independent taxonomies (one an enum, the other free text) with no overlapping values. Grep both entities' property declarations first.

---

<!-- @@project-additions:start -->
## Refusals and remediation changes

- **A refusal returns before mutation.** Trace the rejected operation through its public caller. Its test must assert that existing values, files and external state remain unchanged, as well as checking the refusal and nonzero result where applicable. A conflict message followed by a write has not refused the operation.
- **Review the remediation diff.** Fixes made during review or a retro are new code. Before the final verdict, inspect that diff for asymmetry: read versus write paths, in-memory versus persisted state, duplicated helpers and sibling queries. Re-running tests proves execution, not independent review; follow the existing review-pass budget.
<!-- @@project-additions:end -->

## Review Output Format

Findings are reported with the `code-review` skill's report template; the playbook adds one section:

### Risk Assessment Section

```markdown
## Risk Assessment

| File | Risk Tier | Review Depth | Source |
|------|-----------|-------------|--------|
| {path} | {HIGH/MEDIUM/LOW} | {Deep/Standard/Fast-Lane} | {Risk map pattern or "default"} |

**Overall Review Depth**: {Deep/Standard/Fast-Lane} (highest tier in changeset)
```

This section appears between the Summary and Findings sections in the standard review report.

---

## Cross-References

- **Report template + severity table**: `.claude/skills/code-review/SKILL.md`
- **Two-stage process + subagent templates**: `.claude/skills/code-review/references/two-stage-review.md`
- **Pre-review checklist + subagent dispatch**: `.claude/skills/code-review/references/pre-review-checklist.md`
- **Handling feedback**: `.claude/skills/code-review/references/handling-feedback.md`
- **Risk map source**: `code-reviewer` agent's `## Project Context > ### Risk Map` (generated by `/review:specialize`)
- **Architecture baseline**: `docs/architecture/overview.md`
- **Memory patterns**: `node .claude/core/memory-manager.js search "{domain}"`
