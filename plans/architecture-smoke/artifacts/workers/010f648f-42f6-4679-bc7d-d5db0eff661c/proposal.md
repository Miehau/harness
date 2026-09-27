# Candidate proposal: durable local queue

Recommendation only. Not an owner decision, not arena synthesis, not implementation. Base `b731c08edd71d93a90e7b8faaf05185b934f7fe9`. This candidate did not read other proposals.

## Problem

Replace the in-memory prototype with durable, at-least-once delivery for one local process, without an external broker, while keeping `enqueue` synchronous and its returned id truthful. The existing shape makes that non-obvious: `Queue.enqueue` (`queue.js:3`) returns a numeric id before any durability exists, `take` (`queue.js:4`) removes the job before delivery, and `drain` (`worker.js:3`) awaits `deliver(job.payload)` with no failure path, so a rejected delivery drops the job. `docs/decision.md:2` records why: an in-memory FIFO avoided infrastructure and kept enqueue synchronous when there was no durability requirement, and it documents removal-before-delivery loss. The only caller is `test.mjs:3-4`, which expects the first id to be `1`, payload order `a` then `b`, and `take()` to return `null` when empty. Commit `b731c08` ("Prototype queue uses memory to avoid infrastructure before durability is required") is the sole history. Those are the constraints. Durability, restart replay, and poison behavior are new requirements, not documented historical ones.

## Usage (caller's view)

One process owns one sqlite file. `enqueue` stays synchronous. It returns a number only after the job is committed. `drain` still walks the queue serially and still passes the payload first. A crash after external success and before ack can deliver the same id again. Exactly-once is not promised. Receivers that cannot tolerate duplicates must treat that id as an idempotency key. Receivers that do not will see at-least-once duplicates. No broker, no second consumer, no lease.

```js
import { Queue } from './queue.js';
import { drain } from './worker.js';

const queue = Queue.open('/var/lib/app/jobs.sqlite', { maxAttempts: 5 });
const id = queue.enqueue({ kind: 'welcome', user: 'ada' }); // number, not a Promise
await drain(queue, async (payload, id) => {
  await sendMail(payload); // throw = not acked; resolve = ack after return
});
queue.close(); // not a flush; every successful enqueue/ack already committed
```

Call site 1, the current synchronous caller, migrated from `test.mjs:3-4`. Signature of `enqueue` and the fresh-file id `1` stay. `new Queue()` and destructive `take()` go away.

```js
import { Queue } from './queue.js';
import { drain } from './worker.js';

const queue = Queue.open(path);                 // was: new Queue()
assert.equal(queue.enqueue('a'), 1);            // still sync, still 1 on a new file
queue.enqueue('b');
const got = [];
await drain(queue, async (payload) => got.push(payload)); // id arg ignored; still legal
assert.deepEqual(got, ['a', 'b']);
assert.equal(queue.pending(), 0);               // was: queue.take() === null
queue.close();
```

Call site 2, external delivery. The queue does not know whether the side effect happened. Ack is "deliver resolved, then the delete committed." Idempotent receivers key on `id`. A one-argument deliver function still works.

```js
await drain(queue, async (payload, id) => {
  const first = await db.markIfNew(id);         // receiver-owned dedupe; not the queue
  if (!first) return;
  await charge(payload);
});
```

Call site 3, restart. The same path is the queue. Open recovers crashed in-flight work. Drain again. No replay API.

```js
const queue = Queue.open('/var/lib/app/jobs.sqlite');
await drain(queue, deliver); // jobs committed before the crash, and not acked, deliver again
queue.close();
```

Poison is not a third call the happy path must make. After drain, `queue.dead()` lists parked jobs and `queue.retryDead(id)` puts one back at the tail. Callers do not claim, ack, fsync, or reorder.

## Shape

### Load-bearing decisions

- Synchronous `enqueue` remains, and its meaning is strengthened: a returned id is a committed row, not a memory push. Return happens only after a SQLite commit with `synchronous=FULL`. A thrown `enqueue` means no id and no committed row.
- The durable structure is one table in one file. There is no in-memory job list that can run ahead of disk.
- `Queue` owns claim, external attempt, ack, failure, poison, and recovery. `drain` only repeats attempts until none are runnable. Claim and ack are not public.
- At-least-once. Same id may be delivered twice. Exactly-once is a receiver property, not a queue promise.
- Best-effort FIFO: explicit delivery failure yields to already queued jobs, then parks. It does not hold the queue forever and it does not keep strict head-of-line order across failures.
- One process owns the file. A second opener fails. No multi-process consumer, no broker, no public storage option.

