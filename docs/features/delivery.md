# F11 — Delivery and tracker writeback

[Map](../feature-map.md) · [Navigation reference](../feature-navigation.md)

**Load when:** local integration, PR/MR creation, CI, remote feedback, merge, tracker completion.

## Behavior and boundaries

**Purpose:** For tracker-backed work, reconcile with the remote target, push a ticket branch, create/reuse a GitHub PR or GitLab MR, inspect existing CI/reviews, correct actionable feedback and squash merge. Local-source runs integrate via a per-repository serialized queue. No-change runs complete without a merge. Tracker completion follows delivery; safe local fast-forward may follow remote merge.

**Strength:** Forge adapters expose a compact shared contract. Local synchronization refuses to reconcile user changes. Uncertain remote creation/merge recovery is surfaced rather than guessed.

**Limit:** Forge credentials and existing repository policy determine whether delivery can proceed. This is not a deployment system. Local-source integration is intentionally a distinct path from tracker-backed PR/MR delivery.

Evidence: [delivery.js](../../src/delivery.js), [merge-queue.js](../../src/merge-queue.js), delivery functions in [server.js](../../src/server.js), [delivery tests](../../test/delivery.test.js), [automation e2e tests](../../test/e2e-automation.test.js).

## Find the implementation

Read only this feature’s UI/API/CLI/source/test row from the repository root:

```sh
rg -n '^\| \*\*F11\*\*' docs/feature-navigation.md
```

Follow its named symbols into source, then read callers and the focused tests. Load the navigation guide’s fixture recipes only when exercising a journey.

## Follow only relevant edges

- For approval before delivery, read [F10 — Final proof gate](final-proof.md).
- For uncertain or interrupted delivery, read [F12 — Recovery and process cleanup](recovery.md).
- For tracker adapter behavior, read [F02 — Ticket intake](intake.md).

Snapshot: 2026-09-06, `9703dde` plus uncommitted work. [Audit evidence and provenance](audit.md) are optional; verify current source before relying on historical findings.
