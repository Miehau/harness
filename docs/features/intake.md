# F02 — Tracker intake, free-text tasks and admission

[Map](../feature-map.md) · [Navigation reference](../feature-navigation.md)

**Load when:** missing tickets, dependencies, priority, free-text tasks, automatic pickup.

## Behavior and boundaries

**Purpose:** Combine Linear and Jira tickets with local free-text tasks. Provider adapters remove tickets with unresolved explicit blockers; automatic admission then selects unstarted, non-backlog-like tickets, orders by numeric priority and intake order, and begins requirements shaping. Manual selection and multi-start are also exposed.

**Strength:** A failing provider does not hide a healthy provider's results. Automatic mode is opt-in. Tracker questions and lifecycle changes share the same adapter boundary.

Conversational intake through `orchestrator submit` creates a structured draft without model calls. Workspace-scoped idempotency survives restart; conflicting reuse is rejected. Dependency completion and the original workspace are checked when starting through either dashboard or CLI. See [the local contract](../orchestrator-contract.md).

**Limit:** Blocked tickets disappear from intake rather than remaining visible with blocker explanations. Linear and Jira intake fetch at most 100 issues per request and do not paginate. Jira intake is restricted to children of the configured epic, despite some project-oriented wording in the README. Automatic admission begins all eligible candidates; no explicit admission concurrency limit appears in that loop.

Evidence: [linear.js](../../src/linear.js), [jira.js](../../src/jira.js), [admission.js](../../src/admission.js), [trackers.js](../../src/trackers.js), `admitAutomaticTickets` in [server.js](../../src/server.js), [admission tests](../../test/admission.test.js).

**Runtime caveat:** `GET /api/tickets` (including CLI `list backlog`) can admit work when automatic intake is enabled. Use an isolated fixture for exploratory requests.

## Find the implementation

Read only this feature’s UI/API/CLI/source/test row from the repository root:

```sh
rg -n '^\| \*\*F02\*\*' docs/feature-navigation.md
```

Follow its named symbols into source, then read callers and the focused tests. Load the navigation guide’s fixture recipes only when exercising a journey.

## Follow only relevant edges

- For provider credentials, read [F01 — Setup and credentials](setup.md).
- For what happens after admission, read [F03 — Requirements and exploration](requirements.md).
- For queue presentation or CLI lists, read [F14 — Dashboard, CLI and events](interfaces.md).

Snapshot: 2026-09-06, `9703dde` plus uncommitted work. [Audit evidence and provenance](audit.md) are optional; verify current source before relying on historical findings.
