# Align overlapping tickets

Compare features and behavior as well as file paths. Discover peers in active.md
and communicate directly with native SendMessage under [active-log](active-log.md),
using supervisor relay for unavailable/uncertain peers. No external broker, polling,
direct edits to peer notes or supervisor dispatch of another coordinator's workers.

## Publish scope before implementation

Each coordinator saves `scope-vN.md` in its own ticket directory and points to it
from state.md. Include ticket/repository/coordinator IDs, exact base and candidate,
features and behavior, modules/symbols/files, APIs/schemas/migrations/events/config,
proposed interfaces, shared-definition owners, dependencies and unresolved questions.

Read active.md, then peer briefs, current scope references and decisions for the
same repository. Send your new scope reference to the log-owning supervisor.
Include pending dispatches, paused/blocked tickets with retained changes, and
candidates awaiting acceptance. Accepted work matters if your base lacks its
commits. Missing or stale scope is unknown, not evidence that work is disjoint.
Read Pending acceptance and relevant archive entries too. Archived coordinator IDs
are historical; route questions to their supervisor instead of messaging them.
Different files can still conflict on an API, migration or shared invariant.
Save concrete collision evidence and the exact peer scope versions inspected.

Checkpoint and return `needs-alignment` with this scope and assessment before any
writer starts, even when no peer was found. Settle children before returning. This
gives the supervisor a checkpoint where concurrent tickets' plans can be compared.

## Exchange and acknowledge a proposal

The supervisor considers all registered tickets in the repository, including those
without a published scope. Collect a potentially related pending ticket's scope
before releasing conflicting work. Clearly unrelated work may proceed with a
recorded rationale. Review dispatches serially within this supervisor session;
these Markdown notes do not implement a cross-session lock.

For overlap, contact the coordinator identified in active.md directly when its
native identity/session is confirmed; otherwise use supervisor relay. Exchange an
exact versioned proposal between the owning coordinators before returning alignment.
Each coordinator owns its technical plan and writes an acknowledgment in its own
notes. The supervisor records those references in active.md, never invents acknowledgment
or edits a peer contract. A sent message, timeout, old reply or silence is not agreement.

An agreement records participating ticket IDs and exact scope/contract versions,
shared interfaces/behavior, one owner per shared file/definition, compatibility
checks, parallel versus sequenced assignments, dependency order and exact commit/base
conditions, each coordinator's acknowledgment reference, and unresolved items.

Prefer disjoint ownership and agreed interfaces where sufficient. Sequence
overlapping files or incompatible changes. Do not import unfinished peer work to
unblock a ticket. If peer implementation is required, wait for its accepted commit
to reach the agreed target, reconcile the dependent base, then rerun affected
verification and review. Product disagreement goes through the supervisor to the user.

Return a result tied to exact scope versions: acknowledged agreement, or a
no-overlap assessment listing peers considered. The coordinator records this before
spawning writers and includes relevant agreement references in every assignment.

## Recheck, pause and recover

Recheck peer scope at each writer wave, on discovery of new affected code, before
integration and before candidate handoff. The supervisor also checks when starting
another ticket and before delivery. A new overlapping ticket triggers a proposal
to the existing coordinator; earlier clearance does not reserve future work.

Changed scope, contracts or dependencies invalidate affected agreements. Stop new
conflicting assignments, safely settle/stop affected workers, preserve their edits,
publish a new scope version and return needs-alignment. If live native steering is
unavailable, hold the new conflicting ticket until the existing coordinator returns
safely. Do not claim its workers paused merely because a message was sent.

Pass agreement/dependency evidence to the reviewer and include it in the handoff.
On recovery, inspect current peer scopes and acknowledgments before resuming writers.
An unavailable coordinator or a different supervisor session means ownership may be
uncertain; reconcile through the user instead of granting unilateral clearance.

This is a workflow agreement, not automatic conflict detection or atomic locking.
Git checks, meaningful verification and review still apply to the actual candidate.
