# Review fixes — round 9

- In-scope paths now constrain *where* an approved correction may occur but cannot alone authorize delivery. Ordinary steering requires at least one substantive term with positive correspondence to a single approved step source.
- Directive-only and pronoun-only requests that name `src/steering.js` are withheld as `ambiguous_instruction`, retaining the normal `needs_input` checkpoint rather than being sent to Pi.
- Added unit and API regressions for `Update src/steering.js safely.` and `Delete it in src/steering.js.`; API coverage confirms neither produces Pi delivery.

Checks were not run: `.agent-plan/project.json` exposes only the canonical `verify` command, which this stage explicitly prohibits running. The required helper commands (`nav`, `test-map`, and `seed-list`) are not declared project commands and could not be run. The framework will run verification after this report.
