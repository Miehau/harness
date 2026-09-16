---
name: checkpoint
description: Save the current Agent Plan discussion and exact recovery references before compaction or leaving.
argument-hint: "[task ID]"
disable-model-invocation: true
---

Follow the checkpoint steps in [recovery](../../workflows/recovery.md).
Requested task: $ARGUMENTS

Save the supervisor's requirements, user decisions, pending questions, coordinator
IDs and evidence references in supervisor.md. Request a coordinator checkpoint
through native controls and follow the role-specific recovery instructions. The
coordinator owns state.md and its child-agent notes; do not overwrite them from
this conversation or claim a requested checkpoint has completed without evidence.

Report the saved path. Do not claim unsaved discussion or background processes
will survive a closed session. With no task selected, ask which task to checkpoint.
