# Candidate B — durable local queue

**Recommendation, not an owner decision.** Replace destructive dequeue with one durable `Queue` owner backed by Node's local SQLite, and make delivery/ack a queue operation rather than a caller-coordinated protocol.

## Problem

`Queue` currently keeps only `items` and `nextId` in memory (`queue.js:1-4`); `take()` removes before delivery. `drain()` invokes a payload-only callback after that removal (`worker.js:1-4`), so a rejection loses the head job. The sole observed call site is the synchronous test enqueue plus `drain(q, async p => …)` (`test.mjs:1-4`). The documented rationale intentionally chose an in-memory single-process prototype to keep enqueue synchronous and states that loss is accepted; it gives no rationale for starting IDs at 1 (`docs/decision.md:1-3`). Commit `b731c08edd71d93a90e7b8faaf05185b934f7fe9` is the only history touching these files and says the same.

The new requirement reverses the durability/loss decision while retaining one local process and synchronous enqueue. [INFERENCE] The configured Node 22.19 runtime makes the built-in `node:sqlite` a dependency-free local store; implementation must pin a compatible Node engine before relying on it. No repository evidence identifies a production scheduler, payload schema, receiver, or throughput target.

## Usage (caller's view)

The existing synchronous enqueue use remains synchronous; opening the durable queue is the explicit migration point:

```js
import { Queue } from './queue.js';

const queue = Queue.openSync({ path: '/var/lib/acme/jobs.sqlite', maxAttempts: 5 });
const id = queue.enqueue('a');       // number; 1 for a fresh database
queue.enqueue('b');

await queue.drain(async (payload, { id, attempt }) => {
  await receiver.send(payload, { idempotencyKey: `local-queue:${id}` });
});
queue.close();
```

Current `test.mjs`'s successful caller migrates from `new Queue()` and `drain(q, async p => got.push(p))` to:

```js
const q = Queue.openSync({ path: temporaryDatabase, maxAttempts: 5 });
assert.equal(q.enqueue('a'), 1);
q.enqueue('b');
await q.drain(async payload => got.push(payload)); // unary handler remains valid
```

A receiver that cannot deduplicate can still consume the queue, but must treat its handler as at-least-once. A receiver that can deduplicate uses the supplied stable ID:

```js
await queue.drain((payload, { id }) =>
  payments.apply(payload, { idempotencyKey: `local-queue:${id}` }),
);
```

On restart the application opens the same path before accepting work and calls `drain` from its normal startup/enqueue/retry loop. A caught delivery error is scheduled for retry by that application loop; this package does not invent a background daemon.

## Shape

### Public contract

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type DeliveryContext = Readonly<{ id: number; attempt: number }>;
type Deliver = (payload: JsonValue, context: DeliveryContext) => Promise<void>;
type QueueOptions = Readonly<{ path: string; maxAttempts: number }>;
type DeadLetter = Readonly<{ id: number; payload: JsonValue; attempts: number; lastError: string }>;

