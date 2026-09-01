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
- Review-sized implementation budgets (8 files or 400 changed lines by default), with plan-time splitting, justified atomic exceptions, and automatic-mode stops when actual work exceeds its budget.
- Canonical step, attempt, verification-stage, handoff, and delivered diffs, navigable by file and lazily expanded Git hunk; optional model-generated review maps only link back to those exact hunks.
- Review-only agent notes attach intent, invariants, risks, or test evidence to exact old/new diff lines and batch selected sections into one rewrite request without entering the repository change.
- Dirty-worktree snapshot initialization, scope-enforced writes, and named project commands with no arbitrary shell-string escape hatch.
- A repository-owned `.agent-plan/project.json` contract separates executable commands, environment allow-lists, ignored local env files, and port variables from human architecture prose.
- One repository-owned `.agent-plan/verify.mjs` contract for tests, lint, builds, and optional browser screenshot evidence.
- Ticket-isolated local previews on unique ports with harness-captured Chromium desktop and mobile evidence.
- One final proof-review gate before delivery, combining automated checks with inline screenshots and interaction recordings when required.
- Retained run storage with disk-usage previews and explicit cleanup by run, ticket, project, or age.
- Restart-safe paused recovery, including stale-preview health and remote-delivery uncertainty guards.
- Subscription-oriented usage reporting for elapsed time, model tokens, tool calls, and correction rounds without artificial budgets.
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

Tracker credentials can be entered from the Ticket trackers popup. They are saved outside the repository at `~/.agent-plan-workspace/credentials.json` with owner-only (`0600`) permissions and are never copied into run state, prompts, logs, or artifacts. Environment variables remain available as a fallback:

```bash
# Linear
LINEAR_API_KEY=lin_api_...

# Jira Cloud
JIRA_BASE_URL=https://example.atlassian.net
JIRA_EMAIL=developer@example.com
JIRA_API_TOKEN=...
JIRA_EPIC_KEY=PROJ-42
```

Linear and Jira can be configured together and reconnect immediately after saving. Jira intake uses Atlassian API-token authentication and is restricted to the configured project key. Saved credentials take precedence over environment variables; each saved provider can be removed from the same popup.

Remote delivery uses the repository's existing `origin` plus an environment-only forge token:

```bash
GITHUB_TOKEN=... # GitHub, or
GITLAB_TOKEN=... # GitLab
```

Tracker-backed runs rebase onto the remote target, push one ticket branch, open one pull/merge request, monitor existing CI and review feedback, apply focused feedback fixes, and squash-merge only when the remote gates allow it. After merge, the opened local checkout is fast-forwarded only when it is clean and safely behind the target; otherwise the dashboard records why synchronization was skipped.

Completed run artifacts, ticket worktrees, and local branches are retained indefinitely. Use the storage button in the dashboard to inspect their measured disk usage and explicitly clean selected runs. Cleanup stops owned previews and removes only run-owned local resources; it does not delete remote branches or merged changes.

After a restart, in-flight work remains paused and its last checkpoint is shown. Recorded PRs/MRs resume by inspecting the same remote change. If the daemon stopped while an unconfirmed PR/MR creation or squash merge may have been in flight, the dashboard reports the uncertainty and refuses to guess until the forge has been inspected.

Paused or failed work can also start fresh or restart from a recorded exploration, design, implementation-step, or verification checkpoint. Checkpoint restarts restore the exact stored Git tree, reset all later work, use fresh agent sessions, and retain a machine-readable audit artifact; fresh starts archive the previous run under its unique run ID. Runs that reached delivery are never rewound automatically.

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

The first architecture slice creates or updates `.agent-plan/project.json` without touching product code or repository documentation. Documentation changes remain ticket-specific and require their own justified plan step. Workers can invoke only named argv commands from the project configuration. The harness passes a minimal process environment plus explicitly allow-listed variable names and values loaded from explicitly allow-listed, Git-ignored local env files; command output is redacted before it enters run history.

When `project.json` declares a `preview` or `dev` command, visual tickets receive a localhost preview with their own allocated port. The configured port variables are set only for that preview process. The harness captures 1440×900 desktop and 390×844 mobile Chromium images, attaches them to independent review, and exposes the live preview URL in the run header.

## Deliberate MVP limits

- Pi is the intentionally selected harness.
- Linear and Jira support polling, dependency-aware intake, comments, answers, and lifecycle transitions; unsupported workflow transitions stop with a visible blocker.
- Groups can contain steps, not nested groups.
- Dependency-ready siblings run in isolated worktrees. Accepted worktree commits are cherry-picked into the run worktree in review order; conflicts stop for human attention.
- Existing tracked and untracked files seed the ticket worktree without touching the user's index. Final integration waits until the target repository is clean.
- Built-in Pi tools respect the selected permission. Any third-party Pi extension still runs with the authority it defines, so review installed extensions before use.
- Write workers intentionally have no arbitrary shell tool; their `edit` and `write` tools reject paths outside the approved scope before mutation.

## Checks

```bash
npm test
node scripts/test.mjs plan          # one file
node scripts/test.mjs --map         # src → test
node scripts/nav.mjs                # live API / UI / module map
node scripts/seed.mjs --list        # daemon state fixtures
node src/cli.js list backlog        # same actions as the dashboard
```

See [scripts/README.md](scripts/README.md).

Jujutsu is the default history layer: each serial implementation step is an editable change whose stable change ID survives evolving revisions. Accepted changes are exported as ordinary Git commits before the existing review and delivery flow. Dependency-ready siblings run serially in this mode for now. Use `--vcs git` (or `AGENT_PLAN_VCS=git`) only when a repository needs the compatibility path.
