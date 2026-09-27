---
name: onboard
description: Explore the current repository and establish focused documentation and meaningful verification using native Claude agents.
argument-hint: "[constraints]"
disable-model-invocation: true
---

Read [the common workflow contract](../../shared/contract.md) and
[the common task record](../../shared/task-record.md) before acting. These define the
shared stages, review roles, evidence and approval rules; this file binds them to Claude.

Supervisor session identity: ${CLAUDE_SESSION_ID}

Follow [the supervisor workflow](../../workflows/supervisor.md) in the current repository for
this outcome: inspect the code and existing checks; preserve curated documentation;
add only missing, useful verification instructions or a real verification script,
a partial feature map, and concise architecture/feature notes. User constraints:
$ARGUMENTS

Reuse existing documentation locations and project tooling. Do not install a runner,
MCP server or dependencies for this plugin. Do not overwrite CLAUDE.md or settings.
Delegate this entire ticket to `agent-plan:coordinator`, which owns discovery,
planning, implementation, verification and independent review. Present its candidate for
explicit acceptance; do not automatically merge it.

Read owner-maintained `.agent-plan/project.json` and optional ignored
`.agent-plan/local.json` before selecting runtime, role models, hosting and checks.
Preserve existing configuration and ask only for material missing owner choices.
When canonical project configuration is absent, use `.runner/project.json` for
compatibility. Local overrides affect only execution and agent/model preferences;
never replace owner checks or hosting with local settings.
This installed binding supports native Claude only: refuse a configured or requested
unsupported runtime rather than silently substituting Claude or launching another CLI.
Native crossing to another runtime is not implemented. Model frontmatter defaults to
inherit; use owner role models only when supported by the installed native Agent tool,
and surface unsupported routing instead of claiming it was enforced.