### Core persistent data

One file, the path passed to `open`. Engine: `node:sqlite` `DatabaseSync` (present on the pinned Node v22.19.0 runtime). Pragmas set at open and not exposed: `synchronous=FULL` (probed value `2`), `journal_mode=DELETE` (probed; after close the directory contained only the db file), `locking_mode=EXCLUSIVE` (a second `DatabaseSync` on the live file failed with `database is locked`).

```sql
CREATE TABLE jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT, -- stable, never reused; fresh file starts at 1
  payload    TEXT NOT NULL,                     -- JSON text, not a driver type
  state      TEXT NOT NULL,                     -- 'queued' | 'inflight' | 'dead'
  attempts   INTEGER NOT NULL,                  -- claims so far; incremented only on claim
  seq        INTEGER NOT NULL,                  -- FIFO key; moved to tail on explicit fail
  last_error TEXT                               -- truncated message; diagnostic
);
CREATE INDEX jobs_runnable ON jobs(state, seq, id);
```

No `nextId` column and no side counter. Id allocation is `AUTOINCREMENT`. Probe: after deleting id `1`, the next insert was `2`, so the id was not reused. `seq` is `COALESCE(MAX(seq),0)+1` in the same transaction as the insert or requeue. Derived, not a second counter. `id === seq` is not a contract; it happens to hold only until the first requeue or gap.

Acked jobs are deleted. The table is the set of not-yet-acked jobs, not a history log. Dominant reads and writes:

| Pattern | Path through the table |
| enqueue | one insert, `state='queued'`, `attempts=0`, `seq` at tail, commit, return `run().lastInsertRowid` |
| next attempt | `state='queued' ORDER BY seq, id LIMIT 1`, then same transaction sets `inflight` and `attempts+1`, commit, then deliver |
| ack | `DELETE` where `id` and `state='inflight'`, commit |
| explicit fail | same transaction: `dead` if `attempts >= maxAttempts`, else `queued` with a new tail `seq` |
| crash recovery | `inflight` and `attempts >= maxAttempts` become `dead`; other `inflight` become `queued` at the same `seq` |
| dead list / retry | select `state='dead'`; retry updates that id to `queued`, `attempts=0`, tail `seq` |

The runnable index exists in the initial schema because "next queued job" is the hot read. No later map, cache, or log is part of the design. Process memory holds the db handle, `maxAttempts`, a closed flag, and an attempt-in-progress flag. It does not hold a second copy of the job set.

### Public signatures

Derived from the usage above. JS, not a new TypeScript toolchain (`package.json` is only `{"type":"module"}`).

```js
/**
 * @typedef {null | boolean | number | string | Json[] | { [key: string]: Json }} Json
 * @typedef {number} JobId  // safe integer; never reused inside this file
 */

export class Queue {
  /** Parent directory must exist. Creates the file. Recovers inflight rows. Takes the exclusive lock. */
  static open(path, options) {}

  /** Sync. Returns only after synchronous=FULL commit. Throws => no id and no row. */
  enqueue(payload) {}

  /**
   * One claim + deliver(payload, id) + ack or fail. False if no queued job.
   * Hides claim/ack/fail. Throws if re-entered or the queue is closed.
   * @returns {Promise<boolean>}
   */
  attempt(deliver) {}

  /** queued + inflight. Dead rows are not pending. */
  pending() {}

  /** Copies: { id, payload, attempts, lastError }. Not sqlite rows. */
  dead() {}

  /** Sync commit. Dead -> queued at tail, attempts reset. Throws if not dead. */
  retryDead(id) {}

  /** Releases the file. Not a durability flush. Throws if an attempt is in progress. */
  close() {}
}

/** Until attempt() returns false. Serial. Does not see rows, seq, or SQL. */
export async function drain(queue, deliver) {}
```

`options` is `{ maxAttempts }` only. Default `5`. Finite integer `>= 1`. No journal, lock, or driver options. `deliver` is `(payload: Json, id: JobId) => unknown`. Payload is the JSON round-trip, not the caller's object.

### Module ownership

