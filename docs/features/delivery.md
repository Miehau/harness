# F11 — Delivery and tracker writeback

[Map](../feature-map.md) · [Navigation reference](../feature-navigation.md)

**Load when:** local integration, PR/MR creation, CI, remote feedback, merge, tracker completion.

## Behavior and boundaries

**Purpose:** For tracker-backed work, reconcile with the remote target, push a ticket branch, create/reuse a GitHub PR or GitLab MR, inspect existing CI/reviews, correct actionable feedback and squash merge. Local-source runs integrate via a per-repository serialized queue. No-change runs complete without a merge. Tracker completion follows delivery; safe local fast-forward may follow remote merge.

After final proof approval, each changed writable Git repository is delivered independently (`run.deliveries`: branch, checks, PR/MR or local integrate, remote change id, status). The ticket completes only when every required Git repo has finished. Resume retries unfinished repos without replaying a succeeded PR or local integrate. Partial failure is classified by `displayPath`. Read-only Git extras, non-Git roots, and Any-access writes outside configured read/write Git roots never auto-deliver. Primary-only projects still use one merge/integration record.

**Strength:** Forge adapters expose a compact shared contract. Local synchronization refuses to reconcile user changes. Uncertain remote creation/merge recovery is surfaced rather than guessed.

**Limit:** Forge credentials and existing repository policy determine whether delivery can proceed. This is not a deployment system. Local-source integration is intentionally a distinct path from tracker-backed PR/MR delivery.

Evidence: [delivery.js](../../src/delivery.js) (`changedGitDeliveryRepos`, `upsertDeliveryRecord`), [merge-queue.js](../../src/merge-queue.js), `scheduleAllDeliveries` in [delivery-runner.js](../../src/delivery-runner.js), [delivery tests](../../test/delivery.test.js), [automation e2e tests](../../test/e2e-automation.test.js), [multi-repo flow](../../test/multi-repo-flow.test.js).

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

GitHub inline comments request agent correction only when they begin with `fix:` (case-insensitive, leading whitespace allowed). Other inline comments are informational; blocking reviews still prevent merge. GitLab feedback is unchanged. Squash merges bind to the inspected remote head SHA; a changed-head rejection triggers fresh CI and review inspection.

After successful remote delivery of every required repository, the daemon removes run-owned local worktrees, branches, evidence and session bodies. It retains the completion record, PR/MR links and `retentionCleanup` audit. Cleanup failures do not undo a successful delivery and retry at daemon restart. Set `AGENT_PLAN_KEEP_MERGED_RUNS=1` before completion to retain new merged runs for debugging. Existing historical runs are not retroactively selected. `agent-plan retention list` previews disk usage; `agent-plan retention cleanup <ticketId...>` uses the dashboard cleanup endpoint to remove named inactive runs.
