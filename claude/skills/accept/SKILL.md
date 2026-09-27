---
name: accept
description: Inspect and explicitly accept an exact verified and reviewed Agent Plan candidate for a GitHub PR or GitLab MR merge.
argument-hint: "[task ID] [candidate commit] [target branch]"
disable-model-invocation: true
---

Read [the common workflow contract](../../shared/contract.md) and
[the common task record](../../shared/task-record.md) before acting. These define the
shared stages, review roles, evidence and approval rules; this file binds them to Claude.

Read [delivery](../../workflows/delivery.md) and follow it using Claude's native
tools. User selection: $ARGUMENTS

Resolve the task using [recovery](../../workflows/recovery.md). Inspect the actual
candidate, checks and independent review before presenting the exact commit and
target for user approval. Reuse an explicit current approval only for that exact
candidate/target. A changed candidate requires new checks, review and acceptance.
Publish or update the PR/MR, verify hosted CI and required reviews, then merge on
the host with the approved SHA guard. Never merge locally or deploy.
