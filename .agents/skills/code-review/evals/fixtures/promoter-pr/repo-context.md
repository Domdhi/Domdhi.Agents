# Repo context (for the reviewer — existing code on main, not part of the PR)

`memory-manager.js` — how memories are created and loaded:

```js
function createMemory(category, id, content) {
  const mem = {
    id,
    content: { ...content },          // caller-supplied: description, confidence, evidence, ...
    metadata: { confidence: 1 },      // stamped once at creation, never recomputed
  };
  fs.writeFileSync(pathFor(category, id), JSON.stringify(mem));
}

// listMemories returns the parsed objects as-is (content + metadata).
function listMemories(category) { /* readdir + JSON.parse each */ }
```

Curated memory files on main carry the real confidence in `content.confidence`
(0.5–0.9, set per the confidence-level rubric and decayed over time). The
`metadata.confidence` field is stamped to `1` at creation and never updated.

Downstream, `scanCandidates()` filters on `>= 0.7` and the promoter ranks by
this value.
