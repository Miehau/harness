# Supervisor sessions

`runner/supervisor-extension.js` connects an ordinary, trusted Pi session to the
existing owner API. `agent-plan supervisor` launches it with Pi provider/model
arguments. Watches and acknowledged event IDs live in Pi session entries.

Coordinator questions and result references arrive as follow-up messages. The
model tool exposes start (submit, launch and auto-watch), watch, inspect, artifact
read, advisory feedback and routine coordinator answers. Start uses a stable requestId for submission and launch
receipts, persists its watch before launching, and returns a compact task identity.
The coordinator owns worker delegation; no per-worker subscriptions are needed. The interactive
answer command confirms the exact question and answer before applying it.
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
