---
name: open-pr
description: Open or find an existing GitHub pull request or GitLab merge request for a verified branch, using the repository's configured forge and preserving push, open, CI, and merge as separate authority boundaries. Use when asked to publish, raise, or open a PR or MR.
---

Read [the common workflow contract](../../shared/contract.md) and
[the common task record](../../shared/task-record.md). Follow the native Claude
supervisor binding; discussion skills do not expand tool permissions.

# Open a pull or merge request

With Agent Plan, first read [execution bindings](../../workflows/supervisor.md). Follow the
assigned role and available tools; skill instructions do not expand permissions.


Publish an already implemented and verified branch. This skill does not implement, approve, merge, enable auto-merge, or wait for CI.

## Authority boundaries

Treat these as distinct actions: commit, push, open PR/MR, wait for CI, approve, and merge. Perform only the actions the user or active delivery workflow authorized. Opening a request never implies merge authority.

## Select the forge

1. Read `.agent-plan/project.json`, falling back to `.runner/project.json` only when absent. Prefer `hosting.provider` (`github` or `gitlab`); legacy `forge` may be `github`, `gitlab`, or `auto`.
2. When absent or `auto`, inspect the configured push remote. Select GitHub or GitLab only when unambiguous.
3. If remotes disagree, the host is custom, or both clients are plausible, ask the owner. Persist an explicit `forge` value only when the owner asks or ambiguity would otherwise recur; preserve the rest of the JSON.
4. Use [the GitHub recipe](references/github.md) for `github` and [the GitLab recipe](references/gitlab.md) for `gitlab`.

Do not install clients, change authentication, rewrite remotes, or substitute a local merge when hosted publication is unavailable.

## Preconditions

- Identify the exact source branch, target branch, and candidate commit.
- Confirm the candidate is committed and the reported verification/evidence belongs to that commit.
- Summarize the user-visible change, verification results, risks, and evidence in a temporary or existing Markdown body file.
- Before creating anything, query open PRs/MRs for the same source branch and target. Return the existing URL when one exists instead of creating a duplicate.
- Push only when authorized. Open only when authorized.

After creation, report the URL, source and target branches, exact commit, and what remains (for example CI, review, approval, or merge). Stop there.

## Nonstandard delivery

For ordinary flows, call `gh` or `glab` directly; do not add a shared wrapper. Generate a small project-local script only when the repository repeatedly needs a nonstandard flow such as multiple remotes, a custom GitLab host, a generated body, or stacked branches. Keep it repository-specific, expose it as a named project command, validate its inputs, and document its authority boundary. Do not generate it speculatively.
