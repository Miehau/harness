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

Run `node src/cli.js orchestrator show <ticketId> <runId>`. The response includes the exact `expected` identity, checkpoint, available actions, reported metrics, artifact content/preview/media routes, and recent decision records. Archived runs are inspectable and have no actions. Reconnect by inspecting saved IDs rather than creating another ticket.

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
