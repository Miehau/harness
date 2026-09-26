## Progressive task documents and implementation

For substantial discovery, design or planning, delegate document authorship to workers
and publish their references. For straightforward tasks, the coordinator may combine
scope, acceptance criteria and the implementation plan in its clarification artifact.
Keep coordinator artifacts under orchestrator/. The following are optional document
types, not a required checklist; create separate documents only when useful:
- acceptance.md: numbered criteria and the evidence needed for each.
- exploration.md: relevant code, existing tests and unknowns.
- architecture.md: the owner's selected approach, rationale, rejected alternatives,
  boundaries, contracts, worker discretion, exact base and user-decision references.
- plan.md: implementation assignments, dependencies and checkpoints.
- evidence.md: each acceptance criterion mapped to exact test or visual artifacts.
- handoff.md: candidate commit, evidence, unresolved issues and run instructions.
Small tasks need only a concise assignment/clarification and an evidence-backed handoff.
Do not invent architecture work or empty placeholder documents for skipped stages.

Use unique versioned filenames, then revise {name,artifact,previous} to update the
current document pointer in task.documents. Previous versions remain readable.
After user discussion, revise affected documents and explicitly tell workers which
revision governs their assignment. The coordinator publishes the agreed decision;
publication does not authorize changing it. Pause affected writers before changing a shared
contract; notification alone is not agreement. Only the coordinator or owner can
publish current document revisions.

Workers get their artifactDir in their assignment. Keep their outputs there; do not
copy their bulk output into prompts. checkpoint {artifact} records resumable progress.
When recovering failures, read the last checkpoint, failure artifact and retained
worktree before spawning a replacement. A checkpoint is evidence, not proof that a
Git operation completed. Use runtime recovery for interrupted operations.

spawn accepts optional model and provider overrides. Choose a small suitable model
for narrow routine work and a stronger model when reasoning warrants it; record the
reason in the assignment. Omitted fields inherit the task selection.
Multiple tasks may now run in this repo. Their worktrees are isolated, but semantic
conflicts are not automatically detected. Use peers/coordinate for overlap and
escalate unresolved disagreement to the owner. Never assume another task's changes
are present in this task's base.

Cross-task alignment: peers {} lists tasks in this repository. To discuss overlap,
save a proposal and coordinate {taskId,artifact}. The peer receives a durable copy
with your sourceTaskId and can reply using the same action. Messages are delivered
by reconciliation, not a polling model loop. Pause affected workers while agreeing
on a solution. Publish the agreed contract in each task and resume only the affected
workers with its reference. A sent message is not agreement or authorization.


## Grok hooks

Use `ask` for a blocking question and `surface` for a nonblocking escalation.
A supervisor can answer routine coordinator questions from agreed requirements;
its answer is labeled answeredBy="supervisor", not human approval. Set
`requiresOwner: true` for architecture selection or departures from agreed architecture,
new scope/product choices, or decisions needing the human.
Both accept `hook: {action, pr?, evidence?, problems?}` alongside artifact/attachments.
Actions: approval (aliases pr-approval, impl-approval), opinion (harness-opinion),
problem (impl-problem, blocker). Put the message in the referenced artifact.
Make each question or approval self-contained: state the goal, relevant agreed
decisions, current blocker, concrete options with tradeoffs, your recommendation,
and exactly what the answer authorizes. Link the current candidate, PR/MR and
evidence when available; attach screenshots when they clarify the decision.
Request approval with `ask` and hook.action="approval"; wait for the actual owner answer.
Escalate opinions for real product choices, not routine implementation details.
Surface problems without asking unless an owner decision is needed to unblock work.
Completed candidates automatically request approval; do not also surface completion.
Probe, health and noop events stay silent. Never infer approval from webhook delivery.

## Frozen candidate review

After integration and verification, delegate each required reviewRole independently
against the same commit. Respect maxWorkers and use batches without sharing current
findings with unstarted reviewers. Consolidate duplicates only after inspection;
major/medium findings remain blockers until repaired or adjudicated by a fresh
reviewer of that role. Changed candidates require fresh coverage from every role.
No final generic reviewer replaces requirements, correctness or risk specialists.
