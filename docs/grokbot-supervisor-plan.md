# GrokBot supervisor integration plan

Status: project implementation completed in `docs/grokbot-supervisor.md`; live receiver connection remains pending. Notifications are disabled without private configuration, and autonomous decisions default to disabled.

## Outcome and ownership

GrokBot surfaces important problems, provides a daily digest, and advances stopped runs only within explicit owner delegation. Agent Plan remains responsible for scheduling, workers, verification, approval gates, and delivery. GrokBot consumes the existing orchestrator interface; it does not manage workers or edit daemon state directly.

The integration is optional. Without a configured receiver or while GrokBot is unavailable, dashboard/CLI operation and approved execution continue normally. Neither component can report changes while the daemon host is asleep; delayed delivery resumes when it returns.

## Existing foundations and constraints

- `src/orchestration.js` provides draft submission, exact-run observation, and checkpoint actions; `src/cli.js` provides `orchestrator brief`.
- `src/server.js` wraps serialized mutations with `guardOrchestratorUpdate`; `src/store.js` persists state and recovers in-flight runs as interrupted.
- Existing action identity checks prevent stale run/status/checkpoint decisions. They do not yet provide a general action retry receipt or enforce delegated permissions.
- `authority.mode` is currently caller-attested audit information. The shared daemon token also permits ordinary operator routes. Restricting only `act` would not constrain a bot holding that token.
- Limen's `src/finish-webhook.ts` and `bin/tony-finish-ping.sh` demonstrate private destination configuration, bounded transport, stable event identity, and durable receipts. Its terminal-only, single-attempt delivery does not cover approval checkpoints or establish receiver deduplication.
- The current harness specification and agent-plan skill limit notifications to local surfaces. Implementation must explicitly update those product boundaries for optional owner-configured webhooks. This plan does not activate them.

## Slice 1: alerts and daily-digest input

Configure one harness-wide receiver, disabled by default, with optional per-project destination overrides. Notification setup does not depend on the harness installation path or require edits when switching managed projects. Store its HTTPS endpoint and authorization privately, outside run state, prompts, logs, and Git. Use the existing credential/configuration patterns where suitable. Validate configuration, redact output, bound requests, and do not follow redirects. No recipient discovery or multi-bot fan-out initially.

Persist a notification in the same serialized write that creates a relevant state transition. Send after commit, outside the store lock. Cover startup recovery as well as ordinary mutations; SSE publishing is not the event source.

Notify on:

- A new actionable requirements, plan/UI-proposal, step-review, or final-proof checkpoint.
- Failure, needs-attention, or an interruption requiring an operator decision.
- Successful ticket completion.

An explicit user pause/cancel belongs in the digest and must not trigger automatic recovery. Routine activity, every correction attempt, and repeated observations of the same checkpoint do not generate alerts. Derive classification from checkpoint meaning and existing status contracts; the `terminalRunStatuses` collection includes pauses and must not be treated as a completion signal.

Each event carries a version, stable event ID, project identity, ticket ID, run ID, checkpoint ID, status, occurrence time, and event kind. Keep notification content minimal: GrokBot fetches the current redacted brief and authorized evidence routes. Never include credentials, arbitrary filesystem paths, or full artifact bodies. Event identity must distinguish separate occurrences even when a run returns to the same status.

Persist pending/attempting/accepted/failed-or-unknown delivery results and attempt count. On reconnect, suppress superseded decision alerts and fetch current state before acting. A changed destination must not silently receive an old destination's pending events. Keep pending records until resolved or explicitly discarded; bound settled history using existing retention conventions and expose backlog/delivery failures in inspection.

Retry behavior depends on the receiver contract:

- If the receiver durably deduplicates event IDs, use bounded retries/backoff with the same ID and recover pending sends after restart.
- Otherwise, timeouts or interrupted sends remain unknown and require deliberate retry. Do not claim exactly-once delivery or silently repeat potentially accepted notifications.

HTTP acceptance, a completed GrokBot turn, and a successful Agent Plan decision are separate facts. Only expose bot-turn confirmation if the receiver supplies a correlated confirmation contract.

Add a compact project overview through the orchestrator API/CLI: active runs, outstanding decisions, recently completed/failed runs, and available usage metrics. Reuse existing projections and retained runs. Bound/paginate results and support an explicit time window; identify retention gaps rather than implying a complete history. GrokBot schedules the daily digest in the user's timezone and retains its last successful digest window. No daemon scheduler in this slice.

