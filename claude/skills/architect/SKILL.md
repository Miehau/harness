---
name: architect
description: "Ground a change, compare independent architecture proposals with the user, then delegate agreed implementation to a background coordinator. Use for architect this, design this, or consequential choices before implementation."
---

Read [the common workflow contract](../../shared/contract.md) and
[the common task record](../../shared/task-record.md). Follow the native Claude
supervisor binding; discussion skills do not expand tool permissions.

# Architect

Design together before delegating implementation. Sketch types, function signatures,
class shapes and module boundaries in proposal artifacts. Compare independent
perspectives in the main conversation, record the chosen design and why, then hand
authorized implementation to the background coordinator. If evidence challenges the
design, bring it back for discussion before changing the agreement.

Follow [Agent Plan execution bindings](../../workflows/supervisor.md) for supervisor and managed
worker tools. A candidate worker performs its assigned proposal only; it never
recursively invokes this whole workflow. Already-agreed architecture or a small,
understood change can go directly to an authorized implementation handoff.

## Start

Keep a short phase checklist in the available plan tool or task notes.

1. Ground
2. Sketch
3. Agree
4. Implement
5. Verify
6. Scrap

## Phase A: Ground the problem

Build a real mental model of every system the new code touches. Run the **how** skill over the relevant subsystems.

Naming a file isn't grounding. Produce the traced model `how` prescribes. If the design redefines ownership or layering, also run the **why** skill on the existing shape so the rationale becomes a constraint, not a guess.

Skip Phase A only when the work is genuinely greenfield with no surrounding system to integrate.

## Phase B: Sketch

Run the **arena** skill with the design-sketch task and the Phase A grounding artifacts. Pass `references/runner-prompt.md` as each runner's prompt. Each candidate produces a design package shaped per `references/rationale-template.md`.

Default to three independent architecture workers unless the owner specifies a roster.
Freeze the common brief, grounding, rubric and committed base as file references.
Give every requested seat the same inputs in separate worktrees. Respect capacity
by batching without exposing earlier proposals to later authors. No evaluations,
hints or steering during proposal generation. A material correction starts a new
round for every seat; preserve the original submissions.

Account for every requested seat: a complete proposal or a specific evidence-backed
failure report. Confirm an attempt stopped before replacing it within the budget.
Execution failure is not architectural nonviability; a nonviability claim must name
conflicting constraints and evidence. If proposals remain missing, return all available
files and failure evidence to the user with the coverage gap. Do not silently lower
coverage, claim a complete comparison or fabricate disagreement when proposals converge.

Screen every candidate against [`references/design-red-flags.md`](references/design-red-flags.md) before synthesis. Record shallow modules, information leakage, temporal decomposition and pass-through methods as judging findings after submission; do not steer authors mid-round.

Compare viable candidates on interface depth. Prefer the design that hides more complexity behind a smaller, simpler public surface. A rich interface can keep call chains short by concentrating capability instead of scattering it across layers.

Arena returns all proposals, independent judging evidence and a recommended synthesis.
These inform the discussion; the recommendation is not an architectural decision.

## Phase C: Agree in the main conversation

Read every proposal and compare the tradeoffs with the user. Recommend an approach,
then record the selected design and rationale, rejected alternatives, fixed contracts,
acceptance criteria, worker discretion, exact base and user-decision references.

The coordinator returns proposals using `ask` with `requiresOwner:true`; the supervisor
holds this discussion and records the answer using the existing human decision tool.
Choosing a design without authorizing implementation keeps the task in preparation.
More research or a rejection is not permission to build. Reuse prior explicit
agreement and authorization without asking for them again.

Keep sketches in artifacts until implementation is authorized. When adversarial
pressure would improve a consequential design, use an independent reviewer to
challenge the recommendation before the decision.

If the user challenges the shape, treat that as Phase A evidence. Re-ground affected
questions and revise the proposals before dependent implementation.

## Phase D: Implement against the sketch

After agreement and implementation authorization, the same background coordinator
delegates bounded implementation to isolated writers. Pass the agreed design as the
contract, then let the main conversation continue with the next feature. The
coordinator integrates worker commits, runs checks and commissions independent review.

Investigate deviations: was the sketch wrong, a requirement missed, or implementation
overreaching? Resolve ordinary details within the agreed discretion. For a departure
from agreed architecture, pause affected workers and return the evidence and a
recommendation to the main conversation before changing the design.

## Phase E: Verify and collect evidence

Run the repository's required checks plus focused tests for the changed behavior. Inspect the actual combined candidate, not worker self-reports. Record the exact commit, commands, outcomes, and evidence mapped to the requested behavior. Use an independent reviewer for non-trivial work and repair major or medium findings before completion.

Authorized implementation continues through a verified and independently reviewed
candidate. Preparation-only work ends at the discussion and agreed handoff until
implementation is authorized. Publishing a PR or MR remains a separate action.

## Phase F: Scrap when the architecture is wrong

If implementation repeatedly challenges the sketch, pause affected work and propose
a redesign from the observed constraints. Do not discard an agreed architecture or
retained work independently.

The signal is a *pattern*, not single instances. Tells:

- The same shape of workaround appearing repeatedly across unrelated code.
- Multiple unrelated edge cases that all need special-case branches.
- Types that need escape hatches (`any`, casts, optional fields always set in practice) to compile.
- The "we need a lock" reflex when the sketch said the state wasn't shared.
- Callers having to know the abstraction's internal rules to use it.
- Two or more independent Phase D deviations of the same shape across the implementation.

Use judgment. A few edge cases don't condemn an architecture. Some problems are legitimately complex. Complexity in the data is not complexity in the design.

When proposing a replacement:

1. Re-run the **how** skill over what's been built.
2. Redesign as if the new constraints had been day-one assumptions.
3. Subtract before adding. The new sketch should be smaller than the old one before it grows.
4. Return to Phase B and re-run arena, then agree the replacement in Phase C.

## Outputs

Write the caller's usage first and derive the type sketch from it. Return all
requested proposal artifacts (or explicit failure evidence), comparison/judgment and a rationale shaped per
`references/rationale-template.md`. Record the user-agreed handoff separately from
the recommendation. After authorized implementation, return the candidate and evidence.
