import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlan } from "../src/plan.js";
import { markRunCancelled, rewindRun } from "../src/execution.js";
import { runCli } from "../src/cli.js";
import { invoke, runAgainstDaemon, seedRun, withDaemon } from "./helpers.js";

function stableTimeline(projection) {
  const stable = structuredClone(projection);
  for (const item of [...stable.stages, ...stable.attempts]) {
    if (item.timing) item.timing.elapsedMs = null;
  }
  return stable;
}

async function assertCanonicalTimeline(daemon, id, argv = ["list", "timeline", id]) {
  const api = await invoke(daemon, "GET", `/api/tickets/${encodeURIComponent(id)}/inspection`);
  assert.equal(api.status, 200);
  const cli = await runAgainstDaemon(daemon, argv);
  assert.equal(cli.code, 0);
  assert.deepEqual(stableTimeline(cli.json), stableTimeline(api.json));
  return cli.json;
}

function testTicket(id) {
  return {
    id, identifier: id.toUpperCase(), title: `Ticket ${id}`, description: "Inspect this ticket",
    source: "local", state: { name: "Local", type: "local" }, team: { name: "Local" }
  };
}

test("new text creates a queue item the UI would start", async () => {
  await withDaemon(async (daemon) => {
    const created = await runAgainstDaemon(daemon, ["new", "text", "Add an empty-state heading"]);
    assert.equal(created.code, 0);
    assert.equal(created.json.accepted, true);
    assert.match(created.json.identifier, /^TEXT-/);
    const backlog = await runAgainstDaemon(daemon, ["list", "backlog"]);
    assert.equal(backlog.code, 0);
    const row = backlog.json.tickets.find((ticket) => ticket.id === created.json.ticketId);
    assert.equal(row.title, "Add an empty-state heading");
    assert.equal(row.source, "local");
    assert.ok(row.status);
  });
});

test("timeline requests the canonical endpoint without reading a run record", async () => {
  const requests = [];
  const output = [];
  const projection = { version: 1, ticketId: "ticket-1", focus: { reason: "empty" }, stages: [], workers: [], attempts: [], blockers: [] };
  const code = await runCli(["timeline", "ticket-1"], {
    env: { AGENT_PLAN_URL: "http://127.0.0.1:4317" },
    fetchImpl: async (url) => {
      requests.push(url);
      return { ok: true, status: 200, async text() { return JSON.stringify(projection); } };
    },
    stdout: { write(value) { output.push(value); } }, stderr: { write() {} }
  });
  assert.equal(code, 0);
  assert.deepEqual(requests, ["http://127.0.0.1:4317/api/tickets/ticket-1/inspection"]);
  assert.deepEqual(JSON.parse(output.join("")), projection);
});

test("runs enumerate identities and timeline selects an archived canonical projection", async () => {
  const requests = [];
  const output = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return { ok: true, status: 200, async text() { return JSON.stringify({ runs: [], stages: [], workers: [], attempts: [], blockers: [] }); } };
  };
  const opts = { env: { AGENT_PLAN_URL: "http://127.0.0.1:4317" }, fetchImpl, stdout: { write(value) { output.push(value); } }, stderr: { write() {} } };
  assert.equal(await runCli(["list", "runs", "ticket-1"], opts), 0);
  assert.equal(await runCli(["list", "timeline", "ticket-1", "archived-run"], opts), 0);
  assert.deepEqual(requests, [
    "http://127.0.0.1:4317/api/tickets/ticket-1/runs",
    "http://127.0.0.1:4317/api/tickets/ticket-1/runs/archived-run/inspection"
  ]);
});

