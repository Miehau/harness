---
name: status
description: Inspect a native Codex Agent Plan task's durable state, candidate, decisions, reviews and delivery gates without mutating it.
---

Read [the native binding](../../native.md), [the workflow contract](../../shared/contract.md)
and [the task record](../../shared/task-record.md). Locate the task using its saved
original-checkout absolute state pointer; request an ID only when ambiguous.

Read the record and referenced immutable reports, compare worktree and candidate
SHAs, and inspect native worker status plus configured provider head and CI read-only.
Report stage, exact candidate, AC/verification evidence, each required reviewer role,
open decisions, pending or unknown operations, PR/MR and next needed action. State
which observations are stale or unavailable. Worker idle/done is not task completion.
Do not resume, dispatch workers, update approval, publish, merge or clean up.
