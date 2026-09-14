---
name: agent-plan
description: Develop and operate this repository's terminal-first Pi/Herdr runner, including worktrees, Markdown workflows, task decisions, and recovery.
---

# Agent Plan runner

The active application is `runner/`. The old visual pipeline is retired; `archive/`
contains a verified historical snapshot, not current instructions or reusable modules.

Read `runner/README.md` for operation and `runner/workflow.md` for the main-agent workflow.
`runner/runtime.js` owns task state, worktrees, permissions, messages, and verification;
`runner/herdr.js` and `runner/pi-extension.js` connect terminal sessions to that runtime.

Use `npm test` and `npm run check`. Tests in `test/runner.test.js` exercise disposable
Git repositories and mocked agents. Never call a live model in tests.
`npm run probe` is an opt-in real Herdr/Pi connection check that makes no model calls.

Use `agent-plan start /absolute/repo "task"` with Herdr running. The CLI automatically
starts the background runtime and focuses the orchestrator workspace. `agent-plan open`
focuses a task and `agent-plan stop` cancels it. State defaults to
`~/.local/state/agent-plan`; `RUNNER_DATA` selects another data directory.
Use `npm run runner -- help` without a global installation. Explicit `submit` creates
an inert draft; direct `start REPO TEXT` launches immediately. Pending questions can
be answered interactively in the Pi terminal using its scoped reply credential. Repo configuration lives in `.runner/project.json`; optional
`.runner/workflow.md` replaces the bundled workflow. Both are snapshotted per task.

Keep worker output in immutable files and pass references. Preserve exact task,
attempt, and decision identities. Herdr idle/done is never evidence of task completion.
Retain dirty worktrees and uncertain outcomes for explicit recovery. Completion means
a verified integration branch, not a push, merge, or deployment. GrokBot is disabled
unless the owner configures its receiver; HTTP acceptance is not a human decision.
