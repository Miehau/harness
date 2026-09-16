---
name: stop
description: Stop the selected task's native subagents while preserving work and recovery notes.
argument-hint: "[task ID] [pause or cancel]"
disable-model-invocation: true
---

Read [recovery](../../workflows/recovery.md), select the exact task and follow its
pause/stop steps. User request: $ARGUMENTS

If pause versus cancellation is unspecified, stop active work and record paused.
Ask the owning coordinator to stop/settle its children and return a checkpoint.
Use only exact known native IDs; inspect before stopping anything. Do not assume
stopping the coordinator also stopped its children or claim certainty without evidence.
Preserve all branches, notes and dirty worktrees. Report any agent that could not
be stopped. Do not delete files, kill unrelated sessions or infer approval to merge.
