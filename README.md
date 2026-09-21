# Agent Plan runner

Terminal-first task orchestration using Pi, Herdr, Markdown workflows, and Git
worktrees. One coordinator delegates to workers through durable artifacts and exact
decisions; the dashboard shows the same runtime state.

[`runner/`](runner/README.md) is the primary application. [`claude/`](claude/README.md)
is an independent native Claude plugin with its own skills, hooks, and subagent
workflow; it does not use the Pi/Herdr runtime.

## Run the Pi/Herdr runner

Install the command once from this checkout:

```sh
./install.sh
```

With Herdr running and Pi credentials configured, the normal flow is:

```sh
agent-plan start /path/to/repo "Implement this feature"
# Answer questions in the Pi terminal when asked.
agent-plan accept TASK
```

`start` launches the background runtime, integration worktree, coordinator, and
workers. `accept` rebases the verified candidate onto the local target, verifies it
again, and fast-forward merges it. It never pushes or deploys.

Useful commands:

```sh
agent-plan list
agent-plan open TASK
agent-plan inspect TASK
agent-plan dashboard
agent-plan stop TASK
```

Configure a repository's verification command when it has no
`.runner/project.json`:

```sh
agent-plan init /path/to/repo '["npm","test"]'
```

See the [runner operating guide](runner/README.md) for configuration, recovery,
supervisor sessions, notifications, evidence, and safety boundaries.

## Develop

```sh
npm test
npm run check
npm run probe  # opt-in live Herdr/Pi connection check; no model calls
```

The former visual pipeline is retired. Its final snapshot remains in
[`archive/`](archive/README.md); it is not active code and legacy state is not migrated.
