# OMP migration and hosted delivery

The runner uses pinned OMP 18.3.2 and Bun >=1.3.14. `install.sh` checks prerequisites;
Node still runs the durable coordinator service. Managed transcripts carry an adjacent
backend marker. Unmarked Pi transcripts are retained and rejected rather than silently
resumed as OMP. Finish old tasks on the old checkout or inspect their work and start a
new task with an explicit recovery brief. A supervisor's ordinary `--continue` uses
OMP's separate profile; do not pass a Pi transcript to OMP manually.

## Project choices

`agent-plan onboard REPO` discovers hosted remotes when possible; ambiguous/self-hosted
providers need `agent-plan hosting REPO --hosting-provider github|gitlab`. Flags
`--hosting-host`, `--hosting-project`, `--hosting-remote`, and `--hosting-target` override
discovery. Choices are saved in `.runner/project.json` and snapshotted for each task:

```json
{
  "hosting": {
    "provider": "github",
    "host": "github.com",
    "project": "owner/repo",
    "remote": "origin",
    "target": "main"
  },
  "commands": {
    "test": ["npm", "test"],
    "preview": ["npm", "run", "dev", "--", "--host", "127.0.0.1"]
  },
  "verify": ["test"],
  "preview": {"command": "preview", "url": "http://127.0.0.1:5173"}
}
```

Edit this file to switch future tasks to GitLab. Existing task destinations never
change implicitly. Missing hosting preserves local-only delivery. Configure `gh` or
`glab` credentials on the host; credentials are not stored in project JSON. The push
remote must match the configured host/project; multiple push URLs are rejected.

## Publication, evidence and approval

After all workers finish, verification passes and all required reviewer roles pass,
the coordinator's completed report pushes the candidate and creates/updates one PR/MR.
Its description contains the brief, clarification, handoff mapping AC to evidence and
links to saved reports. Both providers store evidence on immutable branches named
`runner-evidence/TASK/CANDIDATE_SHA/EVIDENCE_COMMIT`; a revised handoff for the same
product commit creates another evidence revision without rewriting earlier proof.
Links name the evidence commit directly and preserve repository access controls.
GitLab image uploads are public by URL by default even in private projects, so the
runner does not use native uploads ([GitLab access-control documentation](https://docs.gitlab.com/security/user_file_uploads/#access-control-for-uploaded-files)). Publication
includes the brief, final verification JSON, every referenced command result and
output log, and the current UI manifest with all its media. Captures are current
evidence only when explicitly bound to this candidate; unbound or old captures are
retained locally without being silently presented as proof of the latest revision.
Missing referenced proof stops publication. Evidence retains repository/provider
access controls.

Publication does not approve merge. `agent-plan hosted-status TASK` reads current CI,
head and mergeability. The service checks published requests periodically and reports
failed CI. `agent-plan accept TASK SHA` is a human approval command; supervisor acceptance
shows a dialog first. The remote head, local verified candidate and approved SHA must
match. Required reviews, no pending decisions, a clean worktree, successful reported CI
and provider merge requirements are checked again. Projects with no CI may merge only
when the provider explicitly reports them mergeable. Merge queues are not auto-enabled.

The provider receives an exact SHA precondition. Unknown or rejected outcomes retain
an operation for inspection; no blind merge retry occurs. A manual provider merge is
observed by status refresh. Worktrees remain until explicit cleanup.

## Revision and recovery

Send `agent-plan feedback TASK FILE` to an open hosted candidate to reopen the same
coordinator/task, preserving the PR/MR and invalidating verification and approval.
The next candidate requires every reviewer again. Publication updates the same request;
ordinary pushes reject rewritten remote history rather than force-pushing.

An interrupted publication or merge must first be inspected with `hosted-status`.
Creation reconciliation requires the expected head, target and description. An uncertain
upload or push remains visible; after inspecting remote effects, owner recovery may mark
publication aborted and retry explicitly. Evidence revisions are immutable; retrying
the same evidence content targets the same revision. A merge is never marked aborted
just because a read failed.

## Worktree preview

`agent-plan open TASK` focuses the coordinator. `agent-plan preview TASK` launches the
saved named command in the retained integration worktree and returns its URL and log;
readiness is explicitly unverified until the application is inspected. Stop with
`agent-plan preview TASK --stop`. Configure distinct ports when previewing multiple tasks.
After a daemon restart, preview process ownership is uncertain: inspect/stop it manually
rather than risk signalling a reused PID. Cleanup stops a known preview before removing
clean worktrees; dirty or uncertain work is retained.

## Trust and verification limits

Execution is trusted local, including normal OMP tools. Worktrees and approval dialogs
are not an OS security boundary. An OMP sandbox wrapper has not been installed. Existing
container/sandbox integrations can be evaluated later without changing task identities.

Mocked tests cover both providers and durable runtime boundaries; `npm run probe` makes
no model calls. Actual model-driven delivery, live provider uploads/merges and GrokBot
rendering/replies require separate recorded canaries against authorized test destinations.
Do not describe mock coverage as proof of those external integrations.
