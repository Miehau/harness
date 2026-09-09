# Merge conflict resolution — MEA-63 onto origin/main

Rebase conflicts were resolved in the six listed files only. Ticket behavior (frozen directory access, extra roots, multi-repo worktrees/proof/delivery, `$evidenceRoot` capture) is preserved. Compatible target-branch steering and verify isolation are kept. The rebase was not aborted, restarted, or committed.

## Reconciled files

### `.agent-plan/project.json`
- Kept this ticket's harness visual command: `capture-proof` → `node scripts/capture-ticket-proof.mjs`.
- Kept origin/main named commands: `test-ui-model`, `test-steering-delivery`, `check`, `test-capture-proof` (`capture-steering-proof.mjs --preflight`).
- Shared commands (`verify`, `nav`, `ui`, `ui-test`, …) unchanged.

### `.agent-plan/features/ui-journeys.md`
- Combined inspector copy: steering form/history from origin/main plus Repository workspace/access-policy dialog and `setup.md` from the ticket.
- Combined capture copy: `$evidenceRoot` substitution and `capture-ticket-proof.mjs` from the ticket; empty live-ticket manifest when no visual ACs from origin/main.

### `.agent-plan/verify.mjs`
- Kept origin/main's extra env stripping so plain verify stays independent of capture identity (`AGENT_PLAN_CAPTURE_URL`, ticket/run ids, criteria) in addition to `AGENT_PLAN_EVIDENCE_DIR`.

### `scripts/capture-ticket-proof.mjs`
- Kept ticket `$evidenceRoot` fixture directory and substitution.
- Dropped HEAD's duplicate `mkdir(evidenceDir)` / `ticketIdentity` (already done earlier after origin/main's empty-criteria early return).

### `src/pi-harness.js`
- Kept origin/main `steeringSessionKey` / `steer` and runStep steering callbacks (`onSessionActive`, `onSessionInactive`, `onSteering`, `attemptId`).
- Kept ticket `access` and `repositories` on `runStep` so file tools still wrap the frozen policy.

### `src/server.js`
- `runContainedWorker` now forwards both `attemptId` (destructured out of `...input`) and frozen `access` / `repositories` fallbacks.
- After a worker returns: acknowledge steering ids from origin/main, then snapshot/diff all frozen Git trees from the ticket (including per-repo check status).
- Steering checkpoint still returns before rollback so parked worker trees are not wiped; runaway restore uses `restoreRepositoryTrees` (all frozen Git roots) instead of primary-only `restoreTree`. Checkpoint persist also records `repositoryVcs` / `repositoryDiffs`.

## Invariants
- File tools and worktrees still read only `run.access` / `run.repositories`; settings edits never enlarge a live freeze.
- Steering binds to an attempt id and does not replace directory-policy enforcement.
- `capture-proof` remains this ticket's UI journey runner; steering preflight stays a separate named command.
- Named commands are still argv/env allow-lists, not a filesystem sandbox.

## Remaining limitation
`test/verification-contract.test.js` was auto-merged outside this write scope and currently asserts `capture-proof` twice (ticket script and steering script). That file was not in the conflict list and was not edited. Focused syntax/steering checks below do not execute that contract test.

## Focused checks
- `check` (`node scripts/test.mjs --check`): passed
- `test-steering-delivery`: 5 passed (queue/ack, unsafe needs-input checkpoint, durable attempt audit, terminal claim failure, FIFO drain)
Canonical `node .agent-plan/verify.mjs` is left for the harness.
