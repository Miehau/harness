---
name: agent-plan
description: Work in Agent Plan Workspace using live helper CLIs for tests, API/UI navigation, JsonStore seeds, and the agent-plan operator CLI that mirrors dashboard actions. Use when editing this repo, running tests, seeding daemon state, inspecting routes, driving a ticket from the CLI, following the hardening plan, or the user runs /agent-plan.
---

# Agent Plan Workspace

Do not reconstruct this app from memory. Run the helper CLIs; they read current source and `JsonStore`.

## First actions

```bash
node scripts/nav.mjs --json
node scripts/test.mjs --map
node scripts/seed.mjs --list
```

Flags and scenarios live in those programs (`--help` / `--list`), not in this skill.

## Tests

- `node scripts/test.mjs` (also `npm test`). Filter by filename: `node scripts/test.mjs plan server`.
- `--check` for syntax, `--watch` while iterating, `-- --test-name-pattern "…"` for node:test flags.
- New daemon tests import `test/helpers.js`: `withDaemon`, `invoke`, `seedRun`, `writeSeed`, `runAgainstDaemon`.
- Do not copy `createDaemon` setup. Do not hand-write `state-v3.json`.
- Run shapes come from `createTicketRun` / `initialStages` in `src/execution.js`.
- Never call a real Pi model in tests; pass `mockHarness()`.

## Operator CLI (same buttons as the UI)

Drive a running daemon over HTTP. Do not `store.update` to fake a journey.

```bash
node src/cli.js new text "Add an empty-state heading"
node src/cli.js list backlog
node src/cli.js select <ticketId>
node src/cli.js wait
node src/cli.js approve              # Run manually
node src/cli.js list timeline        # Inspector output for the active step
node src/cli.js accept <stepId>
node src/cli.js resume
node src/cli.js queue clear
```

`select <id> resume-run` (or `approve` / `cancel`) is allowed. JSON only. `wait` exits 1 on `needs_attention`.

Verify a test ticket against `withDaemon` + `mockHarness()` via `runAgainstDaemon` in `test/helpers.js`. Do not call a live Pi model in CI. For a gate without running Pi, `node scripts/seed.mjs plan-approval` then `select` + `approve`.

## Seeding a dashboard

```bash
node scripts/seed.mjs <scenario> --json
AGENT_PLAN_DATA_DIR=<dataDir> npm start -- --cwd <cwd>
```

`JsonStore.init` marks in-flight statuses interrupted. For a daemon that should stay at a gate, seed `plan-approval`, `review-ready`, `needs-attention`, `interrupted`, or `empty`.

## Where to look

| Need | Source of truth |
|---|---|
| Routes, dialogs, CLI, stages, untested files | `node scripts/nav.mjs` |
| Product boundary | `docs/automation-harness-spec.md` |
| Next refactors | `docs/hardening-plan.md` |
| HTTP + pipeline | `src/server.js` |
| Pi prompts/tools | `src/pi-harness.js` |
| Dashboard | `public/app.js`, `public/ui-model.js` |

## Constraints

- Pi is the only harness. Localhost daemon. JSON store until measured need.
- No extra notifiers, no direct deploy, no second agent layer.
- Workers have no arbitrary shell; commands are named argv from `.agent-plan/project.json`.
- Do not parse architecture prose for commands.
- `src/camera-control.js` is unrelated; leave it alone unless asked.

## Checks before done

```bash
node scripts/test.mjs
node scripts/test.mjs --check
```
