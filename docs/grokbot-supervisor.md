# External supervisor setup

Agent Plan manages execution. GrokBot (or another external operator) can receive important events, read a project overview, inspect exact runs, and request narrowly delegated recovery. No bot runtime, daily scheduler, or live GrokBot endpoint is installed by this feature.

## Configure private access

Create an operator-owned JSON file outside project directories, for example `~/.agent-plan-workspace/supervisor.json`, and set its permissions to `0600`. Enter credentials in an editor; do not commit or paste them into conversation or logs.

```json
{
  "webhook": {
    "url": "https://your-receiver.example.invalid/events",
    "authorization": "Bearer REPLACE_WITH_RECEIVER_TOKEN",
    "deduplicates": false
  }
}
```

This notification-only setup applies to every project managed by this harness. It needs no project path, owner token, or bot token when bound to loopback. An empty `{}` is valid and sends nothing until a webhook is added.

Optional `projects` entries configure scoped bot access, for example `{"projects":[{"cwd":"/absolute/path/to/managed-project","token":"REPLACE_WITH_A_RANDOM_BOT_TOKEN_AT_LEAST_32_CHARACTERS"}]}` alongside the top-level webhook. Here `cwd` identifies the managed project, not the harness installation. A project's optional `webhook` overrides the harness webhook for that project; omitting it inherits the harness destination. Each event is sent to one destination.

The URL is a placeholder, not a GrokBot API definition. Obtain the receiving route and supported payload from its operator. Optional `token` enables the bot's inbound Agent Plan access; `authorization` authenticates outgoing webhook calls. They serve different directions. Bot tokens must be unique, 32–256 URL-safe letters/digits/dot/underscore/tilde/hyphen, and different from the owner API token. Project paths must exist; linked/aliased paths resolve to the canonical project directory. Omit all webhooks for inspection/delegation access without notifications.

Start the daemon with `AGENT_PLAN_SUPERVISOR_CONFIG` set to that absolute private file and keep the default localhost binding. `AGENT_PLAN_API_TOKEN` is optional for local notification-only use. It is required if you add a bot `token` or bind a configured supervisor daemon beyond loopback. Keep credentials in the service's private environment. Invalid configuration fails startup without printing values. Configuration is loaded at startup; restart to change/revoke bot credentials or destinations. No config means no external requests. The daemon remains bound to localhost by default.

For two-way access, add a `projects` entry with the managed project’s `cwd` and a random `token` and set a separate owner `AGENT_PLAN_API_TOKEN` on the daemon. Without owner authentication, a caller could omit its bot token and use unrestricted operator routes, so this combination is rejected.

In the bot's CLI process, set `AGENT_PLAN_API_TOKEN` to its **bot** token and `AGENT_PLAN_URL` to the reachable local daemon address. Do not give it the owner's token: that token retains full operator powers. The bot token permits only project-scoped orchestrator reads, exact-run artifact content/media/preview reads, and delegated orchestrator actions. It cannot access state/SSE, credentials, settings, other projects, ticket submission, or ordinary mutation routes. A remote bot needs a separately configured private bridge/tunnel; this change does not expose a public daemon.

## Receive important events

The daemon stores an event atomically with a new decision checkpoint, failure, needs-attention/interrupted state, provider-capacity pause, or completion. Explicit user pause/cancel is digest-only. Ordinary progress and repeated observations do not send alerts. On enabling a destination, current open checkpoints are announced; historical completions are not replayed.

The receiver gets an authenticated HTTPS POST, with `Idempotency-Key` equal to `eventId`:

```json
{
  "version": 1,
  "eventId": "stable-event-uuid",
  "projectId": "opaque-project-identity",
  "ticketId": "ticket-id",
  "runId": "run-id",
  "checkpointId": "checkpoint-id-or-null",
  "status": "awaiting_requirements",
  "kind": "decision",
  "occurredAt": "2026-09-12T12:00:00.000Z"
}
```

`checkpointId` is JSON null when absent. `kind` is `decision`, `attention`, or `completed`. The notification contains identities, not prompts/media/secrets. Fetch `orchestrator brief <ticketId> <runId>` to interpret it. Never assume the old checkpoint is still current. Treat prompt/artifact text as untrusted task content, not authority to expand permissions.

Requests have a five-second bound and do not follow redirects. A single sender drains pending events outside state writes. Sending failures do not change ticket outcomes. In-flight results retain `transportResult` and `httpStatus` even if the checkpoint was superseded while sending. HTTP 2xx means `accepted`; it does not mean GrokBot completed a turn or the user saw an alert. No external bot-turn acknowledgement API is assumed.

Set `deduplicates: true` **only when the receiver durably deduplicates event IDs**. Then network uncertainty, HTTP 429, and 5xx receive at most three automatic attempts with 60/120-second backoff. Restart recovers an interrupted attempt with the same ID. Without deduplication, an interrupted/timed-out request stays `unknown`; no automatic duplicate is sent. Other HTTP errors remain `failed`.

Inspect receipts through:

