---
name: agent-plan
description: Develop and operate this repository's terminal-first OMP/Herdr runner, including worktrees, Markdown workflows, task decisions, and recovery.
---

# Agent Plan runner

The active application is `runner/`. The old visual pipeline is retired and retained
only in Git history; do not restore its modules or historical instructions.

Read `runner/README.md` for operation and `runner/workflow.md` for the main-agent workflow.
`runner/runtime.js` owns task state, worktrees, permissions, messages, and verification;
`runner/herdr.js` and `runner/pi-extension.js` connect terminal sessions to that runtime.

Use `npm test` and `npm run check`. Tests in `test/runner.test.js` exercise disposable
Git repositories and mocked agents. Never call a live model in tests.
`npm run probe` is an opt-in real Herdr/OMP connection check that makes no model calls.

Use `agent-plan start /absolute/repo "task"` with Herdr running. The CLI automatically
starts the background runtime and focuses the orchestrator workspace. `agent-plan open`
focuses a task and `agent-plan stop` cancels it. State defaults to
`~/.local/state/agent-plan`; `RUNNER_DATA` selects another data directory.
Use `npm run runner -- help` without a global installation. Explicit `submit` creates
an inert draft; direct `start REPO TEXT` launches immediately. Pending questions can
be answered interactively in the OMP terminal using its scoped reply credential. Repo configuration lives in `.agent-plan/project.json` (legacy `.runner/project.json`
fallback). Private `.agent-plan/local.json` overrides runtime/model choices only; optional
`.runner/workflow.md` replaces the bundled workflow. Both are snapshotted per task.

Keep worker output in immutable files and pass references. Preserve exact task,
attempt, and decision identities. Herdr idle/done is never evidence of task completion.
Retain dirty worktrees and uncertain outcomes for explicit recovery. Completion
requires a verified integration branch and passing independent requirements/AC
and correctness reviews, plus risk-selected specialists. With hosting configured,
completion also publishes the PR/MR and repository-protected evidence. Publication
is never merge approval: merging requires owner approval of the exact candidate and
passing provider gates. See `runner/docs/hosted-delivery.md` for OMP session migration,
hosting, previews and recovery. GrokBot is disabled unless the owner configures its
receiver; HTTP acceptance is not a human decision.
