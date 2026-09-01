import test from "node:test";
import assert from "node:assert/strict";
import { addCheckpoint, applyPendingWorkflowGate, applyWorkflowContinuation, bindWorkflowSkill, executionBlockedByWorkflow, initialWorkflow, resolveCheckpoint, upsertWorkflowStage, workflowBlockers } from "../src/workflow.js";

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

test("binding a Pi skill persists skillName and activation gates on the run workflow", () => {
  const run = { workflow: initialWorkflow() };
  run.workflow = bindWorkflowSkill(run.workflow, "shape-feature", {
    reply: "Loaded shape-feature",
    stages: [{ id: "brief", title: "Shape brief", status: "active", summary: "Drafting" }],
    checkpoints: [{ kind: "awaiting_approval", title: "Approve the brief", prompt: "Continue?" }]
  });
  assert.equal(run.workflow.skillName, "shape-feature");
  assert.equal(run.workflow.status, "awaiting_approval");
  assert.equal(run.workflow.lastReview, "Loaded shape-feature");
  assert.equal(run.workflow.stages[0].id, "brief");
  assert.equal(run.workflow.checkpoints[0].title, "Approve the brief");
});

test("binding rejects an empty skill name", () => {
  assert.throws(() => bindWorkflowSkill(initialWorkflow(), "  "), /Choose a Pi skill to bind/);
});

test("rebinding replaces the previous skill and checkpoints", () => {
  const workflow = bindWorkflowSkill(initialWorkflow(), "old-skill", {
    checkpoints: [{ title: "Old gate" }]
  });
  bindWorkflowSkill(workflow, "new-skill");
  assert.equal(workflow.skillName, "new-skill");
  assert.equal(workflow.checkpoints.length, 0);
  assert.equal(workflow.status, "active");
});

test("continuing a bound workflow resolves the gate and records the next stage", () => {
  const workflow = bindWorkflowSkill(initialWorkflow(), "shape-feature", {
    checkpoints: [{ kind: "needs_input", title: "Which audience?", prompt: "Who is this for?" }]
  });
  applyWorkflowContinuation(workflow, workflow.checkpoints[0].id, "Internal operators", {
    stages: [{ id: "brief", title: "Shape brief", status: "active" }]
  });
  assert.equal(workflow.checkpoints[0].status, "resolved");
  assert.equal(workflow.checkpoints[0].response, "Internal operators");
  assert.equal(workflow.stages[0].id, "brief");
  assert.equal(workflow.status, "active");
});

test("applyPendingWorkflowGate copies a blocking checkpoint onto run.checkpoint", () => {
  const run = { workflow: initialWorkflow(), status: "exploring", stages: [{ id: "explore", status: "active", summary: "" }] };
  run.workflow = bindWorkflowSkill(run.workflow, "shape-feature", {
    checkpoints: [{ kind: "awaiting_approval", title: "Approve the brief", prompt: "Continue?" }]
  });
  const gate = applyPendingWorkflowGate(run);
  assert.equal(gate.title, "Approve the brief");
  assert.equal(run.checkpoint.id, run.workflow.checkpoints[0].id);
  assert.equal(run.status, "awaiting_approval");
  assert.equal(executionBlockedByWorkflow(run), true);
  assert.equal(run.stages[0].status, "blocked");
});
