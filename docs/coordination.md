# Worker coordination

The daemon owns scheduling, dependencies, permissions and acceptance. Pi workers can discover related active attempts, exchange messages and report conflicts. The existing supervisor proposes a resolution when a conflict needs judgment; it does not become a second scheduler.

Open **Coordination** in the ticket header to inspect workers, messages, conflicts, plan adjustments and saved decisions. The view retains accepted history across reloads and shows archived executions read-only.

## Resolving a conflict

1. A worker reports a conflict, or an operator uses **Report a conflict**. Identify affected steps and optionally suggest a resolution. Affected work and its dependants wait while independent work can proceed.
2. Worker-reported conflicts request supervisor help automatically. For operator reports, choose **Ask supervisor**. The view shows resolution progress and failures.
3. If the agreement stays within current assignments, use **Record agreement**. Save what was agreed and why. A conversation alone does not change the approved plan.
4. If ownership, assignment or sequencing must change, propose a plan adjustment. Inspect the before/after values and affected work, then accept it or reject it with a reason.

The form can adjust an unfinished step or add corrective work. New work needs an ID, title, assignment and explicit acceptance criteria. Write work also needs a scope and review estimates. Select the completed work being corrected when adding a corrective step. Accepted steps remain historical facts; corrections are additional work.

Accepting an adjustment preserves affected unfinished work for inspection and restarts that work from the latest accepted baseline. Dependencies and scope are validated before acceptance. Scope ownership must be explicit, including `.agent-plan` configuration files; coordination does not implicitly expand a worker’s write scope. Attempts belong to a plan revision, so a superseded attempt cannot silently advance the new plan. Other proposals based on the old revision are superseded.

If applying an adjustment fails, the UI shows the error and any preserved patches. Inspect the saved edits, address the error, then choose **Retry acceptance**. While a revision is being applied, new proposals, rejection and agreement actions are disabled so recovery finishes against one consistent baseline.

Git work is preserved as patches and retained snapshots. Changed files in non-Git writable roots block automatic revision acceptance: their existing baseline records contain hashes, not restorable file contents, so those files need manual preservation and restoration first.

## Messages and recovery

Messages identify both attempts and display queued, delivered, failed or uncertain delivery. Peer text is advisory; it cannot grant permissions. A stale recipient is not automatically restarted. An uncertain message after interruption should not be assumed delivered.

Accepted decisions, unresolved conflicts and plan revisions are persisted with the run. Resumed workers receive current coordination context. Use the saved decision history to understand why an assignment changed, and the preserved-work disclosure to inspect work from before an accepted adjustment.

## Operator CLI

The CLI uses the same HTTP endpoints as the dashboard:

```sh
node src/cli.js coordination show <ticketId>
node src/cli.js coordination conflict <ticketId> '{"summary":"Two workers need the interface","stepIds":["api","client"],"proposal":"API owns the shared contract"}'
node src/cli.js coordination resolve <ticketId> <conflictId>
node src/cli.js coordination decide <ticketId> '{"summary":"Use the existing interface","reason":"Both assignments can proceed unchanged","stepIds":["api","client"],"conflictIds":["<conflictId>"]}'
node src/cli.js coordination propose <ticketId> '{"reason":"Client must wait for API","changes":[{"stepId":"client","dependsOn":["api"]}],"conflictIds":["<conflictId>"]}'
node src/cli.js coordination accept <ticketId> <revisionId>
node src/cli.js coordination reject <ticketId> <revisionId> "Keep the original assignment"
```

Use either an agreement or an accepted adjustment to resolve a given conflict; the examples illustrate alternative outcomes. `coordination show` defaults to the selected ticket. All output is JSON. Proposals can include `addSteps` and `correctiveStepIds` for additive corrections.

Coordination is limited to one daemon. There is no cross-daemon transport or autonomous worker rescheduling.
