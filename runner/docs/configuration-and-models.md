# Configuration and models

Repository configuration is owner-maintained, versioned with the target repository,
and snapshotted at task submission.

## Project configuration

Create `.agent-plan/project.json` manually or start with:

```sh
agent-plan init /absolute/repo '["npm","test"]'
```

Example:

```json
{
  "commands": {
    "install": ["npm", "ci"],
    "test": ["npm", "test"]
  },
  "setup": "install",
  "verify": ["test"],
  "maxWorkers": 2,
  "maxAttempts": 12,
  "timeoutMinutes": 60,
  "commandTimeoutMs": 120000
}
```

Commands are argv arrays and are never interpolated shell strings. A configured setup
command runs in each new worktree. Command output streams to evidence files. Put every
required final check in `verify`. Named commands execute as the runtime user, so only
configure trusted repositories and commands.

Optional top-level `provider` and `model` select the coordinator model; otherwise OMP's
configured default is used. The runner is installed once and can target any Git root;
the target repository needs no dependency on this repository or its retired daemon.

## Workflows

`.runner/workflow.md` replaces the bundled coordinator entry point. The bundled
[workflow](../workflow.md) links to focused reference pages and describes tools and a
suggested method, not mandatory stages. Workers receive the bundled
[worker instructions](../worker.md). Agents can also read the target repository's
`AGENTS.md` through their scoped file tools.

All bundled workflow pages are snapshotted into a task. Existing tasks keep their old
snapshots. A custom workflow should preserve any required repository-specific
documentation policy. Runtime permissions, identity, concurrency, receipts, review,
and verification remain enforced independently of Markdown instructions.

## Repository aliases

```sh
agent-plan repo add demo /absolute/path/to/repo
agent-plan repo list
agent-plan start demo "Implement the next story"
agent-plan onboard demo
agent-plan repo remove demo
```

Aliases also work with `init` and `submit`. They live under the runner data root in
`repos/`; `RUNNER_DATA` selects an independent collection. Registration requires an
existing Git repository root. Removing an alias never removes its repository or tasks.
Remove and add again to change a target. Use `./demo` to choose a local directory whose
name conflicts with an alias.

## Onboarding and repository discovery

```sh
agent-plan onboard /repo --model MODEL
```

Onboarding is an ordinary isolated task. It creates or improves:

- `verify.sh` and runner configuration;
- for interactive systems that need one, a committed project verification skill with
  launch, doctor, drive, evidence and cleanup instructions;
- an experimental `.runner/feature-map.md` linking focused feature documents;
- `.runner/architecture.md` for brownfield concepts, boundaries, patterns, and
  conventions when the repository has enough evidence.

The reusable instructions live in [onboarding.md](../onboarding.md). Feature maps
distinguish observations, inferences, test evidence, and uninspected areas. Existing
curated documentation is preserved and linked. Empty repositories explain why
architecture was skipped rather than inventing it. DDD terms are used only when the
code supports them.

If configuration is absent, onboarding first creates a minimal project file. It also
adds `.pi/`, `.runner/answers/`, and `.runner-ui-*/` to `.gitignore` and commits that
file when needed. The onboarding candidate must pass both existing checks and
`bash verify.sh`; review and integrate it like any other candidate. A zero exit status
does not prove the test suite is meaningful.

Generated verification skills are added to the project's selected `skills` and use
named commands for helper scripts. Re-running onboarding audits an existing skill and
its feature recipes rather than creating a competing harness. The audit reports
`clean`, `changed` or `blocked`; product regressions remain product work, not doc fixes.

Each task records `discovery.json` with committed feature-map, architecture, and
features-directory paths. Agents receive paths, not bulk contents, and load only the
relevant documents. Missing docs are normal. Commit discovery files before starting a
task if agents should see them.

The bundled workflow maintains feature documentation alongside changed capabilities.
New features add a focused document and map entry; changed or removed capabilities
update relevant links. Architecture changes only when concepts or boundaries change.
During parallel work, one worker owns shared index edits. A repository without a map
starts with a small, explicitly partial map; a small fix does not trigger full
onboarding. This is workflow policy, not a semantic completeness check.

## Delegated stages

The main conversation owns architectural choices; the coordinator selects preparation
stages within that scope, based on uncertainty and risk. Small fixes,
cleanup, and deletions may proceed directly from clarification to implementation,
verification, and independent review. Discovery is for uncertain impact; architecture
is for unresolved design choices and requires at least three independent proposals
against the same committed base, returned to the main conversation for agreement.
Run proposals in batches if maxWorkers is below three. Planning workers are for
substantial sequencing or multiple assignments. These preparation workers are read-only.

Skipped stages and their brief reason belong in the clarification artifact—no empty
placeholder documents or extra approval round for already-agreed architecture. A
preparation-only brief does not authorize implementation. Material owner questions are resolved
before `clarify`; changing a current document revision invalidates that checkpoint.

## Model choices

```sh
agent-plan start /repo "Implement the story" --model MODEL --provider PROVIDER
```

Every task gets `model-menu.json`, and the coordinator is told its actual provider and
model. Worker `spawn` can choose `discovery`, `planning`, `implementation`, or
`complex`. Discovery defaults to `openai-codex/gpt-5.6-luna`; the other choices inherit
the coordinator unless configured. Direct provider/model overrides require a reason.
Availability is checked before worker worktree creation; missing models or credentials
are not silently substituted.

