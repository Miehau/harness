# Agent Plan execution bindings

Read this page when using these skills with the OMP/Herdr runner. It changes tool
usage and ownership, not the skills' engineering methods.

## Main conversation

`agent-plan supervisor` loads these skills as `/skill:how`, `/skill:why`,
`/skill:arena`, `/skill:architect`, `/skill:blast-radius` and `/skill:open-pr`.
Use native read-only tools for small explanations. For substantial architecture,
use `runner_supervisor start` with the target repo, stable requestId and a
preparation-only brief. The coordinator manages at least three independent
architecture workers and returns every proposal plus comparison for discussion here.
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
