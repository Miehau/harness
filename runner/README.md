# Agent Plan runner

The primary application in this repository. The former visual pipeline is retired;
its final working-tree snapshot is retained in [archive/](../archive/README.md).
Existing legacy daemon state is not migrated.

## Run

Requires Node 22.19+, installed project dependencies, Git, and a running Herdr server.
The launcher puts this installation's Pi binary first on PATH (currently Pi 0.84),
so it does not accidentally use a different global Pi. Configure Pi credentials
normally before starting model work.

Install the command once with `./install.sh` from this checkout. The script also
works when invoked by its absolute path. Use `agent-plan help` or
`agent-plan help COMMAND` for usage; `agent-plan COMMAND --help` works too.
Then, from any terminal while Herdr is running:

```sh
agent-plan start /absolute/repo "Implement this feature"
agent-plan list
agent-plan open TASK
agent-plan stop TASK
```

`start` creates the task, starts the background runtime when needed, creates an
integration worktree and Herdr workspace, and focuses the Pi orchestrator. Workers
open their own sessions without taking focus away permanently. TASK accepts a full
ID or a unique prefix. No separate daemon terminal, submission file, or copied ID
is required for starting work. `stop` cancels execution while retaining worktrees.

Onboarding and discovery docs are optional. Without `.runner/project.json`, tasks
start with `bash verify.sh`; agents must reuse or establish meaningful verification
before completion. To specify another verification command explicitly:

```sh
agent-plan init /absolute/repo '["npm","test"]'
```

By default all terminals share `~/.local/state/agent-plan`. Set `RUNNER_DATA` to use
another data directory, including one created with the earlier manual setup. The
runtime stays in the background; startup failures are logged in its `daemon.log`.
`node runner/server.js /absolute/data-dir` remains available for foreground debugging.
Without installing a global command, use `npm run runner -- <command>` in this checkout.

When the orchestrator asks a question, it displays it in its Pi terminal. Type the
answer there; it is saved and applied to that exact decision before work resumes.
Only interactive input uses the separate terminal-reply credential. Model tools
cannot claim user approval. The CLI answer command remains available for automation:

```sh
agent-plan inspect TASK
agent-plan answer TASK DECISION_ID /absolute/answer.md
agent-plan dashboard
```

The dashboard URL contains owner access in its fragment; keep it private. It is an
optional view with no separate execution logic. External agents use the same CLI;
its owner credential is trusted operator access, not a public intake endpoint.

The inspector shows task/agent status, integration worktrees, decisions, verification,
and the event timeline. Click artifact filenames to read reports or command logs;
large files have a Load more button. Task status refreshes every five seconds without
closing the artifact you are reading. Refresh files fetches newly created artifacts.
Open in Herdr focuses the orchestrator workspace; switch tabs there to inspect workers.
The dashboard keeps access in tab session storage so browser refresh works. Full Pi
conversations remain in Herdr and the session files listed in Full task state.

For an inert draft, use `agent-plan submit REPO BRIEF_FILE REQUEST_ID`, then
`agent-plan start TASK`. Reusing a submission ID with identical input returns its
original task; changed input is rejected. Startup never automatically repeats a task
after an uncertain response: inspect the task ID shown in the error before retrying.
Submission snapshots committed HEAD, workflow, and command configuration; uncommitted
source changes are not copied.

## Repository configuration

`.runner/project.json` is owner-maintained configuration, snapshotted at submission:

```json
{
  "commands": {
    "install": ["npm", "ci"],
    "test": ["npm", "test"]
  },
  "setup": "install",
  "verify": ["test"],
  "maxWorkers": 2,
  "maxAttempts": 12,
  "timeoutMinutes": 60,
  "commandTimeoutMs": 120000
}
```

Optional `provider` and `model` select Pi's model. Otherwise Pi uses its configured
default. Each new worktree runs `setup` when configured. Commands are argv arrays,
never interpolated shell strings. Command stdout/stderr stream into files; responses
contain evidence references. Configure every required final check in `verify`.

`.runner/workflow.md` replaces the bundled main-agent workflow. The bundled
[workflow](workflow.md) documents the tools and a suggested method, not mandatory
stages. Workers receive the [worker instructions](worker.md). Agents can read
repository `AGENTS.md` with their scoped tools. The runtime enforces permissions,
identity, concurrency, and verification independently of Markdown instructions.

