# Agent Plan Workspace

A local-first visual workspace for shaping Linear, Jira, and local development tasks with Pi, generating editable execution graphs, and reviewing every agent run through its prompt, progress, exact Git diff, artifacts, and screenshot references. The incremental automation design is recorded in [docs/automation-harness-spec.md](docs/automation-harness-spec.md).

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
- Per-run Git tree diffs without modifying the user's index, plus one requirement-linked commit for each accepted step.
- Dirty-worktree snapshot initialization, scope-enforced writes, and named project commands with no arbitrary shell-string escape hatch.
- A repository-owned `.agent-plan/project.json` contract separates executable commands, environment allow-lists, ignored local env files, and port variables from human architecture prose.
- One repository-owned `.agent-plan/verify.mjs` contract for tests, lint, builds, and optional browser screenshot evidence.
- Manual review barriers or an auto mode that accepts verified commits through the whole execution graph.
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

Tracker credentials are read from the daemon environment and are never stored by the harness:

```bash
# Linear
LINEAR_API_KEY=lin_api_...

# Jira Cloud
JIRA_BASE_URL=https://example.atlassian.net
JIRA_EMAIL=developer@example.com
JIRA_API_TOKEN=...
JIRA_PROJECT_KEY=PROJ
```

Linear and Jira can be configured together. Jira intake uses Atlassian API-token authentication and is restricted to the configured project key.

Versions before this change could persist a Linear key under `~/.agent-plan-workspace/credentials`. The harness no longer reads or writes that directory; remove the legacy directory manually after confirming you no longer need it.

## Local zero-state fixture

The included `fixtures/zero-state-task-board` benchmark contains a product brief and a prompt-free ticket graph. Load the fixture, open an empty working directory, then approve the plan. The framework initializes or repairs that directory as the zero-state Git repository, seeds a baseline `.gitignore`, renders its own Pi prompts, commits each accepted step, and preserves the feature, plan, prompts, reports, diffs, and verification artifacts for the run.

Local `plan.json` tickets contain outcomes, permissions, write scopes, acceptance criteria, and dependencies. Runtime fields such as prompts, skills, harnesses, and agent IDs are rejected so framework versions can be compared against the same authored input.

## Workflow

1. Open a repository and optionally bind one of its discovered Pi skills as the supervisor's workflow.
2. Discuss the task, resolving any workflow checkpoints before generating a plan.
3. Inspect or edit the plan JSON and every individual worker prompt.
4. Run a single step or an entire parallel group. Parallel writers use isolated worktrees.
5. Review the supervisor response, live output, exact diff, and produced artifact.
6. Accept the step, or choose Auto when approving the graph. Manual runs pause for every verified batch; Auto accepts its commits and continues. Downstream dependencies unlock only after every required predecessor is accepted.

Architecture owns `.agent-plan/verify.mjs`. The framework always calls `node .agent-plan/verify.mjs` when present, falling back to a root `npm test` only for older repositories. Visual steps must write browser screenshots to `AGENT_PLAN_EVIDENCE_DIR`; missing evidence fails the gate and captured images are attached to independent review.

The first architecture slice also creates or updates `docs/architecture.md`, `AGENTS.md`, and `.agent-plan/project.json`. Workers can invoke only named argv commands from that file. The harness passes a minimal process environment plus explicitly allow-listed variable names and values loaded from explicitly allow-listed, Git-ignored local env files; command output is redacted before it enters run history.

## Deliberate MVP limits

- Pi is the intentionally selected harness.
- Linear and Jira ticket intake is read-only. Tracker lifecycle writeback and polling are planned in the automation specification.
- Groups can contain steps, not nested groups.
- Dependency-ready siblings run in isolated worktrees. Accepted worktree commits are cherry-picked into the run worktree in review order; conflicts stop for human attention.
- Existing tracked and untracked files seed the ticket worktree without touching the user's index. Final integration waits until the target repository is clean.
- Built-in Pi tools respect the selected permission. Any third-party Pi extension still runs with the authority it defines, so review installed extensions before use.
- Write workers intentionally have no arbitrary shell tool; their `edit` and `write` tools reject paths outside the approved scope before mutation.

## Checks

```bash
npm test
node --check src/server.js
node --check public/app.js
```
