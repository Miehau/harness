# F09 — Local previews and visual evidence

[Map](../feature-map.md) · [Navigation reference](../feature-navigation.md)

**Load when:** preview ports, browser captures, screenshots, recordings, media identity.

## Behavior and boundaries

**Purpose:** Allocate owned previews and unique ports from repository commands, expose URL/health, capture desktop/mobile Chromium diagnostics and ingest verification-contract screenshot/video evidence. Visual flags on the plan determine required evidence.

**Strength:** Preview lifecycle belongs to its run; unrelated processes are not intentionally killed. Current working-tree changes bind final visual evidence to ticket/run identity and distinguish preview diagnostics from canonical verification evidence.

**Journeys:** The [UI CLI](../../.agent-plan/features/ui-journeys.md) drives rendered controls, asserts criterion-specific outcomes, and captures desktop/mobile screenshots plus native tab recordings when requested. The capture manifest carries criterion IDs, commands and assertions. Unmapped criteria fail; generic screenshots do not stand in for a missing journey.

**Review:** ffprobe/ffmpeg decode each recording and provide a bounded frame sample to the agents. Independent visual verdicts must cite current mapped images, and video criteria must cite sampled recording frames. Motion and timing retain human playback review. Chromium, ffprobe and ffmpeg are required for the recording tests. A successful assertion or recording is evidence for review, not automatic semantic acceptance.

Evidence: [previews.js](../../src/previews.js), [visual-evidence.js](../../src/visual-evidence.js), [visual evidence tests](../../test/visual-evidence.test.js), [proof e2e tests](../../test/e2e-proof.test.js). `visual-evidence.js` and its test are untracked snapshot inputs, not assumed committed capabilities.

## Find the implementation

Read only this feature’s UI/API/CLI/source/test row from the repository root:

```sh
rg -n '^\| \*\*F09\*\*' docs/feature-navigation.md
```

Follow its named symbols into source, then read callers and the focused tests. Load the navigation guide’s fixture recipes only when exercising a journey.

## Follow only relevant edges

- For canonical verification, read [F08 — Verification and corrections](verification.md).
- For final media approval, read [F10 — Final proof gate](final-proof.md).
- For serving or retaining artifacts, read [F13 — Storage and retention](storage.md).
- For preview process ownership, read [F12 — Recovery and process cleanup](recovery.md).

Snapshot: 2026-09-06, `9703dde` plus uncommitted work. [Audit evidence and provenance](audit.md) are optional; verify current source before relying on historical findings.
