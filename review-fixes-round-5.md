# Final review fixes — round 5

- Containment now takes ownership snapshots after both graceful and force phases. Newly discovered token-owned identities receive their own bounded cleanup cycle; completion requires a post-force quiescent observation.
- If a required observation cannot run, cleanup remains `incomplete` with durable discovery diagnostics instead of reporting completion.
- The containment regression models a child created by graceful termination and asserts both phase snapshots for every discovered identity.
- Fresh-run restart documentation now reflects the run-ID-bound persistence path: bounded late preview cleanup is retained on its process-owning archived run.
- Linux fixture coverage is required by `.github/workflows/verify.yml`; unsupported hosts retain adapter-contract coverage. The repository-command timeout test imports and uses `readFile` for its descendant PID fixture.

## Checks

Not run: the harness permits only the `verify` project command, and the task explicitly prohibits running `node .agent-plan/verify.mjs`. Attempts to run the skill-prescribed `nav`, `test-map`, and `seed-list` commands were rejected because they are not declared in `.agent-plan/project.json`.
