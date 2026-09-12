# F08 — Verification and correction loops

[Map](../feature-map.md) · [Navigation reference](../feature-navigation.md)

**Load when:** verification contracts, failed checks, independent review, correction loops.

## Behavior and boundaries

**Purpose:** Require `.agent-plan/verify.mjs` for repository checks; missing scripts fail instead of falling back to npm or skipping; collect repository checks and independent review findings; run focused fixes and retain each round. Repeated findings, expanded intent, provider waits and workflow gates can interrupt progress.

**Strength:** Deterministic failure is not replaced by model opinion. Each assigned AC needs an explicit independent verdict; worker reports remain proposals. The requirements reviewer reconfirms all ACs at final review, and another reviewer’s failure cannot be overridden by a success. Visual criteria need fresh, inspected images mapped to their CLI journey (recording frames when video is required). Focused findings, retained rounds and restartable fixer sessions make failed work diagnosable.

**Limit:** `MAX_CORRECTION_ROUNDS = 12` imposes an attempt ceiling even if progress continues; this differs from the no-fixed-retry-count specification.

Evidence: [final-review.js](../../src/final-review.js), [step-runner.js](../../src/step-runner.js), [repository-checks.js](../../src/repository-checks.js), `shouldPauseCorrection` in [execution.js](../../src/execution.js), [verification contract tests](../../test/verification-contract.test.js), [execution tests](../../test/execution.test.js). See the [current module responsibilities](../refactor-architecture.md).

The setup step generates or repairs the [discovery/CLI contract](../../.agent-plan/feature-map.md). Feature workers maintain its affected map leaves, commands, assertions and tests before implementation handoff, and report updated paths or why no map change is needed. Missing documentation scope requires input. Step review checks that rationale against the diff; final review checks the combined ticket diff and reports stale or missing affected documentation. Reviewers compare the verification script with repository test/build configuration.

## Find the implementation

Read only this feature’s UI/API/CLI/source/test row from the repository root:

```sh
rg -n '^\| \*\*F08\*\*' docs/feature-navigation.md
```

Follow its named symbols into source, then read callers and the focused tests. Load the navigation guide’s fixture recipes only when exercising a journey.

## Follow only relevant edges

- For proof invalidation, read [F07 — Step review and proof](step-review.md).
- For missing visual evidence, read [F09 — Previews and visual evidence](visual-evidence.md).
- For combined final review, read [F10 — Final proof gate](final-proof.md).
- For resume a stopped correction, read [F12 — Recovery and process cleanup](recovery.md).

Snapshot: 2026-09-06, `9703dde` plus uncommitted work. [Audit evidence and provenance](audit.md) are optional; verify current source before relying on historical findings.
