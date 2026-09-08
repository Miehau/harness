# F14 — Dashboard, CLI and observability

[Map](../feature-map.md) · [Navigation reference](../feature-navigation.md)

**Load when:** ticket selection, inspector tabs, live events, activity, operator commands.

## Behavior and boundaries

**Purpose:** Navigate urgency-grouped tickets, stage/step graph and inspector; inspect prompts, activity, diffs, evidence, cleanup, elapsed time and model/tool usage. SSE streams update the UI. The JSON operator CLI drives the same HTTP actions and exposes status, lists, selection, wait, approvals and recovery.

**Strength:** API and UI actions share a daemon path; compact summaries avoid shipping artifact bodies with every update. CLI automation can reproduce UI actions without mutating state files directly.

**Limit:** Numerous gates and inspector modes create operator complexity. The main UI and daemon files remain large; helper maps and focused UI-model functions are essential navigation aids. Pure UI-model tests do not establish full browser interaction coverage.

Evidence: [app.js](../../public/app.js), [ui-model.js](../../public/ui-model.js), [cli.js](../../src/cli.js), [CLI tests](../../test/cli.test.js), [UI model tests](../../test/ui-model.test.js).

**Runtime caveat:** `GET /api/tickets` (including CLI `list backlog`) can admit work when automatic intake is enabled. Use an isolated fixture for exploratory requests.

## Find the implementation

Read only this feature’s UI/API/CLI/source/test row from the repository root:

```sh
rg -n '^\| \*\*F14\*\*' docs/feature-navigation.md
```

Follow its named symbols into source, then read callers and the focused tests. Load the navigation guide’s fixture recipes only when exercising a journey.

Before invoking corrections, load the [correction payload caveat](../feature-navigation.md#correction-payloads):

```sh
rg -n -A4 '^### Correction payloads' docs/feature-navigation.md
```

## Follow only relevant edges

- For step review actions, read [F07 — Step review and proof](step-review.md).
- For final proof actions, read [F10 — Final proof gate](final-proof.md).
- For recovery controls, read [F12 — Recovery and process cleanup](recovery.md).
- For safe UI fixtures, read [F15 — Fixtures and helpers](developer-tools.md).

Snapshot: 2026-09-06, `9703dde` plus uncommitted work. [Audit evidence and provenance](audit.md) are optional; verify current source before relying on historical findings.
