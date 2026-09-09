# Agent context audit — 2026-09-09

The context flow is partially sound, but it is not yet possible to certify that every agent gets sufficient current evidence or that dashboard token totals are complete. This audit traced daemon call sites through Pi session creation, prompt rendering, retained artifacts, and inspection. Two gpt-5.6-luna exploratory agents independently checked review/fix routing and observability. Verification uses mocked Pi sessions; no paid model runs were launched.

## Context routing

| Agent / time | Context actually supplied | Assessment |
| --- | --- | --- |
| Requirements | Ticket and living product context; no repository tools | Appropriate separation of product clarification and implementation discovery. |
| Exploration / architecture | Approved requirements, living context, exploration / look-ahead, technical answers | Relevant inputs are present. |
| Fresh implementation worker | Full feature brief and architecture artifacts, accepted transitive dependency handoffs, step product context, scope, criteria, skills | Sufficient starting evidence; whole-plan artifacts and transitive handoffs can grow without prompt-size limits. |
| Resumed implementation / slice fixer | Existing conversation, feedback, current criteria and scope, deferred slices | Avoids repeating the full prompt. Assumes the retained conversation still contains the needed handoffs. Fresh-session fallback rebuilds context. |
| Slice verifier | Fresh session per round; step criteria, whole design, cumulative worker artifact and diff, checks, current visual evidence; prior findings for corrections | Strong evidence packet; bounded to 30 inspection actions / five minutes. Resuming repeats the packet, which favors freshness over size. |
| Final independent reviewers | Same compact ticket packet for requirements, integration, verification; different charter; current criteria, images, prior findings and operator constraints | Independence is useful, but the entire packet and all findings are sent three times. Unlike slice verification, this path has no equivalent inspection-action/time budget. |
| Final review fixer | Synthetic step with findings, optional recurring-root-cause / restart instructions, images; no dependency artifacts | Sparse. No supplied canonical diff, check output, accepted implementation handoffs, or relevant approved product context. Repository inspection must fill those gaps. |

Source entry points: `src/server.js:2121` (worker artifacts), `src/pi-harness.js:393` (step context), `src/pi-harness.js:1497` (slice verification), `src/server.js:3127` (final fixer), `src/server.js:3342` (three reviewers).

## Confirmed defects corrected

1. **Review recovery could send a continuation into an empty session.** A saved filename selected the short continuation even if opening it failed or produced no messages. That omitted the charter, diff, artifacts, and finding list. `reviewTicket` now checks actual session messages, like `runStep`, and sends the full packet when recovery has no context. Tests cover valid continuation, empty recovery, and an open failure.
2. **Trace reconstruction discarded recorded token usage.** Live events captured input/output/cache usage, but `sessionTrace` omitted it and the attempt-details serializer removed numeric fields. Both now preserve usage, with timestamp-bound and API regression assertions. The existing bounded event retention still applies; this is not a complete billing ledger.

## Remaining findings, in priority order

