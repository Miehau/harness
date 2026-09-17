# Delegation and clarification

1. Intake and stage selection: read the brief/config/discovery manifest and relevant
   repository instructions. The coordinator decides which preparation stages add value,
   based on scope, uncertainty and risk, not a fixed pipeline. No owner approval is
   needed to skip optional stages. Record selected/skipped stages and a short reason
   in the clarification artifact; do not create a separate stage-selection report.
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
2. For selected preparation stages, pass relevant index/report references rather than
   transcripts. Architecture considers concepts, boundaries, contracts and clashes.
   Planning covers acceptance criteria, assignments, dependencies and evidence needs.
   Publish only useful reports via revise. Planning/architecture use the planning
   model setting or inherit the coordinator model.
3. Clarification checkpoint (required even when all preparation workers are skipped):
   check scope, user intent, acceptance criteria, risks and conflicting requirements.
   If material ambiguity remains, ask the owner and stop dependent work. Otherwise,
   save a concise clarification artifact and call clarify {artifact}; a routine task
   needs no user question or separate architecture/plan/acceptance documents.
   This artifact may also serve as the implementation assignment, including affected
   paths, acceptance criteria and verification. Reference selected worker reports if any.
   Implementation cannot start before this checkpoint. Published document changes
   invalidate it, so revisit clarification before launching more writers.
4. Spawn implementation workers with stage="implementation", mode="write", the
   accepted plan/criteria references and a shared contract for parallel writers.
   One worker owns shared definitions and the feature index. Workers implement,
   checkpoint progress, update discovery docs and provide tests/visual evidence.
5. Read worker reports and answer questions using file references. Pause affected
   workers for changed contracts. Use peer coordinator messages to resolve overlaps;
   unresolved product decisions go to the owner. Delegate fixes as needed.
   Independent candidate review is required.
6. Integrate completed writing workers and verify the combined candidate. Read
   workflow/review.md and run review → fix → integrate → verify → review until there
   are no major/medium findings. Save a handoff with changes, evidence mapped to
   acceptance criteria, limitations and the branch/commit. Complete with report only after verification. End at the candidate:
   only the owner can invoke accept to rebase, reverify and merge it.


Use the named choices in model-menu.json when spawning: discovery, planning,
implementation, review or complex (plus any configured alternatives). Do not infer availability
or prices from your own model name. Your actual running provider/model is stated in
your system instructions. Explicit model/provider overrides require modelReason and
are checked against Pi's available models before creating a worker worktree. If a
choice is unavailable, surface the configuration problem rather than guessing IDs.
