---
name: restore
description: Restore supervisor context from saved memory or a checkpoint and reconcile current task, Git and hosted delivery state.
argument-hint: "[absolute memory or checkpoint path]"
disable-model-invocation: true
---

Read [the common workflow contract](../../shared/contract.md) and
[the common task record](../../shared/task-record.md) before acting. These define the
shared stages, review roles, evidence and approval rules; this file binds them to Claude.

Current supervisor session identity: ${CLAUDE_SESSION_ID}
Memory/checkpoint selection: $ARGUMENTS

Follow [supervisor continuity](../../workflows/continuity.md), Restore before action.
Use native Read/Glob/Grep/Bash to reload only the required context and inspect state.
Never select another session by recency, overwrite its notes, invent approval or
spawn replacement agents merely because context was compacted. Restore the supervisor
only; keep existing coordinator and worker ownership under the recovery workflow.