| Module | Owns | Does not own |
| `queue.js` | file, schema, pragmas, lock, JSON boundary, id, seq, recovery, attempt, poison, dead/retry | how long the caller keeps draining; external side effects |
| `worker.js` | the until-empty serial loop | storage, ack, retry policy |
| `docs/decision.md` | replace the superseded "no durability" note when implementation is authorized | runtime policy |
| `test.mjs` | the contract above, including child-process crash checks spawned by this file | a second verify command |

Call chain is two files: caller → `drain` → `Queue.attempt` → sqlite. No `store.js`. A store module would either forward the same operations (pass-through) or split load/validate/save from the policy that protects one table (temporal decomposition). SQL stays private to `queue.js`.

`worker.js` stays because the loop is a real policy: keep going until no runnable job, including jobs enqueued during an awaited deliver. It is not `return queue.drain(deliver)`. Claim, ack, and fail must not be exported "for tests." Tests use `open`, `enqueue`, `drain`, process kill, and `open` again.

### Flow, ack, and crash windows

`attempt`:

1. If an attempt is already running, throw `QUEUE_BUSY`.
2. Recover leftover `inflight` rows (same transition as open). Idempotent.
3. Claim transaction: oldest `queued` by `(seq, id)`, set `inflight`, `attempts = attempts + 1`, commit. None → return `false`.
4. `await deliver(payload, id)` outside any transaction. The external call is not a database lock hold beyond the exclusive file lock the process already owns.
5. Resolve → ack transaction deletes that inflight row, commit, return `true`.
6. Throw → fail transaction parks `dead` or requeues at tail, commit, return `true`. Drain continues. The error is stored and not rethrown.
7. If the ack or fail commit itself throws, the row stays `inflight` and `attempt` throws. The next `attempt` or `open` runs recovery and can deliver again. That is the same duplicate window as a crash.

`attempts` increments only in the claim transaction. Recovery and fail do not increment again. A crash and a thrown deliver cannot double-count one claim.

Windows:

- **Before enqueue commit.** Transaction not committed. `enqueue` does not return an id (throw, or the process is dead and the caller saw no return). Next open has no row. Caller retry is a new job with a new id. SQLite atomicity covers a torn commit; this candidate does not add a second commit protocol. The page-tear case is not injected in tests.
- **After enqueue commit, before the caller observes the return.** The row is `queued` and will be delivered on restart. If the caller did not see the id and enqueues again, that is a second job. Receiver dedupe on the first id does not collapse it. The contract is about the return value: returned id ⇒ committed. Process death is not a successful call that lied.
- **During delivery, after claim commit.** Row is `inflight` and `attempts` already includes this try. Process death before deliver finishes: next open restores `queued` at the same `seq`, or `dead` if attempts are exhausted. If the external effect actually happened and the process died before we observed resolve, restart delivers the same id again.
- **After external success, before ack commit.** Same observable outcome as the previous window. The queue cannot see the difference. Same id is delivered again. This is the duplicate the brief requires us to admit. Ack is a delete committed only after `deliver` resolves. There is no delete-before-deliver path left; that is the `queue.js:4` / `worker.js:3` loss bug.
- **After ack commit.** Row is gone. Restart does not deliver it. Later jobs remain, in order. If the process dies before `drain` continues, the next `drain` on this file finishes them. Close is irrelevant to this window.

Open recovery and the pre-claim recovery are the same two updates, dead-park first, then remaining inflight back to `queued`. Repeating them is a no-op. Unlinking the file's `-journal` sibling is not a recovery step. A DELETE-mode journal can exist mid-commit; SQLite resolves it on next open. Operators must not delete it.

### FIFO, failures, poison

Runnable order is `(seq, id)` among `state='queued'`. Fresh enqueue always appends. Enqueue during an awaited deliver is included before `drain` returns, behind jobs already queued.

Explicit `deliver` rejection: the job leaves the head. If `attempts < maxAttempts`, it gets a new tail `seq` and drain continues with the previous successors. If `attempts >= maxAttempts`, it becomes `dead` and is not claimed again. Drain still terminates: a job that always throws is claimed at most `maxAttempts` times in that loop, then parked, then `attempt` returns false once nothing queued remains. Dead rows do not keep `drain` spinning.

