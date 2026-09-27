# Handoff

Status: completed. Read-only architecture candidate. No repository edits. No implementation.

Proposal: `workers/010f648f-42f6-4679-bc7d-d5db0eff661c/proposal.md`

Recommendation, not an owner decision: keep synchronous `enqueue`, return the id only after a `node:sqlite` `synchronous=FULL` commit, and let `drain` call `Queue.attempt` so ack is a delete after `deliver` resolves. Same id may be redelivered if the process dies after external success and before that delete. Explicit failures yield to the tail, then park at `maxAttempts`. `new Queue()` and `take()` migrate; the fresh-file id `1` and one-arg `deliver(payload)` stay.

Verification performed: read `queue.js`, `worker.js`, `test.mjs`, `docs/decision.md`, `package.json` at `b731c08edd71d93a90e7b8faaf05185b934f7fe9`; `git log` / `git blame`; Node v22.19.0 `node:sqlite` probe in temp (experimental warning, FULL=`2`, DELETE journal, exclusive lock, AUTOINCREMENT). Did not run `test.mjs`. Did not read other candidates.

Remaining: owner choice, including whether experimental `node:sqlite` is acceptable. Implementation is not authorized. Lock release after `SIGKILL` is specified as a test, not yet demonstrated.
