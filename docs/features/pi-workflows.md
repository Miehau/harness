# F05 — Pi sessions, profiles, skills and workflow gates

[Map](../feature-map.md) · [Navigation reference](../feature-navigation.md)

**Load when:** model profiles, sessions, skills, prompt traces, workflow checkpoints.

## Behavior and boundaries

**Purpose:** Run one supervisor with per-step worker sessions, fresh/seeded/fork context policies, configurable role profiles, discovered skills and prompt artifacts. Bound workflows create typed input/approval checkpoints that block execution until continued.

Every Pi session (exploration, planning, workers, reviewers, verify) wraps SDK file tools with the frozen `run.access` snapshot: realpath plus a path-segment allow-list, including search results and symlink targets. Writes then apply step `writeScope` relative to the matched root (unqualified legacy scopes stay primary-only). Extra roots are actually readable through those wrapped tools. Named `project_command` calls are argv/env allow-lists, not OS filesystem isolation; plan approval discloses that limitation.

**Strength:** Model settings and prompt/session traces remain inspectable. Workflow gates are durable state, rather than instructions buried only in prose. Rate-limit exhaustion becomes an operator checkpoint.

**Limit:** Pi is the only execution harness. Profiles do not imply alternate orchestrators. Skill execution and model calls require working local Pi setup.

Evidence: [pi-harness.js](../../src/pi-harness.js) (`scopedWorkerTools`), [profiles.js](../../src/profiles.js), [workflow.js](../../src/workflow.js), [workflow tests](../../test/workflow.test.js), [pi-harness tests](../../test/pi-harness.test.js), [profile override tests](../../test/profile-override.test.js).

## Find the implementation

Read only this feature’s UI/API/CLI/source/test row from the repository root:

```sh
rg -n '^\| \*\*F05\*\*' docs/feature-navigation.md
```

Follow its named symbols into source, then read callers and the focused tests. Load the navigation guide’s fixture recipes only when exercising a journey.

When configuring profiles, load [profile keys](../feature-navigation.md#profile-keys); they differ from graph stage IDs:

```sh
rg -n -A4 '^### Profile keys' docs/feature-navigation.md
```

## Follow only relevant edges

- For requirements-stage prompts, read [F03 — Requirements and exploration](requirements.md).
- For worker execution, read [F06 — Execution and VCS](execution.md).
- For interrupted session recovery, read [F12 — Recovery and process cleanup](recovery.md).

Snapshot: 2026-09-06, `9703dde` plus uncommitted work. [Audit evidence and provenance](audit.md) are optional; verify current source before relying on historical findings.
