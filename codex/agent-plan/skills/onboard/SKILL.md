---
name: onboard
description: Configure a repository for native Codex Agent Plan tasks, verification, role routing and GitHub or GitLab delivery.
---

Read [the native binding](../../native.md), [the workflow contract](../../shared/contract.md)
and [the task record](../../shared/task-record.md).

Inspect repository instructions, existing configuration, check commands, remotes and
available native tools. Preserve existing values; ask only for missing consequential
choices. Save `.agent-plan/project.json` with `execution` mode `native`, runtime
`codex`, trusted command argv arrays, required verification, task bounds and optional
`agents` role runtime/model/provider choices supported by this session. Explicitly
reject unsupported delegation; no automatic cross-runtime agents or token bridge.

Discover hosting from remotes, then confirm GitHub or GitLab host, remote and target,
provider CI/branch gates and publication intent; allow explicit local-only delivery.
Use installed provider credentials without copying secrets. Put private machine
settings in optional `.agent-plan/local.json`; ensure `.agent-plan/local.json` and
`.agent-plan/tasks/` are ignored before writing either. Choose the original checkout
absolute task-state pointer and Git common-dir identity for all worktrees. Validate
configuration and command availability without running paid model calls or publishing.
Report saved settings and unavailable required capabilities.
