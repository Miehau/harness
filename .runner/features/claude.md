# Native Claude workflow

The independent `claude/` plugin is Markdown and JSON only: nine skills, four
native subagent types, task/delivery/recovery workflows and native hooks. It does
not import or launch the runner, Pi, Herdr, MCP, a custom CLI or background service.
Claude's main conversation supervises ticket coordinators. Each coordinator owns
a native worktree and spawns its own research, implementation and review workers.
The supervisor relays human decisions and owns GitHub/GitLab publication and approved hosted merge. Native
nesting requires Claude Code 2.1.219+ and effective spawn depth of at least two.
Coordinators publish versioned feature/file/interface scope and align overlapping
tickets through native direct proposals and mutual acknowledgments before
writers start. Scope changes reopen alignment; dependency evidence reaches review.

Install once through the bundled local marketplace, then launch plain `claude` in
the target repository and use `/agent-plan:start <description>`. Git and project
checks use Claude's built-in Bash. Task notes are ordinary Markdown under the user's
Claude config directory in `agent-plan/tasks/`; this is a documented workflow, not a
deterministically enforced state machine. The Pi path remains unchanged.

Read [usage and limits](../../claude/README.md) and [live checks](../../claude/HANDOFF.md).
`test/claude.test.js` checks packaging, references and native hooks/tools without
model calls. The removed runtime adapter's end-to-end tests are not evidence for
this replacement; live native execution still needs a subscription smoke test.

A supervisor-owned active.md lists current ticket scope and exact coordinator IDs.
Coordinators discover clashes there and use native SendMessage for reachable peers,
with supervisor relay for stale or cross-session handles. No external broker exists.
Finished coordinators move into archive.md; unmerged candidates stay discoverable
under Pending acceptance. Canonical artifacts and Git work remain intact.

Supervisor-only checkpoint/restore uses readable session memory, snapshots and an explicit
reload order after same-session compaction; it does not checkpoint short-lived children.
