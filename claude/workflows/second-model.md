# Mixed-model architecture and review

This is the native Claude binding's architecture roster and review routing. It
supersedes the generic three-seat default and self-judging fallback in architect
and arena. Claude runs only inside Claude Code; Codex runs through the separately
installed [official Codex plugin](https://github.com/openai/codex-plugin-cc).
The ticket coordinator owns every proposal, judge and review job and its evidence.
The supervisor discusses the resulting recommendation and records the user's choice.
Implementation remains with native Claude workers.

## Plugin and job ownership

Read the installed plugin's command/helper instructions and verify the required
capabilities before dispatch. Resolve its absolute plugin root separately from
Agent Plan's `CLAUDE_PLUGIN_ROOT`. Do not copy its scripts or build another bridge.
Missing plugin, authentication or supported controls block the affected stage;
do not install, change credentials, switch providers or silently omit a Codex seat.

The coordinator may call the plugin's `scripts/codex-companion.mjs` through native
Bash. Its `task` operation supports explicit `--cwd`, `--prompt-file`, `--fresh`,
`--background` and `--json`. Omit `--write`: every Codex assignment here is research
or review only. Leave model/effort at runtime defaults unless explicitly selected.
For example, after resolving and quoting absolute paths:

```sh
node "$codex_plugin_root/scripts/codex-companion.mjs" task --cwd "$worktree" --prompt-file "$assignment" --fresh --background --json
```

The prompt explicitly forbids edits, implementation, commits and delegation, and
requests the full report as output; the coordinator saves it outside source trees.
This uses a custom read-only task because ordinary `/codex:review` does not accept
our role-specific brief. Never resume a proposer as judge or reuse an earlier review.
Do not invoke `/codex:transfer`, enable a Stop-hook review gate or launch Claude in OMP.

Save dispatch intent, assignment path/version, role, full base/candidate SHA,
worktree, returned job ID and session ID when available in state.md. Read status,
result and cancellation through the plugin using that exact ID and `--cwd`; never
select the latest job implicitly. Use supported bounded waits/completion handling,
not a shell or model polling loop. An uncertain dispatch must be reconciled before
retrying; unknown shutdown blocks replacement.

## Architecture: independent worktrees, then a fresh Codex judge

1. Record two Claude proposal seats plus one Codex proposal seat by default. Use
   three Claude seats plus one Codex seat for broad changes needing another
   independent investigation; record why. Honor an explicit owner roster. Freeze
   identical brief, grounding, rubric and full committed base for all seats.
2. The coordinator creates distinct, ticket-owned detached worktrees at that exact
   base using ordinary `git worktree add --detach PATH BASE_SHA`. Record paths and
   verify HEAD/status before dispatch. Give each read-only Claude researcher its
   absolute worktree root and require all source reads there. Give the Codex task
   its own worktree via `--cwd`. These retained research worktrees avoid native
   auto-cleanup before judging. Never reset/reuse user work or remove them mid-round.
3. Launch the Claude researchers and background Codex proposer independently,
   respecting capacity by batching if necessary. No author sees other proposals or
   receives evaluative steering until all reports are submitted. All seats return:
   what they actually inspected/did, file-level evidence and learnings, proposed
   design and sketches, explicit pros and cons, alternatives rejected, assumptions,
   unresolved risks and suggested validation. Distinguish inspected evidence from
   unrun checks; proposal work does not authorize prototypes or source edits.
4. Save every full report to a separate versioned artifact outside the worktrees.
   Verify each worktree still matches the frozen base. Require every seat to finish
   or produce an evidence-backed failure; missing reports block a complete comparison.
   Preserve failures and return the coverage gap rather than inventing a proposal.
5. Once all proposals settle, launch a **fresh Codex judge task** with the frozen
   rubric, every full report and the retained worktree paths. It independently
   inspects the cited code/learnings, scores each approach, compares pros and cons,
   and recommends **one named proposal** with reasons and any clearly identified
   improvements borrowed from the others. Label candidates neutrally. It must not
   inherit the Codex proposer's session or privilege that proposal. If no approach
   satisfies the constraints, report that blocker instead of forcing a winner.
6. Save the full Codex judgment and send it, all proposals and evidence references
   to the supervisor. Surface Codex's recommended approach, its rationale, tradeoffs
   and remaining questions to the user. The supervisor may flag factual problems
   but must not silently replace Codex's recommendation with its own selection.
   No Claude self-judging fallback. The user's choice and implementation authorization
   are recorded separately; the recommendation itself never releases writers.

## Review: Claude plus background Codex

After integration and verification, freeze the clean candidate's full SHA and base.
Launch one fresh native Claude reviewer for `requirements` (requirements/AC) and one
fresh background Codex task for `correctness` (correctness/code-quality) concurrently.
Use the same candidate checkout, full SHA, diff, brief/criteria and check evidence;
pass the Codex task its exact checkout with `--cwd`. Add native Claude specialists
for declared risks. The two mandatory roles stay independent through first reports.

Both reviewers return role, full candidate SHA, inspected scope, evidence, severity,
actionable findings and limitations. Codex also checks regressions and maintainability;
Claude maps acceptance criteria to actual behavior and evidence. The coordinator
saves each report as `review-ROLE-SHA-vN.md`. An empty result or a claimed pass with
missing coverage is not a clean review. Do not mark ready while Codex is running.

Recheck HEAD and working-tree status after both reports; drift invalidates review.
Major/medium findings block delivery. Delegate repairs to native implementers, then
integrate, verify and rerun **both Claude and Codex** plus required specialists on
the new candidate, even if one previously passed. No reviewer grants merge approval.

## Stop and recovery

Before returning a question, blocker or candidate, settle native children and Codex
jobs. On pause/cancel, cancel each recorded Codex job through the plugin and confirm
its terminal state; TaskStop on Claude alone is insufficient. Preserve uncertain
jobs, dirty worktrees, reports and IDs for recovery. After interruption, reconcile
actual job status and Git state before relaunching or archiving. Remove only owned
worktrees when cleanup is authorized and all users of those paths have stopped.
These are workflow instructions, not deterministic runtime gates; live mixed-model
execution still requires a smoke test.
