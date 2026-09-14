# UI evidence (frontend tasks only)

Read this page when the task changes frontend behavior/appearance or config.json
contains uiEvidence. Browser control belongs to the target project: read its
instructions and reuse its CLI/tests. The harness does not prescribe a browser CLI.

Planning must map changed acceptance criteria to browser assertions and screenshots
or video, including relevant viewport sizes and interaction/error states. Include
this page's artifact reference in frontend assignments. If the project has no UI
verification command, establish one in the implementation; surface any tooling or
configuration blocker rather than claiming verification. uiEvidence is an owner
configuration snapshot: workers cannot enable or disable the gate for an existing task.

Workers exercise the actual application, assert observable behavior, and capture
screenshots or finalized WebM/MP4 videos. Publish media with
runner_action({action:"publish",input:{path:"relative/path.png"}}).
Inspect screenshots for layout, clipping, legibility and relevant responsive states.
Video is returned as metadata/localPath, not an image tool block; use the inspector
for playback and publish still screenshots for model visual inspection.
Record what was inspected and any limitations in the handoff. File presence alone
is not proof of correct behavior or appearance.

Final evidence must come from the integrated candidate. With uiEvidence configured,
verify runs the project's named command and imports its manifest/media into immutable
artifacts. The command owns starting/stopping the candidate application, isolation
from other tasks, browser checks and capture. Use RUNNER_UI_DIR for outputs; write
manifest.json there using RUNNER_UI_COMMIT and RUNNER_UI_RUN_ID:

```json
{
  "commit": "<RUNNER_UI_COMMIT>",
  "runId": "<RUNNER_UI_RUN_ID>",
  "passed": true,
  "criteria": [
    {"id":"AC-1","assertion":"Submitting the form shows the saved value",
     "passed":true,"files":["saved.png","flow.webm"]}
  ]
}
```

Every criterion needs a passing assertion and 1–4 media files relative to that output
directory. Include every changed acceptance criterion; the runtime validates structure
and freshness, while the coordinator reviews coverage and the screenshots. PNGs are
limited to 10 MB and videos to 25 MB. Headers are checked, not full media decoding.
Missing/failed/mismatched evidence fails verification. Acceptance reruns the same
command after rebase. A project command is trusted code; it must really test the
candidate and must not copy old captures while claiming a new run.

After verification, read verification.uiEvidence.artifact and inspect its media.
Reference that manifest and the visual review in the final handoff. Completion exposes
the manifest and up to four media attachments to the supervisor/Grok adapter; the
manifest retains all references. For earlier feedback use coordinator surface or ask
with explicit attachments. Use ask only for an actual blocking owner decision.
Video/large-file webhook entries carry an authenticated read request, never public
URLs or owner credentials. A remote bot needs a trusted local adapter to retrieve
and relay media; HTTP acceptance alone does not prove that it displayed the evidence.