Ordering consequence, jobs A,B,C and `maxAttempts=2`: A throws, order becomes B,C,A; B and C can complete; A's second throw parks A. B and C are not held for A's retries. That is best-effort FIFO, not strict FIFO across failures.

Process crash is different, and this is intentional. The in-flight job is restored at its old `seq`, so an unrelated crash does not let later jobs skip a job that had not been observed to fail. Each such crash already consumed an attempt at claim. After `maxAttempts` crash-claims, open parks it and it stops blocking. Crash replay can delay later jobs until that bound. Explicit in-process failure does not.

`retryDead` is the only way back. It appends. It does not cut the line. It resets attempts. It commits before return.

### Durability boundary

The boundary is the SQLite commit, with `synchronous=FULL`, of the single db file, before `enqueue`, `retryDead`, ack, or fail returns. `synchronous=FULL` is the probed pragma (`2`), not a measured `fsync` trace. This candidate treats SQLite's FULL contract as the power-loss boundary as well as the process-crash boundary, so "committed" has one meaning. `journal_mode=DELETE` keeps the durable artifact as one file after close, not a WAL plus `-shm`.

`enqueue` does not buffer, group-commit, or return early. A group commit that returned first would make the id a lie. Disk wait is the price of a truthful sync contract. No latency budget exists in the repo; accepting fsync latency is an inference from a one-process prototype, not a measured SLO.

`close` does not flush. There is nothing to flush. Exit without `close` is the crash path: the OS releases the SQLite lock, and the next `open` recovers. Implementation must prove a `SIGKILL` while the file is open does not leave it locked. That cross-process unlock was not probed here; the probe only showed a live second connection is rejected.

### IDs and receiver idempotency

Ids are per file, not global. A new file starts at `1`, which preserves `test.mjs:3`. `docs/decision.md:2` says there is no evidence for why identifiers start at `1`; keeping `1` is compatibility, not a discovered invariant. After restart, allocation continues. Completed ids are not reused (`AUTOINCREMENT`), so a receiver can store the id without a later job colliding with it.

The queue does not dedupe external effects. `drain` passes `id` as the second argument so a receiver can. The historical deliver path passed payload only (`worker.js:3`); the extra argument is ignored by the existing one-arg callback. Two different ids are two jobs. Producer retry after a crash that ate the `enqueue` return is how those two ids are born. Closing that window would need an enqueue idempotency key the current caller does not have. Not in this surface.

If `lastInsertRowid` is ever outside `Number.MAX_SAFE_INTEGER`, `enqueue` throws rather than returning a rounded id. Only id `1` and `2` were observed as numbers.

### Lifecycle

1. `open` creates the file if missing, sets pragmas, takes the exclusive lock, creates the schema, runs inflight recovery, commits, returns. A second open of the same path throws `QUEUE_LOCKED`. A corrupt or unexpected schema throws `QUEUE_CORRUPT` and does not recreate the file.
2. `enqueue` / `drain` / `retryDead` as needed. One attempt at a time. Enqueue during deliver is allowed.
3. `close` rejects if an attempt is running, then closes the handle and releases the lock.
4. Crash anywhere above is defined by the windows. No recovery command.

Parent directory must already exist. `open` creates the file, not the directory.

### What this deliberately does not do

Exactly-once. Multi-process consumers. Visibility leases. Broker protocol. Public SQL or file format. A memory mode beside the file mode. `take()`. Abort-and-drop on delivery failure. Strict head-of-line blocking. Group commit. A second dead-letter service. Timestamps. Payload size limits. Enqueue idempotency keys.

### Interface depth

Hidden behind `open` / `enqueue` / `drain` / `close`: schema, FULL commit, exclusive lock, claim/ack/fail, attempt counts, tail requeue, crash recovery, JSON codec. The caller does not sequence those stages. `dead` and `retryDead` are the poison port, not a protocol the happy path must drive. `attempt` is public only because `worker.js` is a separate module; it still hides the transitions. The surface is larger than `enqueue`/`take` because durability and poison are new capabilities, not leaked steps of the old array.

Validation sits at `enqueue` (JSON) and `open` (path, lock, schema). Inside the module, state transitions trust the table. Invariant placement: id stability in `AUTOINCREMENT`, runnable order in `(state, seq, id)`, "acked ⇒ absent" in the delete, "one owner" in the exclusive lock plus an in-process open guard so the error does not depend on driver wording.

### Migration

