# F15 — Local fixtures and developer helpers

[Map](../feature-map.md) · [Navigation reference](../feature-navigation.md)

**Load when:** navigation scripts, test selection, seeded states, zero-state fixtures.

## Behavior and boundaries

**Purpose:** Load prompt-free `feature.md` + `plan.json` fixtures into zero-state repositories and construct seeded daemon states for approval, review, recovery and empty-state journeys. Live helpers discover routes, tests and scenarios from source.

**Strength:** Fixtures reject authored runtime fields so harness versions can be compared against the same input. Tests use a mocked harness and reusable daemon helpers.

**Limit:** Seeded states are development evidence, not proof of a complete live provider journey. `src/camera-control.js` is an unrelated NVR helper and is outside this product map.

Evidence: [local.js](../../src/local.js), [scripts README](../../scripts/README.md), [test helpers](../../test/helpers.js), [local tests](../../test/local.test.js), [daemon e2e tests](../../test/e2e-daemon.test.js).

## Find the implementation

Read only this feature’s UI/API/CLI/source/test row from the repository root:

```sh
rg -n '^\| \*\*F15\*\*' docs/feature-navigation.md
```

Follow its named symbols into source, then read callers and the focused tests. Load the navigation guide’s fixture recipes only when exercising a journey.

## Follow only relevant edges

- For plan-approval fixture, read [F04 — Plans and budgets](plans.md).
- For review-ready fixture, read [F07 — Step review and proof](step-review.md).
- For proof-review fixture, read [F10 — Final proof gate](final-proof.md).
- For interrupted fixture, read [F12 — Recovery and process cleanup](recovery.md).

Snapshot: 2026-09-06, `9703dde` plus uncommitted work. [Audit evidence and provenance](audit.md) are optional; verify current source before relying on historical findings.
