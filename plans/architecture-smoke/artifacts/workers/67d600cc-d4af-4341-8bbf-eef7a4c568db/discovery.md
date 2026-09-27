# Discovery brief: `Queue` / `drain`

Base: `b731c08edd71d93a90e7b8faaf05185b934f7fe9` (the sole commit found touching `queue.js`, `worker.js`, and `docs/decision.md`). Read-only exploration; no tests or implementation run.

## Mechanics (directly observed)

- `queue.js:1-5`: `Queue` initializes an empty `items` array and `nextId = 1`. `enqueue(payload)` creates `{ id, payload }`, increments the counter, pushes the object, and immediately returns the numeric id. `take()` removes and returns the first item with `shift()`, or `null` when empty.
- `worker.js:1-5`: `drain(queue, deliver)` repeatedly takes one item and `await`s `deliver(job.payload)` before taking the next. It passes payload only; the id is not delivered. There is no catch/requeue/acknowledgment path. A rejected delivery propagates and exits the drain; because `take()` already removed the item, that item is lost to this queue.
- `test.mjs:1-4`: checks first id equals 1, delivery order for payloads `a`, `b`, then empty `take()` returns `null`. No other callers appear in the repository file inventory; worker and test are the observed callers.
- `package.json:1`: only declares module type. No persistence/runtime dependency is declared.

## Rationale and confidence

**Direct evidence:** `docs/decision.md:1-3` says this is an in-memory FIFO for a single-process prototype, chosen to avoid infrastructure and keep `enqueue` synchronous; it says there was no durability requirement and documents removal-before-delivery/loss on failed delivery. The initial commit subject is “Prototype queue uses memory to avoid infrastructure before durability is required”; its sole change adds the queue, worker, and decision note. The doc explicitly says there is no evidence for why identifiers start at 1.

**Inferred runtime consequences:** Since state exists only in an object’s array/counter, it does not survive process/object recreation; ids restart at 1 per new instance. This follows from code, not an additional documented requirement. `drain` is serial per invocation because each delivery is awaited. If a delivery rejects, later items remain queued but this invocation terminates; the removed failing item is not recoverable from this queue. No claim of durability, retry, exactly-once, concurrency control, or multi-process coordination is supported.

## History and source coverage (why evidence categories)

1. **Source control:** available and queried with `git log`, `git blame`, and `git log -p` for the target files. Only commit `b731c08` was found; it introduces the relevant files together and provides the commit-subject rationale above. No subsequent history or merge/PR number was found. Hosted review discussion was not available in the exposed environment.
2. **Issue/ticket tracker:** unavailable; no tracker connector/tool is exposed, and no ticket id appears in the inspected commit or repository files.
3. **Long-form documents:** local documentation available; `docs/decision.md` was read and has the design rationale above. No separate architecture/ADR docs appeared in the repository inventory. External document connector unavailable.
4. **Real-time team chat:** unavailable; no chat connector/tool exposed.
5. **Infrastructure observability:** unavailable; no observability connector/tool exposed. Not applicable to the stated prototype rationale.
6. **Error/exception tracking:** unavailable; no error-tracking connector/tool exposed.
7. **Product analytics warehouse:** unavailable; no analytics connector/tool exposed. No metrics/threshold rationale is stated in code/docs.

The task explicitly excludes external services and credentials, so these unavailable sources were not queried. `pstack/skills/why/references/sources/source-control.md` is absent; the available fallback is `source-playbook.md`, which points to `sources/code-archaeology.md` for git history. No other external evidence is claimed.

## Gaps and cautions

- Tests establish the basic happy-path FIFO contract only; they do not prove crash behavior, durability, failed-delivery recovery, enqueue during an awaited delivery, multiple drainers, id uniqueness across instances, or scalability.
- Synchronous `enqueue` means the call itself completes without a promise; it does not imply durable acceptance.
- Removal before callback completion makes the failure-loss behavior explicit, not merely hypothetical (doc and implementation agree). The overall retry/ack semantics are otherwise unspecified.
- No benchmark, operational data, incident evidence, requirements record, or rationale for initial id value exists in the sources available here.
