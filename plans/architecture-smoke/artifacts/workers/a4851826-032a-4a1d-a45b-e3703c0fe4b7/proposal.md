# Candidate: synchronous SQLite acceptance; one serial queue-owned delivery loop

## Usage (caller's view)

README-style: install a synchronous local SQLite binding (`better-sqlite3`); create one `Queue.open('./state/jobs.sqlite')` at process startup, on a persistent local volume. `enqueue` commits before returning its numeric ID. Start `serve` to resume eligible jobs after restart; stop it with an `AbortSignal`, await termination, then close. The external receiver should deduplicate on the stable job ID if duplicate effects are unacceptable.

```js
import { Queue } from './queue.js';
const queue = Queue.open('./state/jobs.sqlite');
const id = queue.enqueue({ email: 'a@example.test' }); // synchronous, durable on return
console.log(id);
```

Current synchronous caller and drain migration (`test.mjs:2-4`): preserve `assert.equal(q.enqueue('a'), 1); q.enqueue('b')`, replacing `new Queue()` with `Queue.open(tempDbPath)` and `await drain(q, deliver)` with `await q.drain(deliver)`. `deliver` still receives the payload first; it may also accept the ID second. The original empty `take()` assertion is replaced by a zero-work `drain` result; public destructive `take()` disappears because it could discard a job before acknowledgment.

```js
const q = Queue.open(tempDbPath);
assert.equal(q.enqueue('a'), 1);
q.enqueue('b');
const got = [];
await q.drain(async payload => { got.push(payload); }); // one bounded pass
assert.deepEqual(got, ['a', 'b']);
q.close();
```

Service startup and shutdown (real delivery):

```js
const q = Queue.open('./state/jobs.sqlite');
const stop = new AbortController();
const running = q.serve(async (payload, id) => {
  await receiver.send(payload, { idempotencyKey: String(id) });
}, { signal: stop.signal });
// On graceful shutdown: stop.abort(); await running; q.close();
// On restart: open the same path and call serve again; pending rows are replayed.
```

## Problem

`queue.js:1-5` holds jobs and `nextId` in memory; `worker.js:1-4` calls destructive `take()` before awaiting delivery, so failed delivery loses the current job and restart loses every job. `docs/decision.md:1-2` explicitly chose in-memory FIFO to avoid infrastructure and preserve synchronous enqueue when durability was *not* required. The sole target-history commit `b731c08` reinforces that prototype rationale; a new durability requirement supersedes it, not an inferred past guarantee. Current tests only exercise happy-path order (`test.mjs:1-4`). [INFERENCE] IDs currently reset on process recreation; neither stable restart IDs nor arbitrary object payload formats were documented requirements. No issue/review/operational metrics were available in the discovery record (`workers/67d600cc-d4af-4341-8bbf-eef7a4c568db/discovery.md`).

## Shape

Persistent data first: a local SQLite file contains `jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, payload_json TEXT NOT NULL, available_at_ms INTEGER NOT NULL, failed_attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, state TEXT NOT NULL CHECK(state IN ('pending','quarantined')))`. Index `(state, available_at_ms, id)` for next due job and `(state, id)` for ordered failure inspection. An in-flight job is **not removed or durably claimed**: it remains `pending` until successful callback completion and committed deletion. The stable ID is allocated by the committed insert, never reused across restarts even after all prior jobs have been deleted. One opened queue and one serial drainer per database are supported; the process is the only writer/consumer. No cross-process claim/lease protocol is promised.

Public JavaScript shape (signatures only; `JsonValue` recursively consists of null, booleans, finite numbers, strings, arrays and plain objects of `JsonValue`):

```ts
class Queue {
  static open(filePath: string): Queue;
  enqueue(payload: JsonValue): number;
  drain(deliver: (payload: JsonValue, id: number) => Promise<void> | void): Promise<{ delivered: number; failed: number }>;
  serve(deliver: (payload: JsonValue, id: number) => Promise<void> | void,
        options: { signal: AbortSignal }): Promise<void>;
  failures(): readonly { id: number; payload: JsonValue; failedAttempts: number; lastError: string | null }[];
  quarantine(id: number): boolean;
  close(): void;
}
```

