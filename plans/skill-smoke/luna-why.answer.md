### The Question

Why does `createLookup` coalesce requests, evict failed pending requests, and use a 30,000 ms TTL? Is performance the reason for all three?

### The Code in Question

`cache.mjs:1–16` defines `TTL_MS` and `createLookup`. The relevant choices are the cache-hit check (`:6–7`), pending-request reuse (`:8`), and pending cleanup after settlement (`:12`). `decision.md:1` records rationale for coalescing and failure retry, but says the TTL choice is undocumented.

### What We Found

- **[Direct]** Coalescing same-ID concurrent misses was chosen because duplicate upstream calls exhausted the fixture rate limit during bursts. The decision also says coalescing avoids duplicate calls. Source: `decision.md:1`; commit `985ad562c3761c4da8d61d9144c091b93a9a581b` (“Document burst rate limit rationale and failed request retry”).
- **[Direct]** Failed pending requests are removed so the next call can retry. Source: `decision.md:1`; the same commit. This is documented as retry behavior, not as a performance choice.
- **[Direct]** The TTL’s selection rationale is not recorded. Source: `decision.md:1`, which explicitly says, “This record does not explain the TTL value.”

### What We Can Reasonably Infer

- **[Inferred]** Performance is a benefit of coalescing, since fewer duplicate upstream calls are made, but the documented forcing reason is avoiding rate-limit exhaustion—not performance as a general goal. Source: `decision.md:1`.
- **[Inferred]** Failure eviction permits a later lookup to call `load` again rather than reuse a failed request. The decision states that intent, and `cache.test.mjs:9–10` exercises a failure followed by success. This explains retry behavior; it does not establish a performance rationale.
- **[Inferred]** The TTL limits how long a successful value is reused: `cache.test.mjs:7–8` checks a hit before 30,000 ms and a reload at 30,000 ms. That establishes the boundary behavior, not why 30,000 ms was selected.

### Competing Hypotheses

- **Hypothesis:** The TTL was selected to improve performance by avoiding repeated loads.
  - **Evidence for:** The implementation caches successful values for a bounded interval (`cache.mjs:6–10`).
  - **Evidence against or missing:** No rationale for the specific TTL appears in the fixture decision or reviewed history. The implementation shows behavior, not intent.

### What We Don't Know

The available fixture records do not explain why the TTL is 30,000 ms, whether it reflects a freshness requirement or another constraint, or whether performance influenced its choice. No external evidence sources were available to search.

### Sources Consulted

- **Source control history**: Reviewed the two commits touching the fixture files, including the initial `cache.mjs` addition and the later rationale commit; checked blame for `cache.mjs`. No forge or remote review data was available.
- **Issue / ticket tracker**: Not searched. No external tracker source was available.
- **Long-form documents**: Not searched. No external document source was available.
- **Real-time team chat**: Not searched. No chat source was available.
- **Infrastructure observability**: Not searched. No observability source was available.
- **Error / exception tracking**: Not searched. No error-tracking source was available.
- **Product analytics warehouse**: Not searched. No analytics source was available.

### Confidence Summary

The rate-limit rationale for coalescing and retry rationale for removing failed pending requests are directly documented. The TTL’s value has no documented rationale in the searched fixture history; attributing it to performance would be speculative.