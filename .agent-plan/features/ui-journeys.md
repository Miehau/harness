# UI journeys — F02 intake, F09 evidence, F14 interfaces

The dashboard is at `/`. Tasks are selected in the left list, then a stage or step opens its inspector; an active retained worker attempt also exposes the steering form and durable steering history. Top-bar **Repository** opens the workspace dialog for the primary path and the current project's directory access policy. Feature behavior and owning files: [intake](../../docs/features/intake.md), [interfaces](../../docs/features/interfaces.md), [visual evidence](../../docs/features/visual-evidence.md), [setup](../../docs/features/setup.md).

```sh
node .agent-plan/ui.mjs tasks list --url http://127.0.0.1:4317
node .agent-plan/ui.mjs tasks open TASK_ID --screenshot /tmp/task.png
node .agent-plan/ui.mjs tasks add "Task description"
node .agent-plan/ui.mjs workspace open --screenshot /tmp/access-policy.png
node .agent-plan/ui.mjs journey /tmp/scenario.json --screenshot /tmp/proof.png
node src/cli.js access show
node src/cli.js access set '{"mode":"restricted","extraRoots":[]}'
```

`tasks add` submits New → Task description → Start workflow and starts real work. `workspace open` loads the current project's policy into `#workspace-dialog` (primary, extra roots as saved, Restricted or Any access). `workspace save-policy` submits only on that explicit control; closing the dialog does not persist. Starting a ticket freezes the then-current policy onto that run, so later Any-access or extra-root edits do not enlarge it. Use the isolated mocked daemon in `ui.test.mjs` for tests. Other commands navigate through rendered UI; missing or ambiguous controls fail. Never enable Any access against the operator checkout; seed extra roots in a temp daemon.

A journey runs in one browser session. Example:

```json
{
  "commands": [["tasks", "open", "TASK_ID"], ["stage", "verify"], ["tab", "details"]],
  "assertions": [{"selector": "#ticket-header", "text": "Expected task title"}]
}
```

For verification, add criterion-specific journeys to `.agent-plan/ui-scenarios.json`: an array of objects with `criterion` (exact AC text), `commands`, and `assertions`. Use `$ticketId` as a whole command argument for the active ticket. Access-policy proof may use `$evidenceRoot`; the capture runner creates that isolated directory, substitutes its absolute path in commands and value assertions, and can therefore save then reload a real extra root without relying on the operator's existing policy. Named `capture-proof` (`node scripts/capture-ticket-proof.mjs`) is the harness visual command; it is not part of `verify.mjs`. The capture runner selects only current visual ACs, writes an empty live-ticket manifest when none are selected, and otherwise executes each relevant journey on desktop and mobile with commands/assertions/criterion IDs beside the screenshots. Missing scenarios fail rather than assigning generic screenshots to unrelated ACs.

Use `--video /tmp/journey.webm` to record the live browser tab with MediaRecorder. The capture runner automatically records criteria whose step requires video; a scenario can also set `video: true`. Recordings require ffmpeg on PATH; missing recording/decoder tools fail verification. The harness decodes recordings with ffprobe/ffmpeg, supplies sampled frames to reviewers, and retains human playback approval; a screenshot-derived video is not acceptable.

## Run inspection

`stage verify` shows criteria, current finding states, and review/correction history in the main pane. A completed correction remains awaiting independent review until a subsequent review resolves it. The Activity pane uses saved milestones when a transcript is absent. Worker Output updates in place during streaming; saved attempts use retained session output or the worker report. Cleanup is no longer an inspector tab; actionable process warnings remain in run notices.

Regression/proof: `AGENT_PLAN_INSPECTION_PROOF=/tmp/inspection node scripts/test.mjs dashboard` captures the verification summary, criteria, and streamed worker output using isolated mocked daemons. The browser checks reload, evidence retention, and stable output elements during streaming.

Token counters use cumulative usage retained independently of bounded activity logs. Active workers contribute immediately; saved attempts retain totals on completion. Older runs use available usage events and mark totals partial; missing usage is shown as “—”, not zero. The streaming browser regression also checks token totals before and after reload.
