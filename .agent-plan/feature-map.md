# Feature discovery

Start with the [feature index](../docs/feature-map.md), choose one leaf, then follow only its relevant source and navigation links. Keep existing stable feature IDs; do not load the whole map.

Directory owners: `src/` daemon, harness and proof lifecycle; `public/` dashboard; `scripts/` developer and browser helpers; `test/` regression tests; `.agent-plan/` verification and UI CLI contract; `docs/features/` feature explanations.

For UI work, read [UI journeys](features/ui-journeys.md). Run `node .agent-plan/ui.mjs --help` for commands and `node --test .agent-plan/ui.test.mjs` for a real isolated browser check. API/operator commands remain documented in the feature navigation guide; UI evidence must exercise the browser.

When a feature changes, update its leaf, affected navigation commands, assertions and browser tests. Extend only the relevant journey. The verification reviewer checks the map and commands against the implementation.
