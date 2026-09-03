import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlan } from "../src/plan.js";
import { runCli } from "../src/cli.js";
import { runAgainstDaemon, seedRun, withDaemon } from "./helpers.js";

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

test("select, timeline, resume, and queue clear talk to the same routes as the inspector", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({
      title: "Seeded",
      nodes: [{
        id: "build",
        title: "Build",
        status: "running",
        permission: "write",
        writeScope: "src",
        expectedFiles: ["src/app.js"],
        estimatedChangedLines: 20,
        acceptanceCriteria: ["Works"],
        attempts: [{ events: [
          { type: "tool_start", tool: "edit", callId: "c1", args: "{\"path\":\"src/app.js\"}", at: "2026-09-01T12:00:00.000Z" },
          { type: "tool_end", tool: "edit", callId: "c1", result: "ok", at: "2026-09-01T12:00:01.000Z" }
        ] }]
      }]
    });
    const id = await seedRun(daemon, { status: "interrupted", plan });
    const selected = await runAgainstDaemon(daemon, ["select", id]);
    assert.equal(selected.json.selectedTicketId, id);
    const timeline = await runAgainstDaemon(daemon, ["list", "execution-timeline"]);
    assert.equal(timeline.json.ticketId, id);
    assert.equal(timeline.json.stepId, "build");
    assert.equal(timeline.json.events[0].tool, "edit");
    assert.equal(timeline.json.events[0].isError, false);
    const resumed = await runAgainstDaemon(daemon, ["select", id, "resume-run"]);
    assert.equal(resumed.json.accepted, true);
    const cleared = await runAgainstDaemon(daemon, ["queue", "clear"]);
    assert.equal(typeof cleared.json.cleared, "number");
  });
});

test("timeline includes the active worker before its attempt is persisted", async () => {
  await withDaemon(async (daemon) => {
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", status: "running" }] });
    const id = await seedRun(daemon, {
      status: "running", plan,
      activeRuns: { build: { activity: { events: [{ type: "tool_start", tool: "read", args: '{"path":"src/app.js"}', at: "2026-09-03T00:00:00.000Z" }] } } }
    });

    const timeline = await runAgainstDaemon(daemon, ["list", "timeline", id]);
    assert.equal(timeline.json.events.length, 1);
    assert.equal(timeline.json.events[0].tool, "read");
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
    const plan = normalizePlan({ nodes: [{ id: "build", title: "Build", status: "accepted", attempts: [{ events: [{ type: "tool_start", tool: "write", at: "1" }] }] }] });
    const stages = [
      { id: "implement", status: "completed" },
      { id: "verify", status: "active", activity: { events: [{ type: "phase", label: "Final review", at: "2" }] } }
    ];
    const id = await seedRun(daemon, { status: "reviewing", plan, stages });

    const timeline = await runAgainstDaemon(daemon, ["list", "timeline", id]);
    assert.equal(timeline.json.stepId, null);
    assert.equal(timeline.json.stageId, "verify");
    assert.match(timeline.json.events[0].title, /Final review/);
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
