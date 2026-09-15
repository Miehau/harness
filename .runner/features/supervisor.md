# Supervisor sessions

`runner/supervisor-extension.js` connects an ordinary, trusted Pi session to the
existing owner API. `agent-plan supervisor` launches it with Pi provider/model
arguments. Watches and acknowledged event IDs live in Pi session entries.

Coordinator questions and result references arrive as follow-up messages. The
model tool exposes start (submit, launch and auto-watch), watch, inspect, artifact
read, advisory feedback, routine coordinator answers, ask_user and accept. Start uses a stable requestId for submission and launch
receipts, persists its watch before launching, and returns a compact task identity.
The coordinator owns worker delegation; no per-worker subscriptions are needed.
ask_user collects the human reply through Pi input and routes it to the exact
coordinator decision. accept confirms the exact verified commit and target before
calling runtime acceptance. Cancelled/headless dialogs cannot authorize mutations.
Human actions persist in session entries and reuse runtime receipts across retries.
The interactive answer command remains an optional shortcut.
The model answer action calls the runtime supervisor-answer operation, which writes
an immutable reply and resumes the exact coordinator with answeredBy=supervisor.
Approval hooks and requiresOwner questions reject model replies; the shared owner
answer and acceptance paths remain available for human decisions. Scope reasoning
remains a supervisor instruction; the runtime enforces the explicit classification.
Ordinary Pi shell access remains trusted owner access, not a security boundary.

Evidence: `test/supervisor.test.js` checks delivery, restart deduplication,
advice/answer separation, stale decisions and cancelled confirmation.

UI completion events include evidence manifest/media references; video reads return
metadata/localPath rather than unsupported image blocks. See [UI evidence](ui-evidence.md).

The supervisor-start case in `test/runner.test.js` exercises real runtime intake,
mocked launches, lost-response retries, session restoration and coordinator questions.

Runtime tests cover exact-decision wake-up, restart/retry deduplication, provenance,
stale/cancelled targets, human-only questions and legacy approval events.

The full conversation test in `test/runner.test.js` exercises a worker question,
coordinator escalation, human dialog reply, coordinator-to-worker answer, completed
implementation and human-confirmed local acceptance. Unit tests cover cancelled,
headless, aborted and stale requests, plus requirements questions before task creation.

## Durable memory

The supervisor index and per-feature Markdown files live beneath the runner data
root in `supervisor/`; task notes can precede launch. The index is loaded every turn,
with task filenames and watched IDs for retrieval and live reconciliation. Memory
writes compare previous contents, reject path traversal and use atomic replacement.
Watch/event/human-action receipts also persist outside Pi sessions, so fresh sessions
can continue monitoring without replaying consumed events or prompting twice on retries.
One supervisor owns this directory; concurrent sessions require separate data roots.

`/runner-checkpoint` requests model-maintained notes before `compact_memory` saves
state and queues Pi compaction after the turn ends (avoiding an aborted tool turn). Summaries retain source references, not a lossless
copy of conversation. Routine decision guidance consults memory and records provenance;
contextual human dialogs show recommendations alongside the original exact question.
Their result includes the recorded human answer for memory updates; compaction reports
success or failure through Pi notifications.
Tests in `test/supervisor.test.js` cover fresh-session recovery, stale writes, path and
size limits, contextual question identity, human receipts and the compaction prerequisite.

Native/manual, threshold and overflow compaction share a `session_before_compact`
hook using Pi's standard summarizer and a deterministic recovery footer. Structured
state keeps supervisor transcript paths plus last-observed agent/session/decision
references. Tests cover all trigger reasons, preserved user instructions, authentication
failure, terminal-event acknowledgement before unwatching, missing tasks and transient
connection failures. Final-event handling precedes watch removal; retained notes and
references remain available after removal.

Task lifecycle actions reuse runtime cancel/resume/recover with durable retry inputs.
Resume selects only the coordinator and restores its watch; cancel retains worktrees.
Recovery requires explicit outcome/evidence and an exact operation snapshot, rechecked
inside the runtime's serialized recovery operation. No worker selection or new delivery
approval path is exposed. Runtime integration tests cover lost-response retries across
supervisor sessions, stale operation identity, retained work and terminal-task rejection.
