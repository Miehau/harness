### The Question

Why does `createLookup` coalesce in-flight requests, drop pending entries after failure, and use a 30000ms TTL? The embedded hypothesis is that all three choices are performance optimizations.

### The Code in Question

`cache.mjs:1-16` defines `TTL_MS`, `createLookup`, and `lookup` (`cached`, `pending`). `decision.md:1` is the in-repo decision record. `cache.test.mjs:1-11` locks the three behaviors. Two commits, both by Smoke Test `<smoke@example.invalid>` at 2026-09-27T00:44:54+01:00: `86c7fa96389e2e163d499663602f12003a7b6e7c` (root; adds the code) and `985ad562c3761c4da8d61d9144c091b93a9a581b` (child; adds the decision record and tests). No PR numbers, ticket IDs, or remotes.

### What We Found

- **[Direct]** Concurrent misses for the same customer id are coalesced because duplicate upstream calls exhausted the fixture rate limit during bursts. Source: `decision.md:1`: "coalesce concurrent misses for the same customer id. Duplicate upstream calls exhausted our fixture rate limit during bursts." Same commit subject, `985ad562c3761c4da8d61d9144c091b93a9a581b`: "Document burst rate limit rationale and failed request retry."
- **[Direct]** The same commit also states a narrower mechanism: coalescing avoids duplicate calls. Source: body of `985ad562c3761c4da8d61d9144c091b93a9a581b`: "Coalescing concurrent requests avoids duplicate calls." That sentence does not say "performance" or "rate limit"; the subject and `decision.md:1` supply the rate-limit event. These wordings agree; they are not independent corroboration.
- **[Direct]** Failed pending requests are removed so the next call retries. Source: `decision.md:1`: "Remove failed pending requests so the next call retries." Commit body: "retry after failure needs pending eviction."
- **[Direct]** The authors recorded that the TTL value is unexplained. Source: `decision.md:1`: "This record does not explain the TTL value." Commit body: "TTL selection is not recorded."
- **[Direct]** The implementation commit does not state a rationale. `86c7fa96389e2e163d499663602f12003a7b6e7c` message is only "Add customer lookup cache." The rationale text arrives in the child commit with `decision.md` and `cache.test.mjs`.
- **[Direct]** No searched in-repo text calls any of the three choices a performance optimization. `git log --all --grep=performance` and `--grep=perf` are empty. `decision.md` names rate-limit exhaustion and retry, then says the TTL is unexplained.

### What We Can Reasonably Infer

- **[Inferred]** The tests added in `985ad562c3761c4da8d61d9144c091b93a9a581b` are consistent with the recorded behaviors, not an additional motive. `cache.test.mjs:5-6` expects one load for two concurrent lookups; lines 9-10 expect a second load after a thrown error; lines 7-8 pin the 30000 boundary. Given they landed in the rationale commit and contain no explanatory comment, they appear to lock those behaviors rather than explain the number.

### Competing Hypotheses

- **Hypothesis:** All three choices are performance optimizations.
- **Evidence for:** The commit body says coalescing "avoids duplicate calls," which can be read as reducing work. Nothing else in the record supports a performance framing.
- **Evidence against or missing:** `decision.md:1` attributes coalescing to fixture rate-limit exhaustion and pending eviction to retry. Both that file and the commit body say the TTL is not explained. No commit, comment, or test text says performance. The hypothesis does not fit the two stated reasons, and it is unsupported for the TTL.

- **Hypothesis:** 30000ms was chosen for freshness, to match some upstream cache window, as an arbitrary fixture constant, or to cut load.
- **Evidence for:** None. The constant exists at `cache.mjs:1` and the test asserts the boundary. That is mechanics, not a stated motive.
- **Evidence against or missing:** The only texts that discuss the TTL say its selection is not recorded. These stories fit equally well. No winner.

### What We Don't Know

- Why 30000ms rather than another TTL. Searched `decision.md`, both commit messages and bodies, `cache.mjs` (no comments, TODO, FIXME, HACK, XXX, or NOTE), `cache.test.mjs` (boundary asserts only), `README.md`, and `git log -S '30000'` / `-S 'TTL_MS'`. The only hits are the constant, the boundary test, and the statements that the value is not explained.
- Whether "avoids duplicate calls" was also meant as a latency or throughput goal. The record stops at duplicate calls and fixture rate-limit exhaustion.
- Whether clearing pending entries after success has a separate reason. The text only explains failed requests. The success-path delete is code mechanics, not a recorded motive.
- Whether the rate-limit exhaustion was an incident. Git messages were searched for `incident`, `postmortem`, `sev-`, and `revert`; no matches. No incident tracker, chat, or observability source was searchable.
- Review discussion. No `(#NNNN)` PR markers, no ticket IDs (`[A-Z]+-[0-9]+`), no git remotes, and no forge client was available to query.
- Anyone beyond the commit author, Smoke Test `<smoke@example.invalid>`, who could supply the TTL choice. No ticket or chat path to that author exists in this scope.

### Sources Consulted

- **Source control history**: `cache.mjs:1-16`, `cache.test.mjs:1-11`, `decision.md:1`, `README.md:1-2`; 2 commits reviewed (`86c7fa96389e2e163d499663602f12003a7b6e7c`, `985ad562c3761c4da8d61d9144c091b93a9a581b`); no PRs. In-repo decision record treated as source control, not an external doc search. Comments and incident/perf/ticket message searches above. Hosted review not searched: no remote and no forge data in scope.
- **Issue / ticket tracker**: Not searched. No matching MCP available in this environment.
- **Long-form documents**: Not searched. No matching MCP available in this environment.
- **Real-time team chat**: Not searched. No matching MCP available in this environment.
- **Infrastructure observability**: Not searched. No matching MCP available in this environment.
- **Error / exception tracking**: Not searched. No matching MCP available in this environment.
- **Product analytics warehouse**: Not searched. No matching MCP available in this environment.

### Confidence Summary

Coalescing and failed-pending eviction have direct statements in `decision.md:1` and `985ad562c3761c4da8d61d9144c091b93a9a581b`: fixture rate-limit exhaustion from duplicate calls, and retry after failure. The 30000ms TTL is unknown; the same sources say it is not recorded. The performance hypothesis is not what those sources state.