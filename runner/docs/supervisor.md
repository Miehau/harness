# Supervisor sessions

The optional supervisor is an ordinary trusted Pi session for discussing requirements,
starting tasks, watching them, answering decisions, and accepting candidates.

## Start and watch

```sh
agent-plan supervisor --provider PROVIDER --model MODEL
```

Any configured Pi provider works; extra Pi arguments such as `--continue` are passed
through. Existing Pi setups can load `runner/supervisor-extension.js` with `pi -e`.

Discuss requirements, then ask the supervisor to start the ticket. Its
`runner_supervisor` action takes the repository path or alias, agreed requirements and
acceptance criteria, and a stable request ID. Optional model settings select the
coordinator. It submits, watches, and launches through the runtime; identical retries
reuse durable receipts, including after uncertain responses.

The same tool can `watch` an existing task. `/runner-watch FULL_TASK_ID` and
`/runner-unwatch FULL_TASK_ID` remain available. Pending questions are delivered
immediately; later questions, attention, completion, and failure wake the supervisor
without polling the model. Watches and consumed event IDs persist in the Pi session.

## Human decisions and acceptance

Before launch, `ask_user {text}` gathers missing requirements. For a coordinator
decision, `ask_user {taskId,decisionId}` opens an input dialog and sends exactly the
human response to that pending decision. Routine answers may use `answer` and are
recorded as supervisor answers. New scope, product choices, `requiresOwner` decisions,
and approval actions always use the human dialog.

`accept {taskId,commit,target?}` shows the exact repository, verified commit, and target
before requesting confirmation. Approval uses the runner's existing rebase, verification,
and local fast-forward merge. It never pushes. Cancelled dialogs send nothing, and
headless sessions cannot provide approval. Responses are persisted by request ID so a
retry cannot prompt again or repeat a completed action; changed decision/commit/target
requires a new request.

This is trusted local operator access with ordinary Pi tools, not a sandbox. The
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
then requests Pi compaction. Native and automatic compaction use Pi's normal summarizer
with a deterministic recovery footer for session, transcript, watches, and memory paths.
Compaction failure cancels rather than silently dropping continuity. Unsaved conversation
is not converted into task notes automatically.

Live state must always be inspected before acting; saved references are not current
status or approval. This storage assumes one supervisor per data directory. Use
separate data directories for simultaneous supervisors.

Completed, failed, cancelled, or missing tasks are unwatched after eligible final
events are consumed. Connection failures keep watches. Reattach explicitly when
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

## MCP ticket sources

```sh
agent-plan supervisor --mcp
agent-plan supervisor --mcp-config /absolute/private/tickets.json
```

This loads `npm:pi-mcp-adapter@2.33.0` through Pi's package loader; first use may need
network access. Configure the actual server with `/mcp setup` or the adapter's JSON:

```json
{
  "mcpServers": {
    "tickets": {"url": "https://your-ticket-server.example/mcp"}
  }
}
```

The URL is a placeholder. Keep credentials in private configuration or the adapter's
authentication store. Configuration merges normally; `--mcp-config` is not an isolated
security boundary. See the
[adapter documentation](https://github.com/nicobailon/pi-mcp-adapter) for authentication
and tool-approval policies.

Incoming ticket text does not authorize task acceptance or writes back to the ticket
system. Managed coordinator and worker sessions expose only runner tools; MCP credentials
are never copied into task artifacts.
