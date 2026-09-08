# F10 — Final proof approval

[Map](../feature-map.md) · [Navigation reference](../feature-navigation.md)

**Load when:** Approve & deliver, final criteria, final proof changes, auto-mode approval.

## Behavior and boundaries

**Purpose:** Present combined checks, criteria and media before local integration or remote delivery. Approve resumes handoff; concrete requested changes invalidate proof and trigger another correction pass.

**Strength:** Automatic step execution never bypasses this human gate. Proof eligibility and required media are enforced server-side, rather than only by disabled UI buttons.

**Limit:** Approval applies before delivery reconciliation; the implementation reruns checks during integration, but agents should inspect any new resulting evidence rather than assume the original packet describes every later tree.

Evidence: `completeCleanReview`, `finishHandoff` and evidence routes in [server.js](../../src/server.js), [server proof-gate tests](../../test/server.test.js), [proof e2e tests](../../test/e2e-proof.test.js).

## Find the implementation

Read only this feature’s UI/API/CLI/source/test row from the repository root:

```sh
rg -n '^\| \*\*F10\*\*' docs/feature-navigation.md
```

Follow its named symbols into source, then read callers and the focused tests. Load the navigation guide’s fixture recipes only when exercising a journey.

Before invoking corrections, load the [correction payload caveat](../feature-navigation.md#correction-payloads):

```sh
rg -n -A4 '^### Correction payloads' docs/feature-navigation.md
```

## Follow only relevant edges

- For criterion eligibility, read [F07 — Step review and proof](step-review.md).
- For requested fixes, read [F08 — Verification and corrections](verification.md).
- For media requirements, read [F09 — Previews and visual evidence](visual-evidence.md).
- For delivery after approval, read [F11 — Delivery and tracker writeback](delivery.md).

Snapshot: 2026-09-06, `9703dde` plus uncommitted work. [Audit evidence and provenance](audit.md) are optional; verify current source before relying on historical findings.