`queue.js` owns serialization validation, schema/migration, synchronous transactions, retry scheduling, deletion, quarantine and the drain/serve execution policy; delete `worker.js` and migrate its observed caller (`test.mjs`) rather than retain a pass-through `drain`. A package dependency is necessary because `package.json:1` has none and no supported built-in synchronous SQLite contract is declared. On `open`, configure WAL plus `synchronous=FULL`, create/upgrade schema transactionally, and reject an in-process second opener for the same canonical path. Validate the strict JSON domain before inserting: reject cycles, BigInt, Date, functions, undefined, non-finite numbers and unsupported prototypes instead of silently changing payloads. This is an explicit compatibility narrowing: existing code admits any JS value, but the observed caller uses strings only (`test.mjs:3`). Reject IDs beyond `Number.MAX_SAFE_INTEGER` within the insert transaction; changing the numeric return type silently is worse.

`enqueue` performs a synchronous SQLite insert/commit and returns only after successful commit, making the original synchronous shape a truthful durability boundary; database/serialization/disk errors throw without returning an accepted ID. The backing volume must honor SQLite syncs: local durable filesystem assumed, not volatile `/tmp` or an unreliable network mount. WAL, database and lock files are one durable unit; do not copy only the `.sqlite` file while live. Regular SQLite checkpoint and backup are operational responsibilities; use SQLite's backup API for live backup. There is no external service, broker, or process-wide memory source of truth.

`drain` takes a high-water ID at entry and scans eligible `pending` rows with `id > lastSeen AND id <= highWater`, ordered by ID; thus a job is attempted at most once per call, even if it fails, and newly enqueued work is handled on the next pass. One active `drain` or `serve` per queue, enforced by an internal guard; a second invocation throws rather than delivering concurrently. Never hold a transaction across an awaited external call. On fulfillment, delete that row and commit the acknowledgment. On rejection, commit an incremented failure count, bounded error summary and a future `available_at_ms` (e.g. exponential 1s to 60s); then continue with later eligible jobs. The `drain` result counts callback rejections rather than throwing them as it did before; persistent-store errors instead reject/stop processing. `serve` uses the same private pass, wakes on enqueue and on earliest due timestamp, and exits on abort *between* callbacks (cannot cancel an in-flight external promise). Startup runs a pass immediately. Store timestamps as UTC epoch milliseconds, recompute on restart, and use a timer wake-up plus requery rather than trust timer precision.

FIFO is best-effort among eligible IDs; a failed row backs off so later rows may overtake it. Poison rows stay pending with capped backoff until receiver repair or **explicit** `quarantine(id)` (not silent finite retries or deletion). `failures()` exposes them to an operator. `quarantine` transactionally marks a pending row unavailable; refuse quarantine of the current in-flight ID, so a concurrent admin call cannot turn a successful external effect into a quarantined row. To retry a quarantined job after correcting the cause, explicitly enqueue a corrected payload as a *new* job/ID; the old row remains auditable. The no-silent-drop guarantee applies to committed jobs unless an operator explicitly quarantines them. Unbounded quarantine retention, storage monitoring and scheduled archival policy require an operational decision; don't silently purge historical failed payloads.

Crash matrix: (1) before insert commit: no ID returned, no accepted job; SQLite rolls back. (2) after committed enqueue, before callback: pending row replays on restart. (3) during callback or after its external effect but before committed deletion: pending row replays, possibly duplicates. (4) after committed deletion: no replay. (5) after callback rejection but before retry-metadata commit: pending row replays early; after failure commit it replays at/after due time. A crash during acknowledgment cannot make a half-deleted row: SQLite transaction is atomic. An external success followed by failure to commit acknowledgment is **not** a completed queue acknowledgment; stop and replay later. Receiver-side idempotency keyed by `(queue identity, stable job id)` is needed to suppress duplicate effects; numeric ID alone can collide with an independently created database or a restored older snapshot. Even receiver idempotency must atomically commit its dedupe record with its effect to claim exactly-once effects. At-least-once here means repeated delivery **attempts** of accepted pending work while the service runs; it does not guarantee eventual success against a permanently failing receiver or while a human quarantines it.

Interface depth: `enqueue`, `drain`, `serve`, `failures`, `quarantine`, `close` hide SQLite rows, transaction ordering, retry scheduling, timer wake-up and crash recovery. The two operator methods are necessary to see and intentionally isolate poison jobs. No public claim/ack state machine leaks onto callers. Per boundary-discipline, validation is at enqueue/open; per single-source-of-truth, database state alone determines replay. Per idempotent-transition discipline, an ack is conditional on pending ID, and committed deletions never repeat. One owner module keeps persistence and delivery invariants together; no load/transform/save stages or forwarding worker layer.

