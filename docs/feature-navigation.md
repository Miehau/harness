# Feature navigation for agents

Inspected 2026-09-06 against the working tree, including existing uncommitted visual-evidence work. Start with [feature-map.md](feature-map.md) and load only the matching feature leaf for meaning and boundaries and [the interactive review](feature-review.html) for prioritized findings; this file answers **where to go, what to invoke, and how to verify**. IDs F01–F15 match that map. Paths are repository-relative; symbols are more stable than line numbers.

## Read only the needed row

After choosing a feature in the map, extract its entry without loading this entire guide (substitute the selected F-ID):

```bash
rg -n '^\| \*\*F07\*\*' docs/feature-navigation.md
```

Read the runtime/fixture sections below only when running the app or reproducing a journey. Feature leaves own behavior and boundaries; this guide owns entry points and commands.

## Start here every session

Follow [the repository skill](../.agents/skills/agent-plan/SKILL.md), then run from the repository root:

```bash
node scripts/nav.mjs --json
node scripts/test.mjs --map
node scripts/seed.mjs --list
node src/cli.js --help
git status --short
```

Use `node scripts/nav.mjs routes`, `ui`, `cli`, `modules`, or `stages` to narrow the live inventory. Its source parser is a locator, not a complete API schema: it normalizes every captured ID to `:id`, only recognizes particular route expressions, lists static HTML IDs rather than dynamic inspector controls, and currently omits `list`, `backlog`, and `timeline` CLI branches. CLI `--help` plus [src/cli.js](../src/cli.js) resolves those omissions. `test --map` means matching test filenames, not measured coverage; `http.js` is exercised indirectly by daemon tests.

The application is one dashboard at `/`, not a router with a page per feature. Select a ticket, then a stage or step in the graph, then an inspector tab. Selection is persisted locally; there are no dedicated feature deep links.

## Runtime and safe inspection

```bash
npm start -- --cwd /absolute/path/to/repository
node src/cli.js status
node src/cli.js list backlog
node src/cli.js list timeline <ticketId>
```

Default URL: `http://127.0.0.1:4317`. Server options include `--cwd`, `--port`, `--host`, and `--vcs git|jj` (default `jj`). Persistent data defaults to `~/.agent-plan-workspace`; override with `AGENT_PLAN_DATA_DIR`. CLI honors `AGENT_PLAN_URL` and `AGENT_PLAN_API_TOKEN`. Test/checkpoint polling honors `AGENT_PLAN_WAIT_MS` and `AGENT_PLAN_POLL_MS`.

`GET /api/state`, `/api/health`, `/api/tickets/:ticketId/run`, and `/api/tickets/:ticketId/review-packet` are useful read paths. **`GET /api/tickets` refreshes trackers and may admit ready tickets when automatic intake is enabled**, so `list backlog` is not guaranteed to be side-effect-free. Use an isolated fixture for exploratory work.

Do not overwrite user state or use `store.update` to simulate an operator journey. Seed initial conditions with the helpers, then use CLI/API actions. Creating a task, approving, accepting, resuming, and approving final proof can launch workers or delivery; inspect fixture gates without advancing them when no live model run is intended.

## Feature entry points

`T` below means `/api/tickets/:ticketId`; `S` means `T/steps/:stepId`. All action routes listed here are `POST` unless marked `GET`.

