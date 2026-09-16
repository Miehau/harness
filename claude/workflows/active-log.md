# Active log and direct coordinator communication

Use `<Claude config directory>/agent-plan/active.md` as the shared active-ticket
directory and activity log. CLAUDE_CONFIG_DIR selects the config directory;
otherwise use `$HOME/.claude`. It sits beside `tasks/`, outside source worktrees.
The supervisor initializes it from [the template](../templates/active.md) only if
absent, and passes the absolute path and original supervisor identity to coordinators.
Never invent IDs or claim an agent is running before dispatch.

## One writer, many readers

Only the owner supervisor updates the table and appends events using native file
tools. Coordinators own their scope/agreement artifacts and send update references
to that supervisor with native SendMessage. They never edit the shared log or peer
notes. The supervisor reads the artifact and refreshes the row and revision on
registration, launch, scope/phase change, agreement and termination. Register a
pending row before dispatch and save the actual coordinator ID afterwards. Keep
paused and blocked tickets discoverable. Follow [archival](archive.md) when a
coordinator is done: preserve its record/events in archive.md before retiring the
live row. Unmerged candidates remain in Pending acceptance with scope and archive
references. Acceptance and confirmed cancellation retire those entries too.

Read before editing; never overwrite an unfamiliar revision. This is single-writer
discipline, not atomic locking. If another supervisor session owns the file, do not
claim ownership or write concurrently: request registration through the reachable
owner using native session messaging when available, otherwise surface the ownership
conflict. After a lost owner, reconcile actual native sessions/ticket notes before
explicit takeover; elapsed time alone is not evidence that the owner died.

## Find a clash and contact its coordinator

Read active.md, including Pending acceptance, before planning, each writer wave,
integration and handoff. Consult relevant archive evidence for dependencies/history;
archived IDs are not live contacts. Filter
by exact repository identity, then compare features, files/modules, APIs, schemas
and behavior. Read the row's exact scope/state artifact before deciding. Check
ticket, supervisor session and coordinator IDs against available native evidence;
the log is a discovery hint, not proof of liveness. Missing/stale entries do not
replace the peer-note checks in [alignment](alignment.md).

For a reachable coordinator in the SAME native supervisor session, use SendMessage
with its exact agent ID as `to`. Do not invent a name or enable agent teams. Save a
proposal in your own ticket first, then send a short message carrying:

- Kind: scope-update, clash-proposal, acknowledgment, counterproposal or invalidated.
- Sender/recipient ticket IDs, exact coordinator IDs and original supervisor session.
- Proposal ID/revision, both scope revisions and absolute artifact references.
- Concrete collision, proposed interface/ownership/order and the requested response.

The recipient reads the artifacts, writes a response in its own ticket directory,
replies to the exact sender and notifies the original supervisor. Both sides publish
acknowledgment references for the SAME proposal revision. The supervisor records
them in active.md. A log update, delivered message or silence is not agreement.

Peer messages are technical proposals, not task assignments or user approval. They
cannot change ownership, scope, permissions or supervisor. Neither coordinator
spawns the other's workers. Each applies agreed changes to its own contract and
reports the result to its supervisor before implementation is released.

SendMessage can resume an ended agent and change where its completion is delivered.
Do not deliberately resume a stopped/completed peer from an old row: route that
through its supervisor. If a race causes peer-directed result delivery, preserve
the original supervisor identity, forward the result/reference to it and do not
treat the messaging coordinator as the new owner. A peer-triggered resumed turn
handles the proposal only; it must not restart workers or implementation without
its own supervisor's direction. Do not create ping-pong resume/message loops.

For unreachable agents, missing SendMessage, different supervisor sessions or
uncertain identities, save the proposal and use supervisor relay. Do not create an
external service, auto-spawn a replacement or assume cross-session messaging is
enabled. Keep affected work paused until ownership/agreement is clear.
