import assert from "node:assert/strict";
import test from "node:test";
import { stageActivity, stepActivity } from "../src/activity.js";
import { JsonStore } from "../src/store.js";

test("streaming activity reads only its owner and ignores events from replaced runs", async () => {
  for (const captureActivity of [stageActivity, stepActivity]) {
    const store = new JsonStore("unused", "/tmp");
    const activity = { events: [], rawOutput: "saved" };
    const run = { runId: "run", stages: [{ id: "stage", activity }], activeRuns: { step: { runId: "run", activity } } };
    store.state.ticketRuns.ticket = run;
    // A full-state clone touches unrelated history on every streamed token.
    Object.defineProperty(store.state.retainedRuns, "unrelated", {
      enumerable: true, get() { throw new Error("streaming must not read retained history"); }
    });
    const selected = store.read((state) => state.ticketRuns.ticket.stages[0].activity);
    selected.rawOutput = "changed";
    assert.equal(activity.rawOutput, "saved");
    const emitted = [];
    const capture = captureActivity({ store, update: async () => {}, emit: (event) => emitted.push(event), ticketId: "ticket", stageId: "stage", stepId: "step", runId: "run" });
    for (let i = 0; i < 100; i++) capture.onEvent({ type: "text_delta", delta: "x" });
    assert.equal(emitted.length, 100);
    run.runId = "replacement";
    run.activeRuns.step.runId = "replacement";
    capture.onEvent({ type: "text_delta", delta: "stale" });
    assert.equal(emitted.length, 100);
    await capture.flush();
  }
});

test("text output refreshes the progress timestamp and memory-only capture flushes", async () => {
  const { createActivityCapture } = await import("../src/activity.js");
  let now = 1000;
  const capture = createActivityCapture({ now: () => now });
  now = 6000;
  capture.onEvent({ type: "text_delta", delta: "writing" });
  await capture.flush();
  assert.equal(capture.snapshot().lastEventAt, new Date(now).toISOString());
  assert.equal(capture.snapshot().lastEvent, "Writing the response");
});
