# Review fixes — round 9

- Controlled project-command launches now mark their containment before spawn.
- A containment that was settled by a timed-out command runs one new bounded cleanup cycle when a later marked command has inherited the same ownership token; repeated lifecycle cleanup without another launch remains idempotent.
- Cleanup evidence retains immutable discoveries across those cycles.
- Added a regression test for a timeout cleanup, a later token-owned command, and worker completion; it verifies that both owned process identities are signaled and recorded.

## Checks

Not run: `.agent-plan/project.json` exposes only the canonical `verify` command, which this stage explicitly prohibits workers from running. No focused test command is declared.

Command discovery attempt failed independently: `project_command ??? ` returned `Unknown project command “??? ”; add it to .agent-plan/project.json`.
