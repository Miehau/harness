# Shared Agent Plan workflow

This is the maintained workflow contract for every platform binding. The binding
supplies tool names, native agent lifecycle, private storage paths and hosting commands;
it cannot silently weaken these rules. `policy.json` records the required reviewer
roles and risk mapping. Read [task record](task-record.md) when creating or recovering
work. Platform support means a tested capability, not merely a selectable model name.

## Configure and discuss

Read `.agent-plan/project.json` and optional `.agent-plan/local.json` in the original
checkout. When canonical project config is absent, use `.runner/project.json` for
compatibility. Canonical project settings win; never merge two project files. Local
overrides are limited to execution and agent/model preferences, not checks or hosting.
Never save provider secrets or copy subscription tokens. Use the official runtime's
own login and supported authentication. A runtime, model and workflow role are
separate choices. Confirm the selected binding supports the requested combination
before launching work; an unavailable runtime is a blocker, not permission to substitute.

Discuss requirements in the supervisor conversation. Persist the agreed scope,
acceptance criteria (AC), decisions with rationale and sources, verification commands,
risks and exact base before handing implementation to one coordinator. Reuse the same
task identity for clarifications and retries. Preparation alone does not authorize
implementation. Do not ask again for authority already given in the conversation.

## Scale work to uncertainty

For a small understood bug, documentation change or feature following an established
pattern: inspect affected references, save a concise clarification/assignment, and
use one implementer. Skip separate discovery, architecture and planning workers and
unnecessary documents. A bug's evidence includes a reproduction and regression check.
For unfamiliar or uncertain work, delegate bounded discovery. For unresolved material
architecture, compare independent proposals and return the choice to the owner.
Use separate planning only when dependencies or sequencing warrant it. Record why
stages were selected or skipped in the clarification, not a new ceremony document.

For architecture, record the requested proposal roster (three independent seats by
default when none is specified), exact base, and immutable brief, grounding and rubric
references before dispatch. Every seat receives these same inputs in a separate
context/worktree. Keep authors independent through submission: do not send evaluations,
hints, other proposals or mid-run steering. A material brief correction starts a new
round with the same corrected inputs for every seat; preserve the earlier round.

Account for every requested seat with a complete proposal or an evidence-backed failure
report identifying what failed and why. A provider timeout, tool failure or exhausted
budget is an execution failure, not proof that the architecture is nonviable. A
nonviability conclusion must identify the conflicting constraints and supporting
evidence. Retry only after the prior attempt is confirmed stopped; uncertain shutdown
blocks replacement. Never silently drop a seat or mark a comparison complete with
missing proposals. Return gaps and their evidence to the owner for a decision.

Judge only after independent submissions settle. Pass full proposals, briefs, grounding,
critiques, synthesis and decisions by immutable file reference. Do not truncate outputs
to meet an arbitrary length cap; summaries supplement the full files. While waiting,
end the turn and use completion events or supported waits, never shell sleep or model
polling loops. A recommendation is not approval to implement.

Declare concrete security, database/data-safety, recovery/operator, UI or performance
risks. Sensitive changes get fresh targeted plan assurance before writers start.
Resolve material findings; changed reviewed plans require renewed assurance. Routine
changes require no plan-assurance specialist. Do not classify every task as risky.

## Implement and communicate

The coordinator owns assignments, integration and task state; the supervisor owns
human discussion and approval. Each implementer has a distinct worktree at the agreed
base and explicit file/interface ownership. Respect configured concurrency and attempt
budgets. Never copy unrelated dirty changes, reset user work, force-push to recover, or
infer a task succeeded from an agent becoming idle.

Agents may ask their coordinator or peers questions through the binding's supported
messaging. Persist significant answers and the exact recipient/task/decision identity.
Messages carry information, not human approval or authority to change scope. Ask the
owner only when the agreed brief and available evidence cannot resolve a material
choice. Questions include goal, prior decisions, blocker, options/tradeoffs,
recommendation, evidence/screenshots and what the answer would authorize. Pause only
affected work. Missing cross-session messaging is a capability gap, not an invitation
to pretend a message was delivered. Settled workers report immutable evidence references.

## Verify and review

Integrate serially, then run all configured checks against a clean candidate. Preserve
commands, outcomes, logs, full commit and applicable UI evidence. Verification must
exercise the intended behaviour; command success is not proof of every AC.

Run fresh independent **requirements/AC** and **correctness/code-quality** reviewers
in parallel against the same frozen verified commit (batch if concurrency is limited),
plus every risk-selected role in `policy.json`. Each report names its role, candidate,
coverage, findings and evidence. Do not show one reviewer's current findings to another
before its initial inspection. Reviewers may then ask authors for clarification;
conversation cannot replace independent inspection or evidence.

There is no mandatory final generic reviewer. Major/medium findings block delivery;
never remove a role to waive a blocker. Fix, integrate, verify and rerun every required
role after any candidate change. A failed/missing reviewer is not a pass. A host without
independent delegation must report the missing gate, never relabel self-review.

## Publish and approve

The handoff maps AC to evidence, identifies the exact candidate, review coverage and
limitations, and gives worktree/preview inspection instructions. Publish one PR/MR on
the configured GitHub/GitLab project when authorized. Upload only selected evidence
with known access controls; private task notes and credentials stay local. Reconcile
existing requests before retrying. Evidence must belong to the reviewed candidate.

Publication and CI success are not merge approval. Owner approval must identify the
exact candidate and target; recheck remote head, current required CI and hosting gates
immediately before merge. A new candidate needs new approval. Never bypass provider
protection. Local-only delivery must be explicitly configured and identified.

## Recover and report honestly

Checkpoint before side effects and record outcomes afterward. Resume only an identified
prior task/agent. If a push, publication, merge or process shutdown is uncertain, inspect
actual state before retrying. Retain dirty worktrees and incomplete evidence. Clean up
only explicitly authorized, owned resources after their processes are confirmed stopped.

Native skills provide instructions; they are not a process lock or a security boundary.
The runner adds application-level checks and durable receipts; it is not an OS sandbox.
Git worktrees isolate changes, not credentials. Report actual enforcement and tested
capabilities for the chosen binding. Distinguish mocked checks, live model tests, and
live provider/notification tests. Do not claim one proves the others.
