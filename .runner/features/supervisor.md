# Supervisor sessions

`runner/supervisor-extension.js` connects an ordinary, trusted Pi session to the
existing owner API. `agent-plan supervisor` launches it with Pi provider/model
arguments. Watches and acknowledged event IDs live in Pi session entries.

Coordinator questions and result references arrive as follow-up messages. The
model tool exposes start (submit, launch and auto-watch), watch, inspect, artifact
read and advisory feedback. Start uses a stable requestId for submission and launch
receipts, persists its watch before launching, and returns a compact task identity.
The coordinator owns worker delegation; no per-worker subscriptions are needed. The interactive
answer command confirms the exact question and answer before applying it.
Ordinary Pi shell access remains trusted owner access, not a security boundary.

Evidence: `test/supervisor.test.js` checks delivery, restart deduplication,
advice/answer separation, stale decisions and cancelled confirmation.

UI completion events include evidence manifest/media references; video reads return
metadata/localPath rather than unsupported image blocks. See [UI evidence](ui-evidence.md).

The supervisor-start case in `test/runner.test.js` exercises real runtime intake,
mocked launches, lost-response retries, session restoration and coordinator questions.
