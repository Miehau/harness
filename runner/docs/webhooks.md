# Webhook notifications

GrokBot-style webhooks are optional and disabled until the owner installs private
configuration. A receiver URL alone does not prove payload compatibility, wake a bot,
or authorize a human decision.

## Configure

Copy [webhook.example.json](../../webhook.example.json) to a private `webhook.json`, add the receiver URL
and optional Bearer token, then install it:

```sh
agent-plan webhook /absolute/private-config.json
```

Example:

```json
{
  "webhook": {
    "url": "https://your-receiver.example/events",
    "authorization": "Bearer YOUR_TOKEN",
    "format": "grokbot"
  }
}
```

Never commit real credentials. The CLI copies configuration to
`~/.local/state/agent-plan/webhook.json`, or the selected `RUNNER_DATA`, with mode 600.
Credentials remain plaintext readable by the OS user. Authorization may be omitted
for a secret URL. An existing `webhook.json` takes precedence; invalid JSON is reported
rather than bypassed. Legacy `supervisor.json` settings migrate without changing their
notification start time or replaying receipts.

New events are eligible from configuration time. Set `since` only when intentionally
including retained events, and inspect their task histories first.

## Delivery and receipts

Decision, attention, failure, and completion events use stable event and decision IDs.
Requests set `Idempotency-Key` to the event ID, time out after five seconds, reject
redirects, and are not blindly retried after uncertainty. `agent-plan notifications`
shows accepted, failed, and unknown transport receipts. HTTP acceptance means only
that the receiver accepted bytes; delivery and user action remain unobserved.

Payloads include job/status/branch fields, event/task/decision IDs, up to 10,000
characters of question or problem text, attached artifact references, and exact CLI
reply instructions. No owner credentials or authenticated dashboard links are sent.
Replies still use the owner answer or feedback interface; there is no public answer
endpoint or implicit bot approval authority.

Up to four PNG attachments of at most 1 MB each may be base64 encoded. Larger images,
videos, and other files carry an omission notice and artifact reference. A trusted
local relay must implement authenticated retrieval for those references; the runner
does not provide public media hosting.

Use coordinator `ask` with attachments for a blocking question or `surface` for a
nonblocking problem or preview. The receiver must implement this payload shape to
render images. No live receiver compatibility is claimed by the runner.

## Grok action contract

Notifications include `action`, `from: "harness"`, task, branch, and message.

- Completed candidates become `approval` with evidence and explicit acceptance steps.
- Owner questions default to `opinion`.
- Failure and attention become `problem` with a problems array.
- `pr` is optional and appears only when explicitly supplied.

Coordinator `ask` and `surface` accept
`hook: {action, pr?, evidence?, problems?}`. Aliases normalize
`pr-approval`/`impl-approval` to `approval`, `harness-opinion` to `opinion`, and
`impl-problem`/`blocker` to `problem`. Approval requires a real owner answer; opinion is
for product choices; a problem needs a question only when blocked. Probe, health, and
noop events are never sent, and merging does not create another approval request.
