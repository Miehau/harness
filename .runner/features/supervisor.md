# Supervisor sessions

`runner/supervisor-extension.js` connects an ordinary, trusted Pi session to the
existing owner API. `agent-plan supervisor` launches it with Pi provider/model
arguments. Watches and acknowledged event IDs live in Pi session entries.

Coordinator questions and result references arrive as follow-up messages. The
model tool exposes inspect, artifact read and advisory feedback. The interactive
answer command confirms the exact question and answer before applying it.
Ordinary Pi shell access remains trusted owner access, not a security boundary.

Evidence: `test/supervisor.test.js` checks delivery, restart deduplication,
advice/answer separation, stale decisions and cancelled confirmation.
