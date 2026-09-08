# UI journeys — F02 intake, F09 evidence, F14 interfaces

The dashboard is at `/`. Tasks are selected in the left list, then a stage or step opens its inspector; an active retained worker attempt also exposes the steering form and durable steering history. Feature behavior and owning files: [intake](../../docs/features/intake.md), [interfaces](../../docs/features/interfaces.md), [visual evidence](../../docs/features/visual-evidence.md).

```sh
node .agent-plan/ui.mjs tasks list --url http://127.0.0.1:4317
node .agent-plan/ui.mjs tasks open TASK_ID --screenshot /tmp/task.png
node .agent-plan/ui.mjs tasks add "Task description"
node .agent-plan/ui.mjs journey /tmp/scenario.json --screenshot /tmp/proof.png
```

`tasks add` submits New → Task description → Start workflow and starts real work. Use the isolated mocked daemon in `ui.test.mjs` for tests. Other commands navigate through rendered UI; missing or ambiguous controls fail.

A journey runs in one browser session. Example:

```json
{
  "commands": [["tasks", "open", "TASK_ID"], ["stage", "verify"], ["tab", "details"]],
  "assertions": [{"selector": "#ticket-header", "text": "Expected task title"}]
}
```

For verification, add criterion-specific journeys to `.agent-plan/ui-scenarios.json`: an array of objects with `criterion` (exact AC text), `commands`, and `assertions`. Use `$ticketId` as a whole command argument for the active ticket. The capture runner selects only current visual ACs, writes an empty live-ticket manifest when none are selected, and otherwise executes each relevant journey with commands/assertions/criterion IDs beside the screenshots. Missing scenarios fail rather than assigning generic screenshots to unrelated ACs.

Use `--video /tmp/journey.webm` to record the live browser tab with MediaRecorder. The capture runner automatically records criteria whose step requires video; a scenario can also set `video: true`. Recordings require ffmpeg on PATH; missing recording/decoder tools fail verification. The harness decodes recordings with ffprobe/ffmpeg, supplies sampled frames to reviewers, and retains human playback approval; a screenshot-derived video is not acceptable.
