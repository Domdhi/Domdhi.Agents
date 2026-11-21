# Bug report: CLIENT-88 — new clients start with a used-up request quota

## Symptom

A long-running worker creates one client per job. After a few jobs, a new
client starts with a smaller request quota than the documented 100:

```
const a = createClient('job-1');
a.request('/x');
a.request('/y');
const b = createClient('job-2');
b.config.quota.remaining   // 98, expected 100
```

## Fix already applied

`createClient` in `lib/client.js` now gives each client its own copy of the
`quota` object before it starts counting requests. The reported quota drift no
longer reproduces.

## Task

Confirm the reported problem is gone for good, and fix anything that is still
wrong. Keep changes minimal and in-repo.