| Today | Proposed | Cost |
| `new Queue()` (`test.mjs:3`) | `Queue.open(path)` | one callsite; required because a default memory queue would make durability optional and leak the store choice |
| `enqueue` sync, returns `1` then `2` (`queue.js:3`, `test.mjs:3`) | same signature and fresh-file ids; return means committed | meaning change, no call-shape change; can throw on disk or non-JSON payload |
| `drain(queue, deliver)` with `deliver(payload)` (`worker.js:1-3`) | same; may pass `id` second | existing callback keeps working |
| `take()` removes and is the emptiness check (`queue.js:4`, `test.mjs:4`) | removed; `pending()` | one assertion; a public destructive read would recreate loss-before-ack |
| delivery throw exits `drain` and the job is already gone (`worker.js:3`, `docs/decision.md:2`) | job is requeued or parked; `drain` continues | behavior change at the only other callsite, which does not throw today |

No other callers were found. `package.json` has no persistence dependency; `node:sqlite` adds none.

## Synthesis decision

Not filled. Arena records the base, grafts, and rejections. The owner decision is not this file. Nothing here authorizes implementation.

## Tradeoffs accepted

- We accept per-enqueue `synchronous=FULL` latency in exchange for a returned id that means committed. There is no documented latency budget; treating that wait as acceptable is an inference.
- We accept an experimental builtin (`node:sqlite` printed `ExperimentalWarning` on v22.19.0) in exchange for atomic commit, non-reused ids, and a lock the kernel drops on process death. Stable `node:fs` on this runtime has no `flock`. The driver stays inside `queue.js` so a later swap does not move the caller contract.
- We accept duplicate delivery of the same id after external success and before ack in exchange for not pretending the queue saw the side effect.
- We accept a second id if the producer retries without having seen the first return in exchange for not adding an idempotency-key argument nobody calls today.
- We accept explicit failures losing their place in line in exchange for a poison job not blocking jobs already queued. Crash replay does not yield, until the attempt bound parks it.
- We accept `drain` swallowing delivery errors in exchange for best-effort progress and a terminating poison path. The failure remains on the row and in `dead()`.
- We accept dead rows accumulating until `retryDead` in exchange for not adding a delete method that could be mistaken for ack.
- We accept JSON-only payloads in exchange for a durable copy. The only observed payload is a string (`test.mjs:3-4`). Non-JSON values are a narrowing, not a documented caller requirement.
- We accept "second process must not open this file" in exchange for not building a distributed log. The lock enforces it.
- We accept no direct injection of a torn SQLite page in tests in exchange for not putting a commit-phase hook on the public API.

## Alternatives considered

- **Async `enqueue`.** `await queue.enqueue(payload)` makes the durability wait obvious, and it hides the same disk work. It loses because it breaks the synchronous contract `docs/decision.md:2` names and the only callsite (`test.mjs:3`) for no extra hidden complexity. Callers would all become async. Sync-plus-commit-before-return is the truthful form of the contract they already call.
- **Sync return before fsync, with a background group commit.** Smaller latency, same call shape. It loses because the id is no longer a durability proof. The brief asks whether the sync contract can stay truthful. This alternative answers no, then keeps the lie. Rejected rather than offered as a mode.
- **Atomic JSON snapshot via `node:fs` only.** One temp file, fsync, rename, directory fsync. Stable APIs, `cat`-able, no experimental warning. It hides a similar caller surface. It loses because this Node has no `flock` (`flockSync` absent; no `LOCK_*` constant), so a second process cannot be excluded without a lock file that survives `SIGKILL`. Hand-rolled rename atomicity is also the bug factory SQLite already owns. Prepared as a body-swap inside `queue.js` if the owner forbids the experimental driver. Not a public `storage` option. That option would leak the implementation.
- **In-memory queue plus a periodic snapshot.** Preserves today's speed. Two sources of truth. `enqueue` can return for a job the snapshot does not contain. Same lie as early return, plus a cache to invalidate. Rejected.
- **Strict head-of-line retry until success.** Smaller state machine (no tail `seq`, no `dead`). A poison job blocks B and C forever, which violates best-effort FIFO across failures, and `drain` may never return. Rejected.
- **External broker.** Forbidden by the brief. Also the infrastructure `docs/decision.md:2` and commit `b731c08` refused. Rejected.
- **Visibility leases and multi-process consumers.** Hides nothing this process needs and exposes time, fencing, and stolen claims. One process has no live deliverer after crash; open recovery is enough. Rejected.
- **Queue-side exactly-once.** Would require the queue to observe external commit. It cannot. A local "delivered" flag written before the external call loses the effect; one written after is the ack window we already have. Rejected as a promise. The id is the hook for a receiver that can do it.

