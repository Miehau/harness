# Delegation and clarification

1. Intake and stage selection: read the brief/config/discovery manifest and relevant
   repository instructions. The coordinator decides which preparation stages add value,
   based on scope, uncertainty and risk, not a fixed pipeline. No owner approval is
   needed to skip optional stages. Record selected/skipped stages and a short reason
   in the clarification artifact; do not create a separate stage-selection report.
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
     read-only stage="discovery" worker. Use the configured discovery model (Luna by
     default); escalate only for a concrete deficiency and record why.
   - New features or changes with unresolved system boundaries, contracts, data flow
     or consequential design tradeoffs: use a read-only stage="architecture" worker.
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
   important; routine work keeps the normal final review only.
2. For selected preparation stages, pass relevant index/report references rather than
   transcripts. Architecture considers concepts, boundaries, contracts and clashes.
   Planning covers acceptance criteria, assignments, dependencies and evidence needs.
   Publish only useful reports via revise. Planning/architecture use the planning
   model setting or inherit the coordinator model.
   For each declared category, after a concrete plan or contract exists and before
   clarification, spawn a fresh read-only stage="planning" worker for plan assurance.
   Combine closely related categories when one bounded assignment covers them. Give it
   the exact document revisions, requirements and relevant code references. Its report
   identifies the category and reviewed revisions, then records invariants, abuse or
   failure cases, rollback/recovery needs, required checks and actionable findings.
   Resolve material findings by revising the documents and rerun affected assurance;
   an unresolved material finding blocks writers. Independent plan-assurance workers
   may run concurrently against the same frozen document revisions.
3. Before asking the owner to choose an approach, classify the fork:
   - If existing code, documentation or recorded evidence can answer it, investigate
     and decide from that evidence. Do not build a prototype or ask the owner.
   - If running something can answer it (behavior, timing, layout, API ergonomics or
     feasibility), define a rubric and compare two or three isolated throwaway
     prototypes. Use the clarification checkpoint below to approve only the experiment
     scope, then use implementation workers in separate worktrees. Do not integrate
     prototype commits. Publish the comparison, revise the governing documents and
     return to clarification before final implementation.
   - If the decision is an expensive-to-reverse boundary or interface, run a design
     arena: give at least two architecture workers the same grounded brief, then give
     their artifacts and one rubric to a fresh planning worker for cross-judgment. The
     coordinator reads every candidate and judge report, chooses one base and records
     any ideas deliberately grafted from the others.
   Ask the owner only for a product preference, scope choice or authority that evidence
   cannot settle. A prototype is disposable evidence, not an implementation candidate.
   After an empirical fork, continue from this step using the selected evidence.
4. Clarification checkpoint (required even when all preparation workers are skipped):
   check scope, user intent, acceptance criteria, risks and conflicting requirements.
   If material ambiguity remains, ask the owner and stop dependent work. Otherwise,
   save a concise clarification artifact and call clarify {artifact}; a routine task
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
6. Read worker reports and answer questions using file references. Pause affected
   workers for changed contracts. Use peer coordinator messages to resolve overlaps;
   unresolved product decisions go to the owner. Delegate fixes as needed.
   Independent candidate review is required.
7. Integrate completed writing workers and verify the combined candidate. Read
   workflow/review.md and run required candidate assurance, then the final general
   review. Fix → integrate → verify → rerun affected assurance and review until
   there are no major/medium findings. Save a handoff with changes, evidence mapped to
   acceptance criteria, limitations and the branch/commit. Complete with report only after verification. End at the candidate:
   only the owner can invoke accept to rebase, reverify and merge it.


Use the named choices in model-menu.json when spawning: discovery, planning,
implementation, review or complex (plus any configured alternatives). Do not infer availability
or prices from your own model name. Your actual running provider/model is stated in
your system instructions. Explicit model/provider overrides require modelReason and
are checked against Pi's available models before creating a worker worktree. If a
choice is unavailable, surface the configuration problem rather than guessing IDs.