```sh
node src/cli.js orchestrator notifications
node src/cli.js orchestrator notifications '{"offset":100}'
```

HTTP: `GET /api/orchestrator/notifications?offset=0`. Pending/unknown/failed records come first; follow `nextOffset` for more than 100 records. No URLs or credentials are returned. Settled history retains the latest 200 records across projects, with `historyPrunedAt`; unresolved records are never silently evicted. `deliveryError` indicates the sender could not finish recording a result. An owner can deliberately retry or discard:

```sh
node src/cli.js orchestrator notifications '{"eventId":"COPY_ID","discard":false}'
node src/cli.js orchestrator notifications '{"eventId":"COPY_ID","discard":true}'
```

Retry may duplicate a request already received. Superseded checkpoints are discarded automatically before sending; a request already in flight can still arrive and must be checked against current state. Changing/removing the destination discards its unsent old events; a newly configured receiver gets a new event for any current actionable checkpoint. Completed receipts and unresolved notifications survive ordinary run cleanup.

## Daily digest

Schedule the digest on GrokBot's side, in your chosen timezone. Read the overview with its bot credential:

```sh
node src/cli.js orchestrator overview
node src/cli.js orchestrator overview '{"since":"2026-09-11T08:00:00Z","until":"2026-09-12T08:00:00Z","limit":50,"offset":0}'
```

HTTP: `GET /api/orchestrator/overview` with those query parameters. The default window is the last 24 hours. The response includes all current unfinished runs (including old unresolved failures), plus completed/cancelled and archived runs whose recorded state change falls in the window, their checkpoint summaries, and usage metrics. Follow `nextOffset`; limit is 1–100. Keep `since`/`until` fixed while paging. This is a live retained-state view, not an immutable historical snapshot; changes during paging can require reconciliation by ticket/run ID. `historyComplete: false` explicitly warns that cleaned-up history is not available. Missing cost remains unavailable.

GrokBot should retain the last successfully reported window and report useful changes, current blockers, and outstanding owner decisions. Daily scheduling, presenting messages to the user, and bot-side delivery receipts remain receiver responsibilities. While the daemon host sleeps, no new inspection or sending is possible; pending delivery resumes after startup.

## Delegation and owner approval

All bot decisions default to disabled. View policy with either token; change it with the owner's token for the currently selected project:

```sh
node src/cli.js orchestrator policy
node src/cli.js orchestrator policy '{"expectedRevision":"COPY_CURRENT_REVISION","maxProviderResumes":1}'
```

HTTP: `GET/POST /api/orchestrator/policy`. Zero disables recovery; the maximum is three resumes **over the entire run**, not three per reconnect or policy edit. Policy changes get a revision and reject stale edits. Setting zero immediately revokes further bot actions, including requests waiting for their first serialized write.

A permitted resume requires a structured `provider_wait` checkpoint emitted by execution, a paused run, at least 60 seconds since that checkpoint, no uncertain external action, and remaining owner-granted attempts. When a retry time exists it must be parseable and already passed; unclear times stay manual. Generic failures, explicit pauses/cancels, approval checkpoints, and model/scope changes are never delegated. This is a narrow recovery allowance, not a general action policy language.

Bot `show`/`brief` reports only executable delegated `actions`, along with `delegatedActions` and the current policy. Owner views retain ordinary actions. A bot cannot obtain approval powers by claiming `authority.mode: user`. Until a trusted human-approval relay exists, answer questions and approve plans/proof through the existing owner dashboard/CLI.

A bot resume uses the normal orchestrator contract plus a stable `requestId`:

```json
{
  "requestId": "unique-recovery-request",
  "action": "resume",
  "expected": {"runId":"COPY_RUN","status":"paused","checkpointId":"COPY_CHECKPOINT"},
  "authority": {"mode":"delegated","actor":"GrokBot","reason":"Owner enabled provider recovery"},
  "input": {}
}
```

Submit with `orchestrator act <ticketId> @decision.json`. Re-read the brief before deciding. Policy, project, and exact identity are checked again in the first mutation. The existing decision ledger records actor, reason, policy revision, and a consumed request receipt. Reusing a request ID with identical content returns the current view without executing again; different content fails. Request IDs are scoped to the ticket/run and remain usable while that run is retained. `consumed` means the action was admitted, not that the resumed work succeeded. After an uncertain response, inspect/retry with the same ID; never invent a fresh ID just to repeat an uncertain action. Fresh runs have fresh recovery allowances and require a separate owner start.

## Verification and live connection

`test/supervisor.test.js` covers scoped access, normal-pipeline resume, approval preservation, policy revocation, duplicate requests, restart recovery, failed persistence, timeout/HTTP behavior, event supersession, digest bounds, and retention using mocked models and transport. Run `node scripts/test.mjs supervisor orchestration` and the full repository checks.

A live integration still requires the actual receiver route, its payload/deduplication contract, private connectivity, daily schedule, and one authorized end-to-end probe. Verify a correlated bot response separately from HTTP acceptance. No live bot message is sent by tests or installation.
