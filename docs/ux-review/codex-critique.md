## Current UI: top 8 problems

1. **It makes intake the permanent primary task.** “Load fixture,” free text, trackers, and queue setup dominate the left rail even while work is live. Fleet state should own that space.

2. **It is ticket-first when the operator is worker/gate-first.** A stalled worker is buried inside a selected ticket; there is no fleet-wide “this is the next human decision” surface.

3. **The six-stage rail is progress theatre.** It consumes the header but cannot explain parallel work, waits, retries, or dependencies—the things the operator actually needs to manage.

4. **Needs-attention is visually detached from its cause.** The current stalled-state screen says “correction stalled,” then shows an empty graph and empty artifact card. It should open directly on the failed worker, exact invariant, evidence, and permitted next action.

5. **The execution graph is too late and too local.** It is useful after drilling into a ticket, but there is no fleet-level view of which graph nodes are blocked, ready, or competing for slots.

6. **The queue mixes unrelated concepts.** Intake sources, queued tickets, selected tickets, active capacity, and retained worktrees share one rail. That makes operational priority hard to scan.

7. **Evidence is present but not command-oriented.** Diff, output, prompt, artifacts, reviews, and recovery exist as inspector material, but the operator must navigate to assemble “what happened, is it safe, what do I do?”

8. **Autonomy is hidden rather than operated.** “Auto run graph” is a plan-gate button; project mode and capacity hide in setup. Debug/Watch/Auto and stop conditions need to be visible runtime policy.

## Mock A — Explorer

**Keep**

- Fleet tree grouped by “Needs you” and “Running.”
- Ticket → worker nesting as a compact secondary navigation pattern.
- Global Problems list with direct actions.
- Canonical diff beside the latest decision.
- Persistent steer composer and interrupt + redirect.

**Drop**

- Fake VS Code activity bar, menu bar, and document tabs.
- File-ish tabs for workers (`session.ts`, `rebase`, `diff`): they imply code navigation, not operational state.
- Status-bar token trivia as a primary visual element.

**Dangerous**

- “Workers are documents” is the wrong model. A worker is an execution attempt with a gate, dependency, worktree, and evidence—not a file you open.
- The selected-editor model collapses under several active workers and makes gates look like incidental Problems.
- The central diff is oversized for four changed lines while the operator’s pending decisions are compressed below the fold.

## Mock B — Debugger

**Keep**

- Explicit `Debug / Watch / Auto` mode.
- Break-on policy as a real autonomy control.
- Selected-worker focus with retry, evidence, diff, prompt, artifacts, graph, and redirect.
- Worker state: attempt, budget, permission, last tool, idle time.
- Clear distinction between “Continue” and “Step gate.”

**Drop**

- “Call stack” terminology. These are live workers, not stack frames.
- `Pause fleet` and generic `Stop`: their scope is too dangerous and unclear.
- The central trace’s raw tool-event emphasis.

**Dangerous**

- `Skip gate` and an unqualified `Continue` invite accidental bypasses.
- Global breakpoints need precise semantics and per-ticket exceptions before they become controls.
- It is an excellent drill-in, but a poor default: the fleet is reduced to a narrow list.

## Mock C — Mission control

**Keep**

- Ticket × stage matrix as the fleet scan surface.
- Selected cell becoming the debugger.
- Agentic decision stream, separate from tool spam.
- Watch mode, command jump, slot count, “needs you” count.
- Evidence and last output visible together.
- The `j/k`, inspect, steer model—once it is real and accessible.

**Drop**

- `Accept anyway`.
- Bare dots for every future stage; they add grid noise.
- `g graph json` as a casual keyboard action.

**Dangerous**

- A cell cannot be assumed to equal one worker: a stage can have fan-out, blocked children, or multiple reviewable batches.
- The matrix does not replace the execution graph; it is a summary of it.
- At this density, the 210px matrix header becomes expensive with more tickets, longer titles, or several active workers.

## Merged v1

Make the **ticket × stage cell** the primary scan object. It represents the actionable state for that ticket/stage; it may summarize one or more workers. The **worker or gate** is the action target after selection.

Default view: **Watch mission control**.

- Compact matrix across the top: 2–4 tickets, six stages, with only meaningful labels: active worker, blocker, approval, review, failure.
- Selecting a cell opens the B-style debugger below: decision, failed invariant, canonical diff/log, artifacts, prompt, budget, worktree/preview, and redirect/retry/restart controls.
- One visible execution mode: `Debug`, `Watch`, `Auto`, with explicit stop conditions.
- A compact fleet “needs you” queue, not permanent tracker/setup chrome.
- Keep the current graph editor, profile controls, tracker intake, recovery audit, and retained-artifact tooling—but move them behind setup/command navigation, not the default operational surface.

Steal A’s fleet tree only as an alternate navigation pane, not as the product model.

## Rank

1. **C** — best default mental model for 2–4 tickets and several workers.
2. **B** — best selected-cell inspector; not the default shell.
3. **A** — useful visual vocabulary, wrong primary metaphor.

I would not ship A as the main UI, B as the main UI, `Accept anyway`, unscoped fleet stop controls, or faux IDE chrome that consumes room without operating the fleet.

## Missing from all three

- Real prompt inspection: rendered prompt, effective instruction stack, attempt-to-attempt prompt diff, and safe edit scope.
- Real graph editing: dependencies, roles, scope, acceptance criteria, verification, validation errors, and impact preview.
- Parallel-worker control: fan-out, dependency/wait reason, slot allocation, worker ownership, and cross-ticket contention.
- Recovery: interrupted-state checkpoint, preview/port health, resume vs restart impact, retained evidence, and audit trail.
- Review/delivery operation: inline review notes, correction requests, PR/MR and CI state, merge queue conflicts.
- Proper empty, setup, intake, tracker, repository, profile, and credential states. Every mock assumes a populated fleet.
- Keyboard accessibility beyond C’s printed cheat sheet: focus model, discoverability, confirmations, and safe destructive shortcuts.
- Historical comparison: previous attempts, repeated-failure detection, and whether a retry made meaningful progress.