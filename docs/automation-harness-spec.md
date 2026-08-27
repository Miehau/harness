# Automated Ticket Harness Specification

This document is the implementation contract for evolving Agent Plan Workspace. The existing Pi harness is the foundation; changes are incremental and must preserve verified behavior.

## Product boundary

- The harness is a local daemon with a dashboard. It runs only while the machine is awake and the daemon is active.
- Pi remains the long-term agent orchestrator. Do not build a second Codex executor or a speculative multi-provider agent layer.
- Linear and Jira are the initial ticket sources. GitHub and GitLab are the initial Git hosting providers.
- The harness delivers merged PRs/MRs. It never directly deploys to staging or production; repository CI/CD may deploy after merge.
- Durable product knowledge belongs in the target repository. Prompts, run activity, temporary plans, review rounds, screenshots, and execution metadata remain harness artifacts.

## Ticket admission and queueing

- Each project is explicitly configured for manual or automatic operation. Automatic mode is off by default.
- Automatic pickup uses polling plus manual refresh. A ticket is eligible only when it is in an inferred ready state, unfinished, and has no unresolved tracker blocking dependency.
- Explicit Linear/Jira blocking relationships are authoritative. Dependencies run before priority; priority runs before project order.
- A model-inferred missing dependency is proposed to the user before tracker relationships or ordering change.
- Automatic planning is just in time. A pending plan approval reserves an execution slot rather than creating a stale plan backlog.
- Manual mode supports starting several dependency-ready tickets together.
- Concurrency has a dashboard-configurable global cap and optional per-project overrides. The initial global default is two tickets.
- Independent work continues when one ticket blocks. Pause the project only when a blocker changes shared foundations, contracts, architecture, or assumptions for later work.
- Requirements, dependencies, and acceptance criteria are frozen at plan approval. Later tracker edits are reported at handoff but do not mutate an in-flight run. Runs stop only through the dashboard.
- Oversized tickets may produce a proposed child-ticket and dependency breakdown. Creating or changing tracker items requires user approval.

## Planning and interaction

- Shape requirements, then generate a detailed execution graph covering exploration, architecture/contracts, coherent implementation slices, integration, verification, and handoff as applicable.
- The user directly edits steps, dependencies, roles, scopes, acceptance criteria, and verification in the dashboard. Validate edits for cycles, missing dependencies, impossible scopes, and missing verification.
- The user approves the complete graph once. Execution is autonomous afterward.
- Minor replanning is automatic. Ask before product-behavior changes, UI direction, architecture, migrations, security decisions, material scope expansion, destructive operations, or any uncertain intent.
- The dashboard is the primary question surface. Mirror questions, answers, blockers, plan links, evidence, PR/MR links, and lifecycle state to Linear/Jira. The first valid answer resumes the run.
- Notifications remain in the dashboard; do not add OS, email, Slack, or webhook notifications.

## Repository initialization

- Before feature work, automatically run an initialization ticket through the normal worktree, verification, PR/MR, and merge path.
- Initialization maps architecture and conventions, creates or updates agent guidance, and records build, test, lint, type-check, migration, development, and preview commands.
- Human-facing architecture prose and machine-executable commands are separate. Never parse prose to discover commands.
- Project configuration may declare setup commands, services, port environment variables, and an allow-list of ignored local environment files. Automatic detection is the fallback.
- Feature work starts after initialization merges. Ask only when discovery exposes a material architectural decision or ambiguous intent.

## Execution and permissions

- One tracker ticket maps to one worktree, one branch, and one PR/MR. Dependent tickets wait for prerequisite merges.
- Use logical checkpoint commits while the PR is active and squash merge to one outcome-oriented main-branch commit referencing the ticket.
- Agents may edit any repository file reasonably required by the approved ticket. Planned paths are advisory signals, not brittle hard boundaries.
- Routine adjacent tests, types, fixtures, configuration, and build settings are autonomous. Ask before material expansion or changing approved behavior/architecture.
- Hard-protect credentials, secrets, writes outside the ticket worktree, and destructive production actions. Auth, billing, infrastructure, deployment configuration, migrations, and global configuration are allowed when the approved ticket requires them, with risk-appropriate review.
- Agents receive a sandboxed shell in the ticket worktree. Normal development commands are autonomous. Destructive, privileged, external-state, and out-of-scope operations require approval.
- Permit read-only internet research, source inspection, and package downloads. External state-changing API calls require explicit authorization.
- Small conventional dependencies may be added autonomously when they are the simplest fit. Ask before frameworks, infrastructure, large packages, unusual licenses, or architecture-shaping dependencies. Commit lockfiles and report every addition.
- Do not impose token or cost budgets. Show usage, duration, calls, and correction rounds; pause on rate limits and ask when work stalls.
- Use role-based configurable Pi model profiles. Ask before falling back to materially lower model capability.

