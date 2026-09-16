# Native Claude handoff

The earlier MCP/runtime adapter was the wrong architecture and has been removed.
This replacement consists only of Claude-native skills, subagent definitions,
workflows and hook JSON. The Pi runtime no longer imports anything from `claude/`.
There is no launcher or external agent-control tool to run.

Read [README.md](README.md) for the one-time local plugin installation. Afterwards
launch plain `claude` in a repository and use `/agent-plan:start <description>`.
Repository paths are inferred; the package can be installed without its parent repo.

## Offline checks

From the parent repository:

```sh
node --test test/claude.test.js
npm test
npm run check
claude plugin validate ./claude
```

No live model is called by these checks. Package tests verify self-containment,
resource references, native-only agent tools and the shell-builtin hook. They do
not prove a model will follow the workflow or that prompt-hook judgments are correct.
The removed adapter's 69-test run and real MCP connection are not evidence for this
new architecture. No subscription is needed for today's offline review.

The standalone folder was copied outside this repository and successfully validated,
added as a local marketplace, installed and listed as enabled by Claude Code 2.1.117
using a disposable `CLAUDE_CONFIG_DIR`. The plugin manifest also passed validation.
That isolated installation check covered version 0.2.0. The 0.3.0 hierarchy change
passed manifest validation and `claude --plugin-dir ./claude agents` lists all four
plugin agent definitions, including coordinator. No model was invoked. This verifies packaging
and installation, not live skill/subagent behavior.

## Hierarchy correction

The main conversation is now only the supervisor. `agents/coordinator.md` owns one
isolated ticket and receives the native Agent tool to spawn research, implementation
and review workers. Leaves cannot delegate. Start/onboard dispatch a coordinator;
watch, checkpoint, recovery and acceptance preserve that ownership. The coordinator
settles children before returning a question or result. User decisions route through
the supervisor and back to the exact coordinator.

This needs Claude Code 2.1.219+ with effective spawn depth >=2. Current docs describe
nested subagents; the development CLI 2.1.117 predates the supported baseline. Its
package validation does not establish nested execution support. No automatic
upgrade/settings mutation or supervisor-to-worker fallback is implemented.

## First real session

1. Update to a nesting-capable Claude version, check effective spawn depth, install/enable
   the plugin, then start plain Claude in a clean disposable Git repo
   with a committed base and a meaningful test command. Confirm the eight skills and
   four agent types load. No custom MCP server should appear.
2. Start two small independent tickets. Confirm the supervisor spawns one isolated
   coordinator per ticket, and each coordinator has Agent and spawns its own workers.
   Confirm the original checkout stays unchanged during ticket execution. Confirm discovery, architecture,
   planning and clarification precede native implementation. Check that each writer
   is in a distinct worktree at the supplied full base commit. A default-branch
   worktree must be corrected before editing; do not weaken this to make it run.
3. Confirm worker results reach their coordinator, and ticket results reach the
   supervisor. Try a product question: the coordinator checkpoints and returns
   needs-input, the supervisor asks, then resumes the same coordinator with the answer.
   Check that no duplicate coordinator/worker is created.
4. Confirm combined verification, separate read-only review and a candidate handoff.
   The prompt Stop hook is a completeness reminder, not a proof checker.
5. Checkpoint, compact or reopen, then recover the supervisor-to-coordinator-to-worker
   mapping from notes/Git. Do not expect old native
   IDs to resume across sessions without checking the installed client's behavior.
6. Publish a PR/MR and evidence, then approve its exact candidate for hosted merge.
   Advance the remote target first in a separate trial:
   a rewritten candidate must get fresh verification, review and human acceptance.
7. Pause a ticket and confirm its coordinator settles children before returning; test conflicts and permission denial.
   Do not silently switch to external processes if a native feature is unavailable.
8. Start two related tickets (for example, reset-token expiry and email verification).
   Confirm each publishes scope before writing; overlap must cover shared behavior
   even in different files. Verify both coordinators acknowledge the same proposal
   version, designate the shared-definition owner and sequence dependent work.
   Change one scope mid-task: affected workers must pause and acknowledgments must
   be renewed. A silent peer, stale reply or sent message must not release writers.

Native agent/worktree behavior is version-sensitive. The installed CLI at development
time was 2.1.117; current official documentation describes newer behavior too. The
workflow verifies actual nesting capability and base/paths. Missing native Agent
or isolation is a compatibility blocker; it must never flatten the hierarchy.

## Active-log communication check

Version 0.4.0 adds a shared active.md and native SendMessage to coordinators, replacing
the unsupported assumption that subagents have TaskOutput. Verify two coordinators
can look up their exact peer IDs, exchange proposals and acknowledgments, and send
scope/status updates to the supervisor as the log's single writer. Change a peer's
scope and confirm the row and agreement references update. Test a stale ID and a
second supervisor: neither may overwrite the log or treat old state as live.
Check a peer that ends during messaging: any redirected result must reach its original
supervisor and must not transfer ticket ownership or restart workers. No live message
exchange has been verified without working model access.

## Edit here

Version 0.4.1 adds supervisor-owned archive.md. Check candidate-ready archives remove
the coordinator's live row but retain Pending acceptance and overlap discovery.
Acceptance/cancellation should append the actual final outcome and retire that row.
Paused/blocked/unknown subtrees must remain active. Interrupt between archive write
and active-row removal, then reconcile without losing history or duplicating entries.
Request changes to an archived candidate: reactivate before resume and preserve
artifact paths. These native model-driven lifecycle behaviors still need live checks.

- [Supervisor](workflows/supervisor.md): intake, coordinator dispatch, user decisions and ticket results.
- [Task workflow](workflows/task.md): coordinator-owned notes, worker dispatch, integration and review.
- [Active log](workflows/active-log.md): shared directory, single-writer updates and native peer messaging.
- [Archival](workflows/archive.md): retire finished coordinators, preserve evidence and reopen candidates.
- [Alignment](workflows/alignment.md): scope publication, overlap proposals, mutual acknowledgments and rechecks.
- [Delivery](workflows/delivery.md): PR/MR publication, evidence, CI, exact approval and hosted merge.
- [Recovery](workflows/recovery.md): checkpoints, interrupted operations and stop.
- `agents/`: coordinator plus leaf researcher, implementer and reviewer definitions.
- `skills/`: user-facing commands; `hooks/hooks.json`: native hooks only.

The old disposable smoke runtime was stopped before the redesign. Old state under
`~/.local/state/agent-plan-claude` is not used or migrated by this plugin.

## Hosted delivery smoke checks (0.5.0)

Use disposable GitHub and GitLab test repositories with authenticated host clients.
Verify one PR/MR is created and reused, its head and evidence links match the final
reviewed commit, and CI failures return to coordinator-owned repairs. Check missing
authentication, unavailable artifact publication, pending/failed CI and missing host
approvals block delivery. Change the head after user approval: the SHA guard must
reject merge and require fresh verification/review/approval. Interrupt after create
and after merge; recovery must inspect the host before retrying. A queued merge must
remain pending, cancellation must cancel the host queue, and only confirmed merged
status may archive accepted. Confirm the original checkout stays unchanged.

These are manual live checks, not completed tests. Package/reference checks do not
validate host authentication, actual uploads, CI or model adherence to instructions.
