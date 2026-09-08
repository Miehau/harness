# F01 — Workspace and credential setup

[Map](../feature-map.md) · [Navigation reference](../feature-navigation.md)

**Load when:** repository selection, tracker secrets, local API access.

## Behavior and boundaries

**Purpose:** Attach the local daemon to a repository and configure ticket providers. Workspace selection, tracker credentials, project mode and stage defaults are accessible from dashboard dialogs; the server persists configuration separately from individual runs.

Directory access is a per-project policy (`restricted` or `any`, plus extra roots) stored on the daemon as `projectPolicies` keyed by canonical primary path, not in `project.json` or global settings. The workspace dialog (`#access-policy-form`) and CLI `access show|set` read and write `GET`/`POST /api/workspace/access-policy`. Missing policy is restricted and primary-only. Invalid saves return 400 and leave the previous policy unchanged. Each ticket run freezes the effective policy onto `run.access` at creation.

Before feature execution, missing harness files trigger a setup step that creates `.agent-plan/project.json`, `verify.mjs`, `feature-map.md`, `ui.mjs`, and `ui.test.mjs`. The agent reuses existing feature documentation and browser tooling. An existing UI gets a tested initial journey; an empty or non-UI repo gets an explicit unavailable result until its first UI feature. See the [progressive discovery entry](../../.agent-plan/feature-map.md).

**Strength:** Tracker secrets live in an owner-only credential file or environment, rather than run state. Named project commands use a minimal environment and explicitly allowed ignored env files; command output is redacted. Optional API-token authorization exists.

**Limit:** Local daemon availability depends on the host staying awake and running. Pi authentication is external to this app. Custom Pi extensions retain their own authority; scoped built-in tools are not a universal extension sandbox.

Evidence: [credentials.js](../../src/credentials.js), [access-policy.js](../../src/access-policy.js), [project-config.js](../../src/project-config.js), [http.js](../../src/http.js), [credentials tests](../../test/credentials.test.js), [access-policy tests](../../test/access-policy.test.js), [project config tests](../../test/project-config.test.js).

## Find the implementation

Read only this feature’s UI/API/CLI/source/test row from the repository root:

```sh
rg -n '^\| \*\*F01\*\*' docs/feature-navigation.md
```

Follow its named symbols into source, then read callers and the focused tests. Load the navigation guide’s fixture recipes only when exercising a journey.

## Follow only relevant edges

- For provider connection or intake, read [F02 — Ticket intake](intake.md).
- For Pi authentication or model settings, read [F05 — Pi and workflow gates](pi-workflows.md).

Snapshot: 2026-09-06, `9703dde` plus uncommitted work. [Audit evidence and provenance](audit.md) are optional; verify current source before relying on historical findings.