test("timeline redacts key-value secrets and paths missed by an unsafe inspection response", async () => {
  const output = [];
  const code = await runCli(["timeline", "ticket-1"], {
    env: { AGENT_PLAN_URL: "http://127.0.0.1:4317" },
    fetchImpl: async () => ({
      ok: true, status: 200,
      async text() { return JSON.stringify({
        ticketId: "ticket-1", blockers: [{ summary: "Provider error: password=hunter2 path=/private/run\nAuthorization: Bearer bearer-credential\nAuthorization: Negotiate negotiate-credential\nProxy-Authorization: Negotiate proxy-credential" }],
        diagnostics: { password: "object-secret" }, stages: [], workers: [], attempts: []
      }); }
    }),
    stdout: { write(value) { output.push(value); } }, stderr: { write() {} }
  });
  assert.equal(code, 0);
  const timeline = output.join("");
  assert.equal(timeline.includes("hunter2"), false);
  assert.equal(timeline.includes("object-secret"), false);
  assert.equal(timeline.includes("/private/run"), false);
  assert.equal(timeline.includes("Bearer"), false);
  assert.equal(timeline.includes("bearer-credential"), false);
  assert.equal(timeline.includes("Negotiate"), false);
  assert.equal(timeline.includes("negotiate-credential"), false);
  assert.equal(timeline.includes("proxy-credential"), false);
  assert.match(timeline, /\[redacted\]/);
  assert.match(timeline, /\[path\]/);
});

test("timeline aliases select the canonical inspection projection and preserve existing commands", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({
      title: "Seeded",
      nodes: [{
        id: "build", title: "Build", status: "running", permission: "write", writeScope: "src",
        expectedFiles: ["src/app.js"], estimatedChangedLines: 20, acceptanceCriteria: ["Works"]
      }]
    });
    const id = await seedRun(daemon, { status: "interrupted", plan });
    const selected = await runAgainstDaemon(daemon, ["select", id]);
    assert.equal(selected.json.selectedTicketId, id);
    const timeline = await assertCanonicalTimeline(daemon, id, ["list", "execution-timeline"]);
    assert.equal(timeline.workers[0].id, "worker:build");
    assert.equal("events" in timeline, false);
    const resumed = await runAgainstDaemon(daemon, ["select", id, "resume-run"]);
    assert.equal(resumed.json.accepted, true);
    const cleared = await runAgainstDaemon(daemon, ["queue", "clear"]);
    assert.equal(typeof cleared.json.cleared, "number");
  });
});

test("timeline preserves canonical active focus, parallel workers, and live resource availability", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{
      id: "parallel", type: "group", children: [
        { id: "api", title: "API", status: "running", permission: "write", writeScope: "src/api.js" },
        { id: "ui", title: "UI", status: "running", permission: "write", writeScope: "src/ui.js" }
      ]
    }] });
    const id = await seedRun(daemon, {
      status: "running", plan,
      stages: [{ id: "implement", title: "Implement", status: "active", summary: "Parallel implementation" }],
      activeRuns: {
        api: { runId: "active-api", startedAt: "2026-09-03T10:00:00.000Z", lastEvent: "Editing API", activity: { prompts: [{ content: "Inspect the API contract" }], rawOutput: "streamed API output" } },
        ui: { runId: "active-ui", startedAt: "2026-09-03T10:00:00.000Z", lastEvent: "Editing UI" }
      }
    });
    const timeline = await assertCanonicalTimeline(daemon, id);
    assert.deepEqual(timeline.focus, {
      stageId: "stage:implement", workerId: "worker:api", attemptId: "attempt:api:active-active-api", reason: "active"
    });
    assert.deepEqual(timeline.workers.map((worker) => worker.id), ["worker:api", "worker:ui"]);
    assert.deepEqual(timeline.attempts.map((attempt) => attempt.runId), ["active-api", "active-ui"]);
    assert.equal(timeline.attempts[0].resources.output.state, "available");
    assert.equal(timeline.attempts[0].resources.prompt.state, "available");
    assert.equal(timeline.attempts[1].resources.checks.state, "not_yet_available");
  });
});

test("timeline follows the active run after automatic step advancement", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [
      { id: "old", title: "Old", status: "accepted", attempts: [{ events: [{ type: "tool_start", tool: "read", args: '{"path":"old.js"}', at: "2026-09-03T00:00:00.000Z" }] }] },
      { id: "next", title: "Next", status: "ready" }
    ] });
    const id = await seedRun(daemon, {
      status: "running", plan,
      activeRuns: { next: { activity: { events: [{ type: "tool_start", tool: "edit", args: '{"path":"next.js"}', at: "2026-09-03T00:01:00.000Z" }] } } }
    });

    const timeline = await runAgainstDaemon(daemon, ["list", "timeline", id]);
    assert.equal(timeline.json.stepId, "next");
    assert.equal(timeline.json.events[0].tool, "edit");
  });
});

