# Feature map — read selectively

Agent Plan is a local Pi-only ticket execution daemon. **This file routes you to the smallest relevant context. Do not read every linked file.**

## Read protocol

1. Match the task to one row below; open that feature file only.
2. The leaf explains behavior, boundaries, and conditional next hops. Follow a hop only when the task crosses that boundary.
3. Retrieve that feature’s single row from [feature-navigation.md](feature-navigation.md) using the leaf’s `rg` command. It identifies UI/API/CLI entry points, source symbols, and test filters.
   Route shorthand: `T` = `/api/tickets/:ticketId`; `S` = `T/steps/:stepId`. Actions use POST unless marked GET.
4. Read the owning source and its callers; use the existing helpers to verify current behavior. Stop expanding the map when you have the relevant owner, contract, and checks.

For a cross-feature failure, start at the symptom and follow the adjacent transition. For an audit, load [historical findings](features/audit.md) separately. Neither is required for an ordinary feature lookup.

## Main flow

```text
F01 setup → F02 intake → F03 requirements → F04 plan
F04 approved → F06 execution → F08 step checks → F07 step review
F07 changes requested → F08 corrections
F07 accepted, more steps → F06 next batch
F07 all accepted → F08 combined verification → F10 final proof
F10 changes requested → F08 corrections
F10 human approval → F11 delivery
```

F05 governs Pi sessions and workflow gates across stages. F09 supplies visual evidence to verification/proof. F12 handles interrupted work; F13 persists and retains it. F14 exposes the flow through UI/CLI; F15 supplies developer fixtures. Read the [full lifecycle](features/lifecycle.md) only for an end-to-end question.

## Choose an entry

| Task mentions | Read first |
|---|---|
| Repository, credentials, local API access | [F01 · Setup](features/setup.md) |
| Missing tickets, blockers, priority, automatic pickup, new task | [F02 · Intake](features/intake.md) |
| Clarification, requirements approval, exploration, product context | [F03 · Requirements](features/requirements.md) |
| Graph edits, dependency cycles, plan approval, review budgets | [F04 · Plans](features/plans.md) |
| Models, reasoning, sessions, skills, prompts, workflow gates | [F05 · Pi and workflows](features/pi-workflows.md) |
| Scheduling, scopes, commands, worktrees, Git/jj, step commits | [F06 · Execution](features/execution.md) |
| Step acceptance, exact diffs, review notes, criterion proof | [F07 · Step review](features/step-review.md) |
| Tests, verification contract, failed checks, correction loops | [F08 · Verification](features/verification.md) |
| Preview ports, screenshots, recordings, visual evidence | [F09 · Visual evidence](features/visual-evidence.md) |
| Final proof, Approve & deliver, final requested changes | [F10 · Final proof](features/final-proof.md) |
| PR/MR, CI, remote feedback, merging, tracker completion | [F11 · Delivery](features/delivery.md) |
| Pause, cancel, resume, restart, process cleanup | [F12 · Recovery](features/recovery.md) |
| JSON state, artifacts, disk use, retention, forgetting runs | [F13 · Storage](features/storage.md) |
| Selection, inspector, live events, activity, CLI presentation | [F14 · Interfaces](features/interfaces.md) |
| Navigation helpers, test filters, seeded states, fixtures | [F15 · Developer tools](features/developer-tools.md) |

## Ground rules and freshness

Follow the [repository skill](../.agents/skills/agent-plan/SKILL.md). Run `node scripts/nav.mjs --json`, `node scripts/test.mjs --map`, and `node scripts/seed.mjs --list`; these discover current behavior. Test-map filename matches are not coverage. Use mocked harnesses for test journeys; do not mutate real daemon state while exploring.

Snapshot: 2026-09-06, base `9703dde` plus uncommitted work. Source wins over this map and specification prose. Preserve stable F-IDs; update the affected leaf and navigation row when behavior changes. Keep audit history out of the lookup path. Camera control is unrelated and excluded.
