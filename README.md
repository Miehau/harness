# Agent Plan Workspace

A local-first visual workspace for shaping development tasks with Pi, generating editable execution graphs, and reviewing every agent run through its prompt, progress, exact Git diff, artifacts, and screenshot references.

## MVP capabilities

- Pi-backed planning chat with project-discovered context, skills, and prompt templates.
- One persistent plan supervisor with named Pi worker sessions for every step.
- Binding workflow skills with typed `needs_input` and `awaiting_approval` checkpoints.
- Structured worker reports reviewed by the supervisor before user acceptance.
- AI-generated task-specific plans with generic `group` and `step` nodes.
- One nesting level with parallel sibling runs and a hard acceptance barrier.
- Fresh, seeded, and forked Pi sessions.
- Explicit dependency artifact handoffs.
- Editable prompts, permissions, scopes, skills, references, and acceptance criteria.
- Live run events and output.
- Per-run Git tree diffs without modifying the real Git index or creating commits.
- Screenshot references passed into the selected step's Pi session.
- Local JSON persistence under `~/.agent-plan-workspace`.
- Prompt-free local fixtures loaded from `feature.md` and `plan.json` into a fresh zero-state repository.

## Run

Requires Node.js 22.19 or later and an authenticated Pi installation. The local dependency uses Pi SDK 0.84 or later to include current dependency security fixes.

```bash
npm install --ignore-scripts
npm start -- --cwd /absolute/path/to/a/repository
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

The app uses Pi's existing authentication and model settings from `~/.pi/agent`. It binds to localhost by default.

## Local zero-state fixture

The included `fixtures/zero-state-task-board` benchmark contains a product brief and a prompt-free ticket graph. Open this repository, keep the default fixture path in the left pane, and choose **Load**. The framework creates an empty Git repository, renders its own Pi prompts, and preserves the feature, plan, prompts, reports, diffs, and verification artifacts for the run.

Local `plan.json` tickets contain outcomes, permissions, write scopes, acceptance criteria, and dependencies. Runtime fields such as prompts, skills, harnesses, and agent IDs are rejected so framework versions can be compared against the same authored input.

## Workflow

1. Open a repository and optionally bind one of its discovered Pi skills as the supervisor's workflow.
2. Discuss the task, resolving any workflow checkpoints before generating a plan.
3. Inspect or edit the plan JSON and every individual worker prompt.
4. Run a single step or an entire parallel group. Parallel writers use isolated worktrees.
5. Review the supervisor response, live output, exact diff, and produced artifact.
6. Accept the step. Downstream dependencies unlock only after every required predecessor is accepted.

## Deliberate MVP limits

- Pi is the only implemented harness.
- Groups can contain steps, not nested groups.
- Dependency-ready siblings run in isolated worktrees. Accepted patches are applied to the run worktree in review order; conflicts stop for human attention.
- Built-in Pi tools respect the selected permission. Any third-party Pi extension still runs with the authority it defines, so review installed extensions before use.
- Write scopes are verified against the resulting diff. They are not a filesystem sandbox.

## Checks

```bash
npm test
node --check src/server.js
node --check public/app.js
```