test("timeline follows an active verification stage instead of an accepted step", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", status: "running", permission: "write", writeScope: "src/build.js" }] });
    const id = await seedRun(daemon, {
      status: "running", plan,
      activeRuns: { build: {
        runId: "cancelled-worker", attemptId: "attempt-1", startedAt: "2026-09-03T10:00:00.000Z",
        prompt: "Inspect retained prompt", activity: { prompts: [{ content: "Inspect retained prompt" }] }
      } }
    });
    await daemon.store.update((state) => {
      const current = state.ticketRuns[id];
      current.baselineTree = "baseline-tree";
      markRunCancelled(current, "2026-09-03T10:01:00.000Z");
      rewindRun(current, "step:build", "2026-09-03T10:02:00.000Z");
    });

    const timeline = await assertCanonicalTimeline(daemon, id);
    const attempt = timeline.attempts[0];
    assert.deepEqual({
      lifecycle: attempt.lifecycle,
      prompt: attempt.resources.prompt.state,
      terminationReason: attempt.terminationReason,
      failureKind: attempt.failureKind,
      failurePhase: attempt.failurePhase
    }, { lifecycle: "cancelled", prompt: "available", terminationReason: "run_cancelled", failureKind: "cancellation", failurePhase: "execution" });
    const detail = await invoke(daemon, "GET", `/api/tickets/${id}/runs/run-1/steps/build/attempts/attempt-1/details`);
    assert.deepEqual({
      prompt: detail.json.prompt.content,
      terminationReason: detail.json.terminationReason,
      failureKind: detail.json.failureKind,
      failurePhase: detail.json.failurePhase
    }, { prompt: "Inspect retained prompt", terminationReason: "run_cancelled", failureKind: "cancellation", failurePhase: "execution" });
  });
});

test("timeline keeps failed corrections, completed verification, and handoff as independent canonical attempts", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{
      id: "build", title: "Build", status: "accepted", permission: "write", writeScope: "src/build.js",
      expectedArtifacts: ["build.md"], acceptedAt: "2026-09-03T10:04:00.000Z", attempts: [
        {
          attemptId: "attempt-1", runId: "worker-original", status: "failed", startedAt: "2026-09-03T10:00:00.000Z",
          completedAt: "2026-09-03T10:01:00.000Z", error: "Provider request failed"
        },
        {
          attemptId: "attempt-2", runId: "worker-correction", status: "verified", startedAt: "2026-09-03T10:02:00.000Z",
          completedAt: "2026-09-03T10:03:00.000Z", report: { status: "completed" },
          verification: { checks: { status: "passed", command: "node test", summary: "Passed" } },
          diff: { available: true, files: ["src/build.js"] }
        }
      ]
    }] });
    // Plan normalization deliberately excludes lifecycle timestamps; retained runs carry them.
    plan.nodes[0].acceptedAt = "2026-09-03T10:04:00.000Z";
    const id = await seedRun(daemon, {
      status: "completed", plan,
      stages: [
        { id: "implement", title: "Implement", status: "completed", updatedAt: "2026-09-03T10:04:00.000Z" },
        { id: "verify", title: "Verify", status: "completed", updatedAt: "2026-09-03T10:05:00.000Z" },
        { id: "handoff", title: "Handoff", status: "completed", updatedAt: "2026-09-03T10:06:00.000Z" }
      ],
      artifacts: [
        { id: "output", stepId: "build", attemptId: "attempt-2", kind: "agent-output", name: "build.md" },
        { id: "handoff", stageId: "handoff", kind: "handoff", name: "handoff.md" }
      ],
      reviews: [{ reviews: [{ role: "deterministic", checks: { status: "passed" } }] }],
      integration: { integratedAt: "2026-09-03T10:06:00.000Z" }
    });
    const timeline = await assertCanonicalTimeline(daemon, id);
    assert.deepEqual(timeline.attempts.map((attempt) => [attempt.id, attempt.runId, attempt.lifecycle]), [
      ["attempt:build:attempt-1", "worker-original", "failed"],
      ["attempt:build:attempt-2", "worker-correction", "completed"]
    ]);
    assert.equal(timeline.attempts[0].blocker.type, "provider");
    assert.equal(timeline.attempts[1].resources.checks.status, "passed");
    assert.equal(timeline.evidence.state, "complete");
    assert.equal(timeline.workers[0].lifecycle, "completed");
    assert.equal(JSON.stringify(timeline).includes("rawOutput"), false);
  });
});

