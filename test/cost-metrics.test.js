import assert from "node:assert/strict";
import test from "node:test";
import { safeEvent } from "../src/pi-harness.js";
import { createActivityCapture } from "../src/activity.js";
import { compactRun } from "../src/inspection.js";
import { runMetrics } from "../public/ui-model.js";

const response = (cost, stopReason = "stop") => safeEvent({ type: "message_end", message: { role: "assistant", stopReason, usage: { input: 20, output: 5, ...(cost === undefined ? {} : { cost: { total: cost } }) } } });

test("reported cost survives failure, trimming, resume and duplicate active-attempt projections", async () => {
  let saved;
  const capture = createActivityCapture({ eventLimit: 1, persist: async (value) => { saved = value; } });
  capture.onEvent(response(0));
  assert.equal(runMetrics({ stages: [{ activity: capture.snapshot() }] }).cost.state, "reported");
  assert.equal(runMetrics({ stages: [{ activity: capture.snapshot() }] }).cost.usd, 0);
  const failure = response(0.03, "error");
  assert.equal(failure.type, "agent_error");
  capture.onEvent(failure);
  capture.onEvent({ type: "tool_start", tool: "read" });
  await capture.flush();
  const resumed = createActivityCapture({ existing: JSON.parse(JSON.stringify(saved)) });
  resumed.onEvent(response(0.02));
  const attempt = { runId: "attempt-one", ...resumed.snapshot() };
  const run = { stages: [], plan: { nodes: [{ id: "step", attempts: [attempt] }] }, activeRuns: { step: { runId: "attempt-one", activity: attempt } } };
  assert.deepEqual(compactRun(run).metrics.cost, { usd: 0.05, currency: "USD", reportedCalls: 3, state: "reported" });
  assert.equal(runMetrics(run).modelCalls, 3);
  const correction = createActivityCapture({});
  correction.onEvent(response(undefined));
  run.stages.push({ activity: correction.snapshot() });
  assert.equal(runMetrics(run).cost.state, "partial");
  assert.equal(runMetrics(run).cost.usd, 0.05);
  for (const cost of [undefined, -1, Infinity, NaN, "0.2", null]) {
    const unknown = createActivityCapture({});
    unknown.onEvent(response(cost));
    assert.equal(runMetrics({ stages: [{ activity: unknown.snapshot() }] }).cost.usd, null);
  }
  assert.equal(runMetrics({ stages: [{ activity: { events: [{ type: "usage", input: 3 }] } }] }).cost.state, "unavailable");
});
