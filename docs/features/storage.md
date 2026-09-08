# F13 — Artifacts, persistence and retention

[Map](../feature-map.md) · [Navigation reference](../feature-navigation.md)

**Load when:** JSON persistence, artifact bodies, disk use, forgetting runs, cleanup.

## Behavior and boundaries

**Purpose:** Persist run state as serialized atomic JSON writes, store artifact bodies separately, serve media lazily, retain completed worktrees/branches indefinitely, and offer disk inventory plus explicit cleanup by run/ticket/project/age.

**Strength:** A single-daemon lock and queued writes fit the local product without a database service. Storage cleanup is visible and preserves remote resources.

**Limit:** Indefinite retention grows disk use until operators clean it. Artifact retention and bounded live-activity buffers are different promises; complete raw session traces should not be confused with the compact dashboard projection.

Evidence: [store.js](../../src/store.js), [artifacts.js](../../src/artifacts.js), [retention.js](../../src/retention.js), [retention tests](../../test/retention.test.js), [artifact tests](../../test/artifacts.test.js).

## Find the implementation

Read only this feature’s UI/API/CLI/source/test row from the repository root:

```sh
rg -n '^\| \*\*F13\*\*' docs/feature-navigation.md
```

Follow its named symbols into source, then read callers and the focused tests. Load the navigation guide’s fixture recipes only when exercising a journey.

## Follow only relevant edges

- For interrupted state or processes, read [F12 — Recovery and process cleanup](recovery.md).
- For media artifacts, read [F09 — Previews and visual evidence](visual-evidence.md).
- For storage dialog or artifact inspector, read [F14 — Dashboard, CLI and events](interfaces.md).

Snapshot: 2026-09-06, `9703dde` plus uncommitted work. [Audit evidence and provenance](audit.md) are optional; verify current source before relying on historical findings.
