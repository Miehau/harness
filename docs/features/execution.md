# F06 — Isolated execution and version control

[Map](../feature-map.md) · [Navigation reference](../feature-navigation.md)

**Load when:** worktrees, scopes, named commands, Git/jj, runnable batches, commits.

## Behavior and boundaries

**Purpose:** Snapshot existing tracked/untracked changes without touching the user's index, create ticket worktrees, run scoped workers through named argv commands, and retain logical commits. Git parallel siblings use isolated worktrees and cherry-pick accepted commits; Jujutsu maintains editable changes and exports accepted Git commits.

Each frozen read/write Git extra root gets an isolated run/step worktree. `run.workspace` remains the primary record; `run.repositories` lists every writable Git checkout. File tools rewrite configured original paths into those worktrees so user source checkouts stay untouched except pre-existing dirty files. Read-only Git extras have no worktree. Named `project_command` calls stay on the primary worktree unless a repository id selects another mapped root.

**Strength:** User changes are preserved, step acceptance defines integration order, and dependent artifacts explicitly cross worker boundaries.

**Limit:** Jujutsu is the default and executes dependency-ready siblings serially. Parallel Git work can still conflict at acceptance. Command execution intentionally has no arbitrary shell-string tool. Repository bootstrap is a verification/configuration step inside a plan, not a separate initialization ticket merged before all feature work.

Evidence: [worktrees.js](../../src/worktrees.js) (`ensureTicketWorktree`, `gitRepositoriesForStep`, `mapConfiguredPath`), [git.js](../../src/git.js), [jj.js](../../src/jj.js), `advanceTicket` in [ticket-runner.js](../../src/ticket-runner.js) and `acceptStep` in [step-runner.js](../../src/step-runner.js), [worktree tests](../../test/worktrees.test.js), [multi-repo flow](../../test/multi-repo-flow.test.js).

## Find the implementation

Read only this feature’s UI/API/CLI/source/test row from the repository root:

```sh
rg -n '^\| \*\*F06\*\*' docs/feature-navigation.md
```

Follow its named symbols into source, then read callers and the focused tests. Load the navigation guide’s fixture recipes only when exercising a journey.

## Follow only relevant edges

- For dependency semantics, read [F04 — Plans and budgets](plans.md).
- For worker tools and sessions, read [F05 — Pi and workflow gates](pi-workflows.md).
- For acceptance and integration order, read [F07 — Step review and proof](step-review.md).
- For pause or cleanup, read [F12 — Recovery and process cleanup](recovery.md).

Snapshot: 2026-09-06, `9703dde` plus uncommitted work. [Audit evidence and provenance](audit.md) are optional; verify current source before relying on historical findings.
