# Migrating to v6

v6 makes `.agents/` the authored home for shared workflows, roles, helpers and hooks while retaining ordinary Claude/Codex entry points. This sweep prepares canonical `6.0` metadata and documentation locally. That does not establish a published release, a synced fleet or installed native trust.

## Before updating an application

Use a pinned toolkit checkout and the existing installer/updater. Review its preview and conflicts before applying. Ordinary calls require no organization declaration, policy file or target identifier.

```sh
# Codex; Claude uses .claude/core/ with the same arguments.
node .codex/core/template-updater.js update /path/to/project --merge --dry-run
node .codex/core/template-updater.js update /path/to/project --merge
```

For a new installation, use `install.js /path/to/project --dry-run` then the ordinary installer after reviewing the preview. Project root instructions, role personas/Project Context, bespoke skills, marked additions, local settings and overrides remain preserved through existing mergers. Default merge refreshes shared settings wiring without replacing project permissions/env. Root CLAUDE/AGENTS prose survives outside toolkit-managed startup blocks. [Customization](customization.md) documents each boundary.

Managed-output edits are conflicts, not authoritative shared source. Move intended changes to canonical files, preserve local additions/overrides and render. Missing source assets, invalid project update configuration and unsafe paths refuse; a failed update is not a completed version. Never force a conflict merely to make output hashes match.

## Authoring and native entry points

| Previous native authoring habit | Current authored home |
| --- | --- |
| Edit `.claude/agents/{role}.md` | `.agents/roles/{role}.md`, then render |
| Edit generated Claude command | `.agents/skills/{native-name}/references/workflow.md` and selector/mapping; specialize uses SKILL.md |
| Edit generated skill/support files | `.agents/skills/{name}/` |
| Edit generated core/hook wrappers | `.agents/core/`, `.agents/hooks/` |
| Edit runtime models/hook protocol | Workshop `.agents/adapters/{runtime}/`; preserve adopter native overrides |
| Change release metadata in native version | `.agents/config/version.json`, then render |

Legacy native roles/skills without canonical counterparts retain their supported authoring fallback. Shared role frontmatter holds identity/description/skills; runtime fields belong in adapters/native `shared-agents.json`. Skill additions use tail or anchored inline project markers outside code fences. The renderer records source/projection ownership in `.agents/render-state.json`; commit the ledger with all required canonical/native changes.

```sh
node .codex/core/render-shared-agents.js
node .codex/core/render-shared-agents.js --check
```

Use `.codex/core/` helpers in Codex and `.claude/core/` in Claude. Shared guidance's Claude helper examples translate to the active native prefix with arguments/gates retained. Direct shared-helper execution must explicitly set `AGENTS_RUNTIME=codex` when Codex behavior is intended.

Claude commands remain compatible. Codex uses discovered `$` skills: `/review:qa` maps to `$review-qa`, `/create:module` to `$create-module`. [Commands](commands.md) lists all 49 mappings. If a pre-install session cannot discover a newly installed skill, start a fresh session; reading a file is not proof that the native workflow ran.

## Runtime behavior and evidence limits

- Claude ordinary role floors are Sonnet, security-auditor is pinned Opus and selected high-stakes calls escalate through routing policy. Codex uses its configured native model and tools.
- Codex converts Claude ask into a denial requiring explicit review. Post-output secret handling can refuse continuation and supply redacted feedback after the tool completes; it cannot undo tool effects.
- Codex supports its registered event/tool surface, including apply_patch/Bash/MCP adaptation. It does not invent Claude Read/Skill/Task/ExitPlanMode hooks. Automatic Stop extraction is unregistered.
- Optional Codex extractor/curator/benchmark inference refuses before model launch because a verified tool-free invocation is unavailable. Session-handoff learning, explicit curated-memory CRUD, inbox promotion and search remain supported. Claude retains its text-only Sonnet backend.
- Native hook trust requires repository and exact-definition review. New/changed hooks may be skipped pending review. Parity, installed discovery, executed handlers, named-role execution and fresh-session model-visible behavior are distinct evidence.
- Current local v6 work does not establish fresh live Windows or trusted native-model execution. Historical Windows/reference probes are separately attributed in the [Codex README](../../../.agents/adapters/codex/README.md). Earlier SA-6 Claude execution/resume checks remain blocked in their own TODO; current fixtures do not close them.

