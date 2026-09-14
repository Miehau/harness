# Agent Plan runner

Terminal-first task orchestration using Pi, Herdr, Markdown workflows, and Git worktrees.
One main agent coordinates workers through durable file references and explicit decisions.
The dashboard shows the same runtime state and supports explicit owner acceptance.

Install the command once from this checkout:

```sh
./install.sh
```

The installer checks Node/npm/Git, installs locked dependencies and links the CLI.
It uses your current npm prefix; rerun after switching NVM versions.

Use `agent-plan help`, `agent-plan help start`, or `agent-plan repo --help` for usage.

With Herdr running and Pi credentials configured:

```sh
agent-plan start /path/to/repo "Implement this feature"
agent-plan list
agent-plan open TASK
agent-plan stop TASK
```

The runtime starts in the background automatically. `start` opens a Herdr workspace
with a Pi orchestrator; it launches worker sessions as needed. Answer pending
questions directly in the terminal. TASK accepts a full ID or unique prefix.

Configure each repo's verification command once if it has no `.runner/project.json`:

```sh
agent-plan init /path/to/repo '["npm","test"]'
```

Tasks start from committed HEAD. State lives in `~/.local/state/agent-plan`, shared
across terminals; set `RUNNER_DATA` only to use a different existing state directory.

See [the operating guide](runner/README.md) for repo configuration, Markdown workflows,
worker decisions, recovery, the dashboard, and optional GrokBot notifications.

```sh
npm test
npm run check
npm run probe  # opt-in live Herdr/Pi connection check; no model calls
```

The old visual pipeline is retired. Its source, tests, configuration, and uncommitted
changes are preserved in the verified [legacy archive](archive/README.md).
There is no automatic migration of legacy task state.
