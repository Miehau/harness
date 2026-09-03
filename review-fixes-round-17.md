# Review fixes — round 17

- The Chromium timeout fixture now polls for its completion marker with a bounded deadline, so the assertion waits for managed-process settlement instead of relying on scheduler timing.
- Preview teardown retains `stopping` while its bounded containment wait is unresolved and records pending-cleanup diagnostics. The late settlement callback remains responsible for replacing this provisional evidence with the terminal cleanup result.
- Regression coverage exercises a fresh restart whose preview cleanup exceeds the lifecycle bound.

Checks were not run: `.agent-plan/project.json` exposes only the canonical `verify` command, which this step explicitly prohibits running. The requested helper commands are not registered (`nav`, `test-map`, and `seed-list`).
