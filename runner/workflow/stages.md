# Delegation and clarification

Architecture belongs to the owner and supervisor in the main conversation. The
coordinator organizes preparation and later executes their agreed architecture; it
does not choose a design on their behalf. A preparation-only brief authorizes
research and proposals, not feature implementation. Use the same task and coordinator
for the later implementation handoff; do not launch a replacement task.

1. Intake and stage selection: read the brief/config/discovery manifest and relevant
   repository instructions. Preserve architectural decisions and their reasons from
   the main conversation. Select preparation stages from the brief, uncertainty and
   risk; do not reopen settled architecture or skip requested competing proposals.
   Small, already-understood changes need no architecture round. Record selected/skipped
   stages and a short reason in the clarification artifact; do not create a separate
   stage-selection report.
   Classify the task as bug fix, feature, refactor, performance or generic. For the
   first four, read workflow/playbooks.md and carry its required evidence into the
   clarification and handoff. The playbook shapes the work; it does not make every
   preparation stage mandatory.
   - Straightforward cleanup, directory removal, documentation edits or a small known
     fix: inspect the affected files/references, write a concise scope, acceptance
     criteria and verification plan, then go directly to one implementation worker.
     Skip separate discovery, architecture and planning workers and their documents.
     For deletion, check callers, imports, build/config and documentation references.
   - Unfamiliar code or uncertain impact: delegate a bounded discovery question to a
     read-only stage="discovery" worker. Use the configured discovery model (inheriting the coordinator when unset); escalate only for a concrete deficiency and record why.
   - New features or changes with unresolved system boundaries, contracts, data flow
     or consequential design tradeoffs: run the competing proposals in step 3.
     A new feature following an established pattern does not automatically need one;
     a risky cleanup may. Reuse existing design documents when they settle the question.
   - Multiple assignments, dependencies or substantial sequencing: use a read-only
     stage="planning" worker. Otherwise the coordinator's concise assignment is the plan.
   Add a skipped stage later if evidence reveals a need; do not run it merely to fill
   a checklist. Delegate bulk exploration/design/planning when needed, not every task.
   Classify the task as routine or declare only the concrete assurance categories it
   needs: `security` (authentication, authorization, privacy or trust boundaries),
   `data-safety` (migration, destructive behavior, loss or corruption), `recovery`
   (concurrency, retries, durable state or Git operations), and `operator` (a
   safety-critical human workflow). Do not add a category merely because code is
   important; routine work requires the requirements and correctness review roles.
   Add `database`, `ui` and `performance` when migrations, interface behavior or
   performance risk requires the corresponding specialist. Pass declared categories
   as clarify {artifact,risks:[...]} so required role coverage persists in task state.
2. For selected preparation stages, pass relevant index/report references rather than
   transcripts. Architecture considers concepts, boundaries, contracts and clashes.
   Planning covers acceptance criteria, assignments, dependencies and evidence needs.
   Publish only useful reports via revise. Planning/architecture use the planning
   model setting or inherit the coordinator model.
