import test from "node:test";
import assert from "node:assert/strict";
import { actionableFindings, clearInactiveRuns, markRunCancelled, nextRunnableBatch, nextRunnableStep } from "../src/execution.js";
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
  const state = { selectedTicketId: "old", ticketRuns: { old: { status: "cancelled" }, stale: { status: "awaiting_approval" }, active: { status: "running" } } };
  assert.equal(clearInactiveRuns(state, new Set(["stale", "active"])), 2);
  assert.deepEqual(Object.keys(state.ticketRuns), ["active"]);
  assert.equal(state.selectedTicketId, null);
});
