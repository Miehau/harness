## Current main pane

- It repeats the rail: title/description, usage chips, and the six-stage header consume the first screen without helping decide or steer.
- The actual blocker is fragmented: error banner, graph highlight, then “Overview” prose. In the empty-graph failure state, the operator gets a large blank panel plus empty artifacts instead of failure → evidence → recovery.
- “Overview” is narration, not an operating surface. Activity, raw output, diff, prompt, and artifacts are tab-gated precisely when diagnosis needs them together.
- The graph is valuable for multi-agent dependencies, but it gets 60% of the body even when one blocked worker is the only relevant thing.
- Recovery is too ticket-level and indirect. “Resume,” “restart,” worker retry, last command, attempt count, and worktree need to resolve into one clear next action.

## A — command cockpit

**Keep:** compact ticket header, finding before actions, activity beside canonical diff, compact worker summary.

**Drop:** graph behind `g` as the normal model. This is a multi-agent ticket tool; hiding dependencies turns recovery into guesswork.

**Dangerous:** one flat row makes Retry / Restart / Cancel look equivalent and underspecifies scope. No prompt inspection or graph editing route. Good emergency/debug view, weak default.

## B — graph as map

**Keep:** graph remains ticket-level, compact header, inspector defaults to activity/evidence rather than Overview prose.

**Drop:** the “graph” shown. It is a vertical list with statuses, not a graph: no dependency edges, stages, parallelism, or blocked downstream consequence. Don’t call it a map until it earns the name.

**Dangerous:** it creates a second rail that costs 42% of the pane while conveying less than the existing graph. Keep the real execution graph, but make it denser and select-driven.

## C — selected worker

**Keep:** worker-focused diagnosis, decision stream, evidence adjacent to it, worker metadata, and steering as a first-class action.

**Drop:** worker-as-document as the universal default. It loses ticket context and hides sibling/dependency state exactly when multiple agents matter.

**Dangerous:** “Interrupt + redirect” should not be the default steer action. Most steering should send guidance without throwing away useful progress. A permanently expanded textarea also burns space and risks stale drafts.

## Merged v1

Steal B’s ticket map, A’s compact command header, and C’s worker-focused inspector—but only when a worker is selected.

- **Needs you:** compact `ID · title · status`, one concise finding with attempt/last command, scoped actions (`Retry`, `Steer`, `Open worktree`, recovery menu). Below: real execution map on the left; selected blocked worker’s activity and evidence/diff on the right. Put a compact steer composer under that inspector, focused with `s`.
- **Running:** same map and selected-worker inspector. Header shows active-worker count and heartbeat, not description/chips. Default right view is live activity; show diff only once there is a meaningful diff.
- **Plan gate:** replace the worker inspector with the proposed execution graph and one clear gate panel: `Edit graph`, `Run manually`, `Auto run`. No six-stage strip. The plan is the object here.
- **Empty/setup:** show the current stage and next prerequisite, not “No graph yet” plus empty persisted artifacts.

The execution graph lives in the main pane by default: compact ticket map during execution, full-width plan map at approval. `g` can focus/expand it; it should not be the only way to see it.

## Rank

1. **B direction**, after replacing the fake graph with the real dependency map.
2. **C as a conditional needs-you worker view**, not a whole-app layout.
3. **A as an optional command/debug view**, not default.

I would not ship any mock unchanged—especially B’s flat “graph,” A’s hidden graph, or C as the universal default.

## Missing main-pane essentials

- **Steer:** non-interrupting “Send steer” plus explicit “Interrupt and redirect”; preserve a draft per worker.
- **Prompt inspect:** top-level `p` drawer/panel, not a buried auxiliary tab.
- **Graph edit:** only at the plan gate; don’t allow arbitrary live-graph surgery during recovery.
- **Recovery:** show failure, failed command, attempt `n/8`, selected worktree, and the scoped recovery choices together.
- **Keyboard:** `g` focus map, `s` steer, `p` prompt, `o` worktree, arrows/Enter to select workers; Esc closes the focused panel.