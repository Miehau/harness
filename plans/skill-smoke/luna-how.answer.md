### Overview
`createLookup(load, now)` returns an async lookup function with a per-instance, in-memory cache and in-flight request deduplication. The TTL is 30,000 ms; `now` defaults to `Date.now` and can supply the cache’s clock. [cache.mjs:1–4](cache.mjs)

### How It Works
For each `lookup(id)`, it first checks the cached entry. The value is fresh only when `now() - hit.at < TTL_MS`; at exactly 30,000 ms, it is expired. A fresh hit returns immediately. [cache.mjs:5–7](cache.mjs)

On a miss or expired entry, the lookup checks `pending`. If the same ID already has a load in progress, it returns that promise, so concurrent misses share one `load(id)` call. Otherwise, it schedules `load(id)` through a promise, records the promise in `pending`, and returns it. On success, it caches the value with a timestamp taken at completion. [cache.mjs:8–13](cache.mjs)

If `load` rejects, no new cache entry is written. The `finally` handler removes the pending entry on either success or failure, so a later lookup can retry. [cache.mjs:9–13](cache.mjs)

### Where Things Live
- `cache.mjs` — implementation.
- `cache.test.mjs` — fixture checks concurrent deduplication, the 29,999 ms / 30,000 ms expiry boundary, and retry after rejection. [cache.test.mjs:1–12]
- `README.md` — describes the fixture as an in-process customer lookup cache with no external sources configured.

### Gotchas
- Expired entries are not deleted on lookup; a successful reload overwrites them. If the reload fails, the old entry remains stored but is still expired under a forward-moving clock. [cache.mjs:5–12]
- The state lives in the two `Map`s captured by the function returned from `createLookup`. Each call to `createLookup` creates separate cache and pending state. [cache.mjs:2–4]