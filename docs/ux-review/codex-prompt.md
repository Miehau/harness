You are a senior product/UX partner. Read-only. Do not edit files. Do not implement. Critique only.

# Job

This is Agent Plan Workspace: a local dashboard for a senior software engineer operating multiple Pi coding agents. The operator wants control, visibility, and steering — not a pretty SaaS ticket app.

Operator answers already collected:
- Default mental model: **fleet command center** (see all agents; drill in when needed)
- Typical load: **2–4 tickets, several workers**
- Steering must be first-class: gate decisions, interrupt+redirect, edit plan/graph/prompt, live follow, diff/evidence review
- Start **debuggable**; later run more autonomously; still always see agentic decisions and artifacts
- Visual language: **IDE cockpit (VS Code)**, information-dense
- Do not ship UI changes yet. We are picking features from mockups.

# Current UI (source of truth)

- `public/index.html`, `public/app.js`, `public/styles.css`, `public/ui-model.js`
- Screenshots of the live app: `docs/evidence/01-named-status-plan-approval.png`, `docs/evidence/01-named-status-needs-attention.png`, `docs/evidence/04-e2e-recovery-interrupted.png`, `docs/evidence/05-codex-rename-profiles.png`

Current layout is ticket-centric: left work queue (setup chrome always visible: load fixture, free text, trackers), main ticket header + 6-stage workflow + checkpoint banner, execution graph, inspector with Overview/Evidence/Artifacts/Output.

# Mockups (same fleet scenario, three spatial languages)

Open and read these HTML files (also PNGs):

1. `docs/ux-review/mock-a-explorer.html` (+ `mock-a-explorer.png`)
   VS Code Explorer: activity bar, fleet tree (tickets as folders, workers as files), editor tabs per worker, Problems panel, steer composer, status bar. Workers are documents.

2. `docs/ux-review/mock-b-debugger.html` (+ `mock-b-debugger.png`)
   Debugger: Debug/Watch/Auto mode, Continue/Step gate/Stop, call stack of live agents, breakpoints = workflow gates, watch trace of tool+decision events, variables/artifacts, autonomy gradient in the toolbar.

3. `docs/ux-review/mock-c-matrix.html` (+ `mock-c-matrix.png`)
   Mission control: ticket × stage matrix as the fleet scan surface, selected cell is the debugger, agentic-decision stream (not tool spam), evidence+output, keyboard (j/k, a, s), Watch mode.

Shared scenario in all three:
- TEXT-7F2 verify failed (selected, needs you)
- APP-1901 running (session writing, tests blocked)
- APP-1842 plan approval (2 workers ready)
- LIN-88 review_ready (+12 −4)

# What I want from you

Write a blunt senior-dev critique:

1. Current UI: top 8 look-and-feel / information-architecture problems that hurt the operator job. Be specific to this product, not generic UX.

2. For each mock A/B/C: keep / drop / dangerous. Name concrete features, not vibes. Call out visual or density failures in the mockups themselves.

3. Merged v1: the smallest set of features to steal that serve fleet + debug-now / auto-later. What is the primary object (ticket vs worker vs gate vs cell)? What is the one default view?

4. Rank the three mockups for this user. Say what you would not ship.

5. Missing from all three: things a senior agent operator still cannot do (prompt inspect, graph edit, parallel workers, empty states, keyboard, setup chrome, etc.).

Keep it tight. No implementation. No file edits.
