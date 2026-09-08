# F12 — Pause, recovery, restarts and process cleanup

[Map](../feature-map.md) · [Navigation reference](../feature-navigation.md)

**Load when:** pause, cancel, resume, rewind, fresh restart, process ownership.

## Behavior and boundaries

**Purpose:** Persist checkpoints, pause/cancel owned work, recover in-flight statuses as interrupted, resume sessions deliberately, or restore recorded exploration/design/step/verification trees. Fresh restart archives the prior run. Process containment records ownership and cleanup outcomes.

**Strength:** Recovery is conservative around delivery and PID reuse. Restart audits preserve why/where work was rewound. Cleanup outcome records make incomplete cleanup visible.

**Limit:** A run that reached delivery cannot be automatically rewound. Platform process-containment capability differs, and interrupted processes cannot be assumed safely terminated without recorded evidence.

Evidence: [store.js](../../src/store.js), [daemon-lock.js](../../src/daemon-lock.js), [process-containment.js](../../src/process-containment.js), [process-tree.js](../../src/process-tree.js), [restart tests](../../test/restart.test.js), [process cleanup e2e tests](../../test/process-cleanup-e2e.test.js).

## Find the implementation

Read only this feature’s UI/API/CLI/source/test row from the repository root:

```sh
rg -n '^\| \*\*F12\*\*' docs/feature-navigation.md
```

Follow its named symbols into source, then read callers and the focused tests. Load the navigation guide’s fixture recipes only when exercising a journey.

## Follow only relevant edges

- For worktree or VCS checkpoints, read [F06 — Execution and VCS](execution.md).
- For remote-action uncertainty, read [F11 — Delivery and tracker writeback](delivery.md).
- For state persistence or retained resources, read [F13 — Storage and retention](storage.md).

Snapshot: 2026-09-06, `9703dde` plus uncommitted work. [Audit evidence and provenance](audit.md) are optional; verify current source before relying on historical findings.
