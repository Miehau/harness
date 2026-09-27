# Agent Plan runner

This is the repository's primary application: a local, terminal-first OMP/Herdr
runner that coordinates agents in isolated Git worktrees. The independent
[native Claude plugin](../claude/README.md) has its own workflow and does not use this
runtime. The retired visual pipeline is retained in Git history.

## Operator flow

For collaborative architecture and background implementation, keep a main session
open with `agent-plan supervisor`. Discuss the problem, commission three competing architecture proposals by default (or your explicit roster)
when needed, and choose the approach together.
The bundled `/skill:how`, `/skill:why`, `/skill:arena`, `/skill:architect`,
`/skill:blast-radius` and `/skill:open-pr` commands load automatically.
The same background coordinator then implements the agreed design while you discuss
the next feature. Questions and results return to the supervisor. See
[Supervisor sessions](docs/supervisor.md) for the preparation and implementation handoff.

For a single task opened directly in its coordinator, use the CLI flow below.
The daily path is **discuss → saved handoff → implement → parallel review → PR/MR → approve**.

For a small, understood bug or feature, skip separate discovery, architecture and
planning workers. Use a concise clarification/assignment, one implementation worker,
verification and the two required parallel reviewers. Add specialists only for
relevant risks; see [stage selection](workflow/stages.md).

### 1. Start

Requirements: Node 22.19+, Bun 1.3.14+, installed dependencies, Git, a running Herdr server,
and configured OMP credentials. Install the CLI once from this checkout:

```sh
./install.sh
agent-plan start /absolute/repo "Implement this feature"
```

The installer checks Node, npm, and Git, installs locked dependencies, and links the
CLI under the current npm prefix; rerun it after changing NVM versions. The launcher
puts this checkout's OMP binary first on `PATH` so a different global OMP is not used.

`start` launches the background runtime when needed, snapshots the committed base
and configuration, creates an integration worktree and Herdr workspace, and focuses
the OMP coordinator. Workers open isolated sessions as required. Uncommitted source
changes are not copied.

Without `.agent-plan/project.json`, tasks use `bash verify.sh`. Configure a different
verification command explicitly:

```sh
agent-plan init /absolute/repo '["npm","test"]'
```

Use `npm run runner -- <command>` without installing the CLI. `agent-plan help` and
`agent-plan help COMMAND` describe every command. Task arguments accept a full ID or
unique prefix.

### 2. Answer if needed

Questions appear in the coordinator's OMP terminal. Type the answer there; the runtime
applies it to that exact decision before work resumes. Model tools cannot claim human
approval. Other independent workers may continue while one worker waits.

Inspect or reopen a task at any time:

```sh
agent-plan list
agent-plan open TASK
agent-plan inspect TASK
agent-plan dashboard
```

GrokBot or another local scheduler can launch an alias-only task without focusing the
workspace. Its request ID makes retries duplicate-safe:

```sh
agent-plan launch meal-minder /absolute/task.md grok-roadmap-20260921
```

The external bot owns its schedule; the runner owns task execution and receipts.

For automation, save an answer in a file and target the exact decision:

```sh
agent-plan answer TASK DECISION_ID /absolute/answer.md
```

The dashboard is an optional view of the same runtime state. Its URL contains owner
access in the fragment; keep it private. Full conversations remain in Herdr and the
recorded OMP session files.

### 3. Accept

With `hosting` configured, a completed task has a verified, reviewed candidate and a
published GitHub PR or GitLab MR with evidence links. Required CI is checked again at
merge. Approve its exact commit using `accept`; without hosting, acceptance remains local:

```sh
agent-plan accept TASK # local-only; hosted tasks require the exact published SHA
# Or select the exact candidate and local target:
agent-plan accept TASK COMMIT --target master
```

For local-only tasks, acceptance rebases the candidate onto the local target (`main` by default), reruns
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

`.agent-plan/project.json` is owner-maintained and snapshotted for each task.
Legacy `.runner/project.json` remains supported when the canonical file is absent.
Optional ignored `.agent-plan/local.json` overrides runtime/model preferences only;
checks and hosting remain project-owned. Use `agent-plan config /path/to/repo` for
an offline capability report. See [portable workflow](../plans/unified-workflow.md).
The runner requires `execution: {"mode":"runner","runtime":"omp"}`; omitted
execution retains this legacy default. Native Claude/Codex use their skill packages.

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
  "commandTimeoutMs": 120000
}
```

Commands are argv arrays, not shell strings. They run as the runtime user, so configure
only trusted repositories and commands. Configure every required final check in
`verify`. See [Configuration and models](docs/configuration-and-models.md) for workflow
overrides, onboarding, aliases, model routing, managed skills, and UI evidence.

## Boundaries

- Agents use native OMP tools alongside runner tools under a trusted-local model.
  Worktrees isolate Git changes; they are not OS sandboxes. Shell and native file
  tools can access runner state and credentials as the same OS user. Human approvals
  and read-only roles are workflow rules, not protection against a malicious agent.
- The runner API enforces immutable artifacts. State writes are atomic and mutating calls use durable
  receipts so uncertain outcomes are surfaced instead of repeated.
- Coordinators and reviewers must not edit repository files. Implementation workers
  use native tools in their own worktrees; the runtime commits reported work, integrates
  serially and verifies the resulting candidate. Native command success does not replace
  final configured verification.
- New candidates require independent requirements/AC and correctness/code-quality
  reviewers in parallel, plus risk-selected specialists. Major and medium findings
  block completion; changed commits invalidate every required role review.
- Sensitive changes receive targeted plan assurance before writers. Candidate reviewers
  inspect the same verified commit; there is no mandatory final generic reviewer.
- Back up the runner data directory together with the source repository's Git object
  database. State defaults to `~/.local/state/agent-plan`; `RUNNER_DATA` selects another
  existing data directory.

Current v0.1 non-goals: a public or multi-user service, automatic deployment,
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
  safe local launches, payload limits, receipts, and private configuration.

## Verify this repository

```sh
npm test
npm run check
npm run probe
npm run canary  # opt-in paid end-to-end run; makes live model calls
```

Tests use disposable Git repositories and mocked agents. `npm run probe` is an opt-in
live Herdr/OMP connection check with no model calls. `npm run canary` runs one disposable
repository task through a live model; set `RUNNER_CANARY_TIMEOUT_MS` to change its
timeout. It is a smoke check, not a comparative quality benchmark.

## Hosted delivery and previews

```sh
agent-plan hosting demo --hosting-provider github --hosting-target main
# GitLab, including self-hosted installations, uses the same saved configuration.
agent-plan hosted-status TASK
agent-plan preview TASK
agent-plan preview TASK --stop
agent-plan accept TASK EXACT_PUBLISHED_COMMIT
```

Onboarding discovers hosting from the remote when possible. Edit `hosting` in
`.agent-plan/project.json` to switch providers for future tasks; each existing task keeps
its snapshot. Publication uses installed `gh` or `glab` credentials. Both providers
store evidence on separate `runner-evidence/TASK/CANDIDATE_SHA/EVIDENCE_COMMIT` branches
with commit-pinned links and repository access controls. GitLab's native image upload
API is not used because its default URL access can bypass private-project membership.
No merge occurs from a completion notification. Manual provider merges are detected.
See [hosted delivery](docs/hosted-delivery.md) for setup, recovery and limitations.
