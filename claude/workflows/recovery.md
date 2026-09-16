# Native recovery and checkpoints

Read the shared active.md under the Claude config directory for ticket/contact
lookup, then verify its IDs against actual state under [active-log](active-log.md).
The supervisor reconciles stale rows; a log entry is not proof of liveness.
If the active entry is missing, inspect archive.md and Pending acceptance under
[archival](archive.md). Reconcile interrupted archive/index edits before continuation.

Keep the hierarchy during recovery. The main conversation is the supervisor;
each ticket has one coordinator, which owns its workers and state.md. The supervisor
writes only supervisor.md, briefs and user-decision notes. Never concurrently edit
a coordinator's notes or take over worker dispatch because a session was lost.

Resolve the current repository's absolute Git common directory as identity. Resolve
the user's Claude config directory from CLAUDE_CONFIG_DIR, otherwise `$HOME/.claude`.
Use native Glob/Read to list its `agent-plan/tasks/*/supervisor.md` and available
`state.md` files. Filter by the recorded repository identity, including dispatches
that never initialized state. Select an
exact task from the user's request, current task branch or session notes. If several
are plausible, show their IDs and phases; never resume the most recent one blindly.

Read supervisor.md, state, latest checkpoint, assignments, worker reports, verification and review.
Inspect actual `git status`, HEAD, branches, worktrees and any in-progress
cherry-pick/rebase. Use Claude's native task tools to inspect any known agent IDs
available in this session. Saved running status does not prove an agent is alive.
If another session may still own a worker, reconcile that before starting a duplicate.

The supervisor follows or resumes the exact coordinator; that coordinator follows
or resumes its workers. Use native wait/steering for a running agent, not a duplicate
resume. For an ended coordinator with an available native ID, resume that exact
agent with the saved ticket/decision references. For a lost session, do not assume
IDs remain resumable. Only after reconciling the old coordinator AND its descendants
may the supervisor dispatch a replacement coordinator with the retained ticket,
base, worktree, evidence and recovery-only assignment. Never reinitialize its branch
or silently spawn fresh workers. The replacement inspects and preserves dirty work;
if native isolation prevents access to the retained worktree, return a blocker
rather than bypassing it. Do not rerun already-applied effects.

Claude may remove a clean native worktree after an agent returns without changes.
If that happened, confirm the original worktree is absent and the recorded branch
and commits still exist before reattaching that branch in the replacement
coordinator's own clean native worktree. Verify no other worktree owns the branch;
use an ordinary non-forced Git switch, never reset or overwrite it. Do not infer
that a missing worktree proves there were no lost changes. Report missing evidence.

For a saved integration/merge/rebase intent, compare before/after commits and Git
operation state. Record applied only when Git evidence proves it. On conflicts,
explain the conflict and resolve it only within authorized scope; ask before
discarding ambiguous work. A cleared operation record does not itself resolve Git.
Any changed candidate needs fresh verification/review before completion.
Before resuming writers, follow [alignment](alignment.md): inspect current peer
scope and acknowledgment versions. A saved agreement can be stale after a restart.

Quota/login/model failures remain blockers until the user resolves them. Do not
switch billing methods, launch an external agent or repeatedly retry. A cancelled
task stays cancelled unless the user explicitly requests new continuation work.

For supervisor context checkpoints and reload after compaction, follow
[continuity](continuity.md). This does not request checkpoints from child agents.
The coordinator checkpoint below concerns its existing pause/recovery lifecycle.

For a coordinator checkpoint, save agreed requirements, actual user decisions and their source,
assumptions, full commits, current operation, native agent IDs and worktree paths,
pending questions, evidence references and next action. Update state.md last. Do this
after meaningful milestones and before `/compact` or leaving. Saved Markdown is
ordinary evidence, not authorization or an exactly-once transaction log.

For pause/stop, the supervisor requests that the selected coordinator settle/stop
its exact children and checkpoint, then stop. Do not stop the coordinator first and
assume its descendants also stopped. An unresponsive coordinator requires inspecting
the exact subtree and reporting uncertainty; native emergency stop controls may be
used for those recorded IDs, but never broad process groups. Record which agents stopped
and any uncertain status, plus retained worktrees/dirty files. Mark paused or
cancelled as requested. If a native stop control is unavailable, tell the user what
remains running instead of claiming it stopped. Do not delete work.
After confirmed cancellation, the supervisor archives the outcome. Paused, failed
or uncertain subtree states remain active for attention.

There is no independent supervisor or watcher after Claude closes. Native session
behavior determines what survives; reopening loads instructions, not live process
ownership. The SessionStart hook reminds the model to inspect notes. It does not
reconstruct unsaved discussion or automatically resume work.

For hosted delivery, read the saved publication/merge intent and inspect actual
remote refs and the GitHub PR/GitLab MR before repeating any mutation. Reconcile
its head, target, CI, evidence links and merged/queued status under [delivery](delivery.md).
A pause/cancel must also inspect and, when requested, cancel pending hosted auto-merge
or queue admission; stopping Claude agents alone does not stop a host-side merge.
If the host has already merged, record that outcome rather than claiming cancellation.