test("timeline carries every canonical blocker class without reinterpreting it", async () => {
  const cases = [
    ["repository-check", { status: "needs_attention", stepStatus: "verification_failed", attempt: { status: "verification_failed", verification: { checks: { status: "failed" } } } }],
    ["provider", { status: "needs_attention", stepStatus: "needs_attention", error: "Provider rate limit" }],
    ["review", { status: "needs_attention", stepStatus: "needs_attention", checkpoint: { kind: "review_blocked", title: "Review found an issue", stepId: "build" } }],
    ["scope", { status: "needs_attention", stepStatus: "needs_attention", attempt: { status: "needs_attention", violations: ["outside scope"] } }],
    ["merge", { status: "needs_attention", stepStatus: "needs_attention", error: "Merge conflict", merge: { status: "failed" } }],
    ["preview", { status: "needs_attention", stepStatus: "needs_attention", error: "Preview port bind failed" }],
    ["evidence", { status: "needs_attention", stepStatus: "needs_attention", checkpoint: { kind: "evidence_review", title: "Review final proof", stepId: "build" } }],
    ["cancellation", { status: "cancelled", stepStatus: "cancelled" }],
    ["interruption", { status: "interrupted", stepStatus: "interrupted" }]
  ];
  await withDaemon(async (daemon) => {
    for (const [expected, fixture] of cases) {
      const id = `blocker-${expected}`;
      const attempt = fixture.attempt && { attemptId: "attempt-1", runId: "worker-1", ...fixture.attempt };
      const plan = normalizePlan({ nodes: [{
        id: "build", title: "Build", status: fixture.stepStatus, permission: "write", writeScope: "src",
        lastError: fixture.error, attempts: attempt ? [attempt] : []
      }] });
      await seedRun(daemon, {
        ticket: testTicket(id), status: fixture.status, lastError: fixture.error,
        checkpoint: fixture.checkpoint, merge: fixture.merge, plan
      });
      const timeline = await assertCanonicalTimeline(daemon, id);
      assert.equal(timeline.workers[0].blocker.type, expected);
    }
  });
});

test("timeline hydrates an explicitly targeted unselected run", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{ id: "target-step", title: "Target", status: "running", attempts: [{ events: [{ type: "tool_start", tool: "read", at: "1" }] }] }] });
    const targetId = await seedRun(daemon, { ticket: { id: "target", identifier: "TARGET", title: "Target" }, status: "running", plan });
    await seedRun(daemon, { ticket: { id: "selected", identifier: "SELECTED", title: "Selected" } });

    const timeline = await runAgainstDaemon(daemon, ["list", "timeline", targetId]);
    assert.equal(timeline.json.ticketId, targetId);
    assert.equal(timeline.json.stepId, "target-step");
    assert.equal(timeline.json.events[0].tool, "read");
  });
});

test("timeline keeps a paused verification stage instead of falling back to old step activity", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{ id: "old", title: "Old", status: "accepted", attempts: [{ events: [{ type: "tool_start", tool: "write", at: "1" }] }] }] });
    const stages = [
      { id: "implement", status: "completed" },
      { id: "verify", status: "paused", activity: { events: [{ type: "phase", label: "Review fixer paused", at: "2" }] } }
    ];
    const id = await seedRun(daemon, { status: "paused", plan, stages });
    const timeline = await runAgainstDaemon(daemon, ["list", "timeline", id]);
    assert.equal(timeline.json.stepId, null);
    assert.equal(timeline.json.stageId, "verify");
    assert.match(timeline.json.events[0].title, /Review fixer paused/);
  });
});

