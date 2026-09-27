---
name: accept
description: Accept a native Codex Agent Plan candidate only with exact-revision owner approval, passing independent reviews, verification and delivery gates.
---

Read [the native binding](../../native.md), [the workflow contract](../../shared/contract.md)
and [the task record](../../shared/task-record.md).

Read the current candidate SHA and target from durable state. Confirm owner approval
identifies that exact revision and target, all configured verification passed on it,
and requirements/AC, correctness and applicable specialist reviews passed on it with
no medium or major findings. Self-review cannot satisfy an independent role.

For hosted delivery re-read configured GitHub/GitLab repository, request head, target
and all required CI/branch gates immediately before merge; unknown or failed gates
block. Any revision or target change invalidates approval and requires fresh evidence.
For local delivery require a clean target checkout and verified fast-forward candidate;
stop on conflicts or target movement. Persist intended operation before mutation and
observed result afterward. An uncertain result goes through recover before retry.
Report accepted SHA and provider/local result; retain worktrees until safe cleanup.
