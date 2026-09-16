# Archive completed coordinator work

The supervisor automatically archives finished coordinator work after a verified
candidate or confirmed acceptance/cancellation. Use `<Claude config directory>/
agent-plan/archive.md`, beside active.md, initialized from
[the template](../templates/archive.md) only if absent. The owner supervisor is the
sole writer of both indexes. No extra service or cleanup command is needed.

Archive the record, not the artifact paths. Retain the canonical `tasks/TICKET/`
directory, reports, decisions, scopes, agreements and evidence in place. Never move
or delete files, Git branches or worktrees as part of archival. Existing references
must keep working. Archival is bookkeeping, not acceptance or Git cleanup.

## Completion versus acceptance

Pending acceptance includes publication blockers, PR/MR review, CI and queued merges.
Record host URL, head SHA, CI/evidence links and next action there. User approval or
a queued merge is not an accepted outcome; retain the entry until the host merges.

- Candidate ready: the coordinator returned a verified/reviewed exact candidate and
  settled its children. Archive `candidate-ready`, retire its live coordinator row,
  and add a compact Pending acceptance entry in active.md with scope, candidate,
  archive and supervisor references. The feature is not yet delivered on the target.
- Accepted: verify actual GitHub/GitLab merged status and resulting commit, append an `accepted` archive record
  with exact target/commit and approval reference, then remove the pending entry.
- Cancelled: after requested cancellation, confirmed subtree stop and confirmed
  cancellation of any hosted pending merge under [recovery](recovery.md), archive
  `cancelled` with retained-work and cancellation evidence. No merge is implied.

Never archive because a process exited or a turn ended. Needs-input, needs-alignment,
paused, failed and uncertain ownership/child-stop states stay active for attention.

## Preserve first, retire second

1. Inspect ticket state, coordinator return, native child outcomes and evidence.
   For a candidate, verify its actual commit matches passing checks and review.
   Do not archive with children reported running/unknown or an unresolved operation.
2. Write a unique archive record keyed by ticket, outcome and candidate/delivery
   revision. Preserve IDs, repository identity, timestamps, scope/agreements and
   dependencies, handoff/check/review paths, canonical ticket path, retained worktrees
   and branches. Copy all ticket activity being retired into archive.md first.
3. Read back the archive and verify required artifact references exist. Only then
   retire that ticket's matching active row/events or move it to Pending acceptance.
   Leave unrelated events untouched and add a compact archived event/reference.
4. After interruption, inspect both indexes. Reconcile an existing matching archive
   instead of appending duplicates. If archival is incomplete, retain the active
   entry and report attention. These ordered edits are not an atomic transaction.

## Discover and reopen

Coordinators compare Pending acceptance alongside active tickets: unmerged features
can still conflict. Read relevant archives for dependencies or accepted commits
missing from your base. Archived IDs are not live contacts; ask their supervisor.
Status shows pending candidates and exposes archive history for an exact ticket or
history request. Recovery checks archive.md when an active row is absent.

For requested candidate changes/revalidation, the supervisor restores an active row
before resuming its exact coordinator, removes the pending entry and retains the old
archive as history. Reconcile native ownership and recheck alignment first. Accepted
or cancelled work continues only on an explicit new user request. Never auto-resume
an archived ID merely to refresh a log.
