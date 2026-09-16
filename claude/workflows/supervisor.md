# Supervisor: one coordinator per ticket

The main Claude conversation is the supervisor. Discuss requirements with the
user, launch one native coordinator per ticket, relay decisions and present results.
Only coordinators spawn research, implementation and review workers. Do not perform
ticket implementation or dispatch leaf workers from this main conversation.
Use native tools only; no MCP, custom runtime, CLI-launched model sessions or daemon.

## Compatibility before dispatch

This package targets Claude Code 2.1.219 or newer, with an effective native subagent
spawn depth of at least two. Check `claude --version` through native Bash before a
first launch. Versions 2.1.172–216 supported nesting with different defaults, but
are outside this package's supported baseline. Version 2.1.117 cannot be assumed
to support this hierarchy. Ask the user to update through Claude's normal update
flow if needed; do not update their installation or settings silently.

Current Claude uses three nested layers by default. A user/admin setting of
CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1 prevents coordinator-to-worker delegation.
Do not change it automatically. The coordinator must verify Agent is exposed; a
missing tool or depth-limit error is a compatibility blocker, not a reason for
the supervisor to take over spawning or to run external processes.

## Intake and coordinator launch

1. Infer the repository from the current directory unless the user selects another.
   Inspect repository instructions, current branch, full HEAD, Git status and
   worktrees. Require a committed base. Do not stash, reset or commit user changes.
   If uncommitted work matters to the requested task, obtain a clean agreed base.
2. Record the absolute Git common directory as repository identity. Resolve the
   user's Claude config directory from CLAUDE_CONFIG_DIR, otherwise `$HOME/.claude`.
   Select a unique safe ticket ID and create `agent-plan/tasks/TICKET/` beneath that
   config directory, checking for an existing ticket or branch first. Keep notes
   outside the source checkout so isolated coordinators do not write through the
   main-checkout boundary. Respect normal file permissions; if denied, stop rather
   than bypassing them. Save the agreed brief/criteria in `brief.md`, and maintain
   a separate `supervisor.md` for coordinator ID, dispatch intent, user decisions,
   handoff references and next action. Do not write the coordinator's `state.md`
   while it owns the ticket. These notes are not a transactional launch lock.
3. Inspect other active ticket notes for overlapping scope. Coordinators have their
   own native worktrees, so different tickets may run concurrently. Record semantic
   dependencies and sequence conflicting work. Never assume another ticket's code
   is part of this ticket's base. Coordinators contact confirmed same-session peers
   directly through SendMessage. Relay proposals when direct contact is unavailable; do not
   mutate their contracts or spawn their workers from the supervisor.
   Follow [cross-ticket alignment](alignment.md), including new tickets that overlap
   already-running work. Follow [active-log](active-log.md): maintain the shared
   active.md as its sole writer, registering each ticket before dispatch and updating
   coordinator IDs, scope, phase and agreement references from native messages.
4. Save a dispatch intent before calling the native Agent tool with
   `subagent_type: "agent-plan:coordinator"` and `isolation: "worktree"`.
   Use native background execution when appropriate so the supervisor can continue
   discussing other tickets. Omit a teammate name; experimental teams are not used.
5. Pass the complete agreed brief, criteria, full base commit, original checkout and
   target branch, ticket notes path, shared active.md path, original supervisor ID,
   and absolute paths to task.md, recovery.md, active-log.md, alignment.md and
   delivery.md beside this workflow. Include constraints and user decisions with
   their source. The coordinator cannot rely on inheriting conversation context.
6. Save the returned coordinator ID/handle immediately. After an uncertain spawn,
   inspect native tasks and supervisor.md before retrying; do not create a second
   coordinator. Report uncertainty if this session cannot establish ownership.

## Questions, results and follow-up

Every coordinator returns needs-alignment after planning and before writers start.
Collect its scope assessment, let reachable same-session coordinators exchange
proposals directly with SendMessage, relay only when needed, and record
their matching acknowledgments under [alignment](alignment.md). Resume the exact
coordinator with the versioned agreement or no-overlap result. Never treat this
technical coordination checkpoint as human approval or as a reason to spawn workers
from the supervisor. Later scope changes reopen this checkpoint.

Process scope/phase/agreement messages from ticket coordinators into active.md.
Follow only the ticket coordinators through native completion notifications and
task-output controls; no polling service or model polling loop. Workers report to
their coordinator. If a child result unexpectedly reaches the main conversation,
route it to the owning coordinator without taking over coordination.

For needs-input, read the exact decision artifact. Answer routine questions from
already agreed scope, labeled as supervisor inference with evidence. Relay product
choices/approval to the user through native AskUserQuestion or conversation. Save
the user's exact answer in a new decision note, then resume the exact coordinator
with ticket ID, decision ID and source. Never resume an already-running coordinator
as a duplicate; use native steering if available or await a safe handoff.

Inspect candidate evidence reported by the coordinator. Present `Agent Plan candidate:`
with ticket ID, full commit, checks/outcomes, matching independent review and notes
path. Publish the PR/MR and evidence through [delivery](delivery.md), then obtain
acceptance for the exact hosted candidate after CI and required reviews. If changes are needed,
send them to the coordinator, which owns worker assignment and revalidation.

Follow [archival](archive.md) on a ready candidate: archive the settled coordinator
and move its scope/candidate into Pending acceptance. After acceptance or confirmed
cancellation, archive the final outcome and retire its remaining active entry.
Revalidation reactivates the ticket before coordinator resume; preserve history.

Use [recovery](recovery.md) for pause, checkpoints or interruption. Restore the
supervisor-to-coordinator association before continuing a ticket. Saved worker
IDs do not authorize the supervisor to silently replace its coordinator.
