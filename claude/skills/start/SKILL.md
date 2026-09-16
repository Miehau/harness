---
name: start
description: Plan and implement a repository task with native Claude subagents, isolated writers and independent review.
argument-hint: "[task description]"
disable-model-invocation: true
---

Supervisor session identity: ${CLAUDE_SESSION_ID}

Work on the current repository. User request: $ARGUMENTS

Read [the supervisor workflow](../../workflows/supervisor.md). You are the supervisor
in the main conversation. Spawn one `agent-plan:coordinator` for this ticket using
Claude's native Agent tool and worktree isolation. Pass the full brief, exact base,
notes and absolute workflow paths. The coordinator spawns and manages all workers.
Do not dispatch researcher, implementer or reviewer agents from this conversation.

If the request is missing, ask for the intended outcome. Otherwise begin inspection
and planning; do not ask for permission to do already requested work. Ask only for
material missing requirements, normal tool permissions, or explicit delivery approval.
Infer the repository from the working directory, not a required path argument.

Save notes and exact references at each milestone. Publish the verified candidate
as a PR/MR with evidence under [delivery](../../workflows/delivery.md).
Merge only after explicit approval of that exact candidate and target.
