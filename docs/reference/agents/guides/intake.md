# Intake through GitHub

Intake keeps selected toolkit lessons in the reporting project and can deliver approved lessons to GitHub Issues. Delivery uses GitHub Issues only. No other tracker connection or record migration is included.

Delivery starts disabled. Local capture needs no credentials. Installation and update do not activate delivery, import another project's queue or contact GitHub.

## Capture locally

Run from the reporting checkout. Codex uses .codex/core/; Claude uses .claude/core/ with identical arguments. The installed intake skill selects the workflow; discovery alone does not prove an operation ran. This guide ships in the published artifact; install/update omit docs/reference/agents. When it is absent, the installed workflow requires its delivered canonical core/store validators and limits as the exact schema reference.

~~~bash
workDir="docs/.output/.state/work/$(date +%F)/intake"
mkdir -p "$workDir"
printf '{}\n' > "$workDir/identity.json"
node .codex/core/intake.js init --input "$workDir/identity.json"
~~~

Initialization derives project identity and creates .agents/intake/identity.json and disabled .agents/intake/policy.json, preserving existing authority. Input may supply only optional projectName, such as {"projectName":"My Project"}. Names permit letters, digits, spaces, dots, underscores and hyphens.

Existing `.agents/learning-intake/` configuration continues to work without reinitializing ownership. When ready, rename the whole directory to `.agents/intake/` with the destination absent; preserve both files exactly. For tracked configuration use `git mv .agents/learning-intake .agents/intake`; for untracked configuration use an ordinary directory rename, then explicitly stage the two files. Do not keep two configuration locations: the helper refuses mixed authority with `identity-mismatch`. The rename changes neither policy scope nor request/event history.

Run the selected lifecycle before its caller's final commit, then review and commit the exact identity/policy files and durable request/event records it produced. Disabled configuration belongs in the reporting project's Git history too. The helper does not stage or commit; `/end` and other authorized callers own retention. Ignore only transient locks and scratch. A local commit is separate from delivery to GitHub.

Generate a bounded offline example with actual installed toolkit provenance:

~~~bash
node - "$workDir/lesson.json" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const reference = '.agents/core/constants.js';
const lesson = {
  toolkitVersion: JSON.parse(fs.readFileSync('.agents/config/version.json', 'utf8')).version,
  component: 'core/intake',
  applicability: 'shared-toolkit',
  title: 'Retain independent selected learning occurrences',
  problem: 'A latest-only note can lose an earlier selected occurrence.',
  expected: 'Keep distinct request identities across repeated captures.',
  reproduction: 'Capture this selected example twice and inspect status.',
  verification: 'Confirm two request IDs even when fingerprints match.',
  references: [{ path: reference,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(reference)).digest('hex') }],
  exportApproved: false
};
fs.writeFileSync(process.argv[2], JSON.stringify(lesson, null, 2) + '\n', { flag: 'wx' });
NODE
node .codex/core/intake.js capture --input "$workDir/lesson.json"
node .codex/core/intake.js status
~~~

Retain the returned requestId. Queue state is pending; its first history event is captured. Repeated captures produce distinct occurrences. This example is unapproved for export. After owner review, set exportApproved:true in the input and capture a new occurrence if submission is intended; persisted requests are immutable.

Required input fields are toolkitVersion, component, applicability, title, problem, expected, reproduction, verification, references and boolean exportApproved. Optional fields are toolkitCommit (observed 40- or 64-character lowercase commit hash) and proposed. References contain path and optional commit/sha256. Paths must identify toolkit files under .agents/, .codex/core/ or .claude/core/. Do not invent provenance or supply derived project/request IDs, runtime, timestamp, hashes or fingerprint.

Project-specific applicability always stays local. Select bounded summaries deliberately; exclude conversations, secrets, account identities, private application evidence and bulk source. Existing secret scanning applies to capture and external work. Input files must be checkout-relative, ordinary, bounded UTF-8 JSON without symlink ancestors.

## Review GitHub policy

