# Candidate proposal: one-directory durable queue

Recommendation only. Not an owner decision. Base `b731c08edd71d93a90e7b8faaf05185b934f7fe9`. No repository files changed.

## Problem

Replace the in-memory FIFO with durable, restartable, at-least-once delivery for one local process, without an external broker. The existing shape makes that non-obvious because durability was explicitly out of scope, and the delivery path deletes the job before the external call returns.

Observed today:

- `queue.js:1-5` — `new Queue()` keeps `items` and `nextId` in the object. `enqueue(payload)` assigns `nextId++`, pushes `{ id, payload }`, and returns the number immediately. `take()` `shift`s the head or returns `null`.
- `worker.js:1-5` — `drain(queue, deliver)` takes one job, then `await deliver(job.payload)`. The id is not passed. There is no catch, retry, or ack. A rejection leaves the taken job gone and stops the loop; later items stay only in this object.
- `test.mjs:1-4` — the only observed caller. `q.enqueue('a')` must equal `1`, then `'b'`, then `drain` collects payloads in order, then `q.take()` is `null`. `drain`'s return value is ignored. The deliver callback takes one argument.
- `docs/decision.md:1-3` — in-memory FIFO was chosen to avoid infrastructure and keep `enqueue` synchronous. No durability requirement. Removal-before-delivery is documented. No evidence for why ids start at 1.
- Commit `b731c08edd71d93a90e7b8faaf05185b934f7fe9`, subject “Prototype queue uses memory to avoid infrastructure before durability is required”, adds those files together. No later commit touches them. `package.json` declares `"type": "module"` and no dependencies.
- Discovery (`workers/67d600cc-d4af-4341-8bbf-eef7a4c568db/discovery.md`) matches that reading. Issue tracker, chat, observability, error tracking, and analytics were unavailable. No claim below treats those as evidence.

Constraints this design honors: synchronous `enqueue` that returns an id; FIFO best effort, not strict FIFO across failures; at-least-once; a crash after external success before ack may duplicate; exactly-once only if the receiver dedupes; local storage only; one process.

## Usage (caller's view)

`enqueue` stays synchronous. The return value now means the job record is committed in the local store, not merely pushed into an array. Callers keep `const id = queue.enqueue(payload)`. They must pass a store directory and close the queue. They must not expect exactly-once.

```js
import { Queue } from './queue.js';

const queue = new Queue('./data/jobs');
const id = queue.enqueue({ type: 'send-email', to: 'a@example.com' });
// id is committed before this line. A process crash here still delivers.

await queue.drain(async (payload, meta) => {
  await emailProvider.send({ idempotencyKey: meta.id, ...payload });
});
queue.close();
```

The receiver treats `meta.id` as its dedupe key. The queue does not do that for the receiver.

Call site 1 — current synchronous enqueue caller (`test.mjs`), migrated only where the memory API cannot tell the truth:

```js
import { Queue } from './queue.js';
const q = new Queue(dir);
assert.equal(q.enqueue('a'), 1);
q.enqueue('b');
const got = [];
await q.drain(async (p) => got.push(p));
assert.deepEqual(got, ['a', 'b']);
assert.equal(q.depth(), 0);
q.close();
```

`enqueue` is still not a Promise. The existing one-argument deliver callback still runs. `take()` is gone; emptiness is `depth()`.

Call site 2 — restart replay. Commit survives `close` or a killed process. A new instance delivers the same ids in order.

```js
const first = new Queue(dir);
const id = first.enqueue({ n: 1 });
first.close();
const second = new Queue(dir);
const seen = [];
await second.drain(async (payload, meta) => seen.push([meta.id, payload.n]));
// seen[0][0] === id
second.close();
```

Call site 3 — external success, then failure before ack. The side effect happened; the job file is still there; the next `drain` calls the receiver again with the same id.

```js
await q.drain(async (payload, { id }) => {
  await external.post('/jobs', { id, payload });
  throw new Error('died before ack');
});
// q.depth() === 1; a later drain posts the same id again
```

## Shape

