import test from "node:test";
import assert from "node:assert/strict";
import { actionableFindings, archiveRun, clearInactiveRuns, createActivityCapture, markRunCancelled, nextRunnableBatch, nextRunnableStep, planApprovalPending, resumeStage, rewindRun } from "../src/execution.js";
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
  assert.deepEqual(Object.keys(state.retainedRuns), ["old:legacy", "stale:legacy"]);
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

test("archives repeated ticket runs without overwriting their audit history", () => {
  const state = { ticketRuns: { ticket: { id: "ticket", runId: "run-2" } }, retainedRuns: { "ticket:run-1": { runId: "run-1" } } };
  archiveRun(state, "ticket");
  assert.deepEqual(Object.keys(state.retainedRuns), ["ticket:run-1", "ticket:run-2"]);
  assert.equal(state.ticketRuns.ticket, undefined);
});

test("rewinds a step and every later step to its recorded tree", () => {
  const plan = normalizePlan({ nodes: [
    { id: "one", title: "One", status: "accepted" },
    { id: "two", title: "Two", status: "review_ready" },
    { id: "three", title: "Three", status: "ready", dependsOn: ["two"] }
  ] });
  Object.assign(plan.nodes[0], { baseTree: "base", attempts: [{}] });
  Object.assign(plan.nodes[1], { baseTree: "after-one", attempts: [{}, {}] });
  const run = {
    status: "awaiting_step_review", checkpoint: { kind: "step_review" }, activeRuns: {}, baselineTree: "base", plan,
    stages: ["requirements", "explore", "design", "implement", "verify", "handoff"].map((id) => ({ id, status: "completed", activity: {} }))
  };
  const audit = rewindRun(run, "step:two", "2026-08-27T12:00:00.000Z");
  assert.equal(audit.restoredTree, "after-one");
  assert.deepEqual(audit.resetStepIds, ["two", "three"]);
  assert.equal(audit.discardedAttempts, 2);
  assert.deepEqual(run.plan.nodes.map((step) => step.status), ["accepted", "ready", "ready"]);
  assert.equal(run.stages.find((stage) => stage.id === "implement").status, "pending");
  assert.equal(run.restartHistory[0].fromCheckpoint, "step_review");
});

test("restarts verification without discarding accepted implementation", () => {
  const run = {
    status: "needs_attention", checkpoint: null, activeRuns: {}, reviews: [{}],
    stages: ["requirements", "explore", "design", "implement", "verify", "handoff"].map((id) => ({ id, status: "completed" })),
    plan: normalizePlan({ nodes: [{ id: "one", title: "One", status: "accepted" }] })
  };
  rewindRun(run, "stage:verify");
  assert.equal(run.plan.nodes[0].status, "accepted");
  assert.deepEqual(run.reviews, []);
  assert.equal(run.stages.find((stage) => stage.id === "verify").status, "pending");
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
