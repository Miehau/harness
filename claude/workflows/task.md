# Native Agent Plan workflow

This workflow runs inside the ticket's `agent-plan:coordinator` subagent. The main
conversation is the supervisor, which delegates the ticket and receives its result.
Use Claude's built-in Read, Write, Edit, Glob, Grep, Bash, Agent and question/task
tools. No MCP tools, custom runner, daemon, SDK, external agent process, custom API client
or nested `claude -p` calls. Git and project checks run through native Bash under
the user's normal permissions. Do not change authentication or permission modes.
If repository instructions require unavailable external tools, surface that
limitation instead of overriding this native-only boundary.

## Start and record state

1. Read the supervisor's complete ticket assignment and workflow paths. Confirm the
   native Agent tool is available before any task mutation; if unavailable, return
   a nesting compatibility blocker. Use your native isolated worktree and verify
   it is distinct from the supplied supervisor checkout. Read its CLAUDE.md,
   AGENTS.md and relevant existing instructions. Inspect `git status`, the current
   branch, `git rev-parse HEAD` and `git worktree list`. Require a committed base.
   Do not stash, reset or commit pre-existing user edits; if the checkout is dirty,
   explain what prevents a safe start and wait for the user to choose a clean base.
2. Verify the supplied absolute notes path and ticket brief match your assignment.
   Notes live in the user's Claude config directory under `agent-plan/tasks/TASK/`,
   outside the source checkout. Check the brief's Git common directory identity
   matches your worktree. These are ordinary Markdown files; respect normal file
   permissions. Never write Git metadata or cross the native main-checkout boundary.
   Use the supervisor's exact ticket ID and existing brief. For a fresh assignment
   verify state.md and the ticket branch do not already exist; otherwise follow
   recovery rather than overwriting or reinitializing them.
3. One coordinator owns each ticket. Different tickets get separate native worktrees.
   Record supervisor and coordinator IDs when available. Never write supervisor.md
   or another ticket's state. Notes do not implement a process lock.
4. Record the supplied original branch, full base commit, checkout, task ID, session ID when
   available, requirements, acceptance criteria and verification commands. Create
   a task branch `agent-plan/TASK` from that exact supplied base in your clean native
   worktree and verify HEAD. Its default ref may differ from the supplied base.
   Leave the supervisor checkout unchanged. Implementation children get their own
   native worktrees. A detached original checkout has no implied merge target.
5. Save `state.md` before launching any agent. It contains phase, owner session,
   requirements/decisions with sources, candidate/base/target refs, document
   versions, agent IDs, assigned paths, worktrees, commits, blockers and next action.
   Keep each substantive report as a new versioned Markdown file; do not overwrite
   prior evidence. Only the coordinator writes shared notes. Never put secrets in
   notes. Native task-list tools may track dependencies/progress, but do not replace
   saved notes or verification evidence.

Use phases planning, implementing, verifying, reviewing, awaiting-acceptance,
blocked, paused, cancelled and accepted. Distinguish observed Git state from an
agent's claim. Update notes after each meaningful result and before a risky Git
operation. A session ending is not proof of completion.

## Discover, plan and clarify

Delegate bounded discovery to `agent-plan:researcher` with the absolute repository
root and question. Save its code/test references and unknowns. Then delegate
architecture and planning, passing the earlier findings and exact acceptance
criteria. Separate dependent stages; independent research can run concurrently.
Keep the stages brief for small tasks rather than inventing design work.

Publish versioned exploration, architecture, plan and acceptance notes. Determine
real setup and verification commands from the repository; an existing
`.runner/project.json` may be read as documentation, but never execute the runner.
Do not invent a passing check or quietly replace failing checks with a trivial one.

Resolve routine choices from existing conventions. For missing product/scope
decisions, save a question with a decision ID, checkpoint and return needs-input to
the supervisor after settling your children. The supervisor asks the user and
resumes you with the answer's source. Do not ask the user directly or infer approval.
Record a clarification checkpoint identifying the accepted document
versions before writers start. Changed scope/contracts require a new checkpoint.

Before launching writers, follow [cross-ticket alignment](alignment.md): publish
scope-vN.md, read the supplied active.md and compare peer features/files/interfaces.
Use [active-log](active-log.md) to contact a clashing coordinator directly and send
scope/agreement updates to the supervisor, then return needs-alignment.
Record the supervisor's version-specific alignment result before implementation.

## Native parallel implementation

