import test from "node:test";
import assert from "node:assert/strict";
import { nextRunnableBatch, planApprovalPending, selectWorkerSession, stepCheckpointResumeKind, supervisorReviewCheckpoint, workerReportCheckpoint, workflowGateCheckpoint } from "../src/execution.js";
import { findNode, groupStatus, normalizePlan } from "../src/plan.js";

test("plan approval ignores step-level awaiting_approval checkpoints", () => {
  assert.equal(planApprovalPending({ plan: { nodes: [] }, checkpoint: { kind: "awaiting_approval" } }), true);
  assert.equal(planApprovalPending({ plan: { nodes: [] }, checkpoint: { kind: "awaiting_approval", stepId: "build" } }), false);
});

test("workers resume a named session unless the step is explicitly fresh", () => {
  const step = { sessionFile: "/tmp/worker.jsonl", status: "needs_input" };
  assert.deepEqual(selectWorkerSession(step, { forkSessionFile: "/tmp/fork.jsonl", feedback: "Use dark mode" }), {
    resumeSessionFile: "/tmp/worker.jsonl",
    forkSessionFile: null
  });
  assert.deepEqual(selectWorkerSession({ ...step, contextPolicy: "fresh" }, { forkSessionFile: "/tmp/fork.jsonl" }), {
    resumeSessionFile: null,
    forkSessionFile: null
  });
  assert.deepEqual(selectWorkerSession({ id: "build", contextPolicy: "fork" }, { forkSessionFile: "/tmp/fork.jsonl" }), {
    resumeSessionFile: null,
    forkSessionFile: "/tmp/fork.jsonl"
  });
});

test("worker reports become dashboard checkpoints", () => {
  const step = { id: "build", title: "Build board" };
  const gate = workerReportCheckpoint(step, { status: "needs_input", summary: "Which layout?", request: "Grid or list?" });
  assert.equal(gate.kind, "needs_input");
  assert.equal(gate.stepId, "build");
  assert.equal(gate.source, "worker");
  assert.deepEqual(gate.questions, ["Grid or list?"]);
  assert.equal(workerReportCheckpoint(step, { status: "completed" }), null);
});

test("supervisor review checkpoints reuse the worker gate shape", () => {
  const step = { id: "build", title: "Build board" };
  const gate = supervisorReviewCheckpoint(step, {
    checkpoints: [{ kind: "awaiting_approval", title: "Approve scope", prompt: "The worker exceeded the write scope." }]
  });
  assert.equal(gate.kind, "awaiting_approval");
  assert.equal(gate.stepId, "build");
  assert.equal(gate.source, "supervisor");
  assert.equal(supervisorReviewCheckpoint(step, { checkpoints: [] }), null);
});

test("a group surfaces worker input before review", () => {
  const plan = normalizePlan({
    nodes: [{
      id: "research",
      type: "group",
      title: "Research",
      children: [
        { id: "repo", title: "Map repo" },
        { id: "risk", title: "Map risk" }
      ]
    }]
  });
  const research = findNode(plan, "research");
  research.children[0].status = "accepted";
  research.children[1].status = "needs_input";
  assert.equal(groupStatus(research), "needs_input");
  research.children[1].status = "review_ready";
  assert.equal(groupStatus(research), "review");
  research.children[1].status = "running";
  assert.equal(groupStatus(research), "running");
});

test("workflowGateCheckpoint maps supervisor signals without a step", () => {
  const gate = workflowGateCheckpoint({ kind: "needs_input", title: "Audience", prompt: "Who is this for?" });
  assert.equal(gate.source, "supervisor");
  assert.equal(gate.stepId, null);
  assert.deepEqual(gate.questions, ["Who is this for?"]);
  assert.equal(stepCheckpointResumeKind(gate), null);
  assert.equal(stepCheckpointResumeKind({ stepId: "build", source: "supervisor" }), "supervisor");
  assert.equal(stepCheckpointResumeKind({ stepId: "build" }), "worker");
});

test("a sibling waiting for input blocks the next parallel batch", () => {
  const plan = normalizePlan({ nodes: [{
    id: "parallel", type: "group", title: "Parallel", children: [
      { id: "feature", title: "Feature", permission: "write" },
      { id: "ci", title: "CI", permission: "write" }
    ]
  }] });
  plan.nodes[0].children[0].status = "needs_input";
  assert.deepEqual(nextRunnableBatch(plan), []);
});