One module owns the obligation “a file in `jobs/` is an unacked delivery.” Callers do not claim, ack, or rename. `drain` is a method on that module, not a second layer that can delete early.

### Load-bearing decisions

- Commit-before-return. `enqueue` fsyncs, then returns the id. The synchronous signature stays, and the return becomes a durability contract. An async enqueue was rejected because it would falsify call site 1 or force every caller onto a Promise.
- Presence is the obligation. No inflight record, no delivered-but-unacked bit. After commit, the job is redelivered until the file is durably removed. That is the at-least-once rule, including the duplicate window the brief requires us not to paper over.
- Ack is durable removal, and only `drain` performs it, and only after `deliver` returns normally. A throw is not an ack.
- Failure does not block later ids. Poison is a durable exclusion, not a deleted job and not a head-of-line lock.
- Stable id is the only receiver dedupe key the queue provides. Ids are never reused, including after ack.
- Store format, lock, fsync, and recovery stay inside `Queue`. The public surface is the caller usage above plus poison inspection.

### Data shape

Directory chosen by the caller. Created on construct if missing.

```
<root>/
  LOCK                 # pid of the owner; not a job
  next-id              # ascii integer, advisory
  jobs/<id>.json       # committed, unacked, maybe failing
  poison/<id>.json     # exhausted; not selected by drain
```

`*.tmp` in those directories is an incomplete write. Recovery deletes temps. Temps are not jobs.

Job file (same shape in `jobs/` and `poison/`):

```ts
interface JobRecord {
  v: 1;
  id: number;                    // >= 1, never reused
  payload: unknown;              // JSON value; validated at enqueue
  attempts: number;              // failed deliver returns so far
  lastError: string | null;
  notBefore: number;             // epoch ms; 0 means immediately runnable
  idempotencyKey: string | null; // producer dedupe; optional
}
```

In memory, rebuilt from those files on construct, discarded on close. Not a second source of truth. Updated only after the corresponding file mutation is durable:

- `byId: Map<number, JobRecord>` — ack, fail, requeue, discard
- `runnable: sorted id set` — drain always takes the minimum runnable id
- `byKey: Map<string, number>` — optional producer dedupe

Dominant operations are enqueue (one file + one map insert), next-min, ack-by-id, and fail-by-id. No later index is required. A missing keys file cannot drift because keys are read from job files.

`next-id` is a hint. The allocator is `max(next-id file, every id under jobs/ and poison/) + 1`, then that value is written and fsynced before the new job file is committed. A crash between allocating and committing loses nothing the caller observed: no id was returned, and the unused id is skipped forever. Skipping an id is safe. Reusing one is not.

### Public signatures

```ts
type JobId = number;

interface QueueOptions {
  maxAttempts?: number; // default 5; [INFERENCE] no documented threshold
  backoffMs?: (attempt: number) => number; // default () => 0
  now?: () => number;   // default Date.now; tests inject this
}

interface EnqueueOptions {
  idempotencyKey?: string;
}

interface DeliverMeta {
  id: JobId;
}

type Deliver = (
  payload: unknown,
  meta: DeliverMeta,
) => void | Promise<void>;

interface DrainOptions {
  signal?: AbortSignal; // checked between jobs, not during deliver
}

interface DrainResult {
  acked: number;
  failed: number;
  poisoned: number;
  stopped: 'idle' | 'aborted' | 'closed';
}

interface PoisonView {
  id: JobId;
  attempts: number;
  lastError: string | null;
}

class Queue {
  constructor(dir: string, options?: QueueOptions);
  enqueue(payload: unknown, options?: EnqueueOptions): JobId;
  drain(deliver: Deliver, options?: DrainOptions): Promise<DrainResult>;
  depth(): number; // runnable files, not poison
  poisoned(): readonly PoisonView[];
  requeue(id: JobId): void; // poison → jobs/, same id, attempts reset to 0
  discard(id: JobId): void; // poison file durably removed
  close(): void;
}
```

`worker.js` is not part of the public surface. `take()` is not reintroduced.

