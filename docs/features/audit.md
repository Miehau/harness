# Audit findings and provenance

[Map](../feature-map.md)

**Load when:** prioritizing fixes, checking historical findings, or interpreting snapshot confidence. This is a dated audit, not the feature lookup path.

Historical validation: 415 tests passed, 6 Linux-only process tests skipped on macOS, zero failures; syntax checks passed. These results belong to the original audit and are not a fresh product test run.


The [interactive review](../feature-review.html) contains evidence, source lines, proposed checks, and a selectable next-step brief. It reports six prioritized defects separately from improvements and strengths:

| Review ID | Feature | Finding and evidence |
|---|---|---|
| B01 / P1 | F01 | Default unauthenticated API accepts a foreign-Origin mutation. Reproduced with an isolated request; browser delivery still depends on local-network protections. |
| B02 / P1 | F11 | Merge requests omit the expected checked head SHA. Reproduced as an adapter-payload omission; no real remote merge attempted. |
| B06 / P2 | F11–F12 | PR/MR identity is saved after tracker commenting, so a tracker error can lose successful creation state. Source-traced failure ordering. |
| B03 / P2 | F07–F10, F14 | CLI corrections and queued UI note rewrites omit required criterion IDs. Source-confirmed client/server mismatch. |
| B04 / P2 | F04, F14 | Edit graph JSON → Close attempts a save and can show a bootstrap-scope validation error. Reproduced in the isolated mock dashboard. |
| B05 / P2 | F04, F06 | Generated dependency cycles pass normalization but have no runnable batch. Reproduced normalizer/scheduler check; edited graphs reject the same cycle. |

The following C01–C04 items preserve mapping-specific leads. C01 corresponds to reproduced B05; the rest are source observations or questions requiring additional validation. Keep them distinct from deliberate boundaries above.

| ID | Feature | Finding | Smallest useful next step |
|---|---|---|---|
| C01 | F04 | Generated plans use `normalizePlan`, which drops unknown/self edges and does not reject multi-step cycles; edited plans use stricter `normalizeEditedPlan`. A malformed model graph can change dependency intent or leave no runnable work. | Route both inputs through shared strict graph validation and add one malformed-generated-plan regression. |
| C02 | F02 | Intake stops at 100 tickets and comments also have bounded fetches. Older eligible tasks or later answers can be invisible. | Document the limit; add provider pagination with a two-page adapter test when the actual backlog requires it. |
| C03 | F02 | Jira `priority.id` is used as a numeric priority rank, but it is an identifier. Reordering custom priorities may make cross-provider admission order wrong. | Preserve explicit semantic rank or provider ordering; confirm expected priority policy. |
| C04 | F09 | Ticket/run-bound media validation does not establish capture-to-file mapping, desktop/mobile coverage or exact-tree freshness. | Define the minimum evidence contract, then test substituted or stale media before expanding implementation. |

Product decisions to resolve separately: whether blocked tickets should remain visible; whether automatic pickup needs capacity control; whether the 12-round cap is desired; whether product context belongs in the target repository; whether scopes remain hard-enforced; whether separate initialization tickets are still a requirement. These disagreements should not trigger broad rewrites without choosing the intended behavior.

## Snapshot provenance and maintenance

At inspection start, existing modified paths were `.agent-plan/capture-proof-dashboard.mjs`, `.agent-plan/verify.mjs`, `src/pi-harness.js`, `src/server.js`, `test/e2e-proof.test.js`, `test/pi-harness.test.js`, and `test/server.test.js`. Existing untracked paths were `bun.lock`, `scripts/capture-ticket-proof.mjs`, `src/visual-evidence.js`, and `test/visual-evidence.test.js`. This map includes their observed content and does not imply those changes are reviewed, committed, or released.

When updating this map, keep feature IDs stable, regenerate the helper inventories, follow actual callers through the daemon and harness, and update [feature-navigation.md](../feature-navigation.md) separately. Prefer source/test symbols over brittle line numbers. Record source-only findings as such; do not turn planned specification text into claims of implemented behavior.
