# Harness bottleneck fixes

Scope agreed after the MEA-51 retrospective: implement review admission (1), unresolved finding lifecycle (2), proof readiness and coverage (3), and delivery diagnostics/recovery (5). Daemon isolation (4) is excluded. Item 6 adds progressive review lookup and reusable UI planning; extra reviewer batching remains deferred until measurements justify it.

| Fix | Implementation | Verification |
| --- | --- | --- |
| Review admission | Failed or incomplete prerequisite checks skip independent reviewers and enter focused correction with the actual diagnostic. | Isolated daemon regression asserts zero reviewer calls and checks the correction input. |
| Finding lifecycle | Derive open, resolved and regressed findings from retained review records. Prerequisite-only rounds cannot resolve product findings; correction review receives unresolved findings only. | Regression covers prerequisite failure, resolution, recurrence and retained audit history. |
| Proof readiness | Plan missing capture capability before feature work. Require a separate capture command; run a declared fixture preflight with the same capture inputs. | Regressions cover missing configuration and a preflight failure preventing browser capture. |
| Proof completeness | Validate linked media, commands and assertions for every required visual criterion, including recordings where required. Independent review evaluates actual visual adequacy. | Coverage regression rejects multiple screenshots of one outcome when another is missing; allows media to support multiple outcomes. |
| Failure recovery | Retain kind, phase, command, diagnostic and next action. Preserve capture failures instead of replacing them with generic missing-media errors. Mark publication pending and block merge if publication fails. | Typed-failure tests, publisher retry tests, and the daemon prerequisite regression. |

Capture setup proves a baseline journey before implementation. Feature workers extend that same scenario to cover their new outcomes. Artifact count is descriptive metadata, never the success criterion. Readiness and coverage checks do not establish that an image visually proves its claimed outcome; independent inspection remains required.

## Item 6: rationale and agreed direction

The saved round-38 requirements prompt had roughly one million text characters. Its legacy proof section contained 19 historical reviews totaling about 759,000 characters; the 30 current criteria occupied about 20,000 characters. The dominant problem was repeated historical review content, not an inherently unmanageable number of criteria. Earlier recovery already excluded legacy proof history from reviewer packets.

Agreed approach: send a bounded structured index of current criteria, unresolved findings, changed areas and evidence references. Retain full evidence in files and let reviewers read relevant details on demand. Batch by behavior or affected subsystem when the remaining packet exceeds a measured budget, preserving one integration review for cross-cutting invariants. Splitting every criterion into its own agent risks duplicate context and missed interactions.

For substantial UI changes, keep a short UI plan within the existing design stage: existing components and patterns, information hierarchy, necessary states, interaction flow, and a coverage checklist. Identify the repository’s design system once and retain a concise reference to its components, tokens, typography, layout and writing conventions. Later UI tasks should load that reference progressively and verify only relevant changes, rather than rediscovering it. Small changes should reuse established patterns without another mandatory planning round. A UI plan should constrain unnecessary prose and control density, not generate more documentation for its own sake.

Runtime rollout is separate from code validation. These changes do not restart the shared daemon or alter active tickets.

## Validation

Item 6 full regression suite on Node 22 with test concurrency 2: 493 tests, 487 passed, 6 skipped, no failures. Syntax checks and `git diff --check` passed. Coverage includes bounded inputs with 120 criteria and a large diff, complete detail lookup, immutable packet identities, media inspection/citation checks, and UI reference discovery and worker prerequisites. An earlier Node 25 run hit the existing process-tree timeout test before its child PID file appeared; the Node 22 run passed.

## Item 6 implementation

Independent reviewers now start with a bounded navigation index. Current criteria, behavior groups, changes, check output, constraints and evidence live in immutable, content-addressed files under the run's reviewer session directory. No legacy review history is copied. All criteria remain in the complete index, even when the initial navigation preview is shorter. Existing reviewer roles navigate behavior groups; no additional agent fan-out was introduced.

Images are exposed by current artifact ID through `review_media`, not attached to every prompt. Media inspection is recorded for the packet and validated before accepting media citations. Resumed reviews retain that inspection record; changed packets get new identities. Progressive sessions use a separate versioned directory so the harness does not reopen legacy oversized conversations. Review output records index/prompt character counts and inspected media IDs.

The fixed UI reference is `.agent-plan/design-system.md`. UI plans reuse it when present, or gain a scoped prerequisite to identify existing patterns before implementation. Backend-only plans skip that discovery. UI write steps carry a concise `uiPlan` with reuse, hierarchy, states, interaction, proof and deviations; the existing planner validates those fields. UI workers cannot start without the reference. This repository's initial reference links to its existing styles, rendering code, UI model and journeys, explicitly noting stylesheet inconsistencies.

Rollout remains deferred: implementation and tests run in an isolated worktree and do not reload the shared daemon.