### What the public surface hides

Hidden: temp-file write, fsync, rename, directory fsync, lock steal, `next-id` repair, attempt updates, backoff fields, poison directory, JSON codec, the rule that a thrown deliver is not an ack. Exposed: directory path, sync id return, payload-first deliver, poison tools, close. Callers never sequence claim and ack. One `drain(deliver)` is the delivery operation.

Validation at the boundary: `payload` must be JSON-serializable (`undefined`, functions, symbols, bigint throw before any file is committed). Unknown `v` fails construct rather than skipping a job. Unreadable non-temp files fail construct rather than dropping an obligation. Inside `drain`, records are trusted.

### Module ownership and migration

| Module | Owns | Does not own |
| --- | --- | --- |
| `queue.js` | store, recovery, enqueue commit, selection, deliver loop, ack, fail, poison, lock, close | external receiver behavior |
| `docs/decision.md` | replace the memory rationale when implementation is authorized | — |
| `test.mjs` | migrate the one caller | store layout |

`worker.js` is removed. It is the removal-before-delivery path (`worker.js:1-5`). A re-export of `queue.drain` would be a pass-through. The only importer is `test.mjs`.

Migration of observed callers:

- `new Queue()` → `new Queue(dir)`. No directory means no durability, so the old zero-arg constructor is not kept as a silent memory mode.
- `enqueue(payload)` signature and sync return stay. Fresh store still returns `1` first, because `test.mjs:3` encodes that, not because `docs/decision.md:3` justifies it.
- `drain(queue, deliver)` → `queue.drain(deliver)`. Existing `(payload) => …` callbacks keep working. Idempotent receivers read the second argument.
- `q.take()` after drain → `q.depth() === 0`. `take()` cannot stay: its meaning is delete-before-ack.

No other repository callers were found (`git ls-tree` at the base: `queue.js`, `worker.js`, `test.mjs`, `docs/decision.md`, `package.json`, plus agent-plan and AGENTS files).

### Flow

Construct: take `LOCK` (if the recorded pid is dead, steal it; if it is alive, throw). Delete `*.tmp`. Load every `jobs/` and `poison/` record. Repair `next-id` to `max(id)+1`. Build the three maps. A second live instance, including a second `drain` on the same instance, is rejected.

`enqueue`:

1. If closed, throw. Enqueue during an in-flight `drain` is allowed. The new id sorts after every id already committed.
2. Optional `idempotencyKey` hit in `byKey` returns the existing id and does not write a second obligation. Hit includes poison: returning that id tells the producer the work is still owned here, not that it was acked.
3. Allocate id. Write `jobs/<id>.json.tmp` with `attempts: 0`, `notBefore: 0`. Fsync the file. Rename into `jobs/<id>.json`. Fsync the directory. Only then insert into the maps and return `id`.

`drain`, one invocation, serial as today (`await` before the next deliver):

1. Select the minimum id in `runnable` with `notBefore <= now` that this invocation has not already attempted.
2. None left: return `idle`, or `aborted` / `closed` if that flag was set between jobs.
3. `await deliver(record.payload, { id })`.
4. Normal return: ack (below), then continue.
5. Throw: fail (below), then continue with the next id. The failed id is not retried in this invocation.

Ack: unlink `jobs/<id>.json`, fsync `jobs/`, then drop the map entries. `drain` does this only after `deliver` returns. Ack of an already-absent file is a no-op, so a retried ack after a crash-recovered duplicate removal does not throw.

Fail: replace the job file atomically (temp, fsync, rename, directory fsync) with `attempts + 1`, `lastError`, and `notBefore = now + backoffMs(attempts)`. If `attempts` reaches `maxAttempts`, rename to `poison/<id>.json` and fsync both directories instead. Then continue. Later ids in this invocation still run.

`requeue`: only from `poison/`. Atomic rename back to `jobs/`, attempts `0`, `notBefore` `0`, same id, fsync. `discard`: unlink a poison file and fsync. Both throw if the id is runnable or unknown. Neither runs from `drain`.