The receiver is a GitHub repository written OWNER/REPO; each reporting project configures its own explicitly. Authenticate separately using [gh auth login](https://cli.github.com/manual/gh_auth_login), with access appropriate to read/create issues in that repository. Native acquisition uses gh auth token --hostname github.com. Credentials never enter policy or records.

Trusted resolutions require numeric GitHub maintainer IDs. Select maintainers separately; a login, issue author or CLI default account does not grant trust. Inspect an owner-selected account using:

~~~bash
gh api users/MAINTAINER_LOGIN --jq '.id'
~~~

See the [Users API](https://docs.github.com/en/rest/users/users#get-a-user) and [gh api](https://cli.github.com/manual/gh_api). Empty maintainerIds permits raw issue-state observation but trusts no resolution.

After the owner selects receiver, IDs, operations, trigger and approver alias, generate a candidate. Replace illustrative ID123 and ProjectOwner with reviewed values:

~~~bash
node - "$workDir/policy-candidate.json" OWNER REPO '[123]' ProjectOwner <<'NODE'
const fs = require('node:fs');
const store = require('./.agents/core/_lib/intake-store');
const context = { projectRoot: process.cwd(), stateRoot: process.cwd() };
const identity = store.loadIdentity(context);
const policy = store.loadPolicy(context);
policy.enabled = true;
policy.destination = { provider: 'github', owner: process.argv[3],
  repository: process.argv[4], maintainerIds: JSON.parse(process.argv[5]) };
policy.operations = ['submit', 'reconcile', 'refresh'];
policy.triggers = ['end'];
policy.approval = { approvedBy: process.argv[6], approvedAt: new Date().toISOString(),
  scopeHash: store.canonicalHash(store.policyScope(policy)) };
store.validatePolicy(policy, { identity });
fs.writeFileSync(process.argv[2], JSON.stringify(policy, null, 2) + '\n', { flag: 'wx' });
NODE
~~~

This writes only an ignored candidate. Inspect its complete scope before copying the approved candidate to .agents/intake/policy.json. Owner authorization covers receiver, trust IDs, evidence export and standing operations; calculating a hash is not authorization. Do not edit approval merely to make a refusal pass.

Policy scope binds project identity/name, full destination, export profile, operations, triggers and every limit. INTAKE_LIMITS in .agents/core/constants.js supplies ceilings: policy can narrow each positive integer, never exceed it. Changed scope requires fresh reviewed approval. Setting enabled:false immediately disables delivery while preserving unchanged bindings. Full revocation can also remove destination/approval and empty operations/triggers.

Operations: submit, reconcile, refresh, recover. Lifecycle triggers: end, do, run-todo, run-tests, todo, review-feedback. The example grants only end and excludes recovery. Explicit commands require operation authority; lifecycle additionally requires its exact trigger. Handoff/feedback process one finite eligible batch under existing scope. Startup, tool hooks, install/update/restore have no send hook.

## Deliver and observe

Set requestId to the actual UUID from capture or validated status. These are separate available operations, not a retry loop:

~~~bash
node .codex/core/intake.js status --id "$requestId"
node .codex/core/intake.js submit --id "$requestId"
node .codex/core/intake.js reconcile --id "$requestId"
node .codex/core/intake.js refresh --id "$requestId"
~~~

Submission validates destination and bounded exact-marker search, persists intent before POST, then retains a validated receipt. The [Issues API](https://docs.github.com/en/rest/issues/issues) and [Search API](https://docs.github.com/en/rest/search/search) use fixed-host HTTPS at api.github.com; redirects are refused.

Every intent binds its original full destination, including trust IDs. A later approval cannot redirect an old retry, reconciliation or receipt. Known no-write rejection permits bounded later retry at the original receiver. Retained throttled timestamps block premature submit/reconcile/refresh across repeated lifecycle calls. Attempt ceilings survive restarts.

Possibly committed or interrupted create without validated receipt stays uncertain. Reconciliation requires one exact match. Zero/multiple/truncated/inconclusive results never authorize another create. Receipts bind issue ID/number, canonical URL, destination/hash, request hash, occurrence marker and receipt time.

Exit codes: 0 successful operation, including disabled local-only lifecycle; 2 invalid input/version; 3 identity/authority/export refusal; 4 dependency/retryable/uncertain state; 5 persistence/corruption/lock failure. Inspect both exit and bounded JSON. Failed persistence does not prove durable capture; offline fixtures do not prove live delivery.

## Trusted resolution

Neutral request protocol: AGENTS_LEARNING_REQUEST_V1: followed by escaped JSON in a pre element; occurrence marker: agents-learning-{requestId}. Its envelope binds schemaVersion, requestHash and full validated request. Old Azure DTOs and organization-specific markers are refused without silent migration.

Only a comment by a destination-configured numeric maintainer ID can supply a resolution. Its entire body is:

~~~text
AGENTS_LEARNING_RESOLUTION_V1:<pre>{escaped JSON}</pre>
~~~

Encode JSON first, then HTML-escape &, <, >, double quote and apostrophe. Keep one trusted resolution comment by editing it. Multiple trusted resolution comments, malformed content or incomplete bounded pagination invalidate observation. See the [Issue comments API](https://docs.github.com/en/rest/issues/comments).

Resolution requires schemaVersion:1, actual requestId, disposition, rationale and ISO millisecond reviewedAt. Dispositions: accepted, duplicate, project-specific, needs-evidence, declined. Optional duplicateOf is a positive issue number for a duplicate. Optional implementation/verification each contain reference, summary, sourceCommit. Optional release contains version, sourceCommit, artifactSha256, publicationReference, inspectedBy, inspectedAt; it requires accepted disposition plus implementation and verification.

Issue body and open/closed state are data. Acceptance, implementation, verification, maintainer-reported publication and local installation remain separate facts. A release comment installs nothing. Failed refresh preserves the last valid resolution and reports it stale.

## Manual recovery

Recovery never runs automatically or sends anything. Lifecycle reconciles uncertainty and never consumes a reviewed create grant. A later explicit submit may consume the one-use retry grant.

Prepare checkout-relative JSON from the inspected retained chain:

| Field | Reviewed value |
|---|---|
| schemaVersion | 1 |
| intentEventId | Latest intent event UUID; null only for lock release before intent |
| expectedLastEventHash | Current chain head hash; null for an empty chain |
| actor | Safe local approver alias |
| decision | retry-create or release-lock |
| reason | Explicit bounded rationale |
| acceptDuplicateRisk | true for retry-create; false for release-lock |
| ownerNonce | Exact retained lock nonce, only for release-lock |

~~~bash
node .codex/core/intake.js recover --id "$requestId" --input "$workDir/recovery.json"
~~~

Retry-create requires non-null intent/head, current recovery authority for the original destination and explicit duplicate-risk acceptance. Request/destination/policy/export-profile bindings revoke the grant if changed. Release-lock is separate offline recovery: the exact local-host owner must be definitely absent. A live/reused PID, foreign host or ambiguous liveness refuses; age never permits lock stealing.

## Storage and evidence boundaries

Project-owned configuration lives in .agents/intake/identity.json and policy.json; it is preserved by install/update and excluded from toolkit distribution. Immutable request/event JSON is project-owned output. Durable records live under the active reporting checkout's docs/.output/evolution/learning-requests/ and learning-events/, bucketed by month. Owned transient locks live under the shared-state root's ignored docs/.output/.state/learning-intake/. Status reports safe source references. Intake does not stage/commit/push, promote memory, provision a receiver, publish or install; caller-authorized Git retention follows the existing workflow.

Terminology: "intake" here always means this toolkit-lesson workflow and its `.agents/intake/` configuration. `/listen` writes a different thing, the signal-intake file under `docs/.output/evolution/intake/` that `/triage` drains. Because `intake` is a generic name, an update that finds your own `.claude/commands/intake.md` or a differing `intake` skill directory reports a conflict and leaves it alone; rename yours, or add `intake` to `skillExclude` in `.claude/update-config.json` (an existing `learning-intake` exclusion already carries over).

Renamed from learning-intake. The command, skill, helpers and limits constant are now `intake`, `intake-github`, `_lib/intake-store` and `INTAKE_LIMITS`; update removes the old native and canonical files when unedited (see `.agents/adapters/retired-outputs.json`) and reports any edited one. Names that identify stored or remote records keep their original spelling, because changing them would strand existing records or invalidate hashes: the `AGENTS_LEARNING_REQUEST_V1:` and `AGENTS_LEARNING_RESOLUTION_V1:` record prefixes, the `agents-learning-` occurrence marker searched in GitHub issues, the `evolution/learning-requests` and `evolution/learning-events` record directories, and the legacy `.agents/learning-intake/` configuration location. The lock directory `.state/learning-intake/` keeps its name too: a lock retained after a crashed or uncertain submit is read back on the next run for reviewed recovery, so renaming the directory would let a post-upgrade submit ignore it and risk a duplicate GitHub issue.

Actual install/update/repeat/restore fixtures preserve authority/history, root guidance, role personalization, marked skills, settings and application-only gates. Contaminated source identity/policy/queue records are excluded from fresh installs and published selection. Native helpers include canonical dependencies; workshop runner/tests are not installed into adopters.

Durable publication requires file synchronization and a durable directory entry. On POSIX each parent directory is synchronized; on Windows, where a directory handle cannot be flushed, the published record is flushed through a writable handle, which on NTFS commits the metadata log that holds its new link (the guarantee SQLite relies on there); on FAT, exFAT or a network share that proof does not hold, so keep intake on an NTFS volume. Any failed synchronization returns persistence-failed and retains published evidence without proceeding to create. Default native credential acquisition is fixture-proven for POSIX process groups. Windows refuses before credential spawn until equivalent containment exists; trusted injected token providers are separate programmatic seams with caller-owned I/O. No live GitHub claim follows from offline proof.

Contributor checks belong in Domdhi.Agents: native gate test, npm run test:coverage, render check and focused/integration suites. See [engineering conventions](../../../engineering/conventions.md#focused-feedback-and-full-checkpoints). Adopter Build/Test/PR gates remain application-only.

Provenance: adapted from an upstream learning-intake workflow; shared store/core protections retained with bounded GitHub transport and neutral contracts.
