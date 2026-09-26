# Supervisor sessions

The optional supervisor is an ordinary trusted OMP session for discussing requirements,
starting tasks, watching them, answering decisions, and accepting candidates.

## Start and watch

```sh
agent-plan supervisor --provider PROVIDER --model MODEL
```

Any configured OMP provider works; extra OMP arguments such as `--continue` are passed
through. Existing OMP setups can load `runner/supervisor-extension.js` with `omp -e`.

Explicit `--session`, `--resume`, `-r`, and `--fork` transcript file paths require an
adjacent `.backend.json` marker identifying the pinned OMP backend/version. Existing
unmarked files fail closed, including genuine unmanaged OMP transcripts and Pi files
copied into an OMP directory. Preserve them and start a fresh default OMP session;
the runner does not convert Pi history or infer provenance from its directory.
Default OMP session IDs, the resume picker, and `--continue` remain native. Custom
`--session-dir` or `PI_CODING_AGENT_SESSION_DIR` history selection requires an explicit
marked transcript path. Relative paths are checked against `--cwd` when supplied.

The CLI also loads the bundled [pstack skills](../../codex/agent-plan/runner.md).
Use these in the supervisor conversation (no copying skill files into your project):

| Command | Use |
| --- | --- |
| `/skill:how How does our export pipeline work?` | Trace current behavior and ownership. |
| `/skill:why Why do exports use a background job?` | Recover evidence and separate it from inference. |
| `/skill:architect Add incremental exports` | Compare at least three designs together, then delegate authorized implementation. |
| `/skill:arena Compare export API designs` | Request independent proposals and cross-judgment directly. |
| `/skill:blast-radius Check the export format change` | Investigate affected contracts and concrete safety evidence. |
| `/skill:open-pr Publish the verified candidate` | A separately authorized hosted publication step. |

When loading the extension manually, also pass `--skills /absolute/path/to/agent-plan-workspace/codex/agent-plan/skills`.
Skill source lives in the runner installation. New tasks snapshot it with all
supporting references, so workers in another repository can read the same version.
Project-selected skills remain a separate configuration. Existing tasks retain their
old snapshots; restart the supervisor to load newly integrated skills.

Discuss the problem, constraints and architecture in this main session. When design
is unresolved, ask for competing proposals. The supervisor uses `runner_supervisor`
`start` with a **preparation-only** brief: at least three independent architecture
workers inspect separate worktrees at the same committed base and return proposals.
The coordinator keeps that base fixed and batches workers when capacity is below
three. Proposals are artifacts; architecture workers must not edit repository files.

The coordinator returns all proposal references and a comparison through the existing
`ask` decision with `requiresOwner:true`. The supervisor reads the proposals, compares
tradeoffs, recommends an approach and discusses the choice with you. It sends a draft
handoff through `feedback` before collecting your answer, so the coordinator receives
the design context as well as your exact reply. The handoff records what to build,
how and why, rejected alternatives, contracts, acceptance criteria, worker discretion,
the exact base and proposal references. Feedback alone never authorizes implementation.

Your answer selects the approach and whether to implement or continue preparation.
The same coordinator publishes the agreed architecture and handles implementation,
tests and review while you discuss the next feature here. A request for more research
or a design-only choice does not authorize implementation. Challenges to agreed
architecture return here; routine implementation choices stay with the workers.
Small understood changes or architecture already agreed in this session can go
straight to an implementation brief with the decision's source, without another
architecture round or confirmation.

Both briefs use the existing `start` action with the repository path or alias, scope,
acceptance criteria and a stable request ID; optional model settings select the
coordinator. Preparation versus implementation is workflow policy in the brief, not
a new runtime task status. The existing pending human decision blocks coordinator
actions; proposal count and interpretation of the agreed scope are agent instructions.
The tool submits, watches and launches through the runtime; identical retries reuse
durable receipts, including after uncertain responses. Do not create a second task
for the implementation handoff.

The same tool can `watch` an existing task. `/runner-watch FULL_TASK_ID` and
`/runner-unwatch FULL_TASK_ID` remain available. Pending questions are delivered
immediately; later questions, attention, completion, and failure wake the supervisor
without polling the model. Watches and consumed event IDs persist in the OMP session.