### Crash and ack windows

Process crash means the process is gone and a new `new Queue(dir)` runs recovery. Power loss is the fsync boundary below.

| Window | Store | What the caller saw | Next process |
| --- | --- | --- | --- |
| Before commit | temp only, or nothing | `enqueue` did not return | Temp deleted. No delivery. No id was published. |
| After commit, before return | `jobs/<id>.json` durable | Caller did not observe the id | Job is delivered. If that caller retries `enqueue` without `idempotencyKey`, a second id is a second obligation. |
| During `deliver` | file still in `jobs/` | External effect may be partial | Same id delivered again. |
| After external success, before ack fsync | file still in `jobs/` | Receiver accepted the job; `drain` has not finished ack | Same id delivered again. This duplicate is required behavior, not a bug. |
| After ack directory fsync | file gone | `deliver` returned and removal is durable | No replay of that id. |

A crash after unlink and before directory fsync can resurrect the directory entry on power loss. That falls in the duplicate window. At-least-once still holds. Exactly-once is not claimed.

There is no persisted “externally delivered” state. Writing that bit is the ack. If we die before writing it, the honest state is “obligation remains.”

### FIFO best effort, failures, poison

Happy path: ascending id among runnable files. `drain` awaits each deliver before selecting the next, so one invocation is serial. Enqueue during an awaited deliver commits a higher id and is eligible later in that invocation.

Not strict FIFO once a deliver throws. The failed id is deferred (`notBefore`) or poisoned. Higher ids in the same invocation proceed. A later invocation retries a deferred id only when `notBefore <= now`, and then it may run before newer ids because it keeps its original id. That reordering is the failure policy, not the success policy.

Poison: at `maxAttempts`, the file leaves `jobs/` and `drain` never selects it. Later jobs proceed. The hole is durable across restart. `poisoned()` lists it. `requeue` puts the same id back at the front of the id order; that jump is an operator action, not automatic. `discard` drops the obligation without delivery. Automatic deletion of poison would hide lost work; this design does not do it.

Default `backoffMs` is `() => 0` and default `maxAttempts` is 5. [INFERENCE] Neither number appears in code, tests, or `docs/decision.md`. With zero backoff, a failed job is still attempted at most once per `drain` invocation, so one poison-bound payload does not spin inside a single call. Five failing invocations poison it. Tests pass `backoffMs: () => 0` and a small `maxAttempts` and need no timers.

### Local-store durability boundary

The store is this directory on the local filesystem. No network service, no extra package.

Commit point for enqueue, fail, poison, requeue, and discard: file contents fsynced, rename complete, directory fsynced, and only then the in-memory map changes and the method returns.

Ack point: unlink complete and `jobs/` fsynced.

What that does not cover:

- A disk, snapshot, or copy that ignores fsync can lose or resurrect files. Duplicates remain allowed. Silent loss outside the fsync contract is not.
- Process crash after the method returns is covered even if a later power loss is not, because the kernel still has the directory entry. [INFERENCE] On darwin, `fsync(2)` is not `F_FULLFSYNC`, and directory fsync can return `EINVAL`. Implementation should use `F_FULLFSYNC` on darwin for the file, and treat directory-fsync `EINVAL` as “process-crash durable, power-loss not proven on this OS,” not as a successful power-loss commit. This host is darwin 25.6.0. The brief’s restart story is process restart; power-loss is the stricter boundary this design still names.
- NFS and “sync” mounts that lie are outside the contract. The supported boundary is a local disk that honors the fsync used above.
- The queue does not replicate. One directory, one live owner.

### IDs and receiver idempotency

Ids start at 1 on a fresh directory so the existing assertion holds, then persist for the life of the directory. Ack does not recycle an id. Crash recovery never resets the counter to 1 (that reset is an inference from today’s object fields, and it is the behavior this design removes).

`deliver` is called as `deliver(payload, { id })`. Payload-only callbacks remain valid JavaScript. Receivers that need exactly-once effects must store `id` themselves and no-op on a repeat. The queue will replay that id after every post-commit crash window above. Exactly-once is not a queue promise.

