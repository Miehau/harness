# Local orchestrator contract

Use the running localhost daemon through `node src/cli.js orchestrator`. All responses are JSON. `AGENT_PLAN_URL` and `AGENT_PLAN_API_TOKEN` use the same transport as the operator CLI; keep credentials in the environment. This contract does not connect a particular bot or add another execution agent.

## Draft a ticket

Save a JSON file and run `node src/cli.js orchestrator submit @ticket.json`. `-` reads JSON from stdin; a single JSON argument is also supported.

```json
{
  "idempotencyKey": "conversation-42:activity-panel-v1",
  "origin": "local-conversation",
  "title": "Add activity panel",
  "requirements": ["Show current activity in a new panel"],
  "acceptanceCriteria": ["Empty and active states are understandable"],
  "exclusions": ["No notifications"],
  "dependencies": [],
  "uiImpact": {"level": "material", "reason": "New panel"}
}
```

The response contains `ticketId`, `runId`, and `created`. Submission creates a draft and makes no model calls. Reusing a key with the same normalized content returns the original IDs; different content fails. Keys are scoped to the workspace and persist across daemon restarts and queue cleanup. If the original run is no longer retained, a retry still returns its receipt; deliberately use a new key for new work.

Requirements and acceptance criteria are required string arrays. Exclusions and dependency ticket IDs are optional. Dependencies must be completed before starting, and the draft's project must be open. UI impact is optional; meaningful frontend work should declare `material`. A material provisional classification cannot silently be downgraded by the requirements model; an explicit plan edit can change it with an audit trail.

## Inspect and decide

Run `node src/cli.js orchestrator show <ticketId> <runId>`. The response includes the exact `expected` identity, checkpoint, available actions, reported metrics, artifact content/preview/media routes, and recent decision records. When a checkpoint has a body (requirements draft, technical exception, or similar), `checkpoint.prompt` carries a redacted copy bounded to 4000 characters, with `promptTruncated` and `promptTotal` when the source is longer. Dashboard compact run payloads still omit `prompt`. Archived runs are inspectable and have no actions. Reconnect by inspecting saved IDs rather than creating another ticket.

Save a decision file and run `node src/cli.js orchestrator act <ticketId> @decision.json`:

```json
{
  "action": "start",
  "expected": {"runId": "COPY_FROM_SHOW", "status": "draft", "checkpointId": null},
  "authority": {"mode": "user", "actor": "local-conversation"},
  "input": {}
}
```

Copy `expected` from the latest inspection; do not construct it from a selected dashboard ticket. The run, status, and checkpoint are compared again in the first serialized mutation. Stale decisions fail without changing the successor. Normal dashboard and operator CLI controls work on the same draft and run.

| Action | Input |
| --- | --- |
| `start` | `{}`; starts only a submitted draft |
| `answer` | `answers` string; empty approves requirements with no open questions |
| `approve` | optional boolean `auto`; exact `proposalRevision` when material UI review is required |
| `revise-proposal` | `feedback`, current `proposalRevision` when one exists |
| `accept` | `stepId`, optional boolean `auto` |
| `revise-step` | `stepId`, `feedback`, optional `criterionIds` |
| `approve-proof` | `{}`; requires eligible final evidence |
| `revise-proof` | `feedback`, affected `criterionIds` |
| `resume` | `{}` |

`authority.mode: "user"` records a relayed user decision. `"delegated"` requires a `reason` describing the explicit grant. The local caller attests this authority; it is an audit record, not a separate human-authentication system. By default, the conversational agent may draft and inspect. Start only when instructed, relay approval only after the user decides, and treat UI direction and final proof as user decisions unless explicitly delegated. Automatic graph execution never bypasses the material UI or final-proof gates.

HTTP equivalents are `POST /api/orchestrator/tickets`, `GET /api/orchestrator/tickets/:ticketId/runs/:runId`, and `POST /api/orchestrator/tickets/:ticketId/actions`. Action requests return the current compact view; work can continue asynchronously. Inspect again until a checkpoint or terminal state is reached. On an uncertain action response, inspect before retrying; a consumed checkpoint must not be approved again.

## Connect a conversational agent

Give a locally running agent this operating recipe. It needs permission to invoke this repository's CLI and view authenticated artifact routes. No bot-specific SDK is required.

1. Discuss requirements and acceptance criteria with the user. Classify new panels, screens and material interactions as `material`; record the reason for cosmetic exemptions. Submit a structured draft with a stable conversation-and-ticket idempotency key. Keep the returned ticket/run IDs in the conversation's durable state.
2. Run `orchestrator brief <ticketId> <runId>` when reporting progress or reconnecting. It returns the same versioned fields as `show`, plus a readable `message` covering status, pending questions, the bounded checkpoint prompt, UI impact and proposal revision. Present `metrics` separately; keep unavailable and partial cost labels. Never turn missing cost into zero or describe SDK-reported cost as an invoice.
3. Start only when the user instructs it. At a checkpoint, show the pending questions and relevant artifacts. For UI direction, open the current proposal's `preview` route; for final proof, show the current checkpoint's evidence IDs and their `media` routes alongside the approved proposal. Resolve relative routes against `AGENT_PLAN_URL`; send the API token through the existing authenticated transport, never a URL query string.
4. Relay the user's actual answer, revision request or approval using `act`. Copy `expected` from the view that was shown to the user, and the exact proposal revision when applicable. If the checkpoint changes while awaiting a reply, inspect and present the new decision instead of applying the old reply to a new identity. Set `authority.mode` to `user` with the conversation agent's name as `actor`. Use `delegated` only with a recorded explicit grant and its scope in `reason`.
5. After an uncertain response or restart, inspect the saved run. Do not resubmit or blindly replay an action. Report completion only when its status is `completed`; a proposal approval or successful worker is not final delivery. An interrupted run may require `resume`; the returned `actions` list describes the currently available operations.

Use an argument array to invoke `node` with the absolute path to `src/cli.js`; send JSON through stdin or a file. Do not interpolate user text into shell command strings. Keep `AGENT_PLAN_URL` on localhost for this adapter. Keep `AGENT_PLAN_API_TOKEN` in the child process environment and out of conversation history. The CLI makes no external chat posts: the host conversational agent presents results in its own conversation.

`test/orchestration.test.js` exercises this recipe against a real daemon with mocked planning, workers, review and media. It covers fresh initialization, draft submission, requirements approval, proposal revision, rejection of an old revision, restart/reconnect, duplicate submission, automatic execution, final-proof approval and completion. Its tiny PNG is a plumbing fixture, not evidence that a real panel works. The project browser suite separately exercises real UI input and assertions.

Before claiming a named bot is connected, verify its local process invocation, environment/token handling, durable ID storage, and authenticated proposal/media viewing. No particular bot, remote gateway or notification service is configured by this change.
