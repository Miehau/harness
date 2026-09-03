# Review fixes — round 10

- Cleanup trigger merging now keys the complete durable trigger entry, including `at`, so repeated timeout or lifecycle events remain separately auditable while exact evidence redelivery is collapsed.
- Repository checks mark the shared containment immediately before invoking their runner. A settled preview/timeout cleanup therefore cannot suppress the later worker-exit cleanup cycle for check-owned descendants.
- Added a regression that settles containment, runs a repository check which leaves a token-owned process, and verifies the fresh cycle discovers and signals that process.

## Checks

Not run: `.agent-plan/project.json` exposes only the canonical `verify` command, which this stage explicitly prohibits workers from running. No focused test command is declared.
