# F04 — Editable execution plans and review budgets

[Map](../feature-map.md) · [Navigation reference](../feature-navigation.md)

**Load when:** graph generation or editing, dependencies, review size, plan approval.

## Behavior and boundaries

**Purpose:** Describe work as steps and one-level groups with dependencies, permissions, write scopes, expected files, acceptance criteria, context policy, artifacts, and visual requirements. Plan approval snapshots the proof map. JSON editing validates unknown dependencies, duplicate IDs and cycles.

**Strength:** Default review budgets of 8 files / 400 changed lines encourage coherent slices; justified atomic exceptions remain possible. Acceptance barriers prevent consumers from using unaccepted work.

**Limit:** Groups cannot nest. Write scopes are actively enforced and expansions need a stopped-step approval, unlike the specification's advisory-path model. Generated-plan normalization is more permissive than edited-plan validation; see [audit C01 / B05](audit.md).

Evidence: [plan.js](../../src/plan.js), [plan tests](../../test/plan.test.js), plan routes in [server.js](../../src/server.js).

## Find the implementation

Read only this feature’s UI/API/CLI/source/test row from the repository root:

```sh
rg -n '^\| \*\*F04\*\*' docs/feature-navigation.md
```

Follow its named symbols into source, then read callers and the focused tests. Load the navigation guide’s fixture recipes only when exercising a journey.

## Follow only relevant edges

- For requirements feeding the plan, read [F03 — Requirements and exploration](requirements.md).
- For scheduling an approved graph, read [F06 — Execution and VCS](execution.md).
- For criteria created at approval, read [F07 — Step review and proof](step-review.md).

Snapshot: 2026-09-06, `9703dde` plus uncommitted work. [Audit evidence and provenance](audit.md) are optional; verify current source before relying on historical findings.
