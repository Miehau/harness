# GrokBot control

`agent-plan launch ALIAS BRIEF_FILE REQUEST_ID` is the unattended local entry point.
It accepts only a saved repository alias, reads the task from a file, reuses runtime
submission/start receipts, does not focus Herdr, and returns JSON. Stable request IDs
make identical retries return one task; changed input is rejected.

GrokBot owns scheduling and invokes the command on the harness host as the same OS
user and `RUNNER_DATA`. The runner deliberately has no remote control listener or
second scheduler. Existing webhooks return questions, problems and candidates.
Launch authority does not grant question-answering or candidate-acceptance authority.

Evidence: `test/runner.test.js` covers alias enforcement, single launch across retries,
changed-input rejection and noninteractive startup through the existing mocked runtime.
