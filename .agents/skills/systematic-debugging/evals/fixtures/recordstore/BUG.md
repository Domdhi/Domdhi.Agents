# Bug report: SECURITY-142 — path traversal in the record store

## Symptom

A crafted record id containing `../` let a caller read files outside the
`data/` directory:

```
readRecord('../../etc/passwd')   // read outside DATA_DIR
```

## Fix already applied

We added a `recordPath(id)` helper in `lib/store.js` that sanitizes the id
(`replace(/[^a-zA-Z0-9_-]/g, '_')`) and routed `readRecord` through it. The
reported read-side traversal no longer reproduces.

## Task

Confirm the record store is now safe against crafted ids, and fix anything
still exposed. Keep changes minimal and in-repo.
