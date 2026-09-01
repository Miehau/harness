# Hardening plan

Follow-up work from the repo analysis. Product boundaries in [automation-harness-spec.md](automation-harness-spec.md) stay: Pi-only, localhost daemon, JSON store until measured need, no extra notifiers.

Use `node scripts/nav.mjs`, `node scripts/test.mjs`, and `node scripts/seed.mjs` while doing this. They read current source and `JsonStore` instead of a parallel inventory.

## Out of scope

- Second agent harness or provider layer
- Replacing `state-v3.json` with SQLite
- OS/email/Slack notifications
- Direct deploy
- `src/camera-control.js` (unrelated NVR helper)

Done in-tree: PR1 (named statuses in `src/run-status.js`), PR2 (`src/http.js`), PR4 (`test/e2e-daemon.test.js`), PR5 (Pi labels). Screenshots: [evidence/](evidence/). PR3 (pipeline extract) and PR6 (jj parallel) remain.

## PR 1 — Named run vocabulary

**Why:** Run, merge, checkpoint, and recovery statuses are raw strings copied across [src/store.js](../src/store.js), [src/execution.js](../src/execution.js), and [src/server.js](../src/server.js). Splitting the daemon later without a single list will drop a transition.

**Do:**

- Export frozen status sets from `src/execution.js` (or a tiny `src/run-status.js` if execution would get noisier): run, merge, step, checkpoint kind, recovery kind.
- Replace every matching string list, including daemon-restart interruption in `JsonStore.init`.
- Keep values identical; this is a rename-to-constants change, not a behavior change.

**Prove:** existing store/execution/server tests plus `node scripts/nav.mjs stages`.

## PR 2 — HTTP surface out of `createDaemon`

**Why:** [src/server.js](../src/server.js) is ~2.3k lines of pipeline + routing. The route table is already recoverable via `node scripts/nav.mjs routes`.

**Do:**

- Move `api()`, `staticFile()`, `authorizeApi()`, `handleRequest()` into `src/http.js` (or similar) that receives the daemon context.
- `createDaemon` keeps store, lock, harness, previews, and the ticket pipeline.
- Do not change paths or payloads.

**Prove:** `test/server.test.js`, `node scripts/nav.mjs routes` still lists the same `METHOD path` pairs.

## PR 3 — Ticket pipeline out of `createDaemon`

**Why:** After PR 2, the remaining bulk is `beginTicket` → requirements → explore → design → implement → verify → handoff.

**Do:**

- Extract pipeline functions into `src/pipeline.js` (name flexible) that the daemon calls.
- Keep `createDaemon` as composition: store + harness + pipeline + http.
- No workflow or permission changes.

**Prove:** server tests, workflow tests, `node scripts/seed.mjs plan-approval` still produces an approvable run.

## PR 4 — Daemon-level e2e without Pi

**Why:** [test/e2e-automation.test.js](../test/e2e-automation.test.js) only stitches mocked Jira + GitLab. The live daemon path (seed → approve → step gate → compact run) is untested as one sequence.

**Do:**

- Add `test/e2e-daemon.test.js` using `withDaemon`, `invoke`, and `writeSeed` from [test/helpers.js](../test/helpers.js).
- Cover at least: seed `plan-approval` → `POST /approve` → mocked worker/supervisor → step `review_ready` → accept; seed `needs-attention` → CLI `wait` exits 1; restart recovery of an in-flight status.
- Mock `PiHarness` methods; do not call a real model.

**Prove:** `node scripts/test.mjs e2e`.

## PR 5 — Drop leftover Codex names

**Why:** The API already reports the real Pi provider (`test/server.test.js`). The UI still uses `codexModels` and the default profile provider is `openai-codex`.

**Do:**

- Rename `codexModels` → `piModels` (or `models`) in [public/app.js](../public/app.js).
- Keep profile provider configurable; only change labels/defaults if they disagree with `GET /api/models`.
- Do not retarget models without a dashboard-visible reason.

**Prove:** `test/ui-model.test.js`, server models test, `node --check public/app.js`.

## PR 6 — Jujutsu sibling isolation (optional, after 1–4)

**Why:** Git parallel writers use isolated worktrees. README states jj siblings currently run serially.

**Do:**

- Only if a real ticket needs concurrent jj writers.
- Give dependency-ready jj siblings isolated working copies whose change IDs survive, then export/cherry-pick in review order as Git does today.
- Conflicts still stop for humans.

**Prove:** extend [test/jj.test.js](../test/jj.test.js) and [test/worktrees.test.js](../test/worktrees.test.js). Skip this PR if serial jj remains an accepted MVP limit.

## Order

```
PR1 vocabulary
  └─ PR2 http extract
       └─ PR3 pipeline extract
            └─ PR4 daemon e2e
  └─ PR5 Codex rename (independent after PR1, can parallel PR2)
PR6 jj parallel (independent, lowest urgency)
```

## Checks for every PR

```bash
node scripts/test.mjs
node scripts/test.mjs --check
node scripts/nav.mjs --json > /tmp/nav-before.json   # before behavior changes
```
