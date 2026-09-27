### The Question

Why `createLookup` coalesces same-ID requests, evicts failed pending requests, and uses a 30,000 ms TTL; specifically, whether all three are performance choices.

### The Code in Question

`cache.mjs:1-16` — `TTL_MS`, `createLookup`, `cached`, and `pending`.
`decision.md:1` records the only stated rationale. `cache.test.mjs:5-10` exercises coalescing, TTL expiry, and retry-after-failure.

### What We Found

- **[Direct]** Concurrent misses for the same customer ID are coalesced to prevent duplicate upstream calls from exhausting the fixture rate limit during bursts. Source: `decision.md:1`, introduced by commit `985ad562c3761c4da8d61d9144c091b93a9a581b` (“Coalescing concurrent requests avoids duplicate calls…”).
- **[Direct]** Failed pending requests are removed so a later lookup can retry. Source: `decision.md:1`, commit `985ad562c3761c4da8d61d9144c091b93a9a581b` (“retry after failure needs pending eviction”).
- **[Direct]** The rationale record explicitly says the TTL selection is not recorded. Source: `decision.md:1`, commit `985ad562c3761c4da8d61d9144c091b93a9a581b` (“TTL selection is not recorded.”).

The record therefore does **not** support “all three are for performance.” Coalescing does reduce duplicate work, but the stated forcing function is burst rate-limit exhaustion. Pending eviction is stated as retry behavior. The 30,000 ms value has no recorded rationale.

### What We Can Reasonably Infer

- **[Inferred]** Coalescing likely has a secondary efficiency benefit, since avoiding duplicate upstream calls also avoids duplicated work. The documented reason, however, is rate-limit protection rather than a general performance objective. Reasoning: `decision.md:1` states the rate-limit problem; it does not characterize the change as a performance optimization.
- **[Inferred]** Evicting a rejected pending promise is an availability/correctness choice: retaining it would make subsequent same-ID callers receive the prior rejection instead of initiating a new load. This is consistent with the retry scenario in `cache.test.mjs:9-10`, but the test demonstrates behavior rather than author intent.

### Competing Hypotheses

- **Hypothesis:** 30 seconds was selected as a freshness-versus-upstream-load tradeoff.
  - **Evidence for:** The implementation has an expiring in-process cache at `cache.mjs:1,7`.
  - **Evidence against or missing:** No history, decision record, comment, ticket, or operational data explains freshness requirements, acceptable staleness, or why 30 seconds rather than another value.

- **Hypothesis:** 30 seconds matched an upstream quota, burst window, or operational threshold.
  - **Evidence for:** The documented coalescing rationale concerns upstream rate limits during bursts (`decision.md:1`).
  - **Evidence against or missing:** The record expressly omits TTL rationale; no quota configuration, incident, or metrics source is available to connect the numeric value to a rate-limit window.

### What We Don't Know

- Why the exact value is **30,000 ms**, including whether it derives from freshness requirements, upstream quota windows, observed traffic, latency, or convention.
- Whether alternative TTLs were evaluated.
- Whether the fixture rate-limit issue was measured operationally or only reproduced locally.
- No PRs, merge commits, or linked tickets exist in the fixture history that could add rationale.
- The following six evidence categories are unavailable in this read-only fixture scope:
  1. Issue / ticket tracker
  2. Long-form documents
  3. Real-time team chat
  4. Infrastructure observability
  5. Error / exception tracking
  6. Product analytics warehouse

### Sources Consulted

- **Source control history**: Reviewed all two target-related commits: `86c7fa96389e2e163d499663602f12003a7b6e7c` and `985ad562c3761c4da8d61d9144c091b93a9a581b`; inspected `cache.mjs`, `cache.test.mjs`, `decision.md`, and `README.md`; blamed `cache.mjs:1-14`; searched fixture text for `ttl`, `30000`, `coalesce`, `pending`, `rate limit`, `retry`, and `performance`; no PR-numbered merge commits or code comments.
- **Issue / ticket tracker**: Not searched. No matching MCP or external source is available in this environment.
- **Long-form documents**: Not searched. No matching MCP or external source is available in this environment.
- **Real-time team chat**: Not searched. No matching MCP or external source is available in this environment.
- **Infrastructure observability**: Not searched. No matching MCP or external source is available in this environment.
- **Error / exception tracking**: Not searched. No matching MCP or external source is available in this environment.
- **Product analytics warehouse**: Not searched. No matching MCP or external source is available in this environment.

### Confidence Summary

High confidence for coalescing as burst rate-limit protection and failed-pending eviction as retry enablement: both are explicitly documented in `decision.md:1`. The 30,000 ms rationale is unknown; the sole decision record explicitly says it was not recorded. `node cache.test.mjs` exercised the fixture and printed `fixture passes`.
