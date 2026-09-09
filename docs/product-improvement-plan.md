# Product improvement plan

Discussion consolidated on 2026-09-09. This is an implementation backlog, not a claim that the changes below are complete. No live tickets or executions were created by writing this plan.

## Objective and agreed direction

Make project startup reliable, bring frontend decisions forward, improve the trustworthiness of browser evidence, expose progress and cost clearly, and let an external conversational agent operate the existing harness.

- Keep `Requirements → Explore → Design → Implement → Verify → Handoff`.
- Most meaningful frontend changes require a reviewable UI proposal before product implementation. New panels, screens, forms, navigation, and material interaction changes qualify. Small cosmetic changes such as button colour can be exempt with a visible reason.
- Cost is a usage metric alongside tokens, not a budget or execution limit. Distinguish reported zero, partial data, and unavailable data.
- Keep the project UI CLI as a thin adapter over existing browser tooling. Make its journeys part of planning and verification; do not build another browser framework.
- An external conversational agent shapes and submits work through the existing CLI/API. Pi remains the execution harness; execution, recovery, and gates remain owned by this daemon.
- Preserve localhost operation and JSON persistence. Bot-specific remote connectivity is a later decision once a bot is selected.

## Implementation record

- R1 merged: [PR #13](https://github.com/Miehau/harness/pull/13). Read-only doctor/API and planning prerequisite checks.
- R2: initialization and private dependency preparation implemented; validation and delivery in progress.

## Findings behind the plan

| Area | Current behavior | Gap |
| --- | --- | --- |
| Initialization | Creates Git repositories/baselines and worktrees; initializes jj | Requires installed tools and Pi authentication; missing prerequisites can surface late |
| Dependencies | Links existing node_modules into worktrees | Does not establish reproducible fresh-checkout or changed-lockfile preparation |
| Project contracts | Planning can insert verification and UI-tool bootstrap work | Setup is mixed into feature execution; contract presence does not prove readiness |
| Requirements | Clarification happens without repository tools | Existing-pattern and feasibility discoveries happen later; material changes need an explicit decision |
| Frontend design | Written design, structured uiPlan, design-system reference, final proof review | No dedicated enforced approval of a rendered proposal before implementation |
| UI CLI | Real browser journeys, tests, screenshots/video, worker instructions, canonical verification integration | Some assertions overstate proof; exact AC-text matching is fragile; journeys are not sufficiently visible in planning |
| Observability | Activity events, heartbeat/pulse animations, duration, tokens, calls, corrections | Presentation needs clarity; SDK cost fields are dropped by the usage adapter |
| Orchestration | CLI/API already supports ticket creation, status, answers, steering, approvals, and recovery | Structured intake, retry-safe submission, explicit identities, and checkpoint-safe responses need a cohesive contract |

Assessment evidence: both `.agent-plan/ui.test.mjs` browser tests and all 14 focused project-config/verification-contract tests passed. Browser tests required localhost/browser access beyond the restricted sandbox. This was not a fresh-machine installation test, a full regression run, or a bot integration test.

Specific proof gaps: the current keyboard journey uses programmatic focus rather than keyboard input; DOM clicks do not establish pointer actionability; scenarios claiming cross-project persistence and CLI/API equivalence only inspect a dialog. Passing these tests proves the existing checks run, not those broader claims.

## Delivery sequence

| Order | Slice | Depends on | Completion evidence |
| --- | --- | --- | --- |
| 1 | R1: inspect project readiness | — | Consistent CLI/API readiness results with no mutation |
| 2 | R2: initialize and prepare isolated dependencies | R1 | Empty-directory and fresh-checkout journeys work; reruns preserve user configuration |
| 3 | J1: correct journey evidence and stable mappings | — | Real interaction checks; unrelated screenshots cannot establish a criterion |
| 4 | F1: classify UI impact and bind journeys to the plan | R1, J1 | Reviewable classification, AC, reuse decisions, and evidence mapping |
| 5 | F2: proposal artifacts and approval gate | F1, R2 | New-panel journey pauses for proposal approval and survives restart |
| 6 | O1: durable cost metrics | — | Correct totals across corrections, reload, and restart |
| 7 | O2: readiness, progress, and review presentation | R1, F2, O1 | Clear current work, decision, cost, and final comparison in the UI |
| 8 | A1: structured, retry-safe orchestrator contract | — | Duplicate-safe intake and explicit ticket/run/checkpoint targeting |
| 9 | A2: conversational integration | A1, R2, F2, J1 | Mocked end-to-end conversation-to-delivery journey |

This is the recommended execution order, not a requirement to combine slices into large PRs. O1 and A1 can be implemented independently when useful. Complete readiness and frontend gates before broad unattended orchestration.

## R1–R2: project readiness and initialization

**User outcome:** know whether a ticket can run before spending model calls on planning, and resolve setup failures as setup failures.

Implement `agent-plan doctor` as read-only inspection and `agent-plan init` as repeatable project setup, using shared checks exposed through the API and dashboard. Follow existing command and route conventions rather than duplicating checks.

Check Node, Git, selected VCS availability, Pi authentication/configured model availability where inspectable without a paid call, usable repository history, dependency preparation, deterministic verification, and ticket-relevant preview/capture capability. Report `ready`, `action_needed`, or `not_required`, with a concrete next action and whether a check was actually executed.

Initialization establishes missing repository/project configuration without overwriting existing choices. Provide machine-tool installation guidance; do not silently install system packages. Use explicit named argv commands for project dependency preparation. Reuse the project package manager and lockfile. A greenfield project can configure its install command once manifests exist; it must do so before dependent feature execution.

Run cheap checks before planning and capability-specific checks before dependent execution. Validate applicable baseline verification during setup, recording existing failures separately from feature regressions. Do not rerun every expensive check on every intake. Ensure dependency preparation does not mutate the source checkout through shared worktree links when manifests change.

**Acceptance criteria**

- Missing Git, jj, or authentication is reported before model planning; Git mode does not require jj.
- An empty directory and a fresh checkout each have a documented, tested route to readiness.
- Repeated initialization preserves user files/configuration and explains repairs.
- Missing/changed dependencies are prepared in the correct isolated workspace using project commands.
- Backend tickets do not require browser setup; UI tickets cannot reach dependent execution without usable preview/proof capability.
- CLI and dashboard agree on readiness, failed checks, and corrective actions.

**Likely touchpoints:** `src/cli.js`, `src/routes.js`, `src/worktrees.js`, `src/jj.js`, `src/project-config.js`, planning/admission services, dashboard.

## J1: reliable reusable UI journeys

**User outcome:** evidence demonstrates the claimed behavior and can be replayed reliably.

Retain the existing project CLI and reuse installed browser tooling. Replace programmatic focus as keyboard proof with real Tab/Shift+Tab/Enter/Space actions and outcome assertions as applicable. Use browser input with actionability checks for pointer-dependent criteria. API/seed helpers may arrange isolated state, but UI acceptance must exercise the relevant UI action.

Give reusable journeys stable IDs; bind them to the approved run's criterion IDs rather than matching exact criterion text. Keep scenario data project-specific and migrate current text mappings explicitly. Reuse journey implementations for tests and capture. Do not force backend or persistence-only criteria into screenshot proof: attach appropriate executed tests, with UI media only as supplementary evidence.

**Acceptance criteria**

- Editing criterion wording does not silently lose its journey association.
- Keyboard proof fails when keyboard navigation/operation is broken.
- Persistence/equivalence claims execute the relevant operations and assertions, not merely open a dialog.
- Failures retain the failed action, expected outcome, useful diagnostics, and available media.
- Fixture state is isolated or reset so repeated/mobile/desktop runs do not depend on previous runs.
- Workers can discover supported commands and run a relevant journey through named project commands.
- Backend-only repositories can report UI capability as not applicable without speculative browser scaffolding.

**Likely touchpoints:** `.agent-plan/ui.mjs`, `.agent-plan/ui.test.mjs`, `.agent-plan/ui-scenarios.json`, `scripts/capture-ticket-proof.mjs`, proof-map/visual-evidence modules, project commands and prompts.

## F1–F2: frontend proposal and approval

**User outcome:** review meaningful UI direction before implementation, with approved intent carried into final proof.

Record provisional UI impact in requirements and confirm it after exploration: `none`, `minor`, or `material`. New frontend surfaces default to material. Minor changes record the existing pattern and exemption reason. Let the user override the classification before implementation.

Treat early requirements as approved intent. Exploration may refine technical details, but material changes to scope, AC, or user-visible behavior must be surfaced before implementation. Discover relevant design conventions during exploration/design, rather than leaving those decisions to a later implementation slice.

Within Design, produce a rendered proposal for material UI work and a clickable prototype when interaction is central. Include normal/loading/empty/error/success states as applicable, responsive behavior, keyboard/focus expectations, component reuse, deviations, and planned proof journeys. Reuse project components where practical; keep prototype work isolated and label its evidence as proposal evidence.

Support approve/request-changes on an exact proposal revision. Combine proposal and plan review where both are ready, while allowing the user to request design changes before implementation. Persist approval across restarts, retain prior revisions, and reopen approval for material departures from approved direction. Final review shows the approved proposal alongside the implemented result.

**Acceptance criteria**

- Adding a panel requires a rendered proposal approval; a button-colour edit can use a visible minor-change exemption.
- Auto mode cannot bypass a required proposal gate.
- Every UI criterion has planned behavior/state assertions and an evidence route; scope includes necessary journey updates.
- Stale proposal approvals cannot approve a newer revision.
- Restart restores the pending/approved revision correctly.
- Prototype media cannot be accepted as implementation proof.
- Final review compares the actual result with the approved direction and AC.

**Likely touchpoints:** planning/design-system modules, plan/run state, checkpoints, artifacts, previews, approval/restart routes, final review, dashboard.

## O1–O2: cost and understandable progress

**User outcome:** see what is happening, what needs attention, and reported resource use without opening raw logs.

Carry SDK-reported cost through usage events and durable aggregation by attempt, stage, and run. Include corrections and failed attempts. Preserve totals independently of bounded event history; handle restart/resume without double counting. Explain that reported model cost may differ from billing. Unknown is not zero; mixed reporting produces a partial total. Do not add budget enforcement.

Present current activity, active workers, elapsed time, last activity, tokens, reported cost, calls, and correction count in a compact summary. Clearly label tool calls versus model calls if both are shown. Distinguish working, checking, correcting, awaiting a decision, paused, failed, and disconnected. Use existing activity events and subtle reduced-motion-aware animations; elapsed time alone must not claim progress.

Make every blocker answer: what happened, what action is needed, and what continuing will do. Show readiness results, proposal actions, and journey/assertion results in the same workflow. A replay action targets the isolated ticket preview and identifies state-changing journeys.

**Acceptance criteria**

- Known-zero, partial, and unavailable cost remain distinguishable.
- Totals remain correct across correction rounds, event truncation, reload, and restart.
- Missing legacy cost stays unavailable rather than being fabricated.
- Connection loss is distinct from an agent awaiting a response.
- Active animations stop when work is paused or completed and respect reduced motion.
- The user can identify current work and required action without expanding technical details.

**Likely touchpoints:** `src/pi-harness.js`, `src/activity.js`, usage/inspection projections, `public/ui-model.js`, `public/app.js`, `public/styles.css`.

## A1–A2: conversational orchestrator

**User outcome:** discuss requirements with one external agent, submit tickets, and receive the harness's questions and results in that conversation.

Use the existing CLI/API as the adapter boundary. Add structured submission for requirements, AC, exclusions, dependencies, and provisional UI impact. Separate drafting/submission from execution as needed so discussing a ticket does not accidentally start it. Use persisted idempotency keys; repeated matching requests return the existing ticket, while conflicting reuse is rejected.

Require explicit ticket/run identities for orchestrator mutations and exact checkpoint/revision identities for decisions. Return compact state, required action, and artifact references. Reconnect by observing existing runs rather than resubmitting work. Keep ordinary dashboard and CLI operation interchangeable.

Default authority: draft, inspect, submit/start when instructed, and relay the user's decisions. Additional autonomous start/approval authority must be explicit. UI direction and final proof remain user decisions unless deliberately delegated. No new internal execution-agent layer, notifier, or remote daemon exposure is required for the local adapter.

**Acceptance criteria**

- Multiple tickets in one conversation cannot accidentally operate on the selected dashboard ticket.
- Retried submission creates no duplicate; conflicting idempotency reuse fails clearly.
- Reconnect follows the same run; stale run/checkpoint responses cannot mutate its successor.
- Decisions and their origin are auditable.
- A mock-harness end-to-end test covers submit, clarify, proposal approval, execution, final proof, and completion without real model calls or external messages.
- A selected bot's local invocation, authentication, and artifact-viewing capabilities are checked before claiming that integration works.

**Likely touchpoints:** operator CLI/services, routes, ticket intake, store/run identities, checkpoint actions, adapter instructions and tests.

## Validation and completion

For each slice, refresh the live navigation and test helpers, trace existing call paths, reuse current fixtures, and add focused regression checks for changed behavior. Use `withDaemon`, `invoke`, `seedRun`, and `mockHarness()` for execution tests. Use real isolated browsers for journey behavior; never real Pi calls in automated tests.

Run relevant focused checks during implementation, then `node scripts/test.mjs` and `node scripts/test.mjs --check` before delivery. Run the project UI checks explicitly when browser behavior changes. Update affected feature-map leaves, journeys, command documentation, and the automation spec when contracts change. Existing runs must remain inspectable; new mandatory gates should not silently invalidate historical approvals.

Final integrated demonstration:

1. Initialize a fresh project and resolve readiness blockers.
2. Submit a new-panel ticket through the operator interface.
3. Inspect confirmed UI impact, requirements, and proposed journeys.
4. Request a proposal revision, approve the new revision, and restart the daemon to demonstrate recovery.
5. Execute with isolated dependencies and observe progress/cost.
6. Inspect real interaction assertions and final evidence against the approved proposal.
7. Relay final approval and observe completion from both dashboard and orchestrator interface.
8. Demonstrate that a cosmetic ticket skips proposal review and a backend ticket requires no browser setup.

## Deferred until justified

- Automatic system package installation, a generic browser DSL, commands for every control, a second execution harness, database migration, cost budgets, and new notification infrastructure.
- Exact bot product and remote connectivity; choose after the local contract works.
- Extra workflow stages: use conditional checkpoints within Design unless implementation demonstrates that a separate stage materially simplifies the lifecycle.

Begin with R1/R2 and J1. They make setup dependable and evidence honest; F1/F2 then establish what is approved to build. Observability makes those contracts visible, and the conversational adapter consumes them.
