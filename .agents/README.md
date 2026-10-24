# Domdhi.Agents shared source

Domdhi.Agents is the toolkit workshop. Author shared behavior once under `.agents/`; generated Claude and Codex entry points retain existing invocation paths. Canonical version metadata lives in `.agents/config/version.json`.

Generated parity, installed discovery and actual trusted runtime execution are separate evidence. Preserve project-owned customization through the existing mergers.

| Surface | Authored source | Delivery / owner |
| --- | --- | --- |
| Workflow | `skills/{name}/references/workflow.md` | Canonical skill entry; generated Claude command from `adapters/workflows.json` |
| Knowledge and assets | `skills/{name}/` | Codex discovers canonical skills; Claude gets generated copies |
| Role behavior | `roles/{name}.md` | Generated Claude Markdown and Codex TOML; project identity/context merged |
| Shared helpers and hooks | `core/`, `hooks/` | Generated native executable/import wrappers |
| Document/config templates | `templates/` and skill `assets/` | Generated compatible paths; scaffold uses existing manifest |
| Shared policy/version | `config/` | Native compatibility copies |
| Runtime metadata/protocol | `adapters/{claude,codex}/` | Runtime-specific role, workflow, model and hook settings |
| Root instructions | `startup.md`, conditional `startup-reference.md` | Managed directives in project-owned root prose |
| Project overrides | Native settings/local files, bespoke skills/hooks/helpers and marked additions | Preserve through existing mergers; report conflicting overrides |
| Toolkit tests | `.agents/core/__tests__/`, `.agents/hooks/__tests__/`, `.agents/adapters/{claude,codex}/__tests__/` | Shared suites colocate with canonical code; runtime-specific suites with adapters. Domdhi.Agents only; never an adopter application gate |

Choose the entry point for the active runtime: Codex uses `.codex/core/`; Claude uses `.claude/core/`. These Codex examples preserve the established helper arguments:

```sh
node .codex/core/render-shared-agents.js --check
node .codex/core/render-shared-agents.js
```

`render-state.json` records generated ownership hashes. Missing/stale output and edited managed files require review; project files are never disposable output. Move intended shared changes into their canonical source, then render. Do not force over an adopter conflict to obtain matching bytes.

Canonical `core/`, `hooks/`, `templates/`, `config/` and `adapters/` hashes in that ledger preserve the accepted input baseline. Rendering bootstraps missing entries but retains recorded baselines, including during forced or partial renders; install/update advances them for accepted input files. A local canonical edit can therefore be rendered for use while still causing the next update to refuse before overwriting it. A baseline already replaced by an older renderer needs comparison with the installed release; current file bytes cannot reconstruct that history.

Install and update through the established helpers. Source assets, target paths and project update configuration are validated before mutation.

```sh
node .codex/core/install.js /path/to/project --dry-run
node .codex/core/template-updater.js update /path/to/project --merge --dry-run
node .codex/core/template-updater.js update /path/to/project --merge
```

Runtime model/tool/permission differences stay in adapters. The Codex hook adapter provides the conversion of patches and output envelopes, with portable installed-asset resolution. Its README records supported registration and limitations. Trusted runtime execution is separate from generated parity and offline subprocess tests.

Compatibility migration lessons: preserve inherited behavior and assertions, distinguish source worktree from shared ignored state, test the actual native consumer, and keep fixes focused. Avoid expanding a move into helper redesign or repeating unchanged broad verification.

## Preservation checks when changing mergers or delivery

Compare an adopter's declared bespoke skill list before and after a sync, including symlinked skill directories. Reordering a reference is not removal; a reference with no corresponding addition is. Structural Markdown scans must ignore headings and ownership-marker examples inside code fences, and reanchoring must keep project additions outside those examples. Exercise those cases through the actual merger and rendered consumer, rather than only checking a helper's output shape.

Version and sync the text source of derived state, including curated memory JSON. Keep its binary search index and other regenerable state ignored, and rebuild from source after a pull or source change. This preserves cross-machine content while avoiding whole-file binary merge loss. Native wrapper subsets and delivery commits must include the matching canonical implementations and ownership ledger.
