---
name: watch
description: Follow the selected task's native Claude subagents in this open session.
argument-hint: "[task ID]"
disable-model-invocation: true
---

Inspect the selected task using [recovery](../../workflows/recovery.md).
Requested task: $ARGUMENTS

Use Claude's native agent completion notifications and task-output/wait facilities
for the exact coordinator IDs. Workers remain owned by their coordinators. Handle
ticket results under [the supervisor workflow](../../workflows/supervisor.md),
save reports, and relay genuine product questions to the user. Do not shell-poll,
use `/loop`, start a watcher service, or repeatedly spend model turns checking state.

If this session cannot observe the saved agents, explain that and offer the
recovery workflow. Watching does not create cross-session subscriptions or promise
notifications after Claude closes. Never duplicate agents to make watching work.

After coordinator completion, follow hosted delivery under
[delivery](../../workflows/delivery.md): inspect the known PR/MR and use a bounded
host-client wait for its CI when supported. On timeout, save pending status and the
next action. Handle failures through the coordinator; never interpret CI success
as user approval or queue admission as completed merge.