test("timeline follows the stopped step named by the current checkpoint", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [
      { id: "old", title: "Old", status: "accepted", attempts: [{ events: [{ type: "tool_start", tool: "read", args: '{"path":"old.js"}', at: "1" }] }] },
      { id: "blocked", title: "Blocked", status: "needs_attention", attempts: [{ events: [{ type: "tool_end", tool: "edit", result: "failed", isError: true, at: "2" }] }] }
    ] });
    const id = await seedRun(daemon, {
      status: "needs_attention", plan,
      stages: [{ id: "implement", status: "blocked" }],
      checkpoint: { id: "cp", kind: "needs_attention", stepId: "blocked", title: "Correction stalled" }
    });

    const timeline = await runAgainstDaemon(daemon, ["list", "timeline", id]);
    assert.equal(timeline.json.stepId, "blocked");
    assert.equal(timeline.json.stepStatus, "needs_attention");
    assert.equal(timeline.json.events[0].isError, true);
  });
});

test("approve without an id uses the selected ticket (run manually)", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({
      title: "Ready",
      nodes: [{
        id: "build", title: "Build", permission: "write", writeScope: "src",
        expectedFiles: ["src/app.js"], estimatedChangedLines: 20, acceptanceCriteria: ["Works"]
      }]
    });
    const id = await seedRun(daemon, {
      status: "awaiting_approval",
      plan,
      checkpoint: { id: "cp", kind: "awaiting_approval", title: "Approve local execution plan" }
    });
    await runAgainstDaemon(daemon, ["select", id]);
    const approved = await runAgainstDaemon(daemon, ["approve"]);
    assert.equal(approved.code, 0);
    assert.equal(approved.json.accepted, true);
    assert.equal(approved.json.ticketId, id);
  });
});

test("answer --approve submits an empty requirements response", async () => {
  let called;
  const output = [];
  const code = await runCli(["answer", "ticket-1", "--approve"], {
    env: { AGENT_PLAN_URL: "http://127.0.0.1:4317" },
    fetchImpl: async (url, options) => {
      called = { url, method: options.method, body: JSON.parse(options.body) };
      return { ok: true, status: 202, async text() { return JSON.stringify({ accepted: true, ticketId: "ticket-1" }); } };
    },
    stdout: { write(value) { output.push(value); } },
    stderr: { write() {} }
  });
  assert.equal(code, 0);
  assert.equal(called.url, "http://127.0.0.1:4317/api/tickets/ticket-1/clarify");
  assert.equal(called.method, "POST");
  assert.deepEqual(called.body, { answers: "" });
  assert.equal(JSON.parse(output.join("")).accepted, true);
});

test("restart exposes the dashboard restart route", async () => {
  let called;
  await runCli(["restart", "ticket-1", "stage:design", "--confirm"], {
    env: { AGENT_PLAN_URL: "http://127.0.0.1:4317" },
    fetchImpl: async (url, options) => {
      called = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 202, async text() { return JSON.stringify({ accepted: true }); } };
    },
    stdout: { write() {} },
    stderr: { write() {} }
  });
  assert.equal(called.url, "http://127.0.0.1:4317/api/tickets/ticket-1/restart");
  assert.deepEqual(called.body, { target: "stage:design", confirmed: true });
});

test("revise-proof exposes final evidence corrections to operators", async () => {
  let called;
  await runCli(["revise-proof", "ticket-1", "Remove", "harness", "artifacts"], {
    env: { AGENT_PLAN_URL: "http://127.0.0.1:4317" },
    fetchImpl: async (url, options) => {
      called = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 202, async text() { return JSON.stringify({ accepted: true }); } };
    },
    stdout: { write() {} },
    stderr: { write() {} }
  });
  assert.equal(called.url, "http://127.0.0.1:4317/api/tickets/ticket-1/evidence/changes");
  assert.deepEqual(called.body, { feedback: "Remove harness artifacts" });
});

test("restart-fixer abandons a contaminated correction session with an audit reason", async () => {
  let called;
  await runCli(["restart-fixer", "ticket-1", "Remove", "the", "synthetic", "fallback"], {
    env: { AGENT_PLAN_URL: "http://127.0.0.1:4317" },
    fetchImpl: async (url, options) => {
      called = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 202, async text() { return JSON.stringify({ accepted: true }); } };
    },
    stdout: { write() {} }, stderr: { write() {} }
  });
  assert.equal(called.url, "http://127.0.0.1:4317/api/tickets/ticket-1/review-fix/restart");
  assert.deepEqual(called.body, { reason: "Remove the synthetic fallback" });
});

