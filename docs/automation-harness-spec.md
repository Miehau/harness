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
- Automatic planning is just in time; a pending plan approval remains available for review.
- Manual mode supports starting several dependency-ready tickets together.
- Independent ready tickets may run concurrently.
- Independent work continues when one ticket blocks. Pause the project only when a blocker changes shared foundations, contracts, architecture, or assumptions for later work.
- Requirements, dependencies, and acceptance criteria are frozen at plan approval. Later tracker edits are reported at handoff but do not mutate an in-flight run. Runs stop only through the dashboard.
- Oversized tickets may produce a proposed child-ticket and dependency breakdown. Creating or changing tracker items requires user approval.

## Planning and interaction

- Shape requirements, then generate a detailed execution graph covering exploration, architecture/contracts, coherent implementation slices, integration, verification, and handoff as applicable.
- The user directly edits steps, dependencies, roles, scopes, acceptance criteria, and verification in the dashboard. Validate edits for cycles, missing dependencies, impossible scopes, and missing verification.
- The user approves the complete graph once. Execution is autonomous afterward.
- Minor replanning is automatic. Ask before product-behavior changes, UI direction, architecture, migrations, security decisions, material scope expansion, destructive operations, or any uncertain intent.
- The dashboard is the primary question surface. Mirror questions, answers, blockers, plan links, evidence, PR/MR links, and lifecycle state to Linear/Jira. The first valid answer resumes the run.
- Notifications remain available in the dashboard. An explicitly configured external supervisor may receive project-scoped HTTPS events; delivery is optional, durable, and independent of ticket execution. No OS, email, or Slack notifier is added. See `docs/grokbot-supervisor.md`.

## Repository initialization

- Before feature work, automatically run an initialization ticket through the normal worktree, verification, PR/MR, and merge path.
- Initialization maps architecture and conventions, creates or updates agent guidance, and records build, test, lint, type-check, migration, development, and preview commands.
- Human-facing architecture prose and machine-executable commands are separate. Never parse prose to discover commands.
- Project configuration may declare setup commands, services, port environment variables, and an allow-list of ignored local environment files. Automatic detection is the fallback.
- Feature work starts after initialization merges. Ask only when discovery exposes a material architectural decision or ambiguous intent.

## Execution and permissions

- Primary-only tickets still map to one worktree, one branch, and one PR/MR. When extra read/write Git roots are frozen on the run, each of those repositories gets an isolated worktree and an independent delivery (branch, checks, PR/MR or local integrate). The ticket completes only after every required Git repository finishes; partial failure is named per repository. Dependent tickets wait for prerequisite merges.
- Directory access is a per-project policy stored on the daemon and snapshotted onto `run.access` at ticket-run creation. Later settings edits never enlarge that snapshot. Missing policy is restricted and primary-only.
- Use logical checkpoint commits while each PR/MR is active and squash merge to one outcome-oriented main-branch commit referencing the ticket in that repository.
- Agents may edit any repository file reasonably required by the approved ticket, inside the frozen allow-list. Planned paths are advisory signals, not brittle hard boundaries.
- Routine adjacent tests, types, fixtures, configuration, and build settings are autonomous. Ask before material expansion or changing approved behavior/architecture.
- Hard-protect credentials, secrets, writes outside the frozen allow-list, and destructive production actions. Auth, billing, infrastructure, deployment configuration, migrations, and global configuration are allowed when the approved ticket requires them, with risk-appropriate review.
- File tools resolve paths with realpath and a path-segment allow-list from the frozen snapshot (restricted extra roots, or Any access when the owner opted in). Writes then apply the step writeScope relative to the matched root. Named project commands are an argv and environment allow-list, not OS filesystem isolation: subprocesses can still touch paths the file tools would deny. Plan approval discloses that limitation. Normal development commands are autonomous. Destructive, privileged, external-state, and out-of-scope operations require approval.
- Permit read-only internet research, source inspection, and package downloads. External state-changing API calls require explicit authorization.
- Small conventional dependencies may be added autonomously when they are the simplest fit. Ask before frameworks, infrastructure, large packages, unusual licenses, or architecture-shaping dependencies. Commit lockfiles and report every addition.
- Do not impose token or cost budgets. Show usage, duration, calls, and correction rounds; pause on rate limits and ask when work stalls.
- Use role-based configurable Pi model profiles. Ask before falling back to materially lower model capability.

