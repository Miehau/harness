# End-to-end lifecycle

[Map](../feature-map.md)

**Load when:** investigating a transition spanning several features or orienting to the complete ticket journey. For a local bug, start with its feature leaf instead.


1. Select a repository; connect Linear/Jira or create a free-text task. A local fixture can instead enter directly at plan approval.
2. Pi shapes requirements without repository tools. Human approval unlocks an isolated worktree, code exploration and ticket look-ahead.
3. Pi designs a graph; the operator edits and approves it. Verification-contract bootstrap is inserted when necessary. Profiles, workflow checkpoints, and technical questions can add gates.
4. Dependency-ready steps execute through Pi workers and supervisor review. Git can isolate parallel siblings; default Jujutsu execution serializes them. Required predecessors must be accepted before downstream work runs.
5. Each step retains attempts, reports, checks, exact diffs, and evidence. Manual mode waits for acceptance; automatic execution can accept passing steps. Corrections stop for repeated findings, an attempt ceiling, uncertainty, or explicit workflow gates.
6. Combined verification and independent review produce a criterion-linked final proof packet. Human proof approval is required even in automatic mode; requested changes return to correction.
7. Tracker-backed delivery uses a PR/MR and remote gates; local-source delivery uses local integration. Both keep evidence and worktrees for later inspection. No direct deployment feature exists.
8. Restarted in-flight work is interrupted and requires explicit resume. Cleanup is explicit and restricted to run-owned resources.


Feature ownership and next-hop links live in the [entry map](../feature-map.md). Snapshot: 2026-09-06; re-check current source.