Configure alternatives in `.agent-plan/project.json`:

```json
{
  "workerModels": {
    "discovery": {
      "provider": "openai-codex",
      "model": "gpt-5.6-luna",
      "purpose": "Bounded discovery"
    },
    "planning": {
      "provider": "openai-codex",
      "model": "gpt-6-astra",
      "purpose": "Architecture and planning"
    }
  }
}
```

This is a fragment to merge into existing configuration, not a replacement for command
settings. Task flags such as `--discovery-model`, `--discovery-provider`,
`--planning-model`, and `--planning-provider` set stage defaults; explicit
`workerModels` entries win. Saved worker selections are reused on resume. Configuration
does not claim that a model is cheapest or sufficient for the task.

Owner-authenticated `agent-plan feedback TASK /absolute/feedback.md` sends a
nonblocking message to an unfinished task. It neither answers a pending decision nor
resumes a waiting coordinator; use `answer` for the exact decision.

## Selected managed skills

Add committed repository-relative paths to `.agent-plan/project.json`:

```json
{
  "skills": [".agents/skills/review/SKILL.md"]
}
```

At most 20 paths are accepted. The runtime snapshots instructions from the task's base
commit and supplies a `skills.json` manifest. Agents read selected snapshots and
relative supporting files with runner file tools. Uncommitted replacements are ignored.
Skills do not expand the authorized task scope or grant approval authority. Managed
agents can use native OMP file and shell tools for task-related work; configured named
commands remain the source of final runner verification. Personal skills must be copied
into the repository and committed first. Managed sessions still disable automatic
extension, skill and prompt-template loading so they use the selected snapshots.
Ordinary supervisor OMP sessions retain OMP's native skills and tools.

## Optional browser helper

`runner/browser.js` uses the target repository's installed `playwright` and Chromium.
It does not install dependencies or start the application. Expose its absolute path as
a named command with a repository-relative scenario file:

```json
[
  {"action":"goto","url":"http://127.0.0.1:3000"},
  {"action":"fill","label":"Name","value":"Michal"},
  {"action":"click","name":"Greet"},
  {"action":"visible","text":"Hello, Michal!"},
  {"action":"screenshot","criterion":"AC-1"}
]
```

Each run uses a disposable browser and writes `.runner-ui-*/result.json` plus PNGs.
Ignore `.runner-ui-*/`. Workers can `publish` screenshots into immutable artifacts;
the dashboard previews them. This is a small scenario runner, not a persistent browser.
See [Playwright setup](https://playwright.dev/docs/library).

## Required UI evidence

Projects that need a hard frontend gate can add a named command and policy:

```json
{
  "commands": {
    "test": ["npm", "test"],
    "ui": ["npm", "run", "verify:ui"]
  },
  "verify": ["test"],
  "uiEvidence": {"command": "ui"}
}
```

The runtime executes `ui` after ordinary verification on the integration candidate and
again after acceptance rebases it. It sets `RUNNER_UI_DIR`, `RUNNER_UI_COMMIT`, and
`RUNNER_UI_RUN_ID`. The project command owns application startup, browser assertions,
shutdown, and `manifest.json`; its schema is in
[UI evidence](../workflow/ui-evidence.md).

Every criterion needs a passing assertion and at least one PNG, WebM, or MP4. The
runtime checks run/commit identity, file boundaries, sizes, and media headers before
copying evidence into immutable artifacts. Missing, failed, or stale evidence blocks
completion and acceptance. It does not infer frontend changes, judge assertion quality,
decode media, or establish visual correctness. When configured, the gate applies to
every task in that repository; without it, the workflow still asks frontend work to
provide evidence.

PNG publication is capped at 10 MB; WebM/MP4 at 25 MB. The inspector plays video.
Artifact reads return video metadata and a local path unless `includeMedia:true` is
explicitly requested; Pi/Claude supervisor tools return video metadata as text.
Completion events include the manifest and up to four attachments. Webhooks inline
small PNGs; videos and large files require an authenticated artifact fetch by a trusted
local relay. No public hosting or receiver-side playback is provided.

## Portable execution selection

Canonical configuration is `.agent-plan/project.json`; existing `.runner/project.json`
is read only when canonical configuration is absent. Files are not combined.
Ignored `.agent-plan/local.json` may override execution and model preferences, including
individual role fields, but cannot change hosting or verification commands.
No credential fields belong in either file. Runtime authentication stays native.

```json
{
  "execution": { "mode": "runner", "runtime": "omp" },
  "agents": {
    "coordinator": { "model": "grok-4.7", "provider": "xai-oauth" },
    "implementation": { "model": "grok-4.7", "provider": "xai-oauth" },
    "review": { "model": "gpt-6-sol", "provider": "openai-codex" }
  }
}
```

These model IDs require matching authenticated availability; choose your installed
provider's models. Role runtime inherits execution when omitted. Explicit reviewer
role selections fail if unavailable; they never silently switch providers.
Discovery inherits the coordinator unless configured separately. Legacy model fields
and workerModels remain supported; canonical role fields take precedence.
Run `agent-plan config REPO` to inspect execution support without starting a daemon.
Native Claude/Codex packages use `mode: native` and their matching runtime. Native
Grok/Cursor and cross-runtime delegation remain unavailable. See the
[examples](../../examples/README.md) and [shared contract](../../workflow/contract.md).
