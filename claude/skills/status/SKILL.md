---
name: status
description: Inspect saved Agent Plan tasks and actual native agent and Git state without resuming work.
argument-hint: "[task ID]"
---

Use the selection and read-only inspection steps in
[recovery](../../workflows/recovery.md). Requested task: $ARGUMENTS

Read the shared active.md for discovery, verify the selected scope/state and report
task ID, phase, checkout/branch, observed native agents, pending questions,
verification/review commit, blockers and next action. Distinguish observed state
from stale notes. With no selected task, list active tickets and Pending acceptance.
For an exact ticket/history request, include [archive](../../workflows/archive.md)
evidence too. Do not start workers,
change files, claim an unavailable agent is alive, or infer completion from a
session exit. Use only built-in Claude tools.

For published candidates, inspect the recorded GitHub PR/GitLab MR, exact head,
CI/reviews, evidence links and merged/queued status read-only. Report stale or
unreachable host state explicitly; saved approval is not observed merge completion.