For new repositories, keep configuration and conventions in version control.
The runtime is installed once and accepts arbitrary Git repository roots; there
is no per-repo application code or required dependency on the old daemon.

## Execution and ownership

- Multiple tasks can run in the same repository, with separate integration and worker
  worktrees. Mutations serialize per task; Git worktree creation uses a short repository
  queue. Up to `maxWorkers` workers can run within a task.
- A task has an integration worktree. Each worker has its own worktree, including
  read-only exploration workers. The main agent cannot directly edit repository files.
- Workers can read their worktree and task artifacts. Writing workers can edit/remove
  repository files and invoke named commands. Exploration workers only write artifacts.
  Git/Pi internals and symlink escapes are blocked by the file API. Worktrees are
  isolation for development, not OS sandboxes; owner-configured commands execute
  under the runtime user's permissions. Configure commands only for trusted repos.
- Parallel writers must reference the same published contract. To revise it, the main
  agent pauses affected writers with a recorded question, publishes the revision,
  and answers their questions with the updated contract reference.
- Artifacts are immutable. Save a new revision instead of overwriting a published file.
  A report contains status and references; full transcripts remain in Pi session files.
- Completed worker changes are committed and integrated by the runtime. Integration
  waits for workers, executes serially, and refreshes final verification afterward.
- `completed` means a verified candidate branch. Owner acceptance can rebase, verify and merge the candidate locally. No push, PR
  or deployment occurs automatically. Failed workers can retain useful work.

The durable state is a small JSON file per task; artifacts, session transcripts,
and worktrees are separate. All state writes use atomic replacement. Keep the entire
data directory when backing up, plus the source repository's Git object database.

## Decisions, interruption, and recovery

Workers ask the main agent; the main agent asks the owner. Every answer targets an
exact decision. A worker cannot answer owner decisions or spawn other workers.
The user can answer worker decisions directly if intervention is needed.

A question stops that worker. Other independent workers can continue. The Pi
extension checks its inbox without model calls and wakes the agent with a batch of
file references. Successful turns acknowledge received message IDs. Delivery may
repeat after an uncertain crash; mutating tool calls use durable request receipts.
An uncertain receipt is surfaced rather than automatically repeating a side effect.

Herdr `idle` and `done` never complete a task. Missing sessions and expired attempt
budgets become attention events. The daemon preserves task state across restarts,
reuses its local port and credentials, and reconnects surviving Pi sessions.

```sh
node runner/cli.js resume TASK_ID AGENT_ID
node runner/cli.js cancel TASK_ID
```

Resume checks for a surviving session before starting Pi on its saved session file.
An unknown Herdr state blocks relaunch. Cancellation interrupts running named commands,
revokes task actions, and closes recorded agent tabs. Stop errors are returned.
Budgets bound concurrent workers, total created attempts, command duration, and each
running attempt's elapsed time. A recorded user wait is exempt from expiry; active
elapsed time includes gaps between model turns. Explicit resume grants a fresh window.

Interrupted named commands retain their process-group identity and output path. Recovery refuses to proceed while that process group is alive.

An interrupted integration leaves its Git state and operation record intact. Inspect
and resolve/abort the cherry-pick in the integration worktree before acknowledging it:

```sh
node runner/cli.js recover TASK_ID applied
node runner/cli.js recover TASK_ID aborted
```

The runtime checks the resulting Git state. Other interrupted operations require
inspection of the retained worktree before `recover`. No automatic reset discards work.
If integration creation failed before its identity was saved, cancel the task and
inspect its retained `worktrees/` directory; submit a fresh task after resolving it.

`cleanup TASK_ID` removes clean worktrees of terminal tasks. Dirty or interrupted
work is retained. Branches, artifacts, and histories remain available.

## GrokBot notifications

The adapter is available but disabled by default. No live bot connection is assumed.
Place an owner-only `webhook.json` in the data directory:

```json
{"webhook":{"url":"https://your-receiver.example/events","authorization":"Bearer YOUR_TOKEN"}}
```