Producer retry is a separate hole. `enqueue` after a commit the caller did not observe creates a new id unless the same `idempotencyKey` is passed. The key is optional so `enqueue(payload)` stays source-compatible. A key is remembered for both runnable and poison files, and forgotten after ack or discard, so a reused key after ack is a new obligation. [INFERENCE] No current caller has a natural key; `test.mjs` does not need one.

### Operational lifecycle

- Start: `new Queue(dir)` recovers, or throws if another live pid holds `LOCK` or a committed file is unreadable.
- Run: any number of `enqueue` calls, one `drain` at a time. `drain` returns when it runs out of immediately runnable jobs; it does not sleep. A supervisor calls `drain` again to pick up backoff or new work. That keeps tests timer-free.
- Stop: `close()` waits for the in-flight `deliver` to settle, performs that job’s ack or fail, then releases `LOCK`. It does not cancel an external call. `AbortSignal` stops the loop only between jobs. `close()` twice is a no-op.
- Crash: no close. Next construct steals `LOCK` if the pid is dead, discards temps, replays `jobs/`, leaves `poison/` out of selection.
- Stuck receiver: a `deliver` that never settles blocks this `drain`, as `await` already does in `worker.js:4`. Close waits. No default timeout is invented.
- Full disk: `enqueue` throws before return; no id is published. A partial temp is removed on the next construct.
- Operator: `poisoned`, `requeue`, `discard`. No admin broker, no second process reader.

### Interface depth

`Queue` is one deep module. The capability behind seven methods is commit, recovery, serial at-least-once delivery, failure deferral, and poison. Callers do not learn the file protocol. Compared with exporting `claim` / `ack` / `fail`, this surface is smaller and the misuse that exists today (`take` then `deliver`) is not expressible.

### Deterministic verification

No external service. A temp directory and Node’s `fs` are enough. Suggested checks, each tied to a contract above:

- Fresh `enqueue` returns `1`, then `2`. `drain` with a one-arg callback yields `['a','b']`. `depth()` is 0. Files for those ids are gone. Covers migration of `test.mjs`.
- `enqueue`, `close`, `new Queue(same dir)`, `drain` delivers the same id and payload. Kill `-9` a child process after `enqueue` returns, then open in the parent: same result. Covers after-commit restart.
- Child killed after creating only a `*.tmp`: reopen delivers nothing and `enqueue` does not reuse an id that was never returned.
- `deliver` posts to an in-process recorder and then throws: file remains, `depth()` is 1, second `drain` posts the same id again. Covers after-external-success before ack, without a real crash.
- `deliver` throws for id 1 and succeeds for id 2 in one `drain`: recorder sees id 2 before any second attempt of id 1. With `maxAttempts: 1`, id 1 is under `poison/` and id 2 is acked. Restart does not deliver id 1. `requeue` delivers it under the original id.
- Second `new Queue(dir)` while the first is open throws. Second concurrent `drain` throws.
- `enqueue(payload, { idempotencyKey: 'k' })` twice returns one id and one file.
- Non-JSON payload throws and leaves `depth()` unchanged.
- `enqueue` while `drain` is awaiting still delivers that higher id before `drain` returns idle.

Assert outcomes and files, not source text. Subprocess kill is the crash proof; the throw-after-post case is the in-process duplicate proof. Both should exist. No new dependency.

## Synthesis decision

Not filled here. Arena compares candidates; the owner decides. This page is one recommendation. It does not select an architecture, authorize implementation, or reject another candidate — those proposals were not read.

## Tradeoffs accepted

