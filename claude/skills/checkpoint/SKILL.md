---
name: checkpoint
description: Save the whole supervisor session in a structured, verified checkpoint before compaction.
argument-hint: "[optional focus ticket]"
disable-model-invocation: true
---

Supervisor session identity: ${CLAUDE_SESSION_ID}
Optional resume focus: $ARGUMENTS

Follow [supervisor continuity](../../workflows/continuity.md), save the complete
supervisor discussion and owned ticket references, and read the checkpoint back.
No ticket is required: preserve discussion that has not yet become a task too.
Do not request coordinator/worker checkpoints or change their lifecycle.
Update memory.md, save a versioned snapshot and report both absolute paths. Provide
the focused native `/compact` command and `/agent-plan:restore <memory path>`
fallback described in the workflow. Keep the same session; never suggest `/clear`.
Do not invoke or claim to have performed compaction.
