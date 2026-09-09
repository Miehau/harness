export const inFlightRunStatuses = Object.freeze([
  "preparing", "clarifying", "exploring", "planning", "running", "fixing", "verifying", "reviewing",
  "queued_for_merge", "merging", "resolving_conflicts", "verifying_merge", "rebasing",
  "waiting_for_checks", "addressing_feedback", "waiting_for_merge"
]);

export const terminalRunStatuses = Object.freeze([
  "completed", "failed", "needs_attention", "cancelled", "interrupted", "paused"
]);

export const inFlightMergeStatuses = Object.freeze([
  "queued", "merging", "resolving_conflicts", "verifying", "rebasing",
  "waiting_for_checks", "addressing_feedback", "waiting_for_merge"
]);

export const inFlightStepStatuses = Object.freeze(["running", "fixing", "verifying"]);
export const runnableStepStatuses = Object.freeze(["ready", "interrupted"]);
export const gateStepStatuses = Object.freeze(["review_ready", "needs_input", "awaiting_approval"]);
export const resumeRunStatuses = Object.freeze(["interrupted", "cancelled", "needs_attention", "failed", "paused"]);
export const replaceableRunStatuses = Object.freeze(["completed", "failed", "needs_attention"]);
export const earlyFailureStatuses = Object.freeze(["preparing", "clarifying"]);
export const restartableStepStatuses = Object.freeze(["cancelled", "needs_attention", "failed"]);
export const cleanupOutcomes = Object.freeze(["running", "not-required", "complete", "incomplete", "unsupported"]);

export function setStage(run, id, status, summary = "") {
  const stage = run.stages.find((item) => item.id === id);
  if (!stage) return;
  if (status === "active") {
    for (const other of run.stages) {
      if (other.status === "active") other.status = "completed";
    }
  }
  Object.assign(stage, { status, summary, updatedAt: new Date().toISOString() });
  return stage;
}

function cleanupOutcome(executions) {
  const outcomes = executions.map((execution) => execution.outcome);
  if (outcomes.includes("running")) return "running";
  if (outcomes.includes("incomplete")) return "incomplete";
  if (outcomes.includes("unsupported")) return "unsupported";
  if (outcomes.includes("complete")) return "complete";
  return "not-required";
}

export function normalizeRunCleanup(value = {}) {
  const executions = Array.isArray(value?.executions) ? value.executions.map((execution) => ({
    ...structuredClone(execution || {}), executionId: String(execution?.executionId || "legacy-unknown"),
    outcome: cleanupOutcomes.includes(execution?.outcome) ? execution.outcome : "incomplete",
    triggers: Array.isArray(execution?.triggers) ? structuredClone(execution.triggers) : [],
    diagnostics: Array.isArray(execution?.diagnostics) ? structuredClone(execution.diagnostics) : [],
    unresolved: Array.isArray(execution?.unresolved) ? structuredClone(execution.unresolved) : []
  })) : [];
  return { executions, outcome: cleanupOutcome(executions), updatedAt: value?.updatedAt || null };
}

export const stepStatusList = Object.freeze([
  "draft", "ready", "running", "review_ready", "fixing", "verifying", "needs_attention", "needs_input",
  "awaiting_approval", "accepted", "failed", "interrupted", "cancelled"
]);

export const inFlightRunStatusSet = new Set(inFlightRunStatuses);
export const terminalRunStatusSet = new Set(terminalRunStatuses);
export const inFlightMergeStatusSet = new Set(inFlightMergeStatuses);
export const inFlightStepStatusSet = new Set(inFlightStepStatuses);
export const runnableStepStatusSet = new Set(runnableStepStatuses);
export const gateStepStatusSet = new Set(gateStepStatuses);
export const resumeRunStatusSet = new Set(resumeRunStatuses);
export const replaceableRunStatusSet = new Set(replaceableRunStatuses);
export const earlyFailureStatusSet = new Set(earlyFailureStatuses);
export const restartableStepStatusSet = new Set(restartableStepStatuses);
export const stepStatuses = new Set(stepStatusList);