## Synthesis decision

Not applicable to an independent candidate. Recommendation only; owner has not chosen a design and no other candidate was consulted.

## Tradeoffs accepted

- Accept `better-sqlite3` native dependency and synchronous disk latency on enqueue in exchange for retaining a truthful synchronous ID contract without implementing a crash-safe journal, checksum, torn-tail recovery and compaction ourselves.
- Accept a strict JSON payload domain, migrating any unknown arbitrary-JS callers, in exchange for deterministic durable replay without serialization surprises; only a string caller is evidenced in-repo.
- Accept serialized callback throughput and no mid-callback cancellation in exchange for simple one-process ordering and no leases or distributed locking.
- Accept repeat external effects in the success-before-ack window, and persistent poison rows, in exchange for no silent deletion of unacknowledged accepted work.

## Alternatives considered

- Custom append-only sync filesystem journal: preserves synchronous acceptance with no native dependency, but record framing, fsync/rename/compaction, ID reservation and crash-tail repair become a second storage engine; a similarly small public API hides substantially more bespoke high-risk behavior. SQLite is deeper as a module boundary.
- Asynchronous SQLite/native `fs.promises` queue: non-blocking disk I/O but `enqueue` must return `Promise<number>`, requiring all callers to await acceptance and changing the observed synchronous contract; exposing fire-and-forget IDs would falsely imply durability.
- In-memory queue with periodic snapshots: retains old API and low latency but jobs returned as accepted after the last snapshot can disappear on crash; cannot satisfy durable enqueue semantics. External broker violates the explicit no-service constraint.

## Open questions and risks

- Is synchronous commit latency under the target volume and burst rate acceptable, or should the owner explicitly approve a Promise-returning enqueue migration? No benchmark/volume target exists in available evidence.
- Does the receiver support atomic idempotency keyed by queue identity plus ID, or should users expect duplicate effects during the unavoidable acknowledgment gap?
- What on-call response, volume limits and retention policy should govern accumulated failed/quarantined payloads, some of which may contain sensitive data?
- Is the deployment filesystem genuinely persistent and SQLite-compatible across power loss, backup and restore? A copied/restored database can replay already externally effected IDs.

## Next implementation step

*Only after owner agreement and implementation authorization*, assign the SQLite-backed `Queue.open/enqueue/drain/serve/failures/quarantine/close` cutover, observed caller migration and decision-doc replacement against base `b731c08edd71d93a90e7b8faaf05185b934f7fe9`; fixed contracts are synchronous committed enqueue, one serial drainer, no remove-before-ack, explicit poison isolation and duplicate caveat; worker discretion covers internal SQL layout/backoff constants. Acceptance: durable restart replay, crash-window duplication/no loss, FIFO for successful jobs, failure overtaking, synchronous ID stability and rejected unsupported payloads, operator quarantine and graceful shutdown. Deterministic tests use temporary SQLite files, fake Date/timers, deferred callbacks and fault injection at commit/ack boundaries; direct smoke opens DB, enqueues, restarts, delivers and observes no row after ack. No implementation or tests run in this preparation-only proposal.

## Rubric self-check (0–5, design evidence)

1. Recovery/delivery **5**: commit boundaries, non-destructive in-flight selection and five crash windows above; at-least-once attempts and dedupe qualifications explicit.
2. Compatibility **4**: sync numeric enqueue survives, real `drain` caller migration shown; strict JSON and removed `take` intentionally break unevidenced behaviors.
3. Operational simplicity **4**: single SQLite file/service and one owner module; native binding, backup and poison operations cost administration.
4. Evidence-grounded tradeoffs **5**: cites `queue.js`, `worker.js`, test, decision note and sole commit; separates inferred restart semantics from recorded historical rationale.
5. Testability **4**: temp DB + fake clock/timers + injected commit failures cover key cases without broker; callback crash-window tests require a child process or deliberate fault hook.

## Red-flag screen

- **Shallow module:** no; the public methods hide storage, retries, timers and acknowledgment, rather than requiring caller-controlled claim/ack. Two admin methods have distinct operational policy.
- **Information leakage:** SQLite schema and wire encoding stay in `queue.js`; callback receives domain payload and stable numeric ID only.
- **Temporal decomposition:** no; `queue.js` owns enqueue, replay, delivery policy and acknowledgment as one invariant set, not separate load/deliver/save layers.
- **Pass-through method:** no; remove `worker.js` rather than retain a wrapper around `Queue.drain`.
