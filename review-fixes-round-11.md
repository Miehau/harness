# Review fixes — round 11

- Steering delivery now requires at least two substantive behavior terms localized to one explicit behavioral source (description, product context, acceptance criterion, requirement, capability, or delta). Step titles and IDs cannot authorize delivery, so `Update ledger safely.` is withheld rather than inferred from `Update steering ledger`.
- Approved behavior is protected by default: a destructive or polarity-changing steer must have a localized destructive approval for that same behavior. This withholds FIFO removal, disablement, and withdrawal without Pi delivery, while retaining an explicitly approved removal path.
- Added unit counterexamples plus API regressions verifying generic title overlap and FIFO removal create `needs_input` checkpoints without calling Pi.

Checks were not run: `.agent-plan/project.json` exposes only the canonical `verify` command, which this step explicitly prohibits workers from running. Required helper commands were also unavailable as declared project commands: `nav`, `test-map`, and `seed-list` each returned `Unknown project command`; the framework will run verification after this report.
