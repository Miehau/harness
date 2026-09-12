# Linear ticket review — 12 September 2026

Reviewed against `origin/main` at `54bcc91`. This delivery covers the recent September 7–10 batch.

| Ticket | Assessment and disposition |
| --- | --- |
| MEA-56 | Still valid. Both forge adapters now require the inspected head SHA. A 409 merge rejection returns to status, CI and review inspection. The multi-repository daemon regression exercises a new head with pending checks before a successful retry. |
| MEA-57 | Partly fixed already: PR/MR identity was durable before tracker writeback. The missing retry is now fixed: restart/resume retries the link post using the same remote identity. The daemon regression includes tracker outage, restart, single creation and successful writeback. |
| MEA-58 | CLI `revise` and `revise-proof` already accept repeated `--criterion` flags, with existing payload tests. Active dashboard correction forms already submit selected criterion IDs. The old queued diff-note panel is no longer called by the current dashboard (`stepDiffPanel` has no callers); restoring that retired interface would be new product scope. No additional client change is needed for current flows. |
| MEA-59 | Already fixed. Dismiss buttons have explicit `type="button"` and close handlers; Cancel closes the plan dialog. Existing real-browser regressions exercise dismissal with invalid fields, unsaved workspace input, and explicit submission. |
| MEA-60 | Still valid. Generated and edited ingestion now share cycle, self-dependency and unknown-ID checks, preserving group barriers. An unfinished graph without active execution or a legitimate gate produces an actionable attention checkpoint. |
| MEA-61 | Still valid. GitHub inline comments require a leading, case-insensitive `fix:` marker. File/line/comment identity is retained. Blocking reviews prevent merge even with an empty review body. GitLab feedback is unchanged. |
| MEA-62 | Still valid. Source discovery now includes compound command comparisons and deduplicates aliases. Navigation exposes `list`, `backlog` and `timeline`; the dated caveat is corrected. |
| MEA-64 | Still valid. Successful remote completion schedules durable, resumable cleanup of run-owned local resources. Evidence survives approval, partial failure and unmerged work. Run metadata and remote links remain. `AGENT_PLAN_KEEP_MERGED_RUNS=1` retains new completions for debugging. CLI retention commands use the dashboard API. Existing historical completions are not retroactively selected. |

## Older initiatives (September 3)

These remain separate backlog work, outside the recent batch:

- **MEA-50 — Independent reviewer:** much of the original gap is already covered by fresh reviewer roles, read-only tools, persisted review artifacts, criterion proof, and tree-bound stale-proof rejection. The ticket should be narrowed to the remaining exact commit identity and risk-policy requirements before adding another review mechanism.
- **MEA-53 — Terminal finalization and dead-run reconciliation:** still relevant as a larger lifecycle change. Existing ownership-aware process cleanup, restart interruption and runtime capacity cleanup are foundations; they do not implement the requested repeated dead-observation/grace contract. It should not infer worker death merely from an idle Pi session or an empty child-process list.
- **MEA-54 — Unread advisories:** still a real dashboard feature gap, dependent on MEA-53's durable transition identity. Existing run history and cleanup advisories do not provide unread acknowledgement semantics. No notifier or second coordinator is needed.

## Verification

Full repository suite: 691 passed, 6 skipped, no failures. Syntax checks passed. A subsequent focused retention regression verifies retry after an already-removed coordination worktree (5 retention tests passed). Tests use mock models and forge/tracker adapters; browser tests use isolated local servers.