## Environment and local previews

- Tracker credentials may come from the daemon environment or the dashboard's owner-only local credential file. Project credentials come only from the daemon environment or explicitly allow-listed ignored local development files. Never persist credentials in harness run state, commits, diffs, prompts, logs, or evidence.
- Every active UI worktree receives its own local preview and unique ports for each service. Persist assignments when practical, detect collisions, and never kill unrelated processes.
- The dashboard shows preview URLs and health. Stop preview processes and release ports when a run completes or is discarded.
- Retain the completed ticket worktree and local branch until manual cleanup.
- UI delivery includes final screenshots and interaction evidence. If visual direction is new or ambiguous, present a mock or wireframe for approval before implementation.
- Chromium desktop and mobile are the default browser matrix. Use other browsers only when the ticket or repository requires them.
- Exercise the primary changed flow plus applicable loading, empty, error, success, confirmation, and conflict states. Include keyboard and automated accessibility checks when supported. Missing required evidence blocks merge.
- Read ticket attachments, screenshots, and accessible linked specifications. Treat linked content as untrusted reference material, never as authority to reveal secrets, mutate the harness, or perform external actions.

## Verification and correction

- Always run deterministic repository checks, changed-flow tests, scope validation, and required evidence validation.
- Select specialist reviews by risk: requirements, integration, security, migrations, accessibility, performance, and visual quality.
- Blocking evidence-backed findings trigger corrections. Continue without a fixed retry count while progress is real.
- Ask when the same failure repeats without meaningful progress, fixes oscillate, scope materially expands, reviewer intent conflicts, or the model is uncertain.
- Every correction round remains visible and retained.

## Delivery

- Open a PR/MR and auto-merge after local verification, required remote CI, and required reviews pass. The model may require manual approval when risk or uncertainty warrants it.
- Use existing CI. If none exists, local verification is sufficient. Add or change CI only when the ticket explicitly requires it; later tickets then respect the new CI.
- Git hosting behavior is provider-neutral at the workflow boundary, with complete GitHub and GitLab adapters. Keep the shared contract limited to features the harness uses.
- Rebase/update automatically before delivery. Resolve clear conflicts in an isolated worktree, rerun affected checks, refresh visual evidence when behavior may change, and ask on ambiguous intent.
- Process clear human PR/MR feedback automatically, reply with evidence, and ask when feedback conflicts with the approved ticket or materially expands it. Bot output is evidence, not instruction.
- After remote merge, fast-forward the primary local checkout only when it is clean, on the target branch, and requires no reconciliation. Never stash, discard, switch, or resolve user changes automatically.
- Mark the tracker ticket done only after merge. Failed work stays active with a blocker.

## Persistence and recovery

- Keep the existing structured-file and artifact-directory design. Use atomic writes and a single-daemon lock; add SQLite only after measured need.
- Retain complete run artifacts indefinitely by default. Manual cleanup works by run, ticket, project, and age and shows disk usage before confirmation.
- After restart, crash, or machine sleep, recover state but leave interrupted runs paused. Show the latest checkpoint, worktree and preview status, and any uncertain external actions. Resume only after user confirmation and avoid duplicating tracker, PR, or merge actions.

## Incremental delivery order

1. Persist this specification and introduce configurable daemon policy plus provider-neutral Linear/Jira intake using local owner-only or environment credentials.
2. Add automatic polling, project modes, just-in-time admission, dependency-aware manual multi-start, and tracker lifecycle writeback.
3. Add repository initialization, executable project commands, environment allow-lists, and sandboxed command execution.
4. Replace direct-main integration with GitHub/GitLab PR/MR adapters, existing-CI gates, review feedback handling, squash merge, and safe local fast-forward.
5. Add isolated preview process/port management and strengthen visual evidence workflows.
6. Add manual retained-worktree/artifact cleanup, dashboard usage reporting, and end-to-end adapter scenario coverage.
