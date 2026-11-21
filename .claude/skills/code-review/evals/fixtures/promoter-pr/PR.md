# PR #418 — Route hand-created memory loading through listMemories()

## Why

`loadHandCreatedMemories()` had its own bespoke directory walk and JSON parse,
duplicating `listMemories()`. F47/F48 asked us to collapse the duplication so
hand-created memories go through the same canonical loader as everything else.

## What changed

- `memory-promoter.js`: `loadHandCreatedMemories()` now delegates to
  `listMemories(category)` instead of re-reading the files itself.
- Updated the promoter unit test to match the loader's shape.

## Diff

```diff
--- a/memory-promoter.js
+++ b/memory-promoter.js
@@ -22,14 +22,9 @@ const { listMemories } = require('./memory-manager');
 function loadHandCreatedMemories(category) {
-  const dir = path.join(MEM_ROOT, category);
-  const out = [];
-  for (const f of fs.readdirSync(dir)) {
-    if (!f.endsWith('.json')) continue;
-    const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
-    out.push({ id: m.id, confidence: m.content.confidence, promoted_to: m.content.promoted_to });
-  }
-  return out;
+  // Collapse the duplicate walk — listMemories() is the canonical loader.
+  return listMemories(category).map((m) => ({
+    id: m.id,
+    confidence: m.metadata.confidence,
+    promoted_to: m.content.promoted_to,
+  }));
 }

 function scanCandidates(category) {
   const mems = loadHandCreatedMemories(category);
-  return mems.filter((m) => m.confidence >= 0.7);
+  return mems.filter((m) => m.confidence >= 0.7);
 }
```

```diff
--- a/__tests__/memory-promoter.test.js
+++ b/__tests__/memory-promoter.test.js
@@ -14,7 +14,7 @@ function writeMemory(cat, id, conf) {
   fs.writeFileSync(p, JSON.stringify({
     id,
-    content: { confidence: conf, promoted_to: null },
+    content: { promoted_to: null },
     metadata: { confidence: conf },
   }));
 }
```

## Test result

`npm test -- memory-promoter` → 14/14 pass.
```