[Hooks](concepts/hooks.md) documents the runtime boundaries. Plain terminal commands and some specialized/hosted tools bypass hooks. Staged secret scanning runs through native `commit.js`; the retired `.githooks/pre-commit` path does not protect a plain terminal `git commit`.

## Source checkout and ignored shared state

Toolkit code/assets resolve from the installation independently of action context. Tracked memory belongs to the active source checkout; ignored index/inbox/log state uses the main worktree's Git-common-directory root unless separately overridden.

The [context contract](../../../.agents/adapters/codex/README.md#context-contract) owns exact precedence: neutral/Codex source overrides, legacy Claude fallback and explicit `AGENT_SHARED_STATE_ROOT`. Native Codex helpers establish runtime independently from child hook environments. Preserve source/shared-state separation in linked worktrees; do not move curated JSON into ignored shared state.

## Verification and committed delivery

Application adopters run their own Build/Test/PR gates, including after agent-file changes. Toolkit tests remain in Domdhi.Agents under canonical `.agents/**/__tests__/` and workshop `tools/__tests__/`. They are not an additional application gate leg.

After update, verify relevant role/context/addition/settings preservation, declared skill resolution and actual native helper use. Record the full changed source/native/ledger set together; a wrapper-only commit lacks its executable dependencies. The current sweep also verifies publication refusal, repository/source containment, incomplete/empty memory repair and truthful worktree cleanup. Its final gate and review records—not this guide—establish repair closure.

## Local release preparation and later distribution

The canonical version is `.agents/config/version.json`; `.claude/version.json` is a rendered compatibility copy. Existing pure fleet version/changelog functions prepare the release metadata, cap inline history using `CHANGELOG_INLINE_CAP` and archive overflow into workshop-only `CHANGELOG.md`. Render and check canonical/native agreement before claiming a locally prepared version.

The current sweep prepares `6.0` once. Do not run another major version bump to distribute that prepared snapshot: it would create a different next major version. Release preparation, source/evidence commits, public mirror publication and fleet sync have separate checks and authorization.

When publication is authorized, the existing publisher can distribute the prepared tracked snapshot independently:

```sh
# Workshop only: preview the prepared snapshot.
node tools/publish.js _Domdhi.Agents --dry-run --prune
# After review and publication authorization, copy/prune/commit the storefront.
node tools/publish.js _Domdhi.Agents --prune --commit
# Remote push is a separately authorized option on the same publisher.
```

`_Domdhi.Agents/` is the independent nested storefront repository, with its own Git root. A source checkout publishes Git-tracked allowlisted files; ignored/untracked work does not become public merely because it exists on disk. A genuinely plain source tree has a supported fixture/bootstrap fallback; failed Git discovery in a checkout is not permission to broaden selection. Preserve the explicit manifest/default exclusions, source containment and mirror repository ownership. Copy/prune errors must prevent release commit/push; inspect the complete result.

Do not repurpose application Git history or publish the workshop's working state. Publication does not scaffold adopter project docs. Toolkit reference docs are delivered in the workshop/publish artifact only; install/update do not copy `docs/reference/agents/`.

After the prepared snapshot is reviewed/published as appropriate, a separately authorized `tools/fleet.js sync` can update selected applications through the existing updater. Preview with its `--dry-run` option, preserve project changes and commit complete toolkit delivery rather than only Claude wrappers. Nothing in local version preparation authorizes push, fleet rollout or deployment.

See [contributing](guides/contributing.md) for shared additions, [customization](customization.md) for merges and [system map](system-map.md) for source/native wiring.
