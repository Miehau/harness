import test from "node:test";
import assert from "node:assert/strict";
import { addCheckpoint, initialWorkflow, resolveCheckpoint, upsertWorkflowStage, workflowBlockers } from "../src/workflow.js";

test("a pending supervisor checkpoint is a hard execution gate", () => {
  const workflow = initialWorkflow({ skillName: "shape-feature", status: "active" });
  const checkpoint = addCheckpoint(workflow, {
    kind: "awaiting_approval",
    title: "Approve the brief",
    prompt: "Continue to implementation?"
  });

  assert.deepEqual(workflowBlockers(workflow), ["Approve the brief"]);
  assert.equal(workflow.status, "awaiting_approval");

  resolveCheckpoint(workflow, checkpoint.id, "Approved");
  assert.deepEqual(workflowBlockers(workflow), []);
  assert.equal(workflow.status, "active");
});

test("non-blocking checkpoints do not pause execution", () => {
  const workflow = initialWorkflow();
  addCheckpoint(workflow, { kind: "needs_input", title: "Optional detail", blocking: false });
  assert.deepEqual(workflowBlockers(workflow), []);
});

test("workflow stages retain order and update in place", () => {
  const workflow = initialWorkflow();
  upsertWorkflowStage(workflow, { id: "research", title: "Research", status: "active", summary: "Inspecting" });
  upsertWorkflowStage(workflow, { id: "brief", title: "Shape brief", status: "pending" });
  upsertWorkflowStage(workflow, { id: "research", title: "Research", status: "completed", summary: "Evidence captured" });

  assert.deepEqual(workflow.stages.map(({ id, status }) => ({ id, status })), [
    { id: "research", status: "completed" },
    { id: "brief", status: "pending" }
  ]);
  assert.equal(workflow.stages[0].summary, "Evidence captured");
});