## Slice 2: relayed decisions and limited delegation

GrokBot re-reads `brief` before every decision and uses the existing actions and expected identity. Responses to an old notification never authorize a new checkpoint. User answers must remain associated with the checkpoint and evidence actually presented.

Before giving an autonomous bot credentials, introduce a separately scoped credential that cannot access ordinary mutating operator routes, credentials, project configuration, or other projects. Allow only required inspection/media and explicitly permitted orchestrator actions. Keep the owner's existing dashboard/CLI access intact.

Store explicit project-scoped delegation separately from notification configuration. Start with no autonomous actions. Expose the currently allowed delegated actions and record policy revision, actor, reason, action identity, and outcome. Evaluate current policy inside the serialized decision mutation so revocation cannot race an earlier read. A bot-supplied `mode: user` must not bypass its credential restrictions: either verify a real user approval through a defined trusted channel or keep that approval in the existing dashboard/CLI initially.

Initial policy:

| Situation | Default |
| --- | --- |
| Temporary provider interruption with an unambiguous recorded cause | Eligible for a later, explicitly enabled bounded resume policy |
| Generic failure, repeated failure, or no progress | Notify; no blind resume loop |
| Requirements, scope, architecture, model/budget change | Owner decision |
| UI direction, plan approval, step acceptance, final proof approval | Owner decision |
| Explicit pause/cancel | Never resume automatically |
| Normal verification correction | Existing daemon behavior; no duplicate GrokBot correction loop |

Automatic resume must use structured causes, not parse `lastError` prose. If existing diagnostics cannot establish eligibility, keep it manual. Limit recovery attempts per failure episode and escalate when exhausted. Automatic starting of new tickets is outside the initial delegation.

For uncertain action responses, inspect the exact run and its decision history before retrying. Add a persisted action request ID and receipt if inspection cannot unambiguously distinguish a consumed action, including actions that leave the expected state unchanged. Reuse the current decision ledger rather than creating a second audit system.

## Slice 3: real receiver connection

Confirm the actual GrokBot endpoint/payload, authentication, durable deduplication, scheduling/timezone support, acknowledgement behavior, and how it can invoke Agent Plan's authenticated read/action interfaces. Preserve the localhost daemon boundary: choose a local bridge or an existing authenticated private transport once deployment is known, rather than expose the daemon publicly.

Run an explicitly authorized live probe only after offline verification. Prove receipt and an actual correlated GrokBot response separately. Then prove a user-approved decision on a disposable run and one narrowly delegated recovery. Keep broader delegation disabled until these work.

## Acceptance and verification

Use `withDaemon`, `seedRun`, `invoke`, `runAgainstDaemon`, and `mockHarness`; fake transport must never contact GrokBot in tests.

1. Disabled integration produces no network requests and preserves ordinary execution.
2. Each new qualifying checkpoint produces one durable event; unrelated updates do not. Re-entering a distinct checkpoint produces a new event.
3. Crash/restart between state mutation, send, and receipt preserves an honest pending/unknown/accepted result; deduplicating retries preserve event identity.
4. Receiver errors/timeouts do not stall the store, change ticket outcomes, leak secrets, or create an unbounded retry loop.
5. Superseded events cannot approve or resume successor runs; configuration changes and retention have explicit tested behavior.
6. Overview/digest input correctly distinguishes active, blocked, completed, unavailable usage, and truncated history across the requested time window.
7. Bot credentials cannot bypass delegation via ordinary routes or a claimed user authority. Policy revocation, stale identities, duplicate decisions, and recovery limits are tested.
8. Approval-required scenarios remain stopped; an authorized recovery advances exactly the intended run through existing controls.
9. Full `node scripts/test.mjs`, `node scripts/test.mjs --check`, and proportionate UI checks for any changed controls pass.

## Decisions remaining before connection

- Actual GrokBot receiving and invocation contract, including deduplication.
- Deployment locations and private connectivity between GrokBot and Agent Plan.
- Daily digest time/timezone and where GrokBot presents alerts.
- Whether any automatic recovery should be enabled initially; proposed default is none.

No new agent runtime, database, message broker, multi-recipient routing, or generic policy language is needed. The earlier orchestrator review fixes are committed separately from this integration.
