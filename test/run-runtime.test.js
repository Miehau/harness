import assert from "node:assert/strict";
import test from "node:test";
import { RunRuntime } from "../src/run-runtime.js";

test("queued containment registration observes shutdown before a worker launches", async () => {
  const state = { ticketRuns: { ticket: { runId: "run-1", cleanup: {}, plan: { nodes: [] } } }, retainedRuns: {} };
  let closed = false;
  let release;
  const queued = new Promise((resolve) => { release = resolve; });
  let launches = 0;
  const containment = { ownership: { token: "owned" }, async cleanup() { return { outcome: "complete" }; } };
  const runtime = new RunRuntime({
    readState: () => structuredClone(state),
    update: async (change) => { await queued; await change(state); },
    isClosed: () => closed,
    harness: { async runStep() { launches++; } }
  });
  const work = runtime.runContainedWorker({ ticketId: "ticket", stepId: "step", containment });
  closed = true;
  release();
  await assert.rejects(work, /shutting down/);
  assert.equal(launches, 0);
  assert.equal(state.ticketRuns.ticket.cleanup.executions[0].ownership.executionId, state.ticketRuns.ticket.cleanup.executions[0].executionId);
});

test("expected containment ownership rejects a replacement run without retaining a handle", async () => {
  const state = { ticketRuns: { ticket: { runId: "run-2", cleanup: {}, plan: { nodes: [] } } }, retainedRuns: {} };
  const runtime = new RunRuntime({
    readState: () => state,
    update: async (change) => change(state)
  });
  const containment = { ownership: { token: "owned" }, async cleanup() { return { outcome: "complete" }; } };

  await assert.rejects(
    runtime.registerContainment("ticket", "execution", containment, { runId: "run-1" }),
    (error) => error.code === "run_superseded"
  );
  assert.equal(runtime.activeContainments.has("execution"), false);
  assert.equal(state.ticketRuns.ticket.cleanup.executions, undefined);
});