## Open questions and risks

- Is experimental `node:sqlite` on the pinned v22.19.0 acceptable for the durability shell? If not, the fallback is the JSON snapshot body behind the same usage, with cross-process exclusion becoming an operator rule rather than a lock.
- Is `maxAttempts` default `5` the bound you want? It is a choice. Nothing in the repo states a retry count. Should a crash-restored job keep its place while an explicit failure goes to the tail, or should both yield?
- Is receiver idempotency on job id enough, or do producers need an enqueue idempotency key for the "commit happened, return not observed, caller retries" window?
- Should `drain` keep going after a delivery throw (this recommendation), or persist the failure and rethrow so today's abort-on-throw shape survives?
- Should dead rows be forgettable, or is retry-only enough given that the table retains them until then?
- Hung `deliver` wedges the process, as today's `await` does (`worker.js:3`). No lease. Is operator restart the intended recovery for a stuck callback?

Risk: `locking_mode=EXCLUSIVE` release after `SIGKILL` is inferred from SQLite's OS locks, not demonstrated in this session. The implementation test below is the check. Risk: FULL durability is a pragma result (`synchronous: 2`), not an `fsync` trace. Risk: a caller who depended on `drain` rejecting, or on `take()` deleting, has no in-repo evidence, but the behavior change is still real.

## Next implementation step

After the owner agrees this design and authorizes implementation, implement `Queue.open`, `enqueue`, `attempt`, recovery, and poison in `queue.js` on base `b731c08edd71d93a90e7b8faaf05185b934f7fe9`, keep `drain` as the until-empty loop in `worker.js`, migrate `test.mjs` and `docs/decision.md`, and prove the windows with child-process tests under the existing `node test.mjs` verify command.

Fixed contracts: commit-before-return; numeric never-reused id; fresh file starts at `1`; `deliver(payload, id)` additive; `take()` and `new Queue()` removed; ack deletes; inflight recovery does not increment attempts; explicit fail goes to tail or dead; no exactly-once; no broker; one exclusive owner; no public claim/ack/fail; no storage switch. Worker discretion: error wording, `last_error` truncation, index name, child helper filename. Not discretion: exporting the transition protocol, a memory mode, or returning before commit.

Acceptance: migrated `test.mjs` happy path passes; restart after `enqueue`+`close` delivers; `SIGKILL` during `deliver` after a side-effect marker redelivers the same id; `SIGKILL` after ack does not; `SIGKILL` while open does not stick the lock; a throwing job does not block an already queued successor and parks at `maxAttempts`; `pending()` is `0` and a later `drain` does not deliver the parked job until `retryDead`; second `open` fails; non-JSON `enqueue` throws and writes nothing.

## Verification

No implementation in this slice. Checks below are the deterministic plan, using temp directories, the real file, and `node` child processes. No network and no broker. They must live under `test.mjs` because verify is `node test.mjs` (`.agent-plan/project.json`).

- Happy path: fresh file, ids `1` then `2`, `enqueue` return is a number, drain order `a`,`b`, `pending()===0`, one-arg deliver still runs.
- Commit-before-return: enqueue, close, new open, same id delivers once.
- After external success, before ack: child writes a marker with the id inside `deliver`, then `SIGKILL` before resolve. Parent opens and drains. Marker path shows two deliveries of that id. Job not deleted by the crash.
- After ack: child drains to completion, `SIGKILL`, parent drain delivers nothing.
- Lock: child holds `open` and `SIGKILL`; parent `open` succeeds. Live second `open` throws.
- Failure order: `maxAttempts: 2`, payloads `bad`,`good`. `good` is delivered; `bad` ends in `dead()`; `pending()===0`; another drain does not deliver `bad`. `retryDead` then drain delivers it once.
- Enqueue during deliver: first deliver enqueues another payload; same drain delivers it after the job that was already queued.
- Payload rejection: `undefined` throws; a following successful enqueue on a new file is still id `1`.
- Not claimed as a test: torn pages inside SQLite commit, and power loss. Those sit on the FULL/atomic contract, not on a public fault hook.

