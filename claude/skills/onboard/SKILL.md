---
name: onboard
description: Explore the current repository and establish focused documentation and meaningful verification using native Claude agents.
argument-hint: "[constraints]"
disable-model-invocation: true
---

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
