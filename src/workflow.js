import { randomUUID } from "node:crypto";

export function initialWorkflow(current = {}) {
  return {
    skillName: current.skillName || null,
    status: current.status || "idle",
    stages: Array.isArray(current.stages) ? current.stages : [],
    checkpoints: Array.isArray(current.checkpoints) ? current.checkpoints : [],
    lastReview: current.lastReview || null
  };
}

export function upsertWorkflowStage(workflow, input) {
  const id = String(input.id || "stage").trim();
  const existing = workflow.stages.find((stage) => stage.id === id);
  const stage = existing || { id, createdAt: new Date().toISOString() };
  stage.title = String(input.title || existing?.title || id);
  stage.status = ["pending", "active", "completed", "blocked"].includes(input.status) ? input.status : "pending";
  if (stage.status === "active") {
    for (const other of workflow.stages) if (other.id !== id && other.status === "active") other.status = "completed";
  }
  stage.summary = String(input.summary || "");
  stage.updatedAt = new Date().toISOString();
  if (!existing) workflow.stages.push(stage);
  return stage;
}

export function pendingCheckpoints(workflow) {
  return (workflow?.checkpoints || []).filter((checkpoint) => checkpoint.status === "pending");
}

export function workflowBlockers(workflow) {
  return pendingCheckpoints(workflow)
    .filter((checkpoint) => checkpoint.blocking !== false)
    .map((checkpoint) => checkpoint.title || checkpoint.prompt);
}

export function addCheckpoint(workflow, input) {
  const checkpoint = {
    id: randomUUID(),
    kind: input.kind === "needs_input" ? "needs_input" : "awaiting_approval",
    title: String(input.title || "Supervisor checkpoint"),
    prompt: String(input.prompt || "Review before continuing"),
    stepId: input.stepId || null,
    source: input.source || "supervisor",
    blocking: input.blocking !== false,
    status: "pending",
    createdAt: new Date().toISOString()
  };
  workflow.checkpoints.push(checkpoint);
  workflow.status = checkpoint.kind;
  return checkpoint;
}

export function resolveCheckpoint(workflow, id, response) {
  const checkpoint = workflow.checkpoints.find((item) => item.id === id);
  if (!checkpoint) throw new Error("Checkpoint not found");
  if (checkpoint.status !== "pending") throw new Error("Checkpoint is already resolved");
  checkpoint.status = "resolved";
  checkpoint.response = String(response || "Approved");
  checkpoint.resolvedAt = new Date().toISOString();
  const pending = pendingCheckpoints(workflow);
  workflow.status = pending.length ? pending[0].kind : (workflow.skillName ? "active" : "idle");
  return checkpoint;
}

export function bindWorkflowSkill(workflow, skillName, activation = {}) {
  const name = String(skillName || "").trim();
  if (!name) throw new Error("Choose a Pi skill to bind");
  workflow.skillName = name;
  workflow.status = "active";
  workflow.stages = [];
  workflow.checkpoints = [];
  workflow.lastReview = activation.reply || null;
  for (const stage of activation.stages || []) upsertWorkflowStage(workflow, stage);
  for (const checkpoint of activation.checkpoints || []) addCheckpoint(workflow, checkpoint);
  return workflow;
}

export function applyWorkflowContinuation(workflow, checkpointId, response, activation = {}) {
  resolveCheckpoint(workflow, checkpointId, response);
  if (activation.reply) workflow.lastReview = activation.reply;
  for (const stage of activation.stages || []) upsertWorkflowStage(workflow, stage);
  for (const checkpoint of activation.checkpoints || []) addCheckpoint(workflow, checkpoint);
  return workflow;
}

export function pendingBlockingCheckpoints(workflow) {
  return pendingCheckpoints(workflow).filter((checkpoint) => checkpoint.blocking !== false);
}

export function isWorkflowRunCheckpoint(checkpoint) {
  return Boolean(checkpoint && checkpoint.source === "supervisor" && !checkpoint.stepId);
}

export function executionBlockedByWorkflow(run) {
  return workflowBlockers(run?.workflow).length > 0;
}

export function runCheckpointFromWorkflow(checkpoint) {
  if (!checkpoint) return null;
  const kind = checkpoint.kind === "needs_input" ? "needs_input" : "awaiting_approval";
  const prompt = String(checkpoint.prompt || "Review before continuing");
  return {
    id: checkpoint.id,
    kind,
    title: String(checkpoint.title || "Supervisor checkpoint"),
    prompt,
    questions: kind === "needs_input"
      ? (Array.isArray(checkpoint.questions) && checkpoint.questions.length ? checkpoint.questions.map(String) : [prompt])
      : (Array.isArray(checkpoint.questions) ? checkpoint.questions.map(String) : []),
    stepId: checkpoint.stepId || null,
    source: checkpoint.source || "supervisor",
    createdAt: checkpoint.createdAt || new Date().toISOString()
  };
}

export function applyPendingWorkflowGate(run) {
  const pending = pendingBlockingCheckpoints(run?.workflow);
  if (!pending.length) {
    if (isWorkflowRunCheckpoint(run?.checkpoint) && run.checkpoint?.id && !(run.workflow?.checkpoints || []).some((item) => item.id === run.checkpoint.id && item.status === "pending")) {
      run.checkpoint = null;
    }
    return null;
  }
  const gate = runCheckpointFromWorkflow(pending[0]);
  run.checkpoint = gate;
  run.status = gate.kind === "needs_input" ? "awaiting_input" : "awaiting_approval";
  const stage = (run.stages || []).find((item) => item.status === "active") || (run.stages || []).find((item) => item.status === "blocked");
  if (stage) Object.assign(stage, { status: "blocked", summary: gate.title, updatedAt: new Date().toISOString() });
  return gate;
}
