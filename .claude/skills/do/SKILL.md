---
name: do
description: "Run the do workflow when explicitly requested. Uses the existing authored command and its completion rules."
---

<!-- Generated from .agents/skills/do/SKILL.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# do

Read `references/workflow.md` relative to this skill before acting, then follow its workflow using the user's arguments. Read referenced skills, templates and role instructions only when the current step needs them. Existing project instructions and user authorization apply.

## Runtime adaptation

For Codex, read `.agents/adapters/codex/execution.md` and apply its native tool and model rules.
