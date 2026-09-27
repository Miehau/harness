---
name: arena
description: "Compare independent candidates, cross-judge their tradeoffs, and recommend a synthesis. Architectural choices return to the main conversation. Use for arena this, competing proposals, or consequential design alternatives."
---

Read [the common workflow contract](../../shared/contract.md) and
[the common task record](../../shared/task-record.md). Follow the native Claude
supervisor binding; discussion skills do not expand tool permissions.

For native Claude, follow [mixed-model architecture](../../workflows/second-model.md):
2–3 Claude proposals plus one Codex proposal in separate worktrees, then a fresh
Codex judge recommending one approach to the user. This binding overrides the
generic roster and judge fallback below. Each report includes work done, learnings,
pros and cons. Candidate review pairs Claude with background Codex.

# Arena

Fan out three independent attempts by default, or the owner's explicit roster. Read every candidate,
cross-judge and recommend the strongest base with useful ideas from the others.
For architecture, return the recommendation and all proposals to the main conversation;
only the user's agreement makes it the selected design. Follow the
[Agent Plan execution bindings](../../workflows/supervisor.md) for tool and ownership boundaries.

## Start

Keep a short phase checklist in the available plan tool or task notes.

1. Frame
2. Fan out
3. Cross-judge
4. Pick
5. Graft
6. Verify

## Phase A: Frame

The N candidates will receive the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing. Freeze the brief, grounding, rubric and requested seat roster in immutable files; pass their references.
2. Derive the rubric. State what success looks like for *this* task, then turn it into 3-6 concrete gradeable criteria. Give every candidate the same task, grounding and rubric.
3. Pick the runners. Use configured models when present. Otherwise choose available models with different strengths or families; use the same model in independent contexts when generation diversity matters more than model diversity. Spawn more only when the arena covers more design directions.
4. Assign separate worktrees at the same exact committed base for repository architecture. Keep the integration base fixed during the round. Managed read-only workers write proposals and code sketches to their artifact directories. For non-repository artifacts, isolated directories suffice.

## Phase B: Fan out

Launch every requested candidate with the same frozen brief, rubric, grounding,
base and individual output paths. Respect worker capacity by batching; do not show
later candidates earlier outputs. If independent delegation is unavailable, report
that limitation rather than label three drafts from one context independent proposals.

Keep authors independent until submission: no hints, evaluations, steering or other
proposals. If material inputs change, start a new round for every seat and retain the
old one. Each rationale names the alternatives considered and what it rejected.

Every requested seat must yield a full proposal or a specific failure report with
evidence. Confirm the old attempt stopped before replacement within the budget.
Provider/tool failures and timeouts do not prove a design nonviable; that conclusion
requires constraints and evidence. Missing proposals leave comparison incomplete:
return the available files and gaps to the owner, never silently reduce coverage.

## Phase C: Cross-judge

After all requested Phase B proposals complete, choose a separate judge, preferably from a different available model family. It sees the rubric and candidates by path label, scores each criterion, and recommends a base with rationale. Run this read-only judgment in parallel with the parent's reading in Phase D, not while candidates are still writing. If no separate judge is available, perform the same labeled scoring yourself and record that limitation.

## Phase D: Recommend a base

Read every candidate end to end before picking.

Score each candidate against the rubric criterion by criterion, not on holistic feel. Compare against the cross-judge. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Recommend the candidate a future maintainer can extend most easily without breaking
invariants. Prefer the cleaner boundary or smaller API when two feel tied.

Record the recommendation and reason, including the cross-judge's verdict. For an
architectural choice, return all candidate references and this comparison to the
main conversation before implementation; do not turn a judge's score into approval.

## Phase E: Graft

Walk each losing candidate once more and identify what is worth porting into the base. The signal is usually one or two things per candidate, not most of it.

Propose each graft deliberately. Don't paste mechanically. The recommendation has to
remain coherent under one mental model; architectural grafts are part of the design
the user discusses and agrees.

Record what was grafted, from which candidate, and what was rejected and why.

When candidates converge, note the agreement without inventing alternatives. No
graft is needed, but the architecture still returns to the main conversation.
When they diverge, examine whether constraints or rubric were underspecified before
reframing; do not average incompatible designs.

## Phase F: Verify

The synthesized artifact has to hold up under the same scrutiny as any other output. Verify it against the Phase A rubric with real checks where possible.

If verification surfaces a problem the arena did not catch, either Phase A was wrong (re-frame and re-run) or one candidate caught it and you missed the graft (go back to Phase E). Don't paper over.

## Outputs

Full original candidate files, explicit failure reports and coverage gaps, the judge's comparison and a recommended synthesized
artifact. A short note names the proposed base, grafts, rejections, dropouts and
verification result, keeping recommendations distinct from the user's decision.

Pass briefs, proposals, critiques, synthesis and decisions as file references. Keep full
outputs without arbitrary length caps; summaries do not replace them. End the turn
while waiting for completion events; do not use shell sleep or model polling loops.