## Rubric self-check

1. Recovery/delivery semantics: **5**. Ack is a committed delete. Restart replays unacked rows. The four crash windows, attempt counting, and duplicate admission are specified on one table. Poison does not drop the job and does not spin `drain`.
2. Compatibility: **4**. Sync `enqueue` and fresh-file id `1` stay, and the return becomes a true durability claim. `deliver(payload)` keeps working. `new Queue()`, `take()`, and abort-on-throw change, at the only callsite (`test.mjs:3-4`). Not 5 because that migration is real.
3. Operational simplicity: **4**. One process, one file, no broker, no npm dependency, lifecycle is open/use/close. Minus one because the shell is an experimental builtin and the exclusive-lock release after kill is not yet demonstrated.
4. Evidence-grounded tradeoffs: **5**. Historical facts are separated from inference below. Alternatives are different shapes (async API, early return, hand-rolled snapshot, broker, strict FIFO), not tuning of this one. Each names what it hides and what it forces on the caller.
5. Testability: **4**. Observable crash, order, poison, lock, and migration checks run in temp dirs under `node test.mjs` with child `SIGKILL`. Minus one because torn-commit and power-loss are not injected, on purpose.

## Red-flag screen

- Shallow module: no. One delivery is `enqueue` plus `drain`. Callers do not assemble claim, fsync, and ack. `maxAttempts` is a bound, not a stage switch. `dead` / `retryDead` are optional inspection, not required to finish the loop.
- Information leakage: no. Schema, pragmas, journal file, and `seq` stay inside `queue.js`. `dead()` returns copies, not driver rows. Id is the domain id `enqueue` already returns. No `storage: 'sqlite'` switch.
- Temporal decomposition: no. Open, claim, fail, ack, and recovery are one module protecting one table. `worker.js` owns "until empty," not a second copy of the row. Watch item for implementation: do not split `persist.js` / `deliver.js` / `ack.js`.
- Pass-through: no. `attempt` adds claim, commit, poison, and ack around `deliver`. `drain` adds the terminating loop. Neither forwards the same arguments to a same-shaped inner method. `worker.js` must not become `return queue.drain(deliver)`.

Screen result: no red flag that requires revising the shape. The watch item is an implementation constraint, not a second design.

## Evidence

Direct:

- `queue.js:1-5`: memory array, `nextId = 1`, sync `enqueue`, `take` shifts before delivery.
- `worker.js:1-4`: serial `await deliver(job.payload)`; no catch, no ack, id not passed.
- `test.mjs:1-4`: only observed caller; first id `1`; order `a`,`b`; emptiness via `take()`.
- `docs/decision.md:1-3`: in-memory FIFO, avoid infrastructure, keep enqueue synchronous, no durability requirement then, removal-before-delivery loses the job, no evidence for id start at `1`.
- Commit `b731c08edd71d93a90e7b8faaf05185b934f7fe9`, subject "Prototype queue uses memory to avoid infrastructure before durability is required." `git blame` attributes those lines to that commit. No later commit. No ticket id in the tree.
- `package.json`: `{"type":"module"}` only. Verify command is `node test.mjs`.
- Runtime probe, not a repo write: Node v22.19.0 exports `DatabaseSync`. Import prints `ExperimentalWarning`. `PRAGMA synchronous` returned `2` after `FULL`. `journal_mode` returned `delete`. `locking_mode=EXCLUSIVE` made a second `DatabaseSync` fail with `database is locked`. Insert result `lastInsertRowid` was `1`; after delete, the next id was `2`. After close, the temp dir had only the db file. `fs.flockSync` is absent.

Inference, labeled:

- Fsync latency is acceptable for this process. No benchmark or SLO exists.
- `maxAttempts` default `5` is a choice.
- JSON narrowing is tolerable because the only payload in-repo is a string.
- One drainer matches today's serial `await`. It is not a written concurrency requirement.
- Cross-process lock release on `SIGKILL` follows SQLite OS locking. Not observed here.
- Volume stays small enough that a row-per-job table is the structure, not a thing to index later. The index is still in the initial schema because the hot read is known.

Unavailable, per discovery and this session: issue tracker, chat, hosted review, observability, error tracking, analytics. Not queried. No external evidence is claimed.
