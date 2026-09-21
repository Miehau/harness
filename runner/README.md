# Agent Plan runner

This is the repository's primary application: a local, terminal-first Pi/Herdr
runner that coordinates agents in isolated Git worktrees. The independent
[native Claude plugin](../claude/README.md) has its own workflow and does not use this
runtime. The retired visual pipeline remains only in [archive/](../archive/README.md).

## Operator flow

The daily path is **start → answer if needed → accept**.

### 1. Start

Requirements: Node 22.19+, installed dependencies, Git, a running Herdr server,
and configured Pi credentials. Install the CLI once from this checkout:

```sh
./install.sh
agent-plan start /absolute/repo "Implement this feature"
```

The installer checks Node, npm, and Git, installs locked dependencies, and links the
CLI under the current npm prefix; rerun it after changing NVM versions. The launcher
puts this checkout's Pi binary first on `PATH` so a different global Pi is not used.

`start` launches the background runtime when needed, snapshots the committed base
and configuration, creates an integration worktree and Herdr workspace, and focuses
the Pi coordinator. Workers open isolated sessions as required. Uncommitted source
changes are not copied.

Without `.runner/project.json`, tasks use `bash verify.sh`. Configure a different
verification command explicitly:

```sh
agent-plan init /absolute/repo '["npm","test"]'
```

Use `npm run runner -- <command>` without installing the CLI. `agent-plan help` and
`agent-plan help COMMAND` describe every command. Task arguments accept a full ID or
unique prefix.

### 2. Answer if needed

Questions appear in the coordinator's Pi terminal. Type the answer there; the runtime
applies it to that exact decision before work resumes. Model tools cannot claim human
approval. Other independent workers may continue while one worker waits.

Inspect or reopen a task at any time:

```sh
agent-plan list
agent-plan open TASK
agent-plan inspect TASK
agent-plan dashboard
```

For automation, save an answer in a file and target the exact decision:

```sh
agent-plan answer TASK DECISION_ID /absolute/answer.md
```

The dashboard is an optional view of the same runtime state. Its URL contains owner
access in the fragment; keep it private. Full conversations remain in Herdr and the
recorded Pi session files.

### 3. Accept

A completed task is a verified candidate branch, not a merge, push, or deployment.
Review the candidate, then deliver it locally:

```sh
agent-plan accept TASK
# Or select the exact candidate and local target:
agent-plan accept TASK COMMIT --target master
```

Acceptance rebases the candidate onto the local target (`main` by default), reruns
verification, and fast-forward merges. The source checkout must be clean and on that
target. It performs no fetch, push, PR creation, or deployment.

Dirty work, stale approval, conflicts, failed checks, or a target that advances during
verification stop delivery. The runner never resets or stashes user changes. See
[Runtime and recovery](docs/runtime-and-recovery.md#acceptance-and-delivery) for retry
and interrupted-merge handling.

## Stop, resume, and recover

```sh
agent-plan stop TASK
node runner/cli.js resume TASK AGENT
node runner/cli.js recover TASK applied   # or: aborted
```

Stopping cancels execution but retains worktrees and artifacts. Herdr `idle` or `done`
never means task completion. Unknown outcomes and interrupted Git operations require
inspection; the runtime does not blindly retry side effects or discard work. Full
procedures are in [Runtime and recovery](docs/runtime-and-recovery.md).

## Repository configuration

`.runner/project.json` is owner-maintained and snapshotted for each task:

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

Commands are argv arrays, not shell strings. They run as the runtime user, so configure
only trusted repositories and commands. Configure every required final check in
`verify`. See [Configuration and models](docs/configuration-and-models.md) for workflow
overrides, onboarding, aliases, model routing, managed skills, and UI evidence.

## Boundaries

- Worktrees isolate Git changes; they are not OS sandboxes.
- Artifacts are immutable. State writes are atomic and mutating calls use durable
  receipts so uncertain outcomes are surfaced instead of repeated.
- Coordinators cannot edit repository files directly. Writing workers commit changes;
  the runtime integrates serially and verifies the resulting candidate.
- New candidates require an independent read-only review. Major and medium findings
  block completion; changed commits invalidate prior review.
- Sensitive changes receive targeted plan assurance before writers and fresh candidate
  assurance before the final general review; routine changes keep the single review.
- Back up the runner data directory together with the source repository's Git object
  database. State defaults to `~/.local/state/agent-plan`; `RUNNER_DATA` selects another
  existing data directory.

Current v0.1 non-goals: a public or multi-user service, automatic push/PR/deployment,
autonomous conflict resolution, semantic proof that tests or docs are adequate, and
claimed end-to-end quality parity based only on mocked tests or the transport probe.

## Optional capabilities

- [Runtime and recovery](docs/runtime-and-recovery.md): ownership, artifacts,
  decisions, dashboard, review, interruption, cleanup, and acceptance.
- [Configuration and models](docs/configuration-and-models.md): repository setup,
  onboarding, feature docs, aliases, model choices, skills, and browser/UI evidence.
- [Supervisor sessions](docs/supervisor.md): conversational task control, memory,
  MCP, lifecycle actions, and trust boundaries.
- [Webhook notifications](docs/webhooks.md): optional GrokBot-style event delivery,
  payload limits, receipts, and private configuration.

## Verify this repository

```sh
npm test
npm run check
npm run probe
npm run canary  # opt-in paid end-to-end run; makes live model calls
```

Tests use disposable Git repositories and mocked agents. `npm run probe` is an opt-in
live Herdr/Pi connection check with no model calls. `npm run canary` runs one disposable
repository task through a live model; set `RUNNER_CANARY_TIMEOUT_MS` to change its
timeout. It is a smoke check, not a comparative quality benchmark.