- We accept an event-loop stall inside `enqueue` and `ack` in exchange for a synchronous return that is actually a commit. The historical reason for sync was API shape and avoiding infrastructure (`docs/decision.md:1-2`), not a measured latency budget. None is in evidence.
- We accept duplicate external effects after post-commit crashes in exchange for never dropping a committed id. Exactly-once would be a false contract.
- We accept a JSON payload restriction the memory queue does not have in exchange for a durable representation. Observed payloads are strings (`test.mjs:3-4`). [INFERENCE] No caller passes a live object.
- We accept a required directory argument and deletion of `take()` and `worker.js` in exchange for making the loss path unrepresentable. The call-site count in this repo is one.
- We accept best-effort reordering after failure, and a front-of-queue jump on `requeue`, in exchange for not stalling healthy ids behind a bad one and not minting a new id for the same obligation.
- We accept unbounded growth of `jobs/` while the consumer is down in exchange for not inventing a retention policy with no evidence.
- We accept a default of 5 attempts and zero backoff in exchange for a usable `drain` without new required arguments. Both defaults are inferred.
- We accept one owner process and a pid lock in exchange for not building multi-process coordination the brief forbids us to need.
- We accept file-per-job fsync cost in exchange for a crash window that is visible as directory entries and needs no compaction log.

## Alternatives considered

- In-memory queue plus a background flusher. Smaller change to `queue.js`, but `enqueue` would return before durability, so the sync id would again be a lie. The honest version of this shape is `enqueue` returning a Promise, which breaks call site 1 and every `const id = queue.enqueue(...)` caller. Rejected. It also leaks a flush stage into caller reasoning (what if I crash before flush?).
- Append-only JSONL plus a compaction snapshot. One fsync per commit, similar durability, but ack is a second record that can disagree with the enqueue record, and compaction adds a crash window the file-per-job rename does not have. Callers would still see the same API, so interface depth is similar, while the implementation has two representations of “unacked.” Rejected as a second source of truth.
- SQLite WAL, still local, no broker. Stronger atomic multi-field updates and a proven fsync story. Rejected for this prototype because it adds a native dependency `package.json` does not have, a schema migration path, and pressure to expose queries. The capability the caller needs is already hidden behind `Queue` without that surface. Prefer SQLite only if power-loss atomicity on darwin cannot be made honest with `F_FULLFSYNC` — that is an implementation finding, not the default shape.
- Strict FIFO: block `drain` on the head until it is acked or poisoned as a separate control-plane action. Simpler ordering story, worse operations. One failing receiver freezes every later id, which contradicts best-effort FIFO across failed deliveries. The complexity it hides (no poison-vs-order interaction) is complexity the brief told us to specify, not remove.
- Inflight directory plus pending directory. Looks like explicit claim state. On restart every inflight file is an obligation again, which is the same rule as “file in `jobs/`.” Two directories, one fact. Rejected as temporal decomposition.
- External broker. Forbidden by the brief. Also the opposite of `docs/decision.md:1-2`, which avoided infrastructure. The new requirement is durability, not a second service.

## Open questions and risks

- Is process-restart durability enough, or must a power loss after `enqueue` returns also preserve the job on darwin? The design names `F_FULLFSYNC` plus directory fsync as the commit point and treats darwin directory-fsync `EINVAL` as an unverified power-loss claim. If power loss is in scope and that call cannot be made honest, the SQLite alternative should be reopened before implementation.
- Is pid-lock steal acceptable? [INFERENCE] Pid reuse after a crash could let a second process open the directory while the original is alive. The window is small and the brief asks for one process. A lock that is never stolen fails closed after every crash and needs manual cleanup. Which failure is worse here?
- Should `maxAttempts` stay defaulted at 5, or be required so a guessed threshold is not silently policy?
- A `deliver` that never returns blocks `close`. Do you want a timeout that counts as failure, or is matching today’s unbounded `await` the contract?
- `idempotencyKey` after ack is forgotten. Should a key be remembered forever so a producer retry after success cannot create a second job? Forever needs a key log this design deliberately does not keep.
- How large may `jobs/` grow, and who is the supervisor that calls `drain` again? Nothing in the repo defines a process manager. This design stops at the library.
- `requeue` keeps the original id and can jump ahead of newer work. Is that the operator meaning you want, or should requeue be forbidden so poison is terminal?

## Next implementation step

