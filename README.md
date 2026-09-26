# Agent Plan

OMP/Herdr orchestration for turning an agreed task into a verified, independently
reviewed GitHub pull request or GitLab merge request. Discuss work with an OMP
supervisor or GrokBot, then hand implementation to a coordinator and workers in Git
worktrees. Decisions, evidence and recovery state persist outside the conversation.

## Start

Requires Node 22.19+, Bun 1.3.14+, Git, running Herdr and configured OMP credentials.
The installer uses the locked OMP version rather than a global installation.

```sh
./install.sh
agent-plan onboard /path/to/repo
agent-plan supervisor
```

Onboarding discovers the project and saves checks, hosting and applicable preview
commands in `.runner/project.json`. Review its candidate before starting feature work.
GitHub/GitLab settings are editable; running tasks retain their configuration snapshot.
Configure `gh` or `glab` authentication for hosted delivery. GrokBot uses the
[existing webhook integration](runner/docs/webhooks.md).

Use `/skill:how`, `/skill:why`, `/skill:arena`, `/skill:architect`,
`/skill:blast-radius` and `/skill:open-pr` in the supervisor as needed. The
[portable skills](codex/agent-plan/runner.md) include their reference playbooks and
[upstream attribution](codex/agent-plan/THIRD_PARTY_NOTICES.md).

## Daily workflow

1. Discuss the task and persist the agreed scope, decisions, acceptance criteria and
   verification plan. Explicit handoff starts the implementation coordinator.
2. Workers implement in separate worktrees. The coordinator integrates and verifies
   the candidate, then runs requirements/AC and correctness/code-quality reviewers
   independently in parallel. Risk-selected specialists join when needed.
3. With hosting configured, completion publishes the PR/MR and commit-pinned evidence.
   Questions include context, choices and recommendations; screenshots can accompany them.
4. Inspect the retained worktree and evidence. Merge manually, or approve agent merge
   of the exact published commit after required CI and review gates pass.

```sh
agent-plan start /path/to/repo "Fix the empty-state message"
agent-plan inspect TASK
agent-plan open TASK
agent-plan preview TASK           # when onboarding configured a local preview
agent-plan preview TASK --stop
agent-plan hosted-status TASK
agent-plan accept TASK EXACT_PUBLISHED_COMMIT
```

Without hosting, `accept` retains the local rebase, verification and fast-forward
merge workflow. Publication never authorizes merge. Unknown outcomes and dirty
worktrees are retained for explicit recovery.

### Small bugs and features take the short path

A small, understood change needs one concise clarification/assignment and one
implementation worker. Skip separate discovery, competing architecture proposals,
planning workers and their documents. A feature following an established pattern
qualifies too; size alone does not make a risky change routine.

Verification and the two required parallel reviews remain. Security, database,
recovery, UI or performance specialists are added only for relevant risks. Changes
to the candidate require fresh verification and all required reviews again. There
is no mandatory generic final reviewer or extra human approval for routine details.

## Guides and boundaries

- [Operating guide](runner/README.md): commands, configuration and recovery.
- [OMP migration and hosted delivery](runner/docs/hosted-delivery.md): session
  compatibility, provider setup, evidence, exact-revision approval and previews.
- [Supervisor](runner/docs/supervisor.md): discussion, skills and durable handoff.
- [Migration tracker](plans/omp-migration.html) and [acceptance evidence](plans/omp-acceptance.md).
- [Independent native Claude plugin](claude/README.md): separate supported workflow.

Execution is trusted local: worktrees isolate Git changes, not OS access. Native OMP
tools run with the user's permissions. Repository-backed evidence uses the hosting
project's access controls. Live provider and GrokBot acceptance checks are tracked
separately from local tests and the passing OMP model canary.

The retired visual pipeline is available only in Git history. `runner/` is the active
application; its runtime does not import the independent Claude plugin.

## Develop

```sh
npm ci
npm test
npm run check
npm run probe   # opt-in Herdr/OMP connection check; no model calls
npm run canary  # opt-in disposable model-driven task; incurs model usage
```