3. Architecture preparation and return to the main conversation:
   - Resolve routine implementation details from existing code, documentation or
     evidence. Keep within the agreed architecture; do not ask the owner to predict
     behavior that can be measured.
   - For unresolved architecture or requested competing proposals, give
     three independent architecture workers by default (or the owner's explicit roster)
     the same frozen brief, grounding and rubric file references.
     Read pstack/skills/architect/SKILL.md and pstack/skills/arena/SKILL.md through
     artifact reads. Give each candidate architect/references/runner-prompt.md and
     architect/references/rationale-template.md beneath pstack/skills/. After the
     candidates finish, commission arena's separate read-only judge as a planning
     worker. Pass all original proposals and its recommendation to the supervisor;
     neither the judge nor coordinator makes the architectural choice.
     Use mode="explore", stage="architecture" and separate worktrees at the same
     committed integration base. Keep that base fixed until proposals finish. Respect
     maxWorkers: run in batches if needed, without reducing the proposal count or
     showing earlier proposals to later authors. Do not steer authors with hints or
     evaluations while they generate proposals. A material correction starts a new
     round with the same corrected inputs for all seats; retain the previous round.
     Every requested seat needs a complete proposal or specific evidence-backed failure.
     Confirm prior attempts stopped before replacement within the budget; uncertain
     shutdown blocks replacement. Execution failure is not architectural nonviability;
     that conclusion requires conflicting constraints and evidence. Missing proposals
     leave comparison incomplete: return full available files and failure evidence to
     the owner without silently dropping seats or claiming complete coverage.
     Each proposal covers the what, how and why: boundaries, contracts, data flow,
     code references, tradeoffs, risks and verification. Workers write proposals in
     their artifact directories; architecture worktrees are read-only for repo files.
   - If running something can answer it (behavior, timing, layout, API ergonomics or
     feasibility), define a rubric and compare two or three isolated throwaway
     prototypes within an explicitly authorized experiment scope. If the brief does
     not authorize it, return the bounded experiment to the main conversation first.
     Use the clarification checkpoint below for that scope only, then implementation
     workers in separate worktrees. Do not integrate
     prototype commits. Publish the comparison, revise the governing documents and
     return to clarification before final implementation.
   - Read every proposal and return all original artifact references, the exact base
     commit, comparison and remaining questions with ask {artifact,requiresOwner:true}.
     Stop the turn. The supervisor compares the proposals with the owner and records
     their choice; the coordinator must not select the architecture or start feature
     implementation. A nonblocking surface message is not this handoff.
   - Read the human answer and the supervisor's referenced handoff. A request for more
     research, a rejection, or a design choice without implementation authorization
     continues preparation only. An answer is not automatically permission to build.
     Before implementation, publish the agreed architecture with revise: selected
     approach and rationale, rejected alternatives, fixed contracts, acceptance
     criteria, worker discretion, exact base and user-decision references. Resolve
     missing material details in the main conversation. If the brief already contains
     this agreement and implementation authorization, reuse it without asking again.
   A prototype is disposable evidence, not an implementation candidate.
4. Clarification checkpoint (required even when all preparation workers are skipped):
   For each declared risk category, after the architecture is agreed (or the brief
   already settles it) and a concrete plan or contract exists, spawn a fresh read-only
   stage="planning" worker for plan assurance. Combine closely related categories when
   one bounded assignment covers them. Give it the exact document revisions,
   requirements and relevant code references. Its report identifies the category and
   reviewed revisions, then records invariants, abuse or failure cases, rollback/recovery
   needs, required checks and actionable findings. Resolve material findings and rerun
   affected assurance. Changes to agreed architecture return to the main conversation
   before dependent work; an unresolved material finding blocks writers. Independent
   plan-assurance workers may run concurrently against the same frozen document revisions.

   Check scope, user intent, acceptance criteria, risks and conflicting requirements.
   If material ambiguity remains, ask the owner and stop dependent work. Check the
   implementation handoff from step 3; clarification cannot authorize a design or
   turn preparation into implementation. Otherwise, save a concise clarification
   artifact and call clarify {artifact}; a routine task
   needs no user question or separate architecture/plan/acceptance documents.
   This artifact may also serve as the implementation assignment, including affected
   paths, acceptance criteria and verification. Reference selected worker reports if any.
   Record the routine/risk classification, current plan-assurance artifacts and how
   their findings were resolved. A changed reviewed document makes the affected plan
   assurance stale as well as invalidating clarification.
   Implementation cannot start before this checkpoint. Published document changes
   invalidate it, so revisit clarification before launching more writers.
5. Spawn implementation workers with stage="implementation", mode="write", the
   accepted plan/criteria references and a shared contract for parallel writers.
   One worker owns shared definitions and the feature index. Workers implement,
   checkpoint progress, update discovery docs and provide tests/visual evidence.
6. Read worker reports and answer routine questions from the agreed handoff using
   file references. If evidence challenges an agreed architectural decision, pause
   affected workers and return the issue, evidence and recommendation to the main
   conversation with ask {artifact,requiresOwner:true}. Do not replace the architecture
   independently. Use peer coordinator messages to resolve overlaps;
   unresolved product decisions go to the owner. Delegate fixes as needed.
   Independent candidate review is required.
7. Integrate completed writing workers and verify the combined candidate. Read
   workflow/review.md and run all required candidate review roles independently in
   parallel against one frozen verified commit, bounded by maxWorkers.
   Fix → integrate → verify → rerun every required role until
   there are no major/medium findings. Save a handoff with changes, evidence mapped to
   acceptance criteria, limitations and the branch/commit. For hosted delivery, also
   write a separate immutable PR/MR description for a reviewer unfamiliar with the task:
   explain the problem, resulting changes, verification and material limitations. Cover
   the full diff against the hosting target, including earlier branch changes. Link full
   evidence instead of copying prompts or internal handoffs. Pass its file reference as
   descriptionArtifact alongside artifact in the completed report. No output truncation.
   Complete with report only after verification. End at the candidate:
   hosted completion publishes the PR/MR; only the owner can approve accept for the
   exact published revision. Local-only acceptance rebases, reverifies and merges.


Use the named choices in model-menu.json when spawning: discovery, planning,
implementation, review or complex (plus any configured alternatives). Do not infer availability
or prices from your own model name. Your actual running provider/model is stated in
your system instructions. Explicit model/provider overrides require modelReason and
are checked against OMP's available models before creating a worker worktree. If a
choice is unavailable, surface the configuration problem rather than guessing IDs.