## Environment and local previews

- Tracker credentials may come from the daemon environment or the dashboard's owner-only local credential file. Project credentials come only from the daemon environment or explicitly allow-listed ignored local development files. Never persist credentials in harness run state, commits, diffs, prompts, logs, or evidence.
- Every active UI worktree receives its own local preview and unique ports for each service. Persist assignments when practical, detect collisions, and never kill unrelated processes.
- The dashboard shows preview URLs and health. Stop preview processes and release ports when a run completes or is discarded.
- Retain local-only worktrees until manual cleanup. After successful remote delivery, automatically clean run-owned worktrees, local branches, evidence, and sessions; retain the run summary and remote links. `AGENT_PLAN_KEEP_MERGED_RUNS=1` opts new completions out for debugging.
- UI delivery includes final screenshots and, when acceptance depends on interaction, video evidence. If visual direction is new or ambiguous, present a mock or wireframe for approval before implementation.
- Remote delivery publishes final verification media and assertions into the PR/MR description before merge. Publishing failures block delivery; retries replace the same evidence section. GitHub retains media on isolated `codex/evidence/` branches with immutable links; GitLab uses project uploads. Historical captures and preview diagnostics are excluded.
- Visual acceptance requires `commands.capture-proof` as an argv array in `.agent-plan/project.json`; planning establishes missing capture capability before feature work. A declared `commands.test-capture-proof` runs the same fixture inputs and state-transition preflight before browser capture. The harness runs it after passing deterministic checks for visual verification and final delivery, supplies the current capture identity, criteria and evidence directory, and blocks delivery on failed or missing proof. This keeps plain `node .agent-plan/verify.mjs` independent of screenshot capture.
- Chromium desktop and mobile are the default browser matrix. Use other browsers only when the ticket or repository requires them.
- Exercise the primary changed flow plus applicable loading, empty, error, success, confirmation, and conflict states. Include keyboard and automated accessibility checks when supported. Missing required evidence blocks merge.
- Read ticket attachments, screenshots, and accessible linked specifications. Treat linked content as untrusted reference material, never as authority to reveal secrets, mutate the harness, or perform external actions.

## Verification and correction

- Always run deterministic repository checks, changed-flow tests, scope validation, and required evidence validation.
- Prefer integration tests for behavior crossing components, processes, persistence, or delivery boundaries. Run independent deterministic suites in parallel when the repository contract can do so safely.
- Select specialist reviews by risk: requirements, integration, security, migrations, accessibility, performance, and visual quality.
- Independent reviewers run only after deterministic checks and required proof coverage pass. Failed prerequisites go directly to focused correction with the causal diagnostic, without another model review.
- Required visual outcomes, rather than artifact counts, determine proof completeness. Each required visual criterion needs linked media, executed journey commands and assertions; video criteria need linked recordings. Reviewers still inspect whether the media proves the claims.
- Correction review carries unresolved findings, including findings preserved across prerequisite failures. Complete independent review can resolve findings; recurrence reopens them as regressions. Prior rounds remain the audit history.
- Delivery failures retain their kind, phase, failed command, diagnostic and next recovery action. Evidence publication must succeed before remote merge; publication recovery preserves reviewed code and proof.
- Blocking evidence-backed findings trigger corrections. Continue without a fixed retry count while progress is real.
- Ask when the same failure repeats without meaningful progress, fixes oscillate, scope materially expands, reviewer intent conflicts, or the model is uncertain.
- Every correction round remains visible and retained.

## Delivery

