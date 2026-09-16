# Candidate review and fix loop

After integrating all implementation workers, verify the candidate, then spawn one
mode="explore", stage="review" worker. The runtime supplies its exact candidate
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

The coordinator assigns all major/medium findings to implementation workers. Supply
review references; do not silently discard or downgrade findings. If a finding is
incorrect, ask a fresh reviewer to adjudicate against concrete evidence. Integrate
repairs, rerun verification, and spawn a new review of the resulting candidate.
Repeat until a completed review has zero major/medium findings. Carry minor findings
and limitations in the handoff. Runtime completion requires that passing review to
match the exact verified commit; changing the candidate requires another review.
