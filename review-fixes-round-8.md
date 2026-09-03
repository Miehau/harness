# Review fixes — round 8

- Deduplicated repeated incomplete cleanup evidence for a single execution while preserving its pessimistic outcome and distinct late observations.
- Process identities use `pid`/`ppid`/`startTime`; actions, unresolved entries, and diagnostics use stable value keys.
- Added a regression test covering timeout settlement followed by worker-exit settlement with both repeated and late evidence.

## Checks

Not run: `.agent-plan/project.json` exposes only the canonical `verify` command, which this stage explicitly prohibits workers from running.

The required helper-command discovery attempts could not run because they are not declared project commands:

- `nav`: `Unknown project command “nav”; add it to .agent-plan/project.json`
- `test-map`: `Unknown project command “test-map”; add it to .agent-plan/project.json`
- `seed-list`: `Unknown project command “seed-list”; add it to .agent-plan/project.json`