## Human decisions and acceptance

Before launch, `ask_user {text}` gathers missing requirements. For a coordinator
decision, `ask_user {taskId,decisionId}` opens an input dialog and sends exactly the
human response to that pending decision. Routine answers may use `answer` and are
recorded as supervisor answers. New scope, product choices, `requiresOwner` decisions,
and approval actions always use the human dialog.

`accept {taskId,commit,target?}` shows the exact repository, verified commit, and target
before requesting confirmation. Hosting-configured tasks display the provider and
PR/MR URL, then merge only that approved revision after required CI and provider merge
requirements pass. Local-only tasks use rebase, verification and fast-forward merge. Cancelled dialogs send nothing, and
headless sessions cannot provide approval. Responses are persisted by request ID so a
retry cannot prompt again or repeat a completed action; changed decision/commit/target
requires a new request.

This is trusted local operator access with ordinary OMP tools, not a sandbox. The
extension's model/human distinction does not protect against arbitrary local shell
commands. No webhook is required.

## Memory and checkpoints

The supervisor stores `supervisor/memory.md`, `supervisor/tasks/SLUG.md`, and
`supervisor/state.json` under `RUNNER_DATA`. The index holds preferences and links;
task notes hold scope, criteria, decisions, unresolved questions, artifact references,
and next actions. Original transcripts and runtime artifacts remain the detailed record.

The index and filenames load each turn; task contents load on demand. `memory_write`
uses exact previous contents and atomic replacement, with a 12,000-character index and
24,000-character task-note limit. Before asking the owner, the supervisor consults
agreed requirements and conventions and cites the basis for routine answers. Scope
changes, unclear tradeoffs, and approvals still go to the owner.

`/runner-checkpoint` asks the agent to save current discussion, persists watch state,
then requests OMP compaction. Native and automatic compaction use OMP's normal summarizer
with a deterministic recovery footer for session, transcript, watches, and memory paths.
Compaction failure cancels rather than silently dropping continuity. Unsaved conversation
is not converted into task notes automatically.

Live state must always be inspected before acting; saved references are not current
status or approval. This storage assumes one supervisor per data directory. Use
separate data directories for simultaneous supervisors.

Completed hosted candidates with open requests stay watched for failed CI; pending
and successful CI updates do not wake the model. Merged or closed requests and other
terminal or missing tasks are unwatched after eligible final events are consumed.
Connection failures keep watches. Reattach explicitly when
resuming historical work; Herdr idle alone is not completion.

## Lifecycle actions

The supervisor can `cancel`, `resume`, or `recover` using a stable request ID.

- `cancel` retains worktrees and artifacts and reports stop errors.
- `resume` inspects the task, restores its watch, and resumes the coordinator's saved
  attempt. It cannot reopen terminal tasks or answer a human decision.
- `recover` requires the exact inspected operation, an `applied` or `aborted` outcome,
  and observed evidence. It records already-resolved state; it does not resolve
  conflicts or discard work.

The runtime still rejects active command groups, dirty or unresolved Git state, and
unproven integration outcomes. Changed operations invalidate prior requests. Recovery
restores monitoring but does not resume an agent or approve delivery automatically.

## Onboarding and MCP

Use `/runner-onboard ALIAS_OR_PATH`, the supervisor tool's `onboard` action, or
`agent-plan onboard REPO` to prepare a project. Existing skills remain available.
The tool reuses its `requestId` for uncertain retries; CLI callers can supply
`--request-id ID` to reuse the same onboarding task and launch.
GrokBot can read their instructions with `agent-plan skills` and `agent-plan skills how`
(and `why`, `arena`, `architect`); returned source paths resolve supporting references.

OMP discovers MCP from `~/.omp/agent/mcp.json` or `.omp/mcp.json`. The obsolete
`--mcp-config` argument reports migration instructions rather than silently ignoring
configuration; `--mcp` is accepted for compatibility. The Pi MCP adapter is no longer loaded.

Managed sessions use native tools plus runner tools under trusted local execution.
Only explicitly loaded extensions and selected skill snapshots enter managed workers.
Task content does not authorize approval or unrelated external writes. See
[hosted delivery](hosted-delivery.md) for PR/MR publication and exact-head approval.
