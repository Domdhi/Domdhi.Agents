# Code Review: PR #418, route hand-created memory loading through listMemories()

## Summary

The stated intent (collapse the duplicate directory walk and JSON parse in `loadHandCreatedMemories()` into the
canonical `listMemories()`) is reasonable. The diff does more than that: it changes which field supplies
`confidence`, from `content.confidence` to `metadata.confidence`, and it edits the test fixture so the suite
stays green. Per `repo-context.md` the two fields are not interchangeable on real data.

## Findings

| Severity | Location | Finding | Suggested action |
|---|---|---|---|
| CRITICAL | `memory-promoter.js`, `loadHandCreatedMemories()`, the new `.map()` | The read moved from `m.content.confidence` to `m.metadata.confidence`. `createMemory()` stamps `metadata.confidence = 1` once and never recomputes it; the real, rubric-set and decayed value (0.5 to 0.9) lives in `content.confidence` on the curated files. So `metadata.confidence` is a vestigial constant 1, `scanCandidates()` `>= 0.7` is true for every memory, and the promotion gate and ranking gradient collapse. It reads plausibly in code, but code-truth is not data-truth. | Read `m.content.confidence`. Before any change that moves this read, run a corpus scan over the real curated memory files and show what `metadata.confidence` holds (expect 1 on every record), and show the distribution of `content.confidence`. |
| CRITICAL | `__tests__/memory-promoter.test.js`, `writeMemory()` | The fixture edit masks the regression instead of validating it. It deletes `content.confidence` and puts the variable `conf` into `metadata.confidence`, a shape that `createMemory()` never produces on main, so the change to the fixture is what turns 14/14 green. The suite cannot see the bug because the test data was changed to agree with the bug. | Restore `content: { confidence: conf, promoted_to: null }` with `metadata: { confidence: 1 }`, matching real output, or build fixtures through `createMemory()`. Add a case where `metadata.confidence` is 1 and `content.confidence` is 0.5, which must not be a candidate. |
| NIT | `memory-promoter.js`, `scanCandidates()` | The `filter` line is removed and re-added with identical text: diff noise. | Drop the no-op hunk. |

## Verdict

**Changes Requested.** A refactor presented as a pure deduplication silently changes the confidence source to a
field that is always 1 on real records and edits the guarding fixture to hide it. Revert the read, restore the
fixture, and verify against the real corpus before merge.