The receiver must accept the runner's JSON event contract:
`version`, `eventId`, `taskId`, `kind`, `decisionId`, `artifact`, `occurredAt`.
Only decisions, attention, failure, and completion events are sent. HTTP requests
contain identifiers and file references, not task contents. The `Idempotency-Key`
header equals `eventId`. A timeout is recorded as unknown and is not automatically
retried. HTTP acceptance does not establish that GrokBot or the user acted.

`node runner/cli.js notifications` reads receipts. On first configuration, retained
matching events are eligible for delivery; inspect task histories before enabling.
The terminal answer endpoint requires a separate session credential and an exact decision; there is no public answer endpoint or implicit bot approval authority. A trusted
local operator can use the CLI to inspect and relay exact decisions. A live GrokBot
receiver/payload mapping and human-answer relay must be agreed before enabling it.

## Verification and rollout

```sh
node scripts/test.mjs runner
node scripts/test.mjs --check
node runner/probe.js
```

Tests use real disposable Git repos and fake Herdr agents. They cover question/answer,
restart, identity, parallel contracts, verification, and uncertain notification outcomes.
The opt-in probe launches a real Pi session in Herdr with an empty inbox, verifies the
extension heartbeat, then closes its temporary tab. It makes no model calls.

Evaluate small fixes, FE/BE parallel work, exploration,
and interrupted tasks using fixed acceptance checks. Compare completion correctness,
time, cost, and interventions. A passing transport probe or mocked-model test is not
an end-to-end quality benchmark. This first version does not claim production parity
with the archived harness or autonomous conflict resolution.

## Task models, onboarding and feedback

```sh
agent-plan start /repo "Implement the story" --model MODEL --provider PROVIDER
agent-plan onboard /repo --model MODEL
agent-plan feedback TASK /absolute/feedback.md
```

Onboarding creates a normal isolated task to explore the repository and write
`verify.sh`, its configuration, and an experimental `.runner/feature-map.md` index
linking to focused `.runner/features/<feature>.md` documents. Agents can load the map,
then only relevant features and code references. For brownfield repositories it also
produces `.runner/architecture.md`: high-level concepts, boundaries, patterns and
conventions observed in the code. DDD terminology is used where supported, not imposed. Empty repos/scaffolds skip architecture
and explain the omission. Maps distinguish observations, inferences, test evidence
and uninspected areas; existing curated docs are preserved and referenced.
Copies are published as current documents in the inspector. The reusable instructions
are in [onboarding.md](onboarding.md) and are snapshotted into each onboarding brief. If configuration is absent, the CLI creates a
minimal `.runner/project.json` in the source repo first. Existing configuration is
preserved. The onboarding task must pass both existing checks and `bash verify.sh`.
The script remains a candidate until reviewed/integrated into the source branch.
Its reliability still depends on meaningful test coverage; a zero exit alone does
not establish that a test suite is adequate.

Worker `spawn` accepts optional `model` and `provider`; omitted fields inherit the
task settings. Selection is saved on each agent and reused on resume. Feedback is
an owner-authenticated message to an unfinished task; it does not answer a pending
decision or resume a waiting coordinator. Use `answer` for that exact decision.
GrokBot/Moshi adapters can relay these same CLI operations; no mobile connector or
public cloud endpoint is configured by this change.

## Artifacts, document revisions and recovery

```
tasks/TASK/
  artifacts/
    brief.md, workflow.md, worker.md, config.json
    orchestrator/                 # plans, architecture, evidence, handoff
    workers/WORKER-ID/            # worker output, checkpoints, PNG evidence
    coordination/SOURCE-TASK/     # copied peer proposals
    runtime/                     # system reports and recovery details
  worktrees/integration/
  worktrees/w-ID/
  sessions/AGENT-ID.jsonl
```

Workers may write artifacts only inside their assigned directory. The coordinator
and owner may create artifacts across directories; no published artifact is overwritten.
`revise {name,artifact,previous}` updates the current document pointer with an explicit
previous revision, retains history and notifies workers. Shared contract changes still
require pausing affected writers. `checkpoint {artifact}` records resumable progress;
command completion also records its evidence. A hard crash preserves already written
files/session data, but cannot preserve unsaved model reasoning.

These ownership rules apply to runner file tools. Configured commands are trusted
local code, not an OS sandbox: do not treat Git worktrees as a security boundary.

`peers` and `coordinate {taskId,artifact}` let coordinators exchange durable proposal
files within the repository. Delivery happens during reconciliation. Coordinators
must explicitly pause affected workers and agree on contracts; semantic overlap is
not automatically detected. Conversations are artifact references, not shared context.

