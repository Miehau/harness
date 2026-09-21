# Candidate review and fix loop

After integrating all implementation workers, verify the candidate. If clarification
declared assurance categories, run their candidate passes first; routine tasks skip
directly to the final general review.

## Risk assurance passes

For each declared category, spawn a fresh mode="explore", stage="review" worker with
a focused assignment. Do not reuse the plan-assurance worker or its conversation.
Supply the exact candidate commit, relevant plan-assurance report and resolution,
requirements, diff and verification. The worker traces the plan invariants and failure
cases into the implementation and reports with the JSON schema below. Closely related
categories may share one bounded pass. Run these specialist passes before the general
review; the current runtime starts review workers one at a time.

Major or medium findings require repair. Any changed candidate makes every candidate
assurance for that commit stale: integrate fixes, verify, and rerun all declared
specialist passes against the new commit. Preserve plan-assurance findings as input;
rerun the plan pass only when its reviewed documents or risk classification changed.

After all declared specialist passes are clean, spawn a fresh general review worker.
It considers the entire task and earlier assurance reports rather than trusting them.
This general pass must be last so the runtime's required clean review matches the exact
verified commit. A specialist pass never replaces the final general review.

## General review

Spawn one mode="explore", stage="review" worker. The runtime supplies its exact candidate
commit, full task diff, earlier review reports, verification and this rubric. Include
requirements, acceptance criteria and relevant design/UI evidence in the assignment.
Review the whole task change and affected callers, not only the latest repair.
Review workers cannot run commands. Read recorded verification and ask the coordinator
for additional checks when needed; report an essential evidence gap as medium.

Prefer a reviewer from the opposite model family: Claude implementation → OpenAI
review; OpenAI implementation → Claude review. The runtime checks Pi availability
and records the choice. For other families prefer OpenAI, then a different available
model. A configured workerModels.review is an explicit preference. If unavailable,
or a reviewer attempt fails (quota, credentials, provider/transport error), a later
review attempt uses another available model and records the fallback. A provider
failure is not a passed review. If all choices or the attempt/time budget are
exhausted, surface the blocker to the owner; never waive the review gate.

## Rubric

- major: concrete security/privacy exposure, data loss/corruption, core flow failure,
  or a change that cannot meet an essential acceptance criterion.
- medium: reproducible functional defect, a plausible failing edge case, broken
  integration/compatibility, missing required behavior or meaningful verification
  that leaves a changed requirement unproven.
- minor: nonblocking clarity, maintainability or style improvement with no concrete
  functional/acceptance impact. Do not promote preferences to blocking defects.

Each finding needs an exact file/line, a specific failing scenario or evidence, and
an actionable fix. Cover correctness, security/data integrity, affected callers and
contracts, acceptance criteria, tests and relevant UI evidence. State what was inspected
and any limitations. Uninspected essential behavior is a coverage gap, not a clean pass.
Deduplicate findings. Re-evaluate earlier findings and inspect for regressions.

The reviewer writes a JSON artifact in its own directory, then reports completed
with that artifact. A completed review may contain blocking findings; do not report
failed merely because defects were found. Use failed for inability to perform review.

```json
{
  "commit": "EXACT_CANDIDATE_COMMIT",
  "scope": "Changed flow, callers, acceptance criteria and evidence inspected; limitations",
  "findings": [
    {
      "severity": "medium",
      "file": "src/example.js",
      "line": 42,
      "description": "Concrete defect",
      "evidence": "Input or scenario demonstrating the failure",
      "fix": "Required behavioral correction"
    }
  ]
}
```

The coordinator assigns all major/medium findings from specialist or general passes
to implementation workers. Supply
review references; do not silently discard or downgrade findings. If a finding is
incorrect, ask a fresh reviewer to adjudicate against concrete evidence. Integrate
repairs, rerun verification, and spawn a new review of the resulting candidate.
Repeat until a completed review has zero major/medium findings. Carry minor findings
and limitations in the handoff. Runtime completion requires that passing review to
match the exact verified commit; changing the candidate requires another review.