Start with at most two simultaneous implementers unless the user chooses otherwise.
You, the coordinator, make these Agent calls. Workers are your children, not the
supervisor's. Do not spawn another coordinator. Research/review workers are leaves too.
This is a workflow default, not a runtime-enforced quota. Use the Agent tool with
the plugin's `agent-plan:implementer` type and `isolation: "worktree"` on the call
as well as in its definition. Do not supply a teammate name or rely on experimental
agent teams. If native isolated agents are unavailable, surface the limitation;
do not silently launch external processes or shared-checkout parallel writers.

Before each wave, verify the candidate checkout is clean and record its full HEAD.
Recheck the current peer scopes and alignment agreement before this wave.
Every assignment includes:

- Unique assignment ID and worker branch `agent-plan/TASK/ASSIGNMENT`.
- Exact base commit, coordinator checkout and absolute relevant input paths.
- Bounded outcome, owned files, acceptance criteria and relevant tests/setup.
- The same explicit shared contract for all parallel writers: interfaces, shared
  definitions and their owner, dependencies, and document revision.
- Instructions to return worktree, branch, commits, test evidence and blockers.
- Applicable cross-ticket agreement references and dependency/base conditions.

Save assignments before dispatch; save returned native agent IDs immediately.
Pass essential requirements/contracts in the delegation prompt; subagents do not
inherit the conversation or skill content automatically. Native worktrees can
start from a different default ref. Require each new implementer to initialize its
clean worktree's new branch at the supplied base and verify HEAD before editing.

Run independent assignments concurrently. Sequence overlapping files and schema
changes; do not pretend worktree isolation resolves semantic conflicts. Background
agents cannot reliably ask interactive permission questions: resolve permissions
through Claude's normal UI or use foreground execution if blocked. Never bypass
permissions or approve commands through invented answers.

When a worker needs a scope/contract change, let affected workers finish or stop
them with Claude's native task controls before revising assignments. Preserve
their changes, record the new contract and relay any needed user decision through
the supervisor. Never
change the contract under active writers. Native completion notifications replace
polling; no shell sleep loop, `/loop`, watcher process or model polling loop.

## Integrate, verify and review

1. Wait for all writers in the current wave to finish or explicitly stop. Inspect
   each returned worktree/diff/status, branch and actual commits. Reject work outside
   its assignment; preserve it for inspection rather than deleting it. A partial
   report is not done. Confirm each result descends from its recorded base.
   Recheck peer scope before integration; changed overlap returns to alignment.
2. Save an integration intent (current HEAD, worker base, ordered commit list) in
   state.md before cherry-picking. Integrate only those recorded assignment commits
   in order, one worker at a time. Record the new candidate and completed operation.
   If a command's outcome is uncertain, inspect Git before repeating it. On conflict
   stop and preserve state; do not reset, drop commits or automatically retry.
3. Prepare curated publishable evidence under [delivery](delivery.md), including
   committed evidence files when needed, before final verification and review.
   Run the agreed checks on the combined clean candidate. Save exact commands,
   exit status/output references and full commit in a new verification note. Check
   that HEAD and tracked files stayed unchanged by verification; inspect untracked
   outputs too. A failing/missing check blocks a ready candidate.
4. Save the full base-to-candidate diff. Launch a separate read-only
   `agent-plan:reviewer` with the candidate root, full commit, requirements, diff,
   verification note and all earlier review findings. Keep this checkout unchanged
   while review runs. The reviewer reads actual code and callers, not only a summary.
   Include cross-ticket agreements and evidence that their dependencies are met.
5. Save the review with its exact commit. Major and medium findings require fixes;
   minor suggestions may remain in the handoff. Delegate fixes, integrate, verify
   and obtain a fresh review of the resulting commit. Do not reuse an old pass.
   Default to at most three repair rounds; if still blocked, report the evidence
   and next decision rather than looping indefinitely or weakening the checks.
6. Only after all assignments and decisions are settled, verification passed and
   the exact candidate has no major/medium review findings, set awaiting-acceptance.
   Save a handoff mapping requirements to evidence, with limitations and run steps.
   Recheck alignment and include its current references and peer dependency state.
   Return a final report to the supervisor with task ID, full
   candidate commit, checks/outcomes, matching reviewer result and absolute notes
   path. Completion remains a claim supported by evidence, not a server-enforced gate.

Settle your known child agents before returning a question, blocker or candidate.
Report any uncertain surviving child explicitly. The supervisor presents the
candidate and owns PR/MR publication, hosted CI follow-up and human acceptance. Do not merge, push or deploy. Follow its
revalidation requests under [delivery](delivery.md) and [recovery](recovery.md).
