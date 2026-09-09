# Harness architecture refactor

The harness remains one local Node process with Pi as its agent runtime and a
JSON store. The refactor preserves the repository UI, design-system,
verification, and visual-proof contracts, existing approval settings, and
multi-repository delivery.

## Ownership

| Module | Owns |
| --- | --- |
| `server.js` | Dependency construction, HTTP startup, polling startup, shutdown |
| `routes.js` | Request parsing, operation invocation, response formatting |
| `operator-services.js` | Workspace, profiles, tracker settings, and retention operations |
| `ticket-runner.js` | Phase progression and start/resume/pause/cancel/restart dispatch |
| `planning.js` | Requirements, exploration, design, and planning checkpoints |
| `step-runner.js` | Worker attempts, step verification/correction, and acceptance |
| `final-review.js` | Combined verification, correction, and final proof review |
| `delivery-runner.js` | Per-repository delivery, external-action recovery, and partial completion |
| `run-runtime.js` | Live promises, abort controllers, containment ownership, and steering timers |
| `preview-orchestration.js` | Preview lifecycle, live capture identity, and combined repository checks |
| `execution.js` | Durable lifecycle and attempt operations |
| `run-status.js` | Shared status definitions and stage transitions |
| `steering.js` | Correction ledger, FIFO delivery, and operator steering commands |
| `activity.js` | Bounded activity capture and streaming |
| `review-findings.js` | Finding history, recurrence, and correction progress |
| `inspection.js` | Public state and run projections, inspection records |
| `proof-revision.js` | Repository tree and non-Git content identity for final proof |
| `repository-checks.js` | Deterministic commands and evidence validation |
| `pi-harness.js` | Pi session creation, invocation, steering, and disposal |
| `pi-tools.js` | Pi tool definitions and scoped operations |
| `pi-prompts.js` | Prompt construction and agent instructions |

These modules contain the implementation for their listed responsibilities.
The server composes their state and I/O dependencies; shared pure helpers are
imported directly from their owning modules.

## Phase boundaries

The ticket runner decides which phase runs next. Planning, step execution,
final review, and delivery receive explicit dependencies and return outcomes.
Final review can produce a pending visual approval or a result ready for
delivery. It does not start delivery itself. Delivery owns focused recovery of
its own failures, including rechecking corrected code.

Modules must not receive the entire daemon as a context object. A collection
of callbacks exposing every daemon function has the same coupling problem.
Keep external I/O outside durable state mutations. Preserve direct function
calls and existing adapters rather than adding an event bus, workflow engine,
or provider abstraction.

## State and asynchronous work

`JsonStore.update` mutates a private draft, saves it, and only then replaces
the live state. A failed mutation or save leaves both the published revision
and subsequent updates based on the last successful state.

Use concrete lifecycle operations to update related attempt, step, checkpoint,
and run records together. Preserve stored formats during extraction. Display
projections may derive status from those records, but live runtime handles are
never the durable source of truth.

Ticket run IDs, worker execution IDs, and attempt IDs are distinct. Session
callbacks, activity writes, and phase results must verify their owning
identity before changing state. A late result must not overwrite a replacement
run or attempt, or cause a later phase to start. Cancellation still settles
and records process cleanup for the execution that actually owned it.

## Proof and delivery

Checks, visual evidence, and approval identify the repository revisions they
cover. Multi-repository work needs the corresponding revision for each
repository. Changes invalidate affected proof before it can authorize
delivery. Keep immutable attempt and review evidence available after restart.

New final proof records bind to Git tree identities and non-Git content hashes.
Legacy records without revision metadata remain readable; versioned records
with missing or stale snapshots require fresh verification.

Each repository retains its own delivery result and any uncertain external
action. If A is delivered and B fails, recovery resumes B while retaining A's
success. Retrying evidence publication must not implicitly re-run workers or
discard approved proof. Reconciliation that changes code must use the
existing verification and proof gates.

## Validation

Completed-tree validation on 2026-09-09: 641 tests, 635 passed, six skipped,
zero failures. Source syntax checks passed. All 58 routes, 23 CLI commands,
six stages, and the UI inventory match the pre-refactor baseline. Local
imports have no cycles, and the server has no unreachable local helpers.

Run the source-driven helpers after moving code:

```sh
node scripts/nav.mjs --json
node scripts/test.mjs --map
node scripts/seed.mjs --list
node scripts/test.mjs
node scripts/test.mjs --check
```

Compare route and stage inventories with the baseline. Update the discovery
helper when sources move, retaining meaningful helper tests. Avoid local
module import cycles.

Behavioral evidence must include rejected state updates, valid and stale
session callbacks, cancellation and restart, active steering, final visual
approval, and partial multi-repository delivery recovery. Use existing
daemon helpers and mock harnesses; no test should invoke a real model.

## Migration order

1. Fix store atomicity with a focused regression.
2. Extract repository checks, Pi tools/prompts, activity, and projections.
3. Extract per-repository delivery and its recovery.
4. Extract final review, step execution, and planning around explicit outcomes.
5. Finish ticket coordination and routes; consolidate lifecycle updates.

Validate each coherent change and run the full suite on the completed tree.
Do not weaken approval, access, or evidence contracts to make extraction
easier.
