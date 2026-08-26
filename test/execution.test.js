import test from "node:test";
import assert from "node:assert/strict";
import { actionableFindings, clearInactiveRuns, createActivityCapture, markRunCancelled, nextRunnableBatch, nextRunnableStep, planApprovalPending, resumeStage } from "../src/execution.js";
import { normalizePlan } from "../src/plan.js";

test("only the first dependency-ready implementation slice is selected", () => {
  const plan = normalizePlan({ nodes: [
    { id: "one", title: "First slice", permission: "write" },
    { id: "two", title: "Second slice", permission: "write", dependsOn: ["one"] },
    { id: "three", title: "Third slice", permission: "write", dependsOn: ["two"] }
  ] });
  assert.equal(nextRunnableStep(plan).id, "one");
  plan.nodes[0].status = "review_ready";
  assert.equal(nextRunnableStep(plan), null);
  plan.nodes[0].status = "accepted";
  assert.equal(nextRunnableStep(plan).id, "two");
});

test("dependency-ready siblings in one group form a parallel batch", () => {
  const plan = normalizePlan({ nodes: [{
    id: "parallel", type: "group", title: "Parallel", children: [
      { id: "feature", title: "Feature", permission: "write" },
      { id: "ci", title: "CI", permission: "write" }
    ]
  }] });
  assert.deepEqual(nextRunnableBatch(plan).map((step) => step.id), ["feature", "ci"]);
  plan.nodes[0].children[0].status = "review_ready";
  assert.deepEqual(nextRunnableBatch(plan), []);
});

test("final review keeps every unique actionable finding", () => {
  const duplicate = { severity: "blocking", claim: "Missing guard", evidence: [{ file: "src/a.ts", line: 9 }] };
  const findings = actionableFindings([
    { findings: [duplicate, { severity: "warning", claim: "Missing browser coverage", evidence: [{ file: "test/app.test.ts", line: 2 }] }] },
    { findings: [duplicate, { severity: "blocking", claim: "No regression test", evidence: [{ file: "test/a.test.ts", line: 1 }] }] }
  ]);
  assert.equal(findings.length, 3);
});

test("cancelling a run stops every active step and preserves it for resume", () => {
  const run = {
    status: "verifying", checkpoint: { kind: "step_review" }, activeRuns: { one: {} },
    stages: [{ status: "active", summary: "Working" }],
    plan: normalizePlan({ nodes: [{ title: "One", status: "running" }, { title: "Two", status: "fixing" }, { title: "Later" }] })
  };
  markRunCancelled(run, "2026-08-24T20:00:00.000Z");
  assert.deepEqual(run.plan.nodes.map((step) => step.status), ["cancelled", "cancelled", "ready"]);
  assert.equal(run.status, "cancelled");
  assert.deepEqual(run.activeRuns, {});
  assert.equal(run.stages[0].summary, "Run cancelled");
});

test("clearing the queue preserves active runs", () => {
  const state = { selectedTicketId: "old", ticketRuns: { old: { status: "cancelled" }, stale: { status: "awaiting_approval" }, active: { status: "running" }, merge: { status: "merging" } } };
  assert.equal(clearInactiveRuns(state, new Set(["stale", "active", "merge"])), 2);
  assert.deepEqual(Object.keys(state.ticketRuns), ["active", "merge"]);
  assert.equal(state.selectedTicketId, null);
});

test("a preserved plan checkpoint remains approvable after setup fails", () => {
  assert.equal(planApprovalPending({ status: "needs_attention", plan: { nodes: [] }, checkpoint: { kind: "awaiting_approval" } }), true);
  assert.equal(planApprovalPending({ status: "needs_attention", plan: { nodes: [] }, checkpoint: null }), false);
});

test("an interrupted pre-plan run resumes its active workflow stage", () => {
  assert.equal(resumeStage({ status: "interrupted", plan: null, stages: [{ id: "explore", status: "active" }] }), "explore");
  assert.equal(resumeStage({ status: "interrupted", plan: { nodes: [] }, stages: [] }), "run");
});

test("activity capture bounds memory and coalesces pending persistence", async () => {
  let releaseFirstWrite;
  const firstWrite = new Promise((resolve) => { releaseFirstWrite = resolve; });
  let writes = 0;
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const capture = createActivityCapture({
    outputLimit: 100,
    eventLimit: 5,
    now: () => 1,
    persist: async () => {
      writes++;
      activeWrites++;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      if (writes === 1) await firstWrite;
      activeWrites--;
    }
  });

  capture.onEvent({ type: "tool_start", label: "Started" });
  for (let index = 0; index < 1000; index++) {
    capture.onEvent({ type: "tool_update", detail: "x".repeat(1000) });
    capture.onEvent({ type: "text_delta", delta: "output" });
  }

  assert.equal(writes, 1);
  assert.equal(capture.snapshot().events.length, 5);
  assert.equal(capture.snapshot().rawOutput.length, 100);
  releaseFirstWrite();
  await capture.flush();
  assert.equal(writes, 2);
  assert.equal(maxActiveWrites, 1);
});
