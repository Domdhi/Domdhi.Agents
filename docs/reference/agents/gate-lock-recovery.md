# Build and test lock recovery

Verified stale build/test locks are recovered by the gate itself or by the helper below, never by moving or deleting the lock file by hand. On Windows the helper preserves the exact lock and a prepared receipt before clearing it. Recovery never launches a build or test, and it does not resume a paused run.

From the affected checkout, inspect its gate lock:

```powershell
node .codex/core/build-lock-recovery.js inspect
```

Use `.claude/core/` in Claude. When inspection returns `recoverable`, pass its exact `sha256` and the evidence-based reason:

```powershell
node .codex/core/build-lock-recovery.js recover --expected-sha256 <sha256-from-inspection> --reason "Recorded owner exited; the supported gate lease is idle."
```

The explicit helper has no minimum age. On Windows, ordinary gate acquisition also recovers an expired, verified idle lease through this transaction. Both Windows paths preserve evidence under `docs/.output/.state/work/gate-lock-recovery-<operationId>/` in the affected checkout. Moving locks by hand to a scratchpad bypasses that evidence and ownership check.

The supported Windows producer writes `domdhi-gate/lease-v2`. It marks a stage as running before launch, contains configured stage descendants in a Windows Job Object, and returns the lease to idle only after confirmed tree completion. A dead PID from an older producer cannot establish that its children exited. On Windows, live owners, unreadable/corrupt leases, legacy leases, and unresolved process trees remain held while the agent investigates.

Recovery requires Windows PowerShell, its .NET compiler, and local fixed-volume paths whose directory handles can be pinned. It rejects links and ambiguous ownership. POSIX execution remains available, but this native retirement helper does not support POSIX recovery; the gate handles POSIX locks itself, as follows. Submission and data locks are outside its scope.

## POSIX locks

The gate writes `domdhi-gate/uncontained-posix-v1` outside Windows. It has no owned process tree, so it cannot prove that a stage's descendants exited, and it keeps no recovery receipt. The gate breaks a lock itself only on positive proof that the run is gone: the lock is older than the 30-minute stale ceiling and its recorded owner and any recorded child are definitely absent (`ESRCH`; a denied or ambiguous probe counts as live). The break re-reads the exact bytes it inspected and re-checks that proof immediately before removing the file, so a lock a newer gate installed meanwhile is never removed.

Three kinds of abandoned lock are retired this way:

| Lock | Condition |
|---|---|
| `uncontained-posix-v1`, idle | Older than the ceiling; owner and child gone; no running-tree marker. |
| Legacy `{pid, started}` from before lock protocols | Same proof of exit. |
| Empty or unparseable file | Last written more than the ceiling ago. A fresher one may belong to a gate still writing it, so it is held. |

For the legacy and unreadable kinds the exact bytes are first kept beside the lock as `.gate.lock.abandoned-<epoch>` (if they cannot be kept, the lock is held). A live owner, a live child, a fresh lock, a running-tree marker, and a `lease-v2` lock found outside Windows are all held with their bytes untouched; investigate rather than deleting them.


| Result | Meaning and next action |
|---|---|
| `missing` | No lock was found; preserve normal gate locking when work resumes. |
| `recoverable` | Read-only inspection found an exited owner and a supported idle lease. Recovery rechecks the held object. |
| `recovered` | Exact archive and prepared receipt survived retirement; separate `completion.json` records completion. |
| `changed` | The inspected digest no longer matches. Inspect again; preserve the successor. |
| `held` / `refused` | Recovery did not authorize retirement. Read the reason and investigate the ownership or path constraint. |
| `retired-uncertain` | Retirement occurred, but final diagnostics failed. Use the returned operation/evidence paths to reconcile. |
| `retirement-uncertain` | The backend reply was lost or invalid; whether retirement occurred is unknown. Inspect the returned operation's immutable receipt, archive and completion before proceeding. |

Never rerun an old recovery against a successor lease. The prepared `receipt.json` remains immutable; an interrupted completion write cannot destroy it. Infrastructure failures before CLI Job admission remain unconfirmed and are retained as failures, never accepted as stopped-tree evidence.
