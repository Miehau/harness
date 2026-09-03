The rail currently behaves like setup plus a tracker list. This operator needs a fleet triage surface.

## 1. Current UI: top problems

- Intake dominates the rail before any work is visible. “Load fixture,” free text, trackers, batch start, and clear queue consume the attention budget meant for blocked/running tickets.
- Grouping is by source/tracker bucket (`Local runs`, `In progress`, `Todo`, `Backlog`), not operational urgency. A failed verification can sit below less important work.
- A ticket card says it has a run, but not what is happening: no current stage, failing worker, last finding, idle age, or agent count. The thin completion bar is progress without diagnosis.
- “Start selected” and checkboxes make the rail feel like a ticket-admin app. Running a ticket is a command; fleet status is the rail’s job.
- There is no ticket→agent relationship in the rail. For a multi-agent ticket, the operator cannot see whether one worker failed while another is simply blocked.
- The empty graph in the needs-attention state makes the page look blank precisely when the operator needs a concise recovery reason.

## 2. Mock critique

| Mock | Keep | Drop | Dangerous |
|---|---|---|---|
| **A** | Urgency groups; ticket as parent; selected/attention ticket exposes agents; stage micro-bar; last finding on ticket. | Decorative card padding and duplicate status phrasing. | Auto-expanding every attention ticket can turn the rail into a long incident log. Expand the failing agent, not every sibling. |
| **B** | Parent/child semantics and keyboard-friendly rows. | Fixed columns in a narrow rail; title/action truncation; unlabeled tiny meters. | It reads like process monitoring, not ticket control. Ticket and agent states blur, and the columns collapse under real titles. |
| **C** | Six-stage cells as a compact location signal; visible parallel-worker summary. | Full per-agent telemetry on every ticket. | Too tall and too encoded. `arch`, `skel`, colored cells, and tiny bars require decoding; three tickets already consume the rail. |

## 3. Merged side-panel v1

Start with **A**, borrowing only C’s compact stage cells.

Rail header: `Tickets` + `3 needs you` + `1 / 4 slots` + search. Put intake behind `n` / a New task dialog; put tracker setup in settings or that dialog.

Groups, in order: **Needs you**, **Running**, **Idle / queued**.

Each ticket row should show:

- Severity/state dot, ticket ID, short explicit state: `VERIFY FAILED`, `PLAN GATE`, `RUNNING`
- Title
- Six compact stage cells, with the current/failed cell unmistakable
- One operational line: `rebase failed: port still bound · 9s idle` or `2 workers active · 1 blocked`
- A narrow activity/progress bar only for active work

Nested agents appear for the selected ticket. For a ticket in **Needs you**, reveal just the failing or decision-blocked agent by default; expose siblings on expand. Running tickets show an agent count/summary until selected.

## 4. Rank

1. **A** — ship this direction.
2. **C** — useful source material, not a default layout.
3. **B** — do not ship as the primary rail. It spends scarce width on columns and obscures the actual decision.

## 5. Rail-specific missing pieces

- **Steering:** selected ticket/agent needs a clear `s` command that opens a scoped steer prompt; do not put a button on every row.
- **Inspect:** agent children need a quick prompt/activity entry point (`p`), not permanently visible prompt text.
- **Keyboard:** `j/k` move tickets, `Enter` inspect, `Tab` expand agents, `n` new task, `s` steer, `/` filter. Never intercept typing in inputs/dialogs.
- **Empty/setup:** show one calm empty rail state: `No tickets — n new task · configure trackers`. Do not restore intake chrome.
- **Recovery:** interrupted runs belong in **Needs you** with the cause and a concrete `resume`/`restart from…` affordance; “needs attention” alone is not actionable.

No implementation changes made.