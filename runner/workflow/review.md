# Candidate review and fix loop

Integrate every completed writer and verify the candidate before review. Freeze that
exact commit and its recorded verification. Run fresh mode="explore", stage="review"
workers independently in parallel, bounded by maxWorkers; use batches if needed.
Each worker receives the same candidate, requirements, acceptance criteria, diff,
verification and applicable plan-assurance evidence. Do not show another role's
current-candidate findings before its independent inspection. No generic final
reviewer follows or substitutes for these roles.

## Required roles

Every task requires reviewRole="requirements": map every acceptance criterion to
concrete implementation/documentation and verification evidence. Missing essential
evidence is a medium finding. Every code task also requires reviewRole="correctness":
trace changed flows and affected callers, contracts, edge cases, compatibility,
tests and code quality. The runtime conservatively requires both roles for all new
tasks, including documentation tasks; there is no implicit docs-only exemption.

Clarify records risks and required roles. Declared `security` adds reviewRole="security"
for authentication, authorization, privacy and trust boundaries. `data-safety` or
`database` adds reviewRole="database" for migrations, loss/corruption, constraints
and rollback. `ui` adds reviewRole="ui" for interaction, accessibility and UI evidence;
`performance` adds reviewRole="performance" for baselines, resource use and regressions;
`recovery` or `operator` adds reviewRole="recovery" for concurrency, retries, durable
state, Git recovery and safety-critical human workflows. Each required role receives
its own worker and report. Preserve targeted plan assurance before implementation;
candidate assurance traces its invariants and failure cases into the implementation.
Never reuse the plan-assurance conversation as a candidate reviewer.

The runtime allows concurrent reviewers only on the same clean verified commit.
No writers, integration, configured commands or verification may run during review.
Review workers may use native read-only inspection commands under the trusted-local
workflow. They cannot use the runner command API or mutate repository files. Inspect
recorded checks and request additional checks through the coordinator after the round.
Essential missing evidence blocks a clean pass.

## Model selection

Prefer a reviewer from the opposite model family: Claude implementation → OpenAI
review; OpenAI implementation → Claude review. The runtime checks availability and
records choices/fallbacks. Configured review preferences remain explicit preferences.
A failed provider attempt is not review evidence: replace the failed role within the
attempt budget. If no reviewer can finish, surface the blocker; never waive it.

## Rubric and report

- major: concrete security/privacy exposure, data loss/corruption, core flow failure,
  or inability to meet an essential acceptance criterion.
- medium: reproducible defect, plausible failing edge case, broken compatibility,
  missing required behavior or meaningful evidence leaving a requirement unproven.
- minor: nonblocking clarity, maintainability or style improvement with no concrete
  functional or acceptance impact. Preferences alone are not blocking defects.

Findings need exact file/line, a specific scenario/evidence and an actionable fix.
State inspected coverage and limitations. Uninspected essential behavior is a coverage
gap, not a clean pass. Write JSON in the reviewer's artifact directory, then report
completed even when findings block. Use failed only when review could not be performed.

```json
{
  "commit": "EXACT_CANDIDATE_COMMIT",
  "reviewRole": "requirements",
  "scope": "Inspected changes, callers, acceptance criteria and limitations",
  "coverage": ["AC1: behavior in src/example.js:42; recorded check runtime/check.json"],
  "findings": [
    {
      "severity": "medium",
      "file": "src/example.js",
      "line": 42,
      "description": "Concrete defect",
      "evidence": "Input or scenario demonstrating failure",
      "fix": "Required behavioral correction"
    }
  ]
}
```

The coordinator consolidates and deduplicates findings without waiving or downgrading
major/medium blockers. Assign repairs to writers with all source report references.
A disputed finding requires a fresh reviewer of that same role to adjudicate concrete
evidence; coordinator opinion cannot replace review. After repair, integrate and
verify again. Any changed commit invalidates every required role, so rerun the entire
required role set independently against the new candidate. Preserve plan assurance
unless its reviewed documents/risk classification changed.

Completion and publication require every required role's latest completed report to
be clean, explicitly cover its scope and match the exact verified candidate commit.
Carry minor findings, coverage and limitations into the evidence-backed handoff.
Existing tasks snapshotted without the role policy retain their legacy single-review
contract; new tasks always use these role gates.
