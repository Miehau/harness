# Agent Plan execution bindings

First select the configured execution mode using `.agent-plan/project.json`
(legacy `.runner/project.json` only when absent) and private local preferences.
For native Codex, read [the native binding](../../../native.md) and use the skill's engineering
method with exposed native tools; skip the OMP-specific sections below. Discussion
alone can use the current native session before onboarding; implementation requires
an explicit execution selection. Missing native capabilities are reported, never
replaced by an OMP daemon. These skills do not enable automatic mixed-runtime delegation.

For OMP/Herdr runner execution, use the following tool and ownership boundaries.

## Main conversation

`agent-plan supervisor` loads these skills as `/skill:how`, `/skill:why`,
`/skill:arena`, `/skill:architect`, `/skill:blast-radius` and `/skill:open-pr`.
Use native read-only tools for small explanations. For substantial architecture,
use `runner_supervisor start` with the target repo, stable requestId and a
preparation-only brief. The coordinator manages three independent
architecture workers by default (or the owner's explicit roster). It freezes the same
brief, grounding, rubric and base references for every seat, preserves independence
without hints or steering, and returns every full proposal or evidence-backed failure.
Missing proposals leave comparison incomplete and return to the owner; execution
failure does not prove architectural nonviability. Judge only after submissions settle.
End the turn while awaiting events; do not use shell sleep or model polling loops.
Keep the same task through the later implementation handoff. Send the draft design
using `runner_supervisor {action:"feedback",taskId,text}`, then capture the user's
choice with `{action:"ask_user",taskId,decisionId,text}`. Feedback is not approval.

Read the proposals and judging evidence yourself. Discuss the recommendation with
the user and record the selected architecture, rationale and implementation scope.
If the user defers the choice, retain the unresolved decision in task memory and
do not prompt again until they return to it. If their reply already resumed the
coordinator, it checkpoints the deferral and creates a new `ask` with
`requiresOwner:true`, explicitly marked deferred, then ends its turn. The supervisor
keeps that decision pending quietly; no automatic scheduled wake-up is implied.
Once authorized, delegate implementation to the background coordinator and continue
the main conversation. Do not implement in the supervisor's source checkout.

For revisions to an existing open PR/MR, inspect its task and use
`runner_supervisor {action:"feedback",taskId,text}`. From a CLI client such as GrokBot,
use `agent-plan list` to find the task by PR URL, then
`agent-plan feedback TASK /absolute/revision.md`. This reopens a completed hosted task
in its existing branch/worktree and updates the same PR/MR after verification and review.
Do not launch a replacement task, switch the owner's checkout or merge first.
Use the exact pending decision's answer flow when the task is waiting for a decision.
For non-trivial UI work, relay a visual mockup for owner approval before dependent UI
implementation; skip this for trivial UI fixes and backend-only tasks, and reuse
already approved designs.

## Managed coordinator and workers

Each new task snapshots this package under `pstack/` in its artifacts, including
reference prompts and attribution. Read it with `runner_read(area="artifacts")`.
Resolve skill-relative reference paths there, not against the target repository.
Only load the skill and references required by the current assignment.

- The coordinator uses `runner_action spawn` for subagents. Leaves never spawn
  more agents, even when a skill describes parallel exploration or synthesis.
- Pass each worker the exact skill/reference paths, grounded brief, rubric, base
  and assigned output. The worker performs only its assigned slice of the skill.
- Architecture, discovery and review workers are read-only for repository files.
  Save proposals, including code sketches, in each worker's artifact directory.
  Executable prototypes require separately authorized implementation workers.
- Native OMP tools are available under trusted-local execution. Use runner tools for
  durable artifacts, coordination, configured verification and reports. Native shell
  success never replaces the final configured candidate checks.
- Preserve the agreed design. Pause affected work and bring proposed architectural
  departures to the main conversation; routine details stay with the coordinator.
- Reports, questions, verification, review and acceptance retain the existing runner
  workflow. Hosted completion publishes the verified, reviewed candidate through
  the runtime. Merge requires owner approval of the exact published revision;
  workers must not bypass runtime delivery gates.

## Other interactive clients

Use available native agents for read-only investigation and independent proposals.
For background implementation, use the configured runner integration and its return
channel. If this client lacks that integration, say so and move execution to an OMP
supervisor; do not claim CLI launches can wake this conversation automatically or
silently replace delegation with edits in the main checkout.