0. **Measured: slice verification receives storage-sized diffs.** `formatRepositoryProof` embeds the full patch; `src/git.js` permits 600,000 patch characters. The largest prompt in the sample below is 615,326 characters, of which 600,008 are the diff section (including its delimiter): 97.5%. This is the strongest measured input-volume issue. Use a bounded per-file review packet with explicit omitted-file/hunk metadata and access to the complete canonical diff. Preserve evidence coverage; silently slicing a smaller prefix would hide defects. The compact final-review path already demonstrates a smaller packet, but should not be copied without retaining access to omitted evidence.
1. **Seed final fixers with focused evidence.** `applyFinalReviewFix` passes `artifacts: []`; `finalReviewFixStep` supplies finding prose but no original implementation context. Supply the current relevant diff, failed deterministic diagnostics, and affected accepted handoffs. Do not send every historical artifact. Missing context is confirmed; the amount of wasted inference caused by it needs a measured comparison.
2. **Dashboard token totals are incomplete by construction.** `runMetrics` sums retained attempt/stage events, while activity keeps only bounded event tails and public active workers omit their activity. Missing usage therefore looks like zero or a smaller total. Recovered trace events now expose their counts, but do not automatically repair dashboard totals. Aggregate usage independently of the rolling event log before using those totals to judge model efficiency.
3. **Review context repeats.** The packet contains plan acceptance criteria and proof-map criterion text, then the prompt repeats every approved criterion again. Repository patches can also appear in both canonical and per-repository sections. Preserve criterion IDs and repository identity while removing duplicated bodies; benchmark before changing review coverage.
4. **Worker input can grow with plan length.** All feature/architecture artifacts plus transitive accepted handoffs are hydrated for every worker. The prompt tells the planner to provide only relevant product context, but this separate artifact path bypasses that intention. Prefer the latest relevant handoffs and artifact locators for additional evidence; avoid truncating requirements blindly.
5. **A context manifest is an input inventory, not proof of effective model context.** Ordinary workers retain `context.json` after returning, including profile and artifact references. Resumed workers do not resend those artifacts. The manifest does not capture effective inherited history, SDK compaction, images, tool definitions, or injected repository instructions. Failed pre-report workers and final reviewers/fixers do not have equivalent manifests. Use the rendered prompt plus session trace to assess a specific attempt; do not treat a manifest alone as an exact provider request.

## Verification and tracking

- `node scripts/test.mjs pi-harness` covers recovery, focused correction prompts, inspection limits, and reconstructed usage.
- `node scripts/test.mjs server` covers usage preservation through attempt-details inspection.
- `node src/cli.js list timeline <ticketId> <runId>` resolves the canonical run/attempt identities; the attempt details and session-trace routes expose retained evidence.
- For a real comparison, group by ticket/run, step or reviewer role, and correction round. Measure uncached input, cache read/write, output, repository read/search calls, findings resolved, and repeat findings separately. A short continuation still reuses its conversation history; prompt length alone is not token cost.
- The local daemon was not reachable during this audit. Fixture coverage verifies retention behavior, not real model quality or savings. Dollar savings and a causal link between sparse context and repeated reads are not established by the code audit.

## Retained-session baseline

Read-only sample: the 30 newest JSONL files by filesystem modification time under the default Pi session store, covering 2026-09-08 20:39:47 through 2026-09-09 00:06:28 UTC. All belong to one ticket/run. Roles are inferred from storage paths; five supervisor-level files remain unclassified. Counts cover the entire selected files, including earlier messages in resumed sessions, not only messages within the modification-time interval. A copied/forked transcript can repeat historical usage, so these are recorded-event totals, not a reconciled bill.

| Path role | Files | Recorded input tokens | Output tokens | Cache-read tokens | User text characters |
| --- | ---: | ---: | ---: | ---: | ---: |
| Worker | 9 | 2,528,449 | 384,338 | 61,041,920 | 198,075 |
| Slice verification | 7 | 1,273,203 | 46,806 | 9,712,256 | 1,760,490 |
| Requirements | 2 | 234,947 | 9,585 | 751,360 | 472,093 |
| Commit | 7 | 9,418 | 1,093 | 3,072 | 15,806 |
| Other | 5 | 612,120 | 21,331 | 822,528 | 1,518,151 |
| Total | 30 | 4,658,137 | 463,153 | 72,331,136 | 3,964,615 |

Cache-write tokens were zero in this sample. User text counts exclude image blocks and tool arguments. There were 655 read, 254 grep, 13 find, and 15 ls calls. These are activity counts, not a finding that the reads were redundant. No prompt content, credentials, or private ticket text is included here.

The largest verification prompt contained 2,370 characters in its approved-design section, 568 in its worker-artifact section, and 600,008 in its diff section. This localizes the dominant volume to patch injection rather than assuming that design prose or model exploration caused it. The sample does not contain a separately identified final-review fixer, so it cannot quantify that path's cost.

Final validation: `node scripts/test.mjs` completed with 587 passed, 6 skipped, no failures (593 total). Localhost access was required for browser/HTTP tests. Syntax checks and `git diff --check` passed.
