---
name: recover
description: Recover an interrupted native Codex Agent Plan task by reconciling durable records, worktrees and hosted side effects before resuming.
---

Read [the native binding](../../native.md), [the workflow contract](../../shared/contract.md)
and [the task record](../../shared/task-record.md). Load the saved absolute state
pointer, configuration snapshot, decisions, reports and pending operations.

Inspect worktree status and Git history, native sessions and configured GitHub/GitLab
request state. Reconcile each pending operation as applied, not applied or unknown;
save evidence. Unknown outcomes block retries. Preserve dirty work and unresolved
owner decisions; never infer approval from tool success, provider acceptance or a bot.

Resume only confirmed outstanding authorized work with the original role assignments
and bounds. A changed candidate invalidates verification, all required reviews and
approval. Confirm native delegation availability and configured routing before
resuming; direct execution is an explicit user choice and lacks independent reviews.
Report recovered facts, retained work, remaining uncertainty and next action.
