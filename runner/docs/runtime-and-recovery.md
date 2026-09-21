# Runtime and recovery

This guide covers task state, ownership, interruption, and delivery. Start with the
[operator flow](../README.md#operator-flow).

## Runtime and inspection

The CLI starts the runtime in the background. Startup failures are written to
`daemon.log` under the data directory. A later CLI call replaces a running daemon
built from different runner source. For foreground debugging:

```sh
node runner/server.js /absolute/data-dir
```

All terminals use `~/.local/state/agent-plan` by default. `RUNNER_DATA` selects a
different data directory. Keep that directory and the source repository's Git object
database together when backing up.

`agent-plan inspect TASK` shows task and agent status, integration worktrees,
decisions, verification, and the event timeline. The dashboard adds artifact browsing,
automatic status refresh, and links back to Herdr. Its fragment carries owner access;
keep the URL private. Dashboard session storage allows browser refresh. Full Pi
conversations stay in Herdr and the session files listed in the full task state.

For an inert draft rather than immediate launch:

```sh
agent-plan submit REPO BRIEF_FILE REQUEST_ID
agent-plan start TASK
```

Reusing a submission ID with identical input returns the original task; changed input
is rejected. Startup never repeats automatically after an uncertain response. Inspect
the task ID reported by the failed call before retrying.

## Execution and ownership

- Multiple tasks may run against one repository. Each gets an integration worktree;
  each worker, including exploration workers, gets its own worktree. Repository-level
  worktree creation is briefly queued and task mutations are serialized.
- Up to `maxWorkers` workers run within a task. New branches use
  `runner/<brief-slug>-<id>` so Herdr displays the task name.
- The coordinator cannot edit repository files. Writing workers can change their
  worktree and invoke owner-configured named commands. Exploration workers only write
  artifacts. Git/Pi internals and symlink escapes are blocked by the file API.
- Worktrees are not OS sandboxes. Named commands run as the runtime user; configure
  only trusted repositories and commands.
- Parallel writers must share the same published contract. To revise it, pause affected
  writers with a recorded question, publish a new revision, then answer those questions
  with the new reference.
- Completed worker changes are committed and integrated serially. Integration waits
  for relevant workers and refreshes final verification.

`completed` means a verified candidate branch. It does not mean accepted, merged,
pushed, or deployed.

## Artifacts and coordination

Task data is arranged as follows:

```text
tasks/TASK/
  artifacts/
    brief.md, workflow.md, worker.md, config.json
    orchestrator/                 # plans, architecture, evidence, handoff
    workers/WORKER-ID/            # worker output, checkpoints, evidence
    coordination/SOURCE-TASK/     # copied peer proposals
    runtime/                      # system reports and recovery details
  worktrees/integration/
  worktrees/w-ID/
  sessions/AGENT-ID.jsonl
```

Artifacts are immutable: publish a new revision instead of overwriting a file. Workers
write only in their assigned artifact directory; coordinators and the owner can write
across task artifact directories. `revise {name,artifact,previous}` changes a current
document pointer while retaining history and notifying workers. `checkpoint {artifact}`
records resumable progress; completed commands also record evidence.

`peers` and `coordinate {taskId,artifact}` copy proposal files between coordinators in
the same repository during reconciliation. They do not detect semantic overlap or
share model context. Coordinators still pause affected writers and agree on contracts.

A hard crash preserves files already written, session data, worktrees, and durable
receipts; it cannot preserve unsaved model reasoning.

## Decisions and interruption

Workers ask the coordinator; the coordinator asks the owner. Every answer targets an
exact decision. A worker cannot answer an owner decision or spawn another worker. The
owner may answer a worker decision directly when intervention is necessary.

A waiting worker does not stop unrelated workers. The Pi extension checks inboxes
without model calls, wakes agents with artifact references, and acknowledges messages
after successful turns. Delivery can repeat after an uncertain crash, so mutating tool
calls use durable request receipts. An uncertain receipt is surfaced instead of being
replayed automatically.

Herdr `idle` and `done` are not evidence of completion. Missing sessions and expired
attempt budgets become attention events. The runtime reconnects surviving Pi sessions
after restart and reuses saved session files.

Budgets limit concurrent workers, total attempts, commands, and running-attempt time.
A recorded user wait is exempt; active time includes gaps between model turns. An
explicit resume grants a fresh window.

## Resume, cancel, and clean up

```sh
node runner/cli.js resume TASK_ID AGENT_ID
node runner/cli.js cancel TASK_ID
node runner/cli.js cleanup TASK_ID
```

Resume checks for a surviving session before reopening its saved Pi session. Unknown
Herdr state blocks relaunch. Cancellation interrupts named commands, revokes task
actions, and closes recorded agent tabs; any stop errors are returned. Cleanup removes
clean worktrees only for terminal tasks. Dirty or interrupted work, branches, artifacts,
and histories remain available.

Interrupted commands retain their process-group identity and output path. Recovery
refuses to continue while that process group is alive.

## Recover an interrupted operation

Inspect the task and retained worktree first. For an interrupted integration, resolve
or abort the cherry-pick in the integration worktree, then acknowledge the observed
outcome:

```sh
node runner/cli.js recover TASK_ID applied
node runner/cli.js recover TASK_ID aborted
```

The runtime validates the resulting Git state. Other interrupted operations also
require inspection before recovery. `recover` records an already-resolved outcome; it
does not resolve conflicts, reset files, or discard work.

If integration worktree creation failed before its identity was saved, cancel the task,
inspect the retained `worktrees/` directory, and submit a fresh task after resolving it.

## Independent candidate review

New tasks require a read-only `stage: "review"` worker after integration and
verification. The reviewer receives the candidate commit, task diff, prior reviews,
and the snapshotted [review rubric](../workflow/review.md). Reports contain structured
findings with severity, file/line, evidence, and a suggested fix.

Clarification classifies tasks as routine or declares concrete security, data-safety,
recovery or operator risks. Sensitive work receives plan assurance before writers and
fresh matching candidate-assurance passes on the exact verified commit. A fresh general
review still runs last; routine work skips the specialist passes. These are workflow
requirements rather than new runtime state.

Major and medium findings block completion. The coordinator delegates repairs,
integrates, verifies, and requests another review until the current commit passes.
Changing the commit invalidates the review; minor findings remain in the handoff.

By default, review prefers the opposite OpenAI/Claude family from the latest integrated
writer and avoids other writer models where possible. `workerModels.review` can choose
one explicitly. Unavailable or quota-limited choices fall back to another available
model, ultimately the implementation model, with the reason recorded. Review still
runs as a separate worker. Attempt/time/concurrency exhaustion is a blocker; there is
no automatic waiver. This gate proves review identity, schema, and freshness—not the
semantic correctness of the review—and runtime verification remains required.

## Acceptance and delivery

```sh
agent-plan accept TASK
agent-plan accept TASK COMMIT --target master
```

Without `COMMIT`, the CLI selects the task's recorded verified commit. Acceptance
authorizes rebasing that candidate onto the local target (`main` by default), rerunning
verification, and fast-forward merging. The source checkout must be clean and on the
target. Untracked `.runner/answers/` files do not count as dirt. Acceptance is
serialized per repository while unrelated task work continues.

No remote fetch, push, pull request, or deployment occurs. Dirty work, stale approval,
rebase conflicts, failed checks, or a target that changes during verification stop the
operation. Nothing resets or stashes user changes.

If acceptance failed before Git mutation began, clean the source and retry with the
same request ID. For an interrupted rebase, inspect the retained state, resolve or
abort it, acknowledge the outcome with `recover TASK applied|aborted`, run
`verify TASK`, and accept the reviewed commit again. Interrupted merges keep their own
operation record so recovery can confirm the candidate is already on the target rather
than repeat the merge.