## Browser evidence helper

`runner/browser.js` uses the target repo's installed `playwright` and Chromium. See
[Playwright setup](https://playwright.dev/docs/library). It does not install dependencies
or launch the application server automatically. Add its absolute path as a named
command with a repo-relative scenario JSON path. Example scenario:

```json
[
  {"action":"goto","url":"http://127.0.0.1:3000"},
  {"action":"fill","label":"Name","value":"Michal"},
  {"action":"click","name":"Greet"},
  {"action":"visible","text":"Hello, Michal!"},
  {"action":"screenshot","criterion":"AC-1"}
]
```

Each execution uses a disposable browser and saves `.runner-ui-*/result.json` and
PNG files. Ignore `.runner-ui-*/` in the target repo. The agent calls
`publish {path:".runner-ui-.../1.png"}` to copy a PNG into its immutable artifact
directory; `runner_read` returns image content and the dashboard previews it.
Use `ask` with a question artifact referencing the image to request design feedback.
The helper is a small scenario runner, not a persistent interactive browser session.

## Repository aliases

```sh
agent-plan repo add demo /absolute/path/to/repo
agent-plan repo list
agent-plan start demo "Implement the next story"
agent-plan onboard demo
agent-plan repo remove demo
```

Aliases also work with `init` and `submit`. They are saved under the runner data
root in `repos/` and work from any directory. Explicit paths remain supported;
use `./demo` to choose a local directory instead of the saved alias. Registration
requires an existing Git repository root. Removing an alias never removes its repo
or tasks. To change its target, remove and register it again. `RUNNER_DATA` selects
an independent alias collection alongside that runtime's tasks.

## Maintaining the feature map

The bundled coordinator and worker workflows require feature-document maintenance
as part of implementation: new capabilities add a feature document and index entry;
changed/removed capabilities update the relevant documents and links. Architecture
changes only when concepts, boundaries or patterns change. A worker owns shared index
edits during parallel work, and documentation integrates with the code before final
verification. Without an existing map, new features start a minimal map explicitly
marked as partial coverage. Small fixes do not trigger full-repository onboarding.

This is a workflow instruction, not an automatic semantic completeness check. Custom
.runner/workflow.md files replace the bundled coordinator workflow and should carry
this instruction too. Already-created tasks retain their original workflow snapshots.


Each new task saves a small discovery.json artifact listing feature-map, architecture
and features-directory paths present in its committed base. Coordinator and worker
assignments reference that manifest; the Pi extension tells agents to read it. The
manifest contains paths, not bulk document contents. Missing docs are normal. Uncommitted
discovery files are not included in worktrees; commit them before starting a task if
you want agents to use them. Coordinators select relevant feature references for worker
assignments, and workers follow those links progressively.


## Delegated stages and model menu

New tasks use discovery → architecture worker → planning worker → coordinator
clarification → implementation → verification. The first three workers are read-only
for repository files. The coordinator publishes their document references, resolves
material questions with the owner, and calls `clarify` before starting writers. A new
current-document revision invalidates that checkpoint. Existing task snapshots retain
their previous workflow.

Every task receives `model-menu.json`, and the coordinator's system instructions
identify its actual running model. `spawn` accepts a named `modelChoice`: discovery,
planning, implementation or complex. Discovery defaults to
`openai-codex/gpt-5.6-luna`; other choices inherit the coordinator unless configured.
Explicit provider/model overrides require `modelReason`. Pi availability is checked
before worker worktree creation; names or missing credentials are not silently replaced.

Configure alternatives in `.runner/project.json`, for example:

```json
{
  "workerModels": {
    "discovery": {"provider":"openai-codex","model":"gpt-5.6-luna","purpose":"Cheap bounded discovery"},
    "planning": {"provider":"openai-codex","model":"gpt-6-astra","purpose":"Architecture and planning"}
  }
}
```

This is a snippet to add to existing configuration, not a replacement for commands.
`--discovery-model`, `--discovery-provider`, `--planning-model`, and `--planning-provider`
can set stage defaults at task creation; explicit workerModels entries take precedence.
No runtime claim is made that a model is cheapest or that its output is sufficient.

## Accept a candidate

```sh
agent-plan accept TASK COMMIT
# Different local target:
agent-plan accept TASK COMMIT --target master
```

COMMIT is optional; without it the CLI selects the task's recorded verified commit.
Acceptance authorizes rebasing those task changes onto the local target (main by
default), rerunning verification and fast-forward merging. The source checkout must
be clean and on that target. No remote fetch or push is performed. Acceptance is
serialized per repository; unrelated task work continues asynchronously.

Dirty work, stale approval, rebase conflicts, failed checks or a target that advances
during verification stop delivery. Nothing resets or stashes user changes. Inspect the
retained state; resolve/abort any rebase before `recover TASK applied|aborted`, then
`verify TASK` and accept the reviewed commit again. An interrupted merge has its own
record, allowing recovery to confirm the commit is already on the target without
repeating it. The dashboard shows delivery state and an explicit accept button.

## GrokBot-style notifications

The adapter follows Limen's explicit opt-in, bounded sending and durable receipt
pattern. It does not reuse Limen's private config or assume that HTTP 2xx woke a bot.
To configure it, save a private JSON file outside a worker repo:

```json
{
  "webhook": {
    "url": "https://your-receiver.example/events",
    "authorization": "Bearer YOUR_TOKEN",
    "format": "grokbot"
  }
}
```

Then run `agent-plan webhook /absolute/private-config.json`. The URL/auth are not
printed. Authorization may be omitted if the receiver uses a secret URL. New events
are eligible from configuration time; set an explicit `since` timestamp only when
intentionally including older events.

The v2 payload includes Limen-style job/status/branch fields plus event/task/decision
IDs, up to 10,000 characters of question/problem text, explicitly attached files and
CLI reply instructions. PNG attachments are base64, at most four files and 1 MB each;
larger files carry an omission notice and artifact reference. Use `ask` with attachments
for a blocking question, or coordinator `surface` for a nonblocking problem/preview.
The bot must support this JSON shape to render images; a webhook URL alone does not
prove receiver compatibility. No owner credentials or authenticated dashboard links
are included. Responses still use the existing owner answer/feedback interface.

`agent-plan notifications` shows accepted/failed/unknown transport receipts; wake
remains unobserved. Requests have a five-second timeout, reject redirects and are not
blindly retried after uncertainty. No live webhook has been configured or tested yet.

The bundled `workflow.md` is a short entry point into `workflow/` reference pages.
All pages are snapshotted into each task; coordinators read stage, coordination,
documentation and tool details as needed. Existing tasks retain their original snapshots.
Repository `.runner/workflow.md` overrides still replace the entry point.

The inspector lists each agent’s saved output files beneath its step, with direct
links to failure details, checkpoints and command evidence. The evidence reader
also has an expandable directory tree; folders load when expanded. Failure records
include the observed transport status, heartbeat time and session location.

### Grok action contract

Grok notifications include `action`, `from: "harness"`, `task`, `branch`, and `message`.
Completed candidates map to `approval` with evidence references; owner questions default
 to `opinion`; failures/attention map to `problem` with a problems array. `pr` is optional
and only sent when explicitly supplied. Artifact references, images and exact reply
identities remain attached. Completion replies point to explicit owner acceptance.

Coordinator `ask`/`surface` accepts `hook: {action, pr?, evidence?, problems?}`.
Aliases normalize: pr-approval/impl-approval → approval; harness-opinion → opinion;
impl-problem/blocker → problem. Approval requires a real owner answer; opinions are
for product choices; problems need a question only when blocked. Probe/health/noop
are never sent. Merged events do not generate another Grok approval request.

### Private webhook configuration

Copy the committed `webhook.example.json` to `webhook.json`, fill in your receiver
URL and Bearer token, then run `agent-plan webhook /absolute/path/to/webhook.json`.
The local `webhook.json` is ignored by Git; never put real values in the example.
The CLI installs a private copy at `~/.local/state/agent-plan/webhook.json` (mode 600),
or under `RUNNER_DATA` when set. Credentials remain plaintext readable by your OS user.
New events are enabled from configuration time. Existing `supervisor.json` settings
migrate automatically without changing their notification start time or replaying receipts.
An existing `webhook.json` takes precedence; invalid JSON is reported, not bypassed.

## Pi supervisor sessions

`agent-plan supervisor --provider PROVIDER --model MODEL` opens an ordinary Pi
session with the runner supervisor extension. Any configured Pi provider works.
Extra Pi arguments are forwarded (for example `--continue` to resume a session).
For an existing Pi setup, load `runner/supervisor-extension.js` with `pi -e`.

Discuss requirements in the supervisor chat, then ask it to spin up the ticket.
Its `runner_supervisor` start action takes `repo` (path or saved alias), `text`
(agreed requirements and acceptance criteria), and a stable `requestId`. Optional
`model`/`provider` select the coordinator. It submits and launches through the runtime
API and automatically watches the task before launch. The coordinator delegates to
workers; you do not need to watch them or run a CLI command. Retries reuse the same
requestId and runtime receipts, including after an uncertain launch response.

The tool also supports `watch {taskId}` for existing tasks.
`/runner-watch FULL_TASK_ID` remains available; `/runner-unwatch FULL_TASK_ID`
detaches. Pending questions are included immediately; other historical events
before attachment are omitted. Watches and successfully consumed event IDs persist
in the Pi session. Questions, attention and completed/failed results wake the
supervisor without polling the model. It reads artifacts, including PNG previews,
and uses `runner_supervisor` to send nonblocking feedback to coordinators.

The supervisor uses `ask_user {text}` for requirements questions before starting,
or `ask_user {taskId,decisionId}` for a coordinator question. Pi displays an input
dialog in the same session; the extension sends exactly what you type to the
pending decision as a human reply. No IDs or slash commands need to be copied.
The coordinator resumes and relays the decision to its waiting workers.

Routine questions use `answer {taskId,decisionId,text}` and are recorded as
`answeredBy: supervisor`. New scope/product choices, `requiresOwner` decisions and
approval hooks use the human dialog. The optional `/runner-answer` shortcut remains.

Once evidence is ready, `accept {taskId,commit,target?}` opens a confirmation showing
the repository, exact verified commit and target branch. Approval runs the existing
rebase, verification and local merge operation; it does not push. Cancelled dialogs
send nothing, and headless sessions cannot supply human approval. Human responses
and approvals persist in the Pi session keyed by requestId (tool call ID by default),
so retrying the same request does not prompt again or repeat a completed operation.
A changed decision, commit or target requires a new request and human interaction.

This is a trusted local operator session with ordinary Pi tools and owner CLI access,
not a sandbox: the extension's human/model distinction is not protection from
arbitrary local shell commands. No Grok webhook is required; an existing webhook
continues independently.

## Selected managed skills

Add `"skills": [".agents/skills/review/SKILL.md"]` to `.runner/project.json`.
These are explicit repository-relative paths (maximum 20), committed before task
submission. The runtime snapshots those instructions from the task's base commit,
ignoring uncommitted replacements, and gives coordinators and workers a `skills.json`
manifest. No automatic global skill discovery is enabled for managed agents.

Agents read the selected snapshots with `runner_read`. Relative supporting files
are resolved against each manifest entry's original repository source directory.
Skill instructions use runner file tools; scripts must be exposed as named commands
by the owner. A skill cannot grant new tools or approval authority. Personal skills
must first be copied into the repository and committed to use them in managed tasks.
Ordinary supervisor Pi sessions retain Pi's native skills and tools.

## MCP in the supervisor

```sh
agent-plan supervisor --mcp
# Or explicitly select an adapter config (also enables MCP):
agent-plan supervisor --mcp-config /absolute/private/tickets.json
```

The launcher loads `npm:pi-mcp-adapter@2.33.0` through Pi's existing package loader.
First use needs network access to install/cache it. The adapter supplies MCP tool
and resource discovery, stdio/HTTP transports and its authentication UI. Configure
your actual ticket server using `/mcp setup` or its documented JSON format:

```json
{
  "mcpServers": {
    "tickets": { "url": "https://your-ticket-server.example/mcp" }
  }
}
```

The URL above is a placeholder, not a configured integration. Keep credentials in
private configuration or the adapter's authentication store. The adapter uses its
normal config merging; `--mcp-config` is not an isolated configuration boundary.
See [adapter documentation](https://github.com/nicobailon/pi-mcp-adapter) for server
options, `/mcp-auth`, `excludeTools` and `approveTools` policies.

Ask the supervisor to read a ticket and start it with the agreed requirements.
Its start tool launches and automatically watches the coordinator. Ticket changes need your
instruction; incoming ticket content does not authorize writes or task acceptance.
Managed coordinator/worker sessions still disable ambient extensions and expose
only runner tools. No MCP server credentials are copied into task artifacts.

## Required UI evidence

Browser navigation/capture tooling belongs to the target project. To enforce evidence
for every task in a frontend repository, add a named command and policy to its
owner-maintained `.runner/project.json` before submitting tasks:

```json
{
  "commands": { "test": ["npm", "test"], "ui": ["npm", "run", "verify:ui"] },
  "verify": ["test"],
  "uiEvidence": { "command": "ui" }
}
```

The runtime runs `ui` after ordinary verification, on the integration candidate and
again during acceptance after rebase. It provides RUNNER_UI_DIR, RUNNER_UI_COMMIT and
RUNNER_UI_RUN_ID. The project command starts/stops its app, runs browser assertions,
and writes media plus manifest.json to that unique output directory. The schema is
in [UI evidence](workflow/ui-evidence.md), which agents load conditionally for frontend
work. Existing tasks retain their configuration and instruction snapshots.

Each manifest criterion requires a passing assertion and at least one PNG, WebM or
MP4. The runtime checks run/commit identity, file boundaries, sizes and media headers,
then copies evidence into immutable artifacts. Missing, failed or stale evidence
fails verification and blocks completion/acceptance. It does not infer frontend files,
prove assertion quality, decode media, or automatically judge visual correctness.
When configured, the gate applies to all tasks in that repository, including backend
changes; without configuration, frontend evidence remains a workflow requirement.

PNG publication retains its 10 MB cap; WebM/MP4 publication allows 25 MB. The inspector
plays video. Artifact reads return video metadata and a localPath by default; an
explicit `read {area:"artifacts",path,includeMedia:true}` returns base64 for playback
or relay. Pi/Claude supervisor tools return video metadata as text, never as an image.

Completion events expose the evidence manifest and up to four media attachments to
the supervisor and webhook adapters. The manifest includes every media reference.
Grok sends small PNGs inline; videos and larger files carry an authenticated artifact
read request for a trusted local relay. No public media hosting or credentials are
added. Receiver-side playback/forwarding requires that adapter to implement retrieval;
no live Claude/Grok delivery is claimed. Use `surface`/`ask` attachments for previews.

### Supervisor memory and context checkpoints

The supervisor keeps `supervisor/memory.md` and `supervisor/tasks/SLUG.md` under
`RUNNER_DATA` (the default runner data directory otherwise). The index holds priorities,
preferences and links; task files hold scope, acceptance criteria, decisions and their
sources, unresolved questions, artifact references and next actions. Files can exist
before launch. Launch creates a task-ID note with the brief reference; the supervisor
links it to any pre-launch feature discussion. Completed files remain available.

The index and available filenames are loaded into each turn; task contents are read
on demand with `runner_supervisor memory_read`. `memory_write` requires the exact
previous contents, uses atomic replacement, and limits the index to 12,000 characters
and task notes to 24,000. The supervisor is instructed to update notes after meaningful
changes and before ending its turn. Original Pi transcripts and runtime artifacts
remain the detailed record; unsaved conversation cannot be recovered from these notes.

Use `/runner-checkpoint` to ask the agent to save outstanding discussion and then call
`compact_memory`, which persists watch state and waits for the turn to finish before
requesting Pi compaction. Completion or failure is shown in Pi. A fresh
Pi supervisor session also loads the same memory and watch/action receipts from
`supervisor/state.json`. Live task state must be inspected before acting. This storage
is intended for one supervisor at a time per data directory; simultaneous supervisors
should use separate data directories. Memory is local private state, not committed code.

Before asking you, the supervisor consults task memory and answers routine questions
from agreed requirements, prior decisions or repository conventions, citing its basis.
Scope changes, unclear product tradeoffs and required approvals still go to you.
`ask_user` accepts `text` alongside a task/decision ID to show agreed context,
a recommendation and consequences above the unchanged original coordinator question.
Human input still targets that exact decision; context participates in retry identity.
The tool returns the recorded `humanAnswer` so the supervisor can save the decision
and acknowledge it without asking again.
