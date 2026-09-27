Fixture: /private/tmp/agent-plan-skill-smoke-zHiE5o

How: process-local Map; exact id key; hit only while age < 30000; equality expires; coalesced same-id concurrent miss; load invoked through Promise.resolve().then; cache timestamp captured at success; pending removed on success/failure; rejected calls not cached and retry; no cross-process sharing or capacity eviction.
Why: decision.md and second commit document burst upstream rate limit, same-id coalescing and retry. Exact 30000 TTL rationale UNKNOWN. Six external evidence categories and forge discussion unavailable in this scoped fixture. Direct leaf smoke; task/delegation not enabled.

History:
985ad562c3761c4da8d61d9144c091b93a9a581b Document burst rate limit rationale and failed request retry
86c7fa96389e2e163d499663602f12003a7b6e7c Add customer lookup cache
