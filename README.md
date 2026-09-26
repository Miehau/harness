# Agent Plan runner

Terminal-first task orchestration using Pi, Herdr, Markdown workflows, and Git
worktrees. One coordinator delegates to workers through durable artifacts and exact
decisions; the dashboard shows the same runtime state.

[`runner/`](runner/README.md) is the primary application. [`claude/`](claude/README.md)
is an independent native Claude plugin with its own skills, hooks, and subagent
workflow; it does not use the Pi/Herdr runtime.

The [pstack skill port](codex/agent-plan/runner.md) supplies `how`, `why`, `arena`,
`architect`, `blast-radius` and `open-pr`, including their reference playbooks and
[upstream attribution](codex/agent-plan/THIRD_PARTY_NOTICES.md). The Pi supervisor
loads them automatically. `codex/agent-plan/` also contains a Codex plugin manifest;
placing it in this repository does not install it into Codex.

## Run the Pi/Herdr runner

Install the command once from this checkout:

```sh
./install.sh
```

With Herdr running and Pi credentials configured, the normal flow is:

```sh
agent-plan supervisor
```

In that main conversation, use `/skill:how` to understand existing behavior,
`/skill:why` to recover rationale, and `/skill:architect` to design a change together.
Architecture compares at least three independent proposals before you agree the
design and authorize background implementation. Continue discussing the next feature
while the coordinator manages workers, checks and review; questions return here.
The supervisor presents the verified candidate for local acceptance.

For first-time repository setup, `agent-plan onboard /path/to/repo` delegates
discovery of checks and useful project verification skills. Review and accept that
candidate before feature tasks. For a single already-defined task, use
`agent-plan start /path/to/repo "Implement this feature"` followed by
`agent-plan accept TASK` after reviewing its result.

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