| ID | UI journey / stable selector | API and CLI entry | Implementation anchors | Focused test filters |
|---|---|---|---|---|
| **F01** Workspace / credentials | Top bar **Repository** (`#workspace-settings`) → Choose / Open repository. Queue footer **Trackers** (`#tracker-settings`). | `/api/workspace`, `/api/workspace/pick`; `GET` + `POST /api/tracker-settings`. No direct workspace/credential CLI command. | [server.js](../src/server.js): `createDaemon`, `pickDirectory`, `trackerHub`; [credentials.js](../src/credentials.js): `CredentialStore`, `effectiveTrackerCredentials`; [http.js](../src/http.js). | `credentials daemon-lock server` |
| **F02** Ticket intake / admission | **New** (`#free-text-open`) → description → Start workflow. Or Refresh → select tracker ticket → start. Agent setup → Project mode enables automatic intake. | `T/start` with `{ticket}`; `/api/tickets/start`; `GET /api/tickets`; `new text <prompt>`, `start <ticketId>`, `list backlog`. | [server.js](../src/server.js): `beginTicket`, `refreshTrackers`, `admitAutomaticTickets`; [admission.js](../src/admission.js): `admissionCandidates`; [trackers.js](../src/trackers.js): `TrackerHub`; [ui-model.js](../public/ui-model.js): `freeTextTicket`. | `admission trackers linear jira e2e-automation cli` |
| **F03** Requirements / exploration | Select ticket → requirements questions in header → answer / approve; select Requirements or Explore stage → Activity, Prompt, Artifacts, Details. | `T/clarify` with `{answers}`; `answer <ticketId> <text>` or `answer <ticketId> --approve` when no unanswered required questions remain. | [server.js](../src/server.js): `prepareTicket`, `acceptCheckpointAnswer`, `continueAfterRequirements`, `designTicket`; [pi-harness.js](../src/pi-harness.js): `PiHarness`; [execution.js](../src/execution.js): `runStageDefs`. | `pi-flow e2e-daemon server` |
| **F04** Plan edit / approval | Plan approval checkpoint → **Edit graph JSON** → JSON → Save plan; **Run manually** or auto action. Gate fixture: `plan-approval`. | `T/plan` with `{plan}`; `T/approve` with `{auto}`; `approve [ticketId] [--auto]`. CLI has no edit-plan command. | [plan.js](../src/plan.js): `normalizeEditedPlan`, `planReviewViolations`, `blockingReasons`; [execution.js](../src/execution.js): `planApprovalPending`; server approval route initializes proof map. | `plan execution server` |
| **F05** Profiles / skills / workflows | Top-bar **Agent setup** (`#profile-settings`) → models / reasoning / instructions; workflow gates appear in ticket header. Some advanced operations are API/CLI only. | `GET /api/models`, `/api/skills`, `T/skills`; `/api/stage-profiles`; `T/stage-profiles/:profileId`; `T/workflow`, `T/workflow/continue`; `profile <stage> <model> <thinking> [ticketId]`. | [profiles.js](../src/profiles.js): `normalizeStageProfiles`; [workflow.js](../src/workflow.js): `applyPendingWorkflowGate`, `applyWorkflowContinuation`; server `skillSession`, `continueWorkflowThenResume`; Pi `activateWorkflow`. | `profiles profile-override workflow server` |
| **F06** Isolated execution / VCS | Approve plan → implementation graph → select worker → Activity / Details; inspector footer identifies worktree and jj revision. | `T/approve`, `T/resume`, `S/accept`; `approve`, `resume`, `accept`. Execution is orchestration, not a separate public launch-worker route. | Server `runTicket`, `advanceTicket`, `executeStep`, `acceptStep`; [execution.js](../src/execution.js): `nextRunnableBatch`; [worktrees.js](../src/worktrees.js): `ensureTicketWorktree`, `createParallelWorktrees`, `integrateBranch`; [git.js](../src/git.js), [jj.js](../src/jj.js). | `execution worktrees git jj pi-flow e2e-daemon` |
| **F07** Step review / criterion proof / diffs | Select review-ready step → Diff or Details → inspect criteria → Accept commit / Request changes. Diff includes semantic review-map action and queued section notes. Fixture: `review-ready`. | `S/accept`, `S/changes`, `S/review-map`; `GET T/proof/diff`, `T/proof/check-output`, `T/review-packet`; `accept <stepId> [ticketId] [--auto]`; see [correction payloads](#correction-payloads). | [proof-map.js](../src/proof-map.js): `initializeProofMap`, `proofEligibility`, `resolveEvidence`; [ui-model.js](../public/ui-model.js): `proofMapView`; [app.js](../public/app.js): `stepDiffPanel`, `criterionProofHtml`, `renderInspector`; server `canonicalDiffOutput`. | `proof-map criterion-proof-flow review-packet ui-model e2e-proof` |
| **F08** Verification / correction | Worker Activity / Details shows checks and correction history; a blocked verifier can be resumed, scope-expanded or waived through CLI. | `S/changes`, `S/scope` with `{paths,reason}`, `S/waive` with `{reason}`; `scope-add <stepId> <ticketId> <path> <reason>`, `waive <stepId> <ticketId> <reason>`. | [project-config.js](../src/project-config.js): `runProjectCommand`, `runManagedCommand`; [pi-harness.js](../src/pi-harness.js): `projectCommandTool`, `scopedWorkerTools`, `ensureVerificationContractStep`; server `runChecksWithPreview`, `finalReviewLoop`; execution `shouldPauseCorrection`. | `project-config verification-contract pi-harness process-containment proof-restarts` |
| **F09** Preview / visual evidence | Ticket header → start / stop live preview; verification artifacts show screenshots or recordings. | `T/preview` with `{action:"start"}` or `"stop"`; `GET T/artifacts/:artifactId/media`; `preview start|stop [ticketId]`. | [previews.js](../src/previews.js): `PreviewManager`; [visual-evidence.js](../src/visual-evidence.js): `applyVerifyEvidenceGate`, `ticketBoundVisualEvidence`; server `startOperatorPreview`, `runChecksWithPreview`; [artifacts.js](../src/artifacts.js). | `previews visual-evidence artifacts e2e-proof` |
| **F10** Final proof approval | Evidence-review checkpoint → inspect proof / tests / screenshots → **Approve & deliver** or Request changes with affected criteria. Fixture: `proof-review`. | `T/evidence/approve`, `T/evidence/changes`, `T/review-fix/restart`; `approve-proof [ticketId]`, `restart-fixer <ticketId> <reason>`; `T/context/approve` is a compatibility alias to the same gate. | Server `completeCleanReview`, `finishHandoff`, `applyFinalReviewFix`, `finalReviewLoop`; execution `restartReviewFixSession`, `recoverableCleanReview`; proof-map `invalidateProof`. | `e2e-proof proof-restarts criterion-proof-flow server` |
| **F11** Delivery / tracker writeback | After final proof approval → Handoff Activity / artifacts / review packet. Delivery progresses asynchronously. | `T/evidence/approve` starts downstream delivery; no dedicated CLI merge command. `status <ticketId>` / `GET T/run` observes it. | Server `scheduleTicketIntegration`, `scheduleRemoteDelivery`, `fixRemoteFeedback`, `trackerAction`, `mirrorCheckpoint`; [delivery.js](../src/delivery.js): `GitHubDelivery`, `GitLabDelivery`, `safeSyncLocal`; [merge-queue.js](../src/merge-queue.js): `enqueueSerial`; [linear.js](../src/linear.js), [jira.js](../src/jira.js). | `delivery merge-queue e2e-automation linear jira` |
| **F12** Recovery / process cleanup | Header Pause / Resume / Restart; Restart dialog selects saved point and requires confirmation. Stage or worker → Cleanup. Fixtures: `interrupted`, `needs-attention`. | `T/pause`, `T/resume`, `T/cancel`, `T/restart`; `pause`, `resume`, `cancel`; `restart <ticketId> [target] --confirm`. Targets: `fresh`, `stage:explore`, `stage:design`, `stage:verify`, or valid `step:<id>`. | Server `pauseTicket`, `resumeTicketPipeline`, `restartFrom`, `startFreshRun`, `settleContainment`, `close`; execution `rewindRun`, `prepareRunResume`, `completeRunCleanup`; [process-containment.js](../src/process-containment.js), [process-tree.js](../src/process-tree.js); [store.js](../src/store.js). | `restart run-status process-cleanup-e2e process-containment process-tree store` |
| **F13** Artifacts / retention | Stage or worker → Artifacts → select artifact / open externally. Top bar storage icon (`#retention-open`) → select retained runs → Clean selected → confirm. | `GET T/artifacts/:artifactId`, `T/artifacts/:artifactId/open`; `GET /api/retention`, `/api/retention/cleanup` with `{ticketIds,confirmed:true}`; `T/forget` with confirmation; `/api/queue/clear`; `queue clear`. | [artifacts.js](../src/artifacts.js): `persistArtifact`, `hydrateArtifact`, `artifactPathInDataDir`; [retention.js](../src/retention.js): `retentionInventory`, `cleanupRetainedRun`; execution `archiveRun`, `clearInactiveRuns`; [store.js](../src/store.js): `JsonStore`. | `artifacts retention store server` |
| **F14** Dashboard / CLI / observability | Ticket queue → filter → ticket → stage / worker inspector. Activity is streamed; Prompt/Artifacts/Details/Cleanup expose persisted evidence. | `GET /api/events` (SSE), `/api/state`, `T/run`, `T/stages/:stageId/prompts`, `S/session-trace`; `select <ticketId>`, `status [ticketId]`, `list timeline [ticketId]`, `wait [ticketId]`. | [app.js](../public/app.js): `render`, `selectTicket`, `renderInspector`, EventSource handlers; [ui-model.js](../public/ui-model.js): `eventTimeline`; [execution.js](../src/execution.js): `createActivityCapture`, `publicRun`, `publicState`; [cli.js](../src/cli.js): `runCli`; [http.js](../src/http.js). | `cli ui-model markdown server scripts` |
| **F15** Local fixtures / helper tools | New → **Load fixture…** (`#local-load-open`) → fixture directory → Load; choose plan gate. | `/api/local/load` with `{path}`. `node scripts/seed.mjs <scenario> --json`; `node scripts/nav.mjs`; `node scripts/test.mjs`. | [local.js](../src/local.js): `loadLocalFixture`; [scripts/seed-state.js](../scripts/seed-state.js): `writeSeed`; [scripts/harness.js](../scripts/harness.js): `withDaemon`, `invoke`; [test/helpers.js](../test/helpers.js): `runAgainstDaemon`; [fixtures/zero-state-task-board](../fixtures/zero-state-task-board). | `local scripts cli e2e-daemon` |

## Operator journey and parity caveats

Run these only against a daemon intended for execution. Each approval has real effects:

```bash
node src/cli.js new text "Add an empty-state heading"
node src/cli.js list backlog
node src/cli.js select <ticketId>
node src/cli.js wait
node src/cli.js answer <ticketId> "Answers to the open questions"
node src/cli.js wait
node src/cli.js approve <ticketId>
node src/cli.js list timeline <ticketId>
node src/cli.js accept <stepId> <ticketId>
node src/cli.js approve-proof <ticketId>
```

This is a checkpoint outline, not a script to run blindly: requirements can require more rounds, technical questions can appear, and several steps can need acceptance. `wait` returns on checkpoints; failure / `needs_attention` returns exit 1. A successful `wait` does not by itself mean the whole ticket completed. Commands with omitted ticket ID resolve the selected ticket.

### Profile keys

Profile keys differ from graph stage IDs: profiles are `requirements`, `exploration`, `architecture`, `implementation`, `verification`, `commit`, `handoff`; graph stages are `requirements`, `explore`, `design`, `implement`, `verify`, `handoff`.

### Correction payloads

**Known parity gap at inspection:** CLI `revise <stepId> <ticketId> <feedback>` and `revise-proof <ticketId> <feedback>` send no `criterionIds`; the server rejects corrections without them when the run has a proof map. The UI's queued semantic-note submission also omits these IDs. Use the normal UI Request changes form and select affected criteria, or send an explicit API body with `{feedback, criterionIds:[...]}`. Never invent IDs: read them from the run proof map. See server `explicitCriterionIds` and the `steps/.../changes` / `evidence/changes` handlers.

### Queue and retention actions

Queue **Clear** removes non-running queue items while retaining files; **Forget** removes a run from active state; **retention cleanup** removes retained artifacts/worktrees/local branches/previews. These are different operations. Consult the server guards and inventory before deleting retained data.

## Safe fixture recipes

Generate a fresh temporary state and cwd, ignoring any inherited production directory overrides:

```bash
env -u AGENT_PLAN_DATA_DIR -u AGENT_PLAN_CWD node scripts/seed.mjs plan-approval --json
```

The JSON returns `dataDir`, `cwd`, `stateFile`, and `ticketId`. Start a separate dashboard using those exact returned paths and a spare port:

```bash
AGENT_PLAN_DATA_DIR=<returned-dataDir> npm start -- --cwd <returned-cwd> --port 4318
AGENT_PLAN_URL=http://127.0.0.1:4318 node src/cli.js status
```

The CLI seed command does **not** inject a mock Pi harness when it starts the daemon. A rendered gate is safe to inspect, but clicking approve/resume can call the real configured harness. For actual progression tests use `withDaemon` and a mock.

| Scenario | Best for | Important limit |
|---|---|---|
| `empty` | New task / settings / empty queue | No ticket run. |
| `plan-approval` | Plan dialog and approval controls | Zero-state fixture, not the user's real repository. |
| `review-ready` | Worker review controls | Synthetic slice; not proof of a completed real execution. |
| `proof-review` | Final proof checkpoint presentation | Uses a tiny synthetic PNG and synthetic checks; not visual QA evidence. |
| `interrupted` | Resume/restart UI | In-flight statuses are marked interrupted on load. |
| `needs-attention` | Blocker / correction UI | Synthetic stalled correction. |
| `clarifying` | Requirement-state recovery | Daemon load marks its in-flight status interrupted; not a stable live clarifying screen. |

[JsonStore.init](../src/store.js) reconciles in-flight states on startup. Do not hand-write `state-v3.json` or assume the serialized status survives loading. `--data-dir` and `--cwd` are accepted by the seed helper, but only use explicit disposable locations.

A complete model-free CLI smoke journey, using the existing test helpers:

```bash
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { withDaemon, runAgainstDaemon, mockHarness } from './test/helpers.js';
await withDaemon(async (daemon) => {
  const created = await runAgainstDaemon(daemon, ['new', 'text', 'Add an empty-state heading']);
  assert.equal(created.code, 0);
  assert.equal(created.json.accepted, true);
  const backlog = await runAgainstDaemon(daemon, ['list', 'backlog']);
  assert.ok(backlog.json.tickets.some(ticket => ticket.id === created.json.ticketId));
}, { harness: mockHarness() });
JS
```

This stops after intake; `mockHarness()` implements only a basic subset. For deeper runs reuse the purpose-built mocks in `test/pi-flow.test.js`, `test/e2e-proof.test.js`, or `test/e2e-automation.test.js`, rather than assuming the basic mock executes every stage. `withDaemon` uses no listening socket and cleans its temporary directories; `runAgainstDaemon` exercises the real CLI through `invoke`.

## Verification and change navigation

```bash
node scripts/test.mjs cli scripts
node scripts/test.mjs proof-map criterion-proof-flow
node scripts/test.mjs -- --test-name-pattern "your existing test name"
node scripts/test.mjs
node scripts/test.mjs --check
```

Filters are **OR substring matches against test filenames**; inspect `node scripts/test.mjs <filter> --list` if selection is unclear. `--check` runs Node syntax checks for `src`, `public`, and `scripts` JavaScript, not a browser test or type checker. Prefer existing focused integration tests for cross-cutting behavior.

For any fix, trace the complete path before editing:

```bash
rg -n 'symbolName|/api/relevant-route' src public scripts test
```

For a product contract read [automation-harness-spec.md](automation-harness-spec.md); for planned work read [hardening-plan.md](hardening-plan.md). For named worker commands read [.agent-plan/project.json](../.agent-plan/project.json); deterministic repository verification starts at [.agent-plan/verify.mjs](../.agent-plan/verify.mjs). Avoid launching visual capture/verification blindly while mapping: it can start browsers and child processes. `src/camera-control.js` and `npm run camera` are unrelated utilities; leave them outside the ticket-workflow investigation unless explicitly requested.

## Maintaining these references

When behavior changes, rerun the three helper inventories, verify affected HTTP payloads against `src/server.js` and CLI parsing against `src/cli.js`, then update the corresponding stable F-ID in both Markdown artifacts. Keep findings distinguished from product intent and do not promote fixture output or filename test pairing to runtime evidence. Existing uncommitted changes belong to their author; do not reset them during navigation.