class Queue {
  static openSync(options: QueueOptions): Queue;
  enqueue(payload: JsonValue): number;
  drain(deliver: Deliver): Promise<void>;
  deadLetters(): readonly DeadLetter[];
  redrive(id: number): void;
  discard(id: number): void;
  close(): void;
}
```

`enqueue` serializes and validates a JSON value before writing, then returns only after a committed local transaction. Strings used by the present test stay valid. This intentionally rejects cyclic objects, functions, `undefined`, and other values with no portable durable representation. IDs remain positive safe integers for source compatibility with the observed `1` assertion; the store persists the next value and fails before `Number.MAX_SAFE_INTEGER` rather than silently lose identity precision. The receiver key is `local-queue:${id}`. IDs are never reused in one database, including after dead-letter deletion.

`take()` is removed: no truthful durable version can hand a job to arbitrary caller code while preventing removal-before-delivery. The free `drain(queue, deliver)` export in `worker.js` is removed; callers use `queue.drain(deliver)`. This is a clean migration of the sole observed worker call, not a forwarding compatibility layer. A fresh deployment has no in-memory state to migrate; a live prototype must first drain its old instance or explicitly accept that its unpersisted jobs are outside the old contract.

### Persistent state and ownership

`queue.js` owns the public API, JSON validation, delivery transition, retry policy, and lifecycle. It alone knows SQLite. A private `local-store.js` owns connection setup and the SQL schema; it exports domain operations such as `insert`, `reserveHead`, `ack`, and `deadLetter`, never SQL rows or schema types. This is one cohesive boundary, not a store facade exposed to callers.

The database contains:

- `meta(schema_version, next_id)`, with the schema version and durable monotonic sequence.
- `jobs(id primary key, payload_json, attempts, last_error, created_at)`, where ascending `id` is ready order.
- `dead_letters(id primary key, payload_json, attempts, last_error, failed_at)`.

At open, migrations run before use. The connection uses a local SQLite file with rollback-journal `synchronous=FULL`; every state transition is a SQLite transaction. **The successful commit is the durability boundary**: `enqueue` returns only after its insert/sequence commit, and `ack` is durable only after its delete commit. SQLite recovery restores the last committed transaction after a process crash. The database must be on a local durable filesystem; network/ephemeral volumes and storage that lies about flushes are outside this guarantee.

At open the connection acquires and holds SQLite's exclusive database lock for the queue lifetime; a second local process fails fast as “already owned.” Closing is permitted only after `drain` settles, then releases the connection/lock. An unclean process exit releases OS locks; the next owner opens SQLite and runs recovery. Within an instance, a second simultaneous `drain` rejects rather than duplicate a callback. These rules make one application process the queue owner, rather than pretending SQLite's short write transactions serialize external delivery.

### Delivery, acknowledgement, and recovery

For the lowest-ID ready row, `drain` performs this single ownership-controlled sequence:

1. In a committed transaction, increment `attempts` and select immutable `(id, payload_json, attempt)`.
2. Invoke `deliver(payload, { id, attempt })` outside any database transaction.
3. If it resolves, delete that exact ID in a committed acknowledgement transaction; only then advance.
4. If it rejects, commit its normalized error. Below `maxAttempts`, leave the job at the head and reject `drain`; at the limit, atomically move it to `dead_letters`, delete it from `jobs`, and reject `drain` so the operator sees the failure. The next invocation can proceed with the next job.

Crash behavior follows directly from those commit boundaries:

| Window | Recovered behavior |
| --- | --- |
| Before enqueue commit | No accepted ID was returned; the job is absent. |
| After enqueue commit, before delivery | The persisted head is delivered after reopen. |
| During callback, including after the attempt reservation | The row remains; reopen replays it. `attempts` may increase again, which is conservative for poison handling. |
| After external success, before acknowledgement commit | The row remains and is delivered again. This is the required at-least-once duplicate window. |
| After acknowledgement commit | The row is absent and is not replayed, subject to the local durable-storage boundary. |

The callback receives the ID specifically so an external receiver can atomically record/deduplicate it. Queue-side persistence cannot make a non-idempotent external side effect exactly once. A receiver's retention window must cover the queue's possible replay lifetime; otherwise the same ID can cease to deduplicate after that receiver expires its record.

### Ordering, failures, and operations

Successful jobs are delivered in increasing ID order. A transient failure holds the head, so no later job overtakes it on that retry cycle. A poison job reaching `maxAttempts` is dead-lettered and later jobs are allowed through; therefore FIFO is best effort, not a false global ordering promise. `redrive(id)` moves a chosen dead letter to the tail with its same logical ID; `discard(id)` durably removes it. Both are explicit operator actions, recorded by the existing database state, not automatic hidden retries.

The application owns retry timing, startup drain, error logging/alerting, and graceful shutdown ordering. The queue owns durable state transitions, attempt counts, and dead-letter movement. Disk-full, SQLite I/O/corruption, lock contention, and serialization errors propagate to the caller; none may return an ID or acknowledge a job.

### Deterministic verification plan

Use temporary database files and a real file-backed fake receiver; no broker or clock dependence is needed.

1. Verify an accepted enqueue survives `close`/reopen, retains `1, 2` FIFO order, and resumes the next ID; assert the existing unary delivery callback still receives `a`, `b`.
2. Make delivery reject once. Verify the head remains after reopen, is redelivered before `b`, and has an incremented attempt. Then make it exceed `maxAttempts`; verify one dead letter and that the next drain can deliver `b`.
3. In a child process, write the receiver's durable side effect, leave its callback unresolved, then hard-kill it. Reopen the database and verify the same ID is delivered again: a concrete post-external/pre-ack duplicate proof. Kill before the callback to prove restart delivery as well.
4. Inject a local-store transaction failure before commit; assert enqueue throws and reopening has no job/advanced ID. After an acknowledgement commit, reopen and assert no replay.
5. Open a second queue against the same path and assert it fails while the first is live; after `close`, assert opening succeeds. Verify `close` while `drain` is active is rejected.

## Synthesis decision

Candidate B recommends the SQLite-backed deep `Queue` boundary above. This is an independent candidate only; no owner decision, implementation authorization, or synthesis with the other candidates has occurred.

## Tradeoffs accepted

- We accept synchronous SQLite I/O and possible event-loop blocking in exchange for keeping `enqueue()` synchronous *and* making its returned ID truthful about local durability.
- We accept JSON-only payloads in exchange for restart-safe, inspectable state without serializing arbitrary JavaScript objects.
- We accept deliberate poisoning/throughput loss at a failed head in exchange for FIFO among normally deliverable jobs; dead lettering explicitly trades strict global order for liveness.
- We accept at-least-once receiver integration in exchange for avoiding an impossible cross-system exactly-once claim.
- We accept a Node-version floor and a local durable-volume requirement in exchange for no broker service or third-party storage dependency.

## Alternatives considered

- **Keep `take()` and requeue on failure.** It exposes ack/requeue choreography and ordering decisions to every consumer, still has a crash gap after removal, and is a shallow API. It loses to a queue-owned delivery transaction.
- **Append-only JSON/journal files.** It can meet the constraint, but caller-visible simplicity would conceal a much more error-prone implementation burden: torn-write recovery, compaction, atomic replacement, sequence allocation, and lifetime locking. SQLite already hides those local-storage mechanics behind transactions.
- **External broker/outbox service.** It could add stronger operational tooling, but is explicitly disallowed and enlarges lifecycle/credentials/availability surface for a one-process requirement.

## Open questions and risks

- Is Node 22.19 (or an engine floor that guarantees `node:sqlite`) acceptable for deployments, given `package.json` currently declares only module type?
- What `maxAttempts`, retry schedule, and dead-letter retention match the receiver's actual failure modes? The repository supplies no evidence.
- Can the intended receiver persist `local-queue:<id>` atomically with its side effect, and for at least the queue replay lifetime? Without that, duplicates are observable.
- Is the chosen database path guaranteed to be a durable local volume with space monitoring and backup/restore policy?
- Is synchronous commit latency acceptable on the expected enqueue rate? No throughput evidence exists.

## Next implementation step

After owner approval, implement the `Queue.openSync`/`enqueue`/`drain` contract and private SQLite store at base `b731c08edd71d93a90e7b8faaf05185b934f7fe9`, remove `take()` and `worker.js`, migrate `test.mjs` and `docs/decision.md`, and satisfy all five deterministic checks above; workers may choose SQL statement names and internal error classes but may not alter the durable commit, at-least-once, best-effort-FIFO, ID, or lifecycle contracts.

## Rubric self-check

| Criterion | Score | Evidence |
| --- | ---: | --- |
| Recovery/delivery semantics | 5/5 | Explicit durable insert/attempt/ack transactions, all required crash windows, and receiver duplicate caveat. |
| Compatibility | 4/5 | `enqueue` stays synchronous and numeric IDs keep the observed assertion; setup and `drain` migrate deliberately because `take` is unsafe. |
| Operational simplicity | 5/5 | One local database/file, no daemon or broker, explicit open/close/ownership/dead-letter lifecycle. |
| Evidence-grounded tradeoffs | 5/5 | Code, decision document, and sole relevant commit are separated from stated inferences and unknowns. |
| Testability | 5/5 | Temporary DBs, a file receiver, child-process kills, and local transaction fault injection cover the actual boundaries. |

## Design-red-flag screen

- **Shallow module:** pass. `Queue` offers complete enqueue/delivery/recovery operations; callers never sequence reserve/ack/store calls.
- **Information leakage:** pass. SQLite settings, schema, journal, and row representation stay in the private store; callers see JSON jobs and IDs only.
- **Temporal decomposition:** pass. Durable state and its transitions belong to the queue; no public load/validate/save pipeline exists.
- **Pass-through method:** pass. Removing `worker.js` avoids a `drain` wrapper that would merely forward the same callback to `Queue`.

**Verification performed:** read-only inspection of `queue.js`, `worker.js`, `test.mjs`, `docs/decision.md`, `package.json`, task configuration, and relevant Git history. No implementation or tests were run, as required by this preparation-only assignment.
