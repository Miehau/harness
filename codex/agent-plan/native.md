# Native Codex binding

Read [the workflow contract](shared/contract.md) and [the task record](shared/task-record.md).
These lifecycle skills execute in the current Codex session; they require no Herdr,
OMP daemon, runner server, credential bridge, or custom orchestration engine.
The six discussion skills select this native binding through their execution-binding
page; their engineering methods also work in the current native conversation.

## Capability and configuration

Load `.agent-plan/project.json`; only when absent use `.runner/project.json` for
compatibility. Never merge two project files. Overlay optional `.agent-plan/local.json`
only for execution and agent/model preferences, never checks or hosting. Private local
overrides never enter Git or published evidence. Require
`execution: { "mode": "native", "runtime": "codex" }`. For `runner`/`omp`
execution, route to the existing runner CLI if installed and authorized; otherwise
report that these lifecycle skills require native Codex and direct the owner to the
runner installation. Do not start a native task under runner configuration. Snapshot the effective
configuration in the private task record. Each `agents` role may optionally specify
`runtime`, `model`, and `provider`; omitted values inherit the active Codex runtime.
Check the exposed delegation API and allowed model overrides before dispatch.
A configured unsupported runtime, model, or provider is a blocking capability error:
report it explicitly, never silently substitute. Automatic Claude, Grok, Cursor,
or mixed-runtime native delegation is not implemented. Use official runtime
credentials only; never extract OAuth tokens or reuse private credential stores.

Native delegation requires both exposed subagent tools and authorization under the
current environment's instructions. Skill text cannot enable a disabled feature.
If unavailable, explain the missing capability. Only if the user explicitly chooses
bounded direct execution may the coordinator implement sequentially as a single
worker with a saved scope, command budget and stopping condition. Record this
exception; self-review is not independent review and cannot satisfy completion.
Required reviewers must later run independently in parallel in a capable session.
Do not start paid CLI/API agents to evade a delegation restriction.

## Private durable record

At onboarding choose the original source checkout and save its absolute path and
absolute Git common-dir identity (`git rev-parse --path-format=absolute --git-common-dir`).
Store tasks at `SOURCE/.agent-plan/tasks/TASK_ID/`, ignored by Git. Every integration
and worker worktree uses that saved absolute pointer, not its own `.agent-plan/tasks`.
Never write task state inside Git metadata. Restrict private directories/files to
the owner where supported. Back up this directory together with the repository.

Use [the task record](shared/task-record.md) for the record's fields. Save the brief,
acceptance criteria, decisions and owner replies, configuration snapshot, role/session
identities, worktree paths and bases, candidate SHA, verification logs, reviewer-role
report references, hosted request and evidence references, pending operations, and
exact-revision approval. Persist before and after side effects; write updates through
a temporary file followed by rename. Reports are immutable attempt-specific files;
create a new reference on retry. The coordinator alone updates the record. No tokens,
credentials or private override values belong in published artifacts.

## Work and review

Inspect attached managed worktrees before creating another. When the platform exposes
a supported worktree tool, use it first and wait for its completed path. Use explicit
base refs and returned absolute paths. If unavailable, native Git worktree creation
is the fallback. Preserve dirty checkouts and existing work; never reset, stash or
remove them to obtain a clean start. One coordinator integrates serially; implementation
workers own their assigned worktrees. Coordinators and reviewers do not edit product
files, except an explicitly selected bounded direct executor.

For a small understood task, save a short brief and AC, use one implementation worker,
then configured verification and parallel reviews. Discovery and architecture workers
are optional. For complex work, discuss competing proposals before implementation;
follow the shared contract's independent architecture round: three seats by default
or the owner's roster, identical frozen file references, no steering, and every seat
accounted for by a full proposal or evidence-backed failure. Missing proposals return
to the owner as a coverage gap. A recommendation never authorizes implementation.
Pass substantial content by file reference, keep full outputs, and wait on native
completion events without shell sleep or model polling loops. Confirm an old attempt
stopped before replacement. Select security, data-loss, concurrency, performance or UI
specialists from actual risks.
Sensitive plans receive targeted assurance before writers start.

Verify the integrated candidate using every configured command and save command,
exit status, logs and SHA. Then launch separate requirements/AC and correctness/code
quality reviewers in parallel on that same verified SHA, plus risk-selected specialist
reviewers from [the shared policy](shared/policy.json). Assign each a read-only role, AC and report destination. Use tool-enforced
read-only restrictions when available; otherwise disclose that role restrictions are
advisory and worktrees are not security sandboxes. Reviewers report evidence and
severity; medium and major findings block completion. Revisions invalidate verification
and every required role review. No generic final reviewer is required. Idle sessions,
completed tool calls and an implementer's claim are not completion evidence.

## Hosting, acceptance and interruption

Onboarding selects GitHub or GitLab (including configured self-hosted hosts), remote,
target branch, required verification and provider gates, or explicitly local delivery.
Use installed supported provider tooling and its official credentials. Publish only
when authorized; private evidence must retain repository access controls and stable
commit-pinned references. Record exact repository, request ID, target, head SHA and CI.
Publishing and a completion notice never grant merge approval.

Acceptance requires owner approval bound to the exact candidate and target, passing
verification, independent role reviews and current required provider CI/branch gates.
Re-read provider head and target immediately before mutation. A new head or target
requires fresh verification/review and exact-revision approval; never override failed
or unknown gates. Record the intended mutation first and observed result afterward.
For local delivery require a clean target checkout and verified fast-forward candidate;
if the target moves, stop instead of rebasing an approved candidate silently.

On interruption inspect durable records, live worktrees, Git history and provider state
before retrying. Classify each pending side effect as applied, not applied, or unknown.
Unknown outcomes block retries until resolved. Retain dirty work, failed reports and
unresolved decisions. Cleanup uses supported managed-worktree archive tools when
available, only after checking nothing still uses the checkout; preserve uncertain work.

Capability references: [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents),
[Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees), and
[plugin packaging](https://developers.openai.com/plugins/build/plugins).
Availability is established by the current session's tools, not these references.
