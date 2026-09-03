# Review fixes — round 14

## Lifecycle trigger durability

`persistContainment` now writes the lifecycle entry supplied by its caller rather than selecting a similarly shaped entry from shared containment evidence. Exact trigger records, including `at`, are merged by the existing durable cleanup deduplication, so concurrent identical lifecycle requests remain individually auditable.

## Preview and capture ownership

Preview-server spawning and each Chromium capture invocation now call `beginLaunch()` immediately before launching. A cleanup cycle that previously settled is therefore followed by a fresh cycle which discovers token-owned preview or capture processes.

## Regression coverage

- Added a deterministic cleanup-record test for timestamp-distinct otherwise-identical lifecycle triggers.
- Added a preview-manager regression that settles containment, launches a preview plus two captures, then verifies the fresh cleanup cycle discovers and signals the owned target.

## Checks

Focused tests were not run: `.agent-plan/project.json` exposes only the canonical `verify` command, which this step explicitly forbids running. Attempts to use the required helper command names through `project_command` were rejected because `nav`, `test-map`, and `seed-list` are not declared project commands.
