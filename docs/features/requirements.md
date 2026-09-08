# F03 — Requirements, exploration and ticket look-ahead

[Map](../feature-map.md) · [Navigation reference](../feature-navigation.md)

**Load when:** clarification, repository-access approval, exploration, product context.

## Behavior and boundaries

**Purpose:** Separate product intent from repository access. Requirements drafts and product-context snapshots are retained; approval creates a worktree and runs code exploration alongside nearby-ticket look-ahead. Technical questions pause before design.

**Strength:** Explicit requirements approval prevents premature repository-driven interpretation. Separate artifacts make the transition from request to implementation inspectable.

**Limit:** There is more than one human gate in a normal journey. The living product-context document currently lives under the harness data directory, not in the target repository as the automation specification proposes.

Evidence: `prepareTicket`, `continueAfterRequirements`, `designTicket` in [server.js](../../src/server.js), [artifacts.js](../../src/artifacts.js), [Pi flow tests](../../test/pi-flow.test.js).

## Find the implementation

Read only this feature’s UI/API/CLI/source/test row from the repository root:

```sh
rg -n '^\| \*\*F03\*\*' docs/feature-navigation.md
```

Follow its named symbols into source, then read callers and the focused tests. Load the navigation guide’s fixture recipes only when exercising a journey.

## Follow only relevant edges

- For ticket input, read [F02 — Ticket intake](intake.md).
- For design output, read [F04 — Plans and budgets](plans.md).
- For workflow input gates, read [F05 — Pi and workflow gates](pi-workflows.md).

Snapshot: 2026-09-06, `9703dde` plus uncommitted work. [Audit evidence and provenance](audit.md) are optional; verify current source before relying on historical findings.