After the owner selects this design and authorizes implementation, replace `queue.js` / `worker.js` / `test.mjs` / `docs/decision.md` so `new Queue(dir)` commit-before-return, `queue.drain(deliver)`, and the crash table above hold at base `b731c08edd71d93a90e7b8faaf05185b934f7fe9`.

Fixed contracts if this recommendation is chosen: sync `enqueue` returns only after the job file is committed; id `1` on a fresh store; ids never reused; `deliver(payload, { id })`; ack only after `deliver` returns and the directory fsync completes; post-commit crash replays; poison does not block later ids; no broker; no `take()`; no `worker.js`. Worker discretion: exact backoff curve, error-string truncation, lock-file text format, and whether `F_FULLFSYNC` is a small local helper. Not discretion: exactly-once claims, a memory mode, or a public claim/ack pair.

Acceptance: the verification list in Shape passes, including one real child-process kill after `enqueue` returns and one throw-after-external-success replay of the same id. This preparation task does not authorize that work.

## Rubric self-check

Scores are this candidate against the shared rubric, with the design evidence named. Not a comparison to other candidates.

1. Recovery/delivery semantics — **5**. Ack is unlink plus directory fsync, and only after `deliver` returns. Restart loads `jobs/` and replays. The four windows (before commit, after commit before return, during deliver, after external success before ack) are in the crash table, and the last one is specified as a duplicate, not exactly-once. Failures defer or poison; they do not vanish. Evidence: Shape “Crash and ack windows”, “FIFO best effort”, ack rule. Gap that keeps it from being a hope-score: darwin power-loss fsync is named as unverified rather than assumed.
2. Compatibility — **4**. `enqueue(payload)` stays sync and still returns a number; fresh id `1`; one-arg deliver callbacks still work; `DrainResult` is ignoreable as today’s `drain` return is ignoreable (`test.mjs:4`). Cost is explicit: `new Queue(dir)`, `queue.drain`, `depth()` replaces `take()`, `worker.js` removed, payload must be JSON. Not 5 because the constructor and the only drain import do change, and a zero-arg `new Queue()` cannot remain truthful.
3. Operational simplicity — **5**. One process, one directory, one module, no new package, no broker. Lifecycle is construct / enqueue / drain / close / crash-steal. Poison is three methods, not a control plane. Conceptual surface is the crash table plus “file exists means deliver again.”
4. Evidence-grounded tradeoffs — **4**. Historical rationale cited from `docs/decision.md:1-3` and commit `b731c08` is separated from inference (attempt default, JSON-only callers, pid reuse, darwin fsync, id restart being an object accident). Alternatives are different shapes, each with what it hides and what it pushes onto callers. Not 5 because the attempt default and zero backoff are still choices made without evidence, even though they are labeled.
5. Testability — **5**. Every contract check uses a temp directory, in-process `deliver`, or a killed Node child. No broker, no clock sleep on the default path, no network. Order, poison, migration, duplicate-after-success, and kill-after-commit are each a single assertion story in “Deterministic verification.”

## Red-flag screen

- Shallow module — not present. Callers do not compose claim, deliver, and ack. Learning `enqueue` / `drain` / `close` does not require learning rename or fsync. Poison methods are the operation, not a stage leak. `depth()` is the emptiness check `take()` was used for, without deletion.
- Information leakage — not present. Job JSON, `LOCK`, and `next-id` are not exported. `DeliverMeta` is `{ id }`, a domain identity, not a file path or storage record. `worker.js` is not kept as a second module that would have to share the protocol.
- Temporal decomposition — not present. Load, commit, deliver, fail, and ack stay on `Queue` because they protect one decision: file presence is the obligation. An inflight/pending split was considered and rejected in Alternatives. `drain` running later than `enqueue` is time, not a separate knowledge boundary.
- Pass-through — not present. There is no wrapper that forwards `enqueue` or `drain` unchanged. Folding `worker.js` into `Queue` removes the layer that previously added no policy except “delete, then call.” `drain` adds the policy (serial await, ack only on success, skip-this-invocation on failure, abort between jobs), so it is not a forwarder to an internal `take`.
