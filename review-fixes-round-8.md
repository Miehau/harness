# Review fixes — round 8

- The worker-failure delivery regression now starts resume asynchronously, waits for the mocked worker session, submits and releases steering, then awaits the saved resume response. This removes the test-only request/worker deadlock.
- Ordinary steering now requires either substantive correspondence with one approved step source or an explicit approved file target. Directive-only requests without either are withheld as `ambiguous_instruction`, rather than inferred as approved from an empty correspondence set.
- Added unit data-driven coverage for bare directive/pronoun requests and API coverage that confirms `Remove it safely.` creates a `needs_input` checkpoint without calling Pi.

Checks were not run: `.agent-plan/project.json` exposes only the canonical `verify` command, which this stage explicitly prohibits running. The framework will run it after this report.
