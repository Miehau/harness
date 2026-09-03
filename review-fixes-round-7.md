# Review fixes — round 7

- Steering now requires positive, localized correspondence with one approved step source (requirements, context, capabilities, or deltas). A loose collection of matching words across unrelated approved text cannot authorize a new capability.
- Regression coverage withholds the SQLite/storage and report-download examples unless their behavior is explicitly approved, including a data-driven mixed-capability counterexample.
- Worker-failure coverage verifies that a delivered steer and the persisted failed audit record share the durable logical attempt ID.

Checks were not run: `.agent-plan/project.json` exposes only the canonical `verify` command, which this stage explicitly prohibits running. The framework will run it after this report.