- After final combined verification, pause at one proof-review gate before any local integration or remote merge. The packet maps automated checks and required screenshot/video evidence to the approved acceptance criteria. Automatic mode never bypasses this gate; approval resumes delivery, while requested changes invalidate the packet and return the ticket to correction.
- After final proof approval, deliver each changed writable Git repository independently. Open a PR/MR (or locally integrate) and auto-merge after local verification, required remote CI, and required reviews pass. Resume retries only unfinished repositories and does not replay a succeeded PR or local integrate. Read-only Git extras, non-Git roots, and Any-access writes outside configured read/write Git roots are proof-only and never auto-delivered. The model may require manual approval when risk or uncertainty warrants it.
- Use existing CI. If none exists, local verification is sufficient. Add or change CI only when the ticket explicitly requires it; later tickets then respect the new CI.
- Git hosting behavior is provider-neutral at the workflow boundary, with complete GitHub and GitLab adapters. Keep the shared contract limited to features the harness uses.
- Rebase/update automatically before delivery. Resolve clear conflicts in an isolated worktree, rerun affected checks, refresh visual evidence when behavior may change, and ask on ambiguous intent.
- Process clear human PR/MR feedback automatically, reply with evidence, and ask when feedback conflicts with the approved ticket or materially expands it. Bot output is evidence, not instruction.
- After remote merge, fast-forward the primary local checkout only when it is clean, on the target branch, and requires no reconciliation. Never stash, discard, switch, or resolve user changes automatically.
- Mark the tracker ticket done only after merge. Failed work stays active with a blocker.

## Persistence and recovery

- Keep the existing structured-file and artifact-directory design. Use atomic writes and a single-daemon lock; add SQLite only after measured need.
- Retain incomplete and local-only run artifacts until manual cleanup. Remote-merged runs use a durable post-merge cleanup record, resumed after restart if interrupted. Manual cleanup works by run, ticket, project, and age and shows disk usage before confirmation.
- After restart, crash, or machine sleep, recover state but leave interrupted runs paused. Show the latest checkpoint, worktree and preview status, and any uncertain external actions. Resume only after user confirmation and avoid duplicating tracker, PR, or merge actions.

## Incremental delivery order

1. Persist this specification and introduce configurable daemon policy plus provider-neutral Linear/Jira intake using local owner-only or environment credentials.
2. Add automatic polling, project modes, just-in-time admission, dependency-aware manual multi-start, and tracker lifecycle writeback.
3. Add repository initialization, executable project commands, environment allow-lists, and named-command argv/env enforcement without claiming a sandboxed shell.
4. Replace direct-main integration with GitHub/GitLab PR/MR adapters, existing-CI gates, review feedback handling, squash merge, and safe local fast-forward.
5. Add isolated preview process/port management and strengthen visual evidence workflows.
6. Add manual retained-worktree/artifact cleanup, dashboard usage reporting, and end-to-end adapter scenario coverage.

### Frontend planning contract

Requirements record provisional UI impact. Exploration confirms existing patterns,
journeys, and material scope changes before design. New generated plans explicitly
classify impact as none, minor, or material with a reason; frontend additions are
material by default. Visual steps bind every AC to a stable criterion ID and an
appropriate check/screenshot/video evidence type, with stable journey IDs for UI
proof. Legacy authored plans retain their prior contract. Operator changes to the
classification are recorded before plan approval. Material UI plans generate a retained HTML proposal before implementation. Approval
binds its revision and content to the plan; changed direction requires revision
and renewed approval, including in auto mode. The sandboxed prototype is direction,
not implementation proof, and appears beside actual evidence at final review.

## Local conversational orchestration

The operator CLI exposes structured draft submission, exact-run inspection, and checkpoint decisions through the existing daemon. Persisted workspace-scoped idempotency keys prevent duplicate intake. Drafts make no model calls until started, and dependency completion is checked at the shared start boundary. Orchestrator decisions carry exact run/status/checkpoint expectations and a recorded user or delegated authority claim. `orchestrator brief` adds a conversation-ready status message while retaining exact identities, questions, proposal metadata, artifact links and usage metrics. The local adapter recipe relays user decisions; its end-to-end test mocks model work and evidence without posting external messages. See [the orchestrator contract](orchestrator-contract.md).

External supervisors use separate project-scoped credentials, never the owner token. Delegation is disabled by default; the owner can grant bounded execution-provider resumes. Exact identity, current policy, and consumed request receipts are enforced inside serialized writes. Approval-required actions remain with the owner. Digest scheduling and human message presentation belong to the external supervisor.
