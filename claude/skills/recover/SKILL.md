---
name: recover
description: Inspect interrupted native Agent Plan work and continue from saved evidence when ownership and Git state are clear.
argument-hint: "[task ID]"
disable-model-invocation: true
---

Read [recovery](../../workflows/recovery.md) and inspect the exact selected task.
Requested task: $ARGUMENTS

Preserve dirty work, resolve uncertain operations before repeating them, and use
native subagent resume only when the exact saved agent is available. Do not launch
external sessions or claim an unavailable agent resumed. Once ownership, scope and
Git state are clear, resume the owning coordinator under
[the supervisor workflow](../../workflows/supervisor.md). Do not resume or spawn
individual workers from the supervisor as a substitute for that coordinator.
Pending user questions need answers; candidate delivery still needs acceptance.