test("accept --auto enables automatic continuation at a review checkpoint", async () => {
  let called;
  await runCli(["accept", "build", "ticket-1", "--auto"], {
    env: { AGENT_PLAN_URL: "http://127.0.0.1:4317" },
    fetchImpl: async (url, options) => {
      called = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 202, async text() { return JSON.stringify({ accepted: true }); } };
    },
    stdout: { write() {} },
    stderr: { write() {} }
  });
  assert.equal(called.url, "http://127.0.0.1:4317/api/tickets/ticket-1/steps/build/accept");
  assert.deepEqual(called.body, { auto: true });
});

test("approve-proof exposes the dashboard final proof action", async () => {
  let called;
  await runCli(["approve-proof", "ticket-1"], {
    env: { AGENT_PLAN_URL: "http://127.0.0.1:4317" },
    fetchImpl: async (url, options) => {
      called = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 200, async text() { return JSON.stringify({ accepted: true }); } };
    },
    stdout: { write() {} },
    stderr: { write() {} }
  });
  assert.equal(called.url, "http://127.0.0.1:4317/api/tickets/ticket-1/evidence/approve");
  assert.deepEqual(called.body, {});
});

test("profile overrides one stage on a stopped run", async () => {
  let called;
  await runCli(["profile", "verification", "gpt-5.6-terra", "high", "ticket-1"], {
    env: { AGENT_PLAN_URL: "http://127.0.0.1:4317" },
    fetchImpl: async (url, options) => {
      called = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 200, async text() { return JSON.stringify({ ticketId: "ticket-1" }); } };
    },
    stdout: { write() {} },
    stderr: { write() {} }
  });
  assert.equal(called.url, "http://127.0.0.1:4317/api/tickets/ticket-1/stage-profiles/verification");
  assert.deepEqual(called.body, { model: "gpt-5.6-terra", thinking: "high" });
});

test("revise sends focused feedback to a review-ready step", async () => {
  let called;
  await runCli(["revise", "build", "ticket-1", "Match the installed SDK interface"], {
    env: { AGENT_PLAN_URL: "http://127.0.0.1:4317" },
    fetchImpl: async (url, options) => {
      called = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 202, async text() { return JSON.stringify({ accepted: true }); } };
    },
    stdout: { write() {} },
    stderr: { write() {} }
  });
  assert.equal(called.url, "http://127.0.0.1:4317/api/tickets/ticket-1/steps/build/changes");
  assert.deepEqual(called.body, { feedback: "Match the installed SDK interface" });
});

test("scope-add sends one explicit operator-approved path and reason", async () => {
  let called;
  await runCli(["scope-add", "build", "ticket-1", "test/e2e.test.js", "Canonical failure requires its regression update"], {
    env: { AGENT_PLAN_URL: "http://127.0.0.1:4317" },
    fetchImpl: async (url, options) => {
      called = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 200, async text() { return JSON.stringify({ ticketId: "ticket-1" }); } };
    },
    stdout: { write() {} },
    stderr: { write() {} }
  });
  assert.equal(called.url, "http://127.0.0.1:4317/api/tickets/ticket-1/steps/build/scope");
  assert.deepEqual(called.body, { paths: ["test/e2e.test.js"], reason: "Canonical failure requires its regression update" });
});

test("waive rejects one verifier finding with an operator reason", async () => {
  let called;
  await runCli(["waive", "build", "ticket-1", "Owned by the next plan slice"], {
    env: { AGENT_PLAN_URL: "http://127.0.0.1:4317" },
    fetchImpl: async (url, options) => {
      called = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 200, async text() { return JSON.stringify({ status: "review_ready" }); } };
    },
    stdout: { write() {} }, stderr: { write() {} }
  });
  assert.equal(called.url, "http://127.0.0.1:4317/api/tickets/ticket-1/steps/build/waive");
  assert.deepEqual(called.body, { reason: "Owned by the next plan slice" });
});
