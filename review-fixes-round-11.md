# Review fixes — round 11

- Durable cleanup trigger entries now retain complete object payloads (including `command`) and their supplied timestamp. Exact reported redelivery is structurally deduplicated without collapsing timestamp-distinct lifecycle events.
- Daemon persistence normalizes each lifecycle trigger once and reuses the matching containment-record timestamp, preventing commandless daemon entries from duplicating command-bearing containment evidence.
- Follow-up containment cycles for launches recorded during cleanup are promise-chained after the active cycle, with a cycle-local deadline. Added a regression that proves the later cycle does not start discovery until the first cycle settles.

## Checks

Not run: `.agent-plan/project.json` exposes only the canonical `verify` command, which this stage explicitly prohibits workers from running. No focused test or syntax command is declared.

Helper command discovery attempts failed independently because the project configuration has no `nav`, `test-map`, or `seed-list` commands (`Unknown project command “nav”; add it to .agent-plan/project.json`).
