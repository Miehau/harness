# F07 — Step review, exact diffs and criterion proof

[Map](../feature-map.md) · [Navigation reference](../feature-navigation.md)

**Load when:** exact diffs, criterion evidence, review notes, accepting or revising a step.

## Behavior and boundaries

**Purpose:** Link approved acceptance criteria to canonical checks, artifacts, media or exact diffs. Inspector views retain attempts and output, lazy hunk expansion, review maps and notes; operators accept, request revision, expand scope or waive a stopped verifier finding with an audit trail.

**Strength:** Evidence locators resolve to stored step/attempt/review records. Corrections invalidate affected proof; old attempts remain inspectable. Review notes stay out of the product diff.

**Limit:** A waiver does not accept a step. Legacy runs can use a compatibility projection, so agents must distinguish old runs from newly initialized proof maps. Empty or incorrect acceptance criteria cannot be made meaningful by UI presentation alone.

Evidence: [proof-map.js](../../src/proof-map.js), [review-packet.js](../../src/review-packet.js), [ui-model.js](../../public/ui-model.js), [criterion proof flow tests](../../test/criterion-proof-flow.test.js), [proof restart tests](../../test/proof-restarts.test.js).

## Find the implementation

Read only this feature’s UI/API/CLI/source/test row from the repository root:

```sh
rg -n '^\| \*\*F07\*\*' docs/feature-navigation.md
```

Follow its named symbols into source, then read callers and the focused tests. Load the navigation guide’s fixture recipes only when exercising a journey.

Before invoking corrections, load the [correction payload caveat](../feature-navigation.md#correction-payloads):

```sh
rg -n -A4 '^### Correction payloads' docs/feature-navigation.md
```

## Follow only relevant edges

- For the work being reviewed, read [F06 — Execution and VCS](execution.md).
- For correction execution, read [F08 — Verification and corrections](verification.md).
- For final rather than step approval, read [F10 — Final proof gate](final-proof.md).
- For review UI or CLI actions, read [F14 — Dashboard, CLI and events](interfaces.md).

Snapshot: 2026-09-06, `9703dde` plus uncommitted work. [Audit evidence and provenance](audit.md) are optional; verify current source before relying on historical findings.
